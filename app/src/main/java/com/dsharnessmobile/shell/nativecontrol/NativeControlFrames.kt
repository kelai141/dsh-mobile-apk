package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONObject
import org.json.JSONTokener
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** 私有 IPC 的有界 UTF-8 JSON 帧。前缀是 4 字节大端长度，不使用 modified UTF-8。 */
internal object NativeControlFrames {
  const val PROTOCOL_VERSION = 1
  const val MAX_REQUEST_BYTES = 64 * 1024
  const val MAX_RESPONSE_BYTES = 1024 * 1024

  private val fields = mapOf(
    "capabilities" to setOf("protocolVersion", "method"),
    "execute" to setOf("protocolVersion", "method", "callId", "epoch", "operation", "screenId", "generation", "timeoutMs", "args"),
    "cancel" to setOf("protocolVersion", "method", "callId"),
    "status" to setOf("protocolVersion", "method", "callId"),
  )

  fun readRequest(input: InputStream): JSONObject {
    val source = DataInputStream(input)
    val length = source.readInt()
    if (length !in 1..MAX_REQUEST_BYTES) throw WireException("invalid-frame-size")
    val bytes = ByteArray(length)
    source.readFully(bytes)
    val text = try {
      Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: java.nio.charset.CharacterCodingException) {
      throw WireException("invalid-utf8")
    }
    NativeJsonSyntax.validate(text)
    val request = try {
      val token = JSONTokener(text)
      val value = token.nextValue()
      if (value !is JSONObject || token.nextClean() != 0.toChar()) throw WireException("invalid-json-object")
      value
    } catch (failure: WireException) {
      throw failure
    } catch (_: org.json.JSONException) {
      throw WireException("invalid-json-object")
    }
    validate(request)
    return request
  }

  fun validate(request: JSONObject) {
    if (request.opt("protocolVersion") != PROTOCOL_VERSION) throw WireException("protocol-version-mismatch")
    val method = request.opt("method") as? String ?: throw WireException("invalid-method")
    val allowed = fields[method] ?: throw WireException("unsupported-method")
    val keys = request.keys()
    while (keys.hasNext()) if (keys.next() !in allowed) throw WireException("unknown-request-field")
    if (method != "capabilities") {
      val id = request.opt("callId") as? String ?: throw WireException("invalid-call-id")
      if (!id.matches(Regex("[A-Za-z0-9._:-]{1,64}"))) throw WireException("invalid-call-id")
    }
    if (method == "execute") {
      val epoch = request.opt("epoch") as? String ?: throw WireException("invalid-epoch")
      unsignedToken(epoch, "epoch")
      val operation = request.opt("operation") as? String ?: throw WireException("invalid-operation")
      if (!operation.matches(Regex("[A-Za-z][A-Za-z0-9]{0,63}"))) throw WireException("invalid-operation")
      if (request.has("args") && request.opt("args") !is JSONObject) throw WireException("invalid-args")
      if (request.has("screenId") && request.opt("screenId") !is String) throw WireException("invalid-screen-id")
      if (request.has("generation")) {
        val generation = request.opt("generation") as? String ?: throw WireException("invalid-generation")
        unsignedToken(generation, "generation")
      }
      if (request.has("timeoutMs")) exactInteger(request, "timeoutMs", 1L..30_000L)
    }
  }

  private fun unsignedToken(value: String, field: String) {
    val valid = if (value.startsWith("0x")) {
      value.length in 3..18 && value.substring(2).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' } &&
        value.substring(2).toULongOrNull(16) != null
    } else {
      value.length in 1..20 && value.all { it in '0'..'9' } && value.toULongOrNull() != null
    }
    if (!valid) throw WireException("invalid-$field")
  }

  private fun exactInteger(request: JSONObject, field: String, range: LongRange) {
    val raw = request.opt(field)
    val number = when (raw) {
      is Int -> raw.toLong()
      is Long -> raw
      else -> throw WireException("invalid-$field")
    }
    if (number !in range) throw WireException("invalid-$field")
  }

  fun writeResponse(output: OutputStream, response: JSONObject) {
    val bytes = response.toString().toByteArray(Charsets.UTF_8)
    if (bytes.size !in 1..MAX_RESPONSE_BYTES) throw WireException("response-too-large")
    val target = DataOutputStream(output)
    target.writeInt(bytes.size)
    target.write(bytes)
    target.flush()
  }

  class WireException(val code: String) : Exception(code)
}
