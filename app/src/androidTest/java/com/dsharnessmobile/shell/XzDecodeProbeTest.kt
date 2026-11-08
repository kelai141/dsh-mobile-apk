package com.dsharnessmobile.shell

import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream
import org.tukaani.xz.XZOutputStream
import org.tukaani.xz.XZInputStream

/**
 * 只读 XZ 解码性能探针（设备侧）。
 *
 * 目标只有三件事：
 *  1. 证明 APK 内嵌的 snapshot.tar.xz 与 snapshot.sha256 逐字节一致（产物内容校验）；
 *  2. 在真实设备上量顺序解码与按块并行解码的耗时、吞吐与字节等价性；
 *  3. 用截断与字节翻转两种坏输入证明解码器会失败，不把不完整输入当成成功。
 *
 * 探针不写产品目录，也不改产品状态。解压只读入内存并计算 SHA-256，不落盘；
 * 唯一的写点是 targetContext.cacheDir/xz-decode-probe.json（证据文件）。
 */
@RunWith(AndroidJUnit4::class)
class XzDecodeProbeTest {

  private companion object {
    const val TAG = "dsh-xz-probe"
    const val SNAPSHOT = "snapshot.tar.xz"
    const val DECLARED = "snapshot.sha256"
    const val BUFFER = 64 * 1024
  }

  private data class Decode(val bytes: Long, val sha256: String, val elapsedMs: Long)

  private data class TarStats(val entries: Int, val fileBytes: Long, val elapsedMs: Long)

  @Test(timeout = 15 * 60 * 1000L)
  fun bundledSnapshotDecodesReadOnlyAndRejectsIncompleteInput() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val target = instrumentation.targetContext
    val assets = target.assets

    val declared = assets.open(DECLARED).bufferedReader().use { it.readText().trim().lowercase() }
    assertTrue("snapshot.sha256 必须是 64 位小写十六进制", declared.matches(Regex("[0-9a-f]{64}")))

    val digestStart = SystemClock.elapsedRealtime()
    val digest = SnapshotBundledAsset.digest(open = { assets.open(SNAPSHOT) })
    val digestMs = SystemClock.elapsedRealtime() - digestStart
    assertEquals("内嵌快照字节必须与 snapshot.sha256 声明值一致", declared, digest.hex)
    assertTrue("快照不能为空", digest.bytes > 0L)

    val afd = assets.openFd(SNAPSHOT)
    val startOffset = afd.startOffset
    val length = afd.length
    afd.close()
    assertEquals("openFd 长度必须等于摘要读到的字节数", digest.bytes, length)
    assertTrue("snapshot.tar.xz 必须以 STORED 条目进入 APK（startOffset > 0）", startOffset > 0L)

    val source = SnapshotExtractor.ApkAssetSource(target.applicationInfo.sourceDir, startOffset, length)
    var blocks = -1
    var streams = -1
    source.open().use { seekable ->
      SeekableXZInputStream(seekable).use { xz ->
        blocks = xz.blockCount
        streams = xz.streamCount
      }
    }
    assertTrue("xz 必须至少有一个 block", blocks > 0)
    assertTrue("xz 必须至少有一个 stream", streams > 0)

    val sequential = decodeSequential(source)
    val planThreads = SnapshotExtractor.ParallelPlan
      .threadsFor(Runtime.getRuntime().availableProcessors(), Runtime.getRuntime().maxMemory(), blocks)
    val parallelPlan = decodeParallel(source, planThreads)
    assertEquals("并行解码的字节数必须与顺序解码相同", sequential.bytes, parallelPlan.bytes)
    assertEquals("并行解码必须与顺序解码逐字节相同（SHA-256）", sequential.sha256, parallelPlan.sha256)

    val cores = Runtime.getRuntime().availableProcessors()
    val maxHeap = Runtime.getRuntime().maxMemory()
    val fourThreads = if (blocks >= 4) decodeParallel(source, 4) else null
    if (fourThreads != null) {
      assertEquals("4 线程解码的字节数必须与顺序解码相同", sequential.bytes, fourThreads.bytes)
      assertEquals("4 线程解码必须与顺序解码逐字节相同（SHA-256）", sequential.sha256, fourThreads.sha256)
    }

