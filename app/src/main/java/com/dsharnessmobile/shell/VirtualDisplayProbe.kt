package com.dsharnessmobile.shell

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject

/**
 * VirtualDisplay flag 位值（本文件本地常量，**故意不引用 DisplayManager.VIRTUAL_DISPLAY_FLAG_***）。
 *
 * 原因（2026-09-12 编译阻断实修）：其中 SUPPORTS_TOUCH / DESTROY_CONTENT_ON_REMOVAL / TRUSTED /
 * ALWAYS_UNLOCKED 在公开 android.jar 里不可见（AOSP 标 @hide/@SystemApi），应用态引用
 * DisplayManager.VIRTUAL_DISPLAY_FLAG_* 会 Unresolved reference（整棵 Kotlin 树编译直接断）。
 * 位值取自 AOSP android.hardware.display.DisplayManager（A14 副本
 * docs/review/20260911-vdisplay/_aosp/android-14.0.0_r1/DisplayManager.java:218-439）：
 *   PUBLIC=1<<0 / OWN_CONTENT_ONLY=1<<3 / AUTO_MIRROR=1<<4 / SUPPORTS_TOUCH=1<<6 /
 *   DESTROY_CONTENT_ON_REMOVAL=1<<8 / TRUSTED=1<<10 / ALWAYS_UNLOCKED=1<<12
 * 位值随 VirtualDisplayConfig 进 binder，属平台 ABI，跨版本稳定。
 */
private const val FLAG_PUBLIC = 1 shl 0
private const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
private const val FLAG_AUTO_MIRROR = 1 shl 4
private const val FLAG_SUPPORTS_TOUCH = 1 shl 6
private const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
private const val FLAG_TRUSTED = 1 shl 10
private const val FLAG_ALWAYS_UNLOCKED = 1 shl 12

/**
 * 虚拟屏建屏矩阵探针（0.14.0 迭代「虚拟屏」线 S2；对应 P0-6 / S-AC-12 / S-AC-13）。
 *
 * 定位：
 *  - **只读探测**：建屏 → 记录结果 → 立即 release；不改任何开关、不写授权、不落盘。
 *  - **debug-only**：release 构建直接返回结构化拒绝（不暴露探针面）。
 *  - **必须由后台线程调用**：createVirtualDisplay 是 binder 调用，主线程调用有 StrictMode/ANR 风险。
 *  - **私有屏对照项必跑**：S-AC-13 要求复现「私有屏不被无障碍承认」；本探针负责把私有屏建出来，
 *    a11y 侧是否可见由 P0-9 在开启无障碍后单独验证（本文件不做 a11y 判定，避免越界下结论）。
 *
 * flag 依据（源文档 §6.1 闸门台账）：PUBLIC 单用会隐式带上 AUTO_MIRROR（需 CAPTURE_VIDEO_OUTPUT）；
 * PUBLIC|OWN_CONTENT_ONLY 是清掉该权限要求后的「公开但只显示自己内容」正解。
 * TRUSTED 需 ADD_TRUSTED_DISPLAY（本机矩阵实测 shell 未授予，预期 SecurityException）。
 */
object VirtualDisplayProbe {

  /**
   * 一个待测 flag 组合。
   * @param key 结果里的稳定键（勿改：报告与门禁按它对齐）
   * @param flags 传给 createVirtualDisplay 的 flag 位或
   * @param note 该组合的预期语义（写进结果，便于报告自解释）
   */
  data class Combo(val key: String, val flags: Int, val note: String)

  /** 主路正解 + 对照项（顺序即报告顺序）。 */
  fun combos(): List<Combo> = listOf(
    Combo(
      "public_own_content_touch",
      FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH,
      "主路正解：公开但只显示自己内容（不需要任何投影权限）",
    ),
    Combo(
      "trusted",
      FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_TRUSTED,
      "预期 SecurityException：TRUSTED 需 ADD_TRUSTED_DISPLAY（本机矩阵实测未授予）",
    ),
    Combo(
      "private_only",
      FLAG_OWN_CONTENT_ONLY,
      "S-AC-13 私有屏对照：不带 PUBLIC；无障碍侧可见性由 P0-9 另验",
    ),
    Combo(
      "auto_mirror",
      FLAG_PUBLIC or FLAG_AUTO_MIRROR,
      "预期拒绝：AUTO_MIRROR（镜像真屏）需 CAPTURE_VIDEO_OUTPUT（普通应用无）",
    ),
    Combo(
      "destroy_on_removal",
      FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_DESTROY_CONTENT_ON_REMOVAL,
      "S-AC-15：移除即销毁（推荐语义；不设该 flag 时第三方任务会被搬到主屏抢焦点）",
    ),
    Combo(
      "always_unlocked",
      FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_ALWAYS_UNLOCKED,
      "预期在无 display group 时被静默忽略（源文档 §6.2 注记）",
    ),
  )

  /**
   * 跑完整矩阵。
   * @param context 应用上下文
   * @param width 虚拟屏宽（默认小尺寸，减少合成开销）
   * @param height 虚拟屏高
   * @param dpi 虚拟屏密度
   * @return JSON：{ ok, displayCountBefore, displayCountAfter, results: [...] }；每项含
   *   key/flags/created/displayId/error/elapsedMs/note
   */
  fun runMatrix(context: Context, width: Int = 480, height: Int = 800, dpi: Int = 160): JSONObject {
    val out = JSONObject()
    if (!BuildConfig.DEBUG) {
      return out.put("ok", false).put("code", "probe-disabled-non-debug")
        .put("guidance", "建屏矩阵探针仅在 debug 构建可用（release 不暴露探针面）。")
    }
    val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    out.put("displayCountBefore", dm.displays.size)
    val results = JSONArray()
    for (combo in combos()) {
      results.put(runOne(dm, combo, width, height, dpi))
    }
    out.put("displayCountAfter", dm.displays.size)
    out.put("results", results)
    out.put("ok", true)
    return out
  }

  private fun runOne(dm: DisplayManager, combo: Combo, width: Int, height: Int, dpi: Int): JSONObject {
    val startedAt = System.nanoTime()
    val row = JSONObject().put("key", combo.key).put("flags", combo.flags).put("note", combo.note)
    var vd: VirtualDisplay? = null
    try {
      // surface=null：只验证 display 本体能否建立，不做像素输出（画面路径是 P0-10 的独立探针）。
      vd = dm.createVirtualDisplay(
        "dsh-vd-probe-" + combo.key,
        width,
        height,
        dpi,
        null as Surface?,
        combo.flags,
      )
      row.put("created", vd != null)
      row.put("displayId", vd?.display?.displayId ?: -1)
    } catch (security: SecurityException) {
      row.put("created", false)
      row.put("errorClass", security.javaClass.name)
      row.put("error", security.message ?: "")
      row.put("deniedFlagHint", combo.key)
    } catch (other: Throwable) {
      row.put("created", false)
      row.put("errorClass", other.javaClass.name)
      row.put("error", other.message ?: "")
    } finally {
      runCatching { vd?.release() }
      row.put("elapsedMs", (System.nanoTime() - startedAt) / 1_000_000)
    }
    return row
  }
}
