package com.dsharnessmobile.shell

import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.Window
import android.widget.FrameLayout

/** Resize the main WebView to the part of the Activity window above the IME. */
internal class MainWebImeLayout(
  private val window: Window,
  private val root: FrameLayout,
  private val webView: View,
) {
  private val location = IntArray(2)
  private val visibleFrame = Rect()
  private var imeBottom = 0
  private var windowHeight = 0

  init {
    root.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
      if (left != oldLeft || top != oldTop || right != oldRight || bottom != oldBottom) {
        refreshWindowBounds()
        layout()
      }
    }
  }

  // Window metrics can query WindowManager. Refresh on bounds/insets changes, outside IME progress.
  fun refreshWindowBounds() {
    if (Build.VERSION.SDK_INT >= 30) {
      windowHeight = window.windowManager.currentWindowMetrics.bounds.height()
    }
  }

  fun update(bottom: Int) {
    imeBottom = bottom
    layout()
  }

  private fun layout() {
    if (root.height == 0) return
    val margin = when {
      imeBottom <= 0 -> 0
      Build.VERSION.SDK_INT >= 30 -> {
        // Metrics are window-local here. The root may already have been
        // partly resized by the system, especially in freeform windows.
        root.getLocationInWindow(location)
        val keyboardTop = windowHeight - imeBottom
        remainingImeOverlap(location[1] + root.height, keyboardTop, imeBottom)
      }
      else -> {
        root.getLocationOnScreen(location)
        root.getWindowVisibleDisplayFrame(visibleFrame)
        remainingImeOverlap(location[1] + root.height, visibleFrame.bottom, imeBottom)
      }
    }
    val params = webView.layoutParams as FrameLayout.LayoutParams
    if (params.bottomMargin != margin) {
      params.bottomMargin = margin
      webView.layoutParams = params
    }
  }
}

internal fun remainingImeOverlap(rootBottom: Int, visibleBottom: Int, imeBottom: Int): Int =
  if (imeBottom <= 0 || visibleBottom <= 0) 0 else (rootBottom - visibleBottom).coerceIn(0, imeBottom)
