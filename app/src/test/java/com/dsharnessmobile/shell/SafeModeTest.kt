package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 缺陷 D（fx-2）：安全模式状态机的事务纪律与「保留自有插件」判据（纯 JVM，真实文件系统）。
 *
 * 本仓测试面**没有 Mockito**，所以落盘核心只依赖 [File]（`SafeMode.enter/exit/status` 收 File 参数），
 * 测试直接打真实临时目录——与 `ControlAuditTest` / `BootFailLogTest` 同款纪律。
 *
 * 反证方式（每条判据都有对应变异会判红，见回报）：
 *  - 把 `enter` 里「先写状态文件再改 patch」调换成旧顺序 → `crashWindowLeavesNoWayBack` 判红；
 *  - 把 `exit` 的备份校验去掉 → `exitRefusesWhenBackupMissing` 判红；
 *  - 从 exact Hard fixture 删除任一出厂 `{id,name}` → 产品条目保留/第三方摘除用例判红；用户同包条目不会被误保留。
 */
class SafeModeTest {
  private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

  @Test
  fun `缺失归属清单时拒绝开启且不改配置`() {
    val dir = Files.createTempDirectory("safe-mode-no-hard-manifest").toFile()
    val patch = File(dir, "patch.yml")
    val home = File(dir, "home.yml")
    val auto = File(dir, "auto")
    val original = "- insert:\n  - id: user-hard\n    name: '@deepseek-ai/user-hard'\n"
    patch.writeText(original)
    val result = SafeMode.enter(patch, home, auto, "missing-manifest", hardManifestAvailable = false)
    assertFalse(result.ok)
    assertTrue(result.message.contains("未生效"))
    assertTrue(result.message.contains("归属清单缺失"))
    assertEquals(original, patch.readText())
    assertFalse(File(auto, SafeMode.STATE_FILE).exists())
    assertFalse(File(auto, "safe-mode-backup-missing-manifest.yml").exists())
  }

  @Test
  fun `归属清单空或无exact entries时拒绝开启且不改配置`() {
    val dir = Files.createTempDirectory("safe-mode-empty-hard-manifest").toFile()
    val patch = File(dir, "patch.yml")
    val home = File(dir, "home.yml")
    val auto = File(dir, "auto")
    val original = "- insert:\n  - id: user-entry\n    name: '@dsh-android/user-entry'\n"
    patch.writeText(original)
    val result = SafeMode.enter(patch, home, auto, "empty-manifest", hardManifestAvailable = true, hardEntries = emptySet())
    assertFalse(result.ok)
    assertTrue(result.message.contains("归属清单缺失"))
    assertEquals(original, patch.readText())
    assertFalse(File(auto, SafeMode.STATE_FILE).exists())
  }


  @get:Rule
  val tmp = TemporaryFolder()

  /** 一份**逼真的** live patch：含第三方条目 + 全部自有插件 + 组外 config 行。 */
  private fun realisticPatch(extraThirdParty: Boolean = true): String {
    val shared = javaClass.getResourceAsStream("/safe-mode/cordis.patch.yml")
      ?.bufferedReader(Charsets.UTF_8)?.use { it.readText().replace("\r\n", "\n") }
      ?: error("shared Safe Mode patch fixture missing")
    if (extraThirdParty) return shared
    return shared
      .replace(Regex("    - id: dsh-code-diff-viewer\n      name: dsh-code-diff-viewer\n      config:\n        theme: dark\n"), "")
      .replace("    - id: dsh-find-plugin\n      name: dsh-find-plugin\n", "")
  }

  private fun fixture(): Triple<File, File, File> {
    val root = tmp.root
    val patch = File(root, "profiles/web/cordis.patch.yml")
    patch.parentFile!!.mkdirs()
    val homePatch = File(root, "cordis.patch.yml")
    val autoDir = File(root, "undo-snapshots/auto")
    return Triple(patch, homePatch, autoDir)
  }

  /** Verified product rows represented by this fixture; user entries never become Hard by parsing the fixture. */
  private val fixtureHardEntries = setOf(
    PluginMounts.HardEntry("shell-termux", "@dsh-android/dsh-shell-termux"),
    PluginMounts.HardEntry("host-web-compat", "@dsh-android/dsh-host-web-compat"),
    PluginMounts.HardEntry("ui-responsive", "@dsh-android/dsh-client-ui-responsive"),
    PluginMounts.HardEntry("android-bridge", "@dsh-android/dsh-android-bridge"),
    PluginMounts.HardEntry("android-manage", "@dsh-android/dsh-android-manage"),
    PluginMounts.HardEntry("android-linux-env", "@dsh-android/dsh-android-linux-env"),
    PluginMounts.HardEntry("android-file-open", "@dsh-android/dsh-android-file-open"),
    PluginMounts.HardEntry("android-browser", "@dsh-android/dsh-android-browser"),
    PluginMounts.HardEntry("android-vdisplay", "@dsh-android/dsh-android-vdisplay"),
    PluginMounts.HardEntry("dsh-undo-savepoint", "dsh-undo-savepoint"),
    PluginMounts.HardEntry("dshmarketplace", "dshmarketplace-plugin"),
    PluginMounts.HardEntry("llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai"),
  )

