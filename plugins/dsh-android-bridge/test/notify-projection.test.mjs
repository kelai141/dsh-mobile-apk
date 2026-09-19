// 通知投影回归（0.14.0-preview §6.2/§6.5）：
// D13（turn/end 按 reason.kind 判成败）与 D14（标题取 session/title）各 6/2 组用例；
// 待办进度 n/N、汇报载荷、节流。撤掉修复则本文件变红（§6.5 的「门禁拒合」条件）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import {
  SessionNotifyState,
  TURN_END_KINDS,
  formatDuration,
  reportOutcomeLabel,
  sessionTag,
  shouldEmitTodo,
  shouldPopupReport,
  summarize,
  todoProgress,
  turnEndKind,
  turnEndOk,
} from '../lib/notify-projection.js'

const NOW = 1_800_000_000_000

// ── NT-22 / D13：reason.kind 逐 kind 回归（6 种闭集全覆盖）──

test('D13：只有 reason.kind == completed 判成功', () => {
  assert.equal(turnEndOk({ kind: 'completed' }), true)
  for (const kind of TURN_END_KINDS.filter((k) => k !== 'completed')) {
    assert.equal(turnEndOk({ kind }), false, kind + ' 不得判成功')
  }
})

test('D13：6 种 kind 全部可识别（fixture 逐条）', () => {
  const fixtures = [
    { reason: { kind: 'completed' }, ok: true, label: '已完成', popup: true },
    { reason: { kind: 'error', error: { message: 'boom' } }, ok: false, label: '失败', popup: true },
    { reason: { kind: 'blocked' }, ok: false, label: '被阻塞', popup: true },
    { reason: { kind: 'aborted', reason: { kind: 'user' } }, ok: false, label: '已中止', popup: false },
    { reason: { kind: 'max-tokens' }, ok: false, label: '输出超限', popup: true },
    { reason: { kind: 'interrupted' }, ok: false, label: '被中断（进程重启）', popup: true },
  ]
  for (const f of fixtures) {
    const kind = turnEndKind(f.reason)
    assert.equal(kind, f.reason.kind)
    assert.equal(turnEndOk(f.reason), f.ok, f.reason.kind)
    assert.equal(reportOutcomeLabel(kind), f.label)
    assert.equal(shouldPopupReport(kind), f.popup, f.reason.kind)
  }
})

test('D13 反向自证：旧误读形态（reason.outcome === success）恒 false', () => {
  // 旧代码读的字段不存在——用它判定会得到 false，正是缺陷本体。
  const legacyPayload = { turn: 4, reason: { kind: 'completed' } }
  assert.equal(legacyPayload.outcome === 'success', false)
  assert.equal(turnEndOk(legacyPayload.reason), true)
})

test('D13 兜底：缺字段/非对象/未知字符串一律 unknown 且不判成功', () => {
  for (const bad of [undefined, null, {}, { kind: 'future-kind' }, 'completed', 42]) {
    assert.equal(turnEndKind(bad), 'unknown')
    assert.equal(turnEndOk(bad), false)
  }
  // 未知 kind 仍要弹（否则上游新增 kind 时用户永远收不到「任务结束」）
  assert.equal(shouldPopupReport('unknown'), true)
})

// ── NT-23 / D14：标题来源 ──

test('D14：通知标题取 session/title，不读 session.header.title', () => {
  const s = new SessionNotifyState()
  // 旧代码形态：session.header.title 不存在 → 恒回落字面量
  const legacySession = { id: 'sess-a', header: { id: 'sess-a' } }
  assert.equal('title' in legacySession.header, false)
  s.setTitle('sess-a', '修复通知标题')
  assert.equal(s.titleFor(legacySession.id), '修复通知标题')
})

test('D14：未收到 session/title 时回落可区分标识，不是字面量「任务完成」', () => {
  const s = new SessionNotifyState()
  const t = s.titleFor('sess-without-title')
  assert.notEqual(t, '任务完成')
  assert.match(t, /^会话 [0-9a-f]{6}$/)
  // 两个不同会话必须得到不同标识
  assert.notEqual(t, s.titleFor('another-session'))
  assert.equal(sessionTag('sess-without-title').length, 6)
})

test('D14：连续两轮不同会话标题各自正确', () => {
  const s = new SessionNotifyState()
  s.setTitle('a', '标题 A')
  s.setTitle('b', '标题 B')
  assert.equal(s.titleFor('a'), '标题 A')
  assert.equal(s.titleFor('b'), '标题 B')
})

