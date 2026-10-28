package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Test

class ShotCachePolicyNullListingTest {

  private class FailedListingDirectory(path: String, private val throwOnList: Boolean) : File(path) {
    override fun listFiles(): Array<File>? {
      if (throwOnList) throw SecurityException("listing denied")
      return null
    }
  }

  @Test
  fun nullDirectoryListingDoesNotPublishCapture() {
    assertListingFailureIsRejected(throwOnList = false)
  }

  @Test
  fun listingExceptionDoesNotPublishCapture() {
    assertListingFailureIsRejected(throwOnList = true)
  }

  private fun assertListingFailureIsRejected(throwOnList: Boolean) {
    val backingDir = Files.createTempDirectory("shot-cache-null-listing").toFile()
    try {
      val dir = FailedListingDirectory(backingDir.absolutePath, throwOnList)
      val capture = File(
        backingDir,
        ShotCachePolicy.PREFIX + "capture" + ShotCachePolicy.SUFFIX,
      ).apply { writeBytes(byteArrayOf(1, 2, 3)) }

      assertFalse(
        ShotCachePolicy.prunePublished(
          dir,
          capture,
          nowMs = 1_800_000_000_000L,
          maxFiles = 1,
          maxBytes = 10L,
        ),
      )
      assertFalse("A capture must not remain publishable when its directory cannot be listed", capture.exists())
    } finally {
      backingDir.deleteRecursively()
    }
  }
}
