package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ

/** One disposable compressed rootfs in the Android cache, shared across release URLs. */
internal object LinuxRootfsArchiveCache {
  const val NAME = "linux-rootfs-last.tar.xz"

  fun restore(directory: File?, archive: File, spec: LinuxAssetIO.Spec, root: File, debugBuild: Boolean): Boolean {
    if (directory == null || !Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) return false
    val cached = File(directory, NAME).toPath()
    if (!Files.isRegularFile(cached, NOFOLLOW_LINKS)) return false
    val local = LinuxAssetIO.Opener { _, target, _ ->
      // Snapshot bytes into the candidate before hashing. Cache eviction or replacement
      // cannot switch the already opened descriptor to a different archive.
      FileChannel.open(cached, READ, NOFOLLOW_LINKS).use { source ->
        if (source.size() != spec.size) return@Opener -1L
        target.outputStream().channel.use { output ->
          var copied = 0L
          while (copied < spec.size) {
            val count = source.transferTo(copied, spec.size - copied, output)
            if (count == 0L) return@Opener -1L
            copied += count
          }
          if (source.size() == copied) copied else -1L
        }
      }
    }
    // Use the normal size, digest, origin and atomic-publication checks on every hit.
    return LinuxAssetIO.download(spec, archive, root, local, debugBuild) == null
  }

  fun remember(directory: File?, verified: File) {
    if (directory == null || !Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) return
    try {
      // Android can disallow hard links between filesDir and cacheDir. Keep the
      // candidate archive independent from cache eviction and later replacements.
      val temp = File.createTempFile(".linux-rootfs-", ".tmp", directory)
      try {
        verified.inputStream().use { source ->
          temp.outputStream().use { output -> source.copyTo(output, 128 * 1024) }
        }
        AtomicFileReplace.publishWritten(temp, File(directory, NAME))
      } finally {
        temp.delete()
      }
    } catch (_: IOException) {
      // A full or evicted cache must not invalidate the verified installation.
    }
  }
}
