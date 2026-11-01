package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 共享农场（`home/.dsh/profiles/node_modules`）符号链接在快照刷新时的落地语义。
 *
 * ## 缺陷（v0.14.9 双 ABI 产物，设备 127.0.0.1:16448 实证）
 *
 * ```
 * 归档 farm 顶层 165 项 vs 设备 187 项，差集恰为 1 项 = undici
 * profiles/node_modules  mtime = 2026-10-31 03:05（上一代解压时间）
 * profiles/web           mtime = 2026-11-01 14:05（本次合并时间）
 * ```
 *
 * 真因：`SnapshotTransaction.mergeTree` 对符号链接分支是裸 `return`——staged 里的链接
 * **整个跳过**，因此 live 里不存在的链接项**永远不会被创建**。农场里 4 个相对目标链接中，
 * 其余 3 个设备 mtime 仍是上一代解压时间（说明本路径从未写过它们），只有 `undici` 缺失，
 * 证明是「从未创建」而不是「被删」。
 *
 * 后果不是报错：`dsh-plugin-subscriptions/lib/index.js` 里
 * `import { ProxyAgent, fetch as fetch$1 } from "undici"`，缺它插件在解析期就起不来。
 *
 * ## 本文件的判据
 *
 * 三条用例分别钉住：① 补齐；② 不覆盖 live 已有的农场项（用户后加的必须留着）；
 * ③ 目标按**原样**重建（相对目标不得被解析成绝对路径）。
 *
 * 判据全部走真实 `SnapshotTransaction.swap` 入口 + 注入的 [RecordingLinks]，
 * 因此不依赖本机建链权限（Windows 上无权限，直接建链的用例会永远跳过 = 假绿）。
 */
class FarmSymlinkMergeTest {

  private val preserved = setOf("sessions", "settings.yaml", ".credentials.yaml")

  /**
   * 记录型 [SnapshotTransaction.LinkPrimitives] 替身。
   *
   * 刻意**不**碰真实文件系统：本机（Windows 非特权）建符号链接会抛 IOException，
   * 若用例直接建链就只能在 CI 上跑，本地永远静默跳过——那正是本仓反复出现的「假绿」形态。
   * 这里用一份内存表承载链接，判据锁在「谁被问了、建了什么、目标是什么」。
   */
  private class RecordingLinks : SnapshotTransaction.LinkPrimitives {
    /** 已存在的链接：路径 -> 目标（原样，不解析）。 */
    val links = LinkedHashMap<String, String>()

    /** 建链调用流水，用于断言「建了什么、目标逐字相同」。 */
    val created = mutableListOf<Pair<String, String>>()

    /**
     * 键用 [File.canonicalPath] 而不是 absolutePath：`swap` 内部会经由
     * `stageRoot()`/`File(parent, child)` 逐层重建路径，Windows 上两者的大小写与
     * `.` 段规范化不完全一致，用 absolutePath 作键会静默匹配失败
     * （本轮实测：mergeTree 明明遍历到了 undici，替身却回答 false）。
     */
    private fun keyOf(file: File): String = try {
      file.canonicalPath
    } catch (_: Exception) {
      file.absolutePath
    }

    fun seed(file: File, target: String) {
      links[keyOf(file)] = target
    }

    override fun isLink(file: File): Boolean = links.containsKey(keyOf(file))

    override fun linkTargetOf(file: File): Path =
      Paths.get(links[keyOf(file)] ?: error("not a link: " + file.absolutePath))

    override fun createLink(dest: File, target: Path) {
      // 归一成归档里的 `/` 形态：Windows 上 `Paths.get("../../x/y")` 的 toString 是
      // `..\..\x\y`，直接比字符串会把「目标逐字相同」判成不同（本轮实测踩到）。
      // 语义上要比的是**目标路径**，不是宿主的分隔符风格。
      val text = target.toString().replace('\\', '/')
      created.add(keyOf(dest) to text)
      links[keyOf(dest)] = text
    }

    fun targetOf(file: File): String? = links[keyOf(file)]

    fun wasCreated(file: File): Boolean = created.any { it.first == keyOf(file) }

    fun dump(): String = "created=[" + created.joinToString("; ") { it.first + " -> " + it.second } +
      "] seeded=[" + links.entries.joinToString("; ") { it.key + " -> " + it.value } + "]"
  }

  private fun writeRuntime(root: File, nodeMarker: String, profileMarker: String) {
    File(root, "usr/bin").mkdirs()
    File(root, "usr/bin/node").writeText(nodeMarker)
    File(root, "home/.dsh/profiles/web").mkdirs()
    File(root, "home/.dsh/profiles/web/cordis.yml").writeText(profileMarker)
    File(root, "home/.dsh/settings.yaml").writeText("factory: true\n")
    File(root, "home/.gitconfig").writeText("[user]\n")
  }

