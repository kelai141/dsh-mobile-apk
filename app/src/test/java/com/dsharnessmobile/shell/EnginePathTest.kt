package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 引擎/控制台 PATH 的拼接契约（`<usr>/bin:/system/bin[:<profile>/node_modules/.bin]`）。
 *
 * 为什么需要这组判据：用户装的插件可以带自己的可执行文件。实测
 * `@deepseek-ai/dsh-subagent-codex@0.2.1-rc.3` 的 dependencies 里直接有 `@openai/codex`，
 * pnpm 会在 profile 的 `node_modules/.bin` 落下 `codex` 软链——但旧 PATH 只有
 * `<files>/usr/bin:/system/bin`，于是「插件装好了、二进制也在设备上」，bash 里敲 `codex`
 * 仍然 `command not found`（emulator-5566 实测：`.bin/codex` 存在且可执行，`which codex` 退出 1）。
 *
 * 判据分两半，缺一不可：
 *  - **值这一半**（本文件）：拼接内容与顺序；
 *  - **注入这一半**（[W3ShellContractTest.shellEnvInjectsTheProfileBinDir]）：真的接进了 `shellEnv()`。
 *    只锁值的话，函数写得再对，引擎进程也拿不到这条 PATH。
 *
 * 分隔符注意：期望值一律按**生产同一表达式**构造（`usr.absolutePath + "/bin"`），
 * 不用 `File(usr, "bin").absolutePath`——后者在 Windows 上给出反斜杠，会造出
 * 「期望 `…\usr\bin` / 实际 `…\usr/bin`」的假红（本仓 pnpmStoreDir 用例踩过同款坑）。
 */
class EnginePathTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private fun usr(): File = File(tmp.root, "usr").apply { mkdirs() }

  /** 装过插件的现场：profile 下确实有 `node_modules/.bin` 目录。 */
  private fun profileBin(): File =
    File(File(File(tmp.root, "home/.dsh/profiles/web"), "node_modules"), ".bin").apply { mkdirs() }

  /** 生产口径的 PATH 工厂前缀（与 [enginePath] 内部同一表达式，避免平台分隔符假红）。 */
  private fun factoryPrefix(usr: File): String = usr.absolutePath + "/bin:/system/bin"

  @Test
  fun appendsTheProfileBinDirAtTheEnd() {
    val usr = usr()
    val bin = profileBin()
    val path = enginePath(usr, bin)
    assertEquals(
      "PATH = 工厂 bin + /system/bin + profile 的 node_modules/.bin（末尾追加）",
      factoryPrefix(usr) + ":" + bin.absolutePath,
      path,
    )
    assertTrue("PATH 尾部必须就是该目录", path.endsWith(":" + bin.absolutePath))
    // 末尾追加的**顺序**判据：profile bin 必须排在 /system/bin 之后（用户包不得抢在系统前面）。
    assertTrue(
      "profile bin 必须排在 /system/bin 之后",
      path.indexOf(bin.absolutePath) > path.indexOf("/system/bin"),
    )
  }

  @Test
  fun factoryBinStaysFirst() {
    // 用户包不得遮盖工厂工具链：顺序错了这条必红——遮盖的后果不是「某个命令找不到」，
    // 而是整台设备的 node/bash 被换成用户包里的那一份。
    val usr = usr()
    val bin = profileBin()
    val path = enginePath(usr, bin)
    assertTrue("PATH 必须以 <usr>/bin 开头", path.startsWith(factoryPrefix(usr)))
    // 顺序判据用「前缀之后剩下的整段」表达，不按冒号切：Windows 盘符本身带冒号，
    // 切分会造出与语义无关的假红（本仓已踩过同款坑）。
    assertEquals(
      "工厂前缀之后只允许一处追加，且必须正好是 profile bin",
      ":" + bin.absolutePath,
      path.removePrefix(factoryPrefix(usr)),
    )
  }

  @Test
  fun skipsTheProfileBinDirWhenItDoesNotExist() {
    // 没装过任何插件时不得产生一条指向空目录的 PATH 项：那会让诊断日志里出现一条
    // 「看起来配好了、其实什么都没有」的路径，掩盖真因。
    val usr = usr()
    val absent = File(tmp.root, "home/.dsh/profiles/web/node_modules/.bin")
    assertFalse("前提：该目录确实不存在", absent.exists())
    assertEquals(
      "目录不存在时 PATH 保持原样",
      factoryPrefix(usr),
      enginePath(usr, absent),
    )
    assertEquals(
      "null 时同样保持原样",
      factoryPrefix(usr),
      enginePath(usr, null),
    )
  }

  @Test
  fun neverUsesAHardcodedProfileName() {
    // profile 名只能来自壳侧唯一真源（PluginMounts.PROFILE）；这里断言「拼接函数只吃入参」——
    // 哪天有人图省事把 "profiles/web" 写进来，换 profile 时就会出现「引擎跑 A、PATH 指向 B」的静默错配。
    val usr = usr()
    val bin = profileBin()
    assertTrue("目录来自入参", enginePath(usr, bin).endsWith(bin.absolutePath))
    val other = File(tmp.root, "other-profile/node_modules/.bin").apply { mkdirs() }
    assertTrue("换入参必须换输出（不是把某个常量路径拼死在里面）", enginePath(usr, other).endsWith(other.absolutePath))
    assertFalse("不得出现 web profile 的字面量", enginePath(usr, other).contains("profiles/web"))
  }
}
