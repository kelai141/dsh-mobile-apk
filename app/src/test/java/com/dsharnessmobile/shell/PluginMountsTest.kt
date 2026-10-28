package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 清单式回滚的纯逻辑回归（2026-09-21 用户拍板的设计）。
 *
 * 用户口径：「如果用户装了很多插件，整份回滚可能会全部丢失……采用清单式：随版本更新的硬清单强制保留，
 * 启动后校验出的软清单记录当前可用状态；哪个插件崩溃了，把那个插件拔掉就行，不影响其他插件的状态。」
 *
 * 因此本文件守的三件事：① 能从挂载清单里**认全**插件名（含上游与用户条目）；② 拔除**只删那一块**，
 * 其余条目与文档注释一字不动；③ 能**精确点名**引擎报错的那个插件（点名不出就不许动配置）。
 *
 * 固件取自设备实读的 `profiles/web/cordis.patch.yml`（MuMu x86_64 / 0.14.1-SN-1-17）形态。
 */
class PluginMountsTest {

  @Test
  fun hardSelectorRejectsUnknownAndIncompatibleTransactionMarkers() {
    val base = SnapshotTransaction.Marker(SnapshotTransaction.Phase.STAGED, "a".repeat(64), 1L)
    assertTrue(PluginMounts.transactionMarkerAllowsHard(base))
    assertTrue(PluginMounts.transactionMarkerAllowsHard(base.copy(purpose = SnapshotTransaction.Purpose.ONLINE_UPDATE)))
    assertFalse(PluginMounts.transactionMarkerAllowsHard(base.copy(phase = SnapshotTransaction.Phase.UNKNOWN)))
    assertFalse(PluginMounts.transactionMarkerAllowsHard(base.copy(purpose = SnapshotTransaction.Purpose.UNKNOWN)))
    assertFalse(PluginMounts.transactionMarkerAllowsHard(base.copy(phase = SnapshotTransaction.Phase.ONLINE_COMMITTED)))
  }

