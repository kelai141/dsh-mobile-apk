// issue #1201 负控：浏览器审计必须按**真实结果**记账。
//
// 缺陷形态：8 个调用点在 `await call(...)` 之前传字面量 `true`，失败分支从不补记；
// 另有 10 个工具完全没接审计。于是审计日志把每次被拒的操作都记成成功。
//
// 判据设计：不读源码文本、不做「grep audit 在场」断言，而是**真跑 execute()**，
// 捕获插件交给 face().audit 的 (tool, detail, ok) 三元组，再断言：
//   ① 被拒绝的操作必须 ok=false，且 detail 里带原因；
//   ② 成功的操作必须 ok=true；
//   ③ 18 个工具**每一个**都要产生审计（不是只有原来那 8 个）。
// ②③ 是防「一刀切全记 false」与「只补了部分工具」的回归钉子。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BROWSER_TOOLS } from '../lib/contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const EXEC = { agent: { session: 'audit-test' } }

/** 夹具控制面：记录 audit 调用；按 datas 返回桩数据。 */
function makeFace(datas) {
  const audits = []
  const face = {
    gateFor: () => ({ ok: true, via: 'a11y' }),
    audit: (tool, detail, ok) => { audits.push({ tool, detail, ok }) },
    controlExec: async (op) => {
      if (Object.hasOwn(datas, op)) return { ok: true, data: datas[op] }
      return { ok: true, data: {} }
    },
  }
  return { face, audits }
}

function applyBrowser(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: (name) => (name === 'androidPrivilege' ? face : undefined),
    effect: (fn) => { try { return fn?.() } catch { return undefined } },
    on: () => {},
  })
  return { tools, byName: (n) => tools.find((t) => t.name === n) }
}

// 每个工具的最小合法参数（schema required 面）。
const ARGS = {
  [BROWSER_TOOLS.open]: { url: 'https://example.com/' },
  [BROWSER_TOOLS.snapshot]: {},
  [BROWSER_TOOLS.click]: { ref: 'bx1' },
  [BROWSER_TOOLS.type]: { ref: 'bx1', text: 'hi' },
  [BROWSER_TOOLS.press]: { key: 'Enter' },
  [BROWSER_TOOLS.scroll]: { direction: 'down' },
  [BROWSER_TOOLS.getText]: {},
  [BROWSER_TOOLS.wait]: {},
  [BROWSER_TOOLS.navigate]: { url: 'https://example.com/' },
  [BROWSER_TOOLS.back]: {},
  [BROWSER_TOOLS.forward]: {},
  [BROWSER_TOOLS.reload]: {},
  [BROWSER_TOOLS.listTabs]: {},
  [BROWSER_TOOLS.followTab]: { tabId: 'tab-1' },
  [BROWSER_TOOLS.closeTab]: { tabId: 'tab-1' },
  [BROWSER_TOOLS.setIdentity]: { profile: 'android-chrome' },
  [BROWSER_TOOLS.setViewport]: { preset: 'mobile' },
  [BROWSER_TOOLS.screenshot]: {},
}

const SNAPSHOT_OK = {
  url: 'https://example.com/', title: 'Example', pageGeneration: 3, tabId: 'tab-1',
  nodes: [{ ref: 'bx1', role: 'button', name: 'Go' }],
}

test('#1201 反证：被拒绝的 browser_open 必须记 ok:false，且带原因', async () => {
  // 壳侧 URL 准入拒绝（issue 里的实跑形态：file:// 被 unsupported-url 拒）。
  const { face, audits } = makeFace({ browserOpen: { ok: false, reason: 'unsupported-url' } })
  const { byName } = applyBrowser(face)
  const value = await byName(BROWSER_TOOLS.open).execute({ url: 'file:///data/data/x/shared_prefs/dsh-adb.xml' }, EXEC)
  assert.equal(value.ok, false, '工具必须如实返回失败')
  const rec = audits.find((a) => a.tool === BROWSER_TOOLS.open)
  assert.notEqual(rec, undefined, '被拒绝的操作也必须留下审计记录')
  assert.equal(rec.ok, false, '被拒绝的操作必须记 ok:false（旧实现写死 true）')
  const reason = JSON.stringify(rec.detail)
  assert.match(reason, /unsupported-url/, '审计必须带失败原因；实际 detail=' + reason)
})

test('#1201 反证：成功的操作仍须记 ok:true（不得一刀切记 false）', async () => {
  const { face, audits } = makeFace({ browserOpen: SNAPSHOT_OK })
  const { byName } = applyBrowser(face)
  const value = await byName(BROWSER_TOOLS.open).execute({ url: 'https://example.com/' }, EXEC)
  assert.equal(value.ok, true, '正常打开必须成功')
  const rec = audits.find((a) => a.tool === BROWSER_TOOLS.open)
  assert.notEqual(rec, undefined, '成功的操作同样要有审计')
  assert.equal(rec.ok, true, '成功的操作必须记 ok:true')
})

test('#1201 反证：18 个工具每一个都必须产生审计（旧实现只有 8 个）', async () => {
  const names = Object.keys(ARGS)
  assert.equal(names.length, 18, '工具面应为 18 个；实际 ' + names.length)
  const missing = []
  for (const name of names) {
    const { face, audits } = makeFace({
      browserOpen: SNAPSHOT_OK,
      browserState: SNAPSHOT_OK,
    })
    const { byName } = applyBrowser(face)
    const tool = byName(name)
    assert.notEqual(tool, undefined, '工具必须存在：' + name)
    try { await tool.execute(ARGS[name], EXEC) } catch { /* 抛错也要留痕，下面照查 */ }
    if (!audits.some((a) => a.tool === name)) missing.push(name)
  }
  assert.deepEqual(missing, [], '以下工具完全没有审计记录：' + missing.join(', '))
})
