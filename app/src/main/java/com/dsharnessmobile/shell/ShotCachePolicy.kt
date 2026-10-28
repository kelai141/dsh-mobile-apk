package com.dsharnessmobile.shell

import java.io.File

/**
 * `browser_screenshot` 的临时 PNG 保留策略。
 *
 * 截图落在 `files/home/tmp/dsh-tmp/` 而不是 `cache/`：系统不会把它当缓存回收，
 * 所以清理只能由壳侧自己负责（issue #672）。策略是「先按 TTL 删过期的，再按
 * 数量与总量上限从旧到新删到阈值内」——**不删刚写下的那张**，因为工具回执要
 * 先把它交给调用方。
 */
internal object ShotCachePolicy {

  /** 文件名前缀，与 `BrowserHost` 的 `File.createTempFile` 保持同源。 */
  const val PREFIX = "browser-shot-"

  /** 文件名后缀。 */
  const val SUFFIX = ".png"

  /** 保留时长：超过 1 小时的旧截图一律删掉。 */
  const val DEFAULT_TTL_MS = 60L * 60L * 1000L

  /** 保留数量上限。 */
  const val DEFAULT_MAX_FILES = 32

  /** 保留总字节上限（128 MiB）。 */
  const val DEFAULT_MAX_BYTES = 128L * 1024L * 1024L

  /**
   * 按 TTL 与上限清理 [dir] 下的历史截图，返回删除的文件数。
   *
   * 清理是尽力而为：目录不存在、权限不足、单文件删除失败都只跳过，绝不抛异常
   * ——「清理失败」不该让一次截图失败。
   */
  fun prune(
    dir: File,
    nowMs: Long = System.currentTimeMillis(),
    ttlMs: Long = DEFAULT_TTL_MS,
    maxFiles: Int = DEFAULT_MAX_FILES,
    maxBytes: Long = DEFAULT_MAX_BYTES,
    preserve: File? = null,
  ): Int {
    val files = try {
      dir.listFiles() ?: return 0
    } catch (_: Exception) {
      return 0
    }
    // 只认自己写的文件：别的前缀（例如用户或插件放进来的）一律不碰。
    val shots = files.filter { file ->
      file.isFile && file.name.startsWith(PREFIX) && file.name.endsWith(SUFFIX)
    }
    if (shots.isEmpty()) return 0

    val expiredBefore = nowMs - ttlMs
    val remaining = ArrayList<File>(shots.size)
    var removed = 0
    for (file in shots) {
      if (!sameFile(file, preserve) && file.lastModified() < expiredBefore) {
        if (delete(file)) removed++ else remaining.add(file)
      } else {
        remaining.add(file)
      }
    }

    // 从旧到新删，直到数量与总量都落回阈值内。
    remaining.sortBy { it.lastModified() }
    var totalBytes = remaining.sumOf { sizeOf(it) }
    var count = remaining.size
    for (file in remaining) {
      if (count <= maxFiles && totalBytes <= maxBytes) break
      if (sameFile(file, preserve)) continue
      // 必须在删除**前**取长度：删除后 length() 归零，总量就永远不减，会把目录删空。
      val fileBytes = sizeOf(file)
      if (delete(file)) {
        totalBytes -= fileBytes
        count--
        removed++
      }
    }
    return removed
  }

  /** Prune after publishing a capture while preserving the file being returned to the caller. */
  fun prunePublished(
    dir: File,
    capture: File,
    nowMs: Long = System.currentTimeMillis(),
    ttlMs: Long = DEFAULT_TTL_MS,
    maxFiles: Int = DEFAULT_MAX_FILES,
    maxBytes: Long = DEFAULT_MAX_BYTES,
  ): Boolean {
    if (!capture.isFile || !isManagedShot(capture) || capture.parentFile?.absoluteFile != dir.absoluteFile) return false
    if (maxFiles <= 0 || sizeOf(capture) > maxBytes) {
      delete(capture)
      prune(dir, nowMs, ttlMs, maxFiles, maxBytes)
      return false
    }
    prune(dir, nowMs, ttlMs, maxFiles, maxBytes, preserve = capture)
    // A successful capture requires a listing so the cache limits can be verified.
    val files = try {
      dir.listFiles()
    } catch (_: Exception) {
      delete(capture)
      return false
    }
    if (files == null) {
      delete(capture)
      return false
    }
    val remaining = files.filter { it.isFile && isManagedShot(it) }
    val withinLimits = remaining.size <= maxFiles && remaining.sumOf { sizeOf(it) } <= maxBytes
    if (!withinLimits) delete(capture)
    return withinLimits && capture.isFile
  }

  private fun isManagedShot(file: File): Boolean =
    file.name.startsWith(PREFIX) && file.name.endsWith(SUFFIX)

  private fun sameFile(file: File, other: File?): Boolean =
    other != null && file.absoluteFile == other.absoluteFile

  private fun sizeOf(file: File): Long = try {
    file.length()
  } catch (_: Exception) {
    0L
  }

  private fun delete(file: File): Boolean = try {
    file.delete()
  } catch (_: Exception) {
    false
  }
}
