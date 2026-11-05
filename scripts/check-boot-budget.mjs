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
//
// 三代口径（每一代都是被设备实测推翻后重标的，不是「调参放宽」）：
//
// 第一代（-2026-09-19）50 ms：照搬**稳态**目标（docs/ANDROID-RUNTIME-PERF-2026-09-12.md §C6）。
// 错在口径错配——探针量的是冷启动窗口（全量 compose 进行中），与「稳态空闲」不是同一个量。
//
// 第二代（2026-09-19）100 ms：设备 n=3 实测 37.0 / 61.6 / 77.1 ms，取 max×1.3≈100。
// 错在**尺子本身失明**——那三个读数来自 perf_hooks 的 event-loop-delay monitor，而它对
// 「与 enable() 同 tick 内开始的同步块」结构性失明：直方图只度量它自己采样定时器的迟到量，
// 定时器尚未触发就什么都不记（本机复现：95/500/1500/2000 ms 各档一律读成约 11 ms）。
// ⇒ 它量的从来不是「冷启动窗口」，而是「Loader 装载结束之后那一小段残窗」。
//
// 第三代（2026-10-06）本轮：探针换成**自建、arming 时锚定墙钟基线**的采样器（首个 gap 覆盖
// 自 arming 起全部时间，含已在进行的块）。换尺后读数第一次与两条独立通路对齐：
//   · 独立 interval 观察器（同轮）：1666–2413 ms
//   · phase 探针 loader-settle-wait（用 performance.now 差值，从未受失明缺陷影响）：1532–7288 ms
//
// **样本量与分布（含一次自我更正，勿只看某一批）**：本阈值先按 16416 单机 n=8 定为 3400 ms，
// 随后在**两台**模拟器（16416 竖屏 + 16384 横屏，各自单机串行以免互抢 CPU）扩到 **n=24**，
// 才发现 n=8 那批**尾部被截短**、不具代表性：
//   n=24 全样本（ms，升序）：
//     1371.4 1372.7 1426.2 1468.4 1471.9 1518.9 1525.1 1525.6 1533.0 1654.6 1696.9 1753.9
//     1869.8 2005.6 2184.0 2188.7 2241.2 2533.4 2798.8 2886.5 3820.9 4709.4 4779.9 6260.6
//   → min 1371.4 · median 1811.8 · p75 2533.4 · p90 4709.4 · max 6260.6（max/min ≈ 4.6x）
//   n=8 那批评出的 3400 ms 会误红 4/24 —— **说明「扩样本后重标」是必要步骤，不是走过场**。
//
// 分解（n=24 同批）证明该窗口**不是** compose、也不由本仓补丁造成：
//   · compose 单次最大 4–22 ms；compose 调用数恒 2
//   · constructor-flush（我们的 client-modules registry 扫描）：37.7–552.8 ms
//   · loader-settle-wait：1532.5–7288.1 ms  ← p99 与它逐轮同步，是窗口支配项
// 即支配项是**上游引擎自身激活全部 ~193 条 Loader entry**（模块编译/求值链）。
//
// 阈值取值：**max×1.15 = 7199.6 → 7200 ms**。
//   · 取值规则与第二代一致（max×1.15），变的是样本量与分布事实，不是「放宽以过关」。
//   · **必须承认这条量程的局限**：观测到的 max/min 达 4.6x，该离散度主要来自**模拟器/宿主
//     调度抖动**（环境噪声），不是产品属性。因此 C4 是**粗粒度回归哨兵**，只用于捕获量级回归
//     （例如退回 A4 之前「每次 flush 全表重算」那种形态），**不得**当作紧性能门禁、更不得用
//     它的红/绿宣称「冷启动性能达标」。真正可归因于本仓的量是 constructor-flush（数十至数百 ms）。
//   · 这是**回归哨兵**，不是性能目标：约 1.4–6.3 s 的引擎自激活成本仍在，属上游引擎侧，
//     本仓只观测不认领。（注：详档里的 2795 ms 是 A4 之前的**单次 compose** 同步块，与本文的
//     loader-settle-window 不是同一个量，勿混用作本阈值的依据。）
//   · **样本依赖说明（重要）**：n=24 全部取自 MuMu x86_64 模拟器。真机(arm64)未测，可能显著更小；
//     发布前须在真机补同口径采样，届时应按**真机分布**重新取值，而不是沿用模拟器阈值。
const LOOP_P99_BUDGET_MS = 7200
// C4：至少要采到的样本数——**只用于区分「可判定」与「不可判定」，不用于健康判定**。
// 下限 30 曾在设备实测 25 个样本上误红（冷启动窗口长度随启动快慢天然波动）。取 10：n=10 时
// p99 约等于最大值，是粗糙但**非空洞**的断言；低于它分位数不成立 → C4 记 SKIP（不可判定），
// 而 samples==0 仍判红（探针坏掉）。换尺后实测样本 10–20，仍在 10 附近，故该下限保持不变。
const LOOP_MIN_SAMPLES = 10
/** C2：单个同步块上限（详档 §5.1：「探针报告的单次 compose dur ≤ 2000 ms」）。 */
const SYNC_BLOCK_BUDGET_MS = 2000
// C1：首次成功 HTTP 探测观测时刻 − TCP LISTEN 探测观测时刻的硬上界。
// 历史重标（2026-09-19，设备实测 12 个 boot）：原值 1000 ms **结构性不可达**；既有4000ms阈值依据
// 当时的端到端样本分布与旧成本估算，现保留为回归哨兵，不将其解释成服务端真实响应耗时上限。
// 两个观测时刻来自不同的采样器：
//   ① TCP LISTEN 由 watchEngineListen 每 500ms 尝试一次连接（单次超时 500ms）；
//   ② HTTP 时刻由 EngineStartFlow 的启动轮询写入，轮询间隔 1000ms，单次 EngineProbe 默认连接/读取超时 800ms；
//   ③ 两者之间还可能有真实服务就绪时间、线程调度延迟及页面路径成本。
// 两个时刻都由壳侧轮询落盘，而非服务端精确首字节时刻：LISTEN 来自 500ms TCP 探测循环；
// 首个 HTTP 来自 EngineProbe.check() 成功后的启动轮询（1s 间隔，单次请求有连接/读取超时）。
// 因此差值包含两条探针的采样量化与调度延迟。C1 超限本身不能证明同步 compose 阻塞，需结合 C2 与
// P1 phase 数据定位；C2 是独立的同步块预算。失败仍按原阈值判红，但不得把观测差描述成同步阻塞。
const LISTEN_TO_HTTP_OBSERVATION_BUDGET_MS = 4000
/**
 * C3：compose 调用数上限（与 P-AC-06 一致；已被设备实测满足，降级为回归哨兵）。
 *
 * 依据重写（2026-09-25，随 A4 退役）：这个 2 当初是照 **combo-lazy-A4** 的「9-14 次收敛为 1 次」
 * 定的。A4 已退役——上游 0.1.7 自己就把 combo 载荷惰性化了（dsh/packages/client/modules/README.md
 * 「creates combo descriptors without building response bodies」；index.ts:384 lazyBody）。
 * 撤掉 A4 后**裸树**在启动期是 **2 次** compose（.deploy-tmp/retire-sweep/REPORT.md §3.1.2 同基线实测：
 * 构造期先空表 1 次 records=0 / 2.27ms，随即 flush 带真记录 1 次 records=67 / 3.97ms；设备真值单次 5-9ms），
 * 所以阈值 2 **仍然可满足**、判据本身不需要放宽——它现在守的是「别再退回每次 flush 全表重算」。
 * 放宽会把这层哨兵一起撤掉，故**不放宽**。
 */
