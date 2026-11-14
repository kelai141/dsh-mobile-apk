package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1744：白屏必须有**判据**，且判据不能把正常页面误判成白屏。
 *
 * 缺陷形态：壳侧唯一就绪真源是页面自报 `[dsh-boot-ready]`；拿不到时只写一条 shell-stall 诊断，
 * 不改相位、不盖视图、不弹错误页。而页面侧就绪判据只看 DOM，一个 client bundle entry 崩掉即整树
 * 卸载，且常一条 console 都不留。于是「引擎健康 + 页面白 + 零提示」是没有判据也没有出口的稳态。
 *
 * 判据取向：**行为断言**——直接跑状态转换，不信源码文本。
 * 删掉 BlankScreenGate 的阈值/粘滞/恢复逻辑，下列用例必须变红。
 */
class BlankScreenGateTest {

  // ── 判据 1：单拍空不算白屏（抖动不误报） ──────────────────────────────

  @Test
  fun singleBlankBeatIsOnlyObservationNotVerdict() {
    val gate = BlankScreenGate()
    assertEquals("第一拍空只能观察", BlankScreenGate.Verdict.OBSERVING, gate.beat(rootChildren = 0, textChars = 0))
    assertFalse("单拍空绝不判白屏", gate.blankReported)
    assertEquals("第二拍空仍是观察", BlankScreenGate.Verdict.OBSERVING, gate.beat(0, 0))
    assertFalse(gate.blankReported)
  }

  @Test
  fun consecutiveBlanksReachTheVerdictAtThreshold() {
    val gate = BlankScreenGate()
    gate.beat(0, 0)
    gate.beat(0, 0)
    assertEquals(
      "第三拍（= 阈值）必须判白屏",
      BlankScreenGate.Verdict.BLANK,
      gate.beat(0, 0),
    )
    assertTrue(gate.blankReported)
  }

  @Test
  fun aRenderedBeatResetsTheStreak() {
    val gate = BlankScreenGate()
    gate.beat(0, 0)
    gate.beat(0, 0)
    assertEquals("中间画出来了：计数清零", BlankScreenGate.Verdict.RENDERED, gate.beat(1, 0))
    // 再空两拍仍不足以判白——否则「闪一下就白」会被当成持续白屏。
    assertEquals(BlankScreenGate.Verdict.OBSERVING, gate.beat(0, 0))
    assertEquals(BlankScreenGate.Verdict.OBSERVING, gate.beat(0, 0))
    assertFalse(gate.blankReported)
  }

  // ── 判据 2：什么算「画出来了」 ────────────────────────────────────────

  @Test
  fun rootChildrenAloneCountAsRendered() {
    val gate = BlankScreenGate()
    // 骨架页面：有 #root 子节点但几乎没文本，仍是「画出来了」。
    assertEquals(BlankScreenGate.Verdict.RENDERED, gate.beat(rootChildren = 2, textChars = 3))
  }

  @Test
  fun enoughTextAloneCountsAsRenderedEvenWithoutRoot() {
    val gate = BlankScreenGate()
    // 某些页面把内容挂在 body 下、没有 #root。只看 root 会把它们永久判成白屏。
    assertEquals(
      BlankScreenGate.Verdict.RENDERED,
      gate.beat(rootChildren = -1, textChars = BlankScreenGate.BLANK_MIN_TEXT_CHARS),
    )
  }

  @Test
  fun tinyFrameworkTextIsNotContent() {
    val gate = BlankScreenGate()
    // 「加载中…」这类骨架文案（< 阈值）不得冒充内容，否则白屏永远判不出来。
    gate.beat(0, 0)
    gate.beat(0, 0)
    assertEquals(
      "骨架文案不算内容",
      BlankScreenGate.Verdict.BLANK,
      gate.beat(rootChildren = 0, textChars = BlankScreenGate.BLANK_MIN_TEXT_CHARS - 1),
    )
  }

  // ── 判据 3：粘滞与恢复（判过之后不重复动作，恢复后可再判） ──────────────

  @Test
  fun verdictIsStickyUntilThePageRenders() {
    val gate = BlankScreenGate()
    gate.beat(0, 0); gate.beat(0, 0); gate.beat(0, 0)
    // 已判白屏：后续空拍不得重复返回 BLANK（否则调用方每 10 秒重建一次页面）。
    assertEquals(BlankScreenGate.Verdict.BLANK_STICKY, gate.beat(0, 0))
    assertEquals(BlankScreenGate.Verdict.BLANK_STICKY, gate.beat(0, 0))
  }

