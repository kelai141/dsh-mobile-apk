package com.dsharnessmobile.shell

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject
import java.security.SecureRandom

/** Android binds this service; all control semantics and dispatch belong to the native host. */
class DeviceControlService : AccessibilityService() {
  companion object {
    private const val TAG = "dsh-a11y"
    const val PREFS = "dsh-adb"
    const val KEY_A11Y = "a11yEnabled"
    const val KEY_TOKEN = "controlToken"
    const val KEY_HEARTBEAT = "controlHeartbeat"
    private const val TOKEN_BYTES = 18
    @Volatile private var instance: DeviceControlService? = null
    fun connected(): Boolean = instance != null

    /**
     * 原生控制平台层的服务入口：只回既有绑定实例，不启动、不重建、不改旧分派。
     * 未连接时返回 null，由调用方按离线处理。
     */
    internal fun nativePlatformService(): AccessibilityService? = instance

    /** 设置页展示用的状态 JSON（不含令牌本身）。 */
    fun statusJson(context: Context): String {
      val enabled = connected()
      val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      return JSONObject()
        .put("enabled", enabled)
        .put("label", UiText.t(context, UserCopy.A11Y_SERVICE_NAME, UserCopy.A11Y_SERVICE_NAME_EN))
        .put("sdk", Build.VERSION.SDK_INT)
        .put("restrictedSettingsApplies", restricted)
        .put(
          "hint",
          if (enabled) {
            UiText.t(context, "无障碍服务已开启：设备控制走无障碍通道（语义树 + performAction）", "Accessibility is on: device control uses the semantic tree and performAction")
          } else {
            UiText.t(
              context,
              "未开启：到 系统设置 → 无障碍 → 已下载的服务 里开启「" + UserCopy.A11Y_SERVICE_NAME + "」",
              "Off: open Settings → Accessibility → Downloaded services and turn on " + UserCopy.A11Y_SERVICE_NAME_EN,
            )
          },
        )
        .put("tokenConfigured", !context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null).isNullOrEmpty())
        .toString()
    }

    /**
     * 共享文件来件路由令牌（壳生成一次、持久化到 dsh-adb.xml；引擎插件 live 读）。
     * 由共享文件来件路由使用，与手机控制 IPC 独立。
     */
    fun token(context: Context): String {
      val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val existing = prefs.getString(KEY_TOKEN, null)
      if (!existing.isNullOrEmpty()) return existing
      val random = ByteArray(TOKEN_BYTES)
      SecureRandom().nextBytes(random)
      val fresh = android.util.Base64.encodeToString(random, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
      prefs.edit().putString(KEY_TOKEN, fresh).apply()
      return fresh
    }


    private fun setEnabledFlag(context: Context, enabled: Boolean) {
      val edit = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(KEY_A11Y, enabled)
      edit.remove(KEY_HEARTBEAT)
      edit.apply()
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    setEnabledFlag(this, true)
    token(this)
    LogCollector.log(TAG, "native accessibility platform connected")
  }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
  override fun onInterrupt() = Unit
  override fun onUnbind(intent: Intent?): Boolean {
    teardown()
    return super.onUnbind(intent)
  }
  override fun onDestroy() { teardown(); super.onDestroy() }
  private fun teardown() {
    if (instance === this) instance = null
    setEnabledFlag(this, false)
    LogCollector.log(TAG, "native accessibility platform disconnected")
  }
  internal object WindowPick {
    /** 单个窗口的判别事实（从 AccessibilityWindowInfo 摘出，避免直接依赖 Android 类型）。 */
    data class Fact(val id: Int, val active: Boolean, val focused: Boolean, val hasRoot: Boolean)

    /**
     * 选出本次要用的窗口。
     *
     * 规则（按优先级）：
     *   ① `pinnedId` 仍在场且有 root → **恒选它**（建树用的那棵树，坐标系统一）；
     *   ② 否则挑 active → focused → 第一个有 root 的窗口，并把 id 作为新的 pin。
     * 只考虑 `hasRoot` 的窗口：`root == null` 的装饰窗口取不到树。
     *
     * @return 被选中的窗口；没有任何可用窗口时返回 id=-1 的占位。
     */
    fun order(facts: List<Fact>, pinnedId: Int): Fact {
      val usable = facts.filter { it.hasRoot }
      val fallback = Fact(-1, false, false, false)
      if (usable.isEmpty()) return fallback
      if (pinnedId >= 0) {
        usable.firstOrNull { it.id == pinnedId }?.let { return it }
      }
      return usable.firstOrNull { it.active }
        ?: usable.firstOrNull { it.focused }
        ?: usable.first()
    }
  }

}
