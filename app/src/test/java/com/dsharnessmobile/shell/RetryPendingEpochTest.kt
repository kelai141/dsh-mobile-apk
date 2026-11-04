package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1356 回归：陈旧的重试 runnable 不得跨世代清掉 `retryPending`。
 *
 * 缺陷形态：`postDelayed` 的回调里先 `RepairState.retryPending = false`、后判世代——陈旧回调
 * 执行时会把**新一代**的闩清掉（新一代正在等自己的重试窗口），期间看门狗会去重启引擎。
 */
class RetryPendingEpochTest {

  @Test
  fun `先判世代再清闩`() {
    val src = File(File("src/main/java/com/dsharnessmobile/shell"), "EngineStartFlow.kt").readText()
    val start = src.indexOf("engineMonitorHandler.postDelayed({")
    assertTrue("找不到重试 runnable", start > 0)
    val body = src.substring(start, start + 600)
    val guard = body.indexOf("if (!isCurrentEngineFlow(generation)) return@postDelayed")
    val clear = body.indexOf("RepairState.retryPending = false")
    assertTrue("回调里必须有世代守卫", guard > 0)
    assertTrue("retryPending 的清闩点必须存在", clear > 0)
    assertTrue("世代守卫必须先于清闩（否则陈旧回调会清掉新一代的闩）", guard < clear)
  }
}
