package com.dsharnessmobile.shell

/**
 * tier-2（process-suffix，WebView<114 兼容档）投影的两条**纯判据**（issue #1574）。
 *
 * 缺陷形态（静态审查，现代内核不复现，所以设备验收抓不到）：
 *  - 前端续租是**强制发送**的：侧栏浏览器可见时每秒必到一次 `setStageBounds`，壳侧里
 *    `switchTo` 与 `applyStageBounds` 各调一次 ⇒ 每秒 2 次；tier-2 分支**没有几何去重**，
 *    无条件 `relayout` + `measureRemotePage`。relayout 落到远端 = `destroyProjection()` →
 *    `new SurfaceControlViewHost` → `setView` → `onSurfacePackage`，而宿主侧
 *    `surfacePackages[tabId] = pkg` 直接覆盖，**同 tabId 的旧包没有任何 release()**。
 *  - 后果：画面每秒拆建两次（首帧空白、持续抖动）、Surface 资源随在线时长线性增长
 *    （1 小时约 7200 个包）、`measureRemotePage` 的 `settleChase=2` 长期占用
 *    `PendingJsDrain` 的 64 条余量。
 *
 * 为什么判据要抽成纯对象：`applyStageBounds`/`layoutDetached`/`onSurfacePackage` 都要
 * Activity / Binder / SurfacePackage，JVM 单测直接调不到。把「要不要重排」与「旧包怎么退役」
 * 这两条**决策**抽出来，就能用假对象 + 计数 + 记录式 release 做行为判据（见
 * [RemoteProjectionPolicyTest]），而不是对源码文本切片断言。
 *
 * 语义边界：本对象只回答「这一次要不要把几何下推给渲染进程」与「被替换的旧包该不该释放」。
 * 投影本身怎么建（`SurfaceControlViewHost`）仍归 `BrowserProcessService`。
 */
internal object RemoteProjectionPolicy {

  /** 一次下推的四元组：宿主 SurfaceView 的落点与尺寸（px）。 */
  data class Geometry(val left: Int, val top: Int, val width: Int, val height: Int)

  /**
   * 几何是否变化到需要重新下推。
   *
   * @param previous 上一次**已成功下推**的几何；`null` = 从未下推（首次必须下推）。
   * @param next 本次算出的几何。
   * @returns true = 需要 `relayout` / 重设投影尺寸；false = 全等，跳过远端往返。
   */
  fun changed(previous: Geometry?, next: Geometry): Boolean = previous != next

  /**
   * 登记新投影包，并把**被它替换掉**的旧包交给 `release`。
   *
   * 为什么必须显式释放：`SurfacePackage` 持有跨进程 Surface 资源，只覆盖表项时 native 句柄
   * 不释放、渲染进程侧的 buffer 生产者也不会停（要等 GC 玄学回收）——这正是 issue #1574 的
   * 「Surface 资源随在线时长线性增长」。API 33+ 才有显式 [android.view.SurfaceControlViewHost.SurfacePackage.release]，
   * 调用方按版本决定 `release` 的实际动作（低版本传空实现即退化为旧行为，不假装释放过）。
   *
   * @param packages tabId → 当前包。
   * @param tabId 本次上报的页。
   * @param next 新包。
   * @param release 退役旧包的动作（仅当旧包存在且与新包**不是同一个对象**时调用）。
   * @returns 被退役的旧包（没有则 `null`），供调用方记账/断言。
   */
  fun <T : Any> replacePackage(
    packages: MutableMap<String, T>,
    tabId: String,
    next: T,
    release: (T) -> Unit,
  ): T? {
    val previous = packages.put(tabId, next)
    if (previous != null && previous !== next) release(previous)
    return previous?.takeIf { it !== next }
  }

  /** 页关闭/断线时的整批退役（与 [replacePackage] 同一口径，避免两处各写一遍）。 */
  fun <T : Any> releaseAll(packages: MutableMap<String, T>, release: (T) -> Unit) {
    for (pkg in packages.values) release(pkg)
    packages.clear()
  }
}
