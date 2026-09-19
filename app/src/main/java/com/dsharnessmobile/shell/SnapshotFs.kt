package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.attribute.BasicFileAttributes

/**
 * Symbolic-link-safe filesystem primitives shared by the snapshot transaction and
 * the legacy user-data recovery. Every helper here is deliberately NOFOLLOW: a
 * dangling link inside the runtime tree is ordinary upgrade residue and must never
 * be resolved into the live tree, and a recursive delete must never escape through
 * a link into user data.
 */
internal object SnapshotFs {

  /** Existence without following a symbolic link. */
  fun exists(file: File): Boolean = Files.exists(file.toPath(), NOFOLLOW_LINKS)

  /** True when [file] is a symbolic link, dangling or not. */
  fun isSymbolicLink(file: File): Boolean = Files.isSymbolicLink(file.toPath())

  /**
   * Deletes a file, directory or link without following links.
   *
   * 逐项容错（0.14.0 模拟器实锤）：**一个删不掉的条目曾让整个快照刷新永久卡死**。
   * 现象：模拟器异常掉线时解压中断，留下 `.snapshot-stage/home`；该目录的内部元数据损坏，
   * `ls` 看是空的、`rm -rf` 与 `rmdir` 都删不掉（\`Not a data message\` ／ \`Directory not empty\`）。
   * 而本方法是 refreshSnapshot 的第一步（清理上次残留），它一抛异常就：
   *   ① 本次刷新失败；② 回滚也走同一方法 → **回滚同样失败**（实测日志：
   *   \`snapshot refresh rollback failed; recovery marker retained\`）；
   *   ③ 残留永远存在 ⇒ **之后每次启动都失败**，用户只能清应用数据。
   *
   * 因此这里不能「遇到坏条目就整体失败」：能删的必须删掉，删不掉的**如实记下并继续**，
   * 由调用方决定是否致命。清理阶段的残余不影响后续解压到干净的 staging 目录——
   * 反过来，因一个残余就让整条升级链永久瘫痪，是远比残留更严重的问题。
   *
   * @param onFailure 单条删除失败时的回调（收集诊断用）；不抛异常。
   */
  fun deletePath(path: File, onFailure: (File, Exception) -> Unit = { _, _ -> }) {
    val nioPath = path.toPath()
    try {
      if (!Files.exists(nioPath, NOFOLLOW_LINKS)) return
      val attrs = Files.readAttributes(nioPath, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      if (attrs.isDirectory) {
        // 目录项本身读取失败（元数据损坏）也要能继续：记下并跳过，不要让它中断整棵树。
        //
        // 0.14.1 P0（真机崩溃实锤）：这里原为 `Files.list(nioPath).use { it.toList() }`。
        // `java.util.stream.Stream.toList()` 是 **Java 16 引入、Android API 34 才提供**的接口方法，
        // 而本项目 minSdk = 26 —— 在 API < 34 设备上抛 `NoSuchMethodError`。
        // 关键：`NoSuchMethodError` 是 **Error 而非 Exception**，外层 `catch (e: Exception)` 抓不住，
        // 于是直接打穿 `SnapshotTransaction.finish` → 事务恢复**永远无法完成**（marker retained），
        // 快照刷新/恢复在 Android < 34 上卡死（华为 NOH-AN00 / Android 31 实测：12:55/12:56/12:57
        // 三时点、主线程与工作线程均崩于此行）。
        // 改用 `Files.newDirectoryStream`：`DirectoryStream<Path>` 是 `Iterable` + `Closeable`，
        // Kotlin 的 `toList()` 是自带的 stdlib 扩展（**无 API 级别依赖**），语义等价：
        // 只列直接子项、不跟随符号链接（调用方已按 NOFOLLOW 判定 attrs.isDirectory，
        // 符号链接到目录者不会进本分支）、`use` 保证关闭。
        val children = try {
          Files.newDirectoryStream(nioPath).use { stream -> stream.toList() }
        } catch (e: Exception) {
          onFailure(path, e)
          return
        }
        for (child in children) deletePath(child.toFile(), onFailure)
      }
      Files.deleteIfExists(nioPath)
    } catch (e: Exception) {
      onFailure(path, e)
    }
  }

  /** Rename within one filesystem; falls back to a plain move when ATOMIC_MOVE is unsupported. */
  fun move(source: File, destination: File) {
    destination.parentFile?.let { Files.createDirectories(it.toPath()) }
    try {
      Files.move(source.toPath(), destination.toPath(), ATOMIC_MOVE)
    } catch (_: AtomicMoveNotSupportedException) {
      Files.move(source.toPath(), destination.toPath())
    }
  }

  /**
   * 目录字节数（**不跟随符号链接**：快照树里有大量指向同树的链，跟随会把体积算成几倍）。
   * 用于交换前的空间断言（审查 §7.2-F-4）。不可读的条目按 0 计（宁可低估也不抛）。
   */
  fun sizeOf(dir: File): Long {
    if (!exists(dir)) return 0L
    if (isSymbolicLink(dir)) return 0L
    if (dir.isFile) return dir.length()
    var total = 0L
    val children = dir.listFiles() ?: return 0L
    for (child in children) total += sizeOf(child)
    return total
  }

  fun createDirectories(dir: File) {
    Files.createDirectories(dir.toPath())
  }
}
