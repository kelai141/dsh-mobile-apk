package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #579 台账「换源/更新链 + 渲染重连」批次（2026-10-25）的源码形状锁。
 *
 * 这些修复都在 Android 专有面上（Context / ServiceConnection / 网络栈），JVM 可直接
 * 反证的行为面只有 [ApkUpdateRegressTest] 覆盖的两条（#12 busy、#10 重定向白名单）；
 * 其余按仓内既有惯例（A11yHeartbeatCadenceTest 等）锁源码形状，防回归。
 */
class AuditLedgerSourceTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell/$name"),
      File("app/src/main/java/com/dsharnessmobile/shell/$name"),
    )
    return candidates.firstOrNull { it.isFile }?.readText() ?: error("source file not found: $name")
  }

  /** #8：换源备份必须**每次**刷新到当前源（旧 `!backup.isFile` 守卫造成第二次回滚到出厂源）。 */
  @Test
  fun `8-SourceSettings 备份无条件刷新到当前源`() {
    val text = source("SourceSettings.kt")
    val switchAt = text.indexOf("fun switchTo(")
    assertTrue(switchAt >= 0)
    // 只检查 switchTo 区间：restoreBackup 里 `!backup.isFile` 是合法的无备份早退，不在本缺陷面。
    val switchBody = text.substring(switchAt, text.indexOf("fun replaySelection(", switchAt))
    assertTrue("switchTo 内旧守卫不得复燃：!backup.isFile 已删除", !switchBody.contains("!backup.isFile"))
    val at = switchBody.indexOf("backup.writeText(target.readText())")
    assertTrue("备份写点必须在场（锚点漂移需同步本测试）", at >= 0)
    val before = switchBody.substring((at - 200).coerceAtLeast(0), at)
    assertTrue("备份写点必须由 hadPrevious 守卫（不是备份缺席守卫）", before.contains("if (hadPrevious)"))
  }

  /** #11：换源入口必须先过快照刷新在飞守卫（三真源：进程 CAS×2 + 跨进程 journal）。 */
  @Test
  fun `11-SourceSettings 换源前查快照刷新在飞`() {
    val text = source("SourceSettings.kt")
    val switch = text.indexOf("fun switchTo(")
    assertTrue(switch >= 0)
    val head = text.substring(switch, switch + 900)
    assertTrue("switchTo 头部必须查刷新 CAS", head.contains("EngineManager.snapshotRefreshing.get()"))
    assertTrue("还须查在线更新 CAS", head.contains("EngineManager.onlineUpdateActive.get()"))
    assertTrue("还须查跨进程事务 journal", head.contains("SnapshotTransaction.readMarker(context.filesDir)"))
  }

  /** #9：迟到线程按会话代次作废——回写点全部带代次守卫；非属主终态作废在途。 */
  @Test
  fun `9-ApkUpdateAction 迟到回写按代次作废`() {
    val text = source("ApkUpdateAction.kt")
    assertTrue("runCheck 回写前必须判代次", text.contains("if (!isCurrentEpoch(e)) return"))
    assertTrue("进度回调必须带代次守卫（不得喂新一轮的 percent）", text.contains("{ pct -> onDownloadProgress(pct, e) }"))
    val failAt = text.indexOf("private fun fail(")
    assertTrue("fail() 定义必须在场（锚点漂移需同步本测试）", failAt >= 0)
    assertTrue("非属主终态必须作废在途回写", text.indexOf("invalidateInFlight()", failAt) in failAt..(failAt + 400))
  }

  /** #13：断线→重连事件对（rendererConnected 播报 + 宿主清降级 + 兜底重绑）。 */
  @Test
  fun `13-渲染断线重连有出路`() {
    val host = source("RemoteRendererHost.kt")
    assertTrue("重连时必须播报 rendererConnected", host.contains("rendererConnected"))
    assertTrue("重连前必须先解绑旧连接（防 double-bind 泄漏）", host.contains("unbindService(stale)"))
    val browser = source("BrowserHost.kt")
    assertTrue("宿主必须消费 rendererConnected 清降级标记", browser.contains("rendererConnected"))
    assertTrue("断线时必须有兜底重绑（OEM 不自动重启的场景）", browser.contains("postDelayed"))
  }
}
