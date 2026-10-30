package com.dsharnessmobile.shell

import java.io.File

/**
 * 用户 Python 包的**只读环境注入**（issue #963 第 2 步）。
 *
 * 背景：`usr` 在快照刷新时是**整目录替换**（`SnapshotTransaction.replaceEntry("usr", …)`），
 * 所以用户 `pip install` 到 `usr/lib/python3.14/site-packages` 的包每次更新必丢。
 * 工厂快照里 `site-packages` 顶层只有 3 项（README.txt / pip / pip-26.2.2.dist-info，实测 563 条目归档）。
 *
 * 本步只做**「读」的一半**：把 `<files>/python-packages/py3.X` 前置进 `PYTHONPATH`。
 * **不搬任何数据、不建目录、不改 `usr`** —— 目录不存在时 `pythonPath` 返回 null，行为与改动前完全一致。
 * 这样它可以先合入并被单测钉住；真正的迁移是第 3 步（独立 PR，必须等本步进 main）。
 *
 * 次版本**不写死**：从 `usr/lib` 下唯一那个 `python3.*` 目录探测。写死会在下次换 Python 后静默失效。
 */
internal object PythonPackages {
  /** 用户包区目录名（位于 `filesDir` 下，**不在** `usr` 里 —— 那里会被整目录替换）。 */
  internal const val USER_DIR_NAME = "python-packages"

  /**
   * 探测 `usr/lib` 下唯一的 Python 次版本目录名。
   *
   * @param usrDir `files/usr`。
   * @returns 例如 `3.14`；找不到或不唯一时返回 null（宁可不注入，也不猜）。
   */
  internal fun detectMinor(usrDir: File): String? {
    val libDir = File(usrDir, "lib")
    val names = try {
      libDir.listFiles()?.mapNotNull { it.name } ?: emptyList()
    } catch (_: Throwable) {
      return null
    }
    val minors = names.filter { it.startsWith("python3.") }
    if (minors.size != 1) return null
    val minor = minors[0].removePrefix("python")
    return minor.takeIf { it.isNotEmpty() }
  }

  /**
   * 用户包区：`<files>/python-packages/py3.14`。
   *
   * 按次版本分层：含 `.so` 的包二进制不跨次版本兼容，分层后旧层不参与 `PYTHONPATH`，
   * 不会把错配的 `.so` 喂进去。
   */
  internal fun userPackagesDir(filesDir: File, minor: String): File =
    File(File(filesDir, USER_DIR_NAME), "py" + minor)

  /**
   * 要前置的 `PYTHONPATH` 值；**不适用时返回 null**（调用方据此完全不设置该变量）。
   *
   * 返回 null 的情形（都保持改动前行为）：
   *  - `usr/lib` 下没有唯一的 `python3.*`；
   *  - 用户包区目录不存在（本步不创建它 —— 创建是第 3 步迁移的事）。
   *
   * @param filesDir 应用 `filesDir`。
   * @param usrDir `files/usr`。
   * @returns `<user>:<factory>` 形式；用户区在前，工厂 `site-packages` 在后（工厂 pip 仍可用）。
   */
  internal fun pythonPath(filesDir: File, usrDir: File): String? {
    val minor = detectMinor(usrDir) ?: return null
    val userDir = userPackagesDir(filesDir, minor)
    if (!userDir.isDirectory) return null
    val factory = File(File(File(usrDir, "lib"), "python" + minor), "site-packages")
    return userDir.absolutePath + File.pathSeparator + factory.absolutePath
  }
}