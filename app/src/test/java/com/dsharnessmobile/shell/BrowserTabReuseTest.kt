package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** issue #1318：同 URL 的新开请求必须复用已有标签，不得无限新建。 */
class BrowserTabReuseTest {

  private val tabs = listOf(
    "tab-1" to "https://example.com/a",
    "tab-2" to "https://example.com/b",
  )

  @Test
  fun sameUrlIsReusedInsteadOfOpeningANewTab() {
    assertEquals(
      "同 URL 必须复用 tab-2，而不是再开一个",
      "tab-2",
      BrowserTabReuse.reusableTabId(
        wantsNewTab = true, requestedTabId = null,
        targetUrl = "https://example.com/b", existingTabs = tabs,
      ),
    )
  }

  @Test
  fun differentUrlStillOpensANewTab() {
    assertNull(
      "没见过的 URL 应当新建",
      BrowserTabReuse.reusableTabId(
        wantsNewTab = true, requestedTabId = null,
        targetUrl = "https://example.com/c", existingTabs = tabs,
      ),
    )
  }

  @Test
  fun explicitTabIdWinsOverReuse() {
    assertNull(
      "点名了标签就按点名走：意图优先于去重",
      BrowserTabReuse.reusableTabId(
        wantsNewTab = true, requestedTabId = "tab-9",
        targetUrl = "https://example.com/b", existingTabs = tabs,
      ),
    )
  }

  @Test
  fun withoutNewTabIntentNothingIsReused() {
    assertNull(
      "没要求新开时不该由这里决定复用（走默认标签路径）",
      BrowserTabReuse.reusableTabId(
        wantsNewTab = false, requestedTabId = null,
        targetUrl = "https://example.com/b", existingTabs = tabs,
      ),
    )
  }

  @Test
  fun unnormalizableUrlNeverReuses() {
    assertNull(
      "规范化失败（null）时不得误判为复用",
      BrowserTabReuse.reusableTabId(
        wantsNewTab = true, requestedTabId = null,
        targetUrl = null, existingTabs = tabs,
      ),
    )
  }
}