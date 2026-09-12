package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ST-13（F-APK-03）回归：mux 握手非 101 时按状态码走鉴权刷新，且刷新不得被缓存短路。
 *
 * 缺陷形态：① `connectAndServe` 只 throw——重连循环拿着服务端已作废、本地仍未过期的 cookie
 * 无限重试（要重启 App 才恢复）；② `refresh()` 开头的 `cookie(app)?.let { return it }` 会把
 * 被拒 cookie 原样返回，让 handleUnauthorized 形同空转。
 */
class MuxHandshakeAuthTest {

  @Test
  fun handshakeStatusCodeIsParsedFromTheStatusLine() {
    assertEquals(101, muxHandshakeStatusCode("HTTP/1.1 101 Switching Protocols"))
    assertEquals(401, muxHandshakeStatusCode("HTTP/1.1 401 Unauthorized"))
    assertEquals(403, muxHandshakeStatusCode("HTTP/1.1 403 Forbidden"))
    assertEquals(404, muxHandshakeStatusCode("HTTP/1.1 404 Not Found"))
    assertEquals(500, muxHandshakeStatusCode("HTTP/1.1 500 Internal Server Error"))
    assertEquals("解析不出不得被当成鉴权失败", 0, muxHandshakeStatusCode("garbage"))
    assertEquals(0, muxHandshakeStatusCode(""))
  }

  @Test
  fun onlyAuthRefusalsTriggerTheCookieRefresh() {
    assertTrue(muxRefusalNeedsAuthRefresh(401))
    assertTrue(muxRefusalNeedsAuthRefresh(403))
    assertFalse("101 是成功握手，不刷新", muxRefusalNeedsAuthRefresh(101))
    assertFalse("路径/网关错误与 cookie 无关，不白换 cookie", muxRefusalNeedsAuthRefresh(404))
    assertFalse(muxRefusalNeedsAuthRefresh(500))
  }

  @Test
  fun forcedRefreshNeverShortCircuitsOnACachedCookie() {
    val cookie = "dsh-auth-abc=v1.payload.sig"
    assertFalse(
      "force（401/403 后）必须忽略本地仍「未过期」的缓存 cookie",
      EngineAuth.mayReuseCachedCookie(true, cookie),
    )
    assertTrue(EngineAuth.mayReuseCachedCookie(false, cookie))
    assertFalse(EngineAuth.mayReuseCachedCookie(false, null))
  }
}
