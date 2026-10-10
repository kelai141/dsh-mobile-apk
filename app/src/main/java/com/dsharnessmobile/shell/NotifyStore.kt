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
 *
 * 第四条约束是 0.14.1 真机停摆（`dsh-mobile#238`）之后补上的，前三条都挡不住它：
 *  4. **消费不得只靠一次文件事件**。真机上 `.notify.ndjson` 涨到 9402 B 而 `notify.offset` 冻在 8810，
 *     报告一条也没投出去，历时十余分钟——旧实现的触发点只有「[watching] 的 FileObserver 事件」与
 *     「进程启动时那一次 drain」，**没有定时兜底**：一次事件丢失即永久停摆，直到下一次进程启动。
 *     现补两条互补驱动：①监听位含 `MOVED_TO`/`CLOSE_WRITE`（落盘改成「临时文件 + rename」时旧位集
 *     永不命中）；②[drainTick] 由**既有看门狗 tick（5 s 固定延迟——真机上唯一被证实还活着的消费者）**
 *     周期性调用，`NotifyStore` 自己不起 Handler/协程，驱动权交给已经跑着的那个心跳。
 *     另外 [drain] 加锁：多驱动并发跑同一份 offset 会**重复投递**（真机上同一 id 80 ms 内被投 5 次）。
 */
object NotifyStore {

  const val TAG = "dsh-notify"
  const val FILE_NAME = ".notify.ndjson"
  const val LEGACY_FILE = ".task-done.ndjson"
  const val ROTATED_NAME = ".notify.ndjson.1"

  /** 单次 drain 读取上限（与 OverlayLiveFeed 同口径；溢出部分留到下一轮，不跳行）。 */
  const val READ_CAP_BYTES = 256 * 1024

  /** 尾部倒读窗口（[tailReportLine] 用；进程重启后仍能显示「刚做完的那一轮」）。 */
  const val TAIL_SCAN_BYTES = 32 * 1024

  /** 兜底心跳记账间隔：tick 每 5 s 一拍，但只在每 [TICK_HEARTBEAT_MS] 记一行探针（防刷屏）。 */
  const val TICK_HEARTBEAT_MS = 5 * 60 * 1000L

  /**
   * `FileObserver` 监听位（P1）。
   *
   * 旧值 `MODIFY or CREATE` 只覆盖「就地追加 + 新建」；引擎若改成「写临时文件 + rename」落盘，事件是
   * `MOVED_TO`，旧位集**永不命中**（候选成因 C2，见 `docs/0.14.1-preview-NOTIFY-CONSUMPTION-STALL-FIX-PLAN.md` §4）。
   * `CLOSE_WRITE` 兜住「写句柄关闭」这一事件形态，`DELETE`/`MOVED_FROM` 用于轮转（`.notify.ndjson` → `.1`）。
   */
  val WATCH_MASK: Int =
    FileObserver.MODIFY or FileObserver.CREATE or FileObserver.CLOSE_WRITE or
      FileObserver.MOVED_TO or FileObserver.DELETE or FileObserver.MOVED_FROM

  /** 消费触发源（写进探针：停摆时第一句话就能回答「上一次是谁驱动的、读到了多少」）。 */
  const val TRIGGER_START = "start"
  const val TRIGGER_TICK = "tick"
  const val TRIGGER_MANUAL = "manual"
  const val TRIGGER_WATCH = "watch:"

  private const val KEY_OFFSET = "notify.offset"

  @Volatile
  private var started = false
  private var watcher: FileObserver? = null

  /** application Context（`latestReportLine()` 的签名必须保持无参——文件回落靠它取路径）。 */
  @Volatile
  private var appContext: Context? = null

  /** 最近一次 watcher 事件时刻（任意路径，不筛）：心跳里对照「文件在长 / 事件不来」即判 watcher 失聪。 */
  @Volatile
  private var lastWatchEventAt = 0L

  @Volatile
  private var watchEvents = 0L

  private var lastHeartbeatAt = 0L
  private var ticks = 0L

  /** 新信道是否已在服役（决定旧信道是否只做回退）。 */
  @Volatile
  var notifyChannelActive = false
    private set

  /** 最近一次消费的观测（NT-07 延迟打点 / NT-04 端到端记录）。 */
  @Volatile
  var lastEntryAt: Long = 0L
    private set

