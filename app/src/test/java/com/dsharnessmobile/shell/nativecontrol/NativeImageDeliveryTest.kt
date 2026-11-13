package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CompletableFuture

class NativeImageDeliveryTest {
  // 此层只检查封装和字节一致性；Rust 视觉测试负责实际 JPEG 编解码。
  private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0x01, 0xff.toByte(), 0xd9.toByte())

  private fun metadata() = JSONObject().put("imageId", "image-one").put("mediaType", "image/jpeg")
    .put("bytes", jpeg.size).put("sha256", MessageDigest.getInstance("SHA-256").digest(jpeg)
      .joinToString("") { "%02x".format(it) })
    .put("width", 1920).put("height", 960).put("screenId", "real")
    .put("epoch", "18446744073709551615").put("generation", "7")

  private fun status(image: NativeImageResult?, expected: JSONObject = metadata(), factsValid: Boolean = true): JSONObject {
    val response = JSONObject().put("protocolVersion", 1).put("callId", "image-1")
      .put("ok", true).put("code", "screenshot-captured").put("executed", "yes")
      .put("screenId", "real").put("phase", "settled").put("terminal", true)
      .put("receipt", JSONObject().put("data", JSONObject().put("image", expected)))
    val core = object : NativeControlDispatcher.Core {
      override fun exchange(request: JSONObject): JSONObject = when (request.getString("kind")) {
        "operationStatus" -> response
        "publishFacts" -> JSONObject().put("ok", factsValid)
        else -> throw AssertionError("读取已有图片不能重新派发: $request")
      }
      override fun readImage(callId: String): NativeImageResult? {
        assertEquals("image-1", callId)
        return image
      }
    }
    val platform = object : NativeControlDispatcher.Platform {
      override fun implements(plan: JSONObject) = false
      override fun execute(callId: String, plan: JSONObject, args: JSONObject, refreshFacts: () -> Boolean,
        authorize: () -> Boolean): CompletableFuture<JSONObject> = throw AssertionError("禁止重新截图")
    }
    return NativeControlDispatcher(core, { JSONObject() }, platform).handle(
      JSONObject("""{"protocolVersion":1,"method":"status","callId":"image-1"}"""),
      NativeControlSocketServer.Cancellation(),
    )
  }

  @Test fun oneImageUsesNativeLogicalSizeAndExactJpegBytes() {
    val result = status(NativeImageResult(metadata().toString(), jpeg))
    assertTrue(result.getBoolean("ok"))
    val image = result.getJSONObject("image")
    assertEquals(1920, image.getInt("width"))
    assertEquals(960, image.getInt("height"))
    assertArrayEquals(jpeg, Base64.getDecoder().decode(image.getString("data")))
    assertFalse(result.getJSONObject("receipt").getJSONObject("data").getJSONObject("image").has("data"))
  }

  @Test fun missingOrExpiredImageIsFailureWithoutRecaptureOrReadPath() {
    for (image in listOf(null, NativeImageResult("""{"ok":false,"code":"image-result-expired"}""", null))) {
      val result = status(image)
      assertFalse(result.getBoolean("ok"))
      assertEquals("yes", result.getString("executed"))
      assertFalse(result.has("image"))
      assertFalse(result.has("path"))
    }
  }

  @Test fun alteredBytesOrMetadataNeverBecomeASuccessfulImage() {
    val wrongBytes = jpeg.copyOf().also { it[it.lastIndex] = 0 }
    assertEquals("image-integrity-failed", status(NativeImageResult(metadata().toString(), wrongBytes)).getString("code"))
    val wrongMetadata = metadata().put("width", 8)
    assertEquals("image-integrity-failed", status(NativeImageResult(wrongMetadata.toString(), jpeg)).getString("code"))
  }

  @Test fun unavailableFactsStopDeliveryEvenWhenTheImageWasEncoded() {
    val result = status(NativeImageResult(metadata().toString(), jpeg), factsValid = false)
    assertFalse(result.getBoolean("ok"))
    assertEquals("image-facts-unavailable", result.getString("code"))
    assertFalse(result.has("image"))
  }
}
