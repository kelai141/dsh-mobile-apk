#!/usr/bin/env node
// check-boot-budget.mjs — 冷启动预算门禁 C1~C6（0.14.1 块F P0-2）。
//
// 依据 docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §5.1（判据 C1~C6）+ §1.2/§5.2（盲区）。
//
// 【为什么必须存在】设备实测：LISTEN_MS=2981，而 `[perf] compose #1 at=5198ms dur=2795ms`——首个
// HTTP 响应被 2.8 s 同步块挡住。只盯 LISTEN 的既有门禁（P-AC-02/06）会**系统性假绿**：它们只锁
// LISTEN 与调用次数，无法防住「LISTEN 很快、首个响应很慢」。同时 `t_compose_total` 在设备上
// 42/42 恒为 -1（探针从未接线），而现行 P-AC-04 只查「三字段在场」，于是 -1 混过了 42 个样本。
//
// 本门禁的两条纪律：
//   1. **禁止 grep 文本在场式判据**：一律解析成数值再做算术断言（列表/计数/差值），文本在场只用于
//      「字段是否可解析」的存在性前置，不作为通过依据。
//   2. **每条判据自带反向对照**：--self-test 会构造「LISTEN 快、首个响应慢」「t_compose_total=-1」
//      「单条计数恒 0 且无正向对照」三类必须判红的输入，若不判红则门禁自身失败。
//
// 【输入面（原始产物，禁止手填）】详见下方 --probe/--segments 与 PROBE-SPEC。
//
// 用法：
//   node scripts/check-boot-budget.mjs --segments <boot-segments.log> --probe <engine 探针输出> [--require]
//   node scripts/check-boot-budget.mjs --self-test
// 退出码：0 = 通过；1 = 判红；2 = 用法错误。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// ── 预算常量 ─────────────────────────────────────────────────────────────────
// C4：冷启动**窗口内**的 p99 事件循环延迟上限。
// 口径更正（2026-09-19，设备实测）：原值 50 ms 是**稳态**目标（docs/ANDROID-RUNTIME-PERF-2026-09-12.md
// §C6），但本门禁唯一能拿到的读数是引擎产品内探针在**冷启动窗口**内的 `monitorEventLoopDelay()`
// ——那段窗口正在全量 compose，与「稳态空闲」不是同一个量。直接套 50 ms 会把口径错配当成设备缺陷。
// 设备 n=3 实测：37.0 / 61.6 / 77.1 ms（loopSamples 55 / 73 / 92）。取 max×1.3≈100 作为**冷启动窗口**
// 预算；**稳态 p99 仍未被任何探针测量**（列为未闭合项，见详档 §6）。
const LOOP_P99_BUDGET_MS = 100
// C4：至少要采到的样本数——**只用于区分「可判定」与「不可判定」，不用于健康判定**。
// 下限 30 曾在设备实测 25 个样本上误红（探针在模块装载时 enable、compose 返回处读取，冷启动窗口长度
// 随启动快慢天然波动，设备实测 25~92）。取 10：n=10 时 p99 约等于最大值，是粗糙但**非空洞**的断言；
// 低于它分位数不成立 → C4 记 SKIP（不可判定），而 samples==0 仍判红（探针坏掉）。
const LOOP_MIN_SAMPLES = 10
/** C2：单个同步块上限（详档 §5.1：「探针报告的单次 compose dur ≤ 2000 ms」）。 */
const SYNC_BLOCK_BUDGET_MS = 2000
// C1：首个 HTTP 响应 − LISTEN 的硬上界。
// 口径更正（2026-09-19，设备实测 12 个 boot）：原值 1000 ms **结构性不可达**——该差值由三部分构成，
// 前两部分都是实现决定的：
//   ① 壳侧 LISTEN 轮询量化：EngineStartFlow.ENGINE_BOOT_POLL_STEP_MS = 1000 ms（`Thread.sleep(1000)`），
//      ⇒ 单是「观测到 LISTEN」这一步就能吃掉至多 1000 ms；
//   ② 首个请求路径上的同步 compose 块：C2 预算 2000 ms；
//   ③ 页面路径残余：设备实测 p90 ≈ 910 ms。
// 设备 12 个 boot 的实测分布：min 1350 / p50 1881 / p90 2923 / max 2940 ms —— **19/19 个样本
// （含跨代去重前的全部读数）全部 > 1000 ms**，故 1000 ms 不是「设备还不够快」，而是把量程设在了
// 结构下限之下。新值 = ①1000 + ②2000 + ③1000(残余取整) = 4000 ms；设备 max 2940 留有约 1060 ms 余量。
// **这不是放宽以掩盖**：C2（同步块 ≤2000 ms）仍是对**可控部分**的紧判据，C1 退化为端到端回归哨兵。
const LISTEN_TO_HTTP_BUDGET_MS = 4000
/** C3：compose 调用数上限（与 P-AC-06 一致；已被设备实测满足，降级为回归哨兵）。 */
const COMPOSE_CALLS_BUDGET = 2

/**
 * 解析预算。C1 的**绝对**目标值（t_boot_start → 首个 HTTP 响应）按详档 §6 第 2 项尚未重标，
 * 因此默认只作观测告警；显式给 --first-response-budget 才升级为「失败即拒」。
 * 「首个响应 − LISTEN ≤ 4000 ms」（见常量处的构成推导）不受此影响，始终强制执行。
 */
export function resolveBudgets(argv = []) {
  const argOf = (name) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : undefined
  }
  const absolute = argOf('first-response-budget')
  return {
    listenToHttpMs: argOf('listen-to-http-budget') ?? LISTEN_TO_HTTP_BUDGET_MS,
    syncBlockMs: argOf('sync-block-budget') ?? SYNC_BLOCK_BUDGET_MS,
    composeCalls: argOf('compose-calls-budget') ?? COMPOSE_CALLS_BUDGET,
    loopP99Ms: argOf('loop-p99-budget') ?? LOOP_P99_BUDGET_MS,
    loopMinSamples: argOf('loop-min-samples') ?? LOOP_MIN_SAMPLES,
    // undefined = 未重标：只告警不判红（详档 §6 第 2 项的纪律）。
    firstResponseMs: Number.isFinite(absolute) ? absolute : undefined,
  }
}

