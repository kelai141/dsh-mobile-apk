package com.dsharnessmobile.shell

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 引擎源判定：精确匹配本机引擎的 scheme/host/port（防前缀欺骗，
 * 如 127.0.0.1:30800 或 127.0.0.1:3080.evil.com 误判为引擎源）。
 */
internal fun isEngineSource(url: String): Boolean = EngineProbe.isEngineOrigin(url)

/** 会话日志导出端点路径（WebView 内双拦截识别用）。 */
internal const val SESSION_EXPORT_PATH = "/api/session.export"

/** 命中判定：引擎源 + 会话导出路径 + GET（HEAD 是前端预检，不得触发跳转）。 */
internal fun isSessionExport(url: String, method: String): Boolean {
  return method == "GET" && isEngineSource(url) && url.contains(SESSION_EXPORT_PATH)
}

/**
 * 浏览器下载落盘（自 MainActivity 拆出）：会话日志导出（/api/session.export）与其余
 * 引擎源下载统一走 app 内下载（优先 Documents/dshdata/exports，未授权回退
 * MediaStore.Downloads）——浏览器导航带 Origin:null 会被 dsh 的 /api browser-trust
 * fence 拒绝（403），app 内 HttpURLConnection 无浏览器标记 → fence 放行（403 修复路径）。
 * 另承载引擎同源外链的系统浏览器打开（URL 分流的另一半）。
 * 选择独立文件而非并入 UpdateManager：UpdateManager 职责是快照在线更新编排
 * （manifest/sha256/换 usr），与「引擎同源 URL 落盘通道」不是同一内聚面。
 */
internal class DownloadSaver(private val activity: MainActivity, private val dshDataDir: File) {

  /** 下载 in-flight 守卫：shouldOverrideUrlLoading 与 downloadListener 双入口去重。 */
  private val exportDownloading = java.util.concurrent.atomic.AtomicBoolean(false)

  /** 原子防重放的外部浏览器打开（非导出外链）。尽力而为：启动失败时
   *  静默（调用方不读返回值），不再有 MediaStore 回退契约——回退仅
   *  存在于导出路径（downloadToDownloads 内）。 */
  private val exportLaunching = java.util.concurrent.atomic.AtomicBoolean(false)

  /** 导出结果回传 WebView：UI 插件经 window.__dshExportResult 弹软件内结果框。
   *  （自 MainActivity 迁入；调试日志导出复用同一弹窗通道。） */
  internal fun pushExportResult(ok: Boolean, detail: String) {
    val title = if (ok) "导出成功" else "导出失败"
    val payload = "{\"ok\":" + ok + ",\"title\":" + jsString(title) + ",\"detail\":" + jsString(detail) + "}"
    activity.webView.post {
      activity.webView.evaluateJavascript(
        "window.__dshExportResult && window.__dshExportResult(" + payload + ")", null,
      )
    }
  }

  /**
   * 下载引擎侧 URL 并保存为会话日志 ZIP 导出。优先直写
   * Documents/dshdata/exports/（需 MANAGE_EXTERNAL_STORAGE）；未授权时
   * 回退 MediaStore.Downloads。仅接受引擎同源 URL；流式写入并设大小上限。
   * app 内 HttpURLConnection 请求无浏览器标记（Origin/sec-fetch-site），
   * 通过 dsh 的 /api browser-trust fence（浏览器导航 403 的修复路径）。
   */
  fun downloadToDownloads(url: String, contentDisposition: String?) {
    if (!isEngineSource(url)) {
      activity.showTestNotification("下载被拒绝", "仅支持从本机引擎导出文件")
      pushExportResult(false, "仅支持从本机引擎导出文件")
      return
    }
    if (!exportDownloading.compareAndSet(false, true)) return
    if (Build.VERSION.SDK_INT < 29) {
      activity.showTestNotification("导出失败", "当前系统版本不支持下载，请升级到 Android 10+")
      pushExportResult(false, "当前系统版本不支持下载，请升级到 Android 10+")
      exportDownloading.set(false)
      return
    }
    val filename = sanitizeFilename(parseDownloadFilename(url, contentDisposition))
    Thread {
      var conn: HttpURLConnection? = null
      try {
        // #118：本地引擎端点的下载（session.export）同样必须绕过系统代理直连。
        // 0.13.3 W2：/api/session.* 走浏览器鉴权——带 Cookie，401 自愈换一次后重试。
        var c: HttpURLConnection
        var code = -1
        var stream: java.io.InputStream? = null
        for (attempt in 0..1) {
          c = URL(url).openConnection(java.net.Proxy.NO_PROXY) as HttpURLConnection
          conn = c
          c.connectTimeout = 15_000
          c.readTimeout = 60_000
          c.requestMethod = "GET"
          EngineAuth.attach(activity.applicationContext, c)
          code = c.responseCode
          if (code == 401 && attempt == 0) {
            EngineAuth.handleUnauthorized(activity.applicationContext)
            conn?.disconnect()
            continue
          }
          if (code != HttpURLConnection.HTTP_OK) {
            throw java.io.IOException("HTTP " + code)
          }
          stream = c.inputStream
          break
        }
        if (code != HttpURLConnection.HTTP_OK || stream == null) {
          throw java.io.IOException("HTTP $code")
        }
        var saved: String? = null
        stream.use { input ->
          saved = saveExportToDshData(filename, input)
        }
        val finalPath = saved
        activity.runOnUiThread {
          activity.showTestNotification("会话日志已导出", "已保存到 $finalPath")
          pushExportResult(true, "已保存到 $finalPath")
        }
      } catch (t: Throwable) {
        val message = t.message ?: "未知错误"
        activity.runOnUiThread {
          activity.showTestNotification("导出失败", message)
          pushExportResult(false, message)
        }
      } finally {
        conn?.disconnect()
        exportDownloading.set(false)
      }
    }.start()
  }

