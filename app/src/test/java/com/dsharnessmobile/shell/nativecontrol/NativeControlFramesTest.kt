package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.EOFException

class NativeControlFramesTest {
  private fun frame(bytes: ByteArray) = ByteArrayOutputStream().also {
    DataOutputStream(it).apply { writeInt(bytes.size); write(bytes) }
  }.toByteArray()

  private fun request(extra: String = "") =
    """{"protocolVersion":1,"method":"execute","callId":"turn-1","epoch":"18446744073709551615","operation":"setText","args":{"text":"中文及𠮷"}$extra}"""

  @Test fun ordinaryUtf8PreservesSupplementaryCharactersAndOpaqueEpoch() {
    val value = NativeControlFrames.readRequest(ByteArrayInputStream(frame(request(",\"generation\":\"18446744073709551615\"").toByteArray())))
    assertEquals("中文及𠮷", value.getJSONObject("args").getString("text"))
    assertEquals("18446744073709551615", value.getString("epoch"))
    assertEquals("18446744073709551615", value.getString("generation"))
  }

  @Test fun internalStateAndChannelFieldsCannotEnterPublicProtocol() {
    for (extra in listOf(",\"kind\":\"publishFacts\"", ",\"backend\":\"root\"", ",\"facts\":{}", ",\"appUid\":0")) {
      assertEquals("unknown-request-field", assertThrows(NativeControlFrames.WireException::class.java) {
        NativeControlFrames.readRequest(ByteArrayInputStream(frame(request(extra).toByteArray())))
      }.code)
    }
  }

  @Test fun oversizedFramesRejectBeforeReadingOrAllocatingPayload() {
    val stream = ByteArrayOutputStream().also { DataOutputStream(it).writeInt(Int.MAX_VALUE) }
    assertEquals("invalid-frame-size", assertThrows(NativeControlFrames.WireException::class.java) {
      NativeControlFrames.readRequest(ByteArrayInputStream(stream.toByteArray()))
    }.code)
  }

  @Test fun truncatedFramesNeverBecomeRequests() {
    val bytes = frame(request().toByteArray()).dropLast(1).toByteArray()
    assertThrows(EOFException::class.java) { NativeControlFrames.readRequest(ByteArrayInputStream(bytes)) }
  }

  @Test fun invalidUtf8TrailingDocumentsAndFractionalGenerationsReject() {
    assertEquals("invalid-utf8", assertThrows(NativeControlFrames.WireException::class.java) {
      NativeControlFrames.readRequest(ByteArrayInputStream(frame(byteArrayOf(0xc3.toByte(), 0x28))))
    }.code)
    assertThrows(NativeControlFrames.WireException::class.java) {
      NativeControlFrames.readRequest(ByteArrayInputStream(frame((request() + "{}").toByteArray())))
    }
    assertThrows(NativeControlFrames.WireException::class.java) {
      NativeControlFrames.readRequest(ByteArrayInputStream(frame(request(",\"generation\":1.5").toByteArray())))
    }
  }

  @Test fun responseUsesSameLengthAndStandardUtf8() {
    val response = JSONObject().put("protocolVersion", 1).put("method", "capabilities")
    val buffer = ByteArrayOutputStream()
    NativeControlFrames.writeResponse(buffer, response)
    val parsed = NativeControlFrames.readRequest(ByteArrayInputStream(buffer.toByteArray()))
    assertEquals("capabilities", parsed.getString("method"))
  }

  @Test fun nestingLimitRejectsBeforeRecursiveJsonParsing() {
    val text = "{\"x\":".repeat(1000) + "0" + "}".repeat(1000)
    assertEquals("json-too-deep", assertThrows(NativeControlFrames.WireException::class.java) {
      NativeControlFrames.readRequest(ByteArrayInputStream(frame(text.toByteArray())))
    }.code)
  }

  @Test fun lenientJsonExtensionsAndSignedHexTokensAreRejected() {
    for (text in listOf(
      "{'protocolVersion':1,'method':'capabilities'}",
      "{protocolVersion:1,method:\"capabilities\"}",
      "{\"protocolVersion\":1,\"method\":\"capabilities\",}",
      "/* comment */{\"protocolVersion\":1,\"method\":\"capabilities\"}",
      request(",\"generation\":\"0x+1\""),
    )) {
      assertThrows(NativeControlFrames.WireException::class.java) {
        NativeControlFrames.readRequest(ByteArrayInputStream(frame(text.toByteArray())))
      }
    }
  }

  @Test fun jsonBracketsAndEscapesInsideStringsDoNotConsumeDepth() {
    val text = request().replace("中文及𠮷", "[{}]\\\"\\\\中文\\u4e2d")
    val value = NativeControlFrames.readRequest(ByteArrayInputStream(frame(text.toByteArray())))
    assertEquals("[{}]\"\\中文中", value.getJSONObject("args").getString("text"))
  }
}