  /**
   * 最近一条**工作汇报**（`kind == "report"`）的原始 ndjson 行（0.14.1 块J 为 T5 提供的窄接口）。
   *
   * 为什么是「原始行」而不是渲染好的文案：`reportLine` / `reportBigText` 是 NotifyCenter 的私有口径，
   * 暴露原始行让消费方按需取字段，避免在此再造一份渲染口径（第二真源）。
   */
  @Volatile
  private var lastReportLineRaw: String? = null

  /**
   * 进程内「最近汇报」只读访问器（T5 OverlayReport.kt 调用；**签名保持稳定**）。
   *
   * 挂点在 [dispatch] 的 `kind == "report"` 分支，且登记在**投递判定之前**——因此该条即使被前台
   * 抑制延后（FIX-1）或因类别关闭未投递，长按面板仍能看到「刚做完的那一轮」的文本；这正是
   * OverlayReport 的用途（本轮完成 → 长按查看汇报），不该因为一条通知被抑制就看不到内容。
   *
   * P2 文件回落：内存槽是**单点**——它只在消费路径赋值，消费一旦停摆（0.14.1 真机实况）或进程刚重启，
   * 长按面板就只剩占位行。故内存槽为空时倒读 `.notify.ndjson` 尾部取最后一条 report 行；命中即回填
   * 内存槽（后续调用不再读盘）。读盘失败一律返回 null（面板有自己的占位文案，不崩）。
   *
   * @return 最近一条 report 的原始 ndjson 行；内存与文件都没有时为 null。
   */
  fun latestReportLine(): String? {
    lastReportLineRaw?.let { return it }
    val app = appContext ?: return null
    val fromFile = try { tailReportLine(app) } catch (_: Throwable) { null }
    if (fromFile != null) lastReportLineRaw = fromFile
    return fromFile
  }

  /** 尾部倒读：文件里最后一条 report 行（[latestReportLine] 的回落实现；IO + 纯解析）。 */
  fun tailReportLine(context: Context): String? {
    val f = file(context)
    if (!f.exists()) return null
    val len = f.length()
    if (len <= 0L) return null
    val from = (len - TAIL_SCAN_BYTES).coerceAtLeast(0L)
    val text = try {
      RandomAccessFile(f, "r").use { raf ->
        raf.seek(from)
        val buf = ByteArray((len - from).toInt())
        val read = raf.read(buf)
        if (read <= 0) "" else String(buf, 0, read, Charsets.UTF_8)
      }
    } catch (_: Throwable) {
      return null
    }
    return lastReportLineIn(text, truncatedHead = from > 0L)
  }

  /**
   * 纯逻辑：从尾部窗口文本里取**最后一条** report 行（JVM 单测覆盖）。
   *
   * [truncatedHead] 为真表示窗口是从文件中间切进来的——首行必然残缺，丢弃（残缺行可能恰好能被
   * 解析成一条假 report，或被当成 json 解析失败刷探针，两种都不该发生）。其余行用既有的
   * [parseEntry] 判定 `kind`，不另造文本匹配口径（`"kind":"report"` 出现在 summary 里就会误判）。
   */
  fun lastReportLineIn(text: String, truncatedHead: Boolean): String? {
    val body = if (truncatedHead) text.substringAfter('\n', "") else text
    var found: String? = null
    for (piece in body.split("\n")) {
      val t = piece.trim()
      if (t.isEmpty()) continue
      if (parseEntry(t)?.kind == "report") found = t
    }
    return found
  }

  fun dir(context: Context): File = File(context.filesDir, "home/.dsh")

  fun file(context: Context): File = File(dir(context), FILE_NAME)

  fun legacyFile(context: Context): File = File(dir(context), LEGACY_FILE)

  /** 幂等启动（进程级；EngineService / OverlayService / 动作冷启动任一路径先到即赢）。 */
  @Synchronized
  fun start(context: Context) {
    if (started) return
    started = true
    val app = context.applicationContext
    appContext = app
    // FIX-2（0.14.1 块J）：listener 的真实实现挂在**消费链的生命周期入口**而非某个 Activity——
    // 它是「被抑制/未授权/渠道降级」的用户可见反馈面。幂等；不覆盖外部已安装的实现。
    NotifyCenter.installShellListener()
    // FIX-3 存量升级归一化：schema 代次只跑一次（缺键的存量用户即在此刻被修好；显式值原样保留）。
    NotifyCenter.ensureSuppressForegroundMigrated(app)
    NotifySuppressQueue.restore(app)
    val d = dir(app)
    if (!d.exists()) d.mkdirs()
    watching(app, d)
    // 启动即消费一次（进程离线期间的积压行：偏移持久化保证不重复投递）
    drain(app, TRIGGER_START)
  }

