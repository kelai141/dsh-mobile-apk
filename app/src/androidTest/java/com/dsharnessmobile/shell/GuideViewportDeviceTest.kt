package com.dsharnessmobile.shell

import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Measure the production native startup view after repeated tablet/phone resizes. */
@RunWith(AndroidJUnit4::class)
class GuideViewportDeviceTest {
  @Test
  fun contentAndActionsFillThePaddedViewportAfterEveryResize() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        val chrome = buildGuideChrome(activity, GuideCallbacks(
          onStartEngine = {}, onOpenConsole = {}, onCheckUpdate = {}, onDownloadUpdate = {},
          onGrantStorage = {}, onCopyLog = {}, onShareLog = {},
        ))
        val root = chrome.root
        val gutter = activity.resources.getDimensionPixelSize(R.dimen.ds_guide_gutter)
        root.setPadding(gutter, gutter, gutter, gutter)
        root.visibility = View.VISIBLE
        for ((width, height) in listOf(3008 to 1880, 1880 to 3008, 2800 to 2000, 1080 to 2400, 3008 to 1880)) {
          // A second pass also exposes a listener that clamps widths after the first layout.
          repeat(2) {
            root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, width, height)
          }
          val available = width - gutter * 2
          assertEquals("brand at $width", available, chrome.brandBlock.width)
          assertEquals("status card at $width", available, chrome.cardBlock.width)
          assertEquals("bottom actions at $width", available, chrome.actionBlock.width)
        }
      }
    }
  }
}
