package com.dsharnessmobile.shell

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 使用可丢弃的缓存文件，验证 Android 上实际的发布路径。 */
class SnapshotAtomicRecoveryTest {
  @Test fun failedFingerprintPublicationPreservesTheCommitPoint() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = Files.createTempDirectory(context.cacheDir.toPath(), "fingerprint-publication-").toFile()
    try {
      val target = File(root, ".snapshot-fingerprint")
      target.writeText("old-fingerprint")
      try {
        AtomicFileReplace.writeText(target, "new-fingerprint") { tmp, live ->
          assertEquals("new-fingerprint", tmp.readText())
          assertEquals(target, live)
          false
        }
        throw AssertionError("A failed fingerprint publication must abort the snapshot commit")
      } catch (_: IOException) {
        // The production caller rolls back the enclosing snapshot transaction on this failure.
      }

      assertEquals("the prior commit point must survive a failed publication", "old-fingerprint", target.readText())
      assertFalse(File(root, ".snapshot-fingerprint.tmp").exists())

      AtomicFileReplace.writeText(target, "new-fingerprint")
      assertEquals("new-fingerprint", target.readText())
    } finally {
      root.deleteRecursively()
    }
  }

  @Test fun failedPublicationKeepsExistingConfiguration() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = Files.createTempDirectory(context.cacheDir.toPath(), "snapshot-publication-").toFile()
    try {
      val target = File(root, "package.json")
      val old = "{\"用户配置\":\"必须保留\"}\n".toByteArray(Charsets.UTF_8)
      target.writeBytes(old)
      try {
        SnapshotTransaction.writeTextAtomic(target, "{\"updated\":true}", "fixture", publish = { tmp, live ->
          assertTrue(old.contentEquals(live.readBytes()))
          assertEquals("{\"updated\":true}", tmp.readText())
          false
        }) { org.json.JSONObject(it) }
        throw AssertionError("发布失败必须中止")
      } catch (error: SnapshotFsException) {
        assertEquals(CODE_ATOMIC_WRITE, error.code)
      }
      assertTrue("旧数据必须逐字节保留", old.contentEquals(target.readBytes()))
      SnapshotTransaction.writeTextAtomic(target, "{\"updated\":true}", "fixture") { org.json.JSONObject(it) }
      assertEquals("{\"updated\":true}", target.readText())
    } finally {
      root.deleteRecursively()
    }
  }
}
