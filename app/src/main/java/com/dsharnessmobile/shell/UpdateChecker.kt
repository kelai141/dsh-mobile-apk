package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * APK 自更新（0.13.8 批 H，用户拍板交互）：
 * - **仅手动**：启动页「检查更新」按钮触发，不自动检查（169MB 下载不做任何自动行为）；
 * - **镜像链**：GitHub latest release 直连 → gh-proxy 风格前缀逐级回退（域名常量可配）；
 * - **同按钮二次确认**：发现新版后同一按钮变为「下载并安装 vX.Y.Z」，再点才开始下载；
 * - 下载落 Documents/dshdata/updates/（FileProvider 既有映射内），.tmp→rename 原子；
 * - 安装：REQUEST_INSTALL_PACKAGES 未持有 → 先拉「安装未知应用」授权页（launcher 返回后续继）；
 *   签名不匹配由系统安装器天然拒绝；发布数据带摘要时下载后校验（缺失则如实说明"本次未提供"）。
 * 与引擎快照更新（EngineStartFlow.startUpdateCheck / UpdateManager）完全分离。
 *
 * **版本号确认链（多源，顺序即优先级）**：见 [checkLatest]。
 *   为什么不再只打 api.github.com：未认证额度只有 60 次/小时/IP，而实测同一出口的配额被多个消费方
 *   共享（连续请求的 x-ratelimit-remaining 非单调递减），CGNAT 下随时可能被别人吃光。于是主源换成
 *   **不需要认证**的两类：镜像前缀上的 `releases/latest/download/MANIFEST.txt`（与 APK 下载共用同一套前缀）
 *   与下载站的 `data/releases.json`（CI 已把 MANIFEST 摘要与资产字节数对账过），API 降为末位兜底。
 *   硬纪律：**只有至少一档成功返回并解析出版本号，才允许说"已是最新"**；全部失败一律报失败——
 *   把"查不到"说成"没有新版"会让用户错过整轮更新，且没有任何一层能再纠正这个谎。
 *
 * **摘要语义**：[CheckResult.Available.sha256] 是**摘要本身**，不再是 `.sha256` 资产的 URL。
 *   旧实现去找 `{apk}.sha256` 资产，而发布链从不产出该资产，于是下载后校验从未真正执行过；
 *   新口径的摘要来自 MANIFEST.txt / releases.json，缺失即为 null，界面必须如实说明"本次未提供摘要"。
 *
 * 0.14.6 功能 C（arm64 误报）：本文件此前把**所有**未命中都报成「无 $abi 资产」，而 arm64 资产名
 * 在发布历史上翻转（v0.14.2-fx-2 及更早 = `-arm64-v8a`，v0.14.2-fx-3 起 = `-arm64`），
 * 于是 arm64 设备对当前 latest 恒判"无 arm64 资产"（x86_64 同名故不可见）。
 * 现在：识别层接受两代命名（[assetNameCandidates]），失败按 [CheckResult.FailureKind] 如实分类。
 */
object UpdateChecker {

  private const val TAG = "dsh-update"
  private const val REPO = "kelai141/dsh-mobile-apk"

  /**
   * 镜像前缀表（**与下载站 `webpages/src/assets/release.js` 的 `MIRROR_TEMPLATES` 逐条同序**）。
   *
   * 顺序即回退优先级，所以这不是"一组能用的域名"而是**有序契约**：`scripts/check-mirror-parity.mjs`
   * 会逐条比对两侧，任一侧单独增删或对调即判红。壳侧此前只有 3 条（缺 ghproxy.net），
   * 于是同一台设备在"应用内下载"与"浏览器下载"上走两套线路集合，而没有任何一层为不一致负责。
   */
  internal val MIRROR_PREFIXES: List<String> = listOf(
    "https://github.com/",
    "https://gh-proxy.com/https://github.com/",
    "https://ghfast.top/https://github.com/",
    "https://ghproxy.net/https://github.com/",
  )
  private const val API = "https://api.github.com"

  /** 下载站地址（Pages 部署；`data/releases.json` 是确认链的第 4 档——它不被任何 gh-proxy 类镜像代理）。 */
  private const val SITE_URL = "https://kelai141.github.io/dsh-mobile-apk/"

