package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.COPY_ATTRIBUTES
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes

/**
 * Durable transaction for replacing the embedded runtime.
 *
 * The refresh used to extract the archive straight over the live tree, so a
 * process kill (OEM cleaner, low memory, user force-stop) left a half-old /
 * half-new runtime on disk while the fingerprint still advertised the old one.
 * The transaction separates the two phases:
 *
 * 1. **stage** — the archive is extracted into [stageRoot] only; the live tree is
 *    untouched, so an interrupted extraction is harmless and the old runtime
 *    keeps working.
 * 2. **swap** — `usr` is renamed in as a whole and every factory-owned entry of
 *    `home/.dsh` is replaced, while user-owned names (`sessions`, `settings.yaml`,
 *    …) are left exactly where they are: never copied, never moved, never deleted.
 *    Displaced factory entries are parked in [previousRoot] and every entry is
 *    journaled in the marker before it is touched.
 *
 * The marker is the recovery authority on the next start: `STAGED` discards the
 * stage, `SWAPPING` restores the parked factory entries, `SWAPPED` rolls forward.
 * Nothing here depends on Android APIs so the state machine is unit-testable.
 */
internal object SnapshotTransaction {

  const val STAGE_NAME = ".snapshot-stage"
  const val PREVIOUS_NAME = ".snapshot-previous"
  /** stage 删不掉时被改名挪开的解压残渣前缀（写点在 EngineManager；回收见 [reclaimResidue]）。 */
  const val STAGE_ORPHAN_PREFIX = ".snapshot-stage-orphan-"

  /**
   * 已摘除的 profile 插件（[reconcileRemovedProfilePlugins] 的迁移清单）。
   * 每条 = 「挂载 id + 包名」；摘除新插件时在这里加一条，老设备下次刷新即被清干净。
   */
  private val REMOVED_PROFILE_PLUGINS = listOf(
    // 0.14.1 审查 §9（用户裁定）：第三方模型同步插件，理由见 profile-web.cordis.patch.yml 的注释。
    RemovedProfilePlugin(mountId = "dsh-model-sync", packageName = "@aiwayds/dsh-model-sync"),
  )

  /** [REMOVED_PROFILE_PLUGINS] 的条目。 */
  private data class RemovedProfilePlugin(val mountId: String, val packageName: String)
  const val MARKER_NAME = ".snapshot-transaction"
  private const val TMP_MARKER_NAME = ".snapshot-transaction.tmp"

  enum class Phase { STAGED, SWAPPING, SWAPPED }

  data class Marker(
    val phase: Phase,
    val fingerprint: String,
    val startedAt: Long,
    val moved: List<String> = emptyList(),
  )

  enum class Outcome { NONE, DISCARDED_STAGE, ROLLED_BACK, ROLLED_FORWARD, ROLLBACK_FAILED }

  /**
   * 交换前空间不足（审查 §7.2-F-4）。**专门类型**而不是 IOException：调用方要能对它给
   * 「请清理空间后重试」这类可直接照做的文案，而不是与归档损坏/ENOSPC 混在同一句
   * 「运行时更新失败」里（§7.2 的 F-7 就是这种「同一句报错多种真因」的形态）。
   */
  class InsufficientSpaceException(val requiredBytes: Long, message: String) : IOException(message)

  /**
   * [fingerprintToCommit] is set when the swap completed but the commit write did not.
   * [failures] 非空 = 回滚未完整落地（marker 已按 D-3 保留；条目名供诊断）。
   */
  data class Recovery(
    val outcome: Outcome,
    val fingerprintToCommit: String? = null,
    val failures: List<String> = emptyList(),
  )

  /** 回滚结果：[ok]=false 时 [failures] 列出没能恢复的条目（marker 必须保留）。 */
  data class RollbackResult(val ok: Boolean, val failures: List<String>)

  fun markerFile(filesDir: File): File = File(filesDir, MARKER_NAME)

  fun stageRoot(filesDir: File): File = File(filesDir, STAGE_NAME)

  fun previousRoot(filesDir: File): File = File(filesDir, PREVIOUS_NAME)

  fun writeMarker(filesDir: File, marker: Marker) {
    val text = render(marker)
    val tmp = File(filesDir, TMP_MARKER_NAME)
    tmp.writeText(text)
    val target = markerFile(filesDir)
    SnapshotFs.deletePath(target)
    if (!tmp.renameTo(target)) {
      // Rename can fail on exotic mounts; the marker must still exist before the
      // swap touches anything, so fall back to a direct write.
      target.writeText(text)
      SnapshotFs.deletePath(tmp)
    }
  }

  fun readMarker(filesDir: File): Marker? {
    val file = markerFile(filesDir)
    if (!SnapshotFs.exists(file)) return null
    val text = try {
      file.readText()
    } catch (_: Throwable) {
      // Unreadable marker: treat it as an interrupted swap (the conservative choice).
      return Marker(Phase.SWAPPING, "", 0L)
    }
    var phase: Phase? = null
    var fingerprint = ""
    var startedAt = 0L
    val moved = mutableListOf<String>()
    text.lineSequence().forEach { line ->
      val separator = line.indexOf('=')
      if (separator <= 0) return@forEach
      when (line.substring(0, separator)) {
        "phase" -> phase = try {
          Phase.valueOf(line.substring(separator + 1))
        } catch (_: Throwable) {
          null
        }
        "fingerprint" -> fingerprint = line.substring(separator + 1)
        "started" -> startedAt = line.substring(separator + 1).toLongOrNull() ?: 0L
        "moved" -> moved += line.substring(separator + 1)
      }
    }
    // An unknown phase is an interrupted swap: rolling back is the only outcome
    // that cannot leave a half-activated runtime behind.
    return Marker(phase ?: Phase.SWAPPING, fingerprint, startedAt, moved)
  }

