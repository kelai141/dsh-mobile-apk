package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Runtime snapshot online update (M2): fetch a manifest {url, sha256, size},
 * download the snapshot, verify, extract to an update-stage dir outside the
 * live tree, then atomically swap usr → usr-old / update-stage/usr → usr.
 * The engine restart is handled by the EngineService watchdog on the next poll.
 */
class UpdateManager(private val context: Context) {

  /**
   * Manifest URL override for testing (emulator reaches the host via
   * 10.0.2.2). Production builds point at a real release server.
   */
  var manifestUrl: String = DEFAULT_MANIFEST_URL

  /**
   * Run the update flow on a background thread.
   * @param onStatus progress text callback (any thread).
   */
  fun checkAndApply(onStatus: (String) -> Unit) {
    Thread {
      try {
        onStatus("检查更新…")
        // S-10：未配置可信发布源 = 未启用（不再对着模拟器别名超时，也不再给出「可用」的错觉）。
        if (manifestUrl.isBlank()) {
          throw IllegalStateException(
            "在线更新未启用：未配置可信发布源（需 HTTPS + 签名；本地联调用 overrideManifestUrl 打开）",
          )
        }
        val manifest = JSONObject(fetch(manifestUrl))
        val url = manifest.getString("url")
        // 完整性加固（2026-08-23，审核 A6/B5）：在线更新快照可被中间人篡改——
        // manifest 必须带 sha256 才能应用（空值拒绝），下载按声明大小限流。
        val expectedSha = manifest.getString("sha256")
        val declaredSize = manifest.optLong("size", 0)

        onStatus("下载快照（" + (declaredSize / 1024 / 1024) + " MB）…")
        val tmp = File(context.filesDir, "update.tar.xz")
        download(url, tmp, declaredSize)

        onStatus("校验…")
        val actual = sha256(tmp)
        if (!actual.equals(expectedSha, ignoreCase = true)) {
          tmp.delete()
          throw IllegalStateException("SHA256 不匹配: " + actual.take(12) + "…")
        }

        onStatus("解压新快照…")
        // The archive holds a usr/ prefix; stage it OUTSIDE the live tree.
        val stage = File(context.filesDir, "update-stage")
        SnapshotFs.deletePath(stage)
        SnapshotExtractor.extract(
          tmp.inputStream(), manifest.optLong("size", 0), stage, { _, _ -> }, runtimeRoot = context.filesDir,
        )
        tmp.delete()
        val newUsr = File(stage, "usr")
        if (!File(newUsr, "bin/node").exists()) throw IllegalStateException("新快照缺少 node")

        onStatus("切换运行时…")
        val usr = File(context.filesDir, "usr")
        val old = File(context.filesDir, "usr-old")
        SnapshotFs.deletePath(old)
        if (usr.exists()) usr.renameTo(old)
        if (!newUsr.renameTo(usr)) {
          // 切换失败：立即回退旧代，不留半更新状态（PRD F3.2 第二层回退语义）。
          if (old.exists() && !old.renameTo(usr)) {
            Log.e("dsh-update", "swap failed and rollback failed; old runtime at usr-old: " + old.absolutePath)
          }
          throw IllegalStateException("切换失败（已回退旧代）")
        }
        SnapshotFs.deletePath(stage)
        // 更新管理器第二版（PRD F3.2/F1.10）：保留上一版运行时（usr-old），
        // 由 EngineManager 探活确认（连续 N 次健康）后清理；超窗未健康自动回退旧代。
        // 原子切换联动 F3 最后已知良好状态语义：pending 标记是回退状态机的输入。
        File(context.filesDir, ".update-pending").writeText("1")
        File(context.filesDir, ".update-pending-at").writeText(System.currentTimeMillis().toString())

        // Kill the old engine process: the EngineService watchdog restarts
        // it from the NEW usr within seconds.
        try {
          Runtime.getRuntime().exec(arrayOf("/system/bin/pkill", "-f", "bin.js")).waitFor()
        } catch (_: Throwable) {
        }
        // Record the snapshot fingerprint: distinguishes an online update from the embedded assets
        // fingerprint (otherwise the next boot misjudges "snapshot stale" and re-extracts the assets
        // snapshot, reverting the online update to factory state).
        if (expectedSha.isNotEmpty()) {
          File(context.filesDir, ".snapshot-fingerprint").writeText(expectedSha)
        }
        onStatus("更新完成，引擎已自动重启")
      } catch (t: Throwable) {
        onStatus("更新失败：" + (t.message ?: t.javaClass.simpleName))
      }
    }.start()
  }

