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
import com.dsharnessmobile.shell.RootGrant
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
    val allocations = VdisplayController.nativeDisplayAllocations()
    val registeredDisplayIds = allocations.mapNotNull { allocation ->
      runCatching { allocation.display.displayId }.getOrNull()
    }.toSet()
    for ((alias, display, allocationId) in allocations) {
      publishDisplay(alias, display, allocationId)
    }
    val enabled = try {
      val expected = ComponentName(context, DeviceControlService::class.java)
      val services = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
      if (services.orEmpty().split(':').any { ComponentName.unflattenFromString(it) == expected }) "yes" else "no"
    } catch (_: Exception) { "unknown" }
    val online = if (DeviceControlService.nativePlatformService() != null) "yes" else "no"
    val shizukuFacts = shizuku.snapshot()
    // per-display 事实只对「本应用此刻仍注册」的屏成立：真实屏恰好是 display 0，
    // 其余必须还在 VdisplayController 的分配表里。已销毁的屏立刻从事实面消失，
    // 不让上一轮的实测位残留到下一次派发。
    val measured = shizukuFacts.optJSONObject("displayOperations")
    if (measured != null) {
      val live = JSONObject()
      for (key in measured.keys()) {
        val id = key.toIntOrNull() ?: continue
        if (id == Display.DEFAULT_DISPLAY || id in registeredDisplayIds) live.put(key, measured.get(key))
      }
      if (live.length() > 0) {
        shizukuFacts.put("displayOperations", live)
        val values = JSONObject()
        for (key in live.keys()) values.put(key, true)
        shizukuFacts.put("displaySupport", JSONObject().put("state", "known").put("values", values))
        // supportedOps 必须只反映仍然存活的屏：已销毁屏的 op 不得留在并集里，
        // 否则缺 displayOperations 的回退路径会拿它冒充支持。
        val union = org.json.JSONArray()
        for (key in live.keys()) {
          val operations = live.optJSONArray(key) ?: continue
          for (index in 0 until operations.length()) {
            val operation = operations.optString(index)
            if (operation.isEmpty()) continue
            if ((0 until union.length()).any { union.optString(it) == operation }) continue
            union.put(operation)
          }
        }
        shizukuFacts.put("supportedOps", if (union.length() > 0)
          JSONObject().put("state", "known").put("ops", union)
          else JSONObject().put("state", "unknown"))
      } else {
        // 一块屏都没测到：整键缺席并把支持表降为未知，让 Rust 走「未知不冒充否」的判定。
        shizukuFacts.remove("displayOperations")
        shizukuFacts.put("displaySupport", JSONObject().put("state", "unknown"))
        // 并集也一并收回：不能留下只属于已销毁屏的 op。
        shizukuFacts.put("supportedOps", JSONObject().put("state", "unknown"))
      }
    }
    if (shizukuFacts.optString("functionalReady") == "yes" && shizukuFacts.optString("granted") == "yes" &&
      shizukuFacts.optJSONObject("serverUid")?.optString("kind") == "shell2000") {
      val supported = shizukuFacts.optJSONObject("supportedOps")?.optJSONArray("ops") ?: JSONArray()
      for (operation in listOf("vdCreate", "vdDestroy", "vdInfo", "vdLaunch", "vdLaunchApp")) supported.put(operation)
      shizukuFacts.put("supportedOps", JSONObject().put("state", "known").put("ops", supported))
    }
    return JSONObject().put("scope", scope()).put("observedAtMs", System.currentTimeMillis())
      .put("screens", screens)
      .put("a11y", JSONObject().put("enabled", enabled).put("online", online)
        .put("supportedOps", JSONObject().put("state", "known").put("ops", JSONArray(operations.toList())))
        .put("displaySupport", JSONObject().put("state", "known").put("values", displaySupport))
        .put("displayOperations", displayOperations))
      .put("shizuku", shizukuFacts)
      .put("root", runCatching {
        JSONObject().put("authorization", if (RootGrant.isGranted(context)) "yes" else "no")
          .put("consentValid", if (RootGrant.consentValid(context)) "yes" else "no")
      }.getOrElse { JSONObject().put("authorization", "unknown").put("consentValid", "unknown") })
  }
}
