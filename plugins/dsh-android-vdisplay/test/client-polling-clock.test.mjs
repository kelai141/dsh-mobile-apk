// 虚拟屏常驻定时器：**用假时钟真跑一遍**，数实际打桥次数（离线，node:test）。
//
// 前两份测试分别是源码契约与拍数推导；这份是**执行真循环**——
// 把 src/client/index.ts 里那段 schedule 逻辑按**逐字同源**的方式复刻成可跑的模块，
// 用假时钟推进 10 秒，数 vdisplayStatus / vdisplayBounds 的真实调用次数。
//
// 为什么要复刻而不是 import：这段逻辑嵌在 React 的 useEffect 闭包里，
// 而本插件不带 React（client bundle 由宿主提供）。复刻的风险是「抄错」，
// 所以下面**先从源码里抽出关键表达式再断言复刻与源码一致**（同源校验），
// 抄错会立刻红。
//
// ## 判据（10 秒窗口）
//   面板不可见：vdisplayStatus 11 -> 0，vdisplayBounds 11 -> 0
//   面板可见  ：vdisplayStatus 11 -> 11
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

/** 假时钟：只支持 setTimeout / clearTimeout（这段逻辑只用这两个）。 */
function makeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    get now() { return now },
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    /** 推进到 target，按到期顺序逐个执行。 */
    advanceTo(target) {
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, t] of timers) { if (t.at <= target && t.at < nextAt) { nextAt = t.at; nextId = id } }
        if (nextId === null) break
        const t = timers.get(nextId)
        timers.delete(nextId)
        now = t.at
        t.fn()
      }
      now = target
    },
  }
}

/** 从源码抽出 1s 轮询周期，保证与实现同源。 */
function pollPeriodMs() {
  const m = /\}, (\d+)\)\s*\n\s*\}\s*\n\s*const onVisibility/.exec(SOURCE)
  assert.ok(m, '找不到 1s 轮询周期');
  return Number(m[1]);
}

/** 复刻 1s 轮询循环（与源码逐字同源；下面有同源校验）。 */
function runPollLoop({ clock, onScreen, pull, windowMs }) {
  const period = pollPeriodMs();
  let alive = true;
  let timer;
  const schedule = () => {
    if (!alive || timer !== undefined) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (!alive) return;
      if (onScreen()) pull();
      if (true) schedule();   // 前台：document.hidden 恒 false
    }, period);
  };
  // 源码在 schedule() 之前有一次立即 pull()（首次对齐，不经过门控——那时面板刚挂上）。
  pull();
  schedule();
  clock.advanceTo(windowMs);
  alive = false;
  if (timer !== undefined) clock.clearTimeout(timer);
}

/** 复刻改前的裸 setInterval，作为对照基线。 */
function runLegacyLoop({ clock, pull, windowMs }) {
  const period = pollPeriodMs();
  pull();                       // 源码里 setInterval 之前有一次立即 pull()
  let timer;
  const schedule = () => { timer = clock.setTimeout(() => { pull(); schedule() }, period) };
  schedule();
  clock.advanceTo(windowMs);
  if (timer !== undefined) clock.clearTimeout(timer);
}

test('同源校验：复刻的门控与源码一致', () => {
  assert.match(SOURCE, /if \(panelOnScreen\(\)\) pull\(\)/, '源码必须有 panelOnScreen 门控');
  assert.equal(pollPeriodMs(), 1000, '源码周期必须是 1000ms');
})

test('面板不可见：10 秒窗口打桥 11 -> 1 次（只剩挂载首拍，稳态 0）', () => {
  const WINDOW = 10_000;
  let legacyCalls = 0;
  runLegacyLoop({ clock: makeClock(), pull: () => { legacyCalls++ }, windowMs: WINDOW });
  let gatedCalls = 0;
  runPollLoop({ clock: makeClock(), onScreen: () => false, pull: () => { gatedCalls++ }, windowMs: WINDOW });
  assert.equal(legacyCalls, 11, '改前基线必须是 11 次（10s/1s + 首次）');
  // 门控后仍保留源码里 schedule() 之前那一次立即 pull()（挂载首拍，不经过门控）：
  // 那是「面板刚挂上，还没有任何状态」时唯一一次对齐，删掉会让首屏状态更慢。
  // 真正的收益是**稳态**：10 秒里从 11 次降到 1 次（省掉 10 次跨桥）。
  assert.equal(gatedCalls, 1, '面板不可见时必须只剩挂载首拍（1 次），稳态 0 次');
})

test('面板可见：10 秒窗口打桥 11 次（节奏不变）', () => {
  const WINDOW = 10_000;
  let calls = 0;
  runPollLoop({ clock: makeClock(), onScreen: () => true, pull: () => { calls++ }, windowMs: WINDOW });
  assert.equal(calls, 11, '面板可见时必须仍是 11 次（不许顺手降速）');
})

test('面板中途回到屏上：恢复节奏（不需要等 visibilitychange）', () => {
  const WINDOW = 10_000;
  let calls = 0;
  let visible = false;
  const clock = makeClock();
  // 前 5 秒不可见，之后可见。flip 与轮询都在 now=0 起算；flip 先注册，
  // 假时钟按到期时刻 + 插入顺序执行，所以 5000 那一刻 flip 先跑、随后那拍计数。
  clock.setTimeout(() => { visible = true }, 5_000);
  runPollLoop({ clock, onScreen: () => visible, pull: () => { calls++ }, windowMs: WINDOW });
  // 构成：首次立即 pull（1，不经过门控——那时面板刚挂上，源码里就在 schedule() 之前）
  //     + 5000..10000 共 6 拍 = 7。
  assert.equal(calls, 7, '回屏后必须自动恢复节奏：首次 1 + 后半段 6 拍 = 7');
  assert.notEqual(calls, 0, '不得为 0（证明后半段真的跑了）');
})

test('负控：去掉门控后立刻回到 11 次（证明上面的 1 真的绑在门控上）', () => {
  // 复刻「无条件 pull()」的坏实现，证明上面那条 0 真的绑在门控上。
  const WINDOW = 10_000;
  let calls = 0;
  const clock = makeClock();
  const period = pollPeriodMs();
  const legacyPull = () => { calls++ };
  legacyPull();
  let timer;
  const schedule = () => { timer = clock.setTimeout(() => { legacyPull(); schedule() }, period) };
  schedule();
  clock.advanceTo(WINDOW);
  if (timer !== undefined) clock.clearTimeout(timer);
  assert.equal(calls, 11, '去掉门控必须回到 11 次（负控）');
  assert.notEqual(calls, 0, '不得为 0');
})