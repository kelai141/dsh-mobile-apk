package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import org.json.JSONObject

/**
 * 崩溃自动回退（PRD F3 / D6 方案 a）：壳侧「undo 全自动」闸门。
 *
 * 职责：当引擎反复启动失败（看门狗连续失败达到阈值）或引擎日志出现崩溃签名时，
 * 自动执行 dsh-undo-emergency 急救 CLI，将配置/插件代码树回滚到壳侧探活确认的
 * known-good 快照，并恢复引擎。
 *
 * 与 UpdateManager/EngineManager 的 usr 层回退（usr-old）正交：
 * - usr 层：运行时二进制回退（EngineManager.rollbackToOld）
 * - 本类：配置/插件代码回退（dsh-undo-savepoint 快照，F3 主引擎）
 *
 * 幂等约束：
 * - `.undo-auto-done` 记录成功回滚前冻结的安装指纹与失败 patch digest；
 *   仅同一身份在 30 分钟内受抑制，新身份重新观察；
 * - 仅在急救 CLI 存在快照时执行（list 非空）；
 * - 仅在引擎确实无法启动时触发（不误伤正常慢启动）。
 */
object UndoGate {

  private const val TAG = "dsh-undo"
  private val autoUndoRunning = java.util.concurrent.atomic.AtomicBoolean(false)

  /** 看门狗连续失败触发阈值（与 WatchdogV2.MAX_CONSEC_FAILURES 对齐但更保守：熔断即触发）。 */
  const val TRIGGER_CONSEC_FAILURES = 6

  /** 触发后到执行的静默期：留给引擎自己恢复的最后机会（正常慢启动上限 45s+）。 */
  const val WATCH_MS = 15_000L

  /** 崩溃纪元间隔：距上次自动 undo 完成 < 该间隔时不再自动执行（防循环）。 */
  const val RETRY_WINDOW_MS = 30 * 60 * 1000L

  /**
   * 尝试退避（issue #1368）：距上次**尝试**（无论成败）不足该间隔时不再放行 EXECUTE。
   *
   * 旧实现只在**成功**后写 `.undo-auto-done`，失败路径没有任何记忆 ⇒ 引擎死透且急救 CLI 起不来时，
   * 闸门每 5 秒一拍继续放行，每拍拉起一次回滚尝试，无上限、无退避（后台唤醒与日志一起膨胀）。
   * 取 5 分钟：相对 5 秒拍是 60 拍一次，既不会把「第一次失败后引擎刚好自愈」的窗口堵死，
   * 也不会让不可恢复的现场把 IO 打满。
   */
  const val ATTEMPT_BACKOFF_MS = 5 * 60 * 1000L

  /**
   * 标记文件（arm / attempt）的**唯一写读契约**（issues #1508 #1514 #1530）。
   *
   * 写侧：`v2:<13 位毫秒时间戳>`（[encodeMarker]）。读侧把「长度不是 13 位 / 含非数字 / 落在
   * 合理区间之外」一律判**损坏**——旧判据只要求 `toLongOrNull()` 非空，于是被截断的
   * `1700000000000 -> 1700000000` 依然合法：arm 侧观察窗被静默跳过（#1508），attempt 侧退避
   * 被静默绕过（#1368 原症状复发）。两侧共用同一个编解码器就是「arm/attempt 语义一次定死」的
   * 落点：任何一侧放宽都会立刻被另一侧的用例打红。
   */
  private const val MARKER_VERSION = "v2:"

  /** 毫秒时间戳的固定宽度（13 位覆盖到 2286 年）。宽度不符 = 截断或拼接 = 损坏。 */
  private const val MARKER_DIGITS = 13

  /** 读侧对「未来时刻」的容忍度：超过一个观察窗就只能是时钟回拨造成的坏值。 */
  private const val MARKER_FUTURE_TOLERANCE_MS = WATCH_MS

  /**
   * 闸门的**一次性叙述状态**。收进一个实例而不是散落的 `@Volatile` 字段，是为了让 JVM 用例
   * 各自持有一份——全局可变状态既会让用例互相串扰，也把「只记一次」「退避起点」这类语义
   * 变成不可测。
   */
  internal class GateNotes {
    /** 本进程是否已记过「被重试窗口抑制」。 */
    @Volatile var suppressNoted = false
    /** 证据否决的叙述只落一次（避免每 5s 一拍刷爆观测文件）。 */
    @Volatile var evidenceNoted = false
    /** arm 文件读失败只记一次（issue #1530）。 */
    @Volatile var armUnreadableNoted = false
    /** attempt 标记损坏只记一次（issue #1514）。 */
    @Volatile var attemptCorruptNoted = false
    /** attempt 标记损坏时记住的退避起点（写入时刻拿不到时用它兜住，避免永久抑制）。 */
    var attemptCorruptSeenAt: Long? = null
    /** 硬杀残留的临时文件只清一次（issue #1515）。 */
    @Volatile var staleTempsPurged = false
  }

  private val notes = GateNotes()

  /**
   * Records the first confirmed-dead observation, then grants exactly one caller
   * the right to execute after [WATCH_MS]. A healthy probe disarms the wait.
   */
  /**
   * 回滚的门槛证据（issue #274 ①）。三项都是「这次失败**不该**用回滚来救」的形态：
   *  - 日志里有 `EADDRINUSE`：端口被别的进程占着（我们起不来，重启无意义）；
   *  - 端口**不归本进程**（[portOwnedByApp] == false）：同上，重启我们不解决问题；
   *  - **[slowOnly]**：探活只是**略超**预算（长 turn / 慢磁盘），不是引擎坏了。
   * 三者任一命中 ⇒ 本拍**不 arm 也不 execute**（不碰用户配置、不强杀引擎）。
   *
   * @param logTail 引擎日志尾部（没有则空串）
   * @param portOwnedByApp 端口是否归本应用持有；null = 未知（不因测量失败而否决）
   * @param slowOnly 本次探活是否只是「略超预算」
   */
  data class RollbackEvidence(
    val logTail: String = "",
    val portOwnedByApp: Boolean? = null,
    val slowOnly: Boolean = false,
  ) {
    companion object {
      /** 无证据（既有调用点/测试的默认值）：不否决。 */
      val NONE = RollbackEvidence()
    }
  }

