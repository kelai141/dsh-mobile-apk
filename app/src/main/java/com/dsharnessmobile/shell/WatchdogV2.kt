package com.dsharnessmobile.shell

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.io.File

/**
 * 看门狗升级（0.13.0 PRD F2/M3.4）：
 * - 深度探活：HTTP 状态码 + 页面心跳 + 插件状态（EngineProbe 扩展：/api/android/privilege/status
 *   可达表示插件树健康）+ 引擎日志尾部异常扫描（engine.log 末尾 fatal/Error 关键字）。
 * - 熔断与指数退避：连续失败 → 指数退避（5s→10s→20s→40s→80s 封顶），超过熔断阈值（12 次连续失败）
 *   暂停看门狗并记录（界面提示由 GuideChrome 状态区显示），用户交互或探活成功自动复位。
 * - 开机自启：BOOT_COMPLETED 接收器恢复用户上次同意的运行状态（EngineService.userShutdown 持久化）。
 * - 唤醒锁：**按活动持有**（0.14.10 §6.2，PARTIAL_WAKE_LOCK，标准档位；获取失败降级尽力模式并记录）。
 *   活动 = turn 在跑 / 控制请求在途 / 启动或重启窗口；空闲 60 秒主动放锁，有事件立刻重取。
 * - 授权状态探活：ADB 配对断线时记录（F2.9，桥引导重新配对由桥层返回）。
 */
object WatchdogV2 {

  private const val TAG = "dsh-watchdog"
  const val MAX_CONSEC_FAILURES = 12

  /** FX-212.3：标记文件消费偏移的 prefs 键（跨进程重启不重放历史标记）。 */
  private const val KEY_MARKER_OFFSET = "notify.markerOffset"

  /**
   * A slow HTTP response is distinct from a process that no longer accepts TCP.
   * 0.13.8 #175：DEGRADED 拆分病因——DEGRADED_HTTP = HTTP 失败但端口可连（半死，
   * 连续 N 拍升级为受控重启）；DEGRADED_LOG = HTTP 成功但日志异常签名（绝不触发重启，
   * 保留既有「重启会打断活动 turn」语义）。
   */
  enum class ProbeState { HEALTHY, DEGRADED_HTTP, DEGRADED_LOG, DEAD }

  /**
   * 标准拍长（0.14.10 §6.3）：所有阶梯阈值的时间单位。
   *
   * 为什么要有这个概念：审计点名「DEGRADED_SLOW_GRACE_TICKS 与阶梯拍数是按 5 秒拍标定的，
   * 降频时必须同步换算」，否则健康态退到 20 秒后，30 秒的阶梯会变成 120 秒。现在拍数常量
   * 一律按**标准拍（5 秒）**计，每拍按「实际经过的毫秒」折算成标准拍数记账（[tickUnits]），
   * 于是无论调度拍长是 5 秒还是 20 秒，恢复与熔断都落在同一个时间点。
   */
  const val STANDARD_TICK_MS = 5_000L

  /** 健康态探活间隔（0.14.10 §6.3）：审计要求 15–30 秒，取 20 秒。 */
  const val HEALTHY_TICK_MS = 20_000L

  /** 非健康态（DEGRADED_* / DEAD / 冷启动窗口）探活间隔：立刻回到原节奏。 */
  const val ACTIVE_TICK_MS = 5_000L

  /** DEGRADED_HTTP 阶梯阈值：6 个标准拍 = 30 秒（时间语义，见 [STANDARD_TICK_MS]）。 */
  const val DEGRADED_RESTART_CONFIRMATIONS = 6

  /** 阶梯到点的时间口径（毫秒）：30 秒。降频不得改变它。 */
  const val DEGRADED_RESTART_AFTER_MS = DEGRADED_RESTART_CONFIRMATIONS.toLong() * STANDARD_TICK_MS

  /**
   * 「慢」的宽限拍数（issue #274 ①）：slowProbe 否决破坏性动作的**上界**。
   *
   * 为什么需要上界而不是无条件否决：真机上半死引擎的探活形态也是超时，与长 turn 的单次观测
   * 无法区分；无条件否决会让真卡死的引擎永远救不回来（破坏 0.14.1 锁存盲区回归）。
   * 3 倍阶梯 = 18 个标准拍 = 90 秒，与 START_COOLDOWN_MS 的冷启动预算同量级。
   */
  const val DEGRADED_SLOW_GRACE_TICKS = DEGRADED_RESTART_CONFIRMATIONS * 3

  /** 慢宽限的时间口径（毫秒）：90 秒。降频不得改变它。 */
  const val DEGRADED_SLOW_GRACE_AFTER_MS = DEGRADED_SLOW_GRACE_TICKS.toLong() * STANDARD_TICK_MS

  /** 熔断阈值的时间口径（毫秒）：12 个标准拍 = 60 秒。降频不得改变它。 */
  const val CIRCUIT_OPEN_AFTER_MS = MAX_CONSEC_FAILURES.toLong() * STANDARD_TICK_MS

  /**
   * 单拍最多折算多少个标准拍（= 阶梯阈值 6）。
   *
   * 为什么要封顶：设备深睡/Doze 之后一拍可能隔了几分钟，若按真实间隔折算，单次观测就能
   * 直接顶满熔断（12 拍）——熔断守的是「**反复**失败」，一次观测不该有那个权限。封到阶梯
   * 阈值处，则最多「一拍走完阶梯」，恢复仍会立即发生，只是不跳步打开熔断。
   */
  const val MAX_TICK_UNITS = DEGRADED_RESTART_CONFIRMATIONS

  /**
   * 纯函数（0.14.10 §6.3）：本拍实际经过的毫秒 → 折算成多少个标准拍（5 秒）。
   *
   * 四舍五入而不是向下取整：20 秒拍折 4 个标准拍，12.5 秒折 3 个，5 秒拍恒为 1（不因调度
   * 抖动掉成 0，否则阶梯永远凑不满）。0 或负值（首拍/时钟回退）按 1 拍处理。
   */
  fun tickUnits(elapsedMs: Long): Int {
    if (elapsedMs <= 0L) return 1
    val rounded = (elapsedMs + STANDARD_TICK_MS / 2) / STANDARD_TICK_MS
    return rounded.coerceIn(1L, MAX_TICK_UNITS.toLong()).toInt()
  }

  /**
   * 纯函数（0.14.10 §6.3）：下一拍该隔多久。
   *
   * 只有「引擎健康且不在冷启动窗口」才用 [HEALTHY_TICK_MS]；一旦 DEGRADED_* / DEAD / 冷启动，
   * 立刻回到 [ACTIVE_TICK_MS]——恢复动作必须以 5 秒拍去跟，否则 30 秒的阶梯会被拖成长尾。
   */
  fun nextTickDelayMs(state: ProbeState, booting: Boolean = false): Long =
    if (state == ProbeState.HEALTHY && !booting) HEALTHY_TICK_MS else ACTIVE_TICK_MS