  fun openInExternalBrowser(uri: Uri): Boolean {
    if (!exportLaunching.compareAndSet(false, true)) return true // 已在途：吞掉重复触发
    return try {
      activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
      true
    } catch (_: Exception) {
      // 无浏览器可处理：回退 MediaStore 下载路径
      false
    } finally {
      exportLaunching.set(false)
    }
  }

  /**
   * 保存导出流。已授 MANAGE_EXTERNAL_STORAGE 时直写
   * Documents/dshdata/exports/<净化文件名>.zip（同名加 (1)，先写 .tmp 再 rename）；
   * 未授权回退 MediaStore.Downloads。返回用于展示的实际路径。
   */
  private fun saveExportToDshData(filename: String, input: java.io.InputStream): String {
    if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
      val exportDir = File(dshDataDir, "exports")
      exportDir.mkdirs()
      File(dshDataDir, ".nomedia").writeText("")
      val target = uniqueExportFile(exportDir, filename)
      val tmp = File(exportDir, "." + target.name + ".tmp")
      try {
        tmp.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_DOWNLOAD_BYTES) throw java.io.IOException("导出文件过大")
            out.write(buf, 0, n)
          }
        }
        if (!tmp.renameTo(target)) {
          java.nio.file.Files.move(tmp.toPath(), target.toPath())
        }
      } catch (t: Throwable) {
        tmp.delete()
        throw t
      }
      return "文档/dshdata/exports/" + target.name
    }
    val savedName = saveToDownloadsStreamed(filename, input)
    return "下载/$savedName"
  }

  /** 同名冲突加 (1) 后缀。 */
  internal fun uniqueExportFile(dir: File, name: String): File {
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var candidate = File(dir, name)
    var i = 1
    while (candidate.exists()) {
      candidate = File(dir, base + " (" + i + ")" + ext)
      i++
    }
    return candidate
  }

  /** 写入 MediaStore.Downloads（Android 10+ 免权限），流式 + 200MB 上限。 */
  internal fun saveToDownloadsStreamed(filename: String, input: java.io.InputStream): String {
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, filename)
      put(MediaStore.Downloads.MIME_TYPE, "application/zip")
      put(MediaStore.Downloads.IS_PENDING, 1)
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
    }
    val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw java.io.IOException("无法创建下载文件")
    try {
      activity.contentResolver.openOutputStream(uri)?.use { out ->
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_DOWNLOAD_BYTES) throw java.io.IOException("导出文件过大")
          out.write(buf, 0, n)
        }
      } ?: throw java.io.IOException("无法写入下载文件")
      values.clear()
      values.put(MediaStore.Downloads.IS_PENDING, 0)
      activity.contentResolver.update(uri, values, null, null)
    } catch (t: Throwable) {
      activity.contentResolver.delete(uri, null, null)
      throw t
    }
    return filename
  }

  /** 文件名净化：去路径分隔符/控制字符，限长。 */
  private fun sanitizeFilename(name: String): String {
    val cleaned = name.replace(Regex("[/\\\u0000-\u001f]"), "_").take(200)
    return if (cleaned.isBlank()) "dsh-session-export.zip" else cleaned
  }

  /** 文件名：Content-Disposition 优先，退回 URL 的 sessionId，再退回固定名。 */
  private fun parseDownloadFilename(url: String, contentDisposition: String?): String {
    contentDisposition?.let { cd ->
      Regex("filename=\"?([^\";]+)\"?").find(cd)?.groupValues?.get(1)?.let { return it }
    }
    return try {
      val q = URL(url).query ?: ""
      val sid = q.split("&").mapNotNull { seg ->
        val kv = seg.split("=", limit = 2)
        if (kv.size == 2 && kv[0] == "sessionId") kv[1] else null
      }.firstOrNull()
      if (sid != null) "dsh-session-$sid.zip" else "dsh-session-export.zip"
    } catch (_: Exception) {
      "dsh-session-export.zip"
    }
  }

  companion object {
    /** 导出文件大小上限（防恶意/异常大文件 OOM）。 */
    private const val MAX_DOWNLOAD_BYTES = 200L * 1024 * 1024
  }
}
