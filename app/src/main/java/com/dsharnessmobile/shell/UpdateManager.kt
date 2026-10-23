package com.dsharnessmobile.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

/**
 * Runtime snapshot online update: fetch and verify a {url, sha256, size} archive,
 * extract it to the transaction-owned stage, and atomically swap only usr. A full
 * usr/ + home/ archive can provide verified Hard-composition evidence, but staged
 * home is never applied to the user's live HOME. The previous usr remains journaled
 * until candidate Hard health is confirmed; only then does the UI report completion.
 */
class UpdateManager(private val context: Context) {

  /**
   * 状态回执的**类型**（0.14.1 批 2 / P0-2）。
   *
   * 真因：旧实现把「本版没配发布源」当成**异常**抛出（`IllegalStateException`，消息里带着
   * `overrideManifestUrl` 这个只存在于代码里的名字），调用方只能靠**字符串前缀**猜相位，于是
   * 界面上出现「点一次检查更新 → 先弹『APK 已是最新』→ 半秒后满屏红字 + 内部术语」。
   * 「本版不提供这项能力」与「这项能力失败了」是两回事：前者是中性事实，用户的下一步动作
   * 也不同（前者无需处理，后者要看日志/重试）。故把结论做成**类型**，界面按类型决定相位，
   * 不再靠前缀匹配。
   */
  enum class UpdateOutcome { Working, Verifying, Done, Failed, NotConfigured }

  /** 一次状态回执：类型 + **用户可见**文案（不允许出现内部标识符）。 */
  data class UpdateStatus(val outcome: UpdateOutcome, val text: String)

  /** 未配置可信发布源时的文案（中性事实 + 下一步，不含内部术语）。 */
  val notConfiguredStatus = UpdateStatus(
    UpdateOutcome.NotConfigured,
    "本版不提供在线更新",
  )

  /**
   * Manifest URL override for testing (emulator reaches the host via
   * 10.0.2.2). Production builds point at a real release server.
   */
  var manifestUrl: String = DEFAULT_MANIFEST_URL

