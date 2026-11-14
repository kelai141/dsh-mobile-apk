package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/**
 * Shell-UID motion adapter 的纯 JVM 行为判据。
 *
 * 每条用例只断言一条必须成立的性质，并且都用假的 [NativeShizukuMotion.Environment]
 * 记录「有没有真的启动进程」：拒绝路径一个进程都不能起；已启动的进程不得重试；
 * 只有拿到正向证据才允许 "yes"。
 */
class NativeShizukuMotionTest {
  private val now = 1_000L

  /** 一条脚本化命令：退出码 + 输出。 */
  private class Reply(val exitCode: Int, val output: String)

  private inner class FakeEnvironment(
    private val uid: Int = 2_000,
    private val executable: Set<String> = setOf(
      "/system/bin/input", "/system/bin/cmd", "/system/bin/am", "/system/bin/dumpsys",
    ),
    private val replies: List<Reply> = emptyList(),
  ) : NativeShizukuMotion.Environment {
    val started = mutableListOf<List<String>>()
    private var cursor = 0

    override fun uid(): Int = uid
    override fun canExecute(path: String): Boolean = path in executable
    override fun now(): Long = now
    override fun start(argv: List<String>): Process {
      started += argv.toList()
      val reply = replies.getOrNull(cursor++) ?: Reply(0, "")
      return StubProcess(reply.exitCode, reply.output)
    }
  }

  /** 立刻退出、输出可配的桩进程（与 ProcIoTest 同形）。 */
  private class StubProcess(private val code: Int, private val output: String) : Process() {
    override fun getOutputStream(): OutputStream = java.io.ByteArrayOutputStream()
    override fun getInputStream(): InputStream = ByteArrayInputStream(output.toByteArray())
    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
    override fun waitFor(): Int = code
    override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = true
    override fun exitValue(): Int = code
    override fun destroy() {}
    override fun isAlive(): Boolean = false
    override fun destroyForcibly(): Process = this
  }

  private fun deadline(remaining: Long = 4_000L): Long = now + remaining

  @Test
  fun nonShellUidIsRefusedBeforeStartingAnything() {
    // 应用进程（非 2000）不得借这条适配器跑 input/cmd。
    val environment = FakeEnvironment(uid = 10_123)
    val outcome = NativeShizukuMotion.execute(environment, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline())
    assertEquals("shizuku-motion-unavailable", outcome.code)
    assertEquals("no", outcome.executed)
    assertFalse(outcome.ok)
    assertTrue("拒绝路径不得启动进程: " + environment.started, environment.started.isEmpty())
  }

  @Test
  fun expiredOrOutOfRangeDeadlineStartsNothing() {
    val expired = FakeEnvironment()
    val expiredOutcome = NativeShizukuMotion.execute(expired, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline(remaining = 0L))
    assertEquals("deadline-invalid", expiredOutcome.code)
    assertEquals("no", expiredOutcome.executed)

    // 超过 MAX_DEADLINE_MS 的期限同样不接受：调用方不能一次预约很远的将来。
    val tooFar = FakeEnvironment()
    val tooFarOutcome = NativeShizukuMotion.execute(tooFar, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline(remaining = 5_001L))
    assertEquals("deadline-invalid", tooFarOutcome.code)

    assertTrue(expired.started.isEmpty())
    assertTrue(tooFar.started.isEmpty())
  }

  @Test
  fun invalidDirectionAndCoordinateStartNothing() {
    val badDirection = FakeEnvironment()
    val direction = NativeShizukuMotion.execute(badDirection, "scroll",
      JSONObject().put("direction", "diagonal").put("x", 10).put("y", 10)
        .put("fraction", 0.5).put("width", 1080).put("height", 2400), deadline())
    assertEquals("invalid-direction", direction.code)
    assertEquals("no", direction.executed)

    // 坐标越界（width-1 之外）与负坐标都必须在起进程之前拒绝。
    val badCoordinate = FakeEnvironment()
    val coordinate = NativeShizukuMotion.execute(badCoordinate, "scroll",
      JSONObject().put("direction", "down").put("x", 1_080).put("y", 10)
        .put("fraction", 0.5).put("width", 1_080).put("height", 2_400), deadline())
    assertEquals("invalid-coordinate", coordinate.code)

    val negative = FakeEnvironment()
    val negativeOutcome = NativeShizukuMotion.execute(negative, "longClick",
      JSONObject().put("x", -1).put("y", 20), deadline())
    assertEquals("invalid-coordinate", negativeOutcome.code)

    // 额外参数同样是拒绝：argv 只能由固定模板拼出。
    val extraKey = FakeEnvironment()
    val extra = NativeShizukuMotion.execute(extraKey, "longClick",
      JSONObject().put("x", 10).put("y", 20).put("displayId", 2), deadline())
    assertEquals("invalid-arguments", extra.code)

    assertTrue(badDirection.started.isEmpty())
    assertTrue(badCoordinate.started.isEmpty())
    assertTrue(negative.started.isEmpty())
    assertTrue(extraKey.started.isEmpty())
  }