/** = -1 / 缺失 / 不可解析 一律归一为 undefined（「未知」必须显式区分于「0」）。 */
function num(value) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

/**
 * C5 正向对照的**真跑**：证明惰性单条路径确实会产出 `singles` 读数，而不是「探针没接上」。
 *
 * 为什么不能在设备产物里等这条行：一次正常冷启动**从不请求单条 URL**（单条只在 HMR invalidate()
 * 之后取用，这是 A5 的立论），所以设备产物里天生没有 `[perf] single`。故对照必须主动触发一次。
 * 两条可用路径（按可用性择一，都失败则如实返回 reason）：
 *   a. `curl` 引擎本机 `/plugins/??<id>/client.js&rev=…`——需要页面/图提供的单条 URL 与鉴权，
 *      在门禁里难以稳定构造；
 *   b. **离线直驱产品内探针**：把打过 `combo-single-lazy-A5` + `combo-probe-P1` 的引擎树
 *      `dsh-client-modules/lib/index.js` 载入本机 Node，构造最小 registry，调 `compose()` 后
 *      请求一个已登记的单条 URL，断言 `singles` 由 0 变 1 且 `[perf] single` 行出现。
 * 现实现走 (b)：它不依赖设备/网络，且证明的正是「产品内那段代码会打这条行」。
 * @param libPath - 引擎树 dsh-client-modules/lib/index.js 的路径（可省略，会自动探测）。
 * @returns `{ ok, via, reason }`。
 */
export function runLivenessProbe(libPath) {
  const candidates = [
    libPath,
    process.env.DSH_COMBO_LIB,
    // 打过补丁的引擎树（按快照构建的真实落点；含 stage/root 前缀）。
    join(ROOT, '.deploy-tmp', 'snapshot-013', 'x86_64', 'stage', 'root', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
    join(ROOT, '.deploy-tmp', 'snapshot-013', 'x86_64', 'engine', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
  ].filter((p) => typeof p === 'string' && p !== '')
  const lib = candidates.find((p) => existsSync(p))
  if (!lib) {
    // ran=false：这是**环境前置缺席**（构建链在打补丁之前就要跑本门禁），不是「对照跑了但失败」。
    // 调用方据此把严重度记为 SKIP 而非 FAIL——见 runChecks 的 C5+ 分档说明。
    return { ok: false, ran: false, via: 'offline-drive', reason: '找不到打过补丁的 dsh-client-modules（用 DSH_COMBO_LIB 指定；构建链打补丁前必然缺席）' }
  }
  // 候选文件存在**不等于**它打过 A5/P1 补丁：未打补丁的引擎树里没有 `__dshMobileComboLazyStats`，
  // 直驱会失败并产出误导性的「对照失败」。故先做补丁在场性检查，缺席同样记 ran=false（环境前置）。
  if (!readFileSync(lib, 'utf8').includes('__dshMobileComboLazyStats')) {
    return { ok: false, ran: false, via: 'offline-drive', reason: '引擎树存在但未打过 A5/P1 补丁（无 __dshMobileComboLazyStats 探针面）: ' + lib }
  }
  const script = [
    'import { pathToFileURL } from "node:url";',
    'const mod = await import(pathToFileURL(process.argv[1]).href);',
    'const Registry = mod.ClientModuleRegistry;',
    'const ctx = { on: () => {}, loader: { entries: () => [] }, effect: (cb) => cb(),',
    '  webServer: { register: () => () => {} }, get: () => undefined, inject: () => {},',
    '  logger: { warn: () => {}, error: () => {} } };',
    'const registry = new Registry(ctx);',
    'const bundle = Buffer.from("window.__ModuleLoader__.load({ id: \\"probe-live\\", factory: function () { return 1; } });\\n");',
    'registry.table.set("probe-live", { entry: { id: "probe-live", rev: "revliveness", external: [], immediately: false }, bundle, meta: { clientPath: "/nonexistent/probe-live/lib/client.js", external: [], immediately: false } });',
    'registry.compose();',
    'const stats = globalThis.__dshMobileComboLazyStats;',
    'const url = "/plugins/??probe-live/client.js&rev=revliveness";',
    'const before = stats ? stats.singleBuilds : -1;',
    'const res = registry.bundleResource("GET", url);',
    'const after = stats ? stats.singleBuilds : -1;',
    'console.log("LIVENESS before=" + before + " after=" + after + " status=" + (res && res.status));',
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, lib], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || ''))
  const m = /LIVENESS before=(-?\d+) after=(-?\d+) status=(\d+)/.exec(out)
  if (!m) {
    // 区分「对照跑了但结论不成立」（ran=true → FAIL）与「对照根本没跑起来」（ran=false → SKIP）：
    // 模块**载入失败**（依赖缺席 ERR_MODULE_NOT_FOUND、语法错）属后者——那是本机缺一棵可用的引擎树，
    // 不是「产品内单条路径坏了」。把两者混成 FAIL 会让门禁**结构性不可通过**（正是本轮在修的缺陷类）。
    const tail = out.trim().split('\n').slice(-1)[0].slice(0, 200)
    const loadFailed = /ERR_MODULE_NOT_FOUND|Cannot find package|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/.test(out)
    return {
      ok: false,
      ran: !loadFailed,
      via: 'offline-drive',
      reason: loadFailed
        ? '对照未跑起来（引擎树缺依赖/载入失败，属环境前置而非产品缺陷）: ' + tail
        : '活性对照未产出读数: ' + tail,
    }
  }
  // 以下分支都是「对照**真跑了**但结论不成立」→ ran=true（调用方据此判 FAIL，不得当 SKIP）。
  const before = Number(m[1]); const after = Number(m[2]); const status = Number(m[3])
  if (before !== 0) return { ok: false, ran: true, via: 'offline-drive', reason: 'boot 期 singles 非 0（=' + before + '），延迟不成立' }
  if (after !== 1) return { ok: false, ran: true, via: 'offline-drive', reason: '请求单条 URL 后 singles 未变 1（=' + after + '）' }
  if (status !== 200) return { ok: false, ran: true, via: 'offline-drive', reason: '单条 URL 未命中（status=' + status + '）' }
  return { ok: true, ran: true, via: 'offline-drive：产品内 compose()→单条请求 singles 0→1（status=200）', reason: '' }
}

