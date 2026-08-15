package com.dshmobile.shell

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Runtime snapshot online update (M2): fetch a manifest {url, sha256, size},
 * download the snapshot, verify, extract to usr-new, then atomically swap
 * usr → usr-old / usr-new → usr. The engine restart is handled by the
 * EngineService watchdog on the next poll.
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
        val manifest = JSONObject(fetch(manifestUrl))
        val url = manifest.getString("url")
        val expectedSha = manifest.optString("sha256", "")

        onStatus("下载快照（" + (manifest.optLong("size", 0) / 1024 / 1024) + " MB）…")
        val tmp = File(context.filesDir, "update.tar.xz")
        download(url, tmp)

        if (expectedSha.isNotEmpty()) {
          onStatus("校验…")
          val actual = sha256(tmp)
          if (!actual.equals(expectedSha, ignoreCase = true)) {
            tmp.delete()
            throw IllegalStateException("SHA256 不匹配: " + actual.take(12) + "…")
          }
        }

        onStatus("解压新快照…")
        // The archive holds a usr/ prefix; stage it OUTSIDE the live tree.
        val stage = File(context.filesDir, "update-stage")
        deleteRecursively(stage)
        SnapshotExtractor.extract(
          tmp.inputStream(), manifest.optLong("size", 0), stage, { _, _ -> },
        )
        tmp.delete()
        val newUsr = File(stage, "usr")
        if (!File(newUsr, "bin/node").exists()) throw IllegalStateException("新快照缺少 node")

        onStatus("切换运行时…")
        val usr = File(context.filesDir, "usr")
        val old = File(context.filesDir, "usr-old")
        deleteRecursively(old)
        if (usr.exists()) usr.renameTo(old)
        if (!newUsr.renameTo(usr)) throw IllegalStateException("切换失败")
        deleteRecursively(stage)
        deleteRecursively(old)

        // Kill the old engine process: the EngineService watchdog restarts
        // it from the NEW usr within seconds.
        try {
          Runtime.getRuntime().exec(arrayOf("/system/bin/pkill", "-f", "bin.js")).waitFor()
        } catch (_: Throwable) {
        }
        // 记录快照指纹：在线更新后与内嵌 assets 指纹区分（否则下次启动
        // 会误判"快照过期"而重解压 assets 快照，把在线更新覆盖回出厂）。
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

  private fun download(url: String, dest: File) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 10_000
    conn.readTimeout = 60_000
    val code = conn.responseCode
    if (code != 200) throw IllegalStateException("下载 HTTP $code")
    conn.inputStream.use { input -> dest.outputStream().use { out -> input.copyTo(out) } }
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

  private fun deleteRecursively(file: File) {
    if (!file.exists()) return
    file.walkBottomUp().forEach { it.delete() }
  }

  companion object {
    /** Emulator reaches the host loopback alias; production overrides via manifestUrl. */
    const val DEFAULT_MANIFEST_URL = "http://10.0.2.2:8899/manifest.json"
  }
}