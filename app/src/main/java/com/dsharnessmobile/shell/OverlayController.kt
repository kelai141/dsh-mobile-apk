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
 *
 * ST-02（真源收敛，F-APK-02）：开关的事实来源 = 偏好 && Settings.canDrawOverlays &&
 * 服务实例在场；权限缺失时偏好回落 false（展示值与桥回值同时收敛），且宿主自身
 * 永不再弹系统页——回落让 onResume 的补启路径直接短路，只有用户显式再点开关才会重新引导。
 */
object OverlayController {

  private const val TAG = "dsh-overlay"
  private const val PREFS = "dsh-overlay"
  private const val KEY_ENABLED = "enabled"

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** 偏好原值（不掺真源；仅内部决策用——对外一律看 [isEnabled]）。 */
  private fun enabledPref(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

  /**
   * ST-02：真源合并。原先只读偏好——在系统里撤销「显示在其他应用的上层」后设置页开关
   * 仍显示「开」，而球已消失（展示值与事实不一致）。服务实例 = 进程内 onCreate/onDestroy
   * 维护的 @Volatile 引用（可靠；若某 ROM 上不可用，按退化口径 偏好 && canDrawOverlays 登记差异）。
   */
  fun isEnabled(context: Context): Boolean =
    enabledPref(context) && canDrawOverlays(context) && OverlayService.instance != null

  /** 桥入口：持久化 + 启停；未授 overlay 权限时把偏好回落 false 并引导一次。返回当前是否已启动。 */
  fun setEnabled(context: Context, enable: Boolean): Boolean {
    prefs(context).edit().putBoolean(KEY_ENABLED, enable).apply()
    return if (enable) ensureStarted(context) else { stop(context); false }
  }

  /**
   * 幂等启动。权限缺失时：① 偏好回落 false（真源优先——开关展示值、桥回值、实际球态三者一致）；
   * ② 只在**这次显式开启动作**上跳一次系统授权页，随后 onResume 的补启因偏好已回落而短路，
   * 不再每次回前台弹页（ST-02 判据：未授权态弹页次数 = 0）。
   */
  fun ensureStarted(context: Context): Boolean {
    if (!enabledPref(context)) return false
    if (!canDrawOverlays(context)) {
      prefs(context).edit().putBoolean(KEY_ENABLED, false).apply()
      Log.w(TAG, "overlay permission missing; enabled preference rolled back to false")
      LogCollector.log(TAG, "overlay permission missing: enabled pref rolled back to false (guide once, no onResume loop)")
      stop(context)
      launchSettings(context)
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

  /** 系统授权页（仅在权限缺失且用户刚显式开启时调用一次）。 */
  private fun launchSettings(context: Context) {
    try {
      val i = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.parse("package:" + context.packageName),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(i)
    } catch (e: Exception) {
      Log.e(TAG, "overlay settings launch failed: " + e.message)
    }
  }

  fun canDrawOverlays(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(context)
}
