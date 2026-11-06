package com.dsharnessmobile.shell

import android.util.Log
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream

/**
 * 内嵌快照**资产字节**的对账策略（0.14.7 / task-9）。
 *
 * 为什么单列一个对象：既有链路里 `assets/snapshot.sha256` 只是**声明值**，它被拿去和 live/已提交的
 * `.snapshot-fingerprint` 比较（ShellState 那一侧的新鲜度判据），而真正被解码的
 * `assets/snapshot.tar.xz` **从不做摘要校验**——Android AssetManager 读 STORED 项也不校 zip CRC。
 * 于是资产字节坏掉时（安装介质损坏、ROM 优化器重写 APK 等），用户能拿到的唯一线索是解码器内部的
 * `org.tukaani.xz.CorruptedInputException: Compressed data is corrupt`：
 * 它只说「输入坏了」，**不说「哪一段不一致、期望什么、实际什么」**。
 *
 * 本对象提供**解码之前**的流式摘要对账，使失败能自证。它刻意不假设任何具体损坏原因——
 * 真机（华为 SCA-AL00）未连接，无法比对 base.apk，本项**不声称**已找到 asset 为何损坏。
 *
 * 成本纪律：固定 64KB 缓冲的**流式**读，不整读入内存（快照 194MB），也不解码（比解码便宜一个数量级）。
 */
internal object SnapshotBundledAsset {

  /** 内嵌资产字节与安装包内声明值不一致（被改写/截断）。 */
  const val CODE_CORRUPT = "snapshot-bundled-asset-corrupt"

  /** 内嵌资产连打开/读取都失败（缺席、权限、AssetManager 异常）。与「摘要不一致」分开归类。 */
  const val CODE_UNREADABLE = "snapshot-bundled-asset-unreadable"

  /** 解压完成但 staged 运行时缺件（校验支的失败，此前也是"只 return false"的静默支）。 */
  const val CODE_STAGE_INCOMPLETE = "snapshot-stage-incomplete"

  /** 流式 SHA-256（十六进制小写）+ 读到的字节数。 */
  data class Digest(val hex: String, val bytes: Long)

  /**
   * 对流做一次**顺序** SHA-256（不解码、不缓存整个流）。
   *
   * @param open 打开输入流的实现（单测注入内存流，生产注入 AssetManager 流）。
   */
  fun digest(open: () -> InputStream, bufferSize: Int = 64 * 1024): Digest {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    var bytes = 0L
    open().use { input ->
      val buf = ByteArray(bufferSize)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        if (n > 0) {
          md.update(buf, 0, n)
          bytes += n
        }
      }
    }
    return Digest(md.digest().joinToString("") { "%02x".format(it) }, bytes)
  }

  /**
   * 纯判据：实际摘要 vs 声明摘要。
   *
   * @param declared 归一化后的声明值；null/空 = 声明不可用（已由 SnapshotFingerprintPolicy 归类，此处不重复判）。
   * @return null = 通过；非 null = (errorCode, 可落盘的一行 detail)。
   */
  fun verdict(declared: String?, actual: Digest): Pair<String, String>? {
    if (declared.isNullOrEmpty()) return null
    if (declared == actual.hex) return null
    return CODE_CORRUPT to (
      "内嵌运行时快照资产与安装包内声明值不一致（assets/snapshot.tar.xz 字节被改写/截断）："
        + "expected=" + declared + " actual=" + actual.hex + " bytes=" + actual.bytes
        + "。本次解码未开始即被拦下，现有用户数据未改动；请重新安装完整安装包。"
      )
  }
}

/**
 * 可**随机访问**的 xz 字节源工厂（每个 worker 各开一份）。
 *
 * 为什么需要工厂而不是一个流：并行解码要求每个 worker 持**独立**的文件句柄
 * （SeekableXZInputStream 的 position 是实例状态，共享会让 seek 互相踩）。
 * 生产实现见 [SnapshotExtractor.ApkAssetSource]（APK 内 STORED 条目 + 绝对偏移）。
 */
fun interface SnapshotSeekableSource {
  /** 打开一份新的可 seek 流；调用方负责 close。 */
  fun open(): SeekableInputStream
}