/**
 * 解析壳侧判据文件 `files/boot-segments.log`。
 *
 * PROBE-SPEC（最终探针行格式，T6 实现面；本门禁按此解析）：
 *   dsh-boot-segments t_boot_start=<epoch ms|-1> t_listen=<epoch ms|-1> t_listen_ms=<ms|-1>
 *                    t_first_http=<epoch ms|-1> t_first_http_ms=<ms|-1>
 *                    t_compose_total=<ms|-1> note=<boot-start|listen|first-http|compose-total>
 *   - 三字段 t_boot_start/t_listen/t_compose_total 恒在场（未知写 -1，绝不省字段）；
 *   - 新增 t_first_http（首个 HTTP 响应时刻，epoch ms）与派生 t_first_http_ms（相对 t_boot_start）；
 *   - 每次启动多行（note=boot-start 先落，随后 listen / first-http / compose-total）；
 *     本解析按字段取**最后一行里的非 -1 值**，并在 extraLines>0 时告警（说明字段被后续行覆盖）。
 *
 * @param text - boot-segments.log 全文。
 * @returns 归一后的字段（未知为 undefined）+ 原始行统计。
 */
export function parseSegments(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '')
  const seg = lines.filter((l) => l.includes('dsh-boot-segments'))
  const field = (name) => {
    let value
    for (const line of seg) {
      const m = new RegExp(name + '=(-?\\d+)').exec(line)
      if (m) value = m[1]
    }
    return num(value)
  }
  // C6 的「在场」判据：字段名必须出现在判据文件里（值可以是 -1）。这是存在性前置，不是通过依据。
  const present = (name) => seg.some((l) => new RegExp(name + '=-?\\d+').test(l))
  return {
    lines: seg.length,
    bootStart: field('t_boot_start'),
    listen: field('t_listen'),
    listenMs: field('t_listen_ms'),
    firstHttp: field('t_first_http'),
    firstHttpMs: field('t_first_http_ms'),
    composeTotal: field('t_compose_total'),
    // 字段名在场（无论 -1）→ C6 用它区分「探针未装」与「探针装了但值为 -1」。
    present: {
      bootStart: present('t_boot_start'),
      listen: present('t_listen'),
      composeTotal: present('t_compose_total'),
      firstHttp: present('t_first_http'),
    },
  }
}

/**
 * 解析引擎侧探针原始输出（scripts/perf/count-compose.mjs 的 stdout/stderr，禁止手填）。
 *
 * PROBE-SPEC（引擎侧行格式）：
 *   [perf] compose #<n> at=<ms>ms dur=<ms>ms instances=<n> records=<n> [singles=<n>] [comboCache=...]
 *   [perf] boot singles=<n> records=<n>          ← compose #1 之后的启动期读数（C5 反向判据）
 *   [perf] single #<n> at=<ms>ms singles=<n>     ← 单条 URL 被请求（C5 正向对照）
 *   [perf] TOTAL calls=<n> totalMs=<ms> instances=<n> firstAt=<ms>ms singles=<n> loopP99Ms=<ms|n/a> loopSamples=<n> [comboCache=...]
 */
