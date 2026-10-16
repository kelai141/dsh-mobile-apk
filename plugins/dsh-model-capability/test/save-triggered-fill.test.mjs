// A1/A3/A5/A8 保存触发语义回归（0.14.6 功能 A）。
//
// 判据（SPEC-0.14.6 A1/A3/A5/A8 + Lead 2026-10-11 裁决）：
//   A1 保存触发：模型设置「获取模型列表 -> 勾选 -> 保存」时，只对该次**实际保存**的
//      非内置 provider 模型补缺失能力；获取列表/勾选过程不补；未勾选模型不补。
//   A3/A5 字段级、幂等、不覆盖用户已有值；歧义/身份不确定/目录无此模型不补。
//   A7 无定时器：唯一写触发源是保存事件。
//   A8 保存失败不得「UI 报成功但未写入」；我方写回失败不得影响用户保存结果。
//
// 反向用例（Lead 点名，必须判红能力）：
//   - 「同名不同版本」不得互相匹配；
//   - 「仅改 apiKey / baseURL 而模型集合未变」不得触发任何能力补齐。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

/** 插件源码（结构断言用：inject 声明等无法从行为面观测的事实）。 */
const INDEX_SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// lib/catalog-snapshot.json 是构建期产物：净检出（CI）里缺席，缺席则用夹具补上。
//
// **写一次、永不删除**（2026-10-11 竞态实锤）：`node --test test/*.test.mjs` 把**每个文件放进独立
// 进程并行跑**，而本仓有 4 个文件共用这同一条快照路径。旧实现「谁写的谁删（after 里 rmSync）」于是
// 出现：进程 A 跑完删掉文件，进程 B 正要读 -> ENOENT，**同一份代码时绿时红**（实测净检出下 8 次里
// 失败 1 次；4 个写入者时 8 次里失败 5 次）。不删是安全的：各写入者内容完全相同（同一 FIXTURE）、
// 真快照由 build-snapshot-013.mjs 构建时无条件重生成、check-patch-mirror 第 392 行显式跳过该路径、
// .gitignore:19 已忽略 lib/。写入用「临时文件 + rename」保证读者看不到半截内容。
//
// 夹具**必须如实声明本测试依赖的内置 provider**，否则断言前提会随环境静默改变（2026-10-11 CI 实锤）：
// 下面 A5 用例用 'openai' 举证「内置 provider 不补」，而旧夹具只声明 baseten，
// 于是净检出下 builtInProviders={baseten} -> 'openai' 被误判「非内置」-> 触发补齐 -> 该断言假红。
const SNAPSHOT = new URL('../lib/catalog-snapshot.json', import.meta.url)
const FIXTURE = new URL('./fixtures/catalog-snapshot.min.json', import.meta.url)
before(() => {
  if (existsSync(SNAPSHOT)) return
  const tmp = new URL(`${SNAPSHOT.pathname}.${process.pid}.tmp`, 'file:')
  copyFileSync(FIXTURE, tmp)
  try { renameSync(tmp, SNAPSHOT) } catch { /* 另一进程已抢先落盘（内容相同） */ }
  finally { try { rmSync(tmp, { force: true }) } catch { /* 已被 rename 移走 */ } }
})

const EV = 'settings/document-updated'
/** 出货目录快照里真实存在的 id（baseten 形态：带 thinkingLevelMap 与 thinkingFormat=openai）。 */
const REAL_ID = 'zai-org/GLM-5.3-Fast'
/** 出货目录里不存在的 id：任何来源都无声明 -> 必须不补。 */
const UNKNOWN_ID = 'this-model-is-not-in-any-catalog-9b'

