package com.dsharnessmobile.shell.nativecontrol

import com.dsharnessmobile.shell.ShizukuTransport
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Executes a Rust-authorized real-screen point tap; never chooses the channel itself. */
internal class NativeShizukuExecution(
  private val a11y: NativeControlDispatcher.Platform,
) : NativeControlDispatcher.Platform {
  override fun implements(plan: JSONObject): Boolean =
    if (plan.optString("backend") == "shizuku") isRealTap(plan) else a11y.implements(plan)

  override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
    authorize: () -> Boolean): CompletableFuture<JSONObject> {
    if (plan.optString("backend") != "shizuku") return a11y.execute(callId, plan, args, refreshFacts, authorize)
    if (!isRealTap(plan)) return rejected("platform-adapter-unavailable")
    val x = args.getInt("x")
    val y = args.getInt("y")
    return try {
      CompletableFuture.supplyAsync({ ShizukuTransport.nativeTapReal(x, y, authorize) }, worker)
    } catch (_: RejectedExecutionException) {
      rejected("shizuku-native-input-busy")
    }
  }

  private fun isRealTap(plan: JSONObject): Boolean =
    plan.optString("operation") == "click" && plan.optString("screenId") == "real" &&
      plan.optInt("displayId", -1) == 0 && !plan.has("nodeTarget")

  private fun rejected(code: String): CompletableFuture<JSONObject> = CompletableFuture.completedFuture(
    JSONObject().put("ok", false).put("code", code).put("executed", "no"),
  )

  companion object {
    // A hung Binder blocks at most one worker. No queue can dispatch an expired request later.
    private val worker = ThreadPoolExecutor(0, 1, 10, TimeUnit.SECONDS, SynchronousQueue()) { task ->
      Thread(task, "dsh-native-shizuku").apply { isDaemon = true }
    }
  }
}
