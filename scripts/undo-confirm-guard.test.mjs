// issue #1383：`window.confirm()` 返回 false 时，三个破坏性动作**不得**执行。
//
// 为什么需要这条：宿主原先没实现 onJsConfirm，Android 默认直接 cancel() —— confirm()
// 恒为 false。修宿主之后，「恒 false」不再发生；但**页面侧的守卫本身**也必须被钉住：
// 任何人把 `if (!window.confirm(...)) return;` 删掉或挪到动作之后，破坏性操作就会在没有
// 确认的情况下执行，而这在宿主侧完全看不出来。
//
// 判据跑的是**真实 vendored 字节**（vendor/dsh-undo-savepoint/lib/client.js）里那三个函数，
// 不是复制品：把函数体从源码里切出来，用假 window.confirm 驱动，断言 act() 有没有被调用。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SRC = new URL('../vendor/dsh-undo-savepoint/lib/client.js', import.meta.url)
const source = readFileSync(SRC, 'utf8')

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

/** 把四个函数装进一个沙箱：注入 t / api / act / window / busy。 */
function harness(confirmAnswer) {
  const acts = []
  const body = [
    extract('fetchDiff'),
    extract('restoreOne'),
    extract('toggleSafeMode'),
    extract('deleteOne'),
  ].join('\n')
  const factory = new Function(
    't', 'api', 'act', 'window', 'busy',
    body + '\nreturn { restoreOne, toggleSafeMode, deleteOne };',
  )
  const t = (key) => 'msg:' + key
  const api = async () => ({ ok: true, diff: [], active: false })
  const act = (kind, url, payload) => { acts.push({ kind, url, payload }) }
  const window = { confirm: () => confirmAnswer }
  const fns = factory(t, api, act, window, false)
  return { fns, acts }
}

const snap = { id: 'snap-1' }

test('#1383 确认返回 false 时：恢复 / 删除 / 安全模式三个动作都不得执行', async () => {
  const { fns, acts } = harness(false)
  await fns.restoreOne(snap)
  await fns.toggleSafeMode()
  fns.deleteOne(snap)
  assert.deepEqual(acts, [],
    'confirm 返回 false 却执行了破坏性动作：' + JSON.stringify(acts))
})

test('#1383 反向：确认返回 true 时三个动作都必须真的发出（判据不得恒真）', async () => {
  const { fns, acts } = harness(true)
  await fns.restoreOne(snap)
  await fns.toggleSafeMode()
  fns.deleteOne(snap)
  assert.equal(acts.length, 3, 'confirm 返回 true 时应有三个动作，实得 ' + acts.length)
  assert.deepEqual(acts.map((a) => a.url).sort(), [
    '/api/undo/remove', '/api/undo/restore', '/api/undo/safe-mode',
  ])
})

test('#1383 守卫必须在动作**之前**：删掉守卫的实现必须能被这条判据发现', async () => {
  // 负控思路的静态面：每个动作调用点之前都必须在同一个函数体里出现 window.confirm 守卫。
  for (const [name, actionMarker] of [
    ['restoreOne', 'act("restore"'],
    ['toggleSafeMode', 'act("safe-mode"'],
    ['deleteOne', 'act("delete"'],
  ]) {
    const body = extract(name)
    const guardAt = body.indexOf('window.confirm(')
    const actAt = body.indexOf(actionMarker)
    assert.ok(guardAt > 0, name + ' 里没有 window.confirm 守卫')
    assert.ok(actAt > guardAt, name + ' 的守卫必须在动作之前（实得 guard@' + guardAt + ' act@' + actAt + '）')
  }
})
