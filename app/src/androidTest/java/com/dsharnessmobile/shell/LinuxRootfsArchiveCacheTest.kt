package com.dsharnessmobile.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LinuxRootfsArchiveCacheTest {
  @Test fun verifiedArchiveSurvivesEvictionAndCorruptCacheIsIgnored() {
    val app = InstrumentationRegistry.getInstrumentation().targetContext
    val work = Files.createTempDirectory(app.filesDir.toPath(), "rootfs-cache-test-").toFile()
    val cache = Files.createTempDirectory(app.cacheDir.toPath(), "rootfs-cache-test-").toFile()
    try {
      val first = File(work, "verified.xz")
      val expected = ByteArray(65537) { it.toByte() }
      first.writeBytes(expected)
      val digest = SnapshotBundledAsset.digest({ first.inputStream() })
      val spec = LinuxAssetIO.Spec(
        "https://github.com/kelai141/dsh-bionilux/releases/download/test/rootfs.tar.xz",
        digest.hex, digest.bytes, LinuxAssetIO.Kind.ROOTFS,
      )
      val cached = File(cache, LinuxRootfsArchiveCache.NAME)
      val restored = File(work, "restored.xz")
      LinuxRootfsArchiveCache.remember(cache, first)
      assertTrue(LinuxRootfsArchiveCache.restore(cache, restored, spec, work, false))
      assertArrayEquals(expected, restored.readBytes())
      assertFalse(Files.isSameFile(cached.toPath(), first.toPath()))
      assertFalse(Files.isSameFile(cached.toPath(), restored.toPath()))

      cached.writeBytes(expected.copyOf().apply { this[lastIndex] = 1 })
      val rejected = File(work, "rejected.xz")
      assertFalse(LinuxRootfsArchiveCache.restore(cache, rejected, spec, work, false))
      assertFalse(rejected.exists())
      assertTrue(cached.delete())
      assertArrayEquals(expected, first.readBytes())
      assertArrayEquals(expected, restored.readBytes())
    } finally {
      SnapshotFs.deletePath(cache)
      SnapshotFs.deletePath(work)
    }
  }
}
