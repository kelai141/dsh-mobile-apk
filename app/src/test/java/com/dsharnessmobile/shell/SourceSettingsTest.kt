package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * 换源编排层的判据，集中在两条设备实证过的硬约束上：
 *   1) chosen_mirrors 是「用户意图」的载体，也是唯一能区分「换过源」与「没换过」的事实
 *      （出厂快照里它不存在）；
 *   2) 快照刷新对 usr 是整树替换，所以意图必须在换树前捕获、换树后重放。
 */
class SourceSettingsTest {

  @get:Rule
  val temp = TemporaryFolder()

  /**
   * 宿主无关的链接原语：Windows 未开开发者模式时建不了软链（实测报"客户端没有所需的特权"），
   * 而这里要验的是"双写"这条产品约束，不是宿主能不能建链。
   * 用一份目标映射模拟链接语义，读回的行为与真实软链一致。
   */
  private class FakeLinks : SourceMirror.LinkPrimitives {
    val targets = mutableMapOf<String, String>()
    override fun isSymbolicLink(path: java.nio.file.Path) = targets.containsKey(path.toString())
    override fun readSymbolicLink(path: java.nio.file.Path): java.nio.file.Path =
      java.nio.file.Paths.get(targets.getValue(path.toString()))
    override fun deleteIfExists(path: java.nio.file.Path): Boolean = targets.remove(path.toString()) != null
    override fun createSymbolicLink(link: java.nio.file.Path, target: java.nio.file.Path): java.nio.file.Path {
      targets[link.toString()] = target.toString()
      return link
    }
  }
  /** 造一个带 chinese_mainland 分组的 usr 前缀。 */
  private fun prefix(vararg mirrors: SourceMirror.Mirror): File {
    val usr = File(temp.root, "usr")
    val dir = File(usr, "etc/termux/mirrors/${SourceMirror.GROUP_CHINESE_MAINLAND}")
    dir.mkdirs()
    File(usr, "etc/apt").mkdirs()
    for (m in mirrors) {
      File(dir, m.file).writeText("# fixture\nWEIGHT=1\nMAIN=\"https://${m.file}/termux/termux-main\"\n")
    }
    return usr
  }

  @Test
  fun neverChangedSourceIsDetectedAsAbsent() {
    val usr = prefix(SourceMirror.Mirror.TUNA)
    // 出厂快照里 chosen_mirrors 不存在 —— 这就是「没换过」的事实依据。
    assertNull(SourceSettings.captureSelection(usr, FakeLinks()))
  }

  @Test
  fun chosenMirrorLinkIsCapturedAsTheUserIntent() {
    val usr = prefix(SourceMirror.Mirror.TUNA, SourceMirror.Mirror.ALIYUN)
    val links = FakeLinks()
    SourceMirror.writeChosenMirror(usr, SourceMirror.Mirror.ALIYUN, links)
    assertEquals(SourceMirror.Mirror.ALIYUN.file, SourceSettings.captureSelection(usr, links))
  }

  @Test
  fun replayRewritesSourcesListAndTheLinkAfterTheUsrTreeIsReplaced() {
    // 模拟一次快照刷新：换树后的 usr 是全新的，旧选择只剩 rememberedSource 这个字符串。
    val before = prefix(SourceMirror.Mirror.TUNA)
    val linksBefore = FakeLinks()
    SourceMirror.writeChosenMirror(before, SourceMirror.Mirror.TUNA, linksBefore)
    val remembered = SourceSettings.captureSelection(before, linksBefore)

    // 换树后的 usr 是全新的：链接与 sources.list 都回到出厂状态。
    val after = prefix(SourceMirror.Mirror.TUNA)
    val linksAfter = FakeLinks()
    File(after, "etc/apt/sources.list").writeText("deb https://factory.invalid/x stable main\n")

    assertTrue("重放必须成功", SourceSettings.replaySelection(after, remembered, linksAfter))
    assertTrue(
      "sources.list 必须指向用户选的源",
      SourceSettings.sourcesListFile(after).readText().contains(SourceMirror.Mirror.TUNA.file),
    )
    assertTrue(
      "chosen_mirrors 必须同时重写，否则 pkg 会把源换掉",
      linksAfter.isSymbolicLink(File(after, "etc/termux/chosen_mirrors").toPath()),
    )
    assertEquals(SourceMirror.Mirror.TUNA.file, SourceSettings.captureSelection(after, linksAfter))
  }

  @Test
  fun replayDoesNothingWhenTheUserNeverChangedTheSource() {
    val after = prefix(SourceMirror.Mirror.TUNA)
    File(after, "etc/apt/sources.list").writeText("deb https://factory.invalid/x stable main\n")
    assertFalse("没记过意图就不该动文件", SourceSettings.replaySelection(after, null, FakeLinks()))
    assertTrue(
      "出厂源必须原样保留",
      SourceSettings.sourcesListFile(after).readText().contains("factory.invalid"),
    )
  }

  @Test
  fun replayOfAnUnknownMirrorFailsQuietlyInsteadOfCorruptingTheSource() {
    val after = prefix(SourceMirror.Mirror.TUNA)
    File(after, "etc/apt/sources.list").writeText("deb https://factory.invalid/x stable main\n")
    assertFalse(SourceSettings.replaySelection(after, "mirrors.removed-from-list.example", FakeLinks()))
    assertTrue(
      "认不出的意图不得写坏源文件",
      SourceSettings.sourcesListFile(after).readText().contains("factory.invalid"),
    )
  }

  @Test
  fun nextMirrorCyclesThroughTheListAndStartsOverAtTheEnd() {
    val usr = prefix(*SourceMirror.Mirror.entries.toTypedArray())
    val links = FakeLinks()
    val all = SourceMirror.Mirror.entries
    // 未设源时从第一个开始。
    assertEquals(all.first(), SourceSettings.nextMirror(usr, links))
    for (i in all.indices) {
      SourceMirror.writeChosenMirror(usr, all[i], links)
      SourceMirror.replaceAtomically(
        SourceSettings.sourcesListFile(usr),
        SourceMirror.sourcesListContent("https://${all[i].file}/termux/termux-main"),
      )
      val expected = all[(i + 1) % all.size]
      assertEquals("从 " + all[i].name + " 的下一项", expected, SourceSettings.nextMirror(usr, links))
    }
  }
}