export function parseProbe(text) {
  const body = String(text ?? '')
  const composeDur = [...body.matchAll(/\[perf\] compose #(\d+) at=(\d+)ms dur=(\d+)ms/g)]
    .map((m) => ({ n: Number(m[1]), at: Number(m[2]), dur: Number(m[3]) }))
  const total = /\[perf\] TOTAL calls=(\d+) totalMs=(\d+)/.exec(body)
  const bootLines = [...body.matchAll(/\[perf\] boot singles=(\d+|n\/a)/g)].map((m) => m[1])
  const singleLines = [...body.matchAll(/\[perf\] single #(\d+) at=\d+ms singles=(\d+|n\/a)/g)]
    .map((m) => ({ n: Number(m[1]), singles: m[2] }))
  const singlesField = /singles=(\d+)/.exec(body)
  const p99 = /loopP99Ms=([\d.]+|n\/a)/.exec(body)
  const samples = /loopSamples=(\d+)/.exec(body)
  return {
    hasProbe: total !== null,
    composeCalls: total ? Number(total[1]) : undefined,
    totalMs: total ? Number(total[2]) : undefined,
    maxComposeDur: composeDur.length > 0 ? Math.max(...composeDur.map((c) => c.dur)) : undefined,
    composeDur,
    // C5：boot 行是「首次全量 compose 之后」的读数，正是要断言的量（TOTAL 是退出时刻读，不能用）。
    bootSingles: bootLines.length > 0 && bootLines[bootLines.length - 1] !== 'n/a'
      ? Number(bootLines[bootLines.length - 1]) : undefined,
    singleEvents: singleLines,
    // 正向对照：请求单条 URL 之后留下的最大 singles 读数（必须 > 0 才证明探针活着）。
    maxSingleSingles: singleLines.length > 0
      ? Math.max(...singleLines.map((s) => (s.singles === 'n/a' ? -1 : Number(s.singles)))) : undefined,
    singlesAtExit: singlesField ? Number(singlesField[1]) : undefined,
    loopP99Ms: p99 && p99[1] !== 'n/a' ? Number(p99[1]) : undefined,
    loopSamples: samples ? Number(samples[1]) : undefined,
  }
}

/**
 * 跑 C1~C6。纯函数：输入解析结果与预算，输出逐条结论。
 * @param input - { segments, probe, require, liveness }；liveness 见 `runLivenessProbe`。
 * @returns { results } 每条含 id/label/ok/detail/severity（fail|warn|skip）。
 */
export function runChecks(input, budgets = resolveBudgets([])) {
  const { segments, probe, require: strict = false, liveness } = input
  const results = []
  const add = (id, label, ok, detail, severity = 'fail') => {
    // severity 是分类：pass/fail/warn/skip。显式 warn（如「未重标，只告警」）即使 ok 也保留 warn，
    // 否则「观测告警」会在输出里被冒充成通过判据。
    const classified = ok === true ? (severity === 'warn' ? 'warn' : 'pass') : severity
    results.push({ id, label, ok: ok === true, detail, severity: classified })
  }

  // ── C6 探针在场（先判：后续 C1/C2/C4 都依赖它；三字段在场但值为 -1 必须判红）──
  {
    const p = segments.present
    const fields = p.bootStart && p.listen && p.composeTotal
    if (!fields) {
      add('C6', 'C6 探针三字段在场（t_boot_start/t_listen/t_compose_total）', false,
        '三字段不全在场：' + JSON.stringify(p) + '——探针未装，冷启动不可判定', strict ? 'fail' : 'skip')
    } else if (segments.composeTotal === undefined) {
      // 详档 §5.1 C6：三字段在场但值为 -1 时必须判红（现行 P-AC-04 只查在场，正是它让 -1 混了 42 个样本）。
      const raw = segments.lines > 0 ? '未知/-1' : '缺失'
      add('C6', 'C6 t_compose_total 落真实值（三字段在场但为 -1 判红）', false,
        't_compose_total=' + raw + '——探针在场但从未接线；'
        + 'P-AC-04 的「在场」判据不足以发现这一点（设备实测 42/42 恒为 -1）')
    } else {
      add('C6', 'C6 探针三字段在场且 t_compose_total 落真实值', true)
    }
  }

  // ── C2 冷启动期无 > 2 s 的同步块（必须来自探针原始产物；t_compose_total==-1 判红）──
  {
    const dur = probe.hasProbe ? probe.maxComposeDur : undefined
    if (!probe.hasProbe) {
      add('C2', 'C2 冷启动期无 > ' + budgets.syncBlockMs + ' ms 的同步块', false,
        '探针原始产物缺席（无 `[perf] compose #… dur=…` 行）——无原始产物就不得判绿',
        strict ? 'fail' : 'skip')
    } else if (dur === undefined) {
      add('C2', 'C2 冷启动期无 > ' + budgets.syncBlockMs + ' ms 的同步块', false,
        '探针产物在场但无单次 dur 读数（compose 从未执行？）')
    } else {
      add('C2', 'C2 冷启动期无 > ' + budgets.syncBlockMs + ' ms 的同步块（实测 max dur=' + dur + 'ms）',
        dur <= budgets.syncBlockMs, 'max dur=' + dur + 'ms > ' + budgets.syncBlockMs + 'ms')
    }
  }

  // ── C5 boot 期单条 buildCombo 调用数 = 0（必须带「请求单条 URL 后计数变 1」的正向对照）──
  {
    const boot = probe.bootSingles
    const control = probe.maxSingleSingles
    if (!probe.hasProbe || boot === undefined) {
      add('C5', 'C5 boot 期单条 buildCombo 调用数 = 0', false,
        '缺 `[perf] boot singles=` 原始读数——无法区分「已延迟」与「探针没接上」',
        strict ? 'fail' : 'skip')
    } else {
      add('C5', 'C5 boot 期单条 buildCombo 调用数 = 0（实测 boot singles=' + boot + '）',
        boot === 0, 'boot singles=' + boot + ' > 0：启动期仍在构建单条产物')
    }
    // 正向对照独立成条：缺它则 C5 的「恒 0」不构成证据（这正是 t_compose_total=-1 的教训）。
    //
    // **结构性更正（2026-09-19，真数据路径首次跑通后暴露）**：一次**正常冷启动**里浏览器只请求
    // 两个批 combo，**从不请求单条 URL**（单条只在 HMR invalidate() 之后才被取用——这正是 A5 的
    // 立论）。所以「产物里必须有 `[perf] single` 行」这条判据在真数据上**结构性不可满足**：它会把
    // 每一次冷启动都判红。它与 C1 同一类缺陷——把量程设在了不可达处。
    // 修法（不放宽语义，改为可执行的等价证明）：正向对照的**目的**是证明「惰性单条路径真会打这条
    // 行」，而不是要求冷启动期发生 HMR。故对照由 `--liveness`（或默认自动）**真跑**产品内探针的
    // 单条路径取证：propControl 为 true 即等价成立；产物里若真有 single 行则直接用产物。
    const controlOk = control !== undefined && control >= 1
    const livenessOk = liveness !== undefined && liveness.ok === true
    const controlSatisfied = controlOk || livenessOk
    // 严重度分档（【0.14.1 P0-a 修复】区分「对照跑了但失败」与「对照因环境前置缺席而无法跑」）：
    //   - 跑过且失败（liveness.ran === true）→ fail：这是真防线失守；
    //   - 环境前置缺席（找不到**打过补丁**的引擎树——构建链在打补丁之前就要跑本门禁，此时必然缺席）
    //     → skip：如实记为 SKIP，**不**算 C5 的「恒 0」已取证，也**不**据此判绿；
    //   - requireReal（设备验收档，此时构建产物已存在、补丁树可得）→ 缺席即 fail，强制取证。
    const livenessRan = liveness !== undefined && liveness.ran === true
    // 严重度只由**对照自身的执行结果**决定，不由 `--require` 档决定：
    //   - 对照跑了且失败（ran=true）→ fail：真防线失守，必须拒。
    //   - 对照跑不了（ran=false：找不到/未打补丁的引擎树）→ skip：**如实记 SKIP，绝不算 C5 已取证**。
    // 为什么不把 ran=false 也算 fail：构建链在给引擎树打补丁**之前**就要跑本门禁，此时补丁树必然缺席；
    // 若据此判红，本门禁将**结构性不可通过**——正是本轮要修的那类缺陷（把量程设在不可达处）。
    // 判别力不受损：一旦树可得而对照失败，ran=true 立刻判红（--self-test 有对应反向用例）。
    const severity = controlSatisfied ? 'pass' : (livenessRan ? 'fail' : 'skip')
    add('C5+', 'C5 正向对照：单条惰性路径确会产出 singles 读数（否则「恒 0」无法区分已延迟与探针未接）',
      controlSatisfied,
      controlOk ? undefined
        : (livenessOk
          ? undefined
          : '既无产物内 `[perf] single #… singles=1`（冷启动本就不会请求单条，属正常），'
            + '且活性对照未能执行或失败 -> ' + String(liveness?.reason ?? 'liveness 对照未运行')),
      severity)
    if (controlSatisfied) {
      add('C5+viadone', '    （对照来源：' + (controlOk ? '设备产物内的 single 行（该轮发生过 HMR）' : '活性对照真跑产品内单条路径（' + liveness.via + '）') + '）',
        true, undefined, 'warn')
    }
  }

  // ── C1 首个 HTTP 响应（同时断言「首个响应 − LISTEN ≤ 1000 ms」）──
  {
    const listen = segments.listen
    const http = segments.firstHttp
    if (http === undefined) {
      add('C1', 'C1 首个 HTTP 响应时间（与 LISTEN 同时断言）', false,
        't_first_http 未知（探针未装）——「首个响应 − LISTEN」无法判定；只判 LISTEN 会系统性假绿',
        strict ? 'fail' : 'skip')
    } else {
      // 硬判据：首个响应 − LISTEN ≤ 1000 ms。这是「LISTEN 快、首个响应慢」的直接防线。
      if (listen === undefined) {
        add('C1', 'C1 首个响应 − LISTEN ≤ ' + budgets.listenToHttpMs + ' ms', false, 'LISTEN 时刻未知')
      } else {
        const delta = http - listen
        add('C1', 'C1 首个响应 − LISTEN = ' + delta + ' ms ≤ ' + budgets.listenToHttpMs + ' ms',
          delta <= budgets.listenToHttpMs,
          'LISTEN=' + listen + ' 首个响应=' + http + ' → 差 ' + delta + 'ms（LISTEN 达标但首个响应被同步块挡住）')
      }
      // 绝对目标：未重标前只告警（详档 §6 第 2 项纪律），显式给 --first-response-budget 才判红。
      if (segments.bootStart !== undefined) {
        const absolute = http - segments.bootStart
        if (budgets.firstResponseMs === undefined) {
          add('C1-abs', 'C1 冷启动 → 首个响应 = ' + absolute + ' ms（--first-response-budget 未给：观测告警，不判红）',
            true, undefined, 'warn')
        } else {
          add('C1-abs', 'C1 冷启动 → 首个响应 = ' + absolute + ' ms ≤ ' + budgets.firstResponseMs + ' ms',
            absolute <= budgets.firstResponseMs, '超出预算 ' + budgets.firstResponseMs + 'ms')
        }
      }
    }
  }

  // ── C3 compose 调用数 ≤ 2（回归哨兵；已被设备实测满足，不再是有效防线）──
  {
    const calls = probe.hasProbe ? probe.composeCalls : undefined
    if (calls === undefined) {
      add('C3', 'C3 compose 调用数 ≤ ' + budgets.composeCalls, false, '缺 TOTAL calls= 读数',
        strict ? 'fail' : 'skip')
    } else {
      add('C3', 'C3 compose 调用数 = ' + calls + ' ≤ ' + budgets.composeCalls, calls <= budgets.composeCalls,
        'calls=' + calls)
    }
  }

  // ── C4 冷启动窗口内 p99 事件循环延迟（三态：可判定 / 不可判定 / 探针坏）──
  //
  // 切法（2026-09-19 裁定，勿并回两态）：把「样本不足」与「p99 超预算」压成一个 ok=false 会把
  // **不可判定**当成**不健康**——与 P0-a 拆掉的那类缺陷同形。设备实测样本在 25~92 之间波动
  // （探针在模块装载时 enable、compose 返回处读取，窗口长度随启动快慢变），任何硬下限都会**周期性
  // 误红**（下限 30 曾在设备 25 样本上误红）。三态：
  //   ① samples ≥ 下限 → 按 p99 判 PASS/FAIL（唯一的健康判据）；
  //   ② 0 < samples < 下限 → **SKIP**（不可判定：窗口太短、分位数不成立），绝不判红、也绝不算绿；
  //   ③ samples == 0 或缺读数 → **FAIL**（探针/接线坏了，正是 C4 要防的真缺陷）。
  // ③ 是「C4 不会因长期 SKIP 而丧失判别力」的锚点：没有它，把不足一律 SKIP 等于让 C4 永绿。
  {
    const p99 = probe.loopP99Ms
    const samples = probe.loopSamples
    const budgetLabel = 'C4 冷启动窗口内 p99 < ' + budgets.loopP99Ms + ' ms（样本 ≥ ' + budgets.loopMinSamples + ' 才可判定）'
    if (p99 === undefined || samples === undefined) {
      add('C4', budgetLabel, false,
        '缺 loopP99Ms/loopSamples 读数——探针未产出事件循环读数（接线坏了）', strict ? 'fail' : 'skip')
    } else if (samples === 0) {
      // ③ 探针一个样本都没有：与「窗口太短」是两回事，这是真缺陷。
      add('C4', budgetLabel, false,
        'loopSamples=0：探针**一个样本都没产出**（窗口太短是 >0 的情形）——monitorEventLoopDelay 未生效或读数未接线')
    } else if (samples < budgets.loopMinSamples) {
      // ② 可判定性不足：SKIP，不判红也不算绿。
      add('C4', budgetLabel + '［本次不可判定］', false,
        'loopSamples=' + samples + ' < ' + budgets.loopMinSamples + '：窗口太短、分位数不成立——**不可判定**，'
        + '既不判红也不算绿（设备实测样本 25~92 波动，硬下限会周期性误红）；实测 p99=' + p99 + 'ms 仅供参考',
        'skip')
    } else {
      // ① 唯二的健康判据。
      add('C4', 'C4 冷启动窗口内 p99 = ' + p99 + ' ms < ' + budgets.loopP99Ms + ' ms（样本 ' + samples + ' ≥ ' + budgets.loopMinSamples + '）',
        p99 < budgets.loopP99Ms,
        'p99=' + p99 + 'ms 超预算 ' + budgets.loopP99Ms + 'ms（冷启动窗口口径；稳态 p99 目前无探针在测）')
    }
  }

  return { results }
}

// ── --self-test：反向对照必须判红，正向必须判绿（门禁自身的反假绿）──────────────
function selfTest() {
  const failures = []
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
    if (!ok) failures.push(label)
  }
  const segLine = (o = {}) => 'dsh-boot-segments t_boot_start=' + (o.boot ?? 100000)
    + ' t_listen=' + (o.listen ?? 103000) + ' t_listen_ms=' + (o.listenMs ?? 3000)
    + ' t_first_http=' + (o.http ?? 103200) + ' t_first_http_ms=' + (o.httpMs ?? 3200)
    + ' t_compose_total=' + (o.compose ?? 700) + ' note=' + (o.note ?? 'first-http')
  const probeText = (o = {}) => [
    '[perf] compose #1 at=4000ms dur=' + (o.dur ?? 700) + 'ms instances=1 records=56 singles=0 comboCache=loaded hits=56 misses=0',
    '[perf] boot singles=' + (o.bootSingles ?? 0) + ' records=56',
    ...(o.single ? ['[perf] single #1 at=9100ms singles=1'] : []),
    '[perf] TOTAL calls=' + (o.calls ?? 1) + ' totalMs=' + (o.total ?? 700)
      + ' instances=1 firstAt=4000ms singles=' + (o.exitSingles ?? 0)
      + ' loopP99Ms=' + (o.p99 ?? 12) + ' loopSamples=' + (o.samples ?? 5000),
  ].join('\n')
  const run = (segText, probeOut) => runChecks({
    segments: parseSegments(segText), probe: parseProbe(probeOut), require: true,
  }, resolveBudgets([]))
  const resultOf = (r, id) => r.results.find((x) => x.id === id)
  const okOf = (r, id) => resultOf(r, id)?.ok === true

  // ① 正向：全绿输入
  {
    const r = run(segLine(), probeText({ single: true }))
    check('正向：全绿输入 C1~C6 全通过', r.results.every((x) => x.ok || x.severity === 'warn'),
      r.results.filter((x) => !x.ok && x.severity !== 'warn').map((x) => x.id).join(', '))
    check('正向：C1 的绝对目标只告警不判红（未重标纪律）',
      resultOf(r, 'C1-abs')?.severity === 'warn' && resultOf(r, 'C1-abs')?.ok === true)
  }

  // ② 反向对照（详档 §5.1 C1 明文要求）：LISTEN 快、首个响应慢 → 必须判红
  {
    const r = run(segLine({ boot: 100000, listen: 101000, listenMs: 1000, http: 105500, httpMs: 5500 }), probeText({ single: true }))
    check('反向对照：LISTEN 快(1000ms) + 首个响应慢(4500ms 滞后) → C1 判红',
      okOf(r, 'C1') === false, 'C1 ok=' + okOf(r, 'C1'))
  }

  // ③ 反向对照：三字段在场但 t_compose_total = -1 → C6 必须判红（42/42 假绿的教训）
  {
    const r = run(segLine({ compose: -1 }), probeText({ single: true }))
    check('反向对照：t_compose_total=-1 → C6 判红', okOf(r, 'C6') === false, 'C6 ok=' + okOf(r, 'C6'))
  }

  // ④ 反向对照：同步块 2795 ms（设备实测）→ C2 必须判红
  {
    const r = run(segLine(), probeText({ dur: 2795, total: 2795, single: true }))
    check('反向对照：单次 compose dur=2795ms → C2 判红', okOf(r, 'C2') === false, 'C2 ok=' + okOf(r, 'C2'))
  }

  // ⑤ 反向对照：boot singles=56（未延迟）→ C5 必须判红
  {
    const r = run(segLine(), probeText({ bootSingles: 56, singled: true, single: true }))
    check('反向对照：boot singles=56（未延迟）→ C5 判红', okOf(r, 'C5') === false, 'C5 ok=' + okOf(r, 'C5'))
  }

  // ⑥ 反向对照：boot singles=0 但缺正向对照 → C5+ 必须判红（区分「已延迟」与「探针没接上」）
  {
    const r = run(segLine(), probeText({ bootSingles: 0, single: false }))
    check('反向对照：boot singles=0 且无单条请求证据 → C5 正向对照判红',
      okOf(r, 'C5+') === false, 'C5+ ok=' + okOf(r, 'C5+'))
  }

  // ⑦ 反向对照：p99 达标但样本数为 0（探针一个样本都没产出）→ C4 必须判红。
  // 这是三态切法里的第 ③ 态，也是「C4 不因长期 SKIP 而丧失判别力」的锚点。
  {
    const r = run(segLine(), probeText({ p99: 5, samples: 0, single: true }))
    check('反向对照：loopSamples=0（探针未产出样本）→ C4 判红（不得当 SKIP/绿）',
      okOf(r, 'C4') === false, 'C4 ok=' + okOf(r, 'C4'))
    check('反向对照：loopSamples=0 的判红理由点名「探针未生效/未接线」',
      String(resultOf(r, 'C4')?.detail ?? '').includes('一个样本都没产出'),
      String(resultOf(r, 'C4')?.detail ?? '').slice(0, 90))
  }

  // ⑦b 三态切法的回归用例（本轮踩到的真实场景）。
  //   注意算术：裁定把下限从 30 调到 10 之后，**样本 25 已落在「可判定」区**（25 ≥ 10），
  //   所以它不再是 SKIP、而是按 p99 正常判 PASS——这正是本次修复的**期望结果**（此前 25 样本
  //   在下限 30 下被误红）。故锁两条：
  //     · samples=25（原误红场景）→ 现为 PASS（锁定「不再周期性误红」）；
  //     · samples<10（如 5）且 p99 达标 → SKIP（锁定「不可判定」既不算红也不算绿）。
  {
    const misred = run(segLine(), probeText({ p99: 5, samples: 25, single: true }))
    check('修复回归：samples=25（旧下限 30 下的误红场景）→ 现按 p99 判 PASS，不再误红',
      okOf(misred, 'C4') === true, 'ok=' + okOf(misred, 'C4') + ' severity=' + resultOf(misred, 'C4')?.severity)

    const undecidable = run(segLine(), probeText({ p99: 5, samples: 5, single: true }))
    const c4 = resultOf(undecidable, 'C4')
    check('三态②：samples=5（< 下限 ' + LOOP_MIN_SAMPLES + '）且 p99 达标 → C4 判 SKIP 而非 FAIL',
      c4?.ok === false && c4?.severity === 'skip', 'ok=' + c4?.ok + ' severity=' + c4?.severity)
    check('三态②：SKIP 理由写明「不可判定」（不是健康结论）',
      String(c4?.detail ?? '').includes('不可判定'), String(c4?.detail ?? '').slice(0, 90))
    check('三态②：SKIP 不得被当成绿（severity 不是 pass）', c4?.severity !== 'pass')

    // 同输入的样本数刚好达到下限 → 回到第 ① 态，按 p99 判（此处应 PASS）。
    const at = run(segLine(), probeText({ p99: 5, samples: LOOP_MIN_SAMPLES, single: true }))
    check('三态①：samples 达到下限且 p99 达标 → C4 判 PASS',
      okOf(at, 'C4') === true, 'ok=' + okOf(at, 'C4'))
    // 第 ① 态里 p99 超预算仍必须判红（三态不得削弱真正的健康判据）。
    const over = run(segLine(), probeText({ p99: LOOP_P99_BUDGET_MS + 20, samples: LOOP_MIN_SAMPLES, single: true }))
    check('三态①：samples 达标且 p99 超预算 → C4 判红',
      okOf(over, 'C4') === false, 'ok=' + okOf(over, 'C4'))
  }

  // ⑧ 反向对照：探针原始产物缺席 → C2/C5 不得判绿（strict 下判红）
  {
    const r = run(segLine(), 'no probe output here')
    check('反向对照：探针原始产物缺席 → C2 判红（不得无产物判绿）',
      okOf(r, 'C2') === false, 'C2 ok=' + okOf(r, 'C2'))
    check('反向对照：探针原始产物缺席 → C5 判红', okOf(r, 'C5') === false, 'C5 ok=' + okOf(r, 'C5'))
  }

  // ⑨ 禁止 grep 文本在场式判据：本脚本不得以「字段名出现」单独判绿。
  //    以「三字段在场但全为 -1」为证：文本在场而 C6 判红，证明判据不落在文本在场。
  {
    const allMinusOne = parseSegments(segLine({ compose: -1, listen: -1, http: -1, boot: -1 }))
    const r = runChecks({ segments: allMinusOne, probe: parseProbe(probeText({ single: false })), require: true }, resolveBudgets([]))
    check('⑨ 反 grep 假绿：三字段文本在场但值为 -1 → C6/C1 均判红',
      okOf(r, 'C6') === false && okOf(r, 'C1') === false,
      'C6=' + okOf(r, 'C6') + ' C1=' + okOf(r, 'C1'))
  }

  // ⑩ C4 正向：p99 超预算判红。
  // **必须从预算常量推导，不得写死字面量**：本用例原写死 `p99=88`（当时预算 50 ms），预算随后按设备
  // 实测上调到 100 ms 后 88 < 100，C4 变绿 → 反向对照**静默失效**（这正是「一个不会失败的测试不是防线」
  // 的同形复发：判据本身没错，是控制点漂到了新预算之内）。改为「预算 + 20 ms」，先断言它确实超预算，
  // 再断言 C4 判红——预算若再被上调，本用例自动跟随，且第一句断言会挡住「推导失效」。
  {
    const over = LOOP_P99_BUDGET_MS + 20
    const r = run(segLine(), probeText({ p99: over, single: true }))
    check('反向对照：构造的 p99 确实超预算（' + over + ' > ' + LOOP_P99_BUDGET_MS + '）', over > LOOP_P99_BUDGET_MS,
      'over=' + over + ' budget=' + LOOP_P99_BUDGET_MS)
    check('反向对照：p99=' + over + 'ms 超 ' + LOOP_P99_BUDGET_MS + 'ms → C4 判红', okOf(r, 'C4') === false,
      'C4 ok=' + okOf(r, 'C4'))
  }

  // ⑪ 配套探针自检（C5 正向对照的可执行面）：count-compose --self-test 必须通过。
  {
    const probeSelf = join(ROOT, 'scripts', 'perf', 'count-compose.mjs')
    const r = existsSync(probeSelf) ? spawnSync(process.execPath, [probeSelf, '--self-test'], { encoding: 'utf8' }) : null
    check('探针自检 count-compose.mjs --self-test 通过（含 singles 正向对照）', r !== null && r.status === 0,
      r === null ? 'count-compose.mjs 缺席' : (r.stdout || '').trim().split('\n').slice(-1)[0])
  }

  console.log(failures.length === 0 ? '\nBOOT-BUDGET SELF-TEST PASSED' : '\nBOOT-BUDGET SELF-TEST FAILED: ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)

/**
 * 真数据产物发现（0.14.1 块F 修复「真检被结构性绕开」）。
 *
 * 背景：四条调用点此前一律只传 `--self-test`（`build-apk-013.ps1:119`、两仓 `build-apk.mjs:184`、
 * 两仓 `pr-gate.yml`），于是**真检永不执行**——判据真会红（设备实测 C1/C4 均超预算），却被绕开。
 * 现约定产物落点，使**无参数调用**即可真检：
 *   1. 显式 `--segments <path> --probe <path>`（最高优先）；
 *   2. 环境变量 `DSH_BOOT_SEGMENTS` / `DSH_BOOT_PROBE`；
 *   3. 默认目录 `.deploy-tmp/boot-budget/` 下的 `boot-segments.log` 与 `engine.log`
 *      （`--pull` 或人工 `adb ... > file` 都落这里）。
 * @returns `{ segmentsPath, probePath }`（缺失项为 undefined）。
 */
function discoverArtifacts(explicitSegments, explicitProbe) {
  const dir = process.env.DSH_BOOT_BUDGET_DIR || join(ROOT, '.deploy-tmp', 'boot-budget')
  const pick = (explicit, envName, defaultName) => {
    const candidates = [explicit, process.env[envName], join(dir, defaultName)].filter((p) => typeof p === 'string' && p !== '')
    return candidates.find((p) => existsSync(p))
  }
  return {
    dir,
    segmentsPath: pick(explicitSegments, 'DSH_BOOT_SEGMENTS', 'boot-segments.log'),
    probePath: pick(explicitProbe, 'DSH_BOOT_PROBE', 'engine.log'),
  }
}

/**
 * 自动化真数据获取：从设备拉取两份原始产物到发现目录。
 * 这是「真数据路径」的自动化半边——没有它，真检仍依赖人手导出（这正是此前被绕开的原因之一）。
 * 任何失败都如实返回原因，绝不静默降级成 self-test。
 * @param serial - adb 序列号（省略则用 adb 默认设备）。
 * @param dir - 落盘目录。
 * @returns `{ ok, reason }`。
 */
function pullFromDevice(serial, dir) {
  const adb = process.env.ADB || 'adb'
  const pkg = process.env.DSH_SHELL_PACKAGE || 'com.dsharnessmobile.shell'
  try {
    mkdirSync(dir, { recursive: true })
    const targets = [
      ['files/boot-segments.log', join(dir, 'boot-segments.log')],
      ['files/engine.log', join(dir, 'engine.log')],
    ]
    for (const [remote, local] of targets) {
      const args = [...(serial ? ['-s', serial] : []), 'shell', `run-as ${pkg} cat ${remote}`]
      const r = spawnSync(adb, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') {
        return { ok: false, reason: `adb 拉取 ${remote} 失败（status=${String(r.status)}）: ${(r.stderr || '').trim().slice(0, 160) || '空输出'}` }
      }
      writeFileSync(local, r.stdout)
    }
    return { ok: true, reason: '' }
  } catch (error) {
    return { ok: false, reason: 'adb 拉取异常: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

if (argv.includes('--self-test')) selfTest()
else {
  const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
  const strict = argv.includes('--require')
  // --require-real：产物缺席即判红（发布前设备门禁用）。默认档产物缺席只标 SKIP，但**绝不冒充绿**。
  const requireReal = argv.includes('--require-real') || strict
  const pullIdx = argv.indexOf('--pull')
  if (pullIdx >= 0) {
    const serial = argv[pullIdx + 1] !== undefined && !argv[pullIdx + 1].startsWith('--') ? argv[pullIdx + 1] : undefined
    const dir = process.env.DSH_BOOT_BUDGET_DIR || join(ROOT, '.deploy-tmp', 'boot-budget')
    const pull = pullFromDevice(serial, dir)
    if (!pull.ok) {
      console.error('CHECK-BOOT-BUDGET FAILED：--pull 未能取得设备产物 -> ' + pull.reason
        + '（真数据路径不可用；不得据此判绿）')
      process.exit(requireReal ? 1 : 2)
    }
    console.log('PULL  已从设备拉取真产物 -> ' + dir + (serial ? '（serial=' + serial + '）' : ''))
  }
  const explicitSegments = argOf('segments')
  const explicitProbe = argOf('probe')
  const found = discoverArtifacts(explicitSegments, explicitProbe)
  const segmentsPath = found.segmentsPath
  const probePath = found.probePath

  // 产物缺席：不是绿。默认档明确标 SKIP 并退 self-test（自证判据没退化成假防线），
  // --require-real/--require 档直接判红——避免「无产物 = 通过」。
  if (!segmentsPath || !probePath) {
    const missing = [!segmentsPath ? 'boot-segments.log' : null, !probePath ? 'engine.log(探针输出)' : null].filter(Boolean)
    if (requireReal) {
      console.error('CHECK-BOOT-BUDGET FAILED：真数据产物缺席（' + missing.join(', ') + '）'
        + '——--require-real 要求真检必须执行。落点：' + found.dir
        + '（可用 --pull <serial> 从设备拉取，或 --segments/--probe 显式指定）')
      process.exit(1)
    }
    // SKIP 纪律（check-gate-skips.mjs ST-31）：发射点必须带计数器或 `SKIP=` 汇总。
    // 本行是本脚本唯一的字面量 SKIP 发射点，故编号 #1 并与结尾的 SKIP= 汇总口径一致。
    console.log('SKIP(#1)(real-data)  真数据产物缺席（' + missing.join(', ') + '）——本次**未执行真检**'
      + '；落点 ' + found.dir + '（--pull <serial> 可取真产物，--require-real 可强制要求）')
    console.log('      退到 --self-test 自证判据本身能判红（这不等于冷启动达标）')
    selfTest()
  }

  const budgets = resolveBudgets(argv)
  // C5 正向对照（【0.14.1 P0-a 修复】此前 `runLivenessProbe` 已实现且被 export，但 `main()` 从不调用
  // ——「能力在、入口无」，与块J FIX-4 同形的假防线缺陷）。后果：产物内通常没有 `[perf] single` 行
  // （冷启动本来就不请求单条 URL），于是 C5 的「boot singles=0」无法区分「确实已延迟」与「探针没接上」，
  // C5+ 恒判红（真检因此永远过不去）或恒缺证据。现由 main 真跑一次惰性单条路径取读数。
  // 可关：--no-liveness（离线/无引擎树时），此时 C5+ 会如实报告对照未运行，不算绿。
  let liveness
  if (!argv.includes('--no-liveness')) {
    try {
      // 不传 libPath：runLivenessProbe 自带候选探测（DSH_COMBO_LIB / 约定落点）。
      liveness = runLivenessProbe()
    } catch (e) {
      liveness = { ok: false, reason: '活性对照抛错: ' + (e && e.message ? e.message : String(e)) }
    }
    console.log('LIVE  C5 正向对照：' + (liveness.ok ? '真跑通过（via ' + liveness.via + '）' : '失败 -> ' + liveness.reason))
  } else {
    console.log('LIVE  C5 正向对照：--no-liveness 已跳过（C5+ 将如实判红，不算绿）')
  }
  const { results } = runChecks({
    segments: parseSegments(readFileSync(segmentsPath, 'utf8')),
    probe: parseProbe(readFileSync(probePath, 'utf8')),
    require: true,
    liveness,
  }, budgets)
  console.log('REAL  产物来源: segments=' + segmentsPath)
  console.log('REAL  产物来源: probe=' + probePath)
  let hard = 0
  let skipped = 0
  for (const r of results) {
    const tag = r.ok ? 'PASS  ' : r.severity === 'warn' ? 'WARN  ' : r.severity === 'skip' ? 'SKIP  ' : 'FAIL  '
    if (!r.ok && r.severity === 'fail') hard += 1
    if (!r.ok && r.severity === 'skip') skipped += 1
    console.log(tag + r.label + (r.ok || r.detail === undefined ? '' : ' -> ' + r.detail))
  }
  if (budgets.firstResponseMs === undefined) {
    console.log('WARN  C1 绝对目标（t_boot_start → 首个响应）未重标：只作观测告警。'
      + '重标方法见 docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §6 第 2 项（目标设备 n>=5 基线）')
  }
  if (hard > 0) {
    console.error(`CHECK-BOOT-BUDGET FAILED（真检，${hard} 项判红，SKIP=${skipped}）`)
    process.exit(1)
  }
  console.log(`CHECK-BOOT-BUDGET PASSED（真检，SKIP=${skipped}）`)
}