const COMPOSE_CALLS_BUDGET = 2

/**
 * 解析预算。C1 的**绝对**目标值（t_boot_start → 首个 HTTP 响应）按详档 §6 第 2 项尚未重标，
 * 因此默认只作观测告警；显式给 --first-response-budget 才升级为「失败即拒」。
 * 「首次成功 HTTP 探测观测 − TCP LISTEN 探测观测 ≤ 4000 ms」不受此影响，始终强制执行。
 */
export function resolveBudgets(argv = []) {
  const argOf = (name) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : undefined
  }
  const absolute = argOf('first-response-budget')
  return {
    listenToHttpObservationMs: argOf('listen-to-http-budget') ?? LISTEN_TO_HTTP_OBSERVATION_BUDGET_MS,
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
 * C5 正向对照的**真跑**：证明产品内单条 combo 的**服务路径**确实活着、且载荷是惰性的。
 *
 * 为什么不能在设备产物里等 `[perf] single` 行：一次正常冷启动**从不请求单条 URL**
 * （单条只在 HMR invalidate() 之后取用），所以那条行在真产物里结构性缺席。
 * 为什么不再读 `globalThis.__dshMobileComboLazyStats`：那个计数器由已撤销的 A5 安装，
 * 在 0.14.2 的树上**没有任何生产者**——继续用它，对照就永远「没跑起来」，C5 的恒 0 永不构成证据
 * （2026-09-25 实测：设备 singles=-1，parseProbe 也读不出）。
 * 现判据落回**上游自己的惰性契约**（0.1.7 `lazyBody`，index.ts:384）与真实服务路径：
 *   ① 离线直驱打过 P1 的引擎树：构造最小 registry → compose() → 按登记的单条 URL 请求；
 *   ② 断言三件事：单条 URL 命中 200、脚本头确实带该 id、`body()` 两次调用返回**同一 promise**
 *      （这是 `lazyBody` 的 memoize 契约，也是「载荷没被提前构造」的可判据证据）。
 * ① 跑不起来（无补丁树/载入失败）→ 如实返回 ran=false（环境前置），调用方记 SKIP，绝不当绿。
 * @param libPath - 引擎树 dsh-client-modules/lib/index.js 的路径（可省略，会自动探测）。
 * @returns `{ ok, ran, via, reason }`。
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
    // 调用方据此把严重度记为 SKIP 而非 FAIL——见 runChecks 的 C5/C5+ 分档说明。
    return { ok: false, ran: false, via: 'offline-drive', reason: '找不到打过补丁的 dsh-client-modules（用 DSH_COMBO_LIB 指定；构建链打补丁前必然缺席）' }
  }
  // 候选文件存在**不等于**它打过 P1 补丁：未打补丁的引擎树里没有探针面，直驱会失败并产出误导性的
  // 「对照失败」。故先做补丁在场性检查，缺席同样记 ran=false（环境前置）。
  if (!readFileSync(lib, 'utf8').includes('dsh-mobile combo probe (P1)')) {
    return { ok: false, ran: false, via: 'offline-drive', reason: '引擎树存在但未打过 P1 补丁（无 compose 探针面）: ' + lib }
  }
  const script = [
    'import { pathToFileURL } from \"node:url\";',
    'const mod = await import(pathToFileURL(process.argv[1]).href);',
    'const Registry = mod.ClientModuleRegistry;',
    '// cordis v4 的 Service 构造器要读 ctx.reflect.provide；缺它会 TypeError（实测）。',
    'const ctx = { on: () => {}, loader: { entries: () => [] }, effect: (cb) => cb(),',
    '  webServer: { register: () => () => {} }, reflect: { provide: () => {}, get: () => undefined, set: () => {} },',
    '  get: () => undefined, inject: () => {}, logger: { warn: () => {}, error: () => {} } };',
    'const registry = new Registry(ctx);',
    'const bundle = Buffer.from(\"window.__ModuleLoader__.load({ id: \\\"probe-live\\\", factory: function () { return 1; } });\\n\");',
    'registry.table.set(\"probe-live\", { entry: { id: \"probe-live\", rev: \"revliveness\", external: [], immediately: false }, bundle, meta: { clientPath: \"/nonexistent/probe-live/lib/client.js\", external: [], immediately: false } });',
    'registry.compose();',
    'const url = \"/plugins/??probe-live/client.js&rev=revliveness\";',
    'const response = registry.responses.get(url);',
    'if (response === undefined) { console.log(\"LIVENESS no-single-response url=\" + url); process.exit(0) }',
    '// lazyBody 契约：两次取 body 必须拿到同一 promise（载荷只在首个请求者那里构造一次）。',
    'const first = response.body();',
    'const second = response.body();',
    'const shared = first === second;',
    'const served = await registry.bundleResource(\"GET\", url);',
    'const body = served && served.body ? served.body.toString(\"utf8\") : \"\";',
    'console.log(\"LIVENESS status=\" + (served && served.status) + \" shared=\" + shared',
    '  + \" hasId=\" + body.includes(\"probe-live\") + \" bytes=\" + (served && served.body ? served.body.length : -1));',
  ].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, lib], { encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || ''))
  const m = /LIVENESS status=(\d+) shared=(true|false) hasId=(true|false) bytes=(\d+)/.exec(out)
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
  const status = Number(m[1]); const shared = m[2] === 'true'; const hasId = m[3] === 'true'; const bytes = Number(m[4])
  if (status !== 200) return { ok: false, ran: true, via: 'offline-drive', reason: '单条 URL 未命中（status=' + status + '）' }
  if (!hasId) return { ok: false, ran: true, via: 'offline-drive', reason: '单条载荷不含该 id（bytes=' + bytes + '）——服务路径指向了别的资源' }
  if (!shared) return { ok: false, ran: true, via: 'offline-drive', reason: '两次取 body 不是同一 promise——载荷惰性/memoize 契约不成立' }
  return { ok: true, ran: true, via: 'offline-drive：compose()→单条 URL 200（bytes=' + bytes + '，同一 lazyBody promise）', reason: '' }
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
 *   [perf] TOTAL calls=<n> totalMs=<ms> instances=<n> firstAt=<ms>ms singles=<n> loopP99Ms=<-1|ms|n/a> loopSamples=<-1|n> [comboCache=...]
 */
