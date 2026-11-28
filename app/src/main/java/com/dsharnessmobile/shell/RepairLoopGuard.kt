package com.dsharnessmobile.shell

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Task-local decisions and byte accounting. Callers append only newly prepared results. */
internal object RepairLoopGuard {
  const val MAX_STEPS = 24
  const val MAX_TOOL_CALLS = 60
  const val MAX_TOTAL_OUTPUT_BYTES = 128 * 1024
  private const val RESULT_BYTES = 8192
  private const val BUDGET_MARKER = """{"budgetTruncated":true}"""
  private const val MAX_JSON_DEPTH = 64
  private val priorityFields = listOf("ok", "error", "code", "reason", "path", "exitCode", "offset",
    "nextOffset", "omittedBeforeBytes", "size", "readBytes", "truncated", "timedOut", "cancelled")
  private val writeTools = setOf("write", "edit", "restart_engine", "refresh_runtime")
  private val stableErrors = setOf(
    "unknown-tool", "bad-arguments", "invalid-arguments", "missing-argument", "bad-offset",
    "permission-denied", "permission-refused", "access-denied", "outside-scope", "protected-file",
    "read-only-scope", "backup-reserved", "apk-protected", "symlink-target", "command-refused",
    "invalid-path", "not-found", "is-directory", "not-regular", "invalid-utf8",
    "edit-not-found", "edit-ambiguous", "duplicate-tool-call",
  )

  fun callSignature(name: String, argsJson: String): String {
    val canonical = runCatching {
      canonicalJson(parse(argsJson) as JSONObject, 0)
    }.getOrNull()
    return JSONObject.quote(name) + if (canonical == null) "!invalid:" + digest(argsJson) else ":" + digest(canonical)
  }