  /**
   * 纯判据：本拍是否应当**放弃**回滚（返回拒绝理由；null = 可以用回滚）。
   *
   * 为什么单独抽成纯函数：这是「自动回滚到底该不该跑」的**第二道门**，必须能被 JVM 逐条反证。
   * 注意它与 [decide] 的分工——[decide] 管「拍数/重试窗/观察窗」这类**计数语义**（既有坑 153 依赖它），
   * 本函数管「这次失败**是不是该用回滚救**」这类**证据语义**。两者都在 [onProbeFailure] 里生效；
   * 但把它们分开，既保住了坑 153 的既有语义（半死引擎仍能走到 [decide] 的 EXECUTE），
   * 又让「探活超时误触发回滚」这一条有独立、可反证的判据。
   */
  internal fun rollbackEvidenceRefusal(evidence: RollbackEvidence): String? {
    if (evidence.logTail.contains("EADDRINUSE")) {
      return "回滚被否决：引擎日志显示 EADDRINUSE（端口被别的进程占着），重启/回滚都不解决问题"
    }
    if (evidence.portOwnedByApp == false) {
      return "回滚被否决：监听端口的不是本进程（端口被他进程占用），重启我们不解决问题"
    }
    if (evidence.slowOnly) {
      return "回滚被否决：本次探活只是略超预算（长 turn / 慢磁盘），不是引擎故障——不碰用户配置、不强杀引擎"
    }
    return null
  }

  /**
   * Records the first confirmed observation, then grants one caller the right to
   * execute after [WATCH_MS]. A healthy probe disarms the wait.
   *
   * 【issue #274 ①】在计数闸门之前先过**证据闸门**（[rollbackEvidenceRefusal]）。
   * 真因：探活在 HTTP 超 2.5s 预算时给 DEGRADED_HTTP（实测出现过 3061ms），长 turn / 慢磁盘
   * 足以让它连续 6 拍（30s）⇒ 直接回滚用户配置 + 强杀活引擎。一次慢响应不该有这种权限。
   * 证据闸门否决时**既不 arm 也不 execute**，并落一行可诊断叙述。
   *
   * @param evidence 设备侧证据（默认无证据 = 不否决；既有调用点因此不受影响）。
   */
  fun onProbeFailure(
    context: Context,
    consecutiveFailures: Int,
    evidence: RollbackEvidence = RollbackEvidence.NONE,
    engine: EngineManager? = null,
  ): Boolean = onProbeFailureIn(
    dir = context.filesDir,
    consecutiveFailures = consecutiveFailures,
    evidence = evidence,
    identity = currentRetryIdentity(context, engine),
    nowMs = System.currentTimeMillis(),
    notes = notes,
    note = { record(context, it) },
  )

  /**
   * [onProbeFailure] 的**文件系统无关**实现（JVM 可整链真跑：临时目录 + 推进时钟）。
   *
   * 为什么把 Context 换成目录：这条闸门的全部语义都落在 arm / attempt 两个标记文件上，而
   * 「0 字节 / 半截 / 读失败 / 写入时刻」这些形态只有在真文件上才造得出来。旧实现只能靠源码
   * 文本切片断言「两个调用点都传了 attemptAt」——传参不等于记账，于是 #1507（第二入口从不记账）
   * 与 #1514（损坏标记只退避一拍）在测试全绿的情况下同时存在。
   *
   * @param dir 应用私有目录（生产 = `context.filesDir`）
   * @param identity 重试纪元身份（生产 = 安装指纹 + 当前 patch digest）
   * @param nowMs 本拍墙钟（生产 = `System.currentTimeMillis()`；用例直接推进）
   * @param notes 一次性叙述状态（生产传对象级实例；用例各持一份以隔离）
   * @param note 观测行落点（生产 = [record]；用例收集进列表以断言「留了哪一行」）
   */
  internal fun onProbeFailureIn(
    dir: File,
    consecutiveFailures: Int,
    evidence: RollbackEvidence,
    identity: RetryIdentity,
    nowMs: Long,
    notes: GateNotes = GateNotes(),
    note: (String) -> Unit = {},
  ): Boolean {
    purgeStaleTempsOnce(dir, nowMs, notes, note)
    val refusal = rollbackEvidenceRefusal(evidence)
    if (refusal != null) {
      // 只在到过触发阈值时落叙述，避免每 5s 一拍刷爆观测文件。
      if (consecutiveFailures >= TRIGGER_CONSEC_FAILURES && !notes.evidenceNoted) {
        notes.evidenceNoted = true
        note("evidence-veto failures=" + consecutiveFailures + " reason=" + refusal)
        Log.i(TAG, refusal)
      }
      return false
    }
    notes.evidenceNoted = false
    val retry = retrySuppression(markerFileIn(dir), identity, nowMs)
    if (retry.resetWatch) {
      runCatching { armFileIn(dir).delete() }
      note("retry epoch changed; observation window restarted")
    }
    if (retry.legacyMarker && consecutiveFailures >= TRIGGER_CONSEC_FAILURES && !notes.suppressNoted) {
      notes.suppressNoted = true
      note("legacy undo marker conservatively suppresses until retry window expires")
    }
    val decision = decide(
      consecutiveFailures,
      nowMs,
      retry.atMs,
      armedAt(dir, nowMs, notes, note),
      attemptAt(dir, nowMs, notes, note),
    )
    return when (decision) {
      GateDecision.IDLE -> false
      GateDecision.SUPPRESS -> {
        // 只记一次：重试窗口内每 5s 一拍，逐拍落盘会刷爆观测文件（真实原因由 .undo-auto-done 承载）。
        if (!notes.suppressNoted) {
          notes.suppressNoted = true
          note("suppressed retry-window failures=" + consecutiveFailures + " lastUndoAt=" + retry.atMs)
        }
        false
      }
      GateDecision.ARM -> {
        notes.suppressNoted = false
        val armed = try {
          // issue #1369 / #1508：arm 文件必须原子写且带版本前缀——裸 writeText 先截断再写，
          // 进程在窗口内被硬杀（或磁盘满）会留下 0 字节/半截文件，而读侧把「存在」当「值有效」。
          writeAtomicText(armFileIn(dir), encodeMarker(nowMs), note)
          true
        } catch (t: Throwable) {
          Log.e(TAG, "auto-undo arm failed", t)
          note("arm-failed " + (t.message ?: t.javaClass.simpleName))
          false
        }
        if (armed) {
          Log.i(TAG, "auto-undo armed at $nowMs; waiting $WATCH_MS ms")
          note("armed failures=" + consecutiveFailures + " watchMs=" + WATCH_MS)
        }
        false
      }
      GateDecision.WAIT -> false
      GateDecision.EXECUTE -> {
        notes.suppressNoted = false
        // issue #1368 / #1507：**无论成败**都记一次尝试，且与 client-plugin 入口共用同一个
        // 记录函数——旧实现只有这一处记账，那条路径因此仍每 5 秒拉起一次回滚。
        recordAttempt(dir, nowMs, note)
        note("trigger failures=" + consecutiveFailures)
        true
      }
    }
  }

