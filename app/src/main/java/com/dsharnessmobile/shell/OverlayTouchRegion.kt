package com.dsharnessmobile.shell

import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Region
import android.os.Build
import android.view.AttachedSurfaceControl
import android.view.View
import android.view.ViewGroup
import androidx.annotation.RequiresApi
import androidx.annotation.UiThread
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Public input-region API, independent of drawing clips. API 26..32 needs bounded separate windows
 * or a V2-owned temporary NOT_TOUCHABLE/opacity lease during an already captured morph gesture.
 * This helper never changes flags, focus, window size or children. Android's implementation of
 * setTouchableRegion schedules a traversal internally; cache identical integer regions instead of
 * claiming this API is a draw-only SurfaceControl transaction. Composer uses it on layout changes;
 * API33 card morph uses it for changed integer rounded regions to avoid NOT_TOUCHABLE opacity caps.
 * There is no explicit history measure or WM resize here. Caller must separately validate Android
 * 12+ combined-obscuring-opacity behavior for actual pass-through to another UID.
 */
@UiThread
internal object OverlayTouchRegion {
  fun apply(view: View, region: Region): Boolean {
    if (Build.VERSION.SDK_INT < 33) return false
    if (!view.isAttachedToWindow || view.width <= 0 || view.height <= 0) return false
    return try {
      Api33.apply(view, region)
    } catch (_: RuntimeException) {
      Api33.forget(view)
      false
    } catch (_: LinkageError) {
      false
    }
  }

  fun forget(view: View) {
    if (Build.VERSION.SDK_INT >= 33) {
      try { Api33.forget(view) } catch (_: LinkageError) { /* Public API unavailable on this platform. */ }
    }
  }

  fun rounded(bounds: RectF, radiusPx: Float): Region {
    if (bounds.isEmpty) return Region()
    val radius = if (radiusPx.isFinite()) radiusPx.coerceIn(0f, minOf(bounds.width(), bounds.height()) / 2f) else 0f
    val clip = Region(
      kotlin.math.floor(bounds.left).toInt(), kotlin.math.floor(bounds.top).toInt(),
      kotlin.math.ceil(bounds.right).toInt(), kotlin.math.ceil(bounds.bottom).toInt(),
    )
    val path = Path().apply { addRoundRect(bounds, radius, radius, Path.Direction.CW) }
    return Region().apply { setPath(path, clip) }
  }

  /** Union only supplied visible surfaces, never the transparent common row/root rectangle. */
  fun unionRegions(root: ViewGroup, children: List<View>, radiusPx: (View) -> Float = { 0f }): Region {
    val union = Region()
    val clip = Region(0, 0, root.width.coerceAtLeast(0), root.height.coerceAtLeast(0))
    for (child in children) {
      if (child.visibility != View.VISIBLE || child.alpha <= 0f || !child.isShown || child.width <= 0 || child.height <= 0) continue
      val bounds = Rect(0, 0, child.width, child.height)
      // Static layout-aligned surfaces only: includes descendant offsets/scroll, not arbitrary matrices.
      root.offsetDescendantRectToMyCoords(child, bounds)
      val shape = rounded(RectF(bounds), radiusPx(child))
      shape.op(clip, Region.Op.INTERSECT)
      union.op(shape, Region.Op.UNION)
    }
    return union
  }

  @RequiresApi(33)
  private object Api33 {
    private class Applied(val surface: WeakReference<AttachedSurfaceControl>, val region: Region)
    private val applied = WeakHashMap<View, Applied>()

    fun apply(view: View, region: Region): Boolean {
      val surface = view.rootSurfaceControl ?: return false
      val previous = applied[view]
      if (previous?.surface?.get() === surface && previous.region == region) return true
      surface.setTouchableRegion(region)
      applied[view] = Applied(WeakReference(surface), Region(region))
      return true
    }

    fun forget(view: View) { applied.remove(view) }
  }
}
