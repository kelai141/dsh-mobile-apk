// issue #1392：撤销是**破坏性**动作——必须先给 diff 预览 + 确认；取消时一个破坏性请求都不发。
// 以及成功后不再整页 reload（会掐断正在流式回复的一轮）。
//
// 判据跑**真实 vendored 字节**（vendor/dsh-undo-savepoint/lib/client.js）：把 undoNow 从源码里切出来，
// 用假 window.confirm / 假 api / 假 act 驱动，断言「有没有发出破坏性请求」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../vendor/dsh-undo-savepoint/lib/client.js', import.meta.url), 'utf8')

/** 从源码里切出 `const <name> = ...` 到配对花括号结束（含分号）。 */
function extract(name) {
  const start = source.indexOf('const ' + name + ' = ')
  assert.ok(start > 0, '找不到 ' + name + '（源码漂移了就要同步这里）')
  const braceAt = source.indexOf('{', start)
  assert.ok(braceAt > start, name + ' 后面没有花括号体')
  let depth = 0
  for (let i = braceAt; i < source.length; i += 1) {
    const c = source[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1) + ';'
    }
  }
  throw new Error(name + ' 花括号不配对')
}

function harness(confirmAnswer, preview) {
  const acts = []
  const apiCalls = []
  const confirmTexts = []
  const factory = new Function(
    't', 'api', 'act', 'window', 'busy',
    extract('undoNow') + '\nreturn { undoNow };',
  )
  const t = (key) => 'msg:' + key
  const api = async (url) => { apiCalls.push(url); return preview ?? { ok: true, diff: [] } }
  const act = (kind, url, payload) => { acts.push({ kind, url, payload }) }
  const window = { confirm: (text) => { confirmTexts.push(String(text)); return confirmAnswer } }
  const fns = factory(t, api, act, window, false)
  return { fns, acts, apiCalls, confirmTexts }
}

const PREVIEW = {
  ok: true,
  id: 'snap-target',
  diff: [{ name: 'settings.yaml', added: 3, removed: 1 }, { name: '.env', added: 0, removed: 2 }],
}

test('#1392 确认返回 false 时：不得发出任何破坏性请求（撤销此前是唯一没有确认的）', async () => {
  const { fns, acts } = harness(false, PREVIEW)
  await fns.undoNow()
  assert.deepEqual(acts, [], '取消后仍然发出了动作：' + JSON.stringify(acts))
})

test('#1392 取消后页面状态未变：除**预览**外没有别的请求', async () => {
  const { fns, apiCalls, acts } = harness(false, PREVIEW)
  await fns.undoNow()
  assert.equal(apiCalls.length, 1, '只应有一次预览请求：' + JSON.stringify(apiCalls))
  assert.match(apiCalls[0], /\/api\/undo\/diff\?id=undo/, '预览必须请求服务端算出的撤销目标：' + apiCalls[0])
  assert.deepEqual(acts, [], '取消路径不得有动作')
})

test('#1392 确认框必须列出**本次会改的文件**（diff 预览），而不是空泛一句', async () => {
  const { fns, confirmTexts } = harness(false, PREVIEW)
  await fns.undoNow()
  assert.equal(confirmTexts.length, 1, '必须弹一次确认')
  const text = confirmTexts[0]
  assert.match(text, /msg:panel\.confirm\.undo/, '确认文案走 i18n 键：' + text)
  assert.match(text, /settings\.yaml/, '确认框必须列出会改的文件：' + text)
  assert.match(text, /\+3 -1/, '必须给出增删行数：' + text)
  assert.match(text, /\.env/, '第二个文件也要列出：' + text)
})

test('#1392 确认返回 true 时：必须真的发出撤销（判据不得恒真）', async () => {
  const { fns, acts } = harness(true, PREVIEW)
  await fns.undoNow()
  assert.equal(acts.length, 1, '确认后必须发出动作')
  assert.equal(acts[0].kind, 'undo')
  assert.equal(acts[0].url, '/api/undo/undo')
})

test('#1392 预览说没有可撤销目标时：确认后也不发请求（服务端会回「无可撤销」，没必要打）', async () => {
  const { fns, acts } = harness(true, { ok: true, id: null, noTarget: true, diff: [] })
  await fns.undoNow()
  assert.deepEqual(acts, [], '没有目标时不该发撤销请求：' + JSON.stringify(acts))
})

test('#1392 成功后不再整页 reload：改为派发事件（reload 会掐断流式回复）', () => {
  assert.equal(/location\.reload\s*\(/.test(source), false, '源码里仍有 location.reload()：整页重建会掐断正在进行的一轮回复')
  assert.match(source, /dsh-undo-config-changed/, '必须改为派发配置变更事件')
  assert.match(source, /dispatchEvent\(new CustomEvent\("dsh-undo-config-changed"/, '事件必须真的被派发')
})
