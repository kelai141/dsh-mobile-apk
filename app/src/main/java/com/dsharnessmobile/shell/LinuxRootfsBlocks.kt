package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardOpenOption.READ
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.zip.CRC32
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream

/** Rebuild a multi-block XZ asset in a private temporary file before its normal digest check. */
internal object LinuxRootfsBlocks {
  private const val HEADER = 12
  private const val TAIL = 4096
  private const val MAX_BLOCKS = 512
  private const val MAX_MISSING_RANGES = 10
  private const val PARALLEL_BYTES = 4L * 1024 * 1024
  private const val MAX_DUPLICATE_READ_BYTES = 16L * 1024 * 1024

  private data class Shape(val compressed: Long, val plain: Long, val check: Int)
  private data class Block(val offset: Long, val shape: Shape) {
    val end get() = offset + shape.compressed
  }

  private data class Span(val start: Long, val end: Long) {
    val length get() = end - start
  }

  private fun reusableBlocks(source: FileChannel, old: List<Block>, target: List<Block>): Map<Shape, Block> {
    val needed = target.mapTo(HashSet()) { it.shape }
    val result = mutableMapOf<Shape, Block>()
    var remainingBudget = MAX_DUPLICATE_READ_BYTES
    val buffer by lazy(LazyThreadSafetyMode.NONE) { ByteBuffer.allocate(64 * 1024) }
    val digest by lazy(LazyThreadSafetyMode.NONE) { MessageDigest.getInstance("SHA-256") }
    fun fingerprint(block: Block): ByteArray {
      source.position(block.offset)
      var remaining = block.shape.compressed
      while (remaining > 0) {
        buffer.clear().limit(minOf(remaining, buffer.capacity().toLong()).toInt())
        val n = source.read(buffer)
        if (n <= 0) throw EOFException()
        digest.update(buffer.array(), 0, n)
        remaining -= n
      }
      return digest.digest()
    }
    for ((shape, matches) in old.groupBy { it.shape }) {
      if (shape !in needed) continue
      if (matches.size > 1) {
        val cost = matches.size * shape.compressed
        if (cost > remainingBudget) continue
        remainingBudget -= cost
        val first = fingerprint(matches.first())
        if (matches.drop(1).any { !first.contentEquals(fingerprint(it)) }) continue
      }
      result[shape] = matches.first()
    }
    return result
  }

  // The footer repeats both stream flags. The XZ parser checks its CRC and index,
  // and the manifest digest also covers this reconstructed stream header.
  private fun headerFromFooter(tail: ByteArray): ByteArray {
    var end = tail.size
    while (end > HEADER && tail[end - 1] == 0.toByte()) end--
    if ((tail.size - end) % 4 != 0 || tail[end - 2] != 0x59.toByte() || tail[end - 1] != 0x5a.toByte()) {
      throw IOException("Unsupported XZ stream footer")
    }
    val head = byteArrayOf(0xfd.toByte(), 0x37, 0x7a, 0x58, 0x5a, 0, 0, 0, 0, 0, 0, 0)
    tail.copyInto(head, 6, end - 4, end - 2)
    val crc = CRC32().apply { update(head, 6, 2) }.value
    for (i in 0..3) head[8 + i] = (crc ushr (i * 8)).toByte()
    return head
  }

  private fun prefetchRanges(spans: List<Span>, read: (Long, Int) -> ByteArray): Map<Long, ByteArray> {
    if (spans.size < 2) return emptyMap()
    // Overlap as many small requests as fit. Larger spans stream directly into the output file.
    val selected = mutableListOf<Span>()
    var budget = PARALLEL_BYTES
    for (span in spans.sortedBy { it.length }) {
      if (span.length > budget) break
      selected.add(span)
      budget -= span.length
    }
    if (selected.size < 2) return emptyMap()
    val pool = Executors.newFixedThreadPool(2)
    try {
      return pool.invokeAll(selected.map { span ->
        Callable { span.start to read(span.start, span.length.toInt()) }
      }).associate { it.get() }
    } catch (error: ExecutionException) {
      throw IOException("Cannot read missing XZ blocks", error.cause)
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      throw IOException("Interrupted while reading XZ blocks", error)
    } finally {
      pool.shutdownNow()
    }
  }

  /** Permit the index parser to read only the header and a bounded trailer. */
  private class Edges(val size: Long, val head: ByteArray, val tail: ByteArray) : SeekableInputStream() {
    private var cursor = 0L
    private val single = ByteArray(1)
    override fun length() = size
    override fun position() = cursor
    override fun seek(pos: Long) {
      if (pos !in 0..size) throw EOFException()
      cursor = pos
    }
    override fun read(): Int = if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 255
    override fun read(bytes: ByteArray, offset: Int, len: Int): Int {
      if (len == 0) return 0
      if (cursor == size) return -1
      val prefix = cursor < head.size
      val window = if (prefix) head else tail
      val index = if (prefix) cursor else cursor - size + tail.size
      if (index !in 0L until window.size.toLong()) throw IOException("XZ index exceeds the metadata window")
      val count = minOf(len, window.size - index.toInt())
      window.copyInto(bytes, offset, index.toInt(), index.toInt() + count)
      cursor += count
      return count
    }

