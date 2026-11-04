package com.dsharnessmobile.shell

/**
 * 快照节点句柄的**延迟回收**（issue #1361，2026-11-04 维护者裁定方案 B）。
 *
 * 为什么不立即回收：动作路径把节点**带出锁**使用（`resolveTarget` 在锁内取句柄，`performAction`
 * 在锁外执行）。立即回收会让「重建」与「用户点击」竞争同一批句柄——API<33 上对已 recycle 的
 * 节点调 `performAction` 是未定义行为，且会被动作层解释成「页面已变化」，又变成一次假失败。
 *
 * 为什么不用「把 performAction 包进锁」：那等于让**每一次点击**与重建互斥，而重建是轮询触发的
 * 高频路径——为不存在的对手付代价，还会因锁内调 binder 拉长持锁时间。
 *
 * 因此：`retired` **只保留一代**。新一代到来时才把上一代真正回收 ⇒ 节点最多跨一次重建存活，
 * 内存不会长；动作即使跨锁，也有一代的时间窗。
 *
 * 回收按**实例去重**（`nodes` 与 `rowNodes` 共享同一批实例，`IdentityHashMap` 判等）。
 *
 * @param T 节点类型（生产环境是 `AccessibilityNodeInfo`；判据用假对象，故不绑死 Android 类型）。
 * @property recycle 真正的回收动作（生产环境 = `AccessibilityNodeInfo.recycle()`）。
 */
internal class GenerationalNodeRecycler<T : Any>(
  private val recycle: (T) -> Unit,
) {
  /** 上一代保留的节点（尚未回收）。 */
  private var retired: List<T> = emptyList()

  /** 累计真正调用过多少次 [recycle]（判据用来做计数断言）。 */
  var recycles: Int = 0
    private set

  /** 当前保留的一代里有多少个实例。 */
  fun retiredCount(): Int = retired.size

  /**
   * 换代：把**上一代**真正回收，本代成为唯一保留的一代。
   *
   * 多个集合会被求并集并按 identity 去重（对应 `nodes.values` + `rowNodes`——后者是前者的超集，
   * 传两个是为了在超集关系被将来的改动打破时仍不漏节点）。
   *
   * @returns 本次真正回收的实例数（0 = 还没有上一代）。
   */
  fun retire(vararg groups: Collection<T?>): Int {
    val previous = retired
    val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<T, Boolean>())
    val next = ArrayList<T>()
    for (group in groups) {
      for (node in group) {
        if (node == null) continue
        if (!seen.add(node)) continue
        next.add(node)
      }
    }
    retired = next
    return recycleAll(previous)
  }

  /**
   * 全部回收（服务销毁 / 快照清空时用）：连同当前保留的一代一起回收。
   *
   * @returns 本次真正回收的实例数。
   */
  fun drain(): Int {
    val previous = retired
    retired = emptyList()
    return recycleAll(previous)
  }

  private fun recycleAll(nodes: List<T>): Int {
    var count = 0
    for (node in nodes) {
      runCatching { recycle(node) }
      recycles += 1
      count += 1
    }
    return count
  }
}
