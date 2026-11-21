package com.dsharnessmobile.shell

import android.graphics.Rect
import android.os.Build
import android.view.Window
import android.widget.FrameLayout

/** Measure keyboard overlap in window pixels. The page owns how it uses this space. */
internal class MainWebImeLayout(
  private val window: Window,
  private val root: FrameLayout,
) {
  private val location = IntArray(2)
  private val visibleFrame = Rect()
  private var windowHeight = 0
  private var rootBottom = 0

  // Cache the coordinate space outside the per-frame IME callback.
  fun refreshWindowBounds() {
    if (Build.VERSION.SDK_INT >= 30) {
      windowHeight = window.windowManager.currentWindowMetrics.bounds.height()
      root.getLocationInWindow(location)
    } else {
      root.getLocationOnScreen(location)
      root.getWindowVisibleDisplayFrame(visibleFrame)
    }
    rootBottom = location[1] + root.height
  }

  fun overlap(imeBottom: Int): Int {
    val visibleBottom = if (Build.VERSION.SDK_INT >= 30) windowHeight - imeBottom else visibleFrame.bottom
    return remainingImeOverlap(rootBottom, visibleBottom, imeBottom)
  }
}

internal fun remainingImeOverlap(rootBottom: Int, visibleBottom: Int, imeBottom: Int): Int =
  if (imeBottom <= 0 || visibleBottom <= 0) 0 else (rootBottom - visibleBottom).coerceIn(0, imeBottom)
