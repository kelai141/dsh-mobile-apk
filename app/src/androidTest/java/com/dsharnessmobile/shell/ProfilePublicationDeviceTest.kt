package com.dsharnessmobile.shell

import android.content.ContextWrapper
import android.system.Os
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ProfilePublicationDeviceTest {
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

  @Test fun failedPublicationDoesNotConsumeSuccessfulRetention() = fixture { manager, target, marker ->
    repeat(3) { ProfileNormalizeBackup.write(target, "successful-$it", false, 1_000L + it) }
    val previous = ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() }
    assertTrue(File(target.parentFile, target.name + ".normalize.tmp").mkdir())
    normalize(manager)
    assertEquals(legacy, target.readText())
    assertFalse(marker.exists())
    assertEquals(previous, ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() })
    assertEquals(listOf(legacy), ProfileNormalizeBackup.failedBackups(target).map { it.readText() })
  }

  @Test fun repeatedFailuresOnlyTrimFailedHistory() = fixture { manager, target, marker ->
    repeat(3) { ProfileNormalizeBackup.write(target, "successful-$it", false, 1_000L + it) }
    val previous = ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() }
    repeat(4) {
      assertTrue(File(target.parentFile, target.name + ".normalize.tmp").mkdir())
      normalize(manager)
      assertEquals(legacy, target.readText())
      assertFalse(marker.exists())
      assertEquals(previous, ProfileNormalizeBackup.successfulBackups(target).associate { it.name to it.readText() })
      // Separate wall-clock names even when running against the pre-ownership allocator.
      Thread.sleep(3)
    }
    assertEquals(3, ProfileNormalizeBackup.failedBackups(target).size)
    assertTrue(ProfileNormalizeBackup.failedBackups(target).all { it.readText() == legacy })
  }

  @Test fun successfulPublicationOnlyTrimsSuccessfulHistory() = fixture { manager, target, marker ->
    repeat(3) {
      ProfileNormalizeBackup.write(target, "successful-$it", false, 1_000L + it)
      ProfileNormalizeBackup.write(target, "failed-$it", true, 2_000L + it)
    }
    val failures = ProfileNormalizeBackup.failedBackups(target).associate { it.name to it.readText() }
    normalize(manager)
    assertNotEquals(legacy, target.readText())
    assertTrue(marker.isFile)
    assertEquals(listOf("successful-1", "successful-2", legacy),
      ProfileNormalizeBackup.successfulBackups(target).map { it.readText() })
    assertEquals(failures, ProfileNormalizeBackup.failedBackups(target).associate { it.name to it.readText() })
    assertTrue(pending(target).isEmpty())
  }

  @Test fun unavailablePendingStorageLeavesLiveAndMarkerUntouched() = fixture { manager, target, marker ->
    val parent = requireNotNull(target.parentFile)
    Os.chmod(parent.absolutePath, 0b101_000_000)
    try {
      normalize(manager)
      assertEquals(legacy, target.readText())
      assertFalse(marker.exists())
      assertTrue(pending(target).isEmpty())
    } finally { Os.chmod(parent.absolutePath, 0b111_000_000) }
  }

  @Test fun failedSettlementRetainsDurablePendingOriginal() = fixture { _, target, marker ->
    val parent = requireNotNull(target.parentFile)
    try {
      try {
        ProfileNormalizationPublication.publish(target, legacy) {
          target.writeText("published")
          Os.chmod(parent.absolutePath, 0b101_000_000)
        }
        fail("classification must fail in a non-writable directory")
      } catch (_: java.io.IOException) {
        assertEquals("published", target.readText())
        assertFalse(marker.exists())
        assertEquals(listOf(legacy), pending(target).map { it.readText() })
      }
    } finally { Os.chmod(parent.absolutePath, 0b111_000_000) }
  }

  private fun pending(target: File): List<File> = target.parentFile!!.listFiles()!!.filter {
    it.name.startsWith(target.name + ".normalize-pending-")
  }

  private fun normalize(manager: EngineManager) {
    EngineManager::class.java.getDeclaredMethod("normalizeLegacySinglePointPatch")
      .apply { isAccessible = true }.invoke(manager)
  }

  private fun fixture(action: (EngineManager, File, File) -> Unit) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "publication-${java.util.UUID.randomUUID()}")
    assertTrue(root.mkdir())
    try {
      val wrapped = object : ContextWrapper(context) { override fun getFilesDir(): File = root }
      val profile = File(root, "home/.dsh/profiles/fixture").apply { assertTrue(mkdirs()) }
      File(profile, "package.json").writeText("""{"name":"dsh-profile-fixture","dsh":{"profile":{}}}""")
      val target = File(profile, "cordis.patch.yml").apply { writeText(legacy) }
      action(EngineManager(wrapped), target, File(root, ".profile-patch-normalize-${BuildConfig.VERSION_NAME}"))
    } finally { root.deleteRecursively() }
  }
}
