package com.dsharnessmobile.shell

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * Linux 环境资产 IO：宿主侧「下载 + 校验 + 安全解包」原语（0.15.0）。
 *
 * 为什么在宿主侧：bootstrap 的 `apply(ctx, config)` 需要**函数型 config**
 * （`linuxAssetIO.downloadAsset` / `extractArchive`），Cordis profile 的 YAML 装配表达不了，
 * 所以 bootstrap 只能被动态加载；而 `.tar.xz` 的解码在 Node 侧没有实现（Node 的 zlib 不含 xz，
 * 本仓 node_modules 里也没有任何 xz/tar 包），宿主已有的解码与解包能力才是可复用的那一份。
 * 因此字节获取这一半交给宿主，bootstrap 仍**拥有**版本/状态/校验/激活的权威。
 *
 * 复用了本仓已在生产路径的实现，而不是另写一套安全判据：
 *   * [LinuxAssetExtractor]：xz tar 解包，按资产 kind 判定符号链接；共同拒绝绝对条目名/`..`/
 *     hardlink/特殊文件/父路径符号链接，并带解压炸弹上限。rootfs 的绝对 guest 链接只做词法判定，
 *     不会被宿主 canonicalPath 解引用。
 *   * [SnapshotBundledAsset.digest]：流式 SHA-256 **并返回实读字节数**，一次读同时给出摘要与体量，
 *     正好对应「摘要 + 字节数都要验」。
 *
 * 刻意**不复用** `UpdateChecker.download`：它走 gh-proxy 镜像链（含第三方前缀），而本对象
 * 的来源面要求是「只认本仓 Releases 的 https 直连」，两者是相反的策略。这里只沿用它的
 * 连接超时/逐跳重定向/tmp + 原子 rename 形态，并把主机白名单改成逐跳强制。
 *
 * 绝不 shell out：解包全程走 commons-compress + tukaani xz 的进程内解码器。
 */
internal object LinuxAssetIO {

  /** Linux 环境根目录名（bootstrap 的 dataDir，见 `DSH_FILES_DIR/linux-environment`）。 */
  const val ENV_DIR = "linux-environment"

  /**
   * bootstrap 自证「控制面在场」的状态文件。
   *
   * 作为门禁依据的理由（实测 `plugins/dsh-linux-bootstrap/src/index.js:418-432` 的 `load()`）：
   * 它在 bootstrap 构造时就会 `mkdir` 根/cache/plugins 三个目录，并在状态文件缺席时立刻
   * `save()` 一份 `enabled:false` 的初始状态。所以该文件在场 == 控制面真的起来了，且它
   * **早于**首次安装就存在 —— 用它做门禁不会把首次安装自己挡在外面。
   */
  const val STATE_FILE = "linux-bootstrap-state.json"

  const val CODE_NOT_ENABLED = "linux-asset-not-enabled"
  const val CODE_URL_REJECTED = "linux-asset-url-rejected"
  const val CODE_DESTINATION_ESCAPE = "linux-asset-destination-escape"
  const val CODE_UNSAFE_ARCHIVE = "linux-asset-unsafe-archive"
  const val CODE_SPEC_INVALID = "linux-asset-spec-invalid"
  const val CODE_DIGEST_MISMATCH = "linux-asset-digest-mismatch"
  const val CODE_SIZE_MISMATCH = "linux-asset-size-mismatch"
  const val CODE_DOWNLOAD_FAILED = "linux-asset-download-failed"
  const val CODE_KIND_INVALID = "linux-asset-kind-invalid"

  /**
   * 资产类型：决定符号链接的合法目标面。
   *
   * `rootfs` 里的绝对链接是 **guest** 语义（`/bin -> usr/bin`），必须保留且不能按宿主路径解引用；
   * `backend` / `node` / `plugin` 的链接只允许落在解包根内的相对目标。
   */
  enum class Kind(val wire: String) {
    PLUGIN("plugin"),
    BACKEND("backend"),
    ROOTFS("rootfs"),
    NODE("node");

    companion object {
      /** 缺省 `plugin`；`runtime-plugin` 是旧 UI 的兼容别名。 */
      fun parse(raw: String?): Kind? {
        val value = raw?.trim()?.lowercase()
        if (value == null) return PLUGIN
        if (value.isEmpty()) return null
        if (value == "runtime-plugin") return PLUGIN
        return entries.firstOrNull { it.wire == value }
      }
    }
  }