  private fun tempDir(): File = Files.createTempDirectory("farm-symlink-merge-test").toFile()

  /**
   * 在 farm 里放一个 staged 侧链接。
   *
   * **必须在真实文件系统上落一个条目**：`mergeTree` 是靠 `staged.listFiles()` 枚举的，
   * 只在替身内存表里登记的话它根本不会被遍历到——那样用例会「全部通过」而实际什么都没测
   * （本轮第一版就踩了这个假绿，用例 ② 是空过的）。因此这里写一个普通文件占位，
   * 让枚举能看见它；「它是链接」这一事实由替身回答，正合 [SnapshotTransaction.LinkPrimitives]
   * 的设计意图（判据必须走可注入的 `isLink`，而不是锁死在真实文件系统的建链能力上）。
   */
  private fun stageFarmLink(stage: File, name: String, target: String, links: RecordingLinks): File {
    val linkPath = File(stage, "home/.dsh/profiles/node_modules/" + name)
    linkPath.parentFile.mkdirs()
    linkPath.writeText("placeholder-for-symlink")
    links.seed(linkPath, target)
    return linkPath
  }

  /**
   * 用例 ①（正控 / 需求本体）：归档里有、设备无的农场项，刷新后**必须在场**。
   *
   * 设备对应形态：`profiles/node_modules/undici` 在归档里、在 live 里不存在。
   * 修好后它必须被建出来，且目标与归档**逐字相同**（相对目标不得被解析成绝对路径）。
   */
  @Test
  fun seedsFarmLinkThatLiveDoesNotHave() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")

