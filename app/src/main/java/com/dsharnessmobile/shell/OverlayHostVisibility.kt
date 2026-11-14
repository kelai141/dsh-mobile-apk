package com.dsharnessmobile.shell

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.util.Collections
import java.util.IdentityHashMap

/** 应用级前台真源：服务可在首次建窗前查询，Activity 切换不产生入口闪现。 */
internal object OverlayHostVisibility : Application.ActivityLifecycleCallbacks {
  private var installed = false
  private val resumed = Collections.newSetFromMap(IdentityHashMap<Activity, Boolean>())
  private val main = Handler(Looper.getMainLooper())
  internal var foreground = false
    private set
  private val publish = Runnable {
    val next = resumed.isNotEmpty()
    if (next != foreground) {
      foreground = next
      OverlayService.instance?.onHostForegroundChanged(next)
    }
  }

  internal fun install(app: Application) {
    if (installed) return
    installed = true
    app.registerActivityLifecycleCallbacks(this)
  }

  override fun onActivityResumed(activity: Activity) {
    // 取件代理没有本体界面；外部相机/SAF 期间保留悬浮系统的生命周期。
    if (activity is OverlayAttachProxyActivity) return
    resumed.add(activity)
    main.removeCallbacks(publish)
    publish.run()
  }
  override fun onActivityPaused(activity: Activity) {
    resumed.remove(activity)
    main.removeCallbacks(publish)
    main.postDelayed(publish, 120)
  }
  override fun onActivityDestroyed(activity: Activity) {
    resumed.remove(activity)
    main.removeCallbacks(publish)
    main.post(publish)
  }
  override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
  override fun onActivityStarted(activity: Activity) = Unit
  override fun onActivityStopped(activity: Activity) = Unit
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
}