  /** 更新包落点（已在 file_paths.xml 的 Documents/dshdata 映射内，零新映射）。 */
  fun updatesDir(context: Context): File =
    File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), "dshdata/updates")

  /**
   * 清扫更新目录（issue #676）：只保留本次要装的那一个包，删掉更早的 APK 与中断留下的 `.tmp`。
   *
   * 为什么需要：`updatesDir` 落在公共外部存储（`Documents/dshdata/updates`），全仓只有"写"没有"删"。
   * 每换一版就多一个 169MB 的包；下载被进程中断时 `.tmp` 还会留在原地（`finally` 只在正常退出时跑）。
   *
   * 判据刻意保守：只删 `*.apk`（且不是 [keepName]）与 `*.tmp`，只删普通文件——不碰目录、不跟符号链接。
   * 返回实际删除个数（0 = 没有可删的，也算正常结果）。
   */
  internal fun pruneUpdatesDir(dir: File, keepName: String?): Int {
    val entries = dir.listFiles() ?: return 0
    var removed = 0
    for (file in entries) {
      if (!file.isFile) continue
      val name = file.name
      val staleApk = name.endsWith(".apk", ignoreCase = true) && name != keepName
      val staleTmp = name.endsWith(".tmp", ignoreCase = true)
      if (!staleApk && !staleTmp) continue
      if (runCatching { file.delete() }.getOrDefault(false)) removed++
    }
    return removed
  }

  sealed class CheckResult {
    /** 已是最新（latest.tag == 当前版本）。 */
    data object UpToDate : CheckResult()
    /**
     * 发现新版：tag + 双 ABI 资产 URL（按设备 ABI 已选好）。
     *
     * [sha256] 是**摘要本身**（64 位十六进制小写），不是摘要文件的 URL。没有有效摘要的 APK
     * 不会生成可安装更新，避免把完整性校验降级成仅比较文件大小。
     */
    data class Available(
      val tag: String,
      val name: String,
      val apkUrl: String,
      val sha256: String,
      val sizeBytes: Long,
    ) : CheckResult()

    /**
     * 检查失败的**原因类别**（0.14.6 功能 C）。
     *
     * 真因（旧的单一失败路径）：只要「没选中本机可用的资产」，文案就恒为
     * `latest release $tag 无 $abi 资产（$want）` —— 而走到那一句的**并不只有**「这台设备真的没有包」：
     * 发布资产被改名、assets 为空、资产缺下载地址，全都会掉进同一句，用户看到的是
     * 「没有你这个架构的版本」。文案比事实强，用户据此判「这项目不支持我的机器」并放弃，
     * 而真实原因本来说清就能处理。故把类别做成**事实层**：它只决定文案与日志，
     * 调用方（GuidePageRenderer）仍只读 `reason`，不新增分支面，也不隐藏任何错误。
     */
    enum class FailureKind {
      /** 该 release 确实没有能装在这台设备上的包（本机 ABI 不在其资产里）。 */
      NO_COMPATIBLE_APK,
      /** 发布侧数据异常（assets 为空 / 无 APK 资产 / 资产缺下载地址）——不是设备不支持。 */
      RELEASE_DATA_BROKEN,
      /** 接口限流（403 配额耗尽 / 429 / Retry-After）——与设备架构无关，稍后重试即可。 */
      RATE_LIMITED,
      /** 接口返回非 200 且非限流（服务端 / 代理 / 接口面异常）。 */
      API_HTTP,
      /** 响应体不是可用的 Release JSON（畸形 JSON / 缺 tag_name / 被中间页替换）。 */
      PARSE,
      /** 设备自身 ABI 读不到（SUPPORTED_ABIS 为空）——不得借「无 arm64 资产」顶罪。 */
      ABI_UNSUPPORTED,
      /** 网络不可达（DNS / 连接 / 超时 / TLS）。 */
      NETWORK,
      /** 未归类：如实说未完成并指向日志，不编造原因。 */
      UNKNOWN,
    }

    data class Failed(val reason: String, val kind: FailureKind = FailureKind.UNKNOWN) : CheckResult()
  }

  /** 设备 ABI → ABI 家族名（arm64 / x86_64）。**家族名不是发布资产名**——发布口径见 assetName()。
   *  以 **SUPPORTED_ABIS[0]（设备首选/原生 ABI）**为准：带 ARM 翻译的 x86 设备
   *  （MuMu abilist = x86_64,arm64-v8a,x86）里 arm64 只是翻译层，按「任一含 arm64 即选 arm64」
   *  会下错包——device 实测 v0.13.7fx-1 抓到 arm64 资产。 */
  fun abiFrom(abis: List<String>): String {
    val primary = abis.firstOrNull().orEmpty()
    return when {
      primary.startsWith("arm64") -> "arm64"
      primary.startsWith("x86_64") -> "x86_64"
      abis.any { it.startsWith("arm64") } -> "arm64"
      abis.any { it == "x86_64" } -> "x86_64"
      else -> primary.substringBefore('-').ifEmpty { "arm64" }
    }
  }

  /** 本机 ABI 列表（可注入面：判定层只吃这个列表，真机值只在 checkLatest 里取一次）。 */
  internal fun deviceAbis(): List<String> = android.os.Build.SUPPORTED_ABIS?.toList().orEmpty()

  /**
   * **兼容资产名清单**（0.14.6 功能 C 的识别层）。第一个是**线上发布链口径**，其余为历史/旁路口径。
   *
   * 为什么必须是"清单"而不是单个名字（实测枚举 `gh release view <tag> --json assets`，11 个 release）：
   *   1. 发布链与开发链**不同名**：release.yml:262 → build-apk-013.ps1:465 产 `dsh-mobile-apk-v<ver>-arm64.apk`；
   *      未被 release.yml 调用的旁路 build-release.ps1:208 产 `...-arm64-v8a.apk`。
   *   2. 线上**已经翻转过一次**：v0.14.1 / v0.14.1-preview / v0.14.2 / v0.14.2-fx-1 / v0.14.2-fx-2 是
   *      `-arm64-v8a`；v0.14.0 / v0.14.2-fx-3 / v0.14.3 / v0.14.4 / v0.14.5 / v0.14.5-fx-1 /
   *      **v0.14.5-fx-2（当前 latest）** 是 `-arm64`。只认其中任一个 ⇒ 一半 tag 的 arm64 恒判失败，
   *      文案还是"没有 arm64 版本"（issue 现场）。
   *   3. 只多认**同一个 ABI 家族**的名字：下面任一名字都只用于**设备自身 ABI 对应的那一族**，
   *      异构架构（arm 设备拿 x86_64 包）永远不可能被选中——兼容命名不放宽任何架构校验。
   *
   * 复发防线：`UpdateCheckerTest.assetCandidatesAreBoundToReleaseChainProductName` 直接读
   * `.github/workflows/release.yml`（唯一线上发布入口）与 `scripts/build-apk-013.ps1` 的
   * `--artifact-name` 形态并逐字比对——**发布链改名即判红**，不靠人记得同步。
   */
  /**
   * 产物文件名的形态白名单（**安全边界**，2026-10-28 自查）。
   *
   * 名字最上游来自发布元数据（Pages `releases.json` 的 tag/asset 名、API 的 tag_name/asset），
   * `assetNameCandidates` 只是把 tag 原样插值进 `dsh-mobile-apk-v<tag>-<abi>.apk`。带分隔符的
   * tag（`v9../../../Documents/x`）会让 `File(updatesDir, name)` 落到**任意可写目录**，
   * 而 batch4 起 `pruneUpdatesDir(dest.parentFile)` 的作用域也跟着被元数据决定 ⇒ 能删/写别的目录里
   * 的 `*.apk`/`*.tmp`。修法两层：名字形态白名单 + canonical 父目录必须等于 updatesDir。
   */
  internal val ARTIFACT_NAME = Regex("""^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}\.apk$""")

  internal fun isSafeArtifactName(name: String): Boolean =
    ARTIFACT_NAME.matches(name) && File(name).name == name && File(name).parentFile == null

  /**
   * 把元数据给的文件名解析成 updatesDir 里的安全路径；不安全返回 null（调用方按"产物不可用"拒绝）。
   * 两道判据都要：形态白名单挡住 `../`、绝对路径、尾随空格与大小写变体；canonical 比对挡住
   * 符号链接/`..` 归一化之后仍然逃出目录的情形（形态合法但落点在外面的构造）。
   */
  internal fun resolveUpdateTarget(dir: File, name: String): File? {
    if (!isSafeArtifactName(name)) return null
    val raw = File(dir, name)
    // 名字本身是符号链接就直接拒：`canonicalFile` 对**指向不存在目标**的链接不解引用，
    // 此时 parent 仍等于 dir、判据会放行，而写入会跟着链接落到目录外。
    if (runCatching { java.nio.file.Files.isSymbolicLink(raw.toPath()) }.getOrDefault(true)) return null
    return runCatching {
      val dirReal = dir.canonicalFile
      val fileReal = raw.canonicalFile
      if (fileReal.parentFile == dirReal) fileReal else null
    }.getOrNull()
  }

  fun assetNameCandidates(tag: String, abi: String): List<String> {
    val v = tag.removePrefix("v")
    val releaseAbis = if (abi == "arm64") listOf("arm64", "arm64-v8a") else listOf(abi)
    return releaseAbis.map { "dsh-mobile-apk-v$v-$it.apk" }
  }

  /**
   * 资产命名（**主口径 = 线上发布链产物名**：dsh-mobile-apk-v<版本>-<abi>.apk）。
   *
   * 保留本函数是既有契约（本地落盘名与旧断言都调它）；**匹配环节不再只认它**，
   * 见 [assetNameCandidates]。坑 172 的教训是「把某一时点的口径硬编码成唯一真名」——
   * 修法不是换个同样硬的名字，而是让接受集与发布链产出名绑定且可被判红。
   */
  fun assetName(tag: String, abi: String): String = assetNameCandidates(tag, abi).first()

  /** 一件发布资产（只取判定所需字段；不引入 JSON 对象到判定层，便于 JVM 单测）。 */
  internal data class ReleaseAssetRef(val name: String, val url: String, val sizeBytes: Long, val sha256: String?)

  /** 解析后的 latest release：tag + 资产清单。 */
  internal data class LatestRelease(val tag: String, val assets: List<ReleaseAssetRef>)

  /**
   * 解析 latest release 响应体（纯函数，可 JVM 单测）。
   *
   * 解析失败**抛异常**而不是回一个"没有资产"的默认值：畸形响应必须归入 [CheckResult.FailureKind.PARSE]，
   * 归类到资产问题就是本缺陷的原形（把别的原因说成架构问题）。缺 tag_name 同理——tag 是版本判定的前提。
   */
  internal fun parseLatestRelease(body: String): LatestRelease {
    val j = JSONObject(body)
    val tag = j.optString("tag_name", "").trim()
    require(tag.isNotEmpty()) { "latest release 无 tag_name" }
    val arr = j.optJSONArray("assets") ?: JSONArray()
    val assets = ArrayList<ReleaseAssetRef>(arr.length())
    for (i in 0 until arr.length()) {
      val a = arr.optJSONObject(i) ?: continue
      val name = a.optString("name", "").trim()
      if (name.isEmpty()) continue
      val sha256 = if (APK_NAME_TAG.matches(name)) parseReleaseAssetSha256(a.opt("digest")) else null
      assets += ReleaseAssetRef(name, a.optString("browser_download_url", "").trim(), a.optLong("size", 0L), sha256)
    }
    return LatestRelease(tag, assets)
  }

  /**
   * 非 200 的**分类**（纯函数，可 JVM 单测）。
   *
   * 限流(403 配额耗尽 / 429)与其它 HTTP 失败必须分开：限流是"等一会儿再来"，而用户当前能做的
   * 补偿动作不同（[CheckResult.FailureKind.RATE_LIMITED] 会说明未认证配额是 60 次/小时）。
   * **不读响应体**：GitHub 的限流说明里含请求来源 IP，不进日志也不上屏（日志会被用户分享）。
   */
  internal fun classifyHttpFailure(code: Int, rateLimited: Boolean): CheckResult.Failed = when {
    rateLimited -> CheckResult.Failed(
      "检查失败：更新接口限流（HTTP ${code}）——接口未认证时每小时只有 60 次查询，请稍后重试。这与本机架构无关，不代表没有适配版本",
      CheckResult.FailureKind.RATE_LIMITED,
    )
    else -> CheckResult.Failed(
      "检查失败：更新接口返回 HTTP ${code}（服务端或网络代理异常）——请稍后重试；持续失败可复制日志反馈",
      CheckResult.FailureKind.API_HTTP,
    )
  }

  /**
   * 限流判定（纯函数）：**不能只看状态码**。
   *
   * - 429 = 明确的限流；
   * - 403 只在响应头确认配额耗尽（`x-ratelimit-remaining: 0`）或带 `retry-after` 时才算限流；
   *   普通 403（滥用拦截 / 拒绝访问）归 [CheckResult.FailureKind.API_HTTP]——把普通 403 说成
   *   "限流、稍后重试"同样是给用户一条不会生效的路。
   */
  internal fun isRateLimited(code: Int, rateLimitRemaining: String?, retryAfter: String?): Boolean {
    if (code == 429) return true
    if (code != 403) return false
    if (rateLimitRemaining?.trim() == "0") return true
    return !retryAfter.isNullOrBlank()
  }

  /**
   * 传输/解析异常的**分类**（纯函数）。
   *
   * 旧实现把一切都拼成"检查失败：<异常消息>——请核对网络后重试"：解析错误被说成网络错误，
   * 用户按提示换网络、换流量，问题照旧。这里按异常类别分开，且 UNKNOWN 保持原有的
   * "请核对网络后重试"文案（不编造原因，也不后退既有措辞）。
   */
  internal fun classifyTransportFailure(e: Throwable): CheckResult.Failed {
    val name = e.javaClass.name
    val msg = e.message ?: e.javaClass.simpleName
    val kind = when {
      name.contains("JSONException") || name.contains("IllegalArgument") -> CheckResult.FailureKind.PARSE
      name.contains("UnknownHost") || name.contains("Connect") || name.contains("SocketTimeout") ||
        name.contains("NoRouteToHost") || name.contains("SSL") || name.contains("SocketException") ||
        name.contains("Network") -> CheckResult.FailureKind.NETWORK
      else -> CheckResult.FailureKind.UNKNOWN
    }
    val text = when (kind) {
      CheckResult.FailureKind.PARSE ->
        "检查失败：更新接口返回的内容无法解析（可能被网络中间页替换）——请稍后重试；持续失败可复制日志反馈"
      CheckResult.FailureKind.NETWORK ->
        "检查失败：网络不可达（${msg}）——请检查网络后重试"
      else ->
        "检查失败：${msg}——请核对网络后重试"
    }
    return CheckResult.Failed(text, kind)
  }

  /**
   * 命中失败时的**分类**（纯函数，核心判据）：
   * 「这台设备真的没有可用包」与「发布侧数据有问题」必须分开说。
   *
   * - 一个 APK 资产都没有（assets 空 / 只有快照与插件包）→ [CheckResult.FailureKind.RELEASE_DATA_BROKEN]；
   * - 有 APK 资产但都不是本机 ABI 那一族 → [CheckResult.FailureKind.NO_COMPATIBLE_APK]，
   *   且把**实际资产名**与**本机 abilist** 写进文案——事实可核对，用户/维护者能一眼看出是发布侧漏了包
   *   还是包改名了（改名这一形态正是本缺陷的真实成因，见 [assetNameCandidates]）。
   */
  internal fun classifyAssetFailure(
    tag: String,
    family: String,
    deviceAbis: List<String>,
    assetNames: List<String>,
  ): CheckResult.Failed {
    val apkNames = assetNames.filter { it.endsWith(".apk") }
    if (apkNames.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：发布数据异常——latest release $tag 里没有 APK 资产（不是本机没有可用版本）",
        CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      )
    }
    val want = assetNameCandidates(tag, family)
    return CheckResult.Failed(
      "找不到可安装的版本：latest release $tag 的资产（${apkNames.joinToString("、")}）中没有适配本机 $family 的包" +
        "（本机 ABI：${deviceAbis.joinToString(",")}；期望名 ${want.joinToString(" / ")}）——请等待适配本机架构的版本发布",
      CheckResult.FailureKind.NO_COMPATIBLE_APK,
    )
  }

  // ── 版本号确认链的判定层（纯函数：无网络、无 Android 依赖，JVM 单测直测） ──────────────
  //
  // 三条数据源（MANIFEST.txt / 下载站 releases.json / GitHub API）形态完全不同，但**判定规则必须只有一套**：
  // 选包 -> 比版本 -> 组装 Available。否则"哪个源先成功"就会改变用户看到的结果，
  // 而重试一下换了个源就换了结论——这类不一致没有任何一层会报红。故先把各自解析成 [LatestFacts]，
  // 再统一走 [classifyFacts]。

  /**
   * 一份发布数据的**判定事实**（与数据源形态解耦）。
   *
   * [sizes] / [sha256] 都是**资产名 -> 值**：资产名取 basename（MANIFEST 里的相对路径 `apk/xxx.apk`
   * 与 releases.json 的 `name` 字段、API 的 `assets[].name` 在这一点上同构），于是选包环节不必知道
   * 数据来自哪个源。缺失的摘要**不出现在 map 里**，而不是映射成空串——"没给摘要"与"摘要为空"是两件事。
   */
  internal data class LatestFacts(
    val tag: String,
    /** 资产名 -> 字节数 */
    val sizes: Map<String, Long>,
    /** 资产名 -> sha256（小写）。缺失即为空 map。 */
    val sha256: Map<String, String>,
  )

  private fun factsFromRelease(release: LatestRelease): LatestFacts = LatestFacts(
    release.tag,
    release.assets.associate { it.name to it.sizeBytes },
    release.assets.mapNotNull { asset -> asset.sha256?.let { asset.name to it } }.toMap(),
  )

  /** 发布链产物名里的版本号与架构。为什么从文件名取：MANIFEST.txt 实测 12 行只有三列，没有 tag 字段。 */
  private val APK_NAME_TAG = Regex("^dsh-mobile-apk-v(.+)-(arm64-v8a|arm64|x86_64)\\.apk$")

  /** MANIFEST.txt 的一行：`<sha256>  <相对路径>  <字节数>`（两空格分隔；制表符与多空格同样接受）。 */
  private val MANIFEST_LINE = Regex("^(\\S+)\\s+(\\S+)\\s+(\\S+)$")

  private val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")
  private val RELEASE_ASSET_SHA256 = Regex("^sha256:([0-9a-fA-F]{64})$", RegexOption.IGNORE_CASE)

  private fun parseReleaseAssetSha256(value: Any?): String? {
    if (value == null || value == JSONObject.NULL) return null
    require(value is String) { "latest release APK digest 不是字符串" }
    val match = RELEASE_ASSET_SHA256.matchEntire(value.trim())
      ?: throw IllegalArgumentException("latest release APK digest 不是有效的 SHA-256")
    return match.groupValues[1].lowercase()
  }

  /**
   * 解析 MANIFEST.txt（三列：sha256 相对路径 字节数）。失败**抛异常**，由调用方归类 PARSE。
   *
   * 为什么保守到"任一非空行格式不符就抛"：这份文件是**摘要的权威来源**，也是选包与字节数的唯一依据。
   * 宽松跳过坏行等于用一份部分可信的清单做完整性校验——坏行很可能正是本机要下的那个包，
   * 结果是"校验值缺失"被静默降级成"跳过校验"，而界面还以为验过了。
   *
   * 版本号只能从 apk 资产名里取（见 [APK_NAME_TAG]）；两个架构各有一行，必须解析出**同一个 tag**——
   * 不一致说明这份清单是两次发布的产物拼出来的，拿它的摘要去校验任何一件资产都不成立。
   */
  internal fun parseManifest(text: String): LatestFacts {
    val sizes = LinkedHashMap<String, Long>()
    val digests = LinkedHashMap<String, String>()
    val tags = LinkedHashSet<String>()
    for (raw in text.lineSequence()) {
      val line = raw.trim()
      if (line.isEmpty()) continue
      val m = MANIFEST_LINE.matchEntire(line)
        ?: throw IllegalArgumentException("MANIFEST 行格式不符：" + line)
      val digest = m.groupValues[1]
      if (!SHA256_HEX.matches(digest)) throw IllegalArgumentException("MANIFEST 摘要不是 64 位十六进制：" + line)
      val name = m.groupValues[2].substringAfterLast('/')
      if (name.isEmpty()) throw IllegalArgumentException("MANIFEST 行没有文件名：" + line)
      val size = m.groupValues[3].toLongOrNull()
        ?: throw IllegalArgumentException("MANIFEST 字节数不是整数：" + line)
      sizes[name] = size
      // 摘要一律归一小写：同一份清单在不同源上出现过大小写差异，校验比对不该因此判失败。
      digests[name] = digest.lowercase()
      APK_NAME_TAG.matchEntire(name)?.let { tags.add(it.groupValues[1]) }
    }
    require(tags.size == 1) {
      if (tags.isEmpty()) "MANIFEST 里没有可识别的 APK 资产行（无法判定版本号）"
      else "MANIFEST 里的 APK 资产分属多个版本号（" + tags.joinToString("、") + "），数据自相矛盾"
    }
    return LatestFacts(tags.first(), sizes, digests)
  }

  /**
   * 解析下载站 `data/releases.json`（Pages 站点）。失败抛异常，由调用方归类 PARSE。
   *
   * 该文件的 `sha256` 是**按 ABI 家族**给的（`{"arm64":"...","x86_64":"..."}`），不是按资产名——
   * 站点侧同样只知道"这一族的包是哪个"，且构建期已把摘要与资产字节数强制对账过
   * （`webpages/tools/build.mjs` 对不上即构建失败）。故这里用 [assetNameCandidates] 把家族摘要
   * 挂到本机这一族**实际存在**的那个资产名上：两代命名（-arm64 与 -arm64-v8a）都可能在历史发布里出现。
   */
  internal fun parsePagesReleaseJson(text: String): LatestFacts {
    val j = JSONObject(text)
    val tag = j.optString("tag", "").trim()
    require(tag.isNotEmpty()) { "releases.json 无 tag" }
    val sizes = LinkedHashMap<String, Long>()
    val arr = j.optJSONArray("assets") ?: JSONArray()
    for (i in 0 until arr.length()) {
      val a = arr.optJSONObject(i) ?: continue
      val name = a.optString("name", "").trim()
      if (name.isEmpty()) continue
      sizes[name] = a.optLong("size", 0L)
    }
    val digests = LinkedHashMap<String, String>()
    val sha = j.optJSONObject("sha256")
    if (sha != null) {
      for (family in listOf("arm64", "x86_64")) {
        val digest = sha.optString(family, "").trim()
        if (!SHA256_HEX.matches(digest)) continue
        val name = assetNameCandidates(tag, family).firstOrNull { sizes.containsKey(it) } ?: continue
        digests[name] = digest.lowercase()
      }
    }
    return LatestFacts(tag, sizes, digests)
  }

  /** 选中资产的下载地址：发布链的资产 URL 形态固定，镜像前缀由 [download] 运行时逐级回退。 */
  private fun assetDownloadUrl(tag: String, name: String): String =
    "https://github.com/" + REPO + "/releases/download/" + tag + "/" + name

  /**
   * 统一判定：选包 -> 比版本 -> 组装 [CheckResult.Available]（纯函数，可 JVM 单测）。
   *
   * **顺序是契约的一部分**：先确认"有本机可用的包"，再比版本——反过来会让"发布侧漏了本机架构的包"
   * 被"已是最新"掩盖，用户永远等不到适配版本，也不会看到任何异常。
   *
   * 摘要只从 [LatestFacts.sha256] 里按**选中资产名**取。缺失或无效时拒绝提供可安装更新，
   * 不用邻家资产或文件大小替代摘要校验。
   */
  internal fun classifyFacts(
    facts: LatestFacts,
    deviceAbis: List<String>,
    family: String,
    currentVersion: String,
  ): CheckResult {
    if (deviceAbis.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：读不到本机 ABI（SUPPORTED_ABIS 为空）——无法判断该取哪个包；这不是『没有 arm64 版本』",
        CheckResult.FailureKind.ABI_UNSUPPORTED,
      )
    }
    // 发布 tag 一律归一到带 v 的形态：MANIFEST.txt 里没有 tag 字段，只能从资产名反推出裸版本号
    // （`dsh-mobile-apk-v0.14.9-arm64.apk` -> `0.14.9`），而 GitHub 的 release tag 与站点 JSON 都是 `v0.14.9`。
    // 不归一的话，MANIFEST 这一档会拼出 /releases/download/0.14.9/... 这种必然 404 的地址——
    // 版本号看着对、下载永远失败，是最难排查的一类错。归一后展示文本也与其他档一致。
    val tag = if (facts.tag.startsWith("v")) facts.tag else "v" + facts.tag
    val hit = assetNameCandidates(tag, family).firstOrNull { facts.sizes.containsKey(it) }
      ?: return classifyAssetFailure(tag, family, deviceAbis, facts.sizes.keys.toList())
    if (!isNewer(tag, currentVersion)) return CheckResult.UpToDate
    val sha256 = facts.sha256[hit]?.takeIf { SHA256_HEX.matches(it) }?.lowercase()
      ?: return CheckResult.Failed(
        "检查失败：发布数据异常——APK 资产缺少有效 SHA-256，已拒绝提供更新包",
        CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      )
    return CheckResult.Available(
      tag,
      hit,
      assetDownloadUrl(tag, hit),
      sha256,
      facts.sizes[hit] ?: 0L,
    )
  }

  /**
   * 200 响应体的**判定**（纯函数）：选包 → 版本比较，失败按类归因。
   *
   * 保留本函数是既有契约（GitHub API 兜底与既有单测仍走它）；内部改为解析成 [LatestFacts] 后走
   * [classifyFacts]，三条数据源共用同一套判定规则，避免"哪个源先成功"改变用户看到的结论。
   *
   * 资产缺下载地址只在**本函数**里检查：API 是唯一自带 `browser_download_url` 的源，其余两源的下载地址
   * 由 [assetDownloadUrl] 按发布链形态拼出，不存在"字段为空"这种形态。
   */
  internal fun classifyLatestBody(body: String, deviceAbis: List<String>, family: String): CheckResult {
    val latest = try {
      parseLatestRelease(body)
    } catch (e: Exception) {
      return classifyTransportFailure(e)
    }
    if (deviceAbis.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：读不到本机 ABI（SUPPORTED_ABIS 为空）——无法判断该取哪个包；这不是『没有 arm64 版本』",
        CheckResult.FailureKind.ABI_UNSUPPORTED,
      )
    }
    val byName = latest.assets.associateBy { it.name }
    val hit = assetNameCandidates(latest.tag, family).firstNotNullOfOrNull { byName[it] }
      ?: return classifyAssetFailure(latest.tag, family, deviceAbis, latest.assets.map { it.name })
    if (hit.url.isEmpty()) {
      return CheckResult.Failed(
        "检查失败：发布数据异常——资产 " + hit.name + " 缺下载地址（发布可能未完成）",
        CheckResult.FailureKind.RELEASE_DATA_BROKEN,
      )
    }
    // 保留 API 的真实下载地址，同时把 APK assets[].digest 纳入统一摘要判据。
    val verdict = classifyFacts(
      factsFromRelease(latest),
      deviceAbis,
      family,
      currentVersion(),
    )
    // 下载地址仍用 API 自己给的 browser_download_url：只有这一档能拿到资产真实地址，
    // 用拼出来的形态顶替等于在"地址已变"时把一个可用的源改成不可用。其余两档没有该字段，
    // 由 [assetDownloadUrl] 按发布链形态拼出（镜像回退在 [download] 运行时做）。
    return if (verdict is CheckResult.Available) verdict.copy(apkUrl = hit.url) else verdict
  }

  // ── 版本号确认链：六档，顺序即优先级，每档独立超时 ────────────────────────────────
  //
  // 实测依据（2026-10-22，见 .deploy-tmp/update-refactor/02-source-probes.md）：
  //   · gh-proxy.com 取 MANIFEST 0.36s、1387B、零重定向——单点最快；
  //   · github.com 直连 1.93s（2 跳重定向）、ghfast.top 2.01s（1 跳）；
  //   · github.io 不被任何 gh-proxy 类镜像代理（404/403），所以 Pages 那一档必须直连，不能进镜像循环；
  //   · ghproxy.net 首次 502、成功时也要 25-34s——只能末位兜底，作主源会把"检查更新"拖成半分钟；
  //   · api.github.com 未认证 60 次/小时/IP 且配额被共享——降为最后的兜底。
  // 超时值按实测留余量。**每档独立**：共用一个大超时会让慢档吃掉快档的余量，
  // 而"某一档挂住"与"某一条线路慢"对用户是两件事。

  /** 一档确认源的**判定结果**。区分三类是为了聚合时能如实分档（见 [aggregateFailure]）。 */
  internal sealed class SourceProbe {
    class Parsed(val facts: LatestFacts) : SourceProbe()
    /** 拿到了 HTTP 响应但数据不可用（HTTP 错 / 解析失败 / 发布数据异常）。 */
    class Rejected(val kind: CheckResult.FailureKind, val reason: String) : SourceProbe()
    /** 连响应都没拿到（DNS / 连接 / 超时 / TLS）。 */
    class Unreachable(val e: Exception) : SourceProbe()
  }

  /**
   * 跑确认链：**任一档成功解析出版本号就立即返回**，不继续往下走（后面的档只会更慢）。
   *
   * 这一档解析成功但判定为失败（缺本机包 / 版本比较失败）同样立即返回：缺件结论来自这一份发布数据，
   * 换一条线路再问一遍只会拿到同一份数据的另一个副本，多问一遍不可能变出新架构的包。
   *
   * 抽成可注入的纯函数是为了让"全档失败不得谎报已是最新"这条纪律**能被单测钉住**——
   * 只测私有实现里的真实网络循环，等于把这条纪律交给运气。
   */
  internal fun runChain(
    attempts: List<Pair<String, () -> SourceProbe>>,
    deviceAbis: List<String>,
    family: String,
    current: String,
  ): CheckResult {
    val rejects = ArrayList<Pair<CheckResult.FailureKind, String>>()
    val unreachable = ArrayList<Exception>()
    for ((name, attempt) in attempts) {
      when (val r = attempt()) {
        is SourceProbe.Parsed -> {
          android.util.Log.i(TAG, "check confirmed via " + name + ": " + r.facts.tag)
          return classifyFacts(r.facts, deviceAbis, family, current)
        }
        is SourceProbe.Rejected -> {
          android.util.Log.w(TAG, "check source " + name + " rejected: " + r.reason)
          rejects.add(r.kind to r.reason)
        }
        is SourceProbe.Unreachable -> {
          android.util.Log.w(TAG, "check source " + name + " unreachable: " + (r.e.message ?: r.e.javaClass.simpleName))
          unreachable.add(r.e)
        }
      }
    }
    return aggregateFailure(rejects, unreachable)
  }

  /**
   * 全档失败时的**聚合分类**（纯函数，可 JVM 单测）：把"多次失败"归成用户能据此行动的一类。
   *
   * 判据与理由（顺序有讲究）：
   *  1. 任一档是**限流** -> RATE_LIMITED：这是唯一"等一会儿再来"的档，且它只可能来自 API；
   *  2. 任一档拿到了 HTTP 响应但数据不可用 -> 取那一类（API_HTTP / PARSE / RELEASE_DATA_BROKEN）：
   *     "服务可达但数据不对"与"连不上"是两种完全不同的事，前者换个网络也没用；
   *  3. 全部是连接类异常 -> NETWORK；
   *  其余 -> UNKNOWN（如实说未完成，不编造原因）。
   *
   * **绝不返回 UpToDate**：没有任何一档确认到版本号，"已是最新"没有任何事实支撑。
   */
  internal fun aggregateFailure(
    rejects: List<Pair<CheckResult.FailureKind, String>>,
    unreachable: List<Exception>,
  ): CheckResult.Failed {
    if (rejects.any { it.first == CheckResult.FailureKind.RATE_LIMITED }) {
      return classifyHttpFailure(429, true)
    }
    val http = rejects.firstOrNull { it.first == CheckResult.FailureKind.API_HTTP }
    if (http != null) return CheckResult.Failed(http.second, CheckResult.FailureKind.API_HTTP)
    val data = rejects.firstOrNull()
    if (data != null) return CheckResult.Failed(data.second, data.first)
    if (unreachable.isNotEmpty()) {
      val net = unreachable.filter { classifyTransportFailure(it).kind == CheckResult.FailureKind.NETWORK }
      if (net.size == unreachable.size) return classifyTransportFailure(net.first())
    }
    return CheckResult.Failed(
      "检查失败：更新源全部不可用（连接与数据均未成功）——请稍后重试；持续失败可复制日志反馈",
      CheckResult.FailureKind.UNKNOWN,
    )
  }

  /** 各档独立超时（毫秒）。数值来自实测并留余量，依据见上方确认链的注释。 */
  internal fun timeoutFor(source: String): Int = when (source) {
    "gh-proxy" -> 8_000
    "ghfast" -> 15_000
    "github" -> 15_000
    "pages" -> 8_000
    "ghproxy.net" -> 30_000
    else -> 15_000
  }

  private fun probeSources(deadline: UpdateCheckDeadline): CheckResult {
    val abis = deviceAbis()
    val latestPath = REPO + "/releases/latest/download/MANIFEST.txt"
    val attempts: List<Pair<String, () -> SourceProbe>> = listOf(
      "gh-proxy" to { probeManifest(MIRROR_PREFIXES[1] + latestPath, timeoutFor("gh-proxy"), deadline) },
      "ghfast" to { probeManifest(MIRROR_PREFIXES[2] + latestPath, timeoutFor("ghfast"), deadline) },
      "github" to { probeManifest(MIRROR_PREFIXES[0] + latestPath, timeoutFor("github"), deadline) },
      "pages" to { probePages(SITE_URL + "data/releases.json", timeoutFor("pages"), deadline) },
      "ghproxy.net" to { probeManifest(MIRROR_PREFIXES[3] + latestPath, timeoutFor("ghproxy.net"), deadline) },
      "api" to { probeApi(timeoutFor("api"), deadline) },
    )
    return runChain(attempts, abis, abiFrom(abis), currentVersion())
  }

  /** 元数据读取上限（#10）：MANIFEST/releases.json 都是 KB 级；超过它的一定不是元数据（防无上限读 OOM/拖死）。 */
  internal const val METADATA_MAX_BYTES = 1 shl 20

  /** 元数据重定向跳数上限（#10）：合法链路 1-2 跳；再多就是环或被劫持。 */
  internal const val METADATA_MAX_REDIRECTS = 3

  /**
   * 元数据 302 的合法落点域（#10）。摘要权威源（MANIFEST/releases.json 里的 sha256）决定 169MB
   * 载荷的可信度，不能被镜像方 302 到**任意**主机——那等于把校验值的签发权交出去。
   * 同域跳转（镜像自身的路径调整）恒允许；跨域只放行 GitHub 官方资产域（release 下载的
   * 既有落点）。白名单外的目标按数据错误拒绝（isDataError → PARSE 分档）。
   */
  internal val METADATA_REDIRECT_HOSTS = setOf(
    "github.com", "api.github.com", "codeload.github.com",
    "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
  )

  internal fun metadataRedirectAllowed(fromHost: String, toHost: String): Boolean =
    toHost == fromHost || METADATA_REDIRECT_HOSTS.contains(toHost)

  /**
   * 取一档文本（不做镜像回退：每档就是一个明确 URL，回退由 [runChain] 的顺序负责）。
   *
   * #10（2026-10-25 审计）：重定向改为**手工限域跟随**（同域或 GitHub 官方域、仅 https、
   * ≤[METADATA_MAX_REDIRECTS] 跳），读取加上限——旧实现 `instanceFollowRedirects = true`
   * 盲跟任意 302 + `readBytes()` 无上限，镜像方一条 302 就能把摘要权威源劫到任意主机并
   * 无限流式输出。
   */
  private val metadataTimers = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "dsh-update-metadata-deadline").apply { isDaemon = true }
  }

  internal fun fetchText(
    url: String,
    timeoutMs: Int,
    accept: String?,
    checkDeadline: UpdateCheckDeadline,
    openConnection: (URL) -> HttpURLConnection = { it.openConnection(Proxy.NO_PROXY) as HttpURLConnection },
  ): String {
    val deadline = checkDeadline.source(timeoutMs)
    var current = url
    var hops = 0
    while (true) {
      deadline.remainingMs()
      val conn = openConnection(URL(current))
      val cancellation = metadataTimers.schedule(
        { runCatching { conn.disconnect() } }, deadline.remainingMs(), java.util.concurrent.TimeUnit.MILLISECONDS,
      )
      try {
        conn.connectTimeout = deadline.timeoutMs(timeoutMs)
        conn.readTimeout = deadline.timeoutMs(timeoutMs)
        conn.instanceFollowRedirects = false
        accept?.let { conn.setRequestProperty("Accept", it) }
        val code = conn.responseCode
        deadline.remainingMs()
        if (code in 300..399 && code != 304) {
          val location = conn.getHeaderField("Location")
            ?: throw HttpStatusException(code, url, conn.getHeaderField("x-ratelimit-remaining"), conn.getHeaderField("retry-after"))
          val next = URL(URL(current), location)
          if (next.protocol != "https") {
            throw IllegalStateException("元数据重定向降级到非 https：" + next.protocol)
          }
          if (++hops > METADATA_MAX_REDIRECTS) {
            throw IllegalStateException("元数据重定向超过 " + METADATA_MAX_REDIRECTS + " 跳")
          }
          if (!metadataRedirectAllowed(URL(current).host, next.host)) {
            throw IllegalStateException("元数据重定向目标不在发布链白名单：" + next.host)
          }
          current = next.toString()
          continue
        }
        if (code != 200) {
          // 把限流响应头一起带出去：旧实现靠它们区分"配额耗尽（等一会儿再来）"与"普通 403（换网络也没用）"，
          // 丢掉这两个头等于把两种完全不同的处置方式压成同一条建议。
          throw HttpStatusException(code, url, conn.getHeaderField("x-ratelimit-remaining"), conn.getHeaderField("retry-after"))
        }
        return conn.inputStream.use { input ->
          val buf = java.io.ByteArrayOutputStream()
          val chunk = ByteArray(8 * 1024)
          while (true) {
            conn.readTimeout = deadline.timeoutMs(timeoutMs)
            val n = input.read(chunk)
            deadline.remainingMs()
            if (n < 0) break
            if (buf.size() + n > METADATA_MAX_BYTES) {
              throw IllegalStateException("元数据超过 " + METADATA_MAX_BYTES + " 字节上限（不是合法的 MANIFEST/releases.json）")
            }
            buf.write(chunk, 0, n)
          }
          buf.toString(Charsets.UTF_8)
        }
      } finally {
        cancellation.cancel(false)
        runCatching { conn.disconnect() }
      }
    }
  }

  /**
   * 非 200 携带状态码与限流响应头：调用方据此在 HTTP 错与连接错之间分档。
   * **不携带响应体**——GitHub 的限流说明里含请求来源 IP，日志会被用户分享出去（见 [classifyHttpFailure]）。
   */
  private class HttpStatusException(
    val code: Int,
    val url: String,
    val rateLimitRemaining: String?,
    val retryAfter: String?,
  ) : java.io.IOException("HTTP " + code + " " + url)

  /** 解析/格式类异常（MANIFEST 格式、JSON 畸形）不是连接失败，必须归 PARSE 而不是 NETWORK。 */
  private fun isDataError(e: Throwable): Boolean {
    val n = e.javaClass.name
    return n.contains("JSONException") || n.contains("IllegalArgument") || n.contains("IllegalState")
  }

  /** 一档源失败的统一归口：HTTP 错按状态码分档，数据错归 PARSE，其余才算"连不上"。 */
  private fun probeFailure(e: Exception): SourceProbe = when {
    e is HttpStatusException -> {
      val failure = classifyHttpFailure(e.code, isRateLimited(e.code, e.rateLimitRemaining, e.retryAfter))
      SourceProbe.Rejected(failure.kind, failure.reason)
    }
    isDataError(e) -> {
      val failure = classifyTransportFailure(e)
      SourceProbe.Rejected(failure.kind, failure.reason)
    }
    else -> SourceProbe.Unreachable(e)
  }

  private fun probeManifest(url: String, timeoutMs: Int, deadline: UpdateCheckDeadline): SourceProbe = try {
    SourceProbe.Parsed(parseManifest(fetchText(url, timeoutMs, null, deadline)))
  } catch (e: Exception) {
    probeFailure(e)
  }

  private fun probePages(url: String, timeoutMs: Int, deadline: UpdateCheckDeadline): SourceProbe = try {
    SourceProbe.Parsed(parsePagesReleaseJson(fetchText(url, timeoutMs, null, deadline)))
  } catch (e: Exception) {
    probeFailure(e)
  }

  private fun probeApi(timeoutMs: Int, deadline: UpdateCheckDeadline): SourceProbe = try {
    val latest = parseLatestRelease(fetchText("$API/repos/$REPO/releases/latest", timeoutMs, "application/vnd.github+json", deadline))
    SourceProbe.Parsed(factsFromRelease(latest))
  } catch (e: Exception) {
    probeFailure(e)
  }

  /**
   * 查最新版本：六档确认链（顺序与超时见 [probeSources] 与 [timeoutFor]）。
   *
   * 资产按 [assetNameCandidates] 匹配（发布链口径优先，兼容历史口径）；版本比较用 [isNewer]。
   * **只有至少一档成功解析出版本号，才允许返回 [CheckResult.UpToDate]**——"查不到"与"没有新版"
   * 是两件事，混为一谈会让用户错过整轮更新，且没有任何一层能再纠正这个谎。
   *
   * 元数据只取小文件（MANIFEST 约 1.4KB / releases.json 约 1.3KB），169MB 的 APK 才走镜像下载链（[download]）。
   */
  fun checkLatest(): CheckResult = checkLatest(UpdateCheckDeadline.start())

  internal fun checkLatest(deadline: UpdateCheckDeadline): CheckResult = try {
    probeSources(deadline)
  } catch (e: Exception) {
    android.util.Log.w(TAG, "check chain failed: " + (e.message ?: e.javaClass.simpleName))
    classifyTransportFailure(e)
  }

  /** 当前版本（只去快照后缀 -SN-*；0.13.7fx-1-SN-1-13 → 0.13.7fx-1）。
   *  注意：修订号 -1/-2（0.13.7fx-N 命名）**不能**当后缀剥掉，否则 fx-2 会被判成与 fx-1 同版。 */
  fun currentVersion(): String = BuildConfig.VERSION_NAME.replace(Regex("-SN-.*$"), "")

  /**
   * 预发布/快照后缀**白名单**（FX-209.2，E-5/E-11）：只剥 rc / preview / SN 这一类
   * 非发布序号后缀（含其后的数字段：-rc.1 / -preview2 / -SN-1-13）。
   *
   * - 旧实现（不剥任何后缀）把 `v0.13.7-rc.1` 的 `1` 当成第四个版本段 → 判为比 0.13.7 新；
   * - `-fx-N` 是**修订更新链**的一环（0.13.7fx-2 必须比 0.13.7fx-1 新），不在白名单内，
   *   因此绝不能被剥掉——这正是 E-11 判「回退」的形态。
   * - 白名单是闭集：任何未列出的尾巴（fx-N、build.7、自定义渠道段）一律保留原样参与比较。
   */
  private val PRERELEASE_SUFFIX = Regex("(?i)-(?:rc|preview|sn)(?:[.\\-]?\\d+)*$")

  /** 剥掉白名单后缀（internal：单测复算 6 组 tag 形态）。 */
  internal fun stripPrereleaseSuffix(v: String): String = PRERELEASE_SUFFIX.replace(v, "")

  /** 语义比较：取版本串（先剥白名单后缀）里的**全部数字组**逐位比大小（"0.13.7fx-1" → [0,13,7,1]），
   *  位数不足补 0（0.13 == 0.13.0）。覆盖两种命名：语义化版本与 0.13.7fx-N 修订号。
   *  tag 形如 v0.13.8 / 0.13.8 / v0.13.7fx-2 / v0.13.7-rc.1（rc 段不参与比较）。
   *  FX-209.2：两侧同口径剥后缀（BuildConfig.VERSION_NAME 亦可能是 0.14.0-preview）。 */
  fun isNewer(tag: String, current: String): Boolean {
    // SemVer 的 build metadata（`+build.7`）**不参与优先级**：不切掉的话 `v0.14.5+build.7`
    // 会比 `0.14.5` 多出一个数字组 [.., 7] > [.., 0] ⇒ 每轮检查都报"发现新版"，
    // 随后去要 `…-v0.14.5+build.7-arm64.apk` 必然不存在，最终把"版本号写法"错报成
    // "没有适配本机架构的包"（与 0.14.6 修掉的那类错误归类同源）。
    fun parts(v: String) =
      Regex("\\d+").findAll(stripPrereleaseSuffix(v.substringBefore('+'))).map { it.value.toLongOrNull() ?: 0L }.toList()
    val a = parts(tag); val b = parts(current)
    for (i in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrElse(i) { 0L }; val y = b.getOrElse(i) { 0L }
      if (x != y) return x > y
    }
    return false
  }

  /**
   * 下载重定向的最终域白名单（#513）：直连与镜像域名之外的一律放弃该线路走下一条。
   * 旧实现 `instanceFollowRedirects = true` 无白名单——镜像被劫持 302 到任意域会直接跟随
   * （对照 linux-bootstrap 的 github.js assertResponse，同为下载链标准应对齐）。
   */
  internal val ALLOWED_DOWNLOAD_HOSTS = setOf(
    "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "gh-proxy.com", "ghfast.top", "ghproxy.net",
  )

  /** 纯判据（JVM 单测）：跟随至多 maxHops 跳后，每个中间/最终 URL 的 host 是否都在白名单内。 */
  internal fun redirectChainAllowed(hops: List<String>, allowed: Set<String> = ALLOWED_DOWNLOAD_HOSTS): Boolean =
    hops.isNotEmpty() && hops.all { raw ->
      val host = try { URL(raw).host.lowercase() } catch (_: Exception) { return@all false }
      host in allowed
    }

  /**
   * 通过镜像链把 GitHub 资产 URL 逐级尝试下载到目标文件（.tmp → rename 原子落盘）。
   *
   * 前缀表与确认链**同一份**（[MIRROR_PREFIXES]）：查版本与下 APK 若走不同线路集合，
   * 就会出现"能查到新版却下不下来"这种介于两者之间的状态，而没有任何一层为它负责。
   *
   * @param allowMirrors false = 只允许官方直连（#513：元数据缺 sha256 时，第三方镜像产物
   *   无摘要可校验、直通安装器——fail-closed，宁可下载失败也不裸奔）。
   * @param isActive stops an invalidated attempt before further reads or publication.
   * @param publishIfActive serializes the final move with the owner's generation change.
   * @param connectionFactory transport test seam; production uses verified redirects.
   */
  fun download(
    url: String,
    dest: File,
    onProgress: (percent: Int) -> Unit,
    allowMirrors: Boolean = true,
    isActive: () -> Boolean = { true },
    publishIfActive: (() -> Unit) -> Boolean = { publish -> publish(); true },
    connectionFactory: (String) -> HttpURLConnection? = ::openRedirectVerified,
  ): String? {
    val path = url.removePrefix("https://github.com/")
    val prefixes = if (allowMirrors) MIRROR_PREFIXES else listOf(MIRROR_PREFIXES[0])
    for (mirror in prefixes) {
      if (!isActive()) return null
      val candidate = if (mirror == MIRROR_PREFIXES[0]) url else mirror + path
      var conn: HttpURLConnection? = null
      var ownedTemporary: File? = null
      try {
        conn = connectionFactory(candidate) ?: continue
        if (conn.responseCode != 200) continue
        val total = conn.contentLengthLong
        val parent = dest.absoluteFile.parentFile
        parent.mkdirs()
        // A failed or cancelled attempt owns only this unique staging file.
        val tmp = File.createTempFile("dsh-apk-" + dest.name + ".", ".tmp", parent)
        ownedTemporary = tmp
        tmp.outputStream().use { out ->
          conn.inputStream.use { input ->
            val buf = ByteArray(128 * 1024)
            var read = 0L
            var lastPct = -1
            while (true) {
              if (!isActive()) return null
              val n = input.read(buf)
              if (n < 0) break
              if (!isActive()) return null
              out.write(buf, 0, n)
              read += n
              if (total > 0) {
                val pct = (read * 100 / total).toInt()
                if (pct != lastPct) { lastPct = pct; onProgress(pct) }
              }
            }
          }
        }
        if (!isActive()) return null
        // The owner serializes this publication with invalidation of its generation.
        if (!publishIfActive {
          if (!AtomicFileReplace.publish(tmp, dest)) throw java.io.IOException("APK publication failed")
        }) return null
        return candidate
      } catch (e: Exception) {
        android.util.Log.w(TAG, "download via $mirror failed: " + (e.message ?: e.javaClass.simpleName))
      } finally {
        runCatching { conn?.disconnect() }
        ownedTemporary?.delete()
      }
    }
    return null
  }

  /**
   * 打开连接并手动跟随重定向（≤3 跳），每一跳的最终域都必须在 [ALLOWED_DOWNLOAD_HOSTS] 内；
   * 越域或超跳数返回 null（调用方按"该线路失败"走下一条镜像，绝不盲跟）。
   */
  private fun openRedirectVerified(startUrl: String): HttpURLConnection? {
    var current = startUrl
    var conn: HttpURLConnection? = null
    for (hop in 0..3) {
      if (!redirectChainAllowed(listOf(current))) return null
      conn = try { URL(current).openConnection(Proxy.NO_PROXY) as HttpURLConnection } catch (_: Exception) { return null }
      conn.connectTimeout = 10_000
      conn.readTimeout = 30_000
      conn.instanceFollowRedirects = false
      val code = try { conn.responseCode } catch (_: Exception) { conn.disconnect(); return null }
      if (code in 300..399) {
        val location = conn.getHeaderField("Location") ?: run { conn.disconnect(); return null }
        conn.disconnect()
        current = if (location.startsWith("http")) location else URL(URL(current), location).toString()
        continue
      }
      return conn
    }
    conn?.disconnect()
    return null
  }

  /**
   * 下载后 sha256 校验。预期值**只接受摘要本身**（[CheckResult.Available.sha256] 的定义）：
   * 旧实现还要从 MANIFEST 行里剥掉尾随文件名的兼容分支，那让"传进来的是整行还是摘要"变成
   * 调用方各自的理解，校验对不上时也无从判断是文件坏了还是口径错了。
   */
  fun verifySha256(file: File, expected: String): Boolean = try {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(128 * 1024)
      while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    val actual = md.digest().joinToString("") { "%02x".format(it) }
    actual.equals(expected.trim(), ignoreCase = true)
  } catch (_: Exception) { false }

  /** 安装未知应用来源权限是否已持有（manifest 已声明 REQUEST_INSTALL_PACKAGES）。 */
  fun canInstall(context: Context): Boolean =
    if (android.os.Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true

  /**
   * 拉起「安装未知应用」授权页（普通 startActivity；返回时 onResume 结算，与目录授权同一惯例）。
   *
   * S1-10：**返回是否真的拉起了**。旧实现两级 catch 都失败也不回报，而调用方已经把
   * 「已打开授权页——开启后返回即自动安装」写进了界面：少数 OEM 上那句承诺是假的，
   * 用户在那一页等一个永远不会出现的系统页面。判据改成「有路径成功 startActivity 才回 true」。
   */
  fun requestInstallPermission(activity: android.app.Activity): Boolean {
    val perApp = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
    try {
      activity.startActivity(perApp)
      return true
    } catch (e: Exception) {
      LogCollector.log(TAG, "per-app install-sources page failed: " + (e.message ?: e.javaClass.simpleName))
    }
    // 少数 OEM 无按应用授权页：退化为全局页。
    try {
      activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
      return true
    } catch (e: Exception) {
      LogCollector.log(TAG, "global install-sources page failed: " + (e.message ?: e.javaClass.simpleName))
      return false
    }
  }

  /** FileProvider URI + ACTION_VIEW 唤起系统安装器（签名不匹配由系统拒绝）。 */
  fun invokeInstaller(activity: android.app.Activity, apk: File): Boolean = try {
    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    activity.startActivity(intent)
    true
  } catch (e: Exception) {
    LogCollector.log(TAG, "installer invoke failed: " + (e.message ?: e.javaClass.simpleName))
    false
  }
}