/**
 * Shared snapshot extraction: xz tar → dest with owner-only permissions
 * (dsh's credentials provider fails loud on world-readable secrets) and
 * symlink preservation. Used by both the bundled snapshot (assets) and the
 * online update path (downloaded file).
 *
 * Regular files are owner-readable/writable. Their executable bit is based on
 * their payload signature rather than the tar mode: WSL-mounted archives can
 * flatten ordinary files to 0777, while Android app processes cannot set the
 * `security.android.exec` xattr anyway. Engine execution uses linker64 and the
 * Termux exec hook supplied by EngineManager.
 *
 * ── 并行解码（0.2.2-rc.1 首启提速）─────────────────────────────────────────────
 * 设备实测：`snapshotExtract` 段 **337,227 ms**（168,499,300 B 快照）。
 * 本机同口径分解（与设备同一套解码器：commons-compress 1.28.0 + org.tukaani:xz 1.10）证明
 * **93% 是 xz 解码**：单趟「边解码边落盘」29.5 s，其中解码 27.4 s、落盘 + 逐文件 chmod 仅 2.1 s。
 *
 * 该快照是 **1 stream / 34 blocks**（每块 25,165,824 B，`xz --list -v` 实测），
 * 而 `XZCompressorInputStream` 是**单线程顺序解码**——34 个独立块被逐个串行解。
 * `org.tukaani.xz.SeekableXZInputStream` 提供 getBlockCount / getBlockSize / seekToBlock，
 * 因此可以「N 线程各解各块 + 按块序重组」把解码并行化；**tar 解析仍严格顺序**
 * （tar 只能顺序读，故并行只发生在「xz 字节 → 有界缓冲」这一段）。
 *
 * 三条纪律（缺一不可）：
 *  1. **默认安全**：线程数由 [ParallelPlan.threadsFor] 按 CPU 核数与**可用堆**决定，
 *     堆不足或核数不足时退回单线程；上限 4（手机上 8 线程收益递减且字典内存翻倍）。
 *  2. **失败必回落**：并行路径抛任何 Throwable → 记日志后从同一份可 seek 源用单线程重做一次，
 *     **解压不得因为并行而失败**（并行出问题不能变成「用户装不了应用」）。
 *  3. **单线程路径逐行不变**：[extract] 的既有实现一字未改，并行走新增的 [extractParallel]。
 */
object SnapshotExtractor {

  private const val TAG = "dsh-snap"

  /** 并行解码的块内分片大小（有界队列的单元）。 */
  private const val CHUNK_BYTES = 512 * 1024

  /** 每个块的有界队列容量（片数）：worker 阻塞在 put 上即背压。 */
  private const val QUEUE_CHUNKS = 4

  /**
   * 并行解码计划。
   *
   * 为什么是**纯函数 + 数据类**而不是在解压里现算：线程数策略最危险的形态是
   * 「低端机上按核数开到 8 线程 ⇒ 8 × 8 MiB xz 字典 ⇒ OOM 崩在解压里」，
   * 而这条只有把「核数 / 可用堆 → 线程数」抽成纯函数才可能在 JVM 上逐条反证。
   *
   * 阈值来自实测（本机 `-Xmx` 三档 × 2/4 线程，全部无 OOM 且字节等价）：
   *   `-Xmx128m` 2 线程 used 50 MiB / 4 线程 used 78 MiB；
   *   `-Xmx192m` 2 线程 used 77 MiB / 4 线程 used 68 MiB；
   *   `-Xmx256m` 4 线程 used 93 MiB。
   * 128 MiB 是「2 线程仍留 50 MiB 余量」的下界，256 MiB 是「4 线程仍留 160 MiB 余量」的下界。
   * 低于下界一律降档：**宁可慢也不 OOM**。
   */
  data class ParallelPlan(val threads: Int) {

