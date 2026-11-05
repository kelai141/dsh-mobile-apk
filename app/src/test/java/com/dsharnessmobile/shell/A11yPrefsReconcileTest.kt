package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #648 自愈：a11y 处理器缺席时把 prefs 的 a11yEnabled 回写成 false，且能自己回正。
 *
 * 缺陷形态：prefs 的 a11yEnabled 在进程被 force-stop 后残留 true（onDestroy 不保证执行），
 * 而引擎侧 a11ySource() 只认新鲜心跳——心跳断了引擎侧会正确判离线，但 prefs 里那行
 * 僵尸 true 一直留着，两侧长期不一致。
 *
 * 判据（本文件锁住四条）：
 *  1. 触发条件**只有**「a11y 处理器引用为 null」，与任何一次 op 的成败无关；
 *  2. 回写走 setEnabledFlag(false) 同一条落盘路径：a11yEnabled=false 且心跳键被删除；
 *  3. 闭环：服务重新连上时 onServiceConnected 会写回 true，不会永久钉死；
 *  4. 幂等：已经是 false 时直接返回，不重复落盘（a11y 死掉后每条 op 都会进这个分支）。
 *
 * 反证口径：把 ControlCarrier 的触发条件改成「else 分支一律回写」（不看 handler 是否为 null），
 * 或删掉 onServiceConnected 里的 setEnabledFlag(true)，下面都会变红。
 *
 * **能力边界（必须如实理解）**：本文件是**源码文本断言**（readSource + lineSequence），
 * 只能证明「守卫在场、顺序正确、判据写在预期位置」，**证明不了运行时行为**——它不知道
 * SharedPreferences 真的被写成什么、也不知道 a11y 服务真的有没有绑定。运行时判据在
 * 设备层（关 a11y → 调 android_privilege_status → 读 prefs；重连 → 读 prefs 回正）。
 * 这类源码文本测试在全仓有大量先例，属仓库惯例，但它替代不了设备验收。
 */
class A11yPrefsReconcileTest {

  private fun readSource(rel: String): String {
    val candidates = listOf(
      java.io.File("src/main/java/com/dsharnessmobile/shell/" + rel),
      java.io.File("app/src/main/java/com/dsharnessmobile/shell/" + rel),
    )
    return candidates.first { it.isFile }.readText()
  }

  /** 去掉注释行，避免注释里提到某个词就让断言误判。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  @Test
  fun a11y不可用分支必须只在处理器为null时回写() {
    val code = codeOnly(readSource("ControlCarrier.kt"))
    // 回写调用必须在场（否则僵尸 true 永远不被纠正）。
    assertTrue(
      "a11y 缺席分支必须回写 prefs",
      code.contains("DeviceControlService.markUnavailable("),
    )
    // 但必须被 handler == null 这个判据守卫住：不能因为一次 op 失败就改状态。
    val branch = code.substringAfter("val handler = a11y").substringBefore("a11y-unavailable")
    assertTrue(
      "回写必须包在 handler == null 判据里（不得对任意失败回写）",
      branch.contains("if (handler == null)"),
    )
    // 反证：old 形态 a11y?.handle(...) 直接调用（无 handler 局部变量）时这条会生效——
    // 断言分支里确实先取了 handler，而不是直接对可空 receiver 调 ?.handle。
    assertTrue("分支必须先取 handler 再判空", branch.contains("handler?.handle("))
  }

  @Test
  fun markUnavailable写false并删除心跳键() {
    val code = codeOnly(readSource("DeviceControlService.kt"))
    // 复用 setEnabledFlag 的落盘路径，不另写一份 edit()。
    val fn = code.substringAfter("fun markUnavailable(context: Context)").substringBefore("private fun setEnabledFlag")
    assertTrue("必须复用 setEnabledFlag(false)", fn.contains("setEnabledFlag(context, false)"))
    // 路径语义：setEnabledFlag(false) 本身必须是 putBoolean(false) + remove(heartbeat)。
    val flag = code.substringAfter("private fun setEnabledFlag(context: Context, enabled: Boolean)")
      .substringBefore("fun heartbeat(")
    assertTrue("必须写 a11yEnabled", flag.contains("putBoolean(KEY_A11Y, enabled)"))
    assertTrue("关闭时必须删掉心跳键", flag.contains("else editor.remove(KEY_HEARTBEAT)"))
  }

  @Test
  fun 闭环_服务重连必须把prefs改回true() {
    val code = codeOnly(readSource("DeviceControlService.kt"))
    val connected = code.substringAfter("override fun onServiceConnected()").substringBefore("override fun onAccessibilityEvent")
    assertTrue(
      "onServiceConnected 必须把 a11yEnabled 改回 true，否则一次回写就永久 false",
      connected.contains("setEnabledFlag(this, true)"),
    )
    // 顺序也很重要：先把状态写成 true，再登记处理器（否则登记后到写盘前有一段状态不一致窗口）。
    assertTrue(
      "必须先置 true 再登记 ControlCarrier.a11y",
      connected.indexOf("setEnabledFlag(this, true)") < connected.indexOf("ControlCarrier.a11y = this"),
    )
  }

  @Test
  fun markUnavailable必须是幂等的_已为false时不再落盘() {
    val code = codeOnly(readSource("DeviceControlService.kt"))
    val fn = code.substringAfter("fun markUnavailable(context: Context)").substringBefore("private fun setEnabledFlag")
    // 必须先读当前值并提前返回，否则 a11y 死掉后每条 op 都会写一次 prefs + 记一条日志。
    assertTrue(
      "必须先读当前 a11yEnabled 值",
      fn.contains("getBoolean(KEY_A11Y"),
    )
    assertTrue(
      "已为 false 时必须提前 return（不写盘、不记日志）",
      fn.contains("if (!prefs.getBoolean(KEY_A11Y, false)) return"),
    )
    // 反证：判空必须发生在 setEnabledFlag 调用之前，否则等于没判。
    val guardAt = fn.indexOf("getBoolean(KEY_A11Y")
    val writeAt = fn.indexOf("setEnabledFlag(context, false)")
    assertTrue("判空必须在落盘之前", guardAt in 0 until writeAt)
    val logAt = fn.indexOf("LogCollector.log(TAG")
    assertTrue("日志也必须在判空之后", guardAt < logAt)
  }

  @Test
  fun markUnavailable不碰令牌() {
    val code = codeOnly(readSource("DeviceControlService.kt"))
    val fn = code.substringAfter("fun markUnavailable(context: Context)").substringBefore("private fun setEnabledFlag")
    assertFalse("回写只改 a11y 状态，不得清令牌", fn.contains("KEY_TOKEN"))
    assertFalse("回写不做 teardown（服务本来就没连）", fn.contains("teardown()"))
  }

  @Test
  fun 心跳键常量与消费者窗口仍然对得上() {
    val code = codeOnly(readSource("DeviceControlService.kt"))
    assertTrue("心跳键名必须保持 controlHeartbeat", code.contains("const val KEY_HEARTBEAT = \"controlHeartbeat\""))
    assertTrue("a11y 键名必须保持 a11yEnabled", code.contains("const val KEY_A11Y = \"a11yEnabled\""))
    // 引擎侧消费者窗口 20s，心跳节拍 5s：余量 4 倍（与 A11yHeartbeatCadenceTest 同口径）。
    assertEquals(4L, 20_000L / ControlPoller.HEARTBEAT_INTERVAL_MS)
  }
}