// ── 工作汇报载荷（NT-05 的数据面）──

test('汇报载荷：用时/工具数/摘要/产出文件名齐备', () => {
  const s = new SessionNotifyState()
  s.setTitle('s1', '跑门禁')
  s.startTurn('s1', 4, NOW)
  s.countToolCall('s1')
  s.countToolCall('s1')
  s.countToolCall('s1')
  s.setSummary('s1', '门禁全绿\n\n可以合并')
  s.setPresented('s1', [{ path: '/data/user/0/pkg/files/out/report.md' }, { path: 'build/app.apk' }])
  const r = s.endTurn({ sessionId: 's1', turn: 4, reason: { kind: 'completed' }, now: NOW + 84_000 })
  assert.equal(r.outcome, 'completed')
  assert.equal(r.outcomeLabel, '已完成')
  assert.equal(r.durationMs, 84_000)
  assert.equal(formatDuration(84_000), '1m24s')
  assert.equal(r.toolCount, 3)
  assert.equal(r.turn, 4)
  assert.equal(r.summary, '门禁全绿 可以合并')
  assert.deepEqual(r.presentedFiles, ['report.md', 'app.apk'])
  assert.equal(r.popup, true)
})

test('汇报：aborted(kind=user) 不弹，但载荷仍然生成（不得静默丢失）', () => {
  const s = new SessionNotifyState()
  s.startTurn('s1', 1, NOW)
  const r = s.endTurn({ sessionId: 's1', turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } }, now: NOW + 500 })
  assert.equal(r.outcome, 'aborted')
  assert.equal(r.popup, false)
})

test('汇报：新一轮开始清空上一轮摘要与产出（不串轮）', () => {
  const s = new SessionNotifyState()
  s.startTurn('s1', 1, NOW)
  s.setSummary('s1', '第一轮')
  s.setPresented('s1', [{ path: '/tmp/a.md' }])
  s.endTurn({ sessionId: 's1', turn: 1, reason: { kind: 'completed' }, now: NOW + 10 })
  s.startTurn('s1', 2, NOW + 20)
  const r = s.endTurn({ sessionId: 's1', turn: 2, reason: { kind: 'completed' }, now: NOW + 30 })
  assert.equal(r.summary, '')
  assert.deepEqual(r.presentedFiles, [])
})

// ── 待办进度（NT-06 的数据面）──

test('待办进度：自己数 n/N 且当前项优先取 in_progress', () => {
  const p = todoProgress([
    { content: '读计划', status: 'completed' },
    { content: '跑门禁', status: 'in_progress' },
    { content: '写报告', status: 'pending' },
  ])
  assert.equal(p.done, 1)
  assert.equal(p.total, 3)
  assert.equal(p.current, '跑门禁')
})

test('待办进度：无 in_progress 时回落第一条未完成；空表安全', () => {
  const p = todoProgress([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'pending' },
  ])
  assert.equal(p.current, 'b')
  const empty = todoProgress(undefined)
  assert.deepEqual(empty, { done: 0, total: 0, current: '' })
})

test('待办节流：≥1s 且进度签名变化才重投（同签名不重投）', () => {
  const s = new SessionNotifyState()
  const p1 = todoProgress([{ content: 'a', status: 'in_progress' }])
  assert.equal(s.acceptTodo('s1', p1, NOW), true)
  assert.equal(s.acceptTodo('s1', p1, NOW + 5_000), false, '签名不变不得重投')
  const p2 = todoProgress([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
  ])
  assert.equal(s.acceptTodo('s1', p2, NOW + 500), false, '未满 1s 不得重投')
  assert.equal(s.acceptTodo('s1', p2, NOW + 1_000), true)
  assert.equal(shouldEmitTodo(0, '', 'x', NOW, 1000), true, '首条恒允许')
})

// ── 摘要 ──

test('摘要：单行化 + 硬截断（上限 120 字，超出加省略号）', () => {
  assert.equal(summarize('  a\n\n b\t c '), 'a b c')
  const long = summarize('x'.repeat(300))
  assert.equal(long.length, 120)
  assert.equal(long.endsWith('…'), true)
  assert.equal(summarize('', 120), '')
})

// ── 门禁：源码面反向自证（D13/D14 不得复活，信道写入必须在场）──

