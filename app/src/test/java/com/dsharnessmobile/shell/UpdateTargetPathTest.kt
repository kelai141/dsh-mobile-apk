package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 产物文件名不得把落点带出 `updatesDir`（2026-10-28 自查，安全面）。
 *
 * 名字最上游来自发布元数据；`assetNameCandidates` 把 tag 原样插值进文件名。
 * 带分隔符的 tag ⇒ `File(updatesDir, name)` 落到任意可写目录，而 batch4 起
 * `pruneUpdatesDir(dest.parentFile)` 会在**那个目录**里删 `*.apk`/`*.tmp`。
 */
class UpdateTargetPathTest {
  @get:Rule val tmp = TemporaryFolder()

  private fun dir() = tmp.newFolder("updates")

  @Test
  fun separatorAndTraversalNamesAreRejected() {
    val d = dir()
    for (bad in listOf(
      "../x.apk",
      "..",
      ".",
      "a/../../x.apk",
      "/sdcard/x.apk",
      "sub/x.apk",
      "x.apk ",
      " x.apk",
      "x.APK",
      "x.apk.tmp",
      "",
      ".apk",
      "dsh-mobile-apk-v9../../Documents/x-arm64.apk",
    )) {
      assertNull("必须拒绝：$bad", UpdateChecker.resolveUpdateTarget(d, bad))
      assertFalse("isSafeArtifactName 也该拒绝：$bad", UpdateChecker.isSafeArtifactName(bad))
    }
  }

  @Test
  fun normalArtifactNamesResolveInsideTheUpdatesDirectory() {
    val d = dir()
    for (good in listOf(
      "dsh-mobile-apk-v0.14.8-arm64.apk",
      "dsh-mobile-apk-v0.14.5+build.7-arm64-v8a.apk",
      "a.apk",
    )) {
      val resolved = UpdateChecker.resolveUpdateTarget(d, good)
      assertTrue("应当解析成功：$good", resolved != null)
      assertEquals("落点父目录必须是 updatesDir：$good", d.canonicalFile, resolved!!.parentFile)
    }
  }

  @Test
  fun danglingSymlinkIsRejectedToo() {
    val d = dir()
    val outside = tmp.newFolder("outside-dangling")
    try {
      java.nio.file.Files.createSymbolicLink(
        File(d, "dangling.apk").toPath(),
        File(outside, "not-yet-created.apk").toPath(),
      )
    } catch (_: Exception) {
      return
    }
    // `canonicalFile` 对指向不存在目标的链接不解引用 ⇒ 只靠 parent 判据会放行；
    // 必须显式拒绝符号链接本身，否则写入会跟着链接落到目录外。
    assertNull("悬空符号链接也必须拒", UpdateChecker.resolveUpdateTarget(d, "dangling.apk"))
  }

  @Test
  fun symlinkedTargetCannotEscape() {
    val d = dir()
    val outside = tmp.newFolder("outside")
    // 目录里放一个指向外面的符号链接：形态合法，但 canonical 之后父目录不是 updatesDir。
    File(outside, "victim.apk").writeText("x") // 目标存在，canonical 才会解引用
    try {
      java.nio.file.Files.createSymbolicLink(
        File(d, "link.apk").toPath(),
        File(outside, "victim.apk").toPath(),
      )
    } catch (_: Exception) {
      return // 该文件系统不支持符号链接：跳过（本机 JVM 上通常会成功）
    }
    assertNull("符号链接不得逃出 updatesDir", UpdateChecker.resolveUpdateTarget(d, "link.apk"))
  }
}
