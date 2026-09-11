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

  private fun writeRuntime(root: File, nodeMarker: String, profileMarker: String) {
    File(root, "usr/bin").mkdirs()
    File(root, "usr/bin/node").writeText(nodeMarker)
    File(root, "home/.dsh/profiles/web").mkdirs()
    File(root, "home/.dsh/profiles/web/cordis.yml").writeText(profileMarker)
    File(root, "home/.dsh/settings.yaml").writeText("factory: true\n")
    File(root, "home/.gitconfig").writeText("[user]\n")
  }

  private fun tempDir(): File = Files.createTempDirectory("snapshot-transaction-test").toFile()
}