  @Test
  fun aRenderedBeatAfterBlankLiftsTheStickyState() {
    val gate = BlankScreenGate()
    gate.beat(0, 0); gate.beat(0, 0); gate.beat(0, 0)
    assertTrue(gate.blankReported)
    assertEquals(BlankScreenGate.Verdict.RENDERED, gate.beat(1, 0))
    // 恢复后必须能重新判——否则一次白屏之后永久沉默，等于判据只生效一次。
    assertFalse(gate.blankReported)
    gate.beat(0, 0); gate.beat(0, 0)
    assertEquals(BlankScreenGate.Verdict.BLANK, gate.beat(0, 0))
  }

  @Test
  fun pageReadyReportClearsTheGate() {
    val gate = BlankScreenGate()
    gate.beat(0, 0); gate.beat(0, 0)
    gate.onPageReady()
    assertEquals("ready 是真值：计数必须清零", 0, gate.blankBeats)
    assertFalse(gate.blankReported)
  }

  // ── 判据 4：探针失败不等于白屏（那是冻结链的输入） ─────────────────────

  @Test
  fun probeFailureDoesNotCountAsBlank() {
    val gate = BlankScreenGate()
    // 渲染进程真死时 evaluateJavascript 会失败——那条路走 FreezeRecoveryGate，不在这里判。
    repeat(5) {
      assertEquals(
        "探针失败不得累加白屏计数",
        BlankScreenGate.Verdict.OBSERVING,
        gate.beat(0, 0, probeFailed = true),
      )
    }
    assertEquals(0, gate.blankBeats)
    assertFalse(gate.blankReported)
  }

  @Test
  fun probeFailureAfterVerdictKeepsStickyWithoutRecounting() {
    val gate = BlankScreenGate()
    gate.beat(0, 0); gate.beat(0, 0); gate.beat(0, 0)
    assertEquals(BlankScreenGate.Verdict.BLANK_STICKY, gate.beat(0, 0, probeFailed = true))
    assertTrue(gate.blankReported)
  }

  // ── 判据 5：探针回调解析（两层 JSON） ──────────────────────────────────

  @Test
  fun parsesTheDoubleEncodedCallbackPayload() {
    // evaluateJavascript 的回调是「脚本 return 的字符串」再 JSON 编码一次的结果。
    val raw = "\"{\\\"root\\\":3,\\\"text\\\":42,\\\"err\\\":\\\"\\\",\\\"bundle\\\":5}\""
    val probe = RenderProbe.parse(raw)
    assertFalse("必须解析成功：" + probe, probe.failed)
    assertEquals(3, probe.root)
    assertEquals(42, probe.text)
    assertEquals(5, probe.bundle)
  }

  @Test
  fun parsesAPlainJsonObjectCallbackToo() {
    val probe = RenderProbe.parse("{\"root\":0,\"text\":0,\"err\":\"boom\",\"bundle\":2}")
    assertFalse(probe.failed)
    assertEquals(0, probe.root)
    assertEquals("boom", probe.err)
  }

  @Test
  fun unparseableCallbackIsAFailureNotABlank() {
    // 关键方向：解不出来时**绝不能**当成 root=0（那会让坏探针永久判白屏）。
    for (raw in listOf(null, "", "null", "not json at all", "[1,2,3]")) {
      val probe = RenderProbe.parse(raw)
      assertTrue("解不出来必须标成 failed：raw=" + raw + " probe=" + probe, probe.failed)
    }
  }

  @Test
  fun probeScriptReturnsJsonStringNotAnObject() {
    // evaluateJavascript 的回调参数是 JSON 编码后的值；脚本必须自己 stringify，
    // 否则回调给的是 [object Object]，解析不出来（这条是那次返工的真因）。
    val script = BlankScreenGate.PROBE_SCRIPT
    assertTrue("探针必须自己 JSON.stringify", script.contains("JSON.stringify"))
    assertTrue("必须读 #root", script.contains("getElementById('root')"))
    assertTrue("必须带 bundle 计数（白屏取证用）", script.contains("/plugins/"))
    // 必须整体包在 try/catch 里：任何一处抛错都要能返回可解析的失败读数。
    assertTrue("探针必须有兜底 catch", script.contains("catch"))
  }
}