  @Test
  fun longClickUsesFixedArgvOnRealDisplayExactlyOnce() {
    val environment = FakeEnvironment(replies = listOf(Reply(0, "")))
    val outcome = NativeShizukuMotion.execute(environment, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline())
    assertTrue(outcome.ok)
    assertEquals("long-click-accepted", outcome.code)
    assertEquals("yes", outcome.executed)
    assertEquals("只允许一次派发: " + environment.started, 1, environment.started.size)
    assertEquals(
      listOf("/system/bin/input", "-d", "0", "swipe", "10", "20", "10", "20", "600"),
      environment.started.single(),
    )
  }

  @Test
  fun startedCommandWithBadExitOrOutputIsUnknownAndNeverRetried() {
    // 非 0 退出：副作用可能已发生，只能报 unknown，且不得重试。
    val failed = FakeEnvironment(replies = listOf(Reply(1, "")))
    val failedOutcome = NativeShizukuMotion.execute(failed, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline())
    assertEquals("motion-unconfirmed", failedOutcome.code)
    assertEquals("unknown", failedOutcome.executed)
    assertFalse(failedOutcome.ok)
    assertEquals("已启动的进程不得重试: " + failed.started, 1, failed.started.size)

    // 退出码为 0 但有多余输出：同样不能当作成功。
    val noisy = FakeEnvironment(replies = listOf(Reply(0, "Injection failed\n")))
    val noisyOutcome = NativeShizukuMotion.execute(noisy, "longClick",
      JSONObject().put("x", 10).put("y", 20), deadline())
    assertEquals("motion-unconfirmed", noisyOutcome.code)
    assertEquals("unknown", noisyOutcome.executed)
    assertEquals(1, noisy.started.size)
  }

  @Test
  fun launchAppRequiresPositiveDisplayZeroReadback() {
    val pkg = "com.example.app"
    val resolve = Reply(0, "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1\n" +
      "  $pkg/.MainActivity\n")
    val start = Reply(0, "Starting: Intent { cmp=$pkg/.MainActivity }\nStatus: ok\n")

    // 启动落在 display 1：不得报 yes。
    val wrongDisplay = FakeEnvironment(replies = listOf(resolve, start,
      Reply(0, "Display #1 (activities):\n    ActivityRecord{abc u0 $pkg/.MainActivity t12}\n")))
    val wrong = NativeShizukuMotion.execute(wrongDisplay, "launchApp",
      JSONObject().put("pkg", pkg), deadline())
    assertEquals("launch-wrong-display", wrong.code)
    assertEquals("unknown", wrong.executed)
    assertFalse(wrong.ok)

    // 回读里没有任何该包证据：同样只能是 unknown。
    val noEvidence = FakeEnvironment(replies = listOf(resolve, start,
      Reply(0, "Display #0 (activities):\n    ActivityRecord{abc u0 com.other/.Main t12}\n")))
    val missing = NativeShizukuMotion.execute(noEvidence, "launchApp",
      JSONObject().put("pkg", pkg), deadline())
    assertEquals("launch-unverified", missing.code)
    assertEquals("unknown", missing.executed)

    // 正向对照：display 0 有该包记录才算 yes，且 argv 固定为 --display 0 -n。
    val confirmed = FakeEnvironment(replies = listOf(resolve, start,
      Reply(0, "Display #0 (activities):\n    ActivityRecord{abc u0 $pkg/.MainActivity t12}\n")))
    val yes = NativeShizukuMotion.execute(confirmed, "launchApp",
      JSONObject().put("pkg", pkg), deadline())
    assertTrue(yes.ok)
    assertEquals("launch-confirmed", yes.code)
    assertEquals("yes", yes.executed)
    assertEquals(listOf("/system/bin/am", "start", "--display", "0", "-n", "$pkg/.MainActivity"),
      confirmed.started[1])
  }
}
