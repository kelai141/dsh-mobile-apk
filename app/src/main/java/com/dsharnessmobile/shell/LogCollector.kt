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

  /** 探针口径：`[perf] TOTAL calls=2 totalMs=1234 instances=1 firstAt=…ms`（count-compose.mjs:36）。 */
  private val COMPOSE_TOTAL_RE = Regex("""\[perf\] TOTAL calls=\d+ totalMs=(\d+)""")

  @Volatile private var segBootStartMs = 0L
  @Volatile private var segListenMs = 0L
  @Volatile private var segComposeTotalMs = -1L

  /** 引擎日志文本 → compose 累计毫秒（取最后一条 TOTAL；无探针输出返回 null）。纯函数。 */
  internal fun parseComposeTotalMs(text: String): Long? =
    COMPOSE_TOTAL_RE.findAll(text).lastOrNull()?.groupValues?.get(1)?.toLongOrNull()

  /**
   * 三字段单行格式（纯函数）。三字段**恒在场**（未知一律 -1），所以「三字段均在场」这条判据
   * 不依赖启动是否走完；`t_listen_ms` 是派生等待毫秒（可直接对齐 measure-steady.ps1 的
   * engineListenMs），起止任一未知时为 -1（0 是「立刻应答」的合法值，不能当「未知」）。
   */
  internal fun bootSegmentsLine(bootStartMs: Long, listenMs: Long, composeTotalMs: Long): String {
    val start = if (bootStartMs > 0L) bootStartMs else -1L
    val listen = if (listenMs > 0L) listenMs else -1L
    // 单侧钳制到 0：同进程同时钟不会出现负等待，但设备墙钟被 NTP 回拨时不得输出负数。
    val waitMs = if (start > 0L && listen > 0L) (listen - start).coerceAtLeast(0L) else -1L
    return SEGMENT_MARK + " t_boot_start=" + start + " t_listen=" + listen +
      " t_listen_ms=" + waitMs + " t_compose_total=" + composeTotalMs
  }

  /**
   * 引擎启动请求（EngineManager.startWithArgs 的 spawn 点）：重置本世代并**立即落一行**
   * `note=boot-start`——引擎随后即使启动失败、端口从未应答，三字段也已经在判据文件里。
   */
  fun markBootStart(context: Context) {
    segBootStartMs = System.currentTimeMillis()
    segListenMs = 0L
    segComposeTotalMs = -1L
    emitBootSegments(context, "note=boot-start")
  }

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
    val total = parseComposeTotalMs(engineText) ?: return
    if (total == segComposeTotalMs) return
    segComposeTotalMs = total
    emitBootSegments(ctx, "note=compose-total")
  }

  private fun emitBootSegments(ctx: Context, note: String) {
    val line = bootSegmentsLine(segBootStartMs, segListenMs, segComposeTotalMs) + " " + note
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