/** 可数的 settings 假实现：与出货 settings 的 describe/mutate 语义同形。 */
function makeCtx(providers, hooks = {}) {
  const listeners = new Map()
  let section = { providers }
  const state = { describes: 0, mutates: 0, writes: [], saves: 0, disposer: undefined }
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
      state.writes.push(ops)
      if (hooks.beforeMutate) await hooks.beforeMutate(state, ops)
      if (hooks.reject) throw hooks.reject
      const op = ops[0]
      if (op && op.op === 'set' && op.path[0] === 'providers') {
        const route = op.path[1]
        section = { providers: { ...section.providers, [route]: { ...section.providers[route], models: op.value } } }
      }
      return {}
    },
  }
  // 服务表 + 可选依赖：忠实模拟 cordis 的 ctx.get / ctx.inject 语义。
  //
  // 为什么必须忠实（2026-10-11 设备实锤教训）：真实装配里我们的插件行**早于** webserver 行，
  // 而 ctx.get(name) 默认 strict（只返回已激活实现），故 apply 那刻读 webServer 必然 undefined。
  // 只有 webServer 到位后 ctx.inject 回调才跑、路由才注册。夹具若让 get 恒返回一个假对象，
  // 「A6 永不注册」这个缺陷就**恒不可见** —— 上一版夹具正是这么假绿的。
  const services = new Map()
  const pending = []
  const registeredRoutes = []
  const routesOf = () => registeredRoutes
  const runPending = () => {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i]
      if (item.names.every((n) => services.has(n))) {
        pending.splice(i, 1)
        item.cb(ctx)
      }
    }
  }
  const ctx = {
    settings,
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    effect: (fn) => { state.disposer = fn() },
    // cordis：未激活/未提供的服务读作 undefined（strict 语义）。
    get: (name) => services.get(name),
    // cordis：依赖可用后回调才跑；未声明进静态 inject，故不会挡住 apply()。
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
    registeredRoutes,
    routesOf,
    /** 模拟 webServer 更晚装配（真实拓扑：webserver 行在我们之后才加载）。 */
    provideWebServer() {
      ctx.provide('webServer', { register: (r) => { registeredRoutes.push(r); return () => {} } })
    },
    get section() { return section },
    emit,
    /** 模拟一次用户保存：先写内容、再发事件（顺序与 settings.write 一致）。 */
    save(mutate) {
      if (typeof mutate === 'function') section = mutate(section) ?? section
      state.saves += 1
      emit(EV, 'llm-pi-ai', state.saves)
    },
    modelsOf(route) { return (section.providers[route]?.models ?? []).map((m) => (typeof m === 'string' ? { id: m } : m)) },
    dispose() { if (state.disposer) state.disposer() },
  }
}

/**
 * 等插件的延迟工作跑完。
 *
 * 为什么不是固定墙钟延时（原实现是 `setTimeout(60)`）：插件这条链是
 * 「deferrer 的 MessageChannel 跳一次 -> async describe -> runAutoPass -> setImmediate」，
 * 它的长度是**事件循环轮数**，不是一个秒数。任何常量都在编码「这台机器有多快」这个假设。
 * 2026-10-16 实测：8 个忙循环加压下 A1 用例报「保存后应恰好写回一次，实际 0」，而空载单跑
 * 3/3 通过、整目录跑 3/3 通过——同一个文件在打包时随机判红，直接中止了本次全链构建。
 *
 * 为什么按轮数等就是充分的：插件设计上**零定时器**（A7，且有用例守着），所以一旦事件循环
 * 没有待办，就不存在「稍后还会产生一次写回」的来源。而工作一定在 `save()` / `apply()` 返回前
 * 就已入队（deferrer.defer 是同步 postMessage），因此逐轮推进不可能漏掉它。
 *
 * setImmediate 每一跳都是一次完整循环：若还有待完成的 I/O，poll 阶段会等它，续体随后落地。
 * 取 10 跳，远多于这条链所需（实测 3~4 跳即收敛），且与机器速度无关。
 * @returns 事件循环推进若干轮后的 promise。
 */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
const withModel = (route, model) => (s) => ({
  providers: { ...s.providers, [route]: { ...s.providers[route], models: [model] } },
})

// 所有用例都在一个「已配置的非内置 provider」上跑：gateway 不在出货目录的任何条目里。
const GATEWAY = 'my-custom-gateway'