  fun clearMarker(filesDir: File) {
    SnapshotFs.deletePath(markerFile(filesDir))
    SnapshotFs.deletePath(File(filesDir, TMP_MARKER_NAME))
  }

  /**
   * Removes every artifact of a completed transaction.
   *
   * @param delete - 删除原语（默认 [SnapshotFs.deletePath]）。与 `deletePath` 的 `onFailure`
   *   同款的既有惯例：把「可能失败的一步」作为参数传入，使 [finish] 的**顺序不变量**
   *   （marker 必须清）能在 JVM 上被注入式验证——真机打穿它的是一次 `Error`（见下），
   *   而 JVM 测试无法凭空制造设备侧的错误，只能显式注入。
   */
  fun finish(filesDir: File, delete: (File) -> Unit = { SnapshotFs.deletePath(it) }) {
    // 0.14.1 块K ②（反馈二）：产物清理**不得**阻止 marker 清除。marker 是恢复权威；
    // 它一旦残留 SWAPPED，之后每次启动都会重跑 roll-forward，而 .snapshot-previous
    // （用户实测 920 MB）与 .snapshot-stage（176 MB）在 marker 断言「已提交」之后
    // 永远不会再被清理。用户真机实测的正是这一形态（华为 NOH-AN00 / Android 31）。
    //
    // 为什么必须 try/finally 而不是靠 deletePath 的容错：deletePath 只 catch `Exception`，
    // 而本轮真机打穿它的恰是 `NoSuchMethodError`（**Error**，API 34 才有的 Stream.toList）
    // ——Error 直接越过 catch 让 finish 在 clearMarker 之前中止。清理失败可以下一轮重试，
    // marker 残留却会让「下一轮」也永远走同一条路。
    try {
      delete(previousRoot(filesDir))
      delete(stageRoot(filesDir))
    } finally {
      clearMarker(filesDir)
    }
  }

  /**
   * marker 缺席时**只剩事务残渣**的两个目录是否还在（`.snapshot-previous` / `.snapshot-stage`）。
   *
   * 用途见 [reclaimResidue]：正常路径不构成缺陷（`finish()` 会清）；缺陷形态是
   * **marker 已丢而残渣还在**——此后没有任何一步会回收它们，用户实测 920 MB 长期占地。
   * @param filesDir - 应用私有 files 目录。
   * @returns 二者任一存在即 true。
   */
  fun hasResidue(filesDir: File): Boolean =
    SnapshotFs.exists(previousRoot(filesDir)) || SnapshotFs.exists(stageRoot(filesDir))

  /**
   * 幂等收敛：回收 marker 已丢失的事务残渣（反馈二的核心诉求）。
   *
   * **安全前提由调用方保证**：只在「内嵌快照已激活」时调用（指纹 == 内嵌快照 + node 在场）。
   * 此时 `swap()` 已把 live 树换到位，`previous` 只是被置换下去的旧工厂副本、`stage` 是解压残留，
   * 删除不损失任何可用状态。
   *
   * **绝不无条件删**：半程事务（marker 为 SWAPPING 但被丢/不可读）的 `previous` 是**唯一**
   * 回滚源，删它会把「能回滚」变成「只能前进」。因此本函数不自己判断新鲜度，由调用方前置。
   * @param filesDir - 应用私有 files 目录。
   * @returns 实际回收的条目名（供调用方写日志；空 = 无残渣）。
   */
  fun reclaimResidue(filesDir: File, now: Long = System.currentTimeMillis()): List<String> {
    val reclaimed = mutableListOf<String>()
    if (SnapshotFs.exists(previousRoot(filesDir))) {
      SnapshotFs.deletePath(previousRoot(filesDir))
      if (!SnapshotFs.exists(previousRoot(filesDir))) reclaimed += PREVIOUS_NAME
    }
    if (SnapshotFs.exists(stageRoot(filesDir))) {
      SnapshotFs.deletePath(stageRoot(filesDir))
      if (!SnapshotFs.exists(stageRoot(filesDir))) reclaimed += STAGE_NAME
    }
    // ── 审查 N-1 / F-9：另两类**只写不回收**的残渣 ────────────────────────────────
    //
    // `.snapshot-stage-orphan-<ts>`（EngineManager 在「stage 删不掉」时改名挪开的目录）此前
    // 只有写点、全仓无回收点；`*.failed-<ts>`（rollback/merge 补偿时把删不净的 live 树改名挪开）
    // 同样只写不回收。两者都是**全量树副本**（数百 MB 量级），与「失败→留残渣→空间变紧→更易失败」
    // 形成自我强化（N-1 的原话）。
    //
    // 年龄门槛（30 分钟）刻意存在：这两类目录由**正在进行**的回滚/补偿产生，而本函数可能在
    // 同一轮启动里被调用——没有门槛就会把刚挪开、仍可能被本次恢复引用的目录删掉。
    // 30 分钟 ≫ 一次刷新（8–12 分钟），也 ≫ 一次启动恢复。
    for (dir in residueDirs(filesDir, now)) {
      val before = SnapshotFs.exists(dir)
      if (!before) continue
      SnapshotFs.deletePath(dir)
      if (!SnapshotFs.exists(dir)) reclaimed += dir.name
    }
    return reclaimed
  }

