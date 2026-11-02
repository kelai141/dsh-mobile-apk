package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 冷启动**细分段**耗时埋点（性能审计 2026-11-02 的 #6 项）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────────
 * 本仓对 onCreate 主线程、WebView 构造、快照解压、引擎 loader-settle 四段
 * **完全没有埋点**。既有 LogCollector 的 boot-segments.log 只覆盖引擎侧四个时刻
 * （t_boot_start / t_listen / t_compose_total / t_first_http），回答不了「首帧之前那段时间
 * 花在哪」。而没有分段数据，任何「提升启动速度」的改动都是盲猜。
 *
 * ── 为什么是独立模块而不是塞进 LogCollector ──────────────────────────────────
 * LogCollector.emitBootSegments 每次冷启动都写、**不受任何开关约束**（它是判据面）。
 * 本模块的四个分段是**诊断用的附加量**，按用户拍板的口径必须落在**开发者调试开关之后**
 * （MainActivity.DevLogPrefs，默认 false）：发布包默认零写入、零额外 IO。
 * 把两者物理隔离，才能保证「动这个文件不可能影响既有常开判据行」。
 *
 * ── 有界性 ───────────────────────────────────────────────────────────────────
 * 开关关闭时 enabled() 只读一次已缓存的偏好，**不碰磁盘**，且不分配任何对象。
 * 开关打开时单次启动最多写 [MAX_LINES_PER_BOOT] 行（每段一行），文件超
 * [MAX_BYTES] 轮转一代 .1。无后台线程、无定时器、无队列。
 * 分段可能从主线程 / engine-start 线程 / probe tail 线程写入，故用 ConcurrentHashMap
 * 做幂等覆盖，不依赖调用顺序。
 */
internal object BootPhaseTrace {

  private const val TAG = "dsh-boot-phase"
  private const val FILE_NAME = "boot-phase-trace.log"

  /** 单文件上限：每行 <200 B、单次启动 <=4 行，64 KiB 足够容纳上千次启动。 */
  private const val MAX_BYTES = 64L * 1024

  /** 单次启动最多落盘行数（一个分段一行；重复 mark 只保留首个时刻）。 */
  private const val MAX_LINES_PER_BOOT = 4

  /** 分段名。取值刻意保持短且稳定，便于单条 grep 命中。 */
  const val ON_CREATE = "onCreate"
  const val WEBVIEW_CONSTRUCT = "webviewConstruct"
  const val SNAPSHOT_EXTRACT = "snapshotExtract"
  const val LOADER_SETTLE = "loaderSettle"

  /** 本次启动的基准时刻（单调时钟，不受墙钟调整影响）。 */
  @Volatile private var baseMs: Long = 0L

  /** 已落盘的分段（幂等：同名分段只记首次）。 */
  private val emitted = ConcurrentHashMap<String, Long>()

  /**
   * 开关缓存。null = 尚未读取。
   *
   * 为什么缓存：onCreate 里 mark() 会被调用多次，每次都读一次 SharedPreferences
   * 在主线程上是纯浪费。偏好只在用户手动切换时变，本进程内不重复读是正确取舍
   * （用户切开关后，下一次冷启动才生效，符合「诊断用」的定位）。
   */
  @Volatile private var enabledCache: Boolean? = null

  /** 是否启用。任何异常一律视为关闭——埋点绝不能影响启动。 */
  internal fun enabled(context: Context): Boolean {
    enabledCache?.let { return it }
    val value = try {
      MainActivity.DevLogPrefs.isEnabled(context)
    } catch (_: Throwable) {
      false
    }
    enabledCache = value
    return value
  }

  /** 仅供测试复位（偏好可能在同进程内被改）。 */
  internal fun resetForTest() {
    enabledCache = null
    baseMs = 0L
    emitted.clear()
  }

  /** 启动基准：onCreate 入口调用一次（幂等；关闭时不取时刻、不分配）。 */
  fun markBootBase(context: Context) {
    if (baseMs != 0L) return
    if (!enabled(context)) return
    baseMs = SystemClockElapsed.elapsedRealtime()
  }

  /**
   * 记一个分段。首个同名调用生效（后续重复调用被忽略，保证「首帧之前」的语义不被覆盖）。
   *
   * @param note 可选的附加事实（例如 bytes=750434969），不得含换行。
   */
  fun mark(context: Context, name: String, note: String? = null) {
    if (!enabled(context)) return
    if (baseMs == 0L) baseMs = SystemClockElapsed.elapsedRealtime()
    val at = SystemClockElapsed.elapsedRealtime()
    if (emitted.putIfAbsent(name, at - baseMs) != null) return
    if (emitted.size > MAX_LINES_PER_BOOT) return
    append(context, name, at - baseMs, note)
  }

  /** 已记录的分段数（测试/诊断用）。 */
  internal fun emittedCount(): Int = emitted.size

  /** 落盘：一行 = dsh-boot-phase phase=<name> at=<ms>ms (<note>)。 */
  private fun append(context: Context, name: String, atMs: Long, note: String?) {
    val line = "dsh-boot-phase phase=" + name + " at=" + atMs + "ms" + (if (note != null) " " + note else "")
    try {
      val f = File(context.filesDir, FILE_NAME)
      if (f.length() > MAX_BYTES) {
        val prev = File(context.filesDir, FILE_NAME + ".1")
        try { prev.delete() } catch (_: Throwable) { }
        try { f.renameTo(prev) } catch (_: Throwable) { }
      }
      f.appendText(line + "\n")
    } catch (t: Throwable) {
      // 埋点失败绝不影响启动：只记 logcat，不抛出、不重试。
      Log.w(TAG, "boot phase trace write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }
}

/**
 * SystemClock.elapsedRealtime() 的薄封装。
 *
 * 为什么要包一层：BootPhaseTrace 是 object，纯 JVM 单测直接引 android.os.SystemClock
 * 会要求 Robolectric/仪器环境；包成可替换的点后，JVM 单测能验「相对时刻 + 幂等 + 行格式」。
 */
internal object SystemClockElapsed {
  @Volatile private var fixed: Long? = null

  fun elapsedRealtime(): Long = fixed ?: android.os.SystemClock.elapsedRealtime()

  /** 仅供单测注入固定时钟。 */
  internal fun setForTest(value: Long?) { fixed = value }
}
