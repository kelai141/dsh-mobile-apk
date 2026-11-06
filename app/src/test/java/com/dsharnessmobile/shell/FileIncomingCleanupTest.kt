package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FX-211.2（F-211.2 双重静默）回归：onTaskRemoved 的临时工作区全清不得吃掉「投递/重试期」的来件。
 *
 * 缺陷形态：activeCopies 守卫只包住 copyIn，finally 一减之后 recordOpening → enqueuePending →
 * 20s 重试全在守卫外；用户「分享到 DSH」后数秒内划掉应用 → cleanupTmp 顶层全删 → 来件、
 * 待发清单与元数据一起消失（无重试、无残留、无日志）。
 */
class FileIncomingCleanupTest {

  @Test
  fun deliveryReservationIsTakenAfterSweepAndAlwaysReleased() {
    val lock = Any()
    val deliveries = java.util.concurrent.atomic.AtomicInteger(0)
    val observed = mutableListOf<Pair<Int, Int>>()
    var insideLock = false

    val result = FileIncoming.withIncomingDeliveryAfterSweep(
      lock,
      deliveries,
      sweep = {
        insideLock = Thread.holdsLock(lock)
        observed += 1 to deliveries.get()
      },
    ) {
      observed += 2 to deliveries.get()
      "done"
    }

    assertEquals("done", result)
    assertTrue("sweep must run while holding the cleanup lock", insideLock)
    assertEquals("sweep sees no in-flight delivery reservation", 1 to 0, observed[0])
    assertEquals("delivery is reserved before work starts", 2 to 1, observed[1])
    assertEquals("reservation must be released", 0, deliveries.get())

    assertTrue(runCatching {
      FileIncoming.withIncomingDeliveryAfterSweep(lock, deliveries, {}) { error("pipeline failed") }
    }.isFailure)
    assertEquals("failed delivery must not leak its reservation", 0, deliveries.get())
  }

  @Test
  fun wipeIsAllowedOnlyWhenBothCopyAndDeliveryAreSilent() {
    assertTrue(FileIncoming.workspaceWipeAllowed(0, 0))
    assertFalse("拷贝在途不得全清（会删半个文件）", FileIncoming.workspaceWipeAllowed(1, 0))
    assertFalse("投递/重试在途不得全清（FX-211.2 的双重静默）", FileIncoming.workspaceWipeAllowed(0, 1))
    assertFalse(FileIncoming.workspaceWipeAllowed(2, 3))
  }

  @Test
  fun metadataEntriesAreNeverDeletedByTheTaskRemovedRitual() {
    val entries = listOf(".sessions", ".pending-notify.ndjson", ".meta.ndjson", "alpha.pdf", "beta.txt")
    assertEquals(listOf("alpha.pdf", "beta.txt"), FileIncoming.cleanupDeletions(entries, emptyList()))
  }

  @Test
  fun filesStillInThePendingLedgerSurvive() {
    val entries = listOf(".meta.ndjson", "alpha.pdf", "beta.txt")
    val pending = listOf("/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/workspaces/incoming/alpha.pdf")
    val deletions = FileIncoming.cleanupDeletions(entries, pending)
    assertEquals(listOf("beta.txt"), deletions)
    assertFalse("仍有 pending 的来件不许删（新会话 @<path> 会悬空）", deletions.contains("alpha.pdf"))
  }

  @Test
  fun allPendingKeepsTheWholeIncomingSet() {
    val entries = listOf("a.pdf", "b.pdf", ".meta.ndjson", ".pending-notify.ndjson")
    val pending = listOf("/x/incoming/a.pdf", "/x/incoming/b.pdf")
    assertEquals(emptyList<String>(), FileIncoming.cleanupDeletions(entries, pending))
  }

  @Test
  fun queuedBlankSessionSourceSurvivesUntilBrowserClaim() {
    val entries = listOf("draft.pdf", "unrelated.txt", ".sessions")
    val queued = listOf("/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/workspaces/incoming/draft.pdf")
    val deletions = FileIncoming.cleanupDeletions(entries, emptyList(), queued)
    assertEquals(listOf("unrelated.txt"), deletions)
    assertFalse("未 claim 的外部附件草稿源文件不许被 onTaskRemoved 删除", deletions.contains("draft.pdf"))
  }

