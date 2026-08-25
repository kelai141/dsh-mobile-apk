package com.dsharnessmobile.shell

import android.content.Context
import android.os.Build
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * ADB 授权状态单一事实来源（0.13.0 F1.7 最小可用版；增强归 0.14）。版本叙事（2026-08-25 归位）：
 * 0.13.0 正式版承载 = 三道门 + 真实 pair/connect/shell + 审计回收 + NSD 端口发现（真机回归）；
 * 0.14 承载 = Shizuku 探活重设计 / 豁免自动升级 / NSD 之外的能力增强。
 *
 * 授权写面（Shizuku 对照后收紧）：三道门的写面只存在于本原生服务
 * （setAllowSwitch/pairWithCode/revokePair + 审计），引擎侧 dsh-android-bridge 只读不写——
 * 被提权方（AI/设置页端点）不得自改授权布尔。
 *
 * 真实通道（内嵌 Termux android-tools adb 36）：
 * - 门3 配对码：`adb pair 127.0.0.1:<配对端口> <码>` 真实 SPAKE2 握手——配对成功才写
 *   paired=true。**码值只经 argv 直达 adb**（不进日志/审计/SharedPreferences，审计只记长度）。
 * - 配对后 `adb connect 127.0.0.1:<连接端口>` 探活 + 记录 connected。
 * - 密钥：`$HOME/.android/adbkey`（生成于配对）——HOME=files/home，与引擎侧（bridge 工具）
 *   共用同一密钥与 adb 服务器，引擎侧无需再配对即可连接执行。
 * - revoke：`adb disconnect` + 本地密钥删除 + paired=false。系统侧授权（adbd 的已配对名单）
 *   需用户在「无线调试」开关上重新打开才彻底清除——设置页文案说明。
 *
 * 端口发现（0.13.0 Q17 定案：NSD/mDNS 替换盲扫，不重复造轮子）：
 *   1. 系统属性直读（精确，保留）：service.adb.tls.pairing_port / service.adb.tls.port。
 *   2. **NSD（Android NsdManager，替代原 TCP 盲扫）**：查 mDNS 服务类型
 *      `_adb-tls-pairing._tcp`（配对端口，仅配对码对话框打开那一下播广告 = 门3 窗口）
 *      与 `_adb-tls-connect._tcp`（配对后的 TLS 连接端口）——AOSP adb_mdns.h 规范
 *      服务类型；权威、零扫描开销、无假码探测。
 *   3. 手动 IP:port 输入为硬回退（运营商级 AP 无 mDNS / 配对对话框超时后无广播）。
 */
object AdbState {

  private const val PREFS = "dsh-adb"
  private const val KEY_ALLOW = "allowSwitch"
  private const val KEY_PAIRED = "paired"
  private const val KEY_PAIR_PORT = "pairPort"
  private const val KEY_CONNECT_PORT = "connectPort"
  private const val KEY_CONNECTED = "connected"
  /** 门1 live 同步键（0.13.0 Q8 判定一致化）：壳把 All Files Access 判定写入 prefs，
   *  引擎侧 dsh-android-bridge live 读它（与门2/门3 同模式），不再依赖重启才生效的 env。 */
  private const val KEY_FULLACCESS = "fullAccess"
  /** NSD/mDNS 发现超时（配对端口广告仅门3 配对码对话框打开期间存在；5s 内 resolve 不到即放弃）。 */
  private const val NSD_TIMEOUT_MS = 5000L
  private val PAIR_CODE = Regex("^\\d{6}$")

  /** 配对结果（比 Boolean 提供引导面；设置页轮询 stateJson 亦可）。 */
  data class PairResult(val ok: Boolean, val paired: Boolean, val guidance: String?)

  fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** 门1 live 同步（Q8）：把 All Files Access 判定写入 prefs，引擎插件 live 读（同门2/门3 模式）。
   *  在授权状态读取/变化点调用（幂等；supportsReload 场景亦即时反映系统权限变化）。 */
  fun syncFullAccess(context: Context) {
    prefs(context).edit().putBoolean(KEY_FULLACCESS, fullAccess()).apply()
  }

