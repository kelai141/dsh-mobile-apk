package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * apk #1151 回归：PhotoCaptureController 不得在**构造期**访问 Activity 上下文。
 *
 * 缺陷形态（dev-fast 全新安装，冷启必崩）：
 *   FATAL EXCEPTION: main
 *   Caused by: NullPointerException: 'android.content.Context.getCacheDir()' on a null object
 *     at PhotoCaptureController.pendingStateFile(PhotoCaptureController.kt:55)
 *     at PhotoCaptureController.restorePendingState(PhotoCaptureController.kt:84)
 *     at PhotoCaptureController.<init>(PhotoCaptureController.kt:52)
 *     at MainActivity.<init>(MainActivity.kt:135)
 *
 * 真因：本类是 MainActivity 的**字段初始化**产物（早于 onCreate），那一刻 Activity 的 base
 * context 尚未 attach，ContextWrapper.getCacheDir() 的 mBase 为 null。同级控制器
 * （DirectoryPicker/MediaPick/SplashImport）都不在字段初始化里读 activity.*，只有这里读了。
 *
 * 修法：构造期不再触发恢复；恢复入口改为 [PhotoCaptureController.restoreWhenReady]，由
 * MainActivity.onCreate 首段调用（已在 attachBaseContext 之后），幂等。
 *
 * 判据选择说明：这是**源码级判据**。行为判据需要真实 Activity 的 base context 未 attach 的
 * 状态，JVM 单测里造不出来；而缺陷本体是「构造期就碰上下文」这个形状，源码判据能直接钉住。
 * 显式标注：本条不当行为证据用。
 */
class PhotoCaptureColdStartTest {

  private fun source(): String = File("src/main/java/com/dsharnessmobile/shell/PhotoCaptureController.kt")
    .takeIf { it.isFile }
    ?.readText()
    ?: File("app/src/main/java/com/dsharnessmobile/shell/PhotoCaptureController.kt").readText()

  @Test
  fun constructorMustNotRestorePendingState() {
    val src = source()
    // 反证：把 init { restorePendingState() } 加回去，这条立刻红。
    assertFalse(
      "构造期不得调用 restorePendingState（会读 activity.cacheDir → 冷启 NPE）",
      Regex("init\\s*\\{[^}]*restorePendingState").containsMatchIn(src),
    )
    assertFalse(
      "构造期不得直接初始化 pendingStateFile",
      Regex("init\\s*\\{[^}]*pendingStateFile").containsMatchIn(src),
    )
  }

  @Test
  fun restoreEntryPointExistsAndIsCallableFromOnCreate() {
    val src = source()
    assertTrue(
      "必须提供 restoreWhenReady() 作为就绪后的恢复入口",
      Regex("fun\\s+restoreWhenReady\\s*\\(").containsMatchIn(src),
    )
    assertTrue("恢复入口必须幂等（有 restored 标记）", src.contains("restored"))
  }

  @Test
  fun cacheDirAccessIsGuarded() {
    val src = source()
    // 反证：把 runCatching 去掉、直接 activity.cacheDir，这条红。
    assertTrue(
      "activity.cacheDir 的访问必须被兜住（上下文未就绪时返回 null 而不是抛）",
      Regex("pendingStateFile\\s*\\(\\s*\\)\\s*:\\s*File\\?[^\\n]*\\n?[^\\n]*runCatching").containsMatchIn(src)
        || Regex("runCatching\\s*\\{[^}]*activity\\.cacheDir").containsMatchIn(src),
    )
  }

  @Test
  fun mainActivityCallsRestoreFromOnCreate() {
    val src = File("src/main/java/com/dsharnessmobile/shell/MainActivity.kt")
      .takeIf { it.isFile }
      ?.readText()
      ?: File("app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt").readText()
    // 反证：删掉 onCreate 里那一行，恢复就再也不会发生（#1007 回归）。
    assertTrue(
      "MainActivity.onCreate 必须调用 photoCaptureController.restoreWhenReady()",
      src.contains("photoCaptureController.restoreWhenReady()"),
    )
  }
}
