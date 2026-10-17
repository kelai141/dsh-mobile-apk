// T1 常驻 CPU 回归（2026-09-25；A7 升级 2026-10-11）：**零定时器** + 事件驱动 + describe 次数上界。
//
// 判据不是「字符串在场」，而是**可数的行为**：
//   ① 源码里不存在任何 setTimeout / setInterval —— 既无启动轮也无兜底轮询；
//   ② 事件驱动存在：settings/document-updated 到达时**不靠轮询**即跑一轮；
//   ③ 每次事件触发的 describe 调用次数有上界（旧实现同 tick 内 2-3 次）；
//   ④ 回归场景（用户添加自定义供应商）在事件路径下仍然可达。
//
// 【为什么 ① 从「间隔 >=30s」改成「一个定时器都没有」】
// 旧 ① 挡的是「默认间隔退回 5s ⇒ 常驻 24-26% CPU」。但设备实证（2026-10-10，
// $DSH_HOME/model-capability.log 380KB）显示：即使间隔是 120s，也照样每 120 秒写一行
// tick 日志、连续数日，而该设备当时 runAutoPass: routes=[] —— 定时轮本身就产不出价值。
// 所以「调大间隔」只是把成本摊薄，「一个定时器都不留」才是消除；新 ① 比旧 ① 更强：
// 它同时覆盖 5s、120s 以及任何未来重新引入的间隔。
//
// 反证（改坏必须判红，见末例 REVERSE 与 A7 的变异自证）：
//   - 塞回任意一个 setInterval/setTimeout -> ① 红；
//   - 去掉事件订阅 -> ② 红；
//   - 让 readDescriptor 每次重新 describe -> ③ 红。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { apply } from '../lib/index.js'

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// ── 净检出夹具（B-prime）：lib/catalog-snapshot.json 是**构建期产物** ─────────────────
//
// 真因（2026-09-26 CI 实锤）：该文件由协调仓 build-snapshot-013.mjs 的 0g 步生成，不在 git 里
// （.gitignore:19 `plugins/*/lib/`），而 `npm run build` 只跑 `tsc -p .`，不会生成它。
// 因此**净检出（CI）里它缺席**，而本机工作树里有（构建过）⇒ 同一份测试两处行为不同：
// CI 上 T1-⑤/⑥/X1-⑧ 取不到目录数据 → 写回不发生 → 断言判红；本机全绿。
//
// 处置：**不用 SKIP**（那会让 CI 永久丢掉 X1 的守卫，而 X1 正是咬过我们一次的 HMR 嵌套回归）。
// 改为「缺席则用夹具补上」，使 CI 与本地**同形真跑**；本地真快照在场时不覆盖。
//
// **写一次、永不删除**（2026-10-11 竞态实锤）：`node --test test/*.test.mjs` 把**每个文件放进独立
// 进程并行跑**，而本仓有 4 个文件共用这同一条快照路径。旧实现「谁写的谁删（after 里 rmSync）」于是
// 出现：进程 A 跑完删掉文件，进程 B 正要读 -> ENOENT，**同一份代码时绿时红**（实测净检出下 8 次里
// 失败 1 次；4 个写入者时 8 次里失败 5 次）。不删是安全的：各写入者内容完全相同（同一 FIXTURE）、
// 真快照由 build-snapshot-013.mjs 构建时无条件重生成、check-patch-mirror 第 392 行显式跳过该路径、
// .gitignore:19 已忽略 lib/。写入用「临时文件 + rename」保证读者看不到半截内容。
const SNAPSHOT = new URL('../lib/catalog-snapshot.json', import.meta.url)
const FIXTURE = new URL('./fixtures/catalog-snapshot.min.json', import.meta.url)

before(() => {
  if (existsSync(SNAPSHOT)) return
  const tmp = new URL(`${SNAPSHOT.pathname}.${process.pid}.tmp`, 'file:')
  copyFileSync(FIXTURE, tmp)
  try { renameSync(tmp, SNAPSHOT) } catch { /* 另一进程已抢先落盘（内容相同） */ }
  finally { try { rmSync(tmp, { force: true }) } catch { /* 已被 rename 移走 */ } }
})

