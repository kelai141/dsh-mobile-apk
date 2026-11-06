import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const APPLY = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
const REL = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-j1-'))
  const file = join(root, REL)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    'var ConversationController = class {',
    '\t\t\tcreateDrafts(sessionId, files) { return files; }',
    '\t\t\t/**',
    '\t\t\t* Restart one failed file or image upload.',
    '\t\t\t*/',
    '\t\t\tretryFileUpload() {}',
    '};',
  ].join('\n'))
  return { root, file }
}

test('external-draft-conversation-seam-J1 exposes the existing composer attachment path', () => {
  const { root, file } = fixtureRoot()
  execFileSync(process.execPath, [APPLY, root, '--apply', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
  const patched = readFileSync(file, 'utf8')
  assert.match(patched, /dsh-mobile external draft addFiles seam \(J1\)/)
  assert.match(patched, /this\.input\.shell\(sessionId\)/)
  assert.match(patched, /this\.createDrafts\(sessionId, files\)/)
  assert.match(patched, /this\.releaseDraftAttachments\(drafts\)/)
  execFileSync(process.execPath, [APPLY, root, '--check', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
})