  /** 引擎日志尾部签名：插件树装配失败（`plugin tree failed to load`）。 */
  const val SIGNATURE_PLUGIN_TREE = "plugin-tree"

  /** 引擎日志尾部签名：其它未捕获异常（不参与升级，保留「HTTP 活着就不打扰」语义）。 */
  const val SIGNATURE_UNCAUGHT = "uncaught"

  @Volatile
  var consecutiveFailures = 0
    private set

  @Volatile
  var consecutiveDegradedHttp = 0
    private set

  /**
   * 插件树装配失败的连续拍数（2026-09-21 新增）。
   *
   * 为什么必须单独立账：`DEGRADED_LOG` 原来在 `planTick` 里**直接早退 IDLE**（HTTP 活着就不打扰），
   * 于是「插件树 failed to load」这条形态既没有阶梯、也永远求值不到 `undoReady()`——设备实测
   * （注入坏插件 → 重启引擎）：引擎 HTTP 活着但插件树挂死，`undo-gate.log` 里连 arm 都没有，
   * 用户只能手动重启。装配失败与「活动 turn 里炸了一次」是两回事，前者必须能自救。
   */
  @Volatile
  var consecutivePluginTreeFailures = 0
    private set

  /** 最近一次探活读到的日志签名（[assessProbe] 写、[recordProbe]/[planTick] 读）。 */
  @Volatile
  private var lastLogSignature: String? = null

  /**
   * 退避阶梯（纯函数，JVM 单测）：5s → 10s → 20s → 40s → 80s 封顶。
   * #210.2：入参必须是 [effectiveFailureCount]（半死与 DEAD 共用计数）。只读
   * `consecutiveFailures` 时 DEGRADED_HTTP 恒 5s——与 [tripped] 的熔断口径自相矛盾。
   */
  fun delayForFailureCount(count: Int): Long {
    val n = (count - 1).coerceAtLeast(0).coerceAtMost(4)
    return (5_000L shl n).coerceAtMost(80_000L)
  }

  /** Exponential delay for destructive recovery attempts (death or half-dead ladder). */
  fun nextDelayMs(): Long = delayForFailureCount(effectiveFailureCount())

  /**
   * 记一拍探活结果（0.14.10 §6.3：计数单位是**标准拍**，不是「调度拍」）。
   *
   * [units] = [tickUnits] 折算出来的标准拍数：健康态 20 秒一拍折 4 个，进 DEGRADED 后 5 秒
   * 一拍折 1 个。于是「6 个标准拍 = 30 秒」这条阶梯语义与调度频率完全解耦。
   */
  fun recordProbe(state: ProbeState, signature: String? = lastLogSignature, units: Int = 1) {
    val u = units.coerceAtLeast(1)
    consecutiveFailures = if (state == ProbeState.DEAD) consecutiveFailures + u else 0
    consecutiveDegradedHttp = nextDegradedCount(state, consecutiveDegradedHttp, u)
    consecutivePluginTreeFailures = nextPluginTreeCount(state, signature, consecutivePluginTreeFailures, u)
  }

  /** 纯函数（JVM 单测）：DEGRADED_HTTP 按标准拍自增，其余状态清零。 */
  fun nextDegradedCount(state: ProbeState, count: Int, units: Int = 1): Int =
    if (state == ProbeState.DEGRADED_HTTP) count + units.coerceAtLeast(1) else 0

  /** 纯函数（JVM 单测）：**只认**插件树签名（不跟 DEGRADED_LOG 整类计数，见字段注释）。 */
  fun nextPluginTreeCount(state: ProbeState, signature: String?, count: Int, units: Int = 1): Int =
    if (pluginTreeHung(state, signature)) count + units.coerceAtLeast(1) else 0

  /** 纯函数：是否「插件树挂死」（HTTP 活着但 loader entry 导入失败）。 */
  fun pluginTreeHung(state: ProbeState, signature: String?): Boolean =
    state == ProbeState.DEGRADED_LOG && signature == SIGNATURE_PLUGIN_TREE

  /** 熔断与退避共用同一计数（#175：半死阶梯与 DEAD 共用退避，防重启风暴）。 */
  fun effectiveFailureCount(): Int = maxOf(consecutiveFailures, consecutiveDegradedHttp, consecutivePluginTreeFailures)

  fun tripped(): Boolean = effectiveFailureCount() >= MAX_CONSEC_FAILURES

  fun degradedHttpTripped(): Boolean = consecutiveDegradedHttp >= DEGRADED_RESTART_CONFIRMATIONS

  fun reset() {
    consecutiveFailures = 0
    consecutiveDegradedHttp = 0
    consecutivePluginTreeFailures = 0
    lastLogSignature = null
    lastProbeTimedOut = false
    lastLogTail = ""
    healthyLogMark = 0L
  }

  /**
   * Classifies liveness without treating a temporary HTTP stall or a historical
   * log line as proof of process death. A live port is degraded because the UI
   * may be slow, but restarting it would interrupt the active turn.
   *
   * 只做分类，不承担副作用（#210.4）：标记消费由 [planTick] 的前置段在**任何状态**下
   * 统一执行——挂在 HEALTHY 分支尾部正是「DEGRADED_LOG 早退吞掉消费」的成因。
   */
  /**
   * 引擎日志尾部的**强证据签名**（issue #274 ①）：只有这些才支持「破坏性自愈」。
   *
   * 真因：`assessProbe` 在 HTTP 超 2.5s 预算时给 DEGRADED_HTTP（注释自承实测出现过 3061ms）。
   * 长 turn / 慢磁盘足以让一次探活超预算 ⇒ 连续 6 拍（30s）即升级为「受控重启」，
   * 而那条路径**会回滚用户配置并强杀活引擎**。一次慢响应不该有这种权限。
   *
   * 判据（命中任一条 = 有强证据，才允许跑破坏性阶梯）：
   *  - `EADDRINUSE`：端口被别人占着（我们自己起不来，等下去也不会好）；
   *  - `plugin tree failed to load`：插件树装配失败（引擎没起来，不会自愈）；
   *  - `UncaughtException`：未捕获异常（进程已不可信）。字面量与 [logSignatureOf] 同一份 ——
   *    旧接线实际只可能命中签名，故这里不得放宽成「任何含 uncaught 的行」（2026-10-26 评审：
   *    4KB 尾部里引擎/插件的普通日志也会出现该字样，放宽等于让无关行解除慢探活否决）。
   *
   * **反向要求**：`reset()` 不得因此类证据缺失而破坏既有坑 153 的语义——半死引擎的 undo/
   * 重启必须仍能生效。故本判据只否决**破坏性**阶梯（DEGRADED_HTTP → 重启/回滚），
   * 不影响 DEAD 判定（进程真的没了是硬事实，不看日志）。
   */
  internal fun strongEvidenceForDestructiveRecovery(logTail: String?): Boolean {
    if (logTail.isNullOrEmpty()) return false
    return logTail.contains("EADDRINUSE")
      || logTail.contains("plugin tree failed to load")
      || logTail.contains("UncaughtException")
  }

