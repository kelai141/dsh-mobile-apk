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
  const val MARKER_NAME = ".snapshot-transaction"
  private const val TMP_MARKER_NAME = ".snapshot-transaction.tmp"

  enum class Phase { STAGED, SWAPPING, SWAPPED }

  data class Marker(
    val phase: Phase,
    val fingerprint: String,
    val startedAt: Long,
    val moved: List<String> = emptyList(),
  )

  enum class Outcome { NONE, DISCARDED_STAGE, ROLLED_BACK, ROLLED_FORWARD }

  /** [fingerprintToCommit] is set when the swap completed but the commit write did not. */
  data class Recovery(val outcome: Outcome, val fingerprintToCommit: String? = null)

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

  /** Removes every artifact of a completed transaction. */
  fun finish(filesDir: File) {
    SnapshotFs.deletePath(previousRoot(filesDir))
    SnapshotFs.deletePath(stageRoot(filesDir))
    clearMarker(filesDir)
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
  ) {
    val stagedUsr = File(stagedRoot, "usr")
    if (!SnapshotFs.exists(stagedUsr)) throw IOException("staged runtime is missing usr/")
    val previous = previousRoot(filesDir)
    SnapshotFs.deletePath(previous)
    SnapshotFs.createDirectories(previous)
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt))
    val moved = mutableListOf<String>()

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
              mergeProfiles(filesDir, moved, fingerprint, startedAt, child, liveChild, File(previousDsh, "profiles"), onEntry)
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
   * 原子性：合并失去 rename 的事务性，因此先把 live profiles **整目录拷贝**（非
   * rename）到 previous，条目照常入 journal——失败/中断时 rollbackEntry 按既有
   * 「displaced 存在即恢复」语义整目录回滚。
   */
  private fun mergeProfiles(
    filesDir: File,
    moved: MutableList<String>,
    fingerprint: String,
    startedAt: Long,
    stagedProfiles: File,
    liveProfiles: File,
    previousProfiles: File,
    onEntry: (String) -> Unit,
  ) {
    // Journal + 整目录拷贝备份（拷贝失败即中止刷新——宁可不起树也不丢用户生态）
    moved += "home/.dsh/profiles"
    writeMarker(filesDir, Marker(Phase.SWAPPING, fingerprint, startedAt, moved.toList()))
    SnapshotFs.deletePath(previousProfiles)
    SnapshotFs.createDirectories(previousProfiles.parentFile ?: filesDir)
    copyRecursivelyStrict(liveProfiles, previousProfiles)
    try {
      mergeTree(stagedProfiles, liveProfiles)
      onEntry("home/.dsh/profiles (merged)")
    } catch (t: Throwable) {
      // 合并失败：整目录回滚到 live 原状，再把异常抛给调用方（中止启动，正常 recover）
      SnapshotFs.deletePath(liveProfiles)
      SnapshotFs.move(previousProfiles, liveProfiles)
      throw t
    }
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

  /** 递归合并：staged 权威 + package.json/cordis.patch.yml 特殊合并 + live-only 不动。 */
  private fun mergeTree(staged: File, live: File) {
    val attrs = Files.readAttributes(
      staged.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS,
    )
    when {
      attrs.isSymbolicLink -> return
      attrs.isDirectory -> {
        SnapshotFs.createDirectories(live)
        for (child in staged.listFiles() ?: emptyArray()) mergeTree(child, File(live, child.name))
      }
      attrs.isRegularFile -> when (staged.name) {
        "package.json" -> mergePackageJson(staged, live)
        "cordis.patch.yml" -> mergePatchYamlById(staged, live)
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
    val factoryBundles = factory.optJSONArray("dsh.profile.bundles")
    if (factoryBundles != null && factoryBundles.length() > 0) {
      val bundles = user.optJSONArray("dsh.profile.bundles") ?: org.json.JSONArray().also { user.put("dsh.profile.bundles", it) }
      val present = (0 until bundles.length()).map { bundles.optString(it) }.toHashSet()
      for (i in 0 until factoryBundles.length()) {
        val item = factoryBundles.optString(i)
        if (item.isNotEmpty() && item !in present) bundles.put(item)
      }
    }
    live.writeText(user.toString(2))
  }

  /**
   * cordis.patch.yml 按 id 合并：live 内容为基座（用户追加块与改写权威），把 live
   * 缺少 id 的工厂**顶层块**（连同其前导注释）追加到末尾。文本层实现（壳侧无 YAML 依赖）；
   * 工厂块解析失败时保守跳过该块，绝不破坏 live 内容。
   */
  private fun mergePatchYamlById(staged: File, live: File) {
    val liveText = if (SnapshotFs.exists(live)) live.readText() else ""
    val stagedText = try { staged.readText() } catch (_: Throwable) { return }
    val liveIds = Regex("""^\s*(?:-\s+)?id:\s*(\S+)""", RegexOption.MULTILINE)
      .findAll(liveText).mapTo(HashSet()) { it.groupValues[1] }
    if (liveIds.isEmpty() && liveText.isNotBlank()) return // live 结构未知：不追加，保守保 live
    val appended = StringBuilder()
    for (block in topLevelYamlBlocks(stagedText)) {
      val blockIds = Regex("""^\s*(?:-\s+)?id:\s*(\S+)""", RegexOption.MULTILINE)
        .findAll(block).map { it.groupValues[1] }.toList()
      if (blockIds.isEmpty()) continue
      if (blockIds.any { it in liveIds }) continue
      appended.append(block).append('\n')
    }
    if (appended.isNotEmpty()) {
      val separator = if (liveText.endsWith("\n") || liveText.isEmpty()) "" else "\n"
      live.writeText(liveText + separator + appended)
    }
  }

  /** 顶层 `- ` 列表块切分（含块前紧邻的注释/空行前导）；非列表行归入下一个块的前导。 */
  private fun topLevelYamlBlocks(text: String): List<String> {
    val blocks = mutableListOf<String>()
    val current = StringBuilder()
    for (line in text.lineSequence()) {
      val isTopItem = Regex("^- ").containsMatchIn(line)
      if (isTopItem) {
        if (current.isNotBlank()) blocks.add(current.toString())
        current.setLength(0)
      }
      current.append(line).append('\n')
    }
    if (current.isNotBlank()) blocks.add(current.toString())
    return blocks
  }

  /**
   * Resolves an interrupted transaction.
   *
   * [currentFingerprint] is the content of the live fingerprint file: when it
   * already equals the marker's target fingerprint the commit point was reached
   * before the crash, so the transaction rolls forward instead of undoing a
   * working runtime.
   */
  fun recover(
    filesDir: File,
    stagedRoot: File,
    usrDir: File,
    homeDir: File,
    currentFingerprint: String,
  ): Recovery {
    val marker = readMarker(filesDir) ?: return Recovery(Outcome.NONE)
    if (marker.phase == Phase.STAGED) {
      SnapshotFs.deletePath(stagedRoot)
      SnapshotFs.deletePath(previousRoot(filesDir))
      clearMarker(filesDir)
      return Recovery(Outcome.DISCARDED_STAGE)
    }
    val committed = marker.phase == Phase.SWAPPED ||
      (marker.fingerprint.isNotEmpty() && marker.fingerprint == currentFingerprint)
    if (committed) {
      return Recovery(Outcome.ROLLED_FORWARD, marker.fingerprint.ifEmpty { null })
    }
    rollback(filesDir, stagedRoot, usrDir, homeDir, marker)
    clearMarker(filesDir)
    return Recovery(Outcome.ROLLED_BACK)
  }

  /** Undoes an interrupted swap; leaves the marker in place (the caller clears it). */
  fun rollback(filesDir: File, stagedRoot: File, usrDir: File, homeDir: File, marker: Marker) {
    val previous = previousRoot(filesDir)
    val names = LinkedHashSet<String>()
    names += marker.moved
    // An entry displaced by the first half of a rename pair is journaled, but an
    // entry whose journal write itself was lost is still discoverable here.
    collectDisplacedNames(previous, names)
    for (name in names.toList().asReversed()) {
      rollbackEntry(stagedRoot, name, usrDir, homeDir, previous)
    }
    SnapshotFs.deletePath(previous)
    SnapshotFs.deletePath(stagedRoot)
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
      SnapshotFs.deletePath(live)
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
        for (child in entry.listFiles() ?: emptyArray()) out += "home/.dsh/" + child.name
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
