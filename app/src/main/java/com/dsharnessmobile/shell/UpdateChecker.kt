package com.dsharnessmobile.shell

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
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
 *   签名不匹配由系统安装器天然拒绝；sha256 资产存在则下载后校验。
 * 与引擎快照更新（EngineStartFlow.startUpdateCheck / UpdateManager）完全分离。
 */
object UpdateChecker {

  private const val TAG = "dsh-update"
  private const val REPO = "kelai141/dsh-mobile-apk"

  /** 镜像链（gh-proxy 风格前缀；直连永远第一。站点失效自动逐级回退）。 */
  private val MIRRORS = listOf(
    "https://github.com/",
    "https://gh-proxy.com/https://github.com/",
    "https://ghfast.top/https://github.com/",
  )
  private const val API = "https://api.github.com"

  /** 更新包落点（已在 file_paths.xml 的 Documents/dshdata 映射内，零新映射）。 */
  fun updatesDir(context: Context): File =
    File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOCUMENTS), "dshdata/updates")

  sealed class CheckResult {
    /** 已是最新（latest.tag == 当前版本）。 */
    data object UpToDate : CheckResult()
    /** 发现新版：tag + 双 ABI 资产 URL（按设备 ABI 已选好）。 */
    data class Available(val tag: String, val name: String, val apkUrl: String, val sha256Url: String?, val sizeBytes: Long) : CheckResult()
    data class Failed(val reason: String) : CheckResult()
  }

  /** 设备 ABI → 资产命名 ABI（与 build-apk-013.ps1 双 ABI 口径一致：arm64 / x86_64）。
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

  private fun deviceAbi(): String = abiFrom(android.os.Build.SUPPORTED_ABIS.toList())

  /** 资产命名契约（须与 scripts/build-apk-013.ps1 的 Copy-Item 命名逐字一致）：
   *  dsh-mobile-apk-v<版本>-<abi>.apk，abi ∈ {arm64, x86_64}。 */
  fun assetName(tag: String, abi: String): String = "dsh-mobile-apk-v${tag.removePrefix("v")}-$abi.apk"

  /**
   * 查 latest release（镜像链逐级回退）；资产按 dsh-mobile-apk-v<ver>-<abi>.apk 匹配。
   * 版本比较：tag（去 v 前缀）与 BuildConfig.VERSION_NAME 语义比较（点分段数值）；
   * 相等 = 已是最新（快照后缀 -SN-* 不参与比较）。
   */
  fun checkLatest(): CheckResult {
    // 元数据直连 GitHub API（体积小、可用性远高于 169MB 资产下载）；
    // 资产下载才走镜像链（download()）。API 不可达即失败并如实报告。
    try {
      val conn = URL("$API/repos/$REPO/releases/latest").openConnection(Proxy.NO_PROXY) as HttpURLConnection
      conn.connectTimeout = 10_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("Accept", "application/vnd.github+json")
      val httpCode = conn.responseCode
      if (httpCode != 200) {
        conn.disconnect()
        return CheckResult.Failed("检查失败：GitHub API 返回 HTTP $httpCode")
      }
      val body = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
      conn.disconnect()
      val j = JSONObject(body)
      val tag = j.optString("tag_name", "")
      if (tag.isEmpty()) return CheckResult.Failed("latest release 无 tag_name")
      val assets = j.optJSONArray("assets") ?: org.json.JSONArray()
      val abi = deviceAbi()
      val want = assetName(tag, abi)
      var apkUrl = ""
      var shaUrl: String? = null
      var size = 0L
      for (i in 0 until assets.length()) {
        val a = assets.optJSONObject(i) ?: continue
        val name = a.optString("name", "")
        if (name == want) { apkUrl = a.optString("browser_download_url", ""); size = a.optLong("size", 0L) }
        if (name == "$want.sha256") shaUrl = a.optString("browser_download_url", "")
      }
      if (apkUrl.isEmpty()) return CheckResult.Failed("latest release $tag 无 $abi 资产（$want）")
      if (!isNewer(tag, currentVersion())) return CheckResult.UpToDate
      return CheckResult.Available(tag, want, apkUrl, shaUrl, size)
    } catch (e: Exception) {
      android.util.Log.w(TAG, "check via $API failed: " + (e.message ?: e.javaClass.simpleName))
      return CheckResult.Failed("检查失败：" + (e.message ?: e.javaClass.simpleName) + "——请核对网络后重试")
    }
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
    fun parts(v: String) = Regex("\\d+").findAll(stripPrereleaseSuffix(v)).map { it.value.toLongOrNull() ?: 0L }.toList()
    val a = parts(tag); val b = parts(current)
    for (i in 0 until maxOf(a.size, b.size)) {
      val x = a.getOrElse(i) { 0L }; val y = b.getOrElse(i) { 0L }
      if (x != y) return x > y
    }
    return false
  }

  /** 通过镜像链把 GitHub 资产 URL 逐级尝试下载到目标文件（.tmp → rename 原子落盘）。 */
  fun download(url: String, dest: File, onProgress: (percent: Int) -> Unit): String? {
    val path = url.removePrefix("https://github.com/")
    for (mirror in MIRRORS) {
      val candidate = if (mirror == MIRRORS[0]) url else mirror + path
      try {
        val conn = URL(candidate).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.instanceFollowRedirects = true
        if (conn.responseCode != 200) { conn.disconnect(); continue }
        val total = conn.contentLengthLong
        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, dest.name + ".tmp")
        tmp.outputStream().use { out ->
          conn.inputStream.use { input ->
            val buf = ByteArray(128 * 1024)
            var read = 0L
            var lastPct = -1
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              read += n
              if (total > 0) {
                val pct = (read * 100 / total).toInt()
                if (pct != lastPct) { lastPct = pct; onProgress(pct) }
              }
            }
          }
        }
        if (dest.exists()) dest.delete()
        if (!tmp.renameTo(dest)) { tmp.copyTo(dest, overwrite = true); tmp.delete() }
        conn.disconnect()
        return candidate
      } catch (e: Exception) {
        android.util.Log.w(TAG, "download via $mirror failed: " + (e.message ?: e.javaClass.simpleName))
        File(dest.parentFile, dest.name + ".tmp").delete()
      }
    }
    return null
  }

  /** 下载后 sha256 校验（可选；资产缺失 .sha256 时跳过）。 */
  fun verifySha256(file: File, expected: String): Boolean = try {
    val md = java.security.MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(128 * 1024)
      while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
    }
    val actual = md.digest().joinToString("") { "%02x".format(it) }
    actual.equals(expected.trim().substringBefore(' '), ignoreCase = true)
  } catch (_: Exception) { false }

  /** 通过镜像链取小文本（.sha256 资产；全部镜像失败返回 null = 跳过校验而非判失败）。 */
  fun downloadText(url: String): String? {
    val path = url.removePrefix("https://github.com/")
    for (mirror in MIRRORS) {
      val candidate = if (mirror == MIRRORS[0]) url else mirror + path
      try {
        val conn = URL(candidate).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        if (conn.responseCode != 200) { conn.disconnect(); continue }
        val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        conn.disconnect()
        if (text.isNotBlank()) return text
      } catch (e: Exception) {
        android.util.Log.w(TAG, "text via $mirror failed: " + (e.message ?: e.javaClass.simpleName))
      }
    }
    return null
  }

  /** 安装未知应用来源权限是否已持有（manifest 已声明 REQUEST_INSTALL_PACKAGES）。 */
  fun canInstall(context: Context): Boolean =
    if (android.os.Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true

  /** 拉起「安装未知应用」授权页（普通 startActivity；返回时 onResume 结算，与目录授权同一惯例）。 */
  fun requestInstallPermission(activity: android.app.Activity) {
    val perApp = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
    try {
      activity.startActivity(perApp)
    } catch (_: Exception) {
      // 少数 OEM 无按应用授权页：退化为全局页。
      try {
        activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
      } catch (_: Exception) {
        // 无任何入口：留在待装态，用户可再点按钮重试。
      }
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