/** 剥注释：只保留可执行/声明行，避免用文档串当判据（本仓三次踩过的坑）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const CODE = stripComments(SRC)

// ── 夹具：可数的 settings 假实现 + 可手动触发的事件总线 ─────────────────────────
function makeCtx(providers) {
  const listeners = new Map()
  let section = { providers }
  const state = { describes: 0, mutates: 0, saves: 0, disposer: undefined }
  const settings = {
    describe() {
      state.describes += 1
      // 上游 describe 的 options 被忽略：这里也返回全部命名空间，逼调用方按 ns 查找
      return [
        { ns: 'llm-pi-ai', value: section, revision: state.describes },
        { ns: 'llm-deepseek', value: {}, revision: 0 },
      ]
    },
    async mutate(ns, ops) {
      state.mutates += 1
      const op = ops[0]
      if (op && op.op === 'set' && op.path[0] === 'providers') {
        const route = op.path[1]
        section = { providers: { ...section.providers, [route]: { ...section.providers[route], models: op.value } } }
      }
      return {}
    },
  }
  // 忠实模拟 cordis 的服务表与可选依赖（ctx.get strict 语义 / ctx.inject 延迟回调）。
  // 见 save-triggered-fill.test.mjs 同类夹具的说明：夹具若不忠实，
  // 「A6 在真机上永不注册」这类缺陷会恒不可见（2026-10-11 设备实锤教训）。
  const services = new Map()
  const pending = []
  const routes = []
  const runPending = () => {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].names.every((n) => services.has(n))) {
        const item = pending.splice(i, 1)[0]
        item.cb(ctx)
      }
    }
  }
  const ctx = {
    settings,
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    effect: (fn) => { state.disposer = fn() },
    get: (name) => services.get(name),
    inject(names, cb) { pending.push({ names, cb }); runPending() },
    provide(name, value) { services.set(name, value); runPending() },
    tools: { register: () => {} },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
  }
  const emit = (name, ...args) => { for (const l of listeners.get(name) ?? []) l(...args) }
  return {
    ctx,
    state,
    get section() { return section },
    emit,
    /**
     * 模拟一次「用户在设置页保存」：先把新内容写进 section，再发保存事件。
     *
     * 顺序与上游一致（settings.write 先落盘、describe、再 emit），因此这是唯一
     * 能让本插件看到变化的入口——它没有任何定时器可依赖。
     * @param mutate - 收到当前 section，返回新 section（省略则只发事件）。
     */
    save(mutate) {
      if (typeof mutate === 'function') section = mutate(section) ?? section
      state.saves += 1
      emit(EV, 'llm-pi-ai', state.saves)
    },
    hasListener: (name) => (listeners.get(name) ?? []).length > 0,
    dispose() { if (state.disposer) state.disposer() },
  }
}

// 固定 40ms 睡眠在慢机上是假失败源（0.14.8 CI 实测）：写回链路要跨若干微任务与一次
// settings.mutate，CI 冷启动时 40ms 内跑不完，于是「写回 0 次」被判成「自触发环未收敛」。
// 这里是**等待条件成立**，不是等待固定时长——判据强度不变，只去掉对机器速度的依赖。
const flush = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
/** 轮询等待谓词成立（默认最多 2s）；超时不抛错，交由调用方的断言给出真实判据。 */
const waitFor = async (predicate, timeoutMs = 2000, stepMs = 10) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await flush(stepMs)
  }
  return predicate()
}

const EV = 'settings/document-updated'

// ── ① 零定时器：不存在任何周期/延迟装置 ────────────────────────────────────────
test('T1-① 源码里不存在任何 setTimeout / setInterval（含启动轮与兜底轮询）', () => {
  // 这条同时覆盖旧的「默认间隔是 5s」「默认间隔是 120s」两种回归形态：
  // 只要还有一个定时器，就还有一条与用户操作无关的常驻路径。
  for (const banned of ['setTimeout', 'setInterval']) {
    assert.ok(!CODE.includes(banned), '源码仍含 ' + banned + '（A7 要求零定时器）')
  }
  // setImmediate 本身不是定时器（零延迟、一次性），这里只锁它的**用法**：
  // 只允许出现在让出一轮事件循环的 yieldAutoPass 里，不得成为任何循环驱动。
  const immediateUses = CODE.split('setImmediate').length - 1
  assert.equal(immediateUses, 1, 'setImmediate 出现 ' + immediateUses + ' 次（应只有 yieldAutoPass 一处）')
  assert.match(CODE, /const yieldAutoPass = \(\) => new Promise<void>\(\(resolve\) => setImmediate\(resolve\)\)/,
    'setImmediate 不在 yieldAutoPass 里（出现了一处意外的异步驱动）')
  // 周期语义的配置项也必须消失，否则「没实现定时器但留了配置」会误导后来者接回去。
  assert.ok(!/pollInterval|intervalSeconds|scanInterval/.test(CODE), '仍存在周期扫描配置项')
  assert.ok(!/const fallbackSeconds/.test(CODE), '仍存在兜底间隔计算')
})