  /** 回收年龄门槛：只动「明显不再属于进行中事务」的残渣（见 [reclaimResidue]）。 */
  private const val RESIDUE_MIN_AGE_MS = 30L * 60L * 1000L

  /**
   * 扫描三类位置上的残渣目录（纯函数，可单测）：
   *  - `files/` 与 `files/home/` 与 `files/home/.dsh/` 下的 `*.failed-*`（rollback/补偿挪开的 live 树）；
   *  - `files/` 下的 `.snapshot-stage-orphan-*`（stage 删不掉时挪开的解压残渣）。
   *
   * 为什么只扫这三层：`.failed-*` 的写点只有「live 条目的兄弟位置」，而 live 条目全部落在
   * `files/usr`、`files/home/<name>`、`files/home/.dsh/<name>` 三处（见 livePath）。不做全树递归 =
   * 不把用户数据树整个走一遍（回收入口在启动路径上，必须廉价）。
   */
  fun residueDirs(filesDir: File, now: Long = System.currentTimeMillis()): List<File> {
    val out = mutableListOf<File>()
    val dirs = listOf(filesDir, File(filesDir, "home"), File(filesDir, "home/.dsh"))
    for (dir in dirs) {
      val children = dir.listFiles() ?: continue
      for (child in children) {
        val name = child.name
        val isFailed = name.contains(".failed-")
        val isOrphanStage = dir == filesDir && name.startsWith(STAGE_ORPHAN_PREFIX)
        if (!isFailed && !isOrphanStage) continue
        if (!SnapshotFs.exists(child)) continue
        // 年龄门槛：`<ts>` 后缀是写点时间戳；解析不出时间戳的（老版本命名）不删（保守）。
        val stamp = name.substringAfterLast('-', "").toLongOrNull() ?: continue
        if (now - stamp < RESIDUE_MIN_AGE_MS) continue
        out += child
      }
    }
    return out
  }