// ── A1 正向：保存新模型 -> 补缺失能力 ────────────────────────────────────────
test('A1 保存新模型：只针对该模型补缺失能力，且一次只写一轮', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()

  const models = c.modelsOf(GATEWAY)
  const entry = models.find((m) => m.id === REAL_ID)
  t.diagnostic('mutates=' + c.state.mutates + ' entry=' + JSON.stringify(entry))
  assert.equal(c.state.mutates, 1, '保存后应恰好写回一次，实际 ' + c.state.mutates)
  assert.deepEqual(entry.reasoningEfforts, { off: 'none', low: 'low', high: 'high', max: 'max' }, '思考档位应取自真实目录')
  assert.deepEqual(entry.input, ['text', 'image'])
  assert.equal(entry.contextWindow, 1048576)
  assert.equal(entry.maxTokens, 262144)
})

// ── A1 反向：未勾选的模型不得被补 ────────────────────────────────────────────
test('A1 反向：同路由下未被本次保存涉及的模型一个字段都不动', async (t) => {
  const UNTOUCHED = 'other-model-not-selected'
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [{ id: UNTOUCHED }] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  // 首读建立基线（UNTOUCHED 已在基线里）

  // 用户只勾选了 REAL_ID
  c.save((s) => ({
    providers: { ...s.providers, [GATEWAY]: { ...s.providers[GATEWAY], models: [{ id: UNTOUCHED }, { id: REAL_ID }] } },
  }))
  await flush()

  const models = c.modelsOf(GATEWAY)
  const untouched = models.find((m) => m.id === UNTOUCHED)
  const fresh = models.find((m) => m.id === REAL_ID)
  t.diagnostic('untouched=' + JSON.stringify(untouched) + ' fresh=' + JSON.stringify(fresh))
  assert.ok(fresh.reasoningEfforts, '本次保存的模型应被补')
  assert.equal(untouched.reasoningEfforts, undefined, '未勾选的既有模型不得被补')
  assert.equal(untouched.contextWindow, undefined, '未勾选的既有模型不得被补 contextWindow')
})

// ── A1 反向：勾选过程/获取列表过程不触发（无保存就无写入）────────────────────
test('A1 反向：只做「获取模型列表」而不保存 -> 任何模型都不被补', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  // 「获取列表」在实现里不落 settings（候选列表是 UI 局部状态），因此插件看不到任何信号。
  // 判据：不保存 => 不写回。等一段以确保不是「还没跑到」。
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(c.state.mutates, 0, '获取列表过程触发了写回（A1 要求只在实际保存时补）')
  assert.deepEqual(c.modelsOf(GATEWAY), [], '不保存不应产生任何模型条目')
})

// ── A1 反向：仅改 apiKey/baseURL 而模型集合未变 -> 不补 ─────────────────────
test('A1 反向：仅改 baseURL/apiKey 而模型集合未变 -> 不触发任何能力补齐', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [], apiKey: 'k1' } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  // 先把模型加进去（这一次应当补），建立「模型已在基线」的状态。
  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()
  const afterFirst = c.state.mutates
  assert.equal(afterFirst, 1, '首次加模型应补一次')

  // 再改 baseURL 与 apiKey，模型集合一字未动。
  c.save((s) => ({
    providers: { ...s.providers, [GATEWAY]: { ...s.providers[GATEWAY], baseURL: 'https://gw2.example/v1', apiKey: 'k2' } },
  }))
  await flush()
  t.diagnostic('mutates=' + c.state.mutates + ' (first=' + afterFirst + ')')
  assert.equal(c.state.mutates, afterFirst, '仅改 baseURL/apiKey 却触发了能力补齐（A1 要求只处理本次保存的模型）')
})

