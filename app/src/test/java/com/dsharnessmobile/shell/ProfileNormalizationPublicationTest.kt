package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.util.UUID
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProfileNormalizationPublicationTest {
  @get:Rule val temporary = TemporaryFolder()
  private fun target() = File(temporary.newFolder(), "cordis.patch.yml").apply { writeText("original") }
  private fun pending(directory: File) = directory.listFiles()!!.filter { it.name.contains(".normalize-pending-") }

  @Test fun publicationFailurePreservesTheFullSuccessfulHistory() {
    val target = target()
    repeat(3) { ProfileNormalizeBackup.write(target, "successful-$it", false, 1_000L + it) }
    val before = ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() }
    val error = IOException("publication failure")
    val thrown = assertThrows(IOException::class.java) {
      ProfileNormalizationPublication.publish(target, "original") {
        assertEquals(before, ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() })
        assertEquals("original", pending(target.parentFile!!).single().readText())
        throw error
      }
    }
    assertSame(error, thrown)
    assertEquals(before, ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() })
    assertEquals(listOf("original"), ProfileNormalizeBackup.failedBackups(target).map { it.readText() })
    assertTrue(pending(target.parentFile!!).isEmpty())
  }

  @Test fun successfulPublicationPrunesOnlyAfterTheCallbackAndPreservesFailures() {
    val target = target()
    repeat(3) {
      ProfileNormalizeBackup.write(target, "good-$it", false, 1_000L + it)
      ProfileNormalizeBackup.write(target, "bad-$it", true, 2_000L + it)
    }
    val failed = ProfileNormalizeBackup.failedBackups(target).associate { it.name to it.readText() }
    val backup = ProfileNormalizationPublication.publish(target, "original") {
      assertEquals(listOf("good-0", "good-1", "good-2"), ProfileNormalizeBackup.successfulBackups(target).map { it.readText() })
      target.writeText("normalized")
    }
    assertEquals("original", backup.readText())
    assertEquals(listOf("good-1", "good-2", "original"), ProfileNormalizeBackup.successfulBackups(target).map { it.readText() })
    assertEquals(failed, ProfileNormalizeBackup.failedBackups(target).associate { it.name to it.readText() })
    assertTrue(pending(target.parentFile!!).isEmpty())
  }

  @Test fun unavailablePendingStorageNeverInvokesPublication() {
    val parent = temporary.newFile()
    var invoked = false
    assertThrows(Exception::class.java) {
      ProfileNormalizationPublication.publish(File(parent, "cordis.patch.yml"), "original") { invoked = true }
    }
    assertFalse(invoked)
    assertTrue(parent.isFile)
  }

  @Test fun finalBackupFailureKeepsTheDurablePendingOriginal() {
    val target = target()
    val moved = File(target.parentFile!!.parentFile, "moved-${UUID.randomUUID()}")
    assertThrows(Exception::class.java) {
      ProfileNormalizationPublication.publish(target, "original") {
        assertTrue(target.parentFile!!.renameTo(moved))
        target.parentFile!!.writeText("not a directory")
      }
    }
    assertEquals("original", pending(moved).single().readText())
  }

  @Test fun failedPublicationKeepsItsOriginalExceptionIfSettlementAlsoFails() {
    val target = target()
    val moved = File(target.parentFile!!.parentFile, "moved-${UUID.randomUUID()}")
    val error = IOException("publication failure")
    val thrown = assertThrows(IOException::class.java) {
      ProfileNormalizationPublication.publish(target, "original") {
        assertTrue(target.parentFile!!.renameTo(moved))
        target.parentFile!!.writeText("not a directory")
        throw error
      }
    }
    assertSame(error, thrown)
    assertEquals(1, thrown.suppressed.size)
    assertEquals("original", pending(moved).single().readText())
  }

  @Test fun orphanRetentionIsBoundedAndDoesNotClaimForeignNames() {
    val target = target()
    repeat(8) { File(target.parentFile, target.name + ".normalize-pending-${UUID.randomUUID()}.bak").writeText("orphan-$it") }
    val foreign = File(target.parentFile, target.name + ".normalize-pending-user-note.bak").apply { writeText("keep") }
    ProfileNormalizationPublication.publish(target, "original") { }
    assertEquals(4, pending(target.parentFile!!).size)
    assertEquals("keep", foreign.readText())
  }
}