  /**
   * Activates [stagedRoot] over the live tree. Factory entries are journaled
   * before they are touched so [rollback] can decide from the filesystem which
   * half of the rename pair completed.
   */
  fun swap(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
    preservedNames: Set<String>,
    fingerprint: String,
    startedAt: Long,
    onEntry: (String) -> Unit = {},
    /**
     * 空间前置检查（审查 §7.2-F-4 / B12）：入参是**本次交换需要保留的可用字节**，
     * 返回拒绝文案（null = 放行）。注入式而非直接调 Android StatFs，是为了让事务保持纯 JVM 可测
     * （同 `delete` 注入的既有做法）。
     */
    spaceCheck: ((requiredBytes: Long) -> String?)? = null,
  ): List<String> {
    val stagedUsr = File(stagedRoot, "usr")
    if (!SnapshotFs.exists(stagedUsr)) throw IOException("staged runtime is missing usr/")
    // 空间断言必须在**动第一棵树之前**：换到一半再 ENOSPC 只能靠回滚收拾，而回滚本身也要空间。
    // 需求 = 2.5 × 解压体量（解压树 + 合并期的 profiles 拷贝 + 余量），见 §7.6-1 的实测口径。
    if (spaceCheck != null) {
      val stagedBytes = SnapshotFs.sizeOf(stagedRoot)
      val required = stagedBytes * 5 / 2
      val refusal = spaceCheck(required)
      if (refusal != null) throw InsufficientSpaceException(required, refusal)
    }
    val previous = previousRoot(filesDir)
    SnapshotFs.deletePath(previous)
    SnapshotFs.createDirectories(previous)
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt))
    val moved = mutableListOf<String>()
    // #214：profiles 合并期间的工厂语义纠正说明（返回给调用方写日志/诊断）。
    val notes = mutableListOf<String>()

    replaceEntry(filesDir, moved, fingerprint, startedAt, "usr", stagedUsr, usrDir, File(previous, "usr"), onEntry)

    val stagedHome = File(stagedRoot, "home")
    if (SnapshotFs.exists(stagedHome)) {
      for (entry in stagedHome.listFiles() ?: emptyArray()) {
        if (entry.name == ".dsh") {
          val liveDsh = File(homeDir, ".dsh")
          val previousDsh = File(previous, "home/.dsh")
          SnapshotFs.createDirectories(liveDsh)
          SnapshotFs.createDirectories(previousDsh)
          for (child in entry.listFiles() ?: emptyArray()) {
            val liveChild = File(liveDsh, child.name)
            if (child.name in preservedNames && SnapshotFs.exists(liveChild)) {
              // User data stays exactly where it is.
              onEntry("保留用户数据 " + child.name)
              continue
            }
            if (child.name == "profiles" && SnapshotFs.exists(liveChild)) {
              // 0.13.8 #167：profiles 是「工厂面 + 用户面」混合容器——工厂条目
              // 更新、用户条目（第三方依赖/.npmrc/自打补丁/追加块）保留。
              // 0.14.0 #214：工厂对同 id 的 disabled 语义改为权威（旧规则「以 live 为基」使
              // 旧版遗留的 ui-layout disable 永不被纠正 → 根服务 layout 不 activate）。
              mergeProfiles(filesDir, moved, fingerprint, startedAt, child, liveChild, File(previousDsh, "profiles"), onEntry, notes)
              continue
            }
            replaceEntry(
              filesDir, moved, fingerprint, startedAt,
              "home/.dsh/" + child.name, child, liveChild, File(previousDsh, child.name), onEntry,
            )
          }
          if ((previousDsh.listFiles() ?: emptyArray()).isEmpty()) SnapshotFs.deletePath(previousDsh)
        } else {
          // 0.13.8 #179：home 顶层条目（.gitconfig 等）= 模板 + 用户覆盖混合体，
          // 语义是 seed-if-absent——live 已存在即用户数据，永不整树替换
          // （白名单机制只作用于 .dsh 子项，对本分支无效，见坑 67 之前的取证）。
          val liveEntry = File(homeDir, entry.name)
          if (SnapshotFs.exists(liveEntry)) {
            onEntry("保留用户数据 home/" + entry.name)
            continue
          }
          replaceEntry(
            filesDir, moved, fingerprint, startedAt,
            "home/" + entry.name, entry, liveEntry, File(previous, "home/" + entry.name), onEntry,
          )
        }
      }
    }
    writeMarker(filesDir, Marker(Phase.SWAPPED, fingerprint, startedAt, moved))
    return notes
  }

  /**
   * 0.13.8 #167：`profiles` 分区合并（原「整树替换」会静默抹掉用户插件生态：
   * 第三方依赖、.npmrc、pnpm-lock、自打引擎补丁、bundles 追加项全部丢失）。
   *
   * 规则（对 staged 树递归）：
   * - **staged 没有的条目一律不动**（live-only 的用户内容天然幸存，覆盖
   *   `.npmrc`/`pnpm-lock.yaml` 这类「工厂不发行」实证场景）；
   * - `package.json`：dependencies 与 dsh.profile.bundles 取**并集**，同名冲突保留用户 pin；
   * - `cordis.patch.yml`：按 id 合并——live 内容为基，追加 live 缺失的工厂块；
   * - 其余双存条目：工厂权威（staged 覆盖）。
   *
   * 原子性（review C4 收紧）：合并失去 rename 的事务性，因此先整目录**深拷贝备份**再合并。
   * 旧实现「先记 journal 后拷贝」：拷贝中途被杀 → journal 已声明 displaced 而 previous 只有半份，
   * 恢复路径用半份覆盖 live（用户插件生态/node_modules 缺失）。现在顺序改为：
   *   拷贝到 `profiles.copying` → 原子 rename 为 previous → **才**写 journal。
   * 崩溃窗口只可能留下不带 journal 的 `.copying` 残渣（下次刷新清掉），恢复路径信任的
   * previous 一律是完整备份；宁可本次刷新失败（marker 不被清、下次重试），绝不半份覆盖。
   */
  /**
   * 已摘除插件的**存量迁移**（0.14.1 D-1 的设备侧收尾）。
   *
   * 为什么必须有它（设备实测，不是推演）：profile 根的两个清单是**用户面**（[mergeProfiles] 里
   * `userFacingFiles` 的语义），所以 `cordis.patch.yml` 与 `node_modules` 里的第三方包在升级时
   * **不会被工厂面替换**。于是「从注入集摘除一个插件」在**已完成升级的老设备上等于没摘**：
   * 实测（16416 覆盖安装本轮构建）`profiles/web/node_modules/@aiwayds/dsh-model-sync` 仍在、
   * 清单里的挂载条目仍在 3 处 —— 插件照旧加载、照旧写用户的模型设置，
   * 而新装用户（净安装）完全正常。这正是「幽灵缺陷」的定义形态：一类用户有问题、另一类没有。
   *
   * 迁移内容（逐条具名，不做通用清理——用户自己装的第三方插件必须原样保留）：
   *   ① 从每个 profile 的 `cordis.patch.yml` 摘掉该插件的 insert 条目（两行：id + name）；
   *   ② 删除该插件在 profile `node_modules` 下的包目录。
   * 幂等：条目/目录已不在时是空操作（每轮刷新都会跑，必须无副作用）。
   *
   * @param liveProfiles live 的 `home/.dsh/profiles`。
   * @param notes [mergeProfiles] 的说明列表（迁移动作逐条留档，供 swapNotes 日志）。
   */
  private fun reconcileRemovedProfilePlugins(liveProfiles: File, notes: MutableList<String>) {
    val profiles = liveProfiles.listFiles() ?: return
    for (removed in REMOVED_PROFILE_PLUGINS) {
      for (profile in profiles) {
        if (!profile.isDirectory) continue
        // ① 清单条目
        val patch = File(profile, "cordis.patch.yml")
        if (patch.isFile) {
          val lines = patch.readLines()
          val kept = mutableListOf<String>()
          var dropped = 0
          var index = 0
          while (index < lines.size) {
            val trimmed = lines[index].trim()
            if (trimmed == "- id: " + removed.mountId) {
              // 该行与其后的 `name:` 行同属一个 insert 条目；再确认 name 就是被摘除的包名，
              // 避免误删「同 id 但不同包」的用户自定义条目。
              val nameLine = lines.getOrNull(index + 1)?.trim().orEmpty()
              val matches = nameLine == "name: '" + removed.packageName + "'" ||
                nameLine == "name: \"" + removed.packageName + "\""
              if (matches) {
                dropped += 1
                index += 2
                continue
              }
            }
            kept += lines[index]
            index += 1
          }
          if (dropped > 0) {
            val text = kept.joinToString("\n") + (if (kept.isNotEmpty()) "\n" else "") +
              "# 0.14.1：已摘除 " + removed.mountId + "（升级迁移自动清理；本行由 SnapshotTransaction 写入）\n"
            patch.writeText(text)
            notes += "profile " + profile.name + "：摘除挂载 " + removed.mountId + "（" + dropped + " 处）"
          }
        }
        // ② 包目录
        val packageDir = File(File(profile, "node_modules"), removed.packageName)
        if (SnapshotFs.exists(packageDir)) {
          SnapshotFs.deletePath(packageDir)
          if (!SnapshotFs.exists(packageDir)) {
            notes += "profile " + profile.name + "：删除存量包 " + removed.packageName
          }
        }
        // 作用域目录（`node_modules/@scope`）删空后一并清掉：留着空目录会让人误以为包还在
        // （构建期的 prune 也是这个语义）。
        val scopeDir = packageDir.parentFile
        if (scopeDir != null && scopeDir.name.startsWith("@") && (scopeDir.listFiles() ?: emptyArray()).isEmpty()) {
          SnapshotFs.deletePath(scopeDir)
        }
      }
    }
  }

  private fun mergeProfiles(
    filesDir: File,
    moved: MutableList<String>,
    fingerprint: String,
    startedAt: Long,
    stagedProfiles: File,
    liveProfiles: File,
    previousProfiles: File,
    onEntry: (String) -> Unit,
    notes: MutableList<String>,
  ) {
    // ① 备份先写临时名（拷贝失败/被杀 = live 与 journal 都不受影响）
    val copying = File(previousProfiles.parentFile, previousProfiles.name + ".copying")
    SnapshotFs.deletePath(copying)
    SnapshotFs.deletePath(previousProfiles)
    SnapshotFs.createDirectories(previousProfiles.parentFile ?: filesDir)
    copyRecursivelyStrict(liveProfiles, copying)
    // ② 备份完整落位（同目录原子 rename）后才记账——此后 rollbackEntry 信任 previous
    SnapshotFs.deletePath(previousProfiles)
    SnapshotFs.move(copying, previousProfiles)
    moved += "home/.dsh/profiles"
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt, moved.toList()))
    try {
      // 用户面 = 只有 **profile 根** 的两个清单（profiles/<name>/package.json 与 cordis.patch.yml）：
      // 用户 pin / 用户追加块只可能在这里。其下 node_modules 子树内的清单属工厂面——0.14.0 P0：
      // 旧实现把「并集」规则递归套到嵌套清单，只合并 dependencies/bundles 而丢掉工厂新增的
      // exports 等字段，live 树因此变成「旧清单 + 新文件」的混合体，插件跨包 import
      // "./route-auth" 直接 ERR_PACKAGE_PATH_NOT_EXPORTED（引擎 exit=1）。
      val userFacingFiles = HashSet<String>()
      for (profile in stagedProfiles.listFiles() ?: emptyArray()) {
        userFacingFiles += File(profile, "package.json").absolutePath
        userFacingFiles += File(profile, "cordis.patch.yml").absolutePath
      }
      mergeTree(stagedProfiles, liveProfiles, notes, userFacingFiles)
      reconcileRemovedProfilePlugins(liveProfiles, notes)
      val suffix = if (notes.isEmpty()) "" else "；工厂语义纠正 " + notes.size + " 处"
      onEntry("home/.dsh/profiles (merged" + suffix + ")")
    } catch (t: Throwable) {
      // 合并失败：整目录回滚到 live 原状，再把异常抛给调用方（中止启动，正常 recover）。
      //
      // 【0.14.1 升级路径 P0 修复】旧实现是裸的三行：
      //     SnapshotFs.deletePath(liveProfiles)
      //     SnapshotFs.move(previousProfiles, liveProfiles)
      //     throw t
      // 设备实测（16384 覆盖安装 0.14.0 → 0.14.1）暴露两个缺陷，二者叠加使升级**永久卡死**：
      //   ① `deletePath` 会**逐项容错**（删不掉的子项记 onFailure 后继续），因此它可能返回而
      //      liveProfiles **仍非空**；紧接着把目录 move 到非空目标 → `FileSystemException:
      //      ... Directory not empty`。
      //   ② 由于 ① 抛出的新异常取代了 `throw t`，**原始异常（真因）被完全掩盖**：日志里只剩
      //      「Directory not empty」，排障者拿不到真正的失败原因（与用户反馈一「日志与事实不符」
      //      同一病根）。连带 `EngineManager` 的 rollback 走同一路径，同样撞此错误 →
      //      「rollback failed; recovery marker retained」→ marker 永久留存、每次启动重试、
      //      每次同样失败（实测重启 3 次仍 SWAPPING），live 插件树半合并（1/10）。
      //
      // 修法：补偿动作**一律不得掩盖真因**，且删除失败必须有兜底。抽成
      // [compensateFailedProfilesMerge] 以便**行为级**单测（文本断言锁不住这类缺陷，
      // 本轮实测过：把 addSuppressed 删掉，纯文本判据照样绿）。
      throw compensateFailedProfilesMerge(filesDir, liveProfiles, previousProfiles, t)
    }
  }

  /**
   * 合并失败后的补偿：把 live profiles 恢复成 [previousProfiles]（整个函数**总是**抛
   * [original]，绝不把补偿自身的失败抛出去）。
   *
   * **为什么要单独抽出来**（0.14.1 升级路径 P0）：旧实现是内联三行
   * `deletePath(live); move(previous, live); throw original`，两个缺陷叠加使升级永久卡死：
   *  1. `SnapshotFs.deletePath` 是**逐项容错**的（删不掉的子项记 onFailure 后继续），所以它
   *     可能正常返回而目录**仍非空**；紧接着 `move` 到非空目标 → `FileSystemException:
   *     … Directory not empty`。
   *  2. 该次生异常**取代了** `throw original` → 真因（原始异常 + 栈）被彻底掩盖。
   *
   * 设备实证（16384，覆盖安装 0.14.0 → 0.14.1）：真因被掩盖成
   * `Directory not empty`，`EngineManager` 的 rollback 走同一路径也失败 →
   * `rollback failed; recovery marker retained` → marker 永久留在 SWAPPING、每次启动重试、
   * 每次同样失败（重启 3 次仍 SWAPPING），live 插件树半合并 1/10 → 页面 `Iterator is not defined`。
   *
   * @return 本函数**始终抛出** [original]；返回值只为满足 Kotlin 的类型推断（`throw` 表达式），
   *   调用方写 `throw compensate(...)`，语义上等价于 `throw original`。
   */
  private fun compensateFailedProfilesMerge(
    filesDir: File,
    liveProfiles: File,
    previousProfiles: File,
    original: Throwable,
  ): Throwable {
    try {
      SnapshotFs.deletePath(liveProfiles)
      if (SnapshotFs.exists(liveProfiles)) {
        // 删不净（deletePath 逐项容错）→ 不能 move 到非空目标。
        // 改名只动父目录项、不递归子项，是此处最后可用的手段。
        SnapshotFs.move(liveProfiles, File(filesDir, liveProfiles.name + ".failed-" + System.currentTimeMillis()))
      }
      SnapshotFs.move(previousProfiles, liveProfiles)
    } catch (compensation: Throwable) {
      // 原始异常优先：补偿失败仅作 suppressed 附注，绝不取代真因。
      original.addSuppressed(compensation)
    }
    return original
  }

  /** 深拷贝（不跟随 symlink；目标已存在内容以源为准）。失败即抛，由调用方回滚。 */
  private fun copyRecursivelyStrict(source: File, destination: File) {
    val attrs = Files.readAttributes(
      source.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS,
    )
    if (attrs.isSymbolicLink) return // 链接属运行时残渣，与 replaceEntry 的 NOFOLLOW 语义一致：不复制
    if (attrs.isDirectory) {
      SnapshotFs.createDirectories(destination)
      for (child in source.listFiles() ?: emptyArray()) copyRecursivelyStrict(child, File(destination, child.name))
    } else if (attrs.isRegularFile) {
      Files.copy(
        source.toPath(), destination.toPath(),
        REPLACE_EXISTING, COPY_ATTRIBUTES,
      )
    }
  }

  /**
   * 递归合并：staged 权威 + live-only 不动；**只有 [userFacingFiles]（profile 根清单）走特殊合并**。
   *
   * 边界（0.14.0 P0）：node_modules 子树下的 package.json 与 cordis.patch.yml 是**工厂件**，
   * 必须整体覆盖。旧实现按文件名递归套用并集/按 id 合并，只保住 live 的 dependencies 与
   * bundles，工厂新增的 exports/version/main/bin 等字段全部丢失——live 树变成「旧清单 + 新文件」
   * 的混合体（实测：@dsh-android/dsh-android-file-open 的 live manifest 缺 "./route-auth"，
   * 而快照 tar 内有 → ERR_PACKAGE_PATH_NOT_EXPORTED，引擎起不来）。
   */
  private fun mergeTree(
    staged: File,
    live: File,
    notes: MutableList<String>,
    userFacingFiles: Set<String>,
  ) {
    val attrs = Files.readAttributes(
      staged.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS,
    )
    when {
      attrs.isSymbolicLink -> return
      attrs.isDirectory -> {
        SnapshotFs.createDirectories(live)
        for (child in staged.listFiles() ?: emptyArray()) {
          mergeTree(child, File(live, child.name), notes, userFacingFiles)
        }
      }
      attrs.isRegularFile -> when {
        staged.absolutePath in userFacingFiles && staged.name == "package.json" -> mergePackageJson(staged, live)
        staged.absolutePath in userFacingFiles && staged.name == "cordis.patch.yml" -> mergePatchYamlById(staged, live, notes)
        else -> Files.copy(
          staged.toPath(), live.toPath(),
          REPLACE_EXISTING, COPY_ATTRIBUTES,
        )
      }
    }
  }

  /**
   * package.json 并集：live 为基座（用户 pin 权威），工厂新增的 dependencies 键与
   * dsh.profile.bundles 条目补入；同名冲突保留 live。JSON 解析失败按原样保留 live（宁缺毋滥）。
   */
  private fun mergePackageJson(staged: File, live: File) {
    val liveText = if (SnapshotFs.exists(live)) live.readText() else ""
    val stagedText = try { staged.readText() } catch (_: Throwable) { return }
    if (liveText.isBlank()) {
      // live 缺失（部分新装）：直接落工厂件
      Files.copy(
        staged.toPath(), live.toPath(),
        REPLACE_EXISTING, COPY_ATTRIBUTES,
      )
      return
    }
    val user = try { org.json.JSONObject(liveText) } catch (_: Throwable) { return }
    val factory = try { org.json.JSONObject(stagedText) } catch (_: Throwable) { return }
    val factoryDeps = factory.optJSONObject("dependencies") ?: org.json.JSONObject()
    if (factoryDeps.length() > 0) {
      val deps = user.optJSONObject("dependencies") ?: org.json.JSONObject().also { user.put("dependencies", it) }
      for (key in factoryDeps.keys()) if (!deps.has(key)) deps.put(key, factoryDeps.getString(key))
    }
    // bundles 并集（兼容两种键形态）：真实出厂清单写的是**嵌套** dsh.profile.bundles
    // （scripts/lib/profile-seed.mjs:38-42；设备实测同一形态），而旧实现只读扁键
    // "dsh.profile.bundles" ⇒ 真机恒不命中，bundles 并集静默失效（工厂新增 bundle 进不了 live）。
    val factoryBundles = findBundles(factory)
    if (factoryBundles != null && factoryBundles.length() > 0) {
      val bundles = findBundles(user)
        ?: createBundles(user, nested = nestedBundles(factory) || user.optJSONObject("dsh") != null)
      val present = (0 until bundles.length()).map { bundles.optString(it) }.toHashSet()
      for (i in 0 until factoryBundles.length()) {
        val item = factoryBundles.optString(i)
        if (item.isNotEmpty() && item !in present) bundles.put(item)
      }
    }
    live.writeText(user.toString(2))
  }

  /** 读 bundles：先历史扁键，再真实嵌套 dsh.profile.bundles。 */
  private fun findBundles(root: org.json.JSONObject): org.json.JSONArray? =
    root.optJSONArray("dsh.profile.bundles")
      ?: root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles")

  /** 该清单的 bundles 是否为嵌套形态（而非历史扁键）。 */
  private fun nestedBundles(root: org.json.JSONObject): Boolean =
    root.optJSONArray("dsh.profile.bundles") == null &&
      root.optJSONObject("dsh")?.optJSONObject("profile")?.optJSONArray("bundles") != null

  /** 按 [nested] 新建 bundles 数组（live 缺该键时用工厂/live 的实际形态，避免写进引擎不读的扁键）。 */
  private fun createBundles(root: org.json.JSONObject, nested: Boolean): org.json.JSONArray {
    if (!nested) return org.json.JSONArray().also { root.put("dsh.profile.bundles", it) }
    val dsh = root.optJSONObject("dsh") ?: org.json.JSONObject().also { root.put("dsh", it) }
    val profile = dsh.optJSONObject("profile") ?: org.json.JSONObject().also { dsh.put("profile", it) }
    return org.json.JSONArray().also { profile.put("bundles", it) }
  }

  /**
   * cordis.patch.yml 合并：#214 起改由 [FactoryProfilePatch.merge] 执行——工厂对同 id 的
   * `disabled` 语义权威（纠正旧版遗留的 disable 漂移），用户独有条目保留，工厂新增块照旧追加。
   * 文本层实现（壳侧无 YAML 依赖），纠正说明写入 [notes] 供调用方留日志。
   */
  private fun mergePatchYamlById(staged: File, live: File, notes: MutableList<String>) {
    val liveText = if (SnapshotFs.exists(live)) live.readText() else ""
    val stagedText = try { staged.readText() } catch (_: Throwable) { return }
    val result = FactoryProfilePatch.merge(liveText, stagedText)
    if (result.text == liveText) return
    live.writeText(result.text)
    for (change in result.changes) notes += live.parentFile?.name + "/" + live.name + ": " + change
  }

  /**
   * Resolves an interrupted transaction.
   *
   * review C13（2026-09-14）：提交只认 `phase == SWAPPED` 哨兵。旧实现把「指纹已等于目标」也当
   * 提交证据——同版本重解压时指纹在交换**开始之前**就等于目标，交换中途被杀会被误判前滚，
   * 而 live 可能只换了一半（缺 usr / profiles 未合并）。SWAPPING 一律回滚，由调用方在
   * 下一次启动重新走完整刷新（指纹文件与树的短暂不一致由完整刷新收敛）。
   */
  fun recover(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
  ): Recovery {
    val marker = readMarker(filesDir) ?: return Recovery(Outcome.NONE)
    if (marker.phase == Phase.STAGED) {
      SnapshotFs.deletePath(stagedRoot)
      SnapshotFs.deletePath(previousRoot(filesDir))
      clearMarker(filesDir)
      return Recovery(Outcome.DISCARDED_STAGE)
    }
    if (marker.phase == Phase.SWAPPED) {
      return Recovery(Outcome.ROLLED_FORWARD, marker.fingerprint.ifEmpty { null })
    }
    val result = rollback(filesDir, stagedRoot, usrDir, homeDir, marker)
    if (!result.ok) {
      // 【D-3 / 审查 §7.7.5】回滚失败**不得无条件清 marker**。
      //
      // 旧实现无论回滚成败都 `clearMarker()`：于是半成品树被当成「已恢复」长期使用——
      // 列表在、能力不在（用户实报的「插件注册了但不真实可用」正是这一步的产物）。
      // 保留 marker 的语义 = 「这棵树还没收敛」，下次启动先重试回滚；同时把失败明细交回调用方，
      // 由它在 boot-fail.log 里落结构化字段（recovery=rollback_failed + 失败条目）。
      return Recovery(Outcome.ROLLBACK_FAILED, null, result.failures)
    }
    clearMarker(filesDir)
    return Recovery(Outcome.ROLLED_BACK)
  }

  /**
   * Undoes an interrupted swap; leaves the marker in place (the caller clears it **only on success**).
   *
   * 逐条容错（D-3）：单条失败不再让整次回滚伪装成功——失败的条目名被收集起来交回调用方，
   * 调用方据此保留 marker（下次启动重试）并把明细落进 boot-fail.log。
   */
  fun rollback(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
    marker: Marker,
  ): RollbackResult {
    val previous = previousRoot(filesDir)
    val names = LinkedHashSet<String>()
    names += marker.moved
    // An entry displaced by the first half of a rename pair is journaled, but an
    // entry whose journal write itself was lost is still discoverable here.
    collectDisplacedNames(previous, names)
    val failures = mutableListOf<String>()
    for (name in names.toList().asReversed()) {
      try {
        rollbackEntry(stagedRoot, name, usrDir, homeDir, previous)
      } catch (t: Throwable) {
        // 单条失败：记账后继续恢复其余条目（一条坏条目不该让整棵树停在半成品）。
        failures += name + " (" + t.javaClass.simpleName + ")"
      }
    }
    // 只有整次回滚成功才清残渣：失败时 previous 仍是唯一回滚源，删了就再也回不去。
    return if (failures.isEmpty()) {
      SnapshotFs.deletePath(previous)
      SnapshotFs.deletePath(stagedRoot)
      RollbackResult(true, emptyList())
    } else {
      RollbackResult(false, failures)
    }
  }

  private fun replaceEntry(
    filesDir: File,
    moved: MutableList<String>,
    fingerprint: String,
    startedAt: Long,
    journalName: String,
    staged: File,
    live: File,
    previous: File,
    onEntry: (String) -> Unit,
  ) {
    SnapshotFs.createDirectories(live.parentFile ?: filesDir)
    SnapshotFs.createDirectories(previous.parentFile ?: filesDir)
    // Journal first: if the process dies between the two renames the recovery
    // path still knows this entry was in flight.
    moved += journalName
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt, moved.toList()))
    if (SnapshotFs.exists(live)) {
      SnapshotFs.deletePath(previous)
      SnapshotFs.move(live, previous)
    }
    try {
      SnapshotFs.move(staged, live)
    } catch (t: Throwable) {
      if (SnapshotFs.exists(previous) && !SnapshotFs.exists(live)) {
        try {
          SnapshotFs.move(previous, live)
        } catch (_: Throwable) {
          // The original failure stays authoritative; recovery will retry from the marker.
        }
      }
      throw t
    }
    onEntry(journalName)
  }

  private fun rollbackEntry(stagedRoot: File, name: String, usrDir: File, homeDir: File, previous: File) {
    val staged = File(stagedRoot, name)
    val live = livePath(name, usrDir, homeDir)
    val displaced = File(previous, name)
    if (SnapshotFs.exists(displaced)) {
      // 【0.14.1 升级路径 P0，与 mergeProfiles 补偿同源】`SnapshotFs.deletePath` 是**逐项容错**的：
      // 它可能正常返回而 `live` **仍非空**（删不掉的子项只记 onFailure 后继续）。随后
      // `move(displaced, live)` 就会抛 `FileSystemException: … Directory not empty`。
      // 设备实测（16384）：正是这条路径让 rollback 永远失败 → 「rollback failed; recovery marker
      // retained」→ marker 永久停留、每次启动重试、每次同样失败，live 插件树停在 1/10。
      // 修法同 mergeProfiles 的补偿：删不净时把 live **改名挪开**（只动父目录项），再放回 displaced。
      SnapshotFs.deletePath(live)
      if (SnapshotFs.exists(live)) {
        SnapshotFs.move(live, File(live.parentFile, live.name + ".failed-" + System.currentTimeMillis()))
      }
      SnapshotFs.move(displaced, live)
    } else if (!SnapshotFs.exists(staged) && SnapshotFs.exists(live)) {
      // No displaced copy and the staged entry is gone: it was newly installed.
      SnapshotFs.deletePath(live)
    }
  }

  private fun collectDisplacedNames(previous: File, out: MutableSet<String>) {
    if (SnapshotFs.exists(File(previous, "usr"))) out += "usr"
    val previousHome = File(previous, "home")
    if (!SnapshotFs.exists(previousHome)) return
    for (entry in previousHome.listFiles() ?: emptyArray()) {
      if (entry.name == ".dsh") {
        for (child in entry.listFiles() ?: emptyArray()) {
          // review C4：`.copying` 是未完成的备份残渣（不完整），绝不参与回滚/恢复。
          if (child.name.endsWith(".copying")) continue
          out += "home/.dsh/" + child.name
        }
      } else {
        out += "home/" + entry.name
      }
    }
  }

  private fun livePath(name: String, usrDir: File, homeDir: File): File = when {
    name == "usr" -> usrDir
    name.startsWith("home/") -> File(homeDir, name.removePrefix("home/"))
    else -> File(usrDir.parentFile, name)
  }

  private fun render(marker: Marker): String = buildString {
    append("phase=").append(marker.phase.name).append('\n')
    append("fingerprint=").append(marker.fingerprint).append('\n')
    append("started=").append(marker.startedAt).append('\n')
    for (entry in marker.moved) append("moved=").append(entry).append('\n')
  }
}
