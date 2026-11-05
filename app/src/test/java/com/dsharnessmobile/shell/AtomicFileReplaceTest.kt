package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AtomicFileReplaceTest {

  private fun tempDir(): File = java.nio.file.Files.createTempDirectory("atomic-replace-test").toFile()

  @Test
  fun replacementKeepsTheOldTargetUntilTheNewFileIsReady() {
    val root = tempDir()
    try {
      val target = File(root, "existing.apk")
      target.writeText("old")
      val tmp = File(root, "existing.apk.tmp")
      tmp.writeText("new")
      assertTrue(AtomicFileReplace.publish(tmp, target))
      assertEquals("new", target.readText())
      assertFalse("成功发布后临时文件已被消费", tmp.exists())
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun failedPublishLeavesTheOldTargetAndTheCompletedTemp() {
    val root = tempDir()
    try {
      val target = File(root, "existing.zip")
      target.writeText("old")
      val tmp = File(root, "missing.zip.tmp")
      assertFalse(AtomicFileReplace.publish(tmp, target))
      assertEquals("old", target.readText())
      assertFalse("缺失的临时文件不能成为目标", tmp.exists())
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun failedTextPublishPreservesTheOldTargetAndRemovesTheTemp() {
    val root = tempDir()
    try {
      val target = File(root, "fingerprint")
      target.writeText("old-fingerprint")
      var publisherCalled = false

      try {
        AtomicFileReplace.writeText(target, "new-fingerprint") { tmp, destination ->
          publisherCalled = true
          assertEquals("new-fingerprint", tmp.readText())
          assertEquals(target, destination)
          false
        }
        org.junit.Assert.fail("A failed publish must be reported")
      } catch (_: IOException) {
        // Expected: callers use this failure to roll back the surrounding snapshot transaction.
      }

      assertTrue("the failed publisher must be exercised", publisherCalled)
      assertEquals("the previous commit point must remain intact", "old-fingerprint", target.readText())
      assertFalse("the completed temp is cleaned up", File(root, "fingerprint.tmp").exists())
    } finally {
      root.deleteRecursively()
    }
  }
}
