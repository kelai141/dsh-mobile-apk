package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * 悬浮球控制器（W7，PRD-0.13.2 §4）：开关持久化 + OverlayService 生命周期 +
 * SYSTEM_ALERT_WINDOW 权限引导。桥（DevSection 开关）与 MainActivity.onResume
 * （权限授予后自动补启）共用此入口。
 */
object OverlayController {

  private const val TAG = "dsh-overlay"
  private const val PREFS = "dsh-overlay"
  private const val KEY_ENABLED = "enabled"

  fun isEnabled(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

  /** 桥入口：持久化 + 启停；未授 overlay 权限时发起系统授权页引导。返回当前是否已启动。 */
  fun setEnabled(context: Context, enable: Boolean): Boolean {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enable).apply()
    return if (enable) ensureStarted(context) else { stop(context); false }
  }

  /** 幂等启动：无权限 → 跳授权页并停止（等待 onResume 补启）；有权限 → 起服务。 */
  fun ensureStarted(context: Context): Boolean {
    if (!isEnabled(context)) return false
    if (!canDrawOverlays(context)) {
      Log.w(TAG, "overlay permission missing; launching settings")
      stop(context)
      try {
        val i = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:" + context.packageName),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
      } catch (e: Exception) {
        Log.e(TAG, "overlay settings launch failed: " + e.message)
      }
      return false
    }
    try {
      context.startService(Intent(context, OverlayService::class.java))
      return true
    } catch (e: Exception) {
      Log.e(TAG, "overlay service start failed: " + e.message)
      return false
    }
  }

  fun stop(context: Context) {
    try {
      context.stopService(Intent(context, OverlayService::class.java))
    } catch (e: Exception) {
      Log.e(TAG, "overlay service stop failed: " + e.message)
    }
  }

  fun canDrawOverlays(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(context)
}