  /**
   * Run the update flow on a background thread.
   * @param onStatus 进度与终态回执（任意线程；**终态**由 `outcome` 判定，调用方不再猜前缀）。
   */
  fun checkAndApply(onStatus: (UpdateStatus) -> Unit) {
    Thread {
      val archive = File(context.filesDir, "update-${UUID.randomUUID()}.tar.xz")
      val stage = SnapshotTransaction.stageRoot(context.filesDir)
      var transactionStarted = false
      var ownsTransactionStage = false
      var probationStarted = false
      try {
        onStatus(UpdateStatus(UpdateOutcome.Working, "检查更新…"))
        // S-10：未配置可信发布源 = 未启用（不再对着模拟器别名超时，也不再给出「可用」的错觉）。
        // 0.14.1 批 2（P0-2）：这是**能力缺失**，不是故障——如实回一个中性终态，界面据此走 Info 相位。
        if (manifestUrl.isBlank()) {
          onStatus(notConfiguredStatus)
          return@Thread
        }
        val manager = EngineManager(context)
        if (!manager.beginOnlineUpdateTransaction()) {
          throw IllegalStateException("已有运行时事务或未归属的恢复现场正在进行")
        }
        ownsTransactionStage = true
        val manifest = JSONObject(fetch(manifestUrl))
        val url = manifest.getString("url")
        // 完整性加固（2026-08-23，审核 A6/B5）：在线更新快照可被中间人篡改——
        // manifest 必须带 sha256 才能应用（空值拒绝），下载按声明大小限流。
        val expectedSha = manifest.getString("sha256")
        val declaredSize = manifest.optLong("size", 0)

        onStatus(UpdateStatus(UpdateOutcome.Working, "下载快照（" + (declaredSize / 1024 / 1024) + " MB）…"))
        download(url, archive, declaredSize)

        onStatus(UpdateStatus(UpdateOutcome.Working, "校验…"))
        val actual = sha256(archive)
        if (!actual.equals(expectedSha, ignoreCase = true)) {
          throw IllegalStateException("SHA256 不匹配: " + actual.take(12) + "…")
        }

        onStatus(UpdateStatus(UpdateOutcome.Working, "解压新快照…"))
        val priorFingerprint = File(context.filesDir, ".snapshot-fingerprint")
          .takeIf { it.exists() }?.readText()?.trim().orEmpty()
        if (!priorFingerprint.matches(Regex("[0-9a-fA-F]{64}"))) {
          throw IllegalStateException("当前运行时缺少可验证的回退指纹，拒绝在线更新")
        }
        val baseFingerprint = PluginMounts.embeddedFingerprint(context)
          ?: throw IllegalStateException("当前安装缺少可信的内嵌插件身份，拒绝在线更新")
        val startedAt = System.currentTimeMillis()
        SnapshotTransaction.writeMarker(
          context.filesDir,
          SnapshotTransaction.Marker(
            SnapshotTransaction.Phase.STAGED,
            expectedSha,
            startedAt,
            purpose = SnapshotTransaction.Purpose.ONLINE_UPDATE,
            priorFingerprint = priorFingerprint,
            baseFingerprint = baseFingerprint,
          ),
        )
        transactionStarted = true
        SnapshotExtractor.extract(
          archive.inputStream(), declaredSize, stage, { _, _ -> }, runtimeRoot = context.filesDir,
        )
        val newUsr = File(stage, "usr")
        if (!SnapshotFs.exists(File(newUsr, "bin/node"))) throw IllegalStateException("新快照缺少 node")
        if (PluginMounts.prepareOnlineHardManifest(context, stage, expectedSha, baseFingerprint) == null) {
          throw IllegalStateException("新快照缺少可验证的插件身份，拒绝在线更新")
        }
        if (!File(context.filesDir, "usr/bin/node").isFile) throw IllegalStateException("当前运行时缺少 node，拒绝在线替换")

        onStatus(UpdateStatus(UpdateOutcome.Working, "切换运行时…"))
        // Stop only an engine child held by this app process; never broad-match a listener by argv.
        if (!manager.stopOwnedEngine()) {
          throw IllegalStateException("运行时更新已拒绝：" + EngineProbe.ENGINE_AUTHORITY + " 监听进程未归属到本壳，未停止外部进程")
        }
        SnapshotTransaction.swap(
          filesDir = context.filesDir,
          stagedRoot = stage,
          usrDir = File(context.filesDir, "usr"),
          homeDir = File(context.filesDir, "home"),
          preservedNames = SnapshotUserData.preservedNames.toSet(),
          fingerprint = expectedSha,
          startedAt = startedAt,
          purpose = SnapshotTransaction.Purpose.ONLINE_UPDATE,
          priorFingerprint = priorFingerprint,
          baseFingerprint = baseFingerprint,
        )
        probationStarted = true
        File(context.filesDir, ".update-pending").writeText("1")
        File(context.filesDir, ".update-pending-at").writeText(System.currentTimeMillis().toString())
        onStatus(UpdateStatus(UpdateOutcome.Verifying, "运行时已切换，正在等待启动与健康验证…"))
        val settlement = awaitOnlineSettlement(expectedSha, baseFingerprint, priorFingerprint)
        probationStarted = SnapshotTransaction.readMarker(context.filesDir) != null ||
          File(context.filesDir, ".update-pending").exists()
        onStatus(settlement)
      } catch (t: Throwable) {
        if (transactionStarted) {
          val recovered = try { EngineManager(context).abortOnlineUpdate() } catch (rollback: Throwable) {
            t.addSuppressed(rollback)
            false
          }
          if (!recovered) Log.e("dsh-update", "online update rollback incomplete; transaction journal and recovery source retained")
          probationStarted = !recovered
        }
        // 失败文案也要能读懂：异常自带的内部措辞（HTTP 码、Java 类名）不上屏，只进日志。
        Log.w("dsh-update", "update failed: " + t.message)
        onStatus(UpdateStatus(UpdateOutcome.Failed, "更新失败：" + UpdateFailures.humanize(t)))
      } finally {
        // The archive is never a recovery source; the stage is retained only while its journal needs it.
        SnapshotFs.deletePath(archive)
        if (ownsTransactionStage && SnapshotTransaction.readMarker(context.filesDir) == null) SnapshotFs.deletePath(stage)
        if (!probationStarted) EngineManager.onlineUpdateActive.set(false)
        OnlineUpdateGate.end()
      }
    }.start()
  }

  /**
   * 更新失败 → **用户可读**的原因（0.14.1 批 2 §4.1：机器码/内部标识一律不上屏）。
   *
   * 每条都必须说清「发生了什么 + 你现在能做什么」，且不得出现 Java 类名、URI、内部字段名。
   * 无法归类时如实说「未完成」并指向日志——不编造原因，也不把内部错误串直接倒给用户。
   * 纯函数（不碰 context / 网络），可直接 JVM 单测。
   */
  internal object UpdateFailures {
    fun humanize(t: Throwable): String {
      val m = (t.message ?: "").trim()
      val code = Regex("HTTP (\\d{3})").find(m)?.groupValues?.get(1)
      return when {
        m.startsWith("manifest HTTP") ->
          "暂时无法连接更新服务（服务返回 $code）——可能是发布源已下线或网络被拦截，请稍后再试"
        m.startsWith("下载 HTTP") ->
          "下载被中断（服务返回 $code）——请重试；多次失败可换网络后再试"
        m.startsWith("下载体积超限") ->
          "下载到的文件体积异常（与声明的体积不符）——已丢弃，请重试"
        m.startsWith("SHA256 不匹配") ->
          "下载到的文件校验不通过（内容与发布方声明不一致）——已删除，请重试"
        m.startsWith("新快照缺少") ->
          "新版本运行时包不完整（缺少关键组件）——本次更新已放弃，当前版本不受影响"
        m.startsWith("切换失败") ->
          "运行时切换失败，已自动回退到原版本——可稍后重试，或打开控制台查看日志"
        isNetworkError(t) ->
          "网络不可达——请检查网络后重试"
        else ->
          "更新未完成（详细原因已写入日志）——可重试，或复制日志反馈"
      }
    }

