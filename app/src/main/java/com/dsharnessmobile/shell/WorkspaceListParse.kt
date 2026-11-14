package com.dsharnessmobile.shell

import org.json.JSONObject

/**
 * 工作区列表项（纯数据，不含任何页面/Android 依赖）。
 *
 * @property id 工作区 id，切换会话时必须原样回传。
 * @property title 展示名；缺失时用 id 兜底，保证列表行永远有字可显示。
 */
internal data class OverlayWorkspace(val id: String, val title: String)

/**
 * 解析 home/.dsh/storages/workspace.json 的工作区表（纯函数，JVM 可测）。
 *
 * 为什么需要文件兜底：页面宿主 API 不可用（WebView 未加载/页面崩溃）时，
 * 输入区仍要能列出工作区，而壳侧唯一现成真源就是这个文件；
 * 页面的 store 才是首选真源（design.md §6.3），本类只做只读回退。
 *
 * 容错原则：任何解析异常都返回空列表而不是抛出——这个文件由引擎写入，
 * 可能正处在「写了一半」的状态；悬浮层不能因为一个 JSON 坏了就崩或入口消失。
 */
internal object WorkspaceListParse {

  /**
   * 解析工作区列表。
   *
   * 结构：{"tables":{"workspaces":{"<id>":{"title":"..."}}}}。
   *
   * 为什么按 id 排序输出：JSONObject 的 key 顺序不保证（底层是哈希表），
   * 不排序的话同一次读取在不同进程/不同 JDK 上会得到不同顺序，
   * 悬浮列表会在刷新时无意义地跳动。
   *
   * @param json 文件全文；null/空/坏 JSON 一律返回空列表。
   * @returns 工作区列表，可能为空但绝不为 null 项。
   */
  fun parse(json: String?): List<OverlayWorkspace> {
    val raw = json?.trim()
    if (raw.isNullOrEmpty()) return emptyList()
    return try {
      val workspaces = JSONObject(raw)
        .optJSONObject("tables")
        ?.optJSONObject("workspaces")
        ?: return emptyList()
      workspaces.keys().asSequence()
        .sorted()
        .mapNotNull { id ->
          val entry = workspaces.optJSONObject(id) ?: return@mapNotNull null
          val title = entry.optString("title", "").trim().ifBlank { id }
          OverlayWorkspace(id, title)
        }
        .toList()
    } catch (e: Exception) {
      // 坏 JSON 只丢列表，不丢悬浮层：下一次页面宿主或文件刷新会再试。
      emptyList()
    }
  }

  /**
   * 找出「临时工作区」的 id，供新建会话时默认选中。
   *
   * 优先按标题精确匹配：引擎会为一次性会话建一个固定名的工作区，
   * 用标题找比按位置猜第一项更稳（列表顺序可能变）。
   * 找不到同名项时退回第一项，因为至少给用户一个可用的落点；
   * 列表为空时返回 null，调用方应禁用心回退而不是编一个 id。
   *
   * @param list 已解析的工作区列表。
   * @param tempTitle 临时工作区的展示名（中文默认值与引擎侧一致）。
   */
  fun tempWorkspaceId(
    list: List<OverlayWorkspace>,
    tempTitle: String = "临时工作区",
  ): String? =
    list.firstOrNull { it.title == tempTitle }?.id ?: list.firstOrNull()?.id
}
