package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture

/**
 * Shizuku-only focused text wiring guards.
 *
 * The bit-1 capability must come from the remote service's measured answer, a node-targeted setText
 * stays on accessibility, and an unconfirmed Binder reply must never be reported as a success.
 */
class NativeShizukuTextTest {
  private var now = 1_000L
  private val facts = NativeShizukuFacts(clock = { now })

  private fun healthy(generation: Long = 1): LinkToken {
    val token = facts.tokenAt(generation)
    facts.onLink(token, true, true)
    facts.onGranted(token, true)
    facts.onBound(token, true)
    facts.onProbe(token, true, now)
    facts.onServerUid(token, 2000)
    return token
  }

  private fun ops(): Set<String> {
    val set = facts.snapshot().getJSONObject("supportedOps")
    if (set.getString("state") != "known") return emptySet()
    val array = set.getJSONArray("ops")
    return (0 until array.length()).map { array.getString(it) }.toSet()
  }

  @Test fun textCapabilityIsNotInferredFromReadinessOrTap() {
    val token = healthy()
    assertEquals("没有实测 bit1 时不得声称 setText", emptySet<String>(), ops())
    assertFalse(facts.permitsRealText(token))

    facts.onRealTapCapability(token, true)
    assertTrue("既有 bit0 点按仍放行", facts.permitsRealTap(token))
    assertFalse("点按能力不能冒充文本能力", facts.permitsRealText(token))
    assertEquals(setOf("click"), ops())
  }

  @Test fun textCapabilityAloneAdvertisesTextWithoutTap() {
    val token = healthy()
    facts.onRealTextCapability(token, true)
    assertTrue(facts.permitsRealText(token))
    assertEquals(setOf("setText"), ops())
    assertEquals(setOf("0"), facts.snapshot().getJSONObject("displaySupport")
      .getJSONObject("values").keys().asSequence().toSet())
    assertFalse("文本能力不能推导出点按能力", facts.permitsRealTap(token))
  }

  @Test fun bothCapabilitiesCoexistAndEachCanBeWithdrawn() {
    val token = healthy()
    facts.onRealTapCapability(token, true)
    facts.onRealTextCapability(token, true)
    assertEquals(setOf("click", "setText"), ops())

    facts.onRealTextCapability(token, false)
    assertEquals("远端实测 no 后文本能力必须立即收回", setOf("click"), ops())
    assertFalse(facts.permitsRealText(token))
  }

  @Test fun textCapabilityRequiresShell2000SameConnectionAndLiveTtl() {
    val token = healthy()
    facts.onRealTextCapability(token, true)
    facts.onServerUid(token, 0)
    assertFalse("root0 不是本特性的执行身份", facts.permitsRealText(token))
    facts.onServerUid(token, 2000)
    assertTrue(facts.permitsRealText(token))

    facts.onBound(token, false)
    facts.onBound(token, true)
    assertFalse("同代断连后旧观测作废", facts.permitsRealText(token))

    now += NativeShizukuFacts.DEFAULT_TTL_MS + 1
    assertFalse("过期即未知", facts.permitsRealText(token))
    assertEquals(emptySet<String>(), ops())
  }

  @Test fun staleTextObservationDoesNotOverrideNewerOne() {
    val token = healthy()
    val older = token
    now += 5
    val newer = facts.tokenAt(1)
    facts.onRealTextCapability(newer, false)
    facts.onRealTextCapability(older, true)
    assertFalse("迟到成功不得盖掉较新的否定观测", facts.permitsRealText(newer))
  }

  private inner class Adapter {
    var a11yImplemented = false
    val execution = NativeShizukuExecution(object : NativeControlDispatcher.Platform {
      override fun implements(plan: JSONObject) = a11yImplemented
      override fun execute(callId: String, plan: JSONObject, args: JSONObject,
        refreshFacts: () -> Boolean, authorize: () -> Boolean) =
        CompletableFuture.completedFuture(JSONObject().put("executed", "yes"))
    })
    fun plan(operation: String, screenId: String = "real", nodeTarget: Boolean = false): JSONObject =
      JSONObject().put("backend", "shizuku").put("operation", operation)
        .put("screenId", screenId).put("displayId", 0)
        .also { if (nodeTarget) it.put("nodeTarget", JSONObject().put("windowId", 3).put("path", "0/1")) }
  }

  @Test fun onlyRealDisplayZeroWithoutNodeTargetIsThisAdapter() {
    val adapter = Adapter()
    assertTrue(adapter.execution.implements(adapter.plan("setText")))
    assertTrue(adapter.execution.implements(adapter.plan("click")))
    assertFalse("nodeTarget 的 setText 归无障碍", adapter.execution.implements(adapter.plan("setText", nodeTarget = true)))
    assertFalse("只接 display 0", adapter.execution.implements(
      JSONObject(adapter.plan("setText").toString()).put("displayId", 2)))
    assertFalse("只接真实屏", adapter.execution.implements(adapter.plan("setText", screenId = "vd1")))
    assertTrue(adapter.execution.implements(adapter.plan("scroll")))
  }

  @Test fun nodeTargetedTextIsRejectedBeforeAnyDispatch() {
    val adapter = Adapter()
    val receipt = adapter.execution.execute("text-1", adapter.plan("setText", nodeTarget = true),
      JSONObject().put("text", "中文").put("clear", true), { true }, { true }).get()
    assertEquals("platform-adapter-unavailable", receipt.getString("code"))
    assertEquals("no", receipt.getString("executed"))
  }

  @Test fun oversizedTextIsRejectedWithoutDispatch() {
    val adapter = Adapter()
    val receipt = adapter.execution.execute("text-2", adapter.plan("setText"),
      JSONObject().put("text", "x".repeat(8193)).put("clear", true), { true }, { true }).get()
    assertEquals("invalid-text", receipt.getString("code"))
    assertEquals("no", receipt.getString("executed"))
  }

}
