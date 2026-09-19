package com.dsharnessmobile.shell

import android.util.Log
import java.io.File
import java.io.IOException
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
 * Regular files are owner-readable/writable. Their executable bit is based on
 * their payload signature rather than the tar mode: WSL-mounted archives can
 * flatten ordinary files to 0777, while Android app processes cannot set the
 * `security.android.exec` xattr anyway. Engine execution uses linker64 and the
 * Termux exec hook supplied by EngineManager.
 */
object SnapshotExtractor {

  /**
   * Extract an xz-compressed tar stream.
   * @param input raw xz stream.
   * @param totalBytes expected stream size (for progress; 0 = unknown).
   * @param dest destination root (the archive holds usr/ + home/).
   * @param onProgress bytesDone, bytesTotal.
   * @param runtimeRoot absolute link targets are allowed only inside this root. The
   *   bundled snapshot ships absolute applets (vim/busybox …) that point at the
   *   *live* runtime path (`files/usr/...`), so extraction into a staging directory
   *   must still accept them; after the atomic swap they resolve correctly. Defaults
   *   to [dest] for in-place extraction.
   */
  /**
   * 解压上限（审查 §5.11 / S-10）：默认值按快照真实体量的 3–5 倍留余量
   * （实测：条目 ~6 万、解压后 ~2.5 GB、单文件最大 ~200 MB）。
   * 做成**可注入**而不是硬编码常量，是为了让单测能用小上限真跑一遍判据
   * （写一个 24 万条目的归档去测等于让测试自己变成解压炸弹）。
   */
  data class Limits(
    val maxEntries: Int = 240_000,
    val maxTotalBytes: Long = 8L * 1024L * 1024L * 1024L,
    val maxSingleFileBytes: Long = 2L * 1024L * 1024L * 1024L,
  ) {
    companion object {
      /** 生产口径。 */
      val DEFAULT = Limits()
    }
  }

  fun extract(
    input: InputStream,
    totalBytes: Long,
    dest: File,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File = dest,
    limits: Limits = Limits.DEFAULT,
  ) {
    val xz = XZCompressorInputStream(input)
    val tar = TarArchiveInputStream(xz)
    val destCanon = dest.canonicalPath
    val runtimeCanon = try {
      runtimeRoot.canonicalPath
    } catch (_: Exception) {
      destCanon
    }
    var done = 0L
    var entries = 0
    var entry: TarArchiveEntry? = tar.nextEntry
    while (entry != null) {
      // 解压上限（审查 §5.11 / S-10）：本层自认是「沙盒边界」（在线更新走明文 HTTP 可篡改），
      // 但旧实现只防了路径穿越，**没防解压炸弹**——xz 炸弹/海量小文件足以撑爆 /data 并长时间占 CPU。
      // 上限按快照真实体量的 3–5 倍留余量（实测：条目 ~6 万、解压后 ~2.5 GB、单文件最大 ~200 MB）。
      entries += 1
      if (entries > limits.maxEntries) {
        throw IOException("快照归档条目数超限（>" + limits.maxEntries + "），已中止解压")
      }
      done += entry.size.coerceAtLeast(0)
      if (done > limits.maxTotalBytes) {
        throw IOException("快照归档解压体量超限（>" + limits.maxTotalBytes + " 字节），已中止解压")
      }
      if (entry.size > limits.maxSingleFileBytes) {
        throw IOException("快照归档单文件超限（" + entry.name + " > " + limits.maxSingleFileBytes + " 字节），已中止解压")
      }
      // 路径穿越防护（2026-08-23 安全审计 CRITICAL 修复）：拒绝绝对路径/../ 越界 /
      // 符号链接逃逸——在线更新快照由明文 HTTP（可篡改）路径提供，此层是沙盒边界。
      val target = resolveEntry(dest, destCanon, entry)
      if (target == null) {
        Log.w("dsh-snap", "skipping unsafe tar entry: " + entry.name)
        entry = tar.nextEntry
        continue
      }
      when {
        entry.isDirectory -> target.mkdirs()
        entry.isSymbolicLink -> {
          target.parentFile?.mkdirs()
          val linkPath = java.nio.file.Paths.get(entry.linkName)
          if (!isLinkTargetAllowed(entry.linkName, target.parentFile, destCanon, runtimeCanon)) {
            Log.w("dsh-snap", "skipping unsafe symlink: " + entry.name + " -> " + entry.linkName)
            entry = tar.nextEntry
            continue
          }
          // deleteIfExists does not follow links: on an overwrite re-extract an old symlink may be
          // dangling (File.exists() follows links, returning false for dangling ones, so the stale
          // link would survive and createSymbolicLink would throw FileAlreadyExistsException —
          // measured on the v0.10.7 upgrade re-extract). Also safe for regular files/dirs.
          java.nio.file.Files.deleteIfExists(target.toPath())
          java.nio.file.Files.createSymbolicLink(target.toPath(), linkPath)
        }
        else -> {
          target.parentFile?.mkdirs()
          // Overwrite-safety: a previous extraction can leave a read-only regular file
          // (measured: termux-am/am.apk with 0400 on some emulator ROMs — FileOutputStream
          // would fail EACCES on the upgrade re-extract). deleteIfExists does not follow
          // links, so stale/dangling files are cleared before the new copy is written,
          // mirroring the symlink branch above.
          java.nio.file.Files.deleteIfExists(target.toPath())
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
      }
      done += entry.size
      if (done % (1024 * 1024) < entry.size) onProgress(done, totalBytes)
      entry = tar.nextEntry
    }
    tar.close()
  }

  /**
   * Symlink target policy (sandbox boundary for archives fetched over plain HTTP).
   *
   * A relative target must resolve inside [destCanon] (the extraction root). An
   * absolute target is accepted only inside [runtimeCanon] — the app's live runtime
   * root — because the bundled snapshot ships absolute applet links
   * (`files/usr/libexec/busybox/vi`) that must survive staging and resolve after the
   * atomic swap. Termux residue (`/data/data/com.termux/...`) and escaping targets
   * stay rejected.
   */
  internal fun isLinkTargetAllowed(
    linkName: String,
    linkParent: File?,
    destCanon: String,
    runtimeCanon: String,
  ): Boolean {
    val linkPath = try {
      java.nio.file.Paths.get(linkName)
    } catch (_: Exception) {
      return false
    }
    val resolved = if (linkPath.isAbsolute) linkPath else java.io.File(linkParent, linkName).toPath()
    val linkCanon = try {
      resolved.normalize().toFile().canonicalPath
    } catch (_: Exception) {
      return false
    }
    val insideDest = linkCanon == destCanon || linkCanon.startsWith(destCanon + File.separator)
    val insideRuntime = linkCanon == runtimeCanon || linkCanon.startsWith(runtimeCanon + File.separator)
    return insideDest || insideRuntime
  }

  /** 解析 tar 条目到解压根内目标：拒绝绝对路径、../ 越界；返回 null 表示应跳过该条目。 */
  private fun resolveEntry(dest: File, destCanon: String, entry: TarArchiveEntry): File? {
    val name = entry.name.replace('\\', '/').trimStart('/')
    if (name.isEmpty() || name.contains("..")) return null
    val target = File(dest, name)
    return try {
      // canonicalPath 解析存在的父目录段；目标本身尚未创建时用父目录判定。
      val parentCanon = (target.parentFile?.canonicalPath ?: destCanon)
      if (parentCanon.startsWith(destCanon + File.separator) || parentCanon == destCanon) target else null
    } catch (_: Exception) {
      null
    }
  }
}
