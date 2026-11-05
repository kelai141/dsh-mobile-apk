package com.dsharnessmobile.shell

import java.io.File

/**
 * 「把这个设备路径交给别的应用」的允许面判据（issue #1571）。
 *
 * 缺陷形态：`PathOpen.isChooserAllowedFor` 的允许面是「四条窄根 **并上** 整个外部存储根」，
 * 而三个 `@JavascriptInterface`（`openFileExternal` / `shareFile` / `openPathChooser`）的门禁
 * 只要求顶层帧是引擎 origin；`BridgeOriginGuard` 又明确为「同源 HTML artifact 预览帧」放行桥。
 * 于是模型生成的一段 artifact HTML 调
 * `shareFile("/storage/emulated/0/Android/data/<别的应用>/files/token.db")` 就会弹系统分享面板
 * （第一项通常是聊天工具），`openFileExternal` 更直接把文件交给外部阅读器并授予读权限。
 *
 * 修法口径：**去掉「整个外部存储根」这一支**，改为「用户明确授予过的目录」——外部工作区本来
 * 就是用户经系统 SAF 目录选择器亲手选的，那份持久化授权（`persistedUriPermissions`）是
 * 可核对的事实，不是「整台设备」。判据留在纯对象里，因为它必须能对**规范化后的路径**做边界
 * 判定（前缀兄弟目录必须拒绝），而这正是 JVM 单测能真跑的部分（见 [ChooserAllowlistTest]）。
 *
 * 为什么不用 `File.exists()/canRead()` 当放行依据：持有 All Files Access 时几乎什么都读得到，
 * 「读得到」恰恰是缺陷成立的前提，不是许可。
 */
internal object ChooserAllowlist {

  /**
   * 规范化路径是否落在任一允许根之下（含根本身）。
   *
   * 边界判定必须用「根 + 分隔符」而不是裸 `startsWith`：裸前缀会把
   * `/storage/emulated/0/workspace-evil/x` 判成 `/storage/emulated/0/workspace` 的子路径。
   *
   * @param canonicalPath 已经 canonical 化的目标路径（`File.canonicalPath`）。
   * @param roots 允许根（同样应已 canonical 化；空/空白项被忽略）。
   * @returns true = 放行。
   */
  fun permitted(canonicalPath: String, roots: List<String>): Boolean {
    if (canonicalPath.isEmpty()) return false
    for (raw in roots) {
      val root = raw.trim()
      if (root.isEmpty()) continue
      if (canonicalPath == root) return true
      val prefix = if (root.endsWith(File.separator)) root else root + File.separator
      if (canonicalPath.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * 把「用户持久化授予的 SAF 树」折成可比较的允许根。
   *
   * `AndroidBridge.resolvePickedPath` 只做 docId → 真实路径的字符串映射；非 primary 卷会回
   * `content://` 原串，那种串不是文件系统路径，**不能**参与 canonical 前缀比较（放进来等于
   * 让一个永远匹配不上的字符串白占一位，且掩盖真正的问题）。这里只收绝对路径形态。
   *
   * 平台前提：Android 上文件系统绝对路径恒以 `/` 开头，故这里按 `/` 过滤。JVM 单测若跑在
   * Windows 上（路径形如 `C:\...`）会把输入全部滤掉——那是平台差异，不是判据失效；对应的
   * 过滤契约由 `PathOpenAllowlistTest.contentUrisNeverBecomePathRoots` 用 POSIX 形态覆盖。
   *
   * @param grantedPaths 已映射过的授权目录（顺序无关，可含重复）。
   * @returns 去重后的绝对路径根。
   */
  fun grantedRoots(grantedPaths: List<String>): List<String> =
    grantedPaths.asSequence()
      .map { it.trim() }
      .filter { it.startsWith("/") && !it.startsWith("content://") }
      .distinct()
      .toList()
}
