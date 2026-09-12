package com.dsharnessmobile.shell

import android.app.ActivityManager
import android.content.Context
import android.os.FileObserver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * 通知信道消费（0.14.0-preview §6.2.1 / NT-04、NT-07、NT-08）：
 * FileObserver 监听 home/.dsh/.notify.ndjson → 逐行解析 → NotifyCenter 分流（替代 5s 轮询）。
 *
 * 三条实现约束（每条都对着一个既存缺陷）：
 *  1. **偏移按字节消费**（NT-08）：只推进到最后一个完整行的换行符之后，未消费的半行/截断多字节
 *     留到下一轮——旧实现 readLines() + writeText("") 在「读后写前」追加的行会丢。
 *  2. **偏移持久化在 prefs**（不用清空文件）：引擎是唯一的 append 写者，壳侧只读不截断，
 *     没有「读-清窗口」竞态；引擎超过 512KB 时轮转 .1，壳侧检测到 len < offset 即复位并从
 *     .1 残段补读（尽力而为，日志记录）。
 *  3. **双读不双发**（NT-09）：本文件一旦有 report/silent 行被消费，NotifyStore.notifyChannelActive
 *     置位；此后旧信道 .task-done.ndjson 只做回退（legacyFallback 返回 false 并记日志）。
 */
object NotifyStore {

  const val TAG = "dsh-notify"
  const val FILE_NAME = ".notify.ndjson"
  const val LEGACY_FILE = ".task-done.ndjson"
  const val ROTATED_NAME = ".notify.ndjson.1"

  /** 单次 drain 读取上限（与 OverlayLiveFeed 同口径；溢出部分留到下一轮，不跳行）。 */
  const val READ_CAP_BYTES = 256 * 1024

  private const val KEY_OFFSET = "notify.offset"

  @Volatile
  private var started = false
  private var watcher: FileObserver? = null

  /** 新信道是否已在服役（决定旧信道是否只做回退）。 */
  @Volatile
  var notifyChannelActive = false
    private set

  /** 最近一次消费的观测（NT-07 延迟打点 / NT-04 端到端记录）。 */
  @Volatile
  var lastEntryAt: Long = 0L
    private set

  fun dir(context: Context): File = File(context.filesDir, "home/.dsh")

  fun file(context: Context): File = File(dir(context), FILE_NAME)

  fun legacyFile(context: Context): File = File(dir(context), LEGACY_FILE)

  /** 幂等启动（进程级；EngineService / OverlayService / 动作冷启动任一路径先到即赢）。 */
  @Synchronized
  fun start(context: Context) {
    if (started) return
    started = true
    val app = context.applicationContext
    val d = dir(app)
    if (!d.exists()) d.mkdirs()
    try {
      watcher = object : FileObserver(d.absolutePath, FileObserver.MODIFY or FileObserver.CREATE) {
        override fun onEvent(event: Int, path: String?) {
          if (path == FILE_NAME) drain(app)
        }
      }.apply { startWatching() }
    } catch (t: Throwable) {
      LogCollector.log(TAG, "notify watcher failed: " + t.message)
    }
    // 启动即消费一次（进程离线期间的积压行：偏移持久化保证不重复投递）
    drain(app)
  }

  @Synchronized
  fun stop() {
    try { watcher?.stopWatching() } catch (_: Throwable) {}
    watcher = null
    started = false
  }

  /** 应用是否在前台（弹窗类的「前台抑制」判据；WebView 可见性由调用方补判）。 */
  fun isForeground(context: Context): Boolean {
    return try {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val info = am.runningAppProcesses?.firstOrNull { it.processName == context.packageName }
      info != null && info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    } catch (_: Throwable) {
      false
    }
  }

  // ── 纯逻辑：字节级 drain（NT-08 的核心，JVM 单测覆盖）──────────────────

  /** drain 结果：[lines] 已完整到达的行；[consumed] 本次可推进的字节数（到最后一个换行符）。 */
  data class DrainResult(val lines: List<String>, val consumed: Long)

