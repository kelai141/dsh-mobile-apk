package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADB 输入通道契约回归（#413：AdbKeyboard 广播不 commit，IME 链路全绿而文本不动）。
 *
 * 静态判据 + 纯逻辑判据各守一半。静态判据守的是**缺陷形态**，不是实现细节：
 * 1. 广播必须点名组件 —— 设备实测（Android 16/17）：`am broadcast -a ADB_INPUT_TEXT`
 *    只入队 0 个接收者（targetSdk 26+ 的 manifest 接收器收不到隐式广播），
 *    而 stdout 照样是 `Broadcast completed: result=0`。撤掉 `-n` 即回到「发送成功但什么都没发生」。
 * 2. 发送方 uid 必须取自框架的 `BroadcastReceiver.getSentFromUid()` —— 旧实现反射
 *    `Intent.getSentFromUid()`（AOSP 无此方法，反射恒抛）导致 uid 白名单恒不生效。
 *
 * 另两条形态判据：两个接收器实例按投递方式互补（纯隐式 ↔ 点名/点名包，绝不重叠）；
 * 无序广播不得写结果码（框架没有结果通道，`PendingResult.checkSynchronousHint()`
 * 会往 logcat 打 RuntimeException 栈——导出接收器可被任意应用打到）。
 *
 * 反证（本类必须能红）：把 `ime-broadcast.ts` 的 `am broadcast -n ${KB_RECEIVER}` 改回
 * `am broadcast -a ADB_INPUT_TEXT`，或把接收器的 `getSentFromUid()` 改回
 * `Intent::class.java.getMethod("getSentFromUid")`，对应用例立刻失败。
 */
class AdbKeyboardContractTest {

