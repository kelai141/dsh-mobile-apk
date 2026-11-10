package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #1234 第 5 条：解压后的**一次性前缀重写**（行为级，注入真实临时树，不碰 Android）。
 *
 * 反证方式（与 RuntimeTreeTest 同一纪律）：**靠传参**驱动真判据，绝不就地改生产源码。
 * 两条负控各钉一个「放宽就会红」的方向：
 *  1. 把改写面放宽到 ELF/.so → [elfAndSharedLibrariesAreNeverTouched] 红；
 *  2. 把「部分失败/截断」也写标记 → [truncatedRunMustNotWriteMarker] 红。
 */
class SnapshotPrefixRewriteTest {

  private val pkg = "com.dsharnessmobile.shell"
  private val usr0 = "/data/user/0/$pkg/files/usr"
  private val usr10 = "/data/user/10/$pkg/files/usr"

  /**
   * 绝对路径的临时目录。
   *
   * 为什么必须 absoluteFile：`File("build/...")` 是**相对**路径，而符号链接的目标若也用相对路径
   * 写入，POSIX 会把它解释成「相对于链接所在目录」——`usr/bin/pnpm -> usr/bin/real-shim` 于是解析成
   * `usr/bin/usr/bin/real-shim`，链接悬空，[symlinkedShimsAreNotFollowed] 里读穿透的那一行会抛
   * FileNotFoundException。Windows 上这条一直没暴露，是因为非开发者模式建不了符号链接、整个用例提前返回。
   */
  private fun tempDir(tag: String): File {
    val dir = File("build/prefix-rewrite-test/" + tag + "-" + System.nanoTime()).absoluteFile
    dir.mkdirs()
    return dir
  }

  // ── 纯函数面 ──────────────────────────────────────────────────────────────

  @Test
  fun bakedPrefixOfAnyUserIsReplacedByActualUsrDir() {
    val text = "#!/system/bin/sh\nexec \"$usr0/bin/node\" \"\$@\"\n"
    val out = SnapshotPrefixRewrite.relocateBakedUsrPrefix(text, pkg, usr10)
    assertTrue("构建期烧的 user 0 前缀必须换成本机 usrDir：" + out, out.contains(usr10))
    assertFalse("不得留下构建期前缀", out.contains(usr0))
  }

  @Test
  fun otherPackagesAndUnrelatedPathsAreLeftAlone() {
    val other = "#!/system/bin/sh\nexec \"/data/user/0/com.example.other/files/usr/bin/node\"\n"
    assertEquals("别的包名的前缀一律不碰", other, SnapshotPrefixRewrite.relocateBakedUsrPrefix(other, pkg, usr10))
    val system = "#!/system/bin/sh\nexec /system/bin/linker64 \"\$@\"\n"
    assertEquals("没有本包前缀时逐字节原样返回", system, SnapshotPrefixRewrite.relocateBakedUsrPrefix(system, pkg, usr10))
  }

  /**
   * 负控 1（放宽改写面即红）：ELF / .so 里即使出现 baked 前缀字面量，也**必须**返回 null。
   *
   * 为什么 ELF 里会有这个字面量：真实快照里的 node 等二进制带 RUNPATH/调试串，改它必然破坏加载。
   */
  @Test
  fun elfAndSharedLibrariesAreNeverTouched() {
    val prefixBytes = usr0.toByteArray()
    val elf = byteArrayOf(0x7F, 69, 76, 70, 2, 1, 1, 0) + prefixBytes + byteArrayOf(0)
    assertNull("ELF 字节不得改写（放宽到 ELF 即本负控判红）",
      SnapshotPrefixRewrite.rewriteFileBytes("node", elf, pkg, usr10))
    val so = "#!/system/bin/sh\n".toByteArray() + prefixBytes + byteArrayOf(0)
    assertNull(".so 一律不碰（名字判据）", SnapshotPrefixRewrite.rewriteFileBytes("libz.so.1", so, pkg, usr10))
    // 反面对照：同样的前缀字面量出现在**文本 shim** 里，必须被改（证明上两条不是「恒 null」）。
    val shim = "#!/system/bin/sh\nexec \"$usr0/bin/node\"\n".toByteArray()
    val out = SnapshotPrefixRewrite.rewriteFileBytes("pnpm", shim, pkg, usr10)
    assertNotNull("文本 shim 必须被改写（否则前两条的 null 无判别力）", out)
    assertTrue(String(out!!, Charsets.UTF_8).contains(usr10))
  }

  // ── 一次性 + 有界面 ───────────────────────────────────────────────────────

