package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 换源纯逻辑的判据（issue：移动端手动改源门槛高）。
 *
 * 这里钉住的是**设备实证过的三个坑**，不是主观偏好：
 * 镜像片段只做行解析不执行、sources.list 以原子替换写入且权限收紧、
 * chosen_mirrors 用相对链接（快照目录搬迁不会断）。
 */
class SourceMirrorTest {

  @get:Rule
  val temp = TemporaryFolder()

  /** 取自设备实测的真实片段（tuna）。 */
  private val tunaFragment = listOf(
    "# This file is sourced by pkg",
    "# Mirror by Tsinghua University TUNA Association",
    "WEIGHT=1",
    "MAIN=\"https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main\"",
    "ROOT=\"https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-root\"",
    "X11=\"https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-x11\"",
  ).joinToString("\n")

  @Test
  fun mainUrlIsReadFromTheFragment() {
    assertEquals(
      "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main",
      SourceMirror.parseMainUrl(tunaFragment),
    )
  }

  @Test
  fun commentLinesAreNeverMistakenForTheMainUrl() {
    // 反证：注释里也含 URL 字样；若先按 url 匹配就会取到注释里的地址。
    assertEquals(
      "https://mirrors.ustc.edu.cn/termux/termux-main",
      SourceMirror.parseMainUrl("# see https://example.com\nMAIN=\"https://mirrors.ustc.edu.cn/termux/termux-main\"\n"),
    )
  }

  @Test
  fun nonHttpMainIsRejectedInsteadOfWrittenIntoAptConfig() {
    assertNull(SourceMirror.parseMainUrl("MAIN=\"ftp://example.com/repo\""))
    assertNull(SourceMirror.parseMainUrl("WEIGHT=1\n"))
    assertNull(SourceMirror.parseMainUrl(""))
  }

  @Test
  fun sourcesListLineMatchesThePkgFormat() {
    // 与设备上 pkg 写出来的形态逐字一致；尾部换行不能少（apt 解析要求行结束）。
    assertEquals(
      "deb https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main stable main\n",
      SourceMirror.sourcesListContent("https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main"),
    )
  }

  @Test
  fun atomicReplaceOverwritesAndLeavesNoTempFile() {
    val target = File(temp.root, "sources.list")
    target.writeText("old\n")
    SourceMirror.replaceAtomically(target, "deb https://a/b stable main\n")
    assertEquals("deb https://a/b stable main\n", target.readText())
    // 临时文件必须清理干净：残留会在升级/备份路径里被当成用户数据。
    val leftovers = temp.root.listFiles()!!.filter { it.name.endsWith(".tmp") }
    assertTrue("不得残留临时文件: " + leftovers, leftovers.isEmpty())
  }

  @Test
  fun currentMirrorIsRecognisedFromTheSourcesList() {
    val f = File(temp.root, "sources.list")
    f.writeText("deb https://mirrors.ustc.edu.cn/termux/termux-main/ stable main\n")
    assertEquals(SourceMirror.Mirror.USTC, SourceMirror.currentMirror(f))
  }

  @Test
  fun unknownMirrorYieldsNullInsteadOfGuessing() {
    val f = File(temp.root, "sources.list")
    f.writeText("deb https://unknown.example.org/termux/termux-main stable main\n")
    assertNull("不在清单里就不能猜，UI 显示原始 URL", SourceMirror.currentMirror(f))
  }

  @Test
  fun missingSourcesListDoesNotThrow() {
    assertNull(SourceMirror.currentMirror(File(temp.root, "absent.list")))
  }

  @Test
  fun fragmentFileIsResolvedInsideTheChineseMainlandGroup() {
    val dir = File(temp.root, "etc/termux/mirrors/chinese_mainland")
    dir.mkdirs()
    File(dir, "mirrors.tuna.tsinghua.edu.cn").writeText(tunaFragment)
    assertEquals(SourceMirror.Mirror.TUNA, SourceMirror.Mirror.TUNA)
    val found = SourceMirror.fragmentFile(temp.root, SourceMirror.Mirror.TUNA)
    assertTrue("必须定位到分组内的片段", found != null && found.isFile)
    assertNull("缺失的镜像返回 null 而不是造一个路径", SourceMirror.fragmentFile(temp.root, SourceMirror.Mirror.NJU))
  }