  /**
   * 浏览器侧插件装配失败的**一次性入口**（CONTRACT §5；调用方 EngineStartFlow §4）。
   *
   * 语义来自 [decide] 的 SUPPRESS/EXECUTE 两态，但**刻意不走 ARM→WAIT 观察窗**：
   * 调用方已经把「只花一次预算」花在自己身上（clientPluginTreeRecoverySpent），这里只回答
   * 「现在能不能动手」。
   *
   * 为什么不能照搬 [onProbeFailure] 的 arm → wait：引擎**健康**时看门狗每 5s 一拍走 IDLE 分支并
   * 调用 [disarm]（见 EngineService 的 TickAction.IDLE），arm 文件被逐拍清掉 ⇒ 下一次进来
   * armedAt 仍是 null ⇒ [decide] 永远返回 ARM ⇒ 永远到不了 EXECUTE。页面失败不是「引擎半死」——
   * 它是页面注入层给出的终局判据，引擎本身还在跑，观察窗在这条路上只会变成一道永不打开的闸门，
   * 把唯一的自动恢复路径静默掐死（该反证见 ClientRollbackGateTest）。
   *
   * @param detail 失败原文/原因短句（进观测面，供设备侧归因；不参与判定）
   * @return true = 现在就执行回滚；false = 距上次成功回滚不足 [RETRY_WINDOW_MS]，防循环抑制
   */
  fun onClientPluginTreeFailure(context: Context, detail: String, engine: EngineManager? = null): Boolean =
    onClientPluginTreeFailureIn(
      dir = context.filesDir,
      detail = detail,
      identity = currentRetryIdentity(context, engine),
      nowMs = System.currentTimeMillis(),
      notes = notes,
      note = { record(context, it) },
    )

  /**
   * [onClientPluginTreeFailure] 的目录版实现（理由同 [onProbeFailureIn]）。
   *
   * issue #1507：**放行必须记账**。旧实现在这里只做 [decide] 然后把 EXECUTE 映射成 true，attempt
   * 文件从不更新 ⇒ 「每 5 秒一拍拉起一次回滚」在这条路径上原样保留，#1368 的退避只覆盖了一个
   * 入口。现在两个放行出口共用 [recordAttempt]，语义不可能再分叉。
   */
  internal fun onClientPluginTreeFailureIn(
    dir: File,
    detail: String,
    identity: RetryIdentity,
    nowMs: Long,
    notes: GateNotes = GateNotes(),
    note: (String) -> Unit = {},
  ): Boolean {
    purgeStaleTempsOnce(dir, nowMs, notes, note)
    val retry = retrySuppression(markerFileIn(dir), identity, nowMs)
    if (retry.resetWatch) runCatching { armFileIn(dir).delete() }
    val decision = decide(
      TRIGGER_CONSEC_FAILURES,
      nowMs,
      retry.atMs,
      armedAt(dir, nowMs, notes, note),
      attemptAt(dir, nowMs, notes, note),
    )
    note("client-plugin-tree-failed decision=" + decision + " detail=" + detail.take(160).replace('\n', ' '))
    val allowed = clientPluginFailureDecision(decision)
    // issue #1507：放行即一次真实尝试（调用方拿到 true 就会去执行），必须当场记账。
    if (allowed) recordAttempt(dir, nowMs, note)
    return allowed
  }

  /**
   * 一次性入口的两态映射（纯函数，JVM 直接可测）。
   *
   * - [GateDecision.SUPPRESS]（距上次成功回滚不足 [RETRY_WINDOW_MS]）⇒ false：不放行，防循环；
   * - 其余（IDLE / ARM / WAIT / EXECUTE）⇒ true：**ARM 与 WAIT 不再被当成「等待」**，理由见
   *   [onClientPluginTreeFailure]（观察窗在这条路上永远走不到 EXECUTE）。
   *
   * 于是「EXECUTE → true / SUPPRESS → false」这一对契约语义被原样保留，同时把
   * 「不得用 ARM→WAIT 观察窗」这条约束固化成一个可被单测反证的纯函数。
   */
  internal fun clientPluginFailureDecision(decision: GateDecision): Boolean =
    decision != GateDecision.SUPPRESS

  /**
   * 自动回撤闸门的**纯决策**（JVM 可直接单测，不依赖 Context / 文件系统）。
   *
   * 抽出来的理由：本闸门是「自动 undo 到底会不会跑」的唯一判据，而它原先整体依赖
   * Context + 文件读，导致这段决定「是否自救」的逻辑**零测试覆盖**——`planTick` 的熔断锁存
   * 盲区正是同类「恢复判据无防线」的产物。把四态判定独立成纯函数后可直接断言。
   *
   * 语义（与 [onProbeFailure] 逐条对应）：
   * - [GateDecision.IDLE]     未达触发阈值（[TRIGGER_CONSEC_FAILURES]），不动作；
   * - [GateDecision.SUPPRESS] 距上次成功执行不足 [RETRY_WINDOW_MS]，防循环；
   * - [GateDecision.ARM]      首次确认死亡：起 [WATCH_MS] 观察窗，留给引擎自愈的最后机会；
   * - [GateDecision.WAIT]     观察窗未走完；
   * - [GateDecision.EXECUTE]  观察窗走完仍不健康 → 放行执行。
   *
   * @param consecutiveFailures 看门狗给出的连续确认死亡拍数
   * @param nowMs 当前墙钟毫秒
   * @param lastUndoAtMs 上次自动 undo 成功时刻（无则 null）
   * @param armedAtMs 观察窗起始时刻（未起窗则 null）
   */
  internal fun decide(
    consecutiveFailures: Int,
    nowMs: Long,
    lastUndoAtMs: Long?,
    armedAtMs: Long?,
    /** 上次**尝试**执行回撤的时刻（无论成败，issue #1368）；无则 null。 */
    lastAttemptAtMs: Long? = null,
  ): GateDecision = when {
    consecutiveFailures < TRIGGER_CONSEC_FAILURES -> GateDecision.IDLE
    lastUndoAtMs != null && nowMs - lastUndoAtMs < RETRY_WINDOW_MS -> GateDecision.SUPPRESS
    // issue #1368：失败也记账。旧实现只在成功后写 marker，失败路径每拍都重新放行。
    lastAttemptAtMs != null && nowMs - lastAttemptAtMs < ATTEMPT_BACKOFF_MS -> GateDecision.SUPPRESS
    armedAtMs == null -> GateDecision.ARM
    nowMs - armedAtMs < WATCH_MS -> GateDecision.WAIT
    else -> GateDecision.EXECUTE
  }

  /** [decide] 的取值域。 */
  internal enum class GateDecision { IDLE, ARM, WAIT, SUPPRESS, EXECUTE }

  internal data class RetryIdentity(val installFingerprint: String, val patchDigest: String)
  internal data class RetrySuppression(val atMs: Long?, val legacyMarker: Boolean, val resetWatch: Boolean = false)

  internal fun retrySuppression(fileText: String?, identity: RetryIdentity, nowMs: Long): RetrySuppression {
    if (fileText.isNullOrBlank()) return RetrySuppression(null, false)
    val raw = fileText.trim()
    val legacy = raw.toLongOrNull()
    if (legacy != null) {
      val active = nowMs >= legacy && nowMs - legacy < RETRY_WINDOW_MS
      return RetrySuppression(legacy.takeIf { active }, true, resetWatch = !active)
    }
    return try {
      val value = JSONObject(raw)
      val at = value.optLong("at", 0L)
      val matches = value.optInt("schema", 0) == 2 &&
        value.optString("installFingerprint") == identity.installFingerprint &&
        value.optString("patchDigest") == identity.patchDigest
      val active = matches && at > 0L && nowMs >= at && nowMs - at < RETRY_WINDOW_MS
      RetrySuppression(at.takeIf { active }, false, resetWatch = !active)
    } catch (_: Throwable) { RetrySuppression(null, false, resetWatch = true) }
  }

