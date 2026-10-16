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
    applyNavigationBarImmersive()
  }

  /**
   * issue #392 真沉浸：把导航/手势条区域交由**页面画布**呈现，而不是一条系统实色条。
   *
   * 缺陷形态：主题里 `navigationBarColor=@color/ds_bg`，夜色下是纯黑 #000000，而页面画布是
   * #151517——最底一段被系统涂成实色，与应用底栏割裂。应用侧此前只做了
   * `setDecorFitsSystemWindows(false)`（内容确实铺到了物理底边），但系统仍在最底一段涂自己的
   * 颜色，所以「沉浸式」看着不成立。
   *
   * 判据口径：**截图本身不足以定案**——主题的 `windowBackground` 同为 `@color/ds_bg`，夜色
   * 同为 #000000，「最底一段纯黑」在「系统涂色」与「页面没铺到、露出窗口底色」两种假设下都成立。
   * 定案靠设备层 A/B。本仓实测（Medium_Phone 1080x2400 / 420dpi / 手势条）：改前导航条 inset
   * 区（`frame=[0,2337][1080,2400]`，高 63px）恒为 (0,0,0)、其上为 (10,10,11)；改后同区变为
   * (10,10,11)，即页面画布色透出——说明页面本就铺到物理底边，原色带确系系统所涂。
   *
   * 修法：导航条透明（四份 themes.xml 同步改 `@android:color/transparent`），并在 Android 10+
   * 关掉导航条对比度强制——否则手势条后面仍会被系统叠一层 scrim，透出的不是页面色。
   * 沉浸式开关只隐藏状态栏（`ImmersiveMode.apply`），与导航条透明是两件独立的事，
   * 故本函数**不**受该开关控制：无论开关如何，底部都不该出现系统色带。
   */
  fun applyNavigationBarImmersive() {
    try {
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        activity.window.isNavigationBarContrastEnforced = false
      }
    } catch (t: Throwable) {
      // 厂商 ROM 可能拒绝该 setter：如实放弃（保持主题里的透明值），不把窗口偏好变成崩溃。
      Log.w("dsh-shell", "navigation bar contrast opt-out failed: " + t.message)
    }
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
