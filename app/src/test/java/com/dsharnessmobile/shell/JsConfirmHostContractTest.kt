package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1383：`window.confirm()` 在壳侧必须有实现，且必须「恰好结算一次」。
 *
 * 为什么需要这一层：宿主没实现 `onJsConfirm` 时 Android 的**默认行为是直接 cancel()**，
 * 于是页面里 `confirm()` 恒为 false —— 快照面板的「恢复 / 删除 / 切换安全模式」三个
 * 破坏性动作既没有对话框、也没有提示、也不发请求，界面完全无反应。
 * 这条缺陷长期没被发现，正是因为 `onJsAlert` 有实现而 `onJsConfirm` 没有：
 * 同页面里 `alert()` 类提示正常显示，形成不对称。
 *
 * 本机没有设备时这是**静态判据**：只认源码字面（基类是否 override、两条结算路径是否都在、
 * 是否有一致性守卫与结束态守卫、两个宿主是否真的用了这个基类）。运行时行为另需设备/
 * CDP 层验收，判据见 PR 描述。
 */
class JsConfirmHostContractTest {

  private val shellDir: File = listOf(
    File("src/main/java/com/dsharnessmobile/shell"),
    File("app/src/main/java/com/dsharnessmobile/shell"),
  ).first { it.isDirectory }

  private fun source(name: String): String = File(shellDir, name).readText()

  /** 去掉整行注释，避免注释里提到 onJsConfirm 被当成实现。 */
  private fun codeOnly(text: String): String = text.lineSequence().filterNot {
    val line = it.trimStart()
    line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
  }.joinToString("\n")

  private fun confirmBody(): String {
    val code = codeOnly(source("JsConfirmChromeClient.kt"))
    val at = code.indexOf("override fun onJsConfirm(")
    assertTrue("JsConfirmChromeClient 没有 override onJsConfirm（issue #1383）", at >= 0)
    return code.substring(at)
  }

  @Test
  fun baseClientImplementsOnJsConfirm() {
    // 实现必须落在基类里：两个宿主的匿名 WebChromeClient 都继承它，一次覆盖全部调用方。
    assertTrue("JsConfirmChromeClient.kt 必须存在", File(shellDir, "JsConfirmChromeClient.kt").isFile)
    assertTrue("基类必须是 WebChromeClient 的子类",
      codeOnly(source("JsConfirmChromeClient.kt")).contains(": WebChromeClient()"))
    confirmBody()
  }

  @Test
  fun bothHostsActuallyUseTheBaseClient() {
    // 只写基类而不接到宿主上等于没修——这条钉住「真的接上了」。
    assertTrue("MainActivity 的 webChromeClient 必须用 JsConfirmChromeClient",
      codeOnly(source("MainActivity.kt")).contains("object : JsConfirmChromeClient(this@MainActivity)"))
    assertTrue("BrowserHost 的 webChromeClient 必须用 JsConfirmChromeClient",
      codeOnly(source("BrowserHost.kt")).contains("object : JsConfirmChromeClient(activity)"))
  }

  @Test
  fun confirmSettlesBothWays() {
    val body = confirmBody()
    assertTrue("onJsConfirm 缺 result.confirm()（确认无路可走）", body.contains("result.confirm()"))
    assertTrue("onJsConfirm 缺 result.cancel()（取消无路可走）", body.contains("result.cancel()"))
  }

  @Test
  fun confirmSettlesExactlyOnce() {
    // JsResult 重复结算会抛。对话框可能同时触发「按钮回调」与「取消回调」，
    // 必须有一次性守卫，否则用户在对话框上按返回键就会崩。
    val body = confirmBody()
    assertTrue("onJsConfirm 缺一次性守卫（重复结算会抛）", body.contains("settled"))
    assertTrue("一次性守卫必须是「已结算就不再结算」的形态", body.contains("if (!settled)"))
  }

  @Test
  fun confirmCancelsWhenHostIsFinishing() {
    // 宿主正在结束时不要弹窗：否则会留下一个永远不会结算的 JsResult。
    val body = confirmBody()
    assertTrue("onJsConfirm 必须在结束态直接 cancel",
      body.contains("isFinishing") && body.contains("isDestroyed"))
  }

  @Test
  fun alertImplementationIsNotLost() {
    // 修 confirm 时把 alert 弄丢同样是回归：alert 走的是自动放行，两条路径必须共存。
    val main = codeOnly(source("MainActivity.kt"))
    assertTrue("MainActivity 丢了 onJsAlert", main.contains("override fun onJsAlert("))
    assertTrue("MainActivity 的 onJsAlert 必须仍然自动放行", main.contains("result.confirm()"))
  }

  @Test
  fun vendoredClientStillGuardsOnConfirm() {
    // 宿主侧修好后，「页面仍然用 confirm 做守卫」这个事实不变；一旦页面改成别的确认方式，
    // 本测试会提醒同步更新判据，而不是让宿主实现悄悄变成死代码。
    var root: File? = shellDir.absoluteFile
    while (root != null && !File(root, "vendor/dsh-undo-savepoint/lib/client.js").isFile) root = root.parentFile
    assertTrue("找不到仓库根（vendor/dsh-undo-savepoint 不在任何祖先目录下）", root != null)
    val client = File(root, "vendor/dsh-undo-savepoint/lib/client.js").readText()
    val guards = Regex("if \\(!window\\.confirm\\(").findAll(client).count()
    // issue #1392：撤销也补上了确认守卫，从 3 处变 4 处。
    assertTrue(
      "vendor/dsh-undo-savepoint/lib/client.js 里的 window.confirm 守卫数量变了（实得 " + guards + "）——" +
        "页面若已改用应用内确认组件，宿主 onJsConfirm 的判据需要同步重写",
      guards == 4,
    )
    // 只数个数不够：把其中一个删掉、另一个复制一遍也能凑够 4。逐条点名四个**破坏性**动作，
    // 任何一处守卫被挪走都会在这里点名失败。
    val sites = listOf(
      "恢复" to "window.confirm(t(\"panel.confirm.restore\")",
      "删除" to "window.confirm(t(\"panel.confirm.delete\")",
      "安全模式" to "window.confirm(on ? t(\"safe.off.confirm\")",
      "撤销" to "window.confirm(t(\"panel.confirm.undo\")",
    )
    for ((label, needle) in sites) {
      assertTrue(
        label + " 的 confirm 守卫不见了（找 " + needle + "）——破坏性动作不得在没有确认的情况下执行",
        client.contains(needle),
      )
    }
  }
}