    val tar = countTarEntries(source, planThreads)
    assertTrue("解出的 tar 必须包含条目", tar.entries > 0)
    assertTrue("解出的 tar 必须包含常规文件字节", tar.fileBytes > 0L)

    // 负控 1：截掉尾部 4 KiB（footer/index 不完整）。顺序与并行解码都必须拒绝。
    val truncatedSequential = attempt { decodeSequential(SnapshotSeekableSource { TruncatedSeekable(source.open(), length - 4096L) }) }
    val truncatedParallel = attempt {
      decodeParallel(SnapshotSeekableSource { TruncatedSeekable(source.open(), length - 4096L) }, planThreads)
    }

    // 负控 2：把文件中部的一个字节翻转（落在压缩块数据内）。CRC64 必须拒绝。
    // 先证明注入真的生效：同一个偏移上，原始字节与注入视图读出的字节必须不同。
    val flipAt = length / 2L
    val originalByte = readByteAt(source, flipAt)
    val injectedByte = readByteAt(SnapshotSeekableSource { FlippingSeekable(source.open(), flipAt) }, flipAt)
    assertTrue("负控注入必须真的改变字节（否则这条反证是空的）", originalByte != injectedByte)
    val corruptSequential = attempt { decodeSequential(SnapshotSeekableSource { FlippingSeekable(source.open(), flipAt) }) }
    val corruptParallel = attempt { decodeParallel(SnapshotSeekableSource { FlippingSeekable(source.open(), flipAt) }, planThreads) }

    val result = JSONObject().apply {
      put("device", Build.MODEL)
      put("sdk", Build.VERSION.SDK_INT)
      put("abis", Build.SUPPORTED_ABIS.joinToString(","))
      put("cores", cores)
      put("maxHeapBytes", maxHeap)
      put("compressedBytes", length)
      put("declaredSha256", declared)
      put("actualSha256", digest.hex)
      put("digestMs", digestMs)
      put("blocks", blocks)
      put("streams", streams)
      put("planThreads", planThreads)
      put("sequentialMs", sequential.elapsedMs)
      put("parallelMs", parallelPlan.elapsedMs)
      put("parallelThreads", planThreads)
      put("uncompressedBytes", sequential.bytes)
      put("uncompressedSha256", sequential.sha256)
      put("speedup", ratio(sequential.elapsedMs, parallelPlan.elapsedMs))
      put("throughputMiBps", throughputMiBps(sequential.bytes, parallelPlan.elapsedMs))
      if (fourThreads != null) {
        put("fourThreadMs", fourThreads.elapsedMs)
        put("fourThreadSpeedup", ratio(sequential.elapsedMs, fourThreads.elapsedMs))
      }
      put("tarEntries", tar.entries)
      put("tarFileBytes", tar.fileBytes)
      put("tarMs", tar.elapsedMs)
      put("flipAt", flipAt)
      put("flipOriginalByte", originalByte)
      put("flipInjectedByte", injectedByte)
      put("truncatedSequential", truncatedSequential.toJson())
      put("truncatedParallel", truncatedParallel.toJson())
      put("corruptSequential", corruptSequential.toJson())
      put("corruptParallel", corruptParallel.toJson())
    }
    val out = java.io.File(target.cacheDir, "xz-decode-probe.json")
    out.writeText(result.toString(2))
    android.util.Log.i(TAG, result.toString())

