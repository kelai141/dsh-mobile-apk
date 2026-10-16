package com.dsharnessmobile.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D7（0.14.1）Shizuku 绑定看门狗与文案三态的行为回归。
 *
 * 缺陷（设备实锤，Redmi K70E / 0.14.1-preview）：Shizuku 授权后 UI 永久停在「正在建立 shell UserService」。
 * 本体不是「建连慢」，而是**绑定闩没有任何超时**：复位点只有「同步抛异常」与「回调」两处，
 * Shizuku 侧既不抛也不回调时 `binding` 永久为 true → `kickBind` 的守卫从此关掉全部重试 →
 * 每轮只报「正在建立」。症状因此必然是「卡住」而非「失败」，且进程内不可自愈。
 *
 * 纯 JVM（无 Robolectric、不真连 Shizuku）：[ShizukuBindState] 与 [shizukuBindGuidance]
 * 都不触碰 Android 类，生产面也不留测试注入点（本仓纪律：测试改为显式传参）。
 *
 * 反证方式：把 `reapIfStale` 的阈值判定去掉（永远返回 false），下面
 * `aBindThatNeverCallbacksIsReapedAfterTheWatchdog` 与
 * `afterReapingTheSecondAttemptIsActuallyStarted` 必红——即本缺陷的形状。
 */
class ShizukuBindStateTest {

  private val watchdog = 20_000L

  // ── 看门狗：僵尸绑定必须被回收 ──────────────────────────────────────

  /** 核心反证：一次永不回调的 bind，必须在阈值后被复位（而不是永久闩死）。 */
  @Test
  fun aBindThatNeverCallbacksIsReapedAfterTheWatchdog() {
    val s = ShizukuBindState(watchdog)
    assertTrue("首次发起必须成功", s.beginAttempt(now = 1_000L))
    assertTrue("发起后 binding 必须为真（此时才配说「正在建立」）", s.binding)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)

    assertFalse("阈值内不得回收（否则会打断一次正常的慢绑定）", s.reapIfStale(1_000L + watchdog))
    assertTrue("binding 仍应在飞", s.binding)

