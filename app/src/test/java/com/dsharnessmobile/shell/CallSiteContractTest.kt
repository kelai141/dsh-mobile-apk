package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 调用点契约回归（与仓内 grep 门禁同思路）：#210.5 / #211.3 / ST-01 / ST-02 的缺陷形态
 * 都是「调用点被漏掉或仍在主线程」，纯 JVM 行为测试覆盖不到（需要 Activity/Context）。
 * 这里直接对壳侧源码断言调用点与真源表达式，撤掉修复即变红。
 */
class CallSiteContractTest {

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（形态名出现在注释里不算命中——与门禁只看代码的口径一致）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /** 取一个成员体的文本：从签名起，到下一个同级成员声明为止。 */
  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 " + signature)
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  /** ST-01：onResume 必须重写门1 的 KEY_FULLACCESS（系统设置改权限后的同步路径）。 */
  @Test
  fun onResumeSyncsFullAccess() {
    val onResume = memberBody(codeOnly(source("MainActivity.kt")), "override fun onResume()")
    assertTrue(
      "ST-01：onResume 必须调一次 AdbState.syncFullAccess（否则授予/撤销权限后判定值陈旧）",
      onResume.contains("AdbState.syncFullAccess(this)"),
    )
  }

  /** FX-210.5：onResume 不得同步跑网络探测；探活必须经后台入口。 */
  @Test
  fun onResumeDoesNotProbeTheEngineOnTheMainThread() {
    val onResume = memberBody(codeOnly(source("MainActivity.kt")), "override fun onResume()")
    assertFalse("FX-210.5：onResume 不得同步 EngineProbe.check", onResume.contains("EngineProbe.check("))
    assertTrue("FX-210.5：onResume 的探活必须走后台入口", onResume.contains("probeEngineOffMainThread"))
    assertFalse(
      "旧的主线程合取写法必须消失",
      onResume.contains("webView.visibility != View.VISIBLE && !EngineProbe.check()"),
    )
  }

  /** FX-210.5：onCreate 路径（configureWebView）不得同步 refresh cookie。 */
  @Test
  fun configureWebViewDoesNotRefreshTheCookieOnTheMainThread() {
    val configure = memberBody(codeOnly(source("MainActivity.kt")), "private fun configureWebView()")
    assertTrue("FX-210.5：初始化只允许零网络的本地 cookie", configure.contains("EngineAuth.cookie(this)"))
    val beforeRefresh = configure.substringBefore("EngineAuth.refresh(this)")
    assertTrue("FX-210.5：refresh 只允许出现在后台线程块内", beforeRefresh.contains("Thread {"))
  }

  /** ST-02：开关真源 = 偏好 && 系统权限 && 服务实例在场。 */
  @Test
  fun overlayEnabledMergesPreferencePermissionAndServiceInstance() {
    val body = memberBody(codeOnly(source("OverlayController.kt")), "fun isEnabled(context: Context): Boolean")
    assertTrue("ST-02：必须读偏好", body.contains("enabledPref(context)"))
    assertTrue("ST-02：必须活体查系统权限", body.contains("canDrawOverlays(context)"))
    assertTrue("ST-02：必须要求服务实例在场", body.contains("OverlayService.instance"))
  }

  /** ST-02：权限缺失必须回落偏好（保证 onResume 不再弹页）。 */
  @Test
  fun overlayPermissionLossRollsBackThePreference() {
    val ensure = memberBody(codeOnly(source("OverlayController.kt")), "fun ensureStarted(context: Context): Boolean")
    assertTrue("ST-02：权限缺失必须写入 enabled=false", ensure.contains("putBoolean(KEY_ENABLED, false)"))
    assertTrue("ST-02：权限缺失必须停服务", ensure.contains("stop(context)"))
    assertTrue("ST-02：权限在场才启服务", ensure.contains("startService"))
  }

  /** FX-208.3 / FX-211.3：logcat 管道不得裸读（无上限、无超时）。 */
  @Test
  fun logcatReadGoesThroughBoundedProcIo() {
    val code = codeOnly(source("LogCollector.kt"))
    assertFalse("不得裸读 logcat 管道（门禁新增形态）", code.contains(".bufferedReader().readText()"))
    assertFalse("不得无界 readBytes", code.contains("readBytes()"))
    assertTrue("logcat 读取必须经 ProcIo.readBounded", code.contains("ProcIo.readBounded(proc, 10)"))
  }

  /** FX-211.1：ProcIo 必须给出超时/截断标记（只区分 null/非 null 不解决问题，E-1）。 */
  @Test
  fun procIoKeepsThreeDistinctStates() {
    val code = codeOnly(source("ProcIo.kt"))
    assertTrue("超时标记常量", code.contains("TIMEOUT_FLAG"))
    assertTrue("exit 阶段标记", code.contains("exitTimedOut"))
    assertTrue("drain 阶段标记", code.contains("drainTimedOut"))
    assertTrue("截断标记", code.contains("TRUNCATED_FLAG"))
  }

  /** FX-210.1：启动前置必须把恢复入口与探活顺序固化在可断言的位置。 */
  @Test
  fun startFlowUsesTheRecoveryPrelude() {
    val code = codeOnly(source("EngineStartFlow.kt"))
    assertTrue(
      "FX-210.1：Activity 启动路径必须经 startupRecoverThenProbe（恢复先于探活早退）",
      code.contains("startupRecoverThenProbe("),
    )
    val body = code.substringAfter("internal fun startupRecoverThenProbe(").substringAfter("): Boolean {")
    assertTrue("FX-210.1：函数体必须先 recover 再 probe", body.trimStart().startsWith("recover()"))
  }

  /** FX-210.1：服务路径（EngineService）也要前置恢复入口。 */
  @Test
  fun engineServiceAlsoRunsTheRecoveryPrelude() {
    val code = codeOnly(source("EngineService.kt"))
    val ensureEngine = memberBody(code, "private fun ensureEngine()")
    val recoverAt = ensureEngine.indexOf("recoverInterruptedRefresh()")
    val watchdogAt = ensureEngine.indexOf("WatchdogV2.acquireWakeLock")
    assertTrue("FX-210.1：服务路径必须调恢复入口", recoverAt >= 0)
    assertTrue("FX-210.1：恢复必须先于看门狗装配", watchdogAt < 0 || recoverAt < watchdogAt)
  }
}
