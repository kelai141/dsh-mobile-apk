package com.dsharnessmobile.shell

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 同目录临时文件 + 原子发布的**唯一通用入口**（issue #1057）。
 *
 * 仓内曾有两套「临时文件 + 原子替换」：强的一套（[SnapshotTransaction.writeTextAtomic]：
 * 唯一临时名 + fsync + 失败留 `.pre-*` 证据）与弱的一套（本文件的旧实现：固定名
 * `<target>.tmp`、无 fsync、publish 失败回退**直写目标**）。弱的那套被用在快照指纹、
 * 修复会话索引、通知决策队列等**用户数据/状态**文件上，两个后果都是实锤：
 *  ① 固定名 ⇒ 两次写同一目标互相踩：后一次写掉的临时文件正是前一次要搬走的那一个，
 *     于是「前一次的内容」与「后一次的进度」互相污染；
 *  ② 无 fsync ⇒ 写完就 rename，页缓存还没落盘就已经覆盖了旧目标，掉电/硬杀后目标可能是
 *     0 字节或半截；而半截文件比「没更新」坏得多（读侧解析失败或静默跳过）。
 *
 * 因此这里只做一件事：**写完、flush、fsync，再让 publisher 决定是否发布**；发布失败就
 * 抛 [IOException] 并保持目标原样，**绝不回退成直写目标**——直写把「可能失败的替换」变成
 * 「确定会截断目标的写入」，崩溃窗口内的半写文件正是 #1057 要消掉的那个形态。
 *
 * 快照事务的写入仍走 [SnapshotTransaction.writeTextAtomic]：它需要 validate 回调、
 * `SnapshotFsException` 错误码与 `.pre-*` 留证语义，与这里的通用面不是同一件事，不合并。
 */
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

  /**
   * 原子写文本。失败抛 [IOException]，**目标保持原值**（调用方据此中止，不得改写成直写）。
   *
   * @param publisher 发布实现；返回 false 表示发布失败（单测用它注入失败）。
   */
  fun writeText(
    target: File,
    value: String,
    publisher: (File, File) -> Boolean = ::publish,
  ) = writeBytes(target, value.toByteArray(Charsets.UTF_8), publisher)

  /**
   * 原子写字节（供需要**逐字节保真**的调用方，例如把用户手改过的配置原样搬到另一侧）。
   *
   * 唯一临时名 + fsync 只在这一处实现；[writeText] 是它的文本面。
   */
  fun writeBytes(
    target: File,
    bytes: ByteArray,
    publisher: (File, File) -> Boolean = ::publish,
  ) {
    val parent = target.absoluteFile.parentFile ?: throw IOException("Target has no parent directory")
    // 唯一临时名：固定名 <target>.tmp 会让两次写同一目标互相踩（见类型注释 ①）。
    val tmp = Files.createTempFile(parent.toPath(), "." + target.name + "-", ".tmp").toFile()
    try {
      // 写完 + flush + fsync（见类型注释 ②）：fsync 之前 rename 等于把「页缓存里的半成品」当成新值发布。
      FileOutputStream(tmp).use { output ->
        output.write(bytes)
        output.flush()
        output.fd.sync()
      }
      if (publisher(tmp, target)) return
      throw IOException("Could not atomically replace ${target.name}")
    } finally {
      // 发布成功时 tmp 已被 move 消费（delete 是 no-op）；失败时清掉本次临时文件，目标从未被打开过。
      if (tmp.exists()) tmp.delete()
    }
  }

  /**
   * 发布一个**已经写好**的临时文件（供必须流式落盘、不便整块读进内存的调用方）。
   *
   * fsync 仍然只在这里实现：调用方负责把内容写完并 flush，本函数补 fsync 再发布。
   * 发布失败抛 [IOException] 并清理临时文件，**目标保持原值**。
   */
  fun publishWritten(
    tmp: File,
    target: File,
    publisher: (File, File) -> Boolean = ::publish,
  ) {
    try {
      // 以追加方式打开只为了拿到 fd 做 fsync：不改变已有内容，也不需要把整块字节留在内存里。
      FileOutputStream(tmp, true).use { it.fd.sync() }
      if (publisher(tmp, target)) return
      throw IOException("Could not atomically replace ${target.name}")
    } finally {
      if (tmp.exists()) tmp.delete()
    }
  }
}