  /**
   * 从一个读取块里取出完整行。**只消费到最后一个换行符**——没有换行（半行）时 consumed=0，
   * 多字节被截断的尾部字符随「下次补齐」自然消失，不产生乱码也不丢行。
   */
  fun drainBytes(buf: ByteArray, len: Int): DrainResult {
    val n = len.coerceAtMost(buf.size)
    var last = -1
    var i = n - 1
    while (i >= 0) {
      if (buf[i] == '\n'.code.toByte()) { last = i; break }
      i--
    }
    if (last < 0) return DrainResult(emptyList(), 0)
    val text = String(buf, 0, last, Charsets.UTF_8)
    val lines = ArrayList<String>()
    for (piece in text.split("\n")) {
      val t = piece.trim()
      if (t.isNotEmpty()) lines.add(t)
    }
    return DrainResult(lines, (last + 1).toLong())
  }

  /** 一行 JSON → 通知条目；解析失败 / 缺 kind 返回 null（调用方记日志，不崩）。 */
  fun parseEntry(line: String): NotifyEntry? {
    val j = try { JSONObject(line) } catch (_: Exception) { return null }
    val kind = j.optString("kind").lowercase()
    if (kind.isEmpty()) return null
    val presented = ArrayList<String>()
    j.optJSONArray("presentedFiles")?.let { arr ->
      for (k in 0 until arr.length()) {
        val v = arr.optString(k, "")
        if (v.isNotEmpty()) presented.add(v)
      }
    }
    return NotifyEntry(
      kind = kind,
      title = j.optString("title", ""),
      text = j.optString("text", ""),
      event = j.optString("event", ""),
      dedupeKey = j.optString("dedupeKey", ""),
      sessionId = j.optString("sessionId", ""),
      eventId = j.optString("eventId", ""),
      count = j.optInt("count", 1),
      done = j.optInt("done", 0),
      total = j.optInt("total", 0),
      current = j.optString("current", ""),
      outcome = j.optString("outcome", ""),
      outcomeLabel = j.optString("outcomeLabel", ""),
      summary = j.optString("summary", ""),
      durationMs = j.optLong("durationMs", 0L),
      durationLabel = j.optString("durationLabel", ""),
      toolCount = j.optInt("toolCount", 0),
      turn = j.optInt("turn", 0),
      presentedFiles = presented,
      popup = j.optBoolean("popup", true),
      toolName = j.optString("toolName", ""),
      reason = j.optString("reason", ""),
      questions = parseQuestions(j.optJSONArray("questions")),
      target = j.optString("target", "").ifBlank { null },
    )
  }

  private fun parseQuestions(arr: JSONArray?): List<NotifyQuestion> {
    if (arr == null) return emptyList()
    val out = ArrayList<NotifyQuestion>(arr.length())
    for (i in 0 until arr.length()) {
      val q = arr.optJSONObject(i) ?: continue
      val options = ArrayList<String>()
      q.optJSONArray("options")?.let { opts ->
        for (k in 0 until opts.length()) {
          val o = opts.optJSONObject(k)
          val label = if (o != null) o.optString("label", "") else opts.optString(k, "")
          if (label.isNotEmpty()) options.add(label)
        }
      }
      out.add(
        NotifyQuestion(
          id = q.optString("id", "q" + i),
          header = q.optString("header", ""),
          question = q.optString("question", ""),
          options = options,
        ),
      )
    }
    return out
  }

  // ── 消费 ────────────────────────────────────────────────────────────────