// ── ② 事件驱动存在：不靠轮询也能触发 ──────────────────────────────────────────
test('T1-② settings/document-updated 到达即触发一轮（不依赖轮询）', async (t) => {
  const c = makeCtx({})
  apply(c.ctx, {})
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  assert.ok(c.hasListener(EV), '未订阅 ' + EV + '（事件驱动缺失）')

  const before = c.state.describes
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  assert.ok(
    c.state.describes > before,
    '事件到达后 describe 次数未增加（before=' + before + ' after=' + c.state.describes + '）：事件没有驱动 tick',
  )
})

test('T1-② 非 llm-pi-ai 命名空间的事件必须被忽略（不为其做全量 describe）', async (t) => {
  const c = makeCtx({})
  apply(c.ctx, {})
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  const before = c.state.describes
  c.emit(EV, 'ui-theme', 1)
  c.emit(EV, 'llm-deepseek', 2)
  await flush()
  assert.equal(c.state.describes, before, '无关命名空间触发了 tick（应只关心 llm-pi-ai）')
})

// ── ③ 每 tick describe 次数上界 ───────────────────────────────────────────────
test('T1-③ 单次事件触发内 describe 次数 <= 2（旧实现同 tick 内 3+ 次）', async (t) => {
  const providers = {
    gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'gw-model' }] },
  }
  const c = makeCtx(providers)
  apply(c.ctx, {})
  // 旧实现会泄漏一个 setInterval(1h)，断言先抛时 dispose 走不到 -> node:test 永不排空
  // 事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底（现已是防御性保留）。
  t.after(() => c.dispose())
  await flush()

  const before = c.state.describes
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  const used = c.state.describes - before
  // 旧实现：signatureOf(1) + routesToConsider(1) + providerFromSettings(1)/route = >=3
  assert.ok(used >= 1, '事件后没有读描述符（无从得知新值）')
  assert.ok(used <= 2, '单次事件用了 ' + used + ' 次 describe（>2）：tick 内未复用描述符')
})

test('T1-③ 描述符复用：readDescriptor 必须带缓存（结构断言，剥注释后可执行行）', () => {
  const fn = /const readDescriptor = \(\) => \{([\s\S]*?)\n    \}/.exec(CODE)
  assert.ok(fn, '找不到 readDescriptor')
  const body = fn[1]
  assert.match(body, /tickSection === undefined/, 'readDescriptor 没有缓存判断（每次都会重新 describe）')
  assert.match(body, /tickSection =/, 'readDescriptor 没有写缓存')
})

// ── ④ 回归场景：事件路径下仍走完整补给链 ────────────────────────────────────────
test('T1-④ 回归场景：事件触发后补给链仍可达（用户口径不能退化）', async (t) => {
  const providers = {
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      // 声明了模型但不含 reasoningEfforts —— 正是回归场景（新加供应商、档位缺失）
      models: [{ id: 'gw-model' }],
    },
  }
  const c = makeCtx(providers)
  apply(c.ctx, {})
  // 旧实现会泄漏 setInterval(1h)：断言先抛时 dispose 走不到 -> 事件循环永不排空
  // -> CI 卡死且拿不到汇总行。故挂 t.after 兜底（防御性保留）。
  t.after(() => c.dispose())
  await flush()
  // 用户的保存动作：新加模型（这正是 2026-09-10 的现场）
  c.save((s) => ({ providers: { ...s.providers, gateway: { ...s.providers.gateway, models: [{ id: 'gw-model' }] } } }))
  await flush()

  const models = c.section.providers.gateway.models
  t.diagnostic('describes=' + c.state.describes + ' mutates=' + c.state.mutates + ' models=' + JSON.stringify(models))
  assert.ok(c.state.describes > 0, '事件路径连 describe 都没发生')
  if (c.state.mutates > 0) {
    assert.ok(
      models.some((m) => typeof m === 'object' && m.reasoningEfforts !== undefined),
      '发生了写回但模型条目仍无 reasoningEfforts',
    )
  }
})