// ── A1 反向：同名不同版本不得互相匹配 ───────────────────────────────────────
test('A1 反向：同名不同版本不得互相匹配（改版本号算新模型，但不套用旧版本能力）', async (t) => {
  const snapshotId = 'MiniMax-M3'
  const otherVersion = 'MiniMax-M2.7'
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [{ id: otherVersion }] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save((s) => ({
    providers: { ...s.providers, [GATEWAY]: { ...s.providers[GATEWAY], models: [{ id: otherVersion }, { id: snapshotId }] } },
  }))
  await flush()

  const models = c.modelsOf(GATEWAY)
  const older = models.find((m) => m.id === otherVersion)
  const newer = models.find((m) => m.id === snapshotId)
  t.diagnostic(JSON.stringify(models))
  // 关键判据：不得把目录里 M2.7 的能力写到 M3 条目上（反之亦然）。
  assert.equal(older.reasoningEfforts, undefined, '既有版本被顺带补齐（版本区分失效）')
  if (newer.contextWindow !== undefined && older.contextWindow !== undefined) {
    assert.notEqual(newer.contextWindow, older.contextWindow, '两个版本写出了相同能力值（疑似按名匹配）')
  }
})

// ── A3/A5：不覆盖用户已有值、字段级、幂等 ────────────────────────────────────
test('A5 字段级：用户已声明的字段不被覆盖，缺失字段才补', async (t) => {
  const USER_CW = 7777
  const c = makeCtx({
    [GATEWAY]: {
      baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [],
    },
  })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: REAL_ID, contextWindow: USER_CW, reasoningEfforts: { low: 'my-low' } }))
  await flush()

  const entry = c.modelsOf(GATEWAY).find((m) => m.id === REAL_ID)
  t.diagnostic(JSON.stringify(entry))
  assert.equal(entry.contextWindow, USER_CW, '用户声明的 contextWindow 被覆盖')
  assert.deepEqual(entry.reasoningEfforts, { low: 'my-low' }, '用户声明的 reasoningEfforts 被覆盖')
  // 未声明的字段仍然补上（字段级，而不是「有一条用户值就整条放弃」）
  assert.deepEqual(entry.input, ['text', 'image'], '未声明的 input 应被补')
})

test('A3 幂等：同一模型再保存一次不产生第二次写回', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()
  assert.equal(c.state.mutates, 1)

  // 再保存一次，模型内容一字不变（例如用户只改了别的路由字段）。
  c.save((s) => ({ providers: { ...s.providers } }))
  await flush()
  assert.equal(c.state.mutates, 1, '同一模型重复保存产生了第二次写回（非幂等）')
})

// ── A5：歧义/未知不补 ────────────────────────────────────────────────────────
test('A5 目录无此模型：保存后不得凭空写入任何能力字段', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: UNKNOWN_ID }))
  await flush()

  const entry = c.modelsOf(GATEWAY).find((m) => m.id === UNKNOWN_ID)
  t.diagnostic('mutates=' + c.state.mutates + ' entry=' + JSON.stringify(entry))
  assert.equal(c.state.mutates, 0, '目录无此模型却发生了写回（凭空造事实）')
  assert.deepEqual(entry, { id: UNKNOWN_ID }, '未知模型被写入了字段')
})

// ── A5：内置 provider 不处理 ─────────────────────────────────────────────────
test('A5 内置 provider 不在补齐范围（不与引擎自带目录打架）', async (t) => {
  // 'openai' 是出货目录里真实存在的 provider 之一，即上游口径的「内置」。
  const c = makeCtx({ openai: { baseURL: 'https://api.openai.com/v1', api: 'openai-completions', models: [] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel('openai', { id: REAL_ID }))
  await flush()
  t.diagnostic('mutates=' + c.state.mutates)
  assert.equal(c.state.mutates, 0, '内置 provider 不应被本插件补齐（A1 限定非内置）')
})

// ── A8：写回失败不得影响用户保存结果 ────────────────────────────────────────
test('A8 写回失败：用户保存仍然生效，失败如实记录且不重试风暴', async (t) => {
  const failure = Object.assign(new Error('settings namespace "llm-pi-ai" changed since it was read'), {
    name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT',
  })
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } }, { reject: failure })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()
  await flush()

  // A8 主判据：用户的保存本身没有被撤销/改写，仍是他写下的内容。
  const entry = c.modelsOf(GATEWAY).find((m) => m.id === REAL_ID)
  t.diagnostic('mutates=' + c.state.mutates + ' entry=' + JSON.stringify(entry))
  assert.deepEqual(entry, { id: REAL_ID }, '写回失败后用户的保存内容被改动了')
  // 冲突重试是有界的（MAX_WRITE_ATTEMPTS=3），不得无界循环。
  assert.ok(c.state.mutates <= 3, '写回失败后重试 ' + c.state.mutates + ' 次（应有界 <=3）')
  assert.ok(c.state.mutates >= 1, '写回没有被尝试（判据无判别力）')
})

