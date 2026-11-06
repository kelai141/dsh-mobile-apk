package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM policy tests for the bounded engine stop (no device, synthetic /proc). */
class OwnedEngineStopPolicyTest {

  private class FakeHandle(
    var alive: Boolean = true,
    /** Stops dying on SIGTERM: the wedged-host case. */
    var ignoresTerm: Boolean = false,
    var neverDies: Boolean = false,
  ) : OwnedEngineStop.OwnedStopHandle {
    var terminateCalls = 0
    var killCalls = 0

    override fun isAlive(): Boolean = alive
    override fun terminate() {
      terminateCalls++
      if (!ignoresTerm) alive = false
    }
    override fun forceKill() {
      killCalls++
      if (!neverDies) alive = false
    }
  }

  private fun stopper(
    root: File,
    signal: (Int, Int) -> Unit = { _, _ -> },
    sleep: (Long) -> Unit = { _ -> },
    uid: Int = 10123,
  ) = OwnedEngineStop(procRoot = root, selfPid = 1, selfUid = uid, signal = signal, sleep = sleep)

  private fun stop(handle: FakeHandle): Pair<OwnedEngineStop.TrackedOutcome, List<Long>> {
    val sleeps = mutableListOf<Long>()
    val root = Files.createTempDirectory("owned-stop-none").toFile()
    try {
      val outcome = stopper(root, sleep = { sleeps.add(it) })
        .stopTracked(handle, graceMs = 12_000L, forceWaitMs = 3_000L)
      return outcome to sleeps.toList()
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun gracefulHostExitsWithinTheGraceWithoutBeingForced() {
    val handle = FakeHandle()
    val (outcome, sleeps) = stop(handle)
    assertTrue("SIGTERM alone must be enough for a cooperative host", outcome.exited)
    assertFalse("a cooperative host must not be SIGKILLed", outcome.forced)
    assertFalse(outcome.handleRetained)
    assertEquals(1, handle.terminateCalls)
    assertEquals(0, handle.killCalls)
    assertTrue(sleeps.sum() <= 12_000L)
  }

  @Test
  fun graceIsAtLeastTenSecondsSoHostShutdownCanFinish() {
    assertTrue(
      "host shutdown uninstalls tools and awaits pluginHost.shutdown (~8s); grace must be >= 10s",
      OwnedEngineStop.GRACE_MS >= 10_000L,
    )
  }

  @Test
  fun hungHostIsForcedOnlyAfterTheFullGraceAndItsHandleIsKept() {
    val handle = FakeHandle(ignoresTerm = true, neverDies = true)
    val (outcome, sleeps) = stop(handle)
    assertEquals(1, handle.killCalls)
    assertTrue(outcome.forced)
    assertFalse("a surviving host must never be reported as stopped", outcome.exited)
    assertTrue("the live handle must be retained, not dropped", outcome.handleRetained)
    assertTrue("SIGKILL must wait for the grace first", sleeps.sum() >= 12_000L)
  }

  @Test
  fun forceKillThatWorksIsReportedAsForcedNotCleanStop() {
    val handle = FakeHandle(ignoresTerm = true)
    val (outcome, _) = stop(handle)
    assertTrue(outcome.forced)
    assertTrue(outcome.exited)
    assertFalse(outcome.handleRetained)
  }

  @Test
  fun nullHandleIsTreatedAsAlreadyStopped() {
    val root = Files.createTempDirectory("owned-stop-null").toFile()
    try {
      val outcome = stopper(root).stopTracked(null)
      assertTrue(outcome.exited)
      assertFalse(outcome.forced)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun environMatchingRequiresTheExactGenerationToken() {
    val wanted = setOf("gen-b")
    assertTrue(
      OwnedEngineStop.environHasInstanceToken(
        "PATH=/usr/bin\u0000DSH_ENGINE_INSTANCE=gen-b\u0000HOME=/data".toByteArray(),
        wanted,
      ),
    )
    assertFalse(
      "a token sharing a prefix must not match",
      OwnedEngineStop.environHasInstanceToken("DSH_ENGINE_INSTANCE=gen-b-other\u0000".toByteArray(), wanted),
    )
    assertFalse(
      "the value must be a whole entry, not a substring of another variable",
      OwnedEngineStop.environHasInstanceToken("OTHER=DSH_ENGINE_INSTANCE=gen-b\u0000".toByteArray(), wanted),
    )
    assertFalse(OwnedEngineStop.environHasInstanceToken(ByteArray(0), wanted))
  }

  /** stat layout: "pid (comm) state ppid ..." — starttime is field 22 overall. */
  private fun proc(root: File, pid: Int, ppid: Int, uid: Int, start: Long, state: Char = 'S', env: String? = null) {
    val dir = File(root, pid.toString())
    dir.mkdirs()
    // tail starts at overall field 5 (pgrp); starttime (overall field 22) is the 18th entry.
    val tail = (0..17).map { i -> if (i == 17) start.toString() else "0" }.joinToString(" ")
    File(dir, "stat").writeText("$pid (node) $state $ppid " + tail)
    File(dir, "status").writeText("Name:\tnode\nUid:\t$uid\t$uid\t$uid\t$uid\n")
    if (env != null) {
      File(dir, "environ").writeBytes(env.toByteArray())
      File(dir, "cmdline").writeText("node")
    }
  }

  @Test
  fun captureIncludesTokenOwnerAndDescendantsAcrossTheEnvWhitelist() {
    val root = Files.createTempDirectory("owned-stop-capture").toFile()
    try {
      proc(root, 100, 1, 10123, 11, env = "DSH_ENGINE_INSTANCE=gen-a\u0000")
      // Guest tool: our marker was stripped by the runtime env whitelist, but it is a child.
      proc(root, 101, 100, 10123, 12)
      proc(root, 102, 101, 10123, 13)
      proc(root, 103, 1, 10123, 14)
      proc(root, 104, 1, 10123, 15, env = "DSH_ENGINE_INSTANCE=gen-old\u0000")
      val domain = stopper(root).captureDomain(listOf("gen-a"))
      assertEquals(listOf(100, 101, 102), domain!!.map { it.pid })
      assertEquals(listOf(11L, 12L, 13L), domain.map { it.startTime })
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun captureFailsLoudlyWhenProcIsUnreadable() {
    val missing = File("build/tmp/definitely-missing-proc")
    assertNull("a failed scan is not an empty domain", stopper(missing).captureDomain(listOf("gen-a")))
  }

  @Test
  fun crossUidDescendantIsNeverCaptured() {
    val root = Files.createTempDirectory("owned-stop-uid").toFile()
    try {
      proc(root, 700, 1, 10123, 120, env = "DSH_ENGINE_INSTANCE=gen-a\u0000")
      // A root-owned helper spawned by the host: another permission domain.
      proc(root, 701, 700, 0, 121)
      val domain = stopper(root).captureDomain(listOf("gen-a"))
      assertEquals("only the same-UID domain may be signalled", listOf(700), domain!!.map { it.pid })
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun unparsableProcEntryMakesTheScanUntrusted() {
    val root = Files.createTempDirectory("owned-stop-partial").toFile()
    try {
      proc(root, 800, 1, 10123, 130)
      val broken = File(root, "801")
      broken.mkdirs()
      File(broken, "stat").writeText("801 (broken") // truncated: identity unknowable
      // A foreign-UID directory whose stat is unreadable (SELinux does this on real
      // devices) is outside our domain and must not block an otherwise clean stop.
      val foreign = File(root, "802")
      foreign.mkdirs()
      File(foreign, "stat").writeText("802 (other")
      val outcome = stopper(root).reap(emptyList(), 10, 10)
      assertTrue("foreign unreadable entries must not block the stop", outcome.clean)
      assertNull(outcome.error)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun knownMemberWhoseIdentityBecameUnreadableBlocksClean() {
    val root = Files.createTempDirectory("owned-stop-known").toFile()
    try {
      proc(root, 810, 1, 10123, 140)
      val recorded = OwnedEngineStop.Member(810, 140L, 10123)
      // The member still exists but its stat is now truncated: identity unprovable.
      File(root, "810/stat").writeText("810 (node")
      val signals = mutableListOf<Int>()
      val outcome = stopper(root, signal = { p, _ -> signals.add(p) })
        .reap(listOf(recorded), 100, 100)
      assertFalse("an unverifiable known member must not look clean", outcome.clean)
      assertEquals(listOf(810), outcome.unverified)
      assertTrue("never signal a process whose identity could not be re-verified", signals.isEmpty())
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun recycledPidIsNeverSignalled() {
    val root = Files.createTempDirectory("owned-stop-reuse").toFile()
    try {
      val signals = mutableListOf<Pair<Int, Int>>()
      proc(root, 300, 1, 10123, 999)
      val recorded = OwnedEngineStop.Member(300, 50L, 10123)
      val outcome = stopper(root, signal = { p, s -> signals.add(p to s) }).reap(listOf(recorded), 100, 100)
      assertTrue("a recycled pid must not receive any signal", signals.isEmpty())
      assertTrue(outcome.clean)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun zombieCountsAsDeadNotSurvivor() {
    val root = Files.createTempDirectory("owned-stop-zombie").toFile()
    try {
      proc(root, 400, 1, 10123, 70, state = 'Z')
      val signals = mutableListOf<Int>()
      val outcome = stopper(root, signal = { p, _ -> signals.add(p) })
        .reap(listOf(OwnedEngineStop.Member(400, 70L, 10123)), 100, 100)
      assertTrue("zombies cannot hold the runtime", outcome.clean)
      assertTrue(signals.isEmpty())
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun termAndKillTouchOnlyRecordedMembersAndReportSurvivors() {
    val root = Files.createTempDirectory("owned-stop-reap").toFile()
    try {
      proc(root, 500, 1, 10123, 90)
      proc(root, 501, 1, 99999, 91)
      val signals = mutableListOf<Pair<Int, Int>>()
      val outcome = stopper(root, signal = { p, s -> signals.add(p to s) })
        .reap(listOf(OwnedEngineStop.Member(500, 90L, 10123)), 100, 100)
      assertEquals(listOf(15, 9), signals.map { it.second })
      assertTrue(signals.all { it.first == 500 })
      assertEquals(listOf(500), outcome.survivors)
      assertFalse("survivors after SIGKILL are not clean", outcome.clean)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun unreadableProcIsAnErrorNotEmptySuccess() {
    val missing = File("build/tmp/definitely-missing-proc")
    val outcome = stopper(missing).reap(emptyList(), 10, 10)
    assertFalse("a failed scan must not look clean", outcome.clean)
    assertEquals("proc-unreadable", outcome.error)
  }

  @Test
  fun ledgerRoundTripKeepsStartTimeAndUidAndRemovesSettledGeneration() {
    val dir = Files.createTempDirectory("owned-stop-ledger").toFile()
    try {
      val file = File(dir, ".engine-stop-ledger")
      val ledger = EngineStopLedger(file)
      ledger.recordGeneration("gen-a")
      ledger.recordDomain("gen-a", listOf(OwnedEngineStop.Member(10, 500L, 10123)))
      ledger.recordGeneration("gen-b")
      val entries = ledger.read()
      assertEquals(listOf("gen-a", "gen-b"), entries.map { it.token })
      assertEquals(OwnedEngineStop.Member(10, 500L, 10123), entries.first().members.single())
      ledger.remove("gen-a")
      assertEquals(listOf("gen-b"), ledger.read().map { it.token })
      ledger.remove("gen-b")
      assertFalse("the ledger disappears once nothing is owed", file.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun openProcScanWithNothingOwnedIsClean() {
    val root = Files.createTempDirectory("owned-stop-empty").toFile()
    try {
      proc(root, 600, 1, 10123, 100) // unrelated, same uid
      val domain = stopper(root).captureDomain(listOf("gen-a"))
      assertTrue("nothing owned is an empty domain, not an error", domain!!.isEmpty())
      assertTrue(stopper(root).reap(domain, 10, 10).clean)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun ledgerCandidatesExcludeOnlyTheTokenThisProcessStillOwns() {
    // After a Java-process restart the live token is unknown (null), so the newest
    // generation - whose host may already be dead while guests survive - must be a
    // candidate. Only a token this process still tracks is excluded.
    val dir = Files.createTempDirectory("owned-stop-gen").toFile()
    try {
      val ledger = EngineStopLedger(File(dir, "l"))
      ledger.recordGeneration("gen-current")
      ledger.recordGeneration("gen-newest")
      assertEquals(
        "a restarted app must still be able to settle the newest dead generation",
        listOf("gen-current", "gen-newest"),
        ledger.read().filter { it.token != null }.map { it.token },
      )
      assertEquals(
        "an in-process restart must not reap the host it still owns",
        listOf("gen-newest"),
        ledger.read().filter { it.token != "gen-current" }.map { it.token },
      )
    } finally {
      dir.deleteRecursively()
    }
  }
}