  /**
   * 端口是否**不是**被本进程持有（issue #274 ① 的第二条判据）。
   *
   * 用途：DEGRADED_HTTP（端口可连但 HTTP 失败）有两种成因——① 我们自己半死（该救）；
   * ② 端口被**别的**进程占着（我们把别人的服务当成了自己的引擎，重启我们毫无用处，
   * 只会强杀活引擎 + 回滚用户配置）。`EADDRINUSE` 是 ② 的日志形态；
   * 拿不到进程归属时保守返回「可能是本进程」（不因测量失败而放宽破坏性动作）。
   */
  internal fun portOwnedByOtherProcess(portOwnedByApp: Boolean?): Boolean = portOwnedByApp == false

  /**
   * 最近一次探活是否**超时**（而非连接被拒）。
   *
   * 为什么必须区分（issue #274 ①）：HTTP 超 2.5s 预算 = 「引擎在忙 / 磁盘慢」，
   * 而连接被拒 = 端口根本没开 = 引擎真的不在。前者绝不该成为回滚用户配置的理由。
   * 实测出现过 3061ms 的一次超预算（本文件注释自承），单靠拍数无法区分这两者。
   */
  @Volatile
  var lastProbeTimedOut = false
    private set

  /**
   * 最近一次探活读到的引擎日志尾部原文（[assessProbe] 写、证据面读）。
   *
   * 为什么保留原文而不只保留签名：回滚的证据门要判 `EADDRINUSE` 这类**具体**形态，
   * 而签名会把它们压成 `uncaught`/`plugin-tree` 之外的 null。原文让判据可扩展、可诊断。
   */
  @Volatile
  var lastLogTail: String = ""
    private set

  /**
   * 上一次 HEALTHY 探活时 engine.log 的长度（[assessProbe] 写、[readEngineLogTail] 读）。
   *
   * 为什么需要（2026-10-26 评审）：同一代日志可以**先**出现 EADDRINUSE、随后引擎换临时端口
   * 重试成功转 HEALTHY（`EngineManager` 的 spawn 前预探活只有 300ms 快照，端口在其后被抢即此
   * 形态），那句 EADDRINUSE 会留在 4KB 窗口里直到再写约 4KB。若此后一次长 turn 让探活超时，
   * 陈旧的 EADDRINUSE 会把「解除慢探活否决」提前到 30 秒，强杀一个健康但忙的引擎——正是
   * #274 要挡的形态。故证据只认**上一次健康点之后**写入的字节。
   */
  @Volatile
  private var healthyLogMark: Long = 0L

  /**
   * 纯函数（JVM 单测）：证据窗口的起点。
   *
   * [mark] 落在 `[0, len]` 内即按水位截断（等于 len 表示健康点之后没有新字节，窗口为空）；
   * 超过当前长度说明日志被轮转或重建，整份都算新的，退回常规尾部窗口。
   */
  internal fun tailWindowStart(len: Long, cap: Int, mark: Long): Long {
    if (len <= 0L) return 0L
    val start = if (mark in 0..len) mark else 0L
    return maxOf(len - cap.toLong(), start)
  }

  /**
   * 纯函数（JVM 单测）：健康水位推进。
   *
   * 只有 HEALTHY 才把水位抬到当前长度；文件变短（轮转/重建）一律跟到新长度，避免水位停在
   * 旧文件的大小上，让证据窗口永远读不到东西。
   */
  internal fun nextHealthyLogMark(state: ProbeState, len: Long, mark: Long): Long = when {
    len < 0L -> mark
    state == ProbeState.HEALTHY -> len
    len < mark -> len
    else -> mark
  }

  fun assessProbe(context: Context, callerCurrent: () -> Boolean = { true }): ProbeState {
    if (!callerCurrent()) return ProbeState.DEAD
    val probe = EngineProbe.check(2_500)
    if (!callerCurrent()) return ProbeState.DEAD
    // 「超时」与「拒绝」是两种病因：前者是慢，后者是死。记下来供证据面使用。
    lastProbeTimedOut = probe.optString("error", "") == "timeout"
    // 日志尾部**必须在任何早退之前读**：证据门关心的正是 DEGRADED_HTTP 这一支
    // （它就在下面那个 `if (!base)` 里提前返回）。旧写法把读取放在健康分支之后，
    // 于是最需要证据的时刻 lastLogTail 恒为空 —— 判据形同虚设。
    val tail = readEngineLogTail(context)
    if (!callerCurrent()) return ProbeState.DEAD
    lastLogTail = tail.text
    lastLogSignature = logSignatureOf(tail.text)
    val base = probe.optBoolean("running", false)
    val state = when {
      !base -> if (EngineProbe.portReachable(1_000)) ProbeState.DEGRADED_HTTP else ProbeState.DEAD
      lastLogSignature != null -> ProbeState.DEGRADED_LOG
      else -> ProbeState.HEALTHY
    }
    if (state == ProbeState.DEGRADED_LOG) {
      LogCollector.log(TAG, "engine log reports a recoverable warning while HTTP remains alive: " + lastLogSignature)
    }
    // 健康点推进证据水位：此前的字节不再充当破坏性动作的理由（见 [healthyLogMark]）。
    healthyLogMark = nextHealthyLogMark(state, tail.length, healthyLogMark)
    return state
  }

  /**
   * 一拍看门狗的决策。#210.3 / #210.4（源文档 §3.3 B1 顺序约束第 1 条）：
   * 三个状态无关副作用（onEngineProbe 更新回退确认、标记消费、唤醒锁续期）在
   * **任何分支早退之前**执行——含 [tripped] 熔断打开的那一拍；否则 12 拍之后
   * 所有修复都被熔断早退吞掉。调用方（EngineService）只按返回值执行破坏性动作。
   */
  internal fun planTick(
    state: ProbeState,
    now: Long,
    nextRestartAllowedAt: Long,
    engineReady: Boolean,
    engineProcessAlive: Boolean,
    bootAgeMs: Long,
    restartDeadConfirmations: Int,
    startCooldownMs: Long = EngineManager.START_COOLDOWN_MS,
    /** 本拍的引擎日志签名（[assessProbe] 写、这里读；测试显式传，避免为测试在生产面留钩子）。 */
    logSignature: String? = lastLogSignature,
    /**
     * 本拍的引擎日志**原文尾部**（[assessProbe] 写、这里读）。强证据门（#274 ②）必须喂原文：
     * 签名只有 `"plugin-tree"`/`"uncaught"`/null 三态，EADDRINUSE 连签名都不产生——2026-10-25
     * 审计实锤旧接线把签名喂给了 [strongEvidenceForDestructiveRecovery]，三个证据分支死了两个
     * （仅 uncaught 因同名子串侥幸存活），单测直接喂原文的用例全绿掩盖了接线错误。
     */
    logTail: String = lastLogTail,
    /**
     * 端口是否归本应用持有（issue #274 ①）。null = 未知（不否决）。
     * 生产面由 EngineService 从进程归属算出；JVM 测试直接传值。
     */
    portOwnedByApp: Boolean? = null,
    /**
     * 本次探活是否**超时**（=引擎在忙/磁盘慢），而非连接被拒（=真的死）。
     * 默认取 [lastProbeTimedOut]；测试可显式注入。
     */
    slowProbe: Boolean = lastProbeTimedOut,
    feedProbe: (Boolean) -> Unit,
    consumeMarkers: () -> Unit,
    refreshWake: () -> Unit,
    undoReady: () -> Boolean,
    callerCurrent: () -> Boolean = { true },
    /**
     * 本拍折算成多少个标准拍（0.14.10 §6.3）。生产面传 [tickUnits] 的换算结果；JVM 测试
     * 不传即 1（= 经典 5 秒拍），既有用例语义不变。
     */
    units: Int = 1,
  ): TickPlan {
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    // ── 前置副作用（#210.3/#210.4）：与状态分类无关，先于一切早退 ──
    feedProbe(state == ProbeState.HEALTHY)
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    recordProbe(state, logSignature, units)
    consumeMarkers()
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)
    refreshWake()
    if (!callerCurrent()) return TickPlan(TickAction.HOLD)