  /** 按持久化偏移读取并投递；任何异常都不抛出（通知不是关键路径）。 */
  fun drain(context: Context) {
    val app = context.applicationContext
    val f = file(app)
    if (!f.exists()) return
    val p = NotifyCenter.prefs(app)
    var offset = p.getLong(KEY_OFFSET, 0L)
    val len = f.length()
    if (len < offset) {
      // 轮转（引擎把 >=512KB 的文件改名 .1）或文件被重建：先补读 .1 的残段，再从头开始
      drainRotated(app, offset)
      LogCollector.log(TAG, "notify file rotated/recreated; offset reset (was " + offset + ")")
      offset = 0L
    }
    if (len == offset) return
    val lines = ArrayList<String>()
    var consumed = 0L
    try {
      RandomAccessFile(f, "r").use { raf ->
        raf.seek(offset)
        val buf = ByteArray((len - offset).toInt().coerceAtMost(READ_CAP_BYTES))
        val read = raf.read(buf)
        if (read > 0) {
          val r = drainBytes(buf, read)
          lines.addAll(r.lines)
          consumed = r.consumed
        }
      }
    } catch (t: Throwable) {
      LogCollector.log(TAG, "notify drain failed: " + t.message)
      return
    }
    if (consumed > 0) p.edit().putLong(KEY_OFFSET, offset + consumed).apply()
    for (line in lines) dispatch(app, line)
  }

  /** 轮转残段补读（尽力而为）：从旧偏移读到 .1 末尾。 */
  private fun drainRotated(app: Context, oldOffset: Long) {
    val rotated = File(dir(app), ROTATED_NAME)
    if (!rotated.exists()) return
    try {
      RandomAccessFile(rotated, "r").use { raf ->
        val len = raf.length()
        if (len <= oldOffset) return
        raf.seek(oldOffset)
        val buf = ByteArray((len - oldOffset).toInt().coerceAtMost(READ_CAP_BYTES))
        val read = raf.read(buf)
        if (read <= 0) return
        for (line in drainBytes(buf, read).lines) dispatch(app, line)
        LogCollector.log(TAG, "rotated remnant drained from " + oldOffset + " (len=" + len + ")")
      }
    } catch (t: Throwable) {
      LogCollector.log(TAG, "rotated remnant drain failed: " + t.message)
    }
  }

  /** 单行分流：六种 kind + 未知 kind 显式忽略并记日志（不崩、不误投）。 */
  fun dispatch(context: Context, line: String): NotifyCenter.Result? {
    val entry = parseEntry(line)
    if (entry == null) {
      LogCollector.log(TAG, "notify line ignored (unparsable): " + line.take(120))
      return null
    }
    if (entry.kind == "unknown") {
      LogCollector.log(TAG, "notify line ignored (unknown kind): " + line.take(120))
      return NotifyCenter.Result.UNKNOWN_KIND
    }
    if (entry.kind == "report" || entry.kind == "silent") notifyChannelActive = true
    lastEntryAt = android.os.SystemClock.uptimeMillis()
    val ts = parseEpochMs(line)
    if (ts > 0) {
      LogCollector.log(TAG, "notify kind=" + entry.kind + " latencyMs=" + (System.currentTimeMillis() - ts))
    }
    val result = NotifyCenter.notifyEvent(context, entry, foreground = isForeground(context))
    LogCollector.log(TAG, "notify dispatch kind=" + entry.kind + " result=" + result)
    return result
  }

  /** 行内 ts（ISO-8601）→ epoch ms；解析失败返回 0。 */
  fun parseEpochMs(line: String): Long = try {
    val j = JSONObject(line)
    java.time.Instant.parse(j.optString("ts", "")).toEpochMilli()
  } catch (_: Exception) {
    0L
  }

  /**
   * 旧信道回退（NT-09 双读不双发）：只有新信道尚未服役时才投递；否则丢一行并记日志。
   * @return true = 已投递（旧壳语义）；false = 被新信道接管（不双发）
   */
  fun legacyFallback(context: Context, title: String, text: String): Boolean {
    if (notifyChannelActive) {
      LogCollector.log(TAG, "legacy .task-done fallback skipped (notify channel active): " + title)
      return false
    }
    NotifyCenter.notify(context, "task", title, text)
    return true
  }
}
