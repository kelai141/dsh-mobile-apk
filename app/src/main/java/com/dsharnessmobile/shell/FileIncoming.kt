package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.File
import java.net.URLDecoder

/**
 * 文件直达会话（0.13.0 PRD F5，M3.5）：外部「使用其他应用打开 / 分享」→
 * 路径校验与文件名净化 → 安全拷贝进临时工作区 → 交给引擎侧插件强制新会话。
 *
 * - 只接受 content:// 与 file:// 真实路径；白名单前缀校验；拒绝 ../ 上级跳转
 * - 文件名净化（0.13.8 #177 白名单化）：路径分隔符 `/` `\` 是路径语义 token 一律替换、
 *   `..` 连点折叠（`..%2f` 解码后同样覆盖）、首尾点与空白去除、问号/冒号/竖线/星号/双引号等
 *   非法字符（共享存储实测非法字符集）、百分号解码、255 字节边界（超长截断 + 哈希后缀）、
 *   冲突自动重命名 (1)/(2)…
 * - 归属 fail-closed（0.13.8 #177）：拷贝落点由 safeTarget 做 canonical 归属断言
 *   （写前 + 写后各一次，双侧 canonical 化防 /data/user/0 ↔ /data/data 解析差），
 *   外部字符串拼路径的最终结果无人校验是本缺陷根因——禁止绕过该层
 * - 后台化（0.13.8 #174）：onCreate 前台只做 intent 识别与字符串校验（微秒级）；
 *   TTL 清扫/拷贝/记账/投递全部移交单线程执行器；引擎投递带待发清单与重试
 *   （冷启动 POST 早于引擎 listen 曾静默丢件）
 * - 临时工作区：files/home/.dsh/workspaces/incoming（应用数据目录，原生语义完整）；
 *   纯手动清理（D15 决策：设置页一键清理 + 占用展示）
 * - 生命周期礼仪：onTaskRemoved 时清理本次产生的临时内容（元数据幂等；拷贝进行中让路）
 */
object FileIncoming {

  /** 临时工作区目录（引擎侧以共享目录机制接入的固定路径）。 */
  fun tmpWorkspace(context: Context): File =
    File(context.filesDir, "home/.dsh/workspaces/incoming").apply { mkdirs() }

  private val SAFE_PREFIXES = listOf(
    "content://", "file:///data/user/0/com.dsharnessmobile.shell/", "file:///data/data/com.dsharnessmobile.shell/",
    "file:///storage/emulated/0/", "file:///sdcard/",
  )

  /** 路径校验：仅接受白名单前缀的真实路径，拒绝上级跳转。返回可拷资源 Uri 描述或 null。 */
  fun validate(uriString: String, context: Context): Uri? {
    val uri = try { Uri.parse(URLDecoder.decode(uriString, "UTF-8")) } catch (_: Exception) { return null }
    if (uri.scheme == null) return null
    val ok = when (uri.scheme) {
      "content" -> true // 内容提供者：临时读授权；只拷贝不引用
      "file" -> {
        val p = uri.path ?: return null
        SAFE_PREFIXES.any { p.startsWith(it.removePrefix("file://").let { it }) } ||
          SAFE_PREFIXES.any { uriString.startsWith(it) }
      }
      else -> false
    }
    if (!ok) return null
    // 上级跳转拒绝
    val path = uri.path ?: return null
    if (path.split("/").any { it == ".." }) return null
    return uri
  }

  /**
   * 文件名净化（0.13.8 #177 白名单化）：百分号解码在前（`..%2f` 解码后即 `../`），
   * 路径分隔符与 `..` 连点按路径语义 token 处理而非非法字符；首尾点与空白去除。
   * 唯一调用方 copyIn；调用后仍须经 safeTarget 归属断言（纵深）。
   */
  fun sanitizeName(raw: String): String {
    val decoded = try { URLDecoder.decode(raw, "UTF-8") } catch (_: Exception) { raw }
    val cleaned = decoded
      .replace(Regex("[?*|:\\\"<>]"), "_")
      .replace(Regex("[\\\\/]"), "_") // 路径分隔符：`..` 不是非法字符而是路径语义 token（#177 根因）
      .replace(Regex("\\.{2,}"), "_") // 连点折叠：`....//` 这类混合形态同样覆盖
      .replace(Regex("[\\u0000-\\u001f]"), "")
      .trim()
      .trim('.', '_') // 首尾点/下划线清边：纯点名折叠后只剩 `_`，尾点（Windows 保留语义）同去
      .ifEmpty { "file" }
    // 255 字节边界（UTF-8 多字节安全截断）
    var count = 0
    var cut = cleaned.length
    for (i in cleaned.indices) {
      count += cleaned[i].toString().toByteArray(Charsets.UTF_8).size
      if (count > 200) { cut = i; break }
    }
    val short = cleaned.substring(0, cut)
    if (cut < cleaned.length) {
      val suffix = cleaned.hashCode().toUInt().toString(16).take(6)
      return short + "_" + suffix
    }
    return short
  }

