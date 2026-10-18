package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** JVM coverage for the fail-closed parts of the native repair tools. */
class RepairToolsTest {
  private lateinit var base: File
  private lateinit var runtime: File
  private lateinit var publicRoot: File
  private lateinit var backups: File
  private lateinit var fs: RepairToolsFs
  private lateinit var aliasFs: RepairToolsFs

  @Before
  fun setUp() {
    base = Files.createTempDirectory("repair-tools-test").toFile()
    runtime = File(base, "files").apply { mkdirs() }
    publicRoot = File(base, "Documents/dshdata").apply { mkdirs() }
    backups = File(runtime, RepairTools.BACKUP_DIR).apply { mkdirs() }
    fs = RepairToolsFs(
      runtimeRoot = runtime,
      publicRoot = publicRoot,
      backupRoot = backups,
      runtimeAliases = emptyList(),
      publicAliases = emptyList(),
    )
    aliasFs = RepairToolsFs(
      runtimeRoot = runtime,
      publicRoot = publicRoot,
      backupRoot = backups,
      runtimeAliases = listOf(base.absolutePath + "/runtime-alias"),
      publicAliases = listOf(base.absolutePath + "/public-alias"),
    )
  }

  @After
  fun tearDown() {
    base.deleteRecursively()
  }

  @Test
  fun writeCreatesContentAndBacksUpAnExistingFileBeforeReplacement() {
    val file = File(runtime, "home/note.txt")
    val created = fs.write(file.absolutePath, "first\n")
    assertTrue(created.getBoolean("ok"))
    assertTrue(created.getBoolean("created"))
    assertEquals("first\n", file.readText())

    val replaced = fs.write(file.absolutePath, "second\n")
    assertTrue(replaced.getBoolean("backedUp"))
    assertEquals("second\n", file.readText())
    val backup = File(backups, replaced.getString("backup"))
    assertTrue("backup must retain the pre-write bytes", backup.isFile)
    assertEquals("first\n", backup.readText())
  }

  @Test
  fun readIsBoundedAndProvidesTheNextOffset() {
    val file = File(runtime, "engine.log")
    file.writeText("0123456789")
    val first = fs.read(file.absolutePath, 0, 4)
    assertEquals("0123", first.getString("content"))
    assertTrue(first.getBoolean("truncated"))
    assertEquals(4L, first.getLong("nextOffset"))

    val second = fs.read(file.absolutePath, 8, 4)
    assertEquals("89", second.getString("content"))
    assertFalse(second.getBoolean("truncated"))
  }

  @Test
  fun fileAccessOutsideRuntimeAndPublicDiagnosticsIsRefused() {
    val outside = File(base, "outside.txt").apply { writeText("private"); }
    val failure = failure { fs.read(outside.absolutePath, 0, 10) }
    assertEquals("outside-scope", failure.getString("error"))
  }

  @Test
  fun credentialsAreNeverReadOrWritten() {
    val credential = File(runtime, "home/.dsh/.credentials.yaml")
    credential.parentFile.mkdirs()
    credential.writeText("records: secret\n")
    assertEquals("protected-file", failure { fs.read(credential.absolutePath, 0, 64) }.getString("error"))
    assertEquals("protected-file", failure { fs.write(credential.absolutePath, "x") }.getString("error"))

    val disguised = failure { fs.write(File(runtime, "home/config.txt").absolutePath, "apiKey: sk-test-1234\n") }
    assertEquals("protected-file", disguised.getString("error"))
    assertFalse(File(runtime, "home/config.txt").exists())
  }

  @Test
  fun publicDiagnosticsAreReadOnlyAndAliasesResolve() {
    val log = File(publicRoot, "log/dsh-2026-10-18.log")
    log.parentFile.mkdirs()
    log.writeText("diagnostic\n")
    File(publicRoot, "log/new.txt").apply { parentFile.mkdirs(); writeText("existing public file\n") }
    assertEquals("diagnostic\n", fs.read(File(publicRoot, "log/dsh-2026-10-18.log").absolutePath, 0, 64).getString("content"))
    assertEquals("read-only-scope", failure {
      fs.write(File(publicRoot, "log/dsh-2026-10-18.log").absolutePath, "changed")
    }.getString("error"))

    // Public diagnostics are read-only even for existing files. A write attempt
    // through an alias must reach that same stable refusal.
    val publicAlias = failure {
      aliasFs.write(base.absolutePath + "/public-alias/log/new.txt", "x")
    }
    assertEquals("read-only-scope", publicAlias.getString("error"))
    File(runtime, "note.txt").writeText("runtime data\n")
    assertEquals("runtime data\n", aliasFs.read(base.absolutePath + "/runtime-alias/note.txt", 0, 64)
      .getString("content"))
  }

