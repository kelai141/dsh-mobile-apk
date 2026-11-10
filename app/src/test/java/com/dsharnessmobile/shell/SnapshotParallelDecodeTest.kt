package com.dsharnessmobile.shell

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.util.Arrays
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tukaani.xz.SeekableFileInputStream
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.XZInputStream

/**
 * 并行 xz 解码的判据（缺陷 2：解压后首次启动变慢）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 设备实测 `snapshotExtract` 段 **337,227 ms**（168,499,300 B 快照），而本机同口径分解证明
 * **93% 是 xz 单线程解码**（单趟边解码边落盘 29.5 s = 解码 27.4 s + 落盘 2.1 s）。
 * 该快照是 1 stream / 34 blocks，块完全可并行，但 `XZCompressorInputStream` 只能顺序解。
 *
 * ── 本测试钉住的三件事（缺一即这条优化不可信）──
 *  1. **字节等价**：并行解码（按块 seek + 严格按块序重组）的输出必须与单线程顺序解码
 *     **逐字节相同**。这是并行化唯一真正的风险点——块序错一个字节，解出来的 tar 就错位，
 *     而 tar 错位不会立刻报错，会表现为「解压成功但运行时缺文件」。
 *  2. **回退不失败**：并行路径抛异常时必须自动回落单线程并**成功**返回（并行出问题
 *     不能变成「用户装不了应用」）。
 *  3. **单线程路径逐字节不变**：`extract` 走的是改造前的代码，既有行为必须原样。
 *
 * ── 夹具为什么是「多个 xz stream」而不是「一个 stream 多个 block」──
 * 生产快照是 **1 stream / 34 blocks**（构建链用 `xz -T` 压出多块流）。但
 * `XZCompressorOutputStream`（JVM 侧压缩器）只能产出**单块流**，无法在测试里构造多块。
 * 好在 `SeekableXZInputStream` 的 `getBlockCount()` 对**多 stream** 同样逐流计数
 * （每个 stream 一个 block），而 `seekToBlock(i)` 的语义完全相同——本测试实测：
 * 3 段首尾相接的 xz 流 ⇒ `getBlockCount()=3 / getStreamCount()=3`，
 * `seekToBlock` 逐块读出的字节与顺序解码逐字节相同。因此这条夹具覆盖的正是
 * 「按块随机访问 + 有序重组」这段被测逻辑。
 *
 * ── 必须用与生产同一个解码器 ─────────────────────────────────────────────────
 * 顺序基线用 `XZInputStream`（org.tukaani.xz，多 stream 依次解）而不是
 * commons-compress 的 `XZCompressorInputStream`：后者在**多 stream** 夹具上只解第一个 stream
 * （实测 seqEqualsTar=false），拿它当基线会得到一条永远判红的用例。
 * 生产快照是单 stream，两者等价；此处选能在夹具上给出完整字节的那个。
 */
class SnapshotParallelDecodeTest {

  private companion object {
    /**
     * 并行解码 worker 的线程名（与 `SnapshotExtractor.ParallelXzInputStream` 的
     * `Thread(runnable, "dsh-xz-decode")` 一致）。判据用它区分「调用线程」与「worker 线程」——
     * 这是本测试唯一能在不改生产代码的前提下定位 worker 的手段。
     */
    const val WORKER_THREAD_NAME = "dsh-xz-decode"
  }

  // ── 夹具构造 ────────────────────────────────────────────────────────────────

  /** 造一段真 tar 字节（多个小文件，够跨若干 512 B 块）。 */
  private fun tarBytes(files: Int = 12): ByteArray {
    val out = ByteArrayOutputStream()
    TarArchiveOutputStream(out).use { tar ->
      for (i in 0 until files) {
        val body = ByteArray(1000 + i * 37) { ('a' + i).code.toByte() }
        val entry = TarArchiveEntry("dir" + i + "/file" + i + ".bin")
        entry.size = body.size.toLong()
        tar.putArchiveEntry(entry)
        tar.write(body)
        tar.closeArchiveEntry()
      }
      tar.finish()
    }
    return out.toByteArray()
  }

