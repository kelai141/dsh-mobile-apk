package com.dsharnessmobile.shell

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #921：刷新失败的真因码不得被兜底值吞掉。
 *
 * 三条负控各自能红（逐一改回旧实现时分别变红）：
 *  1. 被包装的真因码必须解包保留 —— 旧实现 `as?` 直接拿到 null，真码丢失；
 *  2. 真的没有码时：`code` 为 null **且** 「未归类」为 true —— 少任何一半都不合格；
 *  3. 真因码与「未归类」渲染必须**不同** —— 旧实现两者都落到同一个 snapshot-refresh-failed。
 */
class RefreshFailureCodeTest {
  private fun snap(code: String, msg: String = "x") = SnapshotFsException(code = code, message = msg)

  @Test
  fun wrappedTrueCauseCodeIsUnwrappedAndKept() {
    val inner = snap("disk-full")
    val wrapped = IOException("read failed", inner)
    assertSame(inner, EngineManager.findSnapshotFsException(wrapped))
    val state = EngineManager.refreshFailureState(wrapped)
    assertEquals("真因码必须保留", "disk-full", state.first)
    assertFalse("有真因码时不得标记未归类", state.second)
  }

  @Test
  fun codeWithNoCodeYieldsNullAndUnclassified() {
    val none = EngineManager.refreshFailureState(IllegalStateException("no code"))
    assertNull("无码时必须为 null，不得塞兜底值", none.first)
    assertTrue("无码时必须标记「未归类」", none.second)
    // 反向：有码的一条不得被这条断言顺带满足
    val real = EngineManager.refreshFailureState(snap("real-code"))
    assertEquals("real-code", real.first)
    assertFalse(real.second)
  }

  @Test
  fun realCodeAndUnclassifiedRenderDifferently() {
    val real = EngineManager.refreshFailureLabel("disk-full", unclassified = false)
    val unknown = EngineManager.refreshFailureLabel(null, unclassified = true)
    assertEquals("disk-full", real)
    assertEquals(EngineManager.CODE_REFRESH_UNCLASSIFIED, unknown)
    assertNotEquals("真因码与未归类必须渲染不同", real, unknown)
    assertNotEquals("未归类不得复用旧兜底值", "snapshot-refresh-failed", unknown)
    // 真因码恰好等于旧兜底值时，也必须与「未归类」可区分
    assertNotEquals(
      "真因码恰为旧兜底值时仍须与未归类不同",
      EngineManager.refreshFailureLabel("snapshot-refresh-failed", false),
      unknown,
    )
  }
}