  // ── 可观测性（0.14.1）：不受 DevLogPrefs 闸门的独立落盘 ─────────────────────
  //
  // 为什么需要独立通道：`LogCollector.log` 在 appContext == null 时直接 return，而 appContext 仅在
  // `LogCollector.start` 内设置、后者受 `DevLogPrefs.isEnabled` 闸门且**默认 false** —— 于是默认
  // 设备上「自动 undo 是否触发 / 是否成功」这类看门狗叙述行**全部落空**，用户无从判断回撤跑没跑
  // （这正是「感觉自动 undo 失效了」的直接来源）。此处按 `.undo-auto-done` marker 的既有范式，
  // 写一条**进程私有但恒在**的判据文件：run-as 可读，不依赖任何调试开关。
  //
  // 边界：不碰 LogCollector / boot-diag.log（T6 写面），自带独立文件与轮转。
  private const val ATTEMPT_FILE = "undo-gate.log"
  private const val ATTEMPT_MAX_BYTES = 64L * 1024

  /** 观测行前缀（设备侧单条 grep；与 boot-segments 同类，机器可判）。 */
  const val ATTEMPT_MARK = "dsh-undo-gate"

  // 「只记一次」与「退避起点」这类一次性叙述状态收在 [GateNotes] 里（见类顶部的实例）。

  /**
   * 落一条闸门观测（best-effort，绝不抛）。**不经 DevLogPrefs 闸门**——它必须在默认配置下可见。
   * 超限轮转一代，与 boot-diag.log 同口径。
   */
  private fun record(context: Context, message: String) {
    val line = ATTEMPT_MARK + " at=" + System.currentTimeMillis() + " " + message.replace('\n', ' ')
    // 双写：LogCollector 打开时进统一日志面（顺序与上下文在一起），关闭时下面的文件仍在。
    try { LogCollector.log(TAG, message) } catch (_: Throwable) {}
    try {
      val f = File(context.filesDir, ATTEMPT_FILE)
      if (f.length() > ATTEMPT_MAX_BYTES) {
        val prev = File(context.filesDir, ATTEMPT_FILE + ".1")
        try { prev.delete() } catch (_: Throwable) { /* 旧代删不掉不影响本轮追加 */ }
        try { f.renameTo(prev) } catch (_: Throwable) { /* 轮转失败则继续追加 */ }
      }
      f.appendText(line + "\n")
    } catch (_: Throwable) {
      // 观测面本身不得成为故障源（磁盘满 / 目录不可写）。
    }
  }

  /**
   * 观察窗起始时刻（无则 null）。
   *
   * issue #1369：存在但**解析不出**（0 字节 / 半截内容）以前会被当成「没有值」，于是每拍都判 ARM
   * 并重写——观察窗永不结束，自动回滚静默失效。现在把它判成损坏：删掉、记一行，下一拍重新起窗。
   * issue #1508：**可解析不等于有效**——被截断成 1700000000 的时间戳同样能 `toLongOrNull()`，
   * 于是 armedAt 远在过去 ⇒ 观察窗被静默跳过（比「永不结束」更危险：引擎还没确认健康就回滚）。
   * 判据换成 [decodeMarker] 的形状 + 区间校验，见 [ArmMarker]。
   * issue #1530：**读失败与内容为空必须分开**——读失败时保留文件（下一拍还能读回真实起点），
   * 起点取文件写入时刻，绝不因为一次瞬时 IO 抖动就删掉有效记录、把观察窗从头重计。
   */
  private fun armedAt(dir: File, nowMs: Long, notes: GateNotes, note: (String) -> Unit): Long? {
    val file = armFileIn(dir)
    val exists = file.exists()
    val raw = readMarker(file)
    val mtime = if (exists) file.lastModified() else 0L
    return when (val marker = armMarker(exists, raw, nowMs, mtime)) {
      ArmMarker.Missing -> null
      is ArmMarker.Armed -> marker.atMs
      is ArmMarker.Unreadable -> {
        if (!notes.armUnreadableNoted) {
          notes.armUnreadableNoted = true
          note("arm file unreadable (kept) — window kept from write time at=" + marker.atMs)
        }
        marker.atMs
      }
      ArmMarker.Corrupt -> {
        runCatching { file.delete() }
        note("arm file corrupt (unparseable) — removed; observation window restarts")
        null
      }
    }
  }

  /**
   * arm 标记的解析结果（纯函数，JVM 单测直接钉）。
   *
   *  - [Missing]   文件不在 ⇒ 本拍起窗；
   *  - [Armed]     形状与区间都合法 ⇒ 用文件里的起点（长度不是 13 位一律不认，截断值走 [Corrupt]）；
   *  - [Unreadable] 文件在、这次读失败（#1530）⇒ **不删**，起点取文件写入时刻（拿不到退回本拍），
   *    于是观察窗既不被重置、也不会被永久冻结；
   *  - [Corrupt]   内容坏 ⇒ 删文件重起窗（#1369 的既有语义，半截值不能当有效起点）。
   */
  internal sealed interface ArmMarker {
    data object Missing : ArmMarker
    data class Armed(val atMs: Long) : ArmMarker
    data class Unreadable(val atMs: Long) : ArmMarker
    data object Corrupt : ArmMarker
  }

  internal fun armMarker(exists: Boolean, raw: String?, nowMs: Long, mtimeMs: Long = 0L): ArmMarker = when {
    !exists -> ArmMarker.Missing
    raw == null -> ArmMarker.Unreadable(writeTimeOrNow(mtimeMs, nowMs))
    else -> decodeMarker(raw, nowMs)?.let { ArmMarker.Armed(it) } ?: ArmMarker.Corrupt
  }

  /** 编码标记值：`v2:<13 位毫秒>`。[decodeMarker] 的逆函数（用例做往返断言）。 */
  internal fun encodeMarker(atMs: Long): String = MARKER_VERSION + atMs

  /**
   * 解码标记值（纯函数，JVM 单测直接钉）：返回 null = **损坏**。
   *
   * 判据是**形状 + 区间**，不是「能不能 parse」：
   *  - 去掉 [MARKER_VERSION] 前缀后必须**恰好 13 位且全为数字**（截断 17000 / 拼接 abc 全判损坏）；
   *  - 必须落在 `(0, now + MARKER_FUTURE_TOLERANCE_MS]`（时钟回拨造出的未来值不许把闸门冻住）。
   * 无前缀但形状合法的裸值照收：那是上一个版本写的标记文件，升级当拍不该被当成损坏。
   */
  internal fun decodeMarker(raw: String?, nowMs: Long): Long? {
    val body = raw?.trim()?.removePrefix(MARKER_VERSION) ?: return null
    if (body.length != MARKER_DIGITS) return null
    if (body.any { it < '0' || it > '9' }) return null
    val at = body.toLongOrNull() ?: return null
    if (at <= 0L || at > nowMs + MARKER_FUTURE_TOLERANCE_MS) return null
    return at
  }

