package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONArray
import org.json.JSONObject

/**
 * 服务侧采集到的有界树体。target 不在这里生成：displayId / screenId / 尺寸 / epoch /
 * 屏幕代次由 Rust 计划在应用侧补上，Kotlin 不持有第二套屏幕身份。
 *
 * 本对象只依赖 org.json，便于在 JVM 单测里直接校验字节预算与字段形状。
 */
internal object NativeShizukuTreeBody {
  /**
   * 树体 UTF-8 上限 256 KiB，低于 AIDL 侧 512 KiB 的硬上限。
   *
   * Binder 字符串按 UTF-16 写，256 KiB 的 ASCII 树体会占约 512 KiB 事务空间，
   * 再加上节点数与 Bundle 头部仍在 1 MiB 事务预算内；512 KiB 的树体则可能直接超限。
   * 超限即停在预算边界并标 complete=false / stopReason=char-budget，绝不发半截 JSON。
   */
  const val MAX_BODY_BYTES = 256 * 1024
  const val MAX_NODES = 1_200
  const val MAX_DEPTH = 40
  const val TREE_BUDGET_MS = 2_500L
  const val MAX_FIELD_CHARS = 8_192

  /** 一个原始节点。path 是真实 child 下标；root 为空列表。 */
  data class Node(
    val path: List<Int>,
    val className: String,
    val packageName: String,
    val viewId: String,
    val text: String,
    val contentDescription: String,
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
    val clickable: Boolean,
    val scrollable: Boolean,
    val editable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val enabled: Boolean,
    val focused: Boolean,
    val visible: Boolean,
    val selected: Boolean,
    val windowId: Int,
  )

  data class Body(
    val windowId: Int,
    val nodes: List<Node>,
    val complete: Boolean,
    val stopReason: String?,
    val elapsedMs: Long,
  )

  /** 字段逐个对齐 NativeRawTreeJson.node，保证同一份原始形态。密码节点不输出文本。 */
  fun node(node: Node): JSONObject = JSONObject()
    .put("path", JSONArray(node.path))
    .put("className", node.className)
    .put("packageName", node.packageName)
    .put("viewId", node.viewId)
    .put("text", node.text)
    .put("contentDescription", node.contentDescription)
    .put("bounds", JSONObject().put("left", node.left).put("top", node.top)
      .put("right", node.right).put("bottom", node.bottom))
    .put("clickable", node.clickable)
    .put("scrollable", node.scrollable)
    .put("editable", node.editable)
    .put("checkable", node.checkable)
    .put("checked", node.checked)
    .put("enabled", node.enabled)
    .put("focused", node.focused)
    .put("visible", node.visible)
    .put("selected", node.selected)
    .put("windowId", node.windowId)

  /**
   * 编码为有界树体 JSON。逐节点累加真实 UTF-8 字节数，越预算即停并标记
   * complete=false / stopReason=char-budget；绝不返回截断的半截 JSON。
   */
  fun encode(body: Body): String {
    val rows = JSONArray()
    var bytes = 0
    var stopReason = body.stopReason
    var complete = body.complete
    for (node in body.nodes) {
      val encoded = node(node)
      val size = encoded.toString().toByteArray(Charsets.UTF_8).size + 1
      if (bytes + size > MAX_BODY_BYTES - 1024) {
        complete = false
        stopReason = "char-budget"
        break
      }
      bytes += size
      rows.put(encoded)
    }
    return JSONObject()
      .put("windowId", body.windowId)
      .put("nodes", rows)
      .put("complete", complete)
      .put("stopReason", stopReason ?: JSONObject.NULL)
      .put("elapsedMs", body.elapsedMs)
      .toString()
  }

  /** 应用侧补 target：target 只取自 Rust 已提交的 plan，不读第二份来源。 */
  fun withTarget(body: String, target: JSONObject): String {
    val parsed = JSONObject(body)
    return JSONObject().put("target", target)
      .put("windowId", parsed.getInt("windowId"))
      .put("nodes", parsed.getJSONArray("nodes"))
      .put("complete", parsed.getBoolean("complete"))
      .put("stopReason", parsed.opt("stopReason") ?: JSONObject.NULL)
      .put("elapsedMs", parsed.optLong("elapsedMs", 0L))
      .toString()
  }
}