// ── REVERSE：反证可判红 ───────────────────────────────────────────────────────
test('T1-REVERSE 反证可判红：改坏任一处都会让 ①/②/③ 判据失败', () => {
  // A) 塞回任意一个定时器 -> ① 必须判红
  const withTimer = CODE.replace('const stamps = createStampStore()',
    'const stamps = createStampStore()\n    setInterval(() => {}, 120000)')
  assert.ok(withTimer.includes('setInterval'), '反证构造失败 A')
  assert.ok(!withTimer.includes('const stamps = createStampStore()\n    setInterval'.replace('const stamps = createStampStore()\n    setInterval', 'NOPE')),
    '反证构造 A 无判别力')
  // ① 的判据在这份「坏代码」上不成立
  assert.ok(withTimer.includes('setInterval'), '塞回 setInterval 后 ① 的判据必须失败（判据有判别力）')

  // B) 去掉事件订阅 -> ② 必须判红
  const noEvent = CODE.replace(/'settings\/document-updated'/, "'settings/never-fired'")
  assert.ok(noEvent.includes("'settings/never-fired'"), '反证构造失败 B')
  assert.ok(!noEvent.includes("'settings/document-updated'"), '移除事件名失败')

  // C) 去掉 readDescriptor 的缓存 -> ③ 必须判红
  const noCache = CODE.replace(/if \(tickSection === undefined\)/, 'if (false)')
  const fn = /const readDescriptor = \(\) => \{([\s\S]*?)\n    \}/.exec(noCache)
  assert.ok(fn, '反证构造失败 C：readDescriptor 未找到')
  assert.ok(!/tickSection === undefined/.test(fn[1]),
    '去掉缓存判断后 ③ 的判别必须失败（判据有判别力）')
})

// ── ⑤ 回归场景（真实目录 + 端到端写回）───────────────────────────────────────
// 用出货目录快照里真实存在的 id（zai-org/GLM-5.3-Fast：单条 entry、有 wire 等级、
// thinkingFormat=openai），这样才能真的走完 discover → mergeCatalog → applyModelPatch。
const REAL_ID = 'zai-org/GLM-5.3-Fast'

test('T1-⑤ 回归场景端到端：保存新模型后真实写回 reasoningEfforts（用户口径不退化）', async (t) => {
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      // 供应商已在、尚无模型：稍后的保存把模型加进来 —— 正是 2026-09-10 的用户现场
      models: [],
    },
  })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  // 用户在设置页「获取模型列表 → 勾选 → 保存」
  c.save((s) => ({ providers: { ...s.providers, gateway: { ...s.providers.gateway, models: [{ id: REAL_ID }] } } }))
  await flush()

  const models = c.section.providers.gateway.models
  const entry = models.find((m) => typeof m === 'object' && m.id === REAL_ID)
  t.diagnostic('mutates=' + c.state.mutates + ' entry=' + JSON.stringify(entry))
  assert.equal(c.state.mutates, 1, '保存路径没有产生写回（回归场景失效）')
  assert.ok(entry && entry.reasoningEfforts, '写回后条目仍无 reasoningEfforts（档位不会出现）')
  assert.ok(entry.reasoningEfforts.high, 'reasoningEfforts 缺少 high 档')
})

test('T1-⑤ 反证：没有任何保存事件时，等再久也不写回（无定时器可兜底）', async (t) => {
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      models: [{ id: REAL_ID }],
    },
  })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  const before = c.state.mutates
  // 刻意等一段：旧实现里 setInterval 或启动 setTimeout 会在这段内触发一轮（并写回）。
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(c.state.mutates, before, '未保存却发生了写回（说明还有定时器在跑）')
  assert.equal(c.state.mutates, 0, '无保存事件时不应写回（A7：已无任何定时轮可兜底）')
})

