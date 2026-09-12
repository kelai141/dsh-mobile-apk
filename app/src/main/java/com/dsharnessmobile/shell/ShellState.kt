package com.dsharnessmobile.shell

import android.app.Activity
import android.content.Context
import android.os.Build
import android.util.Log
import android.view.View
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * ST-10 / ST-11（源 §4.3，缺陷 F-APK-05/06 + F-UI-05/11）的壳侧单一真源。
 *
 * 两条缺陷同形：「展示值」不是「事实」。
 * - 沉浸式：壳偏好 `dsh_settings/immersive_mode` 与页面 localStorage 是两份互不校验的状态，
 *   桥**只有 setter**，页面永远拿不到壳侧真实值（adb 直接改壳偏好后设置页显示不一致）；
 * - 开发者日志：桥只回读偏好，EngineService.onDestroy 无条件 `LogCollector.stop()` 后
 *   开关仍显示「开」——乐观置位。
 *
 * 本文件把两个真源收成一处：壳侧任何读写（MainActivity / WebUiChrome / 桥）都必须走这里，
 * 页面侧只消费桥 getter。删除其中任一份读取（或让 getter 绕过合取）即由
 * ShellStateContractTest / ShellStateTest 判红。
 */

/** 进程级 application context：桥 getter 没有 Context 形参时的真源入口。 */
internal object ShellAppContext {
  @Volatile private var appContext: Context? = null

  fun bind(context: Context) {
    appContext = context.applicationContext
  }

  fun get(): Context? = appContext
}

/** 沉浸式（状态栏常态收起）的壳侧唯一真源。 */
internal object ImmersiveMode {
  const val PREFS = "dsh_settings"
  const val KEY_IMMERSIVE = "immersive_mode"

  /** 默认收起（与既有行为一致：首次安装即沉浸式）。 */
  const val DEFAULT = true

  /** 壳侧权威值（唯一读点；偏好不可读时回落默认值，绝不抛）。 */
  fun isEnabled(context: Context): Boolean = try {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_IMMERSIVE, DEFAULT)
  } catch (_: Exception) {
    DEFAULT
  }

  /** 无 Context 形参的读点（JS 桥 getImmersiveMode）。上下文未绑定前回落默认值。 */
  fun current(): Boolean = ShellAppContext.get()?.let { isEnabled(it) } ?: DEFAULT

  /** 桥 setter 落点：先持久化（事实）、再在 UI 线程应用（表现）。 */
  fun setEnabled(activity: Activity, enabled: Boolean) {
    try {
      activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_IMMERSIVE, enabled).apply()
      Log.i("dsh-image", "immersive set: " + enabled)
    } catch (e: Exception) {
      Log.e("dsh-image", "immersive persist failed: " + e.message)
    }
    activity.runOnUiThread { apply(activity, enabled) }
  }

  /** 状态栏常态收起（沉浸式）：隐藏系统栏，边缘滑动临时呼出后自动收起。 */
  fun apply(activity: Activity, enabled: Boolean) {
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val controller = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
        if (enabled) {
          controller.hide(WindowInsetsCompat.Type.statusBars())
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
          controller.show(WindowInsetsCompat.Type.statusBars())
        }
      } else {
        val flags = if (enabled) {
          View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        } else {
          0
        }
        activity.window.decorView.systemUiVisibility = flags
      }
    } catch (t: Throwable) {
      Log.e("dsh-image", "applyImmersive failed: " + t.message)
    }
  }
}

/** 开发者日志（采集器）的壳侧唯一真源。 */
internal object DevLogControl {

  /** 偏好原值（MainActivity.DevLogPrefs 是既有写面，这里只读它，不另立第二份偏好）。 */
  fun isPrefEnabled(context: Context): Boolean = MainActivity.DevLogPrefs.isEnabled(context)

  /** ST-11：开关事实 = 偏好 **&&** 采集器在跑（拒绝乐观置位）。 */
  fun isEnabled(context: Context): Boolean = isPrefEnabled(context) && LogCollector.isRunning()

  /**
   * onResume 幂等补启：偏好开而采集器不在跑时启动。
   *
   * 断点：EngineService.onDestroy 无条件 `LogCollector.stop()`——服务被杀后回前台，
   * 旧实现只显示「开」而文件不再增长。本入口把「回前台」变成补启点（幂等，重复调用无害）。
   * @return 补启后是否在跑。
   */
  fun ensureStarted(context: Context): Boolean {
    if (!isPrefEnabled(context)) return LogCollector.isRunning()
    if (!LogCollector.isRunning()) {
      LogCollector.start(context)
      LogCollector.log("dsh-log", "collector restarted on foreground (pref on, collector was stopped)")
    }
    return LogCollector.isRunning()
  }

  /** 开关写面：偏好与采集器成对动作（先落偏好，再启停采集器）。 */
  fun setEnabled(context: Context, enabled: Boolean) {
    MainActivity.DevLogPrefs.setEnabled(context, enabled)
    if (enabled) LogCollector.start(context) else LogCollector.stop()
  }
}
