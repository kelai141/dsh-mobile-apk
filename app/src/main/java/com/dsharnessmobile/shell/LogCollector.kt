package com.dsharnessmobile.shell

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Dev debug-log collector (default off; controlled by the Settings → Developer options toggle):
 * logcat (own uid: shell + engine child processes) + engine.log incremental tail → appended daily to
 * Documents/dshdata/log/dsh-<yyyy-MM-dd>.log (falls back to filesDir/log/ without
 * MANAGE_EXTERNAL_STORAGE; the path is shown on the settings page). Files over 5MB rotate to
 * dsh-<date>.1.log; a new file starts on each new day. Process-level singleton, start/stop idempotent.
 *
 * Privacy: logs contain commands and model content, for troubleshooting only; no credential files are read.
 * All sink writes pass EngineAuth.redact() (0.13.8 #184) — launch tokens never reach shared copies.
 */
object LogCollector {

  private const val TAG = "dsh-log"
  private const val INTERVAL_MS = 5_000L
  private const val MAX_FILE_BYTES = 5L * 1024 * 1024
  private const val MAX_ENGINE_CHUNK = 256 * 1024

  private var executor: ScheduledExecutorService? = null
  private var appContext: Context? = null

  /** 事件写盘专用单线程执行器（0.13.8 #174：log() 曾同步 appendText——FileIncoming 来件
   *  管线与 MainActivity 通知链都在主线程调它，磁盘慢时直接卡首帧）。FIFO 保序；daemon。 */
  private val logExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newSingleThreadExecutor { r ->
      Thread(r, "dsh-log-writer").apply { isDaemon = true }
    }

  /** engine.log incremental read offset (in-process; restarts from the top on truncation/rotation). */
  private var engineLogOffset = 0L

  /** Last seen logcat line timestamp (threadtime "MM-dd HH:mm:ss.SSS"; lexicographic order). */
  private var lastLogcatTs = ""

  fun start(context: Context) {
    if (executor != null) return
    appContext = context.applicationContext
    engineLogOffset = 0L
    lastLogcatTs = ""
    executor = Executors.newSingleThreadScheduledExecutor().also { exec ->
      exec.scheduleWithFixedDelay({ tick() }, 0, INTERVAL_MS, TimeUnit.MILLISECONDS)
    }
    Log.i(TAG, "collector started")
  }

  fun stop() {
    executor?.shutdownNow()
    executor = null
    appContext = null
    Log.i(TAG, "collector stopped")
  }

  /** 采集器是否在跑（ST-11：开关展示值 = 偏好 && 本值——只看偏好就是乐观置位）。只读，无副作用。 */
  fun isRunning(): Boolean = executor != null

  // ── P-AC-04（§7.2）：启动分段计时插桩（三字段可 grep） ────────────────────────
  //
  // 口径（与 scripts/perf/count-compose.mjs 的探针 TOTAL totalMs= 对齐，判据差 <5%）：
  //   t_boot_start    壳侧引擎启动请求时刻（epoch ms；EngineManager.startWithArgs 落点）
  //   t_listen        壳侧观察到 Web 端口首次应答的时刻（epoch ms；spawn 起的有界观察线程）
  //   t_compose_total 引擎侧 compose 累计耗时（ms；解析引擎 stdout 的探针行，未装探针时 -1）
  //
  // 判据落盘面 = **壳侧自有文件** `files/boot-segments.log`（唯一写者是壳自己；O_APPEND；
  // 超 64 KiB 轮转一代 .1）。三字段**恒在场**（未知写 -1），因此任何一行都能被单条 grep 命中。
  //
  // 为什么不写 engine.log（设备实测 r10 的结论，别改回去）：engine.log 是引擎 stdout 重定向
  // 文件，其 fd 非 append 且偏移由引擎自己的写推进——壳侧追加的行会被引擎随后的输出**从它
  // 自己的偏移覆盖**，「尾部追加 + 有界补写」在真机上被整行吃掉（三字段全丢；引擎只写了 210 B，
  // 文件里连残尾都没有）。engine.log 依旧只归引擎（EngineAuth 的 token 链依赖它不被改写）。
  // 次面：采集器在跑时同一行另写按天日志（出口脱敏）；采集器关闭时不凭空造日志文件。
  private const val SEGMENT_MARK = "dsh-boot-segments"

  /** P-AC-04 判据文件（壳侧自有；grep 路径见验收计划 P-AC-04）。 */
  private const val SEGMENTS_FILE = "boot-segments.log"

  /** 判据文件上限：每次启动最多 3 行、单行 <200 B；超限轮转一代（.1）。 */
  private const val SEGMENTS_MAX_BYTES = 64L * 1024

  /**
   * 探针口径：`[perf] TOTAL calls=… totalMs=… instances=… firstAt=…ms singles=… loopP99Ms=… loopSamples=…`
   * （`scripts/perf/count-compose.mjs` 产出；T2 定稿口径，尾部多字段不影响本解析）。
   *
   * **为什么设备上恒为 -1（P0 真因，两条，源码级确证）**：
   *
   * （甲）**产出面缺席**——`[perf] …` 系列行只有测量用 preload `scripts/perf/count-compose.mjs` 才会打印
   * （它以 `--import` 注入引擎命令行，并在 `process.on('exit')` 输出 TOTAL 汇总）。而该脚本
   * **没有任何发行路径**：它不在快照 stage 里、不在 `engine-overlay.json`、不被 `inject-all.py` 注入，
   * 出厂引擎 argv（`node --expose-internals bin.js web --port … --no-open`）与 env 都不含它。
   * ⇒ 正则/解析器本身没坏，坏的是**上游从未产出该行**。这一半必须由引擎侧（插桩注入）解决，
   * 壳侧无论怎么改都造不出真值——**壳侧不得用任何近似量冒充它**（见下方 A3 的处理）。
   *
   * （乙）**解析链只在采集器开关打开时才跑**（本侧真缺陷，已修）——旧实现把 `maybeEmitComposeTotal`
   * 只挂在 `tick()` 里，而 `tick()` 由调试日志采集器驱动、采集器**默认关闭**。于是即使探针在场，
   * 默认设备上 `t_compose_total` 也恒为 -1。现改为 [startProbeTail]：与采集器开关**解耦**的独立
   * 轻量 tail（只在 boot 窗口内有界存活），在任何设备上都能把探针值落成真实值。
   */
  private val COMPOSE_TOTAL_RE = Regex("""\[perf\] TOTAL calls=\d+ totalMs=(\d+)""")

  /**
   * 出厂件**确实在产**的 combo 缓存行（`combo-cache-A3` 补丁，已在快照内）：
   * `client-modules: combo cache (A3) state=loaded entries=73 hits=56 misses=0`。
   *
   * 它**不含耗时**，因此**绝不**用来产出 `t_compose_total`——把缓存规模冒充 compose 耗时正是本仓
   * 反复打击的假绿形态。它只用于 [composeProbeSource] 的**诊断分流**：让「探针完全没装」与
   * 「探针装了但只报了缓存统计」可区分，从而把门禁的拒因指向正确的层。
   */
  private val COMBO_CACHE_RE = Regex("""combo cache \(A3\) state=(\S+) entries=(\d+) hits=(\d+) misses=(\d+)""")

  /** C1：首个 HTTP 响应相对 LISTEN 的允许超出量（详档 §5.1 C1 明文要求的硬判据）。 */
  internal const val HTTP_OVER_LISTEN_BUDGET_MS = 1_000L

  @Volatile private var segBootStartMs = 0L
  @Volatile private var segListenMs = 0L
  @Volatile private var segComposeTotalMs = -1L

  /** 本次 t_compose_total 的取值口径（进判据行，可 grep；none = 探针未装）。 */
  @Volatile private var segComposeSource: String = SOURCE_NONE

  @Volatile private var segFirstHttpMs = 0L

  /** 口径标签（进判据行；none 表示「探针未装」——必须与「真实值」可区分）。 */
  private const val SOURCE_NONE = "none"
  private const val SOURCE_PRELOAD = "preload-total"
  private const val SOURCE_PRELOAD_PARTIAL = "preload-compose-only"
  private const val SOURCE_A5_LAZY = "a5-singles"
  private const val SOURCE_A3_ONLY = "a3-cache-only"

  /**
   * 测量 preload 的**逐次**打印行（`[perf] compose #N at=… dur=…`）。
   *
   * 与 `[perf] TOTAL` 分开识别是必要的：TOTAL 由 `process.on('exit')` 在**进程退出时**才输出，
   * 而 compose 行在启动期就出现。若二者混为一个标签，启动窗口内「preload 已装但 TOTAL 未到」
   * 会被报成 `none`（=「探针没装」），把拒因指向错误的一层。
   */
  private val PERF_COMPOSE_RE = Regex("""\[perf\] compose #\d+""")

  /**
   * A5 产品行的两种形态（T2 定稿口径，**逐条按行内特征字段分流**）：
   *   `[perf] boot singles=<n|n/a> records=<n>`      compose #1 之后的启动期读数（C5 反向判据）
   *   `[perf] single #<n> at=<ms>ms singles=<n|n/a>` 单条 URL 被请求（C5 正向对照）
   *
   * 这两条**证明确实有 A5 补丁在产**，但**都不含耗时**，所以只用于 [composeProbeSource] 的诊断分流，
   * 绝不参与 [parseComposeTotalMs] 的取值（否则就是拿计数冒充耗时）。
   *
   * 注意与 `[perf] compose #N …` 的区别：那是测量 preload 的逐次打印行，归 preload 口径一族
   * （由 `[perf] TOTAL` 统一识别），不得被这里误收成 A5。
   */
  private val PERF_A5_BOOT_RE = Regex("""\[perf\] boot singles=\S+""")
  private val PERF_A5_SINGLE_RE = Regex("""\[perf\] single #\d+""")

  /**
   * 引擎日志文本 → compose 耗时毫秒；**无任何口径在场时返回 null（绝不编造数值）**。纯函数。
   *
   * 口径（与 T2 定稿一致）：
   *  - `[perf] TOTAL calls=… totalMs=N`（测量 preload 的**退出汇总**；T2 起含 singles/loopP99Ms 尾字段，
   *    本正则不受影响）→ N 即 compose 累计耗时。**这是唯一能产出数值的口径**。
   *
   * 其余任何行都返回 null，**绝不编造数值**：A5 的 `singles` 与 A3 的 `entries/hits` 都是计数而非耗时，
   * 拿它们填 `t_compose_total` 就是本仓反复打击的假绿形态（缓存规模冒充 compose 耗时）。
   */
  internal fun parseComposeTotalMs(text: String): Long? {
    COMPOSE_TOTAL_RE.findAll(text).lastOrNull()?.groupValues?.get(1)?.toLongOrNull()?.let { return it }
    return null
  }

  /**
   * 纯函数：判定 compose 口径的来源标签。这是「未装探针」与「采样为 0」可区分的**判据面**
   * （-1 混过 42 个样本的教训 → 详档 §5.1 C6 要求 `t_compose_total != -1`）。
   *
   * 分流按**行内特征字段**（不用宽泛前缀，避免把 `[perf] TOTAL` 与 `[perf] boot singles=` 混为一谈）：
   *   `TOTAL calls=`        → preload-total（测量 preload 且**已有耗时值**）
   *   `compose #<n>`        → preload-compose-only（preload 已装，TOTAL 是进程退出汇总、此刻还没到）
   *   `boot singles=` /
   *   `single #<n>`         → a5-singles（A5 补丁在场，但不含耗时）
   *   `combo cache (A3)`    → a3-cache-only（A3 补丁在场，但不含耗时）
   *   全部不匹配             → none（**探针完全没装**）
   *
   * 注意：A5 的 `singles` 与 A3 的 `entries/hits` 都**不含耗时**，因此它们只用于**诊断分流**
   * （把拒因指向正确的层），绝不用来产出 `t_compose_total` 的数值。
   */
  internal fun composeProbeSource(text: String): String = when {
    COMPOSE_TOTAL_RE.containsMatchIn(text) -> SOURCE_PRELOAD
    PERF_COMPOSE_RE.containsMatchIn(text) -> SOURCE_PRELOAD_PARTIAL
    PERF_A5_BOOT_RE.containsMatchIn(text) || PERF_A5_SINGLE_RE.containsMatchIn(text) -> SOURCE_A5_LAZY
    COMBO_CACHE_RE.containsMatchIn(text) -> SOURCE_A3_ONLY
    else -> SOURCE_NONE
  }

  /**
   * 单行判据格式（纯函数）。**字段恒在场、未知一律 -1、绝不省字段**（T2 定稿口径）：
   *
   * ```
   * dsh-boot-segments t_boot_start=<epoch ms|-1> t_listen=<epoch ms|-1> t_listen_ms=<ms|-1>
   *                   t_first_http=<epoch ms|-1> t_first_http_ms=<ms|-1>
   *                   t_compose_total=<ms|-1> note=<boot-start|listen|first-http|compose-total>
   * ```
   *
   * 追加两个**纯派生诊断**字段（不影响 T2 定稿解析；`check-boot-budget.mjs` 按 `name=(-?\d+)` 取名，
   * 多字段无害）：
   *   `t_http_minus_listen_ms` 首个响应 − LISTEN（C1 硬判据的同一口径，避免门禁自行做减法产生分歧）
   *   `t_compose_source`       compose 取值口径（none / preload-total / a3-cache-only / …）
   *
   * 三字段 + first-http 恒在场使「三字段均在场」这条判据不依赖启动是否走完；`t_listen_ms` 与
   * `t_first_http_ms` 是派生等待毫秒（可直接对齐 measure-steady.ps1 的 engineListenMs），
   * 起止任一未知时为 -1（0 是「立刻应答」的合法值，不能当「未知」）。
   */
  internal fun bootSegmentsLine(
    bootStartMs: Long,
    listenMs: Long,
    composeTotalMs: Long,
    firstHttpMs: Long = 0L,
    composeSource: String = SOURCE_NONE,
  ): String {
    val start = if (bootStartMs > 0L) bootStartMs else -1L
    val listen = if (listenMs > 0L) listenMs else -1L
    val firstHttp = if (firstHttpMs > 0L) firstHttpMs else -1L
    // 单侧钳制到 0：同进程同时钟不会出现负等待，但设备墙钟被 NTP 回拨时不得输出负数。
    val waitMs = if (start > 0L && listen > 0L) (listen - start).coerceAtLeast(0L) else -1L
    val firstHttpWait = if (start > 0L && firstHttp > 0L) (firstHttp - start).coerceAtLeast(0L) else -1L
    val overListen = if (firstHttp > 0L && listen > 0L) (firstHttp - listen).coerceAtLeast(0L) else -1L
    return SEGMENT_MARK + " t_boot_start=" + start + " t_listen=" + listen +
      " t_listen_ms=" + waitMs +
      " t_first_http=" + firstHttp + " t_first_http_ms=" + firstHttpWait +
      " t_compose_total=" + composeTotalMs + " t_compose_source=" + composeSource +
      " t_http_minus_listen_ms=" + overListen
  }

  /**
   * 引擎启动请求（EngineManager.startWithArgs 的 spawn 点）：重置本世代并**立即落一行**
   * `note=boot-start`——引擎随后即使启动失败、端口从未应答，三字段也已经在判据文件里。
   */
  fun markBootStart(context: Context) {
    segBootStartMs = System.currentTimeMillis()
    segListenMs = 0L
    segComposeTotalMs = -1L
    segComposeSource = SOURCE_NONE
    segFirstHttpMs = 0L
    emitBootSegments(context, "note=boot-start")
    // （乙）解析链必须与调试日志采集器**解耦**：采集器默认关闭，旧实现把探针解析只挂在 tick()
    // 里 ⇒ 默认设备上即使探针在场也永远落不出 t_compose_total（恒 -1 的第二半成因）。这里起一条
    // 有界轻量 tail，只在本次启动窗口内观察 engine.log，绝不依赖任何用户开关。
    startProbeTail(context.applicationContext)
  }

  // ── 探针 tail（与采集器开关解耦；有界）────────────────────────────────────
  //
  // 为什么用 engine.log 而不是别处：引擎 stdout/stderr 被 EngineManager 重定向到 files/engine.log
  // （redirectErrorStream(true)），`[perf] …` 行只可能出现在那里。这里是**只读 tail**，
  // 不向 engine.log 写一个字（r10 实测教训：壳侧追加会被引擎从它自己的偏移整行覆盖）。
  //
  // 有界性：单世代最长 PROBE_WINDOW_MS、每 PROBE_POLL_MS 一读、读完 TOTAL 后再多读一轮即停；
  // 线程数恒 ≤1（同一世代的重复调用被 @Volatile 守卫），daemon，不影响进程退出。
  private const val PROBE_WINDOW_MS = 90_000L
  private const val PROBE_POLL_MS = 500L

  /** 探针 tail 的独立读偏移（**不得**复用 tick() 的 engineLogOffset，两者可同时运行）。 */
  private var probeOffset = 0L

  @Volatile private var probeTailRunning = false

  /**
   * 探针 tail 主体：把 engine.log 的新增内容喂给 [maybeEmitComposeTotal]，使 `t_compose_total`
   * 在任何设备上都能落真实值（只要引擎侧探针在场）。抽成可注入形态以便 JVM 单测覆盖「读到即落盘」
   * 与「无探针时不得编造」两条。
   */
  private fun startProbeTail(ctx: Context) {
    if (probeTailRunning) return
    probeTailRunning = true
    probeOffset = 0L
    Thread {
      try {
        val deadline = System.currentTimeMillis() + PROBE_WINDOW_MS
        var sawProbe = false
        var graceAfterProbe = 0
        while (System.currentTimeMillis() < deadline) {
          val text = readEngineLogFrom(ctx, probeThreshold = probeOffset, advanced = { probeOffset = it })
          if (text.isNotEmpty()) {
            val source = composeProbeSource(text)
            if (source != SOURCE_NONE) segComposeSource = source
            maybeEmitComposeTotal(ctx, text)
            if (source == SOURCE_PRELOAD) {
              // TOTAL 是 last-wins 汇总：见到就再多读一轮（抓同一批里的最终值）然后收工。
              sawProbe = true
            }
          }
          if (sawProbe) {
            graceAfterProbe++
            if (graceAfterProbe > 2) break
          }
          try {
            Thread.sleep(PROBE_POLL_MS)
          } catch (_: InterruptedException) {
            break
          }
        }
        // 收口落一行，把「这次到底看到了什么」写进判据文件——门禁据此判红，而不是把 -1 误判成 0。
        //
        // 两种收口严格区分（否则拒因会指错层）：
        //  - sawProbe=true（已有 TOTAL 耗时值）→ note=compose-total（值已在行内）
        //  - 只见到 A5/A3 等**不含耗时**的证据 → note=probe-no-total source=<a5-singles|a3-cache-only …>
        //    （探针装了、但没有任何口径能给出耗时）
        //  - 什么都没见到 → note=probe-absent source=none（探针完全没装）
        if (!sawProbe) {
          val note = if (segComposeSource == SOURCE_NONE) "probe-absent" else "probe-no-total"
          emitBootSegments(ctx, note + " source=" + segComposeSource)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "probe tail failed: " + (t.message ?: t.javaClass.simpleName))
      } finally {
        probeTailRunning = false
      }
    }.apply { isDaemon = true; name = "dsh-boot-probe-tail" }.start()
  }

  /**
   * 从 [probeThreshold] 起读 engine.log 增量（有界 [MAX_ENGINE_CHUNK]）。纯 IO，不碰采集器状态。
   * @param advanced 收到新偏移（调用方据此推进）
   */
  private fun readEngineLogFrom(ctx: Context, probeThreshold: Long, advanced: (Long) -> Unit): String {
    val f = File(ctx.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      RandomAccessFile(f, "r").use { raf ->
        val start = if (probeThreshold > raf.length()) 0L else probeThreshold
        raf.seek(start)
        val size = (raf.length() - start).toInt().coerceAtMost(MAX_ENGINE_CHUNK)
        if (size <= 0) return ""
        val buf = ByteArray(size)
        val n = raf.read(buf)
        advanced(raf.filePointer)
        if (n <= 0) "" else String(buf, 0, n, Charsets.UTF_8)
      }
    } catch (t: Throwable) {
      ""
    }
  }

  /**
   * **首个 HTTP 响应**（0.14.1 块F C1 的采集口径）：壳侧观察到引擎端口不仅能连、且 HTTP 真的应答了
   * 的时刻。
   *
   * 为什么与 `t_listen` 分开（C1 的判据来源）：LISTEN 只是 TCP 握手成功，而用户感知的「可对话」还要
   * 等首个 HTTP 响应——0.14.0 实测 LISTEN 2 981 ms 而 compose 5 198–7 993 ms，即**响应被 2.8 s 同步块
   * 挡在 LISTEN 之后**。只判 LISTEN 必假绿。
   *
   * 为什么这个口径今天就能产出真实值：它完全在**壳侧**可测——由壳的探活自己的时间戳定义，不依赖引擎
   * 侧任何插桩（与 t_compose_total 的困境相反）。幂等；未知时如实 -1。
   */
  fun markFirstHttp(context: Context) {
    if (segFirstHttpMs > 0L) return
    segFirstHttpMs = System.currentTimeMillis()
    emitBootSegments(context, "note=first-http")
  }

  /** C1 口径的**纯函数**判定：首个 HTTP 响应相对 LISTEN 的超出量是否在预算内。 */
  internal fun httpWithinListenBudget(firstHttpMs: Long, listenMs: Long, budgetMs: Long = HTTP_OVER_LISTEN_BUDGET_MS): Boolean =
    firstHttpMs > 0L && listenMs > 0L && (firstHttpMs - listenMs) <= budgetMs

  /**
   * Web 端口首次应答（EngineManager.watchEngineListen）：落 `note=listen` 行。幂等。
   * 非本壳发起的启动（segBootStartMs == 0，例如进程内接手已在跑的引擎）同样落盘：
   * t_boot_start 记 -1，而不是整行消失——判据是「三字段在场」，未知必须显式标注。
   */
  fun markListen(context: Context) {
    if (segListenMs > 0L) return
    segListenMs = System.currentTimeMillis()
    emitBootSegments(context, "note=listen")
  }

  /** 探针 TOTAL 出现/更新时补落一行（真实 t_compose_total）。 */
  private fun maybeEmitComposeTotal(ctx: Context, engineText: String) {
    if (segListenMs <= 0L) return
    val source = composeProbeSource(engineText)
    if (source != SOURCE_NONE) segComposeSource = source
    val total = parseComposeTotalMs(engineText) ?: return
    if (total == segComposeTotalMs) return
    segComposeTotalMs = total
    emitBootSegments(ctx, "note=compose-total")
  }

  private fun emitBootSegments(ctx: Context, note: String) {
    val line = bootSegmentsLine(segBootStartMs, segListenMs, segComposeTotalMs, segFirstHttpMs, segComposeSource) +
      " " + note
    if (executor != null) {
      try {
        appendToDayFile(ctx, line + "\n")
      } catch (t: Throwable) {
        Log.w(TAG, "boot segments day-log write failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
    appendToSegmentsFile(ctx, line)
  }

  /**
   * 追加一行到壳侧判据文件（files/boot-segments.log，O_APPEND；超限轮转一代 .1）。
   * 唯一写者就是壳自己 → 不存在「被别的进程从它自己的偏移覆盖」的窗口（engine.log 的教训）。
   */
  private fun appendToSegmentsFile(ctx: Context, line: String) {
    try {
      val f = File(ctx.filesDir, SEGMENTS_FILE)
      if (f.length() > SEGMENTS_MAX_BYTES) {
        val prev = File(ctx.filesDir, SEGMENTS_FILE + ".1")
        try { prev.delete() } catch (_: Throwable) { /* 旧代删不掉不影响本轮 */ }
        try { f.renameTo(prev) } catch (_: Throwable) { /* 轮转失败则继续追加 */ }
      }
      f.appendText(line + "\n")
    } catch (t: Throwable) {
      Log.w(TAG, "boot segments write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  // ── 块L：boot 卡住诊断落盘（壳侧可 run-as 读）──────────────────────────────
  //
  // 背景（docs/0.14.1-preview-THIRD-PARTY-PLUGIN-BOOT-AND-SCHEMA.md §2.2）：诊断屏的
  // `pendingBundles:[] badBundles:[] engineHttp:200` 与「卡住」并不矛盾——那组谓词结构上**报不出**
  // 「加载成功但插件挂住」（HTTP 200 但 fiber 停在 PENDING）。真因只能来自页面侧运行时装配状态。
  //
  // 壳侧能做的两件事（页面侧字段属 dsh-host-web-compat 的写面，见交付说明的接线清单）：
  //  1. **持久化**：把页面/壳侧给出的诊断 JSON 落 `files/boot-diag.log`，`run-as cat` 可取，
  //     不依赖调试采集器开关（那正是「现场拿不到」的一半原因）。
  //  2. **把「拿不到」显式化**：壳侧看不见页面 fiber 状态时必须写 `pageSideRuntime=unavailable`，
  //     **绝不留空数组**——空数组正是本次误导的根源（详档 §6.2 硬约束 1）。
  private const val BOOT_DIAG_FILE = "boot-diag.log"
  private const val BOOT_DIAG_MAX_BYTES = 64L * 1024

  /** 诊断标记（设备侧单条 grep）。 */
  const val BOOT_DIAG_MARK = "dsh-boot-diag"

  /** boot 卡住的壳侧判定阈值：页面超过该时长仍未就绪即记一条（与页面看门狗 40s 同量级）。 */
  internal const val BOOT_STALL_WINDOW_MS = 40_000L

  /**
   * 落一条 boot 诊断（O_APPEND + 超限轮转一代；唯一写者是壳）。
   *
   * **不做任何网络/探活**：调用方（boot 卡住看门狗）已在后台线程判定过引擎健康，这里只负责写盘，
   * 因此本函数可从任意线程调用且不引入 HTTP。
   *
   * @param source 诊断来源（`shell-stall` / `page-console` / …），进同一行便于分流
   * @param detail 已序列化的诊断载荷（JSON 或 k=v）；调用方保证不含凭据
   * @param pageSideRuntime 页面侧运行时状态（页面自报时给真值；壳侧取不到时用
   *   [PAGE_RUNTIME_UNAVAILABLE]）。默认 unavailable —— **绝不留空数组**（块L L-2：空数组
   *   正是「诊断看起来正常」误导的根源；「真值是空数组」与「取不到」必须可区分）。
   */
  fun writeBootDiag(
    context: Context,
    source: String,
    detail: String,
    pageSideRuntime: String = PAGE_RUNTIME_UNAVAILABLE,
  ) {
    val ctx = context.applicationContext
    val runtime = pageSideRuntime.replace('\n', ' ').replace('\r', ' ')
    val line = BOOT_DIAG_MARK + " source=" + source +
      " " + bootSegmentsSnapshot() +
      " pageSideRuntime=" + runtime +
      " detail=" + detail.replace('\n', ' ').replace('\r', ' ')
    try {
      val f = File(ctx.filesDir, BOOT_DIAG_FILE)
      if (f.length() > BOOT_DIAG_MAX_BYTES) {
        val prev = File(ctx.filesDir, BOOT_DIAG_FILE + ".1")
        try { prev.delete() } catch (_: Throwable) { /* 旧代删不掉不影响本轮 */ }
        try { f.renameTo(prev) } catch (_: Throwable) { /* 轮转失败则继续追加 */ }
      }
      f.appendText(line + "\n")
    } catch (t: Throwable) {
      Log.w(TAG, "boot diag write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 页面侧运行时装配状态**从壳侧不可得**时的显式标注（不得留空数组）。 */
  const val PAGE_RUNTIME_UNAVAILABLE = "unavailable"

  // ── 任务 19：启动**失败终态**落盘（files/boot-fail.log）──────────────────────
  //
  // 背景（0.14.0 用户反馈第一条【严重】，Lead 认可）：**App 启动失败时几乎不留任何诊断日志**。
  // 设备事实：2026-09-19 13:25~15:21 `files/boot-segments.log` 记 44 次 boot-start 未到 listen
  // （`t_listen=-1`），最密集连续 10 次失败；而 `logcat -b all` 覆盖该窗口却搜不到任何 App
  // 崩溃/异常，`files/engine.log` 在失败的启动里**无输出**。后果极坏：用户被一份**编造的技术
  // 诊断**误导（谎称 logcat 全是 `NoSuchMethodError: toList()`、engine.log 显示
  // `cannot resolve profile bundle dsh-live2d-pets`——实机核对均不存在），据此手工 rm 插件目录
  // 才恢复。
  //
  // **与 boot-diag.log 的职责分工（两者不得混用）**：
  //   boot-diag.log  **失败过程中的**诊断：页面卡住（L-1/L-2）、页面/壳侧 stall、页面控制台。
  //                  回答「卡在哪、页面侧看到了什么」。可能有很多条。
  //   boot-fail.log  **失败终态**：一次启动被**宣判失败**时的唯一一份现场快照（阶段 + 异常栈 +
  //                  配置指纹）。回答「为什么起不来、当时的配置是什么样」。每次失败追加一条；
  //                  健康启动**默认一条都不写**（唯一例外是显式 [writeBootFailOk]）。
  //
  // 为什么必须「接上」而不只是「有能力」（块J FIX-4 的教训）：能力在、入口无 = 未完成。
  // 故 [writeBootFail] 的调用点全部落在 `EngineStartFlow.start()` 的**失败分支**上，
  // 且有单测断言这些调用点在场（改坏即判红）。
  private const val BOOT_FAIL_FILE = "boot-fail.log"
  private const val BOOT_FAIL_MAX_BYTES = 128L * 1024
  private const val BOOT_FAIL_STACK_MAX_CHARS = 8 * 1024

  /** 启动失败诊断标记（设备侧单条 grep）。 */
  const val BOOT_FAIL_MARK = "dsh-boot-fail"

  /**
   * 落一条启动**失败终态**诊断（O_APPEND + 超限轮转一代；唯一写者是壳）。
   *
   * @param stage 失败阶段（可判别的短标识，如 `engine-start-false` / `process-died-during-boot` /
   *   `boot-budget-exceeded` / `start-flow-exception` / `snapshot-refresh-failed`）
   * @param detail 人类可读的一句话补充（不含凭据）
   * @param error 导致失败的异常（可为 null —— 多数失败分支是布尔判定而非异常）
   */
  fun writeBootFail(context: Context, stage: String, detail: String, error: Throwable? = null) {
    writeBootFailTo(context.applicationContext.filesDir, stage, detail, error, System.currentTimeMillis())
    // 失败路径必须有 Log.e（用户反馈第 5 项：logcat 里连一行都没有）。
    Log.e(TAG, "boot failed: stage=" + stage + " detail=" + detail, error)
  }

  /**
   * [writeBootFail] 的无 Context 核心（便于 JVM 单测直接打真实文件）。
   *
   * 为什么要拆：单测不该为了写一个文件去伪造 `Context`（本项目测试面**没有 Mockito**，
   * 且 `Context` 是抽象类无法直接实例化）。把「组装行 + 有界落盘」抽成只依赖 `File` 的纯函数，
   * 单测就能用 `TemporaryFolder` 覆盖真实字节，而不是断言源码文本。
   *
   * @param filesDir 应用私有目录（生产传 `context.applicationContext.filesDir`）
   * @param nowMs 时间戳（单测可注入固定值）
   */
  internal fun writeBootFailTo(
    filesDir: File,
    stage: String,
    detail: String,
    error: Throwable?,
    nowMs: Long,
  ) {
    appendBounded(filesDir, BOOT_FAIL_FILE, bootFailLine(filesDir, stage, detail, error, nowMs), BOOT_FAIL_MAX_BYTES)
  }

  /**
   * 组装一条失败终态诊断行（纯函数，无 IO）。
   *
   * 行格式（设备侧单条 grep `dsh-boot-fail`）：
   * ```
   * dsh-boot-fail stage=<阶段> at=<epoch ms> <dsh-boot-segments 快照> fingerprint=<配置指纹>
   *               error=<异常类名|none(boolean-failure-path)> stack=<折叠后的栈|none> detail=<已折叠>
   * ```
   * 恒为**单行**：栈与 detail 里的换行一律折成 `|` / 空格——落盘语义是「一行 = 一次失败」，
   * 未折叠的换行会把一条诊断劈成多条、破坏设备侧 grep 与解析。
   *
   * @param filesDir 用于取配置指纹
   * @param nowMs 时间戳
   * @return 完整的单行诊断（不含行尾换行）
   */
  internal fun bootFailLine(
    filesDir: File,
    stage: String,
    detail: String,
    error: Throwable?,
    nowMs: Long,
  ): String {
    val sb = StringBuilder()
    sb.append(BOOT_FAIL_MARK)
      .append(" stage=").append(stage)
      .append(" at=").append(nowMs)
      .append(" ").append(bootSegmentsSnapshot())
      .append(" fingerprint=").append(bootConfigFingerprint(filesDir))
    if (error != null) {
      // 异常类名 + 栈：用户反馈的核心诉求就是「有没有栈可读」。栈必须有界（单条不得爆文件）。
      sb.append(" error=").append(error.javaClass.name)
      val stack = try {
        val sw = java.io.StringWriter()
        error.printStackTrace(java.io.PrintWriter(sw))
        sw.toString()
      } catch (_: Throwable) { "" }
      sb.append(" stack=").append(stack.replace('\n', '|').replace('\r', '|').take(BOOT_FAIL_STACK_MAX_CHARS))
    } else {
      // 显式标注「本次失败无可读异常」——绝不留空（空字段会让读的人以为漏采）。
      sb.append(" error=none(boolean-failure-path) stack=none")
    }
    sb.append(" detail=").append(detail.replace('\n', ' ').replace('\r', ' '))
    return sb.toString()
  }

  /**
   * 健康启动的**可选** ok 标记（`stage=ok`）：只在显式调用时写，用于设备侧确认「采集器接上了、
   * 且这次确实没失败」。**默认不写**——boot-fail.log 的主体语义是失败终态，让健康启动也写会让
   * 「文件非空 = 出过故障」这条最简单的判据失效。
   */
  fun writeBootFailOk(context: Context, detail: String) {
    writeBootFailOkTo(context.applicationContext.filesDir, detail)
  }

  /** [writeBootFailOk] 的无 Context 核心（JVM 单测用；理由同 [writeBootFailTo]）。 */
  internal fun writeBootFailOkTo(filesDir: File, detail: String) {
    appendBounded(
      filesDir, BOOT_FAIL_FILE,
      BOOT_FAIL_MARK + " stage=ok at=" + System.currentTimeMillis() +
        " " + bootSegmentsSnapshot() +
        " fingerprint=" + bootConfigFingerprint(filesDir) +
        " error=none stack=none detail=" + detail.replace('\n', ' ').replace('\r', ' '),
      BOOT_FAIL_MAX_BYTES,
    )
  }

  /**
   * 当时配置指纹（纯读，绝不写、绝不改运行时）：回答「失败那一刻的配置是什么样」——
   * 用户被编造诊断误导时，最缺的正是「配置到底改了没有」的可核对事实。
   *
   * 组成全部是**存在性/摘要**，不含插件内容（不把敏感配置写进日志）：
   *  - `snapshot`：`.snapshot-fingerprint` 内容（快照版本指纹）
   *  - `vcode`：本 APK versionCode
   *  - `transaction`：`.snapshot-transaction` 是否残留（残留 = 上次刷新中断，正是「启动起不来」的已知成因）
   *  - `patchRepair` / `home`：补丁修复 marker 与 `files/home` 是否就位（快照解压标志）
   *  - `engineLog`：引擎日志的在场/大小（失败启动里它常为 absent，这本身就是判据）
   *
   * 任一取不到写 `na`，**绝不留空**（空字段正是「看起来正常」误导的同一族形态）。
   */
  internal fun bootConfigFingerprint(files: File): String {
    val snap = readTrimmed(File(files, ".snapshot-fingerprint")) ?: "na"
    val tx = if (File(files, ".snapshot-transaction").exists()) "present" else "absent"
    val repair = if (File(files, ".profile-patch-repair-" + BuildConfig.VERSION_NAME).exists()) "present" else "absent"
    val home = if (File(files, "home").isDirectory) "present" else "absent"
    val engineLog = File(files, "engine.log")
    val engineLogState = when {
      !engineLog.exists() -> "absent"
      engineLog.length() == 0L -> "empty"
      else -> "bytes=" + engineLog.length()
    }
    return "snapshot=" + snap + ",vcode=" + BuildConfig.VERSION_CODE +
      ",transaction=" + tx + ",patchRepair=" + repair + ",home=" + home +
      ",engineLog=" + engineLogState
  }

  /** 读一个小文本文件并 trim；不存在/读失败返回 null（指纹面必须 fail-soft，绝不抛）。 */
  private fun readTrimmed(f: File): String? = try {
    if (f.isFile) f.readText().trim().ifEmpty { null } else null
  } catch (_: Throwable) {
    null
  }

  /**
   * 引擎日志世代状态（任务 19 要求排查的「为什么失败的启动连 engine.log 都没输出」）。
   *
   * 结论（源码级确证，非猜测）：引擎子进程的 stdout 与 stderr **没有被丢弃** ——
   * `EngineManager.startWithArgs` 用 `redirectErrorStream(true)` 合并两者，再
   * `redirectOutput(engine.log)` 落进同一个文件（EngineManager.kt:865-866）。
   * 因此「engine.log 无输出」只可能是这三种成因之一，本函数把它们区分开：
   *   `absent`            → spawn 从未成功（进程根本没起来）；
   *   `empty`             → 进程起来了但一句没写就退出（native 崩溃 / 缺 so / 动态链接失败）；
   *   `bytes=N`           → 有输出（此时「看不到」的成因多半是轮转：本次输出在 engine.log.1..5）；
   *   `gen1=…,gen2=…`     → 各轮转世代的大小（rotateEngineLog 保留 5 代，外壳读错世代会误判「无输出」）。
   *
   * 该字段直接进 boot-fail 的 detail，使「日志到底在不在」成为可核对的判据，而不是要靠猜。
   *
   * **另附 engine.log 的「非空首行」（task-18 根因结论的直接落点）**：实测失败 B（13:25~15:21 的
   * 44 次 `t_listen=-1`）里 engine.log 是 50 行、6 个世代逐字节相同，首行即是**定性那一行**：
   * `Error: dsh: plugin tree failed to load: … failed to import loader entry live2d-pet
   * (dsh-live2d-pets): The requested module '@deepseek-ai/dsh-settings' does not provide an export
   * named 'settingsNamespace'` —— 用户自装第三方插件 import 期抛错 → 引擎 boot 失败 → 进程 exit=1
   * → 永不 listen。这一行比整份 logcat 有效得多（用户反馈称「logcat 0 命中」，而真因在 engine.log）。
   * 故把首行折叠进本条诊断：**boot-fail.log 一行即可定性**，不必再让用户去别处找。
   */
  internal fun describeEngineLogState(filesDir: File): String {
    val base = File(filesDir, "engine.log")
    val state = when {
      !base.exists() -> "absent"
      base.length() == 0L -> "empty"
      else -> "bytes=" + base.length()
    }
    val gens = (1..5).map { i ->
      val f = File(filesDir, "engine.log.$i")
      if (f.exists()) "gen$i=" + f.length() else "gen$i=absent"
    }.joinToString(",")
    // 非空首行 = 一次失败最有效的定性证据（见上方注释）。有界 + 折叠 + 脱敏（内含 launch token）。
    //
    // 三态必须分开（0.14.1 单测实测抓出的缺陷）：文件**不存在** / **全空行** 都不是「读不出来」，
    // 不能都报 unreadable —— 旧实现无条件 `base.useLines{}`，对不存在的文件抛 FileNotFoundException
    // 被 catch 成 "unreadable"，于是「本次启动根本没生成 engine.log」被误报成「日志存在但读不了」，
    // 而这两者对排障的含义完全相反（前者=引擎没起来，后者=权限/损坏/编码问题）。故先按 state 分流：
    //   absent / empty      -> firstLine=none（如实：没有可读的首行）
    //   存在且非空但读取抛错 -> firstLine=unreadable（真·读不出来）
    val firstLine = when (state) {
      "absent", "empty" -> "none"
      else -> try {
        base.useLines { seq ->
          seq.firstOrNull { it.isNotBlank() }?.let { EngineAuth.redact(it).replace('\n', ' ').take(600) }
        } ?: "none"
      } catch (_: Throwable) {
        "unreadable"
      }
    }
    return "engineLog=" + state + "," + gens + ",firstLine=" + firstLine
  }

  /** 有界追加 + 超限轮转一代（boot-diag / boot-fail 共用形态；唯一写者是壳）。 */
  private fun appendBounded(ctx: Context, name: String, line: String, maxBytes: Long) =
    appendBounded(ctx.applicationContext.filesDir, name, line, maxBytes)

  /** [appendBounded] 的 File 版（供 [writeBootFailTo] 的无 Context 路径复用）。 */
  private fun appendBounded(filesDir: File, name: String, line: String, maxBytes: Long) {
    try {
      val f = File(filesDir, name)
      if (f.length() > maxBytes) {
        val prev = File(filesDir, name + ".1")
        try { prev.delete() } catch (_: Throwable) { /* 旧代删不掉不影响本轮 */ }
        try { f.renameTo(prev) } catch (_: Throwable) { /* 轮转失败则继续追加 */ }
      }
      f.appendText(line + "\n")
    } catch (t: Throwable) {
      Log.w(TAG, "diag write failed (" + name + "): " + (t.message ?: t.javaClass.simpleName))
    }
  }

  // ── 块L L-2：页面控制台行的壳侧消费者（0.14.1）──────────────────────────────
  //
  // 缺陷（gatewire 复核 + 设备实测）：页面侧 `dsh-host-web-compat/lib/index.js` 早已把诊断行
  // `console.error('[dsh-boot-stall] dsh-boot-diag source=page-stall ...')` 打出来，并自述
  // 「壳侧 onConsoleMessage 抓这一条」——但**全壳 `onConsoleMessage` 零实现**，
  // 于是 `files/boot-diag.log` 里 `source=page-console` 恒 0 行、`pageSideRuntime` 恒
  // `unavailable`：那是**永远不可得**，不是「当前不可得」。跨层契约断在壳侧。
  //
  // 为什么选 onConsoleMessage 而不是 evaluateJavascript 轮询：
  //  - 事件驱动、零轮询开销，且**只在页面真的打印时**才落盘（不需要壳侧猜何时去取）；
  //  - 行本身是页面侧已经「折叠成单行」的 k=v 文本，壳侧只需按前缀分流，不需要再序列化 JSON
  //    （evaluateJavascript 取回的是对象，还得再折叠一次，多一处两侧格式对不上的机会）；
  //  - 不需要在主线程外发起 evaluateJavascript 的调度与回调编排。
  //  代价：依赖 WebView 把 console 消息回传（ChromeClient 默认不上报，故必须覆写）。
  //  兜底：`__dshBootStallReport` 仍由页面侧赋值（唯一发布点），壳侧若日后需要主动取样可另加，
  //  但当下不引入第二条通道（两条通道 = 两处格式漂移源）。
  //
  // 前缀契约（与页面侧 BOOT_STALL_PREFIX / BOOT_READY_PREFIX 逐字对应，改动须两侧同步）。
  const val PAGE_STALL_PREFIX = "[dsh-boot-stall]"
  /** 页面**就绪**前缀（L-1 的判据来源）：页面首次 rendered() 为真时报一条。 */
  const val PAGE_READY_PREFIX = "[dsh-boot-ready]"

  /** 页面控制台行的分流结果（`null` = 与本插件无关，直接透传原日志行为）。 */
  internal data class PageConsoleRoute(val source: String, val detail: String)

  /**
   * 把一条页面 console 行分流成 boot 诊断（纯函数，可离线单测）。
   *
   * 命中 `[dsh-boot-stall]` → `page-stall`（页面自报卡住：带 pendingEntries/failedEntries/
   * graphLoaded/waitingForMs 四字段）；命中 `[dsh-boot-ready]` → `page-ready`（页面已渲染，
   * L-1 据此**停止** stall 计时）。两者都进 `source=page-console` 家族——用 source 值区分
   * 具体来源，与 `shell-stall`（壳侧判定）分列，便于设备侧分流 grep。
   *
   * @param message 页面 console 原文（可能含换行，本函数只做前缀判定与折叠）
   * @return 命中时的 (source, detail)；未命中返回 null
   */
  internal fun routePageConsole(message: String): PageConsoleRoute? {
    val text = message ?: return null
    val folded = text.replace('\n', ' ').replace('\r', ' ').trim()
    if (folded.startsWith(PAGE_STALL_PREFIX)) return PageConsoleRoute("page-console", folded)
    if (folded.startsWith(PAGE_READY_PREFIX)) return PageConsoleRoute("page-console", folded)
    return null
  }

  /** 该页面控制台行是否表示「页面已就绪」（L-1 的判据）。 */
  internal fun isPageReadyMessage(message: String): Boolean =
    (message ?: "").trimStart().startsWith(PAGE_READY_PREFIX)

  /** 该页面控制台行是否表示「页面自报卡住」（L-2 的诊断载荷）。 */
  internal fun isPageStallMessage(message: String): Boolean =
    (message ?: "").trimStart().startsWith(PAGE_STALL_PREFIX)

  /** 当前分段判据快照（诊断行/自检面共用；未知一律 -1）。 */
  internal fun bootSegmentsSnapshot(): String =
    bootSegmentsLine(segBootStartMs, segListenMs, segComposeTotalMs, segFirstHttpMs, segComposeSource)

  /**
   * Write shell events directly (no logcat dependency — on MuMu/Android 15 logd blocks logcat reads
   * for non-privileged apps even with a matching --pid). Persisted only while the collector runs;
   * key events (engine start/stop, crash marker, restarts) are written here as they occur.
   * 0.13.8 #174：写盘移交 logExecutor（调用方立即返回）；时间戳在入队时刻取，保序 FIFO。
   */
  fun log(tag: String, message: String) {
    val ctx = appContext ?: return
    val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
    logExecutor.execute {
      try {
        appendToDayFile(ctx, "$ts $tag: $message\n")
      } catch (t: Throwable) {
        Log.w(TAG, "event log write failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
  }

  /** Current log directory (falls back to private filesDir/log without the public-dir grant). */
  fun currentDir(context: Context): File {
    val base = if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
      val docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        ?: File(context.filesDir, "dshdata-fallback")
      File(File(docs, "dshdata"), "log")
    } else {
      File(context.filesDir, "log")
    }
    base.mkdirs()
    return base
  }

  private fun tick() {
    val ctx = appContext ?: return
    try {
      val sb = StringBuilder()
      sb.append(readLogcat())
      val engineText = readEngineLog(ctx)
      sb.append(engineText)
      // P-AC-04：探针口径一到就补落真实 t_compose_total（落壳侧判据文件，绝不写 engine.log）。
      maybeEmitComposeTotal(ctx, engineText)
      if (sb.isEmpty()) return
      appendToDayFile(ctx, sb.toString())
    } catch (t: Throwable) {
      Log.w(TAG, "collect tick failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /**
   * Incremental logcat: on Android 13+/MuMu logd only releases the calling process's own logs
   * (run-as with the same uid can't read them either) — pass --pid=<shell process> explicitly;
   * engine logs are covered by the engine.log incremental tail (engine stdout is redirected),
   * so the two sources complement each other.
   */
  private fun readLogcat(): String {
    return try {
      val proc = ProcessBuilder(
        "/system/bin/logcat", "-d", "-v", "threadtime",
        "--pid=" + android.os.Process.myPid(),
      ).start()
      // FX-211.3 / FX-208.3：原先裸 bufferedReader() 后直接 readText()（无 .use）无上限、
      // 读到 EOF 才返回——logcat -d 在重日志设备上可达数十 MB（采集线程卡死 + OOM），
      // 正是 check-bounded-io 旧正则漏掉的形态。统一经 ProcIo.readBounded：
      // 并发排水 + 10s 有界等待 + 1 MiB 上限（超限带截断标注）。
      val out = ProcIo.readBounded(proc, 10).text
      val sb = StringBuilder()
      var lastTs = lastLogcatTs
      for (line in out.lineSequence()) {
        val ts = line.take(18)
        if (ts.length == 18 && ts[2] == '-' && ts[8] == ' ' && ts >= lastLogcatTs) {
          sb.append(line).append('\n')
          lastTs = ts
        }
      }
      lastLogcatTs = lastTs
      sb.toString()
    } catch (t: Throwable) {
      Log.w(TAG, "logcat read failed: " + (t.message ?: t.javaClass.simpleName))
      ""
    }
  }

  /** Incremental engine.log tail (the engine stdout redirection file). */
  private fun readEngineLog(ctx: Context): String {
    val f = File(ctx.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      RandomAccessFile(f, "r").use { raf ->
        if (engineLogOffset > raf.length()) engineLogOffset = 0 // file was rotated/truncated
        raf.seek(engineLogOffset)
        val size = (raf.length() - engineLogOffset).toInt().coerceAtMost(MAX_ENGINE_CHUNK)
        val buf = ByteArray(size)
        val n = raf.read(buf)
        engineLogOffset = raf.filePointer
        if (n <= 0) "" else String(buf, 0, n, Charsets.UTF_8)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "engine.log tail failed: " + (t.message ?: t.javaClass.simpleName))
      ""
    }
  }

  /** Daily rotation: dsh-<date>.log, rotating to dsh-<date>.1.log when over the size limit.
   *  出口脱敏（0.13.8 #184）：本函数是所有日志落盘（事件/logcat/engine.log 尾巴）的唯一
   *  咽喉，写前过 EngineAuth.redact——engine.log 本体不动（鉴权链依赖），脱敏只作用于这份副本。 */
  private fun appendToDayFile(ctx: Context, text: String) {
    val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
    val dir = currentDir(ctx)
    val safe = EngineAuth.redact(text)
    val file = File(dir, "dsh-$day.log")
    if (file.exists() && file.length() > MAX_FILE_BYTES) {
      rotateDayFile(file, File(dir, "dsh-$day.1.log"), File(dir, "dsh-$day.2.log"))
    }
    file.appendText(safe)
  }

  /**
   * 轮转（#211.3，JVM 单测；rename/delete 可注入）：
   * 1. 上一代 .1.log 先让位到 .2.log（rename **成功**才继续）；
   * 2. 主文件 rename 到 .1.log；
   * 3. **只有上一步 rename 成功之后**才删除 .2.log。
   *
   * 旧实现「先 delete(.1) 再 renameTo(.1) 且忽略返回值」在主文件被占用/跨挂载点时
   * 先毁掉唯一旧副本、再静默失败——日志断代且无痕迹。任何一步失败都保留既有文件
   * （主文件继续 append，日志不丢）。
   *
   * @return true = 本次轮转成功（调用方随后新建同名主文件继续写）。
   */
  internal fun rotateDayFile(
    file: File,
    rotated: File,
    superseded: File,
    rename: (File, File) -> Boolean = { a, b -> a.renameTo(b) },
    deleteFile: (File) -> Boolean = { it.delete() },
  ): Boolean {
    if (rotated.exists()) {
      // .2 是更早的一代（纯冗余），先腾位；失败也不动 .1 的唯一副本。
      if (superseded.exists() && !deleteFile(superseded)) {
        Log.w(TAG, "log rotation skipped: superseded generation could not be cleared (" + superseded.name + ")")
        return false
      }
      if (!rename(rotated, superseded)) {
        Log.w(TAG, "log rotation skipped: previous rotation could not be moved aside (" + rotated.name + " kept)")
        return false
      }
    }
    if (!rename(file, rotated)) {
      Log.w(TAG, "log rotation failed: rename " + file.name + " -> " + rotated.name + " (existing files kept)")
      return false
    }
    // rename 已成功：此刻才收掉更早的一代（失败只留冗余文件，不影响本次轮转）。
    if (superseded.exists()) deleteFile(superseded)
    return true
  }
}