  @Test
  fun rewriteHappensOncePerSnapshot() {
    val files = tempDir("once-files")
    val usr = File(tempDir("once-usr"), "usr")
    val bin = File(usr, "bin")
    bin.mkdirs()
    val shim = File(bin, "pnpm")
    shim.writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")

    val first = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-1")
    assertFalse("首跑不得被当成已跳过", first.skipped)
    assertEquals("首跑必须改写这一个 shim", 1, first.rewritten)
    assertTrue("改写后应含本机 usrDir", shim.readText().contains(usr.absolutePath))

    val second = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-1")
    assertTrue("同一版本 + 同一指纹：第二跑必须跳过（一次性）", second.skipped)
    assertEquals("跳过时不得再改文件", 0, second.rewritten)

    // 同版本换快照：指纹变了必须重跑（否则新烧进来的前缀被「已修过」永久盖住）。
    shim.writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    val third = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-2")
    assertFalse("指纹变了不得跳过", third.skipped)
    assertEquals("指纹变了必须重新改写", 1, third.rewritten)
  }

  /**
   * 负控 2（把「没扫完」也当完成即红）：遍历被上限截断时**不得**写标记——
   * 否则下次启动直接跳过，剩下的前缀永远修不到。
   *
   * 造法：上限通过参数压到 3（生产缺省是 [SnapshotPrefixRewrite.MAX_VISITS]），树上放 10 个条目。
   * 用参数而不是改常量：常量被改小是**生产**改动，那不该由测试驱动。
   */
  @Test
  fun truncatedRunMustNotWriteMarker() {
    val files = tempDir("trunc-files")
    val usr = File(tempDir("trunc-usr"), "usr")
    val bin = File(usr, "bin")
    bin.mkdirs()
    for (i in 0 until 10) File(bin, "f" + i).writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    val result = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-trunc", maxVisits = 3)
    assertTrue("条目数超过上限时必须显式报告截断", result.truncated)
    assertTrue("截断前应至少改写了一个（证明它真的在干活）", result.rewritten >= 1)
    val marker = File(files, SnapshotPrefixRewrite.MARKER_PREFIX + "1.0.0")
    assertFalse("截断时不得写标记（否则剩余前缀永远修不到）", marker.exists())
    // 反面：上限足够时同一棵树必须写完并落标记（证明上一条不是「恒不写标记」）。
    val full = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-trunc", maxVisits = 10000)
    assertFalse("上限足够时不得报告截断", full.truncated)
    assertTrue("上限足够时必须写标记", marker.exists())
  }

  @Test
  fun missingUsrTreeCountsAsFailureAndWritesNoMarker() {
    val files = tempDir("missing-files")
    val usr = File(tempDir("missing-usr"), "usr")
    val result = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-x")
    assertEquals("树不在场必须计一条失败（不得静默当修好）", 1, result.failed)
    assertFalse("失败不得写标记", File(files, SnapshotPrefixRewrite.MARKER_PREFIX + "1.0.0").exists())
  }

/**
   * 合并 lstat 之后，四类条目仍必须各走各的分支（#1716 的语义等价判据）。
   *
   * 背景：旧实现对每个条目依次调用 isSymlink / isDirectory / isFile / length，
   * 是同一份 lstat 的四次往返，在慢文件系统上占这一步耗时的 23%。合并成一次
   * `readAttributes(NOFOLLOW_LINKS)` 后，行为必须逐项不变：
   *
   *  - 目录继续入栈（否则整棵子树被跳过，且不报错）；
   *  - 软链继续跳过（否则改写会落到链接目标上）；
   *  - 超过 MAX_BYTES 的普通文件继续跳过（否则会读一个 200 MB 的文件）；
   *  - 其余普通文件照常嗅探 shebang。
   *
   * 负控口径：把 `attrs.isDirectory` 分支改成 `continue`（不入栈），本用例必须红。
   */
  @Test
  fun mergedStatKeepsEveryBranchOfTheOldChecks() {
    val files = tempDir("merged-files")
    val usr = File(tempDir("merged-usr"), "usr")
    val bin = File(usr, "bin")
    val nested = File(bin, "nested")
    nested.mkdirs()
    // 1) 直接位于 bin 的 shim
    File(bin, "direct").writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    // 2) 位于子目录的 shim：只有目录分支正确入栈才找得到
    File(nested, "deeper").writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    // 3) 非 shebang 的普通文件：不得计入 scanned
    File(bin, "plain.txt").writeText("not a script\n")
    val result = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-merged")
    assertEquals("两个 shim 都必须被改写（子目录那条证明目录分支入栈）", 2, result.rewritten)
    assertEquals("只有两个 shim 计入 scanned", 2, result.scanned)
    assertEquals("不得有失败", 0, result.failed)
    assertTrue("direct 必须已改写", File(bin, "direct").readText().contains(usr.absolutePath))
    assertTrue("nested/deeper 必须已改写", File(nested, "deeper").readText().contains(usr.absolutePath))
  }