  /** 文件写入时刻的可信取值；拿不到（0 / 未来）时退回本拍。 */
  private fun writeTimeOrNow(mtimeMs: Long, nowMs: Long): Long =
    if (mtimeMs > 0L && mtimeMs <= nowMs + MARKER_FUTURE_TOLERANCE_MS) mtimeMs else nowMs

  /** 读标记文件：正常返回内容；读失败返回 null（与「内容为空」严格区分，issue #1530）。 */
  private fun readMarker(file: File): String? = if (file.exists()) runCatching { file.readText() }.getOrNull() else null

  /**
   * 原子写文本（issue #1369 / #1515）：同目录临时文件 → fsync → 发布。
   * 目标路径上要么是上一版的完整内容、要么不存在，不会出现 0 字节残档。
   *
   * issue #1515：ATOMIC_MOVE 在 FUSE / emulated 挂载上会抛 AtomicMoveNotSupportedException。
   * 旧实现让异常直接冒泡，于是 ARM 分支退化成 armed=false、EXECUTE 分支只留一行日志 ⇒ 退避
   * 静默失效。现在统一走 [AtomicFileReplace]（仓内唯一的「临时文件 + fsync + 发布」实现，
   * 自带普通 move 降级），降级经 [AtomicFileReplace.publish] 的 onDegrade 留痕；父目录 fsync
   * 也在那一层补，硬杀残留的临时文件由 [purgeStaleTemps] 在进闸门第一拍清掉。
   */
  internal fun writeAtomicText(
    target: File,
    text: String,
    note: (String) -> Unit,
    publish: (File, File, (String) -> Unit) -> Boolean = AtomicFileReplace::publish,
  ) {
    val parent = target.absoluteFile.parentFile ?: throw java.io.IOException("marker file has no parent")
    parent.mkdirs()
    AtomicFileReplace.writeText(target, text) { tmp, dst ->
      publish(tmp, dst) { reason ->
        note("atomic move unsupported (" + reason + ") — degraded to plain move")
      }
    }
  }

