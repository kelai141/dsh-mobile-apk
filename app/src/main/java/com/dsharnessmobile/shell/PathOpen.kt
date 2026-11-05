package com.dsharnessmobile.shell

import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

/**
 * 0.13.7（追上游 dsh 0.1.5「在外部应用打开」）：把设备路径交给系统选择器。
 *
 * 上游 0.1.5 的 open-in-app 是桌面编排（Finder/Terminal/编辑器目录，宿主侧
 * /open-in-app/ 路由族），Android 上没有等价候选；本对象补的正是这一层：
 *
 * - 文件（mode=view）：FileProvider content:// + ACTION_VIEW（按真实 MIME），
 *   交系统选择器列出所有可处理应用（MT 管理器、WPS、图库…）。
 * - 目录（mode=folder）：主候选走系统文件管理（ACTION_OPEN_DOCUMENT_TREE，
 *   打开系统文件浏览界面）；MT 管理器等在「初始意图」里按包名逐个尝试，
 *   装了就出现在选择器里，没装就不出现（不臆造入口）。
 *
 * 安全：白名单 = FileIncoming 的 canonical 允许面（工作区 / tmp / usr/bin / 导出仓库）
 * 加用户可见的外部存储根（见 isChooserAllowed）；应用私有区的其余部分（含
 * .credentials.yaml）永不进选择器。桥由页面调用，页面内容不可信。
 *
 * 返回 JSON {"ok":true} / {"ok":false,"reason":"..."}：
 * reason ∈ not-exists / not-allowed / no-handler / uri-failed / <异常摘要>。
 */
object PathOpen {

  /** 目录打开时系统识别的 MIME（FileProvider 对目录同样返回此值）。 */
  private const val MIME_FOLDER = "resource/folder"

  /** 「初始意图」候选：装了才出现，顺序即选择器里的顺序。 */
  private val FILE_MANAGER_PACKAGES = listOf("bin.mt.plus", "com.android.documentsui", "com.google.android.documentsui")

