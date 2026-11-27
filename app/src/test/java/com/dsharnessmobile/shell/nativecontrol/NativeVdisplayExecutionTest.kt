package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.atomic.AtomicInteger

/** Rust plan admission and target binding for the virtual-display adapter. */
class NativeVdisplayExecutionTest {
  private val a11y = object : NativeControlDispatcher.Platform {
    override fun implements(plan: JSONObject) = true
    override fun execute(callId: String, plan: JSONObject, args: JSONObject,
      refreshFacts: () -> Boolean, authorize: () -> Boolean) =
      CompletableFuture.completedFuture(JSONObject().put("executed", "yes"))
  }

  private var calls = mutableListOf<Pair<String, String>>()
  private var lastArgs: JSONObject? = null
  private var lastBackend: String? = null
  private var reply: (String, JSONObject, String) -> JSONObject = { op, _, alias ->
    JSONObject().put("ok", true).put("code", op + "-ok").put("screenId", alias)
  }
  private val context = null
  private val adapter = NativeVdisplayExecution({ context }, { _, op, args, screenId, backend, guard ->
    if (!guard()) JSONObject().put("ok", false).put("code", "authorize-denied").put("executed", "no")
    else {
      calls.add(op to screenId)
      lastArgs = args
      lastBackend = backend
      reply(op, args, screenId)
    }
  })

  private fun creation(alias: String = "virtual-1", args: JSONObject = JSONObject(), backend: String = "shizuku"): JSONObject =
    JSONObject().put("backend", backend).put("operation", "vdCreate").put("target", "virtualCreation")
      .put("screenId", alias).put("epoch", "3").put("args", args)

  private fun bound(operation: String, alias: String = "virtual-1", displayId: Int = 9,
    args: JSONObject = JSONObject(), backend: String = "shizuku"): JSONObject =
    JSONObject().put("backend", backend).put("operation", operation).put("target", "androidScreen")
      .put("screenId", alias).put("displayId", displayId).put("width", 480).put("height", 640)
      .put("epoch", "3").put("generation", "8").put("args", args)

  @Test fun onlyTheFiveRustVdOperationsBelongToThisAdapter() {
    for (operation in listOf("vdCreate", "vdDestroy", "vdLaunch", "vdLaunchApp")) {
      val plan = if (operation == "vdCreate") creation(args = JSONObject().put("width", 480).put("height", 640))
      else bound(operation, args = if (operation == "vdLaunchApp") JSONObject().put("pkg", "com.example.app") else JSONObject())
      assertTrue(operation, adapter.implements(plan))
    }
    assertTrue(adapter.implements(creation().put("operation", "vdInfo")))
    assertFalse("旧 vdInput 不再有原生包", adapter.implements(bound("vdInput")))
    assertFalse(adapter.implements(bound("vdMoveTask")))
    assertFalse(adapter.implements(bound("click")))
    assertFalse(adapter.implements(bound("vdDestroy").put("backend", "a11y")))
  }

  @Test fun creationNeedsAPairedBoundedGeometryAndNoGeneration() {
    assertTrue(adapter.implements(creation()))
    assertTrue(adapter.implements(creation(args = JSONObject().put("width", 64).put("height", 4096))))
    assertTrue(adapter.implements(creation(args = JSONObject()
      .put("width", 480).put("height", 640).put("densityDpi", 160).put("session", "s"))))
    assertFalse("width/height 必须成对", adapter.implements(creation(args = JSONObject().put("width", 480))))
    assertFalse(adapter.implements(creation(args = JSONObject().put("width", 63).put("height", 640))))
    assertFalse(adapter.implements(creation(args = JSONObject().put("width", 480).put("height", 4097))))
    assertFalse(adapter.implements(creation(args = JSONObject()
      .put("width", 480).put("height", 640).put("densityDpi", 641))))
    assertFalse("NewVirtual 没有 generation", adapter.implements(creation().put("generation", "1")))
    assertFalse(adapter.implements(creation().put("target", "androidScreen")))
    assertFalse(adapter.implements(creation(alias = "virtual-0")))
    assertFalse(adapter.implements(creation(alias = "real")))
  }

  @Test fun registeredOperationsNeedThePlannedGenerationAndPositiveDisplay() {
    assertTrue(adapter.implements(bound("vdDestroy")))
    assertFalse(adapter.implements(bound("vdDestroy").apply { remove("generation") }))
    assertFalse(adapter.implements(bound("vdDestroy").put("generation", "")))
    assertFalse(adapter.implements(bound("vdDestroy").put("displayId", 0)))
    assertFalse(adapter.implements(bound("vdDestroy").put("target", "virtualCreation")))
    assertFalse(adapter.implements(bound("vdLaunchApp", args = JSONObject().put("pkg", "not a package"))))
    assertTrue(adapter.implements(bound("vdLaunchApp", args = JSONObject().put("pkg", "com.tencent.mm"))))
  }

  @Test fun authorizationIsConsumedImmediatelyBeforeTheOnlyControllerCall() {
    var authorized = 0
    val receipt = adapter.execute("call-1", bound("vdDestroy"), JSONObject(), { true }) {
      authorized++
      assertEquals(0, calls.size)
      true
    }.get()
    assertEquals(1, authorized)
    assertEquals(listOf("vdDestroy" to "virtual-1"), calls)
    assertEquals("yes", receipt.getString("executed"))
  }

