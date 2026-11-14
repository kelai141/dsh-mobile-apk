package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.provider.Settings
import androidx.test.platform.app.InstrumentationRegistry
import com.dsharnessmobile.shell.RootGrant
import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File

/**
 * 专用 MuMu 上的特权诊断面（privilegedShell）真机用例。
 *
 * 组装与壳侧一致：真实 NativeControlHost + NativePlatformFacts + NativePrivilegeFacts/Execution，
 * 请求走私有 socket、经 Rust 计划 → 单一身份适配器，不经过 Node / 旧 Carrier。
 *
 * 纪律：
 *  - A11y 必须离线（本文件只验证 Shizuku 2000 与 termux 两条非 A11y 通道；A11y 在线时前提不成立）。
 *  - Root 只做「没有真实 Root 时必须是确定的 no」这一侧；设备确有 Root 授权时跳过，不伪造阳性。
 *  - 默认 IME 不得改动；不装包、不改系统设置。
 */
class NativePrivilegeDeviceTest {

  @Test fun shizukuShellReportsRealUidAndRefusesWritesWithoutRoot() {
    requireMuMuWithShizuku()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context: Context = instrumentation.targetContext
    val imeBefore = defaultIme(context)
    awaitShizuku(context)
    val a11y = NativeA11yExecution()
    val platform = NativePlatformFacts(context, a11y, { "real-only" })
    NativeControlHost.openIsolated(context,
      NativeControlDispatcher.Facts { NativePrivilegeFacts.augment(context, platform.capture()) },
      NativePrivilegeExecution(context, NativeSharedHostExecution(NativeShizukuExecution(a11y),
        NativeVdisplayExecution({ context }))),
    ).use { host ->
      val caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
      assertTrue(caps.toString(), caps.getBoolean("ok"))
      val channels = caps.getJSONObject("channels")
      val a11yCaps = channels.getJSONObject("a11y")
      assertEquals("本用例只验证非 A11y 通道，A11y 必须关闭；caps=" + caps, "no", a11yCaps.getString("enabled"))
      assertEquals("本用例只验证非 A11y 通道，A11y 必须离线；caps=" + caps, "no", a11yCaps.getString("online"))
      val shizukuCaps = channels.getJSONObject("shizuku")
      assertEquals(caps.toString(), "yes", shizukuCaps.getString("functionalReady"))
      assertEquals("Shizuku 服务端必须是 shell 2000 而不是 root", "shell2000",
        shizukuCaps.getJSONObject("serverUid").getString("kind"))
      assertTrue("Shizuku 未实测 shExec 能力：" + caps, operations(shizukuCaps).contains("shExec"))

      // 1. id 必须由真实 2000 服务端执行，回执自证 uid 2000。
      val identity = executeShell(host, caps, "shExec", "priv-id-" + System.nanoTime(), "id")
      assertTrue(identity.toString(), identity.getBoolean("ok"))
      assertEquals(identity.toString(), "yes", identity.getString("executed"))
      val idOut = identity.getJSONObject("data").getString("stdout")
      // id 的第一行就是真实身份；按整行前缀比对，避免 "uid=20000"/"uid=0(" 之类的串通过。
      val uidLine = idOut.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
      assertTrue("id 输出第一行必须是真实身份；实际：" + idOut,
        Regex("""^uid=2000(\(.*\))?$""").matches(uidLine))
      assertFalse("Shizuku shell 不得冒充 root；实际：" + idOut, uidLine.startsWith("uid=0"))

      // 2. 只读命令读不存在的唯一路径：命令确实跑了（executed=yes），结果如实失败，错误文本可见。
      //    服务端把 stderr 并进 stdout（ShizukuUserService 用 redirectErrorStream），所以按两处
      //    合并断言，不假设它落在 stdout 还是 stderr 字段。
      val missing = "/data/local/tmp/dsh-native-missing-" + System.nanoTime().toString(16)
      val absent = executeShell(host, caps, "shExec", "priv-cat-" + System.nanoTime(), "cat " + missing)
      assertEquals("读取是零副作用操作，必须真的执行过；reply=" + absent, "yes", absent.getString("executed"))
      assertFalse("不存在的路径不得报成功：" + absent, absent.getBoolean("ok"))
      val data = absent.getJSONObject("data")
      assertNotEquals("命令应以非零退出码结束：" + absent, 0, data.getInt("exitCode"))
      val combined = data.optString("stdout") + data.optString("stderr")
      assertTrue("找不到文件的原因必须对调用方可见；data=" + data,
        combined.contains("No such file"))

      // 3. 普通 shExec 的系统写命令必须在 Rust 准入处就被拒（executed=no），不能先跑再说没跑。
      for (write in listOf("settings put global wifi_on 1", "wm size 100x100")) {
        val refused = executeShell(host, caps, "shExec", "priv-write-" + System.nanoTime(), write)
        assertFalse(refused.toString(), refused.getBoolean("ok"))
        assertEquals("写命令必须在派发前被拒绝：" + refused, "no", refused.getString("executed"))
        assertEquals("拒绝码必须指向命令准入：" + refused, "shell-command-denied", refused.getString("code"))
        assertFalse("被拒的写命令不得带回任何执行输出：" + refused, refused.has("data"))
      }

      // 4. 没有真实 Root 授权时 rootExec 必须是确定的 no，且不能改用 2000 通道冒充。
      val rootAuthorization = NativePlatformFacts(context, a11y, { "real-only" }).capture()
        .getJSONObject("root").getString("authorization")
      assumeTrue("本机已授予 Root，rootExec 的否定侧不成立，跳过（不伪造阴性/阳性）",
        rootAuthorization != "yes" && !RootGrant.isGranted(context))
      val rootAttempt = executeShell(host, caps, "rootExec", "priv-root-" + System.nanoTime(), "id")
      assertFalse(rootAttempt.toString(), rootAttempt.getBoolean("ok"))
      assertEquals("无 Root 授权时不得执行：" + rootAttempt, "no", rootAttempt.getString("executed"))
      assertEquals("拒绝必须指向 Root 授权：" + rootAttempt,
        "root-authorization-required", rootAttempt.getString("code"))
      assertFalse("rootExec 不得拿到任何 shell 输出：" + rootAttempt, rootAttempt.has("data"))
      assertFalse("rootExec 拒绝回执不得出现 2000 通道证据：" + rootAttempt,
        rootAttempt.toString().contains("uid=2000"))
    }
    assertEquals("默认 IME 不得改变", imeBefore, defaultIme(context))
  }

