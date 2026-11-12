package com.dsharnessmobile.shell.nativecontrol

import com.dsharnessmobile.shell.DeviceControlService
import org.json.JSONObject
import java.util.concurrent.CompletableFuture

/** M1 坐标点击竖切；其余操作接入各自的原生适配器后才开放。 */
internal class NativeA11yExecution : NativeControlDispatcher.Platform {
  fun supportedOperations(displayId: Int): List<String> {
    val service = DeviceControlService.nativePlatformService() ?: return emptyList()
    return if (NativeAccessibilityPlatform(service).pointGesturesSupported(displayId))
      listOf("click", "longClick") else emptyList()
  }

  override fun implements(plan: JSONObject): Boolean =
    plan.optString("backend") == "a11y" && plan.optString("operation") in setOf("click", "longClick") &&
      DeviceControlService.nativePlatformService() != null

  override fun execute(plan: JSONObject, args: JSONObject, authorize: () -> Boolean): CompletableFuture<JSONObject> {
    val service = DeviceControlService.nativePlatformService()
      ?: return rejected("a11y-offline")
    if (!implements(plan)) return rejected("platform-adapter-unavailable")
    val target = NativeAccessibilityPlatform.RawTarget(
      displayId = plan.getInt("displayId"),
      screenId = plan.getString("screenId"),
      logicalWidth = plan.getInt("width"),
      logicalHeight = plan.getInt("height"),
      epoch = plan.getString("epoch"),
      generation = plan.getString("generation"),
    )
    val platform = NativeAccessibilityPlatform(service)
    val x = args.getInt("x")
    val y = args.getInt("y")
    val future = when (plan.getString("operation")) {
      "click" -> platform.clickAt(target, x, y, authorize)
      "longClick" -> platform.longClickAt(target, x, y, 600L, authorize)
      else -> return rejected("platform-adapter-unavailable")
    }
    return future.thenApply { result ->
      JSONObject().put("ok", result.executed == "yes").put("code", result.code)
        .put("executed", result.executed).put("screenId", target.screenId)
    }
  }

  private fun rejected(code: String): CompletableFuture<JSONObject> = CompletableFuture.completedFuture(
    JSONObject().put("ok", false).put("code", code).put("executed", "no"),
  )
}
