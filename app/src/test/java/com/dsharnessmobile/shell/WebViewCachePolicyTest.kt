package com.dsharnessmobile.shell

import android.webkit.WebSettings
import org.junit.Assert.assertEquals
import org.junit.Test

class WebViewCachePolicyTest {

  @Test
  fun legacyAndUnknownVersionsStayOnNoCache() {
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("", safeModeActive = false))
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("unknown", safeModeActive = false))
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("93.0.4577.82", safeModeActive = false))
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("99.0.4844.88", safeModeActive = false))
  }

  @Test
  fun modernChromiumUsesLayeredDefaultCacheOutsideSafeMode() {
    assertEquals(WebSettings.LOAD_DEFAULT, WebViewShim.engineHttpCacheMode("100.0.4896.127", safeModeActive = false))
    assertEquals(WebSettings.LOAD_DEFAULT, WebViewShim.engineHttpCacheMode("110.0.5481.154.1", safeModeActive = false))
    assertEquals(WebSettings.LOAD_DEFAULT, WebViewShim.engineHttpCacheMode("131.0.6778.100", safeModeActive = false))
  }

  @Test
  fun safeModeAlwaysForcesNoCacheEvenOnModernWebView() {
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("110.0.5481.154.1", safeModeActive = true))
    assertEquals(WebSettings.LOAD_NO_CACHE, WebViewShim.engineHttpCacheMode("131.0.6778.100", safeModeActive = true))
  }
}
