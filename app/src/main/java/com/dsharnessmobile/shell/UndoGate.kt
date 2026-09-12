package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * 崩溃自动回退（PRD F3 / D6 方案 a）：壳侧「undo 全自动」闸门。
 *
 * 职责：当引擎反复启动失败（看门狗连续失败达到阈值）或引擎日志出现崩溃签名时，
 * 自动执行 dsh-undo-emergency 急救 CLI 的 restore-last-good（把配置/插件代码树
 * 回滚到 boot-state.json 归因出的「最后良好快照」），并恢复引擎。
 *
 * 与 UpdateManager/EngineManager 的 usr 层回退（usr-old）正交：
 * - usr 层：运行时二进制回退（EngineManager.rollbackToOld）
 * - 本类：配置/插件代码回退（dsh-undo-savepoint 快照，F3 主引擎）
 *
 * 幂等约束：
 * - 每个「崩溃纪元」只自动执行一次（.undo-auto-done 标记 + 时间戳），
 *   用户手动重试/手动 undo 后清除标记；
 * - 仅在急救 CLI 存在快照时执行（list 非空）；
 * - 仅在引擎确实无法启动时触发（不误伤正常慢启动）。
 */
object UndoGate {

  private const val TAG = "dsh-undo"
  private val autoUndoRunning = java.util.concurrent.atomic.AtomicBoolean(false)

  /** 看门狗连续失败触发阈值（与 WatchdogV2.MAX_CONSEC_FAILURES 对齐但更保守：熔断即触发）。 */
  const val TRIGGER_CONSEC_FAILURES = 6

  /** 触发后到执行的静默期：留给引擎自己恢复的最后机会（正常慢启动上限 45s+）。 */
  const val WATCH_MS = 15_000L

  /** 崩溃纪元间隔：距上次自动 undo 完成 < 该间隔时不再自动执行（防循环）。 */
  const val RETRY_WINDOW_MS = 30 * 60 * 1000L

  /**
   * Records the first confirmed-dead observation, then grants exactly one caller
   * the right to execute after [WATCH_MS]. A healthy probe disarms the wait.
   */
  fun onProbeFailure(context: Context, consecutiveFailures: Int): Boolean {
    if (consecutiveFailures < TRIGGER_CONSEC_FAILURES) return false
    val now = System.currentTimeMillis()
    val last = lastUndoAt(context)
    if (last != null && now - last < RETRY_WINDOW_MS) {
      Log.i(TAG, "auto-undo suppressed: last undo at $last (within retry window)")
      return false
    }
    val armedAt = armFile(context).takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull()
    if (armedAt == null) {
      try {
        armFile(context).writeText(now.toString())
      } catch (t: Throwable) {
        Log.e(TAG, "auto-undo arm failed", t)
        return false
      }
      Log.i(TAG, "auto-undo armed at $now; waiting $WATCH_MS ms")
      return false
    }
    if (now - armedAt < WATCH_MS) {
      Log.i(TAG, "auto-undo delay: armed at $armedAt, waiting watch window")
      return false
    }
    return true
  }

  /**
   * 执行自动 undo（必须后台线程调用）：
   * 1. 急救 CLI restore-last-good（快照回滚）
   * 2. 写 .undo-auto-done 标记（幂等 + 供启动页显示）
   * 3. 返回是否执行了回滚（+ 摘要）
   */
  fun execute(context: Context, engine: EngineManager): UndoResult {
    if (!autoUndoRunning.compareAndSet(false, true)) return UndoResult(false, "自动回撤已在执行", null)
    try {
      val dsh = File(engine.homeDir, ".dsh")
      val cli = File(context.filesDir, "undo-emergency.mjs")
      if (!cli.exists()) {
        Log.e(TAG, "auto-undo aborted: emergency CLI not deployed at " + cli.absolutePath)
        return UndoResult(false, "急救 CLI 未部署", null)
      }
      // 先确认有快照（空库不执行，避免空转）
      val list = runCli(context, engine, cli, dsh, listOf("list"))
      // #211.1：CLI 超时 = 状态未知，绝不判「无快照可回滚」（旧实现两者同形，超时被静默误判为
      // 空库 → 自动回退从未执行）。此分支只是「不执行」并给出可区分的摘要，不吞掉区别。
      if (list.any { it.contains(ProcIo.TIMEOUT_FLAG) }) {
        Log.w(TAG, "auto-undo aborted: emergency CLI list timed out; snapshot state unknown")
        LogCollector.log(TAG, "auto-undo aborted: snapshot list timed out (" + ProcIo.TIMEOUT_FLAG + ")")
        return UndoResult(false, "急救 CLI 超时：快照清单状态未知（非「无快照可回滚」）", null)
      }
      if (!list.any { it.startsWith("2026") || it.startsWith("20") } && !list.any { it.contains("[auto]") }) {
        Log.i(TAG, "auto-undo skipped: no snapshots found")
        return UndoResult(false, "无快照可回滚", null)
      }
      val out = runCli(context, engine, cli, dsh, listOf("restore-last-good"))
      val ok = out.any { it.contains("完成：还原") }
      val summary = out.joinToString("\n")
      if (ok) {
        markerFile(context).writeText(System.currentTimeMillis().toString())
        LogCollector.log(TAG, "auto-undo executed: restore-last-good ok")
      } else {
        Log.e(TAG, "auto-undo failed: " + summary)
      }
      // 0.13.1 W3：急救触发即镜像现场到共享目录（引擎循环崩溃导致用户完全无法取日志的场景）。
      engine.mirrorDiagnosticsToShared("undo-gate")
      return UndoResult(ok, summary, if (ok) restoreTarget(out) else null)
    } finally {
      armFile(context).delete()
      autoUndoRunning.set(false)
    }
  }

