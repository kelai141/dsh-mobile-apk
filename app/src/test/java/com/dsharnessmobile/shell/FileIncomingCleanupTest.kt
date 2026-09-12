package com.dsharnessmobile.shell

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
  fun stalePendingEntryDoesNotShieldUnrelatedFiles() {
    val entries = listOf("a.pdf", "b.pdf")
    val pending = listOf("/x/incoming/gone.pdf")
    assertEquals(listOf("a.pdf", "b.pdf"), FileIncoming.cleanupDeletions(entries, pending))
  }
}