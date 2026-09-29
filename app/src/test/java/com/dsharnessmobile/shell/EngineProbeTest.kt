package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M.1（apk issue #272）的两条语义判据（纯 JVM，无 Robolectric）。
 *
 * 缺陷面：
 *  (a) 「3080 有东西在听」被当成「我们的引擎可用」⇒ EngineManager 静默 return true，
 *      不启动、不报错（用户永久进不去且界面无可辨提示）；
 *  (b) `check()` 把 401 与 200/303 一律算 running=true。无 cookie 时 GET / **本来就回 401**，
 *      于是「需要重新认证」被当成「健康」，壳侧自愈链永不触发。
 *
 * 判据全部抽成 [EngineProbe] 内的纯函数，故本测试不依赖设备/网络。
 */
class EngineProbeTest {

  // ── (a) 可用性四态 ──────────────────────────────────────────────────────────

  /**
  * 反证核心：端口可连但**没有任何归属证据**时，必须报 PORT_FOREIGN，不得报可用。
  *
  * 旧实现的等价形态是「端口可连 ⇒ running=true」，那正是本缺陷。
  */
  @Test
  fun `port reachable without ownership evidence is foreign not available`() {
    val state = EngineProbe.classifyEngineAvailability(
      httpCode = -1, managedAlive = false, logHasTokenLine = false, portReachable = true,
    )
    assertEquals("别的东西占着 3080 时必须报 PORT_FOREIGN", EngineProbe.EngineAvailability.PORT_FOREIGN, state)
    assertFalse("PORT_FOREIGN 不得被当成我们自己的引擎", state == EngineProbe.EngineAvailability.OUR_PROCESS)
    assertFalse("PORT_FOREIGN 不得被当成我们自己的引擎", state == EngineProbe.EngineAvailability.OUR_HTTP)
  }

  /** 托管子进程活着是最强证据（句柄在手，无需任何 HTTP 佐证）。 */
  @Test
  fun `managed process alive is our process even when http is silent`() {
    assertEquals(
      EngineProbe.EngineAvailability.OUR_PROCESS,
      EngineProbe.classifyEngineAvailability(httpCode = -1, managedAlive = true, logHasTokenLine = false, portReachable = false),
    )
  }

  /** 200/303 alone are ordinary HTTP observations, not ownership proof. */
  @Test
  fun `200 and 303 without shell proof remain foreign`() {
    for (code in listOf(200, 303)) {
      assertEquals(
        "code=$code alone must not prove ownership",
        EngineProbe.EngineAvailability.PORT_FOREIGN,
        EngineProbe.classifyEngineAvailability(code, managedAlive = false, logHasTokenLine = false, portReachable = true),
      )
      assertEquals(
        "code=$code plus current token line proves owned HTTP",
        EngineProbe.EngineAvailability.OUR_HTTP,
        EngineProbe.classifyEngineAvailability(code, managedAlive = false, logHasTokenLine = true, portReachable = true),
      )
    }
  }

  /**
  * 401 单独**不构成**归属证据（任何拒绝匿名请求的服务都回 401）；
  * 必须由「本代日志里有引擎自己的 token 行」佐证才算我们的。
  */
  @Test
  fun `401 alone is not ownership evidence but 401 with token line is`() {
    assertEquals(
      "401 且没有 token 行时只算「有人占着端口」",
      EngineProbe.EngineAvailability.PORT_FOREIGN,
      EngineProbe.classifyEngineAvailability(401, managedAlive = false, logHasTokenLine = false, portReachable = true),
    )
    assertEquals(
      "401 + 本代 token 行才证明是我们的引擎",
      EngineProbe.EngineAvailability.OUR_HTTP,
      EngineProbe.classifyEngineAvailability(401, managedAlive = false, logHasTokenLine = true, portReachable = true),
    )
  }

  /** 端口不可连且无任何证据 ⇒ DOWN（不得误报 PORT_FOREIGN）。 */
  @Test
  fun `nothing listening is down`() {
    assertEquals(
      EngineProbe.EngineAvailability.DOWN,
      EngineProbe.classifyEngineAvailability(-1, managedAlive = false, logHasTokenLine = false, portReachable = false),
    )
  }