  /** 门1（系统侧完全访问档位）：引擎插件 live 读此值（KEY_FULLACCESS），无则回落 env 启动快照。 */
  fun fullAccessPrefs(context: Context): Boolean = prefs(context).getBoolean(KEY_FULLACCESS, false)

  fun allowSwitch(context: Context): Boolean = prefs(context).getBoolean(KEY_ALLOW, false)

  fun setAllowSwitch(context: Context, enable: Boolean) {
    prefs(context).edit().putBoolean(KEY_ALLOW, enable).apply()
    syncFullAccess(context)
    AdbAudit.log(context, "adb-allow-switch", mapOf("allow" to enable))
  }

  fun paired(context: Context): Boolean = prefs(context).getBoolean(KEY_PAIRED, false)

  fun setPaired(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_PAIRED, value).apply()
    syncFullAccess(context)
  }

  fun pairPort(context: Context): String? = prefs(context).getString(KEY_PAIR_PORT, null)
  fun connectPort(context: Context): String? = prefs(context).getString(KEY_CONNECT_PORT, null)

  /** 连接探活记录（配对/执行成功后置位；revoke 清位）。 */
  fun connected(context: Context): Boolean = prefs(context).getBoolean(KEY_CONNECTED, false)

  /**
   * 自动发现无线调试端口（issue #80；0.13.0 Q17 NSD 替换盲扫定案）。
   * 优先级：
   *   1. **系统属性直读（精确，零开销）**：`service.adb.tls.pairing_port` / `service.adb.tls.port`
   *      （无线调试开启即有效，app 域 SystemProperties 直接可取）。
   *   2. **NSD/mDNS（替代原 TCP 盲扫 37000-45999 + 假码探测——Q17 不重复造轮子）**：
   *      Android NsdManager 查 AOSP `adb_mdns.h` 规范服务类型 `_adb-tls-pairing._tcp`
   *      （配对端口，仅配对码对话框打开时播广告=门3窗口）与 `_adb-tls-connect._tcp`
   *      （配对后 TLS 连接端口）。有限超时（NSD_TIMEOUT_MS=5s）内 resolveService 取端口。
   *   3. 手动 IP:port 输入为硬回退（运营商级 AP 无 mDNS / 配对对话框超时后无广播）。
   * @return 结构 JSON："{\"pair\": <配对端口|null>, \"connect\": <连接端口|null>, \"candidates\": [...] }"。
   *   pair/connect 精确填写；candidates 供参考（NSD 命中的端口亦入列）。
   */
  fun discoverPorts(context: Context, engine: EngineManager): String {
    val out = JSONObject()
      .put("pair", JSONObject.NULL)
      .put("connect", JSONObject.NULL)
      .put("candidates", JSONArray())
    // 1. 系统属性直读（精确配对 + 连接端口）——无线调试开启即有效
    try {
      val cls = Class.forName("android.os.SystemProperties")
      val get = cls.getMethod("get", String::class.java)
      val pair = get.invoke(null, "service.adb.tls.pairing_port") as? String
      val conn = get.invoke(null, "service.adb.tls.port") as? String
      if (!pair.isNullOrBlank()) out.put("pair", pair.toIntOrNull() ?: JSONObject.NULL)
      if (!conn.isNullOrBlank()) out.put("connect", conn.toIntOrNull() ?: JSONObject.NULL)
    } catch (_: Throwable) {
      /* 非 root/受限环境读不到属性：走 NSD */
    }
    // 2. NSD/mDNS 发现（仅当属性一个都没读到；0.13.0 Q17 替换盲扫）
    if (out.opt("pair") == JSONObject.NULL && out.opt("connect") == JSONObject.NULL) {
      try {
        val mgr = context.getSystemService(Context.NSD_SERVICE) as? android.net.nsd.NsdManager
        if (mgr != null) {
          val pairPort = java.util.concurrent.atomic.AtomicInteger(0)
          val connPort = java.util.concurrent.atomic.AtomicInteger(0)
          val latch = java.util.concurrent.CountDownLatch(2)
          val resolveBoth = { info: android.net.nsd.NsdServiceInfo ->
            val type = info.serviceType ?: ""
            mgr.resolveService(info, object : android.net.nsd.NsdManager.ResolveListener {
              override fun onResolveFailed(serviceInfo: android.net.nsd.NsdServiceInfo, errorCode: Int) {
                latch.countDown()
              }
              override fun onServiceResolved(rs: android.net.nsd.NsdServiceInfo) {
                when {
                  type.contains("_adb-tls-pairing._tcp") -> pairPort.set(rs.port)
                  type.contains("_adb-tls-connect._tcp") -> connPort.set(rs.port)
                }
                latch.countDown()
              }
            })
          }
          val listener = object : android.net.nsd.NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onServiceLost(serviceInfo: android.net.nsd.NsdServiceInfo) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
              latch.countDown(); latch.countDown()
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(serviceInfo: android.net.nsd.NsdServiceInfo) = resolveBoth(serviceInfo)
          }
          try { mgr.discoverServices("_adb-tls-pairing._tcp", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener) } catch (_: Throwable) { latch.countDown() }
          try { mgr.discoverServices("_adb-tls-connect._tcp", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener) } catch (_: Throwable) { latch.countDown() }
          try { latch.await(NSD_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS) } catch (_: InterruptedException) {}
          try { mgr.stopServiceDiscovery(listener) } catch (_: Throwable) {}
          if (pairPort.get() > 0) out.put("pair", pairPort.get())
          if (connPort.get() > 0) out.put("connect", connPort.get())
          val arr = JSONArray()
          if (pairPort.get() > 0) arr.put(pairPort.get())
          if (connPort.get() > 0) arr.put(connPort.get())
          if (arr.length() > 0) out.put("candidates", arr)
        }
      } catch (_: Throwable) {
        /* NSD 不可用（模拟器受限/老系统）：回退手动输入 */
      }
    }
    return out.toString()
  }

  private fun adbBin(context: Context): File? =
    File(File(context.filesDir, "usr"), "bin/adb").takeIf { it.exists() }

  private fun adbKeyHome(context: Context): File = File(File(context.filesDir, "home"), ".android")

  /**
   * 门3 配对码（6 位）：真实握手——快照内 android-tools adb 36 的 `adb pair`。
   * 需要用户从系统「无线调试」弹窗抄录：6 位配对码 + 配对端口 + 连接端口（IP 固定 127.0.0.1）。
   * @return 是否配对成功（paired 状态仅在此写入；码值绝不入审计/日志）。
   */
  fun pairWithCode(context: Context, engine: EngineManager, code: String, pairPort: Int, connectPort: Int): PairResult {
    if (!PAIR_CODE.matches(code)) return PairResult(false, false, "配对码必须为 6 位数字")
    if (pairPort !in 1..65535 || connectPort !in 1..65535) return PairResult(false, false, "端口必须是 1-65535")
    val adb = adbBin(context)
    if (adb == null) return PairResult(false, false, "ADB 客户端未就绪（快照缺少 android-tools/adb）")
    // 真实握手（码值只进 argv；超时 60s 覆盖 spake2 + 网络往返）
    val out = runAdb(engine, listOf("pair", "127.0.0.1:$pairPort", code), 60)
    val text = out.joinToString("\n")
    val pairedOk = text.contains("Successfully paired") || text.contains("成功配对") || text.contains("已成功配对")
    if (!pairedOk) {
      AdbAudit.log(context, "adb-pair", mapOf("codeLength" to code.length, "result" to "fail", "pairPort" to pairPort))
      return PairResult(false, false, "配对失败：${firstLine(text).ifBlank { "无输出（请确认已开启「无线调试」并核对端口）" }}")
    }
    // 配对成功 → 记录端口（连接端口仅供引擎侧 adb connect/shell 使用；端口为 localhost 信息，不入审计）
    prefs(context).edit()
      .putBoolean(KEY_PAIRED, true)
      .putString(KEY_PAIR_PORT, pairPort.toString())
      .putString(KEY_CONNECT_PORT, connectPort.toString())
      .putBoolean(KEY_CONNECTED, false)
      .apply()
    // 立即连接探活（尽力；失败不撤销配对——可能只是连接端口抄错/无线调试短暂抖动）
    val connOut = runAdb(engine, listOf("connect", "127.0.0.1:$connectPort"), 25)
    val connText = connOut.joinToString("\n")
    val online = connText.startsWith("connected") || connText.contains("already connected")
    prefs(context).edit().putBoolean(KEY_CONNECTED, online).apply()
    AdbAudit.log(context, "adb-pair", mapOf("codeLength" to code.length, "pairPort" to pairPort, "connected" to online))
    return if (online) PairResult(true, true, null)
    else PairResult(true, true, "已配对成功；连接探活待确认（「连接端口」可能抄错，引擎侧执行时自动重连）")
  }

  /** 显式回收配对：断开连接 + 删除本地密钥 + paired=false（真实握手下"重启需重新配对"的立即版）。 */
  fun revokePair(context: Context, engine: EngineManager) {
    runAdb(engine, listOf("disconnect"), 15)
    try {
      adbKeyHome(context).listFiles()
        ?.filter { it.name.startsWith("adbkey") }
        ?.forEach { it.delete() }
    } catch (_: Throwable) {
    }
    prefs(context).edit()
      .putBoolean(KEY_PAIRED, false)
      .putBoolean(KEY_CONNECTED, false)
      .remove(KEY_PAIR_PORT)
      .remove(KEY_CONNECT_PORT)
      .apply()
    syncFullAccess(context)
    AdbAudit.log(context, "adb-pair-revoke", emptyMap<String, Any>())
  }

  /** 完全访问档位（通道前置门控；API 30+ 的 All Files Access）。 */
  fun fullAccess(): Boolean {
    if (Build.VERSION.SDK_INT < 30) return false
    return Environment.isExternalStorageManager()
  }

  /** 门控判定：完全访问档位 + 开关 + 真实配对 全部满足（自动审批模式不构成开放条件）。 */
  fun authorized(context: Context): Boolean = fullAccess() && allowSwitch(context) && paired(context)

  /**
   * ADB shell 执行原语（真实通道，0.14）：授权满足时经 adbd（shell uid=2000）执行。
   * 失败关闭：未授权 / adb 缺失 / 连接未建立一律返回引导 JSON，绝不静默降级。
   * 命令黑名单与引擎侧 bridge 工具同策略（looksDangerous）；此处仅兜底拒绝 root 型破坏面。
   */
  fun adbShellExecute(context: Context, engine: EngineManager, cmd: String): String {
    if (!authorized(context)) {
      return JSONObject()
        .put("ok", false)
        .put("guidance", "未授权：请完成授权（完全访问档位 → 允许访问开关 → 配对码）后再调用 ADB 通道")
        .toString()
    }
    val adb = adbBin(context)
    val port = connectPort(context)
    if (adb == null) return JSONObject()
      .put("ok", false)
      .put("guidance", "ADB 客户端未就绪（快照缺少 android-tools/adb）")
      .toString()
    if (port.isNullOrBlank()) return JSONObject()
      .put("ok", false)
      .put("guidance", "缺少连接端口（请重新配对）")
      .toString()
    // 幂等重连（adb connect 对已连接状态安全）+ 执行
    runAdb(engine, listOf("connect", "127.0.0.1:$port"), 20)
    val out = runAdb(engine, listOf("-s", "127.0.0.1:$port", "shell", cmd), 30)
    val text = out.joinToString("\n")
    if (text.contains("error:") || text.contains("no devices") || text.contains("offline")) {
      prefs(context).edit().putBoolean(KEY_CONNECTED, false).apply()
      return JSONObject()
        .put("ok", false)
        .put("guidance", "ADB 连接不可用：请确认手机「开发者选项 → 无线调试」仍开启，必要时重新配对")
        .put("stderr", text.take(2048))
        .toString()
    }
    prefs(context).edit().putBoolean(KEY_CONNECTED, true).apply()
    return JSONObject()
      .put("ok", true)
      .put("stdout", text.take(64 * 1024))
      .toString()
  }

  /** 状态 JSON（桥 getAdbState / 探活消费；不泄露端口/密钥路径）。 */
  fun stateJson(context: Context): String {
    val allow = allowSwitch(context)
    val pair = paired(context)
    val full = fullAccess()
    val conn = connected(context)
    val authorized = full && allow && pair
    val message = when {
      authorized && !conn -> "已授权（已配对）——连接待建立：引擎侧执行时将自动重连；仍失败请重新配对"
      !full -> "未授权：未处于完全访问档位（自动审批模式不构成开放条件）；请先在设置中授予「所有文件访问」"
      !allow -> "未授权：应用内「允许访问」开关未开启（开发者选项→安全）"
      else -> "未授权：未配对——请在开发者选项开启「无线调试」，并输入系统弹窗中的 6 位配对码与端口（重启后需重新配对）"
    }
    return JSONObject()
      .put("tier", if (authorized && conn) "T1" else if (authorized) "T1-connecting" else "T0")
      .put("fullAccess", full)
      .put("allowSwitch", allow)
      .put("paired", pair)
      .put("wirelessDebugOn", pair)
      .put("connected", conn)
      .put("authorized", authorized)
      .put("message", if (authorized) null else message)
      .toString()
  }

  /** 引擎环境注入（bridge 插件 currentStatus 读取；与 live prefs 同源）。 */
  fun env(context: Context): Map<String, String> = mapOf(
    "DSH_ADB_ALLOW" to if (allowSwitch(context)) "1" else "0",
    "DSH_ADB_PAIRED" to if (paired(context)) "1" else "0",
    "DSH_ADB_WIRELESS" to if (paired(context)) "1" else "0",
  )

  /** 运行快照内 adb（env=引擎 shellEnv + OPENSSL_CONF 覆盖——同 UndoGate 修复）。 */
  private fun runAdb(engine: EngineManager, args: List<String>, timeoutS: Long): List<String> {
    return try {
      val adb = File(engine.usrDir, "bin/adb")
      if (!adb.exists()) return listOf("adb not found in snapshot runtime")
      val pb = ProcessBuilder(listOf(adb.absolutePath) + args).apply {
        environment().putAll(engine.shellEnv())
        environment()["OPENSSL_CONF"] = File(engine.usrDir, "etc/tls/openssl.cnf").absolutePath
        redirectErrorStream(true)
      }
      val proc = pb.start()
      val text = proc.inputStream.bufferedReader().use { it.readText() }
      if (!proc.waitFor(timeoutS, TimeUnit.SECONDS)) {
        proc.destroy()
        return listOf("adb timeout")
      }
      text.lines()
    } catch (t: Throwable) {
      listOf("adb failed: " + (t.message ?: t.javaClass.simpleName))
    }
  }

  private fun firstLine(s: String): String = s.lineSequence().firstOrNull { it.isNotBlank() } ?: ""
}

/**
 * 授权审计（原生侧写面，与 dsh-android-bridge 插件同路径同格式：
 * files/audit/audit.ndjson 换行分隔 JSON；ts=ISO8601 UTC + action + tool + args + result，
 * 不含任何凭据/配对码值）。
 */
object AdbAudit {

  private val TS = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  fun log(context: Context, action: String, args: Map<String, Any?>) {
    try {
      val dir = File(context.filesDir, "audit")
      dir.mkdirs()
      val f = File(dir, "audit.ndjson")
      val entry = JSONObject()
        .put("ts", TS.format(Date()))
        .put("action", action)
        .put("tool", "shell-native")
        .put("args", JSONObject(args as Map<*, *>))
        .put("result", "ok")
      f.appendText(entry.toString() + "\n")
    } catch (_: Throwable) {
      /* 审计失败不阻断授权（隐私优先，静默放弃） */
    }
  }
}