  /**
   * 归属断言后的落点（0.13.8 #177，fail-closed）：返回 null = 拒绝落盘。
   * 断言用双侧 canonical 比较（Android 会把 /data/user/0 解析为 /data/data，只做一侧
   * 会「永远拒绝」）；**返回值保留 dir 原始形态**——引擎侧 DSH_HOME 契约是 filesDir 的
   * 原样字符串（/data/user/0 形态），canonical 形态会被插件 safeResolveInside 的
   * 词法首门拒绝（坑 67 实测）。
   */
  internal fun safeTarget(dir: File, name: String): File? {
    return try {
      val dirCanon = dir.canonicalFile
      val target = File(dirCanon, name)
      if (target.canonicalFile.parentFile != dirCanon) return null
      File(dir, name)
    } catch (_: Exception) {
      null
    }
  }

  /** 冲突重命名：name.ext → name (1).ext / (2)… */
  fun uniqueName(dir: File, name: String): String {
    if (!File(dir, name).exists()) return name
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var i = 1
    while (File(dir, "$base ($i)$ext").exists()) i++
    return "$base ($i)$ext"
  }

  /** 文件大小上限（PRD R17 缓解：R17 注入面/隐私——超限文件拒绝进入工作区。200MB 覆盖常见文档/图片/视频）。 */
  private const val MAX_FILE_BYTES = 200L * 1024 * 1024

