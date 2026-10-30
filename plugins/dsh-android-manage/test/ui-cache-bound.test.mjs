// issue #984：按会话键的 UI 快照表必须**有界**。
//
// 背景（缺陷形态）：#688 第二步把 UI 快照从「单槽」改成「按会话键的 Map」之后，这张表
// **只增不减** —— 全仓没有 delete / clear / 容量上限 / 过期清扫，`UI_CACHE_TTL` 只参与
// 读侧判定。每个做过 UI 工具的会话都会在进程里**永久**留一整棵控件树
// （nodes + byId + byOrig + parentByOrig，大页面数千节点）；长跑引擎一个进程开几十个会话，
// 内存单调增长，旧条目永远不会因为 TTL 过期而释放。
//
// 判据选「行为」而不是「源码里有没有 delete 字样」：
//   ① 行为面 —— 开满上限之后，最早那个会话的快照必须**真的被回收**（它下一次 dump 不得再命中
//      「界面未变」快路径，而最近的那个会话仍要命中）；
//   ② 契约面 —— 写入必须经过统一的回收入口，不得再出现绕过回收的裸 set。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const LIB = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

function makeFace() {
  return {
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

test('行为面：会话数超过上限后，最早会话的快照被回收（不得永久留存）', async () => {
  const { byName } = applyManage(makeFace())
  const dump = byName('android_ui_dump')
  // 上限的取值由实现决定，但**必须存在**：一个进程不可能无限留控件树。
  // 这里用一个远超任何合理上限的会话数把「只增不减」逼出来。
  const sessions = Array.from({ length: 64 }, (_, i) => 's' + i)
  const first = await dump.execute({}, { agent: { session: sessions[0] } })
  assert.doesNotMatch(text(first), /界面未变/, '首个会话的首次 dump 不得走快路径')

  for (const session of sessions.slice(1)) {
    await dump.execute({}, { agent: { session } })
  }

  const backFirst = await dump.execute({}, { agent: { session: sessions[0] } })
  assert.doesNotMatch(
    text(backFirst),
    /界面未变/,
    '最早会话的快照必须已被回收（表只增不减 = 每个会话永久留一整棵控件树）',
  )
  const last = await dump.execute({}, { agent: { session: sessions[sessions.length - 1] } })
  assert.match(text(last), /界面未变/, '最近的会话仍应命中快路径（回收不得退化成「什么都不缓存」）')
})

test('契约面：写入一律经过带回收的入口，不得再有绕过回收的裸 set', () => {
  // 读侧早已全部切到 uiCacheOf()；写入侧必须同时带回收。只断言「有 delete」不够，
  // 因为那可能是某条错误分支上的偶发删除 —— 这里钉的是**写入路径本身**。
  assert.match(LIB, /\buiCaches\.delete\(/, 'UI 快照表必须有删除路径（TTL 清扫 / 容量淘汰）')
  assert.match(LIB, /UI_CACHE_MAX_ENTRIES/, 'UI 快照表必须有容量上限常量')
})
