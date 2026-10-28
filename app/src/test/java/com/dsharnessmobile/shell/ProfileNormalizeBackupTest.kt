package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * issue #608 的回归面：归一化迁移的**备份纪律**。
 *
 * 缺陷形态：旧实现只在「备份路径不存在」时写备份。路径已经存在时，无论它是目录还是不完整
 * 文件，都被当成「本次已有备份」继续发布归一后的配置——live 被改了，却没有任何一份属于**本次
 * 原文**的回滚副本。
 *
 * 判据不是「备份路径存在」，而是「存在一份与本次原文逐字节相同、且同步落盘的普通文件」。
 * 另一半是有界性：备份不能无限增长，失败尝试也不能把成功备份挤掉。
 */
class ProfileNormalizeBackupTest {

  @get:Rule val temporary = TemporaryFolder()

  private fun target() = File(temporary.newFolder(), "cordis.patch.yml").apply { writeText("live-original\n") }

  // ── 可判定性：无效的历史残留不能冒充本次备份 ──────────────────────────────

  /** #608 实测形态一：备份路径被占成**目录**。目录不可能是回滚来源。 */
  @Test
  fun historicalDirectoryIsNotAValidBackup() {
    val live = target()
    val old = File(live.parentFile, live.name + ".pre-" + BuildConfig.VERSION_NAME + "-0000000000001.bak")
    assertTrue(old.mkdir())
    assertFalse("目录不能当作备份", ProfileNormalizeBackup.isValid(old, "live-original\n"))
  }

  /** #608 实测形态二：备份路径上是**不完整文件**。 */
  @Test
  fun partialHistoricalBackupIsNotAValidBackup() {
    val live = target()
    val old = File(live.parentFile, live.name + ".pre-" + BuildConfig.VERSION_NAME + "-0000000000001.bak")
    old.writeText("partial")
    assertFalse("内容不相同不能当作本次备份", ProfileNormalizeBackup.isValid(old, "live-original\n"))
  }

  /** 长度相同但内容不同也必须判无效：只看大小会漏掉同长度的陈旧副本。 */
  @Test
  fun sameLengthButDifferentBytesIsNotAValidBackup() {
    val live = target()
    val old = File(live.parentFile, live.name + ".pre-" + BuildConfig.VERSION_NAME + "-0000000000001.bak")
    old.writeText("live-originaL\n")
    assertEquals("前提：长度必须相同", "live-original\n".length, "live-originaL\n".length)
    assertFalse(ProfileNormalizeBackup.isValid(old, "live-original\n"))
  }

  /** 每份备份都属于**它那一次**的原文，不会把上一轮的原文当成本轮的。 */
  @Test
  fun everyAttemptKeepsItsOwnPriorText() {
    val live = target()
    val first = ProfileNormalizeBackup.write(live, "first\n", failed = false, now = 1_000)
    val second = ProfileNormalizeBackup.write(live, "second\n", failed = false, now = 2_000)
    assertEquals("first\n", first.readText())
    assertEquals("second\n", second.readText())
    assertTrue(ProfileNormalizeBackup.isValid(first, "first\n"))
    assertFalse("第一份不能冒充第二份的回滚来源", ProfileNormalizeBackup.isValid(first, "second\n"))
  }

  // ── 有界性：保留最近 N 份，且失败与成功分开算 ───────────────────────────

  @Test
  fun successfulBackupsAreCappedAtTheDocumentedLimit() {
    val live = target()
    repeat(ProfileNormalizeBackup.KEEP_ATTEMPTS + 4) { i ->
      ProfileNormalizeBackup.write(live, "attempt-" + i + "\n", failed = false, now = 1_000L + i)
    }
    assertEquals(
      "成功备份必须被裁到上限：" + ProfileNormalizeBackup.KEEP_ATTEMPTS,
      ProfileNormalizeBackup.KEEP_ATTEMPTS,
      ProfileNormalizeBackup.successfulBackups(live).size,
    )
  }

  /** 裁剪必须**留最近的**：上限内保留的是最后 N 次原文，不是最早的。 */
  @Test
  fun pruningKeepsTheMostRecentAttempts() {
    val live = target()
    repeat(ProfileNormalizeBackup.KEEP_ATTEMPTS + 3) { i ->
      ProfileNormalizeBackup.write(live, "attempt-" + i + "\n", failed = false, now = 1_000L + i)
    }
    val kept = ProfileNormalizeBackup.successfulBackups(live).map { it.readText() }
    val total = ProfileNormalizeBackup.KEEP_ATTEMPTS + 3
    val expected = (total - ProfileNormalizeBackup.KEEP_ATTEMPTS until total).map { "attempt-" + it + "\n" }
    assertEquals("必须保留最近的 N 次原文", expected, kept)
  }

