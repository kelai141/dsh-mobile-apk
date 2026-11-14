package com.dsharnessmobile.shell

import android.view.View
import android.view.WindowManager

/**
 * 悬浮窗口持有者（Phase 2「entry_ui_v2」的窗口纪律唯一收口点）。
 *
 * 为什么需要它：旧实现把 4 个窗口的 add/remove/update 散落在服务与三个协作类里，任何一处
 * 漏掉 `removeView` 就是残窗，而残窗在 WindowManager 里**照样吃触摸**（0.13.2「互吞」根治结论：
 * 不可见不等于不命中，见 docs/0.14.9-preview-OVERLAY-BALL-HIDE.md §2）。窗口数量从 4 涨到 6 之后，
 * 「谁加的谁收」这种口头纪律不再可靠，必须有一个持有者同时负责：
 *  1) 单槽唯一：同一槽位重复 add 时先移除旧视图，杜绝同槽双窗；
 *  2) 失败可回执：addView 抛异常时返回 false 并记日志——旧实现在 showPanel() 里
 *     `try { wm.addView(unit, pp) } catch (_: Exception) {}` 吞掉失败，而 `expanded` 已经置 true，
 *     用户视角就是「点球没反应」（Phase 1 登记的 P0-2 缺陷）；
 *  3) z 序可断言：槽位自带 zIndex，[slots] 按**实际添加顺序**返回，契约测试据此钉住
 *     「光环 → 入口 → 卡片 → 药丸 → 输入」的顺序（同类型 overlay 窗口按添加顺序叠、后加者在上）。
 *
 * 线程纪律：全部方法只允许在主线程调用（WindowManager 只在主线程安全）。
 * 失败不抛出：调用方按返回值决定是否回滚自身状态，异常只走日志。
 */