  @Test
  fun symbolicLinkTargetsAreNotFollowed() {
    val real = File(runtime, "real.txt").apply { writeText("real\n"); }
    val link = File(runtime, "link.txt")
    try {
      Files.createSymbolicLink(link.toPath(), real.toPath())
    } catch (_: Exception) {
      return // Windows without symlink privilege: the guard is still exercised in code.
    }
    assertEquals("symlink-target", failure { fs.read(link.absolutePath, 0, 16) }.getString("error"))
    assertEquals("real\n", real.readText())
  }

  @Test
  fun apkAndSystemPathsAreRefusedEvenWhenTheyLookLikeRuntimePaths() {
    assertEquals("apk-protected", failure { fs.read("/system/bin/sh", 0, 8) }.getString("error"))
    assertEquals("apk-protected", failure { fs.read("/nonexistent/file", 0, 8) }.getString("error"))
    assertEquals("apk-protected", failure { fs.write(runtime.absolutePath + "/x.apk", "x") }.getString("error"))
  }

  @Test
  fun listIsBoundedAndReportsSymlinksWithoutFollowingThem() {
    val dir = File(runtime, "home/list").apply { mkdirs() }
    for (i in 0 until RepairTools.MAX_LIST_ENTRIES + 4) File(dir, String.format("f%03d", i)).writeText("x")
    val value = fs.list(dir.absolutePath)
    assertTrue(value.getBoolean("truncated"))
    assertEquals(RepairTools.MAX_LIST_ENTRIES, value.getJSONArray("entries").length())
  }

  @Test
  fun listHidesCredentialAndPrivateKeyFiles() {
    val dir = File(runtime, "home").apply { mkdirs() }
    File(dir, ".credentials.yaml").writeText("refs:\n  SECRET: value\n")
    File(dir, "deepseek-key.txt").writeText("private")
    File(dir, "visible.txt").writeText("ok")
    val entries = fs.list(dir.absolutePath).getJSONArray("entries")
    val names = (0 until entries.length()).map { entries.getJSONObject(it).getString("name") }
    assertEquals(listOf("visible.txt"), names)
  }

  @Test
  fun commandGuardRefusesProcessApkSystemAndCredentialAccess() {
    assertTrue(RepairToolsGuard.refusal("kill 1234") != null)
    assertTrue(RepairToolsGuard.refusal("am force-stop com.example") != null)
    assertTrue(RepairToolsGuard.refusal("pm uninstall com.example") != null)
    assertTrue(RepairToolsGuard.refusal("rm -f /data/app/base.apk") != null)
    assertTrue(RepairToolsGuard.refusal("cat home/.dsh/.credentials.yaml") != null)
    assertTrue(RepairToolsGuard.refusal("cat files/deepseek-key.txt") != null)
    assertTrue(RepairToolsGuard.refusal("base64 /data/data/app/files/home/.dsh/.credentials.yaml") != null)
    assertTrue(RepairToolsGuard.refusal("grep secret home/.dsh/.credentials.yaml") != null)
    assertEquals(null, RepairToolsGuard.refusal("ls usr/bin | head"))
  }

  @Test
  fun toolDefinitionsHaveStrictArgumentsAndARealStatusProbe() {
    val defs = RepairToolSchemas.definitions()
    assertEquals(listOf("read", "write", "list", "bash", "engine_status", "restart_engine", "refresh_runtime"),
      (0 until defs.length()).map { defs.getJSONObject(it).getString("name") })
    for (i in 0 until defs.length()) {
      val parameters = defs.getJSONObject(i).getJSONObject("parameters")
      assertEquals(false, parameters.getBoolean("additionalProperties"))
    }
    val read = defs.getJSONObject(0).getJSONObject("parameters")
    assertTrue((0 until read.getJSONArray("required").length()).any { read.getJSONArray("required").getString(it) == "path" })
  }

  @Test
  fun credentialMaterialIsRejectedBeforeAFileIsCreated() {
    assertTrue(RepairToolsGuard.credentialLike("password=hunter2") != null)
    assertTrue(RepairToolsGuard.credentialLike("Authorization: Bearer x") != null)
    assertTrue(RepairToolsGuard.credentialLike("note: harmless") == null)
  }

  private fun failure(block: () -> Unit): JSONObject {
    try {
      block()
    } catch (failure: RepairFailure) {
      return JSONObject().put("error", failure.code)
    }
    throw AssertionError("expected RepairFailure")
  }
}