  /**
   * 打开系统选择器。
   * @param activity 壳 Activity（startActivity 主体）。
   * @param path 设备绝对路径。
   * @param mode `folder` 视为目录，其余按文件处理。
   * @return 结果 JSON 文本（同步返回，桥线程调用）。
   */
  fun openChooser(activity: MainActivity, path: String, mode: String?): String {
    val file = File(path)
    if (!file.exists()) return answer(false, "not-exists")
    if (!isChooserAllowed(activity, file)) return answer(false, "not-allowed")
    val folder = file.isDirectory || mode == "folder"
    val uri = try {
      FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
    } catch (e: Exception) {
      android.util.Log.w("dsh-path", "uri failed: " + e.message)
      return answer(false, "uri-failed")
    }
    val primary = if (folder) folderIntent() else viewIntent(uri, null)
    if (primary.resolveActivity(activity.packageManager) == null) return answer(false, "no-handler")

    val extras = ArrayList<Intent>()
    if (folder) {
      // 「用其它应用打开这个目录」：能处理 resource/folder 的应用（MT 等）。
      viewIntent(uri, MIME_FOLDER)
        .takeIf { it.resolveActivity(activity.packageManager) != null }
        ?.let { extras.add(it) }
      for (pkg in FILE_MANAGER_PACKAGES) {
        viewIntent(uri, MIME_FOLDER).setPackage(pkg)
          .takeIf { it.resolveActivity(activity.packageManager) != null }
          ?.let { extras.add(it) }
      }
    }

    return try {
      val chooser = Intent.createChooser(primary, "打开方式").apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (extras.isNotEmpty()) putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toTypedArray())
      }
      activity.startActivity(chooser)
      android.util.Log.i("dsh-path", "chooser ok: " + path + " folder=" + folder + " extras=" + extras.size)
      answer(true, null)
    } catch (e: Exception) {
      android.util.Log.w("dsh-path", "chooser failed: " + path + " -> " + e.message)
      answer(false, e.message ?: "exception")
    }
  }

  /**
   * 选择器允许面 = FileIncoming 的 canonical 白名单（工作区 / tmp / usr/bin / 导出仓库）。
   *
   * issue #1571：这里**不再**并上整个存储根（要浏览全盘请走用户当场授权的
   * `ACTION_OPEN_DOCUMENT` 通路，而不是放宽这张表）。旧允许面是「四条窄根 ∪
   * /storage/emulated/0」，而三个 `@JavascriptInterface`（openFileExternal / shareFile /
   * openPathChooser）的门禁只要求顶层帧是引擎 origin，`BridgeOriginGuard` 又明确为「同源 HTML
   * artifact 预览帧」放行桥——模型生成的一段 artifact HTML 调
   * `shareFile("/storage/emulated/0/Android/data/<别的应用>/files/token.db")` 就能把别的应用
   * 私有区里的文件交给系统分享面板（第一项通常是聊天工具），`openFileExternal` 更直接把文件
   * 交给外部阅读器并授予读权限。
   *
   * 与 FileIncoming.isReaderAllowed 的分工：本方法服务**页面主动打开**这一条出口
   * （PathOpen.openChooser → 系统选择器，用户当场选应用）；引擎/插件驱动的
   * 「文件提及 → 外部阅读器」（FileIncoming.openWithExternalReader）走同一份白名单。
   * 应用私有区仍严格：`.dsh` 其余部分（.credentials.yaml 等）永不进选择器。
   */
  fun isChooserAllowed(activity: MainActivity, file: File): Boolean = isChooserAllowedFor(activity, file)

  /**
   * 允许面判定（[isChooserAllowed] 的实现体；0.15.0 起对 [FileExternalBridge] 开放）。
   *
   * 为什么让两个出口共用同一份判据：openFileExternal / shareFile 与 openPathChooser
   * 做的是同一件事（把设备路径变成可交给别的应用的 Uri），允许面若各写一份，必然漂移成
   * 「某个按钮能分享、另一个不能」这种无法解释的差异。
   *
   * 允许面 = 严格白名单，**不**并外部存储根（issue #1571，理由见 [isChooserAllowed] 的 KDoc）。
   */
  internal fun isChooserAllowedFor(activity: MainActivity, file: File): Boolean {
    if (FileIncoming.isReaderAllowed(activity, file)) return true
    return try {
      // issue #1571：外部存储**不再是**无条件的允许面；只有用户经系统目录选择器亲手授予过的
      // 目录（persistedUriPermissions，外部工作区走的就是这条）才继续放行。
      ChooserAllowlist.permitted(file.canonicalPath, grantedRoots(activity))
    } catch (_: Exception) {
      false
    }
  }

  /**
   * 用户持久化授予过的 SAF 目录（真实路径形态）。
   *
   * 为什么要读系统真源而不是自己记一份清单：`ConfigTransfer` 里那张私有 prefs 目录清单
   * 已在 ST-24 因「有写无读 + 与系统双口径」被删；这里直接读 `persistedUriPermissions`，
   * 授权被系统回收（用户清除、卸载重装）后判据自动跟着收紧。
   */
  private fun grantedRoots(activity: MainActivity): List<String> = try {
    ChooserAllowlist.grantedRoots(
      activity.contentResolver.persistedUriPermissions
        .filter { it.isReadPermission }
        .map { AndroidBridge.resolvePickedPath(it.uri) },
    )
  } catch (_: Exception) {
    emptyList()
  }

  /** 文件/目录通吃：ACTION_VIEW + 读授权；`type` 为空时由系统按 Uri 推断。 */
  private fun viewIntent(uri: Uri, type: String?): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, type)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

  /** 系统文件管理：打开系统文件浏览界面（目录打开的可达路径）。 */
  private fun folderIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)

  /** 同步结果 JSON（桥方法一律返回文本，页面据 reason 分流文案）。 */
  private fun answer(ok: Boolean, reason: String?): String {
    val json = JSONObject().put("ok", ok)
    if (reason != null) json.put("reason", reason)
    return json.toString()
  }
}
