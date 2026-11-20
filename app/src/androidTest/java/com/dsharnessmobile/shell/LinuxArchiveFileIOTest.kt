package com.dsharnessmobile.shell

import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LinuxArchiveFileIOTest {
  private fun withDirectory(check: (File) -> Unit) {
    val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    val work = Files.createTempDirectory(cache.toPath(), "linux-archive-io-").toFile()
    try {
      check(work)
    } finally {
      SnapshotFs.deletePath(work)
    }
  }

  @Test fun extractionPreservesContentsExecutablePolicyAndDuplicateRegularFiles() {
    withDirectory { work ->
      val archive = File(work, "input.tar.xz")
      TarArchiveOutputStream(XZCompressorOutputStream(archive.outputStream())).use { tar ->
        for ((name, text) in listOf("bin/cmd" to "#!/bin/sh\n", "data" to "old", "data" to "new", "empty" to "")) {
          val bytes = text.toByteArray()
          tar.putArchiveEntry(TarArchiveEntry(name).apply { size = bytes.size.toLong() })
          tar.write(bytes)
          tar.closeArchiveEntry()
        }
      }
      val root = Files.createDirectory(File(work, "tree").toPath()).toFile()
      archive.inputStream().use { input ->
        LinuxAssetExtractor.extract(input, archive.length(), root, LinuxAssetIO.Kind.ROOTFS, LinuxAssetIO.ROOTFS_LIMITS)
      }
      assertEquals("new", File(root, "data").readText())
      assertEquals(0L, File(root, "empty").length())
      assertEquals("#!/bin/sh\n", File(root, "bin/cmd").readText())
      assertEquals("700", Integer.toOctalString(Os.stat(File(root, "bin/cmd").path).st_mode and 511))
      assertEquals("600", Integer.toOctalString(Os.stat(File(root, "data").path).st_mode and 511))
    }
  }

  @Test fun creationRejectsDirectoryAndLinkConflicts() {
    withDirectory { work ->
      val parent = Files.createDirectory(File(work, "existing").toPath()).toFile()
      val link = File(work, "link")
      Files.createSymbolicLink(link.toPath(), parent.toPath())
      assertThrows(IOException::class.java) { LinuxArchiveFileIO.ensureDirectory(link) }
      for (conflict in listOf(parent, link)) {
        assertThrows(IOException::class.java) { LinuxArchiveFileIO.write(conflict) { true } }
      }
      assertTrue(Files.isSymbolicLink(link.toPath()))
      assertTrue(parent.isDirectory)
    }
  }

  @Test fun failedWriteClosesTheDescriptorAndPreservesTheOriginalError() {
    withDirectory { work ->
      val descriptors = File("/proc/self/fd")
      val before = descriptors.list()!!.size
      repeat(24) { index ->
        val error = assertThrows(IOException::class.java) {
          LinuxArchiveFileIO.write(File(work, "file-$index")) { throw IOException("interrupted input") }
        }
        assertEquals("interrupted input", error.message)
      }
      assertTrue(descriptors.list()!!.size <= before + 3)
    }
  }
}