  /** 仓根（测试工作目录可能是 apk/ 或仓根；按 settings.gradle.kts 向上找）。 */
  private fun repoFile(rel: String): File {
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      if (File(dir, "settings.gradle.kts").isFile) return File(dir, rel)
      dir = dir.parentFile
    }
    throw AssertionError("找不到仓根（settings.gradle.kts），工作目录 = " + File(".").absolutePath)
  }

  private fun shellSource(name: String): String =
    repoFile("app/src/main/java/com/dsharnessmobile/shell/$name").readText()

  /** 去掉注释行（注释里写 API 名不算命中——与本仓静态门禁同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  // ── 静态判据 ────────────────────────────────────────────────────────────────

  @Test
  fun receiverTakesUidFromFrameworkNotIntentReflection() {
    val code = codeOnly(shellSource("AdbKeyboardReceiver.kt"))
    assertTrue("必须用 BroadcastReceiver.getSentFromUid()", code.contains("getSentFromUid()"))
    assertFalse(
      "Intent 没有 getSentFromUid（反射恒抛，白名单恒失效）",
      code.contains("Intent::class.java.getMethod"),
    )
  }

  @Test
  fun serviceRegistersExportedRuntimeReceiverForImplicitBroadcasts() {
    val code = codeOnly(shellSource("AdbKeyboardService.kt"))
    assertTrue(
      "经典隐式协议必须由运行期接收器承担（targetSdk 26+ manifest 接收器收不到隐式广播）",
      code.contains("registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)"),
    )
    assertTrue("运行期接收器必须随 IME 销毁注销", code.contains("unregisterReceiver(receiver)"))
  }

  @Test
  fun manifestReceiverIsExportedAndDeclaresBothActions() {
    val xml = repoFile("app/src/main/AndroidManifest.xml").readText()
    val element = Regex("<receiver[^>]*android:name=\"\\.AdbKeyboardReceiver\"[\\s\\S]*?</receiver>").find(xml)
      ?: Regex("<receiver[^>]*android:name=\"\\.AdbKeyboardReceiver\"[^>]*/>").find(xml)
    assertNotNull("manifest 必须声明 .AdbKeyboardReceiver", element)
    val text = element!!.value
    assertTrue("接收器必须 exported（adb shell 是外部 uid）", text.contains("android:exported=\"true\""))
    assertTrue("必须声明 ADB_INPUT_TEXT", text.contains("ADB_INPUT_TEXT"))
    assertTrue("必须声明 ADB_CLEAR_TEXT", text.contains("ADB_CLEAR_TEXT"))
  }

  @Test
  fun unorderedBroadcastMustNotWriteResultCode() {
    val code = codeOnly(shellSource("AdbKeyboardReceiver.kt"))
    assertTrue(
      "无序广播没有结果通道，setResultCode 会触发框架栈（导出接收器可被任意应用打到）",
      code.contains("isOrderedBroadcast()"),
    )
    assertTrue("结果码必须经统一入口写入", code.contains("setOrderedResult("))
  }

  @Test
  fun twoReceiverFormsNeverHandleTheSameBroadcast() {
    val input = AdbKeyboardService.ACTION_INPUT_TEXT
    val clear = AdbKeyboardService.ACTION_CLEAR_TEXT
    // 运行期实例：只接纯隐式（无 component 也无 package）
    assertTrue("纯隐式广播 → 运行期实例", AdbKeyboardReceiver.shouldHandle(input, false, false, true))
    assertTrue("清空动作同样成立", AdbKeyboardReceiver.shouldHandle(clear, false, false, true))
    assertFalse("点名组件不得再被运行期实例处理（会提交两遍）", AdbKeyboardReceiver.shouldHandle(input, true, false, true))
    assertFalse("点名包不得再被运行期实例处理（会提交两遍）", AdbKeyboardReceiver.shouldHandle(input, false, true, true))
    // manifest 实例：只接点名/点名包
    assertTrue("点名组件 → manifest 实例", AdbKeyboardReceiver.shouldHandle(input, true, false, false))
    assertTrue("点名包 → manifest 实例", AdbKeyboardReceiver.shouldHandle(input, false, true, false))
    assertFalse("纯隐式即使被平台投递也不得由 manifest 实例处理（防双提交）", AdbKeyboardReceiver.shouldHandle(input, false, false, false))
    // 动作白名单
    assertFalse("非白名单动作一律忽略", AdbKeyboardReceiver.shouldHandle("ADB_OTHER", false, false, true))
    assertFalse("空动作一律忽略", AdbKeyboardReceiver.shouldHandle(null, false, false, false))
  }

  @Test
  fun engineBroadcastNamesReceiverComponentAndParsesResult() {
    val module = repoFile("plugins/dsh-android-manage/src/ime-broadcast.ts").readText()
    assertTrue(
      "广播命令必须点名组件（am broadcast -n …）",
      module.contains("am broadcast -n \${KB_RECEIVER}"),
    )
    assertTrue(
      "必须能解析壳侧结果码（否则 result=0 与「已提交」无法区分）",
      module.contains("Broadcast completed"),
    )
    val tool = repoFile("plugins/dsh-android-manage/src/index.ts").readText()
    assertTrue("android_ui_input 必须走命令构造器", tool.contains("adbKeyboardBroadcast("))
    assertTrue("android_ui_input 必须读结果码", tool.contains("parseBroadcastResult("))
    assertTrue("失败必须按结果码分类说明", tool.contains("KB_RESULT.rejected"))
  }

  // ── 纯逻辑判据 ──────────────────────────────────────────────────────────────

  @Test
  fun onlyRootIsImplicitlyTrustedUid() {
    assertTrue("root", AdbKeyboardService.isTrustedUid(0))
    assertFalse("#679：adb shell(2000) 不再隐式可信——Shizuku 应用可持该身份", AdbKeyboardService.isTrustedUid(2000))
    assertFalse("普通应用 uid 不在白名单", AdbKeyboardService.isTrustedUid(10123))
    assertFalse("取不到发送方（INVALID_UID=-1）不得放行", AdbKeyboardService.isTrustedUid(-1))
  }

  @Test
  fun nonRootSenderWithoutNonceIsRejected() {
    // 纯判据面（[AdbKeyboardService.isTrustedSender] 负责从 nonce 文件收敛出 fileSecret；
    // JVM 单测没有可实例化的 Context，context→secret 的读文件路径不在此测）。
    assertFalse("uid 2000 无 nonce 必须拒（#679：Shizuku 冒用面）", AdbKeyboardService.isTrustedSenderFor(2000, null, "any"))
    assertFalse("uid 2000 带 nonce 但无有效 secret（文件缺失/不可读）同样拒（fail-closed）",
      AdbKeyboardService.isTrustedSenderFor(2000, "x", null))
    assertFalse("uid 2000 nonce 不匹配必须拒", AdbKeyboardService.isTrustedSenderFor(2000, "x", "y"))
    assertTrue("uid 2000 nonce 匹配放行（经典 adb 路径的合法新形态：--es auth 携带 nonce）",
      AdbKeyboardService.isTrustedSenderFor(2000, "x", "x"))
    assertFalse("普通应用无 nonce 必须拒", AdbKeyboardService.isTrustedSenderFor(10123, null, "any"))
    assertTrue("普通应用带有效 nonce 放行（引擎路径，本就以应用 uid 运行）",
      AdbKeyboardService.isTrustedSenderFor(10123, "x", "x"))
    assertTrue("root 不要求 nonce（本已拥有设备全部权限）", AdbKeyboardService.isTrustedSenderFor(0, null, null))
  }

  @Test
  fun nonceComparisonIsExactAndNeverAcceptsEmptySecret() {
    assertTrue(AdbKeyboardService.trustNonce("deadbeef", "deadbeef"))
    assertFalse("错一位即拒", AdbKeyboardService.trustNonce("deadbeee", "deadbeef"))
    assertFalse("空 nonce 不是有效凭据", AdbKeyboardService.trustNonce("", ""))
    assertFalse("空 nonce 不能匹配空文件", AdbKeyboardService.trustNonce("", "x"))
    assertFalse("非空 nonce 不能匹配空 secret", AdbKeyboardService.trustNonce("x", ""))
  }

  @Test
  fun resultCodesAreStableContract() {
    assertEquals(1, AdbKeyboardService.RESULT_COMMITTED)
    assertEquals(2, AdbKeyboardService.RESULT_IME_NOT_READY)
    assertEquals(3, AdbKeyboardService.RESULT_REJECTED)
    assertEquals(4, AdbKeyboardService.RESULT_BAD_REQUEST)
    assertEquals(5, AdbKeyboardService.RESULT_NO_CONNECTION)
  }

  @Test
  fun imeNotReadyIsReportedInsteadOfSilentSuccess() {
    assertEquals(
      "未激活时必须返回「未就绪」而不是成功码",
      AdbKeyboardService.RESULT_IME_NOT_READY,
      AdbKeyboardService.handle(AdbKeyboardService.ACTION_INPUT_TEXT, "x"),
    )
  }
}