  @Test fun denialHasNoControllerSideEffectAndNoExecution() {
    val receipt = adapter.execute("call-2", bound("vdDestroy"), JSONObject(), { true }) { false }.get()
    assertEquals("authorize-denied", receipt.getString("code"))
    assertEquals("no", receipt.getString("executed"))
    assertTrue(calls.isEmpty())
  }

  @Test fun falseFinalAuthorizationNeverCallsTheAndroidController() {
    var controllerCalls = 0
    val denied = NativeVdisplayExecution({ context }, { _, _, _, _, _, guard ->
      if (!guard()) JSONObject().put("ok", false).put("code", "authorize-denied").put("executed", "no")
      else {
        controllerCalls++
        JSONObject().put("ok", true).put("executed", "yes")
      }
    })
    val receipt = denied.execute("call-3", bound("vdLaunch"), JSONObject(), { true }) { false }.get()
    assertEquals("authorize-denied", receipt.getString("code"))
    assertEquals(0, controllerCalls)
  }

  @Test fun authorizationThrowingIsTreatedAsDenied() {
    val receipt = adapter.execute("call-3b", bound("vdLaunch"), JSONObject(), { true }) {
      throw IllegalStateException("gate")
    }.get()
    assertEquals("authorize-denied", receipt.getString("code"))
    assertEquals("no", receipt.getString("executed"))
    assertTrue(calls.isEmpty())
  }

  @Test fun explicitScreenIsPassedVerbatimAndNeverReplacedByASelection() {
    reply = { _, _, _ -> JSONObject().put("ok", true).put("code", "destroyed").put("screenId", "virtual-9") }
    val receipt = adapter.execute("call-4", bound("vdDestroy", alias = "virtual-2"), JSONObject(),
      { true }, { true }).get()
    assertEquals(listOf("vdDestroy" to "virtual-2"), calls)
    assertEquals("virtual-2", receipt.getString("screenId"))
    assertEquals("virtual-2", receipt.getString("alias"))
  }

  @Test fun createdAliasIsBoundToThePlanAndNotTheCurrentSelection() {
    reply = { _, _, _ -> JSONObject().put("ok", true).put("code", "vdisplay-active")
      .put("screenId", "virtual-9").put("selected", "virtual-9") }
    val plan = creation(alias = "virtual-1", args = JSONObject().put("width", 480).put("height", 640))
    val receipt = adapter.execute("call-5", plan, JSONObject(), { true }, { true }).get()
    assertEquals(listOf("vdCreate" to "virtual-1"), calls)
    assertEquals("virtual-1", receipt.getString("screenId"))
    assertEquals("virtual-1", receipt.getString("alias"))
  }

  @Test fun controllerArgumentsAreThePlansArguments() {
    val plan = creation(args = JSONObject().put("width", 480).put("height", 640)
      .put("densityDpi", 160).put("session", "trusted"))
    adapter.execute("call-6", plan, plan.getJSONObject("args"), { true }, { true }).get()
    assertEquals(480, lastArgs!!.getInt("width"))
    assertEquals(640, lastArgs!!.getInt("height"))
    assertEquals(160, lastArgs!!.getInt("densityDpi"))
    assertEquals("trusted", lastArgs!!.getString("session"))
  }

  @Test fun creationPlanUsesOnlyItsOwnArguments() {
    adapter.execute("call-6b", creation(args = JSONObject().put("width", 480).put("height", 640)),
      JSONObject().put("width", 999), { true }, { true }).get()
    assertEquals(480, lastArgs!!.getInt("width"))
    assertFalse(lastArgs!!.has("target"))
  }

  @Test fun controllerExceptionIsUnknownRatherThanNotExecuted() {
    val exploding = NativeVdisplayExecution({ context }, { _, _, _, _, _, guard -> check(guard()); throw IllegalStateException("lost") })
    val receipt = exploding.execute("call-7", bound("vdLaunchApp",
      args = JSONObject().put("pkg", "com.example.app")), JSONObject(), { true }, { true }).get()
    assertEquals("vdisplay-result-unknown", receipt.getString("code"))
    assertEquals("unknown", receipt.getString("executed"))
  }

  @Test fun malformedPlanNeverRunsTheController() {
    val future = adapter.execute("call-8", bound("vdDestroy").put("screenId", "real"), JSONObject(),
      { true }, { true })
    assertEquals("platform-adapter-unavailable", future.get().getString("code"))
    assertTrue(calls.isEmpty())
  }

  @Test fun rootBackendPlansAreAcceptedAndForwardedVerbatim() {
    assertTrue(adapter.implements(creation(backend = "root")))
    assertTrue(adapter.implements(creation(backend = "root").put("operation", "vdInfo")))
    assertTrue(adapter.implements(bound("vdDestroy", backend = "root")))
    assertTrue(adapter.implements(bound("vdLaunchApp", args = JSONObject().put("pkg", "com.example.app"), backend = "root")))
    assertFalse(adapter.implements(bound("vdDestroy", backend = "local")))
    val receipt = adapter.execute(
      "call-root-1",
      creation(alias = "virtual-1", args = JSONObject().put("width", 480).put("height", 640), backend = "root"),
      JSONObject(),
      { true },
      { true },
    ).get()
    assertEquals("yes", receipt.getString("executed"))
    assertEquals("root", lastBackend)
    assertEquals(listOf("vdCreate" to "virtual-1"), calls)
  }

  @Test fun adapterDoesNotClaimNonVirtualPlans() {
    assertFalse(adapter.implements(JSONObject().put("backend", "a11y").put("operation", "click")))
    assertTrue(a11y.implements(JSONObject().put("backend", "a11y").put("operation", "click")))
  }
}
