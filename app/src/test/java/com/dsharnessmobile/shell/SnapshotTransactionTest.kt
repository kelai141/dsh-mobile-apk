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
  fun strictPatchYamlAcceptsCordisJsExpressionAsSafeScalar() {
    val patch = """
      - id: mnemon-bundle
        disabled: !!js >-
          ((entry) => Boolean(entry.options.disabled))
          ([...loader.entries()].find(entry => entry.options.id === 'mnemon'))
      - id: next-row
        disabled: false
    """.trimIndent()

    SnapshotTransaction.validatePatchYaml(patch, "cordis.patch.yml")
  }

  @Test
  fun strictPatchYamlRejectsDuplicateMappingKeys() {
    val patch = """
      - id: agent-default-model
        config:
          provider: deepseek-official
        config:
          model: deepseek-v4-flash
    """.trimIndent()

    val failure = try {
      SnapshotTransaction.validatePatchYaml(patch, "cordis.patch.yml")
      null
    } catch (e: SnapshotFsException) {
      e
    }
    assertTrue("duplicate mapping keys must fail before atomic write", failure != null)
    assertTrue(failure?.message?.contains("严格合法 YAML") == true)
  }

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

    /**
     * 替身记录的链接目标（真实用例里是 `.pnpm/real-dep` 这类相对路径）。
     *
     * 必须放在**外层类的 companion object**：`RecordingLinks` 是 nested class，
     * 看不到外层测试类的 instance 成员（`private val` 编译期即 `Unresolved reference`）。
     * companion 的成员对 nested class 可见，故这里是唯一正确的位置。
     */
    private const val LINK_TARGET_TEXT = ".pnpm/real-dep"
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
      // live 的 profiles 树（交换会把它整份拷成 previous —— 这才是本检查要守的量）。
      val liveProfiles = File(live, "home/.dsh/profiles/web/node_modules")
      liveProfiles.mkdirs()
      File(liveProfiles, "big.bin").writeBytes(ByteArray(1024 * 1024))
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
      // 需求口径 = 交换真正会新占用的量（live profiles 备份 ×1.25 + 64MB）。
      // 两侧都钉住：既要为正，又**不得**退化成「整棵解压树 ×2.5」——后者跑在解压之后会把
      // 本可成功的刷新拒掉（过度拦截，本轮自查发现并修正的口径）。
      val liveBytes = SnapshotFs.sizeOf(File(live, "home/.dsh/profiles"))
      assertTrue("需求必须为正", asked > 0)
      assertTrue("需求应约等于 live profiles 备份 + 25% + 64MB（含 1MB live 内容），实测 $asked",
        asked >= 64L * 1024 * 1024 && asked <= liveBytes * 2 + 128L * 1024 * 1024)
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
      // apk #249（本用例原先**抓不到**的形态）：旧实现 index += 2 只删 id + name 两行，
      // 于是 - insert: 包装行被留下、底下再无子项 ⇒ YAML 解析成 null 条目，
      // loader 拿到 nil 即 boot 期 TypeError。上一条断言（不含 "id: dsh-model-sync"）
      // 对这个残骸**恒为真**，所以缺陷能一路穿到设备——这就是判据必须能反证的意义。
      // 判据：每个 - insert: 后面必须紧跟一个更深缩进的非空行（= 它有子项）。
      val patchLines = text.lines()
      val dangling = patchLines.withIndex().filter { (i, line) ->
        val own = line.indexOfFirst { !it.isWhitespace() }
        val next = patchLines.drop(i + 1).firstOrNull { it.isNotBlank() }
        line.trim() == "- insert:" && (next == null || next.indexOfFirst { !it.isWhitespace() } <= own)
      }
      assertTrue("不得留下空壳 - insert:（YAML null 条目，boot 期 TypeError）：" +
        dangling.map { it.index + 1 }, dangling.isEmpty())
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

  // ── apk #249 反证：条目独占一个 insert 时，包装行必须整块摘掉 ─────────────────────
  // 真实 0.14.0 形态就是「- insert: 下只有 dsh-model-sync 一条」。旧实现删两行后留下
  // 一个 null 条目；本用例把「包装行也必须消失」钉死（这是设备 boot 崩溃的直接来源）。
  @Test
  fun removedProfilePluginLeavesNoDanglingInsertWrapper() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")
      val liveWeb = File(live, "home/.dsh/profiles/web")
      SnapshotFs.createDirectories(liveWeb)
      File(liveWeb, "cordis.patch.yml").writeText(
        listOf(
          "- id: keep-me",
          "  name: '@dsh-android/keep-me'",
          "- insert:",
          "    - id: dsh-model-sync",
          "      name: '@aiwayds/dsh-model-sync'",
          "",
        ).joinToString("\n"),
      )
      File(liveWeb, "package.json").writeText("{}\n")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp4",
        startedAt = 5L,
      )

      val text = File(liveWeb, "cordis.patch.yml").readText()
      // 注意判据必须落在**条目**上，不能落在裸包名上：迁移成功时会追加一行留档注释
      // （"# 0.14.1：已摘除 dsh-model-sync…"），裸 contains("dsh-model-sync") 对它恒为真
      // ——这正是本仓「字符串在场判据必须只看可执行行/剥注释」那条纪律的又一个实例。
      assertFalse("被摘除插件的挂载条目必须消失", text.contains("id: dsh-model-sync"))
      assertFalse("其包名条目也不得再出现", text.contains("name: '@aiwayds/dsh-model-sync'"))
      assertFalse("独占的 insert 包装行也必须整块摘掉（否则是 null 条目）",
        text.contains("insert:"))
      assertTrue("无关挂载必须原样保留", text.contains("id: keep-me"))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }


  /**
   * 0.14.2（D11）反证：被摘除的条目与**同组的其它子条目**共处一个 @BQ@- insert:@BQ@ 组时，
   * 摘除**只作用于目标条目**，同组的硬清单兄弟必须一字不动。
   *
   * 旧实现把「本条目是 insert 组子项」的清理逻辑与「组内还有没有兄弟」的缩进启发式绑在一起，
   * 误判即整组消失——设备实读形态（@BQ@shell-termux@BQ@ + @BQ@host-web-compat@BQ@ 同组）一旦被
   * 摘除清单命中就是「更新后静默少两个插件」，而日志只说摘了 1 处。
   */
  @Test
  fun removedProfilePluginDoesNotCollaterallyDropItsGroupSiblings() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(stage, "new-node", "new-profile")
      val liveWeb = File(live, "home/.dsh/profiles/web")
      SnapshotFs.createDirectories(liveWeb)
      File(liveWeb, "cordis.patch.yml").writeText(
        listOf(
          "- insert:",
          "    - id: dsh-model-sync",
          "      name: '@aiwayds/dsh-model-sync'",
          "    - id: host-web-compat",
          "      name: '@dsh-android/dsh-host-web-compat'",
          "- id: keep-me",
          "  name: '@dsh-android/keep-me'",
          "",
        ).joinToString("\n"),
      )
      File(liveWeb, "package.json").writeText("{}\n")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp5",
        startedAt = 6L,
      )

      val text = File(liveWeb, "cordis.patch.yml").readText()
      assertFalse("被摘除的条目必须消失", text.contains("id: dsh-model-sync"))
      assertTrue(
        "D11：同组的硬清单兄弟必须一字不动（旧实现会连坐整组）",
        text.contains("id: host-web-compat") && text.contains("@dsh-android/dsh-host-web-compat"),
      )
      assertTrue("组里还剩一个子条目 ⇒ 组包装行必须保留", text.contains("- insert:"))
      assertTrue("无关顶层条目原样保留", text.contains("id: keep-me"))
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── M.2 A（issue #273 ①）：回滚不得丢符号链接、不得把半份备份当 live ──────────────
  //
  // 旧实现在 copyRecursivelyStrict 里对链接直接 `return`（注释：「链接属运行时残渣」）。
  // 该假定是错的：pnpm 的 node_modules 结构大量依赖链接（现网实测 501 个），而 profiles
  // 回滚的唯一数据源就是这份备份 ⇒ 备份里没有链接，回滚后结构崩掉、模块解析失败。
  // 更坏的是没有任何一层会发现：备份「合法但残缺」。

  /** 工厂态写入一个带符号链接的 profiles 树（pnpm 形态的最小复现）。 */
  private fun writeProfilesWithLinks(root: File, marker: String) {
    File(root, "home/.dsh/profiles/web").mkdirs()
    File(root, "home/.dsh/profiles/web/cordis.yml").writeText(marker)
    val nm = File(root, "home/.dsh/profiles/web/node_modules")
    nm.mkdirs()
    File(nm, ".pnpm").mkdirs()
    File(nm, ".pnpm/real-dep").mkdirs()
    File(nm, ".pnpm/real-dep/index.js").writeText("module.exports = 1\n")
    // pnpm 的经典形态：顶层条目是指向 .pnpm 的符号链接
    try {
      Files.createSymbolicLink(
        File(nm, "dep").toPath(),
        java.nio.file.Paths.get(".pnpm/real-dep"),
      )
    } catch (_: Throwable) {
      // 个别环境不允许建链；用例自行跳过链接断言（见下方 linksAvailable 守卫）。
    }
  }

  @Test
  fun backupKeepsSymbolicLinksAndRollbackRestoresThem() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      writeProfilesWithLinks(live, "live-marker")
      val link = File(live, "home/.dsh/profiles/web/node_modules/dep")
      // 本机（Windows，无建链权限）无法构造符号链接 ⇒ 本用例的核心判据不可构造。
      // **必须用 Assume 报 SKIP，绝不能 `return`** —— `return` 会让它显示为 PASS，
      // 那就是「判据存在但无判别力」的假绿（本轮实测：撤掉 A 的修法后本用例照样绿，
      // 真因正是这里静默返回）。SKIP 会如实进入报告，并在有建链权限的环境（Linux/CI/设备）真正执行。
      org.junit.Assume.assumeTrue(
        "本机无符号链接创建权限（需 Linux/CI/设备或管理员权限）",
        SnapshotFs.isSymbolicLink(link),
      )

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-link",
        startedAt = 1L,
      )

      // 备份必须**含链接**（旧实现在这里恒为 0 ⇒ 判红）。
      val previousProfiles = File(filesDir, ".snapshot-previous/home/.dsh/profiles")
      val backupStats = SnapshotFs.treeStats(previousProfiles)
      assertTrue(
        "备份必须保留符号链接（issue #273 ①：旧实现跳过链接，回滚必丢）",
        backupStats.links >= 1,
      )
      assertTrue(
        "备份里的链接必须真的能解析为链接（不是被复制成了普通文件）",
        SnapshotFs.isSymbolicLink(File(previousProfiles, "web/node_modules/dep")),
      )

      // 回滚后 live 的链接必须回来。
      val rollback = SnapshotTransaction.rollback(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        marker = SnapshotTransaction.readMarker(filesDir)!!,
      )
      assertTrue("回滚必须成功: " + rollback.failures, rollback.ok)
      assertTrue(
        "回滚后 live 的符号链接必须被重建（issue #273 ① 的第二半）",
        SnapshotFs.isSymbolicLink(File(live, "home/.dsh/profiles/web/node_modules/dep")),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 反证（A）：残缺备份**必须**被拒绝，绝不 move 回 live。
   * 构造一份「合法但空」的 previous —— 正是半份备份/未完成 copying 残渣的形态。
   */
  @Test
  fun rollbackRefusesAnEmptyBackupInsteadOfWipingLive() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      File(live, "home/.dsh/profiles/web/keep-me").writeText("user data")

      // 手造一份**空的** previous + 一个声称搬过 profiles 的 marker。
      val previous = SnapshotTransaction.previousRoot(filesDir)
      previous.mkdirs()
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp", 1L, listOf("home/.dsh/profiles")),
      )

      val before = File(live, "home/.dsh/profiles/web/keep-me").readText()
      val rollback = SnapshotTransaction.rollback(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        marker = SnapshotTransaction.readMarker(filesDir)!!,
      )

      assertFalse("空备份必须被拒绝（否则等于用空目录覆盖用户数据）", rollback.ok)
      assertTrue(
        "拒绝理由必须点名备份残缺: " + rollback.failures,
        rollback.failures.any { it.contains("回滚被拒") },
      )
      assertEquals(
        "live 必须原封不动（拒绝回滚 ≠ 破坏 live）",
        before,
        File(live, "home/.dsh/profiles/web/keep-me").readText(),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── M.2 B（issue #273 ②）：writeMarker 原子性 + 失败中止事务 ─────────────────────

  /**
   * 反证（B）：marker 写失败**必须抛**，不得静默继续。
   *
   * 构造法：把 marker 的目标路径变成一个**目录**（rename 与直写都不可能成功），
   * 模拟「写不进 journal」的现场。旧实现会把异常咽掉、让调用方带着「可能没有 journal」
   * 的状态继续动树 —— 那是最危险的一种继续。
   */
  @Test
  fun writeMarkerFailureAbortsInsteadOfContinuingWithoutJournal() {
    val filesDir = tempDir()
    try {
      // 目标 marker 路径占成目录：rename 到它、直写它都会失败。
      SnapshotTransaction.markerFile(filesDir).mkdirs()
      var threw = false
      try {
        SnapshotTransaction.writeMarker(
          filesDir,
          SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp", 1L),
        )
      } catch (e: Throwable) {
        threw = true
        assertTrue(
          "失败必须结构化（code=snapshot-marker-write），便于日志/诊断归因: " + e,
          e is SnapshotFsException && e.code == CODE_MARKER_WRITE,
        )
      }
      assertTrue("marker 写失败必须抛（旧实现静默继续，事务再无 journal）", threw)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 正证（B）：正常写入**不得**经过「先删目标」的窗口 —— 判据是写入后 marker 立即可读，
   * 且 tmp 不残留。旧实现的 deletePath 窗口无法在单线程 JVM 里「同步」被抓到，
   * 因此这里钉住**可观察的等价契约**：写入后没有 tmp 残留、内容完整可读。
   */
  @Test
  fun writeMarkerLeavesNoTemporaryResidueAndIsImmediatelyReadable() {
    val filesDir = tempDir()
    try {
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPING, "fp-x", 7L, listOf("usr")),
      )
      val marker = SnapshotTransaction.readMarker(filesDir)
      assertEquals(SnapshotTransaction.Phase.SWAPPING, marker?.phase)
      assertEquals("fp-x", marker?.fingerprint)
      assertEquals(listOf("usr"), marker?.moved)
      assertFalse(
        "不得残留 tmp（旧实现的先删后写路径会留下它）",
        SnapshotFs.exists(File(filesDir, ".snapshot-transaction.tmp")),
      )
      // 覆盖写：第二次仍必须原子成功（rename 覆盖既有目标）。
      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(SnapshotTransaction.Phase.SWAPPED, "fp-y", 8L, listOf("usr")),
      )
      assertEquals(SnapshotTransaction.Phase.SWAPPED, SnapshotTransaction.readMarker(filesDir)?.phase)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── M.3 C（issue #274 ②）：用户面清单必须原子写 + 写后可解析 ─────────────────────
  //
  // 旧实现 `live.writeText(...)` 直接截断目标再写：写到一半被杀 / 磁盘满 ⇒ live 上留下
  // **半个 JSON**。引擎读它就是解析失败 —— 比「没更新」坏得多。marker 与指纹早已走
  // tmp+rename，只有这两处是例外。

  /**
   * 正证（C）：package.json 合并后必须仍是**合法 JSON**，且不留 tmp 残留。
   * 这条同时锁住「合并逻辑产出的结构」与「写入路径不破坏结构」。
   */
  @Test
  fun mergedPackageJsonStaysParseableAndLeavesNoTempFiles() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      File(live, "home/.dsh/profiles/web/package.json").writeText(
        """{"dependencies":{"@user/pin":"1.0.0"},"dsh":{"profile":{"bundles":["@user/custom"]}}}""",
      )
      File(stage, "home/.dsh/profiles/web/package.json").writeText(
        """{"dependencies":{"@factory/new":"2.0.0"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}""",
      )

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-json",
        startedAt = 1L,
      )

      val merged = File(live, "home/.dsh/profiles/web/package.json")
      // 可解析性：坏 JSON 会在这里抛（就是「半个 JSON」的判据）。
      val root = org.json.JSONObject(merged.readText())
      val deps = root.getJSONObject("dependencies")
      assertTrue("用户 pin 必须幸存", deps.has("@user/pin"))
      assertTrue("工厂新增依赖必须补入", deps.has("@factory/new"))
      val bundles = root.getJSONObject("dsh").getJSONObject("profile").getJSONArray("bundles")
      val list = (0 until bundles.length()).map { bundles.getString(it) }
      assertTrue("用户 bundle 幸存", list.contains("@user/custom"))
      assertTrue("工厂 bundle 补入", list.contains("@deepseek-ai/dsh-base"))
      assertFalse(
        "不得残留 tmp 文件（原子写的临时文件必须已被 rename 消费）",
        merged.parentFile!!.listFiles()!!.any { it.name.startsWith(".package.json.tmp-") },
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /** 正证（C）：cordis.patch.yml 合并后必须非空（空 patch = 静默丢掉全部装配条目）。 */
  @Test
  fun mergedPatchYamlIsNonEmptyAndKeepsBothSides() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      File(live, "home/.dsh/profiles/web/cordis.patch.yml").writeText(
        "- id: user-row\n  disabled: true\n",
      )
      File(stage, "home/.dsh/profiles/web/cordis.patch.yml").writeText(
        "- id: user-row\n- id: factory-row\n  disabled: true\n",
      )

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-yaml",
        startedAt = 1L,
      )

      val merged = File(live, "home/.dsh/profiles/web/cordis.patch.yml")
      val text = merged.readText()
      assertTrue("合并结果必须非空", text.isNotBlank())
      assertTrue("用户行幸存", text.contains("user-row"))
      assertTrue("工厂行补入", text.contains("factory-row"))
      assertFalse(
        "不得残留 tmp 文件",
        merged.parentFile!!.listFiles()!!.any { it.name.startsWith(".cordis.patch.yml.tmp-") },
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── M.3 D（issue #274 ③）：工厂件覆盖用户改动必须**可发现** ─────────────────────

  /**
   * 反证（D）：用户改过的 node_modules 内工厂件被覆盖时，必须留下同目录 `.pre-*` 副本。
   *
   * 覆盖语义本身**不变**（node_modules 工厂件做字段级合并会造成「旧清单 + 新文件」，
   * 0.14.0 P0 实锤过）—— 缺的只是「被抹掉的东西能找回来」。
   */
  @Test
  fun factoryOverwritePreservesTheUserVersionInAPreFile() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      // node_modules 子树内的工厂件（**不是** profile 根清单 ⇒ 走整体覆盖分支）
      val rel = "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-x/cordis.yml"
      File(live, rel).parentFile!!.mkdirs()
      File(stage, rel).parentFile!!.mkdirs()
      File(live, rel).writeText("user-patched: true\n")
      File(stage, rel).writeText("factory: true\n")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-preserve",
        startedAt = 1L,
      )

      val target = File(live, rel)
      assertEquals("工厂件必须整体覆盖（语义不变）", "factory: true\n", target.readText())
      val pre = target.parentFile!!.listFiles()!!.filter { it.name.startsWith(".pre-cordis.yml-") }
      assertTrue(
        "被覆盖的用户版本必须另存为可发现的 .pre-* 副本（issue #274 ③）",
        pre.isNotEmpty(),
      )
      assertEquals(
        "另存的必须是**用户那个版本**，不是工厂件",
        "user-patched: true\n",
        pre.first().readText(),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /** 正证（D）：内容与工厂**相同**时不留 .pre-*（否则每次刷新都堆一份纯噪声副本）。 */
  @Test
  fun factoryOverwriteOfIdenticalContentLeavesNoBackup() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val rel = "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-x/cordis.yml"
      File(live, rel).parentFile!!.mkdirs()
      File(stage, rel).parentFile!!.mkdirs()
      File(live, rel).writeText("same: true\n")
      File(stage, rel).writeText("same: true\n")

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-same",
        startedAt = 1L,
      )

      val pre = File(live, rel).parentFile!!.listFiles()!!.filter { it.name.startsWith(".pre-") }
      assertTrue("内容相同不得留副本（纯噪声）", pre.isEmpty())
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  // ── M.3 E（issue #274 ④）：空间预检必须带 need/available MB 且**改在动树之前** ────

  /**
   * 反证（E）：预检拒绝时**live 必须未被改动**，且异常携带可展示的 need MB。
   * 注入 spaceCheck 是既有惯例（同 delete/move/ownerProbe），生产面不留测试缝。
   */
  @Test
  fun spaceRefusalHappensBeforeAnyTreeIsTouchedAndCarriesUserFacingNumbers() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      File(live, "home/.dsh/profiles/web/untouched").writeText("user")

      var threw: SnapshotTransaction.InsufficientSpaceException? = null
      try {
        SnapshotTransaction.swap(
          filesDir = filesDir,
          stagedRoot = stage,
          usrDir = File(live, "usr"),
          homeDir = File(live, "home"),
          preservedNames = preserved,
          fingerprint = "fp-space",
          startedAt = 1L,
          spaceCheck = { required ->
            "存储空间不足：运行时更新需要约 " + (required / (1024 * 1024)) + " MB，当前仅 3 MB。"
          },
        )
      } catch (e: SnapshotTransaction.InsufficientSpaceException) {
        threw = e
      }
      assertTrue("空间不足必须抛 InsufficientSpaceException（不是泛化的刷新失败）", threw != null)
      assertTrue("异常必须携带 requiredBytes（供用户面显示）", (threw?.requiredBytes ?: 0L) > 0L)
      assertTrue("文案必须含 MB 数字: " + threw?.message, (threw?.message ?: "").contains("MB"))
      assertEquals(
        "预检必须在动树之前：live 未被改动",
        "old-node",
        File(live, "usr/bin/node").readText(),
      )
      assertTrue("live 用户数据必须原样", File(live, "home/.dsh/profiles/web/untouched").exists())
      assertFalse(
        "不得留下任何 previous 残渣（动树之前就该拒绝）",
        SnapshotFs.exists(SnapshotTransaction.previousRoot(filesDir)),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }


  // ── M.2 A（issue #273 ①）可注入判别力：链接三动作 ────────────────────────────────
  //
  // 本机 Windows 无 SeCreateSymbolicLinkPrivilege ⇒ 真建链接的 e2e 只能 SKIP。
  // 按本仓既有范式（swap 的 move/delete/ownerProbe/spaceCheck），把「判链接 / 读目标 / 建链接」
  // 抽成可注入原语后，本机即可行为对照地判红。**反证靠传参，不就地改生产源码。**

  /** 记录型链接替身：记下每一条被当作链接处理的条目及其目标。 */
  private class RecordingLinks(
    private val links: Set<String>,
    private val failOnCreate: Boolean = false,
    private val failOnRead: Boolean = false,
    /** 只让这些目标路径的 createLink 失败（其余成功）——用于「应建 2 / 实建 1」的精确构造。 */
    private val failCreateFor: Set<String> = emptySet(),
  ) : SnapshotTransaction.LinkPrimitives {
    val created = LinkedHashMap<String, String>()
    val readTargets = LinkedHashMap<String, String>()

    override fun isLink(file: File): Boolean = file.absolutePath in links

    override fun linkTargetOf(file: File): java.nio.file.Path {
      if (failOnRead) throw java.io.IOException("synthetic read-link failure")
      readTargets[file.absolutePath] = LINK_TARGET_TEXT
      return java.nio.file.Paths.get(LINK_TARGET_TEXT)
    }

    override fun createLink(dest: File, target: java.nio.file.Path) {
      if (failOnCreate || dest.absolutePath in failCreateFor) {
        throw java.io.IOException("synthetic create-link failure")
      }
      created[dest.absolutePath] = target.toString()
      // 本机建不了真链接：落一个**占位条目**，让备份树的条目数与源齐平，
      // 否则 verifyBackupComplete 会把「对账不齐」判成失败（那会掩盖本用例要验的语义）。
      dest.parentFile?.mkdirs()
      dest.writeText("") // 0 字节：与源侧空条目字节数齐平，避免对账误报
    }
  }


  /** 造一棵带「链接」的 profiles 树；返回被替身认作链接的那个条目路径。 */
  private fun writeProfilesWithFakeLink(root: File): String {
    File(root, "home/.dsh/profiles/web").mkdirs()
    File(root, "home/.dsh/profiles/web/cordis.yml").writeText("marker")
    val nm = File(root, "home/.dsh/profiles/web/node_modules")
    nm.mkdirs()
    // 替身把 `dep` 认作链接；真实文件系统上它只是个**空文件**（本机没有建链权限）。
    // 用空文件而非目录：verifyBackupComplete 会对账字节数，空文件的字节数是确定的 0。
    File(nm, "dep").writeText("")
    return File(nm, "dep").absolutePath
  }

  /**
   * 正例（A，可注入）：源里的链接必须被 [SnapshotTransaction.LinkPrimitives.createLink]
   * 重建，且目标名与源**逐字相同**；不得退化成按普通文件拷贝。
   */
  @Test
  fun strictCopyRebuildsLinksThroughTheInjectableSeam() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val linkPath = writeProfilesWithFakeLink(live)
      val links = RecordingLinks(links = setOf(linkPath))

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-seam",
        startedAt = 1L,
        links = links,
      )

      assertTrue(
        "链接必须被 createLink 重建（旧实现直接 return，这里恒为空）: " + links.created,
        links.created.isNotEmpty(),
      )
      val createdTarget = links.created.values.single()
      // 断言守的是「**同一个目标**」——没被解析成绝对路径、没被改名；**不是**同一个字面串。
      // 原因：Windows 的 `Path.toString()` 用反斜杠（`.pnpm\real-dep`），而源是 POSIX 形态的
      // `.pnpm/real-dep`。Android 上源是真正的 POSIX 符号链接，分隔符只会是 `/`；
      // 这里按 **Path 语义**比较，避免在非 Android 平台上误报（本轮实测：该断言曾在 Windows 判红）。
      assertEquals(
        "重建的链接目标必须是同一个目标（不得解析成绝对路径或改成别的名字）",
        java.nio.file.Paths.get(LINK_TARGET_TEXT),
        java.nio.file.Paths.get(createdTarget),
      )
      assertFalse(
        "重建的链接目标不得被解析成绝对路径: " + createdTarget,
        java.nio.file.Paths.get(createdTarget).isAbsolute,
      )
      assertTrue(
        "重建的落点必须在备份树内部（.snapshot-previous/...）: " + links.created.keys,
        links.created.keys.single().contains(".snapshot-previous"),
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 反例（A，可注入）：若把判据换成「一律当普通文件」（= 旧行为），本用例必须判红。
   * 传一个**永不认链接**的替身即等价于旧实现。
   */
  @Test
  fun noLinkPrimitiveCallMeansTheOldBehaviourAndFailsThisContract() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      writeProfilesWithFakeLink(live)
      // 空集合 = 一个链接都不认 = 旧实现「跳过链接」的等价物
      val links = RecordingLinks(links = emptySet())

      SnapshotTransaction.swap(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = File(live, "usr"),
        homeDir = File(live, "home"),
        preservedNames = preserved,
        fingerprint = "fp-old",
        startedAt = 1L,
        links = links,
      )

      assertEquals(
        "旧行为（不认链接）下 createLink 恒不被调用 —— 这正是缺陷的形态",
        0,
        links.created.size,
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 反例（A，可注入）：`createLink` 抛 IOException 时，严格拷贝**必须向上冒错**，
   * 不得静默跳过（静默跳过正是本缺陷的成因，也是 CP-B 那类「静默造出假绿」的同型面）。
   */
  @Test
  fun linkCreateFailurePropagatesInsteadOfBeingSilentlySkipped() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val linkPath = writeProfilesWithFakeLink(live)
      val links = RecordingLinks(links = setOf(linkPath), failOnCreate = true)

      var thrown: Throwable? = null
      try {
        SnapshotTransaction.swap(
          filesDir = filesDir,
          stagedRoot = stage,
          usrDir = File(live, "usr"),
          homeDir = File(live, "home"),
          preservedNames = preserved,
          fingerprint = "fp-fail",
          startedAt = 1L,
          links = links,
        )
      } catch (t: Throwable) {
        thrown = t
      }
      assertTrue(
        "建链接失败必须向上冒错（静默跳过会让备份合法地残缺，正是 #273 的成因）",
        thrown != null,
      )
      // 真因必须可诊断：异常链里应能找到那条合成失败。
      val chain = generateSequence(thrown) { it.cause }.toList()
      assertTrue(
        "真因必须保留在异常链里（不得被补偿动作掩盖）: " + chain.map { it.javaClass.simpleName },
        chain.any { it.message?.contains("synthetic create-link failure") == true },
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 安全面（issue #273 ① 追问的 (ii)）：建链接抛错时，
   *  (a) live/profiles 子树必须**逐条目未变**（不得扩大破坏面）；
   *  (b) 未完成的备份 .copying 不得被当成可用回滚点。
   *
   * 背景：`usr` 的替换**早于** profiles 合并（swap L470 < L492），故抛错时事务已进入
   * 「必须靠回滚收场」的状态；但 profiles 子树有结构性保证（拷贝目标是 .copying 临时名、
   * 且 profiles 直到 L701 才进 journal）。本条把这个保证钉成断言。
   */
  @Test
  fun linkCreateFailureLeavesLiveProfilesUntouchedAndNoUsableBackup() {
    val filesDir = tempDir()
    try {
      val live = File(filesDir, "live").apply { mkdirs() }
      val stage = SnapshotTransaction.stageRoot(filesDir)
      writeRuntime(live, "old-node", "old-profile")
      writeRuntime(stage, "new-node", "new-profile")
      val linkPath = writeProfilesWithFakeLink(live)
      // 抛错前给 profiles 加一个用户文件，并记录逐条目快照。
      val profiles = File(live, "home/.dsh/profiles")
      File(profiles, "web/user-keep.txt").writeText("must survive")
      val beforeStats = SnapshotFs.treeStats(profiles)
      fun snapshot(): Map<String, String> = profiles.walkTopDown()
        .filter { SnapshotFs.exists(it) }
        .associate { it.absolutePath to (if (it.isFile) it.readText() else "<dir>") }
      val before = snapshot()

      val links = RecordingLinks(links = setOf(linkPath), failOnCreate = true)
      var thrown: Throwable? = null
      try {
        SnapshotTransaction.swap(
          filesDir = filesDir,
          stagedRoot = stage,
          usrDir = File(live, "usr"),
          homeDir = File(live, "home"),
          preservedNames = preserved,
          fingerprint = "fp-safe",
          startedAt = 1L,
          links = links,
        )
      } catch (x: Throwable) {
        thrown = x
      }
      assertTrue("建链接失败必须抛（fail-loud 在建备份面）", thrown != null)

      // (a) live/profiles 逐条目未变。
      val afterStats = SnapshotFs.treeStats(profiles)
      assertEquals("抛错后 live/profiles 条目数不得变", beforeStats.entries, afterStats.entries)
      assertEquals("抛错后 live/profiles 链接数不得变", beforeStats.links, afterStats.links)
      assertEquals("抛错后 live/profiles 字节数不得变", beforeStats.bytes, afterStats.bytes)
      assertEquals("抛错后 live/profiles 逐条目内容不得变", before, snapshot())

      // (b) 未完成的备份不得被当成可用回滚点：marker（若已写）不得声称 profiles。
      val marker = SnapshotTransaction.readMarker(filesDir)
      if (marker != null) {
        assertFalse(
          "抛错早于记账 ⇒ marker 不得声称 profiles: " + marker.moved,
          marker.moved.any { it.contains("profiles") },
        )
      }
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 反证（B 的「可见」验收定义）：回滚收尾期的链接重建是 **fail-soft 但绝不 silent**。
   *
   * **手工构造 previous/staged/live，不走 swap 整链** —— 避免「替身认的树不是 relink 遍历的树」
   * 那类构造性假绿（本用例第一版正是那样：替身认 live 树，而 relink 遍历 staged 树 ⇒ 永不命中）。
   *
   * 关键构造（全部在 Windows 上可复现，无需真实符号链接权限）：
   *  · previous/home/.dsh/profiles/keep.txt —— 备份本体（非空，且**不含** node_modules，
   *    以绕开 verifyPreviousForRollback 对「node_modules 零链接」的拒绝）；
   *  · staged/home/.dsh/profiles/web —— 替身认作「链接」的条目；
   *  · live 侧此时没有 web（备份里本来就没有）⇒ `SnapshotFs.exists(target)` 为假
   *    ⇒ 必须记 expected + shortfall（而不是被 `if (exists(target)) return` 提前跳过）。
   *
   * 断言四条（**全部无条件**，不再用 `if (shortfalls.isNotEmpty())` 包裹 ——
   * 那种写法在空集时整段跳过，等于给假绿发免死金牌）：
   *  (i) live 已由 previous 恢复的内容逐条目不变（soft 没扩大破坏面）；
   *  (ii) 应建 > 实建 的信息**回到调用方**；
   *  (iii) 短缺点名到**条目路径** + 同时出现在 notes（用户可见面）；
   *  (iv) 这次回滚**不被当成干净成功**，但 ok 仍为 true（不制造重试风暴）。
   */
  @Test
  fun relinkShortfallIsSoftButNeverSilent() {
    val filesDir = tempDir()
    try {
      val previous = SnapshotTransaction.previousRoot(filesDir)
      val stage = SnapshotTransaction.stageRoot(filesDir)
      val usrDir = File(filesDir, "live/usr").apply { mkdirs() }
      val homeDir = File(filesDir, "live/home").apply { mkdirs() }

      // previous：非空 profiles，且**不含** web（这样 live 恢复后没有 web ⇒ relink 必须计 expected）。
      val backupProfiles = File(previous, "home/.dsh/profiles")
      backupProfiles.mkdirs()
      File(backupProfiles, "keep.txt").writeText("restored-from-backup")

      // staged：relink 遍历的**源**树，替身在这里命中。
      val stagedProfiles = File(stage, "home/.dsh/profiles")
      stagedProfiles.mkdirs()
      val stagedLink = File(stagedProfiles, "web")
      stagedLink.mkdirs()

      // live 侧先放一份「将被覆盖」的 profiles，验证它确实被 previous 恢复。
      val liveProfiles = File(homeDir, ".dsh/profiles")
      liveProfiles.mkdirs()
      File(liveProfiles, "stale.txt").writeText("should be replaced by backup")

      SnapshotTransaction.writeMarker(
        filesDir,
        SnapshotTransaction.Marker(
          SnapshotTransaction.Phase.SWAPPING,
          "fp-soft",
          1L,
          listOf("home/.dsh/profiles"),
        ),
      )

      // 替身认 stagedLink；createLink 必抛 ⇒ relink 必须记 shortfall 而非抛出。
      val links = RecordingLinks(links = setOf(stagedLink.absolutePath), failOnCreate = true)
      val rollback = SnapshotTransaction.rollback(
        filesDir = filesDir,
        stagedRoot = stage,
        usrDir = usrDir,
        homeDir = homeDir,
        marker = SnapshotTransaction.readMarker(filesDir)!!,
        links = links,
      )

      // (i) 备份内容必须已恢复，且残留的 live 旧文件必须已被换掉。
      assertEquals(
        "previous 的内容必须被恢复出来（soft 的语义是「已恢复」）",
        "restored-from-backup",
        File(liveProfiles, "keep.txt").readText(),
      )
      assertFalse(
        "live 的旧内容必须已被备份替换（回滚确实发生了）",
        File(liveProfiles, "stale.txt").exists(),
      )

      // (iv) 不冒充干净成功，也不报成致命失败（避免 issue #271 的重试风暴）。
      assertTrue("回滚结构恢复应成功（ok=true）: " + rollback.failures, rollback.ok)
      assertFalse("有链接未重建时不得报成干净成功", rollback.isCleanSuccess)

      // (ii) 缺失必须回到调用方 —— **无条件**断言：替身若没命中，这里必须判红。
      assertTrue(
        "应建而未建的链接必须回到调用方（替身未命中时本断言判红，不得静默通过）: "
          + rollback.relinkShortfalls,
        rollback.relinkShortfalls.isNotEmpty(),
      )
      // (iii) 点名到条目路径 + 同时出现在用户可见面（notes）。
      assertTrue(
        "短缺点名必须到条目路径（不能只是一个数字）: " + rollback.relinkShortfalls,
        // shortfall 记的是**目标**（live 侧）路径——那是「应该建在哪」，排障要用它。
        rollback.relinkShortfalls.any { it.contains(File(liveProfiles, "web").absolutePath) },
      )
      assertTrue(
        "短缺点必须带失败原因: " + rollback.relinkShortfalls,
        rollback.relinkShortfalls.any { it.contains("createSymbolicLink") },
      )
      assertTrue(
        "缺失必须同时出现在 notes（用户可见面）: " + rollback.notes,
        rollback.notes.any { it.contains("未重建") },
      )
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }

  /**
   * 纯判据单测（不依赖 swap/rollback 整链）：`relinkFromStaged` 的「应建 vs 实建」语义。
   *
   * 为什么必须独立一条：整链用例（relinkShortfallIsSoftButNeverSilent）会被体检/记账/回滚等
   * 多重前置影响；本用例**只**构造「源树 2 条链接、其中 1 条建失败」，直接断言计数与点名。
   *
   * 访问方式：`relinkFromStaged` 是 `private`（生产面本轮已冻结，不改可见性），故用反射调用。
   * 反射是为了**不为了测试去动生产面的可见性**；若后续你允许改 `internal`，这条可去掉反射。
   */
  @Test
  fun relinkOutcomeCountsExpectedVersusRestoredPerEntry() {
    val filesDir = tempDir()
    try {
      val staged = File(filesDir, "staged/home/.dsh/profiles").apply { mkdirs() }
      val live = File(filesDir, "live/home/.dsh/profiles").apply { mkdirs() }
      // 源树三条：两条「链接」（替身认）、一条普通文件（不得计入 expected）。
      val linkA = File(staged, "a").apply { mkdirs() }
      val linkB = File(staged, "b").apply { mkdirs() }
      File(staged, "plain.txt").writeText("not-a-link")
      // live 侧已有 a（不需要重建，故不进 expected），缺 b。
      File(live, "a").mkdirs()

      val links = RecordingLinks(
        links = setOf(linkA.absolutePath, linkB.absolutePath),
        failCreateFor = setOf(File(live, "b").absolutePath),
      )
      val method = SnapshotTransaction::class.java.getDeclaredMethod(
        "relinkFromStaged", File::class.java, File::class.java, SnapshotTransaction.LinkPrimitives::class.java,
      ).apply { isAccessible = true }
      val outcome = method.invoke(SnapshotTransaction, staged, live, links) as SnapshotTransaction.RelinkOutcome

      assertEquals("应建数 = live 缺的那一条（已存在的 a 不计）", 1, outcome.expected)
      assertEquals("实建数 = 0（b 的 createLink 必抛）", 0, outcome.restored)
      assertEquals("缺失恰好一条", 1, outcome.shortfalls.size)
      assertTrue(
        "短缺点名到目标路径: " + outcome.shortfalls,
        outcome.shortfalls.single().contains(File(live, "b").absolutePath),
      )
      assertTrue(
        "短缺点名到失败原因: " + outcome.shortfalls,
        outcome.shortfalls.single().contains("createSymbolicLink"),
      )
      assertFalse("有缺失时 complete 必须为 false", outcome.complete)

      // 反向对照：换一个「都建成功」的替身，expected=1 / restored=1 / complete=true。
      val okLinks = RecordingLinks(links = setOf(linkA.absolutePath, linkB.absolutePath))
      val okOutcome = method.invoke(SnapshotTransaction, staged, live, okLinks) as SnapshotTransaction.RelinkOutcome
      assertEquals("成功的应建数", 1, okOutcome.expected)
      assertEquals("成功的实建数", 1, okOutcome.restored)
      assertTrue("无缺失时 complete 必须为 true", okOutcome.complete)
    } finally {
      SnapshotFs.deletePath(filesDir)
    }
  }
}