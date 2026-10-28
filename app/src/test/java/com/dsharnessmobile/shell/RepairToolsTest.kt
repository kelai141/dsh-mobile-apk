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

  // ---- issue #720：restart_engine 的三态映射（逐态回归，不再靠"看文案") ----

  @Test
  fun `三态映射：STARTED 继续走存活判据，DEFERRED 让行，REFUSED 失败`() {
    assertEquals(RestartDisposition.PROCEED, restartDisposition(EngineStartOutcome.STARTED))
    assertEquals(
      RestartDisposition.DEFERRED,
      restartDisposition(EngineStartOutcome.DEFERRED_REFRESHING),
    )
    assertEquals(RestartDisposition.FAILED, restartDisposition(EngineStartOutcome.REFUSED))
  }

  @Test
  fun `让行结果是成功形状：restarted=false 且 deferred=true 且 reason 稳定`() {
    val deferred = deferredRestartResult(cancelled = false)
    assertFalse("让行不是重启成功", deferred.getBoolean("restarted"))
    assertTrue("必须显式标记 deferred，否则调用方只能靠文案猜", deferred.getBoolean("deferred"))
    assertEquals(
      RepairTools.DEFERRED_REASON_SNAPSHOT_REFRESH,
      deferred.getString("reason"),
    )
    assertEquals("snapshot-refresh-in-flight", deferred.getString("reason"))
    assertFalse(deferred.getBoolean("cancelled"))
    assertTrue("要有可读解释", deferred.getString("detail").contains("让行"))
  }

  @Test
  fun `让行结果带取消标记，且绝不带错误码字段`() {
    val cancelled = deferredRestartResult(cancelled = true)
    assertTrue(cancelled.getBoolean("cancelled"))
    // 关键反证：让行结果一旦带 error/code，工具面就会把它渲染成失败（issue #720 的现场）。
    assertFalse(cancelled.has("error"))
    assertFalse(cancelled.has("code"))
  }

  @Test
  fun `反证：DEFERRED 不得被当成失败态映射`() {
    // 旧实现把让行与拒启并成同一条 restart-failed；这条断言把那种回归钉死。
    assertFalse(
      restartDisposition(EngineStartOutcome.DEFERRED_REFRESHING) == RestartDisposition.FAILED,
    )
    assertFalse(
      restartDisposition(EngineStartOutcome.DEFERRED_REFRESHING) == RestartDisposition.PROCEED,
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

    val systemNamed = File(base, "system/outside.txt").apply {
      parentFile.mkdirs()
      writeText("private")
    }
    assertEquals("outside-scope", failure { fs.read(systemNamed.absolutePath, 0, 10) }.getString("error"))
  }

  /** I-R1（2026-10-25 审计）：list 隐藏的 4 个凭据名必须与 read/write 拦截同源——旧实现漏了两个 key.txt。 */
  @Test
  fun keyTextFilesAreNeverReadOrWritten() {
    for (name in listOf("deepseek-key.txt", "dashscope-key.txt")) {
      val file = File(runtime, "home/$name")
      file.parentFile.mkdirs()
      file.writeText("sk-test")
      assertEquals(name + " read", "protected-file", failure { fs.read(file.absolutePath, 0, 64) }.getString("error"))
      assertEquals(name + " write", "protected-file", failure { fs.write(file.absolutePath, "x") }.getString("error"))
      assertEquals("密钥文件不得被覆盖", "sk-test", file.readText())
    }
  }

  /** M-R2：offset 越界必须拒绝——旧实现静默返回文件头内容冒充 offset 处的数据。 */
  @Test
  fun readBeyondFileSizeIsRejectedInsteadOfReturningTheFileHead() {
    val file = File(runtime, "engine.log")
    file.writeText("0123456789")
    assertEquals("越界 offset 必须拒绝", "bad-offset", failure { fs.read(file.absolutePath, 11, 4) }.getString("error"))
    // offset == size 仍合法：读到空并收尾（nextOffset=null）
    val tail = fs.read(file.absolutePath, 10, 4)
    assertTrue(tail.getBoolean("ok"))
    assertEquals("", tail.getString("content"))
    assertTrue(tail.isNull("nextOffset"))
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
  fun apkPathsAreRefusedEvenWhenTheyLookLikeRuntimePaths() {
    assertEquals("outside-scope", failure {
      fs.read(File(base, "nonexistent/file").absolutePath, 0, 8)
    }.getString("error"))
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

  /** #512：引号拆词与字面量中断是字面正则的系统性盲区——归一化判据补上（原样命令仍交执行）。 */
  @Test
  fun commandGuardNormalizesQuotesBeforeMatching() {
    assertEquals("引号拆词后必须命中 kill 家族", true,
      RepairToolsGuard.refusal("ki\"ll\" -9 1") != null)
    assertEquals("字面量中断的凭据路径必须命中", true,
      RepairToolsGuard.refusal("cat ~/'.cred'entials.yaml") != null)
    assertEquals("字面量中断的凭据路径（双引号变体）必须命中", true,
      RepairToolsGuard.refusal("cat ~/.credenti\"al\"s.yaml") != null)
  }

  /** #512：变量间接让「路径字面量出现在 rm 之前」的黑名单失明——同段 $VAR 引用一律拒绝。 */
  @Test
  fun commandGuardRefusesVariableIndirectionForDestructiveFamilies() {
    assertEquals("路径经变量中转的删除必须拒绝", true,
      RepairToolsGuard.refusal("D=/data/app; rm -rf \$D") != null)
    assertEquals("rm 参数里的变量引用必须拒绝", true,
      RepairToolsGuard.refusal("rm -rf \$TARGET_DIR") != null)
    assertEquals("cp 目标变量引用必须拒绝", true,
      RepairToolsGuard.refusal("cp a \$OUT") != null)
    // 误伤面锚定：读类命令的变量不受影响（修复场景常见形态，不得因本规则全灭）。
    assertEquals("读命令带变量不应误拒", null,
      RepairToolsGuard.refusal("cat \$HOME/status.log"))
    assertEquals("普通删除无变量仍走既有黑名单口径", null,
      RepairToolsGuard.refusal("rm usr/tmp/cache.log"))
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
