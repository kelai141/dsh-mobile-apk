package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class SnapshotUserDataTest {

  @Test
  fun neverRollsBackDataThatTheLiveTreeAlreadyHas() {
    val root = Files.createTempDirectory("snapshot-user-data-additive-test").toFile()
    try {
      val backup = File(root, "backup").apply { mkdirs() }
      File(backup, "sessions").mkdirs()
      File(backup, "sessions/a.jsonl").writeText("0123456789")
      File(backup, "sessions/b.jsonl").writeText("recovered")
      val destination = File(root, "destination/.dsh").apply { mkdirs() }
      File(destination, "sessions").mkdirs()
      File(destination, "sessions/a.jsonl").writeText("01234567890123456789")

      val result = SnapshotUserData.restoreLegacyBackup(backup, destination) { }

      assertEquals(1, result.copiedEntries)
      assertEquals(1, result.skippedExisting)
      assertEquals("01234567890123456789", File(destination, "sessions/a.jsonl").readText())
      assertEquals("recovered", File(destination, "sessions/b.jsonl").readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun completesATruncatedFileFromTheBackup() {
    val root = Files.createTempDirectory("snapshot-user-data-truncated-test").toFile()
    try {
      val backup = File(root, "backup/sessions").apply { mkdirs() }
      File(backup, "a.jsonl").writeText("01234567890123456789")
      val destination = File(root, "destination/.dsh/sessions").apply { mkdirs() }
      File(destination, "a.jsonl").writeText("01234")

      val result = SnapshotUserData.restoreLegacyBackup(File(root, "backup"), File(root, "destination/.dsh")) { }

      assertEquals(1, result.copiedEntries)
      assertEquals("01234567890123456789", File(destination, "a.jsonl").readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun restoresSingletonSettingsWholesale() {
    val root = Files.createTempDirectory("snapshot-user-data-singleton-test").toFile()
    try {
      val backup = File(root, "backup").apply { mkdirs() }
      File(backup, "settings.yaml").writeText("user: true\n")
      val destination = File(root, "destination/.dsh").apply { mkdirs() }
      File(destination, "settings.yaml").writeText("factory: true\n")

      SnapshotUserData.restoreLegacyBackup(backup, destination) { }

      assertEquals("user: true\n", File(destination, "settings.yaml").readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun recreatesMissingLinksAndSkipsBrokenLinksWithoutMutatingTheLiveTree() {
    val root = Files.createTempDirectory("snapshot-user-data-links-test").toFile()
    try {
      val backup = File(root, "backup/sessions").apply { mkdirs() }
      val payload = File(backup, "payload.txt").apply { writeText("saved") }
      val validLink = File(backup, "payload-link")
      val brokenLink = File(backup, "missing-link")
      try {
        Files.createSymbolicLink(validLink.toPath(), java.nio.file.Paths.get(payload.name))
        Files.createSymbolicLink(brokenLink.toPath(), java.nio.file.Paths.get("missing"))
      } catch (_: Throwable) {
        assumeTrue("The host must permit symbolic-link creation for this regression test", false)
      }
      val destination = File(root, "destination/.dsh/sessions").apply { mkdirs() }
      val brokenLinks = mutableListOf<File>()

      val result = SnapshotUserData.restoreLegacyBackup(File(root, "backup"), File(root, "destination/.dsh")) {
        brokenLinks += it
      }

      assertEquals(1, result.skippedBrokenLinks)
      assertEquals(1, brokenLinks.size)
      assertEquals("missing-link", brokenLinks.single().name)
      assertTrue(Files.isSymbolicLink(File(destination, "payload-link").toPath()))
      assertFalse(Files.exists(File(destination, "missing-link").toPath(), NOFOLLOW_LINKS))
      // The backup tree is read-only input: its broken link must still be there.
      assertTrue(Files.exists(brokenLink.toPath(), NOFOLLOW_LINKS))
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun doesNothingWhenThereIsNoLegacyBackup() {
    val root = Files.createTempDirectory("snapshot-user-data-absent-test").toFile()
    try {
      val destination = File(root, "destination/.dsh").apply { mkdirs() }
      File(destination, "settings.yaml").writeText("user: true\n")

      val result = SnapshotUserData.restoreLegacyBackup(File(root, "missing"), destination) { }

      assertEquals(0, result.copiedEntries)
      assertEquals("user: true\n", File(destination, "settings.yaml").readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  // ── issue #1566：配置导入必须拒绝执行型 YAML 标签 ─────────────────────────────
  //
  // 缺陷形态：importConfiguration 只校验 isFile && !isSymbolicLink，对内容零检查；而导入源是
  // <外部存储>/exports/config/ 下的文件（任意应用可写），其 !!js 会被引擎 eval 求值。
  //
  // 下面四条是**打红负控**：把 importConfiguration 里那段 firstExecutableTag 校验删掉，
  // rejectsExecutableTagsOnImport 与 leavesActiveConfigUntouchedWhenRejected 立刻变红。

  /** 造一份「已导出」的配置树，返回 (dshRoot, sharedRoot)。 */
  private fun importFixture(root: File, documentText: String): Pair<File, File> {
    val dshRoot = File(root, "dsh").apply { mkdirs() }
    File(dshRoot, "profiles/web").mkdirs()
    File(dshRoot, "profiles/web/cordis.patch.yml").writeText("# live config\nproviders: {}\n")
    val sharedRoot = File(root, "shared").apply { mkdirs() }
    File(sharedRoot, "exports/config").mkdirs()
    File(sharedRoot, "exports/config/cordis.patch.yml").writeText(documentText)
    return dshRoot to sharedRoot
  }

  @Test
  fun rejectsExecutableTagsOnImport() {
    val root = Files.createTempDirectory("config-import-js-tag").toFile()
    try {
      val malicious = listOf(
        "providers:",
        "  openai:",
        "    disabled: !!js process.mainModule.require('child_process').exec('id')",
      ).joinToString("\n")
      val (dshRoot, sharedRoot) = importFixture(root, malicious)
      val failure = runCatching { SnapshotUserData.importConfiguration(dshRoot, sharedRoot) }.exceptionOrNull()
      assertTrue("含 !!js 的导入必须被拒绝，实得：" + failure, failure is IllegalArgumentException)
      val message = failure!!.message ?: ""
      assertTrue("拒绝理由必须指出执行型标签与行号，实得：" + message, message.contains("执行型 YAML 标签"))
      assertTrue("拒绝理由必须给出行号，实得：" + message, message.contains("第 3 行"))
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun leavesActiveConfigUntouchedWhenRejected() {
    val root = Files.createTempDirectory("config-import-untouched").toFile()
    try {
      val (dshRoot, sharedRoot) = importFixture(root, "disabled: !!js 1\n")
      val live = File(dshRoot, "profiles/web/cordis.patch.yml")
      val before = live.readText()
      runCatching { SnapshotUserData.importConfiguration(dshRoot, sharedRoot) }
      assertEquals("活动配置不得被坏文档覆盖", before, live.readText())
      // 备份也必须是**未被坏文档顶过**的：校验在备份之前。
      val backup = File(live.parentFile, "cordis.patch.yml.import-backup")
      assertFalse("不得因为一次被拒的导入而写出备份：" + backup, backup.exists())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun acceptsOrdinaryConfigAndStillImports() {
    // 正向对照：不能为了安全把正常导入也堵死（防「一律拒绝」的假绿）。
    val root = Files.createTempDirectory("config-import-ok").toFile()
    try {
      val clean = "providers:\n  openai:\n    disabled: true\n"
      val (dshRoot, sharedRoot) = importFixture(root, clean)
      val target = SnapshotUserData.importConfiguration(dshRoot, sharedRoot)
      assertEquals(clean, target.readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  @Test
  fun tagScanIgnoresCommentsAndAcceptsVariants() {
    // 判据自身的判别力：注释里的同名文本不误拒；大小写/空白/子类型都要认出来。
    assertEquals(null, SnapshotUserData.firstExecutableTag(listOf("# disabled: !!js 1", "a: 1")))
    assertEquals(1, SnapshotUserData.firstExecutableTag(listOf("a: !js x"))!!.first)
    assertEquals(1, SnapshotUserData.firstExecutableTag(listOf("a: !!JS x"))!!.first)
    assertEquals(2, SnapshotUserData.firstExecutableTag(listOf("a: 1", "b: !! js  x"))!!.first)
    assertEquals(1, SnapshotUserData.firstExecutableTag(listOf("a: !!js/regexp x"))!!.first)
    // 不是 js 标签的其它标签不得误拒
    assertEquals(null, SnapshotUserData.firstExecutableTag(listOf("a: !!str 1", "b: !ref x")))
  }}