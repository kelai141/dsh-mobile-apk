package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 自动回滚**目标选择**的回归（2026-09-21，dsh-mobile#238 同轮设备实证）。
 *
 * 为什么需要本文件：0.14.1 之前，UndoGate 把回滚目标完全交给急救 CLI 的 `restore-last-good`，
 * 而它的判据是插件自报的 `boot-state.json.lastGoodAt`——**插件 apply 阶段/30s 定时就会写 ok**，
 * 不代表引擎整体起来了。2026-09-21 设备实测（注入一个坏插件 + 挂载项，然后杀引擎）：
 *   ① 引擎起不来，但 boot-state 仍写 `ok:true`、`lastGoodAt` 前移到这次崩溃的启动；
 *   ② `restore-last-good` 于是选中**含坏配置的那份快照**（快照是在插件挂载时就建的），
 *      把坏配置原样写回，日志却是 `executed ok`；
 *   ③ 结果：坏插件仍被挂载、引擎仍不可达——**回滚报成功而状态没变好**。
 *
 * 修法（本文件守护的不变量）：「已知良好」只能由**壳侧自己的健康观测**定义（引擎 HTTP 活着的那一拍），
 * 本轮实现将该回退路径移除：只有 ID 可用且属于本次安装时才恢复，否则 fail closed。
 */
class UndoGateKnownGoodTest {

