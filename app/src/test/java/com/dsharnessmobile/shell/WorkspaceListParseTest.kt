package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * workspace.json 解析契约（纯 JVM）。
 *
 * 钉的是 [WorkspaceListParse] 的容错口径：坏 JSON / 缺字段 / 非对象条目都不能抛异常，
 * 标题缺失用 id 兜底，输出顺序稳定，临时工作区按标题优先匹配。
 * 这个文件由引擎写入，正处在半写状态时悬浮层也必须能继续工作。
 */
class WorkspaceListParseTest {

  @Test
  fun `正常结构按 id 排序解析出工作区`() {
    val json = "{\"tables\":{\"workspaces\":{" +
      "\"w2\":{\"title\":\"第二个\"}," +
      "\"w1\":{\"title\":\"第一个\"}}}}"
    val list = WorkspaceListParse.parse(json)
    assertEquals("两条工作区", 2, list.size)
    assertEquals("按 id 排序，顺序稳定", "w1", list[0].id)
    assertEquals("标题原样保留", "第一个", list[0].title)
    assertEquals("第二条", "w2", list[1].id)
  }

  @Test
  fun `标题缺失时用 id 兜底`() {
    val list = WorkspaceListParse.parse("{\"tables\":{\"workspaces\":{\"w1\":{}}}}")
    assertEquals("不能只有空标题", "w1", list.single().title)
  }

  @Test
  fun `标题为空白时同样用 id 兜底`() {
    val json = "{\"tables\":{\"workspaces\":{\"w1\":{\"title\":\"   \"}}}}"
    assertEquals("空白标题等于缺失", "w1", WorkspaceListParse.parse(json).single().title)
  }

  @Test
  fun `非对象条目被跳过而不是整表失败`() {
    val json = "{\"tables\":{\"workspaces\":{" +
      "\"w1\":{\"title\":\"好的\"},\"w2\":\"坏条目\"}}}"
    val list = WorkspaceListParse.parse(json)
    assertEquals("只保留能解析的条目", 1, list.size)
    assertEquals("好的那条仍在", "w1", list.single().id)
  }

  @Test
  fun `null 与空字符串返回空列表`() {
    assertTrue("null 输入", WorkspaceListParse.parse(null).isEmpty())
    assertTrue("空字符串", WorkspaceListParse.parse("").isEmpty())
    assertTrue("纯空白", WorkspaceListParse.parse("   ").isEmpty())
  }

  @Test
  fun `坏 JSON 返回空列表而不抛异常`() {
    assertTrue("截断的 JSON", WorkspaceListParse.parse("{\"tables\":").isEmpty())
    assertTrue("根本不是 JSON", WorkspaceListParse.parse("not json").isEmpty())
    assertTrue("根是数组", WorkspaceListParse.parse("[]").isEmpty())
  }

  @Test
  fun `缺少 tables 或 workspaces 时返回空列表`() {
    assertTrue("没有 tables", WorkspaceListParse.parse("{\"other\":1}").isEmpty())
    assertTrue("tables 里没有 workspaces",
      WorkspaceListParse.parse("{\"tables\":{}}").isEmpty())
    assertTrue("workspaces 不是对象",
      WorkspaceListParse.parse("{\"tables\":{\"workspaces\":[]}}").isEmpty())
  }

  @Test
  fun `临时工作区优先按标题匹配`() {
    val list = listOf(
      OverlayWorkspace("w1", "日常"),
      OverlayWorkspace("w2", "临时工作区"),
    )
    assertEquals("标题匹配优先于位置", "w2",
      WorkspaceListParse.tempWorkspaceId(list))
  }

  @Test
  fun `没有同名临时工作区时退回第一项`() {
    val list = listOf(OverlayWorkspace("w1", "日常"), OverlayWorkspace("w2", "工作"))
    assertEquals("至少给一个可用落点", "w1", WorkspaceListParse.tempWorkspaceId(list))
  }

  @Test
  fun `空列表的临时工作区是 null`() {
    assertNull("空列表不得编造 id", WorkspaceListParse.tempWorkspaceId(emptyList()))
  }

  @Test
  fun `临时工作区标题可自定义`() {
    val list = listOf(OverlayWorkspace("w1", "Scratch"), OverlayWorkspace("w2", "日常"))
    assertEquals("按传入标题匹配", "w1",
      WorkspaceListParse.tempWorkspaceId(list, tempTitle = "Scratch"))
  }
}
