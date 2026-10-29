package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #676：更新目录只增不减 + 安装前不重验字节。
 *
 * 两条判据各自的现场：
 *  - 目录卫生：`updatesDir` 落在公共外部存储（`Documents/dshdata/updates`），全仓只有"写"没有"删"，
 *    每换一版多一个 169MB 的包，进程被杀还会留下 `.tmp`；
 *  - 字节绑定：`install()` 旧实现只判 `exists()`，而"安装未知应用"授权页可以停留任意久，
 *    期间同名 APK 可被替换 —— 装进安装器的是 T0 的校验结论、T1 的字节。
 *
 * 第 2 条走源码契约：install() 是 UI-thread 方法（要 Activity + 授权页），JVM 上起不来；
 * 能离线钉住的是"拉起安装器之前必须按当初的依据重跑 verifyApkArtifact"这个接线关系。
 */
class UpdateArtifactRecheckTest {

  private fun src(name: String): String =
    File(File("src/main/java/com/dsharnessmobile/shell"), name).readText()

  @Test
  fun `清扫只留本次目标包，删掉更早的 apk 与残留 tmp`() {
    val dir = Files.createTempDirectory("updates-prune").toFile()
    val keep = File(dir, "dsh-mobile-apk-v0.14.8.apk").apply { writeBytes(ByteArray(16)) }
    val stale = File(dir, "dsh-mobile-apk-v0.14.7.apk").apply { writeBytes(ByteArray(16)) }
    val partial = File(dir, "dsh-mobile-apk-v0.14.8.apk.tmp").apply { writeBytes(ByteArray(8)) }
    val removed = UpdateChecker.pruneUpdatesDir(dir, keep.name)
    assertEquals("应删掉 1 个旧包 + 1 个残留 tmp", 2, removed)
    assertTrue("本次目标包必须留着", keep.isFile)
    assertFalse(stale.exists())
    assertFalse(partial.exists())
  }

  @Test
  fun `清扫不碰目录与无关文件`() {
    val dir = Files.createTempDirectory("updates-prune-safe").toFile()
    val sub = File(dir, "keep-dir").apply { mkdirs() }
    val note = File(dir, "notes.txt").apply { writeText("x") }
    val removed = UpdateChecker.pruneUpdatesDir(dir, null)
    assertEquals("没有 apk/tmp 时不该删任何东西", 0, removed)
    assertTrue(sub.isDirectory)
    assertTrue(note.isFile)
  }

  @Test
  fun `目录不存在时不抛异常`() {
    val missing = File(Files.createTempDirectory("updates-missing").toFile(), "nope")
    assertEquals(0, UpdateChecker.pruneUpdatesDir(missing, "x.apk"))
  }

  @Test
  fun `install 拉起安装器之前必须按当初的依据重验字节`() {
    val action = src("ApkUpdateAction.kt")
    val start = action.indexOf("private fun install(dest: File, reused: Boolean)")
    assertTrue("找不到 install()", start > 0)
    val end = action.indexOf("private fun ", start + 10)
    val body = action.substring(start, if (end > start) end else action.length)
    assertTrue("install() 必须记住校验依据", body.contains("verifiedArtifact"))
    assertTrue("install() 必须重跑 verifyApkArtifact（只判 exists 不够）", body.contains("verifyApkArtifact("))
    assertTrue(
      "复验失败必须清掉续继载荷（否则下次「继续安装」会把同一个坏包装进去）",
      body.contains("readyToInstall = null"),
    )
    assertTrue("向下传的必须是当初的大小/摘要依据", body.contains("verified.expectedSha256"))
  }

  @Test
  fun `安装器拉起后必须丢掉校验依据，避免下一轮误判`() {
    val action = src("ApkUpdateAction.kt")
    val start = action.indexOf("if (UpdateChecker.invokeInstaller(activity, dest)) {")
    assertTrue("找不到安装器成功分支", start > 0)
    val branch = action.substring(start, start + 420)
    assertTrue("成功后要清 verifiedArtifact", branch.contains("verifiedArtifact = null"))
    assertTrue("成功后仍要清续继载荷", branch.contains("readyToInstall = null"))
  }

  @Test
  fun `下载收尾要把依据绑到产物上`() {
    val action = src("ApkUpdateAction.kt")
    assertTrue(
      "downloadAndInstall 必须记录 VerifiedArtifact(dest, size, sha256)",
      action.contains("verifiedArtifact = VerifiedArtifact(dest, r.sizeBytes, r.sha256)"),
    )
  }
}