  /**
   * 挂 `FileObserver`（P1：位集扩到 [WATCH_MASK]，且**任何**事件都刷新 lastWatchEventAt）。
   *
   * 为什么要记「任意路径」的事件：心跳探针要靠它回答「文件在长、事件不来」——即 watcher 是否失聪。
   * 只记命中路径的话，watcher 死了与「这段时间真的没有事件」在探针里长得一模一样。
   */
  private fun watching(app: Context, d: File) {
    try {
      watcher = object : FileObserver(d.absolutePath, WATCH_MASK) {
        override fun onEvent(event: Int, path: String?) {
          lastWatchEventAt = System.currentTimeMillis()
          watchEvents++
          if (shouldConsumeOnEvent(event, path)) drain(app, TRIGGER_WATCH + (path ?: "-"))
        }
      }.apply { startWatching() }
      NotifyProbe.log(app, TAG, "notify watcher started mask=0x" + Integer.toHexString(WATCH_MASK))
    } catch (t: Throwable) {
      // C1（停摆计划 §4）：构造/startWatching 抛异常时这里只留一行探针，此前 `started` 已置 true，
      // 于是此后**再无 watcher**、也无人重试。兜底 tick（drainTick）是这条路的补偿，不是替代。
      NotifyProbe.log(app, TAG, "notify watcher failed: " + t.message)
    }
  }

  /**
   * 纯逻辑：一个 `FileObserver` 事件是否应触发一次消费（JVM 单测覆盖）。
   *
   * 路径判据用白名单（本文件的两个名字 + path==null 的「被监视目录自身」事件），因为同一目录下还有
   * `.live.ndjson` 等高频写者——它们每个事件都做一次 drain 是白烧 CPU。事件位判据用 [WATCH_MASK]，
   * 于是「位集漏了 MOVED_TO」这类漏配（C2）在单测里直接判红。
   */
  fun shouldConsumeOnEvent(event: Int, path: String?): Boolean {
    if (event and WATCH_MASK == 0) return false
    return path == null || path == FILE_NAME || path == ROTATED_NAME
  }