  /** Debug-only 本地回放配置：私有目录下的单行 loopback origin。 */
  const val DEBUG_ORIGIN_FILE = "debug-download-origin"

  /**
   * 清单里的字面量不合规（摘要是路径段的来源，必须先于**任何**文件系统使用判定）。
   *
   * 摘要在宿主侧被当成**路径段**使用（暂存目录按摘要命名）。没有格式校验时
   * `sha256 = "../../../app_state"` 会让 [SnapshotFs.deletePath]（无包含关系检查的递归删除）
   * 删掉环境根**之外**的目录。格式口径与上游 bootstrap 自己的校验器逐字一致（`/^[a-f0-9]{64}$/`）。
   * `@JavascriptInterface` 是页面可直达的公开边界，必须自己校验入参，不能假定调用方已校验。
   */
  val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")


  /** 允许的来源主机：本仓 Releases 直连 + GitHub 资产 CDN（重定向落点），逐跳校验。 */
  val ALLOWED_HOSTS = setOf(
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  )

  /** 只接受本仓 Linux 插件的版本化 Release 资产路径。 */
  const val REQUIRED_PATH_PREFIX = "/kelai141/dsh-bionilux/releases/download/"

  const val MAX_REDIRECTS = 5

  /** 声明体量之上的兜底上限，避免被无限流拖住（插件包远小于此）。 */
  const val MAX_DOWNLOAD_BYTES = 512L * 1024L * 1024L

  /** 资产清单条目：与 bootstrap 的 `{url, sha256, size}` 同形。 */
  data class Spec(
    val url: String,
    val sha256: String,
    val size: Long,
    val kind: Kind = Kind.PLUGIN,
  )

  /** 失败原因：稳定 code + 可落盘的一行 detail。 */
  data class Failure(val code: String, val detail: String)

  /**
   * 首个 URL 的合规判据（纯函数，便于反证）：
   * 必须 https、主机在白名单、路径必须是本仓 Releases 的 download 形态，且不得带 query/fragment。
   */
  fun urlVerdict(raw: String): String? {
    val url = try { URL(raw) } catch (_: Exception) { return "不是合法 URL" }
    if (!url.protocol.equals("https", ignoreCase = true)) return "只接受 https（实际 ${url.protocol}）"
    if (url.host?.lowercase() !in ALLOWED_HOSTS) return "主机不在白名单：${url.host}"
    if (!url.path.startsWith(REQUIRED_PATH_PREFIX)) return "路径不是本仓 Releases 资产：${url.path}"
    if (url.query != null || url.ref != null) return "资产 URL 不得带 query/fragment"
    val tail = url.path.removePrefix(REQUIRED_PATH_PREFIX)
    // 恰好 <tag>/<asset>：一个分隔符、两段都非空（多一段就是别的路径形态，不得放行）。
    val parts = tail.split('/')
    if (parts.size != 2 || parts.any { it.isEmpty() }) return "资产路径必须恰好是 <tag>/<asset>"
    return null
  }

  /**
   * 重定向落点的合规判据（纯函数）：只要求 https + 主机仍在白名单。
   *
   * 为什么这里**不**复用 [urlVerdict] 的路径面：GitHub 的资产直链会 302 到 CDN
   * （`objects.githubusercontent.com` / `release-assets.githubusercontent.com`），落点的路径与
   * query 都是 CDN 自己生成的，与「本仓 Releases 的 `<tag>/<asset>` 形态」无关——若在这里继续
   * 要求路径前缀，合法重定向会被一律拒绝。来源面由**首个 URL** 保证，逐跳只守「不跳出白名单主机」。
   *
   * 为什么不能沿用 `instanceFollowRedirects = true` 的自动跟随：自动跟随**不校验中间跳**，
   * 一次 302 就能把请求引到任意主机，而「只认本仓 Releases」是本对象的硬要求。
   */
  fun hopVerdict(location: String): String? {
    val url = try { URL(location) } catch (_: Exception) { return "不是合法 URL" }
    if (!url.protocol.equals("https", ignoreCase = true)) return "重定向落点必须仍是 https（实际 ${url.protocol}）"
    if (url.host?.lowercase() !in ALLOWED_HOSTS) return "重定向落点主机不在白名单：${url.host}"
    return null
  }

