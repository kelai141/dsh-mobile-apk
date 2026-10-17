package com.dsharnessmobile.shell

import android.os.Handler
import android.os.Looper
import android.view.SurfaceHolder
import android.view.View
import android.view.SurfaceView
import android.webkit.WebView
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Native SurfaceView projected over the trusted virtual-screen sidebar stage.
 *
 * The page supplies CSS-pixel geometry only from the DSH WebView. This host maps it to the root
 * frame, owns the Surface lifecycle, and never gives the displayed third-party activity a bridge.
 *
 * 0.14.0 batch: each host instance owns one viewer id, publishes independent bounds (including the
 * controller-owned presentation target), and binds its surface through
 * [VdisplayController.attachViewerSurface] so one Surface is never silently attached to two viewers.
 * Closing the stage releases ownership without destroying the display or its task; reopening binds
 * the same viewer id again and reattaches the surface.
 */
internal class VdisplayHost(
  private val root: FrameLayout,
  private val dshWebView: WebView,
) {
  private data class StageBounds(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
    val visible: Boolean,
    val target: String?,
    val viewerId: String?,
  )

  /** Stable per-instance viewer identity: two Activities in multi-window get distinct owners. */
  private val viewerId = "viewer-" + Integer.toHexString(System.identityHashCode(this))
  private val main = Handler(Looper.getMainLooper())
  private var view: SurfaceView? = null
  private var stageBounds: StageBounds? = null
  private var stageVisible = false
  private var attached = false
  private var lastReason = ""
  private val rootLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyStageBounds() }

  init { root.addOnLayoutChangeListener(rootLayoutListener) }

  fun setStageBounds(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      val bounds = StageBounds(
        left = value.optDouble("left", 0.0),
        top = value.optDouble("top", 0.0),
        width = value.optDouble("width", 0.0),
        height = value.optDouble("height", 0.0),
        viewportWidth = value.optDouble("viewportWidth", 0.0),
        viewportHeight = value.optDouble("viewportHeight", 0.0),
        visible = value.optBoolean("visible", false),
        target = value.optString("target", "").takeIf { it.isNotBlank() },
        viewerId = value.optString("viewerId", "").takeIf { it.isNotBlank() },
      )
      stageBounds = bounds
      VdisplayController.setViewerBounds(viewerId, value)
      if (!bounds.visible) {
        releaseSurface()
      } else {
        ensureView()
      }
      applyStageBounds()
      JSONObject().put("ok", true).put("visible", stageVisible)
        .put("presenting", attached)
        .put("viewerId", viewerId)
        .put("reason", lastReason)
        .toString()
    } catch (t: Throwable) {
      JSONObject().put("ok", false).put("reason", "invalid-vdisplay-stage-bounds")
        .put("detail", t.javaClass.simpleName).toString()
    }
  } ?: JSONObject().put("ok", false).put("reason", "main-thread-timeout").toString()

  fun destroy() {
    onMain {
      root.removeOnLayoutChangeListener(rootLayoutListener)
      releaseSurface()
      view?.let { surface ->
        surface.holder.removeCallback(callback)
        root.removeView(surface)
      }
      view = null
      Unit
    }
  }

  /** 退后台：交出 Surface 给浮窗，但保留视图与几何（回前台可原样恢复）。 */
  fun detachForBackground() {
    onMain {
      releaseSurface()
      Unit
    }
  }

  /** 回前台：视图与几何仍在且 Surface 有效时重新绑定侧栏工位。 */
  fun reattach() {
    onMain {
      val surface = view?.holder?.surface
      if (stageBounds?.visible == true && surface != null && surface.isValid && !attached) {
        bindSurface(surface)
      }
      Unit
    }
  }

  private val callback = object : SurfaceHolder.Callback {
    override fun surfaceCreated(holder: SurfaceHolder) { bindSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
      if (width > 0 && height > 0) {
        if (attached) VdisplayController.attachViewerSurface(root.context, viewerId, stageBounds?.target, holder.surface)
        else bindSurface(holder.surface)
      }
    }
    override fun surfaceDestroyed(holder: SurfaceHolder) { releaseSurface() }
  }

  /**
   * Bind this viewer's surface to the requested target. On `viewer-target-occupied` the stage stays
   * hidden and reports the arbitration reason instead of stealing the surface.
   */
  private fun bindSurface(surface: android.view.Surface) {
    val result = VdisplayController.attachViewerSurface(root.context, viewerId, stageBounds?.target, surface)
    attached = result.optBoolean("ok")
    lastReason = if (attached) "" else result.optString("code", "attach-failed")
    if (!attached) view?.visibility = View.GONE
  }

  private fun releaseSurface() {
    if (!attached) return
    VdisplayController.releaseViewerSurface(root.context, viewerId)
    attached = false
  }

  private fun ensureView(): SurfaceView {
    view?.let { return it }
    return SurfaceView(root.context).also { created ->
      created.visibility = View.GONE
      created.holder.addCallback(callback)
      root.addView(created, FrameLayout.LayoutParams(1, 1))
      view = created
    }
  }

  private fun applyStageBounds() {
    val bounds = stageBounds
    val cssWidth = bounds?.viewportWidth ?: 0.0
    val cssHeight = bounds?.viewportHeight ?: 0.0
    if (bounds == null || !bounds.visible || cssWidth <= 0.0 || cssHeight <= 0.0 ||
      bounds.width <= 1.0 || bounds.height <= 1.0 || root.width <= 0 || root.height <= 0 ||
      dshWebView.width <= 0 || dshWebView.height <= 0
    ) {
      stageVisible = false
      view?.visibility = View.GONE
      return
    }
    val surface = ensureView()
    val scaleX = dshWebView.width.toDouble() / cssWidth
    val scaleY = dshWebView.height.toDouble() / cssHeight
    val stageLeft = (bounds.left * scaleX).toInt().coerceIn(0, (root.width - 1).coerceAtLeast(0))
    val stageTop = (bounds.top * scaleY).toInt().coerceIn(0, (root.height - 1).coerceAtLeast(0))
    val stageWidth = (bounds.width * scaleX).toInt().coerceIn(1, (root.width - stageLeft).coerceAtLeast(1))
    val stageHeight = (bounds.height * scaleY).toInt().coerceIn(1, (root.height - stageTop).coerceAtLeast(1))
    // 等比适配（0.14.0 设备实测修正）：虚拟屏内容有自己的宽高比（如 360x640 = 0.5625），
    // 与侧栏舞台的宽高比（如 434x682 = 0.6363）通常不同。直接撑满舞台会让内容只渲染在
    // 自己那部分、其余留黑边（用户报「未自动拉伸适配」+「黑边」）。
    //
    // 正确做法：按**内容宽高比**在舞台内尽力放大（用 scale 的最小值保证不溢出、不裁剪），
    // 再在舞台内居中。这是 letterbox 的适配方向——宁可留对称的窄边，也绝不拉伸变形。
    val content = VdisplayController.contentSizeForAlias(bounds.target)
    val contentAspect = if (content != null && content.first > 0 && content.second > 0) {
      content.first.toDouble() / content.second.toDouble()
    } else {
      stageWidth.toDouble() / stageHeight.toDouble()
    }
    // 等比适配（0.14.8 设备实测修正，用户报「虚拟屏比例不对」）：旧式把宽高比又当宽度基准，
    // 在「舞台比内容更高」时算出 width < stageWidth 且 height < stageHeight 的双向留边，
    // 画面缩在中间一条窄带（实测内容 288x640 = 0.45、舞台 344x654 = 0.526：旧式宽 294，
    // 左右各留 25px，用户看到的就是「内容只占一半、另一半黑」）。
    // 正确做法：按「宽受限 / 高受限」显式二选一，绝不双向留边。
    val byWidth = stageWidth.toDouble() / contentAspect
    val byHeight = stageHeight.toDouble() * contentAspect
    val useHeight = byWidth > stageHeight
    val width = (if (useHeight) byHeight else stageWidth.toDouble()).toInt()
      .coerceIn(1, (root.width - stageLeft).coerceAtLeast(1))
    val height = (if (useHeight) stageHeight.toDouble() else byWidth).toInt()
      .coerceIn(1, (root.height - stageTop).coerceAtLeast(1))
    // 居中：把等比后的内容摆在舞台中央（两侧/上下对称留边，而不是全部堆在左侧）。
    val left = stageLeft + (stageWidth - width) / 2
    val top = stageTop + (stageHeight - height) / 2
    surface.layoutParams = FrameLayout.LayoutParams(width, height).apply {
      leftMargin = left.coerceIn(0, (root.width - 1).coerceAtLeast(0))
      topMargin = top.coerceIn(0, (root.height - 1).coerceAtLeast(0))
    }
    // Make the SurfaceView visible so its Surface is created; binding/arbitration happens in
    // surfaceCreated. An occupied target is hidden again by bindSurface with a structured reason.
    stageVisible = true
    surface.visibility = View.VISIBLE
    // Retry path: if a previous bind was refused (target occupied or not yet created), the next
    // trusted bounds publication retries once the display is free again.
    if (!attached) surface.holder.surface?.takeIf { it.isValid }?.let { bindSurface(it) }
  }

  private fun <T> onMain(block: () -> T): T? {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    main.post { try { result = block() } finally { latch.countDown() } }
    return if (latch.await(2, TimeUnit.SECONDS)) result else null
  }
}