    assertTrue("超过阈值必须回收僵尸绑定", s.reapIfStale(1_000L + watchdog + 1))
    assertFalse("回收后 binding 必须复位——否则 kickBind 的守卫会永久关掉重试", s.binding)
    assertEquals(
      "回收必须写入真实错误码（不是继续报 connecting）",
      ShizukuBindCodes.BIND_TIMEOUT,
      s.lastError,
    )
  }

  /** 反证 ②：回收之后，第二次调用必须**确实再次发起**绑定（次数可观测）。 */
  @Test
  fun afterReapingTheSecondAttemptIsActuallyStarted() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    // 僵尸在飞时不得重复发起（幂等，避免无谓抖动）
    assertFalse("僵尸在飞时 beginAttempt 必须拒绝", s.beginAttempt(1L))
    assertEquals(1, s.attempts)

    assertTrue(s.reapIfStale(watchdog + 1))
    assertTrue("回收后必须允许新的尝试——这正是本缺陷从「卡死」变成「可重试」的分界", s.beginAttempt(watchdog + 2))
    assertEquals("必须观察到第二次真实发起", 2, s.attempts)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)
  }

  /** 幂等：轮询路径每 2s 调一次，回收过后再调不得重复记账（否则日志与错误码会被反复改写）。 */
  @Test
  fun reapIsIdempotentOnThePollPath() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    assertTrue(s.reapIfStale(watchdog + 1))
    assertFalse("已回收后必须返回 false（否则每轮轮询都重复记日志）", s.reapIfStale(watchdog + 2))
    assertFalse(s.reapIfStale(watchdog + 999_999))
    assertEquals("重复回收不得改写错误码", ShizukuBindCodes.BIND_TIMEOUT, s.lastError)
  }

  /** 未在绑定中时，等待时长的哨兵是 -1 而不是 0（0 是合法等待值，用它冒充会把「未发起」读成「刚发起」）。 */
  @Test
  fun attemptAgeIsMinusOneWhenNotBinding() {
    val s = ShizukuBindState(watchdog)
    assertEquals(-1L, s.attemptAgeMs(123_456L))
    s.beginAttempt(10_000L)
    assertEquals(0L, s.attemptAgeMs(10_000L))
    assertEquals(2_500L, s.attemptAgeMs(12_500L))
    s.onDisconnected()
    assertEquals(-1L, s.attemptAgeMs(12_500L))
  }

  // ── 复位点：抛异常 / 无效 binder / 断连 ─────────────────────────────

  /** `bindUserService` 同步抛异常：必须复位，否则那个永不回调的闩会把后续调用全挡死。 */
  @Test
  fun onBindThrewResetsSoTheNextAttemptIsPossible() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onBindThrew(ShizukuBindCodes.bindFailed(IllegalStateException("boom")))
    assertFalse(s.binding)
    assertEquals(
      "code 必须带上异常类型（现场可诊）",
      "shizuku-user-service-bind-failed:IllegalStateException",
      s.lastError,
    )
    assertTrue("抛异常后必须能立刻重试", s.beginAttempt(1L))
    assertEquals(2, s.attempts)
  }

  /** 回调了但 binder 无效：不得当成「连上」（与 status() 的 bound 判据同口径）。 */
  @Test
  fun onConnectedWithAnInvalidBinderIsNotTreatedAsBound() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onConnected(binderValid = false)
    assertFalse("binder 无效时 binding 必须复位", s.binding)
    assertEquals(ShizukuBindCodes.INVALID_BINDER, s.lastError)

    val ok = ShizukuBindState(watchdog)
    ok.beginAttempt(0L)
    ok.onConnected(binderValid = true)
    assertFalse(ok.binding)
    assertEquals("连上后错误码必须清空（status() 据此回 ready）", "", ok.lastError)
  }

  @Test
  fun onDisconnectedResetsForReconnect() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onConnected(binderValid = true)
    s.onDisconnected()
    assertFalse(s.binding)
    assertEquals(ShizukuBindCodes.DISCONNECTED, s.lastError)
    assertTrue("断连后必须能重建连接", s.beginAttempt(5L))
  }

  @Test
  fun lateConnectionAfterResetCannotResurrectTheRemovedService() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    val old = s.currentGeneration
    s.onReset()
    assertFalse(s.onConnected(true, old))
    assertEquals(ShizukuBindCodes.RESET, s.lastError)
    assertFalse(s.binding)
  }

  @Test
  fun lateConnectionAfterTimeoutCannotCompleteANewerAttempt() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    val old = s.currentGeneration
    s.reapIfStale(watchdog + 1)
    s.beginAttempt(watchdog + 2)
    val current = s.currentGeneration
    assertFalse(s.onConnected(true, old))
    assertTrue(s.binding)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)
    assertTrue(s.onConnected(true, current))
    assertEquals("", s.lastError)
  }

  @Test
  fun oldDisconnectCannotClearAHealthyReplacement() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    val old = s.currentGeneration
    s.onConnected(true, old)
    s.onReset()
    s.beginAttempt(1L)
    val current = s.currentGeneration
    s.onConnected(true, current)
    assertFalse(s.onDisconnected(old))
    assertEquals("", s.lastError)
    assertTrue(s.onDisconnected(current))
    assertEquals(ShizukuBindCodes.DISCONNECTED, s.lastError)
  }

  @Test
  fun lateFailureCannotCancelTheReplacementWaiter() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    val old = s.currentGeneration
    s.onReset()
    s.beginAttempt(1L)
    assertFalse(s.onBindThrew("old-failure", old))
    assertTrue(s.binding)
    assertEquals(2, s.attempts)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)
  }

  @Test
  fun disconnectedAttemptCannotBeResurrectedByADuplicateConnection() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    val old = s.currentGeneration
    s.onConnected(true, old)
    assertFalse(s.onConnected(true, old))
    s.onDisconnected(old)
    assertFalse(s.onConnected(true, old))
    assertEquals(ShizukuBindCodes.DISCONNECTED, s.lastError)
  }

  // ── 文案三态：不许用一句「正在建立」盖住三种状态 ────────────────────

  /** 不变量：「正在建立」这四个字**当且仅当** binding 为真时才允许出现。 */
  @Test
  fun theConnectingWordingRequiresABindActuallyInFlight() {
    val codes = listOf(
      ShizukuBindCodes.CONNECTING,
      ShizukuBindCodes.NOT_BOUND,
      ShizukuBindCodes.BIND_TIMEOUT,
      ShizukuBindCodes.INVALID_BINDER,
      ShizukuBindCodes.DISCONNECTED,
      "shizuku-user-service-bind-failed:IllegalStateException",
      "shizuku-something-new",
    )
    for (code in codes) {
      val text = shizukuBindGuidance(code, binding = false, ageMs = -1L, watchdogMs = watchdog)
      assertFalse(
        "无 bind 在飞时不得说「正在建立」（code=$code）——旧实现正是这样把失败盖成进行中的",
        text.contains("正在建立"),
      )
    }
    val live = shizukuBindGuidance(ShizukuBindCodes.CONNECTING, binding = true, ageMs = 3_000L, watchdogMs = watchdog)
    assertTrue("确有 bind 在飞时才说「正在建立」", live.contains("正在建立"))
  }

  /** 超时态必须给出「可立即重试」而不是「去设置页排查」，并把已等待时长写进文案。 */
  @Test
  fun theTimeoutGuidanceIsActionableNotAVagueFailure() {
    val text = shizukuBindGuidance(ShizukuBindCodes.BIND_TIMEOUT, binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue("必须点明超时", text.contains("超时"))
    assertTrue("必须给出可执行动作", text.contains("可直接重试"))
    assertTrue("必须写明判据时长（用户据此判断是不是真卡住）", text.contains("20s"))
    assertFalse("超时不是「去设置页」那类需要排查的状态", text.contains("查看状态与引导"))
  }

  /** 「尚未发起」与「正在建立」必须可区分：前者不该让用户干等。 */
  @Test
  fun notBoundIsDistinctFromConnecting() {
    val text = shizukuBindGuidance(ShizukuBindCodes.NOT_BOUND, binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue("必须点明尚未发起", text.contains("尚未发起"))
    assertFalse("尚未发起时不得让人干等", text.contains("正在建立"))
  }

  /** 进行中文案必须带已等待秒数（否则用户无法判断它到底在动还是冻住）。 */
  @Test
  fun theConnectingGuidanceReportsElapsedSeconds() {
    val text = shizukuBindGuidance(ShizukuBindCodes.CONNECTING, binding = true, ageMs = 7_400L, watchdogMs = watchdog)
    assertTrue("必须写出已等待秒数：$text", text.contains("已等待 7s"))
    assertTrue("必须写出上限：$text", text.contains("上限 20s"))
    assertTrue("必须明确「直接重试即可」，不得把瞬时态说成需要排查", text.contains("重试"))
  }

  /** 未知 code 必须有兜底文案（上游/壳侧新增 code 时不得静默空串）。 */
  @Test
  fun anUnknownCodeStillProducesGuidance() {
    val text = shizukuBindGuidance("shizuku-brand-new-code", binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue(text.isNotBlank())
    assertTrue("兜底文案必须带上 code（现场可诊）", text.contains("shizuku-brand-new-code"))
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 0.14.2 P1「重置链接」（方案 §3.7 的五条）
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // 按钮解决的用户现场：Shizuku 已授权，却从「可创建」跳成「需要准备」，**重新授权与重启 App 都无效**。
  // 「App 重启无效」排除了「我们进程内标志位脏了」，指向 Shizuku 侧 UserService 处于坏态。
  // 因此真实修复动作（`unbindUserService(…, remove = true)`）在 ShizukuTransport 里，属 Android 面、
  // **无 JVM 注入点**（本仓纪律：生产面不留测试注入点），只能在设备层验（方案 §3.8）。
  // 本类能且必须锁住的是**我们这一侧的记账**：重置后必须真的回到「可以重新发起」的起点。

  /** §3.7-1：onReset() 后 binding == false 且 lastError == RESET。 */
  @Test
  fun onResetClearsBindingAndReportsTheResetCode() {
    val s = ShizukuBindState(watchdog)
    assertTrue(s.beginAttempt(1_000L))
    assertTrue(s.binding)

    s.onReset()
    assertFalse("重置后不得仍报「有一次绑定在飞」——否则 UI 会继续说「正在建立」", s.binding)
    assertEquals(
      "重置必须写 RESET 而不是保留旧 code（UI 据此如实说「已重置」）",
      ShizukuBindCodes.RESET,
      s.lastError,
    )
  }

  /**
   * §3.7-2（**反证核心**）：重置**确实打开重试**——beginAttempt 返回 true 且 attempts 递增。
   *
   * 这就是「重置有效」的判据。反证方式：让 `onReset()` 只清 error 而不清 `bindingFlag`
   * （即「重置无效」的形态），下面两句必红：第一次断言拿到 false、attempts 停在 1。
   */
  @Test
  fun resetActuallyOpensTheNextAttempt() {
    val s = ShizukuBindState(watchdog)
    assertTrue(s.beginAttempt(0L))
    val attemptsBefore = s.attempts
    assertEquals(1, attemptsBefore)

    s.onReset()
    assertTrue("重置后 beginAttempt 必须放行——否则按钮点了也不会再发起任何绑定", s.beginAttempt(10L))
    assertEquals("必须观测到一次真实的新发起", attemptsBefore + 1, s.attempts)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)
    assertTrue(s.binding)
  }

  /** §3.7-3：重置会作废在飞的绑定，且等待时长回 -1（不得用 0 冒充「刚发起」）。 */
  @Test
  fun resetInvalidatesAnInFlightBindAndItsAge() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(5_000L)
    assertTrue(s.binding)
    assertEquals(3_000L, s.attemptAgeMs(8_000L))

    s.onReset()
    assertFalse(s.binding)
    assertEquals("重置后不得再报在飞时长（0 是合法等待值，会把它读成「刚发起」）", -1L, s.attemptAgeMs(8_000L))
    // 作废必须彻底：重置后看门狗不得再把这次已作废的尝试当僵尸回收并改写 code。
    assertFalse("重置后 reapIfStale 不得再回收（幂等，且不得改写 RESET）", s.reapIfStale(999_999L))
    assertEquals(ShizukuBindCodes.RESET, s.lastError)
  }

  /** §3.7-4：reapIfStale 幂等性 + 四个既有 mutator 语义未被重置改动（回归）。 */
  @Test
  fun resetDoesNotDisturbTheExistingFourMutators() {
    // 既有四态逐条重放，确保 onReset 的加入没有改变它们的语义。
    val thrown = ShizukuBindState(watchdog)
    thrown.beginAttempt(0L)
    thrown.onBindThrew("shizuku-user-service-bind-failed:IllegalStateException")
    assertFalse(thrown.binding)
    assertEquals("shizuku-user-service-bind-failed:IllegalStateException", thrown.lastError)

    val invalid = ShizukuBindState(watchdog)
    invalid.beginAttempt(0L)
    invalid.onConnected(binderValid = false)
    assertEquals(ShizukuBindCodes.INVALID_BINDER, invalid.lastError)

    val ok = ShizukuBindState(watchdog)
    ok.beginAttempt(0L)
    ok.onConnected(binderValid = true)
    assertEquals("连上后错误码必须清空", "", ok.lastError)

    val gone = ShizukuBindState(watchdog)
    gone.beginAttempt(0L)
    gone.onDisconnected()
    assertEquals(ShizukuBindCodes.DISCONNECTED, gone.lastError)

    // reapIfStale 幂等性在 **重置之后** 也必须保持（重置把 binding 清空，故回收恒 false）。
    val reset = ShizukuBindState(watchdog)
    reset.beginAttempt(0L)
    reset.onReset()
    assertFalse(reset.reapIfStale(watchdog + 1))
    assertFalse(reset.reapIfStale(watchdog + 2))
    assertEquals("重复回收不得改写 RESET", ShizukuBindCodes.RESET, reset.lastError)
    // 重置后发起的**新**尝试仍必须能被看门狗正常回收（重置不得把看门狗一起废掉）。
    assertTrue(reset.beginAttempt(watchdog + 10))
    assertTrue("重置后新发起的尝试仍须受看门狗保护", reset.reapIfStale(watchdog + 10 + watchdog + 1))
    assertEquals(ShizukuBindCodes.BIND_TIMEOUT, reset.lastError)
  }

  /**
   * §3.7-5：RESET 文案三态诚实——含「已重置」，且**不得**出现过度承诺词（反向断言）。
   *
   * 方案 §3.6 明文：不许写「一定能修复」。Shizuku 自身 binder 故障不在本按钮的修复范围
   * （用户已定性「与我们无关」），文案必须如实说清「做了什么 / 现在什么态 / 还不行时做什么」。
   */
  @Test
  fun theResetGuidanceIsHonestAndDoesNotOverpromise() {
    val text = shizukuBindGuidance(ShizukuBindCodes.RESET, binding = false, ageMs = -1L, watchdogMs = watchdog)
    // ① 必须说清「已经做了什么」。
    assertTrue("必须点明已重置：$text", text.contains("已重置"))
    assertTrue("必须说明旧 UserService 已被请求移除（用户据此知道真的动过 Shizuku 侧）", text.contains("UserService"))
    // ② 必须说清「现在处于什么态」以及自动重扫（方案 §3.1 的「持续扫描链接」）。
    assertTrue("必须说明通道会自行重建", text.contains("重建"))
    assertTrue("必须写明既有 2 秒轮询在自动重扫（不新开扫描机制）", text.contains("2 秒"))
    // ③ 必须说清「还不行时该做什么」。
    assertTrue("必须给出下一步动作", text.contains("重试") || text.contains("启动"))
    // ④ 反向断言：不得过度承诺。
    for (banned in listOf("一定能", "必定", "保证", "一定可以", "必然能")) {
      assertFalse("重置文案不得过度承诺（出现「$banned」）：$text", text.contains(banned))
    }
    // ⑤ 重置态不是「正在建立」：binding=false 时那句话不准出现（与既有不变量同口径）。
    assertFalse("重置后不得说「正在建立」", text.contains("正在建立"))
  }

  /**
   * §3.7 补充（源码级接线断言，防「能力在、入口无」）：承重墙必须真的被调用，且不得同步等待。
   *
   * 为什么必须有这一条：[ShizukuTransport] 是 Android 面、无 JVM 注入点（§3.8 已如实登记），
   * 所以「resetConnection 里到底调没调 `remove = true`」在单测里**只能**从源码面判。
   * 本仓有现成先例（`BootFailLogTest` 用 `File("src/main/...").readText()` 断言失败调用点
   * 真的接在失败分支上），本条沿用同一手法。三类形态各判一次：
   *   ① 承重墙在场：`unbindUserService(args(app), connection, true)` 必须出现在 resetConnection 内；
   *   ② 不得同步等待：函数体内不得出现 `await(`（UI 高频路径，方案 §3.3 明文禁止）；
   *   ③ 两处连带必须在场：`onReset()` 与 `invalidateShizukuCache()`（缺前者按钮无效、
   *      缺后者界面最多 5 秒仍报旧值）。
   */
  @Test
  fun resetConnectionCallsTheLoadBearingRemoveAndDoesNotBlock() {
    val src = File("src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt").readText()
    val start = src.indexOf("fun resetConnection(context: Context)")
    assertTrue("resetConnection 必须在场（按钮的壳侧入口）", start >= 0)
    // 取函数体：从签名到下一个空行后的 `}` 归位（实现内无嵌套顶层函数，故按下一个 "\n  }" 截断足够）。
    val body = src.substring(start, minOf(src.length, start + 4_000))
    assertTrue(
      "承重墙必须在场：unbindUserService(args(...), connection, remove = true)",
      body.contains("discardOnMain(previous?.userArgs ?: args(app), previous?.connection, remove = true)"),
    )
    val cleanup = src.substring(src.indexOf("  private fun discardOnMain("), src.indexOf("  private fun bindOnMain("))
    assertTrue("注销与移除必须排到 SDK 回调所在的主线程", cleanup.contains("connectionMain.post"))
    val detach = cleanup.indexOf("Shizuku.unbindUserService(userArgs, connection, /* remove = */ false)")
    val remove = cleanup.indexOf("Shizuku.unbindUserService(userArgs, connection, /* remove = */ true)")
    assertTrue("两步调用必须同时存在，且先注销 SDK 缓存再移除远端", detach >= 0 && remove >= 0 && detach < remove)
    val watchdogBody = src.substring(src.indexOf("  private fun reapStaleBind("), src.indexOf("  private fun args("))
    assertTrue("超时也必须移除远端僵尸，而非只清本地标志", watchdogBody.contains("discardOnMain(previous.userArgs, previous.connection, remove = true)"))
    assertFalse("resetConnection 不得同步等待新绑定（UI 路径）", body.contains("latch.await("))
    assertTrue("必须调用 bindState.onReset()（否则我们这一侧的闩不清，重置无效）", body.contains("bindState.onReset()"))
    assertTrue("必须让 caps 缓存失效（否则最多 5 秒仍报旧值）", body.contains("ControlCarrier.invalidateShizukuCache()"))
    // 写后回读仍在（status(app)），但返回必须经动作面组装——直接 return status 会把「重置成功、
    // 通道待重建」渲染成「重置失败」（0.14.2 设备实测缺陷）。
    assertTrue("必须写后回读 status()（就绪事实取自真源，不得自造）", body.contains("status(app)"))
  }

  /**
   * 接线断言：页面入口 + Activity 真接线两端都必须在场（防「能力在、入口无」）。
   *
   * 这两条互补，缺一都不够：
   *  - 只有桥方法在场、Activity 没接线 → 按钮点了返回结构化错误（`shizuku-not-wired`），
   *    用户看到的是「按钮没用」；
   *  - 只有 Activity 接线、桥方法没暴露 → 页面根本调不到。
   * 默认桩返回**结构化**错误码（与本仓其余桥方法的既有约定一致）而不是空串/静默 false，
   * 所以「漏接线」至少是可诊断的失败；本测试把「真接线」钉成断言，让它不可能悄悄发生。
   */
  @Test
  fun theBridgeAndActivityBothWireTheReset() {
    val bridge = File("src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt").readText()
    assertTrue("@JavascriptInterface 方法必须在场（页面入口）", bridge.contains("fun resetShizukuConnection(): String"))
    assertTrue(
      "桥必须暴露 onResetShizukuConnection 这个注入点",
      bridge.contains("private val onResetShizukuConnection: () -> String"),
    )
    val activity = File("src/main/java/com/dsharnessmobile/shell/MainActivity.kt").readText()
    assertTrue(
      "MainActivity 必须把 onResetShizukuConnection 接到 ShizukuTransport.resetConnection",
      activity.contains("onResetShizukuConnection = { ShizukuTransport.resetConnection(this).toString() }"),
    )
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 0.14.2 设备实测缺陷修法：`ok` 的动作面语义（与 status() 的就绪面语义分开）
  // ══════════════════════════════════════════════════════════════════════════════
  //
  // 现场（16416，真实 tap）：重置**实际生效**（bindAttempts 1→3、userServiceAgeMs 608801→66538），
  // 但界面报「重置 Shizuku 连接失败」。真因：resetConnection 返回 status() 快照，重置后尚未绑定
  // ⇒ 快照 ok=false ⇒ UI 的 settleLinkCall 判 ok===true 才算成功 ⇒ 成功被渲染成失败。
  // 这是「一个字段被两件事共用」：只读快照的 ok（能不能用）被拿去回答动作的成败。

  /**
   * 正向：重置响应里 `ok` 表达**动作已执行**，同时就绪面事实**全部保留**。
   *
   * 本用例直接驱动生产用的纯组装函数 [shizukuResetResponse]，因此它测的是**真行为**，
   * 不是源码文本在场。
   */
  @Test
  fun resetResponseReportsTheActionWhileKeepingReadinessFacts() {
    // 造一个「重置刚走完」的真实快照形态：尚未绑定 + RESET code（与设备实测一致）。
    val status = JSONObject()
      .put("ok", false)                       // 就绪面：通道还没起来（这就是被误当成动作失败的那个字段）
      .put("installed", true)
      .put("running", true)
      .put("granted", true)
      .put("bound", false)
      .put("binding", false)
      .put("lastError", ShizukuBindCodes.RESET)
      .put("code", ShizukuBindCodes.RESET)
      .put("guidance", "Shizuku 通道已重置（旧 UserService 已请求移除，绑定态已清空）。")

    val res = shizukuResetResponse(JSONObject(status.toString()))

    // ① 动作面：ok 必须为 true（否则 UI 把成功渲染成失败——本缺陷）。
    assertTrue("重置动作必须报 ok=true（旧实现这里是 status 的 false）", res.getBoolean("ok"))
    assertTrue("必须带 reset=true，让调用方区分「重置动作」与「状态查询」", res.getBoolean("reset"))
    // ② 就绪面：一件事都不能丢——它们仍如实说通道未就绪。
    assertFalse("就绪事实必须保留：bound 仍为 false（通道尚未绑定）", res.getBoolean("bound"))
    assertFalse("就绪事实必须保留：binding 仍为 false（没有绑定在飞）", res.getBoolean("binding"))
    assertEquals(
      "就绪事实必须保留：code 仍是 RESET（通道态没被美化）",
      ShizukuBindCodes.RESET,
      res.getString("code"),
    )
    assertEquals(
      "就绪事实必须保留：lastError 仍是 RESET",
      ShizukuBindCodes.RESET,
      res.getString("lastError"),
    )
    assertTrue("引导文案必须原样保留", res.getString("guidance").contains("已重置"))
    assertTrue(
      "installed/running/granted 等既有字段不得丢失",
      res.getBoolean("installed") && res.getBoolean("running") && res.getBoolean("granted"),
    )
    // ③ 反向：动作 ok 与就绪 code 必须能同时成立（不是二选一）。
    assertTrue(
      "ok 与 code 各说各的事：ok=true 与 code=RESET 必须同时成立",
      res.getBoolean("ok") && res.getString("code") == ShizukuBindCodes.RESET,
    )
  }

  /**
   * 反向断言（源码级，与上面的行为断言互补）：只改 `ok` 而丢掉就绪字段、或只改文案不动 `ok`，
   * 都必须被判红。
   *
   * 为什么行为断言不够、还要这一条：`shizukuResetResponse` 的行为能证「组装对」，
   * 但证不了「resetConnection 真的用了它」——若调用点退回直接 `return status(app)`，
   * 行为断言仍旧全绿（它只驱动纯函数）。这条把**调用点**钉住，两者合起来才闭合。
   */
  @Test
  fun resetConnectionReturnsTheActionResponseNotTheRawStatus() {
    val src = File("src/main/java/com/dsharnessmobile/shell/ShizukuTransport.kt").readText()
    val start = src.indexOf("fun resetConnection(context: Context)")
    assertTrue("resetConnection 必须在场", start >= 0)
    val body = src.substring(start, minOf(src.length, start + 5_000))
    assertTrue(
      "调用点必须走动作面组装（shizukuResetResponse），不得直接 return status(app)",
      body.contains("return shizukuResetResponse(status(app))"),
    )
    assertFalse(
      "不得退回「直接返回 status 快照」——那正是把成功渲染成失败的形态",
      body.contains("return status(app)"),
    )
    // 就绪判据的 ok 语义不得被改到 status() 身上（ControlCarrier.shizukuReady 依赖它）。
    val statusStart = src.indexOf("fun status(context: Context): JSONObject")
    assertTrue("status() 必须在场", statusStart >= 0)
    val statusBody = src.substring(statusStart, minOf(src.length, statusStart + 5_000))
    assertFalse(
      "status() 的 ok 必须保持就绪判据，不得被动作面语义污染",
      statusBody.contains(".put(\"ok\", true).put(\"reset\", true)"),
    )
  }
}