    companion object {
      /** 硬上限：手机上再多的核也不值得（字典内存线性增长、收益递减）。 */
      const val MAX_THREADS = 4

      /** 低于此可用堆：只跑单线程（128 MiB 是 2 线程实测仍余 50 MiB 的下界）。 */
      const val MIN_HEAP_FOR_TWO_BYTES = 128L * 1024L * 1024L

      /** 达到此可用堆才允许 4 线程（256 MiB 是 4 线程实测仍余 160 MiB 的下界）。 */
      const val MIN_HEAP_FOR_FOUR_BYTES = 256L * 1024L * 1024L

      /** 单线程计划（测试与回退路径共用）。 */
      val SINGLE = ParallelPlan(1)

      /**
       * 纯判据：核数 + 可用堆 + 块数 → 线程数。
       *
       * @param cores 可用处理器数（生产传 Runtime.availableProcessors()）。
       * @param maxHeapBytes 可用堆上限（生产传 Runtime.maxMemory()）。
       * @param blockCount xz 的块数（线程数不得超过它——多于块数只会空转）。
       */
      fun threadsFor(cores: Int, maxHeapBytes: Long, blockCount: Int = Int.MAX_VALUE): Int {
        if (cores <= 1) return 1
        if (maxHeapBytes < MIN_HEAP_FOR_TWO_BYTES) return 1
        val heapCap = if (maxHeapBytes >= MIN_HEAP_FOR_FOUR_BYTES) MAX_THREADS else 2
        val wanted = minOf(cores, heapCap, blockCount).coerceAtLeast(1)
        // threads >= 2 才启用并行：1 线程走原路径，不做无谓封装（与纪律 3 同源）。
        return if (wanted < 2) 1 else wanted
      }

      /** 生产计划：按本进程的核数与堆上限推导。 */
      fun production(): ParallelPlan {
        val runtime = Runtime.getRuntime()
        return ParallelPlan(threadsFor(runtime.availableProcessors(), runtime.maxMemory()))
      }
    }
  }

  /**
   * 解压上限（审查 §5.11 / S-10）：默认值按快照真实体量的 3–5 倍留余量
   * （实测：条目 ~6 万、解压后 ~2.5 GB、单文件最大 ~200 MB）。
   * 做成**可注入**而不是硬编码常量，是为了让单测能用小上限真跑一遍判据
   * （写一个 24 万条目的归档去测等于让测试自己变成解压炸弹）。
   */
  data class Limits(
    val maxEntries: Int = 240_000,
    val maxTotalBytes: Long = 8L * 1024L * 1024L * 1024L,
    val maxSingleFileBytes: Long = 2L * 1024L * 1024L * 1024L,
  ) {
    companion object {
      /** 生产口径。 */
      val DEFAULT = Limits()
    }
  }

  /**
   * Extract an xz-compressed tar stream（**单线程路径，逐行未改**）。
   * @param input raw xz stream.
   * @param totalBytes expected stream size (for progress; 0 = unknown).
   * @param dest destination root (the archive holds usr/ + home/).
   * @param onProgress bytesDone, bytesTotal.
   * @param runtimeRoot absolute link targets are allowed only inside this root. The
   *   bundled snapshot ships absolute applets (vim/busybox …) that point at the
   *   *live* runtime path (`files/usr/...`), so extraction into a staging directory
   *   must still accept them; after the atomic swap they resolve correctly. Defaults
   *   to [dest] for in-place extraction.
   * @return 本次解出的**常规文件字节合计**（tar entry size 累加；目录与链接按 0 计）。
   */
  fun extract(
    input: InputStream,
    totalBytes: Long,
    dest: File,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File = dest,
    limits: Limits = Limits.DEFAULT,
  ): Long {
    // D-3（0.14.7 / task-9）：tar/xz 必须在**任何**退出路径上关闭。
    // 旧实现把 `tar.close()` 放在函数体末尾（无 try/finally）：中途抛异常（超限判据、路径解算失败、
    // 写盘 EACCES、**解码器抛 CorruptedInputException**）时两条流都不关 —— 而这条路径正是真机
    // 启动失败时走的那条（真机 logcat 实证：XZCompressorInputStream.read 抛 CorruptedInputException）。
    // 不关流的后果不是「泄漏一点点」：xz 解码器持有 native 级缓冲，且调用方在刷新事务里会立刻重试，
    // 每次启动都叠一次。
    val xz = XZCompressorInputStream(input)
    val tar = TarArchiveInputStream(xz)
    var primary: Throwable? = null
    try {
      return extractEntries(tar, dest, totalBytes, onProgress, runtimeRoot, limits)
    } catch (t: Throwable) {
      primary = t
      throw t
    } finally {
      // 关闭顺序与打开顺序相反（tar 先关：它可能从 xz 读尾部）。**任一 close 抛异常都不得掩盖
      // 正在传播的真因**——与 kotlin use{} 的语义对齐（close 异常进 addSuppressed）：
      // 真机现场的真因是 CorruptedInputException，若被一个 close 异常顶掉，本次修复就白做了。
      closeKeepingPrimary(tar, primary)
      closeKeepingPrimary(xz, primary)
    }
  }