  private fun fetch(url: String): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 10_000
    conn.readTimeout = 30_000
    val code = conn.responseCode
    if (code != 200) throw IllegalStateException("manifest HTTP $code")
    return conn.inputStream.bufferedReader().use { it.readText() }
  }

  private fun download(url: String, dest: File, declaredSize: Long = 0) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 10_000
    conn.readTimeout = 60_000
    val code = conn.responseCode
    if (code != 200) throw IllegalStateException("下载 HTTP $code")
    conn.inputStream.use { input -> dest.outputStream().use { out -> input.copyTo(out) } }
    // 大小限流（审核 B5 加固）：声明 size 存在且实际超限 → 删除并拒绝
    if (declaredSize > 0 && dest.length() > declaredSize + 16 * 1024 * 1024) {
      dest.delete()
      throw IllegalStateException("下载体积超限: " + dest.length() + " > " + declaredSize)
    }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      var n = input.read(buf)
      while (n >= 0) {
        digest.update(buf, 0, n)
        n = input.read(buf)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  companion object {
    /**
     * 发布面 manifest 地址（审查 §5.10 / S-10）。
     *
     * **空串 = 在线更新未启用**（默认，生产姿态）。旧实现把默认值写成
     * `http://10.0.2.2:8899/manifest.json`（**模拟器别名**）且全仓没有任何生产覆盖点 ⇒
     * 该功能在真机上只能得到「连接超时」，而文档仍把它当可用能力写（「看起来有、实际不可用」），
     * 同时留下一条明文 HTTP + 同信道 sha256 的更新路径（完整性基准与载荷同源，对主动 MITM 零效力）。
     *
     * 0.14.1 裁定（审查 S-10 的第二条选项）：**显式下线**，直到接上 HTTPS + 内置公钥签名。
     * 需要设备端联调的开发/验收场景用 [overrideManifestUrl] 显式打开（见其限制）。
     */
    const val DEFAULT_MANIFEST_URL = ""

    /** 开发/验收用的模拟器别名（仅 http 且仅此主机允许走明文）。 */
    private const val EMULATOR_HOST = "10.0.2.2"

    /** manifest 地址校验结论：accepted 为空串 = 关闭；refusal 非空 = 拒绝原因。 */
    data class ManifestUrlVerdict(val accepted: String, val refusal: String?)

    /**
     * 纯函数：manifest 地址的准入判据（可 JVM 单测；不碰 context）。
     *
     * 规则：空 = 关闭（生产默认）；只接受 http(s)；**明文 http 只允许回环与模拟器别名**
     * （本地联调与生产可用刻意分开，见 §5.10 的教训——旧实现把二者混成一个默认值）。
     */
    fun validateManifestUrl(url: String?): ManifestUrlVerdict {
      val text = url?.trim().orEmpty()
      if (text.isEmpty()) return ManifestUrlVerdict("", null)
      val scheme = text.substringBefore("://", "").lowercase()
      val host = text.substringAfter("://", "").substringBefore('/').substringBefore(':')
      if (text.contains("://") && scheme != "http" && scheme != "https") {
        return ManifestUrlVerdict("", "只接受 http(s) 地址（当前：$scheme）")
      }
      if (scheme != "https" && host != EMULATOR_HOST && host != "127.0.0.1" && host != "localhost") {
        return ManifestUrlVerdict(
          "",
          "明文 http 只允许回环与模拟器别名（$EMULATOR_HOST）：请改用 https，或经 adb reverse 映射到回环",
        )
      }
      return ManifestUrlVerdict(text, null)
    }
  }

  /**
   * 开发/验收用的显式开关：设置 manifest 地址（`null`/空 = 关闭）。
   *
   * 明文 http 只对**回环与模拟器别名**放行——其余一律要求 https。这样「本地联调」与
   * 「生产可用」不会因为同一个开关而混为一谈（§5.10 的教训是二者被混在一起）。
   * @return null = 接受；非 null = 拒绝原因。
   */
  fun overrideManifestUrl(url: String?): String? {
    val verdict = validateManifestUrl(url)
    manifestUrl = verdict.accepted
    return verdict.refusal
  }
}