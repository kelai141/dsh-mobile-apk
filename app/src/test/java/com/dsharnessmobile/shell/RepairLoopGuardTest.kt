package com.dsharnessmobile.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RepairLoopGuardTest {
  @Test
  fun signatureSortsEveryObjectKeepsArrayOrderAndDoesNotExposeArguments() {
    val original = """{"path":"private","options":{"z":[{"b":2,"a":1},true],"a":null}}"""
    val reordered = """{"options":{"a":null,"z":[{"a":1,"b":2},true]},"path":"private"}"""
    val arrayReordered = """{"options":{"a":null,"z":[true,{"a":1,"b":2}]},"path":"private"}"""
    val signature = RepairLoopGuard.callSignature("read", original)
    assertEquals(signature, RepairLoopGuard.callSignature("read", reordered))
    assertNotEquals(signature, RepairLoopGuard.callSignature("read", arrayReordered))
    assertNotEquals(signature, RepairLoopGuard.callSignature("edit", reordered))
    assertFalse(signature.contains("private"))
    assertNotEquals(RepairLoopGuard.callSignature("read", "{broken"), RepairLoopGuard.callSignature("read", "{}"))
  }

  @Test
  fun structuredClippingAccountsForUtf8EscapesAndPreservesMetadata() {
    val raw = JSONObject().put("ok", false).put("error", "bad-offset").put("nextOffset", 421)
      .put("content", "\"\n🙂界".repeat(5000)).toString()
    val clipped = RepairLoopGuard.truncateToolResult(raw, 190)
    val result = JSONObject(clipped)
    assertTrue(clipped.toByteArray().size <= 190)
    assertTrue(result.getBoolean("budgetTruncated"))
    assertEquals("bad-offset", result.getString("error"))
    assertEquals(421, result.getInt("nextOffset"))
    assertTrue(result.getString("content").endsWith("…"))
    assertFalse(result.getString("content").contains('\uFFFD'))
    val small = """{"success":"完整"}"""
    assertEquals(small, RepairLoopGuard.truncateToolResult(small))
  }

  @Test
  fun markerOnlyArrayMalformedAndNestedResultsStayLegal() {
    val marker = """{"budgetTruncated":true}"""
    val minimum = marker.toByteArray().size
    assertEquals(marker, RepairLoopGuard.truncateToolResult("""{"veryLongUnfitKey":true}""".repeat(20), minimum))
    assertEquals("{}", RepairLoopGuard.truncateToolResult("{}", 2))
    assertThrows(IllegalArgumentException::class.java) {
      RepairLoopGuard.truncateToolResult("""{"content":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}""", minimum - 1)
    }
    val nested = """{"payload":{"items":[1,2,3,"界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界界",5]}}"""
    val clipped = JSONObject(RepairLoopGuard.truncateToolResult(nested, 100))
    assertEquals(1, clipped.getJSONObject("payload").getJSONArray("items").getInt(0))
    val array = JSONObject(RepairLoopGuard.truncateToolResult("[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2]", 64))
    assertTrue(array.getBoolean("budgetTruncated"))
    assertEquals(1, array.getJSONArray("result").getInt(0))
    assertEquals("invalid-tool-result",
      JSONObject(RepairLoopGuard.truncateToolResult("{\"x\":1} trailing")).getString("error"))
  }

  @Test
  fun writesStopAtSecondReadStopsAtThirdAndStateChangeResetsDuplicates() {
    for (name in listOf("write", "edit", "restart_engine", "refresh_runtime")) {
      val loop = RepairLoopGuard.LoopTracker()
      assertTrue(loop.beginBatch().allowCall)
      assertTrue(loop.beforeCall(name, """{"b":2,"a":1}""", "v1").allowCall)
      val denied = loop.beforeCall(name, """{"a":1,"b":2}""", "v1")
      assertEquals("duplicate-tool-call", denied.reason)
      assertFalse(denied.shouldStop)
      assertFalse(denied.allowCall)
      assertTrue(loop.beforeCall(name, """{"a":1,"b":2}""", "v2").allowCall)
      assertEquals(3, loop.toolCalls)
    }
    val loop = RepairLoopGuard.LoopTracker()
    assertTrue(loop.beginBatch().allowCall)
    repeat(2) { assertTrue(loop.beforeCall("preflight", "{}", "v1").allowCall) }
    assertEquals("duplicate-tool-call", loop.beforeCall("preflight", "{}", "v1").reason)
    assertTrue(loop.beforeCall("preflight", "{}", "v2").allowCall)
  }

  @Test
  fun stopsAfterThreeConsecutiveNoProgressOrThreeEntirelyInvalidBatches() {
    val idle = RepairLoopGuard.LoopTracker()
    repeat(2) {
      assertTrue(idle.beginBatch().allowCall)
      assertFalse(idle.finishBatch(false, emptyList()).shouldStop)
    }
    assertTrue(idle.beginBatch().allowCall)
    assertEquals("consecutive-no-progress-batches", idle.finishBatch(false, listOf("busy")).reason)
    assertTrue(idle.beforeCall("read", "{}", "new").shouldStop)

    val invalid = RepairLoopGuard.LoopTracker()
    val batches = listOf(listOf("bad-offset", "unknown-tool"), listOf("missing-argument"),
      listOf("permission-denied", "duplicate-tool-call"))
    for ((index, errors) in batches.withIndex()) {
      assertTrue(invalid.beginBatch().allowCall)
      val result = invalid.finishBatch(madeProgress = true, errorCodes = errors)
      assertEquals(index == 2, result.shouldStop)
      if (result.shouldStop) assertEquals("consecutive-invalid-tool-batches", result.reason)
    }
  }

  @Test
  fun progressAndMixedOrEmptyBatchesResetTheirRespectiveStreaks() {
    val loop = RepairLoopGuard.LoopTracker()
    repeat(2) {
      loop.beginBatch()
      assertFalse(loop.finishBatch(false, listOf("unknown-tool")).shouldStop)
    }
    loop.beginBatch()
    assertFalse(loop.finishBatch(true, listOf("bad-arguments", null)).shouldStop)
    repeat(2) {
      loop.beginBatch()
      assertFalse(loop.finishBatch(false, listOf("protected-file")).shouldStop)
    }
    loop.beginBatch()
    val result = loop.finishBatch(true, emptyList())
    assertFalse(result.shouldStop)
    assertNull(result.reason)
  }

  @Test
  fun hardCapsAllowTheLastStepAndCallAndBudgetOnlyNewSerializedResults() {
    val steps = RepairLoopGuard.LoopTracker(maxSteps = 1)
    assertTrue(steps.beginBatch().allowCall)
    assertTrue(steps.beforeCall("read", "{}", "v1").allowCall)
    assertEquals("max-steps", steps.finishBatch(true, listOf(null)).reason)
    assertFalse(steps.beginBatch().allowCall)
    assertEquals(1, steps.steps)

    val calls = RepairLoopGuard.LoopTracker(maxToolCalls = 2)
    calls.beginBatch()
    assertTrue(calls.beforeCall("write", "{}", "v1").allowCall)
    assertEquals("duplicate-tool-call", calls.beforeCall("write", "{}", "v1").reason)
    assertEquals("max-tool-calls", calls.finishBatch(false, listOf(null, "duplicate-tool-call")).reason)
    assertEquals(2, calls.toolCalls)

    val output = RepairLoopGuard.LoopTracker(maxTotalOutputBytes = 87)
    output.beginBatch()
    val first = requireNotNull(output.prepareResult("""{"content":"中"}""").content)
    val second = requireNotNull(output.prepareResult("""{"content":"文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文"}""").content)
    assertEquals(first.toByteArray().size + second.toByteArray().size, output.outputBytes)
    assertTrue(output.outputBytes <= 87)
    assertTrue(JSONObject(second).getBoolean("budgetTruncated"))
    assertEquals("max-total-output-bytes", output.finishBatch(true, listOf(null, null)).reason)
    assertNull(output.prepareResult("{}").content)
    assertEquals("""{"content":"中"}""", first)
  }
}
