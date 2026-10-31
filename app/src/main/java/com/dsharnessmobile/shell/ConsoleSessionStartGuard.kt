package com.dsharnessmobile.shell

/**
 * 控制台会话「只起一次」的准入守卫（issue #1008）。
 *
 * 为什么必须抽出来：[ConsoleActivity] 是 Activity，JVM 单测无法实例化；而缺陷恰好长在
 * 「判定」与「置位」之间，只有真并发才看得见。所以把准入状态与判定搬进这个纯 Kotlin 类，
 * Activity 只持有实例并调用——行为面（并发只起一个）与形态面（锁只护守卫）都能在单测里钉住。
 *
 * 缺陷形态：旧实现在 `startSessionNow()` 里「读 [started]/[starting] → 清 startPending →
 * removeCallbacks → 再读一次 → 置 starting」，**两次检查两次赋值**；而
 * [ConsoleSession.start] 不幂等。两个线程（onStart 的延时任务、页面首帧 resize 的桥线程）
 * 同时进这段窗口时都能看到 `starting == false`，于是各 spawn 一个 PTY：一个 Activity 里
 * 两条 bash、两个读线程，输出互相串，页面输入落到其中一条。
 *
 * 修法边界（不要扩大锁的范围）：`synchronized` 只覆盖「读两个标志 + 写 [starting]」，
 * start/restart 本身是文件 IO（bash 存在性、relay 解包、spawn），仍在 Activity 的后台线程里跑，
 * **不得**挪进锁内——否则慢盘上会把主线程与桥线程一起卡在锁上。
 *
 * 反证：把 [claimStart] 改回「先两次读、再置位」的无锁形态，
 * `ConsoleSessionSingleStartGuardTest.并发启动只许起一个 PTY` 立刻判红（同一轮里 start 桩被调用多次）。
 */
internal class ConsoleSessionStartGuard {

  private val lock = Any()

  /** 会话是否已成功起过。跨线程可见：写=后台线程的结算，读=主线程/桥线程。 */
  @Volatile
  var started: Boolean = false
    private set

  /** 是否正在启动/重启。跨线程可见，同上。 */
  @Volatile
  var starting: Boolean = false
    private set

  /**
   * 首次启动的准入：只有**第一个**调用者拿到 `true`，其余一律 `false`。
   *
   * 已起过（[started]）也拒绝：控制台的「重连」有自己的入口 [claimRestart]。
   */
  fun claimStart(): Boolean = claim(restart = false)

  /**
   * 重启的准入：已起过也允许（重连就是要把现有会话换掉），但**正在启动中**一律拒绝——
   * 两条 restart 交错会先互相 destroy 再各起一个 PTY。
   */
  fun claimRestart(): Boolean = claim(restart = true)

  private fun claim(restart: Boolean): Boolean = synchronized(lock) {
    if (starting || (!restart && started)) return false
    starting = true
    true
  }

  /**
   * 后台线程跑完 start/restart 后的结算（Activity 经 handler 回主线程调用）。
   *
   * 只有拿过准入的调用者应当结算；[ok] 为 false 时 [started] 保持 false，下次仍可再试。
   * 与 [claim] 共用同一把锁：否则「已启动」与「启动中」两个字段可能被另一线程看到中间态
   * （`started=true` 而 `starting` 还没放下，或反之）。锁内只有两次赋值，不含任何 IO。
   */
  fun settle(ok: Boolean) = synchronized(lock) {
    started = ok
    starting = false
  }

  /** 任一状态为真——`onStart` 的早退判据（页面已在起或已起，不必再排延时任务）。 */
  fun busy(): Boolean = started || starting
}