  private fun shellSource(name: String): String {
    val f = listOf(
      "src/main/java/com/dsharnessmobile/shell/" + name,
      "app/src/main/java/com/dsharnessmobile/shell/" + name,
    ).map { File(it) }.firstOrNull { it.isFile } ?: throw AssertionError("找不到 $name")
    return f.readText().lineSequence()
      .filterNot { val t = it.trimStart(); t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") }
      .joinToString("\n")
  }

  @Test
  fun 最新快照id必须是纯时间戳形状且取最大() {
    val names = listOf(
      "boot-state.json", "env-vault", ".tmp-1234",
      "20260920-235635-524b", "20260921-001349-13de", "20260920-081902-9171",
    )
    // 字典序 = 时间序；状态文件与临时名不得被当成快照 id（否则会把 boot-state.json 传给 CLI restore）。
    assertEquals("20260921-001349-13de", UndoGate.newestSnapshotId(names))
    assertNull("空目录必须返回 null；调用方不得退回 CLI last-good", UndoGate.newestSnapshotId(emptyList()))
    assertNull(
      "非快照形状一个都不认",
      UndoGate.newestSnapshotId(listOf("boot-state.json", "env-vault", "2026-09-20", "2026092-1", "manual")),
    )
    assertEquals(
      "只有一份快照时就是它",
      "20260920-235635-524b",
      UndoGate.newestSnapshotId(listOf("20260920-235635-524b", "boot-state.json")),
    )
  }

  @Test
  fun 回滚必须只用本次安装建立的已知良好快照() {
    // 跨版本护栏：stored(旧安装) 与 current(本次安装) 指纹不同 ⇒ 绝不写回（否则新代码 + 旧配置的混合态）。
    assertEquals("同版本且指纹一致 ⇒ 返回快照 id", "20260920-235635-524b", UndoGate.knownGoodUsable("20260920-235635-524b", "fp1", "fp1"))
    assertNull("跨版本必须拒绝（用户追问的「救旧插件却把新版本改动回退掉」）",
      UndoGate.knownGoodUsable("20260920-235635-524b", "fp-old", "fp-new"))
    assertNull("记录缺指纹必须拒绝（归属不明）", UndoGate.knownGoodUsable("20260920-235635-524b", null, "fp1"))
    assertNull("记录缺指纹必须拒绝（空串）", UndoGate.knownGoodUsable("20260920-235635-524b", "", "fp1"))
    assertNull("当前安装指纹缺失时必须拒绝", UndoGate.knownGoodUsable("20260920-235635-524b", "fp1", null))
    assertNull("无记录必须拒绝", UndoGate.knownGoodUsable(null, null, "fp1"))
    assertNull("id 为空必须拒绝", UndoGate.knownGoodUsable("", "fp1", "fp1"))
  }

  @Test
  fun 先外科拔除_整份回滚只在清单没变时才允许() {
    // 用户 2026-09-21 拍板的清单式：坏插件**只拔它一个**；整份回滚会把「最后一次健康启动之后
    // 用户装的插件」全抹掉，故只有在「挂载清单没变过」（故障与插件无关）时才允许。
    val code = shellSource("UndoGate.kt")
    val pullAt = code.indexOf("PluginMounts.pull(context, patch, failed)")
    val restoreAt = code.indexOf("listOf(\"restore\", known)")
    assertTrue("必须存在外科拔除调用", pullAt > 0)
    assertTrue("整份回滚必须排在外科拔除之后", pullAt < restoreAt)
    assertTrue("失败插件必须按权威Hard exact id/name清单判归属", code.contains("!hard.owns(failed.id, failed.name)"))
    assertTrue("清单变了又点不出名时不得回滚", code.contains("aborted mount-changed-and-unattributed") &&
      code.contains("PluginMounts.mountUnchangedSinceHealthy(context, patch)"))
    assertTrue("拔不动的名单要落探针（不许静默）", code.contains("pull failed (block not located) plugin="))
    // 两份清单必须在「壳侧确认健康」那一拍维护
    assertTrue("硬清单按当前安装指纹选择", code.contains("PluginMounts.ensureHard(context, installFingerprint(context))"))
    assertTrue("软清单按spawn与完整健康证据推进", code.contains("PluginMounts.noteHealthy(context, patch, launchId, complete)"))
  }

  @Test
  fun 回滚接线必须以已知良好为唯一目标() {
    val code = shellSource("UndoGate.kt")
    // ① 目标是 known-good（restore <id>），且选目标前核对它还在（快照会被 prune）
    assertTrue("必须 restore 已知良好 id", code.contains("runCli(context, engine, cli, dsh, listOf(\"restore\", known))"))
    assertTrue("必须核对快照仍在", code.contains("if (!snapshotExists(context, engine, known))"))
    // ② **不得**再退回 CLI 的 last-good（设备实测它会把含坏配置/上一次安装的快照写回）
    assertFalse("不得再调用 restore-last-good", code.contains("listOf(\"restore-last-good\")"))
    assertTrue("不可用时必须明写「不自动回滚」并留下指纹对照",
      code.contains("aborted no-known-good-for-this-install stored=") && code.contains("knownGoodUsable(knownGoodId(context), knownGoodFp(context), installFingerprint(context))"))
    // ③ 已知良好记录必须带安装指纹（否则无法判跨版本）
    assertTrue("记录必须两行：id + 指纹", code.contains("knownGoodFile(context).writeText(id + \"\\n\" + fp + \"\\n\")"))
    // ④ 自动 undo 已退役：看门狗不再记录 known-good，手动恢复仍读取历史记录。
    val svc = shellSource("EngineService.kt")
    assertFalse("看门狗不得继续写自动 undo 的健康记录", svc.contains("UndoGate.noteHealthy(this, engineManager)"))
  }

  @Test
  fun noKnownGoodStillHasExplicitConsoleRecoveryWithoutAutomaticFallback() {
    val manager = shellSource("EngineManager.kt")
    val startFlow = shellSource("EngineStartFlow.kt")
    val session = shellSource("ConsoleSession.kt")
    val guide = shellSource("GuidePageRenderer.kt")
    val cli = File("src/main/assets/undo-emergency.mjs").takeIf { it.isFile }
      ?: File("app/src/main/assets/undo-emergency.mjs")

    assertFalse("自动 undo 退役后启动流不得继续部署或调用急救链", startFlow.contains("engineManager.deployUndoCli()"))
    assertTrue("CLI 部署到壳可读的 filesDir", manager.contains("File(context.filesDir, asset)"))
    assertTrue("控制台继承 shellEnv", session.contains("environment().putAll(engineManager.shellEnv())"))
    assertTrue("shellEnv 为控制台提供 app-private 根目录", manager.contains("\"DSH_FILES_DIR\" to context.filesDir.absolutePath"))
    assertTrue("错误页仍可打开离线控制台", guide.contains("onOpenConsole = { activity.startActivity(Intent(activity, ConsoleActivity::class.java)) }"))
    val emergencyCli = cli.readText()
    assertTrue("CLI 支持列出可选快照", emergencyCli.contains("case 'list':"))
    assertTrue("CLI 支持按显式 ID 恢复", emergencyCli.contains("case 'restore':"))
    assertTrue("手动 CLI 恢复不改变自动 fail-closed 判据", shellSource("UndoGate.kt").contains("listOf(\"restore\", known)"))
    assertFalse("自救说明不能把 last-good 引回自动路径", shellSource("UndoGate.kt").contains("listOf(\"restore-last-good\")"))
  }
}
