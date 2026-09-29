package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M.1（apk #272）缺陷 (c)(d) 的纯判据（JVM，无网络/无设备）。
 *
 * (c) token 归属：旧 `tokenFromLog` 依次看 engine.log/.1/.2 并取**第一条命中**。启动瞬间
 *     `rotateEngineLog` 已把上一代滚到 .1、新代 engine.log 尚空（引擎约 2s 后才打印 token 行），
 *     于是读到**上一代死进程**的 token —— 拿它交换要么失败、要么换回旧进程的 cookie
 *     （表现为「首启偶发要等很久才进去」）。
 *
 * (d) cookie 时窗：旧实现硬编码 30 天，与引擎的 cookieMaxAgeDays 无联动。
 *     实测（设备 Set-Cookie 头 `Max-Age=2592000`）证明真值**只能从引擎应答观测**——
 *     该配置项不在 settings.yaml 里（是 `@deepseek-ai/dsh-client-connection` 的 cordis config，
 *     `dsh/packages/client/connection/src/index.ts:105/113` 默认 30）。
 */
class EngineAuthPolicyTest {

  // ── (c) token 归属 ─────────────────────────────────────────────────────────

  /** 反证核心：上一代日志（mtime 早于本代起点）里的 token 必须被拒绝。 */
  @Test
  fun `token from a previous generation is rejected`() {
    val generationStart = 1_000_000L
    // 旧代：spawn 之前就被写过（rotate 已把它滚成 .1），mtime 明显早于本代起点。
    assertFalse(
      "上一代的日志不得用于本代 token",
      EngineAuth.logBelongsToCurrentGeneration(
        logModifiedMs = generationStart - 60_000L,
        generationStartMs = generationStart,
      ),
    )
  }

  /** 本代日志（spawn 之后被写过）必须接受。 */
  @Test
  fun `token from the current generation is accepted`() {
    val generationStart = 1_000_000L
    assertTrue(
      "本代日志必须接受",
      EngineAuth.logBelongsToCurrentGeneration(generationStart + 3_000L, generationStart),
    )
  }

  /** 容差：写入延迟/时钟抖动不应误杀本代日志（但不放宽到上一代）。 */
  @Test
  fun `generation check tolerates small clock slack but not a previous generation`() {
    val generationStart = 1_000_000L
    assertTrue("起点前 3s（容差内）应接受", EngineAuth.logBelongsToCurrentGeneration(generationStart - 3_000L, generationStart))
    assertFalse("起点前 30s（超出容差）必须拒绝", EngineAuth.logBelongsToCurrentGeneration(generationStart - 30_000L, generationStart))
  }

  /** Unknown generation is fail-closed; a zero timestamp cannot prove current ownership. */
  @Test
  fun `unknown generation start and missing file are rejected`() {
    assertFalse("起点未知时不得提取 token", EngineAuth.logBelongsToCurrentGeneration(123L, generationStartMs = 0L))
    assertFalse("文件不存在（mtime=0）不得当成本代", EngineAuth.logBelongsToCurrentGeneration(0L, generationStartMs = 1_000L))
  }

  @Test
  fun `production extractor reads only current log and rejects unknown generation`() {
    val dir = java.nio.file.Files.createTempDirectory("engine-auth-token")
    try {
      val current = dir.resolve("engine.log").toFile()
      val freshToken = "current_token_123456789012345678901234567890"
      current.writeText("dsh web: http://127.0.0.1:3080/?token=$freshToken\n")
      val generation = current.lastModified() - 1L
      assertEquals("current engine.log token is extracted", freshToken, EngineAuth.tokenFromCurrentLog(current, generation))

      // Refreshing mtime cannot resurrect stale content: creation time remains before this generation.
      val createdMs = java.nio.file.Files.readAttributes(
        current.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java,
      ).creationTime().toMillis()
      val staleGeneration = createdMs + 60_000L
      java.nio.file.Files.setLastModifiedTime(current.toPath(), java.nio.file.attribute.FileTime.fromMillis(staleGeneration + 1L))
      assertNull("stale current-log content with refreshed mtime is rejected", EngineAuth.tokenFromCurrentLog(current, staleGeneration))

      val rotated = dir.resolve("engine.log.1").toFile()
      rotated.writeText("dsh web: http://127.0.0.1:3080/?token=rotated_token_123456789012345678901234567890\n")
      java.nio.file.Files.setLastModifiedTime(rotated.toPath(), java.nio.file.attribute.FileTime.fromMillis(generation - 60_000L))
      assertNull("rotated diagnostics never prove ownership", EngineAuth.tokenFromCurrentLog(rotated, generation))
      assertNull("unknown generation fails closed in production extractor", EngineAuth.tokenFromCurrentLog(current, 0L))
    } finally {
      dir.toFile().deleteRecursively()
    }
  }