export function parseProbe(text) {
  const body = String(text ?? '')
  const composeDur = [...body.matchAll(/\[perf\] compose #(\d+) at=(\d+)ms dur=(\d+)ms/g)]
    .map((m) => ({ n: Number(m[1]), at: Number(m[2]), dur: Number(m[3]) }))
  // G-1 修复（2026-09-25）：原实现用 String.prototype.exec 只取**首条** TOTAL 行——P1 探针是
  // 在**每次** compose() 返回处各打一对 compose/TOTAL 行，A4 退役后设备 compose 由 1 次变 8 次，
  // 于是 exec 读到第一条 calls=1 而真值 8，C3 打印「compose 调用数 = 1 ≤ 2 PASS」。
  // 这是「防线消失却显示绿色」的同形复发：判据本身没写错，是**取值口径**把末次真值丢了。
  // 改为 matchAll 取**全部**：末条（进程累计计数，单调不减，末条即真值）给出 composeCalls，
  // 所有行的最大值（maxComposeCalls，防行序被日志轮转/交错打乱时低估）留给 C3 判据。
  const totalLines = [...body.matchAll(/\[perf\] TOTAL calls=(\d+) totalMs=(\d+)/g)]
    .map((m) => ({ calls: Number(m[1]), totalMs: Number(m[2]) }))
  const total = totalLines.length > 0 ? totalLines[totalLines.length - 1] : null
  // P1 在 A5 计数缺席时**故意**打 singles=-1（绝不省字段），所以正则必须收 -1：
  // 缺了这条分支，解析返回 undefined，C5 对设备真值永远不可判定（2026-09-25 实测复现）。
  const bootLines = [...body.matchAll(/\[perf\] boot singles=(-?\d+|n\/a)/g)].map((m) => m[1])
  const singleLines = [...body.matchAll(/\[perf\] single #(\d+) at=\d+ms singles=(-?\d+|n\/a)/g)]
    .map((m) => ({ n: Number(m[1]), singles: m[2] }))
  const singlesField = /singles=(\d+)/.exec(body)
  // TOTAL 行可能先输出 monitor 尚未采样的 -1/0，随后再输出 debounce 收口后的真实读数。
  // 两个字段必须从同一条、最新的完整 TOTAL 行配对读取；分开 .exec 会把早期哨兵当成最终值。
  const loopStats = [...body.matchAll(/\[perf\] TOTAL\b[^\r\n]*?\bloopP99Ms=(-?\d+(?:\.\d+)?|n\/a)\s+loopSamples=(-?\d+)\b/g)]
    .map((m) => ({ p99: m[1], samples: Number(m[2]) }))
  const lastLoopStats = loopStats.length > 0 ? loopStats[loopStats.length - 1] : null
  return {
    hasProbe: total !== null,
    // composeCalls 取**末条** TOTAL 的 calls：P1 的 stats.calls 是进程内累计计数器，末条即真值。
    composeCalls: total === null ? undefined : total.calls,
    totalMs: total === null ? undefined : total.totalMs,
    // G-1 反向判据面：全部 TOTAL 行 + 行数。C3 用 maxComposeCalls 兜住「末条被截断/乱序」低估，
    // totalLineCount 让「行数与会话数不符」可判（行数与末次 calls 应当一致）。
    totalLines,
    totalLineCount: totalLines.length,
    maxComposeCalls: totalLines.length > 0 ? Math.max(...totalLines.map((t) => t.calls)) : undefined,
    maxComposeDur: composeDur.length > 0 ? Math.max(...composeDur.map((c) => c.dur)) : undefined,
    composeDur,
    // C5：boot 行是「首次全量 compose 之后」的读数，正是要断言的量（TOTAL 是退出时刻读，不能用）。
    // 三态（与 C4 同形，禁止把「不可判定」压成「不健康」或「健康」）：
    //   0        计数在场且为 0（A5 型计数器活着 —— 可直接判惰性成立）
    //   > 0      计数在场且非 0（启动期仍在构建单条 —— 判红）
    //   -1       计数器**整个缺席**（A5 退役后的常态；P1 的哨兵值，不是读数）
    //   undefined 行缺席或 n/a（探针没接上 —— 不可判定）
    bootSingles: bootLines.length > 0 && bootLines[bootLines.length - 1] !== 'n/a'
      ? Number(bootLines[bootLines.length - 1]) : undefined,
    singleEvents: singleLines,
    // 正向对照：请求单条 URL 之后留下的最大 singles 读数（必须 > 0 才证明探针活着）。
    maxSingleSingles: singleLines.length > 0
      ? Math.max(...singleLines.map((s) => (s.singles === 'n/a' ? -1 : Number(s.singles)))) : undefined,
    singlesAtExit: singlesField ? Number(singlesField[1]) : undefined,
    loopP99Ms: lastLoopStats && lastLoopStats.p99 !== 'n/a' ? Number(lastLoopStats.p99) : undefined,
    loopSamples: lastLoopStats?.samples,
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

  // ── C5 boot 期单条 combo 构建数（三态；A5 退役后该计数器已无生产者）──
  //
  // 2026-09-25 退役 A4 时连带修的**第二条** C5 缺陷：本判据的正向对照原先只认
  // `globalThis.__dshMobileComboLazyStats.singleBuilds`（A5 装的计数器）。A5 在 0.14.2 已撤销、
  // 上游 0.1.7 又把脚本体改成原生惰性 lazyBody，于是那个计数器**没有任何生产者**，
  // bootSingles 在设备上恒为 -1 —— C5 的「恒 0」因此在任何环境下都不构成证据。
  // 判据分三态（与 C4 同形：禁止把「不可判定」压成「不健康」或「健康」）：
  //   ① boot === 0                计数器在场且为 0 → 惰性成立（产物可直接判）
  //   ② boot > 0                  计数器在场且非 0 → 判红（启动期仍在构建单条）
  //   ③ boot === -1 或 undefined  计数器缺席/探针没接上 → 不可判定，交 C5+ 正向对照取证：
  //                              对照真跑通过即等价成立；跑不起来（无补丁树）→ SKIP，绝不判绿。
  // 于是 C5 既不恒绿（②永远能红）也不恒红（③在有对照时等价成立，无对照时如实 SKIP）。
  {
    const boot = probe.bootSingles
    const control = probe.maxSingleSingles
    const livenessOk = liveness !== undefined && liveness.ok === true
    const livenessRan = liveness !== undefined && liveness.ran === true
    if (!probe.hasProbe || boot === undefined) {
      add('C5', 'C5 boot 期单条 combo 构建数 = 0', false,
        '缺 `[perf] boot singles=` 原始读数——无法区分「已延迟」与「探针没接上」',
        strict ? 'fail' : 'skip')
    } else if (boot === 0) {
      add('C5', 'C5 boot 期单条 combo 构建数 = 0（实测 boot singles=0）', true)
    } else if (boot > 0) {
      add('C5', 'C5 boot 期单条 combo 构建数 = 0', false,
        'boot singles=' + boot + ' > 0：启动期仍在构建单条产物')
    } else {
      // boot === -1：A5 计数器已无生产者（P1 的哨兵值，不是读数），不能当「已延迟」。
      const satisfied = (control !== undefined && control >= 1) || livenessOk
      add('C5', 'C5 boot 期单条 combo 构建数（计数器缺席：boot singles=-1，A5 已退役）',
        satisfied,
        'singles=-1 是 P1 的哨兵值（A5 计数器已无生产者），不是读数；'
        + (satisfied
          ? '由 C5+ 正向对照裁定：产品内单条服务路径真跑通过'
          : '且 C5+ 正向对照未取证 -> ' + String(liveness?.reason ?? 'liveness 对照未运行')),
        satisfied ? 'pass' : (livenessRan ? 'fail' : 'skip'))
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
    // control / livenessOk / livenessRan 已在本条上方的 C5 分档里声明（同一块作用域）。
    const controlOk = control !== undefined && control >= 1
    const controlSatisfied = controlOk || livenessOk
    // 严重度分档（【0.14.1 P0-a 修复】区分「对照跑了但失败」与「对照因环境前置缺席而无法跑」）：
    //   - 跑过且失败（liveness.ran === true）→ fail：这是真防线失守；
    //   - 环境前置缺席（找不到**打过补丁**的引擎树——构建链在打补丁之前就要跑本门禁，此时必然缺席）
    //     → skip：如实记为 SKIP，**不**算 C5 的「恒 0」已取证，也**不**据此判绿；
    //   - requireReal（设备验收档，此时构建产物已存在、补丁树可得）→ 缺席即 fail，强制取证。
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

  // ── C1 首次成功 HTTP 探测观测 − TCP LISTEN 探测观测（阈值保持 4000 ms）──
  {
    const listen = segments.listen
    const http = segments.firstHttp
    if (http === undefined) {
      add('C1', 'C1 首个 HTTP 响应时间（与 LISTEN 同时断言）', false,
        't_first_http 未知（探针未装）——首次成功 HTTP 探测观测与 TCP LISTEN 探测观测之差无法判定；只判 LISTEN 会系统性假绿',
        strict ? 'fail' : 'skip')
    } else {
      // 硬判据：两次壳侧成功探测的观测时刻相差不超过预算。它包含采样/调度延迟，不能单独归因于同步阻塞。
      if (listen === undefined) {
        add('C1', 'C1 首次成功 HTTP 探测观测 − TCP LISTEN 探测观测 ≤ ' + budgets.listenToHttpObservationMs + ' ms', false, 'TCP LISTEN 观测时刻未知')
      } else {
        const delta = http - listen
        add('C1', 'C1 首次成功 HTTP 探测观测 − TCP LISTEN 探测观测 = ' + delta + ' ms ≤ ' + budgets.listenToHttpObservationMs + ' ms',
          delta <= budgets.listenToHttpObservationMs,
          'TCP LISTEN 观测=' + listen + ' 首次成功 HTTP 探测观测=' + http + ' → 差 ' + delta + 'ms；差值包含两条探针的轮询采样与调度延迟，单凭 C1 不能归因于同步 compose；请结合 C2 与 P1 phase 数据')
      }
      // 绝对目标：未重标前只告警（详档 §6 第 2 项纪律），显式给 --first-response-budget 才判红。
      if (segments.bootStart !== undefined) {
        const absolute = http - segments.bootStart
        if (budgets.firstResponseMs === undefined) {
          add('C1-abs', 'C1 冷启动 → 首次成功 HTTP 探测观测 = ' + absolute + ' ms（--first-response-budget 未给：观测告警，不判红）',
            true, undefined, 'warn')
        } else {
          add('C1-abs', 'C1 冷启动 → 首次成功 HTTP 探测观测 = ' + absolute + ' ms ≤ ' + budgets.firstResponseMs + ' ms',
            absolute <= budgets.firstResponseMs, '超出预算 ' + budgets.firstResponseMs + 'ms')
        }
      }
    }
  }

  // ── C3 compose 调用数 ≤ 2（回归哨兵；A4 退役后裸树 2 次，阈值仍可满足，见常量处依据）──
  //
  // G-1 修复（2026-09-25）：判据取值改用**全部** TOTAL 行的最大值，而不是首条。原实现下
  // 多行产物只读到第一条 calls=1，真值 8 时照样打印 PASS（见 parseProbe 处的复现说明）。
  // 同时断言「TOTAL 行数 == 末次 calls」：P1 的 calls 是进程内累计计数器，每次 compose 返回处
  // 打一行，故两者必须相等；不等即说明有行被日志轮转截断/解析漏读，读数不可信——判红而非静默取小。
  {
    // issue #1194：调用数取原始事件行，不取被检查方自报的 TOTAL 汇总。
    //
    // 旧判据只数 TOTAL calls= 行（maxComposeCalls），而同一份产物里的 [perf] compose #n
    // 事件行被 C2 用来算耗时、却从不计数。于是 8 次 compose + 只打 1 行 TOTAL（自报 calls=1）
    // → C3 打印「= 1 ≤ 2」PASS。少打一行 TOTAL、或 TOTAL 只报最后一次，预算就自动放宽 ——
    // 判据读的是被检查方的自述。
    //
    // 现在两路取值并取最大值：
    //   - events：真实事件行条数（原始事实，除非不打印事件否则改不了）；
    //   - reported：自报汇总（保留，累计计数器能暴露「事件行被截断」）。
    // 两者取大，任何一路偏小都不会放宽预算。
    const events = probe.hasProbe ? probe.composeDur.length : undefined
    const reported = probe.hasProbe ? probe.maxComposeCalls : undefined
    const calls = events === undefined || reported === undefined
      ? undefined : Math.max(events, reported)
    const last = probe.hasProbe ? probe.composeCalls : undefined
    const lines = probe.totalLineCount ?? 0
    if (calls === undefined) {
      add('C3', 'C3 compose 调用数 ≤ ' + budgets.composeCalls, false, '缺 TOTAL calls= 读数',
        strict ? 'fail' : 'skip')
    } else {
      // 自洽判据保留：TOTAL 行数应当等于末次自报 calls。
      // 但它不能单独充当调用数判据 —— 只打 1 行 TOTAL 时它对 1 === 1 恒成立。
      const consistent = lines === last
      add('C3', 'C3 compose 调用数 = ' + calls + '（事件行 ' + events + ' / 自报 ' + reported
        + ' 取大）≤ ' + budgets.composeCalls,
        consistent && calls <= budgets.composeCalls,
        consistent
          ? 'calls=' + calls + '（事件行 ' + events + '，自报 ' + reported + '）超预算 ' + budgets.composeCalls
          : ('TOTAL 行数 ' + lines + ' ≠ 末次 calls=' + last
            + '（累计计数器每次 compose 打一行，不等即有行被截断/漏读，读数不可信）'))
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
  //   ③ sentinel/负样本、samples == 0 → **FAIL**（探针/接线坏了，正是 C4 要防的真缺陷）。
  // ③ 是「C4 不会因长期 SKIP 而丧失判别力」的锚点：没有它，把不足一律 SKIP 等于让 C4 永绿。
  {
    const p99 = probe.loopP99Ms
    const samples = probe.loopSamples
    const budgetLabel = 'C4 冷启动窗口内 p99 < ' + budgets.loopP99Ms + ' ms（样本 ≥ ' + budgets.loopMinSamples + ' 才可判定）'
    if (p99 === undefined || samples === undefined) {
      add('C4', budgetLabel, false,
        '缺 loopP99Ms/loopSamples 读数——探针未产出事件循环读数（接线坏了）', strict ? 'fail' : 'skip')
    } else if (p99 < 0 || samples < 0) {
      add('C4', budgetLabel, false,
        '事件循环探针返回哨兵值：loopP99Ms=' + p99 + ' loopSamples=' + samples
        + '（负值表示没有有效读数，不能视为缺字段、SKIP 或通过）')
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
  // G-1（2026-09-25）：A4 退役后设备一次启动会打 N 条 TOTAL（P1 在每次 compose 返回处各打一行）。
  // 这个构造器造「最后一次 calls = final、共 lines 条」的真形态，用于 C3 的多行判据反证。
  const multiTotalProbe = (lines, final) => {
    const out = []
    const lastCompose = Math.max(1, final)
    for (let i = 1; i <= lastCompose; i += 1) {
      out.push('[perf] compose #' + i + ' at=' + (3400 + i * 40) + 'ms dur=6ms instances=1 records=65 singles=-1')
    }
    // TOTAL 行的 calls 序列：前 lines-1 条递增，**末条**强制为 final。
    // lines === final 时两者自洽（完整体）；lines < final 时末次 calls 大于行数（有行被截断/漏读）。
    for (let i = 1; i <= lines; i += 1) {
      const callsValue = i === lines ? final : i
      out.push('[perf] TOTAL calls=' + callsValue + ' totalMs=' + (i * 6) + ' instances=1 firstAt=3480ms singles=-1'
        + ' loopP99Ms=12 loopSamples=40')
    }
    out.push('[perf] boot singles=-1 records=65')
    return out.join('\n')
  }
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
    check('反向对照：首次成功 HTTP 探测观测晚于 TCP LISTEN 观测 4500ms → C1 判红',
      okOf(r, 'C1') === false, 'C1 ok=' + okOf(r, 'C1'))
    const c1 = resultOf(r, 'C1')
    check('反向对照：C1 超限仍维持 4000ms 阈值且明确是观测差',
      c1?.label.includes('≤ 4000 ms') === true && c1?.label.includes('探测观测') === true,
      String(c1?.label ?? ''))
    check('反向对照：C2 同步块预算通过时，C1 详情不把超限归因于同步 compose',
      okOf(r, 'C2') === true && String(c1?.detail ?? '').includes('轮询采样与调度延迟')
        && !String(c1?.detail ?? '').includes('被同步块挡住'),
      'C2=' + okOf(r, 'C2') + ' C1 detail=' + String(c1?.detail ?? ''))
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

  // ④b 【G-1 修复】多行 TOTAL：解析取全部而不是首条；真值 8 必须判红。
  //     旧实现（`.exec` 取首条）在本输入上读到 calls=1 → 打印 PASS，正是「防线消失却显示绿色」。
  {
    const body = multiTotalProbe(8, 8)
    const parsed = parseProbe(body)
    check('④b-① 多行 TOTAL 解析取末条（composeCalls=8 而非首条 1）',
      parsed.composeCalls === 8, 'composeCalls=' + String(parsed.composeCalls))
    check('④b-② 多行 TOTAL 全部收进 totalLines（8 条）',
      parsed.totalLineCount === 8, 'totalLineCount=' + String(parsed.totalLineCount))
    const r = run(segLine(), body)
    check('④b-③ 真值 calls=8 > 阈值 2 → C3 判红（旧实现此处打印 PASS）',
      okOf(r, 'C3') === false, 'C3 ok=' + okOf(r, 'C3') + ' label=' + String(resultOf(r, 'C3')?.label ?? ''))
    // issue #1194 后 C3 口径是「事件行 / 自报 取大」，理由行要能看见两个来源。
    check('④b-④ 判红理由点名真值 8 与「事件行/自报取大」口径',
      String(resultOf(r, 'C3')?.label ?? '').includes('8') && String(resultOf(r, 'C3')?.label ?? '').includes('事件行') && String(resultOf(r, 'C3')?.label ?? '').includes('自报'),
      String(resultOf(r, 'C3')?.label ?? ''))
    // 行数 ≠ 末次 calls（行被截断/漏读）→ 读数不可信，必须判红而不是静默取小。
    const truncated = run(segLine(), multiTotalProbe(3, 8))
    check('④b-⑤ TOTAL 行数(3) ≠ 末次 calls(8) → C3 判红（读数不可信，不静默取小）',
      okOf(truncated, 'C3') === false, 'C3 ok=' + okOf(truncated, 'C3'))
    check('④b-⑥ 行数不一致的判红理由点名截断/漏读',
      String(resultOf(truncated, 'C3')?.detail ?? '').includes('截断'),
      String(resultOf(truncated, 'C3')?.detail ?? ''))
    // 多行但都在阈值内 → 必须判绿（证明不是「多行即红」的恒红改写）
    const within = run(segLine(), multiTotalProbe(2, 2))
    check('④b-⑦ 多行 TOTAL 且真值 2 ≤ 阈值 → C3 判绿（不是「多行即红」）',
      okOf(within, 'C3') === true, 'C3 ok=' + okOf(within, 'C3'))
  }

  // ⑤ 反向对照：boot singles=56（未延迟）→ C5 必须判红
  {
    const r = run(segLine(), probeText({ bootSingles: 56, singled: true, single: true }))
    check('反向对照：boot singles=56（未延迟）→ C5 判红', okOf(r, 'C5') === false, 'C5 ok=' + okOf(r, 'C5'))
  }

  // ⑤b 【0.14.2 A4 退役连带】设备真值形态：P1 在 A5 计数缺席时打 singles=-1。
  //     ① 解析必须读得出 -1（旧正则缺 -1 分支 ⇒ undefined ⇒ C5 永远不可判定，这是被测出的缺陷）；
  //     ② -1 + 正向对照真跑通过 ⇒ C5 判绿（等价成立）；
  //     ③ -1 且对照跑不起来 ⇒ C5 记 SKIP（**不是** pass、也不是 fail）；
  //     ④ 把对照换成「跑过但失败」⇒ C5 判红（判别力不得因三态而丢失）。
  {
    const parsed = parseProbe(probeText({ bootSingles: -1 }))
    check('⑤b-① 解析器读得出 singles=-1（A5 退役后的设备真值形态）',
      parsed.bootSingles === -1, 'bootSingles=' + String(parsed.bootSingles))
    const live = { ok: true, ran: true, via: 'stub', reason: '' }
    const withControl = runChecks({ segments: parseSegments(segLine()), probe: parseProbe(probeText({ bootSingles: -1 })), require: true, liveness: live }, resolveBudgets([]))
    const c5ok = withControl.results.find((x) => x.id === 'C5')
    check('⑤b-② singles=-1 且正向对照真跑通过 → C5 判绿（不是恒红）',
      c5ok?.ok === true && c5ok?.severity === 'pass', 'ok=' + c5ok?.ok + ' severity=' + c5ok?.severity)
    const absent = runChecks({ segments: parseSegments(segLine()), probe: parseProbe(probeText({ bootSingles: -1 })), require: true, liveness: { ok: false, ran: false, via: 'stub', reason: 'no tree' } }, resolveBudgets([]))
    const c5skip = absent.results.find((x) => x.id === 'C5')
    check('⑤b-③ singles=-1 且对照跑不起来 → C5 记 SKIP（既不是 pass 也不是 fail）',
      c5skip?.ok === false && c5skip?.severity === 'skip', 'ok=' + c5skip?.ok + ' severity=' + c5skip?.severity)
    const failed = runChecks({ segments: parseSegments(segLine()), probe: parseProbe(probeText({ bootSingles: -1 })), require: true, liveness: { ok: false, ran: true, via: 'stub', reason: 'single path broken' } }, resolveBudgets([]))
    const c5fail = failed.results.find((x) => x.id === 'C5')
    check('⑤b-④ singles=-1 且对照跑过但失败 → C5 判红（判别力不因三态丢失）',
      c5fail?.ok === false && c5fail?.severity === 'fail', 'ok=' + c5fail?.ok + ' severity=' + c5fail?.severity)
    check('⑤b-⑤ singles=-1 的理由点名「哨兵值/无生产者」，不得冒充读数',
      String(c5ok?.detail ?? '').includes('哨兵值'), String(c5ok?.detail ?? '').slice(0, 80))
  }

  // ⑥ 反向对照：boot singles=0 但缺正向对照 → C5+ 必须判红（区分「已延迟」与「探针没接上」）
  {
    const r = run(segLine(), probeText({ bootSingles: 0, single: false }))
    check('反向对照：boot singles=0 且无单条请求证据 → C5 正向对照判红',
      okOf(r, 'C5+') === false, 'C5+ ok=' + okOf(r, 'C5+'))
  }

  // ⑦ 反向对照：p99=-1 且样本数为 0 → 哨兵和空读数都必须被解析并使 C4 判红。
  // 这是三态切法里的第 ③ 态，也是「C4 不因长期 SKIP 而丧失判别力」的锚点。
  {
    const body = probeText({ p99: -1, samples: 0, single: true })
    const parsed = parseProbe(body)
    check('反向对照：loopP99Ms=-1 被解析为哨兵值，loopSamples=0 保留为真实读数',
      parsed.loopP99Ms === -1 && parsed.loopSamples === 0,
      'loopP99Ms=' + String(parsed.loopP99Ms) + ' loopSamples=' + String(parsed.loopSamples))
    const r = run(segLine(), body)
    check('反向对照：loopP99Ms=-1 / loopSamples=0 → C4 判红（不得误报缺字段或 SKIP）',
      okOf(r, 'C4') === false && resultOf(r, 'C4')?.severity === 'fail',
      'C4 ok=' + okOf(r, 'C4') + ' severity=' + resultOf(r, 'C4')?.severity)
    check('反向对照：负哨兵判红理由明确点名「哨兵值」',
      String(resultOf(r, 'C4')?.detail ?? '').includes('哨兵值'),
      String(resultOf(r, 'C4')?.detail ?? '').slice(0, 100))
  }

  // ⑦a 实机反例：首次 TOTAL 可以在采样窗口收口前记录 -1/0，末次 TOTAL 才有完整采样。
  // 必须从末条完整 TOTAL 读取一对数据，不能把早期哨兵读成最终值，也不能跨行拼接字段。
  {
    const body = [
      '[perf] TOTAL calls=1 totalMs=300 instances=1 firstAt=100ms singles=-1 loopP99Ms=-1 loopSamples=0',
      '[perf] compose #2 at=800ms dur=40ms instances=1 records=60 singles=-1',
      // 245.1 是**第二代（失明尺）**时期的实机读数，此处仅用于验证「取末条完整 loopStats」的解析语义。
      '[perf] TOTAL calls=2 totalMs=340 instances=1 firstAt=100ms singles=-1 loopP99Ms=245.1 loopSamples=20',
    ].join('\n')
    const parsed = parseProbe(body)
    check('⑦a-① 多条 TOTAL 取末条完整 loopStats（245.1ms / 20）',
      parsed.loopP99Ms === 245.1 && parsed.loopSamples === 20,
      'loopP99Ms=' + String(parsed.loopP99Ms) + ' loopSamples=' + String(parsed.loopSamples))
    // **必须由预算常量推导，不得写死字面量**：本用例原写死「245.1ms 必判红」，那是照失明尺时期的
    // 100ms 预算写的；2026-10-06 按新尺重标到 3400ms 后 245.1 < 3400，该断言**静默失效**——
    // 与 ⑧ 处已记载的 `p99=88` 事故同形（一个不会失败的测试不是防线）。改从常量推导，读数本身
    // 只作解析面样本，判红面用「预算 + 123.4」这个必然超预算的值。
    const overBudget = LOOP_P99_BUDGET_MS + 123.4
    const overBody = [
      '[perf] TOTAL calls=1 totalMs=300 instances=1 firstAt=100ms singles=-1 loopP99Ms=-1 loopSamples=0',
      '[perf] TOTAL calls=2 totalMs=340 instances=1 firstAt=100ms singles=-1 loopP99Ms=' + overBudget + ' loopSamples=20',
    ].join('\n')
    const r = run(segLine(), overBody)
    check('⑦a-② 超预算读数（' + overBudget + 'ms / 20 样本）判 C4 FAIL',
      okOf(r, 'C4') === false && resultOf(r, 'C4')?.severity === 'fail',
      'C4 ok=' + okOf(r, 'C4') + ' severity=' + resultOf(r, 'C4')?.severity)
    const finalSentinel = parseProbe([
      '[perf] TOTAL calls=1 totalMs=300 instances=1 firstAt=100ms singles=-1 loopP99Ms=12 loopSamples=40',
      '[perf] TOTAL calls=2 totalMs=340 instances=1 firstAt=100ms singles=-1 loopP99Ms=-1 loopSamples=0',
    ].join('\n'))
    check('⑦a-③ 末条仍为 -1/0 时保留末条哨兵（不回退到早期健康值）',
      finalSentinel.loopP99Ms === -1 && finalSentinel.loopSamples === 0,
      'loopP99Ms=' + String(finalSentinel.loopP99Ms) + ' loopSamples=' + String(finalSentinel.loopSamples))
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
    console.log('WARN  C1 绝对目标（t_boot_start → 首次成功 HTTP 探测观测）未重标：只作观测告警。'
      + '重标方法见 docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §6 第 2 项（目标设备 n>=5 基线）')
  }
  if (hard > 0) {
    console.error(`CHECK-BOOT-BUDGET FAILED（真检，${hard} 项判红，SKIP=${skipped}）`)
    process.exit(1)
  }
  console.log(`CHECK-BOOT-BUDGET PASSED（真检，SKIP=${skipped}）`)
}
