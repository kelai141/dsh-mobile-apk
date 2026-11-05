package com.dsharnessmobile.shell

import java.io.File

/**
 * 用户 Python 包的**落点重定向 + 一次性搬迁**（issue #963 第 3 步）。
 *
 * ## 为什么不能靠"搬得更勤"
 * `usr` 在快照刷新时是**整目录 rename 替换**（`SnapshotTransaction.replaceEntry(..., "usr", ...)`，
 * 实现见 `SnapshotTransaction.kt` 的 `replaceEntry`：`move(live, previous)` + `move(staged, live)`），
 * 而 `pip install` 默认落在 `usr/lib/python3.14/site-packages`。所以每次更新必丢——在"销毁点前
 * sweep"只能把丢失窗口缩小，不能消除。本对象做的是**让 pip 根本不要往 usr 里写**。
 *
 * ## 机制（设备实测，emulator-5558 / Android 15 / Python 3.14.8）
 * 引擎启动环境里设 `PIP_USER=1` + `PYTHONUSERBASE=<files>/python-packages`：
 *  - `pip install` 落到 `<files>/python-packages/lib/python3.14/site-packages`（**在 usr 之外**，
 *    与 `home` 同级，快照事务只替换 `usr`，从不整树替换 `files` 顶层条目）；
 *  - Python 的 user site 本来就在 `sys.path` 上，**无需 PYTHONPATH**；
 *  - `pip list --user` / `pip uninstall` 仍然可用（这点 `PIP_TARGET` 做不到）。
 *
 * ## 三条实测出来的硬约束（错一条就静默失效）
 *  ① **目录必须先存在**：`PYTHONUSERBASE` 指向不存在的目录时，Python **不把 user site 加进
 *     `sys.path`**（实测 `site.getusersitepackages() in sys.path == False`）。所以 [environment] 必须
 *     `mkdirs`，且**只有**建成功才设置这两个变量。
 *  ② **设了 base 就看不见旧的默认 user site**：`~/.local/lib/python3.14/site-packages` 会从
 *     `sys.path` 消失。所以迁移必须把旧默认 user site 一并捞过来（[legacyDefaultUserSite]）。
 *  ③ **console script 落在 `<base>/bin`**，不在 PATH 上（实测 `which pycowsay` 为空）。本对象不
 *     改 PATH：把用户 bin 塞进引擎 PATH 会让"同名工具覆盖工厂版"变成一个隐式面；这属于后续步骤。
 *
 * ## 次版本不写死
 * 从 `usr/lib` 下唯一那个 `python3.*` 探测（[detectMinor]）。写死会在下次换 Python 后静默失效；
 * 探测不唯一时**宁可不注入也不猜**。
 *
 * ## 幂等与可中断
 * 迁移用 rename（`Files.move`，与 `SnapshotFs.move` 同原语），逐个顶层条目搬：
 * 中断后要么在源、要么在目标，**不会两处都没有**；重跑时已搬走的条目自然不在源里。
 * 目标已存在同名条目时**不覆盖**（用户可能在新布局里重装过），只记冲突。
 */
internal object PythonPackages {
  /** 用户包区目录名（位于 `filesDir` 下，**不在** `usr` 里 —— 那里会被整目录替换）。 */
  internal const val USER_DIR_NAME = "python-packages"

  // 迁移**刻意不用**幂等标记：标记会让"标记写下之后又装进 usr 的包"永远搬不动
  // （repairProfilePatch 的教训是"必须用独立标记"，但那条前提是"修复本身只该发生一次"）。
  // 搬迁的幂等性来自数据本身 —— 搬完源就空了，重跑只是几次 listFiles。

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
   * 用户包区根：`<files>/python-packages`（= `PYTHONUSERBASE` 的值）。
   *
   * 按次版本分层：含 `.so` 的包二进制不跨次版本兼容，分层后旧层不参与 `sys.path`，
   * 不会把错配的 `.so` 喂进去。
   */
  internal fun userBase(filesDir: File): File = File(filesDir, USER_DIR_NAME)