    assertTrue("截断输入必须被顺序解码拒绝：" + truncatedSequential.describe(), truncatedSequential.threw)
    assertTrue("截断输入必须被并行解码拒绝：" + truncatedParallel.describe(), truncatedParallel.threw)
    assertTrue("字节翻转必须被顺序解码拒绝：" + corruptSequential.describe(), corruptSequential.threw)
    assertTrue(
      "字节翻转的并行解码必须失败或至少不完整（完整且摘要不同 = 静默产出坏数据）："
        + corruptParallel.describe(),
      corruptParallel.threw || corruptParallel.bytes != sequential.bytes,
    )
  }

  /**
   * 生产入口的反证：小夹具损坏或截断时，[SnapshotExtractor.extractParallel] 必须抛异常。
   *
   * 为什么单独用一个小的多 stream 夹具：真实快照 800 MB、5 万个文件，解压到缓存会写满设备；
   * 这里只需要证明「并行路径不会把坏输入当成功」，与夹具体量无关。
   * 多 stream 夹具可在 JVM 侧构造（XZOutputStream 只产单块流，多 stream 拼接等价于多块语义）。
   */
  @Test(timeout = 5 * 60 * 1000L)
  fun productionExtractRejectsTruncatedAndCorruptFixtures() {
    val payload = tarFixture()
    val joined = java.io.ByteArrayOutputStream()
    val piece = (payload.size / 512 / 3) * 512
    var offset = 0
    repeat(3) { i ->
      val end = if (i == 2) payload.size else offset + piece
      val out = java.io.ByteArrayOutputStream()
      XZOutputStream(out, org.tukaani.xz.LZMA2Options(1)).use { it.write(payload, offset, end - offset) }
      joined.write(out.toByteArray())
      offset = end
    }
    val archive = joined.toByteArray()
    assertTrue("夹具必须真的切出 3 段", offset == payload.size && piece > 0)

    val root = java.nio.file.Files.createTempDirectory(
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.toPath(),
      "xz-probe-fixture-",
    ).toFile()
    try {
      val good = java.io.File(root, "good.tar.xz").apply { writeBytes(archive) }
      val truncated = java.io.File(root, "truncated.tar.xz").apply { writeBytes(archive.copyOf(archive.size - 64)) }
      val corrupt = java.io.File(root, "corrupt.tar.xz").apply {
        val bytes = archive.copyOf()
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0x01).toByte()
        writeBytes(bytes)
      }

      val goodResult = SnapshotExtractor.extractParallel(
        source = fileSource(good),
        totalBytes = good.length(),
        dest = java.io.File(root, "out-good"),
        onProgress = { _, _ -> },
        plan = SnapshotExtractor.ParallelPlan(2),
      )
      assertEquals(
        "正常夹具必须走并行且成功",
        SnapshotExtractor.ExtractResult.MODE_PARALLEL,
        goodResult.mode,
      )

      assertThrows("截断夹具必须被生产入口拒绝", IOException::class.java) {
        SnapshotExtractor.extractParallel(
          source = fileSource(truncated),
          totalBytes = truncated.length(),
          dest = java.io.File(root, "out-truncated"),
          onProgress = { _, _ -> },
          plan = SnapshotExtractor.ParallelPlan(2),
        )
      }
      assertThrows("损坏夹具必须被生产入口拒绝（不得静默产出半份）", IOException::class.java) {
        SnapshotExtractor.extractParallel(
          source = fileSource(corrupt),
          totalBytes = corrupt.length(),
          dest = java.io.File(root, "out-corrupt"),
          onProgress = { _, _ -> },
          plan = SnapshotExtractor.ParallelPlan(2),
        )
      }
    } finally {
      SnapshotFs.deletePath(root)
    }
  }

  private fun fileSource(file: java.io.File): SnapshotSeekableSource = SnapshotSeekableSource {
    org.tukaani.xz.SeekableFileInputStream(file)
  }

  private fun tarFixture(): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    TarArchiveOutputStream(out).use { tar ->
      repeat(6) { i ->
        val body = ByteArray(1024 + i * 64) { ('a' + i).code.toByte() }
        val entry = org.apache.commons.compress.archivers.tar.TarArchiveEntry("dir$i/file$i.bin")
        entry.size = body.size.toLong()
        tar.putArchiveEntry(entry)
        tar.write(body)
        tar.closeArchiveEntry()
      }
      tar.finish()
    }
    return out.toByteArray()
  }

  /** 一次负控尝试的如实结果：抛没抛、抛了什么、如果没抛则解出了多少字节。 */
  private data class Attempt(
    val threw: Boolean,
    val error: String?,
    val bytes: Long?,
    val sha256: String?,
    val elapsedMs: Long,
  ) {
    fun toJson(): JSONObject = JSONObject().apply {
      put("threw", threw)
      if (error != null) put("error", error)
      if (bytes != null) put("bytes", bytes)
      if (sha256 != null) put("sha256", sha256)
      put("elapsedMs", elapsedMs)
    }

    fun describe(): String = if (threw) {
      "拒绝（" + error + "，耗时 " + elapsedMs + "ms）"
    } else {
      "未拒绝（解出 " + bytes + " 字节，耗时 " + elapsedMs + "ms）"
    }
  }

  private fun attempt(block: () -> Decode): Attempt {
    val started = SystemClock.elapsedRealtime()
    return try {
      val decoded = block()
      Attempt(false, null, decoded.bytes, decoded.sha256, SystemClock.elapsedRealtime() - started)
    } catch (t: Throwable) {
      Attempt(true, t.javaClass.name + ": " + t.message, null, null, SystemClock.elapsedRealtime() - started)
    }
  }

  private fun readByteAt(source: SnapshotSeekableSource, at: Long): Int {
    source.open().use { stream ->
      stream.seek(at)
      return stream.read()
    }
  }

  private fun decodeSequential(source: SnapshotSeekableSource): Decode {
    val started = SystemClock.elapsedRealtime()
    val md = MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    XZInputStream(source.open()).use { input ->
      bytes = drain(input, md)
    }
    return Decode(bytes, md.digest().toHex(), SystemClock.elapsedRealtime() - started)
  }

  private fun decodeParallel(source: SnapshotSeekableSource, threads: Int): Decode {
    val started = SystemClock.elapsedRealtime()
    val md = MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    SnapshotExtractor.ParallelXzInputStream(source, threads).use { input ->
      bytes = drain(input, md)
    }
    return Decode(bytes, md.digest().toHex(), SystemClock.elapsedRealtime() - started)
  }

  private fun drain(input: InputStream, md: MessageDigest): Long {
    val buffer = ByteArray(BUFFER)
    var bytes = 0L
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      if (n > 0) {
        md.update(buffer, 0, n)
        bytes += n
      }
    }
    return bytes
  }

  private fun countTarEntries(source: SnapshotSeekableSource, threads: Int): TarStats {
    val started = SystemClock.elapsedRealtime()
    var entries = 0
    var fileBytes = 0L
    SnapshotExtractor.ParallelXzInputStream(source, threads).use { stream ->
      TarArchiveInputStream(stream).use { tar ->
        var entry = tar.nextEntry
        while (entry != null) {
          entries += 1
          if (!entry.isDirectory && !entry.isSymbolicLink) fileBytes += entry.size.coerceAtLeast(0L)
          entry = tar.nextEntry
        }
      }
    }
    return TarStats(entries, fileBytes, SystemClock.elapsedRealtime() - started)
  }

  private fun ratio(baseMs: Long, candidateMs: Long): Double =
    if (candidateMs <= 0L) 0.0 else baseMs.toDouble() / candidateMs.toDouble()

  private fun throughputMiBps(bytes: Long, elapsedMs: Long): Double =
    if (elapsedMs <= 0L) 0.0 else bytes.toDouble() / (1024.0 * 1024.0) / (elapsedMs / 1000.0)

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  /** 只读视图：长度截到 [limit]，越界读返回 -1，不复制原文件。 */
  private class TruncatedSeekable(
    private val delegate: SeekableInputStream,
    private val limit: Long,
  ) : SeekableInputStream() {
    override fun length(): Long = limit

    override fun position(): Long = delegate.position()

    override fun seek(pos: Long) {
      if (pos < 0L || pos > limit) throw IOException("seek out of truncated view: $pos")
      delegate.seek(pos)
    }

    override fun read(): Int {
      if (delegate.position() >= limit) return -1
      return delegate.read()
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      val remaining = limit - delegate.position()
      if (remaining <= 0L) return -1
      return delegate.read(b, off, minOf(len.toLong(), remaining).toInt())
    }

    override fun close() = delegate.close()
  }

  /** 只读视图：每次读经过 [flipAt] 时翻转该字节的低位，用于 CRC 负控。 */
  private class FlippingSeekable(
    private val delegate: SeekableInputStream,
    private val flipAt: Long,
  ) : SeekableInputStream() {
    override fun length(): Long = delegate.length()

    override fun position(): Long = delegate.position()

    override fun seek(pos: Long) = delegate.seek(pos)

    override fun read(): Int {
      val one = ByteArray(1)
      return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      val start = delegate.position()
      val n = delegate.read(b, off, len)
      if (n > 0 && flipAt >= start && flipAt < start + n) {
        val at = off + (flipAt - start).toInt()
        b[at] = (b[at].toInt() xor 0x01).toByte()
      }
      return n
    }

    override fun close() = delegate.close()
  }
}
