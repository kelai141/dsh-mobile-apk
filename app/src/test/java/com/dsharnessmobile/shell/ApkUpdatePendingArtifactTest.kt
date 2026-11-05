package com.dsharnessmobile.shell

import android.app.Activity
import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #676 续继链载荷的**存在性判据**（2026-10-28 自查）。
 *
 * 缺陷：`readyToInstall` 是一个裸 `File`，`hasReadyArtifact()` 只判 `!= null` ⇒ 包被系统清理
 * （或用户在文件管理器里删掉）之后，控制器仍声称"有可安装包"：页面一直摆着「重试安装」，
 * `start()` 也永远把请求 redirect 到续继链，而真正的**新版永远下不下来**。
 *
 * 为什么不能只写源码断言：这两个事实的持有者是控制器字段，行为必须真执行才看得见——
 * 照 [ApkUpdateEpochPublicationTest] 的反射手法（未初始化的 `Activity()` 只当占位，不调用其方法）。
 */
class ApkUpdatePendingArtifactTest {
  private val controller = ApkUpdateController(Activity())
  private val type = ApkUpdateController::class.java
  private fun field(name: String) = type.getDeclaredField(name).apply { isAccessible = true }

  @Test
  fun artifactDeletedOnDiskMustNotCountAsReady() {
    val missing = File.createTempFile("dsh-gone", ".apk").also { it.delete() }
    assertFalse("前提：临时文件已经不存在", missing.exists())
    field("readyToInstall").set(controller, missing)
    assertFalse(
      "文件已不在磁盘上 ⇒ 不得再声称有可安装包（否则续继链永久堵住下载入口）",
      controller.hasReadyArtifact(),
    )
  }

  @Test
  fun existingArtifactStillCounts() {
    val present = File.createTempFile("dsh-present", ".apk").also { it.writeText("x") }
    try {
      field("readyToInstall").set(controller, present)
      assertTrue("文件仍在 ⇒ 仍应报告可安装（修法不得把正常路径也判死）", controller.hasReadyArtifact())
    } finally {
      present.delete()
    }
  }

  @Test
  fun directoryWithTheSameNameIsNotAnArtifact() {
    val dir = File.createTempFile("dsh-dir", "").let { it.delete(); it.mkdirs(); it }
    try {
      field("readyToInstall").set(controller, dir)
      assertFalse("同名目录不是安装包", controller.hasReadyArtifact())
    } finally {
      dir.delete()
    }
  }

  @Test
  fun theMissingArtifactBranchClearsTheWholeContinuationPayload() {
    // 源码契约（行为面在 install() 里，需要授权页，JVM 上拉不起来）：这一支必须成组清零，
    // 与同函数另外两个失败分支一致。少清一个字段就让续继链永久指向不存在的文件。
    val source = File("src/main/java/com/dsharnessmobile/shell/ApkUpdateAction.kt").readText()
    val branch = source.substringAfter("if (!dest.exists()) {").substringBefore("\n      }")
    assertTrue("必须清 readyToInstall：" + branch, branch.contains("readyToInstall = null"))
    assertTrue("必须清 verifiedArtifact：" + branch, branch.contains("verifiedArtifact = null"))
    assertTrue("必须清 currentResult：" + branch, branch.contains("currentResult = null"))
  }
}