  @Test
  fun `生产web布局复用既有scoped marker且双位置冲突fail closed`() {
    val dsh = File(tmp.root, ".dsh")
    val patch = File(dsh, "profiles/web/cordis.patch.yml").apply { parentFile!!.mkdirs(); writeText(realisticPatch()) }
    val home = File(dsh, "cordis.patch.yml")
    val flat = File(dsh, "undo-snapshots/auto")
    val scoped = File(dsh, "undo-snapshots/web/auto")
    // A real scoped legacy marker is the routing evidence; an empty scoped directory alone must not redirect new state.
    scoped.mkdirs()
    File(scoped, "safe-mode-state.json").writeText(org.json.JSONObject().put("active", false).put("snapshotId", "legacy-scoped").toString())
    val entries = fixtureHardEntries
    val original = patch.readBytes()
    val entered = SafeMode.enter(patch, home, flat, "scoped-route", hardEntries = entries)
    assertTrue(entered.ok)
    assertTrue("新状态落在web scoped旧marker位置", File(scoped, SafeMode.STATE_FILE).isFile)
    assertFalse(File(flat, SafeMode.STATE_FILE).exists())
    assertTrue(SafeMode.exit(patch, home, flat).ok)
    assertTrue(patch.readBytes().contentEquals(original))

    scoped.mkdirs()
    File(scoped, SafeMode.STATE_FILE).writeText("not-json")
    flat.mkdirs()
    File(flat, SafeMode.STATE_FILE).writeText("also-not-json")
    val before = patch.readBytes()
    val conflict = SafeMode.enter(patch, home, flat, "conflict", hardEntries = entries)
    assertFalse(conflict.ok)
    assertTrue(conflict.message.contains("冲突"))
    assertTrue(patch.readBytes().contentEquals(before))
  }

