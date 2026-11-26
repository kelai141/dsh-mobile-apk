package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import com.dsharnessmobile.shell.VdisplayController
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException

/**
 * Executes only the virtual-display plans committed by the Rust native controller.
 *
 * This adapter owns no policy: it accepts the five vd* operations, binds every call to the plan's
 * screenId, and calls the controller's authorized entry immediately after the final authorization
 * check. It never routes through VdisplayOps, ControlCarrier, or a selected-screen fallback.
 */
internal class NativeVdisplayExecution(
  private val context: () -> Context?,
  private val executeAuthorized: (
    context: Context?,
    op: String,
    args: JSONObject,
    screenId: String,
    backend: String,
    authorize: () -> Boolean,
  ) -> JSONObject = { app, op, args, screenId, backend, authorize ->
    if (app == null) JSONObject().put("ok", false).put("code", "vdisplay-host-unavailable")
    else VdisplayController.executeAuthorized(app, op, args, screenId, authorize = authorize, backend = backend)
  },
) : NativeControlDispatcher.Platform {

  data class Binding(val operation: String, val screenId: String, val args: JSONObject, val backend: String)

  override fun implements(plan: JSONObject): Boolean = binding(plan) != null

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val bound = binding(plan) ?: return rejected("platform-adapter-unavailable")
    return try {
      worker.supplyAsync({
        // The controller consumes this guard at the Android side effect, after Binder preparation.
        val guard = { try { authorize() } catch (_: Exception) { false } }
        val receipt = try {
          executeAuthorized(context(), bound.operation, bound.args, bound.screenId, bound.backend, guard)
        } catch (_: Exception) {
          return@supplyAsync failure("vdisplay-result-unknown", "unknown", bound.screenId)
        }
        settled(receipt, bound.screenId)
      })
    } catch (_: RejectedExecutionException) {
      rejected("vdisplay-native-busy")
    }
  }

  /**
   * Strict plan shape check. A vdCreate plan is a virtual creation without generation; every other
   * vd* plan must be bound to an already registered display and its generation.
   */
  private fun binding(plan: JSONObject): Binding? {
    // Rust emits backend=shizuku or backend=root (independently authorized) for vd*;
    // never claim a plan that selected a different transport.
    val backend = plan.optString("backend")
    if (backend != "shizuku" && backend != "root") return null
    val operation = plan.optString("operation")
    if (operation !in operations) return null
    val screenId = plan.optString("screenId")
    if (!isVirtualAlias(screenId)) return null
    val target = plan.optString("target")
    if (operation == "vdCreate" || operation == "vdInfo") {
      if (target != "virtualCreation") return null
      if (plan.has("generation") || plan.has("displayId")) return null
    } else {
      if (target != "androidScreen") return null
      val generation = plan.optString("generation")
      if (generation.isBlank()) return null
      if (plan.optInt("displayId", 0) <= 0) return null
    }
    val args = plan.optJSONObject("args") ?: JSONObject()
    if (operation == "vdCreate") {
      val width = args.opt("width")
      val height = args.opt("height")
      if ((width == null) != (height == null)) return null
      if (width != null) {
        val w = args.optInt("width", 0)
        val h = args.optInt("height", 0)
        if (w !in 64..4096 || h !in 64..4096) return null
      }
      if (args.has("densityDpi") && args.optInt("densityDpi", 0) !in 120..640) return null
    }
    if (operation == "vdLaunchApp" && !isPackage(args.optString("pkg"))) return null
    return Binding(operation, screenId, JSONObject(args.toString()), backend)
  }

  private fun settled(receipt: JSONObject, screenId: String): JSONObject {
    val ok = receipt.optBoolean("ok")
    val executed = when (receipt.optString("executed")) {
      "yes", "no" -> receipt.optString("executed")
      else -> if (ok) "yes" else "unknown"
    }
    return JSONObject().apply {
      for (key in listOf("ok", "code", "guidance", "aliases", "displayId", "landedDisplayIds", "data", "diagnostic")) {
        if (receipt.has(key)) put(key, receipt.get(key))
      }
      put("ok", ok)
      put("code", receipt.optString("code", if (ok) "vdisplay-ok" else "vdisplay-failed"))
      put("executed", executed)
      // The plan owns the target: never return another screen's alias.
      put("screenId", screenId)
      put("alias", screenId)
    }
  }

  private fun failure(code: String, executed: String, screenId: String): JSONObject = JSONObject()
    .put("ok", false).put("code", code).put("executed", executed)
    .put("screenId", screenId).put("alias", screenId)

  private fun rejected(code: String): CompletableFuture<JSONObject> = CompletableFuture.completedFuture(
    JSONObject().put("ok", false).put("code", code).put("executed", "no"),
  )

  companion object {
    private val operations = setOf("vdCreate", "vdDestroy", "vdLaunch", "vdLaunchApp", "vdInfo")
    private val aliasPattern = Regex("^virtual-[1-9][0-9]*$")
    private val packagePattern = Regex("^[a-zA-Z][a-zA-Z0-9_]*\\.[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)*$")

    internal fun isVirtualAlias(alias: String): Boolean =
      alias.length in 9..20 && aliasPattern.matches(alias)

    internal fun isPackage(value: String): Boolean =
      value.length in 3..255 && packagePattern.matches(value)

    private val worker = NativeOperationWorker("dsh-native-vdisplay")
  }
}
