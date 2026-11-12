package com.dsharnessmobile.shell.nativecontrol

import android.content.ComponentName
import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.provider.Settings
import android.view.Display
import android.view.Surface
import com.dsharnessmobile.shell.DeviceControlService
import org.json.JSONArray
import org.json.JSONObject

/** Android 原始事实采集。scope 只读取宿主值，默认与损坏值由 Rust 收敛。 */
@Suppress("DEPRECATION")
internal class NativePlatformFacts(
  private val context: Context,
  private val execution: NativeA11yExecution,
  private val scope: () -> String,
  // 只接受宿主实际持有的显示器；不扫描并冒认其他应用创建的虚拟显示器。
  private val registeredDisplays: () -> Map<String, Int> = { mapOf("real" to Display.DEFAULT_DISPLAY) },
) : NativeControlDispatcher.Facts {
  override fun capture(): JSONObject {
    val manager = context.getSystemService(DisplayManager::class.java)
    val screens = JSONObject()
    val displaySupport = JSONObject()
    val operations = linkedSetOf<String>()
    for ((alias, displayId) in registeredDisplays()) {
      val display = manager.getDisplay(displayId) ?: continue
      if (!display.isValid) continue
      val size = Point()
      display.getRealSize(size)
      val rotation = when (display.rotation) {
        Surface.ROTATION_0 -> 0
        Surface.ROTATION_90 -> 1
        Surface.ROTATION_180 -> 2
        Surface.ROTATION_270 -> 3
        else -> continue
      }
      screens.put(alias, JSONObject().put("displayId", displayId).put("width", size.x)
        .put("height", size.y).put("rotation", rotation))
      val available = execution.supportedOperations(displayId)
      operations.addAll(available)
      displaySupport.put(displayId.toString(), available.isNotEmpty())
    }
    val enabled = try {
      val expected = ComponentName(context, DeviceControlService::class.java)
      val services = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
      if (services.orEmpty().split(':').any { ComponentName.unflattenFromString(it) == expected }) "yes" else "no"
    } catch (_: Exception) { "unknown" }
    val online = if (DeviceControlService.nativePlatformService() != null) "yes" else "no"
    return JSONObject().put("scope", scope()).put("observedAtMs", System.currentTimeMillis())
      .put("screens", screens)
      .put("a11y", JSONObject().put("enabled", enabled).put("online", online)
        .put("supportedOps", JSONObject().put("state", "known").put("ops", JSONArray(operations.toList())))
        .put("displaySupport", JSONObject().put("state", "known").put("values", displaySupport)))
    // Shizuku / Root 未接入本竖切：省略即 unknown，不复用旧插件推断出的布尔值。
  }
}
