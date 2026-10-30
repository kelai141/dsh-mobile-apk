package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.File
import java.net.URLDecoder

/**
 * 文件直达会话（0.13.0 PRD F5，M3.5）：外部「使用其他应用打开 / 分享」→
 * 路径校验与文件名净化 → 安全拷贝进临时工作区 → 交给引擎侧插件创建空白强制新会话与
 * 未发送的 file attachment 草稿。壳侧不生成 `@路径` user message，也不自动发送。
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
    // A content URI's encoded document id is opaque. URLDecoder on the whole URI turns `%2F`
    // into a path separator before DocumentsProvider sees it, so a valid external file can become
    // its parent directory and copy as a zero-byte draft. Uri.parse retains encoded authority/path
    // semantics; `uri.path` below is still decoded for file:// traversal checks.
    val uri = try { Uri.parse(uriString) } catch (_: Exception) { return null }
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
  fun metaFile(context: Context): File = File(tmpWorkspace(context), META_ENTRY)

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
   * 待发清单与 `.sessions` 仍引用的来件受与 [cleanupTmp] 相同的保护；目录不递归删除。
   * onTaskRemoved 的 cleanupTmp 仍保留（进程被系统回收时的即时全清礼仪）。
   */
  fun sweepExpired(context: Context) {
    synchronized(pendingLock) {
      if (!workspaceWipeAllowed(activeCopies.get(), activeDeliveries.get())) {
        LogCollector.log("dsh-file-open", "temp workspace TTL sweep skipped (copy/delivery in flight)")
        return
      }
      try {
        val dir = tmpWorkspace(context)
        val now = System.currentTimeMillis()
        val pending = pendingPaths(context) ?: return
        val queued = queuedSessionPaths(context) ?: return
        val removed = sweepWorkspace(dir, pending, queued, now, TTL_MS)
        if (removed > 0) {
          LogCollector.log("dsh-file-open", "temp workspace TTL sweep removed $removed expired file(s)")
        }
      } catch (_: Exception) {
      }
    }
  }

  /** 元数据条目名（生命礼仪豁免面，与 .sessions 对称）。 */
  private const val SESSIONS_ENTRY = ".sessions"
  private const val PENDING_ENTRY = ".pending-notify.ndjson"
  internal const val META_ENTRY = ".meta.ndjson"

  /**
   * 全清是否可执行（纯函数，JVM 单测锁定）：拷贝与投递/重试两段都静默才许全清。
   *
   * FX-211.2（F-211.2 双重静默）：旧实现只看 activeCopies——copyIn 的 finally 一减，
   * 「recordOpening → enqueuePending → 20s 重试」就全在守卫之外；用户「分享到 DSH」后数秒内
   * 划掉应用（EngineService.onTaskRemoved → cleanupTmp）时计数已归零 → 顶层全删：刚拷好的
   * 来件、待发清单、会话元数据一起消失，且**无重试、无残留、无日志**。
   */
  internal fun workspaceWipeAllowed(copies: Int, deliveries: Int): Boolean = copies <= 0 && deliveries <= 0

  /**
   * 本次全清要删的条目名（纯函数，JVM 单测锁定）。豁免面 = 三个元数据条目（.sessions /
   * .pending-notify.ndjson / .meta.ndjson）∪ 待发清单或 `.sessions` 队列仍引用的来件——
   * 「仍可投递或仍待浏览器草稿 claim 的文件不许删」，与源文件 TTL 清理职责分离。
   */
  internal fun cleanupDeletions(
    entries: List<String>,
    pendingPaths: List<String>,
    queuedPaths: List<String> = emptyList(),
  ): List<String> {
    val protectedNames = (pendingPaths + queuedPaths).map { File(it).name }.toSet()
    return entries.filter {
      it != SESSIONS_ENTRY && it != PENDING_ENTRY && it != META_ENTRY && it !in protectedNames
    }
  }

  /** Same protection rules for the TTL pass; manifest itself is never deleted by age. */
  internal fun ttlDeletions(
    entries: List<String>,
    pendingPaths: List<String>,
    queuedPaths: List<String> = emptyList(),
  ): List<String> = cleanupDeletions(entries, pendingPaths, queuedPaths)

  /** Apply the TTL policy to a real directory. Null references mean unreadable: skip deletion. */
  internal fun sweepWorkspace(
    dir: File,
    pendingPaths: List<String>?,
    queuedPaths: List<String>?,
    now: Long,
    ttlMs: Long,
  ): Int {
    if (pendingPaths == null || queuedPaths == null) return 0
    val list = dir.listFiles() ?: return 0
    val deletions = ttlDeletions(list.map { it.name }, pendingPaths, queuedPaths).toSet()
    var removed = 0
    for (file in list) {
      if (file.name !in deletions || file.isDirectory) continue
      val last = file.lastModified()
      if (last > 0 && now - last > ttlMs && file.delete()) removed++
    }
    return removed
  }

  /** null = read failure. Callers that delete files must skip the pass rather than assume empty. */
  private fun pendingPaths(context: Context): List<String>? = readPending(pendingFile(context))

  /** Engine queue records whose source file must survive task removal until the browser claims it. */
  private fun queuedSessionPaths(context: Context): List<String>? =
    readQueuedSessionPaths(File(tmpWorkspace(context), SESSIONS_ENTRY))

  /** null = the queue exists but cannot be fully read; callers must not delete on null. */
  internal fun readQueuedSessionPaths(dir: File): List<String>? {
    if (!dir.exists()) return emptyList()
    return try {
      val files = dir.listFiles { file -> file.isFile && file.name.endsWith(".json") } ?: return null
      val result = mutableListOf<String>()
      for (file in files) {
        val record = try { org.json.JSONObject(file.readText()) } catch (_: Exception) { return null }
        val path = record.opt("path") as? String ?: return null
        if (path.isBlank()) return null
        result += path
      }
      result
    } catch (_: Exception) {
      null
    }
  }

  /** 清理本次临时会话与临时工作区内容（幂等；不阻塞进程退出——生命周期礼仪 F5.3）。
   *  拷贝在途时让路（0.13.8 #174：后台拷贝与 onTaskRemoved 全清曾可竞态删半个文件），
   *  FX-211.2 起**投递/重试在途时同样让路**，且任何仍被待发清单或 `.sessions` 草稿队列引用的来件与三个元数据条目
   *  一律不删（残余内容交给下次 TTL 清扫）。 */
  fun cleanupTmp(context: Context) {
    synchronized(pendingLock) {
      if (!workspaceWipeAllowed(activeCopies.get(), activeDeliveries.get())) {
        LogCollector.log("dsh-file-open", "temp workspace clean skipped (copy/delivery in flight)")
        return
      }
      try {
        val dir = tmpWorkspace(context)
        val entries = dir.listFiles()?.map { it.name } ?: emptyList()
        val pending = pendingPaths(context) ?: return
        val queued = queuedSessionPaths(context) ?: return
        val deletions = cleanupDeletions(entries, pending, queued)
        var removed = 0
        for (name in deletions) {
          if (File(dir, name).delete()) removed++
        }
        LogCollector.log(
          "dsh-file-open",
          "temp workspace cleaned (task removed ritual; removed=" + removed + " kept=" + (entries.size - removed) + ")",
        )
      } catch (_: Exception) {
      }
    }
  }

  /** 来件 IO 专用单线程执行器（0.13.8 #174：onCreate 前台零 IO——尺寸不可预知的拷贝
   *  与首帧事务曾同线串行，200MB 提供方可达数十秒 = 无上界阻塞）。daemon = 不阻断进程退出。
   *  issue #1006：本执行器只做 IO，不得承载投递重试的有界等待（重试已搬到类尾的
   *  deliveryRetryExecutor；旧实现在这条单线程上跑 20s 重试循环，后一个来件要排队等满窗口）。 */
  private val ioExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newSingleThreadExecutor { r ->
      Thread(r, "dsh-file-incoming").apply { isDaemon = true }
    }

  /** 拷贝在途计数（cleanupTmp 让路依据，避免删半个文件）。 */
  private val activeCopies = java.util.concurrent.atomic.AtomicInteger(0)

  /** FX-211.2：投递 + 重试在途计数。拷贝后的记账/入待发清单/20s 重试原本全在守卫外，
   *  「分享来件 → 数秒内划掉应用」时 cleanupTmp 看到拷贝计数已归零 → 顶层全删 = 静默丢件。 */
  private val activeDeliveries = java.util.concurrent.atomic.AtomicInteger(0)

  /** 待发清单：已落盘但引擎未确认受理的路径（冷启动 POST 早于 listen 曾静默丢件）。 */
  private fun pendingFile(context: Context): File = File(tmpWorkspace(context), PENDING_ENTRY)

  /** One serialized read-modify-write owner for the pending ledger and its delivery attempts. */
  private val pendingLock = Any()

  /**
   * Run the TTL sweep before reserving the delivery window, with both steps under the
   * same lock as [cleanupTmp]. The sweep must observe a quiescent workspace; cleanup
   * must observe the reservation before this thread can start copying a new source.
   *
   * The body runs after the lock is released so hashing/copying and the bounded retry
   * loop cannot block the pending ledger's other readers and writers. The reservation
   * is always released, including when the body throws.
   */
  internal fun <T> withIncomingDeliveryAfterSweep(
    lock: Any,
    deliveries: java.util.concurrent.atomic.AtomicInteger,
    sweep: () -> Unit,
    body: () -> T,
  ): T {
    synchronized(lock) {
      sweep()
      deliveries.incrementAndGet()
    }
    try {
      return body()
    } finally {
      deliveries.decrementAndGet()
    }
  }

  private fun enqueuePending(context: Context, path: String) {
    synchronized(pendingLock) {
      try {
        val f = pendingFile(context)
        val current = readPending(f)
        if (current == null) LogCollector.log("dsh-file-open", "pending ledger enqueue skipped (unreadable)")
        else writePending(f, current + listOf(path))
      } catch (_: Exception) {
        LogCollector.log("dsh-file-open", "pending ledger enqueue failed")
      }
    }
  }

  /** null = the ledger exists but could not be read; [] = it is absent or empty. */
  internal fun readPending(f: File): List<String>? {
    if (!f.exists()) return emptyList()
    return try {
      f.readLines().map { it.trim() }.filter { it.isNotEmpty() }
    } catch (_: Exception) {
      null
    }
  }

  /** Publish a complete ledger with a unique sibling temp file and an atomic replacement. */
  internal fun writePending(f: File, paths: List<String>) {
    f.parentFile?.mkdirs()
    val temp = File.createTempFile(f.name + ".", ".tmp", f.parentFile)
    try {
      val text = paths.joinToString("\n") + if (paths.isEmpty()) "" else "\n"
      java.io.FileOutputStream(temp).use { output ->
        output.write(text.toByteArray(Charsets.UTF_8))
        output.flush()
        output.fd.sync()
      }
      java.nio.file.Files.move(
        temp.toPath(), f.toPath(),
        java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
      )
    } finally {
      temp.delete()
    }
  }

  /** 单次投递尝试（无内部重试）。端点语义：HTTP 200 但 body `{ok:false}` = 拒收
   *  （路径形态/不存在）——必须核对 body 的 ok 字段，只看状态码会把拒收当成功（静默丢件）。
   *
   *  鉴权（FX-205.1/.6）：三条 file-incoming exact 路由绕过上游 /api 前缀栅栏（上游 match()
   *  先查 exact 表），必须带共享控制令牌头 `X-DSH-Control-Token`（与无障碍控制队列同一枚
   *  DeviceControlService.token；引擎侧实时读壳侧 prefs 比对）。不带 = 401 fail-closed，
   *  表现为「投递静默失败」——因此投递方与鉴权必须同批发布。 */
  private fun deliverOnce(context: Context, path: String): Boolean {
    return try {
      val conn = java.net.URL(EngineEndpoint.url + "/api/android/file-incoming")
        .openConnection(java.net.Proxy.NO_PROXY) as java.net.HttpURLConnection
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.connectTimeout = 3000
      conn.readTimeout = 5000
      // 共享控制令牌（壳侧生成、写 dsh-adb.xml；引擎侧同一枚）——缺它一律 401。
      conn.setRequestProperty("X-DSH-Control-Token", DeviceControlService.token(context))
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
    synchronized(pendingLock) {
      val f = pendingFile(context)
      val lines = readPending(f) ?: return false
      if (lines.isEmpty()) { try { f.delete() } catch (_: Exception) {} ; return true }
      val accepted = HashSet<String>()
      for (line in lines) if (deliverOnce(context, line)) accepted += line
      try {
        val current = readPending(f) ?: return false
        val remaining = current.filter { it !in accepted }
        if (remaining.isEmpty()) f.delete() else writePending(f, remaining)
        if (remaining.isEmpty()) LogCollector.log("dsh-file-open", "pending incoming flushed (${lines.size} file(s))")
        return remaining.isEmpty()
      } catch (_: Exception) {
        return false
      }
    }
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
        withIncomingDeliveryAfterSweep(pendingLock, activeDeliveries, { sweepExpired(context) }) {
          // 每次文件入队前先做 TTL 清扫（issue #60 F5.1：临时文件 7 天自动回收，防止无限堆积）
          // 与投递预留同锁完成，见 withIncomingDeliveryAfterSweep。
          // FX-211.2：把守卫从「拷贝」扩到「投递 + 重试期」——这一段里 tmp 工作区中的来件与待发
          // 清单都不能被 onTaskRemoved 的全清吃掉（划掉应用 = 用户主动关闭，不等于丢弃来件）。
          activeCopies.incrementAndGet()
          val target = try {
            copyIn(context, validated)
          } finally {
            activeCopies.decrementAndGet()
          }
          if (target == null) {
            main.post { notify("文件拷贝失败", "无法读取传入文件") }
            return@withIncomingDeliveryAfterSweep
          }
          recordOpening(context, target.absolutePath)
          LogCollector.log("dsh-file-open", "incoming processed: " + target.absolutePath)
          // 引擎侧插件端点：路径交给 dsh-android-file-open 强制新会话。
          // 待发清单 + 短促重试（引擎就绪钩子会再补投，冷启动不再丢件）：
          enqueuePending(context, target.absolutePath)
          // issue #1006：重试不在这条单线程上——否则后一个来件要排队等满 20s（旧实现把
          // 20s 重试循环放在 ioExecutor 上）。拷贝与入队已完成，等待受理交给类尾的
          // deliveryRetryExecutor；下面这行在 IO 线程上同步返回。
          retryDelivery(context, deliveryRetryBudgetMs) { }
        }
      } catch (t: Throwable) {
        android.util.Log.w("dsh-file-open", "incoming pipeline failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
  }

  /**
   * 把**已在临时工作区内**的文件交给既有来件通路（拍照等壳侧自产来件的入口）。
   *
   * 为什么单独开一个入口而不是让调用方自己 enqueuePending + flushPending：
   * 「记账 → 入待发清单 → 短促重试 → 引擎受理」是一个整体，投递预留计数（activeDeliveries）
   * 必须在整段里持有，否则「刚入队就划掉应用」会让 cleanupTmp 把在途来件与清单一起删掉
   * （FX-211.2 的现场）。调用方只负责把文件**拷进**临时工作区；之后的投递全在这里，
   * 且与「外部分享一个文件进来」走的是同一段代码，不会出现第二条投递链。
   *
   * @param context 宿主上下文。
   * @param copied 已落在 [tmpWorkspace] 内的文件（调用方应已用 [copyIn] 拷入）。
   * @param notify 投递结果提示（主线程回调；title, text）。
   */
  fun processIncomingPath(context: Context, copied: File, notify: (title: String, text: String) -> Unit) {
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    ioExecutor.execute {
      try {
        withIncomingDeliveryAfterSweep(pendingLock, activeDeliveries, { sweepExpired(context) }) {
          recordOpening(context, copied.absolutePath)
          LogCollector.log("dsh-file-open", "incoming processed (shell-produced): " + copied.absolutePath)
          enqueuePending(context, copied.absolutePath)
        }
        // issue #1006：重试**不在这条单线程上**——否则后一个来件要排队等满 20s。
        // 拷贝与入队已经完成，这里只把「等待受理」交给独立的重试线程。
        retryDelivery(context, deliveryRetryBudgetMs) {
          main.post { notify("文件投递未确认", "引擎暂未受理，稍后自动重试") }
        }
      } catch (t: Throwable) {
        android.util.Log.w("dsh-file-open", "incoming pipeline failed: " + (t.message ?: t.javaClass.simpleName))
        main.post { notify("文件投递失败", t.message ?: t.javaClass.simpleName) }
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

  /**
   * 投递重试专用执行器（issue #1006）：**每个来件一个线程**，不与会话/拷贝串行。
   *
   * 为什么必须与 ioExecutor 分开：重试是「等待 + 轮询」，最长 20s，且大部分时间在 Thread.sleep。
   * 把它放在单线程上等于让 IO 队列为一个纯等待付阻塞代价。这里用 cached pool（线程在等待期间
   * 不占 CPU，且来件本就低频），daemon 同样不阻断进程退出。
   *
   * 放在类尾而非 ioExecutor 旁边：既有 EXECUTION-MAP 锚点按行号引用本文件 30+ 处，插在中段会
   * 让它们整体位移（本轮实测 13 条漂移）。新增成员集中在末尾可保持零位移。
   */
  private val deliveryRetryExecutor: java.util.concurrent.ExecutorService =
    java.util.concurrent.Executors.newCachedThreadPool { r ->
      Thread(r, "dsh-file-deliver").apply { isDaemon = true }
    }

  /** 投递重试的总预算与间隔（issue #1006；与 0.13.8 起的 20s / 4s 口径完全一致）。 */
  private val deliveryRetryBudgetMs = 20_000L
  private val deliveryRetryIntervalMs = 4_000L

  /**
   * 有界投递重试（issue #1006）：把「等待 + flushPending」这段从 IO 线程搬到
   * [deliveryRetryExecutor]，并在整段里持有投递预留计数。
   *
   * 为什么不复用 [withIncomingDeliveryAfterSweep]：那个函数把 sweep 与预留做成一个原子步，
   * 而这里**必须**在拷贝完成、已入待发清单之后才开始（sweep 若在重试期再跑一次，会把刚入队的
   * 路径当过期条目清掉）。所以这里只做「预留 → 重试 → 释放」，与调用方已完成的拷贝段解耦。
   */
  private fun retryDelivery(context: Context, deadlineMs: Long, onExhausted: () -> Unit) {
    deliveryRetryExecutor.execute {
      activeDeliveries.incrementAndGet()
      try {
        val deadline = System.currentTimeMillis() + deadlineMs
        while (System.currentTimeMillis() < deadline) {
          if (flushPending(context)) return@execute
          try {
            Thread.sleep(deliveryRetryIntervalMs)
          } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return@execute
          }
        }
        onExhausted()
      } catch (t: Throwable) {
        android.util.Log.w("dsh-file-open", "delivery retry failed: " + (t.message ?: t.javaClass.simpleName))
      } finally {
        activeDeliveries.decrementAndGet()
      }
    }
  }
}