  @Test
  fun `安全模式只保留权威factory bundle并精确恢复package`() {
    val dsh = File(tmp.root, ".dsh")
    val patch = File(dsh, "profiles/web/cordis.patch.yml").apply { parentFile!!.mkdirs(); writeText("- insert:\n  - id: user\n    name: user\n") }
    val home = File(dsh, "cordis.patch.yml")
    val auto = File(dsh, "undo-snapshots/auto")
    val packageFile = File(patch.parentFile, "package.json")
    val originalPackage = "{\n  \"dsh\": {\"profile\": {\"bundles\": [\"factory-good\", \"user-soft\"]}},\n  \"dsh.profile.bundles\": [\"dotted-only\"]\n}\n".toByteArray()
    packageFile.writeBytes(originalPackage)
    val bundle = File(patch.parentFile, "node_modules/factory-good")
    bundle.mkdirs()
    val patchBytes = "- config:\n    safe: true\n".toByteArray()
    File(bundle, "package.json").writeText("{\"name\":\"factory-good\",\"version\":\"1.2.3\",\"dsh\":{\"bundle\":{\"patch\":\"patch.yml\"}}}")
    File(bundle, "patch.yml").writeBytes(patchBytes)
    val framed = MessageDigest.getInstance("SHA-256")
    framed.update("DSHBNDL1".toByteArray(Charsets.US_ASCII))
    val path = "patch.yml".toByteArray(Charsets.UTF_8)
    framed.update(java.nio.ByteBuffer.allocate(4).putInt(path.size).array())
    framed.update(path)
    framed.update(java.nio.ByteBuffer.allocate(8).putLong(patchBytes.size.toLong()).array())
    framed.update(patchBytes)
    val factory = PluginMounts.FactoryBundle("factory-good", "1.2.3", framed.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) })
    val entered = SafeMode.enter(patch, home, auto, "bundle-filter", hardEntries = setOf(PluginMounts.HardEntry("own", "own")), factoryBundles = setOf(factory))
    assertTrue(entered.message, entered.ok)
    val safePackage = org.json.JSONObject(packageFile.readText())
    assertEquals(listOf("factory-good"), (0 until safePackage.getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles").length()).map { safePackage.getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles").getString(it) })
    assertEquals(listOf("dotted-only"), (0 until safePackage.getJSONArray("dsh.profile.bundles").length()).map { safePackage.getJSONArray("dsh.profile.bundles").getString(it) })
    assertTrue(SafeMode.exit(patch, home, auto).ok)
    assertTrue(packageFile.readBytes().contentEquals(originalPackage))

    packageFile.writeBytes(originalPackage)
    val beforePatch = patch.readBytes()
    val refused = SafeMode.enter(patch, home, auto, "bundle-no-identity", hardEntries = setOf(PluginMounts.HardEntry("own", "own")), factoryBundles = null)
    assertFalse(refused.ok)
    assertTrue(packageFile.readBytes().contentEquals(originalPackage))
    assertTrue(patch.readBytes().contentEquals(beforePatch))
  }

  @Test
  fun `vendor共享marker的home与package备份都先恢复校验再退出`() {
    fun prepare(id: String): Triple<Triple<File, File, File>, List<ByteArray>, org.json.JSONObject> {
      val (patch, home, auto) = fixture()
      val pkg = File(patch.parentFile, "package.json")
      val originals = listOf("profile-before\n".toByteArray(), "home-before\n".toByteArray(), "package-before\n".toByteArray())
      val current = listOf("profile-safe\n".toByteArray(), "home-safe\n".toByteArray(), "package-safe\n".toByteArray())
      patch.writeBytes(current[0]); home.writeBytes(current[1]); pkg.writeBytes(current[2])
      val profileBackup = File(auto, "safe-mode-backup-$id.yml")
      val homeBackup = File(auto, "safe-mode-home-backup-$id.yml")
      val pkgBackup = File(auto, "safe-mode-pkg-$id.json")
      profileBackup.parentFile!!.mkdirs()
      profileBackup.writeBytes(originals[0]); homeBackup.writeBytes(originals[1]); pkgBackup.writeBytes(originals[2])
      val shas = originals.map(::digest)
      val marker = org.json.JSONObject()
        .put("active", true).put("profile", "web").put("snapshotId", id)
        .put("backup", profileBackup.absolutePath).put("backupSha256", shas[0])
        // Simulate a vendor marker predating homeExisted: presence of homeBackup authorizes restore.
        .put("homeBackup", homeBackup.absolutePath).put("homeBackupSha256", shas[1])
        .put("pkgBackup", pkgBackup.absolutePath).put("pkgBackupSha256", shas[2])
      File(auto, SafeMode.STATE_FILE).writeText(marker.toString())
      val recovery = File(auto.parentFile, "safe-mode-recovery").apply { mkdirs() }
      originals.forEachIndexed { i, bytes -> File(recovery, "safe-mode-${shas[i]}.yml").writeBytes(bytes) }
      // Deliberately invalidate all primaries; Kotlin must use the verified vendor CAS copies.
      profileBackup.writeText("bad profile primary")
      homeBackup.writeText("bad home primary")
      pkgBackup.writeText("bad package primary")
      return Triple(Triple(patch, home, auto), originals, marker)
    }

    val (files, originals, _) = prepare("vendor-ok")
    val (patch, home, auto) = files
    assertTrue(SafeMode.exit(patch, home, auto).ok)
    assertTrue(patch.readBytes().contentEquals(originals[0]))
    assertTrue(home.readBytes().contentEquals(originals[1]))
    assertTrue(File(patch.parentFile, "package.json").readBytes().contentEquals(originals[2]))

    val (failedFiles, _, _) = prepare("vendor-bad-pkg")
    val (failedPatch, failedHome, failedAuto) = failedFiles
    val pkg = File(failedPatch.parentFile, "package.json")
    val before = listOf(failedPatch.readBytes(), failedHome.readBytes(), pkg.readBytes())
    val badState = org.json.JSONObject(File(failedAuto, SafeMode.STATE_FILE).readText())
    val badSha = badState.getString("pkgBackupSha256")
    File(File(failedAuto.parentFile, "safe-mode-recovery"), "safe-mode-$badSha.yml").writeText("bad pkg recovery")
    val refused = SafeMode.exit(failedPatch, failedHome, failedAuto)
    assertFalse(refused.ok)
    assertTrue(failedPatch.readBytes().contentEquals(before[0]))
    assertTrue(failedHome.readBytes().contentEquals(before[1]))
    assertTrue(pkg.readBytes().contentEquals(before[2]))
    assertTrue(File(failedAuto, SafeMode.STATE_FILE).exists())
  }

  private fun enterWithProductManifest(
    patch: File, homePatch: File, autoDir: File, id: String,
    atomicWrite: ((File, ByteArray) -> Unit)? = null,
  ): SafeMode.Result {
    val entries = fixtureHardEntries
    return if (atomicWrite == null) SafeMode.enter(
      patch, homePatch, autoDir, id, hardManifestAvailable = entries.isNotEmpty(), hardEntries = entries,
    ) else SafeMode.enter(
      patch, homePatch, autoDir, id, atomicWrite,
      hardManifestAvailable = entries.isNotEmpty(), hardEntries = entries,
    )
  }

  private fun filterWithProductManifest(text: String): String {
    val entries = fixtureHardEntries
    return SafeMode.filterThirdPartyInserts(text, entries)
  }

  private fun removedWithProductManifest(text: String): List<String> {
    val entries = fixtureHardEntries
    return SafeMode.removedPluginNames(text, entries)
  }

  // ── ① 事务纪律：备份缺失/崩溃窗口 ──────────────────────────────────────────

  /**
   * 反证核心（既有缺口）：改了 patch 就必须有**可还原的备份 + 状态**——不能出现「patch 已变、
   * 状态不存在」的中间态。本条按 enter 的**后置条件**断言：enter 成功后 off 一定能整份还原。
   */
  @Test
  fun `enter 之后一定存在可还原的备份与状态文件`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    val r = enterWithProductManifest(patch, homePatch, autoDir, "t1")
    assertTrue("enter 必须成功：" + r.message, r.ok)
    // ① 状态文件在场（这是 off 能还原的前提）。
    val state = File(autoDir, SafeMode.STATE_FILE)
    assertTrue("必须写状态文件（否则 off 判「未开启」而拒绝还原）", state.isFile)
    // ② 备份必须存在且逐字节等于进入前的原文。
    val backupPath = org.json.JSONObject(state.readText()).getString("backup")
    val backup = File(backupPath)
    assertTrue("备份必须仍然在场", backup.isFile)
    assertEquals("备份必须逐字节等于进入前的原文", original, backup.readText())
    // ③ patch 确实被改写了（否则这个按钮什么也没做）。
    assertFalse("第三方条目应已被摘除", patch.readText().contains("dsh-code-diff-viewer"))
  }

  /** 备份目录不可建 ⇒ **拒绝进入**，且**不写状态文件**（否则 off 会以为开着）。 */
  @Test
  fun `备份写不成功时拒绝进入且不写状态文件`() {
    val (patch, homePatch, _) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    // 用一个「父路径是普通文件」的 autoDir，制造 mkdirs 必然失败。
    val blocker = File(tmp.root, "blocker")
    blocker.writeText("not a dir")
    val badAuto = File(blocker, "auto")
    val r = enterWithProductManifest(patch, homePatch, badAuto, "t2")
    assertFalse("无法建目录时必须拒绝进入", r.ok)
    assertTrue("回执必须给出理由", r.message.isNotBlank())
    assertEquals("拒绝进入时 patch 必须一字未动", original, patch.readText())
    assertFalse("拒绝进入时不得留下状态文件", File(badAuto, SafeMode.STATE_FILE).exists())
  }

  /** 反证：主备份和副本都被删 ⇒ exit **拒绝**且**不动任何 live 文件**。 */
  @Test
  fun `两份备份缺失时 exit 拒绝且不动live文件`() {
    val (patch, homePatch, autoDir) = fixture()
    patch.writeText(realisticPatch())
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "t3").ok)
    val afterEnter = patch.readBytes()
    val state = File(autoDir, SafeMode.STATE_FILE)
    val marker = org.json.JSONObject(state.readText())
    File(marker.getString("backup")).delete()
    File(autoDir.parentFile, "safe-mode-recovery/safe-mode-${marker.getString("backupSha256")}.yml").delete()
    val r = SafeMode.exit(patch, homePatch, autoDir)
    assertFalse("备份缺失必须拒绝退出", r.ok)
    assertTrue("回执必须说明拒绝原因", r.message.contains("备份缺失"))
    assertTrue("拒绝退出时 patch 必须一字未动", afterEnter.contentEquals(patch.readBytes()))
    assertTrue("状态文件必须保留（否则用户再也看不到安全模式开着）", state.isFile)
  }

  /** 未开启时 exit 必须说「未开启」而不是报错崩溃。 */
  @Test
  fun `未开启时 exit 如实回报未开启`() {
    val (patch, homePatch, autoDir) = fixture()
    autoDir.mkdirs()
    val r = SafeMode.exit(patch, homePatch, autoDir)
    assertFalse("无可退出时 ok=false", r.ok)
    assertTrue("必须说清是「未开启」：" + r.message, r.message.contains("未开启"))
    assertFalse("不得凭空创建文件", patch.exists())
  }

  /**
   * 核心不变量：**enter → exit 后 patch 逐字节等于进入前**。
   *
   * 这是「用户插件不会永久消失」的唯一防线（`PluginMounts.kt` 记载过历史事故）。
   * 反证：把 exit 的 `copyTo(overwrite=true)` 改成「只删我们加的条目」→ 本条判红。
   */
  @Test
  fun `enter 再 exit 后 patch 逐字节等于进入前`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "t4").ok)
    val r = SafeMode.exit(patch, homePatch, autoDir)
    assertTrue("exit 必须成功：" + r.message, r.ok)
    assertEquals("必须整份还原（含第三方插件条目与全部注释/config）", original, patch.readText())
    assertFalse("状态文件必须被清掉", File(autoDir, SafeMode.STATE_FILE).exists())
  }

  /** home 级 patch 存在时：enter 写、exit 还原（设备上通常不存在，但漏处理会让 home 级永久最小化）。 */
  @Test
  fun `home 级 patch 存在时也要备份并还原`() {
    val (patch, homePatch, autoDir) = fixture()
    patch.writeText(realisticPatch())
    val homeOriginal = "- id: user-home-entry\n  name: some-user-plugin\n"
    homePatch.writeText(homeOriginal)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "t5").ok)
    assertFalse("home 级必须被改写", homePatch.readText() == homeOriginal)
    assertTrue(SafeMode.exit(patch, homePatch, autoDir).ok)
    assertEquals("home 级必须整份还原", homeOriginal, homePatch.readText())
  }

  @Test
  fun `重复进入保留首次备份且重复退出不改数据`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "repeat-a").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    val stateBefore = stateFile.readText()
    val filtered = patch.readBytes()
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "repeat-b").ok)
    assertEquals("重复 on 必须保留第一次 marker", stateBefore, stateFile.readText())
    assertTrue("重复 on 不得再改 live patch", filtered.contentEquals(patch.readBytes()))
    assertTrue(SafeMode.exit(patch, homePatch, autoDir).ok)
    assertFalse("成功 off 清除 marker", stateFile.exists())
    assertFalse("重复 off 是无操作失败", SafeMode.exit(patch, homePatch, autoDir).ok)
    assertEquals("重复操作仍逐字节还原", original, patch.readText())
  }

  @Test
  fun `主备份损坏时从独立副本恢复并退出`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "damaged").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    val state = org.json.JSONObject(stateFile.readText())
    File(state.getString("backup")).writeText("corrupted")
    val result = SafeMode.exit(patch, homePatch, autoDir)
    assertTrue("独立副本可恢复时应允许退出：" + result.message, result.ok)
    assertEquals(original, patch.readText())
    assertFalse("退出成功清除 marker", stateFile.exists())
  }

  @Test
  fun `主备份与副本均损坏时不写任何live文件`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    val homeOriginal = "- id: user-home-entry\n  name: some-user-plugin\n"
    patch.writeText(original)
    homePatch.writeText(homeOriginal)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "both-damaged").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    val marker = org.json.JSONObject(stateFile.readText())
    File(marker.getString("backup")).writeText("primary-corrupt")
    File(autoDir.parentFile, "safe-mode-recovery/safe-mode-${marker.getString("backupSha256")}.yml").writeText("copy-corrupt")
    val safePatch = patch.readBytes()
    val safeHomePatch = homePatch.readBytes()
    val result = SafeMode.exit(patch, homePatch, autoDir)
    assertFalse(result.ok)
    assertTrue("失败回执说明拒绝退出", result.message.contains("已拒绝退出"))
    assertTrue("拒绝时 profile patch 不变", safePatch.contentEquals(patch.readBytes()))
    assertTrue("拒绝时 home patch 不变", safeHomePatch.contentEquals(homePatch.readBytes()))
    assertTrue("marker 保留供恢复", stateFile.isFile)
  }

  @Test
  fun `home主备份损坏时从独立副本恢复`() {
    val (patch, homePatch, autoDir) = fixture()
    val profileOriginal = realisticPatch()
    val homeOriginal = "- id: user-home-entry\n  name: some-user-plugin\n"
    patch.writeText(profileOriginal)
    homePatch.writeText(homeOriginal)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "home-fallback").ok)
    val marker = org.json.JSONObject(File(autoDir, SafeMode.STATE_FILE).readText())
    File(marker.getString("homeBackup")).writeText("home-primary-corrupt")
    val result = SafeMode.exit(patch, homePatch, autoDir)
    assertTrue("home 副本有效时应完整退出：" + result.message, result.ok)
    assertEquals(profileOriginal, patch.readText())
    assertEquals(homeOriginal, homePatch.readText())
  }

  @Test
  fun `home任一副本失效时profile与home均不写`() {
    val (patch, homePatch, autoDir) = fixture()
    patch.writeText(realisticPatch())
    homePatch.writeText("- id: user-home-entry\n  name: some-user-plugin\n")
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "home-both-invalid").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    val marker = org.json.JSONObject(stateFile.readText())
    File(marker.getString("homeBackup")).writeText("home-primary-corrupt")
    File(autoDir.parentFile, "safe-mode-recovery/safe-mode-${marker.getString("homeBackupSha256")}.yml").writeText("home-copy-corrupt")
    val profileSafe = patch.readBytes()
    val homeSafe = homePatch.readBytes()
    val result = SafeMode.exit(patch, homePatch, autoDir)
    assertFalse(result.ok)
    assertTrue(profileSafe.contentEquals(patch.readBytes()))
    assertTrue(homeSafe.contentEquals(homePatch.readBytes()))
    assertTrue(stateFile.isFile)
  }

  @Test
  fun `恢复副本写失败时拒绝进入且不留marker`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    val r = enterWithProductManifest(patch, homePatch, autoDir, "recovery-write-fails") { target, bytes ->
      if (target.parentFile.name == "safe-mode-recovery") throw java.io.IOException("recovery write blocked")
      target.parentFile?.mkdirs()
      target.writeBytes(bytes)
    }
    assertFalse(r.ok)
    assertTrue(original.toByteArray().contentEquals(patch.readBytes()))
    assertFalse(File(autoDir, SafeMode.STATE_FILE).exists())
  }

  @Test
  fun `已有效内容寻址副本直接复用`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "reuse-first").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    stateFile.delete()
    patch.writeText(original)
    val again = enterWithProductManifest(patch, homePatch, autoDir, "reuse-second") { target, bytes ->
      if (target.parentFile.name == "safe-mode-recovery") throw java.io.IOException("valid object must not be rewritten")
      target.parentFile?.mkdirs()
      target.writeBytes(bytes)
    }
    assertTrue("有效副本必须复用：" + again.message, again.ok)
  }

  @Test
  fun `备份校验后被替换仍使用已校验字节`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "read-once").ok)
    val marker = org.json.JSONObject(File(autoDir, SafeMode.STATE_FILE).readText())
    val primary = File(marker.getString("backup"))
    val result = SafeMode.exit(patch, homePatch, autoDir) { target, bytes ->
      if (target == patch) primary.writeText("changed-after-validation")
      target.writeBytes(bytes)
    }
    assertTrue("应使用校验时载入的字节：" + result.message, result.ok)
    assertEquals(original, patch.readText())
  }

  @Test
  fun `旧状态无sha字段仍兼容主备份`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "legacy-marker").ok)
    val stateFile = File(autoDir, SafeMode.STATE_FILE)
    val marker = org.json.JSONObject(stateFile.readText())
    val digest = marker.getString("backupSha256")
    marker.remove("backupSha256")
    marker.remove("homeBackupSha256")
    stateFile.writeText(marker.toString())
    File(autoDir.parentFile, "safe-mode-recovery/safe-mode-$digest.yml").delete()
    val result = SafeMode.exit(patch, homePatch, autoDir)
    assertTrue("旧 primary-only marker 应兼容：" + result.message, result.ok)
    assertEquals(original, patch.readText())
  }

  @Test
  fun `写入中断后 marker 仍可驱动完整还原`() {
    val (patch, homePatch, autoDir) = fixture()
    val original = realisticPatch()
    patch.writeText(original)
    val interruptPatchWrite: (File, ByteArray) -> Unit = { target, bytes ->
      if (target.canonicalFile == patch.canonicalFile) {
        target.writeBytes(bytes.copyOf(bytes.size / 2))
        throw java.io.IOException("simulated interrupted patch write")
      }
      target.parentFile?.mkdirs()
      target.writeBytes(bytes)
    }
    val entered = enterWithProductManifest(patch, homePatch, autoDir, "interrupted", interruptPatchWrite)
    assertFalse("注入的写入中断必须回报失败", entered.ok)
    assertTrue("marker 已先提交，off 仍可恢复", File(autoDir, SafeMode.STATE_FILE).isFile)
    assertTrue(SafeMode.exit(patch, homePatch, autoDir).ok)
    assertEquals("中断后的文件必须逐字节回到进入前", original, patch.readText())
    assertFalse("完成恢复后清 marker", File(autoDir, SafeMode.STATE_FILE).exists())
  }

  // ── ② 用户口径：保留我们自己的插件 ──────────────────────────────────────────

  /** safe 态下 10 个自有 Android 插件必须一个不少，依据测试中固定的 exact `{id,name}` 清单。 */
  @Test
  fun `safe 态保留全部十个自有插件`() {
    val before = realisticPatch()
    val after = filterWithProductManifest(before)
    for (p in listOf(
      "@dsh-android/dsh-shell-termux",
      "@dsh-android/dsh-host-web-compat",
      "@dsh-android/dsh-client-ui-responsive",
      "@dsh-android/dsh-android-bridge",
      "@dsh-android/dsh-android-manage",
      "@dsh-android/dsh-android-linux-env",
      "@dsh-android/dsh-android-file-open",
      "@dsh-android/dsh-android-browser",
      "@dsh-android/dsh-android-vdisplay",
    )) {
      assertTrue("自有插件必须保留：$p", after.contains(p))
    }
    assertTrue("undo 必须保留", after.contains("dsh-undo-savepoint"))
    assertTrue("marketplace 必须保留", after.contains("dshmarketplace-plugin"))
  }

  /** 第三方条目必须被摘掉，且摘得**干净**（不留悬空 id、不留空 insert 组）。 */
  @Test
  fun `第三方条目被摘除且不留悬空结构`() {
    val after = filterWithProductManifest(realisticPatch())
    assertFalse("第三方 name 必须消失", after.contains("dsh-code-diff-viewer"))
    assertFalse("第三方 name 必须消失", after.contains("dsh-find-plugin"))
    // 它们的 config 行也必须一起走（只删 name 行会留下悬空 config）。
    assertFalse("第三方 config 不得残留", after.contains("theme: dark"))
    // 摘光后的空 insert 组必须整组消失（空 insert 会让引擎 boot 抛）。
    assertFalse(
      "不得留下空 insert 组（空 insert 语义为 null，引擎会抛）",
      Regex("-" + " insert:\\n(?=\\s*(?:- |\\S))", RegexOption.MULTILINE).containsMatchIn(after) &&
        !after.contains("insert:"),
    )
    assertTrue("原有条目结构仍应存在", after.contains("- insert:"))
  }

  /**
   * 组外的一切**一字不动**（禁用位 / config-only 条目 / 用户 providers）：
   * 它们不是「插件」，动它们等于改语义而不是降风险。
   */
  @Test
  fun `组外条目与原样内容一字不动`() {
    val after = filterWithProductManifest(realisticPatch())
    assertTrue("禁用位必须保留", after.contains("- id: bash-sandbox\n  disabled: true"))
    assertTrue("禁用位必须保留", after.contains("- id: client-hmr\n  disabled: true"))
    assertTrue("config-only 条目必须保留", after.contains("ptc-runtime"))
    assertTrue("nodeExecutable 必须保留", after.contains("nodeExecutable: /x/node"))
    assertTrue("llm-pi-ai 必须保留", after.contains("llm-pi-ai"))
    assertTrue("用户 providers 必须保留", after.contains("providers: {}"))
  }

  /** 无第三方条目时**逐字节不变**（调用方据此跳过写盘，避免无谓改写与 mtime 漂移）。 */
  @Test
  fun `没有第三方条目时输出逐字节等于输入`() {
    val clean = realisticPatch(extraThirdParty = false)
    assertEquals("无改动即逐字节相同", clean, filterWithProductManifest(clean))
  }

  /** 回执里的「摘了几个」必须与实际摘除一致（否则用户拿到自相矛盾的信息）。 */
  @Test
  fun `摘除名单与实际摘除一致`() {
    val before = realisticPatch()
    val removed = removedWithProductManifest(before)
    assertEquals("两个第三方插件", listOf("dsh-code-diff-viewer", "dsh-find-plugin"), removed)
    val after = filterWithProductManifest(before)
    for (name in removed) assertFalse("回执点名的插件必须真的不在结果里：$name", after.contains("name: $name"))
  }

  // ── ③ exact identity ownership and shared policy fixture ───────────────────
  @Test
  fun `不再使用前缀或包名名单判断产品归属`() {
    val candidates = listOf(
      File("scripts/patches/apply-patches.mjs"),
      File("../scripts/patches/apply-patches.mjs"),
      File("dsh-mobile-apk/scripts/patches/apply-patches.mjs"),
    )
    val src = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到 apply-patches.mjs（白名单真源）；cwd=" + File(".").absolutePath)
    val text = src.readText()
    assertTrue("补丁器采用 exact identity manifest", text.contains("safe ownership identity v2"))
    // 判据必须落在「补丁器实际复核什么」上：它用字面量 /entry\.id === id && entry\.name === name/
    // 复核注入结果，而不是靠某个 .mjs 片段里的 JS 拼写（那只管实现细节，换个引号风格就假红）。
    // 注意这里是**字面文本**比对：源码里本来就有一个反斜杠，用 Regex 写 \. 只会去匹配点号。
    assertTrue(
      "补丁器必须按 exact {id,name} 复核所有权，不得回退到包名或前缀",
      text.contains("""entry\.id === id && entry\.name === name"""),
    )
    // 单一权威实现：共享过滤助手是 Kotlin / vendor / CLI 三方对齐的那个源。
    val helper = listOf(
      File("scripts/patches/data/undo-safe-filter-helper-snippet.mjs"),
      File("../scripts/patches/data/undo-safe-filter-helper-snippet.mjs"),
      File("dsh-mobile-apk/scripts/patches/data/undo-safe-filter-helper-snippet.mjs"),
    ).firstOrNull { it.isFile }
      ?: throw AssertionError("找不到共享 safe-mode 过滤助手（唯一权威源）；cwd=" + File(".").absolutePath)
    val helperText = helper.readText()
    assertTrue("助手只认 exact id", helperText.contains("typeof entry.id === 'string'"))
    assertTrue("助手同时比对 id 与 name", helperText.contains("entry.id === id && entry.name === name"))
  }

  @Test
  fun `Safe Mode策略与共享黄金夹具一致`() {
    val candidates = listOf(
      File("scripts/patches/tests/fixtures/safe-mode-policy.yml"),
      File("../scripts/patches/tests/fixtures/safe-mode-policy.yml"),
      File("dsh-mobile-apk/scripts/patches/tests/fixtures/safe-mode-policy.yml"),
    )
    val fixture = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到共享 Safe Mode 策略夹具；cwd=" + File(".").absolutePath)
    val expected = File(fixture.parentFile, "safe-mode-policy.expected.yml").readText()
    val input = fixture.readText()
    assertEquals(
      "Kotlin壳过滤必须与共享黄金输出一致",
      expected,
      SafeMode.filterThirdPartyInserts(input, setOf(
        PluginMounts.HardEntry("mobile-hard", "@dsh-android/dsh-shell-termux"),
        PluginMounts.HardEntry("upstream-hard", "@deepseek-ai/dsh-shipped-core"),
        PluginMounts.HardEntry("undo", "dsh-undo-savepoint"),
        PluginMounts.HardEntry("disabled-product", "@dsh-android/dsh-host-web-compat"),
      )),
    )
    assertEquals(
      "回执只能点名被移除的insert插件",
      listOf("@deepseek-ai/dsh-mcp-client", "dsh-code-diff-viewer", "user-disabled-plugin"),
      SafeMode.removedPluginNames(input, setOf(
        PluginMounts.HardEntry("mobile-hard", "@dsh-android/dsh-shell-termux"),
        PluginMounts.HardEntry("upstream-hard", "@deepseek-ai/dsh-shipped-core"),
        PluginMounts.HardEntry("undo", "dsh-undo-savepoint"),
        PluginMounts.HardEntry("disabled-product", "@dsh-android/dsh-host-web-compat"),
      )),
    )
  }

  @Test
  fun `exact manifest identity判据的正反例`() {
    assertTrue("精确 id/name 清单可证明产品身份", SafeMode.isProductOwned("@deepseek-ai/dsh-llm-pi-ai", setOf(PluginMounts.HardEntry("llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai")), "llm-pi-ai"))
    assertFalse("同包名但不同 id 不属于工厂条目", SafeMode.isProductOwned("@deepseek-ai/dsh-llm-pi-ai", setOf(PluginMounts.HardEntry("llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai")), "user-created-id"))
  }
  /**
   * D-1(c) 的行为回归：**用户自装的官方包必须被 Safe Mode 摘掉**。
   *
   * 这是本轮修的真实缺陷：旧实现按 `@deepseek-ai/` 前缀判归属，会把用户自挂的官方包
   * （实测 `@deepseek-ai/dsh-mcp-client`）当成产品自有条目**保留**，于是 Safe Mode 的
   * 「不加载 Soft」对它失效——而 Safe Mode 存在的全部意义就是让坏插件不参与启动。
   *
   * 判据可证伪：把 [SafeMode.isProductOwned] 改为按发布者前缀保留，本条判红。
   */
  @Test
  fun `用户自装的官方包必须被安全模式摘掉`() {
    val patch = listOf(
      "- insert:",
      "    - id: llm-pi-ai",
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      "    - id: mcp-lark",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "",
    ).joinToString("\n")
    // 权威装配清单只含我们自带的 exact id/name；用户自挂的 mcp-client 不在其中。
    val hardEntries = setOf(PluginMounts.HardEntry("llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai"))
    val after = SafeMode.filterThirdPartyInserts(patch, hardEntries)
    assertTrue("自带的必须保留", after.contains("@deepseek-ai/dsh-llm-pi-ai"))
    assertFalse(
      "用户自装的官方包必须被摘掉（旧实现在此恒保留，本条即其反证）",
      after.contains("@deepseek-ai/dsh-mcp-client"),
    )
    val removed = SafeMode.removedPluginNames(patch, hardEntries)
    assertEquals("回执必须如实点名被摘的那个", listOf("@deepseek-ai/dsh-mcp-client"), removed)
  }

  /** 清单缺席时包名与命名空间都不能冒充 ownership；生产 enter 会在写数据前拒绝。 */
  @Test
  fun `权威清单缺席时不得使用名字或前缀静态兜底`() {
    val patch = listOf(
      "- insert:",
      "    - id: shell-termux",
      "      name: '@dsh-android/dsh-shell-termux'",
      "    - id: marketplace",
      "      name: 'dshmarketplace-plugin'",
      "    - id: evil",
      "      name: 'dsh-code-diff-viewer'",
      "",
    ).joinToString("\n")
    val after = SafeMode.filterThirdPartyInserts(patch, emptySet())
    assertFalse("名字相同不能证明工厂归属", after.contains("@dsh-android/dsh-shell-termux"))
    assertFalse("具名包名不能证明工厂归属", after.contains("dshmarketplace-plugin"))
    assertFalse("未知 entry 必须被纯过滤器视作 Soft", after.contains("dsh-code-diff-viewer"))
  }

  /** status 三态回执：未开启 / 开启中 / 状态文件损坏——三者必须可区分。 */
  @Test
  fun `status 三态回执可区分`() {
    val (patch, homePatch, autoDir) = fixture()
    autoDir.mkdirs()
    assertTrue(SafeMode.status(autoDir).message.contains("未开启"))
    patch.writeText(realisticPatch())
    assertTrue(enterWithProductManifest(patch, homePatch, autoDir, "t6").ok)
    val on = SafeMode.status(autoDir)
    assertTrue("开启后必须说开启中：" + on.message, on.message.contains("开启中"))
    assertTrue("必须带档 id（可追溯）", on.message.contains("t6"))
    File(autoDir, SafeMode.STATE_FILE).writeText("{ 坏 json")
    val broken = SafeMode.status(autoDir)
    assertTrue("损坏必须与「未开启」区分：" + broken.message, broken.message.contains("无法解析"))
  }

  // ── ④ 剪贴板 prompt（纯函数）──────────────────────────────────────────────

  /** prompt 必须含报错**原文**（不得截断成摘要）+ 两条关键约束 + 不承诺修复。 */
  @Test
  fun `prompt 含报错原文与两条关键约束`() {
    val detail = "EngineManager.startEngine() 返回 false（未能拉起引擎进程）"
    val tail = "dsh-boot-fail stage=engine-start-false at=1 fingerprint=abc\\njava.lang.IllegalStateException: boom"
    val p = buildSafeModePrompt("engine-start-false", detail, tail, safeModeActive = true)
    assertTrue("必须含 stage", p.contains("engine-start-false"))
    assertTrue("必须含 detail 原文", p.contains(detail))
    assertTrue("必须含日志尾巴原文（不得摘要化）", p.contains("java.lang.IllegalStateException: boom"))
    assertTrue("必须要求保留自有插件（用户口径第二条）", p.contains("保留") && p.contains("@dsh-android/"))
    assertTrue("必须要求先定位真因", p.contains("先定位真因"))
    assertTrue("必须点明安全模式已开启", p.contains("已开启"))
    // 反向：不得出现过度承诺。
    for (banned in listOf("一定能", "必定", "保证", "一定可以", "必然能")) {
      assertFalse("prompt 不得过度承诺（出现「$banned」）：$p", p.contains(banned))
    }
  }

  /** 输入全空也必须产出**可用**的 prompt（现场可能什么日志都没有）。 */
  @Test
  fun `空输入仍产出可用 prompt`() {
    val p = buildSafeModePrompt(null, null, null, safeModeActive = false)
    assertTrue("必须非空", p.isNotBlank())
    assertTrue("必须点明即将开启（而非已开启）", p.contains("即将开启"))
    assertTrue("缺上下文必须如实说是「未记录」而不是编造", p.contains("(未记录)"))
    assertTrue("不得凭空造出报错内容", p.contains("日志尾巴"))
  }

  /**
   * 安全关键：safe 态下 **7 条 `disabled: true` 一条都不能少**（lead 实测清单）。
   *
   * 其中 `client-hmr` 是安全关键项：漏掉它会重开 `/plugins/events` 无鉴权 SSE
   * （依据 `scripts/profile-web.cordis.patch.yml:60-64`）。
   * 本条锁「安全模式不得把上游禁用位恢复成启用」——它只摘第三方插件条目，不动任何禁用位。
   */
  @Test
  fun `safe 态保留全部七条 disabled true`() {
    val before = realisticPatch(extraThirdParty = false).let { clean ->
      // 补齐 lead 点名的 7 条禁用位（fixture 只含其中 2 条，这里补全以便逐条断言）。
      // 注意 trimMargin 的 `|` 必须**紧贴**内容，否则会留下前导空格，
      // 于是断言里的 "- id: x\n  disabled: true" 匹配不上（缩进多一格）。
      clean + listOf(
        "open-in-app",
        "ui-open-in-app",
        "agent-default-model",
        "directory-picker",
        "office-to-pdf",
      ).joinToString("") { "- id: " + it + "\n  disabled: true\n" }
    }
    val after = filterWithProductManifest(before)
    for (id in listOf(
      "bash-sandbox",
      "open-in-app",
      "ui-open-in-app",
      "client-hmr",
      "agent-default-model",
      "directory-picker",
      "office-to-pdf",
    )) {
      assertTrue("禁用位必须保留：- id: " + id + " disabled: true", after.contains("- id: " + id + "\n  disabled: true"))
    }
  }
}