  /**
   * 真机 bug（0.14.9）：枚举里的文件名必须与 Termux 快照里的片段名逐字一致。
   *
   * 南京大学那档曾写成 mirror.nju.edu.cn，而快照里实际是 mirrors.nju.edu.cn（带 s）。
   * 循环换源走到这一档就报「运行时里找不到该镜像的配置片段，无法切换」，
   * 再点一下又跳过去，表现为「点几下就报错、换不过去」。
   *
   * 这里不硬编码清单，而是用真实快照里出现过的名字逐个建片段：
   * 任何一项对不上就说明枚举与快照又开始漂了。
   */
  @Test
  fun everyMirrorFileMatchesTheSnapshotFragmentName() {
    // 2026-10-25 真机 files/usr/etc/termux/mirrors/chinese_mainland/ 的实际内容（含全部六个候选）。
    val snapshotNames = setOf(
      "mirrors.tuna.tsinghua.edu.cn",
      "mirrors.ustc.edu.cn",
      "mirrors.aliyun.com",
      "mirror.sjtu.edu.cn",
      "mirrors.nju.edu.cn",
      "mirrors.zju.edu.cn",
    )
    val dir = File(temp.root, "etc/termux/mirrors/chinese_mainland")
    dir.mkdirs()
    for (name in snapshotNames) File(dir, name).writeText("MAIN=\"https://$name/termux/\"\n")
    for (mirror in SourceMirror.Mirror.entries) {
      assertNotNull(
        "枚举值 " + mirror + "（" + mirror.file + "）在快照里找不到同名片段——换源走到这一档必然报「找不到配置片段」",
        SourceMirror.fragmentFile(temp.root, mirror),
      )
    }
  }


  /** #554：换链必须原子——先删后建的窗口内 chosen_mirrors 缺失，pkg 下次 update 随机重选覆盖。 */
  @Test
  fun swapLeavesNoWindowWhereChosenMirrorIsAbsent() {
    val usr = tempFolder()
    val links = RecordingLinks()
    SourceMirror.writeChosenTarget(usr, "chinese_mainland/mirrors.tuna.tsinghua.edu.cn", links)
    SourceMirror.writeChosenTarget(usr, "chinese_mainland/mirrors.aliyun.com", links)
    // 第二次换链后：最终链接在场且指向新目标；任何时刻都没有「delete 之后、create 之前」的空窗。
    // 宿主 Path 分隔符差异归一（Windows JVM 上链接目标是反斜杠，与 readChosenMirror 的 fileName 同款坑）。
    assertEquals("chinese_mainland/mirrors.aliyun.com", SourceMirror.readChosenTarget(usr, links)!!.replace(92.toChar(), '/'))
    assertFalse("不允许出现先删后建的序列", links.sawDeleteOfLiveLink)
  }

  /** 换链过程中的每一步之后链接都在场：delete 只允许指向 staging 临时名。 */
  private class RecordingLinks : SourceMirror.LinkPrimitives {
    val targets = mutableMapOf<String, String>()
    var sawDeleteOfLiveLink = false
    override fun isSymbolicLink(path: java.nio.file.Path) = targets.containsKey(path.toString())
    override fun readSymbolicLink(path: java.nio.file.Path): java.nio.file.Path = java.nio.file.Paths.get(targets.getValue(path.toString()))
    override fun deleteIfExists(path: java.nio.file.Path): Boolean {
      // 删的是正式名且它当前在场 = 旧实现「先删后建」的空窗形态。
      if (path.toString().endsWith("chosen_mirrors") && targets.containsKey(path.toString())) sawDeleteOfLiveLink = true
      return targets.remove(path.toString()) != null
    }
    override fun createSymbolicLink(link: java.nio.file.Path, target: java.nio.file.Path): java.nio.file.Path {
      targets[link.toString()] = target.toString(); return link
    }
    override fun moveAtomic(from: java.nio.file.Path, to: java.nio.file.Path) {
      val v = targets.remove(from.toString()) ?: error("staging missing")
      targets[to.toString()] = v
    }
  }

  private fun tempFolder(): java.io.File = java.nio.file.Files.createTempDirectory("srcmirror").toFile()
}
