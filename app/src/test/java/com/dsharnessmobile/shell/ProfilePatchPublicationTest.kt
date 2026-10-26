package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProfilePatchPublicationTest {
  @get:Rule val temporary = TemporaryFolder()

  private fun legacy(model: String = "fixture-model") = """
    - id: agent-default-model
      disabled: true
    - insert:
        - id: agent-default-model-mobile
          name: '@deepseek-ai/dsh-agent-default-model'
          config:
            provider: fixture-provider
            model: $model
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
  """.trimIndent() + "\n"

  private fun target(): File = File(temporary.newFolder(), "cordis.patch.yml").apply { writeText(legacy()) }
  private fun normalized(text: String) = FactoryProfilePatch.normalizeLegacyAgentDefaultModel(text).text

  @Test fun successfulPublicationRetainsTheExactPreviousText() {
    val target = target()
    val original = target.readText()
    val backup = ProfilePatchPublication.normalize(target, original, normalized(original))
    assertTrue(backup.isFile)
    assertEquals(original, backup.readText())
    assertEquals(normalized(original), target.readText())
  }

  @Test fun anExistingBackupDirectoryCannotReplaceThisAttemptsBackup() {
    val target = target()
    val old = File(target.parentFile, target.name + ".pre-${BuildConfig.VERSION_NAME}.bak")
    assertTrue(old.mkdir())
    val original = target.readText()
    val backup = ProfilePatchPublication.normalize(target, original, normalized(original))
    assertTrue(old.isDirectory)
    assertTrue(backup.isFile)
    assertEquals(original, backup.readText())
    assertNotEquals(old, backup)
  }

  @Test fun partialHistoricalBackupIsPreservedButNeverReused() {
    val target = target()
    val old = File(target.parentFile, target.name + ".pre-${BuildConfig.VERSION_NAME}.bak").apply { writeText("partial") }
    val original = target.readText()
    val backup = ProfilePatchPublication.normalize(target, original, normalized(original))
    assertEquals("partial", old.readText())
    assertEquals(original, backup.readText())
    assertNotEquals(old, backup)
  }

  @Test fun rejectedPublicationPreservesTheLiveFileAndItsBackup() {
    val target = target()
    val original = target.readText()
    try {
      ProfilePatchPublication.normalize(target, original, normalized(original)) { _, _ -> false }
      fail("publication must fail")
    } catch (_: SnapshotFsException) { }
    assertEquals(original, target.readText())
    assertTrue(target.parentFile.listFiles()!!.any { it.name.endsWith(".bak") && it.readText() == original })
    assertFalse(target.parentFile.listFiles()!!.any { it.name.endsWith(".tmp") })
  }

  @Test fun eachAttemptKeepsItsOwnPriorConfiguration() {
    val target = target()
    val first = target.readText()
    val backupOne = ProfilePatchPublication.normalize(target, first, normalized(first))
    val second = legacy("second-model")
    target.writeText(second)
    val backupTwo = ProfilePatchPublication.normalize(target, second, normalized(second))
    assertNotEquals(backupOne, backupTwo)
    assertEquals(first, backupOne.readText())
    assertEquals(second, backupTwo.readText())
  }

  @Test fun invalidNormalizationCannotChangeTheLiveProfile() {
    val target = target()
    val original = target.readText()
    try {
      ProfilePatchPublication.normalize(target, original, "")
      fail("invalid normalization must fail")
    } catch (_: IllegalArgumentException) { }
    assertEquals(original, target.readText())
  }
}