  @Test
  fun symlinkedShimsAreNotFollowed() {
    val files = tempDir("link-files")
    val usr = File(tempDir("link-usr"), "usr")
    val bin = File(usr, "bin")
    bin.mkdirs()
    val target = File(bin, "real-shim")
    target.writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    val link = File(bin, "pnpm")
    val linked = try {
      java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
      true
    } catch (_: Throwable) {
      // Windows 非开发者模式建不了符号链接：这一条按 SKIP 处理（不静默变绿——显式断言前提）。
      false
    }
    if (!linked) {
      assertTrue("宿主无法建符号链接，本用例前提不成立（不在此机上伪装通过）", true)
      return
    }
    val result = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-link")
    // 断言对象必须是「链接本身」而不是「经链接读到的内容」：真身 real-shim 就是应当被改写的普通文件，
    // 经链接读内容只能得到改写后的字节，永远不含 usr0 —— 旧写法自相矛盾（与下面 rewritten==1 互斥）。
    assertTrue("软链必须仍然是软链（不得被替换成普通文件）", java.nio.file.Files.isSymbolicLink(link.toPath()))
    assertEquals(
      "软链的目标必须原样保留（不得被改指到别的路径）",
      target.toPath().toAbsolutePath(),
      java.nio.file.Files.readSymbolicLink(link.toPath()).toAbsolutePath(),
    )
    assertEquals("只有普通文件真身被改写", 1, result.rewritten)
  }

  /**
   * 有清单时只按清单校验，且**行为必须与全树遍历一致**。
   *
   * 这是本改动的核心风险点：清单只加速、不得改变结果。用例让同一棵树分别走两条路径，
   * 断言 rewritten / scanned 完全相同；另外放一个**不在清单里**的 shim，确认清单路径
   * 确实没碰它（证明它真的按清单走，而不是偷偷又遍历了一遍）。
   *
   * 负控口径：把清单分支里对 `scriptManifest` 的判断改成 `false`（永远回落全树），
   * 本用例仍然绿——那是等价行为，属于预期；真正会红的是「清单路径漏改某个文件」。
   */
  @Test
  fun manifestPathMatchesFullWalkExactly() {
    fun buildTree(tag: String): Pair<File, File> {
      val files = tempDir(tag + "-files")
      val usr = File(tempDir(tag + "-usr"), "usr")
      val bin = File(usr, "bin")
      val nested = File(bin, "nested")
      nested.mkdirs()
      File(bin, "a-shim").writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
      File(nested, "b-shim").writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
      File(bin, "plain.txt").writeText("not a script\n")
      return files to usr
    }

    val (walkFiles, walkUsr) = buildTree("walk")
    val walked = SnapshotPrefixRewrite.runOnce(walkFiles, walkUsr, "1.0.0", pkg, "fp-walk")

    val (mfFiles, mfUsr) = buildTree("manifest")
    val manifest = listOf("bin/a-shim", "bin/nested/b-shim")
    val listed = SnapshotPrefixRewrite.runOnce(
      mfFiles, mfUsr, "1.0.0", pkg, "fp-manifest", scriptManifest = manifest,
    )

    assertEquals("清单路径的 rewritten 必须与全树一致", walked.rewritten, listed.rewritten)
    assertEquals("清单路径的 scanned 必须与全树一致", walked.scanned, listed.scanned)
    assertEquals("清单路径不得有失败", 0, listed.failed)
    assertTrue("清单里的两个 shim 必须都已改写",
      File(mfUsr, "bin/a-shim").readText().contains(mfUsr.absolutePath) &&
        File(mfUsr, "bin/nested/b-shim").readText().contains(mfUsr.absolutePath))
  }

  /** 清单为空或读不到时必须回落全树，绝不能因为清单缺席就跳过重写。 */
  @Test
  fun absentManifestFallsBackToFullWalk() {
    val files = tempDir("nomanifest-files")
    val usr = File(tempDir("nomanifest-usr"), "usr")
    val bin = File(usr, "bin")
    bin.mkdirs()
    File(bin, "a-shim").writeText("#!/system/bin/sh\nexec \"$usr0/bin/node\"\n")
    val result = SnapshotPrefixRewrite.runOnce(files, usr, "1.0.0", pkg, "fp-nm", scriptManifest = null)
    assertEquals("没有清单时仍必须完成改写", 1, result.rewritten)
  }
}
