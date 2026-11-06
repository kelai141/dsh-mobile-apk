package com.dsharnessmobile.shell

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 客户端触发准备入口的回归（0.15.0）。
 *
 * 判据集中在三件事：① 环境不在场/来源不合规时**在起线程之前**就拒绝（不当通用下载器）；
 * ② 五个负控（穿越、符号链接逃逸、解压炸弹、摘要不符、字节数不符）在**这一层**同样真的变红，
 * 且失败一律不发布产物；③ 只有全部通过才原子发布成 `<staging>/<sha256>/`，并把归档字节留在原地
 * 供引擎侧复验。
 */
class LinuxAssetPrepareTest {

  private val goodUrl =
    "https://github.com/kelai141/dsh-bionilux/releases/download/v1.2.0/linux-runtime-plugin.tar.xz"

  private lateinit var root: File
  private lateinit var envRoot: File

  @Before
  fun setUp() {
    root = Files.createTempDirectory("linux-asset-prepare-test").toFile()
    envRoot = File(root, LinuxAssetIO.ENV_DIR).apply { mkdirs() }
    // bootstrap 的 load() 会写出初始状态文件；它的在场就是「控制面已启用」的宿主侧凭据。
    File(envRoot, LinuxAssetIO.STATE_FILE).writeText("{\"schemaVersion\":1,\"enabled\":false}\n")
    LinuxAssetPrepare.reset()
    LinuxAssetPrepare.runner = { work -> work() }
    LinuxAssetPrepare.debugBuild = false
  }

  @After
  fun tearDown() {
    LinuxAssetPrepare.reset()
    LinuxAssetPrepare.runner = { work -> Thread(work, "dsh-linux-asset-prepare").start() }
    LinuxAssetPrepare.opener = LinuxAssetIO.HttpOpener
    LinuxAssetPrepare.debugBuild = BuildConfig.DEBUG
    SnapshotFs.deletePath(root)
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private fun archive(build: (TarArchiveOutputStream) -> Unit): ByteArray {
    val buf = ByteArrayOutputStream()
    XZCompressorOutputStream(buf).use { xz ->
      TarArchiveOutputStream(xz).use { tar ->
        build(tar)
        tar.finish()
      }
    }
    return buf.toByteArray()
  }

  private fun writeEntry(tar: TarArchiveOutputStream, name: String, body: ByteArray) {
    val entry = TarArchiveEntry(name)
    entry.size = body.size.toLong()
    tar.putArchiveEntry(entry)
    tar.write(body)
    tar.closeArchiveEntry()
  }

  private fun goodArchive(): ByteArray = archive { tar ->
    writeEntry(tar, "package/package.json", "{\"name\":\"@dsh-android/linux-runtime\"}\n".toByteArray())
    writeEntry(tar, "package/lib/index.js", "export const apply = () => {}\n".toByteArray())
  }

  private fun specJson(bytes: ByteArray, url: String = goodUrl, sha: String? = null, size: Long? = null): String =
    JSONObject()
      .put("url", url)
      .put("sha256", sha ?: sha256(bytes))
      .put("size", size ?: bytes.size.toLong())
      .toString()

  private fun installOpener(bytes: ByteArray): LinuxAssetIO.Opener = LinuxAssetIO.Opener { _, target, _ ->
    target.writeBytes(bytes)
    bytes.size.toLong()
  }

  private fun status(): JSONObject = JSONObject(LinuxAssetPrepare.status())

  private fun stagedDir(bytes: ByteArray): File =
    File(File(envRoot, LinuxAssetPrepare.DIR_STAGING), sha256(bytes))

  // ── 门禁：环境不在场 / 来源不合规 → 起线程之前就拒绝 ──────────────────────

  @Test
  fun refusesBeforeStartingWorkWhenTheEnvironmentIsNotLive() {
    SnapshotFs.deletePath(envRoot)
    var started = false
    LinuxAssetPrepare.runner = { started = true }
    LinuxAssetPrepare.opener = LinuxAssetIO.Opener { _, _, _ -> throw AssertionError("must not fetch") }

    val bytes = goodArchive()
    val answer = JSONObject(LinuxAssetPrepare.start(root, specJson(bytes)))
    assertEquals(false, answer.getBoolean("ok"))
    assertEquals(LinuxAssetIO.CODE_NOT_ENABLED, answer.getString("code"))
    assertFalse("环境不在场不得启动任何工作", started)
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, status().getString("phase"))
  }

