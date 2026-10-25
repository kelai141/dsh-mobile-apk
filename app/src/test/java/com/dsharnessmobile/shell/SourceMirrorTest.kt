package com.dsharnessmobile.shell

import java.io.File
import org.junit.Assert.assertEquals
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
}