  // ── (d) cookie 时窗 ────────────────────────────────────────────────────────

  /** 反证核心：时窗必须可由引擎应答观测，不得再硬编码 30 天。 */
  @Test
  fun `set cookie max age is parsed from the engine response`() {
    // 设备实测原样：Max-Age=2592000（30 天）。
    val header = "dsh-auth-abc=v1.xxx.yyy; Max-Age=2592000; Path=/; Expires=Tue, 27 Oct 2026 13:28:55 GMT; HttpOnly; SameSite=Strict"
    assertEquals(2_592_000_000L, EngineAuth.maxAgeFromSetCookie(header))
    // 大小写与空格容忍（HTTP 头不区分大小写）。
    assertEquals(3600_000L, EngineAuth.maxAgeFromSetCookie("dsh-auth-a=b; max-age=3600"))
    assertEquals(3600_000L, EngineAuth.maxAgeFromSetCookie("dsh-auth-a=b;MAX-AGE=3600"))
  }

  @Test
  fun `unparseable max age yields null and never a bogus value`() {
    assertNull("无该属性", EngineAuth.maxAgeFromSetCookie("dsh-auth-a=b; Path=/; HttpOnly"))
    assertNull("null 输入", EngineAuth.maxAgeFromSetCookie(null))
    assertNull("空串", EngineAuth.maxAgeFromSetCookie(""))
    assertNull("0 非法", EngineAuth.maxAgeFromSetCookie("dsh-auth-a=b; Max-Age=0"))
    assertNull("非数字", EngineAuth.maxAgeFromSetCookie("dsh-auth-a=b; Max-Age=abc"))
  }

  /**
  * 关键方向：壳侧自铸 cookie 必须比引擎允许的时窗**早**失效（否则我们以为还有效、
  * 引擎已拒绝 ⇒ 卡在 401 页面）。这条断言把方向钉死，防止修成「加边距」而不是「减边距」。
  */
  @Test
  fun `minted cookie expires strictly earlier than the engine window`() {
    val observed = 2_592_000_000L
    val minted = EngineAuth.mintedMaxAgeMs(observed)
    assertTrue("必须早于引擎时窗（方向错了就会卡 401）", minted < observed)
    assertEquals("提前量必须是安全边距", EngineAuth.COOKIE_EXPIRY_SAFETY_MARGIN_MS, observed - minted)
    // 默认（尚未观测到）也要有明确默认值，且同样留边距。
    val fallback = EngineAuth.mintedMaxAgeMs(null)
    assertEquals(
      "未观测到时用默认 30 天减边距",
      EngineAuth.DEFAULT_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000 - EngineAuth.COOKIE_EXPIRY_SAFETY_MARGIN_MS,
      fallback,
    )
  }

  /** 极小观测值不得算出负数或 0（否则 cookie 一铸出来就失效 ⇒ 死循环 refresh）。 */
  @Test
  fun `tiny observed window still yields a positive minted window`() {
    assertTrue("观测 1 分钟时仍须为正", EngineAuth.mintedMaxAgeMs(60_000L) > 0L)
    assertTrue("观测极小值时被下限托住", EngineAuth.mintedMaxAgeMs(1L) >= 60_000L)
  }

  /** 与引擎侧校验口径一致：expiresAt - issuedAt 必须 <= 引擎 maxAge（browser-auth.ts:299）。 */
  @Test
  fun `minted window satisfies the engine side inequality`() {
    val engineMaxAgeMs = 30L * 24 * 60 * 60 * 1000
    val minted = EngineAuth.mintedMaxAgeMs(engineMaxAgeMs)
    assertTrue("expiresAt - issuedAt <= engineMaxAge 才不会被引擎拒", minted <= engineMaxAgeMs)
  }
}