  /**
   * 并行解压：从**可随机访问**的 xz 源按块并行解码，失败自动回落单线程。
   *
   * @param source 可 seek 的 xz 字节源（生产见 [ApkAssetSource]；每个 worker 各开一份）。
   * @param plan 并行计划；[ParallelPlan.threads] 小于 2 时**直接走单线程**（不做无谓封装）。
   * @return 常规文件字节合计，语义与 [extract] 相同。
   */
  fun extractParallel(
    source: SnapshotSeekableSource,
    totalBytes: Long,
    dest: File,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File = dest,
    limits: Limits = Limits.DEFAULT,
    plan: ParallelPlan = ParallelPlan.production(),
  ): ExtractResult {
    if (plan.threads < 2) {
      val bytes = extractSequentialFromSource(source, totalBytes, dest, onProgress, runtimeRoot, limits)
      return ExtractResult(bytes, ExtractResult.MODE_SEQUENTIAL, 1)
    }
    val startedMs = android.os.SystemClock.elapsedRealtime()
    try {
      val parallelStream = ParallelXzInputStream(source, plan.threads)
      val bytes = extractEntriesFrom(parallelStream, dest, totalBytes, onProgress, runtimeRoot, limits)
      Log.i(
        TAG,
        "snapshot extract used parallel xz decode threads=" + plan.threads
          + " uncompressedBytes=" + bytes
          + " durMs=" + (android.os.SystemClock.elapsedRealtime() - startedMs),
      )
      return ExtractResult(bytes, ExtractResult.MODE_PARALLEL, plan.threads)
    } catch (t: Throwable) {
      // 纪律 2：并行失败**不得**让解压失败。回落单线程重做一次——每个 tar 条目在写入前都
      // deleteIfExists 目标，目录 mkdirs 与符号链接分支同样幂等，故重做是安全的。
      Log.w(
        TAG,
        "parallel xz decode failed after " + (android.os.SystemClock.elapsedRealtime() - startedMs)
          + "ms; falling back to single thread (this is not an extraction failure)",
        t,
      )
      val bytes = extractSequentialFromSource(source, totalBytes, dest, onProgress, runtimeRoot, limits)
      return ExtractResult(bytes, ExtractResult.MODE_FALLBACK, 1)
    }
  }

  /**
   * 从可 seek 源做**顺序**解压，用于回退路径与「计划线程数不足 2」。
   *
   * 为什么不用 [extract]：后者建的是 commons-compress 的 XZCompressorInputStream，
   * 而它**只解第一个 xz stream**（实测：多 stream 输入上读出的字节远少于原始 tar，
   * 且不报错——静默截断）。生产的 bundled 快照是 1 stream / 34 blocks，两者等价；
   * 但并行路径按块解的是**全部块**（跨 stream 也是块），若回退用只解首 stream 的解码器，
   * 就会出现「并行对、回退错」的不一致。故回退与单线程计划一律走
   * org.tukaani.xz.XZInputStream（多 stream 依次解），保证**同一份输入两条路径字节相同**。
   *
   * [extract] 保持逐行不变：它服务的仍是 bundled 资产那条单 stream 路径。
   */
  private fun extractSequentialFromSource(
    source: SnapshotSeekableSource,
    totalBytes: Long,
    dest: File,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File,
    limits: Limits,
  ): Long {
    val seekable = source.open()
    val stream: InputStream = try {
      org.tukaani.xz.XZInputStream(seekable)
    } catch (t: Throwable) {
      try { seekable.close() } catch (_: Throwable) { }
      throw t
    }
    return extractEntriesFrom(stream, dest, totalBytes, onProgress, runtimeRoot, limits)
  }