  /** 安全拷贝进临时工作区；返回落盘路径（或 null——超限/IO 失败/归属断言拒绝）。 */
  fun copyIn(context: Context, uri: Uri): File? {
    return try {
      val dir = tmpWorkspace(context)
      val display = queryDisplayName(context, uri) ?: "file"
      val name = uniqueName(dir, sanitizeName(display))
      val target = safeTarget(dir, name) ?: run {
        android.util.Log.w("dsh-file-open", "incoming rejected (ownership assertion): $display")
        return null
      }
      val input = context.contentResolver.openInputStream(uri) ?: return null
      input.use { ins ->
        // 有界拷贝（R17：大小上限；防御流式读取绕过 SIZE 列声明）
        var written = 0L
        target.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = ins.read(buf)
            if (n < 0) break
            written += n
            if (written > MAX_FILE_BYTES) {
              target.delete()
              return null
            }
            out.write(buf, 0, n)
          }
        }
      }
      // 写后复核（TOCTOU / 目录被符号链接替换的窗口）；失败即删，不留孤儿
      if (target.canonicalFile.parentFile != dir.canonicalFile) {
        target.delete()
        return null
      }
      target
    } catch (_: Exception) {
      null
    }
  }

  private fun queryDisplayName(context: Context, uri: Uri): String? {
    // 回落结构（0.13.8）：query 抛异常与「返回空游标」都要回落 lastPathSegment——
    // MuMu/Android 15 对 file:// 返回空游标（不抛异常），旧结构在那里直接掉 "file" 占位。
    val viaQuery = try {
      context.contentResolver.query(
        uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null,
      )?.use { c ->
        if (c.moveToFirst()) c.getString(c.getColumnIndexOrThrow(android.provider.OpenableColumns.DISPLAY_NAME)) else null
      }
    } catch (_: Exception) {
      null
    }
    return viaQuery?.takeIf { it.isNotBlank() }
      ?: uri.lastPathSegment?.takeIf { it.isNotBlank() }
  }

  /** 元数据：本次打开的会话清单（生命礼仪清理的依据）。 */
  fun metaFile(context: Context): File = File(tmpWorkspace(context), ".meta.ndjson")

  fun recordOpening(context: Context, path: String) {
    try {
      metaFile(context).appendText(
        System.currentTimeMillis().toString() + "\t" + path + "\n",
      )
    } catch (_: Exception) {
    }
  }

  /** 临时文件保留窗口（PRD F5.1 / issue #60：「文件定时清理（如七天）」——不配置工作区时
   *  临时工作区按 TTL 自动回收，避免无限堆积）。 */
  private const val TTL_MS = 7L * 24 * 60 * 60 * 1000

  /**
   * 定时清理（TTL 7 天）：删除超过保留窗口的临时文件（含子目录）、以及超过窗口的历史会话元数据行。
   * 幂等；在应用启动（onCreate）与每次文件入队前调用——不打扰未过期内容。
   * onTaskRemoved 的 cleanupTmp 仍保留（进程被系统回收时的即时全清礼仪）。
   */
  fun sweepExpired(context: Context) {
    try {
      val dir = tmpWorkspace(context)
      val now = System.currentTimeMillis()
      val list = dir.listFiles() ?: return
      var removed = 0
      for (f in list) {
        if (f.name == ".sessions") continue // 引擎侧队列元数据：由 claim 消费删除
        val last = f.lastModified()
        if (last > 0 && now - last > TTL_MS) {
          if (f.delete() || !f.exists()) removed++
        }
      }
      if (removed > 0) {
        LogCollector.log("dsh-file-open", "temp workspace TTL sweep removed $removed expired file(s)")
      }
    } catch (_: Exception) {
    }
  }

  /** 清理本次临时会话与临时工作区内容（幂等；不阻塞进程退出——生命周期礼仪 F5.3）。
   *  拷贝在途时让路（0.13.8 #174：后台拷贝与 onTaskRemoved 全清曾可竞态删半个文件），
   *  残余内容交给下次 TTL 清扫。 */
  fun cleanupTmp(context: Context) {
    if (activeCopies.get() > 0) {
      LogCollector.log("dsh-file-open", "temp workspace clean skipped (copy in flight)")
      return
    }
    try {
      val dir = tmpWorkspace(context)
      dir.listFiles()?.forEach { it.delete() }
      LogCollector.log("dsh-file-open", "temp workspace cleaned (task removed ritual)")
    } catch (_: Exception) {
    }
  }

  /** 来件 IO 专用单线程执行器（0.13.8 #174：onCreate 前台零 IO——尺寸不可预知的拷贝
   *  与首帧事务曾同线串行，200MB 提供方可达数十秒 = 无上界阻塞）。daemon = 不阻断进程退出。 */
  private val ioExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newSingleThreadExecutor { r ->
      Thread(r, "dsh-file-incoming").apply { isDaemon = true }
    }

  /** 拷贝在途计数（cleanupTmp 让路依据，避免删半个文件）。 */
  private val activeCopies = java.util.concurrent.atomic.AtomicInteger(0)

  /** 待发清单：已落盘但引擎未确认受理的路径（冷启动 POST 早于 listen 曾静默丢件）。 */
  private fun pendingFile(context: Context): File = File(tmpWorkspace(context), ".pending-notify.ndjson")

  private fun enqueuePending(context: Context, path: String) {
    try {
      pendingFile(context).appendText(path + "\n")
    } catch (_: Exception) {
    }
  }

  /** 单次投递尝试（无内部重试）。端点语义：HTTP 200 但 body `{ok:false}` = 拒收
   *  （路径形态/不存在）——必须核对 body 的 ok 字段，只看状态码会把拒收当成功（静默丢件）。 */
  private fun deliverOnce(path: String): Boolean {
    return try {
      val conn = java.net.URL("http://127.0.0.1:3080/api/android/file-incoming")
        .openConnection(java.net.Proxy.NO_PROXY) as java.net.HttpURLConnection
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.connectTimeout = 3000
      conn.readTimeout = 5000
      conn.outputStream.use { it.write(org.json.JSONObject().put("path", path).toString().toByteArray()) }
      val code = conn.responseCode
      val ok = if (code in 200..299) {
        val body = conn.inputStream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        try { org.json.JSONObject(body).optBoolean("ok", false) } catch (_: Exception) { false }
      } else false
      conn.disconnect()
      ok
    } catch (_: Exception) {
      false
    }
  }

  /**
   * 清待发清单（0.13.8 #174）：逐条投递，未确认的写回。返回 true = 清单已空。
   * 调用点：来件后台流（短促重试）与引擎就绪钩子（EngineStartFlow boot 探活成功点，
   * 冷启动竞态的确定性补投路径）。
   */
  fun flushPending(context: Context): Boolean {
    val f = pendingFile(context)
    val lines = try { f.readLines().filter { it.isNotBlank() } } catch (_: Exception) { return true }
    if (lines.isEmpty()) { try { f.delete() } catch (_: Exception) {} ; return true }
    val remaining = lines.filter { !deliverOnce(it) }
    if (remaining.isEmpty()) {
      try { f.delete() } catch (_: Exception) {}
      LogCollector.log("dsh-file-open", "pending incoming flushed (${lines.size} file(s))")
    } else {
      try { f.writeText(remaining.joinToString("\n") + "\n") } catch (_: Exception) {}
    }
    return remaining.isEmpty()
  }

  /**
   * VIEW/SEND 外部来件接线（0.13.0 F5/M3.5；自 MainActivity.maybeProcessIncoming 迁入）：
   * 校验净化 → 拷贝临时工作区 → 通知引擎侧插件。
   * 外部路径不留原件引用（一律拷贝，权限模型对齐 F1.8）；引擎未启动先启动（启动流先于通知）。
   * 0.13.8 #174 后台化：本函数在 onCreate 主线程调用，前台只做 intent 识别 + 字符串校验，
   * 微秒级返回；IO 与投递全部在 ioExecutor。notify 一律 post 回主线程（launcher 限制）。
   */
  fun processIncomingIntent(context: Context, intent: Intent?, notify: (title: String, text: String) -> Unit) {
    if (intent == null) return
    val action = intent.action
    val uri: Uri? = when (action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    }
    if (uri == null) return
    val validated = validate(uri.toString(), context) ?: run {
      notify("文件直达被拒绝", "路径不在允许范围（仅系统打开/分享的真实路径）")
      return
    }
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    ioExecutor.execute {
      try {
        // 每次文件入队前先做 TTL 清扫（issue #60 F5.1：临时文件 7 天自动回收，防止无限堆积）
        sweepExpired(context)
        activeCopies.incrementAndGet()
        val target = try {
          copyIn(context, validated)
        } finally {
          activeCopies.decrementAndGet()
        }
        if (target == null) {
          main.post { notify("文件拷贝失败", "无法读取传入文件") }
          return@execute
        }
        recordOpening(context, target.absolutePath)
        LogCollector.log("dsh-file-open", "incoming processed: " + target.absolutePath)
        // 引擎侧插件端点：路径交给 dsh-android-file-open 强制新会话。
        // 待发清单 + 短促重试（引擎就绪钩子会再补投，冷启动不再丢件）：
        enqueuePending(context, target.absolutePath)
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
          if (flushPending(context)) return@execute
          try { Thread.sleep(4_000) } catch (_: InterruptedException) { return@execute }
        }
      } catch (t: Throwable) {
        android.util.Log.w("dsh-file-open", "incoming pipeline failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
  }

  /**
   * 用外部阅读器打开文件路径（issue #52；自 MainActivity.openNativePathWithReader 迁入）：
   * 引擎 native-path-opener 仅支持 mac/win/linux，Android 上文件提及按钮会失败。路径解析：
   * - /storage/emulated/0/Documents/dshdata/...（导出仓库）→ FileProvider content Uri
   * - 应用私有文件区（工作区/usr/bin）→ FileProvider content Uri
   * - 其他（content://、不可读、或私密区路径如 .dsh/.credentials.yaml）→ false，
   *   前端回退引擎 RPC（桌面宿主行为）。
   * 安全（2026-08-23 CRITICAL 修复）：运行时白名单 canonical 校验，与
   * res/xml/file_paths.xml 的映射面一致——FileProvider 若配到更宽路径也会被此层拦截。
   */
  fun openWithExternalReader(activity: MainActivity, path: String): Boolean {
    return try {
      val file = java.io.File(path)
      if (!file.exists()) {
        android.util.Log.w("dsh-image", "openNativePath: not exists: $path")
        return false
      }
      if (!isReaderAllowed(activity, file)) {
        android.util.Log.w("dsh-image", "openNativePath rejected (outside reader whitelist): $path")
        return false
      }
      val uri = androidx.core.content.FileProvider.getUriForFile(
        activity, activity.packageName + ".fileprovider", file,
      )
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(intent)
      android.util.Log.i("dsh-image", "openNativePath ok: $path")
      true
    } catch (e: Exception) {
      android.util.Log.w("dsh-image", "openNativePath failed: $path -> ${e.message}")
      false
    }
  }

  /** 外部阅读器白名单（与 res/xml/file_paths.xml 映射面一致；canonical 比较防 symlink/.. 逃逸）。
   *  0.13.7：PathOpen（系统选择器）复用同一道门——两处出口同一份允许面。 */
  internal fun isReaderAllowed(activity: MainActivity, file: java.io.File): Boolean {
    return try {
      val canon = file.canonicalPath
      val roots = listOf(
        java.io.File(activity.filesDir, "home/.dsh/workspaces"),
        java.io.File(activity.filesDir, "home/tmp"),
        java.io.File(activity.filesDir, "usr/bin"),
        java.io.File(
          android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS),
          "dshdata",
        ),
      ).map { it.canonicalPath }
      roots.any { root -> canon == root || canon.startsWith(root + java.io.File.separator) }
    } catch (_: Exception) {
      false
    }
  }
}