    fun blocks(): List<Block> = SeekableXZInputStream(this, 256).use { xz ->
      if (xz.streamCount != 1 || xz.blockCount !in 2..MAX_BLOCKS) throw IOException("Ineligible XZ index")
      var next = HEADER.toLong()
      val result = List(xz.blockCount) { i ->
        val shape = Shape(xz.getBlockCompSize(i), xz.getBlockSize(i), xz.getBlockCheckType(i))
        val offset = xz.getBlockCompPos(i)
        if (offset != next || shape.compressed !in 1..(size - next)) throw IOException("Invalid XZ block extent")
        Block(offset, shape).also { next = it.end }
      }
      if (size - next !in HEADER.toLong()..tail.size.toLong()) throw IOException("Unsupported XZ trailer")
      result
    }
  }

  fun restore(cacheDir: File?, archive: File, spec: LinuxAssetIO.Spec, root: File,
              debugBuild: Boolean, http: LinuxAssetIO.RangeOpener): Boolean {
    if (cacheDir == null || spec.size <= HEADER + TAIL || !Files.isDirectory(cacheDir.toPath(), NOFOLLOW_LINKS)) return false
    val cached = File(cacheDir, LinuxRootfsArchiveCache.NAME).toPath()
    if (!Files.isRegularFile(cached, NOFOLLOW_LINKS)) return false
    val rebuild = LinuxAssetIO.Opener { url, temp, _ ->
      FileChannel.open(cached, READ, NOFOLLOW_LINKS).use { source ->
        val size = source.size()
        if (size !in (HEADER + TAIL + 1).toLong()..LinuxAssetIO.MAX_DOWNLOAD_BYTES) return@Opener -1L
        val old = Edges(size, source.bytesAt(0, HEADER), source.bytesAt(size - TAIL, TAIL)).blocks()
        fun fetch(start: Long, count: Long, out: OutputStream) {
          if (!http.fetchRange(url, spec.size, start, count, out)) throw IOException("Asset range unavailable")
        }
        fun edge(start: Long, count: Int) = ByteArrayOutputStream(count).apply {
          fetch(start, count.toLong(), this)
        }.toByteArray().also { if (it.size != count) throw EOFException() }
        val tailStart = spec.size - TAIL
        val tail = edge(tailStart, TAIL)
        val edges = Edges(spec.size, headerFromFooter(tail), tail)
        val blocks = edges.blocks()
        // Index dimensions are hints. Repeated dimensions must identify identical cached bytes.
        val byShape = reusableBlocks(source, old, blocks)
        val runs = mutableListOf<Span>()
        for (block in blocks) {
          if (byShape[block.shape] != null) continue
          val previous = runs.lastOrNull()
          if (previous?.end == block.offset) runs[runs.lastIndex] = Span(previous.start, block.end)
          else runs.add(Span(block.offset, block.end))
        }
        if (runs.size > MAX_MISSING_RANGES || runs.sumOf { it.length } > spec.size / 2) return@Opener -1L
        val network = runs.filter { it.start < tailStart }.map { Span(it.start, minOf(it.end, tailStart)) }
        val prefetched = prefetchRanges(network, ::edge)
        temp.outputStream().buffered(128 * 1024).use { output ->
          output.write(edges.head)
          val buffer = ByteBuffer.allocate(128 * 1024)
          var i = 0
          while (i < blocks.size) {
            val block = blocks[i++]
            val match = byShape[block.shape]
            if (match != null) {
              source.position(match.offset)
              var remaining = match.shape.compressed
              while (remaining > 0) {
                buffer.clear().limit(minOf(buffer.capacity().toLong(), remaining).toInt())
                val n = source.read(buffer)
                if (n <= 0) throw EOFException()
                output.write(buffer.array(), 0, n)
                remaining -= n
              }
            } else {
              var end = block.end
              while (i < blocks.size && byShape[blocks[i].shape] == null) end = blocks[i++].end
              val networkEnd = minOf(end, tailStart)
              if (block.offset < networkEnd) {
                val data = prefetched[block.offset]
                if (data != null) output.write(data) else fetch(block.offset, networkEnd - block.offset, output)
              }
              val tailFrom = maxOf(block.offset, tailStart)
              if (tailFrom < end) output.write(tail, (tailFrom - tailStart).toInt(), (end - tailFrom).toInt())
            }
          }
          val suffix = (spec.size - blocks.last().end).toInt()
          output.write(edges.tail, edges.tail.size - suffix, suffix)
        }
      }
      temp.length()
    }
    return LinuxAssetIO.download(spec, archive, root, rebuild, debugBuild) == null
  }

  private fun FileChannel.bytesAt(start: Long, count: Int): ByteArray {
    position(start)
    val data = ByteBuffer.allocate(count)
    while (data.hasRemaining()) if (read(data) <= 0) throw EOFException()
    return data.array()
  }
}
