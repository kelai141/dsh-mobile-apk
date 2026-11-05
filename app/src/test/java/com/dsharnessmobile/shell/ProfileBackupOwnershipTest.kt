package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProfileBackupOwnershipTest {
  @get:Rule val temporary = TemporaryFolder()

  private fun target() = File(temporary.newFolder(), "cordis.patch.yml")
  private fun prefix(target: File) = target.name + ".pre-" + BuildConfig.VERSION_NAME + "-"

  @Test fun sameTimestampDoesNotOverwriteAnEarlierAttempt() {
    val target = target()
    val first = ProfileNormalizeBackup.write(target, "first", false, 1_000)
    val second = ProfileNormalizeBackup.write(target, "second", false, 1_000)
    assertNotEquals(first, second)
    assertEquals("first", first.readText())
    assertEquals("second", second.readText())
  }

  @Test fun anOccupiedAttemptNameIsNeverTruncated() {
    val target = target()
    val occupied = File(target.parentFile, prefix(target) + "0000000001000.bak").apply { writeText("keep") }
    val backup = ProfileNormalizeBackup.write(target, "new", false, 1_000)
    assertEquals("keep", occupied.readText())
    assertNotEquals(occupied, backup)
  }

  @Test fun pruningNeverClaimsAnEarlierUuidBackup() {
    val target = target()
    val foreign = File(target.parentFile, prefix(target) + "00000000-0000-4000-8000-000000000000.bak")
      .apply { writeText("repair rollback") }
    repeat(4) { ProfileNormalizeBackup.write(target, "attempt-$it", false, 1_700_000_000_000L + it) }
    assertEquals("repair rollback", foreign.readText())
    assertFalse(ProfileNormalizeBackup.successfulBackups(target).contains(foreign))
  }

  @Test fun malformedNamesAreNotPartOfEitherRetentionQuota() {
    val target = target()
    val foreign = File(target.parentFile, prefix(target) + "0000000000000-user-note.bak").apply { writeText("keep") }
    assertFalse(ProfileNormalizeBackup.successfulBackups(target).contains(foreign))
    repeat(4) { ProfileNormalizeBackup.write(target, "attempt-$it", false, 1_000L + it) }
    assertEquals("keep", foreign.readText())
  }

  @Test fun aClockRollbackCannotPruneTheBackupBeingReturned() {
    val target = target()
    repeat(3) { ProfileNormalizeBackup.write(target, "old-$it", false, 2_000L + it) }
    val newest = ProfileNormalizeBackup.write(target, "current original", false, 1_000)
    assertTrue("The returned backup must still exist after pruning", newest.isFile)
    assertEquals("current original", newest.readText())
    assertEquals(newest, ProfileNormalizeBackup.successfulBackups(target).last())
  }
}
