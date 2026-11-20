package com.dsharnessmobile.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.zip.CRC32
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.SeekableFileInputStream
import org.tukaani.xz.SeekableXZInputStream
import org.tukaani.xz.XZOutputStream

@RunWith(AndroidJUnit4::class)
class LinuxNativeXzTest {
  private val payload = ByteArray(393217) { ((it * 31) xor (it ushr 4)).toByte() }

  private fun archive(): ByteArray {
    val output = ByteArrayOutputStream()
    XZOutputStream(output, LZMA2Options(0)).use { stream ->
      stream.write(payload, 0, 150001)
      stream.endBlock()
      stream.write(payload, 150001, payload.size - 150001)
    }
    return output.toByteArray()
  }

  private fun withArchive(bytes: ByteArray, check: (File) -> Unit) {
    val directory = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    val file = File.createTempFile("linux-native-xz-", ".xz", directory)
    try {
      file.writeBytes(bytes)
      check(file)
    } finally {
      file.delete()
    }
  }

  @Test fun nativeReaderPreservesSmallReadsOffsetsAndEof() {
    withArchive(archive()) { file ->
      file.inputStream().use { raw ->
        LinuxXzInputStream.open(raw).use { stream ->
          assertTrue(stream is LinuxXzInputStream)
          val out = ByteArrayOutputStream()
          out.write(stream.read())
          val buffer = ByteArray(32781) { 42 }
          while (true) {
            val count = stream.read(buffer, 3, buffer.size - 6)
            if (count == -1) break
            out.write(buffer, 3, count)
            assertEquals(42, buffer.first().toInt())
            assertEquals(42, buffer.last().toInt())
          }
          assertArrayEquals(payload, out.toByteArray())
          assertEquals(-1, stream.read())
          assertEquals(0, stream.read(buffer, 0, 0))
        }
      }
    }
  }

  @Test fun checksumDamageAndTruncationFail() {
    val original = archive()
    val damaged = original.clone().apply { this[lastIndex - 8] = (this[lastIndex - 8].toInt() xor 1).toByte() }
    for (bytes in listOf(damaged, original.copyOf(original.size - 7))) {
      withArchive(bytes) { file ->
        assertThrows(IOException::class.java) {
          file.inputStream().use { raw -> LinuxXzInputStream.open(raw).use { it.readBytes() } }
        }
      }
    }
  }

  @Test fun sizedBlocksDecodeAndRejectCorruptPayloads() {
    val expected = "DSH Android block decoder test\n".repeat(2400).toByteArray()
    // Three independently compressed XZ blocks with lengths in their headers.
    val encoded = android.util.Base64.decode(
      "/Td6WFoAAATm1rRGA8BrgIACIQESAAAA4zOULeB//wBjXQAiFMUQGBWnam8PCYJZ+NAcOcJNPw8BcIFYUPqvanv1" +
      "8JitZlhSND7qeTl0t0GQef0QGzMNfQfrBhxcIqRajxSCr+OYplbYvaKUww14tM7zUDsqXU1238WvWUvfmXV1s+5P" +
      "AAAAAIxf3wV0p82aA8BrgIACIQESAAAA4zOULeB//wBjXQApkgADEsUnnjvIOQKPMu3Sw4Zl6o91BcmDIg8gEBqu" +
      "6vDRwZGaUGbVlHmDtXxNGahfAO9bbx5HL10CtphNlwNlFZBIt4LTDSkVzhYR3UZifhwasElyw+egPEnIidGR7iHe" +
      "AAAAAPH8QxcyKhj/A8BSoEUhARIAAAAAkAVsLeAinwBKXQAkCAQnI4Ii0b2LiA3YUgHUas1IHn4CAsfw/VsRSSVC" +
      "rWI9t0fAQf6HO/3J5v2g0dHuebAsrruTHPu9yC+4e0oQaXRCqrQ55jOXAAAAAHLAoOoRpXMeAAODAYCAAoMBgIAC" +
      "aqBFAMvYaLOsJz4tBAAAAAAEWVo=", android.util.Base64.DEFAULT,
    )
    withArchive(encoded) { file ->
      val last = SeekableXZInputStream(SeekableFileInputStream(file)).use { index ->
        assertEquals(3, index.blockCount)
        index.getBlockCompPos(2).toInt()
      }
      file.inputStream().use { raw ->
        LinuxXzInputStream.open(raw).use { stream ->
          assertTrue(stream is LinuxXzInputStream)
          assertArrayEquals(expected, stream.readBytes())
        }
      }
      val headerBytes = ((encoded[last].toInt() and 255) + 1) * 4
      encoded[last + headerBytes] = 0
      file.writeBytes(encoded)
      assertThrows(IOException::class.java) {
        file.inputStream().use { raw -> LinuxXzInputStream.open(raw).use { it.readBytes() } }
      }
    }
  }

  @Test fun secondBlockCanResumeInJavaAfterNativeMemoryLimit() {
    val encoded = archive()
    withArchive(encoded) { file ->
      val second = SeekableXZInputStream(SeekableFileInputStream(file)).use { stream ->
        assertEquals(2, stream.blockCount)
        stream.getBlockCompPos(1).toInt()
      }
      val headerSize = ((encoded[second].toInt() and 0xff) + 1) * 4
      assertEquals(0, encoded[second + 1].toInt())
      assertEquals(0x21, encoded[second + 2].toInt())
      assertEquals(1, encoded[second + 3].toInt())
      // The unchanged block payload is valid with a larger dictionary. The header CRC covers its properties.
      encoded[second + 4] = 28
      val crc = CRC32().apply { update(encoded, second, headerSize - 4) }.value
      for (i in 0..3) encoded[second + headerSize - 4 + i] = (crc ushr (i * 8)).toByte()
      file.writeBytes(encoded)
      file.inputStream().use { raw ->
        LinuxXzInputStream.open(raw).use { stream ->
          assertTrue(stream is LinuxXzInputStream)
          assertArrayEquals(payload, stream.readBytes())
        }
      }
    }
  }

  @Test fun earlyCloseIsIdempotentAndReleasesDescriptors() {
    withArchive(archive()) { file ->
      val descriptors = File("/proc/self/fd")
      val before = descriptors.list()!!.size
      repeat(40) {
        file.inputStream().use { raw ->
          val stream = LinuxXzInputStream.open(raw)
          assertEquals(payload.first().toInt() and 0xff, stream.read())
          stream.close()
          stream.close()
          assertThrows(IOException::class.java) { stream.read() }
        }
      }
      assertTrue(descriptors.list()!!.size <= before + 3)
    }
  }
}