  /**
   * 把相对名解到 [root] 内（纯函数）：拒绝绝对路径、`..`、NUL 与越界，符号链接按真实路径判定。
   *
   * 目标本身可能尚未创建，故按**父目录**的 canonicalPath 判定（与
   * `SnapshotExtractor.resolveEntry` 同一手法）。
   */
  fun resolveInside(root: File, relative: String): File? {
    if (relative.isEmpty() || relative.contains('\u0000')) return null
    if (File(relative).isAbsolute) return null
    if (relative.split('/', '\\').any { it == ".." }) return null
    val rootCanon = root.canonicalPath
    val target = File(root, relative)
    val parentCanon = target.parentFile?.canonicalPath ?: rootCanon
    val inside = parentCanon == rootCanon || parentCanon.startsWith(rootCanon + File.separator)
    return if (inside) target else null
  }

  /**
   * 清单里**来自调用方**的字面量判据（纯函数）：摘要必须是 64 位小写十六进制，体量必须是非负且
   * 不超过兜底上限的整数。
   *
   * 这一层是**路径安全的前置条件**，不是可选校验：摘要随后会被拼进路径并交给递归删除，
   * 所以任何在它之前使用该字符串的文件系统动作都是缺陷。调用点：[LinuxAssetPrepare.start]
   * （起线程/推导路径/删除之前）与 [download]（防调用方绕过）。
   */
  fun specVerdict(spec: Spec): String? {
    if (!SHA256_PATTERN.matches(spec.sha256)) {
      return "sha256 必须是 64 位小写十六进制（实际 ${spec.sha256.length} 字符）"
    }
    if (spec.size < 0L || spec.size > MAX_DOWNLOAD_BYTES) {
      return "size 必须是 0..$MAX_DOWNLOAD_BYTES 的整数（实际 ${spec.size}）"
    }
    return null
  }

