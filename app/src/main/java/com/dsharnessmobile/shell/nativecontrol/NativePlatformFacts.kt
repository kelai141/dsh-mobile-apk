package com.dsharnessmobile.shell.nativecontrol

import android.content.ComponentName
import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.provider.Settings
import android.view.Display
import android.view.Surface
import com.dsharnessmobile.shell.DeviceControlService
import com.dsharnessmobile.shell.VdisplayController
import org.json.JSONArray
import org.json.JSONObject

/** Android 原始事实采集。scope 只读取宿主值，默认与损坏值由 Rust 收敛。 */
@Suppress("DEPRECATION")
internal class NativePlatformFacts(
  private val context: Context,
  private val execution: NativeA11yExecution,
  private val scope: () -> String,
  private val shizuku: NativeShizukuFacts = NativeShizukuFacts.shared,
) : NativeControlDispatcher.Facts {
  override fun capture(): JSONObject {
    val manager = context.getSystemService(DisplayManager::class.java)
    val screens = JSONObject()
    val displaySupport = JSONObject()
    val displayOperations = JSONObject()
    val operations = linkedSetOf<String>()
    fun publishDisplay(alias: String, display: Display, allocationId: Long? = null) {
      if (!display.isValid) return
      val displayId = display.displayId
      val size = Point()
      display.getRealSize(size)
      val rotation = when (display.rotation) {
        Surface.ROTATION_0 -> 0
        Surface.ROTATION_90 -> 1
        Surface.ROTATION_180 -> 2
        Surface.ROTATION_270 -> 3
        else -> return
      }
      val screen = JSONObject().put("displayId", displayId).put("width", size.x)
        .put("height", size.y).put("rotation", rotation)
      if (allocationId != null) screen.put("allocationId", allocationId.toString())
      screens.put(alias, screen)
      val available = execution.supportedOperations(displayId)
      operations.addAll(available)
      displaySupport.put(displayId.toString(), available.isNotEmpty())
      displayOperations.put(displayId.toString(), JSONArray(available))
    }
    manager.getDisplay(Display.DEFAULT_DISPLAY)?.let { publishDisplay("real", it) }
    // Keep each alias, Android Display object, and identity from the same owner snapshot.
    for ((alias, display, allocationId) in VdisplayController.nativeDisplayAllocations()) {
      publishDisplay(alias, display, allocationId)
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
        .put("displaySupport", JSONObject().put("state", "known").put("values", displaySupport))
        .put("displayOperations", displayOperations))
      .put("shizuku", shizuku.snapshot())
    // Root 仍省略即 unknown，不从 Shizuku 的远端身份推导授权。
  }
}
