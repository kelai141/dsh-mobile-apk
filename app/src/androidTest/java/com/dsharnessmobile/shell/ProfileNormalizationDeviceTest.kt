package com.dsharnessmobile.shell

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ProfileNormalizationDeviceTest {
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

  @Test fun historicalBackupDirectoryCannotSubstituteForThisAttemptsCopy() = fixture { manager, profile ->
    val old = File(profile, "cordis.patch.yml.pre-${BuildConfig.VERSION_NAME}.bak")
    assertTrue(old.mkdir())
    normalize(manager)
    assertTrue(old.isDirectory)
    assertValidPublication(profile)
  }

  @Test fun partialHistoricalBackupCannotSubstituteForThisAttemptsCopy() = fixture { manager, profile ->
    val old = File(profile, "cordis.patch.yml.pre-${BuildConfig.VERSION_NAME}.bak").apply { writeText("partial") }
    normalize(manager)
    assertEquals("partial", old.readText())
    assertValidPublication(profile)
  }

  @Test fun normalMigrationPreservesItsExactPriorText() = fixture { manager, profile ->
    normalize(manager)
    assertValidPublication(profile)
  }

  private fun assertValidPublication(profile: File) {
    val current = File(profile, "cordis.patch.yml").readText()
    assertFalse(current.contains("agent-default-model-mobile"))
    assertTrue(current.contains("provider: fixture-provider"))
    assertTrue(current.contains("model: fixture-model"))
    assertTrue("migration must retain an exact regular rollback file", profile.listFiles()!!.any {
      it.isFile && it.name.endsWith(".bak") && it.readText() == legacy
    })
  }

  private fun normalize(manager: EngineManager) {
    EngineManager::class.java.getDeclaredMethod("normalizeLegacySinglePointPatch").apply { isAccessible = true }.invoke(manager)
  }

  private fun fixture(action: (EngineManager, File) -> Unit) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "normalization-${java.util.UUID.randomUUID()}")
    assertTrue(root.mkdir())
    try {
      val wrapped = object : ContextWrapper(context) { override fun getFilesDir(): File = root }
      val profile = File(root, "home/.dsh/profiles/fixture")
      assertTrue(profile.mkdirs())
      File(profile, "package.json").writeText("""{"name":"dsh-profile-fixture","dsh":{"profile":{}}}""")
      File(profile, "cordis.patch.yml").writeText(legacy)
      action(EngineManager(wrapped), profile)
      assertTrue(File(root, ".profile-patch-normalize-${BuildConfig.VERSION_NAME}").isFile)
    } finally { root.deleteRecursively() }
  }
}