test('A8 写回失败：不得把「未写入」当成「已写入」（失败后不落戳、不重复尝试）', async (t) => {
  let attempts = 0
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } }, {
    beforeMutate: () => { attempts += 1 },
    reject: Object.assign(new Error('boom'), { name: 'Error', code: 'SOME_FAILURE' }),
  })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()
  await flush()

  // 非冲突错误不得重试（只有 SETTINGS_CONFLICT 才有界重试）。
  t.diagnostic('attempts=' + attempts + ' mutates=' + c.state.mutates)
  assert.equal(attempts, 1, '非冲突错误被重试了 ' + attempts + ' 次（应恰好 1 次）')
  // 且失败后用户的模型条目保持原样（没有半写入的字段）。
  assert.deepEqual(c.modelsOf(GATEWAY).find((m) => m.id === REAL_ID), { id: REAL_ID })
})

// ── 可选服务：webServer 缺席时工具链必须仍然装配（headless 兼容）────────────
test('webServer 缺席（headless profile）时 apply 仍注册工具，只是不挂 A6 路由', async (t) => {
  // 回归背景：headless profile「不挂 Host / HTTP server / Web runtime」
  // （dsh-headless/cordis.patch.yml 原文）。若把 webServer 写进 inject，
  // cordis 就不满足依赖 -> apply() 根本不执行 -> **工具与保存触发补给全线失效**。
  // 因此 inject 只声明 ['tools','settings']，路由按可选服务读取。
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  // 本夹具的 get() 返回 undefined —— 等价于「没有 webServer 服务的 profile」。
  const tools = []
  c.ctx.tools = { register: (tool) => { tools.push(tool) } }
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()

  assert.ok(tools.length >= 1, 'webServer 缺席时工具未注册（headless 上功能会整体失效）')
  // 保存触发补给也必须照常工作（它与 webServer 无关）。
  c.save(withModel(GATEWAY, { id: REAL_ID }))
  await flush()
  const entry = c.modelsOf(GATEWAY).find((m) => m.id === REAL_ID)
  t.diagnostic('tools=' + tools.map((x) => x.name).join(',') + ' entry=' + JSON.stringify(entry))
  assert.ok(entry !== undefined && entry.reasoningEfforts !== undefined,
    'webServer 缺席时保存触发的补给未生效（说明 apply 被可选服务挡住了）')

  // 结构断言：inject 里**不得**出现 webServer。上面那条行为断言只能证明「代码没直接用
  // ctx.webServer」，证明不了 inject 数组本身 —— 而 inject 才是 cordis 的依赖闸门。
  const injectMatch = /export const inject = \[([^\]]*)\] as const/.exec(INDEX_SRC)
  assert.ok(injectMatch, '找不到 inject 声明')
  assert.ok(!injectMatch[1].includes('webServer'),
    'inject 声明了 webServer：headless profile 没有它 -> apply() 不会执行 -> 工具与保存补给全线失效')
  assert.ok(injectMatch[1].includes("'settings'") && injectMatch[1].includes("'tools'"),
    'inject 缺少 tools/settings（核心功能依赖）')
})

