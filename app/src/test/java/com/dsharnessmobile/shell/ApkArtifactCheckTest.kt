package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-209.E1（E-12 第二处）回归：缓存复用分支与新下载分支**共用同一份**产物校验。
 *
 * 缺陷形态：缓存分支判 sizeBytes（有 sha 还校验 sha），新下载分支只判「HTTP 200 且写盘成功」；
 * 同一份截断/半包/被替换产物在两条路径上判定相反（缓存更严、下载更松）。
 */
class ApkArtifactCheckTest {
  private val validSha256 = "a".repeat(64)

  /** 一条异常输入（两条路径的输入形状一致：文件、实际字节数、元数据大小、可选 sha）。 */
  private class Case(
    val exists: Boolean,
    val actual: Long,
    val expected: Long,
    val sha: String?,
    val shaOk: Boolean,
  )

  /** 两条路径的输入形状一致，判定必须逐条相同。 */
  @Test
  fun cachePathAndDownloadPathJudgeIdenticallyForEveryAbnormalInput() {
    val cases = listOf(
      Case(true, 100L, 100L, validSha256, true), // 正常
      Case(true, 99L, 100L, validSha256, true),  // 截断/半包（旧下载分支会接受）
      Case(true, 101L, 100L, validSha256, true), // 多写
      Case(true, 100L, 100L, validSha256, false), // sha 不符
      Case(true, 100L, 100L, validSha256, true),  // sha 符合
      Case(true, 100L, 0L, validSha256, true),    // 无大小 → sha-only 校验仍可判定
      Case(true, 100L, 0L, null, true),          // 缺 sha，即使文件大小匹配也拒收
      Case(false, 0L, 100L, null, true),         // 文件不存在
    )
    for (c in cases) {
      val cache = verifyApkArtifact(c.exists, c.actual, c.expected, c.sha) { c.shaOk }
      val download = verifyApkArtifact(c.exists, c.actual, c.expected, c.sha) { c.shaOk }
      assertEquals("两分支判定必须一致：" + c, cache, download)
    }
  }

  @Test
  fun truncatedArtifactIsRejectedWhenDigestMatchesButSizeDoesNot() {
    val v = verifyApkArtifact(fileExists = true, actualBytes = 1_000L, expectedBytes = 2_000L,
      expectedSha256 = validSha256, sha256Matches = { true })
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("大小不符"))
  }

  @Test
  fun shaMismatchIsRejectedEvenWhenSizeMatches() {
    val v = verifyApkArtifact(true, 2_000L, 2_000L, validSha256) { false }
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("sha256"))
  }

  @Test
  fun missingSizeMetadataStillLetsShaDecide() {
    assertTrue(verifyApkArtifact(true, 123L, 0L, validSha256) { true } is ApkArtifactVerdict.Accept)
    assertTrue(verifyApkArtifact(true, 123L, 0L, validSha256) { false } is ApkArtifactVerdict.Reject)
  }

  @Test
  fun missingShaIsRejectedEvenWhenSizeMatches() {
    val v = verifyApkArtifact(true, 123L, 123L, null) { error("digest callback must not run") }
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("sha256"))
  }

  @Test
  fun malformedShaIsRejectedEvenWhenSizeMatches() {
    assertTrue(verifyApkArtifact(true, 123L, 123L, "deadbeef") { error("digest callback must not run") } is ApkArtifactVerdict.Reject)
  }

  /** Metadata without a usable SHA-256 is rejected even when the reported size matches. */
  @Test
  fun metadataWithoutAnyEvidenceIsRejected() {
    val v = verifyApkArtifact(true, 123L, 0L, null) { true }
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("无法校验"))
  }

  @Test
  fun absentFileIsRejectedByBothPaths() {
    assertTrue(verifyApkArtifact(false, 0L, 0L, null) { true } is ApkArtifactVerdict.Reject)
  }
}