  /**
   * 把 [payload] 按 512 B 对齐切成 [pieces] 段，各压成一个 xz stream，首尾相接。
   *
   * 为什么必须 512 B 对齐：tar 以 512 B 为记录单位，跨段切开会让顺序基线读出的字节
   * 与原始 tar 不等（实测：不对齐时 seqEqualsTar=false，那会把夹具本身写成坏的）。
   */
  private fun multiStreamXz(payload: ByteArray, pieces: Int): ByteArray {
    val aligned = (payload.size / pieces / 512) * 512
    require(aligned > 0) { "payload 太小，切不出 $pieces 段" }
    val joined = ByteArrayOutputStream()
    var offset = 0
    for (i in 0 until pieces) {
      val end = if (i == pieces - 1) payload.size else offset + aligned
      val piece = ByteArrayOutputStream()
      XZCompressorOutputStream(piece).use { xz -> xz.write(payload, offset, end - offset) }
      joined.write(piece.toByteArray())
      offset = end
    }
    return joined.toByteArray()
  }

  private fun writeTemp(bytes: ByteArray): File {
    val file = Files.createTempFile("snapshot-parallel-test", ".xz").toFile()
    file.writeBytes(bytes)
    return file
  }

  /** 生产同款的「可 seek 源」：每次 open 各开一份文件句柄。 */
  private fun sourceOf(file: File): SnapshotSeekableSource = SnapshotSeekableSource {
    SeekableFileInputStream(file) as SeekableInputStream
  }

