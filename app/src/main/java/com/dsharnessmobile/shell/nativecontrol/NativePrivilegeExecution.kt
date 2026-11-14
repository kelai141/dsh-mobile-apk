package com.dsharnessmobile.shell.nativecontrol

import android.content.Context
import com.dsharnessmobile.shell.RootAccess
import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Facts come from the shell. Diagnostics have no display or fallback to a different identity. */
internal object NativePrivilegeFacts {
  fun augment(context: Context, facts: JSONObject): JSONObject {
    facts.put("device", JSONObject().put("manufacturer", android.os.Build.MANUFACTURER)
      .put("model", android.os.Build.MODEL).put("sdk", android.os.Build.VERSION.SDK_INT)
      .put("release", android.os.Build.VERSION.RELEASE))
    facts.put("termuxReady", if (NativeAppShell.ready(context)) "yes" else "no")
    val rootState = RootAccess.state(context, includeOwnership = false)
    facts.optJSONObject("root")?.put("appSu", when {
      rootState.optBoolean("granted") && rootState.optInt("uid", -1) == 0 -> "yes"
      rootState.optString("state") in setOf("no-su", "denied", "not-root") -> "no"
      else -> "unknown"
    })
    val shell = facts.optJSONObject("shizuku") ?: return facts
    if (shell.optString("granted") == "yes" && shell.optString("functionalReady") == "yes" &&
      shell.optJSONObject("serverUid")?.optString("kind") == "shell2000") {
      val previous = shell.optJSONObject("supportedOps")?.optJSONArray("ops") ?: JSONArray()
      val ops = (0 until previous.length()).map { previous.getString(it) }.toMutableSet()
      ops.add("shExec")
      if (java.io.File("/system/bin/settings").canExecute()) ops.add("prepareEnvironment")
      shell.put("supportedOps", JSONObject().put("state", "known").put("ops", JSONArray(ops.toList())))
    }
    return facts
  }
}

internal class NativePrivilegeExecution(
  private val context: Context,
  private val next: NativeControlDispatcher.Platform,
) : NativeControlDispatcher.Platform {
  private fun isDiagnostic(plan: JSONObject): Boolean = plan.optString("target") == "privilegedShell" &&
    when (plan.optString("operation")) {
      "shExec" -> plan.optString("backend") == "shizuku"
      "rootExec" -> plan.optString("backend") == "root"
      "termuxExec" -> plan.optString("backend") == "local"
      else -> false
    }

  override fun implements(plan: JSONObject): Boolean = isDiagnostic(plan) || next.implements(plan)

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    if (!isDiagnostic(plan)) return next.execute(callId, plan, args, refreshFacts, authorize)
    val command = args.getString("command")
    val root = plan.getString("backend") == "root"
    return try {
      worker.supplyAsync({
        if (plan.optString("operation") == "termuxExec") {
          return@supplyAsync NativeAppShell.execute(context, command, authorize)
        }
        val permitted = AtomicBoolean(false)
        val gate = { authorize().also { permitted.set(it) } }
        // Select one available root transport before execution. No error path promotes or retries.
        val result = if (root && RootAccess.isGranted(context) && RootAccess.suPath() != null) {
          RootAccess.execRoot(context, command, 20_000, gate)
        } else {
          ShizukuTransport.runNativeDiagnostic(context, command, if (root) 0 else 2000, gate)
        }
        val complete = permitted.get() && RootAccess.suAcknowledgement(result) && !result.optBoolean("noReplay")
        val ok = complete && result.optBoolean("ok")
        val code = result.optString("code").ifBlank { if (ok) "shell-completed" else "shell-failed" }
        JSONObject().put("ok", ok).put("code", code)
          .put("executed", when {
            complete -> "yes"
            !permitted.get() -> "no"
            else -> "unknown"
          }).apply {
            if (complete) put("data", NativeShellOutput.compact(result.optString("stdout"),
              result.optString("stderr"), result.optInt("exitCode", -1), result.optBoolean("truncated")))
          }
      })
    } catch (_: RejectedExecutionException) {
      CompletableFuture.completedFuture(JSONObject().put("ok", false).put("code", "diagnostic-busy").put("executed", "no"))
    }
  }

  companion object {
    private val worker = NativeOperationWorker("dsh-native-diagnostics")
  }
}
