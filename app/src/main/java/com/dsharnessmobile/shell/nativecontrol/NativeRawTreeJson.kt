package com.dsharnessmobile.shell.nativecontrol

import org.json.JSONArray
import org.json.JSONObject

/** 将 Android 事实逐字段传给 Rust；不压缩、不生成 ref、不改变原始 path。 */
internal object NativeRawTreeJson {
  fun encode(tree: NativeAccessibilityPlatform.RawTree): String = JSONObject()
    .put("target", tree.target.let { target ->
      JSONObject().put("displayId", target.displayId).put("screenId", target.screenId)
        .put("logicalWidth", target.logicalWidth).put("logicalHeight", target.logicalHeight)
        .put("epoch", target.epoch).put("generation", target.generation)
    }).put("windowId", tree.windowId).put("complete", tree.complete)
    .put("stopReason", tree.stopReason ?: JSONObject.NULL).put("elapsedMs", tree.elapsedMs)
    .put("nodes", JSONArray().also { rows -> tree.nodes.forEach { rows.put(node(it)) } }).toString()

  fun node(node: NativeAccessibilityPlatform.RawNode): JSONObject = JSONObject()
    .put("path", JSONArray(node.path)).put("className", node.className).put("packageName", node.packageName)
    .put("viewId", node.viewId).put("text", node.text).put("contentDescription", node.contentDescription)
    .put("bounds", node.bounds.let { bounds -> JSONObject().put("left", bounds.left).put("top", bounds.top)
      .put("right", bounds.right).put("bottom", bounds.bottom) })
    .put("clickable", node.clickable).put("scrollable", node.scrollable).put("editable", node.editable)
    .put("checkable", node.checkable).put("checked", node.checked).put("enabled", node.enabled)
    .put("focused", node.focused).put("visible", node.visible).put("selected", node.selected)
    .put("windowId", node.windowId)
}