  @Test fun replayedCallIdOnFreshConnectionNeverRunsTwice() {
    requireMuMuWithShizuku()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context: Context = instrumentation.targetContext
    val imeBefore = defaultIme(context)
    val a11y = NativeA11yExecution()
    val platform = NativePlatformFacts(context, a11y, { "real-only" })
    val facts = NativeControlDispatcher.Facts { NativePrivilegeFacts.augment(context, platform.capture()) }
    assumeTrue("计数文件需要应用 shell（termux 未解压时前提不成立）",
      facts.capture().optString("termuxReady") == "yes")

    val directory = File(context.filesDir, ".native-control-tests").apply { mkdirs() }
    val counter = File(directory, "replay-" + System.nanoTime().toString(16) + ".count")
    val marker = "dsh"
    try {
      assertFalse("计数文件不得预先存在", counter.exists())
      NativeControlHost.openIsolated(context, facts,
        NativePrivilegeExecution(context, NativeSharedHostExecution(NativeShizukuExecution(a11y),
          NativeVdisplayExecution({ context })))).use { host ->
        val caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
        assertTrue(caps.toString(), caps.getBoolean("ok"))
        val a11yCaps = caps.getJSONObject("channels").getJSONObject("a11y")
        assertEquals("计数用例要求 A11y 离线且不参与；caps=" + caps, "no", a11yCaps.getString("enabled"))
        assertEquals("计数用例要求 A11y 离线且不参与；caps=" + caps, "no", a11yCaps.getString("online"))
        val callId = "priv-replay-" + System.nanoTime()
        val command = "printf '%s' '" + marker + "' >> '" + counter.absolutePath + "'"
        val first = executeShell(host, caps, "termuxExec", callId, command)
        assertTrue(first.toString(), first.getBoolean("ok"))
        assertEquals(first.toString(), "yes", first.getString("executed"))
        assertEquals("首次执行必须恰好写一次", marker, counter.readText())

        // 重连：每次 rpc 都是新的 LocalSocket 连接，callId 不变即语义上的重连重放。
        val replay = executeShell(host, caps, "termuxExec", callId, command)
        assertTrue("重放必须回执既有结果；reply=" + replay, replay.optBoolean("replayed"))
        assertEquals("重放回执沿用原执行结论", "yes", replay.getString("executed"))
        assertEquals("同 callId 重连不得再执行一次", marker, counter.readText())

        // 反证：换 callId 就是另一次派发，说明上面的计数确实能发现重复执行。
        val second = executeShell(host, caps, "termuxExec", callId + "-b", command)
        assertTrue(second.toString(), second.getBoolean("ok"))
        assertEquals("新 callId 是另一次派发", marker + marker, counter.readText())
      }
    } finally {
      // 只删本次用例的确切路径。
      counter.delete()
      directory.delete()
    }
    assertEquals("默认 IME 不得改变", imeBefore, defaultIme(context))
  }

