package com.dsharnessmobile.shell

import java.io.File
import java.io.FileOutputStream

/**
 * 归一化迁移的**备份纪律**（issue #608）。
 *
 * 缺陷形态：旧实现「备份路径已存在就跳过写备份」——路径存在时，无论它是目录还是不完整文件，
 * 都被当成「本次已有备份」继续发布归一后的配置。于是 live 被改了，却没有任何一份属于**本次
 * 原文**的回滚副本。
 *
 * 修法分两半，缺一半都不成立：
 *
 * 1. **可判定性**：备份是否有效不看「路径存不存在」，而是看它是不是普通文件、且内容与本次
 *    live 原文**逐字节相同**。历史残留目录/半截文件一概不算数，本次照样写自己的备份。
 * 2. **有界保留**：每次尝试一份备份、名字带 13 位时间序号，成功尝试只保留最近
 *    [KEEP_ATTEMPTS] 份。旧策略是「稳定路径 + 每版本一份」，跨版本各留一份、永不清理。
 *
 * 失败尝试的备份**不占**成功配额（落在 `-failed` 后缀，单独保留最近 [KEEP_FAILED_ATTEMPTS] 份）：
 * 否则连续几次失败就能把最后一份有效备份挤掉，而失败那几份恰恰最没用——它们的 live 根本没
 * 被改过。失败标记同时让排障者一眼看出哪份备份对应的是没生效的尝试。
 *
 * 本对象只手写备份文件；live 的写入仍走既有原子发布，不在本 PR 里换写路径。
 */
internal object ProfileNormalizeBackup {

  /** 成功尝试保留的备份份数上限。 */
  const val KEEP_ATTEMPTS = 3

  /** 失败尝试保留的备份份数上限（与成功配额分开计，互不挤占）。 */
  const val KEEP_FAILED_ATTEMPTS = 3

  private const val SEQ_DASH = "-"
  private const val SUFFIX = ".bak"
  private const val FAILED_MARK = "-failed"

  /**
   * 该备份是否能作为「本次原文」的回滚来源。
   *
   * 判据只有两条：是普通文件（目录与符号链接都不算）、且字节与 [original] 完全相同。
   * 长度不同直接短路，避免把大文件整读两遍。
   */
  fun isValid(path: File, original: String): Boolean {
    if (!path.isFile) return false
    val bytes = original.toByteArray(Charsets.UTF_8)
    if (path.length() != bytes.size.toLong()) return false
    return try {
      path.readBytes().contentEquals(bytes)
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * 为本次尝试落一份**同步落盘**的完整备份。
   *
   * @param target live 配置（备份落在它的同目录，命名沿用 `<目标名>.pre-<版本>`）。
   * @param original 本次将要被改写的原文。
   * @param failed 本次发布是否失败（失败备份带 `-failed` 标记，与成功备份分开保留）。
   * @return 落盘成功的备份文件。
   * @throws Throwable 写盘失败——调用方必须据此**放弃改写 live**。
   */
  fun write(target: File, original: String, failed: Boolean, now: Long = System.currentTimeMillis()): File {
    val parent = target.absoluteFile.parentFile ?: error("missing backup parent: " + target.absolutePath)
    val prefix = target.name + ".pre-" + BuildConfig.VERSION_NAME + SEQ_DASH
    val suffix = (if (failed) FAILED_MARK else "") + SUFFIX
    val bytes = original.toByteArray(Charsets.UTF_8)
    // 直接落到有序名字上：保留策略按文件名字典序裁剪，随机名会让「最近 N 份」无从判断。
    val ordered = File(parent, prefix + String.format("%013d", now) + suffix)
    try {
      FileOutputStream(ordered).use { output ->
        output.write(bytes)
        output.flush()
        output.fd.sync()
      }
    } catch (t: Throwable) {
      runCatching { SnapshotFs.deletePath(ordered) }
      throw t
    }
    if (ordered.length() != bytes.size.toLong()) {
      // 落盘不完整等同于没有备份：删掉残片并报错，绝不让它冒充成功备份。
      runCatching { SnapshotFs.deletePath(ordered) }
      error("backup not durable: " + ordered.absolutePath)
    }
    prune(target)
    return ordered
  }

  /**
   * 裁剪历史备份：成功配额与失败配额各自算、互不挤占。
   *
   * 只动本对象自己命名的文件（`<目标名>.pre-<版本>-<13位序号>[-failed].bak`），
   * `repairProfilePatch` 用 UUID 命名的既有多份备份不受影响。
   */
  fun prune(target: File) {
    drop(managed(target).filterNot { isFailed(it) }, KEEP_ATTEMPTS)
    drop(managed(target).filter { isFailed(it) }, KEEP_FAILED_ATTEMPTS)
  }

  /** 该目录下本对象管理的成功备份（按时间序，供测试与诊断用）。 */
  fun successfulBackups(target: File): List<File> = managed(target).filterNot { isFailed(it) }

  /** 该目录下本对象管理的失败备份（按时间序）。 */
  fun failedBackups(target: File): List<File> = managed(target).filter { isFailed(it) }

  private fun isFailed(file: File): Boolean = file.name.contains(FAILED_MARK + SUFFIX, ignoreCase = true)

  private fun drop(ordered: List<File>, keep: Int) {
    val excess = ordered.size - keep
    if (excess <= 0) return
    // 文件名的 13 位序号单调，字典序即时间序：留尾部、删头部。
    for (file in ordered.take(excess)) runCatching { SnapshotFs.deletePath(file) }
  }

  private fun managed(target: File): List<File> {
    val parent = target.absoluteFile.parentFile ?: return emptyList()
    val prefix = target.name + ".pre-" + BuildConfig.VERSION_NAME + SEQ_DASH
    return (parent.listFiles() ?: emptyArray())
      .filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(SUFFIX) }
      .sortedBy { it.name }
  }
}