  @Test
  fun refusesNonAllowlistedOriginsBeforeStartingWork() {
    var started = false
    LinuxAssetPrepare.runner = { started = true }
    var fetched = false
    LinuxAssetPrepare.opener = LinuxAssetIO.Opener { _, _, _ -> fetched = true; -1L }

    val bytes = goodArchive()
    for (bad in listOf("http://github.com/kelai141/dsh-bionilux/releases/download/v1/a.tar.xz", "https://evil.example.com/a.tar.xz")) {
      val answer = JSONObject(LinuxAssetPrepare.start(root, specJson(bytes, url = bad)))
      assertEquals(false, answer.getBoolean("ok"))
      assertEquals(LinuxAssetIO.CODE_URL_REJECTED, answer.getString("code"))
    }
    assertFalse("来源不合规不得启动工作", started)
    assertFalse("来源不合规不得触达网络", fetched)
  }

  @Test
  fun rejectsAnUnparseableRequest() {
    val answer = JSONObject(LinuxAssetPrepare.start(root, "{not json"))
    assertEquals(false, answer.getBoolean("ok"))
    assertEquals(LinuxAssetIO.CODE_SPEC_INVALID, answer.getString("code"))
    assertFalse(answer.isNull("detail"))
  }

  /**
   * 响应面：清单字面量不合规（摘要格式 / 体量）→ 在起线程、碰文件系统、触网之前就拒绝。
   */
  @Test
  fun rejectsAnInvalidDigestOrSizeBeforeAnyWorkStarts() {
    var started = false
    LinuxAssetPrepare.runner = { started = true }
    var fetched = false
    LinuxAssetPrepare.opener = LinuxAssetIO.Opener { _, _, _ -> fetched = true; -1L }

    val bytes = goodArchive()
    val bad = listOf(
      "../../sentinel",
      "../../../app_state",
      "../../../../../../shared_prefs",
      "..",
      ".",
      "/abs/path",
      "staging/../../escape",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "z".repeat(64),
      "",
    ).map { it to 10L } + listOf(
      sha256(bytes) to -1L,
      sha256(bytes) to (LinuxAssetIO.MAX_DOWNLOAD_BYTES + 1L),
    )

    for ((digest, size) in bad) {
      val json = JSONObject().put("url", goodUrl).put("sha256", digest).put("size", size).toString()
      val answer = JSONObject(LinuxAssetPrepare.start(root, json))
      assertEquals("digest=$digest size=$size 必须被拒", false, answer.getBoolean("ok"))
      assertEquals("digest=$digest size=$size", LinuxAssetIO.CODE_SPEC_INVALID, answer.getString("code"))
    }
    assertFalse("不合规清单不得启动工作", started)
    assertFalse("不合规清单不得触达网络", fetched)
  }