  /**
   * 记一次**尝试**（issue #1368 / #1507）：两个放行出口（[onProbeFailureIn] 的 EXECUTE、
   * [onClientPluginTreeFailureIn] 的放行）共用本函数，语义不可能再分叉。
   * 写失败只留痕、不放行失败——退避是加固，不是执行的前置条件。
   */
  internal fun recordAttempt(dir: File, nowMs: Long, note: (String) -> Unit) {
    try {
      writeAtomicText(attemptFileIn(dir), encodeMarker(nowMs), note)
    } catch (t: Throwable) {
      note("attempt marker write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** 硬杀残留的原子写临时文件（issue #1515）：本类写入器产生的 `..undo-auto-*.<rand>.tmp`。 */
  internal fun staleTempNames(names: List<String>): List<String> =
    names.filter { it.startsWith("..undo-auto-") && it.endsWith(".tmp") }

  /** 残留临时文件的最小年龄：正常写盘是毫秒级，仍在写的临时文件不能被误清。 */
  internal const val STALE_TEMP_MS = 10 * 60 * 1000L

  /** 清掉 [STALE_TEMP_MS] 之前的残留临时文件；返回清掉的条数。 */
  internal fun purgeStaleTemps(dir: File, nowMs: Long, note: (String) -> Unit): Int {
    val names = runCatching { dir.list()?.toList() ?: emptyList<String>() }.getOrNull() ?: return 0
    var removed = 0
    for (name in staleTempNames(names)) {
      val stale = File(dir, name)
      if (nowMs - stale.lastModified() < STALE_TEMP_MS) continue
      if (runCatching { stale.delete() }.getOrDefault(false)) removed++
    }
    if (removed > 0) note("purged " + removed + " stale atomic-write temp file(s)")
    return removed
  }

  /** 每个进程只清一次（进闸门的第一拍；本类没有独立的启动钩子）。 */
  private fun purgeStaleTempsOnce(dir: File, nowMs: Long, notes: GateNotes, note: (String) -> Unit) {
    if (notes.staleTempsPurged) return
    notes.staleTempsPurged = true
    purgeStaleTemps(dir, nowMs, note)
  }

  /**
   * 记录「已知良好快照 id」——**只由壳侧自己的健康观测写入**（引擎探活 HEALTHY 的那一拍）。
   *
   * 为什么必须由壳侧判：急救 CLI 的 `restore-last-good` 目标是插件自报的
   * `boot-state.json.lastGoodAt`，而那个 `ok=true` 是**插件 apply 阶段/30s 定时**写的，并不代表
   * 引擎整体起来了（2026-09-21 设备实测：注入坏插件后，引擎起不来，而 boot-state 仍写 ok、
   * `lastGoodAt` 前移到崩溃那次启动 ⇒ `restore-last-good` 选中的正是**含坏配置的那份快照**，
   * 回滚把坏配置原样写回，日志却报 `executed ok`）。
   * 壳侧的唯一硬证据是**引擎 HTTP 活着**（看门狗 5s 一拍的两级探活）——那就用它来定义「好」。
   *
   * 幂等且廉价：一次目录列举 + 一次字符串比较；值不变不落盘（5s 一拍，不刷文件）。
   */
  fun noteHealthy(context: Context, engine: EngineManager) {
    val fp = installFingerprint(context)
    val patch = PluginMounts.patchFile(engine)
    // Hard ownership is packaged from the final snapshot composition. Live patch entries are user-editable
    // and must never be promoted to product-owned merely because the install fingerprint changed.
    val hard = PluginMounts.ensureHard(context, fp)
    if (hard == null) {
      record(context, "hard-manifest unavailable; ownership actions fail closed fp=" + (fp?.take(12) ?: "none"))
    } else {
      val launchId = EngineManager.lastStartAttemptAt
      if (PluginMounts.shouldProbeHealth(context, patch, launchId)) {
        val complete = EngineProbe.completeSoftHealth(context, hard)
        if (PluginMounts.noteHealthy(context, patch, launchId, complete)) {
          record(context, "soft-manifest stable after two healthy engine launches " + PluginMounts.softStateSummary(context, patch))
        } else if (complete) {
          record(context, "soft-manifest candidate observed launch=" + launchId + " " + PluginMounts.softStateSummary(context, patch))
        } else if (!complete) {
          record(context, "soft-manifest candidate not confirmed: complete Cordis/API health unavailable launch=" + launchId)
        }
      }
    }
    val id = newestSnapshotId(autoSnapshotIds(engine)) ?: return
    // 无安装指纹就不记：没有指纹就无法回答「这份快照属于哪次安装」，而跨版本的配置回滚正是要禁止的
    // （见 [knownGoodUsable]）——宁可退回「不自动回滚」，也不做一次归属不明的写回。
    if (fp == null) return
    if (id == knownGoodId(context) && fp == knownGoodFp(context)) return
    try {
      knownGoodFile(context).writeText(id + "\n" + fp + "\n")
      record(context, "known-good snapshot=" + id + " fp=" + fp.take(12))
    } catch (t: Throwable) {
      Log.e(TAG, "known-good write failed", t)
    }
  }

  /**
   * 纯逻辑：这份「已知良好」记录能否用于**本次安装**的回滚（JVM 单测覆盖）。
   *
   * 版本护栏（2026-09-21 用户追问「已有插件与新插件冲突时，会不会为了救旧插件而把新版本的改动回退掉」
   * 的正面回答）：只有当记录里的安装指纹与当前安装一致时才允许写回配置。否则会出现一种最坏的混合态：
   * **新版本的代码（APK 已装）+ 旧版本的配置（快照写回）**——新版本的补丁/挂载项被静默删掉，
   * 用户看到的是「升级后功能反而没了」，且无从归因。跨版本时正确的恢复路径是内嵌快照重解包/工厂复位，
   * 不是把上一次安装的配置写回。
   *
   * @return 可用的快照 id；不可用（跨版本 / 记录缺指纹 / id 为空）返回 null。
   */
  internal fun knownGoodUsable(storedId: String?, storedFp: String?, currentFp: String?): String? =
    storedId?.takeIf { it.isNotEmpty() && !storedFp.isNullOrEmpty() && storedFp == currentFp }

  /** 当前安装的快照指纹（`files/.snapshot-fingerprint`，EngineManager 写入；缺失返回 null）。 */
  private fun installFingerprint(context: Context): String? = installFingerprintIn(context.filesDir)

  /** [installFingerprint] 的目录版（[onProbeFailureIn] / [onClientPluginTreeFailureIn] 用得到）。 */
  private fun installFingerprintIn(dir: File): String? =
    File(dir, ".snapshot-fingerprint")
      .takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }

  /** 快照目录里的 id 列表（排除 `boot-state.json` / `env-vault` 等非快照条目）。 */
  private fun autoSnapshotIds(engine: EngineManager): List<String> {
    val dir = File(File(engine.homeDir, ".dsh/undo-snapshots"), "auto")
    return try {
      dir.list()?.toList() ?: emptyList()
    } catch (t: Throwable) {
      Log.w(TAG, "snapshot dir unreadable: " + t.message)
      emptyList()
    }
  }

  /**
   * 纯逻辑：取最新快照 id（JVM 单测覆盖）。
   *
   * id 形如 `20260920-235635-524b`（本地时间 + 4 位随机），字典序即时间序；非该形状的名字
   * （`boot-state.json`、`env-vault`、`*.tmp`）一律不认——否则会把状态文件当成快照 id 传给 CLI。
   */
  internal fun newestSnapshotId(names: List<String>): String? =
    names.filter { SNAPSHOT_ID.matches(it) }.maxOrNull()

  /** 已知良好快照 id（无则 null）。 */
  internal fun knownGoodId(context: Context): String? =
    knownGoodFile(context).takeIf { it.exists() }?.readText()?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

  /** 写入该记录时的安装指纹（第二行；无则 null）。 */
  internal fun knownGoodFp(context: Context): String? =
    knownGoodFile(context).takeIf { it.exists() }?.readText()?.lineSequence()?.drop(1)?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

  /** 该快照 id 在 auto 目录里是否仍存在（快照会被 prune 掉，选目标前必须核对）。 */
  private fun snapshotExists(context: Context, engine: EngineManager, id: String): Boolean =
    File(File(File(engine.homeDir, ".dsh/undo-snapshots"), "auto"), id).isDirectory

  /**
   * 执行自动 undo（必须后台线程调用）：
   * 1. 急救 CLI 恢复壳侧探活记录、且属于本次安装的快照 ID
   * 2. 写 .undo-auto-done 标记（重试抑制）
   * 3. 返回是否执行了回滚（+ 摘要）
   */
  fun execute(
    context: Context,
    engine: EngineManager,
    clientFailure: PluginMounts.FailedEntry? = null,
  ): UndoResult {
    if (!autoUndoRunning.compareAndSet(false, true)) return UndoResult(false, "自动回撤已在执行", null)
    try {
      // Freeze the failing runtime/config identity before any surgical isolation or whole-patch restore.
      val failedIdentity = currentRetryIdentity(context, engine)
      val dsh = File(engine.homeDir, ".dsh")
      val cli = File(context.filesDir, "undo-emergency.mjs")
      if (!cli.exists()) {
        Log.e(TAG, "auto-undo aborted: emergency CLI not deployed at " + cli.absolutePath)
        record(context, "aborted cli-missing at=" + cli.absolutePath)
        return UndoResult(false, "急救 CLI 未部署", null)
      }
      // 先确认有快照（空库不执行，避免空转）
      val list = runCli(context, engine, cli, dsh, listOf("list"))
      // #211.1：CLI 超时 = 状态未知，绝不判「无快照可回滚」（旧实现两者同形，超时被静默误判为
      // 空库 → 自动回退从未执行）。此分支只是「不执行」并给出可区分的摘要，不吞掉区别。
      if (list.any { it.contains(ProcIo.TIMEOUT_FLAG) }) {
        Log.w(TAG, "auto-undo aborted: emergency CLI list timed out; snapshot state unknown")
        record(context, "aborted list-timeout flag=" + ProcIo.TIMEOUT_FLAG)
        return UndoResult(false, "急救 CLI 超时：快照清单状态未知（非「无快照可回滚」）", null)
      }
      if (!list.any { it.startsWith("2026") || it.startsWith("20") } && !list.any { it.contains("[auto]") }) {
        Log.i(TAG, "auto-undo skipped: no snapshots found")
        record(context, "skipped no-snapshots listLines=" + list.size)
        return UndoResult(false, "无快照可回滚", null)
      }
      // ── 清单式外科修复（2026-09-21 用户拍板）：**先拔坏插件，不做整份回滚** ──────────────
      // 整份回滚会把「最后一次健康启动之后用户装的插件」全部从装配里抹掉（用户明确否决）。
      // 故顺序是：能点名 → 只拔它；点不出名但清单没变 → 才允许走 known-good 整份回滚；
      // 清单变了又点不出名 → 什么都不做（宁可不动，也不吞用户插件）。
      val patch = PluginMounts.patchFile(engine)
      // 失败条目来源（CONTRACT §5）：**引擎日志优先**，日志点不出名时退到调用方给的 clientFailure
      // （页面契约行 failedIds → PluginMounts.clientPullCandidate 的产物）。
      // 为什么日志优先：引擎原文 'failed to import loader entry <id> (<包名>)' 带括号包名，
      // 比页面侧文本可靠；两者都不成立时行为与改动前一字不差（failed == null，继续走整份
      // 回滚或如实拒绝）。
      val failed = PluginMounts.failedEntryOf(PluginMounts.readEngineLogTail(context)) ?: clientFailure
      val hard = PluginMounts.ensureHard(context, installFingerprint(context))
      if (hard == null) {
        record(context, "aborted ownership-unverified; no plugin isolation or rollback")
        return UndoResult(false, "插件归属清单缺失或与当前快照不匹配：未自动隔离或回滚，用户配置保持原样", null)
      }
      if (failed != null && failed.name != null && !hard.owns(failed.id, failed.name)) {
        if (PluginMounts.pull(context, patch, failed)) {
          record(context, "pulled plugin=" + failed.name + " id=" + (failed.id ?: "?"))
          return UndoResult(true, "已从装配里拔出失败插件（其余插件未改动）：" + failed.name, failed.name)
        }
        record(context, "pull failed (block not located) plugin=" + failed.name)
      } else if (failed != null) {
        record(context, "pull skipped: failed entry is in the hard manifest (our own plugin) name=" + (failed.name ?: "?"))
      }
      if (!PluginMounts.mountUnchangedSinceHealthy(context, patch)) {
        record(context, "aborted mount-changed-and-unattributed plugin=" + (failed?.name ?: "?"))
        return UndoResult(false, "插件清单已变化但点名不出失败插件：不做整份回滚（避免连用户其它插件一起回退）", null)
      }
      // 2026-09-21 主修：回滚目标 = **壳侧确认健康那一刻的最新快照**（而不是 CLI 自报的 lastGood），
      // 且**只允许回滚本次安装建立的快照**（跨版本一律不回滚，见 [knownGoodUsable]）。
      // 无可用目标时返回「不执行」并写明理由——旧实现在这里退回 restore-last-good，而设备实测证明
      // 那条路会把**含坏配置的快照**（崩溃那次启动建的）或**上一次安装的配置**写回，日志却是 ok。
      val known = knownGoodUsable(knownGoodId(context), knownGoodFp(context), installFingerprint(context))
      if (known == null) {
        record(
          context,
          "aborted no-known-good-for-this-install stored=" + (knownGoodId(context) ?: "none") +
            "/" + (knownGoodFp(context)?.take(12) ?: "none") + " current=" + (installFingerprint(context)?.take(12) ?: "none"),
        )
        return UndoResult(false, "本次安装尚未建立已知良好快照：不自动回滚（避免把旧版本配置写回）", null)
      }
      if (!snapshotExists(context, engine, known)) {
        record(context, "aborted known-good pruned id=" + known)
        return UndoResult(false, "已知良好快照已被轮转回收（" + known + "）：不自动回滚", null)
      }
      val out = runCli(context, engine, cli, dsh, listOf("restore", known))
      val ok = out.any { it.contains("完成：还原") }
      val summary = out.joinToString("\n")
      if (ok) {
        writeRetryMarker(context, failedIdentity, System.currentTimeMillis())
        record(context, "executed ok snapshot=" + (restoreTarget(out) ?: known) + " via=known-good")
      } else {
        Log.e(TAG, "auto-undo failed: " + summary)
        record(context, "executed failed exitSummary=" + summary.take(160).replace('\n', ' '))
      }
      // 0.13.1 W3：急救触发即镜像现场到共享目录（引擎循环崩溃导致用户完全无法取日志的场景）。
      engine.mirrorDiagnosticsToShared("undo-gate")
      return UndoResult(ok, summary, if (ok) restoreTarget(out) else null)
    } finally {
      armFile(context).delete()
      autoUndoRunning.set(false)
    }
  }

  /** 从 CLI 输出提取恢复目标快照 id；解析失败返回 null（不阻断）。 */
  private fun restoreTarget(lines: List<String>): String? {
    val m = lines.firstOrNull { it.contains("恢复快照") }?.let { line ->
      Regex("恢复快照 (\\S+)").find(line)
    }
    return m?.groupValues?.get(1)
  }

  /** 运行急救 CLI（节点为快照内的 node，DSH_HOME 指向壳私有 .dsh）。 */
  private fun runCli(
    context: Context,
    engine: EngineManager,
    cli: File,
    dsh: File,
    args: List<String>,
  ): List<String> {
    return try {
      val cmd = listOf(
        engine.usrDir.absolutePath + "/bin/node",
        cli.absolutePath,
      ) + args
      // #118 根因2（2026-09）：直接 exec app-data ELF 在 Android 15+ 恒 Permission denied
      // （error=13），auto-undo 因此从未真正执行。与 EngineManager.startWithArgs 同款：
      // 捕获 Permission denied 后降级经 /system/bin/linker64 加载（系统库加载机制对
      // app 数据永远放行）。
      fun build(argv: List<String>): ProcessBuilder = ProcessBuilder(argv).apply {
        environment().putAll(engine.shellEnv())
        environment()["DSH_HOME"] = dsh.absolutePath
        environment()["DSH_UNDO_ROOT"] = File(dsh, "undo-snapshots").absolutePath
        environment()["DSH_UNDO_PROFILE"] = "web"
        // 2026-08-23 真机实测：快照 node 编译期 openssl.cnf 路径为 /data/data/com.termux/...（不可读），
        // 缺失该覆盖时 Node 启动致命退出（OpenSSL config error）→ CLI 无输出 → 误判「无快照可回滚」，
        // 自动回退从未执行。显式指向快照内真实 cnf（与 shellEnv 的 SSL_CERT_FILE 同域）。
        environment()["OPENSSL_CONF"] = File(engine.usrDir, "etc/tls/openssl.cnf").absolutePath
        redirectErrorStream(true)
      }
      var proc: Process
      try {
        proc = build(cmd).start()
      } catch (e: java.io.IOException) {
        if (e.message?.contains("Permission denied") != true) throw e
        Log.w(TAG, "direct exec denied, falling back to linker64: " + e.message)
        proc = build(listOf("/system/bin/linker64") + cmd).start()
      }
      // 0.13.8 #173：有界读——CLI 挂起曾令 60s 守卫失效，且 execute 的 autoUndoRunning
      // 只在 finally 复位 → 恒「已在执行」，连看门狗 DEAD 支的强制重启都被锁死。
      // 超时分支显式复位标志与 arm 文件（幂等，防御未来再引入无界读）。
      val r = ProcIo.readBounded(proc, 60)
      if (r.timedOut) {
        proc.destroyForcibly()
        try { armFile(context).delete() } catch (_: Throwable) {}
        autoUndoRunning.set(false)
        return listOf(r.timeoutText("emergency CLI timeout"))
      }
      r.text.lines()
    } catch (t: Throwable) {
      Log.e(TAG, "emergency CLI run failed", t)
      listOf("emergency CLI failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** Clears a pending observation window after the engine becomes reachable. */
  fun disarm(context: Context) {
    armFile(context).delete()
  }

  /** 快照 id 形状：`yyyyMMdd-HHmmss-rrrr`（本地时间 + 4 位随机；字典序 = 时间序）。 */
  private val SNAPSHOT_ID = Regex("^20[0-9]{6}-[0-9]{6}-[0-9a-f]{4}$")

  private fun markerFile(context: Context) = markerFileIn(context.filesDir)
  private fun armFile(context: Context) = armFileIn(context.filesDir)
  private fun markerFileIn(dir: File) = File(dir, ".undo-auto-done")
  private fun armFileIn(dir: File) = File(dir, ".undo-auto-armed")

  /** 上次尝试执行的时刻（issue #1368）：成败都写，供 decide 退避。 */
  private fun attemptFileIn(dir: File) = File(dir, ".undo-auto-attempt")

  /**
   * 上次尝试执行的时刻（无则 null）。
   *
   * issue #1514：损坏时**不再删文件**——原子写本身是 REPLACE_EXISTING，预删毫无必要；旧实现
   * 「删掉 + 返回 now」让 tick1 判 SUPPRESS、tick2 已是 Missing ⇒ 退避只维持一拍，坏标记反而
   * 让回滚提前。现在把损坏解成「尝试过，时间取文件写入时刻」，于是退避按真实时间走完整个窗口，
   * 文件本身留着（下一次成功写入会原地覆盖，不留下「被清空」的中间态）。
   */
  private fun attemptAt(dir: File, nowMs: Long, notes: GateNotes, note: (String) -> Unit): Long? {
    val file = attemptFileIn(dir)
    val exists = file.exists()
    val mtime = if (exists) file.lastModified() else 0L
    val marker = attemptMarker(exists, readMarker(file), nowMs, mtime, notes.attemptCorruptSeenAt)
    return when (marker) {
      AttemptMarker.Missing -> null
      is AttemptMarker.Recorded -> {
        notes.attemptCorruptNoted = false
        marker.atMs
      }
      is AttemptMarker.Corrupt -> {
        if (!notes.attemptCorruptNoted) {
          notes.attemptCorruptNoted = true
          note("attempt marker corrupt (unparseable) — kept; backoff continues from at=" + marker.atMs)
        }
        notes.attemptCorruptSeenAt = marker.atMs
        marker.atMs
      }
    }
  }

  /** 尝试标记的解析结果（纯函数，JVM 单测直接钉）。 */
  internal sealed interface AttemptMarker {
    data object Missing : AttemptMarker
    data class Recorded(val atMs: Long) : AttemptMarker
    /**
     * 内容不可解析：**尝试确实发生过**，只是时间不可知（issue #1514）。
     * [atMs] 是本次可用的最佳线性估计——文件写入时刻；取不到时退回上一次观测到的时刻、再退回本拍。
     * 调用方把它当退避起点即可，**不得删文件**：下一拍仍要据此继续退避。
     */
    data class Corrupt(val atMs: Long) : AttemptMarker
  }

  /**
   * 解析尝试标记。
   *
   * 0 字节 / 半截内容的语义是「尝试过但时间不可知」，不是「没尝试过」——
   * 前者必须继续退避，后者才放行。半截值（例如 1700000000000 被截成 1700000000）也不能当成
   * 有效时间：那会让退避显示「早已过期」而立刻放行（#1508 的同款失效面）。
   *
   * @param exists 文件是否存在。
   * @param raw 文件内容（读失败时为 null）。
   * @param nowMs 本拍墙钟（区间校验与兜底起点）。
   * @param mtimeMs 文件写入时刻（0 = 拿不到）。
   * @param seenAtMs 上一次观测到的损坏起点（避免写入时刻拿不到时永久抑制）。
   */
  internal fun attemptMarker(
    exists: Boolean,
    raw: String?,
    nowMs: Long,
    mtimeMs: Long = 0L,
    seenAtMs: Long? = null,
  ): AttemptMarker = when {
    !exists -> AttemptMarker.Missing
    else -> decodeMarker(raw, nowMs)?.let { AttemptMarker.Recorded(it) }
      ?: AttemptMarker.Corrupt(corruptAttemptAt(mtimeMs, nowMs, seenAtMs))
  }

  /** 损坏标记的退避起点：写入时刻 → 上次观测 → 本拍（三级兜底，任何一级都不退化成「没有记录」）。 */
  private fun corruptAttemptAt(mtimeMs: Long, nowMs: Long, seenAtMs: Long?): Long =
    if (mtimeMs > 0L) writeTimeOrNow(mtimeMs, nowMs) else (seenAtMs ?: nowMs)

  private fun currentRetryIdentity(context: Context, engine: EngineManager?): RetryIdentity {
    val install = runCatching { installFingerprint(context)?.lowercase(java.util.Locale.ROOT) }.getOrNull() ?: "unavailable"
    val patchDigest = engine?.let { manager ->
      runCatching { PluginMounts.digest(PluginMounts.patchFile(manager).readText()) }.getOrNull()
    } ?: "unavailable"
    return RetryIdentity(install, patchDigest)
  }

  private fun writeRetryMarker(context: Context, identity: RetryIdentity, atMs: Long) {
    // issue #1515 同源：重试标记也是「临时文件 + 发布」，同样必须走唯一写入器（含降级与留痕），
    // 否则它在不支持 ATOMIC_MOVE 的文件系统上会静默写不进去，防循环窗口随之消失。
    val target = markerFile(context)
    val text = JSONObject().put("schema", 2).put("at", atMs)
      .put("installFingerprint", identity.installFingerprint)
      .put("patchDigest", identity.patchDigest).toString()
    try {
      writeAtomicText(target, text, note = { record(context, it) })
    } catch (t: Throwable) {
      record(context, "retry-marker write failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** Called only by an explicit user-requested engine restart; automatic retries keep the guard. */
  fun clearRetryEpochForUserRestart(context: Context) {
    runCatching { markerFile(context).delete() }
    runCatching { armFile(context).delete() }
    notes.suppressNoted = false
    // 用户显式重启同时重开一个干净的退避纪元（损坏标记的观测记录不得跨纪元延续）。
    notes.attemptCorruptSeenAt = null
    notes.attemptCorruptNoted = false
  }

  /** 壳侧确认过健康的那份快照 id（[noteHealthy] 写、[execute] 读）。 */
  private fun knownGoodFile(context: Context) = File(context.filesDir, ".undo-known-good")

  private fun retrySuppression(marker: File, identity: RetryIdentity, nowMs: Long): RetrySuppression = try {
    if (marker.isFile) retrySuppression(marker.readText(), identity, nowMs) else RetrySuppression(null, false)
  } catch (_: Throwable) { RetrySuppression(null, false) }

  data class UndoResult(val executed: Boolean, val summary: String, val snapshotId: String?)
}
