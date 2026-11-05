package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.BasicFileAttributes
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * Linux 环境资产的安全解包器（0.15.0）。
 *
 * 与快照解包器分开的理由：快照的符号链接策略按**宿主** canonicalPath 判定，而 rootfs 里的
 * 绝对链接是**guest** 语义（`/bin -> usr/bin`、`/etc/localtime -> /usr/share/...`）。把 guest 路径
 * 交给宿主 canonicalPath 既会误判，也可能在解包阶段解引用宿主文件。本解包器只做词法判定，
 * 创建链接时不解引用，因此 rootfs 的绝对 guest 链接可以保留，而宿主目录不会被穿透。
 *
 * 所有 kind 共同拒绝：绝对条目名、`..` 段、hardlink、字符/块设备、FIFO 与未知类型；
 * 任一父路径是符号链接时失败关闭，避免先前条目把后续写入引到根外。
 */
internal object LinuxAssetExtractor {

  fun extract(
    input: InputStream,
    totalBytes: Long,
    destination: File,
    kind: LinuxAssetIO.Kind,
    limits: SnapshotExtractor.Limits,
    onProgress: (Long, Long) -> Unit = { _, _ -> },
  ) {
    val dest = destination.canonicalFile
    val xz = XZCompressorInputStream(input)
    val tar = TarArchiveInputStream(xz)
    var primary: Throwable? = null
    try {
      var entries = 0
      var done = 0L
      var entry: TarArchiveEntry? = tar.nextEntry
      while (entry != null) {
        entries += 1
        if (entries > limits.maxEntries) throw IOException("资产归档条目数超限（>${limits.maxEntries}）")
        val declared = entry.size.coerceAtLeast(0L)
        done += declared
        if (done > limits.maxTotalBytes) throw IOException("资产归档解压体量超限（>${limits.maxTotalBytes} 字节）")
        if (entry.size > limits.maxSingleFileBytes) {
          throw IOException("资产归档单文件超限（${entry.name} > ${limits.maxSingleFileBytes} 字节）")
        }

        // Debian 归档通常带 `./` 根目录条目：目录可跳过；根上的普通文件/链接仍必须拒绝。
        val segments = entrySegments(entry.name)
        if (segments == null) {
          if (entry.isDirectory && isRootDirectoryName(entry.name)) {
            entry = tar.nextEntry
            continue
          }
          throw IOException("资产归档含不安全条目名：${entry.name}")
        }
        val target = resolveLexical(dest, segments)
          ?: throw IOException("资产条目越出解包根：${entry.name}")

        when {
          entry.isDirectory -> {
            ensureParents(dest, segments.dropLast(1))
            ensureDirectory(target)
          }
          entry.isSymbolicLink -> {
            val parentSegments = segments.dropLast(1)
            ensureParents(dest, parentSegments)
            val link = entry.linkName ?: throw IOException("符号链接缺少目标：${entry.name}")
            linkVerdict(link, parentSegments, kind)
              ?: throw IOException("符号链接越界或不合规：${entry.name} -> $link")
            Files.deleteIfExists(target.toPath())
            Files.createSymbolicLink(target.toPath(), Paths.get(link))
          }
          entry.isLink -> throw IOException("资产归档含 hardlink，已拒绝：${entry.name}")
          entry.isCharacterDevice || entry.isBlockDevice || entry.isFIFO ->
            throw IOException("资产归档含特殊文件，已拒绝：${entry.name}")
          entry.isFile -> {
            ensureParents(dest, segments.dropLast(1))
            writeFile(target, tar)
          }
          else -> throw IOException("资产归档含不支持的条目类型：${entry.name}")
        }
        if (done % (1024 * 1024) < declared) onProgress(done, totalBytes)
        entry = tar.nextEntry
      }
    } catch (t: Throwable) {
      primary = t
      throw t
    } finally {
      closeKeepingPrimary(tar, primary)
      closeKeepingPrimary(xz, primary)
    }
  }

  /** 条目名 → 规范化段；拒绝绝对路径、`..`、NUL 与空名。 */
  internal fun entrySegments(raw: String?): List<String>? {
    if (raw == null || raw.isEmpty() || raw.contains('\u0000')) return null
    val normalized = raw.replace('\\', '/')
    if (normalized.startsWith('/')) return null
    if (Regex("^[A-Za-z]:").containsMatchIn(normalized)) return null
    val segments = mutableListOf<String>()
    for (part in normalized.split('/')) {
      if (part.isEmpty() || part == ".") continue
      if (part == "..") return null
      segments += part
    }
    return segments.ifEmpty { null }
  }