  /** 用户包区：`<files>/python-packages/lib/python3.14/site-packages`（= user site 本体）。 */
  internal fun userSiteDir(filesDir: File, minor: String): File =
    File(File(File(userBase(filesDir), "lib"), "python" + minor), "site-packages")

  /**
   * 旧默认 user site（`PYTHONUSERBASE` 未设时 pip `--user` 的落点）：`<home>/.local/lib/python3.X/site-packages`。
   *
   * 设了 `PYTHONUSERBASE` 之后它**从 `sys.path` 上消失**，所以迁移必须把它一起搬走。
   */
  internal fun legacyDefaultUserSite(homeDir: File, minor: String): File =
    File(File(File(homeDir, ".local"), "lib"), "python" + minor + "/site-packages")

  /** 引擎启动环境里要设的变量；**不适用时返回空 map**（调用方据此完全不设置）。 */
  internal fun environment(filesDir: File, usrDir: File): Map<String, String> {
    val minor = detectMinor(usrDir) ?: return emptyMap()
    val site = userSiteDir(filesDir, minor)
    // 约束 ①：目录不存在时 user site 不进 sys.path，设了变量等于什么都没做——先建，建不成就不设。
    if (!ensureDir(site)) return emptyMap()
    return mapOf("PIP_USER" to "1", "PYTHONUSERBASE" to userBase(filesDir).absolutePath)
  }

  /**
   * 一次搬迁的结果（供日志/诊断面消费；不参与控制流）。
   *
   * @param moved 实际搬走的顶层条目名（源 → 目标）。
   * @param conflicts 目标已有同名条目、因此**留在原地**的条目名（不覆盖）。
   * @param failures 单个条目搬迁失败（含源路径与异常类名）；不阻塞其余条目。
   */
  internal data class MigrationResult(
    val moved: List<String>,
    val conflicts: List<String>,
    val failures: List<String>,
  ) {
    val touched: Boolean get() = moved.isNotEmpty() || conflicts.isNotEmpty() || failures.isNotEmpty()
  }