  /**
   * 一次解压的结果。
   *
   * @param bytes 常规文件字节合计（= 解压后字节数，归一化判据的分子）。
   * @param mode 实际走的路径：parallel / sequential / fallback。**必须如实**——把回退记成
   *   parallel 会让「并行生效了没有」这件事在诊断面上永久失真。
   * @param threads 实际并行线程数（非并行路径恒为 1）。
   */
  data class ExtractResult(val bytes: Long, val mode: String, val threads: Int) {
    companion object {
      /** 并行解码成功。 */
      const val MODE_PARALLEL = "parallel"

      /** 走的是改造前的单线程路径（计划线程数不足 2 或调用方显式要求）。 */
      const val MODE_SEQUENTIAL = "sequential"

      /** 并行尝试失败后回落单线程（**不是**解压失败）。 */
      const val MODE_FALLBACK = "fallback"
    }
  }

  /**
   * 从 [stream] 建 tar 并解压，**负责关闭**两条流（与 [extract] 的 finally 同语义）。
   */
  private fun extractEntriesFrom(
    stream: InputStream,
    dest: File,
    totalBytes: Long,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File,
    limits: Limits,
  ): Long {
    val tar = TarArchiveInputStream(stream)
    var primary: Throwable? = null
    try {
      return extractEntries(tar, dest, totalBytes, onProgress, runtimeRoot, limits)
    } catch (t: Throwable) {
      primary = t
      throw t
    } finally {
      closeKeepingPrimary(tar, primary)
      closeKeepingPrimary(stream, primary)
    }
  }

  /**
   * APK 内 **STORED** 资产的绝对偏移源。
   *
   * 前提（已在设备实测验证，不是推断）：`assets/snapshot.tar.xz` 在 APK 里是
   * `compress_type=0`（STORED，见 build.gradle.kts 的 `noCompress += "xz"`），
   * 因此 `AssetFileDescriptor.startOffset` 就是该条目在 `base.apk` 里的**真实文件偏移**；
   * 从它直接读出的字节流与 `assets.open()` 读出的 SHA-256 完全相同（设备上实测两者都是
   * `c035123ad666283f1e0d0273c66d6770e440177fa884afe39801ecea2db83a12`）。
   *
   * fd 生命周期：**每次 [open] 各开一个** RandomAccessFile，由 [ApkAssetSeekable.close] 关闭；
   * worker 结束时必须 close（[ParallelXzInputStream] 用 use{} 保证）。线程数 ≤ 4 ⇒ fd ≤ 4。
   */
  class ApkAssetSource(
    private val apkPath: String,
    private val startOffset: Long,
    private val length: Long,
  ) : SnapshotSeekableSource {
    override fun open(): SeekableInputStream = ApkAssetSeekable(apkPath, startOffset, length)
  }

  /** 见 [ApkAssetSource]。position 相对 [startOffset]，length 截到条目长度，越界不可读。 */
  class ApkAssetSeekable(
    apkPath: String,
    private val startOffset: Long,
    private val length: Long,
  ) : SeekableInputStream() {
    private val file = RandomAccessFile(apkPath, "r")
    private var position = 0L
    private var closed = false

    override fun length(): Long = length

    override fun position(): Long = position

    override fun seek(pos: Long) {
      if (pos < 0L || pos > length) throw IOException("seek 越界: " + pos + " (0.." + length + ")")
      position = pos
    }

    override fun read(): Int {
      val one = ByteArray(1)
      return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (closed) throw IOException("stream closed")
      if (len == 0) return 0
      val remaining = length - position
      if (remaining <= 0L) return -1
      val want = minOf(len.toLong(), remaining).toInt()
      file.seek(startOffset + position)
      val n = file.read(b, off, want)
      if (n > 0) position += n
      return n
    }

    override fun available(): Int = (length - position).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()

    override fun close() {
      if (closed) return
      closed = true
      try {
        file.close()
      } catch (_: Throwable) {
        // 关闭失败不得掩盖正在传播的解压真因（与 closeKeepingPrimary 同纪律）。
      }
    }
  }

  /** 关闭 [closeable]；失败时若有正在传播的 [primary] 就挂成 suppressed，否则如实抛出。 */
  private fun closeKeepingPrimary(closeable: java.io.Closeable, primary: Throwable?) {
    try {
      closeable.close()
    } catch (closeError: Throwable) {
      if (primary != null) primary.addSuppressed(closeError) else throw closeError
    }
  }