  /** `./`、`.` 与 `/` 是归档根目录的常见写法；只有目录条目可以跳过。 */
  internal fun isRootDirectoryName(raw: String?): Boolean {
    if (raw == null) return false
    val normalized = raw.replace('\\', '/')
    return normalized.split('/').all { it.isEmpty() || it == "." }
  }

  /** 词法拼接到 [root] 内；调用方已拒绝 `..`，这里只做包含关系复核。 */
  internal fun resolveLexical(root: File, segments: List<String>): File? {
    var current = root
    for (segment in segments) current = File(current, segment)
    val rootPath = root.absoluteFile.toPath().normalize()
    val targetPath = current.absoluteFile.toPath().normalize()
    return if (targetPath.startsWith(rootPath)) current else null
  }

  /**
   * 符号链接目标的判据（纯函数）：
   * - rootfs：绝对 guest 路径合法；相对路径必须在解包根内。
   * - 其它 kind：只允许解包根内的相对路径。
   * 判定只做词法归一，不 stat、不 canonicalPath，因此不会解引用宿主。
   */
  internal fun linkVerdict(
    linkName: String,
    linkParentSegments: List<String>,
    kind: LinuxAssetIO.Kind,
  ): String? {
    if (linkName.isEmpty() || linkName.contains('\u0000')) return null
    val normalized = linkName.replace('\\', '/')
    if (normalized.startsWith('/')) {
      if (kind != LinuxAssetIO.Kind.ROOTFS) return null
      return if (guestAbsoluteVerdict(normalized)) normalized else null
    }
    var depth = linkParentSegments.size
    for (part in normalized.split('/')) {
      when (part) {
        "", "." -> Unit
        ".." -> {
          depth -= 1
          if (depth < 0) return null
        }
        else -> depth += 1
      }
    }
    return normalized
  }

  /** 绝对 guest 路径：以 `/` 开头，归一后仍停在 guest 根内。 */
  private fun guestAbsoluteVerdict(raw: String): Boolean {
    var depth = 0
    for (part in raw.split('/')) {
      when (part) {
        "", "." -> Unit
        ".." -> {
          depth -= 1
          if (depth < 0) return false
        }
        else -> depth += 1
      }
    }
    return true
  }

  /** 逐段确保父目录是真实目录且不是符号链接；不存在则创建。 */
  private fun ensureParents(root: File, segments: List<String>) {
    var current = root
    for (segment in segments) {
      current = File(current, segment)
      val path = current.toPath()
      if (Files.exists(path, NOFOLLOW_LINKS)) {
        val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        if (attrs.isSymbolicLink || !attrs.isDirectory) {
          throw IOException("资产父路径不是真实目录：${current.absolutePath}")
        }
      } else {
        Files.createDirectory(path)
      }
    }
  }

  private fun ensureDirectory(target: File) {
    val path = target.toPath()
    if (Files.exists(path, NOFOLLOW_LINKS)) {
      val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      if (attrs.isSymbolicLink || !attrs.isDirectory) throw IOException("目录条目与现有条目冲突：${target.absolutePath}")
    } else {
      Files.createDirectory(path)
    }
  }

  private fun writeFile(target: File, tar: TarArchiveInputStream) {
    val path = target.toPath()
    if (Files.exists(path, NOFOLLOW_LINKS)) {
      val attrs = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      if (attrs.isDirectory || attrs.isSymbolicLink) throw IOException("文件条目与现有条目冲突：${target.absolutePath}")
      Files.delete(path)
    }
    val prefix = ByteArray(4)
    var prefixLength = 0
    target.outputStream().use { out ->
      val buf = ByteArray(64 * 1024)
      var n = tar.read(buf)
      while (n >= 0) {
        if (prefixLength < prefix.size) {
          val copied = minOf(prefix.size - prefixLength, n)
          System.arraycopy(buf, 0, prefix, prefixLength, copied)
          prefixLength += copied
        }
        out.write(buf, 0, n)
        n = tar.read(buf)
      }
    }
    target.setReadable(false, false)
    target.setReadable(true, true)
    target.setWritable(true, true)
    target.setExecutable(SnapshotFileMode.isDirectlyExecutable(prefix, prefixLength), true)
  }

  private fun closeKeepingPrimary(closeable: java.io.Closeable, primary: Throwable?) {
    try {
      closeable.close()
    } catch (closeError: Throwable) {
      if (primary != null) primary.addSuppressed(closeError) else throw closeError
    }
  }
}
