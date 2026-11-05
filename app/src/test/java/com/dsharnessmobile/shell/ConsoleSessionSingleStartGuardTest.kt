package com.dsharnessmobile.shell

import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1008：两处并发状态字段缺 `@Volatile`，且控制台的「只起一次」守卫非原子。
 *
 * 缺陷形态（复验于 origin/main f45aa988）：
 *  1. `EngineManager.lastRefreshFailureUnclassified`（写点在 `refreshSnapshot` 的 catch 路径，
 *     读点在 UI 线程消费 `refreshFailureLabel` 处）没有 `@Volatile`，而同组相邻的
 *     `lastRefreshFailureCode` / `lastRefreshDeferred` 都有——不可见即可能读到旧值，
 *     「真因未归类」被渲染成上一次的判定，boot-fail 的码与真因对不上。
 *  2. `ConsoleActivity.startSessionNow()` 先读 `sessionStarted`/`sessionStarting`、再置
 *     `sessionStarting = true`，**两次检查两次赋值**；而 `ConsoleSession.start()` 无幂等
 *     ⇒ 两个线程各起一个 PTY（同一界面里两条 bash、两个读线程，输出互相串）。
 *     且 `sessionStarted` 本身也没有 `@Volatile`。
 *
 * 修法边界：`ConsoleActivity` 是 Activity，JVM 单测无法实例化——所以「守卫 + 启动动作」抽成纯
 * Kotlin 的 [ConsoleSessionStartGuard]（锁只保护「判定 + 置位」，start 本身是文件 IO，仍在
 * Activity 的后台线程里跑），Activity 只剩调用。本类用两种判据钉住：
 *  - **并发行为**（`并发启动只许起一个 PTY`）：真起 N 个线程同时抢准入，断言只有一次放行；
 *  - **源码形态**（其余用例）：锁住「判据在 Guard、Activity 不自持标志、字段带 @Volatile」不被回退。
 *
 * 反证（本类必须能红，逐条实测过）：
 *  - 修前（Activity 自持标志、Guard 不存在）：三条用例全红；
 *  - 把 `claim` 改成「先两次读、再置位」的无锁形态：并发用例判红并打印实际放行次数；
 *  - 去掉任一 `@Volatile`：对应字段用例判红。
 */
class ConsoleSessionSingleStartGuardTest {