// ── A6 真实拓扑：apply 先、webServer 后（设备实锤回归）─────────────────────────
test('A6 真实拓扑：apply 时 webServer 尚未加载，路由最终仍须注册成功', async (t) => {
  // 回归背景（2026-10-11 真机实锤，修前 5/5 次引擎启动失败）：
  // 装配顺序是「我们的行早于 webserver 行」（profile-web.cordis.patch.yml:94-96
  // vs dsh-web-app/cordis.patch.yml:150），而 ctx.get(name) 默认 strict（只返回已激活实现），
  // 所以 apply() 里裸读 webServer 恒为 undefined -> A6 路由**永不注册**，web 上完全不可用。
  // 修法：改用 ctx.inject(['webServer'], cb)，依赖到位后回调再注册。
  //
  // 这个用例的价值在于**顺序必须是真的**：先 apply 且此刻 get 不到，再 provide。
  // 若夹具顺序反过来（先 provide 再 apply），缺陷就恒不可见 —— 那正是上一版的假绿。
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  const tools = []
  c.ctx.tools = { register: (tool) => { tools.push(tool) } }

  apply(c.ctx, {})               // 1) 先 apply —— 此刻 webServer 尚不存在
  t.after(() => c.dispose())

  // 判别力前提：apply 那一刻服务表里确实**没有** webServer。
  // 注意这里不再拦截 ctx.get 计数：修好后 apply() 根本不该读它（读太早正是原缺陷），
  // 所以「读没读」不能当判据；「此刻在不在」才是。（修前正是读到了 undefined 才不注册。）
  assert.equal(c.ctx.get('webServer'), undefined,
    '真实拓扑复现：apply 那一刻 webServer 必须不在场（否则本用例没有判别力）')
  assert.equal(c.routesOf().length, 0, 'webServer 缺席时不该有路由')

  c.provideWebServer()           // 2) webServer 更晚装配 —— 与真实引擎一致
  await flush()

  // 三件事必须**同时**成立（Lead 明确要求：inject 无 webServer 且回调里注册成功）。
  const injectMatch = /export const inject = \[([^\]]*)\] as const/.exec(INDEX_SRC)
  assert.ok(injectMatch && !injectMatch[1].includes('webServer'),
    '静态 inject 含 webServer：headless 上 apply() 会整体不执行')
  assert.ok(tools.length >= 1, 'apply 时工具未注册')
  assert.equal(c.routesOf().length, 1, 'webServer 后到后，A6 路由最终仍未注册（真机缺陷复现）')
  assert.equal(c.routesOf()[0].path, '/api/android/model-capability/fill', '注册的不是 A6 路由')
  t.diagnostic('routes=' + JSON.stringify(c.routesOf().map((r) => r.path)))
})

// ── 反向保护：apply 时 webServer 已在场也必须注册（不能只修「后到」）──────────
test('A6 反向：webServer 在 apply 之前就位时同样注册', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [] } })
  c.provideWebServer()           // 先提供（另一种真实拓扑：某些 profile 顺序不同）
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  assert.equal(c.routesOf().length, 1, 'webServer 先就位时 A6 路由未注册')
})

// ── A7 与 A1 的交界：无保存则无写入，即使等待 ───────────────────────────────
test('A7/A1 交界：没有任何保存事件时，模型缺失能力也不会被自动补', async (t) => {
  const c = makeCtx({ [GATEWAY]: { baseURL: 'https://gw.example/v1', api: 'openai-completions', models: [{ id: REAL_ID }] } })
  apply(c.ctx, {})
  t.after(() => c.dispose())
  await flush()
  // 启动态：模型已声明、能力缺失。旧实现（启动轮/轮询）会在这里补上；A7 之后不会。
  await new Promise((r) => setTimeout(r, 400))
  t.diagnostic('mutates=' + c.state.mutates + ' models=' + JSON.stringify(c.modelsOf(GATEWAY)))
  assert.equal(c.state.mutates, 0, '无保存事件却自动补齐了（A7 禁止启动/定时自动重写）')
})