  /**
   * lead 追加要求：**失败备份不能挤掉成功备份**。
   *
   * 连续 3 次失败尝试（每次都落一份 `-failed` 备份）之后再做 1 次成功尝试，那份成功备份
   * 必须还在；失败配额与成功配额各自独立。
   */
  @Test
  fun failedAttemptsNeverEvictTheSuccessfulBackup() {
    val live = target()
    val good = ProfileNormalizeBackup.write(live, "the-one-good\n", failed = false, now = 1_000)
    repeat(ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS + 2) { i ->
      ProfileNormalizeBackup.write(live, "failed-" + i + "\n", failed = true, now = 2_000L + i)
    }
    val survivors = ProfileNormalizeBackup.successfulBackups(live)
    assertTrue("连续失败后成功备份必须仍在", survivors.contains(good))
    assertEquals("the-one-good\n", good.readText())
    assertEquals(
      "失败备份单独计数、不挤占成功配额",
      ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS,
      ProfileNormalizeBackup.failedBackups(live).size,
    )
  }

  /** 反向：失败备份自己也有界，不能无限堆。 */
  @Test
  fun failedBackupsAreAlsoCapped() {
    val live = target()
    repeat(ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS + 5) { i ->
      ProfileNormalizeBackup.write(live, "failed-" + i + "\n", failed = true, now = 1_000L + i)
    }
    assertEquals(
      ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS,
      ProfileNormalizeBackup.failedBackups(live).size,
    )
  }

  /** 失败备份必须在文件名上**可区分**，否则排障时分不清哪份对应没生效的尝试。 */
  @Test
  fun failedBackupsAreMarkedInTheirName() {
    val live = target()
    val good = ProfileNormalizeBackup.write(live, "ok\n", failed = false, now = 1_000)
    val bad = ProfileNormalizeBackup.write(live, "bad\n", failed = true, now = 2_000)
    assertTrue("成功备份名里不应带失败标记", !good.name.contains("-failed"))
    assertTrue("失败备份名里必须带失败标记：" + bad.name, bad.name.contains("-failed"))
    assertNotEquals(good.name, bad.name)
  }

  /**
   * 反向锁：裁剪只碰**本对象自己命名**的文件。
   * `repairProfilePatch` 用 UUID 命名的既有多份备份，以及用户自己的文件，都不能被删。
   */
  @Test
  fun pruningDoesNotTouchForeignKeyNamedBackups() {
    val live = target()
    val uuidBackup = File(
      live.parentFile,
      live.name + ".pre-" + BuildConfig.VERSION_NAME + "-" + java.util.UUID.randomUUID() + ".bak",
    ).apply { writeText("uuid-backup\n") }
    val unrelated = File(live.parentFile, "user-notes.txt").apply { writeText("keep me\n") }
    repeat(ProfileNormalizeBackup.KEEP_ATTEMPTS + 3) { i ->
      ProfileNormalizeBackup.write(live, "attempt-" + i + "\n", failed = false, now = 1_000L + i)
    }
    assertTrue("UUID 命名的既有备份不得被裁剪", uuidBackup.isFile)
    assertTrue("与备份无关的文件不得被删", unrelated.isFile)
  }

  /**
   * lead 追加要求：钉住**最坏情况**的目录布局。
   *
   * 3 次成功 + 3 次失败共 6 份同时在场（两边配额都满），此时：
   *  - 成功清单与失败清单互不相交、各 3 份；
   *  - 清单里的每一份都**仍然可解**（能被 isValid 判为某次原文的有效回滚来源）；
   *  - 没有任何一份被 prune 成空壳或残留 tmp。
   * 保留策略最容易出错的就是这里：清单还在、文件却已被裁掉或写成半截。
   */
  @Test
  fun fullQuotaDirectoryStillListsOnlyUsableBackups() {
    val live = target()
    val texts = ArrayList<String>()
    for (i in 0 until ProfileNormalizeBackup.KEEP_ATTEMPTS) {
      val text = "good-" + i + "\n"
      texts += text
      ProfileNormalizeBackup.write(live, text, failed = false, now = 10_000L + i)
    }
    for (i in 0 until ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS) {
      ProfileNormalizeBackup.write(live, "bad-" + i + "\n", failed = true, now = 20_000L + i)
    }

    val good = ProfileNormalizeBackup.successfulBackups(live)
    val bad = ProfileNormalizeBackup.failedBackups(live)
    assertEquals("成功配额应恰好填满", ProfileNormalizeBackup.KEEP_ATTEMPTS, good.size)
    assertEquals("失败配额应恰好填满", ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS, bad.size)
    assertTrue("两个清单不得有交集", good.intersect(bad.toSet()).isEmpty())
    assertEquals("磁盘上不得有别的一等备份文件", 6, good.size + bad.size)

    // 每一份都必须仍然可用：能对上一份真实原文。
    val goodTexts = good.map { it.readText() }.toSet()
    assertEquals("成功清单里的每份都必须是某次原文", texts.toSet(), goodTexts)
    for (file in good) {
      assertTrue("备份必须仍可按其原文校验：" + file.name, ProfileNormalizeBackup.isValid(file, file.readText()))
      assertTrue("备份不得是空壳：" + file.name, file.length() > 0)
      assertTrue("备份不得残留 tmp 后缀：" + file.name, file.name.endsWith(".bak"))
    }
    for (file in bad) {
      assertTrue("失败备份也必须可读：" + file.name, file.length() > 0)
    }
  }

