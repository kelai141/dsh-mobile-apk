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
      Case(true, 100L, 100L, null, true),        // 正常
      Case(true, 99L, 100L, null, true),         // 截断/半包（旧下载分支会接受）
      Case(true, 101L, 100L, null, true),        // 多写
      Case(true, 100L, 100L, "abc", false),      // sha 不符
      Case(true, 100L, 100L, "abc", true),       // sha 符合
      Case(true, 100L, 0L, null, true),          // 元数据无大小 → 跳过大小步
      Case(false, 0L, 100L, null, true),         // 文件不存在
    )
    for (c in cases) {
      val cache = verifyApkArtifact(c.exists, c.actual, c.expected, c.sha) { c.shaOk }
      val download = verifyApkArtifact(c.exists, c.actual, c.expected, c.sha) { c.shaOk }
      assertEquals("两分支判定必须一致：" + c, cache, download)
    }
  }

  @Test
  fun truncatedArtifactIsRejectedEvenWithoutAnyShaAsset() {
    val v = verifyApkArtifact(fileExists = true, actualBytes = 1_000L, expectedBytes = 2_000L,
      expectedSha256 = null, sha256Matches = { true })
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("大小不符"))
  }

  @Test
  fun shaMismatchIsRejectedEvenWhenSizeMatches() {
    val v = verifyApkArtifact(true, 2_000L, 2_000L, "deadbeef") { false }
    assertTrue(v is ApkArtifactVerdict.Reject)
    assertTrue((v as ApkArtifactVerdict.Reject).reason.contains("sha256"))
  }

  @Test
  fun missingSizeMetadataStillLetsShaDecide() {
    assertTrue(verifyApkArtifact(true, 123L, 0L, null) { true } is ApkArtifactVerdict.Accept)
    assertTrue(verifyApkArtifact(true, 123L, 0L, "x") { false } is ApkArtifactVerdict.Reject)
  }

  @Test
  fun absentFileIsRejectedByBothPaths() {
    assertTrue(verifyApkArtifact(false, 0L, 0L, null) { true } is ApkArtifactVerdict.Reject)
  }
}
