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
 * 线程安全：换代方法各自 `@Synchronized`（独立监视器）。`retire` 在服务锁内调用，`adopt` 在动作
 * 路径锁外调用——两者不同源，所以不共用调用方的锁，也不在内部回头去取服务锁（避免锁序反转）。
 *
 * @param T 节点类型（生产环境是 `AccessibilityNodeInfo`；判据用假对象，故不绑死 Android 类型）。
 * @property sdkInt 设备 API 级别。**注入而非直读** `Build.VERSION.SDK_INT`：判据要能同时跑
 *   「API<33 必须回收」与「API≥33 不得调用」两个方向，直读静态字段只能测到跑测试的那一档
 *   （issue #1522）。放在末位参数之前、带默认值，是为了让生产调用点保持
 *   `GenerationalNodeRecycler<AccessibilityNodeInfo> { node -> node.recycle() }` 原样不变（尾随 lambda）。
 * @property recycle 真正的回收动作（生产环境 = `AccessibilityNodeInfo.recycle()`）。
 */
internal class GenerationalNodeRecycler<T : Any>(
  private val sdkInt: Int = android.os.Build.VERSION.SDK_INT,
  private val recycle: (T) -> Unit,
) {
  /**
   * `AccessibilityNodeInfo.recycle()` 在 API 33 起已降为 no-op（平台在 33 上取消了池化）。
   *
   * 判据取 `< 33` 而不是「总是调」：`#1361` 的提交说明承诺的是「API<33 上 recycle 仍是必须动作」，
   * 而无条件调用 + `runCatching` 静默会让这条承诺无法被证伪——API≥33 上调了也看不出来，
   * 回收失败也被吞掉（issue #1522）。
   */
  private val shouldRecycle: Boolean = sdkInt < 33

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
  @Synchronized
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
   * 收编**没有持有者**的临时节点（兜底重定位路径 `obtain` 出来的那些）：并入当前保留的一代，
   * 随下一次换代或 [drain] 真正回收（issue #1521）。
   *
   * 为什么不就地回收：动作路径把节点**带出锁**使用，立刻回收就是 use-after-recycle（#1510 的教训）。
   * 延迟一代与 `rowNodes` 同一个安全窗——兜底节点和快照节点本来就要活一样久。
   *
   * @returns 收编后的这一代实例总数。
   */
  @Synchronized
  fun adopt(vararg nodes: T?): Int {
    val merged = ArrayList<T>(retired)
    val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<T, Boolean>())
    for (node in merged) seen.add(node)
    for (node in nodes) {
      if (node == null) continue
      if (!seen.add(node)) continue
      merged.add(node)
    }
    retired = merged
    return merged.size
  }

  /**
   * 全部回收（服务销毁 / 快照清空时用）：连同当前保留的一代一起回收。
   *
   * @returns 本次真正回收的实例数。
   */
  @Synchronized
  fun drain(): Int {
    val previous = retired
    retired = emptyList()
    return recycleAll(previous)
  }

  private fun recycleAll(nodes: List<T>): Int {
    // API≥33：recycle() 已是 no-op，不调用；不把它算进 recycles，否则计数会谎报「回收了多少」。
    if (!shouldRecycle) return 0
    var count = 0
    for (node in nodes) {
      val failure = runCatching { recycle(node) }.exceptionOrNull()
      // 失败不得静默：吞掉之后无法从日志判断到底回收了没有（issue #1522）。
      if (failure != null) LogCollector.log("dsh-a11y", "节点回收失败（已跳过，不中断换代）：${failure.javaClass.simpleName}")
      recycles += 1
      count += 1
    }
    return count
  }
}