  /** 仓根（测试工作目录可能是 app/ 或仓根；按 settings.gradle.kts 向上找）。 */
  private fun repoFile(rel: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) return File(dir, rel)
      dir = dir.parentFile
    }
    throw AssertionError("找不到仓根（settings.gradle.kts），工作目录 = " + File(".").absolutePath)
  }

  private fun shellSource(name: String): String =
    repoFile("app/src/main/java/com/dsharnessmobile/shell/" + name).readText()

  /** 去掉注释行（注释里复述旧实现作为背景，对全文断言会被自己的说明判红——仓内同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * 取某条声明的**声明区**（该行 + 其上方两行），用于判注解是否贴着这个字段。
   *
   * 只取上方两行而不是全文：断言必须能区分「这个字段带注解」与「文件里别处有注解」——
   * 后者会把判定洗成恒绿（只做 `code.contains("@Volatile")` 的老写法正有这个问题）。
   */
  private fun declaration(src: String, marker: String): String {
    val lines = codeOnly(src).lines()
    val i = lines.indexOfFirst { it.contains(marker) }
    assertTrue("源码里找不到声明（marker=" + marker + "）", i >= 0)
    return listOf(-2, -1, 0).mapNotNull { d -> lines.getOrNull(i + d)?.trim() }
      .filter { it.isNotEmpty() }
      .joinToString(" ")
  }

  // ── ① EngineManager 的刷新失败标记 ────────────────────────────────────────

  @Test
  fun `刷新失败未归类标记必须跨线程可见`() {
    val src = shellSource("EngineManager.kt")
    val decl = declaration(src, "var lastRefreshFailureUnclassified")
    assertTrue(
      "issue #1008：lastRefreshFailureUnclassified 必须 @Volatile（写点在 refreshSnapshot 的" +
        " catch 路径，读点在 UI 线程；缺它则读端可能拿到旧值，文案与 boot-fail 码对不上）。实际声明区：" + decl,
      decl.contains("@Volatile"),
    )
    // 判据自证：同组相邻字段本来就带注解，它们必须仍被判为「带注解」——
    // 否则上面那条的松紧可能只是 declaration() 抓错行造成的。
    assertTrue(
      "同组字段 lastRefreshFailureCode 必须仍带 @Volatile",
      declaration(src, "var lastRefreshFailureCode").contains("@Volatile"),
    )
    assertTrue(
      "同组字段 lastRefreshDeferred 必须仍带 @Volatile",
      declaration(src, "var lastRefreshDeferred").contains("@Volatile"),
    )
  }

  // ── ② 控制台的「只起一次」守卫（行为面）────────────────────────────────

  /**
   * 有界并发负控：N 个线程同一时刻抢首次启动准入，只有一次能拿到。
   *
   * 为什么用**自旋栅栏**而不是 CyclicBarrier/CountDownLatch 起跑：那两者的放行抖动在毫秒级，
   * 线程一个接一个醒来 ⇒ 后到者看到的 `starting` 早已为 true，竞态窗口被完全跳过。
   * 实测（本机 JDK 17，x 4 线程）：CyclicBarrier 起跑 0/300 轮撞上竞态；自旋起跑
   * 修前形态 132/200 轮撞上（最多 4 个线程同时通过），完整旧形态 293/2000 轮。
   * 负控能不能红，取决于起跑是不是真的同时——所以这里用自旋，而不是有毫秒级抖动的栅栏。
   * 轮数取 60：按上面实测的命中率，修前形态判红的概率 ≈ 1 - 0.34^60，同时把用例耗时压在 10s 量级。
   * 自旋栅栏把「全部就位 → 放行」压到纳秒级，才让「读两次 → 置位」的窗口可被观测。
   *
   * 判据是**硬**的：任何一轮放行数不为 1 即判红并带上实际值，没有「低于阈值就算过」。
   * 修前形态（无锁 claim）在本用例下稳定判红；修后（synchronized 判据+置位）恒为 1。
   */
  @Test
  fun `并发启动只许起一个 PTY`() {
    val rounds = 60
    val threads = 4
    var badRounds = 0
    var worstAdmits = 0
    for (round in 1..rounds) {
      val guard = ConsoleSessionStartGuard()
      val admitted = AtomicInteger(0)
      val ready = AtomicInteger(0)
      val go = AtomicInteger(0)
      val finished = AtomicInteger(0)
      repeat(threads) {
        Thread({
          ready.incrementAndGet()
          while (go.get() == 0) Thread.onSpinWait()
          // Activity 的真实次序：抢准入 → start（长 IO）→ 结算。
          if (guard.claimStart()) {
            admitted.incrementAndGet()
            guard.settle(true)
          }
          finished.incrementAndGet()
        }, "console-claim-" + round + "-" + it).apply { isDaemon = true }.start()
      }
      // 有界等待：真卡死要判红而不是挂住 CI；30s 给足开发机上并行构建的抖动余量。
      val spinDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
      while (ready.get() < threads && System.nanoTime() < spinDeadline) Thread.onSpinWait()
      assertEquals("第 " + round + " 轮线程未全部就位", threads, ready.get())
      go.set(1)
      while (finished.get() < threads && System.nanoTime() < spinDeadline) Thread.onSpinWait()
      assertEquals("第 " + round + " 轮线程未全部收尾", threads, finished.get())
      if (admitted.get() != 1) {
        badRounds++
        worstAdmits = maxOf(worstAdmits, admitted.get())
      }
    }
    assertEquals(
      "有 " + badRounds + " 轮出现多个线程同时通过首次启动准入（最多 " + worstAdmits +
        " 个）——ConsoleSession.start 会被调用同样多次，即同一界面里起了多个 PTY",
      0,
      badRounds,
    )
  }

  @Test
  fun `启动中拒绝重启且失败后仍可再试`() {
    val guard = ConsoleSessionStartGuard()
    assertTrue("首次启动必须放行", guard.claimStart())
    assertFalse("启动中不得再放行首次启动", guard.claimStart())
    assertFalse("启动中不得放行重启（两条 restart 会先互相 destroy 再各起一个 PTY）", guard.claimRestart())
    guard.settle(false)
    assertFalse("启动失败后不得留下「已启动」", guard.started)
    assertFalse("结算后不得仍算在启动中", guard.busy())
    assertTrue("启动失败后必须还能再试（正是 MISSING 后重连的路径）", guard.claimStart())
    guard.settle(true)
    assertTrue("已启动后 busy 必须为真（onStart 靠它早退）", guard.busy())
    assertFalse("已启动后首次启动不得再放行", guard.claimStart())
    assertTrue("已启动后允许重连", guard.claimRestart())
  }

  // ── ② 控制台的「只起一次」守卫（形态面）────────────────────────────────

  @Test
  fun `PTY 启动守卫必须只有原子实现`() {
    val act = codeOnly(shellSource("ConsoleActivity.kt"))
    assertTrue(
      "「只起一次」必须由 ConsoleSessionStartGuard 承担（Activity 自持标志即回到两次检查两次赋值）",
      act.contains("ConsoleSessionStartGuard()"),
    )
    assertTrue("首次启动必须经原子准入", act.contains(".claimStart()"))
    assertTrue("重连必须经原子准入", act.contains(".claimRestart()"))
    assertFalse(
      "Activity 不得再保留会话启动标志：读与置位分开 ⇒ 两个线程都能通过检查 ⇒ 双启 PTY",
      act.contains("var sessionStarted") || act.contains("var sessionStarting"),
    )
    // 次序判据：**先拿准入，才允许调 start/restart**。线程本身留在 Activity 是对的
    // （锁只护判定，long IO 不得在锁内跑）；被钉住的是「先起后判」或「判两遍再起」这种形态。
    val claimStartAt = act.indexOf("startGuard.claimStart()")
    val startAt = act.indexOf("session.start(sessionListener)")
    assertTrue("必须能定位首次启动的准入与启动调用", claimStartAt >= 0 && startAt >= 0)
    assertTrue("首次启动必须先拿准入再起会话（顺序反了就是无守卫启动）", claimStartAt < startAt)
    val claimRestartAt = act.indexOf("startGuard.claimRestart()")
    val restartAt = act.indexOf("session.restart(sessionListener)")
    assertTrue("必须能定位重连的准入与重启调用", claimRestartAt >= 0 && restartAt >= 0)
    assertTrue("重连必须先拿准入再重启（两条 restart 交错会先互相 destroy 再各起一个 PTY）", claimRestartAt < restartAt)
    assertTrue("onStart 的早退必须问守卫而不是裸标志", act.contains("if (startGuard.busy() || startPending) return"))
  }

  @Test
  fun `守卫状态跨线程可见且锁只护判定`() {
    val src = shellSource("ConsoleSessionStartGuard.kt")
    for (marker in listOf("var started", "var starting")) {
      val decl = declaration(src, marker)
      assertTrue(
        "issue #1008：守卫状态 " + marker + " 必须 @Volatile（主线程、桥线程、后台收尾线程跨线程读写）。实际声明区：" + decl,
        decl.contains("@Volatile"),
      )
    }
    val code = codeOnly(src)
    assertTrue(
      "claim 必须在一个原子单元内完成「判定 + 置位」（synchronized 或 CAS）——分开做就是本 issue 的缺陷形态",
      code.contains("synchronized(lock)") || code.contains("compareAndSet"),
    )
    assertFalse(
      "守卫不得自己做 start/restart 的 long IO（锁只护判定与置位，IO 留在 Activity 的后台线程）",
      code.contains(".start(") || code.contains("Thread(") || code.contains("Runnable"),
    )
  }
}
