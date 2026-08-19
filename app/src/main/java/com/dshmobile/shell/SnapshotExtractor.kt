package com.dsharnessmobile.shell

import java.io.File
import java.io.InputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * Shared snapshot extraction: xz tar → dest with owner-only permissions
 * (dsh's credentials provider fails loud on world-readable secrets) and
 * symlink preservation. Used by both the bundled snapshot (assets) and the
 * online update path (downloaded file).
 *
 * After extraction, every executable file gets the Android exec attribute
 * (security.android.exec): Android 15+ apps targeting SDK 35+ may only exec
 * app-data ELF binaries that carry it. The tar does not preserve xattrs
 * through the Java path, so it is stamped via the system setfattr (best
 * effort — kernels that do not enforce it accept the no-op).
 */
object SnapshotExtractor {

  /**
   * Extract an xz-compressed tar stream.
   * @param input raw xz stream.
   * @param totalBytes expected stream size (for progress; 0 = unknown).
   * @param dest destination root (filesDir; the archive holds usr/ + home/).
   * @param onProgress bytesDone, bytesTotal.
   */
  fun extract(input: InputStream, totalBytes: Long, dest: File, onProgress: (Long, Long) -> Unit) {
    val xz = XZCompressorInputStream(input)
    val tar = TarArchiveInputStream(xz)
    val execFiles = mutableListOf<String>()
    var done = 0L
    var entry: TarArchiveEntry? = tar.nextEntry
    while (entry != null) {
      val target = File(dest, entry.name)
      when {
        entry.isDirectory -> target.mkdirs()
        entry.isSymbolicLink -> {
          target.parentFile?.mkdirs()
          // deleteIfExists 不跟随链接：覆盖重解压时旧 symlink 可能是悬空的
          // （File.exists() 跟随链接对 dangling 返回 false，会漏删导致
          // createSymbolicLink 抛 FileAlreadyExistsException——v0.10.7
          // 升级重解压实测）。对普通文件/目录同样安全删除。
          java.nio.file.Files.deleteIfExists(target.toPath())
          java.nio.file.Files.createSymbolicLink(target.toPath(), java.nio.file.Paths.get(entry.linkName))
        }
        else -> {
          target.parentFile?.mkdirs()
          target.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            var n = tar.read(buf)
            while (n >= 0) {
              out.write(buf, 0, n)
              n = tar.read(buf)
            }
          }
          target.setReadable(false, false)
          target.setReadable(true, true)
          target.setWritable(true, true)
          target.setExecutable(entry.mode and 0x40 != 0, true)
          if (entry.mode and 0x40 != 0) execFiles.add(target.absolutePath)
        }
      }
      done += entry.size
      if (done % (1024 * 1024) < entry.size) onProgress(done, totalBytes)
      entry = tar.nextEntry
    }
    tar.close()
    stampExecAttribute(execFiles)
  }

  /** Stamp the Android exec attribute on all extracted executables. */
  private fun stampExecAttribute(files: List<String>) {
    if (files.isEmpty()) return
    try {
      // 参数数组直传（不经 shell），文件名里的引号/元字符不会被解释。
      val base = listOf("/system/bin/setfattr", "-n", "security.android.exec", "-v", "1")
      // 并发批次（每批最多 64 个），避免一次 spawn 过多进程。
      files.chunked(64).forEach { batch ->
        val procs = batch.map { f -> ProcessBuilder(base + f).redirectErrorStream(true).start() }
        for (p in procs) {
          val finished = p.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)
          if (!finished) p.destroyForcibly()
        }
      }
    } catch (_: Throwable) {
      // Kernels without the exec-attribute check (emulators, older Android)
      // do not need it; ignore failures here.
    }
  }
}
