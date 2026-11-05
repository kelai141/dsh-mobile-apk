package com.dsharnessmobile.shell

import android.util.Log
import java.io.File
import java.io.IOException
import java.io.InputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * 内嵌快照**资产字节**的对账策略（0.14.7 / task-9）。
 *
 * 为什么单列一个对象：既有链路里 `assets/snapshot.sha256` 只是**声明值**，它被拿去和 live/已提交的
 * `.snapshot-fingerprint` 比较（ShellState 那一侧的新鲜度判据），而真正被解码的
 * `assets/snapshot.tar.xz` **从不做摘要校验**——Android AssetManager 读 STORED 项也不校 zip CRC。
 * 于是资产字节坏掉时（安装介质损坏、ROM 优化器重写 APK 等），用户能拿到的唯一线索是解码器内部的
 * `org.tukaani.xz.CorruptedInputException: Compressed data is corrupt`：
 * 它只说「输入坏了」，**不说「哪一段不一致、期望什么、实际什么」**。
 *
 * 本对象提供**解码之前**的流式摘要对账，使失败能自证。它刻意不假设任何具体损坏原因——
 * 真机（华为 SCA-AL00）未连接，无法比对 base.apk，本项**不声称**已找到 asset 为何损坏。
 *
 * 成本纪律：固定 64KB 缓冲的**流式**读，不整读入内存（快照 194MB），也不解码（比解码便宜一个数量级）。
 */
internal object SnapshotBundledAsset {

  /** 内嵌资产字节与安装包内声明值不一致（被改写/截断）。 */
  const val CODE_CORRUPT = "snapshot-bundled-asset-corrupt"

  /** 内嵌资产连打开/读取都失败（缺席、权限、AssetManager 异常）。与「摘要不一致」分开归类。 */
  const val CODE_UNREADABLE = "snapshot-bundled-asset-unreadable"

  /** 解压完成但 staged 运行时缺件（校验支的失败，此前也是"只 return false"的静默支）。 */
  const val CODE_STAGE_INCOMPLETE = "snapshot-stage-incomplete"

  /** 流式 SHA-256（十六进制小写）+ 读到的字节数。 */
  data class Digest(val hex: String, val bytes: Long)

  /**
   * 对流做一次**顺序** SHA-256（不解码、不缓存整个流）。
   *
   * @param open 打开输入流的实现（单测注入内存流，生产注入 AssetManager 流）。
   */
  fun digest(open: () -> InputStream, bufferSize: Int = 64 * 1024): Digest {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    open().use { input ->
      val buf = ByteArray(bufferSize)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        if (n > 0) {
          md.update(buf, 0, n)
          bytes += n
        }
      }
    }
    return Digest(md.digest().joinToString("") { "%02x".format(it) }, bytes)
  }

  /**
   * 纯判据：实际摘要 vs 声明摘要。
   *
   * @param declared 归一化后的声明值；null/空 = 声明不可用（已由 SnapshotFingerprintPolicy 归类，此处不重复判）。
   * @return null = 通过；非 null = (errorCode, 可落盘的一行 detail)。
   */
  fun verdict(declared: String?, actual: Digest): Pair<String, String>? {
    if (declared.isNullOrEmpty()) return null
    if (declared == actual.hex) return null
    return CODE_CORRUPT to (
      "内嵌运行时快照资产与安装包内声明值不一致（assets/snapshot.tar.xz 字节被改写/截断）："
        + "expected=" + declared + " actual=" + actual.hex + " bytes=" + actual.bytes
        + "。本次解码未开始即被拦下，现有用户数据未改动；请重新安装完整安装包。"
      )
  }
}

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
    // D-3（0.14.7 / task-9）：tar/xz 必须在**任何**退出路径上关闭。
    // 旧实现把 `tar.close()` 放在函数体末尾（无 try/finally）：中途抛异常（超限判据、路径解算失败、
    // 写盘 EACCES、**解码器抛 CorruptedInputException**）时两条流都不关 —— 而这条路径正是真机
    // 启动失败时走的那条（真机 logcat 实证：XZCompressorInputStream.read 抛 CorruptedInputException）。
    // 不关流的后果不是「泄漏一点点」：xz 解码器持有 native 级缓冲，且调用方在刷新事务里会立刻重试，
    // 每次启动都叠一次。
    val xz = XZCompressorInputStream(input)
    val tar = TarArchiveInputStream(xz)
    var primary: Throwable? = null
    try {
      extractEntries(tar, dest, totalBytes, onProgress, runtimeRoot, limits)
    } catch (t: Throwable) {
      primary = t
      throw t
    } finally {
      // 关闭顺序与打开顺序相反（tar 先关：它可能从 xz 读尾部）。**任一 close 抛异常都不得掩盖
      // 正在传播的真因**——与 kotlin use{} 的语义对齐（close 异常进 addSuppressed）：
      // 真机现场的真因是 CorruptedInputException，若被一个 close 异常顶掉，本次修复就白做了。
      closeKeepingPrimary(tar, primary)
      closeKeepingPrimary(xz, primary)
    }
  }

  /** 关闭 [closeable]；失败时若有正在传播的 [primary] 就挂成 suppressed，否则如实抛出。 */
  private fun closeKeepingPrimary(closeable: java.io.Closeable, primary: Throwable?) {
    try {
      closeable.close()
    } catch (closeError: Throwable) {
      if (primary != null) primary.addSuppressed(closeError) else throw closeError
    }
  }

  /**
   * 解压主体（D-3 拆出：让 [extract] 的 try/finally 只负责关闭，主体保持线性易读）。
   *
   * 行为与拆分前逐行相同 —— 本函数**不关闭**任何流，由 [extract] 的 finally 统一负责。
   */
  private fun extractEntries(
    tar: TarArchiveInputStream,
    dest: File,
    totalBytes: Long,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File,
    limits: Limits,
  ) {
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
      // done 已在循环头部（上限检查处）累加过 entry.size——这里不再重复累加（#680）：
      // 双倍计数让 8 GiB 总量上限在 4 GiB 就触发，正常快照被误判成解压炸弹。
      if (done % (1024 * 1024) < entry.size) onProgress(done, totalBytes)
      entry = tar.nextEntry
    }
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