// ── ⑥ 自触发环收敛（lead 复核问题 1）────────────────────────────────────────
test('T1-⑥ 自触发环收敛：连续自身写回后签名稳定，不无限自旋', async (t) => {
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      models: [],
    },
  })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  // 模拟上游：我方 mutate 后上游会再发一次 document-updated（同一 ns）。
  // 在 mutate 里回灌事件，制造「写回 -> 事件 -> 再写回」的自触发环候选。
  const origMutate = c.ctx.settings.mutate
  c.ctx.settings.mutate = async (ns, ops, rev) => {
    const out = await origMutate(ns, ops, rev)
    queueMicrotask(() => c.emit(EV, ns, 99))
    return out
  }

  // 用户保存新模型；此后每一轮都由「我方写回自己引发的那个事件」驱动。
  c.save((s) => ({ providers: { ...s.providers, gateway: { ...s.providers.gateway, models: [{ id: REAL_ID }] } } }))
  // 先等到「首次写回真的发生」，再给足余量观察是否出现第二次（自旋）。
  // 固定轮次睡眠在慢机上会在首写回之前就断言，见 flush 处的说明。
  await waitFor(() => c.state.mutates >= 1)
  await flush()
  await flush()

  // 收敛判据：首次写回之后再无第二次（字段已填 → diff 无新增 → 不再 mutate）
  t.diagnostic('mutates=' + c.state.mutates + ' describes=' + c.state.describes)
  assert.equal(c.state.mutates, 1, '写回发生了 ' + c.state.mutates + ' 次：自触发环未收敛（应为 1）')
})

// ── ⑦ 无事件面时的行为：不注册监听，也**不**悄悄退回轮询 ────────────────────────
test('T1-⑦ ctx.on 缺席时不注册监听，且不会退回任何定时器', async (t) => {
  const c = makeCtx({})
  delete c.ctx.on
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  assert.ok(!c.hasListener(EV), '本夹具不应有事件订阅')
  // 关键：事件面缺席的旧处置是「改用 30s 轮询兜底」——那正是要根除的常驻路径。
  // 现在没有任何可退回的定时器，因此这里只断言「不该发生写回」。
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(c.state.mutates, 0, '事件面缺席时不应有任何写回（更不该有轮询兜底）')
})

// ── ⑧ X1 回归：事件回调必须把写回送出 hmr 事务上下文 ────────────────────────────
// 现场（2026-09-25）：settings/document-updated 是在用户那次写事务**之内**同步 emit 的，
// 事件回调里直接调 settings.mutate -> configEditor.edit -> hmr.runExclusive 被判嵌套：
//   Error: HMR transactions cannot be nested
//     at Proxy.runExclusive (dsh-hmr/lib/index.js) at Proxy.edit (dsh-config-editor) ...
// 判据：事件到达后写回必须**不在**原事务的异步上下文里执行。
test('X1-⑧ 事件回调把 tick 送出当前异步上下文（否则写回被 hmr 判嵌套）', async (t) => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage()
  const c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: REAL_ID }] } })
  apply(c.ctx, {})
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()

  // 观测点（C，2026-09-26）：**主判据落在 settings.describe 上**，而不是 settings.mutate。
  // 为什么提前：mutate 只在「目录命中且确有字段要补」时才发生，因此依赖 lib/catalog-snapshot.json；
  // 而 describe 是 tick 的**第一件事**（deferrer 回调一进来就读描述符），与目录数据无关。
  // 主判据挂在 describe 上，X1 的守卫就不再随目录数据有无而失效 —— 覆盖不丢失，且两个环境同形。
  // mutate 观测保留为**加强项**（确有写回时再断言一次，证明端到端路径同样在事务外）。
  const descCtx = []
  const origDescribe = c.ctx.settings.describe
  c.ctx.settings.describe = function (...args) {
    descCtx.push(als.getStore())
    return origDescribe.apply(this, args)
  }
  let sawMutateContext = null
  const origMutate = c.ctx.settings.mutate
  c.ctx.settings.mutate = async (ns, ops, rev) => {
    if (sawMutateContext === null) sawMutateContext = als.getStore()
    return origMutate(ns, ops, rev)
  }

  // 复刻上游：在事务标记内同步 emit 事件（与 settings.write 的 emit 位置同形）
  await new Promise((resolve) => { als.run(true, () => { c.emit(EV, 'llm-pi-ai', 1); resolve() }) })
  await new Promise((r) => setTimeout(r, 400))

  // 主判据：tick 的 describe 必须已经脱离事务上下文
  assert.ok(descCtx.length > 0, '事件没有驱动 tick（describe 未被调用，夹具问题，判据无效）')
  assert.equal(descCtx.every((x) => x === undefined), true,
    'tick 的 settings.describe 仍在 hmr 事务上下文内执行（descCtx=' + JSON.stringify(descCtx)
      + '）=> 说明 deferrer 没把 tick 送出事务')
  // 加强项：若真的发生了写回，写回也必须在事务外
  if (sawMutateContext !== null) {
    assert.equal(sawMutateContext, undefined,
      '写回仍在 hmr 事务上下文内执行（sawMutateContext=' + String(sawMutateContext)
        + '）=> 会抛 HMR transactions cannot be nested')
  }
})