  @Test fun termuxExecRunsAsAppUidWithValidEnvironment() {
    requireMuMuWithShizuku()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context: Context = instrumentation.targetContext
    val imeBefore = defaultIme(context)
    val a11y = NativeA11yExecution()
    val platform = NativePlatformFacts(context, a11y, { "real-only" })
    NativeControlHost.openIsolated(context,
      NativeControlDispatcher.Facts { NativePrivilegeFacts.augment(context, platform.capture()) },
      NativePrivilegeExecution(context, NativeSharedHostExecution(NativeShizukuExecution(a11y),
        NativeVdisplayExecution({ context }))),
    ).use { host ->
      val caps = rpc(host, JSONObject("""{"protocolVersion":1,"method":"capabilities"}"""))
      assertTrue(caps.toString(), caps.getBoolean("ok"))
      val a11yCaps = caps.getJSONObject("channels").getJSONObject("a11y")
      assertEquals("termux 用例同样要求 A11y 离线；caps=" + caps, "no", a11yCaps.getString("enabled"))
      assertEquals("termux 用例同样要求 A11y 离线；caps=" + caps, "no", a11yCaps.getString("online"))
      val ready = NativePrivilegeFacts.augment(context, platform.capture()).optString("termuxReady")
      assumeTrue("本机未解压 termux 运行时（termuxReady=" + ready + "），应用 shell 用例前提不成立", ready == "yes")
      val offered = caps.getJSONArray("operations")
      assertTrue("termux 就绪时必须出现在可执行操作里：" + caps,
        (0 until offered.length()).any { offered.getString(it) == "termuxExec" })

      // 中文、uid、环境变量一次性验证：任一缺失都说明应用 shell 的环境是坏的。
      val command = "printf '%s\n' '中文输出：括号（全角）'; id -u; printenv HOME; printenv PATH; printenv TERMUX__ROOTFS"
      val reply = executeShell(host, caps, "termuxExec", "priv-termux-" + System.nanoTime(), command)
      assertTrue(reply.toString(), reply.getBoolean("ok"))
      assertEquals(reply.toString(), "yes", reply.getString("executed"))
      assertEquals("termux 回执不得使用 Shizuku 的完成码：" + reply, "termux-completed", reply.getString("code"))
      val data = reply.getJSONObject("data")
      val stdout = data.getString("stdout")
      assertTrue("中文必须原样往返；实际：" + stdout, stdout.contains("中文输出：括号（全角）"))
      val lines = stdout.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
      assertTrue("termux 必须以应用 UID 运行，实际：" + stdout, lines.contains(Process.myUid().toString()))
      assertFalse("termux 不得跑成 root 或 shell：" + stdout, lines.contains("0") || lines.contains("2000"))
      val home = File(context.filesDir, "home").absolutePath
      assertTrue("HOME 必须是应用私有 home；实际：" + stdout, lines.contains(home))
      val usr = File(context.filesDir, "usr").absolutePath
      assertTrue("TERMUX__ROOTFS 必须指向应用私有 usr 的父目录；实际：" + stdout,
        lines.contains(context.filesDir.absolutePath))
      assertTrue("PATH 必须包含快照 usr/bin；实际：" + stdout,
        lines.any { it.split(':').contains(usr + "/bin") })
      // termux 不走 Shizuku：回执必须自带退出码，且不能借 Shizuku 的完成码。
      assertTrue("termux 回执必须带退出码：" + data, data.has("exitCode"))
      assertEquals("termux 必须正常退出：" + data, 0, data.getInt("exitCode"))
    }
    assertEquals("默认 IME 不得改变", imeBefore, defaultIme(context))
  }