internal class OverlayWindows(
  private val wm: WindowManager,
  private val log: (String) -> Unit,
) {

  /**
   * 窗口槽位。zIndex 是**目标**叠放顺序（数值大者在上），同时用于检测调用方是否按纪律添加。
   *
   * RECALL 排在 ENTRY 之后：召回条与入口不会同屏（隐藏态只有召回条），zIndex 只表达
   * 「两者都在时必须谁在上」这一条不存在的情形；真正决定观感的是互斥移除。
   */
  internal enum class Slot(val label: String, val zIndex: Int) {
    HALO("halo", 0),
    ENTRY("entry", 1),
    RECALL("recall", 2),
    CARD("card", 3),
    PILL("pill", 4),
    COMPOSER("composer", 5),
    WORKSPACE("workspace", 6),
    SESSION("session", 7),
    DRAWER("drawer", 8),
  }

  private class Held(val view: View, val params: WindowManager.LayoutParams)

  private val held = LinkedHashMap<Slot, Held>()

  /** 添加窗口。已存在同槽视图时：同一视图 -> 只更新参数；不同视图 -> 先移除再添加。 */
  internal fun add(slot: Slot, view: View, params: WindowManager.LayoutParams): Boolean {
    val existing = held[slot]
    if (existing != null) {
      if (existing.view === view) return update(slot, params)
      remove(slot)
    }
    return try {
      params.title = "dsh-overlay-v2-" + slot.label
      // 几何函数已扣系统栏；WMS再fit会把卡片状态栏算两遍，并使药丸y=0到不了物理顶缘。
      if (slot != Slot.COMPOSER && slot != Slot.DRAWER) {
        if (android.os.Build.VERSION.SDK_INT >= 30) params.setFitInsetsTypes(0)
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
      }
      wm.addView(view, params)
      held[slot] = Held(view, params)
      if (orderViolation()) {
        log("window z-order violation after add " + slot.label + ": " + slots().joinToString(",") { it.label })
      }
      true
    } catch (t: Throwable) {
      log("addWindow failed slot=" + slot.label + " err=" + t.javaClass.simpleName + " " + (t.message ?: ""))
      false
    }
  }

  /** 更新窗口布局参数。窗口不在持有者里时返回 false（调用方据此不做后续动画）。 */
  internal fun update(slot: Slot, params: WindowManager.LayoutParams): Boolean {
    val h = held[slot] ?: return false
    return try {
      wm.updateViewLayout(h.view, params)
      held[slot] = Held(h.view, params)
      true
    } catch (t: Throwable) {
      log("updateWindow failed slot=" + slot.label + " err=" + t.javaClass.simpleName + " " + (t.message ?: ""))
      false
    }
  }

  /** A same-view lease: no detach/re-add and no draft or focus selection writes. */
  internal class InteractionLease internal constructor(internal val entries: List<InteractionEntry>)
  internal class InteractionEntry internal constructor(
    internal val slot: Slot, internal val view: View, internal val flags: Int, internal val alpha: Float,
  )

  internal var pendingInteractionRestore: InteractionLease? = null
    private set

  internal fun yieldInteraction(): InteractionLease? {
    val entries = held.map { (slot, h) -> InteractionEntry(slot, h.view, h.params.flags, h.params.alpha) }
    val lease = InteractionLease(entries)
    for (entry in entries) {
      val params = held[entry.slot]?.params ?: continue
      params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
      // Android 12+ blocks touches through opaque untrusted overlays even with NOT_TOUCHABLE.
      // Nine slots at .15 have combined opacity < .8. Keep windows visible, never hide/remove.
      params.alpha = minOf(entry.alpha, .15f)
      if (!update(entry.slot, params)) {
        pendingInteractionRestore = lease
        if (restoreInteraction(lease)) pendingInteractionRestore = null
        return null // The picker must not start unless EVERY existing window yielded successfully.
      }
    }
    return lease
  }

  internal fun restoreInteraction(lease: InteractionLease): Boolean {
    var restored = true
    for (entry in lease.entries) {
      val current = held[entry.slot] ?: continue
      if (current.view !== entry.view) continue // A late result must not mutate a replacement window.
      val oldFlags = current.params.flags; val oldAlpha = current.params.alpha
      current.params.flags = entry.flags
      current.params.alpha = entry.alpha
      if (!update(entry.slot, current.params)) {
        current.params.flags = oldFlags; current.params.alpha = oldAlpha
        restored = false
      }
    }
    if (restored && pendingInteractionRestore === lease) pendingInteractionRestore = null
    return restored
  }

  /** 移除窗口（幂等）。窗口本来就不在持有者里时返回 false。 */
  internal fun remove(slot: Slot): Boolean {
    val h = held.remove(slot) ?: return false
    return try {
      wm.removeView(h.view)
      true
    } catch (t: Throwable) {
      // 视图已被系统回收（如权限撤回后 WMS 自行移除）时抛 BadTokenException/IllegalArgumentException：
      // 这是「已经不在」，不是失败——持有者本地记录已经同步清掉，不再向调用方放大。
      log("removeWindow skipped slot=" + slot.label + " err=" + t.javaClass.simpleName)
      true
    }
  }

  internal fun contains(slot: Slot): Boolean = held.containsKey(slot)

  internal fun view(slot: Slot): View? = held[slot]?.view

  internal fun params(slot: Slot): WindowManager.LayoutParams? = held[slot]?.params

  /** 按实际添加顺序返回槽位（= 当前 z 序，从下到上）。 */
  internal fun slots(): List<Slot> = held.keys.toList()

  internal fun count(): Int = held.size

  /** 逐个移除全部窗口（服务 onDestroy 收口）。返回移除数量。 */
  internal fun removeAll(): Int {
    val slots = held.keys.toList()
    var removed = 0
    for (s in slots) if (remove(s)) removed++
    return removed
  }

  /**
   * 当前添加顺序是否违反既定 z 序（重排后 zIndex 必须单调不减）。
   *
   * 注意：**违反不修正**——修正唯一可行的办法是整个拆掉重加（会闪、会丢焦点），
   * 所以这里只记录。契约测试断言它为 false，等于把「不许乱序 add」变成可测事实。
   */
  internal fun orderViolation(): Boolean = orderViolationOf(held.keys.toList())

  internal companion object {
    /**
     * z 序纪律的**纯判据**（JVM 可直接测，不需要真实 WindowManager）：
     * 给定实际添加顺序，返回它是否违反既定叠放顺序（zIndex 必须单调不减）。
     */
    internal fun orderViolationOf(slots: List<Slot>): Boolean {
      var last = -1
      for (slot in slots) {
        if (slot.zIndex < last) return true
        last = slot.zIndex
      }
      return false
    }
  }
}
