package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Symlink target policy regression: the bundled archive carries absolute applet links
 * into the live runtime root (`files/usr/...`). Extraction into a staging directory must
 * still accept them (they are correct after the atomic swap), while Termux residue and
 * escaping targets stay rejected.
 */
class SnapshotExtractorTest {

  @Test
  fun acceptsTargetsInsideTheStageOrTheLiveRuntimeRootAndRejectsTheRest() {
    val root = Files.createTempDirectory("snapshot-extractor-policy-test").toFile()
    try {
      val runtimeRoot = File(root, "files").apply { mkdirs() }
      val dest = File(runtimeRoot, ".snapshot-stage").apply { mkdirs() }
      val linkParent = File(dest, "usr/bin").apply { mkdirs() }
      val destCanon = dest.canonicalPath
      val runtimeCanon = runtimeRoot.canonicalPath

      assertTrue(
        "relative link inside the stage",
        SnapshotExtractor.isLinkTargetAllowed("../libexec/busybox/vi", linkParent, destCanon, runtimeCanon),
      )
      assertTrue(
        "absolute applet link into the live runtime root must survive staging",
        SnapshotExtractor.isLinkTargetAllowed(
          File(runtimeRoot, "usr/libexec/busybox/vi").absolutePath, linkParent, destCanon, runtimeCanon,
        ),
      )
      assertTrue(
        "absolute link into the stage itself",
        SnapshotExtractor.isLinkTargetAllowed(File(dest, "usr/bin/node").absolutePath, linkParent, destCanon, runtimeCanon),
      )
      assertFalse(
        "absolute target outside the runtime root",
        SnapshotExtractor.isLinkTargetAllowed(File(root, "elsewhere/less").absolutePath, linkParent, destCanon, runtimeCanon),
      )
      assertFalse(
        "relative escape",
        SnapshotExtractor.isLinkTargetAllowed("../../../../../../etc/passwd", linkParent, destCanon, runtimeCanon),
      )
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  // ── 审查 §5.11 / S-10：解压上限（旧实现只防路径穿越，不防解压炸弹） ────────────────
  //
  // 本层自认是「沙盒边界」（在线更新走明文 HTTP 可篡改），但没有条目数/总量/单文件上限 ⇒
  // xz 炸弹与海量小文件可撑爆 /data 并长时间占 CPU。上限用**可注入的小值**真跑一遍判据，
  // 否则测试自己就得构造 24 万条目（等于让测试变成解压炸弹）。
  private fun archive(build: (org.apache.commons.compress.archivers.tar.TarArchiveOutputStream) -> Unit): java.io.ByteArrayInputStream {
    val buf = java.io.ByteArrayOutputStream()
    org.apache.commons.compress.compressors.xz.XZCompressorOutputStream(buf).use { xz ->
      org.apache.commons.compress.archivers.tar.TarArchiveOutputStream(xz).use { tar ->
        build(tar)
        tar.finish()
      }
    }
    return java.io.ByteArrayInputStream(buf.toByteArray())
  }

  private fun writeEntry(
    tar: org.apache.commons.compress.archivers.tar.TarArchiveOutputStream,
    name: String,
    body: ByteArray,
  ) {
    val entry = org.apache.commons.compress.archivers.tar.TarArchiveEntry(name)
    entry.size = body.size.toLong()
    tar.putArchiveEntry(entry)
    tar.write(body)
    tar.closeArchiveEntry()
  }

  @Test
  fun rejectsArchivesThatExceedTheDeclaredLimits() {
    val root = Files.createTempDirectory("snapshot-extractor-limits-test").toFile()
    try {
      // ① 条目数超限
      val manyEntries = archive { tar -> repeat(6) { writeEntry(tar, "usr/f$it", ByteArray(8)) } }
      val tooMany = try {
        SnapshotExtractor.extract(
          manyEntries, 0L, File(root, "a"), { _, _ -> },
          limits = SnapshotExtractor.Limits(maxEntries = 5),
        )
        null
      } catch (t: java.io.IOException) { t }
      assertTrue("条目数超限必须中止解压", tooMany != null)

      // ② 解压总体量超限
      val bigTotal = archive { tar -> writeEntry(tar, "usr/big", ByteArray(4096)) }
      val tooBig = try {
        SnapshotExtractor.extract(
          bigTotal, 0L, File(root, "b"), { _, _ -> },
          limits = SnapshotExtractor.Limits(maxTotalBytes = 1024),
        )
        null
      } catch (t: java.io.IOException) { t }
      assertTrue("解压体量超限必须中止解压", tooBig != null)

      // ③ 单文件超限
      val single = archive { tar -> writeEntry(tar, "usr/one", ByteArray(4096)) }
      val tooWide = try {
        SnapshotExtractor.extract(
          single, 0L, File(root, "c"), { _, _ -> },
          limits = SnapshotExtractor.Limits(maxSingleFileBytes = 1024),
        )
        null
      } catch (t: java.io.IOException) { t }
      assertTrue("单文件超限必须中止解压", tooWide != null)

      // ④ 正向对照：同样内容在上限之内必须解压成功（否则上面三条可能是「恒拒」的假绿）
      val ok = archive { tar ->
        writeEntry(tar, "usr/bin/node", "node".toByteArray())
        writeEntry(tar, "usr/etc/motd", "hi".toByteArray())
      }
      val dest = File(root, "ok")
      SnapshotExtractor.extract(ok, 0L, dest, { _, _ -> })
      assertEquals("node", File(dest, "usr/bin/node").readText())
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

}