  // ── (b) 401 语义 ────────────────────────────────────────────────────────────

  /** 反证核心：401 必须报 REQUIRED（需要重新认证），而**不是**「健康」。 */
  @Test
  fun `401 means re authentication required`() {
    assertEquals(EngineProbe.EngineAuthState.REQUIRED, EngineProbe.classifyAuthState(401))
    assertFalse("401 不得被当成已认证", EngineProbe.classifyAuthState(401) == EngineProbe.EngineAuthState.OK)
  }

  @Test
  fun `200 and 303 are ok 403 and others are unknown`() {
    assertEquals(EngineProbe.EngineAuthState.OK, EngineProbe.classifyAuthState(200))
    assertEquals(EngineProbe.EngineAuthState.OK, EngineProbe.classifyAuthState(303))
    // 403 是「认证过了但不许访问」，与「需要重新认证」是两件事——不得混为一谈。
    assertEquals(EngineProbe.EngineAuthState.UNKNOWN, EngineProbe.classifyAuthState(403))
    assertEquals(EngineProbe.EngineAuthState.UNKNOWN, EngineProbe.classifyAuthState(500))
    assertEquals("没有 HTTP 应答", EngineProbe.EngineAuthState.UNKNOWN, EngineProbe.classifyAuthState(-1))
  }

  /**
  * 「401 不得杀健康引擎」的语义仍在：401 是可认证态，不是 DOWN。
  * 这条防的是「修 (b) 时把 401 顺手当成引擎死了」——那会每次冷启动都重复拉起引擎。
  */
  @Test
  fun `401 is not death — availability stays ours when token line is present`() {
    val state = EngineProbe.classifyEngineAvailability(401, managedAlive = false, logHasTokenLine = true, portReachable = true)
    assertTrue("401 + token 行必须仍是「我们的引擎」（decision D3/W2）", state == EngineProbe.EngineAvailability.OUR_HTTP)
  }

  @Test
  fun `auth recovery requires owned main frame exact origin and 401`() {
    val owned = EngineProbe.EngineAvailability.OUR_PROCESS
    assertTrue(EngineProbe.shouldAutoRecoverAuth(401, true, "http://127.0.0.1:3080/", owned))
    assertTrue(EngineProbe.shouldAutoRecoverAuth(401, true, "http://127.0.0.1:3080/?x=1", EngineProbe.EngineAvailability.OUR_HTTP))
    assertFalse("403 never refreshes auth", EngineProbe.shouldAutoRecoverAuth(403, true, "http://127.0.0.1:3080/", owned))
    assertFalse("subresources never refresh auth", EngineProbe.shouldAutoRecoverAuth(401, false, "http://127.0.0.1:3080/", owned))
    assertFalse("foreign listener never refreshes auth", EngineProbe.shouldAutoRecoverAuth(401, true, "http://127.0.0.1:3080/", EngineProbe.EngineAvailability.PORT_FOREIGN))
    assertFalse("unrelated origin never refreshes auth", EngineProbe.shouldAutoRecoverAuth(401, true, "http://127.0.0.1:3081/", owned))
  }

  @Test
  fun `origin helper rejects port host scheme and userinfo tricks`() {
    assertTrue(EngineProbe.isEngineOrigin("http://127.0.0.1:3080/path"))
    assertFalse(EngineProbe.isEngineOrigin("https://127.0.0.1:3080/"))
    assertFalse(EngineProbe.isEngineOrigin("http://127.0.0.1:30800/"))
    assertFalse(EngineProbe.isEngineOrigin("http://127.0.0.2:3080/"))
    assertFalse(EngineProbe.isEngineOrigin("http://127.0.0.1:3080.evil.example/"))
    assertFalse(EngineProbe.isEngineOrigin("http://attacker@127.0.0.1:3080/"))
  }

  @Test
  fun `pre spawn port check fails closed`() {
    assertEquals(EngineProbe.EngineAvailability.PORT_FOREIGN, EngineProbe.classifyPreSpawnPort(true))
    assertEquals(EngineProbe.EngineAvailability.DOWN, EngineProbe.classifyPreSpawnPort(false))
  }
}
