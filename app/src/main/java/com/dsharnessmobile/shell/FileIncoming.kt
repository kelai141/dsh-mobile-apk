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

  /**
   * 外部来件（VIEW/SEND）白名单——**只放行外部世界的真实路径**（issue #1353）。
   *
   * 为什么私有目录不在其中：这条入口的调用方是任意已安装应用（MainActivity exported），
   * 而 `file://` 方案下壳侧拿不到调用方身份（Activity 侧才有 getCallingPackage，且 file://
   * 不携带任何读授权）。前缀匹配一旦放行 `/data/data/<pkg>/`，等于「谁都能让 DSH 把私有目录
   * 里的 .credentials.yaml 拷进来件工作区，再随强制新会话交给引擎」——FileProvider 那条出口
   * 特意没映射 home/.dsh，这条入口曾经绕过了它。
   *
   * 壳侧自产来件（拍照等）不走本白名单：它们已经有 `File`，直接进 [processIncomingPath]。
   */
  private val SAFE_PREFIXES = listOf(
    "content://", "file:///storage/emulated/0/", "file:///sdcard/",
  )

  /**
   * 运行期白名单 = 编译期那三条 + **当前用户**的 primary 共享存储根（issue #1234）。
   *
   * 为什么不能只靠 `file:///storage/emulated/0/` 这条常量：多用户设备上 DSH 跑在 user 10 时，
   * 真实共享存储是 `/storage/emulated/10/`，来件的 `file://` 路径不命中 user 0 那条前缀 ⇒
   * 「无法添加外部工作区」。`/sdcard` 在多数 ROM 指向当前用户，但它不是所有 ROM 都成立，
   * 且它解决不了「路径已经被改写成 user 0」的上游问题（见 AndroidBridge.resolvePickedPath）。
   *
   * 私有目录仍然**不在**白名单内（issue #1353 的判据不变）：这里只加共享存储那一面。
   */
  private fun safePrefixes(context: Context): List<String> {
    val current = try {
      android.os.Environment.getExternalStorageDirectory()?.absolutePath
    } catch (_: Throwable) {
      null
    }
    if (current.isNullOrBlank()) return SAFE_PREFIXES
    val extra = "file://" + current.trimEnd('/') + "/"
    return if (SAFE_PREFIXES.contains(extra)) SAFE_PREFIXES else SAFE_PREFIXES + extra
  }

  /**
   * 本应用自己 FileProvider 的 authority（issue #1567）。
   *
   * `AndroidManifest.xml` 里是 `${applicationId}.fileprovider`，applicationId 为
   * `com.dsharnessmobile.shell`；这里用 `context.packageName` 动态拼，避免 build variant 改包名后失配。
   */
  internal fun ownFileProviderAuthority(packageName: String): String = packageName + ".fileprovider"

  /**
   * `content://` 是否可作外部来件接受（issue #1567）。
   *
   * 抽成纯函数是为了能单测：本仓单测 `unitTests.isReturnDefaultValues = true`，`Uri.parse` /
   * `uri.authority` 在 JVM 下恒为 null，直接对 validate 断言拿不到真值（见
   * FileExternalBridgeTest 的同类说明）。判据本身是纯字符串比较，不该因为测试环境而不可测。
   *
   * @param authority 来件 Uri 的 authority（可为 null，表示无 authority 的畸形 Uri）。
   * @param packageName 本应用包名。
   * @returns true 表示可作为外部来件接受。
   */
  internal fun acceptsContentAuthority(authority: String?, packageName: String): Boolean =
    authority != ownFileProviderAuthority(packageName)

  /**
   * 路径校验：仅接受白名单前缀的真实路径，拒绝上级跳转。返回可拷资源 Uri 描述或 null。
   *
   * issue #1567：`content://` **不再无条件放行**。来件入口是 exported 的 MainActivity，调用方是
   * 任意已安装应用；而本应用自己的 FileProvider 映射了 `home/.dsh/workspaces/` 等私有目录
   * （`res/xml/file_paths.xml`）。FileProvider 虽 `exported=false`，但调用方若与本应用同 uid
   * 侧提供的 Uri 属于「本应用自产」语义——外部应用构造 `content://<本包>.fileprovider/...` 时
   * 框架的授权检查与同 uid 情形不同，但**读取侧的权限判定不该建立在「猜对方是谁」上**。
   *
   * 判据取「authority 等于本应用 FileProvider」：那是我们自己的出口，其内容已经在
   * [processIncomingPath] 的调用链里由壳侧掌控，不需要再经这道外部来件门。允许它反而会把
   * 「私有目录里的 .credentials.yaml」变成可被外部 Intent 驱动的拷贝源——正是同文件
   * SAFE_PREFIXES 注释里写明的那个缺陷形态，`file://` 分支挡住了，`content://` 分支曾经绕过。
   *
   * 壳侧自产来件（拍照）不经过本函数：`PhotoCaptureController` 直接调 [processIncomingPath]。
   */
  fun validate(uriString: String, context: Context): Uri? {
    // A content URI's encoded document id is opaque. URLDecoder on the whole URI turns `%2F`
    // into a path separator before DocumentsProvider sees it, so a valid external file can become
    // its parent directory and copy as a zero-byte draft. Uri.parse retains encoded authority/path
    // semantics; `uri.path` below is still decoded for file:// traversal checks.
    val uri = try { Uri.parse(uriString) } catch (_: Exception) { return null }
    if (uri.scheme == null) return null
    val ok = when (uri.scheme) {
      // issue #1567：内容提供者按 authority 判。本应用 FileProvider 的 Uri 一律拒绝——
      // 它映射了私有目录（home/.dsh/workspaces 等），放行等于把私有文件变成可驱动拷贝源。
      // 其它 authority 只持临时读授权、只拷贝不引用，仍是合法来件通道。
      "content" -> acceptsContentAuthority(uri.authority, context.packageName)
      "file" -> {
        val p = uri.path ?: return null
        val prefixes = safePrefixes(context)
        prefixes.any { p.startsWith(it.removePrefix("file://").let { it }) } ||
          prefixes.any { uriString.startsWith(it) }
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
  private fun pendingPaths(context: Context): List<String>? =
    readPending(pendingFile(context))?.map { it.second }

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

  /**
   * 入待发清单。
   *
   * **同一路径已存在时保留原来源**：先入队的那条来源代表「这次来件是什么」，后到的入队不得
   * 把它改写（判据见 FileIncomingOriginTest：先 external 后 camera 同路径 → 仍是 external）。
   * 这条纪律的实际意义是：来源是**来件的属性**，不是调用时刻的属性；重试期间任何一次重复
   * 入队都不该让一个外部分享突然获得「并入用户当前会话」的能力。
   */
  private fun enqueuePending(context: Context, path: String, origin: String) {
    synchronized(pendingLock) {
      try {
        val f = pendingFile(context)
        val current = readPending(f)
        if (current == null) LogCollector.log("dsh-file-open", "pending ledger enqueue skipped (unreadable)")
        else if (current.any { it.second == path }) return
        else writePending(f, current + (normalizeOrigin(origin) to path))
      } catch (_: Exception) {
        LogCollector.log("dsh-file-open", "pending ledger enqueue failed")
      }
    }
  }

  /**
   * 读待发清单。
   *
   * 行格式是 `origin<TAB>path`（见 [encodePendingLine]）；**不含分隔符的旧行按 external 解读**
   * （升级前落盘的清单原样可读，行为不变）。
   *
   * @returns 来源 to 路径；null = 清单存在但读不出来（调用方必须跳过删除/改写）。
   */
  internal fun readPending(f: File): List<Pair<String, String>>? {
    if (!f.exists()) return emptyList()
    return try {
      f.readLines().mapNotNull { decodePendingLine(it) }
    } catch (_: Exception) {
      null
    }
  }

  /** 发布整份清单（唯一临时兄弟文件 + 原子替换）；行格式见 [encodePendingLine]。 */
  internal fun writePending(f: File, entries: List<Pair<String, String>>) {
    f.parentFile?.mkdirs()
    val temp = File.createTempFile(f.name + ".", ".tmp", f.parentFile)
    try {
      val text = entries.joinToString("\n") { encodePendingLine(it.first, it.second) } +
        if (entries.isEmpty()) "" else "\n"
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

  /**
   * 投递 body（纯函数，JVM 单测直接断言）。
   *
   * 缺陷 1 的判据落点：body 必须带 `origin`，否则引擎侧无从区分「外部分享」与「壳侧拍照」，
   * 只能一律按强制新会话处理 —— 拍照结果就进了新会话。
   *
   * @param path 临时工作区内的落点。
   * @param origin 来源；未归一的值在这里塌回 [ORIGIN_EXTERNAL]。
   */
  fun incomingRequestBody(path: String, origin: String): String =
    org.json.JSONObject()
      .put("path", path)
      .put("origin", normalizeOrigin(origin))
      .toString()

  internal fun targetedRequestBody(path: String, origin: String, targetSessionId: String, requestId: String, mediaType: String): String {
    val body = org.json.JSONObject(incomingRequestBody(path, origin))
    if (targetSessionId.isNotEmpty() || requestId.isNotEmpty()) {
      require(targetSessionId.isNotBlank() && requestId.isNotBlank())
      body.put("targetSessionId", targetSessionId).put("requestId", requestId).put("mediaType", mediaType)
    }
    return body.toString()
  }

  /** Overlay targets are immutable, process-local and never fall back to a current/new session. */
  internal fun processTargetedIncomingPath(context: Context, copied: File, targetSessionId: String, requestId: String, mediaType: String, onResult: (Boolean) -> Unit) {
    val app = context.applicationContext
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    ioExecutor.execute {
      val ok = try {
        require(targetSessionId.isNotBlank() && requestId.isNotBlank())
        require(copied.isFile && copied.canonicalFile.parentFile == tmpWorkspace(app).canonicalFile)
        withIncomingDeliveryAfterSweep(pendingLock, activeDeliveries, { sweepExpired(app) }) {
          recordOpening(app, copied.absolutePath)
          deliverOnce(app, copied.absolutePath, ORIGIN_CAMERA, targetSessionId, requestId, mediaType)
        }
      } catch (_: Throwable) { false }
      main.post { onResult(ok) }
    }
  }

  /** 单次投递尝试（无内部重试）。端点语义：HTTP 200 但 body `{ok:false}` = 拒收
   *  （路径形态/不存在）——必须核对 body 的 ok 字段，只看状态码会把拒收当成功（静默丢件）。
   *
   *  鉴权（FX-205.1/.6）：三条 file-incoming exact 路由绕过上游 /api 前缀栅栏（上游 match()
   *  先查 exact 表），必须带共享控制令牌头 `X-DSH-Control-Token`（与无障碍控制队列同一枚
   *  DeviceControlService.token；引擎侧实时读壳侧 prefs 比对）。不带 = 401 fail-closed，
   *  表现为「投递静默失败」——因此投递方与鉴权必须同批发布。 */
  private fun deliverOnce(context: Context, path: String, origin: String, targetSessionId: String = "", requestId: String = "", mediaType: String = ""): Boolean {
    return try {
      val conn = java.net.URL(EngineEndpoint.url + "/api/android/file-incoming")
        .openConnection(java.net.Proxy.NO_PROXY) as java.net.HttpURLConnection
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.connectTimeout = 3000
      conn.readTimeout = 5000
      // 共享控制令牌（壳侧生成、写 dsh-adb.xml；引擎侧同一枚）——缺它一律 401。
      conn.setRequestProperty("X-DSH-Control-Token", DeviceControlService.token(context))
      conn.outputStream.use { it.write(targetedRequestBody(path, origin, targetSessionId, requestId, mediaType).toByteArray()) }
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
      val accepted = HashSet<Pair<String, String>>()
      for (entry in lines) if (deliverOnce(context, entry.second, entry.first)) accepted += entry
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
          enqueuePending(context, target.absolutePath, ORIGIN_EXTERNAL)
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
   * @param origin 来件来源，缺省 [ORIGIN_EXTERNAL]（强制新会话）。壳侧自产拍照传
   *   [ORIGIN_CAMERA]，页面侧据此把成品并入**当前会话**而不是新建一个。
   */
  fun processIncomingPath(
    context: Context,
    copied: File,
    notify: (title: String, text: String) -> Unit,
    origin: String = ORIGIN_EXTERNAL,
  ) {
    val main = android.os.Handler(android.os.Looper.getMainLooper())
    val normalized = normalizeOrigin(origin)
    ioExecutor.execute {
      try {
        withIncomingDeliveryAfterSweep(pendingLock, activeDeliveries, { sweepExpired(context) }) {
          recordOpening(context, copied.absolutePath)
          LogCollector.log(
            "dsh-file-open",
            "incoming processed (shell-produced, origin=" + normalized + "): " + copied.absolutePath,
          )
          enqueuePending(context, copied.absolutePath, normalized)
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
      readerAllowedBy(
        readerRoots(
          activity.filesDir,
          android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS),
        ),
        file.canonicalPath,
      )
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

  /**
   * 外部阅读器白名单的**纯判据**（issue #1571）：只回答「这个规范化路径是否落在四条根之下」。
   *
   * 为什么把根表从 [isReaderAllowed] 里抽出来：两个出口（`openWithExternalReader` 与
   * `PathOpen` 的系统选择器）必须共用同一份允许面，而 JVM 单测拿不到 `MainActivity`
   * （`activity.filesDir` / `Environment.getExternalStoragePublicDirectory` 在无 Robolectric 的
   * 单测里是默认值 null）。抽出纯判据后，「允许根集合」本身可以逐条被断言——包括**不得**
   * 混进整个外部存储根这条负控。
   *
   * @param roots 允许根的 canonical 路径（由 [readerRoots] 生成）。
   * @param canonicalPath 目标的 canonical 路径。
   * @returns true = 放行。
   */
  internal fun readerAllowedBy(roots: List<String>, canonicalPath: String): Boolean =
    ChooserAllowlist.permitted(canonicalPath, roots)

  /**
   * 外部阅读器的四条允许根（顺序即 [isReaderAllowed] 的判据顺序）。
   *
   * @param filesDir 应用私有目录（`Context.filesDir`）。
   * @param externalDocuments 外部存储的 Documents 目录（`Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)`）。
   * @returns canonical 化后的根表；任一根不可解析时跳过该根（fail-closed，不抛）。
   */
  internal fun readerRoots(filesDir: java.io.File?, externalDocuments: java.io.File?): List<String> = try {
    listOfNotNull(
      filesDir?.let { java.io.File(it, "home/.dsh/workspaces") },
      filesDir?.let { java.io.File(it, "home/tmp") },
      filesDir?.let { java.io.File(it, "usr/bin") },
      externalDocuments?.let { java.io.File(it, "dshdata") },
    ).map { it.canonicalPath }
  } catch (_: Exception) {
    emptyList()
  }

  // ── 来件来源（缺陷 1：拍照后附件被投进新会话）──────────────────────────────
  //
  // 投递链把「来源」送到引擎侧，引擎侧把它记进队列记录，页面侧据此决定目标会话：
  //   external = 用户从别的应用分享/打开进来（PRD F5）⇒ **强制新会话**（F5.2 硬规则）；
  //   camera   = 用户在会话 A 里主动点「+ → 拍照」⇒ 并入**当前会话**。
  //
  // 缺省一律 external（fail-closed 到强制新会话）：漏传来源的调用方不得升级成「并入既有会话」。

  /** 外部分享/打开（缺省）。 */
  const val ORIGIN_EXTERNAL = "external"

  /** 壳侧自产来件：原生拍照。 */
  const val ORIGIN_CAMERA = "camera"

  /** 来源闭集（新增一个必须同时改引擎侧与页面侧判据）。 */
  val KNOWN_ORIGINS: Set<String> = setOf(ORIGIN_EXTERNAL, ORIGIN_CAMERA)

  /**
   * 归一来源：只有显式的 [ORIGIN_CAMERA] 才离开缺省，其余（含 null / 空串 / 拼错 / 伪造）
   * 一律塌回 [ORIGIN_EXTERNAL]。
   *
   * 为什么 fail-closed 到这个方向：external 的行为是「强制新会话」——那是既有且安全的语义。
   * 反过来把未知值当 camera，等于让一个拼错的字符串获得「并入用户当前会话」的能力。
   */
  fun normalizeOrigin(origin: String?): String =
    if (origin == ORIGIN_CAMERA) ORIGIN_CAMERA else ORIGIN_EXTERNAL

  /** 待发清单行的分隔符：`origin<TAB>path`。路径本身不含 TAB（文件名净化已剔除控制字符）。 */
  internal const val PENDING_SEPARATOR = "\t"

  /**
   * 待发清单行编码（`origin<TAB>path`）。
   *
   * 为什么清单必须带来源：清单是**重试的唯一真源**——投递失败（引擎还没 listen）后由
   * [flushPending] 补投，而 [flushPending] 也被引擎就绪钩子调用（EngineStartFlow boot 探活
   * 成功点）。清单只存路径的话，重试那一步就丢了来源，拍照来件会在补投时重新变成
   * 「强制新会话」——缺陷换个时机复活。
   */
  internal fun encodePendingLine(origin: String, path: String): String =
    normalizeOrigin(origin) + PENDING_SEPARATOR + path

  /**
   * 待发清单行解码。
   *
   * **向后兼容**：不含分隔符的行是本次改动之前（或老版本）落盘的旧格式，一律按
   * [ORIGIN_EXTERNAL] 解读——它们本来就该走强制新会话，升级后行为不变。
   *
   * @returns 来源 to 路径；空行/纯空白返回 null。
   */
  internal fun decodePendingLine(line: String): Pair<String, String>? {
    // 不能先 trim 整行：TAB 也是空白字符，trim 会把「origin 后紧跟分隔符、路径为空」的畸形行
    // 折成 "origin"，于是它会被当成一条**旧格式路径**——既丢了来源语义，又把来源字符串
    // 当成文件路径去投递。这里只去掉行尾换行（readLines 已去，留作防御），其余原样解析。
    val text = line.trimEnd('\r', '\n')
    if (text.trim().isEmpty()) return null
    val cut = text.indexOf(PENDING_SEPARATOR)
    // cut <= 0：没有分隔符（旧格式，按 external）或分隔符在最前（畸形行，同样 fail-closed）。
    if (cut <= 0) return ORIGIN_EXTERNAL to text.trim()
    val origin = normalizeOrigin(text.substring(0, cut).trim())
    val path = text.substring(cut + PENDING_SEPARATOR.length).trim()
    return if (path.isEmpty()) null else origin to path
  }

}