test('源码门禁：不得再读 session.header.title / reason.outcome', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
  assert.equal(/\.header\?\.title/.test(code), false, 'D14：不得读 session.header.title')
  assert.equal(/reason\.outcome|d\?\.outcome === 'success'/.test(code), false, 'D13：不得把 reason 当 outcome')
})

test('源码门禁：.notify.ndjson 写入与六种 kind 的壳侧消费面在场', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /\.notify\.ndjson/)
  assert.match(src, /kind: 'report'/)
  assert.match(src, /kind: 'todo'/)
  assert.match(src, /NOTIFY_MAX/)
})

// ── 0.14.1 块H 依赖面：`.live.ndjson` 的 turn_end 行必须带 kind ────────────────────────
//
// 背景（T5 块H 完成态语义标签，详档 §5.2 选项 C）：壳侧 Overlay 读 `.live.ndjson` 的
// `turn_end.kind` 作为语义标签真源，`ok` 只是兜底。此前本仓**只写 ok、从不写 kind**，
// 于是壳侧只能走兜底：ok=false 时一律「结果未知」，无法区分失败/被阻塞/被中断/被取消。
//
// 形为「行为测试」而非 grep：真的走 apply() 注册的 session/event 监听，再把 .live.ndjson 读回来。

const SAVED_DSH_HOME = process.env.DSH_HOME
after(() => {
  if (SAVED_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = SAVED_DSH_HOME
})

/** 用桩 ctx 跑一次 apply()，emit 若干 turn/end，回读 .live.ndjson 的 turn_end 行。 */
function liveTurnEndLines(reasons) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t3-live-'))
  process.env.DSH_HOME = dir
  const listeners = new Map()
  const ctx = {
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: () => {} },
    get: () => undefined,
    provide: () => {},
    effect: () => () => {},
    on: (event, handler) => { listeners.set(event, handler); return () => {} },
  }
  apply(ctx)
  const emit = listeners.get('session/event')
  assert.equal(typeof emit, 'function', 'apply() 必须注册 session/event 监听')
  for (const reason of reasons) emit({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason } })
  const raw = readFileSync(join(dir, '.live.ndjson'), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.k === 'turn_end')
}

test('turn_end 行必须同时带 ok 与 kind（块H 语义标签的真源）', () => {
  const lines = liveTurnEndLines([{ kind: 'completed' }, { kind: 'error' }])
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.equal(typeof line.ok, 'boolean', 'ok 必须在场（壳侧兜底判据）')
    assert.equal(typeof line.kind, 'string', 'kind 必须在场（T5 块H 优先消费它；缺了只能退化成「结果未知」）')
  }
  assert.equal(lines[0].ok, true)
  assert.equal(lines[0].kind, 'completed')
  assert.equal(lines[1].ok, false)
  assert.equal(lines[1].kind, 'error', 'ok=false 时必须能区分出「失败」而不是笼统的未知')
})

test('turn_end 的 kind 覆盖六种闭集，且与 ok 同源一致', () => {
  const lines = liveTurnEndLines(TURN_END_KINDS.map((kind) => ({ kind })))
  assert.equal(lines.length, TURN_END_KINDS.length)
  for (const [i, kind] of TURN_END_KINDS.entries()) {
    // 取值必须落在 TURN_END_KINDS 内，且不得把未知/失败类映射成 completed
    assert.ok(TURN_END_KINDS.includes(lines[i].kind), kind + ' -> ' + String(lines[i].kind))
    assert.equal(lines[i].kind, kind, 'kind 必须逐字透传，不得改名或归一')
    assert.equal(lines[i].ok, kind === 'completed', kind + ' 的 ok 必须与 kind 一致')
  }
})

test('未知 reason 时 kind 不得是 completed（防「把未知当成功」的假绿）', () => {
  // 三种「判不出成功」的形态：上游新增 kind、缺 reason、reason 非对象。
  const lines = liveTurnEndLines([{ kind: 'brand-new-kind' }, undefined, 'not-an-object'])
  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.notEqual(line.kind, 'completed', '未知 reason 绝不能判成 completed：' + JSON.stringify(line))
    assert.equal(line.ok, false, '未知 reason 的 ok 必须 false：' + JSON.stringify(line))
    assert.equal(line.kind, 'unknown', '未知 reason 的稳定占位是 unknown（T5 据此显示「结果未知」）')
    assert.equal(reportOutcomeLabel(line.kind), '结果未知', 'unknown 的文案不得是「已完成」')
  }
})