  @Test
  fun stalePendingEntryDoesNotShieldUnrelatedFiles() {
    val entries = listOf("a.pdf", "b.pdf")
    val pending = listOf("/x/incoming/gone.pdf")
    assertEquals(listOf("a.pdf", "b.pdf"), FileIncoming.cleanupDeletions(entries, pending))
  }
  @Test
  fun ttlSweepKeepsPendingAndQueuedSources() {
    val entries = listOf("pending.pdf", "draft.pdf", "orphan.txt", ".pending-notify.ndjson", ".sessions")
    val pending = listOf("/x/incoming/pending.pdf")
    val queued = listOf("/x/incoming/draft.pdf")
    assertEquals(listOf("orphan.txt"), FileIncoming.ttlDeletions(entries, pending, queued))
  }

  @Test
  fun sweepWorkspaceDeletesOnlyUnreferencedExpiredFiles() {
    val dir = Files.createTempDirectory("ttl-sweep").toFile()
    try {
      val pendingFile = File(dir, "pending.pdf").apply { writeText("pending") }
      val queuedFile = File(dir, "draft.pdf").apply { writeText("queued") }
      val orphan = File(dir, "orphan.txt").apply { writeText("old") }
      val metadata = File(dir, ".pending-notify.ndjson").apply { writeText("reference") }
      val old = System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000
      for (file in listOf(pendingFile, queuedFile, orphan, metadata)) file.setLastModified(old)

      val removed = FileIncoming.sweepWorkspace(
        dir,
        listOf(pendingFile.absolutePath),
        listOf(queuedFile.absolutePath),
        System.currentTimeMillis(),
        7L * 24 * 60 * 60 * 1000,
      )

      assertEquals(1, removed)
      assertTrue("pending source must survive", pendingFile.isFile)
      assertTrue("queued source must survive", queuedFile.isFile)
      assertTrue("metadata must survive", metadata.isFile)
      assertFalse("unreferenced expired file is the only deletion", orphan.exists())
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun sweepWorkspaceFailsClosedWhenAnyReferenceListIsUnreadable() {
    val dir = Files.createTempDirectory("ttl-unreadable").toFile()
    try {
      val orphan = File(dir, "orphan.txt").apply { writeText("old") }
      val pending = File(dir, "pending.pdf").apply { writeText("pending") }
      val old = System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000
      orphan.setLastModified(old)
      pending.setLastModified(old)
      val now = System.currentTimeMillis()

      assertEquals(0, FileIncoming.sweepWorkspace(dir, null, emptyList(), now, 7L * 24 * 60 * 60 * 1000))
      assertEquals(0, FileIncoming.sweepWorkspace(dir, emptyList(), null, now, 7L * 24 * 60 * 60 * 1000))
      assertTrue(orphan.isFile)
      assertTrue(pending.isFile)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun sweepWorkspaceDoesNotDeleteUnexpiredOrDirectoryEntries() {
    val dir = Files.createTempDirectory("ttl-scope").toFile()
    try {
      val fresh = File(dir, "fresh.txt").apply { writeText("fresh") }
      val subdirectory = File(dir, "sub").apply { mkdirs(); File(this, "child").writeText("child") }
      val old = System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000
      subdirectory.setLastModified(old)
      val removed = FileIncoming.sweepWorkspace(dir, emptyList(), emptyList(), System.currentTimeMillis(), 7L * 24 * 60 * 60 * 1000)
      assertEquals(0, removed)
      assertTrue(fresh.isFile)
      assertTrue(subdirectory.isDirectory)
      assertTrue(File(subdirectory, "child").isFile)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun corruptSessionRecordMakesTheWholeSweepFailClosed() {
    val dir = Files.createTempDirectory("ttl-corrupt-session").toFile()
    try {
      val sessions = File(dir, ".sessions").apply { mkdirs() }
      File(sessions, "broken.json").writeText("{")
      File(sessions, "valid.json").writeText("{\"path\":\"/x/incoming/draft.pdf\"}")
      val pending = File(dir, "pending.pdf").apply { writeText("pending") }
      val orphan = File(dir, "orphan.txt").apply { writeText("old") }
      val old = System.currentTimeMillis() - 8L * 24 * 60 * 60 * 1000
      pending.setLastModified(old)
      orphan.setLastModified(old)

      assertEquals(
        0,
        FileIncoming.sweepWorkspace(dir, emptyList(), null, System.currentTimeMillis(), 7L * 24 * 60 * 60 * 1000),
      )
      assertTrue(pending.isFile)
      assertTrue(orphan.isFile)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun queuedIndexReadFailureIsNotTreatedAsAnEmptyQueue() {
    val dir = Files.createTempDirectory("queued-read").toFile()
    try {
      val sessions = File(dir, ".sessions").apply { mkdirs() }
      File(sessions, "broken.json").writeText("{")
      assertTrue("unreadable session index must fail closed", FileIncoming.readQueuedSessionPaths(sessions) == null)

      File(sessions, "broken.json").delete()
      File(sessions, "valid.json").writeText("{\"path\":\"/x/incoming/draft.pdf\"}")
      assertEquals(listOf("/x/incoming/draft.pdf"), FileIncoming.readQueuedSessionPaths(sessions))
      assertEquals(emptyList<String>(), FileIncoming.readQueuedSessionPaths(File(dir, "missing")))
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun validJsonWithUnknownReferenceSchemaStopsCleanup() {
    val dir = Files.createTempDirectory("queued-schema").toFile()
    try {
      val record = File(dir, "unknown.json")
      for (text in listOf("{}", "{\"path\":null}", "{\"path\":42}", "{\"path\":\" \"}")) {
        record.writeText(text)
        assertEquals("unknown reference schema must not be treated as no references", null, FileIncoming.readQueuedSessionPaths(dir))
      }
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun missingAndEmptyLedgerAreDifferentFromUnreadableLedger() {
    val dir = Files.createTempDirectory("pending-ledger").toFile()
    try {
      val ledger = File(dir, ".pending-notify.ndjson")
      // 清单条目自带来源（缺陷 1）：读出来的每一项是 origin to path；老格式（纯路径）按 external。
      assertEquals(emptyList<Pair<String, String>>(), FileIncoming.readPending(ledger))
      ledger.writeText("alpha\n\nbeta\n")
      assertEquals(
        listOf(FileIncoming.ORIGIN_EXTERNAL to "alpha", FileIncoming.ORIGIN_EXTERNAL to "beta"),
        FileIncoming.readPending(ledger),
      )
      assertTrue(FileIncoming.readPending(dir) == null)
    } finally {
      dir.deleteRecursively()
    }
  }

  @Test
  fun ledgerWriteReplacesTheWholeManifestAtomically() {
    val dir = Files.createTempDirectory("pending-write").toFile()
    try {
      val ledger = File(dir, ".pending-notify.ndjson")
      ledger.writeText("old\n")
      FileIncoming.writePending(
        ledger,
        listOf(FileIncoming.ORIGIN_EXTERNAL to "survivor", FileIncoming.ORIGIN_EXTERNAL to "new"),
      )
      assertEquals(
        listOf(FileIncoming.ORIGIN_EXTERNAL to "survivor", FileIncoming.ORIGIN_EXTERNAL to "new"),
        FileIncoming.readPending(ledger),
      )
      assertTrue("temporary files must not be left behind", dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    } finally {
      dir.deleteRecursively()
    }
  }
  @Test
  fun ledgerWriteFailureLeavesNoTemporaryFileOrPartialManifest() {
    val dir = Files.createTempDirectory("pending-failure").toFile()
    try {
      val ledger = File(dir, ".pending-notify.ndjson")
      ledger.writeText("old\n")
      val old = ledger.readText()
      val failingParent = File(dir, "missing").apply { writeText("not-a-directory") }
      val impossible = File(failingParent, "ledger")
      assertTrue(
        runCatching {
          FileIncoming.writePending(impossible, listOf(FileIncoming.ORIGIN_EXTERNAL to "new"))
        }.isFailure,
      )
      assertEquals(old, ledger.readText())
      assertTrue("no temp residue beside a failed write", dir.listFiles()!!.none { it.name.endsWith(".tmp") })
      assertFalse(File(failingParent, "ledger").exists())
    } finally {
      dir.deleteRecursively()
    }
  }
}