  private fun digest(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun parse(text: String): Any {
    val tokener = JSONTokener(text)
    val value = tokener.nextValue()
    require(tokener.nextClean() == '\u0000')
    return value
  }

  private fun canonicalJson(value: Any, depth: Int): String {
    require(depth <= MAX_JSON_DEPTH)
    return when (value) {
      is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { key ->
        JSONObject.quote(key) + ":" + canonicalJson(value.get(key), depth + 1)
      }
      is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { index ->
        canonicalJson(value.opt(index) ?: JSONObject.NULL, depth + 1)
      }
      else -> jsonValue(value)
    }
  }

  private fun jsonValue(value: Any): String = when (value) {
    is String -> JSONObject.quote(value)
    is Number -> JSONObject.numberToString(value)
    else -> value.toString()
  }

  /**
   * Clipping requires enough room for the marker. Long strings are shortened in
   * their value position, and objects and arrays retain complete entries.
   */
  fun truncateToolResult(rawJson: String, maxBytes: Int = RESULT_BYTES): String {
    val parsed = runCatching { parse(rawJson) }.getOrElse {
      JSONObject().put("ok", false).put("error", "invalid-tool-result")
    }
    val serialized = runCatching { jsonValue(parsed) }.getOrNull()
    if (serialized != null && utf8Size(rawJson) <= maxBytes && utf8Size(serialized) <= maxBytes) {
      return serialized
    }
    require(maxBytes >= BUDGET_MARKER.length) { "maxBytes cannot hold the JSON truncation marker" }
    val wrapper = if (parsed is JSONObject) parsed else JSONObject().put("result", parsed)
    return clippedObject(wrapper, maxBytes, 0, markBudget = true)
  }

  private fun utf8Size(text: String): Int = text.toByteArray(Charsets.UTF_8).size

  private fun clippedObject(value: JSONObject, budget: Int, depth: Int, markBudget: Boolean = false): String {
    val result = StringBuilder("{")
    if (markBudget) result.append(BUDGET_MARKER, 1, BUDGET_MARKER.lastIndex)
    var used = result.length + 1
    val keys = priorityFields.filter(value::has).asSequence() +
      value.keys().asSequence().filter { it !in priorityFields }
    for (key in keys) {
      if (markBudget && key == "budgetTruncated") continue
      val prefix = (if (result.length > 1) "," else "") + JSONObject.quote(key) + ":"
      val prefixBytes = utf8Size(prefix)
      val clipped = clippedValue(value.get(key), budget - used - prefixBytes, depth + 1) ?: continue
      result.append(prefix).append(clipped)
      used += prefixBytes + utf8Size(clipped)
      if (used == budget) break
    }
    return result.append('}').toString()
  }

  private fun clippedValue(value: Any, budget: Int, depth: Int): String? {
    if (budget < 1 || depth > MAX_JSON_DEPTH) return null
    if (budget == 1 && (value is JSONObject || value is JSONArray || value is String)) return null
    return when (value) {
      is JSONObject -> clippedObject(value, budget, depth)
      is JSONArray -> {
        val result = StringBuilder("[")
        var used = 2
        for (index in 0 until value.length()) {
          val separator = if (index == 0) 0 else 1
          val clipped = clippedValue(value.opt(index) ?: JSONObject.NULL, budget - used - separator, depth + 1) ?: break
          if (separator != 0) result.append(',')
          result.append(clipped)
          used += separator + utf8Size(clipped)
        }
        result.append(']').toString()
      }
      is String -> clippedString(value, budget)
      else -> jsonValue(value).takeIf { utf8Size(it) <= budget }
    }
  }

  private fun clippedString(value: String, budget: Int): String {
    val encoded = JSONObject.quote(value)
    if (utf8Size(encoded) <= budget) return encoded
    val suffix = if (budget >= 5) "…" else ""
    var low = 0
    var high = minOf(value.length, budget - 2)
    while (low < high) {
      val middle = low + (high - low + 1) / 2
      val prefix = value.take(middle).dropLastWhile { it.isHighSurrogate() }
      if (utf8Size(JSONObject.quote(prefix + suffix)) <= budget) low = middle else high = middle - 1
    }
    return JSONObject.quote(value.take(low).dropLastWhile { it.isHighSurrogate() } + suffix)
  }

  data class Decision(val shouldStop: Boolean = false, val reason: String? = null) {
    val allowCall: Boolean get() = !shouldStop && reason == null
  }

  data class PreparedResult(val content: String?, val decision: Decision)

  class LoopTracker(
    private val maxSteps: Int = MAX_STEPS,
    private val maxToolCalls: Int = MAX_TOOL_CALLS,
    private val maxTotalOutputBytes: Int = MAX_TOTAL_OUTPUT_BYTES,
  ) {
    init {
      require(maxSteps > 0 && maxToolCalls > 0 && maxTotalOutputBytes > 0)
    }

    var steps: Int = 0
      private set
    var toolCalls: Int = 0
      private set
    var outputBytes: Int = 0
      private set
    private var state: String? = null
    private val signatures = mutableMapOf<String, Int>()
    private var stalledBatches = 0
    private var invalidBatches = 0
    private var stopped: Decision? = null
    private val remainingBytes: Int get() = maxTotalOutputBytes - outputBytes

    /** Call before a model step. The last allowed step can still execute its batch. */
    fun beginBatch(): Decision {
      stopped?.let { return it }
      if (steps >= maxSteps) return stop("max-steps")
      if (toolCalls >= maxToolCalls) return stop("max-tool-calls")
      if (remainingBytes < BUDGET_MARKER.length) return stop("max-total-output-bytes")
      steps++
      return Decision()
    }

    /** Every attempted call counts, even when a stable refusal is returned instead of executing it. */
    fun beforeCall(name: String, argsJson: String, stateKey: String): Decision {
      stopped?.let { return it }
      if (toolCalls >= maxToolCalls) return stop("max-tool-calls")
      if (remainingBytes < BUDGET_MARKER.length) return stop("max-total-output-bytes")
      toolCalls++
      if (state != stateKey) {
        state = stateKey
        signatures.clear()
      }
      val signature = callSignature(name, argsJson)
      val seen = signatures[signature] ?: 0
      if (seen >= (if (name in writeTools) 1 else 2)) return Decision(reason = "duplicate-tool-call")
      signatures[signature] = seen + 1
      return Decision()
    }

    /** Reserve exactly the UTF-8 bytes that will be appended, including refusal results. */
    fun prepareResult(rawJson: String): PreparedResult {
      stopped?.let { return PreparedResult(null, it) }
      if (remainingBytes < BUDGET_MARKER.length) return PreparedResult(null, stop("max-total-output-bytes"))
      val content = truncateToolResult(rawJson, minOf(RESULT_BYTES, remainingBytes))
      outputBytes += utf8Size(content)
      return PreparedResult(content, Decision())
    }

    /** Null error codes represent successful results. The caller supplies observed progress. */
    fun finishBatch(madeProgress: Boolean, errorCodes: List<String?>): Decision {
      stopped?.let { return it }
      val allInvalid = errorCodes.isNotEmpty() && errorCodes.all { it in stableErrors }
      invalidBatches = if (allInvalid) invalidBatches + 1 else 0
      stalledBatches = if (madeProgress) 0 else stalledBatches + 1
      return when {
        invalidBatches >= 3 -> stop("consecutive-invalid-tool-batches")
        stalledBatches >= 3 -> stop("consecutive-no-progress-batches")
        steps >= maxSteps -> stop("max-steps")
        toolCalls >= maxToolCalls -> stop("max-tool-calls")
        remainingBytes < BUDGET_MARKER.length -> stop("max-total-output-bytes")
        else -> Decision()
      }
    }

    private fun stop(reason: String): Decision = Decision(shouldStop = true, reason = reason).also { stopped = it }
  }
}