  /**
   * 解压主体（D-3 拆出：让 [extract] 的 try/finally 只负责关闭，主体保持线性易读）。
   *
   * 行为与拆分前逐行相同 —— 本函数**不关闭**任何流，由调用方的 finally 统一负责。
   *
   * @return 常规文件字节合计（tar entry size 累加；目录与链接按 0 计）。
   */
  private fun extractEntries(
    tar: TarArchiveInputStream,
    dest: File,
    totalBytes: Long,
    onProgress: (Long, Long) -> Unit,
    runtimeRoot: File,
    limits: Limits,
  ): Long {
    val destCanon = dest.canonicalPath
    val runtimeCanon = try {
      runtimeRoot.canonicalPath
    } catch (_: Exception) {
      destCanon
    }
    var done = 0L
    var entries = 0
    var entry: TarArchiveEntry? = tar.nextEntry
    while (entry != null) {
      // 解压上限（审查 §5.11 / S-10）：本层自认是「沙盒边界」（在线更新走明文 HTTP 可篡改），
      // 但旧实现只防了路径穿越，**没防解压炸弹**——xz 炸弹/海量小文件足以撑爆 /data 并长时间占 CPU。
      // 上限按快照真实体量的 3–5 倍留余量（实测：条目 ~6 万、解压后 ~2.5 GB、单文件最大 ~200 MB）。
      entries += 1
      if (entries > limits.maxEntries) {
        throw IOException("快照归档条目数超限（>" + limits.maxEntries + "），已中止解压")
      }
      done += entry.size.coerceAtLeast(0)
      if (done > limits.maxTotalBytes) {
        throw IOException("快照归档解压体量超限（>" + limits.maxTotalBytes + " 字节），已中止解压")
      }
      if (entry.size > limits.maxSingleFileBytes) {
        throw IOException("快照归档单文件超限（" + entry.name + " > " + limits.maxSingleFileBytes + " 字节），已中止解压")
      }
      // 路径穿越防护（2026-08-23 安全审计 CRITICAL 修复）：拒绝绝对路径/../ 越界 /
      // 符号链接逃逸——在线更新快照由明文 HTTP（可篡改）路径提供，此层是沙盒边界。
      val target = resolveEntry(dest, destCanon, entry)
      if (target == null) {
        Log.w(TAG, "skipping unsafe tar entry: " + entry.name)
        entry = tar.nextEntry
        continue
      }
      when {
        entry.isDirectory -> target.mkdirs()
        entry.isSymbolicLink -> {
          target.parentFile?.mkdirs()
          val linkPath = java.nio.file.Paths.get(entry.linkName)
          if (!isLinkTargetAllowed(entry.linkName, target.parentFile, destCanon, runtimeCanon)) {
            Log.w(TAG, "skipping unsafe symlink: " + entry.name + " -> " + entry.linkName)
            entry = tar.nextEntry
            continue
          }
          // deleteIfExists does not follow links: on an overwrite re-extract an old symlink may be
          // dangling (File.exists() follows links, returning false for dangling ones, so the stale
          // link would survive and createSymbolicLink would throw FileAlreadyExistsException —
          // measured on the v0.10.7 upgrade re-extract). Also safe for regular files/dirs.
          java.nio.file.Files.deleteIfExists(target.toPath())
          java.nio.file.Files.createSymbolicLink(target.toPath(), linkPath)
        }
        else -> {
          target.parentFile?.mkdirs()
          // Overwrite-safety: a previous extraction can leave a read-only regular file
          // (measured: termux-am/am.apk with 0400 on some emulator ROMs — FileOutputStream
          // would fail EACCES on the upgrade re-extract). deleteIfExists does not follow
          // links, so stale/dangling files are cleared before the new copy is written,
          // mirroring the symlink branch above.
          java.nio.file.Files.deleteIfExists(target.toPath())
          val prefix = ByteArray(4)
          var prefixLength = 0
          target.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            var n = tar.read(buf)
            while (n >= 0) {
              if (prefixLength < prefix.size) {
                val copied = minOf(prefix.size - prefixLength, n)
                System.arraycopy(buf, 0, prefix, prefixLength, copied)
                prefixLength += copied
              }
              out.write(buf, 0, n)
              n = tar.read(buf)
            }
          }
          target.setReadable(false, false)
          target.setReadable(true, true)
          target.setWritable(true, true)
          target.setExecutable(SnapshotFileMode.isDirectlyExecutable(prefix, prefixLength), true)
        }
      }
      // done 已在循环头部（上限检查处）累加过 entry.size——这里不再重复累加（#680）：
      // 双倍计数让 8 GiB 总量上限在 4 GiB 就触发，正常快照被误判成解压炸弹。
      if (done % (1024 * 1024) < entry.size) onProgress(done, totalBytes)
      entry = tar.nextEntry
    }
    return done
  }

  /**
   * 按 XZ block 并行解码、**严格按块序**对外输出字节的 InputStream。
   *
   * 结构：N 个 worker 各持一个独立的 SeekableXZInputStream（经 [SnapshotSeekableSource.open]
   * 各开一份），只解自己认领的块，把解出的字节按 [CHUNK_BYTES] 分片塞进**该块专属的有界队列**；
   * 消费者（TarArchiveInputStream）从当前块队列取，取空且该块已解完就前进到下一块。
   *
   * 有界性（本类最危险的形态是「把整份解压到内存里」）：
   *  - 队列容量固定 [QUEUE_CHUNKS] 片 ⇒ worker 满了就阻塞在 put 上（背压），
   *    内存上界 = threads × QUEUE_CHUNKS × [CHUNK_BYTES]（4 线程 = 8 MiB）；
   *  - 每 worker 另持 xz 字典（preset 6 = 8 MiB），4 线程合计 32 MiB；
   *  - 与快照总大小无关。
   *
   * 正确性：块内 CRC64 由 xz 库自校验；块序由消费者强制，字节流与单线程解码**逐字节相同**
   * （单测用多块夹具比对 SHA-256）。
   */
  internal class ParallelXzInputStream(
    private val source: SnapshotSeekableSource,
    threads: Int,
  ) : InputStream() {

    private val blockSizes: LongArray
    private val queues: Array<ArrayBlockingQueue<ByteArray>>
    private val finished: Array<AtomicBoolean>
    private val failures: Array<AtomicReference<Throwable>>
    private val dispatched = AtomicInteger(0)
    private val pool: ExecutorService

    private var blockIndex = 0
    private var chunk: ByteArray? = null
    private var chunkPos = 0

    @Volatile
    private var closed = false

    init {
      val sizes = ArrayList<Long>()
      source.open().use { probe ->
        val stream = SeekableXZInputStream(probe)
        val count = stream.blockCount
        for (i in 0 until count) sizes += stream.getBlockSize(i)
      }
      if (sizes.isEmpty()) throw IOException("xz 归档没有任何 block，无法并行解码")
      blockSizes = LongArray(sizes.size) { sizes[it] }
      queues = Array(blockSizes.size) { ArrayBlockingQueue<ByteArray>(QUEUE_CHUNKS) }
      finished = Array(blockSizes.size) { AtomicBoolean(false) }
      failures = Array(blockSizes.size) { AtomicReference<Throwable>(null) }
      val workerCount = minOf(threads, blockSizes.size).coerceAtLeast(1)
      pool = Executors.newFixedThreadPool(workerCount) { runnable ->
        Thread(runnable, "dsh-xz-decode").apply { isDaemon = true }
      }
      // 【护栏】下面这个 execute 循环与 pool 的创建之间**不得插入任何可能抛异常的语句**：
      // 构造函数中途抛时 parallelStream 从未赋值，extractParallel 的 catch 拿不到这个池，
      // 已启动的 worker 会泄漏。当前不可达（新建池的 execute 不会拒绝），故不加 try/finally
      // （那会是未被测试覆盖的死代码）；将来若要在此插入逻辑，必须先 pool.shutdownNow() 再抛。
      for (i in 0 until workerCount) {
        pool.execute { pump() }
      }
    }

    /** worker 主循环：按 [dispatched] 递增顺序认领块，解完再认领下一块。 */
    private fun pump() {
      while (!closed) {
        val index = dispatched.getAndIncrement()
        if (index >= blockSizes.size) return
        decodeBlock(index)
      }
    }

    private fun decodeBlock(index: Int) {
      try {
        source.open().use { seekable ->
          val stream = SeekableXZInputStream(seekable)
          stream.seekToBlock(index)
          var remaining = blockSizes[index]
          val buffer = ByteArray(CHUNK_BYTES)
          while (remaining > 0 && !closed) {
            val want = minOf(CHUNK_BYTES.toLong(), remaining).toInt()
            val read = stream.read(buffer, 0, want)
            if (read < 0) break
            remaining -= read
            queues[index].put(buffer.copyOf(read))
          }
        }
      } catch (t: Throwable) {
        failures[index].set(t)
      } finally {
        finished[index].set(true)
      }
    }

    /** 取下一片；null = 整条流结束。块内失败**如实抛出**（由 extractParallel 回落单线程）。 */
    private fun nextChunk(): ByteArray? {
      while (true) {
        if (blockIndex >= blockSizes.size) return null
        val failure = failures[blockIndex].get()
        if (failure != null) throw IOException("并行 xz 解码在第 " + blockIndex + " 块失败", failure)
        val queue = queues[blockIndex]
        val piece = try {
          queue.poll(100, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          throw IOException("并行 xz 解码被中断")
        }
        if (piece != null) return piece
        if (finished[blockIndex].get() && queue.isEmpty()) {
          blockIndex += 1
          continue
        }
      }
    }

    override fun read(): Int {
      var piece = chunk
      if (piece == null || chunkPos >= piece.size) {
        piece = nextChunk() ?: return -1
        chunk = piece
        chunkPos = 0
      }
      return piece[chunkPos++].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (len == 0) return 0
      var written = 0
      while (written < len) {
        var piece = chunk
        if (piece == null || chunkPos >= piece.size) {
          piece = nextChunk() ?: break
          chunk = piece
          chunkPos = 0
          continue
        }
        val available = piece.size - chunkPos
        val take = minOf(available, len - written)
        System.arraycopy(piece, chunkPos, b, off + written, take)
        chunkPos += take
        written += take
      }
      return if (written == 0) -1 else written
    }

    override fun available(): Int {
      val piece = chunk ?: return 0
      return piece.size - chunkPos
    }

    override fun close() {
      closed = true
      pool.shutdownNow()
      try {
        pool.awaitTermination(2, TimeUnit.SECONDS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
  }

  /**
   * Symlink target policy (sandbox boundary for archives fetched over plain HTTP).
   *
   * A relative target must resolve inside [destCanon] (the extraction root). An
   * absolute target is accepted only inside [runtimeCanon] — the app's live runtime
   * root — because the bundled snapshot ships absolute applet links
   * (`files/usr/libexec/busybox/vi`) that must survive staging and resolve after the
   * atomic swap. Termux residue (`/data/data/com.termux/...`) and escaping targets
   * stay rejected.
   */
  internal fun isLinkTargetAllowed(
    linkName: String,
    linkParent: File?,
    destCanon: String,
    runtimeCanon: String,
  ): Boolean {
    val linkPath = try {
      java.nio.file.Paths.get(linkName)
    } catch (_: Exception) {
      return false
    }
    val resolved = if (linkPath.isAbsolute) linkPath else java.io.File(linkParent, linkName).toPath()
    val linkCanon = try {
      resolved.normalize().toFile().canonicalPath
    } catch (_: Exception) {
      return false
    }
    val insideDest = linkCanon == destCanon || linkCanon.startsWith(destCanon + File.separator)
    val insideRuntime = linkCanon == runtimeCanon || linkCanon.startsWith(runtimeCanon + File.separator)
    return insideDest || insideRuntime
  }

  /** 解析 tar 条目到解压根内目标：拒绝绝对路径、../ 越界；返回 null 表示应跳过该条目。 */
  private fun resolveEntry(dest: File, destCanon: String, entry: TarArchiveEntry): File? {
    val name = entry.name.replace('\\', '/').trimStart('/')
    if (name.isEmpty() || name.contains("..")) return null
    val target = File(dest, name)
    return try {
      // canonicalPath 解析存在的父目录段；目标本身尚未创建时用父目录判定。
      val parentCanon = (target.parentFile?.canonicalPath ?: destCanon)
      if (parentCanon.startsWith(destCanon + File.separator) || parentCanon == destCanon) target else null
    } catch (_: Exception) {
      null
    }
  }
}
