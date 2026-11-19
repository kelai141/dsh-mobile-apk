package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.nio.file.Files
import java.util.Random
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.XZOutputStream

class LinuxRootfsBlocksTest {
  private val root = Files.createTempDirectory("linux-rootfs-blocks").toFile()
  private val cache = File(root, "cache").apply { mkdir() }
  private val url = "https://github.com/kelai141/dsh-bionilux/releases/download/test/rootfs.tar.xz"
  private val data = List(8) { i -> ByteArray(8192 + i * 613).also { Random(i.toLong()).nextBytes(it) } }
  private val target = File(root, "candidate.xz")

  @After fun clean() { SnapshotFs.deletePath(root) }

  private fun encode(blocks: List<ByteArray>): ByteArray {
    val bytes = ByteArrayOutputStream()
    XZOutputStream(bytes, LZMA2Options(0)).use { out ->
      for (block in blocks) {
        out.write(block)
        out.endBlock()
      }
    }
    return bytes.toByteArray()
  }

  private class Network(val payload: ByteArray) : LinuxAssetIO.RangeOpener {
    val ranges = mutableListOf<Long>()
    override fun fetch(url: String, dest: File, maxBytes: Long): Long = error("Unexpected full download")
    override fun fetchRange(url: String, total: Long, start: Long, bytes: Long, output: OutputStream): Boolean {
      assertEquals(payload.size.toLong(), total)
      ranges.add(bytes)
      output.write(payload, start.toInt(), bytes.toInt())
      return true
    }
  }

  private fun attempt(old: ByteArray, remote: Network, source: String = url): Boolean {
    File(cache, LinuxRootfsArchiveCache.NAME).writeBytes(old)
    val digest = SnapshotBundledAsset.digest({ remote.payload.inputStream() })
    val spec = LinuxAssetIO.Spec(source, digest.hex, digest.bytes, LinuxAssetIO.Kind.ROOTFS)
    return LinuxRootfsBlocks.restore(cache, target, spec, root, false, remote)
  }

  @Test fun reconstructsNewBlocksWithoutFetchingTheWholeAsset() {
    val remote = Network(encode(data))
    assertTrue(attempt(encode(data.filterIndexed { i, _ -> i != 3 && i != 4 }), remote))
    assertEquals(3, remote.ranges.size)
    assertTrue(remote.ranges.sum() < remote.payload.size / 2)
    assertArrayEquals(remote.payload, target.readBytes())
  }

  @Test fun sameSizeChangedContentCannotPublishAnIncorrectReconstruction() {
    val prior = encode(data)
    val changed = data.toMutableList()
    changed[3] = changed[3].clone().apply { this[34] = this[34].inc() }
    val remote = Network(encode(changed))
    assertFalse(attempt(prior, remote))
    assertFalse(target.exists())
    assertArrayEquals(prior, File(cache, LinuxRootfsArchiveCache.NAME).readBytes())
  }

  @Test fun unsupportedOldFormatAndRejectedOriginMakeNoRangeRequests() {
    val remote = Network(encode(data))
    assertFalse(attempt(encode(listOf(data.first())), remote))
    assertFalse(attempt(encode(data), remote, "https://example.invalid/rootfs.tar.xz"))
    assertTrue(remote.ranges.isEmpty())
    assertFalse(target.exists())
  }

  @Test fun rangeResponsesMustMatchTheRequestedBytesAndCompleteLength() {
    for (mode in listOf("valid", "ignored", "offset", "short", "encoded")) {
      ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
        server.soTimeout = 5000
        val served = CompletableFuture.supplyAsync {
          server.accept().use { socket ->
            socket.soTimeout = 5000
            val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
            val headers = generateSequence { reader.readLine() }.takeWhile { it.isNotEmpty() }.toList()
            val status = if (mode == "ignored") "200 OK" else "206 Partial Content"
            val extent = if (mode == "offset") "3-5/10" else "2-4/10"
            val body = if (mode == "short") byteArrayOf(2, 3) else byteArrayOf(2, 3, 4)
            val encoding = if (mode == "encoded") "Content-Encoding: gzip\r\n" else ""
            val response = "HTTP/1.1 $status\r\nContent-Range: bytes $extent\r\n" +
              "Content-Length: ${body.size}\r\n${encoding}Connection: close\r\n\r\n"
            socket.getOutputStream().use {
              it.write(response.toByteArray(Charsets.US_ASCII))
              it.write(body)
            }
            headers
          }
        }
        val out = ByteArrayOutputStream()
        val result = LinuxAssetIO.HttpOpener.fetchRange("http://127.0.0.1:${server.localPort}/asset", 10, 2, 3, out)
        assertTrue(served.get(5, TimeUnit.SECONDS).any { it.equals("Range: bytes=2-4", ignoreCase = true) })
        assertEquals(mode, mode == "valid", result)
        assertArrayEquals(if (result) byteArrayOf(2, 3, 4) else byteArrayOf(), out.toByteArray())
      }
    }
  }
}