    val logs = ArrayList<String>(2)
    val degradedLadderTripped = state == ProbeState.DEGRADED_HTTP && degradedHttpTripped()
    val alive = state != ProbeState.DEAD
    if (degradedLadderTripped) {
      // 计数单位是标准拍（5 秒），故这里同时给出秒数——降频后「拍」的字面量会误导排障。
      logs += "DEGRADED_HTTP 连续 " + consecutiveDegradedHttp + " 个标准拍（约 " +
        (consecutiveDegradedHttp.toLong() * STANDARD_TICK_MS / 1000L) + "s；端口可连但 HTTP 持续失败）→ 升级为受控重启"
    }
    // 【issue #274 ①】破坏性动作的证据门。**本条只作用于「强杀一个还活着的进程」这一件事**
    // （下面的 RESTART 分支），不拦 undo、也不拦「重启一个已经死掉的进程」。
    //
    // 为什么不能拿「日志里没有强证据」当否决理由：logSignature 只在与已知签名（插件树失败/
    // uncaught）匹配时才非空，**其常态就是 null**（生产也一样）。拿它做前提会让半死引擎
    // 永久救不回来，直接破坏 0.14.1 的锁存盲区回归（halfDeadEngineStillReachesUndo…）——
    // 那条防线要求「托管进程活着但 HTTP 永不健康」时 undo 仍能在预算用尽后介入。
    //
    // 因此判据取**正向证据**（指认「是慢、不是死」或「占着端口的不是我们」），而不是
    // 「缺少证据」：
    //   · [slowProbe]：本次探活**超时**（引擎在忙 / 磁盘慢）⇒ 它可能就是没死，先不动它；
    //   · 端口**由他进程持有** ⇒ 重启我们不解决问题（该处理的是那个占用者）——这条**无上界**（它是硬事实）。
    // 注意 `error=refused`（端口没开）**不算**慢——那是真的死，必须能走恢复流程。
    val portForeign = portOwnedByOtherProcess(portOwnedByApp)
    // 「慢」的否决是**有界宽限**，不是永久封锁 —— 这一点是刻意的，理由如下：
    //
    // 真机上半死引擎（进程在、HTTP 永远不健康）的探活形态**同样是超时**，与「长 turn 导致的
    // 慢」在单次观测里无法区分。若把 slowProbe 做成无条件否决，就再也救不回真正卡死的引擎，
    // 直接破坏 0.14.1 锁存盲区回归（halfDeadEngineStillReachesUndo…：它要求托管进程存活时
    // undo 仍能在预算用尽后介入）——那是**生产语义**，不是测试注入口径。
    //
    // 所以宽限只覆盖「比常态阶梯长得多」的一段：阶梯 6 拍（30s）到达时先不动手，
    // 继续观察；慢若持续到 [DEGRADED_SLOW_GRACE_TICKS] 拍（= 3 倍阶梯，约 90s）仍无改善，
    // 视为真卡死，放行破坏性动作。这既消掉 #274 的「30s 慢响应就回滚」，又不制造死局。
    val slowGraceExhausted = consecutiveDegradedHttp >= DEGRADED_SLOW_GRACE_TICKS
    // 强证据（EADDRINUSE / 插件树装配失败 / uncaught）**解除**「慢」这条否决：
    // 它把「探活超时」从「可能只是在忙」变成「确知引擎坏了」。
    // 注意方向——证据是**放行**的理由，不是**前置条件**（后者会挡掉必需的第 6 拍，见上）。
    // 必须喂 logTail 原文而非 logSignature（签名三态折叠会饿死 EADDRINUSE/插件树两个分支）。
    val strongEvidence = strongEvidenceForDestructiveRecovery(logTail)
    // 两组条件作用面不同，故用「或」：
    //  · portForeign：监听者不是我们 ⇒ **任何**恢复动作都不解决问题（含子进程已死时盲目重启）；
    //  · slowProbe：探活只是超时，但**只有在我们确实托管着一个活进程时**才谈得上「别强杀它」；
    //    子进程已死时重启它不具破坏性，不该被这条拦住。
    val destructiveBlocked = degradedLadderTripped &&
      (portForeign || (engineProcessAlive && slowProbe && !slowGraceExhausted && !strongEvidence))
    // DEGRADED_LOG 保留「绝不重启」语义：HTTP 存活时重启会打断活动 turn。
    // **例外：插件树装配失败**（[pluginTreeHung]）。那一刻引擎没起来，且不会自愈——设备实测
    // （2026-09-21，注入坏插件后重启）：本行早退 IDLE ⇒ 自动 undo 永不被求值（调用方还会在 IDLE
    // 拍 disarm），用户只剩手动重启。放行到 undo 决策后，配置回滚才有机会把坏插件剔出去。
    if (alive && !degradedLadderTripped && !pluginTreeHung(state, logSignature)) {
      return TickPlan(TickAction.IDLE)
    }
    if (!engineReady) return TickPlan(TickAction.HOLD)
    // 「confirmed-dead sample」这一档是给**进程死亡**留的观察期；插件树挂死形态下 consecutiveFailures
    // 恒为 0（那是 DEAD 专用计数），不放行的话这里会永远 HOLD，undo 决策同样到不了。
    if (!degradedLadderTripped && !pluginTreeHung(state, logSignature) &&
      consecutiveFailures < restartDeadConfirmations) {
      return TickPlan(
        TickAction.HOLD,
        listOf("confirmed-dead sample " + consecutiveFailures + "/" + restartDeadConfirmations + "; observing before restart"),
      )
    }
    // 冷启动预算内的托管子进程：任何破坏性动作（含配置回滚）都推迟到它用满预算之后，
    // 避免把「还在冷启动」误判成「起不来」。
    if (engineProcessAlive && bootAgeMs in 0 until startCooldownMs) {
      return TickPlan(TickAction.HOLD, logs + "dead probe deferred while the tracked child remains inside its boot window")
    }
    // ── undo 必须先于熔断锁存（0.14.1 修复的锁存盲区）────────────────────────
    // 缺陷形态（存量，非本迭代引入）：[tripped] 曾排在本分支之前，而它一旦为真即**永久** HOLD，
    // 只有 HEALTHY 探活能解（[recordProbe] 在健康拍把三个计数清零）。生产面没有任何
    // `WatchdogV2.reset()` 调用点：那个函数只给 JVM 单测清场用。而熔断在
    // effectiveFailureCount >= 12 时打开（12 拍 x 5s = 60s），却小于 START_COOLDOWN_MS = 90s 的
    // 启动预算——于是「托管子进程仍存活、但 HTTP 永远不健康」（半死引擎 / 插件树挂住）这条路径上，
    // 计数器先撞满 12，本函数此后**再也不会求值 undoReady()**：自动 undo 与自动重启同时永久失效。
    // 配置回滚（undo）与「禁止盲目重启」（熔断）是两种正交的恢复手段，不应互斥：先给 undo 机会，
    // 熔断继续守它该守的「undo 不可用时不得盲目反复重启」。反向对照见 WatchdogLadderTest 的
    // circuitBreakerStillBlocksBlindRestartWhenUndoIsUnavailable。
    // 【issue #274 ①】破坏性动作的证据门（**位于 undo 之前**，因为 undo 也会回滚用户配置，
    // 那正是本 issue 要收窄的对象之一）。
    //
    // 只在「托管进程还活着」时才可能误伤——进程已死时下面任何动作都只是恢复，不是破坏。
    // 判据取**正向证据**（指认「是慢、不是死」或「占端口的不是我们」）：
    //   · [slowProbe]：本次探活超时（引擎在忙/磁盘慢）⇒ 它没死，掐掉它是 #274 的靶子；
    //   · 端口由他进程持有 ⇒ 重启/回滚我们都不解决问题。
    // **不得**用「日志里没有强证据」当否决理由：logSignature 常态就是 null（只在与插件树失败 /
    // uncaught 匹配时非空），拿它做前提会把半死引擎永久锁死，破坏 0.14.1 的锁存盲区回归。
    if (destructiveBlocked) {
      return TickPlan(
        TickAction.HOLD,
        logs + if (portForeign)
          "destructive recovery withheld: the listening port belongs to another process; restarting us cannot help"
        else
          "destructive recovery withheld: the probe timed out (slow engine/disk), not a dead engine"
      )
    }
    if (undoReady()) {
      return TickPlan(TickAction.UNDO, logs + ("auto-undo trigger after confirmed failures=" + effectiveFailureCount()))
    }
    // 熔断守的是「undo 不可用时不得盲目反复重启」。插件树挂死是例外：此时 undo 可能被 30 分钟重试窗
    // 闸掉，若再被熔断锁进 HOLD，就再也没有任何自动路径（引擎不会自愈、也永远等不到 HEALTHY 去解锁）
    // ——只剩手动重启。放行重启（仍受退避节流）比锁死好；坏配置下次启动照旧失败，但至少不是死局。
    if (tripped() && !pluginTreeHung(state, logSignature)) {
      return TickPlan(TickAction.HOLD, logs + "watchdog circuit open after confirmed-dead failures; destructive recovery paused")
    }
    if (now < nextRestartAllowedAt) {
      return TickPlan(TickAction.HOLD, logs + ("restart deferred for " + (nextRestartAllowedAt - now) + "ms"))
    }
    return TickPlan(TickAction.RESTART, logs, force = engineProcessAlive)
  }

  /** watchdog 一拍的恢复动作（#210.2/.3/.4）。 */
  enum class TickAction {
    /** 存活且未触发半死阶梯：调用方复位重启窗口并解除 undo 观察。 */
    IDLE,
    /** 本拍不动作（未就绪 / 观察窗 / 熔断打开 / 启动冷却 / 重启节流）。 */
    HOLD,
    /** 触发配置层急救回撤（UndoGate）。 */
    UNDO,
    /** 请求受控重启（force = 托管子进程仍在场，须换进程）。 */
    RESTART,
  }

  /** [planTick] 的决策结果；[logs] 为本次 tick 应写入 dsh-watchdog 的结构化行。 */
  data class TickPlan(
    val action: TickAction,
    val logs: List<String> = emptyList(),
    val force: Boolean = false,
  )

  /** Compatibility projection for callers that only need a strict HTTP health bit. */
  fun deepProbe(context: Context): Boolean = assessProbe(context) == ProbeState.HEALTHY

  /** 会话短哈希（D14：标题缺失时的可区分回落，非字面量）。 */
  private fun markerTag(sessionId: String): String {
    if (sessionId.isEmpty()) return "未知"
    return (sessionId.hashCode() and 0x7fffffff).toString(16).padStart(6, '0').takeLast(6)
  }

  /** 引擎事件桥标记文件（dsh-android-bridge 写入 home/.dsh/.task-done.ndjson；经 context 推导）。 */
  private fun taskMarkerFile(context: Context): java.io.File =
    java.io.File(File(context.filesDir, "home/.dsh"), ".task-done.ndjson")

  /** 标记文件消费偏移（FX-212.3：按字节推进；-1 = 尚未从 prefs 装载）。 */
  @Volatile
  private var markerOffset = -1L

  /** 单次读取上限（与 OverlayLiveFeed / NotifyStore 同口径：行边界在 CAP 内，溢出留到下一轮）。 */
  internal val markerReadCapBytes: Int = 256 * 1024

  /** §6.4：标记消费的调试日志文件（受开发者日志开关门控；到上限滚一代）。 */
  internal const val MARKER_DEBUG_FILE = "notify-debug.log"

  /** §6.4：调试日志容量上限（512 KiB，滚一代 .1；总量因此被钉在 1 MiB 以内）。 */
  internal const val MARKER_DEBUG_LIMIT_BYTES = 512L * 1024

  /** §6.4：调试日志的一次写盘处置。 */
  internal enum class MarkerDebugStep { APPEND, ROTATE, SKIP }

  /**
   * §6.4 纯函数（JVM 单测）：本次调试日志该写、该滚、还是该跳过。
   *
   * 两重收敛：① 开发者日志开关（默认关）关着就完全不写；② 开着也有容量上限，
   * 到上限滚一代而不是无限追长——审计原文的「没有轮转上限，没有开关」两条都在这里堵住。
   */
  internal fun markerDebugStep(
    enabled: Boolean,
    currentBytes: Long,
    limitBytes: Long = MARKER_DEBUG_LIMIT_BYTES,
  ): MarkerDebugStep = when {
    !enabled -> MarkerDebugStep.SKIP
    currentBytes >= limitBytes -> MarkerDebugStep.ROTATE
    else -> MarkerDebugStep.APPEND
  }

  /**
   * §6.4：调试日志是否开启——复用仓里既有的开发者日志开关（MainActivity.DevLogPrefs，
   * 默认 false，同一条偏好也门控 LogCollector 采集器），不另造一套开关。
   *
   * 读失败按关闭处理：诊断日志写不写都不该影响标记消费，失败静默降级为「不写」。
   */
  internal fun devLogEnabled(context: Context): Boolean = try {
    MainActivity.DevLogPrefs.isEnabled(context)
  } catch (_: Throwable) {
    false
  }

  /** 消费窗口的纯函数结果：[lines] 整行；[advance] 本次可推进的字节数（到最后一个换行符）。 */
  internal data class MarkerWindow(val lines: List<String>, val advance: Long)

  /**
   * FX-212.3（纯函数，JVM 单测）：从一个读取窗口里取出**整行前缀**。
   * 没有换行（半行）时 advance=0 —— 偏移不推进，等下一拍补齐；多字节被截断的尾字符同理自然消失。
   * 旧实现 readLines() + writeText("") 的三态缺陷（读-清窗口吞行、清零窗口重复投递、无界读）
   * 都靠「只推进整行 + 从不截断」这一条消掉。
   */
  internal fun markerConsumeWindow(payload: ByteArray, length: Int): MarkerWindow {
    val n = length.coerceAtMost(payload.size)
    var last = -1
    var i = n - 1
    while (i >= 0) {
      if (payload[i] == '\n'.code.toByte()) { last = i; break }
      i--
    }
    if (last < 0) return MarkerWindow(emptyList(), 0L)
    val lines = ArrayList<String>()
    for (piece in String(payload, 0, last, Charsets.UTF_8).split("\n")) {
      val t = piece.trim()
      if (t.isNotEmpty()) lines.add(t)
    }
    return MarkerWindow(lines, (last + 1).toLong())
  }

  private fun markerOffsetOf(context: Context): Long {
    if (markerOffset < 0) markerOffset = NotifyCenter.prefs(context).getLong(KEY_MARKER_OFFSET, 0L)
    return markerOffset
  }

  private fun markerOffsetTo(context: Context, value: Long) {
    markerOffset = value
    try {
      NotifyCenter.prefs(context).edit().putLong(KEY_MARKER_OFFSET, value).apply()
    } catch (_: Exception) {
      // prefs 写失败只损「重启后偏移」，不影响本轮消费
    }
  }

  /**
   * 消费任务完成标记（FX-212.3，按偏移推进；**不再截断文件**）。
   *
   * 为什么偏移要落 prefs（对计划口径的唯一增补）：只放内存时，进程每次重启 offset 归零 →
   * 「新壳 + 老引擎」组合（没有 .notify.ndjson，双读不双发门永不置位）会把历史标记**重复通知**一遍；
   * 落 prefs 后：离线期间写入的标记仍会被消费（保留原语义），重启不重放。
   *
   * #210.4：由 [planTick] 的前置段调用——HEALTHY/DEGRADED_HTTP/DEGRADED_LOG/DEAD 四态都要消费。
   */
  internal fun consumeTaskDoneMarkers(context: Context) {
    // §6.4（0.14.10）：调试日志收进既有开发者日志开关（MainActivity.DevLogPrefs，默认关），
    // 并给文件加了容量上限。此前是**无条件** appendText：每拍至少两行、有标记时每行再两条，
    // 无轮转、无开关——审计点名它是纯噪音写入。
    //
    // 开关只影响这条日志，**消费逻辑一行都没动**（下面的解析、去重、通知投递、偏移推进全在）。
    val debugLogOn = devLogEnabled(context)
    fun dbg(msg: String) {
      try {
        val file = java.io.File(context.filesDir, MARKER_DEBUG_FILE)
        when (markerDebugStep(debugLogOn, if (file.exists()) file.length() else 0L)) {
          MarkerDebugStep.ROTATE -> {
            // 有界：到上限就滚一代（旧 .1 先删，不累积历史）。
            val rotated = java.io.File(context.filesDir, MARKER_DEBUG_FILE + ".1")
            try { if (rotated.exists()) rotated.delete() } catch (_: Exception) {}
            try { file.renameTo(rotated) } catch (_: Exception) {}
          }
          MarkerDebugStep.APPEND -> Unit
          MarkerDebugStep.SKIP -> return
        }
        file.appendText(System.currentTimeMillis().toString() + " " + msg + "\n")
      } catch (_: Exception) {
      }
    }
    try {
      val f = taskMarkerFile(context)
      if (!f.exists()) return
      val len = f.length()
      var offset = markerOffsetOf(context)
      if (len < offset) {
        // 文件被轮转/重建（旧 truncate 语义或外部清理）：偏移归零重新读
        dbg("marker shrunk: len=" + len + " offset=" + offset + " -> 0")
        markerOffsetTo(context, 0L)
        offset = 0L
      }
      if (len == offset) return
      var window = MarkerWindow(emptyList(), 0L)
      try {
        java.io.RandomAccessFile(f, "r").use { raf ->
          val want = (len - offset).coerceAtMost(markerReadCapBytes.toLong()).toInt()
          val buf = ByteArray(want)
          raf.seek(offset)
          val read = raf.read(buf)
          if (read > 0) window = markerConsumeWindow(buf, read)
        }
      } catch (e: Exception) {
        dbg("marker read failed: " + (e.message ?: e.javaClass.simpleName))
        return
      }
      dbg("marker window: len=" + len + " offset=" + offset + " consumedBytes=" + window.advance + " lines=" + window.lines.size)
      var notified = 0
      for (line in window.lines) {
        dbg("line: " + line)
        try {
          val j = org.json.JSONObject(line)
          // D14 同源约束：标题缺失时回落可区分标识，不再回落字面量「任务完成」。
          // 0.14.1 批 3（P3-6）：**不再回落哈希片段**——旧实现是「会话 3f9a21」，那是内部 id 的哈希，
          // 用户既认不出也搜不到（审查档 §4.1）。这里退回人类可读标题。
          // 如实说明代价：旧信道**没有**会话可分性（本项目 `legacyFallback` 一律走 `kind="silent"`、
          // dedupeKey 固定，所有帧覆盖同一条通知），所以哈希带来的「可区分」本来就只在**覆盖前后**可见，
          // 不值得为它把机器码留在屏上。会话可分性由 `.notify.ndjson` 新信道（按会话分桶）提供。
          val title = j.optString("title").ifBlank { "一轮任务已完成" }
          dbg("legacy title fallback session=" + markerTag(j.optString("sessionId")))
          val snippet = j.optString("text").ifBlank { "引擎已完成一轮任务处理" }
          // NT-09 双读不双发：.notify.ndjson 已服役时旧信道只做回退（不在两处重复投递）
          val posted = NotifyStore.legacyFallback(context, title, snippet)
          if (posted) notified++
          dbg("notify returned ok=" + posted)
        } catch (e: Exception) {
          dbg("notify threw: " + (e.message ?: e.javaClass.simpleName))
        }
      }
      // 只推进整行字节；**永不 writeText("")**（截断会清零窗口内的行，且崩溃中途会重复投递）
      if (window.advance > 0) markerOffsetTo(context, offset + window.advance)
      dbg("done notified=" + notified + " consumedLines=" + window.lines.size + " newOffset=" + markerOffset)
    } catch (e: Exception) {
      dbg("consume outer threw: " + (e.message ?: e.javaClass.simpleName))
    }
  }

  /** 引擎日志尾部异常扫描（最近 4KB 内 fatal/Error 关键字；命中率控制：只取尾部）。 */
  /** 读引擎日志尾部 4KB，返回命中的签名（[SIGNATURE_PLUGIN_TREE] 优先；无命中 null）。 */

  /** 纯函数：日志尾部文本 → 签名（插件树优先于未捕获异常）。 */
  internal fun logSignatureOf(tail: String): String? = when {
    tail.contains("plugin tree failed to load") -> SIGNATURE_PLUGIN_TREE
    tail.contains("UncaughtException") -> SIGNATURE_UNCAUGHT
    else -> null
  }

  /** 一次尾部读取的结果：原文 + 读取时的文件长度（长度用于证据水位，见 [healthyLogMark]）。 */
  private data class LogTail(val text: String, val length: Long)

  private fun readEngineLogTail(context: Context): LogTail {
    return try {
      val f = java.io.File(context.filesDir, "engine.log")
      if (!f.exists()) return LogTail("", 0L)
      java.io.RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        val off = tailWindowStart(len, LOG_TAIL_BYTES, healthyLogMark)
        raf.seek(off)
        val buf = ByteArray((len - off).toInt().coerceIn(0, LOG_TAIL_BYTES))
        val n = raf.read(buf)
        LogTail(String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8), len)
      }
    } catch (_: Exception) {
      LogTail("", 0L)
    }
  }

  /** 引擎日志尾部窗口上限（原本散落在读取处的字面量）。 */
  private const val LOG_TAIL_BYTES = 4096

  /**
   * 活动租约（0.14.10 §6.2）：唤醒锁按「有没有事在做」持有，而不是按「引擎进程还活着」持有。
   *
   * 缺陷形态（审计 §6.2，功耗最大单项）：旧实现服务启动即 acquireWakeLock，此后每拍
   * refreshWake 无条件续持（refreshWakeLock 就是 acquireWakeLock 的别名），于是即使没有任何
   * turn 在跑，CPU 也不允许深睡——审计实测连续持锁 7 分钟以上，「放着不动也发热」。
   *
   * 口径（用户拍板）：**活动 turn / 控制请求在途 / 启动或重启窗口**三类事件刷新本租约；
   * 距最近一次活动 [IDLE_RELEASE_MS] 内续持，超时主动释放；有事件立刻重取。
   * 释放期间进程优先级仍由前台服务维持——本租约只管「CPU 是否被强制唤醒」，不动保活语义。
   *
   * 时钟基准是 SystemClock.elapsedRealtime()：单调、不受墙钟调整影响，且跨休眠不回绕。
   */
  internal object WakeActivityLease {
    /** 空闲多久后允许放掉唤醒锁（用户口径：60 秒）。 */
    const val IDLE_RELEASE_MS = 60_000L

    /** 从未有过活动。elapsedRealtime 恒 >= 0，故负值即哨兵，也不必担心减法溢出。 */
    private const val NEVER = Long.MIN_VALUE

    private val lastActivityAt = java.util.concurrent.atomic.AtomicLong(NEVER)

    /** 记一次活动（turn 事件 / 控制请求在途 / 启动或重启窗口）。 */
    fun note(now: Long = android.os.SystemClock.elapsedRealtime()) {
      lastActivityAt.set(now)
    }

    /** 最近一次活动的时刻；负值 = 本进程尚未有过活动（冷启动即此态）。 */
    fun lastActivityAt(): Long = lastActivityAt.get()

    /**
     * 租约是否新鲜（= 此刻应当持锁）。
     *
     * 从未活动必须判「不新鲜」：不能因为哨兵比 now 小就当成「刚活动过」。
     * 反向也要判：last > now（时钟域混用/测试注入）按不新鲜处理，宁可放掉也不锁死。
     */
    fun holdable(now: Long): Boolean {
      val last = lastActivityAt.get()
      if (last < 0L || last > now) return false
      return now - last < IDLE_RELEASE_MS
    }

    /** 重置（JVM 单测用；生产不调——租约跨用例残留会互相污染）。 */
    fun reset() {
      lastActivityAt.set(NEVER)
    }
  }

  /** 一拍唤醒锁的处置（纯枚举，便于单测直接断言「该持 / 该放」）。 */
  internal enum class WakeTick { HOLD, RELEASE }

  /** 纯函数：按活动租约决定本拍唤醒锁的处置（0.14.10 §6.2）。 */
  internal fun wakeTickDecision(now: Long): WakeTick =
    if (WakeActivityLease.holdable(now)) WakeTick.HOLD else WakeTick.RELEASE

  /**
   * 桥的 live 事件流长度（§6.2「turn 在跑」的廉价观测：只做一次 length()，不读内容）。
   *
   * 为什么可以拿它当活动信号：dsh-android-bridge 每产生一条 live 事件（tool_call /
   * tool_result / text / turn_end）就 append 一行，turn 在跑期间文件必长；turn 结束后停止增长，
   * 于是租约在 60 秒后自然过期——正是用户口径要的「空闲释放」。文件不存在时按 0 处理。
   */
  internal fun liveFeedLength(context: Context): Long = try {
    java.io.File(java.io.File(context.filesDir, "home/.dsh"), ".live.ndjson").length()
  } catch (_: Throwable) {
    0L
  }

  /** A terminal owner belongs to one Service epoch; no process-global wake handle exists. */
  internal data class WakeAcquisition(val lock: PowerManager.WakeLock, val renewAt: Long)
  internal class WakeLockOwner {
    internal val acquisition = EpochResourceOwner<WakeAcquisition> { held ->
      try { if (held.lock.isHeld) held.lock.release() } catch (_: Throwable) {}
    }
  }

  internal fun acquireWakeLock(context: Context, owner: WakeLockOwner) {
    try {
      owner.acquisition.install(
        acquire = {
          val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
          val candidate = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:engine")
          try {
            candidate.setReferenceCounted(false)
            candidate.acquire(30 * 60 * 1000L)
            WakeAcquisition(candidate, android.os.SystemClock.elapsedRealtime() + 25 * 60 * 1000L)
          } catch (t: Throwable) {
            try { if (candidate.isHeld) candidate.release() } catch (_: Throwable) {}
            throw t
          }
        },
        keepExisting = { held -> android.os.SystemClock.elapsedRealtime() < held.renewAt && held.lock.isHeld },
      )
    } catch (t: Throwable) {
      Log.e(TAG, "wake lock acquire failed (degraded best-effort)", t)
    }
  }

  /**
   * 续期（0.14.10 §6.2）：**按活动租约**决定续持还是放掉，而不是无条件 acquire。
   *
   * 旧实现是 acquireWakeLock 的别名 ⇒ 每拍无条件续持，唤醒锁等于「引擎进程活多久就持多久」
   * （审计 §6.2 的缺陷本体）。现在：
   *  - 租约新鲜（60 秒内有 turn / 控制请求 / 启动窗口事件）⇒ 照旧 acquire（keepExisting 仍按
   *    25 分钟 renewAt 判，30 分钟 acquire 上限那档继续由 renew 覆盖）；
   *  - 租约过期 ⇒ 走 [releaseWakeLockIdle] 主动放掉，下一次有事件时 [acquireWakeLock] 立刻重取。
   *
   * 无论哪一支，唤醒锁句柄始终由调用方那个 epoch 的 [WakeLockOwner] 持有——本函数不引入
   * 进程级句柄，[releaseWakeLock] 的终态释放路径（onDestroy/retireEpoch）不受影响。
   */
  internal fun refreshWakeLock(
    context: Context,
    owner: WakeLockOwner,
    now: Long = android.os.SystemClock.elapsedRealtime(),
  ) {
    when (wakeTickDecision(now)) {
      WakeTick.HOLD -> acquireWakeLock(context, owner)
      // 空闲放锁不是终态：只摘掉当前句柄，owner 仍可再次 install（见 EpochResourceOwner.drop）。
      WakeTick.RELEASE -> releaseWakeLockIdle(owner)
    }
  }

  /**
   * 空闲放锁（0.14.10 §6.2）：释放当前句柄但**保持 owner 可用**。
   *
   * 不能直接 owner.acquisition.close()：close 是终态（closed=true 后 install 一律拒绝），
   * 用它做「空闲释放」会让此后所有重取静默失败，唤醒锁永久失效。故走 drop()——它保留
   * epoch 语义（释放仍由同一个 owner 执行、仍只释放自己那一个句柄），只是不动终态位。
   */
  internal fun releaseWakeLockIdle(owner: WakeLockOwner) {
    try {
      owner.acquisition.drop()
    } catch (t: Throwable) {
      Log.e(TAG, "wake lock idle release failed", t)
    }
  }

  /** 终态释放（onDestroy / retireEpoch）：关闭 owner，此后一律拒绝重新 install。 */
  internal fun releaseWakeLock(owner: WakeLockOwner) { owner.acquisition.close() }

  /**
   * 「缺口拍」阈值（issue #1505）：超出最长合法调度拍（健康态 [HEALTHY_TICK_MS]）一个标准拍以上，
   * 就不是调度抖动而是**深睡 / 进程挂起**——`Handler.postDelayed` 在 doze 期间不执行，
   * 唤醒后的第一拍必然出现一个巨大的单调间隔。
   *
   * 取 [HEALTHY_TICK_MS] + [STANDARD_TICK_MS]（25s）而不是「2 个标准拍」：健康态 20 秒拍本身
   * 就是合法的 4 个标准拍，按 10s 设阈值会把它误判成缺口（DEAD 引擎从健康拍降下来那一拍也要
   * 折算 4 拍，压成 1 拍会让 60 秒熔断变成 240 秒）。
   */
  const val GAP_TICK_MS = HEALTHY_TICK_MS + STANDARD_TICK_MS

  /** 一拍记账结果（issue #1505）：[units] 交给 [recordProbe] 的加权标准拍数；[gap] = 深睡/挂起后的缺口拍；[log] 缺口时的结构化日志行（非缺口为空串）。 */
  internal data class TickAccounting(val units: Int, val gap: Boolean, val log: String = "")

  /**
   * 纯函数（issue #1505）：本拍实际经过的毫秒 -> 记账。判据见 WatchdogCadenceTest。
   *
   * 缺陷形态：#1357 把拍长记账从墙钟换成 `elapsedRealtime()`（这一步是对的，否则系统时间前跳
   * 会误触熔断），但那个时钟**包含深睡**：doze 或进程挂起后第一拍的 `tickMs` 就是睡眠时长，
   * 而 [tickUnits] 对任意大间隔都封顶 [MAX_TICK_UNITS]（6），[recordProbe] 又是
   * `consecutiveFailures += units` ⇒ **两拍**就是 12 = 熔断。深睡唤醒因此被当成「引擎连续失败
   * 60 秒」，自动恢复反而被抑制。
   *
   * 处置：缺口拍只记**一个**标准拍（等价于「醒来后看了一次、失败一次」），并给 [gap]/[log]
   * 让调用方落 `watchdog-gap` 日志——不静默丢信息，也不让一次睡眠冒充一串失败。
   * 合法节奏不受影响：健康态 20 秒拍（4 个标准拍）与降级态 5 秒拍（1 个）都 <= [GAP_TICK_MS]。
   */
  internal fun tickAccounting(elapsedMs: Long): TickAccounting {
    if (elapsedMs > GAP_TICK_MS) {
      return TickAccounting(
        1,
        true,
        "watchdog-gap: 深睡/挂起 " + elapsedMs + "ms 后本拍按 1 个标准拍记账（缺口拍不折算，避免两拍打满熔断）",
      )
    }
    return TickAccounting(tickUnits(elapsedMs), false)
  }
}

