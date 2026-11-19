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
import org.tukaani.xz.SeekableInputStream
import org.tukaani.xz.SeekableXZInputStream

/** Rebuild a multi-block XZ asset in a private temporary file before its normal digest check. */
internal object LinuxRootfsBlocks {
  private const val HEADER = 12
  private const val TAIL = 4096
  private const val MAX_BLOCKS = 512
  private const val MAX_MISSING_RANGES = 10

  private data class Shape(val compressed: Long, val plain: Long, val check: Int)
  private data class Block(val offset: Long, val shape: Shape) {
    val end get() = offset + shape.compressed
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
        // The index is a lookup hint. Ambiguous matches stay on the network.
        val byShape = old.groupBy { it.shape }.mapValues { it.value.singleOrNull() }
        fun fetch(start: Long, count: Long, out: OutputStream) {
          if (!http.fetchRange(url, spec.size, start, count, out)) throw IOException("Asset range unavailable")
        }
        fun edge(start: Long, count: Int) = ByteArrayOutputStream(count).apply {
          fetch(start, count.toLong(), this)
        }.toByteArray().also { if (it.size != count) throw EOFException() }
        val edges = Edges(spec.size, edge(0, HEADER), edge(spec.size - TAIL, TAIL))
        val blocks = edges.blocks()
        val missing = blocks.filter { byShape[it.shape] == null }
        val runs = missing.filterIndexed { i, b -> i == 0 || missing[i - 1].end != b.offset }
        if (runs.size > MAX_MISSING_RANGES || missing.sumOf { it.shape.compressed } > spec.size / 2) return@Opener -1L
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
              fetch(block.offset, end - block.offset, output)
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
