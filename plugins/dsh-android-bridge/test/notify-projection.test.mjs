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
  boundReportBody,
  formatDuration,
  reportOutcomeLabel,
  sessionTag,
  shouldEmitTodo,
  shouldPopupReport,
  summarize,
  todoProgress,
  turnEndKind,
  turnEndOk,
  visibleText,
  REPORT_BODY_MAX,
  REPORT_BODY_TRUNCATED,
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
    // 0.14.2 D15-B **产品意图裁定**（不是缺陷修复）：interrupted 由引擎崩溃/自动重启产生，
    // 不是用户动作的结果。自动重启风暴下每轮 turn/end 都产一条 report ⇒ 每轮 heads-up 一次，
    // 而弹窗里没有任何可操作内容 —— 用户看到的就是「频繁弹窗」。故改为不弹（与 aborted 同组）。
    // 注意这是**只改 popup 不改投递**：report 条目照常产出并进通知栏（见下面 popup 字段行为面用例）。
    { reason: { kind: 'interrupted' }, ok: false, label: '被中断（进程重启）', popup: false },
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

test('汇报：interrupted 不弹，但载荷完整生成（D15-B；内容不得静默丢失）', () => {
  // D15-B 判据 (a)：不再 heads-up。
  // D15-B 判据 (b) 的**单元级形态**：popup=false 只表示「不打断」，不代表「不投递」——
  // endTurn 仍返回完整载荷（outcome/label/turn/duration），调用方照常把它写进 .notify.ndjson，
  // 壳侧只据 popup 做降级（NotifyCenter.formDecision），条目仍在通知栏可见。
  // 若将来有人把 interrupted 改成「直接 return null / 不产条目」，本用例即判红。
  const s = new SessionNotifyState()
  s.startTurn('s1', 7, NOW)
  s.countToolCall('s1')
  s.setSummary('s1', '重启前的进度')
  const r = s.endTurn({
    sessionId: 's1',
    turn: 7,
    reason: { kind: 'interrupted' },
    now: NOW + 1_500,
  })
  assert.notEqual(r, null, 'interrupted 必须仍产出载荷（不得静默丢弃）')
  assert.equal(r.outcome, 'interrupted')
  assert.equal(r.outcomeLabel, '被中断（进程重启）')
  assert.equal(r.summary, '重启前的进度', '摘要必须保留')
  assert.equal(r.toolCount, 1)
  assert.equal(r.durationMs, 1_500)
  assert.equal(r.popup, false, 'D15-B：interrupted 不得 heads-up')
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

// ── 0.14.1 设备缺陷：汇报摘要必须只取可见正文（不得把思考块当回答）────────────────────
//
// 缺陷本体（设备实报：「长按查看详情」显示的不是最终输出，而是某一段的思考内容）：
// 上游 `TextBlock { type:'text'; text }` 与 `ReasoningBlock { type:'reasoning'; text }`
// **共用 `text` 字段名**（dsh/packages/llm/llm/src/types.ts:54-64）。投影层写的是
// `content.map(c => c.text ?? '').join('')`——**按字段取值而不按类型过滤**；思考块在一条
// assistant message 里通常排在最前，再经 `summarize(text, 120)` 硬截断，于是报告栏首行
// 呈现的正是思考的开头。同一条 summary 还是通知展开正文与 `.live.ndjson` 的 `sum` 来源，
// 故这组用例同时断言两个信道。
//
// 形为「行为测试」而非 grep：真的走 apply() 注册的 session/event 监听，再把文件读回来。

/** 用桩 ctx 跑一次 apply()，emit 给定事件序列，回读两个信道的行。 */
function notifyChannelsFrom(events) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d5-notify-'))
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
  for (const ev of events) emit({ id: 's1' }, ev)
  const readLines = (name) => {
    let raw = ''
    try { raw = readFileSync(join(dir, name), 'utf8') } catch { return [] }
    return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  }
  return {
    notify: readLines('.notify.ndjson'),
    live: readLines('.live.ndjson'),
    // 旧信道（issue #561）：老壳的通知来源，写入时机必须与 turn/end 同刻。
    taskDone: readLines('.task-done.ndjson'),
  }
}

// 思考段刻意排在正文之前（上游常态），且带一个只属于思考的标记串供反证引用。
const THINKING_TEXT = '先判断用户到底要什么，再决定用哪个工具，这段推理绝不该出现在汇报里'
const VISIBLE_TEXT = '三处缺陷都已修好，门禁全绿。'

/** 一轮：assistant/message（给定 content 块）+ turn/end，返回两个信道的行。 */
function oneTurn(contentBlocks) {
  return notifyChannelsFrom([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: contentBlocks } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
}

test('D5：汇报摘要只取 type==="text"，思考块不得混入（报告栏与通知同源）', () => {
  const { notify, live } = oneTurn([
    { type: 'reasoning', text: THINKING_TEXT },
    { type: 'text', text: VISIBLE_TEXT },
  ])
  const report = notify.find((e) => e.kind === 'report')
  assert.ok(report, '必须写出 report 行（报告栏的数据源）')
  assert.equal(report.summary, VISIBLE_TEXT, '摘要必须是可见正文本身')
  assert.equal(report.summary.includes('绝不该出现'), false, '思考文本不得进入汇报摘要')
  const textLine = live.find((e) => e.k === 'text')
  assert.ok(textLine, '必须写出 .live.ndjson 的 text 行（工具行 chip 的数据源）')
  assert.equal(textLine.sum, VISIBLE_TEXT)
  assert.equal(textLine.sum.includes('绝不该出现'), false, '实时流不得把思考当回答')
})

test('D5 反证：思考块排在正文之后、或夹在中间，同样不得混入（顺序无关）', () => {
  for (const blocks of [
    [{ type: 'text', text: VISIBLE_TEXT }, { type: 'reasoning', text: THINKING_TEXT }],
    [{ type: 'reasoning', text: THINKING_TEXT }, { type: 'text', text: VISIBLE_TEXT }, { type: 'reasoning', text: THINKING_TEXT }],
  ]) {
    const report = oneTurn(blocks).notify.find((e) => e.kind === 'report')
    assert.equal(report.summary, VISIBLE_TEXT, JSON.stringify(blocks))
  }
})

test('D5 退化：只产出思考时摘要为空，绝不把思考当回答顶上去', () => {
  const report = oneTurn([{ type: 'reasoning', text: THINKING_TEXT }]).notify.find((e) => e.kind === 'report')
  assert.equal(report.summary, '', '没有可见正文时摘要必须为空')
  assert.equal(report.outcomeLabel, '已完成', '空摘要下首行退化为只有结果标签（可接受的结果退化，优于显示思考）')
})

test('D5 兼容分支：整条消息无任何块带 type 时才退化为取全部 text', () => {
  // 上游恒定带 type；这条兜底只为「未知 provider 的旧形状」，避免从「显示思考」劣化成「什么都不显示」。
  assert.equal(visibleText([{ text: 'A' }, { text: 'B' }]), 'AB')
  assert.equal(visibleText([{ type: 'text', text: 'A' }, { type: 'reasoning', text: 'B' }]), 'A')
  assert.equal(visibleText([{ type: 'tool-call', text: '不是正文' }]), '')
  assert.equal(visibleText([{ type: 'reasoning', text: THINKING_TEXT }, undefined, 'not-an-object']), '')
  assert.equal(visibleText(undefined), '')
  assert.equal(visibleText('不是数组'), '')
})

test('D5 源码门禁：不得再出现「按字段取值拼 content」的写法', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const code = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')
  assert.equal(
    /content\.map\(\s*\(\s*c\s*\)\s*=>\s*c\.text/.test(code),
    false,
    'D5：不得再按字段取值拼 content（思考块与正文块共用 text 字段名，必须按 type 过滤）',
  )
  assert.match(code, /visibleText\(content\)/, 'D5：两条 assistant/message 路径都必须走 visibleText')
})

// ── issue #561：旧信道 .task-done.ndjson 的写入时机（中途不得弹「任务完成」）──────────
//
// 缺陷本体（v0.14.9 用户实测）：任务还在跑（引擎侧显示「运行中 19m」），通知栏已弹「任务完成」。
// 根因是 appendTaskMarker 写在 `case 'assistant/message'` 分支里——每收到一条 assistant 消息
// 就写一行标记，不等 turn/end。壳侧 NotifyStore.notifyChannelActive 是进程内开关，只有先消费到
// 一条 report/silent 才置位，所以任务跑到一半（尚无 report 行）时旧信道照常投递。
// 修法：写入点移到 turn/end，判据复用 shouldPopupReport（aborted/interrupted 不写）。
// 下面三条覆盖「不写 / 写一条 / aborted 不写」，第一条即负控：写入点放回 assistant/message 即红。

test('issue #561：assistant/message 不写 task marker（任务中途不得弹「任务完成」）', () => {
  const { taskDone } = notifyChannelsFrom([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一步做完了' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二步做完了' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第三步正在做' }] } } },
  ])
  assert.deepEqual(taskDone, [], 'assistant/message 期间旧信道必须一行都不写（否则中途就弹完成）')
})

test('issue #561：turn/end(completed) 恰好写一条，字段取该轮 report', () => {
  const { taskDone, notify } = notifyChannelsFrom([
    { type: 'session/title', data: { title: '跑门禁' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '中间进度' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: VISIBLE_TEXT }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const report = notify.find((e) => e.kind === 'report')
  assert.ok(report, '新信道必须同时写出 report 行')
  assert.equal(taskDone.length, 1, '一轮只写一条标记（不得按 assistant 消息条数写）')
  assert.equal(taskDone[0].sessionId, report.sessionId, 'sessionId 取该轮 report')
  assert.equal(taskDone[0].title, report.title, 'title 取该轮 report')
  assert.equal(taskDone[0].title, '跑门禁', '标题必须来自 session/title')
  assert.equal(taskDone[0].text, report.summary, 'text 取该轮 report 的 summary')
  assert.equal(taskDone[0].text, VISIBLE_TEXT, '摘要必须是该轮最后的可见正文')
})

test('issue #561：摘要为空时 text 回落「任务完成」，不写空正文', () => {
  const { taskDone } = notifyChannelsFrom([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  assert.equal(taskDone.length, 1)
  assert.equal(taskDone[0].text, '任务完成')
})

test('issue #561：turn/end(aborted) 不写 task marker，但新信道照常投递 report', () => {
  const { taskDone, notify } = notifyChannelsFrom([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做到一半被按停' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ])
  assert.deepEqual(taskDone, [], 'aborted 不写旧信道标记（与 NT-05 新信道一致：用户自己按停不弹）')
  const report = notify.find((e) => e.kind === 'report')
  assert.ok(report, '新信道仍须投递 report 条目（不得静默丢失）')
  assert.equal(report.popup, false)
})

// ── 0.14.1 D6：报告栏可滚动正文（摘要之外必须真的有可滚的内容）────────────────────
//
// 设备实报「长按查看详情…无法在不改变窗口大小的情况下滚动查看输出」。代码事实：
//   ① 报告栏此前只渲染 head+summary / 用时·工具 / 产出 三行；
//   ② summary 经单行化 + `summarize(text, 120)` 硬截断 → **恒不超高** → 滚动区间恒为 0。
// 即「栏内可滚动」这条验收判据在 120 字上限下恒真而无意义：不是滚动坏了，是没有可滚的内容。
// 修法是把该轮可见正文有界地一并落进 report 条目（8 KiB + 显式截断标记）。
// 下面同时钉住「有界」这一半——无界落盘会把 512 KiB 的信道几十轮就撑爆、把历史汇报挤掉。

test('D6：summary 截到 120 字，body 保留全文（二者同源不同用途）', () => {
  const s = new SessionNotifyState()
  s.startTurn('s1', 1, NOW)
  const long = '正文段落。'.repeat(60)      // 300 字，远超 120
  s.setSummary('s1', long)
  const r = s.endTurn({ sessionId: 's1', turn: 1, reason: { kind: 'completed' }, now: NOW + 10 })
  assert.equal(r.summary.length, 120, '摘要仍按既有口径硬截断')
  assert.equal(r.body.length, long.length, '正文必须保留全文（这是「可滚动」的前提）')
  assert.equal(r.body, long)
  assert.equal(r.body.startsWith(r.summary.slice(0, 20)), true, '两者同源：正文以摘要开头')
})

test('D6：正文必须有界（8 KiB）+ 显式截断标记，不得静默截断', () => {
  const s = new SessionNotifyState()
  s.startTurn('s1', 1, NOW)
  s.setSummary('s1', 'x'.repeat(REPORT_BODY_MAX * 2))
  const r = s.endTurn({ sessionId: 's1', turn: 1, reason: { kind: 'completed' }, now: NOW + 10 })
  assert.equal(r.body.length, REPORT_BODY_MAX + REPORT_BODY_TRUNCATED.length, '正文长度必须是上限 + 标记')
  assert.equal(r.body.endsWith(REPORT_BODY_TRUNCATED), true, '截断必须显式，用户不得把截断处当全文结尾')
  assert.equal(REPORT_BODY_MAX <= 16 * 1024, true, '单轮正文上限必须远小于信道轮转上限（512 KiB）')
})

test('D6：正文不得跨轮残留（新一轮开始即清空）', () => {
  const s = new SessionNotifyState()
  s.startTurn('s1', 1, NOW)
  s.setSummary('s1', '第一轮正文')
  s.endTurn({ sessionId: 's1', turn: 1, reason: { kind: 'completed' }, now: NOW + 10 })
  s.startTurn('s1', 2, NOW + 20)
  const r = s.endTurn({ sessionId: 's1', turn: 2, reason: { kind: 'completed' }, now: NOW + 30 })
  assert.equal(r.body, '', '新一轮没有正文时不得把上一轮的正文带出来')
  assert.equal(r.summary, '')
})

test('D6：只产出思考块时正文为空（与 D5 的过滤一致，不得把思考当正文落盘）', () => {
  const report = oneTurn([{ type: 'reasoning', text: THINKING_TEXT }]).notify.find((e) => e.kind === 'report')
  assert.equal(report.body, '')
  assert.equal(JSON.stringify(report).includes('绝不该出现'), false, '思考文本不得进入任何落盘字段')
})

test('D6 行为面：report 行必须带 body 且等于可见正文全文', () => {
  const report = oneTurn([
    { type: 'reasoning', text: THINKING_TEXT },
    { type: 'text', text: VISIBLE_TEXT },
  ]).notify.find((e) => e.kind === 'report')
  assert.equal(report.body, VISIBLE_TEXT, '.notify.ndjson 的 report 须携带正文供壳侧滚动区渲染')
})

test('D6 兼容分支：boundReportBody 对空值/非字符串安全', () => {
  assert.equal(boundReportBody(undefined), '')
  assert.equal(boundReportBody(''), '')
  assert.equal(boundReportBody('   '), '')
  assert.equal(boundReportBody('保留\n换行'), '保留\n换行', '正文必须保留换行（报告栏按原样多行渲染）')
})