  /**
   * 周期兜底驱动入口（P1）：由**既有看门狗 tick**（`EngineService` 每 5 s 一拍）调用。
   *
   * 为什么由外部驱动而不是本对象起 Handler：那个 tick 已经在跑、已经持唤醒锁、且是真机上唯一被证实
   * **还活着**的消费者（`files/notify-debug.log` 在停摆期间持续更新）。本对象自起一个定时器等于新增
   * 一处生命周期（进程死、被冻结、被 Doze 时与那个 tick 一起失效，等于没有兜底），不划算。
   *
   * 幂等、廉价（一次 stat + 一次 prefs 读）、不抛（[drain] 自带异常边界），可安全地同步调用。
   */
  fun drainTick(context: Context) {
    drain(context, TRIGGER_TICK)
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
      body = j.optString("body", ""),
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
  fun drain(context: Context) = drain(context, TRIGGER_MANUAL)

  /**
   * 按持久化偏移读取并投递（[trigger] 只进探针，用于停摆取证）；任何异常都不抛出。
   *
   * **加锁的理由**（P1）：现在有三个驱动者（`start()`、watcher 线程、看门狗线程），它们会并发读到
   * 同一份 offset 并把同一批行各投一遍——真机上「同一 id 80 ms 内被投 5 次」正是这个形状。
   * 锁是重入的，`start()` 内调用本函数不会自锁。
   */
  @Synchronized
  fun drain(context: Context, trigger: String) {
    val app = context.applicationContext
    if (appContext == null) appContext = app
    val f = file(app)
    if (!f.exists()) return
    val p = NotifyCenter.prefs(app)
    var offset = p.getLong(KEY_OFFSET, 0L)
    val len = f.length()
    if (drainStep(offset, len) == DrainStep.Rotated) {
      // 轮转（引擎把 >=512KB 的文件改名 .1）或文件被重建：先补读 .1 的残段，再从头开始
      if (!drainRotated(app, offset)) return
      NotifyProbe.log(app, TAG, "notify file rotated/recreated; offset reset (was " + offset + ", len=" + len + ") trigger=" + trigger)
      offset = 0L
    }
    val step = drainStep(offset, len)
    heartbeat(app, trigger, offset, len)
    if (step !is DrainStep.Read) return
    val lines = ArrayList<String>()
    var consumed = 0L
    try {
      RandomAccessFile(f, "r").use { raf ->
        raf.seek(step.from)
        val buf = ByteArray(step.bytes)
        val read = raf.read(buf)
        if (read > 0) {
          val r = drainBytes(buf, read)
          lines.addAll(r.lines)
          consumed = r.consumed
        }
      }
    } catch (t: Throwable) {
      NotifyProbe.log(app, TAG, "notify drain failed: " + t.message + " trigger=" + trigger)
      return
    }
    // 至少一次语义（P1）：**先投递再推进偏移**。反向（旧实现：先推进、后投递）在两者之间崩溃即
    // **静默丢**——那条汇报永远不出现（本缺陷的形态）；正向崩溃最多重复投一条，由 P3 去重兜住。
    for (line in lines) {
      if (dispatch(app, line) == NotifyCenter.Result.ERROR) {
        NotifyProbe.log(app, TAG, "notify drain retained offset after delivery/persistence failure: " + offset)
        return
      }
    }
    val next = advanceOffset(offset, consumed, len)
    if (next != offset && !p.edit().putLong(KEY_OFFSET, next).commit()) {
      // SharedPreferences updates memory even when commit fails; retain the retry cursor there too.
      p.edit().putLong(KEY_OFFSET, offset).commit()
      NotifyProbe.log(app, TAG, "notify offset commit failed; source will replay")
      return
    }
    NotifyProbe.log(
      app, TAG,
      "notify drain trigger=" + trigger + " lines=" + lines.size + " offset " + offset + "->" + next + " len=" + len,
    )
  }

  /** 本次消费该做什么（`offset`/`len` 的三种关系；纯逻辑，JVM 单测覆盖）。 */
  sealed class DrainStep {
    /** 无新字节：不读盘、不投递。 */
    object Skip : DrainStep()

    /** `len < offset`：文件被轮转或重建 → 先补读 `.1` 残段，再从 0 读。 */
    object Rotated : DrainStep()

    /** 从 [from] 起读至多 [bytes] 字节（未满行的尾巴留给下一轮）。 */
    data class Read(val from: Long, val bytes: Int) : DrainStep()
  }

  /** 纯逻辑：[drainStep] 的判定（`offset < 0` 视同被重建，与 `len < offset` 同路）。 */
  fun drainStep(offset: Long, len: Long, cap: Int = READ_CAP_BYTES): DrainStep = when {
    offset < 0L -> DrainStep.Rotated
    len < offset -> DrainStep.Rotated
    len == offset -> DrainStep.Skip
    else -> DrainStep.Read(offset, (len - offset).toInt().coerceAtMost(cap))
  }

  /**
   * 纯逻辑：推进后的偏移（P1 判据②「offset 单调前进」）。
   *
   * `consumed <= 0` 不动（半行/无换行），且**永不超过 len**——旧实现无条件写 `offset + consumed`，
   * 一旦上游算出越界的 consumed 就把偏移写到文件长度之外，此后 `len < offset` 恒真、每轮都走轮转复位。
   */
  fun advanceOffset(offset: Long, consumed: Long, len: Long): Long =
    if (consumed <= 0L) offset else (offset + consumed).coerceAtMost(len)

  /**
   * 兜底心跳（只认 tick 触发、只在每 [TICK_HEARTBEAT_MS] 记一行）。
   *
   * 这一行要能回答停摆时的三连问：**兜底还在跑吗**（`ticks`）、**积压多深**（`lag`）、
   * **watcher 还活着吗**（`watchEvents` / `watchEventAgeMs`——两者都停在前一次，就是 watcher 失聪）。
   */
  private fun heartbeat(app: Context, trigger: String, offset: Long, len: Long) {
    if (trigger != TRIGGER_TICK) return
    ticks++
    val now = System.currentTimeMillis()
    if (lastHeartbeatAt != 0L && now - lastHeartbeatAt < TICK_HEARTBEAT_MS) return
    val first = lastHeartbeatAt == 0L
    lastHeartbeatAt = now
    val age = if (lastWatchEventAt == 0L) -1L else now - lastWatchEventAt
    if (first) return
    NotifyProbe.log(
      app, TAG,
      "notify tick alive ticks=" + ticks + " offset=" + offset + " len=" + len + " lag=" + (len - offset) +
        " watchEvents=" + watchEvents + " watchEventAgeMs=" + age + " watcher=" + (watcher != null),
    )
  }


  /** 轮转残段补读（尽力而为）：从旧偏移读到 .1 末尾。 */
  private fun drainRotated(app: Context, oldOffset: Long): Boolean {
    val rotated = File(dir(app), ROTATED_NAME)
    if (!rotated.exists()) return true
    try {
      RandomAccessFile(rotated, "r").use { raf ->
        val len = raf.length()
        if (len <= oldOffset) return true
        raf.seek(oldOffset)
        val buf = ByteArray((len - oldOffset).toInt().coerceAtMost(READ_CAP_BYTES))
        val read = raf.read(buf)
        if (read <= 0) return true
        for (line in drainBytes(buf, read).lines) {
          if (dispatch(app, line) == NotifyCenter.Result.ERROR) return false
        }
        NotifyProbe.log(app, TAG, "rotated remnant drained from " + oldOffset + " (len=" + len + ")")
      }
    } catch (t: Throwable) {
      NotifyProbe.log(app, TAG, "rotated remnant drain failed: " + t.message)
      return false
    }
    return true
  }

  /** 单行分流：六种 kind + 未知 kind 显式忽略并记日志（不崩、不误投）。 */
  fun dispatch(context: Context, line: String): NotifyCenter.Result? {
    val entry = parseEntry(line)
    if (entry == null) {
      NotifyProbe.log(context.applicationContext, TAG, "notify line ignored (unparsable): " + line.take(120))
      return null
    }
    if (entry.kind == "unknown") {
      NotifyProbe.log(context.applicationContext, TAG, "notify line ignored (unknown kind): " + line.take(120))
      return NotifyCenter.Result.UNKNOWN_KIND
    }
    if (entry.kind == "report" || entry.kind == "silent") notifyChannelActive = true
    // 最近汇报登记（T5 窄接口）：在投递判定**之前**，故被抑制/被关也不影响面板可见内容。
    if (entry.kind == "report") lastReportLineRaw = line
    lastEntryAt = android.os.SystemClock.uptimeMillis()
    val ts = parseEpochMs(line)
    if (ts > 0) {
      NotifyProbe.log(context.applicationContext, TAG, "notify kind=" + entry.kind + " latencyMs=" + (System.currentTimeMillis() - ts))
    }
    val foreground = isForeground(context)
    // FIX-1 补投触发点 ①（事件驱动）：应用已不在前台且队列非空 → 先补投延后条目再投本条。
    // 触发点 ② 是 NotifySuppressQueue 的自续 tick（30s，队列空即停），覆盖「后台不再有新事件」的场景。
    // 补投走 notifyEvent(foreground=false)，不经过本函数，故不存在递归。
    if (!foreground && NotifySuppressQueue.pendingCount() > 0) NotifySuppressQueue.flush(context)
    val result = NotifyCenter.notifyEvent(context, entry, foreground = foreground)
    // J-2：这条「投递结果」是本缺陷唯一的终态记账，详档 §6.2/§6.3 的分流表按它判 POSTED /
    // SUPPRESSED_FOREGROUND。必须走 [NotifyProbe] 写进 files/notify-responder.log——旧实现用
    // LogCollector.log 只写 day-file，而 day-file 只在「调试采集器已开」时存在，于是设备上
    // `grep result= files/notify-responder.log` 恒为 0 命中（判据结构性取不到数）。
    NotifyProbe.log(context.applicationContext, TAG, "notify dispatch kind=" + entry.kind + " result=" + result)
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
   *
   * **`return false` 的语义（设备复验口径）**：`notify-debug.log` 里的 `notify returned ok=false`
   * 正是本函数的 false——即「新信道（`.notify.ndjson`）已服役，旧信道按 NT-09 让路」。
   * 这是**预期行为，不是缺陷**：两条信道同时存在时若都投，同一轮任务会弹两次。旧实现把这一行的
   * 解释只写进 day-file（调试采集器未开就不存在），于是在设备上 `ok=false` 变成无法解释的悬疑
   * ——与 J-2 同源。现改走 [NotifyProbe]，该解释与 `ok=false` 落在同一个可 run-as 直读的文件里。
   * @return true = 已投递（新信道未服役）；false = 被新信道接管（不双发）
   */
  fun legacyFallback(context: Context, title: String, text: String): Boolean {
    if (notifyChannelActive) {
      NotifyProbe.log(context.applicationContext, TAG,
        "legacy .task-done fallback skipped (notify channel active; NT-09 single-send): " + title)
      return false
    }
    NotifyCenter.notify(context, "task", title, text)
    return true
  }
}