  /**
   * 最坏情况的**下一轮**：两组配额都满时再来一次成功尝试，必须只掉一份失败以外的成功备份，
   * 失败清单原样不动，且新备份立即进入清单尾部。
   */
  @Test
  fun fullQuotaThenAnotherSuccessOnlyEvictsTheOldestSuccess() {
    val live = target()
    repeat(ProfileNormalizeBackup.KEEP_ATTEMPTS) { i ->
      ProfileNormalizeBackup.write(live, "good-" + i + "\n", failed = false, now = 10_000L + i)
    }
    repeat(ProfileNormalizeBackup.KEEP_FAILED_ATTEMPTS) { i ->
      ProfileNormalizeBackup.write(live, "bad-" + i + "\n", failed = true, now = 20_000L + i)
    }
    val badBefore = ProfileNormalizeBackup.failedBackups(live).map { it.name }

    val newest = ProfileNormalizeBackup.write(live, "good-newest\n", failed = false, now = 30_000)

    val good = ProfileNormalizeBackup.successfulBackups(live)
    assertEquals(ProfileNormalizeBackup.KEEP_ATTEMPTS, good.size)
    assertEquals("失败清单必须原样不动", badBefore, ProfileNormalizeBackup.failedBackups(live).map { it.name })
    assertEquals("最新一次必须在清单尾部", newest.name, good.last().name)
    assertTrue("最早的那份应被挤掉", good.none { it.readText() == "good-0\n" })
    assertEquals("淘汰后剩下的应是 good-1/good-2/good-newest",
      listOf("good-1\n", "good-2\n", "good-newest\n"), good.map { it.readText() })
  }

  /** 内容一致才可当回滚来源；刚写出来的备份必须立刻通过这条判据（同步落盘的证据）。 */
  @Test
  fun freshlyWrittenBackupIsImmediatelyUsable() {
    val live = target()
    val text = "- id: agent-default-model\n  disabled: true\n"
    val backup = ProfileNormalizeBackup.write(live, text, failed = false, now = 5_000)
    assertTrue("刚写的备份必须立即可用", ProfileNormalizeBackup.isValid(backup, text))
  }

  // ── 跨版本收尾：旧版本前缀的备份在 prune 时被收走（2026-10-28 扫描 M1）───────────────

  /**
   * 备份名带 [BuildConfig.VERSION_NAME]，升级后旧前缀的文件不再被 [managed] 计数——
   * 不收走的话每升一版漏一批孤儿 .bak，与有界保留的意图矛盾。prune（经 write 触发）
   * 必须把它们收走，同时当前版本配额原样工作。
   */
  @Test
  fun backupsFromPriorVersionsAreSweptOnPrune() {
    val live = target()
    val staleSuccess = File(live.parentFile, live.name + ".pre-0.0.1-0000000000099.bak")
    staleSuccess.writeText("older-version-attempt\n")
    val staleFailed = File(live.parentFile, live.name + ".pre-0.0.1-0000000000100-failed.bak")
    staleFailed.writeText("older-version-failure\n")

    ProfileNormalizeBackup.write(live, "current-attempt\n", failed = false, now = 1_000)

    assertFalse("旧版本成功备份必须被收走", staleSuccess.exists())
    assertFalse("旧版本失败备份必须被收走", staleFailed.exists())
    assertEquals("当前版本配额照常", 1, ProfileNormalizeBackup.successfulBackups(live).size)
  }

  /** 收尾只动本对象命名样式（.pre-<版本>-<13位序号>[.failed].bak）的文件，同目录邻居绝不碰。 */
  @Test
  fun versionSweepSparesFilesThatDoNotMatchTheManagedShape() {
    val live = target()
    val pending = File(live.parentFile, live.name + ".normalize-pending-3f2b1c9d-1e2f-4a5b-8c7d-6e5f4a3b2c1d.bak")
    pending.writeText("pending original\n")
    val notASequence = File(live.parentFile, live.name + ".pre-0.0.1-not-a-13-digit-sequence.bak")
    notASequence.writeText("repair-style residue\n")

    ProfileNormalizeBackup.write(live, "current-attempt\n", failed = false, now = 1_000)

    assertTrue("pending 原文必须保留", pending.exists())
    assertTrue("非 13 位序号的文件不属于本对象命名空间", notASequence.exists())
  }
}