  /**
   * 一次性把用户包搬进新布局。**幂等、可中断、不覆盖**。
   *
   * 处理顺序（**顺序本身是判据**，改动前先读一遍）：
   *  1. **先扫 `usr` 里的用户包**（`usr/lib/python3.X/site-packages` 减去工厂 3 项）。
   *     这是"当前还在用、但下次刷新必丢"的那一份，必须最先捞 —— 它寿命最短。
   *  2. **再扫旧默认 user site**（`<home>/.local/lib/python3.X/site-packages`）。
   *     设了 `PYTHONUSERBASE` 之后它会从 `sys.path` 消失，晚一步就变成"看得见目录、import 不到"。
   *  3. **最后扫 `.snapshot-previous/usr/lib/python3.X/site-packages`**（上一轮已丢的救援通道）。
   *     它有寿命：下一次 swap 的 `deletePathStrict(previous)` 会把它清掉，所以只能在"下次刷新之前"
   *     的启动里捞。
   *
   * 每个源树都按"工厂条目跳过 / 目标已有同名条目则记冲突不覆盖 / 其余 rename"处理。
   *
   * @param factoryEntries 额外的工厂条目名（快照升级后若新增了工厂条目，由调用方补进来）。
   *   默认判据 [isFactoryEntry] 已覆盖实测的 3 项：`README.txt` / `pip` / `pip-<ver>.dist-info`。
   * @param move 搬迁原语（默认 rename；JVM 单测可注入以对照失败路径）。
   */
  internal fun migrate(
    filesDir: File,
    usrDir: File,
    homeDir: File,
    factoryEntries: Set<String>? = null,
    move: (File, File) -> Unit = { source, destination -> defaultMove(source, destination) },
  ): MigrationResult {
    val minor = detectMinor(usrDir) ?: return MigrationResult(emptyList(), emptyList(), emptyList())
    val target = userSiteDir(filesDir, minor)
    if (!ensureDir(target)) {
      return MigrationResult(emptyList(), emptyList(), listOf("cannot create " + target.absolutePath))
    }
    val extraFactory = factoryEntries ?: emptySet()
    val moved = mutableListOf<String>()
    val conflicts = mutableListOf<String>()
    val failures = mutableListOf<String>()

    // 顺序是判据：usr（寿命最短，下次刷新必丢）→ 旧默认 user site（设了 base 就看不见）→ previous（有寿命）。
    val sources = listOf(
      "usr" to File(File(File(usrDir, "lib"), "python" + minor), "site-packages"),
      "legacy-home" to legacyDefaultUserSite(homeDir, minor),
      "previous" to File(File(File(File(filesDir, SnapshotTransaction.PREVIOUS_NAME), "usr"), "lib"), "python" + minor + "/site-packages"),
    )
    for ((label, source) in sources) {
      if (!source.isDirectory) continue
      val entries = try {
        source.listFiles()?.sortedBy { it.name } ?: emptyList()
      } catch (t: Throwable) {
        failures += label + ": cannot list (" + t.javaClass.simpleName + ")"
        continue
      }
      for (entry in entries) {
        // 工厂条目留在原地：搬走它们等于从 usr 里挖掉 pip 自己的 dist-info。
        if (isFactoryEntry(entry.name, extraFactory)) continue
        val destination = File(target, entry.name)
        if (destination.exists()) {
          // 不覆盖：用户可能已在新布局里重装过同名包，覆盖等于拿旧字节顶掉新字节。
          conflicts += label + "/" + entry.name
          continue
        }
        try {
          move(entry, destination)
          moved += label + "/" + entry.name
        } catch (t: Throwable) {
          // 单个条目搬不动不阻塞其余：留在源里，下次启动重试（源还在 ⇒ 不会两处都没有）。
          failures += label + "/" + entry.name + " (" + t.javaClass.simpleName + ")"
        }
      }
    }
    return MigrationResult(moved, conflicts, failures)
  }

  /**
   * 默认 rename 原语：同卷 `Files.move`。
   *
   * **不预删目标**：[migrate] 已在调用前挡住"目标已有同名条目"这条路，而 `Files.move`
   * 在目标存在时会自己抛 `FileAlreadyExistsException`——预删只会多出一条"把非空目录当文件删"
   * 的失败面，且失败点离真因更远。
   */
  private fun defaultMove(source: File, destination: File) {
    destination.parentFile?.let { java.nio.file.Files.createDirectories(it.toPath()) }
    java.nio.file.Files.move(source.toPath(), destination.toPath())
  }

  /**
   * 工厂快照 `site-packages` 顶层的条目名（实测值，2026-10-31 / Python 3.14.8）。
   *
   * 只用于**迁移时跳过**，不用于判定"是不是工厂包"——判定靠"顶层条目名在这个集合里"，
   * 多出来的（`tzdata`、`tzdata-2026.6.dist-info`……）就是用户装的。
   * `pip-<ver>.dist-info` 版本号会随快照升级变化，因此按前缀匹配而不是全等。
   */
  private val DEFAULT_FACTORY_ENTRIES = setOf("README.txt", "pip")

  /** 工厂条目判定：精确名 或 `pip-<ver>.dist-info` 形态。 */
  internal fun isFactoryEntry(name: String, extra: Set<String> = emptySet()): Boolean =
    name in DEFAULT_FACTORY_ENTRIES || name in extra ||
      (name.startsWith("pip-") && name.endsWith(".dist-info"))

  private fun ensureDir(dir: File): Boolean = try {
    if (dir.isDirectory) true else dir.mkdirs() || dir.isDirectory
  } catch (_: Throwable) {
    false
  }
}
