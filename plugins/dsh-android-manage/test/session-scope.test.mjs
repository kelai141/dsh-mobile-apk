// issue #688 第二步：UI 快照按会话键。
//
// 三条不变量（各自有用例）：
//  ① 同一会话内复用快照（快路径仍生效）；
//  ② **跨会话互不干扰** —— s2 不得命中 s1 的快照，且 s1 的快照不被 s2 覆盖；
//  ③ 无会话上下文回落到同一个 `__anonymous__` 桶，**与原单槽行为等价**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

function makeFace() {
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'test-a11y' }),
    controlExec: async (op) => {
      if (op !== 'snapshot') return { ok: true, data: { done: true } }
      return {
        ok: true,
        data: {
          gen: 7,
          rotation: 0,
          screen: { w: 1080, h: 2400 },
          nodes: [
            { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', text: '' } },
            { id: '0.0', parentId: '0', attrs: { bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', text: '设置' } },
          ],
        },
      }
    },
    execAdbShell: async () => ({ ok: true, stdout: '' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
  }
  return { face }
}

function applyManage(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { byName: (n) => tools.find((t) => t.name === n) }
}

const text = (r) => String(r.text ?? '')

test('两个会话的 UI 快照互不干扰', async () => {
  const { face } = makeFace()
  const { byName } = applyManage(face)
  const dump = byName('android_ui_dump')
  const s1 = { agent: { session: 's1' } }
  const s2 = { agent: { session: 's2' } }

  const first = await dump.execute({}, s1)
  assert.equal(first.ok, true)
  assert.doesNotMatch(text(first), /界面未变/, '首次 dump 不得走快路径')
  assert.ok((first.nodes ?? []).length >= 1, '首次 dump 必须给出节点清单')

  const again1 = await dump.execute({}, s1)
  assert.match(text(again1), /界面未变/, '同会话应命中快路径')

  const other = await dump.execute({}, s2)
  assert.equal(other.ok, true)
  assert.doesNotMatch(text(other), /界面未变/, '跨会话不得复用 s1 的快照')
  assert.ok((other.nodes ?? []).length >= 1, 's2 必须自己拿到节点清单')

  const back1 = await dump.execute({}, s1)
  assert.match(text(back1), /界面未变/, 's1 的快照不应被 s2 覆盖')
})

test('无会话上下文回落到同一个匿名桶（与旧单槽等价）', async () => {
  const { face } = makeFace()
  const { byName } = applyManage(face)
  const dump = byName('android_ui_dump')

  const a = await dump.execute({}, undefined)
  assert.equal(a.ok, true)
  assert.doesNotMatch(text(a), /界面未变/, '无会话时首次 dump 不得走快路径')
  assert.ok((a.nodes ?? []).length >= 1, '无会话时首次 dump 也应给出清单')

  const b = await dump.execute({}, undefined)
  assert.match(text(b), /界面未变/, '匿名调用之间应共享同一桶')

  const withSession = await dump.execute({}, { agent: { session: 's1' } })
  assert.doesNotMatch(text(withSession), /界面未变/, '有会话的调用不得命中匿名桶')
})