  @Test
  fun 在线Hard来源只用验证usr组合加嵌入profile并拒绝缺basepatch() {
    val root = Files.createTempDirectory("online-hard-").toFile()
    try {
      val base = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml")
      val web = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml")
      val archiveProfile = File(root, "home/.dsh/profiles/web/cordis.patch.yml")
      base.parentFile.mkdirs(); web.parentFile.mkdirs()
      archiveProfile.parentFile.mkdirs()
      base.writeText("- insert:\n  - id: base-v2\n    name: '@vendor/base-v2'\n")
      web.writeText("- insert:\n  - id: web-v2\n    name: '@vendor/web-v2'\n")
      archiveProfile.writeText("- insert:\n  - id: archive-profile\n    name: '@vendor/archive-profile'\n")
      File(archiveProfile.parentFile, "package.json").writeText("{\"dsh\":{\"profile\":{\"bundles\":[]}}}")
      val profile = setOf(PluginMounts.HardEntry("profile-shell", "@dsh-android/shell"))
      val entries = PluginMounts.onlineHardEntries(root, profile)
      assertEquals(setOf(
        PluginMounts.HardEntry("profile-shell", "@dsh-android/shell"),
        PluginMounts.HardEntry("base-v2", "@vendor/base-v2"),
        PluginMounts.HardEntry("web-v2", "@vendor/web-v2"),
        PluginMounts.HardEntry("archive-profile", "@vendor/archive-profile"),
      ), entries)
      assertFalse("上一在线sidecar中已移除的profile身份不得混入新归档清单",
        entries!!.contains(PluginMounts.HardEntry("retired-online-plugin", "@vendor/retired-online-plugin")))
      archiveProfile.delete()
      File(root, "home").deleteRecursively()
      assertEquals("usr-only旧包回退到APK可信profile identities", setOf(
        PluginMounts.HardEntry("profile-shell", "@dsh-android/shell"),
        PluginMounts.HardEntry("base-v2", "@vendor/base-v2"),
        PluginMounts.HardEntry("web-v2", "@vendor/web-v2"),
      ), PluginMounts.onlineHardEntries(root, profile))
      File(root, "home").mkdirs()
      assertNull("full archive含home却缺factory profile时失败关闭", PluginMounts.onlineHardEntries(root, profile))
      archiveProfile.parentFile.mkdirs()
      archiveProfile.writeText("- insert:\n  - id: profile-shell\n    name: '@vendor/conflicting-name'\n")
      assertNull("同id不同name冲突时拒绝扩大Hard集合", PluginMounts.onlineHardEntries(root, profile))
      archiveProfile.parentFile.mkdirs()
      archiveProfile.writeText("- insert:\n  - name: '@vendor/malformed'\n")
      assertNull("存在但无法证明精确id的归档profile不得静默退回", PluginMounts.onlineHardEntries(root, profile))
      File(root, "home").deleteRecursively()
      val danglingHome = File(root, "home").toPath()
      val symlinkCreated = runCatching { Files.createSymbolicLink(danglingHome, File(root, "missing-home").toPath()) }.isSuccess
      if (symlinkCreated) {
        assertNull("dangling home symlink仍表示归档提供了home入口，不能降级成usr-only", PluginMounts.onlineHardEntries(root, profile))
        Files.deleteIfExists(danglingHome)
      }
      web.delete()
      assertNull("缺失任一verified bundle来源时不产出partial Hard清单", PluginMounts.onlineHardEntries(root, profile))
      assertNull("profile来源缺失时不伪造完整ownership", PluginMounts.onlineHardEntries(root, emptySet()))
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun factoryBundleIdentityRequiresExactPackageAndOrderedPatchBytes() {
    val root = Files.createTempDirectory("factory-bundle-").toFile()
    try {
      val pkg = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@vendor/factory")
      pkg.mkdirs()
      File(pkg, "package.json").writeText("""{"name":"@vendor/factory","version":"1.2.3","dsh":{"bundle":{"patch":["patches/a.yml","patches/b.yml"]}}}""")
      File(pkg, "patches").mkdirs()
      File(pkg, "patches/a.yml").writeText("first patch\n")
      File(pkg, "patches/b.yml").writeText("second patch\n")
      val bundle = PluginMounts.onlineFactoryBundles(root, setOf("@vendor/factory"))!!.single()
      assertEquals("1.2.3", bundle.version)
      assertEquals("bdcb30e4206cb3058c8f762907fa3044b95374d9dcc988c353e824e54f0db709", bundle.patchSha256)
      File(pkg, "package.json").writeText("""{"name":"@vendor/impostor","version":"1.2.3","dsh":{"bundle":{"patch":"patches/a.yml"}}}""")
      assertNull("selected name must match package's own identity", PluginMounts.onlineFactoryBundles(root, setOf("@vendor/factory")))
    } finally { root.deleteRecursively() }
  }

  @Test
  fun hardBundleRepairAddsOnlyTrustedFactoryBundlesAndPreservesUserProfileState() {
    val root = Files.createTempDirectory("hard-bundle-repair-").toFile()
    try {
      val modules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val base = writeFactoryBundle(modules, "@deepseek-ai/dsh-base", "base patch\n")
      val web = writeFactoryBundle(modules, "@deepseek-ai/dsh-web-app", "web patch\n")
      val profile = File(root, "home/.dsh/profiles/web/package.json")
      profile.parentFile.mkdirs()
      profile.writeText(
        """{"name":"dsh-profile-web","dependencies":{"@user/pinned":"7.3.1"},"dsh":{"profile":{"bundles":["@user/soft-plugin"],"future":{"keep":true}}},"futureRoot":{"value":"preserve"}}""",
      )
      val hard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(base, web))

      val repaired = PluginMounts.ensureHardBundlesSelected(profile, modules, hard)
      assertNull(repaired.failure)
      assertTrue(repaired.changed)
      val parsed = JSONObject(profile.readText())
      val profileConfig = parsed.getJSONObject("dsh").getJSONObject("profile")
      val selected = profileConfig.getJSONArray("bundles")
      assertEquals(
        listOf("@user/soft-plugin", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"),
        (0 until selected.length()).map { selected.getString(it) },
      )
      assertEquals("7.3.1", parsed.getJSONObject("dependencies").getString("@user/pinned"))
      assertTrue(profileConfig.getJSONObject("future").getBoolean("keep"))
      assertEquals("preserve", parsed.getJSONObject("futureRoot").getString("value"))
      val bytesAfterFirstRepair = profile.readBytes()

      val second = PluginMounts.ensureHardBundlesSelected(profile, modules, hard)
      assertNull(second.failure)
      assertFalse(second.changed)
      assertTrue(bytesAfterFirstRepair.contentEquals(profile.readBytes()))
    } finally { root.deleteRecursively() }
  }

  @Test
  fun hardBundleRepairRejectsMalformedOrAmbiguousProfileWithoutWriting() {
    val root = Files.createTempDirectory("hard-bundle-repair-invalid-").toFile()
    try {
      val modules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val factory = writeFactoryBundle(modules, "@deepseek-ai/dsh-base", "base patch\n")
      val profile = File(root, "home/.dsh/profiles/web/package.json")
      profile.parentFile.mkdirs()
      val hard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(factory))

      val malformed = "{not-json"
      profile.writeText(malformed)
      assertNotNull(PluginMounts.ensureHardBundlesSelected(profile, modules, hard).failure)
      assertEquals(malformed, profile.readText())

      val ambiguous = """{"dsh.profile.bundles":["@user/soft"],"dsh":{"profile":{"bundles":["@another/soft"]}}}"""
      profile.writeText(ambiguous)
      assertNotNull(PluginMounts.ensureHardBundlesSelected(profile, modules, hard).failure)
      assertEquals(ambiguous, profile.readText())
    } finally { root.deleteRecursively() }
  }

  @Test
  fun hardBundleRepairReportsInstalledIdentityMismatchWithoutBlockingManualRepair() {
    val root = Files.createTempDirectory("hard-bundle-repair-identity-").toFile()
    try {
      val modules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val actual = writeFactoryBundle(modules, "@deepseek-ai/dsh-base", "base patch\n")
      val profile = File(root, "home/.dsh/profiles/web/package.json")
      profile.parentFile.mkdirs()
      val original = """{"dsh":{"profile":{"bundles":["@user/soft"]}},"custom":true}"""
      profile.writeText(original)
      val wrongHash = actual.copy(patchSha256 = "0".repeat(64))
      val hard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(wrongHash))

      val drift = PluginMounts.ensureHardBundlesSelected(profile, modules, hard)
      assertNull(drift.failure)
      assertFalse(drift.changed)
      assertTrue(drift.warnings.single().contains("expectedPatchSha256=" + wrongHash.patchSha256))
      assertTrue(drift.warnings.single().contains("actualPatchSha256=" + actual.patchSha256))
      assertEquals(original, profile.readText())

      val wrongNameIdentity = actual.copy(name = "@deepseek-ai/impostor")
      val mismatchedHard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(wrongNameIdentity))
      val missing = PluginMounts.ensureHardBundlesSelected(profile, modules, mismatchedHard)
      assertNull(missing.failure)
      assertTrue(missing.warnings.single().contains("actualVersion=unavailable"))
      assertEquals(original, profile.readText())
    } finally { root.deleteRecursively() }
  }

  @Test
  fun selectedManuallyRepairedBundleIsPreservedAndNotPromotedToHard() {
    val root = Files.createTempDirectory("hard-bundle-manual-").toFile()
    try {
      val modules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val originalIdentity = writeFactoryBundle(modules, "@deepseek-ai/dsh-base", "factory patch\n")
      val profile = File(root, "home/.dsh/profiles/web/package.json")
      profile.parentFile.mkdirs()
      val original = """{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@user/soft"]}}}"""
      profile.writeText(original)
      File(modules, originalIdentity.name + "/cordis.patch.yml").writeText("manually repaired patch\n")
      val hard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(originalIdentity))
      val result = PluginMounts.ensureHardBundlesSelected(profile, modules, hard)
      assertNull(result.failure)
      assertFalse(result.changed)
      assertEquals(original, profile.readText())
      assertEquals(setOf(originalIdentity), hard.factoryBundles)
      assertTrue(result.warnings.single().contains("not added or trusted as Hard"))
    } finally { root.deleteRecursively() }
  }

  @Test
  fun driftedBundleDoesNotPreventRepairOfAnotherExactlyVerifiedMissingBundle() {
    val root = Files.createTempDirectory("hard-bundle-partial-").toFile()
    try {
      val modules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val base = writeFactoryBundle(modules, "@deepseek-ai/dsh-base", "base patch\n")
      val web = writeFactoryBundle(modules, "@deepseek-ai/dsh-web-app", "web patch\n")
      File(modules, base.name + "/cordis.patch.yml").writeText("repaired base patch\n")
      val profile = File(root, "home/.dsh/profiles/web/package.json")
      profile.parentFile.mkdirs()
      profile.writeText("""{"dsh":{"profile":{"bundles":["@user/soft"]}}}""")
      val hard = PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = setOf(base, web))
      val result = PluginMounts.ensureHardBundlesSelected(profile, modules, hard)
      assertNull(result.failure)
      assertTrue(result.changed)
      assertEquals(1, result.warnings.size)
      val selected = JSONObject(profile.readText()).getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
      assertEquals(listOf("@user/soft", web.name), (0 until selected.length()).map { selected.getString(it) })
    } finally { root.deleteRecursively() }
  }

  private fun writeFactoryBundle(modules: File, name: String, patchText: String): PluginMounts.FactoryBundle {
    val dir = File(modules, name)
    dir.mkdirs()
    File(dir, "package.json").writeText(
      """{"name":"$name","version":"1.2.3","dsh":{"bundle":{"patch":"cordis.patch.yml"}}}""",
    )
    File(dir, "cordis.patch.yml").writeText(patchText)
    val snapshotRoot = modules.parentFile.parentFile.parentFile.parentFile.parentFile.parentFile
    return requireNotNull(PluginMounts.onlineFactoryBundles(snapshotRoot, setOf(name))?.singleOrNull())
  }

  @Test
  fun 自动隔离保留原插件块和未知配置并追加禁用override() {
    val original = "- insert:\n  - id: user-probe\n    name: '@deepseek-ai/user-probe'\n    config:\n      customField: keep-me\n- id: user-probe\n  disabled: false\n"
    val isolated = PluginMounts.quarantineEntry(original, PluginMounts.FailedEntry("user-probe", "@deepseek-ai/user-probe"))
    assertNotNull(isolated)
    assertTrue(isolated!!.startsWith(original))
    assertTrue(isolated.contains("customField: keep-me"))
    assertTrue(isolated.endsWith("# dsh-mobile-quarantine-v1 reason=loader-failure\n- id: \"user-probe\"\n  name: \"@deepseek-ai/user-probe\"\n  disabled: true\n"))
    assertEquals("重复隔离保持幂等", isolated, PluginMounts.quarantineEntry(isolated, PluginMounts.FailedEntry("user-probe", "@deepseek-ai/user-probe")))
  }

  @Test
  fun 自动隔离拒绝只命中顶层覆盖或歧义条目() {
    val topLevelOnly = "- id: user-probe\n  name: '@deepseek-ai/user-probe'\n"
    assertNull(PluginMounts.quarantineEntry(topLevelOnly, PluginMounts.FailedEntry("user-probe", "@deepseek-ai/user-probe")))
    val ambiguous = "- insert:\n  - id: user-probe\n    name: '@deepseek-ai/user-probe'\n- insert:\n  - id: user-probe\n    name: '@deepseek-ai/user-probe'\n"
    assertNull(PluginMounts.quarantineEntry(ambiguous, PluginMounts.FailedEntry("user-probe", "@deepseek-ai/user-probe")))
  }

  /** 设备实读形状的缩略固件：含我们的、上游的、用户的条目 + 块内注释 + 空 insert 残留。 */
  private val fixture = """
    # 顶层说明注释：属于它后面紧邻的那个条目，拔别的块时不得被误删。
    - insert:
        - id: shell-termux
          name: '@dsh-android/dsh-shell-termux'
          config:
            # 块内注释：随本块一起删除
            writeMode: workspace-write
    - insert:
        - id: dsh-undo-savepoint
          name: dsh-undo-savepoint
    # 插件市场（用户装的）
    - insert:
        - id: dshmarketplace
          name: dshmarketplace-plugin
    - id: open-in-app
      disabled: true
    - insert:
        - id: android-bridge
          name: '@dsh-android/dsh-android-bridge'
    - insert:
        - id: agent-default-model-mobile
          name: '@deepseek-ai/dsh-agent-default-model'
    - insert:
    # 0.14.1：已摘除 dsh-model-sync（升级迁移自动清理；本行由 SnapshotTransaction 写入）
  """.trimIndent()

  @Test
  fun 挂载清单必须认全三类条目() {
    val names = PluginMounts.mountedNames(fixture)
    assertTrue("必须是五条 name（id/disabled 行不算）", names.size == 5)
    assertTrue("我们的（带 scope）", names.contains("@dsh-android/dsh-android-bridge"))
    assertTrue("我们的（无 scope，所以前缀区分不了）", names.contains("dsh-undo-savepoint"))
    assertTrue("上游的", names.contains("@deepseek-ai/dsh-agent-default-model"))
    assertTrue("用户装的", names.contains("dshmarketplace-plugin"))
    assertFalse("引号必须剥掉", names.any { it.contains("'") })
    assertFalse("id 行不得当成插件名", names.contains("open-in-app"))
  }

  @Test
  fun 拔除只删那一块且不动别人的块与注释() {
    val after = PluginMounts.removeEntry(fixture, "dshmarketplace-plugin", "dshmarketplace")
    assertNotNull(after)
    val text = after!!
    assertFalse("目标块必须消失", text.contains("dshmarketplace"))
    assertTrue("别的条目一条不少", PluginMounts.mountedNames(text).containsAll(
      listOf("@dsh-android/dsh-shell-termux", "dsh-undo-savepoint", "@dsh-android/dsh-android-bridge", "@deepseek-ai/dsh-agent-default-model"),
    ))
    assertTrue("顶层说明注释不得被误删（它属于后面的块）", text.contains("顶层说明注释"))
    assertTrue("disabled 条目不得受影响", text.contains("disabled: true"))
    assertTrue("空 insert 残留不得受影响", text.contains("# 0.14.1：已摘除 dsh-model-sync"))
    // 只删了它自己：条目数 5 -> 4
    assertEquals(4, PluginMounts.mountedNames(text).size)
  }

  @Test
  fun 块内缩进注释随块删除_顶层注释保留() {
    // 这一条专门钉「注释边界」：块**内**的缩进注释属于该块（随之删除），
    // 块**前**的列 0 注释属于后面那个条目（必须保留，否则会把下一块的文档吃掉）。
    val after = PluginMounts.removeEntry(fixture, "@dsh-android/dsh-shell-termux", "shell-termux")!!
    assertFalse("块内缩进注释必须随块删除", after.contains("块内注释"))
    assertTrue("顶层说明注释必须保留", after.contains("顶层说明注释"))
    assertTrue("同块内的配置字段一并删除", !after.contains("writeMode"))
    assertTrue("其它条目不受影响", after.contains("dshmarketplace-plugin") && after.contains("@dsh-android/dsh-android-bridge"))
    assertEquals(4, PluginMounts.mountedNames(after).size)
  }

  @Test
  fun 拔我们自己的条目也走同一条路() {
    // 硬清单保护发生在调用方（UndoGate 先查 hard 集合）；本函数只管「按名拔块」这一动作。
    val after = PluginMounts.removeEntry(fixture, "@dsh-android/dsh-android-bridge", "android-bridge")
    assertNotNull(after)
    assertFalse(after!!.contains("dsh-android-bridge"))
    assertTrue(after.contains("dshmarketplace-plugin"))
  }

  @Test
  fun 点不出名或定位不到时必须什么都不做() {
    assertNull("名字不在清单里 → null（调用方据此拒绝回滚）", PluginMounts.removeEntry(fixture, "@x/not-there", null))
    assertNull("名与 id 都为空 → null", PluginMounts.removeEntry(fixture, null, null))
    assertNull("空文本 → null", PluginMounts.removeEntry("", "a", null))
    // 只有 name、没有 id 时也能拔（日志里名字最可靠）
    val renamed = fixture.replace("- id: android-bridge", "- id: something-else")
    assertNotNull(PluginMounts.removeEntry(renamed, "@dsh-android/dsh-android-bridge", null))
  }

  @Test
  fun 引擎报错必须能精确点名插件() {
    // 设备实读原文（files/engine.log.1）
    val line = "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): " +
      "failed to import loader entry dsh-bad-probe (@dsh-android/dsh-bad-probe): INJECTED-BAD-PLUGIN"
    val e = PluginMounts.failedEntryOf(line)
    assertNotNull(e)
    assertEquals("@dsh-android/dsh-bad-probe", e!!.name)
    assertEquals("dsh-bad-probe", e.id)
    // 只有 id 的退化形态（包名解析不出时引擎照样会打这一句）
    val idOnly = PluginMounts.failedEntryOf("... failed to import loader entry dsh-bad-probe ...")
    assertNotNull(idOnly)
    assertNull("包名解析不出时必须为 null（调用方退回按 id 拔）", idOnly!!.name)
    assertEquals("dsh-bad-probe", idOnly.id)
    // 无关日志不得点名
    assertNull(PluginMounts.failedEntryOf("engine listening on 3080\nall plugins mounted"))
  }

  @Test
  fun 指纹必须稳定且随内容变化() {
    val a = PluginMounts.digest(fixture)
    assertEquals("同内容同指纹", a, PluginMounts.digest(fixture))
    assertTrue("内容变化指纹必须变", a != PluginMounts.digest(fixture + "\n# x"))
    assertEquals("sha256 十六进制 64 位", 64, a.length)
  }

  @Test
  fun `Soft digest 需跨两个不同引擎启动并在健康窗口内才转 Stable`() {
    val empty = JSONObject()
    val identities = listOf(PluginMounts.HardEntry("hard-id", "hard"), PluginMounts.HardEntry("soft-id", "soft"))
    val first = PluginMounts.softHealthTransition(empty, "digest-a", identities, 101L, 1_000_000L)
    assertNotNull("首次完整健康只建立 Candidate", first)
    assertFalse(first!!.promoted)
    assertEquals("digest-a", first.state.getString("candidateDigest"))
    assertFalse(first.state.has("stableDigest"))

    assertNull("同一次引擎启动重复探活不得充当 cold boot", PluginMounts.softHealthTransition(
      first.state, "digest-a", identities, 101L, 1_060_000L,
    ))
    val promoted = PluginMounts.softHealthTransition(
      first.state, "digest-a", identities, 202L, 1_060_000L,
    )
    assertNotNull(promoted)
    assertTrue(promoted!!.promoted)
    assertEquals("digest-a", promoted.state.getString("stableDigest"))
    assertEquals(202L, promoted.state.getLong("stableBoot"))
    assertFalse(promoted.state.has("candidateDigest"))
  }

  @Test
  fun `Soft digest 变化或超出窗口时重置 Candidate 且不能误升 Stable`() {
    val previous = JSONObject().put("candidateDigest", "digest-a").put("candidateBoot", 101L).put("candidateAt", 1_000_000L)
    val changed = PluginMounts.softHealthTransition(previous, "digest-b", listOf(PluginMounts.HardEntry("hard-id", "hard"), PluginMounts.HardEntry("new-id", "new")), 202L, 1_060_000L)
    assertNotNull(changed)
    assertFalse(changed!!.promoted)
    assertEquals("digest-b", changed.state.getString("candidateDigest"))
    assertFalse(changed.state.has("stableDigest"))

    val expired = PluginMounts.softHealthTransition(previous, "digest-a", listOf(PluginMounts.HardEntry("hard-id", "hard"), PluginMounts.HardEntry("soft-id", "soft")), 303L, 1_000_000L + 604_800_001L)
    assertNotNull(expired)
    assertFalse(expired!!.promoted)
    assertEquals(303L, expired.state.getLong("candidateBoot"))
    assertFalse(expired.state.has("stableDigest"))
    assertNull("缺完整健康 / 无效 boot 身份不得落盘或推进", PluginMounts.softHealthTransition(previous, "digest-a", listOf(PluginMounts.HardEntry("soft-id", "soft")), 0L, 2_000_000L))
  }

  @Test
  fun `Soft composition digest includes ordered bundle identities and actual patch bytes`() {
    val root = Files.createTempDirectory("soft-composition-").toFile()
    try {
      val profile = File(root, "home/.dsh/profiles/web")
      val patch = File(profile, "cordis.patch.yml")
      patch.parentFile.mkdirs()
      val installModules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      fun writeBundle(modules: File, name: String, version: String, body: String) {
        val pkg = File(modules, name)
        File(pkg, "patch.yml").parentFile.mkdirs()
        File(pkg, "package.json").writeText(
          """{"name":"$name","version":"$version","dsh":{"bundle":{"patch":"./patch.yml"}}}""",
        )
        File(pkg, "patch.yml").writeText(body)
      }
      val firstName = "@vendor/first"
      val secondName = "@vendor/second"
      val firstPatch = "- insert:\n  - id: first-row\n    name: '@vendor/first-row'\n"
      val secondPatch = "- insert:\n  - id: second-row\n    name: '@vendor/second-row'\n"
      writeBundle(installModules, firstName, "1.0.0", firstPatch)
      writeBundle(installModules, secondName, "2.0.0", secondPatch)
      patch.writeText("[]\n")
      fun select(vararg names: String) {
        File(profile, "package.json").writeText(JSONObject().put("dsh", JSONObject().put("profile", JSONObject().put("bundles", org.json.JSONArray(names.toList())))).toString())
      }
      select(firstName)
      val first = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue(first.entries.contains(PluginMounts.HardEntry("first-row", "@vendor/first-row")))
      val firstCandidate = PluginMounts.softHealthTransition(JSONObject(), first.digest, first.entries, 10L, 1_000_000L)!!
      val firstStable = PluginMounts.softHealthTransition(firstCandidate.state, first.digest, first.entries, 11L, 1_060_000L)!!
      assertTrue(firstStable.promoted)

      select(secondName)
      val second = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue("仅改 package.json bundles 已改变有效 composition digest", first.digest != second.digest)
      val secondCandidate = PluginMounts.softHealthTransition(firstStable.state, second.digest, second.entries, 12L, 1_120_000L)!!
      assertFalse("新 bundle composition 不能沿用旧稳定态", secondCandidate.promoted)
      val secondStable = PluginMounts.softHealthTransition(secondCandidate.state, second.digest, second.entries, 13L, 1_180_000L)!!
      assertTrue(secondStable.promoted)

      val current = File(installModules, secondName)
      File(current, "patch.yml").writeText(secondPatch + "# changed bytes\n")
      val changedPatch = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue("只改 bundle patch bytes 也改变 composition digest", changedPatch.digest != second.digest)

      val homePatch = File(profile.parentFile.parentFile, "cordis.patch.yml")
      homePatch.writeText("- insert:\n  - id: home-only-row\n    name: '@vendor/home-only'\n")
      val withHome = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue("只改后置 HOME patch 也改变 composition digest", withHome.digest != changedPatch.digest)
      assertTrue("HOME layer 的有效条目身份参与组合", withHome.entries.contains(PluginMounts.HardEntry("home-only-row", "@vendor/home-only")))
      assertEquals("HOME insert来源独立可定位", listOf(PluginMounts.HardEntry("home-only-row", "@vendor/home-only")), withHome.homeInsertEntries)
      val homeCandidate = PluginMounts.clientPullCandidate(withHome, listOf("home-only-row"),
        PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = emptySet()))!!
      assertEquals(PluginMounts.FailedLayer.HOME, homeCandidate.layer)
      val homeDisabled = PluginMounts.quarantineCompositionEntry(homeCandidate, withHome,
        PluginMounts.HardManifest("a".repeat(64), emptySet(), factoryBundles = emptySet()))
      assertTrue("HOME来源隔离追加在HOME层", homeDisabled!!.indexOf("name: '@vendor/home-only'") < homeDisabled.indexOf("disabled: true"))
      homePatch.writeText("- insert:\n  - id: home-only-row\n    name: '@vendor/home-only'\n# home setting changed\n")
      val changedHomeBytes = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue("HOME override bytes也绑定健康digest", changedHomeBytes.digest != withHome.digest)

      select(firstName, secondName)
      val forward = PluginMounts.compositionSnapshot(patch, installModules)!!
      select(secondName, firstName)
      val reverse = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertTrue("profile bundle order participates in composition digest", forward.digest != reverse.digest)

      File(profile, "package.json").writeText("not-json")
      assertNull("unknown profile package state cannot be treated as healthy composition", PluginMounts.compositionSnapshot(patch, installModules))
    } finally { root.deleteRecursively() }
  }

  @Test
  fun `bundle-origin failure requires unique nonfactory composition identity before Cordis quarantine`() {
    val root = Files.createTempDirectory("bundle-quarantine-").toFile()
    try {
      val profile = File(root, "home/.dsh/profiles/web")
      val patch = File(profile, "cordis.patch.yml")
      patch.parentFile.mkdirs()
      patch.writeText("[]\n")
      val installModules = File(root, "usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
      val bundleName = "@vendor/soft-bundle"
      val bundleDir = File(installModules, bundleName)
      bundleDir.mkdirs()
      File(profile, "package.json").writeText(JSONObject().put("dsh", JSONObject().put("profile", JSONObject().put("bundles", org.json.JSONArray(listOf(bundleName))))).toString())
      val bundlePatch = File(bundleDir, "cordis.patch.yml")
      bundlePatch.writeText("- insert:\n  - id: soft-from-bundle\n    name: '@vendor/soft-entry'\n")
      val originalBundlePatch = bundlePatch.readText()
      File(bundleDir, "package.json").writeText("""{"name":"$bundleName","version":"1.4.0","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}""")
      val composition = PluginMounts.compositionSnapshot(patch, installModules)!!
      val hard = PluginMounts.HardManifest("a".repeat(64), setOf(PluginMounts.HardEntry("product", "@dsh-android/product")), factoryBundles = emptySet())
      val candidate = PluginMounts.clientPullCandidate(composition, listOf("soft-from-bundle"), hard)
      assertNotNull("composition-aware selector finds bundle rows", candidate)
      assertEquals(bundleName, candidate!!.bundleIdentity?.name)
      val bundleCandidate = candidate!!
      assertNull("existing insert-only quarantine correctly cannot find the bundle's source row", PluginMounts.quarantineEntry(patch.readText(), bundleCandidate))
      val isolated = PluginMounts.quarantineCompositionEntry(bundleCandidate, composition, hard)
      assertNotNull(isolated)
      assertTrue(isolated!!.startsWith("# dsh-mobile-quarantine-v1"))
      assertTrue(isolated.contains("# dsh-mobile-quarantine-v1 reason=loader-failure\n- id: \"soft-from-bundle\"\n  name: \"@vendor/soft-entry\"\n  disabled: true\n"))
      bundlePatch.writeText(bundlePatch.readText() + "# changed\n")
      val changedComposition = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertNull("an old failed candidate cannot quarantine after its bundle patch changed", PluginMounts.quarantineCompositionEntry(
        bundleCandidate, changedComposition, hard,
      ))
      assertNull("unknown legacy factory tuple cannot prove bundle ownership safely", PluginMounts.quarantineCompositionEntry(
        bundleCandidate, composition, hard.copy(factoryBundles = null),
      ))
      val logIdentity = PluginMounts.FailedEntry("soft-from-bundle", "@vendor/soft-entry")
      assertNotNull("loader log identity is mapped to the current unique bundle row, not trusted as ownership",
        PluginMounts.quarantineCompositionEntry(logIdentity, composition, hard))

      bundlePatch.writeText(bundlePatch.readText() + "- insert:\n  - id: soft-from-bundle\n    name: '@vendor/soft-entry'\n")
      val duplicateComposition = PluginMounts.compositionSnapshot(patch, installModules)!!
      assertNull("duplicate actual import rows are ambiguous even when they share one bundle identity",
        PluginMounts.quarantineCompositionEntry(logIdentity, duplicateComposition, hard))
      bundlePatch.writeText(originalBundlePatch)

      val homePatch = composition.homePatch
      val manualDisable = "- id: soft-from-bundle\n  name: '@vendor/soft-entry'\n  disabled: true\n"
      homePatch.writeText(manualDisable)
      val manualComposition = PluginMounts.compositionSnapshot(patch, installModules)!!
      val manualCandidate = PluginMounts.clientPullCandidate(manualComposition, listOf("soft-from-bundle"), hard)!!
      assertEquals("已有普通disabled:true已禁用即可，但不伪造quarantine marker", manualDisable,
        PluginMounts.quarantineCompositionEntry(manualCandidate, manualComposition, hard))

      homePatch.writeText(
        "- id: soft-from-bundle\n  name: '@vendor/soft-entry'\n  disabled: true\n" +
          "- id: soft-from-bundle\n  name: '@vendor/soft-entry'\n  disabled: false\n",
      )
      val withHomeOverride = PluginMounts.compositionSnapshot(patch, installModules)!!
      val overrideCandidate = PluginMounts.clientPullCandidate(withHomeOverride, listOf("soft-from-bundle"), hard)
      assertNotNull("later HOME config override is not a second loader source", overrideCandidate)
      val overrideQuarantine = PluginMounts.quarantineCompositionEntry(overrideCandidate!!, withHomeOverride, hard)
      assertTrue("稍早disabled:true不能压过后来的disabled:false；隔离必须追加末尾true",
        overrideQuarantine!!.lastIndexOf("disabled: false") < overrideQuarantine.lastIndexOf("disabled: true"))
      assertTrue("重新解析后，末尾有效隔离保持幂等", run {
        homePatch.writeText(overrideQuarantine)
        val quarantinedComposition = PluginMounts.compositionSnapshot(patch, installModules)!!
        PluginMounts.quarantineCompositionEntry(
          PluginMounts.clientPullCandidate(quarantinedComposition, listOf("soft-from-bundle"), hard)!!,
          quarantinedComposition,
          hard,
        ) == overrideQuarantine
      })

      homePatch.writeText(
        "- id: soft-from-bundle\n  name: '@vendor/soft-entry'\n  disabled: true\n" +
          "- id: soft-from-bundle\n  name: '@vendor/soft-entry'\n  disabled: unknown\n",
      )
      val unknownComposition = PluginMounts.compositionSnapshot(patch, installModules)!!
      val unknownCandidate = PluginMounts.clientPullCandidate(unknownComposition, listOf("soft-from-bundle"), hard)!!
      val unknownQuarantine = PluginMounts.quarantineCompositionEntry(unknownCandidate, unknownComposition, hard)
      assertTrue("无法解析的disabled状态不得视为已隔离", unknownQuarantine!!.contains("dsh-mobile-quarantine-v1"))
      homePatch.writeText("[]\n")
      val current = PluginMounts.compositionSnapshot(patch, installModules)!!
      val currentCandidate = PluginMounts.clientPullCandidate(current, listOf("soft-from-bundle"), hard)!!
      val homeQuarantine = PluginMounts.quarantineCompositionEntry(currentCandidate, current, hard)
      assertNotNull("bundle failure is quarantined at the highest persistent HOME layer", homeQuarantine)
      assertTrue(homeQuarantine!!.contains("disabled: true"))
      assertTrue(homeQuarantine.startsWith("[]\n# dsh-mobile-quarantine-v1"))
      assertNull("a caller cannot fabricate bundle provenance without the resolver tuple", PluginMounts.quarantineCompositionEntry(
        currentCandidate.copy(bundleIdentity = null), current, hard,
      ))
      assertNull("old schema cannot prove a bundle candidate is nonfactory", PluginMounts.quarantineCompositionEntry(
        currentCandidate, current, hard.copy(factoryBundles = null),
      ))
    } finally { root.deleteRecursively() }
  }

  @Test
  fun `自动隔离与用户手动禁用有不同可诊断状态`() {
    val original = "- insert:\n  - id: plugin-a\n    name: plugin-a\n    config:\n      unknown: keep\n- id: plugin-b\n  name: plugin-b\n  disabled: true\n"
    val quarantined = PluginMounts.quarantineEntry(original, PluginMounts.FailedEntry("plugin-a", "plugin-a"))!!
    assertTrue("原用户配置必须保留", quarantined.contains("unknown: keep"))
    assertTrue("隔离 marker 必须可读", quarantined.contains("dsh-mobile-quarantine-v1"))
    assertTrue("手动禁用 override 仍保留", quarantined.contains("plugin-b"))
    val entry = PluginMounts.HardEntry("plugin-a", "plugin-a")
    val stable = setOf(entry)
    assertEquals(PluginMounts.SoftEntryState.QUARANTINED, PluginMounts.classifySoftEntry(entry, stable, disabled = true, quarantined = true))
    assertEquals(PluginMounts.SoftEntryState.DISABLED, PluginMounts.classifySoftEntry(entry, stable, disabled = true, quarantined = false))
    assertEquals(PluginMounts.SoftEntryState.STABLE, PluginMounts.classifySoftEntry(entry, stable, disabled = false, quarantined = false))
    assertEquals(PluginMounts.SoftEntryState.CANDIDATE, PluginMounts.classifySoftEntry(entry, emptySet(), disabled = false, quarantined = false))
  }

  // ── 0.14.2 D12：显示名不得进入插件集合 ────────────────────────────────

  /** 设备实读形态的 llm-pi-ai 条目：36 个模型显示名，一个都不得进条目名集合。 */
  private val displayNameFixture = """
    - id: llm-pi-ai
      name: "@deepseek-ai/dsh-llm-pi-ai"
      config:
        providers:
          opencode-go:
            models:
              - id: mimo-v2.5
                name: MiMo 2.5
              - id: glm-5.3
                name: GLM-5.3
          xiaomi-token-plan-cn:
            models:
              - id: mimo-v2.5
                name: MiMo-V2.5
    - insert:
        - id: android-manage
          name: '@dsh-android/dsh-android-manage'
    - id: ui-theme
      name: "@deepseek-ai/dsh-client-ui-theme"
      config:
        preference: dark
  """.trimIndent() + "\n"

  @Test
  fun 模型显示名不得进入插件条目名集合() {
    val entries = PluginMounts.entryNames(displayNameFixture)
    assertEquals(
      "只认 - name: 条目（顶层 + insert 子条目）",
      listOf("@deepseek-ai/dsh-llm-pi-ai", "@dsh-android/dsh-android-manage", "@deepseek-ai/dsh-client-ui-theme"),
      entries,
    )
    assertFalse("模型显示名不是插件名", entries.contains("MiMo 2.5"))
    assertFalse(entries.contains("GLM-5.3"))
    assertFalse(entries.contains("MiMo-V2.5"))
    // 宽松口径仍然认得出它们（兼容展示/诊断用途，但不得用于「插件在不在场」判定）
    assertTrue(PluginMounts.mountedNames(displayNameFixture).contains("GLM-5.3"))
  }

  @Test
  fun 必需插件判定用条目名且能抓出缺席() {
    val required = listOf("@dsh-android/dsh-android-manage", "@dsh-android/dsh-android-bridge")
    val missing = PluginMounts.missingRequired(displayNameFixture, required)
    assertEquals("bridge 不在场", listOf("@dsh-android/dsh-android-bridge"), missing)
    assertTrue(PluginMounts.missingRequired(displayNameFixture, listOf("@dsh-android/dsh-android-manage")).isEmpty())
    assertTrue("显示名不得伪造在场", PluginMounts.missingRequired(displayNameFixture, listOf("GLM-5.3")).isNotEmpty())
  }

  // ── 0.14.2 D11：摘除只作用于目标条目，不连坐 ──────────────────────────

  /**
   * D11 反证：两个子条目同处一个 \`- insert:\` 组时，摘除其中一个**不得**连带删掉另一个。
   * 旧实现按「缩进区间里还有没有兄弟」判定，误判即整组消失（同组里我们自己的硬清单插件一起没了）。
   */
  @Test
  fun 同组摘除不得连坐删除兄弟条目() {
    val two = """
      - id: bash-sandbox
        disabled: true
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
          - id: host-web-compat
            name: '@dsh-android/dsh-host-web-compat'
      - id: open-in-app
        disabled: true
    """.trimIndent() + "\n"

    val after = PluginMounts.removeEntry(two, "@dsh-android/dsh-host-web-compat", "host-web-compat")

    assertNotNull(after)
    assertFalse("目标条目必须消失", after!!.contains("host-web-compat"))
    assertTrue("同组兄弟必须一字不动（D11）", after.contains("shell-termux"))
    assertTrue("组包装行必须保留（还剩一个子条目）", after.contains("- insert:"))
    assertTrue(after.contains("bash-sandbox") && after.contains("open-in-app"))
    assertEquals(listOf("@dsh-android/dsh-shell-termux"), PluginMounts.entryNames(after))
  }

  /** 摘掉组内**最后一个**子条目时，\`- insert:\` 空壳必须一并清理（YAML 里它是 null 条目）。 */
  @Test
  fun 摘除组内最后一条时清掉空壳() {
    val one = """
      - insert:
          - id: only-child
            name: 'some-plugin'
      - id: keep-me
        disabled: true
    """.trimIndent() + "\n"

    val after = PluginMounts.removeEntry(one, "some-plugin", "only-child")

    assertNotNull(after)
    assertFalse("空壳 - insert: 必须消失", after!!.contains("- insert:"))
    assertFalse(after.contains("only-child"))
    assertTrue(after.contains("keep-me"))
  }

  @Test
  fun 必需进场集合与缺失集合互补() {
    val required = listOf("@dsh-android/dsh-android-manage", "@dsh-android/dsh-android-bridge", "GLM-5.3")
    val present = PluginMounts.requiredPresent(displayNameFixture, required)
    val missing = PluginMounts.missingRequired(displayNameFixture, required)
    assertEquals(setOf("@dsh-android/dsh-android-manage"), present)
    assertEquals(listOf("@dsh-android/dsh-android-bridge", "GLM-5.3"), missing)
    assertEquals("两口径必须互补", required.toSet(), present + missing.toSet())
  }

  // ── 0.14.5 S-1：空壳收尾的**唯一实现**（两条恢复写路径共用）────────────────────

  /** 壳侧源码（工作目录随 gradle 调用方式而变，两种布局都试）。 */
  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 " + name + "（工作目录 = " + File(".").absolutePath + "）")
    return f.readText()
  }

  /** 去掉注释行（函数名出现在注释里不算命中——与仓内 grep 门禁同口径）。 */
  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  /**
   * S-1 反证：`dropEmptyInsertWrappers` 只允许有**一份**实现，且快照事务侧必须调用它。
   *
   * 为什么这条断言必须落在**源码结构**上而不是行为上：两份实现在 0.14.5 之前**逐字节等价**，
   * 任何行为用例都会同时被两份实现满足 —— 也就是说「重复实现」这个缺陷在行为面**不可观测**，
   * 它只在将来某一份被单独修改时才变成可观测的语义分裂（同一份清单经两条恢复路径得到两种结果，
   * 其中一条是安全敏感的快照事务写路径）。因此判据只能是「定义唯一 + 调用点在场」。
   *
   * 三条都要能变红：
   * ① 把实现复制回 SnapshotTransaction.kt（private 副本）→ 定义计数变 2 → 第一条红；
   * ② 删掉 PluginMounts 侧的 internal 实现 → 定义计数变 0 → 第一条红；
   * ③ 把 `PluginMounts.dropEmptyInsertWrappers(kept)` 改回本地调用 → 第二条红。
   */
  @Test
  fun 空壳清理必须是两条恢复路径共用的唯一实现() {
    val mounts = codeOnly(source("PluginMounts.kt"))
    val tx = codeOnly(source("SnapshotTransaction.kt"))

    val definitions = listOf(
      Regex("""fun\s+dropEmptyInsertWrappers\s*\(\s*lines""").findAll(mounts).count(),
      Regex("""fun\s+dropEmptyInsertWrappers\s*\(\s*lines""").findAll(tx).count(),
    ).sum()
    assertEquals(
      "dropEmptyInsertWrappers 必须全仓只有一份实现（重复实现的行为差在快照事务写路径上不可观测，" +
        "只能用结构判据钉住）：PluginMounts=" + definitions,
      1, definitions,
    )
    assertTrue(
      "唯一实现必须留在 PluginMounts（快照事务侧不得再自行定义）",
      Regex("""internal fun dropEmptyInsertWrappers""").containsMatchIn(mounts),
    )
    assertTrue(
      "快照事务的已摘除插件迁移必须调用 PluginMounts 的唯一实现" +
        "（撤掉这次合并 = 该调用消失，本断言即红）",
      tx.contains("PluginMounts.dropEmptyInsertWrappers(kept)"),
    )
  }

  /**
   * 唯一实现的行为契约（两条路径共用同一份，故这一条同时钉住两侧收尾）：
   * 空壳连同其**前后**相邻空行一起摘掉，不留连续空行；非空壳一字不动。
   *
   * 直接调 internal 实现而不是绕 removeEntry：`removeEntry` 的定位正则要求 `- ` 前缀，
   * 表达不出列 0 的 `-`（合法 YAML 空 elem，可出现在 `- insert:` 前），
   * 而设备实读的 patch 就是那种形态。
   */
  @Test
  fun 空壳收尾必须吃掉前后空行且不碰非空壳() {
    val shellThenBlank = mutableListOf(
      "- id: keep-me",
      "  disabled: true",
      "",
      "- insert:",
      "",
      "- id: tail",
    )
    val afterShell = PluginMounts.dropEmptyInsertWrappers(shellThenBlank)
    assertEquals(
      "空壳与其后紧邻空行必须摘掉，其前紧邻空行也不得留下（否则连续空行会累积）",
      listOf("- id: keep-me", "  disabled: true", "- id: tail"),
      afterShell,
    )

    val withChild = mutableListOf("", "- insert:", "    - id: child", "      name: 'p'")
    val afterChild = PluginMounts.dropEmptyInsertWrappers(withChild)
    assertEquals(
      "组内还有子条目时包装行必须保留（误删 = 整组装配消失）",
      listOf("", "- insert:", "    - id: child", "      name: 'p'"),
      afterChild,
    )
  }

  // ---- 2026-10-28 regression: identity matching must ignore nested config fields ----

  @Test
  fun configSubtreeNameDoesNotDeleteAProductEntry() {
    // A product config may contain a name equal to the plugin being removed.
    val patch = listOf(
      "- insert:",
      "    - id: prod-one",
      "      name: '@dsh-android/prod-one'",
      "      config:",
      "        name: evil",
      "    - id: evil",
      "      name: evil",
    ).joinToString("\n") + "\n"
    val out = PluginMounts.removeEntry(patch, "evil", null)
    assertNotNull("The matching third-party entry should be removed", out)
    assertTrue("The product entry must remain: " + out, out!!.contains("- id: prod-one"))
    assertTrue("The product config must remain intact: " + out, out.contains("name: evil"))
    assertFalse("The matching third-party entry should be removed", out.contains("id: evil"))
  }

  @Test
  fun nameAsTheItemFirstKeyStillMatches() {
    // An entry whose first key is name must still match without an id field.
    val patch = listOf(
      "- insert:",
      "    - name: evil-pkg",
      "      config:",
      "        x: 1",
    ).joinToString("\n") + "\n"
    val out = PluginMounts.removeEntry(patch, "evil-pkg", null)
    assertNotNull("An entry with name as its first key should still match", out)
    assertFalse("The matching entry should be removed: " + out, out!!.contains("evil-pkg"))
  }

  @Test
  fun nestedConfigListNameDoesNotDeleteProductConfigEntry() {
    val patch = listOf(
      "- insert:",
      "    - id: product",
      "      name: product-package",
      "      config:",
      "        aliases:",
      "          - name: target",
      "            value: 1",
      "    - id: target",
      "      name: target",
    ).joinToString("\n") + "\n"

    val out = PluginMounts.removeEntry(patch, "target", null)

    assertNotNull("The matching plugin entry should be removed", out)
    assertTrue("The matching nested config item must remain: " + out, out!!.contains("          - name: target"))
    assertFalse("The direct plugin entry should be removed: " + out, out.lines().any { it == "    - id: target" })
  }

  @Test
  fun nestedConfigListIdDoesNotDeleteProductConfigEntry() {
    val patch = listOf(
      "- insert:",
      "    - id: product",
      "      name: product-package",
      "      config:",
      "        mappings:",
      "          - id: target",
      "            value: 1",
      "    - id: target",
      "      name: target-package",
    ).joinToString("\n") + "\n"

    val out = PluginMounts.removeEntry(patch, null, "target")

    assertNotNull("The matching plugin entry should be removed", out)
    assertTrue("The matching nested config item must remain: " + out, out!!.contains("          - id: target"))
    assertFalse("The direct plugin entry should be removed: " + out, out.lines().any { it == "    - id: target" })
  }

  @Test
  fun removingByIdDoesNotDeleteTheFollowingSiblingWhenBothKeysMatch() {
    val patch = listOf(
      "- insert:",
      "    - id: target",
      "      name: target",
      "    - id: keep",
      "      name: keep",
    ).joinToString("\n") + "\n"

    val out = PluginMounts.removeEntry(patch, null, "target")

    assertNotNull("The matching plugin entry should be removed", out)
    assertTrue("The unmatched sibling must remain: " + out, out!!.contains("    - id: keep"))
    assertTrue("The sibling name must remain: " + out, out.contains("      name: keep"))
    assertFalse("The matching entry should be removed: " + out, out.contains("    - id: target"))
  }
}