test('X1-⑧ 反证：不经 deferrer 直接调用会在事务内（说明判据有判别力）', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage()
  // 直接对照：事务内同步调用普通异步函数，其上下文必然继承（这就是回归现场）
  let inside = null
  await new Promise((resolve) => {
    als.run(true, () => { queueMicrotask(() => { inside = als.getStore(); resolve() }) })
  })
  assert.equal(inside, true, '对照夹具失效：普通调度应继承上下文')
})

// ── E-P2-4：S3/S5 合流后，tick 仍不得触发任何网络（T1 常驻 CPU 前科）─────────────
// 判据是**可数的 fetch 次数**，不是字符串在场：给自动补给喂一个计数 fetch，
// 断言它一次都没被调用；并断言 describe 次数不因本轮改动增加。
// 【精确化（P2-S3 启动刷新，2026-09-26）】
// 旧断言是「自动补给期间 0 次网络」。方案 §2.2 的降级链要求「无缓存/陈旧 -> 后台拉一次」，
// 所以现在正确的判据是**分档**的，不是放宽：
//   - 总次数 <= 1（每次进程启动最多一次刷新）；
//   - 第 2 次及以后恒为 0（tick / 事件 / 轮询路径绝不联网）；
//   - 无缓存 -> 恰好 1 次；有新鲜缓存 -> 0 次。
// 两条变异反证见文件末（删刷新 -> 无缓存那档判红；把刷新塞进 tick -> tick 那档判红）。
const MODELSDEV_URL = 'https://models.dev/api.json'

