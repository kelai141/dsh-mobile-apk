package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * Shizuku 探针（0.14.0 迭代「虚拟屏」线 S2）。
 *
 * 定位与纪律：
 *  - **debug-only**：非 debuggable 构建一律返回结构化拒绝，不做任何探测（不引入运行期成本）。
 *  - **fail-closed**：安装/运行/授权/版本/uid 五态逐项独立 `runCatching`，任一项异常不得
 *    影响其它项，也不得把「未知」写成可用。
 *  - **零编译期依赖**：本文件经反射读 Shizuku（与既有 [ShizukuSupport] 同口径），
 *    因此 Shizuku aar 尚未接入时本文件照样编译；`bindUserService` 等需要 aar 类型的能力
 *    属 S5（依赖落地后改用直连 API，见 P0-2/P0-3）。
 *  - 不写任何授权状态：Shizuku 授权只能由用户在 Shizuku App 内授予（被提权方不得自改授权）。
 *
 * 错误码与源文档 §9.3 的表一致：`shizuku-absent` / `shizuku-not-running` / `shizuku-denied` /
 * `shizuku-prev11`。缺什么/为什么/能否补救三项都必须出现在 `guidance` 里。
 */
object ShizukuProbe {

  /** 反射缓存（避免每次探测都 Class.forName）。 */
  @Volatile
  private var cachedClass: Class<*>? = null
  @Volatile
  private var classProbed = false

  private fun shizukuClass(): Class<*>? {
    if (!classProbed) {
      cachedClass = runCatching { Class.forName("rikka.shizuku.Shizuku") }.getOrNull()
      classProbed = true
    }
    return cachedClass
  }

  @Suppress("DEPRECATION") // getPackageInfo(String, Int) 在 API 33 起废弃，但 minSdk 26 仍需该重载
  private fun installed(context: Context): Boolean = runCatching {
    context.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0)
    true
  }.getOrDefault(false)

  /**
   * 五态探测，返回可直接下发给模型/设置页的 JSON。
   * @param context 应用上下文（只用于包名查询，不持久化任何东西）。
   * @return `{ ok, installed, running, granted, version, uid, code, guidance }`
   */
  fun probe(context: Context): JSONObject {
    val out = JSONObject()
    if (!BuildConfig.DEBUG) {
      return out.put("ok", false).put("code", "probe-disabled-non-debug")
        .put("guidance", "Shizuku 探针仅在 debug 构建可用（release 不暴露探针面）。")
    }
    val cls = shizukuClass()
    val isInstalled = installed(context) || cls != null
    out.put("installed", isInstalled)
    out.put("running", false)
    out.put("granted", false)

    if (!isInstalled) {
      return out.put("ok", false).put("code", "shizuku-absent")
        .put("guidance", "未检测到 Shizuku。虚拟屏需要 Shizuku 以 shell 身份建屏/拉应用；"
          + "不安装不影响真实屏控制。安装见 https://shizuku.rikka.app/download/。")
    }
    if (cls == null) {
      return out.put("ok", false).put("code", "shizuku-absent")
        .put("guidance", "Shizuku 应用在场但 API 类不可达（缺少 provider 声明或版本过旧）："
          + "本应用清单尚未声明 rikka.shizuku.ShizukuProvider，属已知未落地项。")
    }

    val running = runCatching { cls.getMethod("pingBinder").invoke(null) as? Boolean ?: false }.getOrDefault(false)
    out.put("running", running)
    if (!running) {
      return out.put("ok", false).put("code", "shizuku-not-running")
        .put("guidance", "Shizuku 已安装但服务未运行。非 root 设备需在每次开机后用无线调试启动一次"
          + "（Android 11+ 可在设备上直接启动；官方限制，无法自动开机自启）。")
    }

    var version = 0
    var versionError = ""
    runCatching { cls.getMethod("getVersion").invoke(null) as? Int ?: 0 }
      .onSuccess { version = it }
      .onFailure { versionError = it.javaClass.simpleName + ": " + (it.message ?: "") }
    out.put("version", version)
    if (version in 1..11) {
      return out.put("ok", false).put("code", "shizuku-prev11")
        .put("guidance", "Shizuku 版本过低（v" + version + "，需要 v12+ 才有 bindUserService 等能力）。请升级 Shizuku。")
    }
    if (version == 0 && versionError.isNotEmpty()) {
      return out.put("ok", false).put("code", "shizuku-prev11")
        .put("guidance", "读不到 Shizuku 版本（" + versionError + "）：按 v12+ 以下处理，请升级后重试。")
    }

    val granted = runCatching {
      cls.getMethod("checkSelfPermission").invoke(null) as? Boolean ?: false
    }.getOrDefault(false)
    out.put("granted", granted)

    val uid = runCatching { cls.getMethod("getUid").invoke(null) as? Int ?: -1 }.getOrDefault(-1)
    out.put("uid", uid)
    if (!granted) {
      return out.put("ok", false).put("code", "shizuku-denied")
        .put("guidance", "本应用尚未获得 Shizuku 授权：请在 Shizuku App 的「已授权应用」里授予本应用"
          + "（本项目只读、只引导，不代授）。uids=" + uid + "。")
    }
    // shell(2000) 是虚拟屏主路的执行身份；root(0) 亦可用但本方案不依赖。
    val identity = when (uid) {
      2000 -> "shell"
      0 -> "root"
      else -> "uid=$uid"
    }
    return out.put("ok", true).put("identity", identity).put("code", "shizuku-ok")
      .put("guidance", "Shizuku 就绪（identity=" + identity + "，v" + version + "）。")
  }

}
