package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Public API/source wiring checks only: real input dispatch and opacity need device evidence. */
class OverlayTouchRegionTest {
  private fun source(name: String): String = listOf(
    File("src/main/java/com/dsharnessmobile/shell", name),
    File("app/src/main/java/com/dsharnessmobile/shell", name),
  ).first { it.isFile }.readText()

  @Test fun publicInputRegionIsApi33GuardedAndDoesNotResizeOrChangeFlags() {
    val helper = source("OverlayTouchRegion.kt")
    assertTrue(helper.contains("if (Build.VERSION.SDK_INT < 33) return false"))
    assertTrue(helper.contains("@RequiresApi(33)"))
    assertTrue(helper.contains("private object Api33"))
    assertTrue(helper.contains("view.rootSurfaceControl ?: return false"))
    assertTrue(helper.contains("surface.setTouchableRegion(region)"))
    assertTrue(helper.contains("catch (_: RuntimeException)"))
    assertTrue(helper.contains("catch (_: LinkageError)"))
    assertTrue(helper.contains("!view.isAttachedToWindow"))
    for (forbidden in listOf("requestLayout(", ".measure(", "updateViewLayout(", "addView(", "removeView(", "java.lang.reflect", "OnComputeInternalInsetsListener", "layoutParams")) assertFalse(forbidden, helper.contains(forbidden))
  }

  @Test fun sameSurfaceAndIntegerRegionAreCachedAndDetachedViewsCanBeForgotten() {
    val helper = source("OverlayTouchRegion.kt")
    assertTrue(helper.contains("WeakHashMap<View, Applied>"))
    assertTrue(helper.contains("previous?.surface?.get() === surface && previous.region == region"))
    assertTrue(helper.contains("Applied(WeakReference(surface), Region(region))"))
    assertTrue(helper.contains("fun forget(view: View)"))
  }

  @Test fun composerUnionUsesOnlySuppliedVisibleChildSurfacesNotTheirCommonRoot() {
    val helper = source("OverlayTouchRegion.kt")
    val union = helper.substringAfter("fun unionRegions(").substringBefore("@RequiresApi(33)")
    assertTrue(union.contains("val union = Region()"))
    assertTrue(union.contains("for (child in children)"))
    assertTrue(union.contains("child.visibility != View.VISIBLE || child.alpha <= 0f"))
    assertTrue(union.contains("!child.isShown"))
    assertTrue(union.contains("root.offsetDescendantRectToMyCoords(child, bounds)"))
    assertTrue(union.contains("rounded(RectF(bounds), radiusPx(child))"))
    assertTrue(union.contains("shape.op(clip, Region.Op.INTERSECT)"))
    assertTrue(union.contains("union.op(shape, Region.Op.UNION)"))
    assertFalse(union.contains("union.op(clip, Region.Op.UNION)"))
  }

  @Test fun cardUsesExactRoundedPublicRegionWithoutExplicitHistoryMeasureOrWindowResize() {
    val card = source("OverlayCardView.kt")
    val morph = card.substringAfter("fun applyMorph(").substringBefore("fun resetMorph()")
    assertTrue(morph.contains("updateMorphTouchableRegion()"))
    val region = card.substringAfter("fun updateMorphTouchableRegion()").substringBefore("fun setHandleOffsetPx(")
    assertTrue(region.contains("morphVisibleHeight(view.height)"))
    assertTrue(region.contains("OverlayTouchRegion.apply(view, OverlayTouchRegion.rounded(bounds, morphCornerRadius()))"))
    for (forbidden in listOf("requestLayout(", ".measure(", "updateViewLayout(", "FLAG_NOT_TOUCHABLE")) assertFalse(forbidden, region.contains(forbidden) || morph.contains(forbidden))
    assertTrue(card.contains("view.addOnLayoutChangeListener"))
    assertTrue(card.contains("OverlayTouchRegion.forget(view)"))
    val reset = card.substringAfter("fun resetMorph()").substringBefore("fun updateMorphTouchableRegion()")
    assertTrue(reset.contains("updateMorphTouchableRegion()"))
    val helper = source("OverlayTouchRegion.kt")
    assertTrue(helper.contains("internal layout") || helper.contains("traversal internally"))
    assertTrue(helper.contains("combined-obscuring-opacity"))
  }
}
