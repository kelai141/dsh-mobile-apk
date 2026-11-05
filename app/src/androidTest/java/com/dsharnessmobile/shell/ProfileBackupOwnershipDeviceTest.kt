package com.dsharnessmobile.shell

import android.content.ContextWrapper
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ProfileBackupOwnershipDeviceTest {
  private val legacy = """
    - id: agent-default-model
      disabled: true
    - insert:
        - id: agent-default-model-mobile
          name: '@deepseek-ai/dsh-agent-default-model'
          config:
            provider: fixture-provider
            model: fixture-model
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
  """.trimIndent() + "\n"

  @Test fun aHistoricalDirectoryCannotReplaceThisAttemptsBackup() = fixture { manager, profile, root ->
    val old = File(profile, "cordis.patch.yml.pre-${BuildConfig.VERSION_NAME}.bak")
    assertTrue(old.mkdir())
    normalize(manager)
    assertTrue(old.isDirectory)
    assertPublication(profile, root, legacy)
  }

  @Test fun aPartialHistoricalFileIsPreservedButNotReused() = fixture { manager, profile, root ->
    val old = File(profile, "cordis.patch.yml.pre-${BuildConfig.VERSION_NAME}.bak").apply { writeText("partial") }
    normalize(manager)
    assertEquals("partial", old.readText())
    assertPublication(profile, root, legacy)
  }

  @Test fun failedBackupCreationLeavesLiveAndMarkerUntouched() = fixture { manager, profile, root ->
    Os.chmod(profile.absolutePath, 0x140) // Owner read/execute, with no directory write permission.
    try {
      normalize(manager)
      assertEquals(legacy, File(profile, "cordis.patch.yml").readText())
      assertFalse(marker(root).exists())
      assertTrue(ProfileNormalizeBackup.successfulBackups(File(profile, "cordis.patch.yml")).isEmpty())
    } finally { Os.chmod(profile.absolutePath, 0x1c0) }
  }

  @Test fun fourRealMigrationsKeepTheLatestThreeOriginals() = fixture { manager, profile, root ->
    val originals = (0..3).map { "# attempt $it\n" + legacy }
    for (original in originals) {
      marker(root).delete()
      File(profile, "cordis.patch.yml").writeText(original)
      normalize(manager)
      assertPublication(profile, root, original)
    }
    val target = File(profile, "cordis.patch.yml")
    assertEquals(originals.takeLast(3), ProfileNormalizeBackup.successfulBackups(target).map { it.readText() })
    assertTrue(ProfileNormalizeBackup.failedBackups(target).isEmpty())
  }

  @Test fun androidAllocationRejectsLinksAndPreservesForeignBackups() = fixture { _, profile, _ ->
    val target = File(profile, "cordis.patch.yml")
    val prefix = target.name + ".pre-" + BuildConfig.VERSION_NAME + "-"
    val foreign = File(profile, prefix + "00000000-0000-4000-8000-000000000000.bak").apply { writeText("repair") }
    val outside = File(profile, "unrelated.txt").apply { writeText("untouched") }
    val link = File(profile, prefix + "0000000001000.bak")
    Files.createSymbolicLink(link.toPath(), outside.toPath())
    assertFalse(ProfileNormalizeBackup.isValid(link, "untouched"))
    val first = ProfileNormalizeBackup.write(target, "first", false, 1_000)
    val second = ProfileNormalizeBackup.write(target, "second", false, 1_000)
    assertNotEquals(first, second)
    assertEquals("first", first.readText())
    assertEquals("second", second.readText())
    assertEquals("untouched", outside.readText())
    assertTrue(Files.isSymbolicLink(link.toPath()))
    repeat(4) { ProfileNormalizeBackup.write(target, "good-$it", false, 2_000L + it) }
    val newest = ProfileNormalizeBackup.write(target, "after-clock-rollback", false, 1)
    assertEquals("after-clock-rollback", newest.readText())
    repeat(4) { ProfileNormalizeBackup.write(target, "failed-$it", true, 1) }
    assertEquals(3, ProfileNormalizeBackup.successfulBackups(target).size)
    assertEquals(3, ProfileNormalizeBackup.failedBackups(target).size)
    assertTrue(newest.exists())
    assertEquals("repair", foreign.readText())
  }

  private fun marker(root: File) = File(root, ".profile-patch-normalize-${BuildConfig.VERSION_NAME}")

  private fun assertPublication(profile: File, root: File, original: String) {
    val target = File(profile, "cordis.patch.yml")
    assertFalse(target.readText().contains("agent-default-model-mobile"))
    assertTrue(target.readText().contains("model: fixture-model"))
    assertTrue(ProfileNormalizeBackup.successfulBackups(target).any { it.readText() == original })
    assertTrue(marker(root).isFile)
  }

  private fun normalize(manager: EngineManager) {
    EngineManager::class.java.getDeclaredMethod("normalizeLegacySinglePointPatch")
      .apply { isAccessible = true }.invoke(manager)
  }

  private fun fixture(action: (EngineManager, File, File) -> Unit) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "backup-ownership-${java.util.UUID.randomUUID()}")
    assertTrue(root.mkdir())
    try {
      val wrapped = object : ContextWrapper(context) { override fun getFilesDir(): File = root }
      val profile = File(root, "home/.dsh/profiles/fixture").apply { assertTrue(mkdirs()) }
      File(profile, "package.json").writeText("""{"name":"dsh-profile-fixture","dsh":{"profile":{}}}""")
      File(profile, "cordis.patch.yml").writeText(legacy)
      action(EngineManager(wrapped), profile, root)
    } finally { root.deleteRecursively() }
  }
}
