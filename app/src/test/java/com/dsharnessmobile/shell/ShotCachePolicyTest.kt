package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `browser_screenshot` 的临时 PNG 保留策略（issue #672）。 */
class ShotCachePolicyTest {

  private fun tempDir(): File = java.nio.file.Files.createTempDirectory("shot-cache-test").toFile()

  private fun shot(dir: File, name: String, bytes: Int, mtimeMs: Long): File {
    val file = File(dir, ShotCachePolicy.PREFIX + name + ShotCachePolicy.SUFFIX)
    file.writeBytes(ByteArray(bytes))
    assertTrue("测试需要能设置 mtime", file.setLastModified(mtimeMs))
    return file
  }

  @Test
  fun expiredShotsAreRemovedAndFreshOnesSurvive() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val stale = shot(dir, "stale", 16, now - ShotCachePolicy.DEFAULT_TTL_MS - 1_000L)
      val fresh = shot(dir, "fresh", 16, now - 1_000L)
      assertEquals(1, ShotCachePolicy.prune(dir, nowMs = now))
      assertFalse("超过 TTL 的旧截图应被删除", stale.exists())
      assertTrue("新截图不该被删", fresh.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun fileCountCapDropsOldestFirst() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val files = (1..5).map { index -> shot(dir, "n$index", 8, now - (10L - index) * 1_000L) }
      // 5 张都在 TTL 内，只让数量上限生效。
      assertEquals(2, ShotCachePolicy.prune(dir, nowMs = now, maxFiles = 3))
      assertFalse("最旧的两张应被删除", files[0].exists() || files[1].exists())
      assertTrue("最新的三张保留", files[2].exists() && files[3].exists() && files[4].exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun byteCapDropsOldestFirst() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val files = (1..4).map { index -> shot(dir, "b$index", 100, now - (10L - index) * 1_000L) }
      // 4 张 x100B；上限 250B ⇒ 至少删掉两张最旧的。
      assertEquals(2, ShotCachePolicy.prune(dir, nowMs = now, maxBytes = 250L))
      assertFalse(files[0].exists())
      assertFalse(files[1].exists())
      assertTrue(files[2].exists() && files[3].exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun publishedCaptureCountsTowardLimitsAndRemainsAvailable() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val oldest = shot(dir, "oldest", 100, now - 2_000L)
      val newer = shot(dir, "newer", 100, now - 1_000L)
      val capture = shot(dir, "current", 100, now)

      assertTrue(
        ShotCachePolicy.prunePublished(dir, capture, nowMs = now, maxFiles = 2, maxBytes = 250L),
      )

      assertTrue("本次回执指向的截图必须保留", capture.isFile)
      assertFalse("超限时应先删最旧历史图", oldest.exists())
      assertTrue("较新历史图应保留", newer.isFile)
      val retained = dir.listFiles()!!.filter { it.isFile && it.name.endsWith(ShotCachePolicy.SUFFIX) }
      assertEquals("发布后数量上限必须立即生效", 2, retained.size)
      assertTrue("发布后字节上限必须立即生效", retained.sumOf { it.length() } <= 250L)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun oversizedCaptureIsDeletedAndMustNotBeReturned() {
    val dir = tempDir()
    try {
      val capture = shot(dir, "too-large", 101, 1_800_000_000_000L)
      assertFalse(ShotCachePolicy.prunePublished(dir, capture, nowMs = 1_800_000_000_000L, maxBytes = 100L))
      assertFalse("超限截图不能留下一个成功回执所指向的文件", capture.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun foreignFilesAndDirectoriesAreNeverTouched() {
    val dir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val stale = shot(dir, "stale", 16, now - ShotCachePolicy.DEFAULT_TTL_MS - 1_000L)
      val foreign = File(dir, "engine-output.png").apply { writeBytes(ByteArray(16)) }
      assertTrue(foreign.setLastModified(now - ShotCachePolicy.DEFAULT_TTL_MS - 1_000L))
      val foreignPrefix = File(dir, "browser-shot-not-a-png.txt").apply { writeBytes(ByteArray(16)) }
      assertTrue(foreignPrefix.setLastModified(now - ShotCachePolicy.DEFAULT_TTL_MS - 1_000L))
      val nested = File(dir, ShotCachePolicy.PREFIX + "dir" + ShotCachePolicy.SUFFIX).apply { mkdirs() }

      assertEquals(1, ShotCachePolicy.prune(dir, nowMs = now))
      assertFalse(stale.exists())
      assertTrue("非本策略命名的文件不碰", foreign.exists())
      assertTrue("后缀不符的不碰", foreignPrefix.exists())
      assertTrue("同名目录不碰", nested.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun missingDirectoryIsNotAnError() {
    val missing = File(tempDir(), "does-not-exist")
    assertEquals(0, ShotCachePolicy.prune(missing, nowMs = 1_800_000_000_000L))
  }

  @Test
  fun emptyDirectoryIsNotAnError() {
    val dir = tempDir()
    try {
      assertEquals(0, ShotCachePolicy.prune(dir, nowMs = 1_800_000_000_000L))
    } finally {
      dir.deleteRecursively()
    }
  }
}
