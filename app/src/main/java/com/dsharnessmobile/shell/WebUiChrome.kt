package com.dsharnessmobile.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.PowerManager
import android.util.Log
import android.webkit.WebView

/** 窗口/页面 UI chrome 助手（自 MainActivity 拆出）：沉浸式状态栏、
 *  原生剪贴板、屏幕常亮、系统深色主题推送——均为无业务逻辑的纯 UI 状态读写。 */
internal class WebUiChrome(private val activity: MainActivity) {

  // ST-10（F-APK-06）：本类原有一份与 MainActivity 私有方法**逐字重复**的沉浸式实现，
  // 加上页面 localStorage 就是三份状态。真源统一收敛到 ImmersiveMode（ShellState.kt），
  // 本类三个入口只做委托——不再持有第二份 prefs 读写与第二份 systemUiVisibility 逻辑。

  /** 沉浸式权威值读取（设置 → 通用设置 开关；默认收起）。 */
  fun immersivePrefs(): Boolean = ImmersiveMode.isEnabled(activity)

  /** 状态栏常态收起（沉浸式）：委托 ImmersiveMode.apply。 */
  fun applyImmersive(enabled: Boolean) {
    ImmersiveMode.apply(activity, enabled)
  }

  /** 沉浸式开关（JS 桥）：持久化 + 应用（委托 ImmersiveMode.setEnabled）。 */
  fun setImmersivePersisted(enabled: Boolean) {
    ImmersiveMode.setEnabled(activity, enabled)
  }

  /** 0.13.3：textZoom 桥与持久化退役（D6）——上游 ui-theme fontSize 原生覆盖字体调节。 */

  /**
   * 原生剪贴板写入（WebView 的 Clipboard API 在 Android 上被拒
   * NotAllowedError: Write permission denied，页面回退到本桥）。
   */
  fun copyTextNative(text: String): Boolean {
    return try {
      val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      cm.setPrimaryClip(ClipData.newPlainText("dsh", text))
      Log.i("dsh-image", "copyTextNative ok, len=" + text.length)
      true
    } catch (e: Exception) {
      Log.e("dsh-image", "copyTextNative failed: " + e.message)
      false
    }
  }

  /** 屏幕常亮 WakeLock（JS 桥 keepScreenOn）。单例字段持有 + 成对
   *  acquire/release：旧实现每次调用 newWakeLock，新实例 isHeld 恒 false，
   *  关闭路径永不 release（Review 2026-08-18 实锤的锁泄漏）。 */
  private var screenWakeLock: PowerManager.WakeLock? = null

  fun keepScreenOn(enable: Boolean) {
    try {
      val power = activity.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (enable && screenWakeLock == null) {
        screenWakeLock = power.newWakeLock(
          PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ON_AFTER_RELEASE,
          "dsh:screen",
        ).apply { acquire() }
      } else if (!enable && screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (t: Throwable) {
      Log.e("dsh-shell", "keepScreenOn failed: " + t.message)
    }
  }

  /** Activity 销毁兜底释放（原 onDestroy 的 screenWakeLock 释放块）。 */
  fun releaseWakeLock() {
    try {
      if (screenWakeLock != null) {
        screenWakeLock?.release()
        screenWakeLock = null
      }
    } catch (_: Exception) {
    }
  }

  /** M7：主题延迟重推 Runnable 引用（onDestroy 取消用）。 */
  private var themeRetryRunnable: Runnable? = null

  /** 系统深色状态推送：某些厂商 WebView 的 prefers-color-scheme 不跟随
   *  uiMode（vivo/Android 16 实测），UI 插件经 matchMedia hook 消费此桥值
   *  （window.__dshThemeBridge.setDark）驱动上游 system 主题。
   *  推送时机加固（2026-08-16）：兜底桥（ui-responsive client bundle 内的
   *  ThemeBridge）可能晚于 onPageFinished 才安装——单次推送会静默落空
   *  （`window.__dshThemeBridge &&` 短路），主题不跟随。延迟 800ms 再推
   *  一次覆盖该时序；onResume 亦补推（覆盖从系统设置/SAF 返回后主题变化）。
   *  Runnable 体内 try/catch + onDestroy removeCallbacks（M7：防销毁后
   *  迟到的 evaluateJavascript 抛主线程异常）。 */
  fun pushSystemDark(view: WebView) {
    val dark = (activity.resources.configuration.uiMode and
      android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
      android.content.res.Configuration.UI_MODE_NIGHT_YES
    try {
      view.evaluateJavascript(
        "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
      )
      themeRetryRunnable?.let { view.removeCallbacks(it) }
      val runnable = Runnable {
        try {
          view.evaluateJavascript(
            "window.__dshThemeBridge && window.__dshThemeBridge.setDark(" + dark + ")", null,
          )
        } catch (_: Exception) {
          // 页面/WebView 已销毁：重推失败无害。
        }
      }
      themeRetryRunnable = runnable
      view.postDelayed(runnable, 800)
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再推一次。
    }
  }

  /** onDestroy 取消延迟重推（M7）。 */
  fun cancelThemePush(view: WebView) {
    themeRetryRunnable?.let { view.removeCallbacks(it) }
  }
}