    /** 连接类异常（含 DNS 解析失败 / 连接被拒 / 超时）：文案统一成「网络不可达 + 下一步」。 */
    fun isNetworkError(t: Throwable): Boolean {
      val name = t.javaClass.name
      return name.contains("UnknownHost") || name.contains("Connect") ||
        name.contains("SocketTimeout") || name.contains("NoRouteToHost")
    }
  }

  private fun awaitOnlineSettlement(expectedFingerprint: String, baseFingerprint: String, priorFingerprint: String): UpdateStatus {
    val deadline = System.currentTimeMillis() + EngineManager.UPDATE_ROLLBACK_MS + UPDATE_SETTLEMENT_GRACE_MS
    while (System.currentTimeMillis() < deadline) {
      val markerPresent = SnapshotTransaction.readMarker(context.filesDir) != null
      val pendingPresent = File(context.filesDir, ".update-pending").exists()
      val liveFingerprint = File(context.filesDir, ".snapshot-fingerprint")
        .takeIf { it.isFile }?.let { runCatching { it.readText().trim() }.getOrNull() }.orEmpty()
      val onlineIdentity = readOnlineIdentity(File(context.filesDir, ".online-snapshot"))
      when (OnlineSettlement.classify(
        markerPresent, pendingPresent, liveFingerprint, onlineIdentity.first, onlineIdentity.second,
        expectedFingerprint, baseFingerprint, priorFingerprint,
      )) {
        OnlineSettlement.State.COMMITTED -> return UpdateStatus(UpdateOutcome.Done, "更新已通过启动与健康验证")
        OnlineSettlement.State.ROLLED_BACK -> return UpdateStatus(UpdateOutcome.Failed, "新版本未通过健康验证，已自动回退到原版本；用户数据已保留")
        OnlineSettlement.State.INCONSISTENT -> return UpdateStatus(UpdateOutcome.Failed, "更新状态无法确认；恢复现场已保留，请打开控制台检查日志")
        OnlineSettlement.State.PENDING -> Unit
      }
      try { Thread.sleep(UPDATE_SETTLEMENT_POLL_MS) } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return UpdateStatus(UpdateOutcome.Failed, "健康验证等待已中断；恢复现场已保留，请重新启动应用完成恢复")
      }
    }
    return UpdateStatus(UpdateOutcome.Failed, "启动与健康验证超时；恢复现场已保留，请重新启动应用并查看控制台日志")
  }

  private fun readOnlineIdentity(file: File): Pair<String, String> {
    if (!file.isFile) return "" to ""
    return try {
      val values = file.readLines().mapNotNull { line ->
        val split = line.indexOf('=')
        if (split <= 0) null else line.substring(0, split) to line.substring(split + 1)
      }
      val map = values.toMap()
      if (values.size != 2 || map.size != 2 || map.keys != setOf("base", "archive")) "" to ""
      else map["base"].orEmpty() to map["archive"].orEmpty()
    } catch (_: Throwable) { "" to "" }
  }

  internal object OnlineSettlement {
    enum class State { PENDING, COMMITTED, ROLLED_BACK, INCONSISTENT }

    fun classify(
      markerPresent: Boolean, pendingPresent: Boolean, liveFingerprint: String,
      onlineBase: String, onlineArchive: String, expectedFingerprint: String,
      baseFingerprint: String, priorFingerprint: String,
    ): State {
      if (markerPresent || pendingPresent) return State.PENDING
      if (liveFingerprint.equals(expectedFingerprint, true) &&
        onlineBase.equals(baseFingerprint, true) && onlineArchive.equals(expectedFingerprint, true)) return State.COMMITTED
      if (priorFingerprint.isNotBlank() && !priorFingerprint.equals(expectedFingerprint, true) &&
        liveFingerprint.equals(priorFingerprint, true)) return State.ROLLED_BACK
      return State.INCONSISTENT
    }
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
    private const val UPDATE_SETTLEMENT_POLL_MS = 1_000L
    private const val UPDATE_SETTLEMENT_GRACE_MS = 45_000L

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