/** CAS publication/terminal teardown. Acquisition and release may block, but never hold a lock. */
internal class EpochResourceOwner<T : Any>(private val release: (T) -> Unit) {
  private data class State<T>(val closed: Boolean = false, val resource: T? = null)
  private val state = java.util.concurrent.atomic.AtomicReference(State<T>())

  fun install(acquire: () -> T, keepExisting: (T) -> Boolean = { false }): Boolean {
    val before = state.get()
    if (before.closed) return false
    if (before.resource?.let(keepExisting) == true) return state.get() === before
    // Teardown may win while acquire waits in Binder. Its terminal state rejects publication.
    val candidate = acquire()
    if (!state.compareAndSet(before, State(resource = candidate))) {
      release(candidate) // Only this unpublished acquisition; never the replacement owner's handle.
      return false
    }
    before.resource?.let(release)
    return true
  }

  /**
   * 释放当前资源但**保留 owner 可用**（0.14.10 §6.2 空闲放锁用；[close] 是终态，不可替代）。
   *
   * 语义与 [close] 的唯一差别是 closed 位：这里置回 false，于是下一次 [install] 能重新发布
   * 新资源。并发安全：release 只对「自己 CAS 掉的那个句柄」执行一次，绝不动别人刚装进去的
   * 句柄（与 [install] 的 obsolete-candidate 清理同纪律）。
   *
   * @return 被释放的资源；无资源可释放或 owner 已关闭时返回 null。
   */
  fun drop(): T? {
    while (true) {
      val before = state.get()
      if (before.closed) return null
      val held = before.resource ?: return null
      if (state.compareAndSet(before, State(closed = false, resource = null))) {
        release(held)
        return held
      }
    }
  }

  fun close() {
    val before = state.getAndSet(State(closed = true))
    before.resource?.let(release)
  }
}
