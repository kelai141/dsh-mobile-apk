package com.dsharnessmobile.shell

import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RepairPreflightTest {
  @Test
  fun activeSnapshotRuntimeEngineAndModelProblemsAreStructured() {
    val observed = RepairPreflight.Observations(
      transactionPhase = "swapping", stagePresent = true, previousPresent = true, recoveryBlocked = true,
      refreshFailure = "snapshot-stage-incomplete",
      missing = listOf("bin/node", "lib/libz.so.1", "bin/node"), confirmed = listOf("bin/node"),
      damageMarker = true, refusalCode = "live-runtime-incomplete", refusal = "could not start",
      exitInfo = "exit=137", repairRequired = true, retries = 2,
      modelRootMissing = true, invalidModelSources = listOf(".dsh/settings.yaml"), missingCredentials = 2,
    )
    val findings = RepairPreflight.select(observed)
    assertEquals(
      listOf("transaction-pending", "recovery-blocked", "stage-present", "previous-present", "refresh-failed",
        "damage-marker", "confirmed-missing", "missing", "start-refusal-code", "start-refused", "abnormal-exit",
        "root-missing", "invalid"),
      findings.map { it.code },
    )
    assertEquals("lib/libz.so.1", findings.single { it.code == "missing" }.detail)
    val result = RepairPreflight.format(observed)
    assertEquals(1, result.getInt("schema"))
    assertEquals(2, result.getInt("missingCredentialCount"))
    assertEquals(2, result.getInt("retries"))
    assertTrue(result.getBoolean("repairRequired"))
    assertFalse(result.getBoolean("trackedChildAlive"))
  }

  @Test
  fun oldAndNormalObservationsDoNotAppearAsFailures() {
    val observed = RepairPreflight.Observations(
      refreshFailure = "snapshot-transaction-in-flight", refreshDeferred = true,
      childAlive = true, refusalCode = "old-refusal", exitInfo = "exit=42", generationStart = 200,
      logs = mapOf(
        "boot-fail.log" to listOf(
          "dsh-boot-fail stage=extract-failed at=150 recovery=rollback_failed",
          "dsh-boot-fail stage=ok at=250",
        ),
        "boot-diag.log" to listOf(
          "source=render-gone t_boot_start=150 didCrash=true",
          "source=render-gone t_boot_start=200 didCrash=false",
          "source=page-stall t_boot_start=200 pageReady=false",
          "source=page-console t_boot_start=200 phase=page-ready",
        ),
        "boot-segments.log" to listOf("dsh-boot-segments t_boot_start=200 t_listen=210 note=first-http"),
        "undo-gate.log" to listOf("dsh-undo-gate at=215 executed failed", "dsh-undo-gate at=220 executed ok snapshot=6"),
        "engine.log" to listOf("HTTP 401", "[perf A5] phase=compose-complete", "phase=plugins-loaded failed=0",
          "linker64 exec: Permission denied"),
        "engine.log.1" to listOf("FATAL ERROR: Reached heap limit"),
      ),
    )
    assertTrue(RepairPreflight.select(observed).isEmpty())
    assertEquals(0, RepairPreflight.format(observed).getJSONArray("findings").length())
    assertTrue(RepairPreflight.select(RepairPreflight.Observations(exitInfo = "exit=0")).isEmpty())
  }

  @Test
  fun newestDiagnosticSignalsPreserveLinkerPluginHeapRendererAndStallEvidence() {
    val observed = RepairPreflight.Observations(
      recoveryBlocked = true, generationStart = 200,
      logs = mapOf(
        "engine.log" to listOf(
          "CANNOT LINK EXECUTABLE: missing binary",
          "CANNOT LINK EXECUTABLE: missing binary",
          "library libicu.so not found",
          "Error: dsh: plugin tree failed to load",
          "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        ),
        "boot-fail.log" to listOf("dsh-boot-fail stage=snapshot-recovery at=215 recovery=rollback_failed"),
        "boot-diag.log" to listOf(
          "source=render-gone t_boot_start=200 didCrash=true",
          "source=shell-stall t_boot_start=200 stalledMs=43300 pageReady=false",
        ),
        "undo-gate.log" to listOf("dsh-undo-gate at=250 aborted ownership-unverified"),
      ),
    )
    val codes = RepairPreflight.select(observed).map { it.code }
    assertEquals(2, codes.count { it == "linker-failure" })
    assertTrue(codes.containsAll(listOf("plugin-load-failed", "v8-oom", "renderer-crash", "page-stall",
      "recovery-failed", "undo-failed")))
    assertTrue(RepairPreflight.select(RepairPreflight.Observations(logs = mapOf(
      "boot-fail.log" to listOf("stage=refresh-failed recovery=rollback_failed"),
    ))).isEmpty())
    assertTrue(RepairPreflight.select(RepairPreflight.Observations(logs = mapOf(
      "boot-fail.log" to listOf("stage=auth-retry detail=HTTP 401"),
    ))).isEmpty())
  }

  @Test
  fun formattedReportRedactsDetailsAndKeepsJsonWithinFourKiB() {
    val observed = RepairPreflight.Observations(
      refusal = "Authorization: Bearer test-credential",
      missing = (1..25).map { "$it-" + "长".repeat(550) },
      refreshFailure = "snapshot-failed Cookie: sid=test-cookie",
      logs = mapOf("engine.log" to listOf("plugin load failed: sk-keyRedacted123")),
    )
    val formatted = RepairPreflight.format(observed).toString()
    val result = JSONObject(formatted)
    assertTrue(formatted.toByteArray().size <= 4096)
    assertTrue(result.getBoolean("budgetTruncated"))
    assertTrue(result.getInt("findingCount") > result.getJSONArray("findings").length())
    assertFalse(formatted.contains("test-cookie"))
    assertTrue(formatted.contains("***"))
    val small = RepairPreflight.format(observed.copy(missing = emptyList())).toString()
    assertFalse(small.contains("test-credential"))
    assertFalse(small.contains("sk-keyRedacted123"))
    assertTrue(small.contains("start-refused"))
  }

  @Test
  fun preflightSurvivesTheActivityTextSanitizerWithValidJsonAndIntactCounts() {
    val report = RepairPreflight.format(RepairPreflight.Observations(
      missingCredentials = 3,
      refusal = "Launch failed: password=hunter2",
      logs = mapOf("engine.log" to listOf("plugin load failed: Authorization: Bearer sample")),
    ))
    val wire = repairToolWireJson(report)
    assertEquals(wire, LogSanitizer.sanitizeOrNull(wire))
    val decoded = JSONObject(wire)
    assertEquals(report.toString(), decoded.toString())
    assertEquals(3, decoded.getInt("missingCredentialCount"))
    assertFalse(wire.contains("hunter2"))
    assertFalse(wire.contains("Bearer sample"))
  }

  @Test
  fun boundedLogTailDiscardsCutUtf8AndUnfinishedLogLines() {
    val file = Files.createTempFile("repair-preflight", ".log").toFile()
    try {
      val partial = "partial".toByteArray() + byteArrayOf(0xe5.toByte(), 0x89.toByte())
      file.writeBytes(("前".repeat(16) + "\r\n保留这行\r\n").toByteArray() + partial)
      val wanted = "保留这行\r\n"
      val limit = wanted.toByteArray().size + partial.size + 3
      val window = readRepairTail(file, limit, completeLinesOnly = true)
      assertEquals(wanted, window.bytes.toString(Charsets.UTF_8))
      assertEquals(file.length() - (wanted.toByteArray().size + partial.size), window.offset)
      file.writeText("no final newline")
      assertEquals("no final newline", readRepairTail(file, 64, completeLinesOnly = true).bytes.toString(Charsets.UTF_8))
      file.writeBytes("line\n".toByteArray() + byteArrayOf(0xe5.toByte(), 0x89.toByte()))
      assertEquals("line\n", readRepairTail(file, 64, completeLinesOnly = false).bytes.toString(Charsets.UTF_8))
    } finally {
      file.delete()
    }
  }
}