  /** 从 CLI 输出提取恢复目标快照 id；解析失败返回 null（不阻断）。 */
  private fun restoreTarget(lines: List<String>): String? {
    val m = lines.firstOrNull { it.contains("恢复快照") }?.let { line ->
      Regex("恢复快照 (\\S+)").find(line)
    }
    return m?.groupValues?.get(1)
  }

  /** 运行急救 CLI（节点为快照内的 node，DSH_HOME 指向壳私有 .dsh）。 */
  private fun runCli(
    context: Context,
    engine: EngineManager,
    cli: File,
    dsh: File,
    args: List<String>,
  ): List<String> {
    return try {
      val cmd = listOf(
        engine.usrDir.absolutePath + "/bin/node",
        cli.absolutePath,
      ) + args
      // #118 根因2（2026-09）：直接 exec app-data ELF 在 Android 15+ 恒 Permission denied
      // （error=13），auto-undo 因此从未真正执行。与 EngineManager.startWithArgs 同款：
      // 捕获 Permission denied 后降级经 /system/bin/linker64 加载（系统库加载机制对
      // app 数据永远放行）。
      fun build(argv: List<String>): ProcessBuilder = ProcessBuilder(argv).apply {
        environment().putAll(engine.shellEnv())
        environment()["DSH_HOME"] = dsh.absolutePath
        environment()["DSH_UNDO_ROOT"] = File(dsh, "undo-snapshots").absolutePath
        environment()["DSH_UNDO_PROFILE"] = "web"
        // 2026-08-23 真机实测：快照 node 编译期 openssl.cnf 路径为 /data/data/com.termux/...（不可读），
        // 缺失该覆盖时 Node 启动致命退出（OpenSSL config error）→ CLI 无输出 → 误判「无快照可回滚」，
        // 自动回退从未执行。显式指向快照内真实 cnf（与 shellEnv 的 SSL_CERT_FILE 同域）。
        environment()["OPENSSL_CONF"] = File(engine.usrDir, "etc/tls/openssl.cnf").absolutePath
        redirectErrorStream(true)
      }
      var proc: Process
      try {
        proc = build(cmd).start()
      } catch (e: java.io.IOException) {
        if (e.message?.contains("Permission denied") != true) throw e
        Log.w(TAG, "direct exec denied, falling back to linker64: " + e.message)
        proc = build(listOf("/system/bin/linker64") + cmd).start()
      }
      // 0.13.8 #173：有界读——CLI 挂起曾令 60s 守卫失效，且 execute 的 autoUndoRunning
      // 只在 finally 复位 → 恒「已在执行」，连看门狗 DEAD 支的强制重启都被锁死。
      // 超时分支显式复位标志与 arm 文件（幂等，防御未来再引入无界读）。
      val r = ProcIo.readBounded(proc, 60)
      if (r.timedOut) {
        proc.destroyForcibly()
        try { armFile(context).delete() } catch (_: Throwable) {}
        autoUndoRunning.set(false)
        return listOf(r.timeoutText("emergency CLI timeout"))
      }
      r.text.lines()
    } catch (t: Throwable) {
      Log.e(TAG, "emergency CLI run failed", t)
      listOf("emergency CLI failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  /** Clears a pending observation window after the engine becomes reachable. */
  fun disarm(context: Context) {
    armFile(context).delete()
  }

  /** 清除自动 undo 标记（引擎健康确认/用户手动操作后调用）。 */
  fun clearMarker(context: Context) {
    markerFile(context).delete()
    armFile(context).delete()
  }

  fun armedToDisplay(context: Context): String? = armFile(context).takeIf { it.exists() }?.let {
    "auto-undo pending: " + it.readText()
  }

  private fun markerFile(context: Context) = File(context.filesDir, ".undo-auto-done")
  private fun armFile(context: Context) = File(context.filesDir, ".undo-auto-armed")

  /** 上次自动 undo 时间（毫秒）；从未执行返回 null。 */
  private fun lastUndoAt(context: Context): Long? =
    markerFile(context).takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull()

  data class UndoResult(val executed: Boolean, val summary: String, val snapshotId: String?)
}