  /**
   * 正式来源校验之后的 debug 回放地址。生产（debugBuild=false）永不读取该文件。
   *
   * 映射只替换 origin，保留官方 pathname（`/kelai141/.../releases/download/<tag>/<asset>`），
   * 因而本地服务器能按与正式 Releases 相同的路径提供字节。任何不满足显式 IPv4 loopback
   * HTTP origin 的配置都失败关闭；这里不放宽 [urlVerdict] 的正式白名单。
   */
  fun debugMappedUrl(root: File, officialUrl: String, debugBuild: Boolean): String? {
    // 映射之前先独立复核正式来源；release 构建不读取配置，但也不接受非官方 URL。
    urlVerdict(officialUrl)?.let { return null }
    if (!debugBuild) return officialUrl
    val file = File(root, DEBUG_ORIGIN_FILE)
    // 未配置 = 正常走官方地址；已配置但不合规 = 失败关闭，绝不回落到网络。
    if (!java.nio.file.Files.exists(file.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return officialUrl
    val origin = try {
      if (!file.isFile || java.nio.file.Files.isSymbolicLink(file.toPath())) return null
      file.readText().trim()
    } catch (_: Exception) {
      return null
    }
    val originVerdict = debugOriginVerdict(origin) ?: return null
    val official = try { URL(officialUrl) } catch (_: Exception) { return null }
    // 只替换 origin，保留官方 pathname（含 `/releases/download/<tag>/<asset>` 形态）。
    return try { URL(URL("$originVerdict/"), official.path).toString() } catch (_: Exception) { null }
  }

  /** 纯判据：只接受 `http://127.0.0.1:<port>/`，无凭据、query、fragment 与额外路径。 */
  fun debugOriginVerdict(raw: String): String? {
    val url = try { URL(raw) } catch (_: Exception) { return null }
    if (!url.protocol.equals("http", ignoreCase = true)) return null
    if (url.host != "127.0.0.1") return null
    if (url.port !in 1..65535) return null
    if (url.userInfo != null) return null
    if (url.path != "/" && url.path.isNotEmpty()) return null
    if (url.query != null || url.ref != null) return null
    return "http://127.0.0.1:${url.port}"
  }

  /** 摘要与体量的合规判据（纯函数）：两者都必须与清单一致。 */
  fun verifyVerdict(digest: SnapshotBundledAsset.Digest, spec: Spec): String? {
    if (digest.bytes != spec.size) {
      return "字节数不一致：声明 ${spec.size}，实读 ${digest.bytes}"
    }
    if (!digest.hex.equals(spec.sha256.trim().lowercase(), ignoreCase = true)) {
      return "SHA-256 不一致：声明 ${spec.sha256.trim().lowercase()}，实读 ${digest.hex}"
    }
    return null
  }

  /** 该 Linux 环境是否「在场」：根目录与控制面状态文件都必须真实存在。 */
  fun environmentVerdict(filesDir: File?): String? {
    if (filesDir == null) return "缺少 DSH_FILES_DIR（应用私有目录）"
    val root = File(filesDir, ENV_DIR)
    if (!root.isDirectory) return "Linux 环境根目录不在场：${root.absolutePath}"
    if (!File(root, STATE_FILE).isFile) return "Linux 控制面未启用（无 $STATE_FILE）"
    return null
  }

  /**
   * 解包到 [destination]：走 [LinuxAssetExtractor]（按 kind 的链接判据 + 炸弹上限）。
   *
   * [root] 是唯一允许的落点根；[destination] 必须先通过 [resolveInside] 的等价判定。
   */
  fun extract(
    archive: File,
    destination: File,
    root: File,
    kind: Kind = Kind.PLUGIN,
    limits: SnapshotExtractor.Limits = PLUGIN_LIMITS,
  ): Failure? {
    val rootCanon = root.canonicalPath
    val destCanon = destination.canonicalPath
    if (destCanon != rootCanon && !destCanon.startsWith(rootCanon + File.separator)) {
      return Failure(CODE_DESTINATION_ESCAPE, "解包目标越出允许根：$destCanon")
    }
    if (!archive.isFile) return Failure(CODE_DOWNLOAD_FAILED, "归档不存在：${archive.name}")
    return try {
      archive.inputStream().use { input ->
        LinuxAssetExtractor.extract(input, archive.length(), destination, kind, limits)
      }
      null
    } catch (e: Exception) {
      // 穿越/符号链接逃逸/上限超限都由 SnapshotExtractor 以 IOException 中止；统一归为「不安全归档」
      // （与「落点越界」分开，故障归因才不会把炸弹报成路径问题）。
      Failure(CODE_UNSAFE_ARCHIVE, "解包被拒绝（路径穿越/符号链接逃逸/超出解压上限）：${e.message}")
    }
  }

  /**
   * 插件包的解压上限口径：比快照小得多（插件包是纯 JS，几万条目/GB 级都不合理），
   * 但仍留足余量，避免把正常包判成炸弹。
   */
  val PLUGIN_LIMITS = SnapshotExtractor.Limits(
    maxEntries = 20_000,
    maxTotalBytes = 512L * 1024L * 1024L,
    maxSingleFileBytes = 128L * 1024L * 1024L,
  )

  /** rootfs 含完整 Debian 树；Node 含 npm 全量文件。 */
  val ROOTFS_LIMITS = SnapshotExtractor.Limits(
    maxEntries = 240_000,
    maxTotalBytes = 4L * 1024L * 1024L * 1024L,
    maxSingleFileBytes = 1L * 1024L * 1024L * 1024L,
  )

  val NODE_LIMITS = SnapshotExtractor.Limits(
    maxEntries = 60_000,
    maxTotalBytes = 1L * 1024L * 1024L * 1024L,
    maxSingleFileBytes = 256L * 1024L * 1024L,
  )

  fun limitsFor(kind: Kind): SnapshotExtractor.Limits = when (kind) {
    Kind.ROOTFS -> ROOTFS_LIMITS
    Kind.NODE -> NODE_LIMITS
    Kind.PLUGIN, Kind.BACKEND -> PLUGIN_LIMITS
  }

  /**
   * 逐跳校验地下载到 [destination]（tmp + 原子 rename），随后**回验**摘要与字节数。
   *
   * 校验发生在 rename 之前：任何失败都不留下半个「看似可用」的资产。
   */
  fun download(
    spec: Spec,
    destination: File,
    root: File,
    opener: Opener = HttpOpener,
    debugBuild: Boolean = BuildConfig.DEBUG,
  ): Failure? {
    // 清单字面量先判：摘要是路径段的来源，校验必须早于任何文件系统动作（含下面的 mkdirs/delete）。
    specVerdict(spec)?.let { return Failure(CODE_SPEC_INVALID, it) }
    urlVerdict(spec.url)?.let { return Failure(CODE_URL_REJECTED, it) }
    val fetchUrl = debugMappedUrl(root, spec.url, debugBuild)
      ?: return Failure(CODE_URL_REJECTED, "debug 回放配置不可用或不是 loopback origin")
    val rootCanon = root.canonicalPath
    val destCanon = destination.parentFile?.canonicalPath ?: rootCanon
    if (destCanon != rootCanon && !destCanon.startsWith(rootCanon + File.separator)) {
      return Failure(CODE_DESTINATION_ESCAPE, "下载目标越出允许根：${destination.absolutePath}")
    }
    val tmp = File(destination.parentFile, destination.name + ".tmp")
    try {
      destination.parentFile?.mkdirs()
      tmp.delete()
      val read = opener.fetch(fetchUrl, tmp, MAX_DOWNLOAD_BYTES)
      if (read < 0) return Failure(CODE_DOWNLOAD_FAILED, "下载失败或逐跳校验未通过")
      // 兜底上限在**本函数**里再判一次：注入的下载器可能不自己设限，判据不能只存在于生产实现里。
      if (read > MAX_DOWNLOAD_BYTES) {
        return Failure(CODE_SIZE_MISMATCH, "下载体量超过兜底上限 $MAX_DOWNLOAD_BYTES（实读 $read）")
      }
      // 先验字节数（便宜且能挡住截断），再验摘要。lambda 必须括号包起来：尾随 lambda 会绑定到
      // 最后一个参数（这里是 bufferSize: Int），`digest { }` 会被判成类型不符。
      val digest = SnapshotBundledAsset.digest({ tmp.inputStream() })
      verifyVerdict(digest, spec)?.let { detail ->
        val code = if (digest.bytes != spec.size) CODE_SIZE_MISMATCH else CODE_DIGEST_MISMATCH
        return Failure(code, detail)
      }
      if (destination.exists()) destination.delete()
      if (!tmp.renameTo(destination)) {
        tmp.copyTo(destination, overwrite = true)
        tmp.delete()
      }
      return null
    } catch (e: Exception) {
      return Failure(CODE_DOWNLOAD_FAILED, e.message ?: e.javaClass.simpleName)
    } finally {
      tmp.delete()
    }
  }

  /** 下载器接口（单测注入内存实现，生产走 https）。返回实读字节数，失败返回 -1。 */
  fun interface Opener {
    fun fetch(url: String, dest: File, maxBytes: Long): Long
  }

  /** 生产下载器：https + 主机白名单逐跳校验 + 有界流式落盘。 */
  object HttpOpener : Opener {
    override fun fetch(url: String, dest: File, maxBytes: Long): Long {
      var current = url
      var hops = 0
      while (true) {
        val conn = URL(current).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = false
        try {
          val code = conn.responseCode
          if (code in 300..399) {
            val location = conn.getHeaderField("Location")
              ?: return -1
            hops += 1
            if (hops > MAX_REDIRECTS) return -1
            // 相对 Location 按当前 URL 解析，再逐跳复核（自动跟随不校验中间跳，故关掉它）。
            val resolved = try { URL(URL(current), location).toString() } catch (_: Exception) { return -1 }
            if (hopVerdict(resolved) != null) {
              android.util.Log.w(TAG, "linux-asset redirect rejected: $resolved")
              return -1
            }
            current = resolved
            continue
          }
          if (code != 200) return -1
          var read = 0L
          dest.outputStream().use { out ->
            conn.inputStream.use { input ->
              val buf = ByteArray(128 * 1024)
              while (true) {
                val n = input.read(buf)
                if (n < 0) break
                read += n
                if (read > maxBytes) throw IOException("下载体量超过上限 $maxBytes")
                out.write(buf, 0, n)
              }
            }
          }
          return read
        } finally {
          conn.disconnect()
        }
      }
    }
  }

  private const val TAG = "dsh-linux-asset"
}
