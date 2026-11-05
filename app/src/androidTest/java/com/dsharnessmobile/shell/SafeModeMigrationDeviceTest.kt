package com.dsharnessmobile.shell

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

/** Actual Android filesystem qualification; all profile state is isolated under app cache. */
class SafeModeMigrationDeviceTest {
  private val state = """{"active":false,"snapshotId":"fixture"}""".toByteArray()
  private val hard = setOf(PluginMounts.HardEntry("fixture-owned", "fixture-owned-package"))
  private val original = """
    # Preserve this header Ω
    - insert:
        - id: fixture-external
          name: fixture-external-package
    # Preserve this column-zero boundary Ω
    - insert:
        - id: fixture-owned
          name: fixture-owned-package
    # Preserve this tail
  """.trimIndent() + "\n"

  @Test fun identicalDuplicateStatusConvergesWithoutChangingCurrentBytes() = fixture { patch, home, auto ->
    val current = File(auto, SafeMode.STATE_FILE).apply { writeBytes(state) }
    val legacy = File(auto, "safe-mode-state.json").apply { writeBytes(state) }
    val result = SafeMode.status(auto, patch, home)
    assertTrue(result.message, result.ok)
    assertArrayEquals(state, current.readBytes())
    assertFalse(Files.exists(legacy.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
  }

  @Test fun conflictingDuplicateStateKeepsBothOriginalFiles() = fixture { patch, home, auto ->
    val current = File(auto, SafeMode.STATE_FILE).apply { writeBytes(state) }
    val other = """{"active":false,"snapshotId":"different"}""".toByteArray()
    val legacy = File(auto, "safe-mode-state.json").apply { writeBytes(other) }
    val before = patch.readBytes()
    assertFalse(SafeMode.status(auto, patch, home).ok)
    assertArrayEquals(state, current.readBytes())
    assertArrayEquals(other, legacy.readBytes())
    assertArrayEquals(before, patch.readBytes())
  }

  @Test fun eitherSymbolicLinkIsRefusedWithoutFollowingOrDeletingIt() {
    for (linkCurrent in listOf(true, false)) fixture { patch, home, auto ->
      val current = File(auto, SafeMode.STATE_FILE)
      val legacy = File(auto, "safe-mode-state.json")
      val target = File(auto.parentFile, "outside-state.json").apply { writeBytes(state) }
      val link = if (linkCurrent) current else legacy
      val regular = if (linkCurrent) legacy else current
      regular.writeBytes(state)
      Files.createSymbolicLink(link.toPath(), target.toPath())
      assertFalse(SafeMode.status(auto, patch, home).ok)
      assertTrue(Files.isSymbolicLink(link.toPath()))
      assertArrayEquals(state, regular.readBytes())
      assertArrayEquals(state, target.readBytes())
    }
  }

  @Test fun eitherDirectoryIsRefusedAndItsContentsRemainIntact() {
    for (directoryCurrent in listOf(true, false)) fixture { patch, home, auto ->
      val current = File(auto, SafeMode.STATE_FILE)
      val legacy = File(auto, "safe-mode-state.json")
      val directory = if (directoryCurrent) current else legacy
      val regular = if (directoryCurrent) legacy else current
      assertTrue(directory.mkdir())
      val sentinel = File(directory, "sentinel").apply { writeText("keep") }
      regular.writeBytes(state)
      assertFalse(SafeMode.status(auto, patch, home).ok)
      assertEquals("keep", sentinel.readText())
      assertArrayEquals(state, regular.readBytes())
    }
  }

  @Test fun enterAndExitPreserveColumnZeroCommentsAndRestoreExactBytes() = fixture { patch, home, auto ->
    val patchBefore = patch.readBytes()
    val homeBefore = home.readBytes()
    val result = SafeMode.enter(patch, home, auto, "comment-round-trip", hardEntries = hard)
    assertTrue(result.message, result.ok)
    val filtered = patch.readText()
    assertFalse(filtered.contains("fixture-external-package"))
    assertTrue(filtered.contains("fixture-owned-package"))
    assertTrue(filtered.contains("# Preserve this column-zero boundary Ω"))
    assertTrue(filtered.contains("# Preserve this tail"))
    assertTrue(SafeMode.status(auto, patch, home).ok)
    val exited = SafeMode.exit(patch, home, auto)
    assertTrue(exited.message, exited.ok)
    assertArrayEquals(patchBefore, patch.readBytes())
    assertArrayEquals(homeBefore, home.readBytes())
    assertFalse(File(auto, SafeMode.STATE_FILE).exists())
  }

  @Test fun interruptedActiveStateMigrationStillExitsThroughVerifiedBackups() = fixture { patch, home, auto ->
    val before = patch.readBytes()
    assertTrue(SafeMode.enter(patch, home, auto, "active-migration", hardEntries = hard).ok)
    val current = File(auto, SafeMode.STATE_FILE)
    val legacy = File(auto, "safe-mode-state.json").apply { writeBytes(current.readBytes()) }
    val exited = SafeMode.exit(patch, home, auto)
    assertTrue(exited.message, exited.ok)
    assertArrayEquals(before, patch.readBytes())
    assertFalse(current.exists())
    assertFalse(legacy.exists())
  }

  private fun fixture(action: (File, File, File) -> Unit) {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val root = File(context.cacheDir, "safe-mode-migration-${UUID.randomUUID()}")
    check(root.mkdir())
    try {
      val dsh = File(root, ".dsh")
      val patch = File(dsh, "profiles/web/cordis.patch.yml").apply {
        check(parentFile!!.mkdirs())
        writeText(original)
      }
      val home = File(dsh, "cordis.patch.yml").apply { writeText("# Original home Ω\n[]\n") }
      val auto = File(dsh, "undo-snapshots/auto").apply { check(mkdirs()) }
      action(patch, home, auto)
    } finally {
      check(root.deleteRecursively())
    }
  }
}
