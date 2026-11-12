package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CompletableFuture

class NativeControlDispatcherTest {
  private fun json(text: String) = JSONObject(text)
  private fun request() = json("""{"protocolVersion":1,"method":"execute","callId":"click-1","epoch":"18446744073709551615","operation":"click","screenId":"real","generation":"7","args":{"x":20,"y":30}}""")

  private inner class Fixture {
    val calls = mutableListOf<String>()
    var replay = false
    var valid = true
    var supported = true
    var sdkCalls = 0
    var skipGate = false
    var throwAfterGate = false
    var secondGate: Boolean? = null
    val plan = JSONObject("""{"backend":"a11y","operation":"click","screenId":"real","displayId":0,"width":720,"height":1600,"epoch":"18446744073709551615","generation":"7"}""")
    val core = NativeControlDispatcher.Core { req ->
      val kind = req.getString("kind")
      calls.add(kind)
      when (kind) {
        "publishFacts" -> JSONObject().put("ok", true)
        "prepare" -> if (replay) JSONObject("""{"ok":true,"code":"clicked","executed":"yes","replayed":true}""")
          else JSONObject().put("ok", true).put("code", "prepared").put("plan", plan)
        "commit" -> JSONObject().put("dispatch", "permitted").put("plan", plan)
        // ok=false is intentional: only valid+dispatch carry execution authority.
        "validateDispatch" -> JSONObject().put("ok", false).put("valid", valid)
          .put("dispatch", if (valid) "permitted" else "forbidden")
          .also { if (!valid) it.put("settleHint", JSONObject("""{"ok":false,"code":"scope-generation-mismatch","executed":"no","screenId":"real"}""")) }
        "settle" -> req.getJSONObject("receipt")
        "cancel" -> JSONObject("""{"ok":true,"executed":"no","code":"withdrawn-before-dispatch"}""")
        else -> error("Unexpected exchange $kind")
      }
    }
    val platform = object : NativeControlDispatcher.Platform {
      override fun implements(plan: JSONObject) = supported
      override fun execute(plan: JSONObject, args: JSONObject, authorize: () -> Boolean): CompletableFuture<JSONObject> {
        if (!skipGate && !authorize()) return CompletableFuture.completedFuture(JSONObject("""{"ok":false,"code":"authorize-denied","executed":"no"}"""))
        sdkCalls++
        if (throwAfterGate) throw IllegalStateException("lost callback")
        if (!skipGate) secondGate = authorize()
        return CompletableFuture.completedFuture(JSONObject("""{"ok":true,"code":"clicked","executed":"yes"}"""))
      }
    }
    val dispatcher = NativeControlDispatcher(core, { JSONObject() }, platform)
    fun run() = dispatcher.handle(request(), NativeControlSocketServer.Cancellation())
  }

  @Test fun durableCommitPrecedesTheFinalGuardAndSdk() {
    val f = Fixture()
    val result = f.run()
    assertEquals("yes", result.getString("executed"))
    assertEquals("real", result.getString("screenId"))
    assertEquals(listOf("publishFacts", "prepare", "publishFacts", "commit", "publishFacts", "validateDispatch", "settle"), f.calls)
    assertEquals(1, f.sdkCalls)
    assertEquals(false, f.secondGate)
  }

  @Test fun terminalReplayNeverTouchesPlatform() {
    val f = Fixture().apply { replay = true }
    assertTrue(f.run().getBoolean("replayed"))
    assertEquals(0, f.sdkCalls)
    assertEquals(listOf("publishFacts", "prepare"), f.calls)
  }

  @Test fun revokedPlanStopsBeforeAndroidAndSettlesNo() {
    val f = Fixture().apply { valid = false }
    val result = f.run()
    assertEquals("scope-generation-mismatch", result.getString("code"))
    assertEquals("no", result.getString("executed"))
    assertEquals(0, f.sdkCalls)
  }

  @Test fun exceptionAfterSdkCannotBecomeNotExecuted() {
    val f = Fixture().apply { throwAfterGate = true }
    assertEquals("unknown", f.run().getString("executed"))
    assertEquals(1, f.sdkCalls)
    assertFalse(f.calls.contains("fallback"))
  }

  @Test fun missingAdapterWithdrawsBeforeCommit() {
    val f = Fixture().apply { supported = false }
    assertEquals("platform-adapter-unavailable", f.run().getString("code"))
    assertEquals(listOf("publishFacts", "prepare", "cancel"), f.calls)
    assertEquals(0, f.sdkCalls)
  }

  @Test fun adapterCannotClaimSuccessWithoutFinalAuthorization() {
    val f = Fixture().apply { skipGate = true }
    assertEquals("unknown", f.run().getString("executed"))
    assertEquals("settle", f.calls.last())
  }

  @Test fun cancellationBeforeAdmissionMakesNoCoreOrSdkCall() {
    val f = Fixture()
    val cancellation = NativeControlSocketServer.Cancellation().also { it.cancel() }
    assertEquals("no", f.dispatcher.handle(request(), cancellation).getString("executed"))
    assertTrue(f.calls.isEmpty())
    assertEquals(0, f.sdkCalls)
  }
}