/** 在隔离 DSH_HOME 下跑一次 apply()，返回该窗口内的 fetch 调用。 */
async function runWithFetchCounter({ opts = {}, seedCache = null, settleMs = 200 } = {}) {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelsdev-fetch-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  if (seedCache) fs.writeFileSync(path.join(dir, 'models-dev.json'), JSON.stringify(seedCache))
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    // 返回一个形状正确的最小响应，让刷新路径能走完并落盘
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ p: { id: 'p', name: 'P', models: { m: { id: 'm', limit: { context: 1000, output: 100 }, modalities: { input: ['text'] } } } } }),
    }
  }
  let c
  try {
    c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'gw-model' }] } })
    apply(c.ctx, { ...opts })
    await new Promise((r) => setTimeout(r, settleMs))
    return { calls, state: c.state, dir, home: dir }
  } finally {
    globalThis.fetch = realFetch
    if (c) c.dispose()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const freshCache = () => ({
  schema: 1, source: 'models.dev', generatedAt: new Date().toISOString(), modelCount: 0, models: [],
})
const staleCache = () => ({
  schema: 1, source: 'models.dev', generatedAt: new Date(Date.now() - 8 * 86400000).toISOString(), modelCount: 0, models: [],
})

test('P2-S3 无缓存 -> 启动后台刷新恰好拉 1 次（干净安装上 S3 必须自动生效）', async () => {
  const { calls } = await runWithFetchCounter({ seedCache: null })
  assert.equal(calls.length, 1, '无缓存时应恰好拉 1 次，实际 ' + calls.length + '：' + calls.join(', '))
  assert.equal(calls[0], MODELSDEV_URL)
})

test('P2-S3 有新鲜缓存 -> 启动不拉（0 次）', async () => {
  const { calls } = await runWithFetchCounter({ seedCache: freshCache() })
  assert.deepEqual(calls, [], '新鲜缓存不应产生流量，实际 ' + calls.length + ' 次')
})

test('P2-S3 缓存陈旧 -> 启动后台刷新恰好拉 1 次', async () => {
  const { calls } = await runWithFetchCounter({ seedCache: staleCache() })
  assert.equal(calls.length, 1, '陈旧缓存应恰好重拉 1 次，实际 ' + calls.length)
})

test('P2-S3 config.modelsDev=false -> 整个 S3 关闭，含启动刷新（0 次）', async () => {
  const { calls } = await runWithFetchCounter({ opts: { modelsDev: false }, seedCache: null })
  assert.deepEqual(calls, [], 'S3 关闭时不得拉取，实际 ' + calls.length + ' 次')
})

test('E-P2-4 tick/事件/轮询路径恒 0 次网络（总次数 <=1，第二次及以后为 0）', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelsdev-tick-'))
  const savedHome = process.env.DSH_HOME
  // 必须显式隔离 DSH_HOME 并**放入新鲜缓存**：否则这一轮自己就会发起合法的启动刷新，
  // 判据会依赖开发机上真实 DSH_HOME 的状态（曾因此误判一次）。放新鲜缓存后，
  // 启动刷新本就不该发生，于是「任何一次 fetch」都是越界，断言最严且确定。
  process.env.DSH_HOME = dir
  fs.writeFileSync(path.join(dir, 'models-dev.json'), JSON.stringify(freshCache()))
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('tick 不应联网') }
  let c
  try {
    c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'gw-model' }] } })
    apply(c.ctx, {})
    await new Promise((r) => setTimeout(r, 150))
    // 主动再触发几轮事件 tick，覆盖 event 路径
    for (let i = 0; i < 3; i++) { c.emit(EV, 'llm-pi-ai', i + 1); await new Promise((r) => setTimeout(r, 60)) }
    assert.deepEqual(calls, [], '启动轮/事件路径发生了网络：' + calls.join(', '))
    assert.ok(calls.length <= 1, '总网络次数应 <=1，实际 ' + calls.length)
  } finally {
    globalThis.fetch = realFetch
    if (c) c.dispose()
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('E-P2-4 反证：该计数面确实能观测 fetch（否则上面的空数组毫无判别力）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('x') }
  try {
    await globalThis.fetch('https://example.invalid/probe').catch(() => undefined)
    assert.equal(calls.length, 1, '计数面失效：无法观测 fetch')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('E-P2-4 tick 的 describe 次数不因 S3/S5 合流增加（上界仍为 2）', async () => {
  const c = makeCtx({
    gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: REAL_ID }] },
  })
  apply(c.ctx, {})
  await new Promise((r) => setTimeout(r, 150))
  const used = c.state.describes
  assert.ok(used <= 2, '启动轮用了 ' + used + ' 次 describe（>2）：S3/S5 合流增加了描述符读取')
  c.dispose()
})

