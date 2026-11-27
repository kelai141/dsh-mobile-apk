package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CompileCachePolicyTest {

  @get:Rule
  val tmp = TemporaryFolder()

  private val fpA = "a".repeat(64)
  private val fpB = "b".repeat(64)

  @Test
  fun generationDirNameValidatesStrict64Hex() {
    assertNull(CompileCachePolicy.generationDirName(null))
    assertNull(CompileCachePolicy.generationDirName(""))
    assertNull(CompileCachePolicy.generationDirName("abc"))
    assertNull(CompileCachePolicy.generationDirName("z".repeat(64)))
    assertEquals("snap-" + "a".repeat(12), CompileCachePolicy.generationDirName(fpA.uppercase()))
  }

  @Test
  fun resolveEngineCacheDirIsolatesValidSnapshotsAndFallsBackWhenAbsent() {
    val home = tmp.root
    assertEquals(
      File(File(home, CompileCachePolicy.ROOT_DIR_NAME), "snap-" + "a".repeat(12)),
      CompileCachePolicy.resolveEngineCacheDir(home, fpA),
    )
    assertEquals(
      File(home, CompileCachePolicy.ROOT_DIR_NAME),
      CompileCachePolicy.resolveEngineCacheDir(home, null),
    )
  }

  @Test
  fun pruneStaleGenerationsRemovesLegacyAndOldSnapDirsWhilePreservingActiveAndSymlinks() {
    val cacheRoot = File(tmp.root, CompileCachePolicy.ROOT_DIR_NAME).apply { mkdirs() }
    val activeGen = CompileCachePolicy.generationDirName(fpA)!!
    val activeDir = File(cacheRoot, activeGen).apply { mkdirs() }
    val activeBlob = File(activeDir, "blob.bin").apply { writeText("keep") }

    val staleSnap = File(cacheRoot, CompileCachePolicy.generationDirName(fpB)!!).apply { mkdirs() }
    File(staleSnap, "old.bin").writeText("stale")

    val legacyDir = File(cacheRoot, "v24.18.0-x64-cf738c9d-10051").apply { mkdirs() }
    File(legacyDir, "legacy.bin").writeText("legacy")

    val externalTarget = tmp.newFolder("external-data")
    val externalFile = File(externalTarget, "keep.txt").apply { writeText("never-delete") }
    val link = File(cacheRoot, "user-link")
    Files.createSymbolicLink(link.toPath(), externalTarget.toPath())

    val removed = CompileCachePolicy.pruneStaleGenerations(cacheRoot, activeGen)
    assertEquals(2, removed)
    assertTrue(activeBlob.isFile)
    assertFalse(staleSnap.exists())
    assertFalse(legacyDir.exists())
    assertTrue(Files.isSymbolicLink(link.toPath()))
    assertTrue(externalFile.isFile)
  }

  @Test
  fun clearGenerationEmptiesCacheWithoutTouchingSymlinks() {
    val cacheDir = File(tmp.root, "snap-" + "a".repeat(12)).apply { mkdirs() }
    val f1 = File(cacheDir, "entry1").apply { writeText("corrupt") }
    val sub = File(cacheDir, "sub").apply { mkdirs() }
    File(sub, "entry2").writeText("corrupt2")

    assertTrue(CompileCachePolicy.clearGeneration(cacheDir))
    assertTrue(cacheDir.isDirectory)
    assertFalse(f1.exists())
    assertFalse(sub.exists())

    val linkTarget = tmp.newFolder("outside")
    val sym = File(tmp.root, "sym-cache")
    Files.createSymbolicLink(sym.toPath(), linkTarget.toPath())
    assertFalse(CompileCachePolicy.clearGeneration(sym))
  }

  @Test
  fun retryPurgeFusesExactlyOncePerSession() {
    assertFalse(CompileCachePolicy.shouldPurgeOnRetry(retryCount = 0, alreadyPurgedThisSession = false))
    assertTrue(CompileCachePolicy.shouldPurgeOnRetry(retryCount = 1, alreadyPurgedThisSession = false))
    assertFalse(CompileCachePolicy.shouldPurgeOnRetry(retryCount = 1, alreadyPurgedThisSession = true))
    assertFalse(CompileCachePolicy.shouldPurgeOnRetry(retryCount = 2, alreadyPurgedThisSession = true))
  }
}
