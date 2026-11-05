package com.dsharnessmobile.shell

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * #1509 回归：按天日志的「查长度 -> 轮转 -> 追加」必须整段互斥。
 *
 * 缺陷形态（与 #1366 的分段日志同形，只是换了文件）：`dsh-<date>.log` 有多个写者——
 * `log()` 的调用线程、`tick()` 的调度线程、`emitBootSegments()` 的调用线程与 probe 尾线程。
 * 旧实现 `appendToDayFile` 是无锁的「exists/length -> 可能轮转 -> appendText」：
 *  - 一方刚 rename 走主文件、另一方仍握着旧句柄追加 -> 那几行落进 .1.log，主文件缺行；
 *  - 两线程同时判定超限 -> 各自轮转一次，前一代的 .1.log 被后来的 rename 撞掉。
 *
 * 判据是**行为化**的：给 `rotate` 注入一段停顿，把另一个写者顶在临界区外，
 * 直接观察「它写的那一行最终落在哪一代文件里」以及「临界区内是否同时有两个人」。
 * 读源码文本的判据发现不了「锁加在别处」或「只在某一分支加锁」。
 */
class DayFileLockTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun newline(): String = 10.toChar().toString()

  /** 主文件（`dsh-<day>.log`）：appendDayFile 自己拼前缀，这里只给日期段。 */
  private fun main(): File = File(tmp.root, "dsh-$DAY.log")

  private fun rotated(): File = File(tmp.root, "dsh-$DAY.1.log")

  private fun superseded(): File = File(tmp.root, "dsh-$DAY.2.log")

  @Test
  fun `轮转窗口内的写入必须落到新一代主文件`() {
    main().writeText("generation-0" + newline())
    val paused = CountDownLatch(1)
    val hold = CountDownLatch(1)

    // 真轮转，但在动文件之前停住——这就是旧实现里「rename 与 append 之间」的窗口。
    val slowRotate = { file: File ->
      paused.countDown()
      hold.await(2, TimeUnit.SECONDS)
      LogCollector.rotateDayFile(file, rotated(), superseded())
      Unit
    }

    val rotator = Thread {
      LogCollector.appendDayFile(
        dir = tmp.root, day = DAY, text = "-rotated" + newline(),
        shouldRotate = { true },
        rotate = slowRotate,
      )
    }.apply { isDaemon = true; start() }

    assertTrue("轮转必须先进入停顿", paused.await(2, TimeUnit.SECONDS))

    // 第二个写者：轮转正卡在临界区里时发起。加锁 ⇒ 它必须等；不加锁 ⇒ 它写进即将被 rename 的旧文件。
    val writer = Thread {
      LogCollector.appendDayFile(
        dir = tmp.root, day = DAY, text = "-late" + newline(),
        shouldRotate = { false },
      )
    }.apply { isDaemon = true; start() }

    Thread.sleep(150)
    hold.countDown()
    rotator.join(5_000)
    writer.join(5_000)

    assertTrue("轮转必须发生：.1.log 应拿到整个旧代", rotated().exists())
    assertEquals("旧代必须整段落在 .1.log", "generation-0" + newline(), rotated().readText())
    assertFalse(
      "被 rename 走的文件里不得出现迟到的行（出现 = 写入没有与轮转互斥）",
      rotated().readText().contains("-late"),
    )
    assertEquals(
      "新一代主文件必须拿到两条新行（顺序 = 轮转者先、迟到者后）",
      "-rotated" + newline() + "-late" + newline(),
      main().readText(),
    )
  }

  @Test
  fun `两个写者不得同时处在轮转临界区`() {
    val inside = AtomicInteger(0)
    val peak = AtomicInteger(0)
    val start = CountDownLatch(1)

    // 只量重叠，不真动文件：真轮转会把先写的行搬去 .1.log，行数判据就变成在数两代文件。
    // 「轮转窗口内不丢行」由下一条用例（真轮转 + 迟到写者）单独判。
    val rotate = { _: File ->
      peak.accumulateAndGet(inside.incrementAndGet()) { a, b -> maxOf(a, b) }
      try { Thread.sleep(90) } catch (_: InterruptedException) { }
      inside.decrementAndGet()
      Unit
    }

    val threads = (1..3).map { i ->
      Thread {
        start.await(2, TimeUnit.SECONDS)
        LogCollector.appendDayFile(
          dir = tmp.root, day = DAY, text = "line-" + i + newline(),
          shouldRotate = { true },
          rotate = rotate,
        )
      }.apply { isDaemon = true; start() }
    }
    start.countDown()
    threads.forEach { it.join(10_000) }

    assertEquals("同一时刻只允许一个写者处在临界区（大于 1 即旧实现的重叠形态）", 1, peak.get())
    assertEquals("三条写入一条都不能丢", 3, main().readLines().count { it.startsWith("line-") })
  }

  @Test
  fun `未超限时不轮转且仍然落盘`() {
    val calls = AtomicInteger(0)
    val rotate = { _: File -> calls.incrementAndGet(); Unit }
    LogCollector.appendDayFile(tmp.root, DAY, "hello" + newline(), shouldRotate = { false }, rotate = rotate)
    LogCollector.appendDayFile(tmp.root, DAY, "world" + newline(), shouldRotate = { false }, rotate = rotate)
    assertEquals("未超限不得轮转", 0, calls.get())
    assertEquals("hello" + newline() + "world" + newline(), main().readText())
  }

  @Test
  fun `超限时用默认动作轮转且主文件继续写`() {
    main().writeText("generation-0")
    LogCollector.appendDayFile(tmp.root, DAY, "-appended", shouldRotate = { true })
    assertEquals("主文件必须只剩本次写入", "-appended", main().readText())
    assertEquals("上一代必须整段落进 .1.log", "generation-0", rotated().readText())
    assertFalse("轮转成功后不得留下更早一代（既有契约见 LogRotationTest）", superseded().exists())
  }

  private companion object {
    const val DAY = "2026-11-04"
  }
}
