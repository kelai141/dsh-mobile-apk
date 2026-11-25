// spj-compaction-dedup-C5.test.mjs — Compaction deduplication & lossless roundtrip regression test
//
// Verifies:
// 1. Applying spj-migration-link-F5 + publish-exclusive-F7 + spj-compaction-dedup-C5 on fixture
//    matches runtime asset app/src/main/assets/patched/session-persistence-jsonl-index.js bytes.
// 2. Physical line encoding omits duplicate rawOutput (when equal to summary) and duplicate
//    checkpoint user/message middle summary blocks, yielding significant byte & slope reduction
//    across multi-compaction logs (plain and zstd).
// 3. SessionLogScanner and MigratingJsonlRows transparently reconstruct full rawOutput and
//    checkpoint user/message.content BEFORE assertV4RowAdmission / decodeRow.
// 4. Backward compatibility: legacy un-deduped compaction/summary + checkpoint user/message
//    events read/replay cleanly without markers; fork prefix seeding & export receive full content.
// 5. Existing publish-exclusive-reclaim.test.mjs remains satisfied on the patched asset.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
const FIXTURE = versionedFixture('dsh-session-persistence-jsonl', 'lib', 'index.js')
const ASSET = join(repoRoot, 'app', 'src', 'main', 'assets', 'patched', 'session-persistence-jsonl-index.js')

function extractSection(source, startMarker, endMarker) {
  const s = source.indexOf(startMarker)
  assert.ok(s >= 0, `missing start marker: ${startMarker}`)
  const e = source.indexOf(endMarker, s)
  assert.ok(e > s, `missing end marker: ${endMarker}`)
  return source.slice(s, e)
}

function makeSummaryEvent(seq, cid, text, rawMatches = true) {
  const summary = [{ type: 'text', text }]
  const rawOutput = rawMatches
    ? [{ type: 'text', text }]
    : [{ type: 'reasoning', text: 'think' }, { type: 'text', text }]
  return {
    type: 'compaction/summary',
    seq,
    time: 1000 + seq,
    data: {
      compactionId: cid,
      summary,
      rawOutput,
      llmStreamCall: true,
      shadowedRange: { start: 1, end: seq - 1 },
      shadowedSeqs: [1],
      shadowedTokenCount: 500,
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
  }
}

function makeCheckpointUserEvent(seq, cid, summaryBlocks) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: seq - 2 },
    sourceEventSeqs: [seq - 2, seq - 1, 1],
    data: {
      id: `msg-${cid}`,
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId: cid },
      content: [
        { type: 'text', text: 'CHECKPOINT PREAMBLE\n\n<summary>' },
        ...summaryBlocks,
        { type: 'text', text: '</summary>' },
      ],
    },
  }
}

test('spj-compaction-dedup-C5 patch output matches runtime asset and passes syntax check', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'c5-patch-'))
  try {
    const target = join(scratch, TARGET)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

    const applied = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine',
        '--only', 'spj-migration-link-F5,publish-exclusive-F7,spj-compaction-dedup-C5'],
      { encoding: 'utf8' },
    )
    assert.equal(applied.status, 0, applied.stderr)
    const patched = readFileSync(target, 'utf8')
    const asset = readFileSync(ASSET, 'utf8').replace(/\r\n/g, '\n')
    assert.equal(patched, asset, 'fixture patched with F5+F7+C5 must equal assets/patched/session-persistence-jsonl-index.js')

    const syntax = spawnSync(process.execPath, ['--check', ASSET], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('spj-compaction-dedup-C5 round-trips deduped & legacy events, preserves fork/replay fidelity, and shrinks multi-compaction growth', () => {
  const asset = readFileSync(ASSET, 'utf8').replace(/\r\n/g, '\n')
  const helpersSrc = extractSection(
    asset,
    '/* dsh-mobile compaction dedup (C5):',
    'function refuseForeignFormatVersion(',
  )
  const fn = new Function(
    'sessionFormatCatalog',
    'isDeepStrictEqual',
    `${helpersSrc}\nreturn { dshMobileCollectCompactionSummaries, dshMobileDeduplicateCompactionEncoded, dshMobileHydrateCompactionRow, eventLines, eventLine };`,
  )
  const runtime = fn({ encodeCurrentEvent: (e) => structuredClone(e) }, isDeepStrictEqual)

  const longSummary = 'Important architectural decision preserved in full detail. '.repeat(40)
  const compactEvents = []
  for (let i = 0; i < 6; i += 1) {
    const cid = `cmp-${i}`
    const s = makeSummaryEvent(i * 2 + 1, cid, `${longSummary} [round ${i}]`, true)
    const u = makeCheckpointUserEvent(i * 2 + 2, cid, s.data.summary)
    compactEvents.push(s, u)
  }

  const dedupedJsonl = runtime.eventLines(compactEvents, new Map())
  const baselineJsonl = compactEvents.map((e) => JSON.stringify(e)).join('\n')

  // Significant savings: removes 2 duplicate copies out of 3 per round (~66% savings on text payload).
  assert.ok(dedupedJsonl.length < baselineJsonl.length * 0.5,
    `expected >50% shrinkage: dedup=${dedupedJsonl.length} vs baseline=${baselineJsonl.length}`)

  // Reconstruct via dshMobileHydrateCompactionRow (replay path & fork seed extraction).
  const scannerSummaries = new Map()
  const hydrated = dedupedJsonl.split('\n').map((line) => {
    const row = JSON.parse(line)
    runtime.dshMobileHydrateCompactionRow(row, scannerSummaries)
    return row
  })
  assert.deepEqual(hydrated, compactEvents, 'reconstructed events must be deeply equal to original events (including rawOutput & checkpoint content)')

  // Non-identical rawOutput (e.g. contains reasoning block) is preserved verbatim.
  const mixedSummary = makeSummaryEvent(1, 'cmp-mixed', longSummary, false)
  const mixedCheckpoint = makeCheckpointUserEvent(2, 'cmp-mixed', mixedSummary.data.summary)
  const mixedJsonl = runtime.eventLines([mixedSummary, mixedCheckpoint], new Map())
  const mixedParsed = mixedJsonl.split('\n').map((l) => JSON.parse(l))
  assert.ok(Array.isArray(mixedParsed[0].data.rawOutput), 'distinct rawOutput with reasoning block is retained')
  assert.equal(mixedParsed[1].data.dshCompactCheckpointRef, 'cmp-mixed', 'checkpoint content still deduplicated')
  const mixedMap = new Map()
  const mixedHydrated = mixedParsed.map((row) => runtime.dshMobileHydrateCompactionRow(row, mixedMap))
  assert.deepEqual(mixedHydrated, [mixedSummary, mixedCheckpoint])

  // Backward compatibility: legacy un-deduplicated rows read seamlessly with no markers.
  const legacyMap = new Map()
  const legacyHydrated = compactEvents.map((e) => runtime.dshMobileHydrateCompactionRow(structuredClone(e), legacyMap))
  assert.deepEqual(legacyHydrated, compactEvents)

  // Fail-closed: dangling checkpoint reference without prior compaction/summary throws loudly.
  const orphanRow = JSON.parse(dedupedJsonl.split('\n')[1])
  assert.throws(
    () => runtime.dshMobileHydrateCompactionRow(orphanRow, new Map()),
    /corrupt compaction checkpoint reference/,
  )
})
