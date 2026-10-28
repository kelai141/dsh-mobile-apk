package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** 发布已完成的同目录临时文件，替换期间目标路径始终存在。 */
internal object AtomicFileReplace {

  /** 仅当目标已指向完整的临时文件时返回 true。 */
  fun publish(tmp: File, target: File): Boolean {
    return try {
      Files.move(
        tmp.toPath(),
        target.toPath(),
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING,
      )
      true
    } catch (_: Exception) {
      // 部分 Android 存储 provider 不支持 ATOMIC_MOVE；回退仍只做一次 move，绝不先删目标。
      try {
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        true
      } catch (_: Exception) {
        false
      }
    }
  }

  /** Write a complete sibling file first; a failed publish must never truncate the old target. */
  fun writeText(
    target: File,
    value: String,
    publisher: (File, File) -> Boolean = ::publish,
  ) {
    val parent = target.parentFile ?: throw IOException("Target has no parent directory")
    val tmp = File(parent, target.name + ".tmp")
    tmp.writeText(value)
    if (publisher(tmp, target)) return
    tmp.delete()
    throw IOException("Could not atomically replace ${target.name}")
  }
}
