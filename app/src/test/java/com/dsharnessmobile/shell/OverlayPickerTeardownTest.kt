package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1359：悬浮球面板的 picker 是**独立顶层窗口**，服务销毁时必须一起收口。
 *
 * 缺陷：`OverlayService.onDestroy` 逐个收了 root / halo / unit / report / recall，还调了
 * `panel.destroy()`，而后者只关 mux —— **picker 没人收**。窗口级 `wm.addView` 8 处、
 * `wm.removeView` 5 处，缺的正是它。picker 打开时服务被销毁 → 屏上留一个点不动的孤儿窗口。
 *
 * 判据形态：这条只能在**源码契约**层钉（收口走 Android WindowManager，JVM 单测造不出真窗口）。
 * 所以这里逐条钉住「收口确实接上了」与「关闭本身是幂等的」——这两件事都是结构性事实。
 */
class OverlayPickerTeardownTest {
  private fun repoFile(rel: String): String {
    var root: File? = File(System.getProperty("user.dir")).absoluteFile
    while (root != null && !File(root, rel).isFile) root = root.parentFile
    requireNotNull(root) { "找不到仓库根（" + rel + " 不在任何祖先目录下）" }
    return File(root, rel).readText()
  }

  private val panel by lazy { repoFile("app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt") }
  private val service by lazy { repoFile("app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt") }

  /** 取一个 Kotlin 函数体（从签名行到配对花括号）。 */
  private fun body(signature: String): String {
    val start = panel.indexOf(signature)
    assertTrue("找不到函数：" + signature, start >= 0)
    var depth = 0
    val open = panel.indexOf('{', start)
    for (i in open until panel.length) {
      if (panel[i] == '{') depth++ else if (panel[i] == '}') { depth--; if (depth == 0) return panel.substring(open, i + 1) }
    }
    error("花括号不配对：" + signature)
  }

  @Test fun destroyClosesPickerBeforeClosingMux() {
    val body = body("internal fun destroy()")
    assertTrue("destroy() 里没有 closePicker()：服务销毁后 picker 会成为孤儿窗口", body.contains("closePicker()"))
    // 顺序：先收窗口，再断连接（连接一断，后续 UI 收口就没人驱动了）
    assertTrue(
      "必须先 closePicker() 再改 mux（实得：" + body.replace('\n', ' ') + "）",
      body.indexOf("closePicker()") < body.indexOf("mux"),
    )
  }

  @Test fun closePickerIsIdempotent() {
    val body = body("internal fun closePicker()")
    // 空安全：重复调用时 pickerWindow 已是 null，必须直接跳过（否则 NPE）
    assertTrue("closePicker() 必须先判空再移除", body.contains("pickerWindow?.let"))
    // 无条件置空：这是「第二次调用是 no-op」的前提；若只在自己移除成功时置空，
    // 异常路径会留下非空引用 → 第二次调用重复 removeView。
    assertTrue("pickerWindow 必须无条件置空", Regex("pickerWindow = null").containsMatchIn(body))
    assertTrue("pickerRowView 也要置空（否则持有已销毁容器内的 View）", Regex("pickerRowView = null").containsMatchIn(body))
    // 移除必须容忍异常：重复调用 / 父已摘 / 窗口已失效 都不该抛
    assertTrue("removeView 必须包在 try/catch 里", body.contains("catch"))
  }

  @Test fun serviceOnDestroyReachesPanelTeardown() {
    val start = service.indexOf("override fun onDestroy()")
    assertTrue("找不到 OverlayService.onDestroy", start >= 0)
    val end = service.indexOf("super.onDestroy()", start)
    assertTrue("onDestroy 结构漂移了", end > start)
    val block = service.substring(start, end)
    assertTrue(
      "onDestroy 必须调用 panel.destroy()（picker 的收口就挂在它里面）",
      block.contains("panel.destroy()"),
    )
    // 反向：确认这条收口**不是**靠 report/recall 顺带完成的——它们是各自独立的顶层窗口。
    assertTrue("report 必须自己收口", block.contains("report.hideReport()"))
    assertTrue("recall 必须自己收口", block.contains("recall.hide()"))
  }

  @Test fun pickerStillHasItsOwnWindowLifecycle() {
    // 防「把 picker 改成非窗口」这种重构：一旦不再是独立顶层窗口，本 issue 的整条判据就失去意义，
    // 这条会红并提醒同步改判据，而不是留下一个永远为真的断言。
    val open = body("private fun openPickerWindow()")
    assertTrue("picker 必须仍是独立顶层窗口（wm.addView）", open.contains("wm.addView"))
    assertFalse("openPickerWindow 里不应该自己 removeView", open.contains("removeView"))
  }
}
