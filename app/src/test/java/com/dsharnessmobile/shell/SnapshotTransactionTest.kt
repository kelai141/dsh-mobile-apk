package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotTransactionTest {

  private val preserved = setOf("sessions", "settings.yaml", ".credentials.yaml")

  @Test
  fun activatesFactoryEntriesAndNeverTouchesUserData() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      File(live, "home/.dsh/sessions").mkdirs()
      File(live, "home/.dsh/sessions/s1.jsonl").writeText("session")
      File(live, "home/.dsh/settings.yaml").writeText("user: true\n")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp1",
        startedAt = 1L,
      )

      assertEquals("new-node", File(live, "usr/bin/node").readText())
      assertEquals("new-profile", File(live, "home/.dsh/profiles/web/cordis.yml").readText())
      assertEquals("[user]\n", File(live, "home/.gitconfig").readText())
      assertEquals("user: true\n", File(live, "home/.dsh/settings.yaml").readText())
      assertEquals("session", File(live, "home/.dsh/sessions/s1.jsonl").readText())
      assertEquals(SnapshotTransaction.Phase.SWAPPED, SnapshotTransaction.readMarker(filesDir)?.phase)
      assertEquals("old-node", File(filesDir, ".snapshot-previous/usr/bin/node").readText())

      SnapshotTransaction.finish(filesDir)

      assertFalse(SnapshotFs.exists(SnapshotTransaction.previousRoot(filesDir)))
      assertFalse(SnapshotFs.exists(stage))
      assertNull(SnapshotTransaction.readMarker(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 0.13.8 #167：profiles 分区合并——用户插件生态幸存 + 工厂条目更新，两者同时成立。
   * （live 与 staged 的 .gitconfig / profiles 内容必须不同，否则断言恒真即假绿。）
   */
  @Test
  fun mergesUserProfilesAndKeepsUserGitconfig() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      // 工厂侧 package.json（0.13.8 #167 合并输入）：含一条工厂依赖与工厂 bundles
      File(stage, "home/.dsh/profiles/web/package.json").writeText(
        """{"dependencies":{"@dsh-android/dsh-shell-termux":"0.1.0","@dsh-android/dsh-host-web-compat":"0.1.13"},"dsh.profile.bundles":["@dsh-android/dsh-shell-termux"]}""",
      )

      // 用户生态：第三方依赖 + 用户 pin + 用户 patch 追加块 + .npmrc + 工厂不发行文件
      File(live, "home/.dsh/profiles/web/package.json").writeText(
        """{"dependencies":{"@dsh-android/dsh-shell-termux":"0.1.0","@user/third-party":"1.2.3"},"dsh.profile.bundles":["@user/custom-bundle"]}""",
      )
      File(live, "home/.dsh/profiles/web/cordis.patch.yml").writeText(
        "- id: bash-sandbox\n  disabled: true\n- insert:\n    - id: user-custom\n      name: '@user/plugin'\n",
      )
      File(live, "home/.dsh/profiles/web/.npmrc").writeText("registry=https://registry.npmmirror.com\n")
      File(live, "home/.dsh/profiles/web/node_modules/@user").mkdirs()
      File(live, "home/.dsh/profiles/web/node_modules/@user/plugin.js").writeText("user plugin\n")
      // 用户改过的 .gitconfig（工厂模板 = [user]，live = 模板 + 用户名）
      File(live, "home/.gitconfig").writeText("[user]\n\tname = 用户名\n")

      SnapshotTransaction.swap(
        filesDir, stage, File(live, "usr"), File(live, "home"), preserved, "fp1", 1L,
      )

      val pkg = File(live, "home/.dsh/profiles/web/package.json").readText()
      assertTrue("第三方依赖幸存", pkg.contains("@user/third-party"))
      assertTrue("工厂依赖补入（合并不是保留）", pkg.contains("@dsh-android/dsh-host-web-compat"))
      assertTrue("用户 bundles 幸存", pkg.contains("@user/custom-bundle"))
      val patch = File(live, "home/.dsh/profiles/web/cordis.patch.yml").readText()
      assertTrue("用户追加块幸存", patch.contains("id: user-custom"))
      assertTrue("工厂已有条目不被重复追加", Regex("id: bash-sandbox").findAll(patch).count() == 1)
      assertEquals(".npmrc 幸存", "registry=https://registry.npmmirror.com\n", File(live, "home/.dsh/profiles/web/.npmrc").readText())
      assertEquals(
        "用户 node_modules 幸存", "user plugin\n",
        File(live, "home/.dsh/profiles/web/node_modules/@user/plugin.js").readText(),
      )
      assertTrue(
        "工厂 cordis.yml 更新（混合容器内工厂条目仍升级）",
        File(live, "home/.dsh/profiles/web/cordis.yml").readText() == "new-profile",
      )
      assertTrue("用户 .gitconfig 幸存（#179 seed-if-absent）", File(live, "home/.gitconfig").readText().contains("用户名"))
      assertTrue("工厂 .gitconfig 的新增语义仍保留", File(live, "home/.gitconfig").readText().contains("[user]"))
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /** #167 回滚：合并中断（marker SWAPPING + previous 有备份）→ live profiles 整目录还原。 */
  @Test
  fun rollsBackAMergedProfilesDirectoryFromTheDisplacedCopy() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "old-node", "old-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      writeRuntime(previous, "old-node", "old-profile") // displaced 整目录备份形态
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("home/.dsh/profiles")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "old-fp")

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      assertEquals("old-profile", File(live, "home/.dsh/profiles/web/cordis.yml").readText())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun installsFactoryEntryWhenTheLiveCopyDoesNotExist() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")

      SnapshotTransaction.swap(
        filesDir, stage, File(live, "usr"), File(live, "home"), preserved, "fp1", 1L,
      )

      assertEquals("new-node", File(live, "usr/bin/node").readText())
      assertEquals("factory: true\n", File(live, "home/.dsh/settings.yaml").readText())
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun rollsBackWhenTheProcessDiedBetweenTheTwoRenames() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")
      val previous = SnapshotTransaction.previousRoot(filesDir)
      File(previous, "usr/bin").mkdirs()
      File(previous, "usr/bin/node").writeText("old-node")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "old-fp")

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      assertEquals("old-node", File(live, "usr/bin/node").readText())
      assertNull(SnapshotTransaction.readMarker(filesDir))
      assertFalse(SnapshotFs.exists(previous))
      assertFalse(SnapshotFs.exists(stage))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun rollsBackAfterTheStagedRuntimeWasAlreadyActivated() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "new-node", "new-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      writeRuntime(previous, "old-node", "old-profile")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr", "home/.dsh/profiles")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "old-fp")

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      assertEquals("old-node", File(live, "usr/bin/node").readText())
      assertEquals("old-profile", File(live, "home/.dsh/profiles/web/cordis.yml").readText())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun removesNewlyInstalledEntriesOnRollback() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "new-node", "new-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr")),
      )

      SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "")

      assertFalse(SnapshotFs.exists(File(live, "usr")))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun discardsAStagedRuntimeThatWasNeverActivated() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "old-node", "old-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.STAGED, "fp1", 1L),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "old-fp")

      assertEquals(SnapshotTransaction.Outcome.DISCARDED_STAGE, recovery.outcome)
      assertEquals("old-node", File(live, "usr/bin/node").readText())
      assertFalse(SnapshotFs.exists(stage))
      assertNull(SnapshotTransaction.readMarker(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun rollsForwardWhenOnlyTheFingerprintWriteWasLost() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "new-node", "new-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPED, "fp2", 1L, listOf("usr")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "fp1")

      assertEquals(SnapshotTransaction.Outcome.ROLLED_FORWARD, recovery.outcome)
      assertEquals("fp2", recovery.fingerprintToCommit)
      // The runtime must stay activated: only the commit write is repeated.
      assertEquals("new-node", File(live, "usr/bin/node").readText())
      SnapshotTransaction.finish(filesDir)
      assertNull(SnapshotTransaction.readMarker(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun rollsForwardWhenTheFingerprintAlreadyMatchesTheTarget() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "new-node", "new-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp2", 1L, listOf("usr")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"), "fp2")

      assertEquals(SnapshotTransaction.Outcome.ROLLED_FORWARD, recovery.outcome)
      assertEquals("new-node", File(live, "usr/bin/node").readText())
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun treatsAnUnreadableMarkerAsAnInterruptedSwap() {
    val filesDir = tempDir()
    try {
      SnapshotTransaction.markerFile(filesDir).writeText("phase=NOT_A_PHASE\nfingerprint=\n")

      val marker = SnapshotTransaction.readMarker(filesDir)

      assertEquals(SnapshotTransaction.Phase.SWAPPING, marker?.phase)
      assertTrue(marker!!.moved.isEmpty())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * apk #214 端到端：从「曾禁用 ui-layout」的旧版升级（live profiles 在场 → 走合并而非整树替换）时，
   * 工厂语义必须纠正旧版遗留的 `- id: ui-layout / disabled: true`；否则根服务 layout 不 activate。
   */
  @Test
  fun profileSwapReconcilesLegacyUiLayoutDisable() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val livePatch = File(live, "home/.dsh/profiles/web/cordis.patch.yml")
      livePatch.writeText(LEGACY_UI_LAYOUT_PATCH)
      File(stage, "home/.dsh/profiles/web/cordis.patch.yml").writeText(FACTORY_PATCH)

      val notes = SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp214",
        startedAt = 1L,
      )

      val merged = livePatch.readText()
      assertFalse("旧版遗留的 ui-layout disable 必须被纠正（#214 规格断言）", merged.contains("ui-layout"))
      assertTrue("live 既有工厂块保留", merged.contains("shell-termux"))
      assertTrue("live 缺失的工厂块照旧追加", merged.contains("android-manage"))
      assertTrue("纠正必须留说明（供升级现场追溯）", notes.any { it.contains("ui-layout") })
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 0.14.0 P0：node_modules 子树下的 package.json 是**工厂件**——工厂新增的 exports 必须整份覆盖 live。
   * 现场：@dsh-android/dsh-android-file-open 的 live manifest 缺 "./route-auth"，而快照 tar 内有，
   * 插件跨包 import 直接 ERR_PACKAGE_PATH_NOT_EXPORTED → 引擎 exit=1。根因是把「并集」规则
   * 递归套用到嵌套清单（只并 dependencies/bundles，丢掉 exports/version 等）。
   */
  @Test
  fun nestedNodeModulesManifestFollowsTheFactoryNotTheLiveCopy() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val rel = "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-file-open/package.json"
      File(stage, rel).apply { parentFile.mkdirs() }.writeText(
        """{"name":"file-open","version":"0.2.0","exports":{".":"./lib/index.js","./route-auth":"./lib/route-auth.js"},"dependencies":{"dep":"1.0.0"}}""",
      )
      File(live, rel).apply { parentFile.mkdirs() }.writeText(
        """{"name":"file-open","version":"0.1.0","exports":{".":"./lib/index.js"},"dependencies":{"dep":"1.0.0","userExtra":"9.9.9"}}""",
      )

      SnapshotTransaction.swap(filesDir, stage, File(live, "usr"), File(live, "home"), preserved, "fp1", 1L)

      val nested = File(live, rel).readText()
      assertTrue("工厂新增 exports 必须覆盖 live（P0 根因）", nested.contains("route-auth"))
      assertTrue("工厂 version 必须生效", nested.contains("0.2.0"))
      assertFalse("嵌套清单不得保留 live 独有字段（旧并集语义的残留）", nested.contains("userExtra"))
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /** 同一口径：node_modules 子树下的 cordis.patch.yml 也是工厂件，整份覆盖（不做按 id 追加）。 */
  @Test
  fun nestedCordisPatchYmlFollowsTheFactoryNotTheLiveCopy() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val rel = "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-manage/cordis.patch.yml"
      val factoryPatch = "- id: manage-row\n  disabled: false\n"
      File(stage, rel).apply { parentFile.mkdirs() }.writeText(factoryPatch)
      File(live, rel).apply { parentFile.mkdirs() }.writeText(
        "- id: manage-row\n  disabled: true\n- insert:\n    - id: stale-user-row\n      name: '@user/x'\n",
      )

      SnapshotTransaction.swap(filesDir, stage, File(live, "usr"), File(live, "home"), preserved, "fp1", 1L)

      assertEquals("嵌套 patch 必须与工厂逐字一致", factoryPatch, File(live, rel).readText())
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * profile **根**清单仍走并集（用户 pin 权威），且真实嵌套形态 dsh.profile.bundles 的并集必须生效：
   * 旧实现只读扁键 "dsh.profile.bundles"，而出厂清单是嵌套 dsh.profile.bundles
   * （scripts/lib/profile-seed.mjs:38-42；设备实测同形态）⇒ 真机恒不命中，工厂新增 bundle 进不去。
   */
  @Test
  fun profileRootManifestKeepsUserPinAndUnionsTheNestedFactoryBundles() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val rel = "home/.dsh/profiles/web/package.json"
      File(stage, rel).writeText(
        """{"name":"dsh-profile-web","dependencies":{"@dsh-android/dsh-host-web-compat":"0.1.13"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"],"patchReload":"startup"}}}""",
      )
      File(live, rel).writeText(
        """{"name":"dsh-profile-web","dependencies":{"@user/third-party":"1.2.3"},"dsh":{"profile":{"bundles":["@user/custom-bundle"]}}}""",
      )

      SnapshotTransaction.swap(filesDir, stage, File(live, "usr"), File(live, "home"), preserved, "fp1", 1L)

      val root = org.json.JSONObject(File(live, rel).readText())
      val deps = root.getJSONObject("dependencies")
      assertEquals("用户 pin 权威", "1.2.3", deps.getString("@user/third-party"))
      assertEquals("工厂依赖补入", "0.1.13", deps.getString("@dsh-android/dsh-host-web-compat"))
      val bundles = root.getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
      val list = (0 until bundles.length()).map { bundles.getString(it) }
      assertTrue("工厂新增 bundle 必须补入（真实嵌套键形态）", list.contains("@deepseek-ai/dsh-web-app"))
      assertTrue("工厂既有 bundle 也必须补入", list.contains("@deepseek-ai/dsh-base"))
      assertTrue("用户既有 bundle 必须幸存（不是重建数组）", list.contains("@user/custom-bundle"))
      assertFalse("不得写成引擎不读的扁键", root.has("dsh.profile.bundles"))
      SnapshotTransaction.finish(filesDir)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  private fun writeRuntime(root: File, nodeMarker: String, profileMarker: String) {
    File(root, "usr/bin").mkdirs()
    File(root, "usr/bin/node").writeText(nodeMarker)
    File(root, "home/.dsh/profiles/web").mkdirs()
    File(root, "home/.dsh/profiles/web/cordis.yml").writeText(profileMarker)
    File(root, "home/.dsh/settings.yaml").writeText("factory: true\n")
    File(root, "home/.gitconfig").writeText("[user]\n")
  }

  private fun tempDir(): File = Files.createTempDirectory("snapshot-transaction-test").toFile()

  private companion object {
    /** ≤0.13.6 权威清单形态（docs/archive/M1-PLAN.md:104-105）：ui-layout 被禁用。 */
    val LEGACY_UI_LAYOUT_PATCH = """
      # Android adaptation
      - id: bash-sandbox
        disabled: true
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
      - id: ui-layout
        disabled: true
    """.trimIndent() + "\n"

    /** 0.1.5 起的权威清单形态：ui-layout 不再出现（工厂语义 = 恒启用）。 */
    val FACTORY_PATCH = """
      # Android adaptation
      - id: bash-sandbox
        disabled: true
      - insert:
          - id: shell-termux
            name: '@dsh-android/dsh-shell-termux'
      - insert:
          - id: android-manage
            name: '@dsh-android/dsh-android-manage'
    """.trimIndent() + "\n"
  }
}
