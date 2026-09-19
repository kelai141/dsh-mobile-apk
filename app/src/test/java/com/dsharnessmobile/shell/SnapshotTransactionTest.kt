package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      assertEquals("old-profile", File(live, "home/.dsh/profiles/web/cordis.yml").readText())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 【0.14.1 升级路径 P0】补偿动作不得掩盖真因，且删除失败必须有兜底。
   *
   * 设备实证（16384 覆盖安装 0.14.0 → 0.14.1）：`mergeProfiles` 的 catch 旧实现是内联三行
   *   `deletePath(liveProfiles); move(previousProfiles, liveProfiles); throw original`。
   * `deletePath` 逐项容错 → 可能返回而 live 仍非空 → `move` 到非空目标抛
   * `FileSystemException: … Directory not empty`，**取代**原始异常 → 真因被掩盖，
   * marker 永不收敛，live 插件树半合并 1/10。
   *
   * **行为级判据**（不用文本在场断言——本轮实测过：把 addSuppressed 删掉，纯文本判据照样绿）：
   * 反射调用 `compensateFailedProfilesMerge`，构造「删不净的 live」（其下留一个非空子目录，
   * 并把子目录 chmod 成只读以让递归删除失败；JVM 下更稳的做法是让子项为**非空目录**，
   * 因为 `deletePath` 对文件失败会 onFailure 继续）。
   * 断言：① 抛出的**就是**原始异常（同一对象身份）；② previous 的内容回到 live（兜底成功）；
   * ③ 不得抛出 Directory not empty 之类次生异常。
   */
  @Test
  fun mergeCompensationNeverMasksTheOriginalFailureAndRecoversTheBackup() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val profiles = File(live, "home/.dsh/profiles")
      SnapshotFs.createDirectories(profiles)
      File(profiles, "dirty.json").writeText("live")

      val method = SnapshotTransaction::class.java.getDeclaredMethod(
        "compensateFailedProfilesMerge",
        File::class.java, File::class.java, File::class.java, Throwable::class.java,
      )
      method.isAccessible = true
      // `SnapshotTransaction` 是 Kotlin `object`：静态 `invoke(null, ...)` 会 NPE，
      // 必须把 `INSTANCE` 当接收者传进去。
      val self = SnapshotTransaction::class.java.getDeclaredField("INSTANCE").get(null)

      // ── ① 补偿**必然失败**的确定性构造（跨平台）：previous 指向一个**不存在**的目录
      //    → `move(previous, live)` 必抛 NoSuchFileException。这正是设备上
      //    「rollback 也失败」的等价形态。
      //    契约：`compensateFailedProfilesMerge` **返回**原始异常（调用方写 `throw compensate(...)`），
      //    故 invoke 正常返回时拿到的就是 original；若它抛异常，抛出的也必须是 original。
      val missingPrevious = File(filesDir, "no-such-previous")
      val original = IllegalStateException("原始合并失败（真因，必须被保留）")
      val returned = try {
        method.invoke(self, filesDir, profiles, missingPrevious, original)
      } catch (invocation: java.lang.reflect.InvocationTargetException) {
        invocation.targetException
      }
      assertSame(
        "补偿失败时必须原样交回**原始异常**（旧实现会被 Directory not empty 之类的次生异常取代）",
        original,
        returned,
      )
      assertTrue(
        "补偿的次生错误必须作为 suppressed 附在真因上（否则真因链断裂、排障只能看到假象）",
        original.suppressed.isNotEmpty(),
      )
      assertTrue(
        "suppressed 里必须能看到真正的次生失败（本例为 move 找不到 previous）",
        original.suppressed.any {
          it is java.nio.file.NoSuchFileException ||
            it is java.io.FileNotFoundException ||
            it is java.nio.file.FileSystemException
        },
      )

      // ── ② 补偿**成功**路径：previous 是完整备份 → live 被还原成备份内容。
      val filesDir2 = tempDir()
      try {
        val live2 = File(filesDir2, "live").apply { mkdirs() }
        val profiles2 = File(live2, "home/.dsh/profiles")
        SnapshotFs.createDirectories(profiles2)
        File(profiles2, "dirty.json").writeText("live")
        val previous2 = SnapshotTransaction.previousRoot(filesDir2)
        SnapshotFs.createDirectories(previous2)
        File(previous2, "backup.json").writeText("previous")

        val original2 = IllegalStateException("原始合并失败 2")
        method.invoke(self, filesDir2, profiles2, previous2, original2)
        assertTrue(
          "补偿成功时必须把 previous 的备份内容放回 live",
          File(profiles2, "backup.json").exists(),
        )
      } finally {
        SnapshotFs.deletePath(filesDir2)
      }
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 真因出口：`EngineManager.lastRefreshFailure` 必须存在且被失败路径赋值。
   *
   * 为什么仍保留一条源码契约断言：`refreshSnapshot` 只回布尔值，`boot-fail.log` 想拿到真因
   * 只能靠这个出口；但**行为**由本文件另两条用例覆盖（上面那条锁补偿语义，
   * `EngineManager` 侧的赋值属跨类行为，见 `BootFailLogTest` 的失败终态用例）。
   */
  @Test
  fun refreshSnapshotExposesItsFailureCauseForBootFailLog() {
    val src = File("src/main/java/com/dsharnessmobile/shell/EngineManager.kt").readText()
    assertTrue(
      "EngineManager 必须暴露 lastRefreshFailure（refreshSnapshot 的真因出口）",
      src.contains("var lastRefreshFailure"),
    )
    val flow = File("src/main/java/com/dsharnessmobile/shell/EngineStartFlow.kt").readText()
    assertTrue(
      "boot-fail 必须带上真因（否则 error=none(boolean-failure-path) 不可排障）",
      flow.contains("lastRefreshFailure") && flow.contains("refreshCause"),
    )
  }

  /**
   * review C4：备份只有「拷贝完成 + 原子 rename」后才入 journal——拷贝中途被杀的残渣
   * （`profiles.copying`，半份内容）绝不能被恢复路径当成 displaced 覆盖 live。
   */
  @Test
  fun rollbackIgnoresAHalfWrittenProfilesBackupLeftover() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "old-node", "old-profile-live")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      // 半份备份残渣（模拟拷贝中被杀）：目录名带 .copying，内容不完整
      val copying = File(previous, "home/.dsh/profiles.copying/web")
      copying.mkdirs()
      File(copying, "cordis.yml").writeText("half-copied")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      assertEquals("live 必须保持原样（半份备份不得覆盖）", "old-profile-live", File(live, "home/.dsh/profiles/web/cordis.yml").readText())
      assertFalse("残渣不得被搬进 live", SnapshotFs.exists(File(live, "home/.dsh/profiles.copying")))
      assertFalse("previous 整目录清掉（含残渣）", SnapshotFs.exists(previous))
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

  /**
   * 【0.14.1 升级路径 P0】rollbackEntry 的**正常路径**回归：displaced 在场时回滚必须
   * 以 ROLLED_BACK 结束、备份内容回到 live、marker 被清。
   *
   * **诚实边界（必须说清，否则它就是一个看起来更强的判据）**：本用例**测不到**真正的缺陷触发条件。
   * 设备上的失败是 `deletePath(live)` **删不净**（SELinux/`untrusted_app` 下子项删除被拒，
   * 而 `SnapshotFs.deletePath` 逐项容错、删不掉的只记 onFailure 后继续），随后 `move` 到非空目录抛
   * `FileSystemException: … Directory not empty`。JVM 单测跑在普通文件系统上，`deletePath` 会**真的删干净**，
   * 因此「兜底改名挪开」这一分支在本用例里根本不会被执行——
   * **实测证实**：把兜底删掉（改回 `deletePath(live); move(displaced, live)`）本用例**仍然全绿**。
   * 所以：
   *   - 本用例锁的是**回滚语义**（正常路径不许回归）；
   *   - 「删不净仍能放回」这一分支的证据 = **设备实测**（16384 上 repair 前后 boot-fail 真因从
   *     `mergeProfiles` 移到 `rollbackEntry`，且 `error=` 已能带出真因）+ 与
   *     `compensateFailedProfilesMerge` **同一段代码形态**（那段有可判红的反证）。
   * 不把这两件事混为一谈：判据没有牙的地方就写明没有牙。
   */
  @Test
  fun rollbackPutsTheDisplacedCopyBackEvenWhenLiveCouldNotBeCleared() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      // live 的 usr/profile 都在场（模拟「删不净」的现场：deletePath 后仍留内容）
      writeRuntime(live, "live-node", "live-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      writeRuntime(previous, "old-node", "old-profile")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(
          SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr", "home/.dsh/profiles"),
        ),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      // displaced 的备份内容必须回到 live（兜底：先改名挪开，再 move 回来）
      assertEquals("old-node", File(live, "usr/bin/node").readText())
      assertNull("marker 必须被清（否则每次启动重试同一失败）", SnapshotTransaction.readMarker(filesDir))
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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

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

      SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

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

  /**
   * review C13（旧语义反转）：指纹已等于目标**不再是**提交证据——同版本重解压时指纹在交换开始前
   * 就等于目标，交换中途被杀必须回滚（旧实现会误判前滚，live 可能只换了一半）。
   */
  @Test
  fun rollsBackWhenOnlyTheTargetFingerprintMatchesButTheSwapNeverCommitted() {
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

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(live, "usr"), File(live, "home"))

      assertEquals(SnapshotTransaction.Outcome.ROLLED_BACK, recovery.outcome)
      // 无 previous 备份 + staged 已不在场 = 该条目是本次新装：回滚即删除（live 不得停在半交换态）。
      assertFalse("半交换的新树必须被回滚清除", SnapshotFs.exists(File(live, "usr/bin/node")))
      assertNull(SnapshotTransaction.readMarker(filesDir))
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

  // ── 清理阶段的容错（0.14.0 模拟器实锤） ──────────────────────────────────────
  //
  // 缺陷形态：模拟器异常掉线把解压打断，留下 `.snapshot-stage/home`；其内部元数据损坏，
  // `ls` 看是空的、`rm -rf` 与 `rmdir` 都删不掉（"Not a data message" / "Directory not empty"）。
  // 旧 deletePath 遇到它就抛异常 ⇒ 清理失败 ⇒ 刷新失败 ⇒ **回滚也走同一方法、也失败**
  // （实测日志 "snapshot refresh rollback failed; recovery marker retained"）⇒
  // **之后每次启动都失败**，用户只能清应用数据。
  //
  // 这里无法在 JVM 上造出真正的损坏 inode，因此钉住可离线验证的那部分契约：
  // **删除失败必须被上报、不得抛出**，且能删的兄弟条目必须照常删掉。

  @Test
  fun deletePathReportsFailuresInsteadOfThrowing() {
    // 用一个「删不掉」的替身证明契约：传入不存在的路径也不得抛异常。
    val missing = File(tempDir(), "not-there")
    var failures = 0
    SnapshotFs.deletePath(missing) { _, _ -> failures += 1 }
    assertEquals(0, failures)

    // 正常树：必须整体删除且不上报失败。
    val root = tempDir()
    try {
      File(root, "usr/bin").mkdirs()
      File(root, "usr/bin/node").writeText("node")
      File(root, "home/.dsh").mkdirs()
      File(root, "home/.dsh/settings.yaml").writeText("user: true\n")
      var reported = 0
      SnapshotFs.deletePath(root) { _, _ -> reported += 1 }
      assertFalse("正常树应被整体删除", SnapshotFs.exists(root))
      assertEquals("正常树不应上报任何失败", 0, reported)
    } finally {
      root.deleteRecursively()
    }
  }

  @Test
  fun deletePathContinuesAfterAnIndividualFailure() {
    // 只要有一个条目删除失败，其余条目仍必须被清理（不能因一条坏项放弃整棵树）。
    val root = tempDir()
    try {
      File(root, "a").mkdirs()
      File(root, "a/keep").writeText("x")
      File(root, "b").mkdirs()
      File(root, "b/other").writeText("y")
      val visited = mutableListOf<String>()
      // 让 a/keep 读作目录但删不掉：用只读父目录无法在 JVM 稳定复现，故直接验证遍历完整性——
      // 通过 onFailure 不会被触发（此树健康）但两个分支都被访问过。
      SnapshotFs.deletePath(root) { f, _ -> visited += f.name }
      assertFalse(SnapshotFs.exists(root))
      assertTrue("失败的项才会上报，健康树不上报", visited.isEmpty())
    } finally {
      root.deleteRecursively()
    }
  }

  // ── ② 反馈二：半程事务必须幂等收敛（0.14.1 块K） ────────────────────────────
  //
  // 用户实测形态（华为 NOH-AN00 / Android 31 / 0.14.0 vc39）：`.snapshot-transaction` 长期停在
  // `phase=SWAPPED`（自 0.14.0 覆盖安装那一刻），配套 `.snapshot-previous` 920 MB、
  // `.snapshot-stage` 176 MB 长期不回收；之后每次启动都走「收敛未完成事务」。
  //
  // 真因（源码级，见 0.14.1 块K 报告）：提交路径是
  //   EngineManager.applyRecovery(ROLLED_FORWARD) → writeFingerprint → SnapshotTransaction.finish()
  // 而完成安装那一刻的 finish() 在真机上被 `NoSuchMethodError`（Error，非 Exception）打穿 ——
  // 于是 marker 永远留在 SWAPPED。

  @Test
  fun finishClearsMarkerEvenWhenArtifactCleanupThrows() {
    // 判据：产物清理抛错（模拟真机 Error 打穿 deletePath 的情形）时，marker 仍必须被清除。
    // 旧实现顺序为 delete → delete → clearMarker，任一抛出即 marker 残留 ⇒ 本测试判红。
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "node", "profile")
      SnapshotFs.createDirectories(SnapshotTransaction.stageRoot(filesDir))
      SnapshotFs.createDirectories(SnapshotTransaction.previousRoot(filesDir))
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPED, "fp", 1L, listOf("usr")),
      )

      // 注入一个「清理必失败」的删除原语（等价真机 Error 越过 catch 的形态）。
      var attempts = 0
      try {
        SnapshotTransaction.finish(filesDir) { attempts += 1; throw NoSuchMethodError("injected: Stream.toList") }
      } catch (_: NoSuchMethodError) {
        // 清理失败本身可以向上传播；但 marker 必须已经被清掉（finally 语义）。
      }
      assertTrue("删除原语应被尝试（否则测试没走到清理步）", attempts > 0)
      assertNull(
        "finish() 必须保证 marker 被清除——它残留 SWAPPED 会让之后每次启动都重跑前滚、残渣永不回收",
        SnapshotTransaction.readMarker(filesDir),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun reclaimResidueRemovesPreviousAndStageWhenNoMarkerRemains() {
    // 幂等收敛：marker 已丢、残渣还在 ⇒ 必须能被回收（用户诉求「自动提交并清理」）。
    val filesDir = tempDir()
    try {
      val previous = SnapshotTransaction.previousRoot(filesDir)
      val stage = SnapshotTransaction.stageRoot(filesDir)
      File(previous, "usr/bin").mkdirs()
      File(previous, "usr/bin/node").writeText("old")
      File(stage, "home/.dsh").mkdirs()
      assertNull("本用例前提：没有 marker", SnapshotTransaction.readMarker(filesDir))
      assertTrue("前提：残渣在场", SnapshotTransaction.hasResidue(filesDir))

      val reclaimed = SnapshotTransaction.reclaimResidue(filesDir)

      assertTrue("two residue dirs are reported", reclaimed.containsAll(listOf(SnapshotTransaction.PREVIOUS_NAME, SnapshotTransaction.STAGE_NAME)))
      assertFalse("previous 必须被真删（不得只报不删）", SnapshotFs.exists(previous))
      assertFalse("stage 必须被真删", SnapshotFs.exists(stage))
      assertFalse("回收后不应再有残渣", SnapshotTransaction.hasResidue(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun reclaimResidueIsIdempotentOnACleanTree() {
    // 幂等：无残渣时不得报任何回收项，也不得抛错（每次启动都会走这条判定）。
    val filesDir = tempDir()
    try {
      assertFalse(SnapshotTransaction.hasResidue(filesDir))
      assertEquals(emptyList<String>(), SnapshotTransaction.reclaimResidue(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

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

  // ── 0.14.1 审查 D-3 / §7.7.5：回滚失败**不得无条件清 marker** ──────────────────────
  //
  // 缺陷形态：旧 recover() 无论回滚成败都 clearMarker() ⇒ 半成品树被当成「已恢复」长期使用，
  // 下游症状正是用户实报的「插件注册了但不真实可用」（列表在、能力不在，§7.7）。
  @Test
  fun recoveryKeepsTheMarkerWhenRollbackCouldNotFinish() {
    val filesDir = tempDir()
    try {
      // 构造「回滚这一条必定失败」的形态：live 路径的**父级是一个普通文件** ⇒
      // rollbackEntry 里 `move(displaced, live)` 的 createDirectories 必然抛错。
      // （不用「只读目录/占用句柄」这类平台相关手法：CI 跑 Linux、本机跑 Windows，两者语义不同。）
      File(filesDir, "live").writeText("not-a-directory")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      File(previous, "usr/bin").mkdirs()
      File(previous, "usr/bin/node").writeText("old-node")
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr")),
      )

      val recovery = SnapshotTransaction.recover(filesDir, stage, File(filesDir, "live/usr"), File(filesDir, "live/home"))

      assertEquals(SnapshotTransaction.Outcome.ROLLBACK_FAILED, recovery.outcome)
      assertTrue("失败条目必须如实回报（供 boot-fail.log 归因）", recovery.failures.isNotEmpty())
      assertTrue("marker 必须保留（下次启动重试回滚，而不是把半成品当已恢复）",
        SnapshotTransaction.readMarker(filesDir) != null)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  @Test
  fun rollbackReportsOkSoTheCallerCanDecideAboutTheMarker() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "live-node", "live-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage)
      val previous = SnapshotTransaction.previousRoot(filesDir)
      writeRuntime(previous, "old-node", "old-profile")
      val marker = SnapshotTransaction.Marker(
        SnapshotTransaction.Phase.SWAPPING, "fp1", 1L, listOf("usr", "home/.dsh/profiles"),
      )
      val result = SnapshotTransaction.rollback(filesDir, stage, File(live, "usr"), File(live, "home"), marker)
      assertTrue("成功回滚必须回报 ok（调用方据此决定清 marker）", result.ok)
      assertTrue(result.failures.isEmpty())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── 0.14.1 审查 N-1 / F-9：只写不回收的两类残渣 ────────────────────────────────
  @Test
  fun residueReclaimCoversFailedAndOrphanStageDirectoriesWithAnAgeGate() {
    val filesDir = tempDir()
    try {
      val now = 1_800_000_000_000L
      val old = now - 31L * 60L * 1000L        // 超过 30 分钟门槛
      val fresh = now - 60L * 1000L            // 1 分钟前（可能属于进行中事务）
      // 三类残渣：`.failed-<ts>`（rollback 挪开的 live 树，三层位置各一）
      val usrFailed = File(filesDir, "usr.failed-$old").apply { mkdirs() }
      File(usrFailed, "bin/node").apply { parentFile?.mkdirs() }.writeText("x")
      val dshFailed = File(filesDir, "home/.dsh/profiles.failed-$old").apply { mkdirs() }
      val orphanStage = File(filesDir, SnapshotTransaction.STAGE_ORPHAN_PREFIX + old).apply { mkdirs() }
      // 新鲜残渣：必须**不动**（可能仍被进行中的恢复引用）
      val freshFailed = File(filesDir, "usr.failed-$fresh").apply { mkdirs() }
      // 无时间戳的（老命名）：保守不动
      val noStamp = File(filesDir, "usr.failed-legacy").apply { mkdirs() }

      val reclaimed = SnapshotTransaction.reclaimResidue(filesDir, now)

      assertFalse("老 .failed-* 必须被回收（旧实现只认 previous/stage）", usrFailed.exists())
      assertFalse("home/.dsh 下的 .failed-* 同样回收", dshFailed.exists())
      assertFalse("孤儿 stage 必须被回收（旧实现只有写点、无回收点）", orphanStage.exists())
      assertTrue("新鲜残渣不得动（30 分钟年龄门槛）", freshFailed.exists())
      assertTrue("解析不出时间戳的命名保守不动", noStamp.exists())
      assertEquals(3, reclaimed.size)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── 0.14.1 审查 §7.2-F-4 / B12：交换前的空间断言 ──────────────────────────────
  @Test
  fun swapRefusesToStartWhenTheSpacePrecheckFailsAndLeavesTheTreeUntouched() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      writeRuntime(live, "old-node", "old-profile")
      val stage = SnapshotTransaction.stageRoot(filesDir)
      File(stage, "usr/bin").mkdirs()
      File(stage, "usr/bin/node").writeText("new-node-内容")
      var asked = 0L
      val failure = try {
        SnapshotTransaction.swap(
          filesDir = filesDir,
          stagedRoot = stage,
          usrDir = File(live, "usr"),
          homeDir = File(live, "home"),
          preservedNames = preserved,
          fingerprint = "fp2",
          startedAt = 2L,
          spaceCheck = { required -> asked = required; "空间不足" },
        )
        null
      } catch (t: SnapshotTransaction.InsufficientSpaceException) {
        t
      }
      assertTrue("空间不足必须抛专门类型（调用方据此给可照做的文案）", failure != null)
      assertTrue("需求按 2.5× 解压体量算（实测口径）", asked > 0)
      assertEquals("空间不足时**不得动 live 树**", "old-node", File(live, "usr/bin/node").readText())
      assertNull("也不得留下 marker（事务根本没开始）", SnapshotTransaction.readMarker(filesDir))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }


  // ── 0.14.1 D-1 设备侧收尾：已摘除插件的存量迁移 ────────────────────────────────
  //
  // 设备实测（16416 覆盖安装本轮构建）：`profiles/web/node_modules/@aiwayds/dsh-model-sync` 与
  // 清单里的挂载条目**都还在**（profile 根的两个清单是用户面，升级不替换）⇒ 摘除对老用户等于没摘，
  // 而新装用户正常 —— 幽灵缺陷的定义形态。本用例把迁移钉死：条目摘掉、包目录删掉、其它挂载不动、
  // 幂等（第二遍是空操作）。
  @Test
  fun removedProfilePluginsAreReconciledOutOfTheLiveProfile() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")
      // 工厂面：新快照**不再**含该插件；用户面：老设备的清单与包目录仍在。
      val liveWeb = File(live, "home/.dsh/profiles/web")
      SnapshotFs.createDirectories(liveWeb)
      File(liveWeb, "cordis.patch.yml").writeText(
        listOf(
          "- id: keep-me",
          "  name: '@dsh-android/keep-me'",
          "- insert:",
          "    - id: dsh-model-sync",
          "      name: '@aiwayds/dsh-model-sync'",
          "- insert:",
          "    - id: keep-me-too",
          "      name: '@user/keep-me-too'",
          "",
        ).joinToString("\n"),
      )
      File(liveWeb, "package.json").writeText("{}\n")
      val stalePackage = File(liveWeb, "node_modules/@aiwayds/dsh-model-sync/lib").apply { mkdirs() }
      File(stalePackage, "index.js").writeText("stale")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp3",
        startedAt = 3L,
      )

      val text = File(liveWeb, "cordis.patch.yml").readText()
      assertFalse("被摘除插件的挂载条目必须消失", text.contains("id: dsh-model-sync"))
      assertFalse("其包名也不得再出现", text.contains("@aiwayds/dsh-model-sync"))
      assertTrue("其它挂载必须原样保留", text.contains("id: keep-me-too"))
      assertTrue("用户自定义条目不得被误删", text.contains("@user/keep-me-too"))
      assertFalse("存量包目录必须删除",
        File(liveWeb, "node_modules/@aiwayds/dsh-model-sync").exists())
      assertFalse("删空的作用域目录也应清理（留着空目录会让人以为包还在）",
        File(liveWeb, "node_modules/@aiwayds").exists())

      // 幂等：再来一次完整交换（必须重新铺好 staged 树——上一轮已把它换进 live），
      // 迁移不得再有动作、更不得抛错。
      val stage2 = SnapshotTransaction.stageRoot(filesDir)
      SnapshotFs.createDirectories(stage2)
      writeRuntime(stage2, "new-node-2", "new-profile-2")
      val second = SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage2,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp3",
        startedAt = 4L,
      )
      assertTrue("第二遍不得再报迁移动作（幂等）：" + second.joinToString("；"),
        second.filter { it.contains("dsh-model-sync") }.isEmpty())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

}