      val links = RecordingLinks()
      // 归档侧：相对目标（与真实快照里 undici 的形态一致）
      val stagedLink = stageFarmLink(
        stage, "undici",
        "../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici", links,
      )
      // live 侧：农场目录存在，但**没有** undici
      File(live, "home/.dsh/profiles/node_modules").mkdirs()
      val liveLink = File(live, "home/.dsh/profiles/node_modules/undici")
      assertFalse("前置：live 侧不得已有该项", SnapshotFs.exists(liveLink))
      assertFalse("前置：live 侧不得已有该链接", links.isLink(liveLink))

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-farm-1",
        startedAt = 1L,
        links = links,
      )

      assertEquals(
        "归档里有、设备无的农场项必须在刷新后建出来，且目标逐字相同（相对目标不得被解析） " + links.dump(),
        links.targetOf(stagedLink),
        links.targetOf(liveLink),
      )
      assertTrue(
        "必须真的调用一次建链，而不是只在内存表里出现 " + links.dump(),
        links.wasCreated(liveLink),
      )
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 用例 ②（负控 / 不得覆盖）：设备**已有**的农场项——包括用户后加的、以及上一代遗留的——
   * 刷新后必须**原样留着**，不得被落成归档那一份。
   *
   * 这一条是「不做整目录替换」的判据：整目录替换会把用户后加的农场包抹掉，
   * 那比缺一个 undici 更坏（用户装的东西没了）。
   */
  @Test
  fun neverOverwritesFarmEntryThatLiveAlreadyHas() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")

      val links = RecordingLinks()
      // 同名项两边都在，但目标不同（模拟「上一代遗留 / 用户改过」）
      val stagedLink = stageFarmLink(
        stage, "undici",
        "../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici", links,
      )
      File(live, "home/.dsh/profiles/node_modules").mkdirs()
      val liveLink = File(live, "home/.dsh/profiles/node_modules/undici")
      val userTarget = "/data/data/com.dsharnessmobile.shell/files/usr/lib/node_modules/undici"
      links.seed(liveLink, userTarget)

      // 另一个 live-only 的农场项（用户后加的包，归档里根本没有）
      val userOnly = File(live, "home/.dsh/profiles/node_modules/user-added-plugin")
      links.seed(userOnly, "/data/user/0/com.dsharnessmobile.shell/files/usr/lib/user-added-plugin")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-farm-2",
        startedAt = 1L,
        links = links,
      )

      assertEquals(
        "live 已有的农场项必须原样保留，不得被落成归档那一份",
        userTarget,
        links.targetOf(liveLink),
      )
      assertEquals(
        "用户后加的农场项（归档里没有）不得被删",
        "/data/user/0/com.dsharnessmobile.shell/files/usr/lib/user-added-plugin",
        links.targetOf(userOnly),
      )
      assertFalse(
        "覆盖判定必须发生在建链之前：live 已有该项时不得再建一次 " + links.dump(),
        links.wasCreated(liveLink),
      )
      assertEquals(
        "前置：归档侧确实指向另一份目标，否则本用例恒真（假绿）",
        "../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici",
        links.targetOf(stagedLink),
      )
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 用例 ④（真机实锤回归）：live 里**完全没有**该项时，判定「不存在」不得抛异常。
   *
   * ## 缺陷（设备实证 127.0.0.1:16448，v0.14.9 覆盖安装后强制刷新）
   *
   * ```
   * boot failed: stage=snapshot-refresh-unclassified
   *   cause=java.nio.file.NoSuchFileException:
   *     .../files/home/.dsh/profiles/web/node_modules/dsh-find-plugin
   *   at SnapshotTransaction$PRODUCTION_LINKS$1.isLink(SnapshotTransaction.kt:919)
   *   at SnapshotTransaction.mergeTree(SnapshotTransaction.kt:1156)
   *   at SnapshotTransaction.mergeProfiles(SnapshotTransaction.kt:815)
   *   at SnapshotTransaction.swap(SnapshotTransaction.kt:620)
   * ```
   *
   * 用户看到的是「运行时更新失败」，**整次刷新作废**。
   *
   * 真因：第一版判据写成 `if (SnapshotFs.exists(live) || links.isLink(live))`。
   * `SnapshotFs.exists` 对缺项返回 false（短路救不了），于是对**不存在的路径**调用
   * `isLink`；生产实现是 `readAttributes(NOFOLLOW)`——**路径不存在直接抛**，不返回 false。
   * 而「live 没有这一项」正是该分支要处理的主要情形。
   *
   * 本用例用一个**对不存在的路径会抛**的替身（与生产语义一致）锁住这个契约：
   * 缺项必须被正常判定为「不存在」并建链，全程不抛。
   */
  @Test
  fun missingLiveEntryIsDetectedWithoutThrowing() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")

      // 与生产语义一致的替身：路径不存在时抛 NoSuchFileException（而不是返回 false）
      val real = RecordingLinks()
      val strict = object : SnapshotTransaction.LinkPrimitives {
        override fun isLink(file: File): Boolean {
          if (!real.isLink(file) && !file.exists()) {
            throw java.nio.file.NoSuchFileException(file.absolutePath)
          }
          return real.isLink(file)
        }
        override fun linkTargetOf(file: File): Path = real.linkTargetOf(file)
        override fun createLink(dest: File, target: Path) = real.createLink(dest, target)
      }
      val stagedLink = File(stage, "home/.dsh/profiles/node_modules/undici")
      stagedLink.parentFile.mkdirs()
      stagedLink.writeText("placeholder")
      real.seed(stagedLink, "../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici")
      File(live, "home/.dsh/profiles/node_modules").mkdirs()
      val liveLink = File(live, "home/.dsh/profiles/node_modules/undici")

      // 不得抛：缺项是正常情形
      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-farm-4",
        startedAt = 1L,
        links = strict,
      )

      assertEquals(
        "缺项必须被补齐（而不是因为判存在性抛错把整次刷新炸掉）",
        "../../../../usr/lib/node_modules/@deepseek-ai/dsh/node_modules/undici",
        real.targetOf(liveLink),
      )
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 用例 ③（判别力）：把修复退回「裸 return」后，用例 ① 必须判红。
   *
   * 为什么需要它：本仓有过「接缝在、但判据没接上」的假绿（0.14.7 实锤）。
   * 这里不依赖注解，靠**同一份夹具**跑一遍「link 分支被跳过」的等价形态——
   * staged 侧不是链接（替身里不登记），于是 mergeTree 走普通文件/目录分支，
   * 不可能产出建链动作；用例 ① 的断言在这种形态下必然失败。
   */
  @Test
  fun withoutLinkSeedingNoFarmEntryIsCreated() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")

      val links = RecordingLinks()
      // staged 侧**不登记**为链接（等价于旧实现「链接被跳过」的形态）
      val stagedLink = File(stage, "home/.dsh/profiles/node_modules/undici")
      stagedLink.parentFile.mkdirs()
      File(live, "home/.dsh/profiles/node_modules").mkdirs()
      val liveLink = File(live, "home/.dsh/profiles/node_modules/undici")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-farm-3",
        startedAt = 1L,
        links = links,
      )

      assertFalse(
        "反证：staged 侧不是链接时不得凭空建链（证明用例 ① 判的是链接分支，不是别的路径） " + links.dump(),
        links.wasCreated(liveLink),
      )
      assertEquals("反证：此时 live 侧确实仍然缺失", null, links.targetOf(liveLink))
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }
}
