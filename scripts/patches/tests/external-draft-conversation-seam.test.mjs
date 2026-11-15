import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { FIXTURES_DIR, versionedFixture } from './lib/fixture.mjs'
import { Script } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const APPLY = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
const REL = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'

/**
 * 造一棵只有目标包的临时树。
 *
 * 夹具形参是**紧凑形态**的类体骨架（0.2.2-rc.2 起上游把 client bundle 压成单行，本补丁的锚点
 * 就是紧凑形态的真字节）：createDrafts 的收尾 "return attachment})}" 紧跟 retryFileUpload 的开头。
 * 用真实产物（-0.2.2-rc.3 夹具）另跑一条用例，保证骨架与真产物同时可施加。
 */
function fixtureRoot(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-j1-'))
  const file = join(root, REL)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  return { root, file }
}

/** 紧凑形态骨架：只保留本补丁认的两段标识符。 */
const COMPACT_SKELETON = 'var ConversationController=class{createDrafts(sessionId,files,uploadImages){return files.map(file=>{const attachment={kind:`file`,id:randomUUID(),file};this.draftAttachments.set(attachment.id,attachment);this.beginFileUpload(sessionId,attachment);return attachment})}retryFileUpload(sessionId,id){const attachment=this.draftAttachments.get(id);if(attachment===void 0)return;this.beginFileUpload(sessionId,attachment)}};'

test('external-draft-conversation-seam-J1 exposes the existing composer attachment path', () => {
  const { root, file } = fixtureRoot(COMPACT_SKELETON)
  try {
    execFileSync(process.execPath, [APPLY, root, '--apply', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
    const patched = readFileSync(file, 'utf8')
    assert.match(patched, /dsh-mobile external draft addFiles seam \(J1\)/)
    // 注入的方法是紧凑形态（与被注入的 bundle 同风格，空格不参与语义）。
    assert.match(patched, /this\.input\.shell\(sessionId\)/)
    assert.match(patched, /this\.createDrafts\(sessionId, ?files\)/)
    assert.match(patched, /this\.releaseDraftAttachments\(drafts\)/)
    assert.match(patched, /shell\.addAttachments\(drafts\.map\(draft=>draft\.id\)\)===false/)
    // 注入的方法必须与 createDrafts / retryFileUpload **平级**（落在类体上，不是塞进 createDrafts 体内）。
    // 判据：类体在插入后仍然解析得动，且三个成员都在同一个对象字面量的第一层。
    new Script(patched)
    const order = ['createDrafts(sessionId,files,uploadImages)', 'addFiles(sessionId,files)', 'retryFileUpload(sessionId,id)']
    const positions = order.map((member) => patched.indexOf(member))
    assert.deepEqual(positions.every((at) => at >= 0), true, '三个成员必须都在场')
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, '成员顺序必须是 createDrafts -> addFiles -> retryFileUpload')
    execFileSync(process.execPath, [APPLY, root, '--check', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real 0.2.2 client bundle takes the seam and stays parseable', () => {
  const source = readFileSync(versionedFixture('dsh-client-ui-conversation', 'lib', 'client.js'), 'utf8')
  const { root, file } = fixtureRoot(source)
  try {
    const r = spawnSync(process.execPath, [APPLY, root, '--apply', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''))
    const patched = readFileSync(file, 'utf8')
    assert.match(patched, /dsh-mobile external draft addFiles seam \(J1\)/)
    new Script(patched, { filename: REL })
    // 幂等：再施加一次不得改字节。
    assert.equal(spawnSync(process.execPath, [APPLY, root, '--apply', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' }).status, 0)
    assert.equal(readFileSync(file, 'utf8'), patched, '重复施加必须字节不变')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('J1 rejects unknown bytes without writing a partial method', () => {
  const damaged = COMPACT_SKELETON.replace('retryFileUpload(sessionId,id){', 'retryUpload(sessionId,id){')
  const { root, file } = fixtureRoot(damaged)
  try {
    const r = spawnSync(process.execPath, [APPLY, root, '--apply', '--scope', 'engine', '--only', 'external-draft-conversation-seam-J1'], { encoding: 'utf8' })
    assert.notEqual(r.status, 0, '锚点缺失必须判红')
    assert.match((r.stderr || ''), /锚点未命中/)
    assert.equal(readFileSync(file, 'utf8'), damaged, '失败即不写回')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