// ── E-P2-2 端到端：S3 命中 -> 真的写回 settings ──────────────────────────────
// 前面的 models-dev.test.mjs 验的是合流函数；这条验的是「合流出来的字段确实走到了 mutate」，
// 即 S3 不是只在报告里好看。做法：把 models.dev 快照放到 DSH_HOME 下的缓存路径（读缓存，不联网），
// 启动一轮后断言 settings 里被写入了 models.dev 提供的字段。
test('E-P2-2 端到端：S3 提供的长尾字段真的写回 settings（离线读缓存）', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelsdev-e2e-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    // 造一个「引擎目录里没有、models.dev 里有」的 id
    const LONG_TAIL = 'vendor-only-long-tail-9b'
    fs.writeFileSync(path.join(dir, 'models-dev.json'), JSON.stringify({
      schema: 1, source: 'models.dev', generatedAt: new Date().toISOString(), modelCount: 1,
      models: [{ id: LONG_TAIL, provider: 'encyclopedia', contextWindow: 131072, maxTokens: 8192, input: ['text'] }],
    }))
    const c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [] } })
    apply(c.ctx, {})
    await new Promise((r) => setTimeout(r, 200))
    // A7：无定时器 => 写回只可能由「保存」触发，因此这里必须真的模拟一次保存。
    c.save((s) => ({ providers: { ...s.providers, gateway: { ...s.providers.gateway, models: [{ id: LONG_TAIL }] } } }))
    await new Promise((r) => setTimeout(r, 200))
    const entry = c.section.providers.gateway.models.find((m) => m && m.id === LONG_TAIL)
    assert.ok(c.state.mutates >= 1, 'S3 命中却没有写回（mutates=' + c.state.mutates + '）')
    assert.equal(entry.contextWindow, 131072, 'models.dev 的 contextWindow 应写回')
    assert.equal(entry.maxTokens, 8192, 'models.dev 的 maxTokens 应写回')
    c.dispose()
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('E-P2-2 端到端反证：无 models.dev 缓存时同一 id 不写回（未知保持未知）', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelsdev-e2e-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const LONG_TAIL = 'vendor-only-long-tail-9b'
    const c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: LONG_TAIL }] } })
    apply(c.ctx, {})
    await new Promise((r) => setTimeout(r, 200))
    const entry = c.section.providers.gateway.models.find((m) => m && m.id === LONG_TAIL)
    assert.equal(c.state.mutates, 0, '无任何来源却发生了写回（凭空造事实）')
    assert.equal(entry.contextWindow, undefined)
    c.dispose()
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── P2-S3 结构守卫（与运行期计数互补：一个防「实现被改掉」，一个防「行为退化」）──────
const SRC_INDEX = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const CODE_INDEX = SRC_INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('P2-S3 结构：启动刷新有「每进程最多一次」闩锁', () => {
  assert.match(CODE_INDEX, /let startupRefreshStarted = false/, '找不到启动刷新闩锁声明')
  // 闩锁必须在真正拉取之前置位，否则失败后会被反复重试（重试风暴）
  const fn = /const refreshModelsDevOnStartup = async \(\)[\s\S]*?\n  \}/.exec(CODE_INDEX)
  assert.ok(fn, '找不到 refreshModelsDevOnStartup')
  const setAt = fn[0].indexOf('startupRefreshStarted = true')
  const fetchAt = fn[0].indexOf('ensureModelsDev(true')
  assert.ok(setAt >= 0, '闩锁未被置位')
  assert.ok(fetchAt > setAt, '闩锁必须在拉取之前置位（否则失败会重试风暴）')
})

test('P2-S3 结构：自动补给（tick）调用点必须显式禁网', () => {
  const call = /const found = await discover\(route, \{([^}]*)\}/.exec(CODE_INDEX)
  assert.ok(call, '找不到 runAutoPass 的 discover 调用')
  assert.match(call[1], /allowModelsDevNetwork: false/, 'tick 未显式禁网')
  assert.match(call[1], /useCachedModelsDev: true/, 'tick 未声明只用缓存')
})

test('P2-S3 结构：apply() 的 diag 行必须报告 modelsDev 状态（可观测性）', () => {
  assert.match(CODE_INDEX, /modelsDev=\$/m, 'diag 行未报告 modelsDev 状态')
  assert.match(CODE_INDEX, /const modelsDevStatus = \(\): string =>/, '找不到 modelsDevStatus')
  for (const s of ['disabled', 'no-cache', 'stale', 'fresh']) {
    assert.ok(CODE_INDEX.includes("'" + s + "'"), 'modelsDevStatus 缺少状态 ' + s)
  }
})


test('C4 automatic pass yields before fresh signature and observes intervening settings', async (t) => {
  const c = makeCtx({})
  t.after(() => c.dispose())
  const original = c.ctx.settings.describe
  let peerTurnRan = false
  let readsAfterPeerTurn = 0
  c.ctx.settings.describe = () => {
    const descriptor = original()
    if (c.state.describes === 1) setImmediate(() => { peerTurnRan = true })
    else if (peerTurnRan) readsAfterPeerTurn++
    return descriptor
  }
  apply(c.ctx, {})
  await flush()
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  assert.ok(readsAfterPeerTurn >= 1, 'fresh signature was read in the same turn as initial projection')
  assert.equal(c.state.mutates, 0)
})

test('C4 disposal during the pass checkpoint prevents further discovery or signature reads', async (t) => {
  const c = makeCtx({ gateway: { api: 'openai-completions', models: [{ id: 'unrecognized-model' }] } })
  t.after(() => c.dispose())
  const original = c.ctx.settings.describe
  c.ctx.settings.describe = () => {
    const descriptor = original()
    if (c.state.describes === 1) setImmediate(() => c.dispose())
    return descriptor
  }
  apply(c.ctx, {})
  await flush()
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  assert.equal(c.state.describes, 1, 'disposed pass performed another settings projection')
  assert.equal(c.state.mutates, 0)
})