  // ── 装配与断言辅助 ────────────────────────────────────────────────────────────

  /** 只在专用 MuMu 且由启动器显式开启 Shizuku 时执行；其他设备或未授权一律跳过。 */
  private fun requireMuMuWithShizuku() {
    val arguments = InstrumentationRegistry.getArguments()
    assumeTrue("仅在专用 MuMu 执行", arguments.getString("nativeTestEmulator") == "mumu")
    assumeTrue("Shizuku 授权由启动器显式开启",
      arguments.getString("nativeTestShizuku") == "yes" &&
        arguments.getString("nativeTestShizukuDenied") != "yes")
  }

  private fun executeShell(host: NativeControlHost, caps: JSONObject, operation: String,
    callId: String, command: String): JSONObject = rpc(host, JSONObject().put("protocolVersion", 1)
    .put("method", "execute").put("operation", operation).put("callId", callId)
    .put("epoch", caps.getString("epoch")).put("args", JSONObject().put("command", command)))

  private fun operations(channel: JSONObject): Set<String> {
    val supported = channel.optJSONObject("supportedOps") ?: return emptySet()
    if (supported.optString("state") != "known") return emptySet()
    val ops = supported.optJSONArray("ops") ?: return emptySet()
    return (0 until ops.length()).map { ops.getString(it) }.toSet()
  }

  /** 等本机 Shizuku 绑定并测出真实能力位；未就绪就带着快照判红，不降级到别的通道。 */
  private fun awaitShizuku(context: Context) {
    val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
    while (true) {
      if (ShizukuTransport.observeNativeRealTap(context)) return
      if (android.os.SystemClock.elapsedRealtime() >= deadline) {
        throw AssertionError("Shizuku 未就绪：" + NativeShizukuFacts.shared.snapshot())
      }
      android.os.SystemClock.sleep(250)
    }
  }

  private fun defaultIme(context: Context): String =
    Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD).orEmpty()

  private fun rpc(host: NativeControlHost, request: JSONObject): JSONObject = LocalSocket().use { socket ->
    socket.connect(LocalSocketAddress(host.endpoint.absolutePath, LocalSocketAddress.Namespace.FILESYSTEM))
    socket.soTimeout = 30_000
    val bytes = request.toString().toByteArray(Charsets.UTF_8)
    DataOutputStream(socket.outputStream).apply { writeInt(bytes.size); write(bytes); flush() }
    val input = DataInputStream(socket.inputStream)
    val length = input.readInt()
    assertTrue(length in 1..NativeControlFrames.MAX_RESPONSE_BYTES)
    val response = ByteArray(length)
    input.readFully(response)
    JSONObject(response.toString(Charsets.UTF_8))
  }
}