  /**
   * 文件系统面 —— 本缺陷的**承重**判据。
   *
   * 摘要是**路径段的来源**，而 `SnapshotFs.deletePath` 是无包含检查的递归删除。修复前
   * `sha256 = "../../sentinel"` 让 `<envRoot>/staging/../../sentinel` 解析到环境根**之外**，
   * 于是在下载与校验之前就把哨兵删掉了（删除排在 `download()` 之前，URL 404 也照样删）。
   *
   * 本条**故意不判响应码**：只判「环境根之外一个字节都没被动过」。若在这里也判响应码，缺陷存在时
   * 会先红在响应码上，永远走不到哨兵那一行 —— 那正是「只查响应码抓不到该缺陷」的原因。
   */
  @Test
  fun neverDeletesOutsideTheEnvironmentRootWhateverTheDigestSays() {
    val sentinel = File(root, "sentinel").apply { mkdirs() }
    val keep = File(sentinel, "keep.txt").apply { writeText("keep") }

    // 自证非空转：确认该摘要确实**精确指向**哨兵，否则这条负控会悄悄退化成空判。
    val escaped = File(File(envRoot, LinuxAssetPrepare.DIR_STAGING), "../../sentinel")
    assertEquals(
      "本负控的前提：该摘要必须解析到环境根之外的哨兵",
      sentinel.canonicalFile,
      escaped.canonicalFile,
    )

    val json = JSONObject().put("url", goodUrl).put("sha256", "../../sentinel").put("size", 10L).toString()
    LinuxAssetPrepare.start(root, json)

    assertTrue("环境根之外的哨兵必须还在（这正是本缺陷的判据）", keep.isFile)
    assertTrue("哨兵目录必须还在", sentinel.isDirectory)
    assertTrue("环境根本身必须还在", envRoot.isDirectory)
    assertTrue("环境根的状态文件必须还在", File(envRoot, LinuxAssetIO.STATE_FILE).isFile)
  }

  @Test
  fun refusesASecondStartWhileOneIsRunning() {
    // runner 不执行 → 状态停在 running，第二次 start 必须被拒。
    LinuxAssetPrepare.runner = { }
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = installOpener(bytes)
    val first = JSONObject(LinuxAssetPrepare.start(root, specJson(bytes)))
    assertEquals(true, first.getBoolean("ok"))
    assertEquals(LinuxAssetPrepare.PHASE_RUNNING, first.getString("phase"))
    val second = JSONObject(LinuxAssetPrepare.start(root, specJson(bytes)))
    assertEquals(false, second.getBoolean("ok"))
    assertEquals("linux-asset-busy", second.getString("code"))
  }

  // ── 正控：原子发布 + 归档留证 ──────────────────────────────────────────────

