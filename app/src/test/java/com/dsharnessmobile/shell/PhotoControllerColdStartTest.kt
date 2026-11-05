package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0：控制器构造不得读 Context（冷启必崩）。
 *
 * 缺陷现场（真机 FATAL，全新安装冷启必现）：
 *   NullPointerException: "android.content.Context.getCacheDir()" on a null object reference
 *     at PhotoCaptureController.pendingStateFile(PhotoCaptureController.kt:55)
 *     at PhotoCaptureController.<init>(PhotoCaptureController.kt:52)
 *     at MainActivity.<init>(MainActivity.kt:135)
 *
 * 根因：MainActivity 的字段初始化建出控制器，那一刻 Activity 还没跑完 attachBaseContext，
 * activity.cacheDir 是 null；旧实现的 init { restorePendingState() } 第一行就取 cacheDir。
 *
 * 为什么是源码级判据：本仓 JVM 单测没有 Robolectric/Mockito（app/build.gradle.kts 的
 * testImplementation 只有 junit 与 org.json），无法在 JVM 里 new 出一个未 attach 的 Activity，
 * 因此「控制器在未 attach 的 Activity 下构造不抛」无法用行为断言表达。退而钉住产生该行为的
 * 代码形状——这是能真正变红的那一层，且显式标注为源码判据，不当行为证据用。
 *
 * 负控：把 restoreNow() 从 MainActivity.onCreate 搬回 init { restorePendingState() }，
 * 第一条与第三条必红。
 */
class PhotoControllerColdStartTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 只留代码行：注释里必然复述旧的错误写法，对全文断言会被自己的说明判红。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** init 块的正文（构造里允许出现的语句）。 */
  private fun initBlock(code: String): String {
    val i = code.indexOf("init {")
    if (i < 0) return ""
    val j = code.indexOf("\n  }", i)
    return if (j < 0) code.substring(i) else code.substring(i, j)
  }

  @Test
  fun `控制器 init 里不得出现会读 Context 的恢复调用`() {
    val code = codeOnly(source("PhotoCaptureController.kt"))
    val init = initBlock(code)
    assertTrue("必须仍存在 init 块（否则本判据失去对象，可能是被整体删掉而不是修好）", init.isNotBlank())
    assertFalse(
      "init 里不得调 restorePendingState()——那会读 activity.cacheDir，而未 attach 时为 null",
      init.contains("restorePendingState("),
    )
    assertFalse(
      "init 里不得直接读 activity.cacheDir / filesDir",
      init.contains("cacheDir") || init.contains("filesDir"),
    )
  }

  @Test
  fun `恢复入口必须存在且可被 onCreate 调用`() {
    val code = codeOnly(source("PhotoCaptureController.kt"))
    assertTrue("必须提供 restoreNow() 作为 onCreate 侧的恢复入口",
      code.contains("fun restoreNow()"))
    val body = code.substringAfter("fun restoreNow()")
    assertTrue("restoreNow 必须真的执行恢复（不得是空实现）",
      body.contains("restorePendingState("))
  }

  @Test
  fun `MainActivity 必须在 onCreate 里 super 之后恢复，而不是靠字段初始化`() {
    val main = codeOnly(source("MainActivity.kt"))
    assertTrue("MainActivity 必须调用 restoreNow()", main.contains("photoCaptureController.restoreNow()"))
    val onCreate = main.substringAfter("override fun onCreate(savedInstanceState: Bundle?) {")
    val superAt = onCreate.indexOf("super.onCreate(savedInstanceState)")
    val restoreAt = onCreate.indexOf("photoCaptureController.restoreNow()")
    assertTrue("onCreate 里必须先调 super.onCreate", superAt >= 0)
    assertTrue("恢复必须在 onCreate 内、super.onCreate 之后（此时 cacheDir 才可用）", restoreAt > superAt)
    // 反向：控制器仍必须留在字段初始化（ActivityResult launcher 要在 STARTED 之前注册）。
    assertTrue("控制器构造必须仍在 MainActivity 的字段初始化里",
      Regex("internal val photoCaptureController = PhotoCaptureController\\(this\\)").containsMatchIn(main))
  }
}