  private fun sha256(bytes: ByteArray): String =
    java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it) }

  private fun readAll(stream: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(4096)
    while (true) {
      val n = stream.read(buf)
      if (n < 0) break
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  // ── 1. 字节等价（本改动的核心判据）──────────────────────────────────────────

  @Test
  fun parallelDecodeProducesByteIdenticalOutputToSequentialDecode() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    try {
      val sequential = XZInputStream(ByteArrayInputStream(multi)).use { readAll(it) }
      assertEquals("夹具自检：顺序解码必须还原原始 tar", sha256(tar), sha256(sequential))

      val parallel = SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 3).use { readAll(it) }
      assertEquals("并行解码的字节数必须与顺序解码相同", sequential.size, parallel.size)
      assertEquals("并行解码必须与顺序解码逐字节相同（SHA-256）", sha256(sequential), sha256(parallel))
    } finally {
      file.delete()
    }
  }

  /** 线程数多于块数时也必须正确（worker 会空转，不得越界、不得丢块）。 */
  @Test
  fun parallelDecodeIsCorrectWhenThreadsExceedBlocks() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 2)
    val file = writeTemp(multi)
    try {
      val sequential = XZInputStream(ByteArrayInputStream(multi)).use { readAll(it) }
      val parallel = SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 8).use { readAll(it) }
      assertEquals("线程数(8) > 块数(2) 时输出仍须逐字节相同", sha256(sequential), sha256(parallel))
    } finally {
      file.delete()
    }
  }

  /** 单线程也必须正确（走的是同一个类，但只有 1 个 worker 认领全部块）。 */
  @Test
  fun parallelDecodeWithSingleThreadIsStillCorrect() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    try {
      val sequential = XZInputStream(ByteArrayInputStream(multi)).use { readAll(it) }
      val single = SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 1).use { readAll(it) }
      assertEquals("1 线程的并行解码器输出必须与顺序解码相同", sha256(sequential), sha256(single))
    } finally {
      file.delete()
    }
  }

  /** 小块读（逐字节 read()）与大批量读必须给出同一结果。 */
  @Test
  fun byteAtATimeReadMatchesBulkRead() {
    val tar = tarBytes(files = 3)
    val multi = multiStreamXz(tar, pieces = 2)
    val file = writeTemp(multi)
    try {
      val sequential = XZInputStream(ByteArrayInputStream(multi)).use { readAll(it) }
      val oneByOne = ByteArrayOutputStream()
      SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 2).use { stream ->
        while (true) {
          val value = stream.read()
          if (value < 0) break
          oneByOne.write(value)
        }
      }
      assertEquals("逐字节 read() 与批量 read() 必须一致", sha256(sequential), sha256(oneByOne.toByteArray()))
    } finally {
      file.delete()
    }
  }

  // ── 2. 回退不失败（本改动最重要的安全网）────────────────────────────────────

  /**
   * 并行路径抛异常 ⇒ [SnapshotExtractor.extractParallel] 必须回落单线程并**成功**返回。
   *
   * 注入方式：给一个「第一次 open 抛异常」的源。并行路径第一步就是 open（读块表），
   * 因此必然走到回落分支；回落分支再 open 一次，这次成功。
   */
  @Test
  fun parallelFailureFallsBackToSequentialAndStillSucceeds() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    val dest = Files.createTempDirectory("snapshot-parallel-fallback").toFile()
    try {
      val real = sourceOf(file)
      var opens = 0
      val flaky = SnapshotSeekableSource {
        opens += 1
        if (opens == 1) throw java.io.IOException("injected: block table unreadable")
        real.open()
      }
      val result = SnapshotExtractor.extractParallel(
        flaky, multi.size.toLong(), dest, { _, _ -> }, plan = SnapshotExtractor.ParallelPlan(2),
      )
      assertEquals("回退路径必须如实报告 mode=fallback", SnapshotExtractor.ExtractResult.MODE_FALLBACK, result.mode)
      assertEquals("回退后线程数必须记 1", 1, result.threads)
      assertTrue("回退后必须真的解出了字节", result.bytes > 0L)
      // 内容对账：解出来的每个文件字节必须与 tar 里的一致。
      for (i in 0 until 12) {
        val expected = ByteArray(1000 + i * 37) { ('a' + i).code.toByte() }
        val actual = File(File(dest, "dir$i"), "file$i.bin").readBytes()
        assertTrue("dir$i/file$i.bin 内容必须与归档一致", Arrays.equals(expected, actual))
      }
    } finally {
      file.delete()
      SnapshotFs.deletePath(dest)
    }
  }

  /**
   * worker 线程内 `open()` 抛 ⇒ 必须经 failures[] → nextChunk() → TarArchiveInputStream → 回退。
   *
   * ── 为什么这条与上一条必须都留（它们走**不同**的异常传播路径）──────────────────
   * 上一条注入的是**构造函数**那次 `open()`：它抛时 `parallelStream` 从未赋值，
   * 异常直接从 `extractParallel` 的 try 里跳出——**线程池根本还没建**，`finally` 不在场。
   *
   * 本条注入的是**worker 线程**里的 `open()`：并行流已构造好、线程池已在跑。此时异常只能走
   * `decodeBlock` 的 catch → `failures[index].set(t)` → 消费者 `nextChunk()` 抛出 →
   * 穿过 `TarArchiveInputStream` → `extractEntriesFrom` 的 catch → `finally` 关 tar
   * （连带关并行流 ⇒ `shutdownNow` 线程池）→ `extractParallel` 的 catch → 回退。
   *
   * **这条才是生产路径**：真机上 xz 解码失败发生在 worker 里，不在构造。
   *
   * 判据用线程名区分：`ParallelXzInputStream` 给 worker 起名 `dsh-xz-decode`。
   * worker 线程上 `open()` 必抛，调用线程上 `open()` 成功（构造函数与回退都跑在调用线程）。
   */
  @Test
  fun workerThreadOpenFailureFallsBackAndClosesThePool() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    val dest = Files.createTempDirectory("snapshot-parallel-worker-fallback").toFile()
    val before = Thread.getAllStackTraces().keys.filter { it.name == WORKER_THREAD_NAME && it.isAlive }.toSet()
    try {
      val real = sourceOf(file)
      val workerOpens = java.util.concurrent.atomic.AtomicInteger(0)
      val flaky = SnapshotSeekableSource {
        if (Thread.currentThread().name == WORKER_THREAD_NAME) {
          workerOpens.incrementAndGet()
          throw java.io.IOException("injected: worker-thread open failure")
        }
        real.open()
      }
      val result = SnapshotExtractor.extractParallel(
        flaky, multi.size.toLong(), dest, { _, _ -> }, plan = SnapshotExtractor.ParallelPlan(2),
      )
      assertTrue("注入必须真的发生在 worker 线程上（否则本用例没测到目标路径）", workerOpens.get() > 0)
      assertEquals(
        "worker 内失败必须走回退并如实报告 mode=fallback",
        SnapshotExtractor.ExtractResult.MODE_FALLBACK, result.mode,
      )
      assertEquals("回退后线程数必须记 1", 1, result.threads)
      assertTrue("回退后必须真的解出了字节", result.bytes > 0L)
      // 内容对账：解出来的每个文件字节必须与 tar 里的一致（回退真的解完了，不是半份）。
      for (i in 0 until 12) {
        val expected = ByteArray(1000 + i * 37) { ('a' + i).code.toByte() }
        val actual = File(File(dest, "dir$i"), "file$i.bin").readBytes()
        assertTrue("dir$i/file$i.bin 内容必须与归档一致", Arrays.equals(expected, actual))
      }
      // 线程池不泄漏：回退完成后不得残留**新增的** worker 线程。
      val deadline = System.currentTimeMillis() + 5_000
      while (System.currentTimeMillis() < deadline && leakedWorkers(before).isNotEmpty()) {
        Thread.sleep(20)
      }
      val leaked = leakedWorkers(before)
      assertTrue("并行解码线程池必须被关闭，不得残留 worker 线程：" + leaked.map { it.name }, leaked.isEmpty())
    } finally {
      file.delete()
      SnapshotFs.deletePath(dest)
    }
  }

  /** 当前仍存活、且不在 [baseline] 里的并行 worker 线程（排除同 JVM 其它用例的残留）。 */
  private fun leakedWorkers(baseline: Set<Thread>): List<Thread> =
    Thread.getAllStackTraces().keys.filter {
      it.name == WORKER_THREAD_NAME && it.isAlive && it !in baseline
    }

  /** 并行成功的路径必须如实报告 mode=parallel 与实际线程数（不得把回退记成并行）。 */
  @Test
  fun parallelSuccessReportsParallelModeAndThreadCount() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    val dest = Files.createTempDirectory("snapshot-parallel-ok").toFile()
    try {
      val result = SnapshotExtractor.extractParallel(
        sourceOf(file), multi.size.toLong(), dest, { _, _ -> }, plan = SnapshotExtractor.ParallelPlan(2),
      )
      assertEquals(SnapshotExtractor.ExtractResult.MODE_PARALLEL, result.mode)
      assertEquals(2, result.threads)
      assertTrue("解出的字节合计必须等于 tar 里常规文件体量", result.bytes > 0L)
    } finally {
      file.delete()
      SnapshotFs.deletePath(dest)
    }
  }

  /** 线程数 < 2 时必须直接走单线程路径（不做无谓封装），并如实报告。 */
  @Test
  fun singleThreadPlanBypassesParallelWrapper() {
    val tar = tarBytes()
    val multi = multiStreamXz(tar, pieces = 3)
    val file = writeTemp(multi)
    val dest = Files.createTempDirectory("snapshot-sequential-plan").toFile()
    try {
      val result = SnapshotExtractor.extractParallel(
        sourceOf(file), multi.size.toLong(), dest, { _, _ -> }, plan = SnapshotExtractor.ParallelPlan.SINGLE,
      )
      assertEquals(SnapshotExtractor.ExtractResult.MODE_SEQUENTIAL, result.mode)
      assertEquals(1, result.threads)
    } finally {
      file.delete()
      SnapshotFs.deletePath(dest)
    }
  }

  // ── 3. 线程数策略（纯函数，逐档反证）────────────────────────────────────────

  @Test
  fun threadPlanNeverExceedsFourOrCoresOrBlocks() {
    // 上限 4：核数与堆都充足时也只到 4（手机上 8 线程收益递减且字典内存翻倍）。
    assertEquals(4, SnapshotExtractor.ParallelPlan.threadsFor(cores = 16, maxHeapBytes = 512L * 1024 * 1024))
    // 不得超过核数。
    assertEquals(2, SnapshotExtractor.ParallelPlan.threadsFor(cores = 2, maxHeapBytes = 512L * 1024 * 1024))
    // 不得超过块数（34 块的快照上 4 线程绰绰有余；块数少时按块数）。
    assertEquals(1, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 512L * 1024 * 1024, blockCount = 1))
    assertEquals(3, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 512L * 1024 * 1024, blockCount = 3))
  }

  @Test
  fun threadPlanDegradesOnSmallHeaps() {
    // 低于 128 MiB：强制单线程（128 MiB 是 2 线程实测仍余 50 MiB 的下界）。
    assertEquals(1, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 96L * 1024 * 1024))
    assertEquals(1, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 128L * 1024 * 1024 - 1))
    // 128 MiB .. 256 MiB：最多 2 线程。
    assertEquals(2, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 128L * 1024 * 1024))
    assertEquals(2, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 255L * 1024 * 1024))
    // 达到 256 MiB：放开到 4。
    assertEquals(4, SnapshotExtractor.ParallelPlan.threadsFor(cores = 8, maxHeapBytes = 256L * 1024 * 1024))
    // 单核：无论堆多大都只能 1（并行没有意义，只会多线程开销）。
    assertEquals(1, SnapshotExtractor.ParallelPlan.threadsFor(cores = 1, maxHeapBytes = 1024L * 1024 * 1024))
  }

  // ── 4. APK 内 STORED 资产的偏移源（fd 生命周期 + 边界）──────────────────────

  /**
   * [SnapshotExtractor.ApkAssetSeekable] 的边界：seek 越界必须抛、读到条目末尾必须返回 -1、
   * 关闭后再读必须抛。fd 泄漏的判据在 [apkAssetSourceOpensIndependentHandles]。
   */
  @Test
  fun apkAssetSeekableRespectsOffsetAndLength() {
    val payload = ByteArray(4096) { (it % 251).toByte() }
    val host = Files.createTempFile("apk-asset-seekable", ".bin").toFile()
    try {
      // 在文件前面塞一段无关字节，模拟「APK 里条目之前的内容」。
      val prefix = ByteArray(1000) { 0x7f }
      host.writeBytes(prefix + payload)
      val seekable = SnapshotExtractor.ApkAssetSeekable(host.absolutePath, 1000L, payload.size.toLong())
      try {
        assertEquals("length() 必须是条目长度", payload.size.toLong(), seekable.length())
        val read = ByteArray(payload.size)
        var off = 0
        while (off < read.size) {
          val n = seekable.read(read, off, read.size - off)
          if (n < 0) break
          off += n
        }
        assertTrue("从 startOffset 读出的字节必须等于条目本体", Arrays.equals(payload, read))
        assertEquals("读到末尾后必须返回 -1", -1, seekable.read())
        seekable.seek(0L)
        assertEquals("seek(0) 后必须能重读首字节", payload[0].toInt() and 0xff, seekable.read())
        try {
          seekable.seek(payload.size + 1L)
          throw AssertionError("seek 越过条目末尾必须抛 IOException")
        } catch (_: java.io.IOException) {
          // 期望路径。
        }
      } finally {
        seekable.close()
      }
      try {
        seekable.read()
        throw AssertionError("close 之后读必须抛 IOException")
      } catch (_: java.io.IOException) {
        // 期望路径。
      }
    } finally {
      host.delete()
    }
  }

  /**
   * 每条解码流的字典缓存必须在块结束后交还，不得跨块累积（#1714）。
   *
   * 判据不是「跑通」——跑通在 192 MiB 堆上也常常成立，只是概率性 OOM。判据是
   * **默认进程级缓存确实没被这些流留下条目**：块解完就该 `reset`。
   *
   * 负控口径：把 `ParallelXzInputStream` 里那两处 `cache.reset()` 去掉，本用例必须红
   * （默认缓存会留下该块大小的缓冲区）。这条用例存在的意义就是让那两行不可被顺手删掉。
   */
  @Test
  fun parallelDecodeReleasesPerBlockCaches() {
    val payload = tarBytes(files = 6)
    val xz = multiStreamXz(payload, pieces = 3)
    val file = writeTemp(xz)
    try {
      val stream = SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 2)
      try {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = stream.read(buf)
          if (n < 0) break
          out.write(buf, 0, n)
        }
        assertTrue("并行输出必须非空", out.size() == payload.size)
      } finally {
        stream.close()
      }
      // 每一块（含探针那次）都必须走交还这一层，判据取自生产代码的计数器。
      assertTrue("探针 + 每块都必须交还缓存，实际次数=" + stream.cacheResetCount(),
        stream.cacheResetCount() >= 4)
    } finally {
      file.delete()
    }
  }

  /**
   * worker 不得无限超前于消费者（#1714 的主因）。
   *
   * 队列是**每块一份**、每份 QUEUE_CHUNKS 片。不限制超前量时，worker 会一路抢到
   * 最后一个块，块数 × 2 MiB 的排队内存正是设备 OOM 的来源。
   *
   * 负控口径：把 awaitConsumerCloseEnough 里的等待去掉（回到旧行为），本用例必须红。
   */
  @Test
  fun parallelDecodeLimitsWorkerLookahead() {
    val payload = tarBytes(files = 8)
    val xz = multiStreamXz(payload, pieces = 32)
    val file = writeTemp(xz)
    try {
      val stream = SnapshotExtractor.ParallelXzInputStream(sourceOf(file), 2)
      try {
        val head = ByteArray(1)
        assertTrue("必须能读到首字节", stream.read(head) > 0)
        Thread.sleep(1500)
        val lookahead = stream.decodedAheadOfConsumer()
        assertTrue(
          "worker 超前了 " + lookahead + " 块，超过限流窗口",
          lookahead <= SnapshotExtractor.ParallelXzInputStream.lookaheadLimit(),
        )
      } finally {
        stream.close()
      }
    } finally {
      file.delete()
    }
  }

  /** 每个 worker 必须拿到**独立**句柄：源被 open 多次时不得复用同一个流（否则 seek 互相踩）。 */
  @Test
  fun apkAssetSourceOpensIndependentHandles() {
    val payload = ByteArray(2048) { (it % 97).toByte() }
    val host = Files.createTempFile("apk-asset-source", ".bin").toFile()
    try {
      host.writeBytes(payload)
      val source = SnapshotExtractor.ApkAssetSource(host.absolutePath, 0L, payload.size.toLong())
      val first = source.open()
      val second = source.open()
      try {
        assertTrue("两次 open 必须是不同实例（独立 fd）", first !== second)
        // 交错读：若共享同一个 fd，第二次读会从错误的偏移继续。
        assertEquals(payload[0].toInt() and 0xff, first.read())
        assertEquals(payload[0].toInt() and 0xff, second.read())
        assertEquals(payload[1].toInt() and 0xff, first.read())
        assertEquals(payload[1].toInt() and 0xff, second.read())
      } finally {
        first.close()
        second.close()
      }
    } finally {
      host.delete()
    }
  }
}