  @Test
  fun publishesAtomicallyAndRetainsTheArchiveForEngineSideReverification() {
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = installOpener(bytes)
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes))).getBoolean("ok"))

    val state = status()
    assertEquals("准备失败原因：$state", LinuxAssetPrepare.PHASE_OK, state.getString("phase"))
    val staged = stagedDir(bytes)
    assertEquals(staged.absolutePath, state.getString("stagedPath"))

    // 归档字节保留在原地：引擎侧可就地重算摘要，不必相信宿主写的任何标记。
    val archive = File(staged, "asset.tar.xz")
    assertTrue("归档必须留证", archive.isFile)
    assertEquals(sha256(bytes), sha256(archive.readBytes()))
    assertTrue(File(staged, "unpacked/package/package.json").isFile)
    // 工作目录不得留下 .part 残件
    assertFalse(File(envRoot, "${LinuxAssetPrepare.DIR_STAGING}-${sha256(bytes)}.part").exists())
  }

  // ── 五个负控：摘要、字节数、穿越、符号链接逃逸、炸弹 ────────────────────────

  @Test
  fun digestMismatchAndSizeMismatchGoRedWithoutPublishing() {
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = installOpener(bytes)

    // 负控：摘要不符
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes, sha = "0".repeat(64)))).getBoolean("ok"))
    var state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_DIGEST_MISMATCH, state.getString("code"))
    assertFalse("摘要不符不得发布", stagedDir(bytes).exists())

    // 负控：字节数不符
    LinuxAssetPrepare.reset()
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes, size = bytes.size + 1L))).getBoolean("ok"))
    state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_SIZE_MISMATCH, state.getString("code"))
    assertFalse("字节数不符不得发布", stagedDir(bytes).exists())
  }

  @Test
  fun traversalSymlinkEscapeAndBombArchivesAllFailClosed() {
    // 负控：路径穿越。新解包器对 `..` 条目失败关闭（不再静默跳过）。
    val traversal = archive { tar -> writeEntry(tar, "../evil.txt", "pwned".toByteArray()) }
    LinuxAssetPrepare.opener = installOpener(traversal)
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(traversal))).getBoolean("ok"))
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, status().getString("phase"))
    assertEquals(LinuxAssetIO.CODE_UNSAFE_ARCHIVE, status().getString("code"))
    assertFalse("穿越失败不得发布", stagedDir(traversal).exists())
    assertFalse("穿越条目不得落地到环境根之外", File(envRoot, "evil.txt").exists())
    assertFalse("穿越条目不得落地到环境根的父目录", File(root, "evil.txt").exists())
    assertFalse(File(root.parentFile, "evil.txt").exists())

    // 负控：符号链接逃逸 —— 逃逸链接不得落地（平台无关的判定：看落地事实）
    LinuxAssetPrepare.reset()
    val linkEscape = archive { tar ->
      writeEntry(tar, "package/lib/keep.js", "keep".toByteArray())
      val link = TarArchiveEntry("package/lib/leak.js", org.apache.commons.compress.archivers.tar.TarConstants.LF_SYMLINK)
      link.linkName = "../../../../etc/passwd"
      tar.putArchiveEntry(link)
      tar.closeArchiveEntry()
    }
    LinuxAssetPrepare.opener = installOpener(linkEscape)
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(linkEscape))).getBoolean("ok"))
    assertFalse(
      "逃逸符号链接不得落地",
      File(stagedDir(linkEscape), "unpacked/package/lib/leak.js").exists(),
    )

    // 负控：解压炸弹（超过插件包上限）→ 中止且不发布
    LinuxAssetPrepare.reset()
    val bomb = archive { tar -> repeat(20_001) { writeEntry(tar, "package/lib/f$it.js", ByteArray(1)) } }
    LinuxAssetPrepare.opener = installOpener(bomb)
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bomb))).getBoolean("ok"))
    val state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_UNSAFE_ARCHIVE, state.getString("code"))
    assertFalse("炸弹不得发布", stagedDir(bomb).exists())
    assertFalse(
      "炸弹失败不得留下工作目录",
      File(envRoot, "${LinuxAssetPrepare.DIR_STAGING}-${sha256(bomb)}.part").exists(),
    )
  }

  @Test
  fun downloadFailureLeavesNothingPublished() {
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = LinuxAssetIO.Opener { _, _, _ -> -1L }
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes))).getBoolean("ok"))
    val state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_DOWNLOAD_FAILED, state.getString("code"))
    assertFalse(stagedDir(bytes).exists())
    assertNotNull("失败必须留下可落盘的原因", state.getString("detail"))
  }

  // ── kind：请求契约与按 kind 解包 ─────────────────────────────────────────

  @Test
  fun kindDefaultsToPluginAndIsReportedInStatus() {
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = installOpener(bytes)
    val answer = JSONObject(LinuxAssetPrepare.start(root, specJson(bytes)))
    assertEquals("plugin", answer.getString("kind"))
    assertEquals(LinuxAssetPrepare.PHASE_OK, status().getString("phase"))
    assertEquals("plugin", status().getString("kind"))

    LinuxAssetPrepare.reset()
    val alias = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
      .put("size", bytes.size.toLong()).put("kind", "runtime-plugin").toString()
    assertEquals("plugin", JSONObject(LinuxAssetPrepare.start(root, alias)).getString("kind"))
  }

  @Test
  fun rejectsAnUnknownKindBeforeStartingWork() {
    var started = false
    LinuxAssetPrepare.runner = { started = true }
    val bytes = goodArchive()
    for (bad in listOf("rootfs/../../x", "rootfsx", "../rootfs", "node\u0000")) {
      val json = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
        .put("size", bytes.size.toLong()).put("kind", bad).toString()
      val answer = JSONObject(LinuxAssetPrepare.start(root, json))
      assertEquals(false, answer.getBoolean("ok"))
      assertEquals("kind=$bad", LinuxAssetIO.CODE_KIND_INVALID, answer.getString("code"))
    }
    assertFalse("非法 kind 不得启动工作", started)

    // 显式空串与 JSON null 同义：缺省 plugin（兼容旧 UI 只传 url/sha/size）。
    LinuxAssetPrepare.opener = installOpener(bytes)
    val empty = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
      .put("size", bytes.size.toLong()).put("kind", "").toString()
    val emptyAnswer = JSONObject(LinuxAssetPrepare.start(root, empty))
    assertEquals(false, emptyAnswer.getBoolean("ok"))
    assertEquals(LinuxAssetIO.CODE_KIND_INVALID, emptyAnswer.getString("code"))
    LinuxAssetPrepare.reset()
    val nullKind = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
      .put("size", bytes.size.toLong()).put("kind", JSONObject.NULL).toString()
    assertEquals("plugin", JSONObject(LinuxAssetPrepare.start(root, nullKind)).getString("kind"))
  }

  @Test
  fun rootfsKindKeepsGuestAbsoluteLinksWhileOtherKindsRejectThem() {
    val bytes = archive { tar ->
      writeEntry(tar, "usr/bin/bash", "#!/bin/sh\n".toByteArray())
      writeEntry(tar, "etc/os-release", "debian\n".toByteArray())
      val link = TarArchiveEntry("bin", org.apache.commons.compress.archivers.tar.TarConstants.LF_SYMLINK)
      link.linkName = "/usr/bin"
      tar.putArchiveEntry(link)
      tar.closeArchiveEntry()
    }
    LinuxAssetPrepare.opener = installOpener(bytes)
    val json = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
      .put("size", bytes.size.toLong()).put("kind", "rootfs").toString()
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, json)).getBoolean("ok"))
    val rootfsState = status()
    assertEquals("rootfs", rootfsState.getString("kind"))
    // Windows JVM 默认无符号链接权限；链接策略由 LinuxAssetIOTest 的纯函数用例覆盖。
    val symlinksUnavailable = rootfsState.getString("phase") == LinuxAssetPrepare.PHASE_FAILED &&
      (rootfsState.optString("detail") + rootfsState.optString("code")).contains("特权")
    if (!symlinksUnavailable) {
      assertEquals("准备失败原因：$rootfsState", LinuxAssetPrepare.PHASE_OK, rootfsState.getString("phase"))
      val staged = stagedDir(bytes)
      assertEquals("/usr/bin", java.nio.file.Files.readSymbolicLink(File(staged, "unpacked/bin").toPath()).toString())
      assertTrue(File(staged, "unpacked/usr/bin/bash").isFile)
    }

    LinuxAssetPrepare.reset()
    val nodeJson = JSONObject().put("url", goodUrl).put("sha256", sha256(bytes))
      .put("size", bytes.size.toLong()).put("kind", "node").toString()
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, nodeJson)).getBoolean("ok"))
    val state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_UNSAFE_ARCHIVE, state.getString("code"))
    assertFalse("node kind 不得发布含逃逸链接的产物", stagedDir(bytes).exists())
  }

  @Test
  fun debugOriginIsIgnoredWhenDebugIsOffAndFailsClosedWhenMalformed() {
    val bytes = goodArchive()
    LinuxAssetPrepare.opener = installOpener(bytes)
    File(envRoot, LinuxAssetIO.DEBUG_ORIGIN_FILE).writeText("http://192.168.1.2:18791")
    // 生产档不读配置：即使文件不合规也走官方 URL，由注入的 opener 接管。
    LinuxAssetPrepare.debugBuild = false
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes))).getBoolean("ok"))
    assertEquals(LinuxAssetPrepare.PHASE_OK, status().getString("phase"))

    LinuxAssetPrepare.reset()
    LinuxAssetPrepare.debugBuild = true
    assertTrue(JSONObject(LinuxAssetPrepare.start(root, specJson(bytes))).getBoolean("ok"))
    val state = status()
    assertEquals(LinuxAssetPrepare.PHASE_FAILED, state.getString("phase"))
    assertEquals(LinuxAssetIO.CODE_URL_REJECTED, state.getString("code"))
  }
}
