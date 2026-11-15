package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * 应用级 root 授权面（2026-09-30 主人定例：「这个开关应该调用一下 root 弹窗，并且检测 root
 * 是否授权，如果没有，请写好引导去 Root 管理器，授予 root」）。
 *
 * ── 与 [RootGrant] / [ShizukuTransport] 的分工（三层，别混）────────────────────
 *  1. **本对象** = 应用自身有没有 root 的事实面：`su -c id` 取一次真实身份（uid 0 与否）。
 *  2. [RootGrant] = 「AI root 权限」开关位与免责确认（策略门 + 知情同意门）。
 *  3. [ShizukuTransport] = 特权执行通道；其身份（uid 0 / 2000）决定通道是不是 root。
 *
 * ── ★授权框的现实（2026-09-30 主人指正，别再假设统一行为）────────────────────
 * **多数 Root 管理器（KernelSU / SukiSU 等）不再自动弹授权框** —— 除 Magisk 外，用户得
 * 自己打开管理器授予 ✗。所以：
 *  - 不承诺"点一下就会弹窗"（旧注释与旧文案这么写，是把管理器行为当成了统一的 ✗）；
 *  - **不做「打开 Root 管理器」入口**：各家管理器包名/入口不一（还可能根本没管理器 App，
 *    如部分 ROM 内置 su），打开不保证成功；而"能刷 root 的人自己会开管理器"（主人原话口径）⇒
 *    只做**诚实引导**（识别到管理器就报它的名字，识别不到就说"你使用的 Root 管理器"）✓。
 *  - 因此状态读面 `state()` 是**纯读**（读缓存 + su 是否存在），永不触发任何管理器交互；
 *    `requestGrant()` 只在用户显式点按钮时跑一次 `su -c id`（成功即证明已授权 ✓，
 *    失败/超时如实回报，绝不猜）✓。
 *
 * ── su 调用纪律 ──────────────────────────────────────────────────────────────
 *  - 后台线程执行 + 有界超时（[REQUEST_TIMEOUT_MS]，给用户在管理器上操作的时间）；
 *  - 超时即 `destroyForcibly()`，不留挂死进程；
 *  - 判据是输出里的 `uid=0`（`su -c id` 的真实身份），不是退出码（各家 su 退出码语义不一）；
 *  - 任何异常都不抛出，一律落成结构化状态（fail-closed：未知就是未知）。
 */
object RootAccess {

  /** su 候选路径（按常见顺序；不限于 root 管理器自带的那份）。 */
  private val SU_PATHS = listOf(
    "/system/bin/su",
    "/system/xbin/su",
    "/sbin/su",
    "/data/adb/ksu/bin/su",
    "/data/adb/magisk/su",
    "/debug_ramdisk/su",
  )

  /** Root 管理器包名 → 显示名（顺序即识别优先级）。 */
  private val MANAGERS = listOf(
    "me.weishu.kernelsu" to "KernelSU",
    "com.topjohnwu.magisk" to "Magisk",
    "me.bmax.apatch" to "APatch",
  )

  /** 授权请求的总预算：要留出用户在弹窗上点「允许」的时间（KernelSU 默认弹窗本身约 30s）。 */
  private const val REQUEST_TIMEOUT_MS = 25_000L

  private const val PREFS = "dsh_root_access"
  private const val KEY_STATE = "state"
  private const val KEY_UID = "uid"

  private val lock = Any()
  @Volatile private var requesting = false
  /** 内存态；进程重启后由 prefs 回填（见 [cachedState]）。 */
  @Volatile private var memState: String? = null

  /** 状态取值（互斥，全部如实；未知不用默认值冒充）。 */
  const val STATE_UNKNOWN = "unknown"     // 从未请求过（或本机无 su）
  const val STATE_REQUESTING = "requesting" // 弹窗已弹出，等用户在管理器上确认
  const val STATE_GRANTED = "granted"     // 已授权（uid 0）
  const val STATE_DENIED = "denied"       // 用户在弹窗上拒绝 / su 明确失败
  const val STATE_TIMEOUT = "timeout"     // 弹窗无响应（用户没点）
  const val STATE_NO_SU = "no-su"         // 本机没有可执行的 su（未 root 或未装管理器）

  /** 找到可执行的 su 路径；没有则 null（纯读，不触发任何弹窗）。 */
  fun suPath(): String? = SU_PATHS.firstOrNull { runCatching { File(it).canExecute() }.getOrDefault(false) }

  /** 本机是否装了已知的 Root 管理器（纯读）。 */
  fun manager(context: Context): Pair<String, String>? {
    val pm = context.packageManager
    return MANAGERS.firstOrNull { (pkg, _) ->
      runCatching { pm.getPackageInfo(pkg, 0); true }.getOrDefault(false)
    }
  }

  /** 缓存的授权状态（内存优先；无则读 prefs；都没有 = 未检测）。 */
  private fun cachedState(context: Context): Pair<String, Int> {
    memState?.let { return it to uidValue(context) }
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val s = prefs.getString(KEY_STATE, STATE_UNKNOWN) ?: STATE_UNKNOWN
    memState = s
    return s to prefs.getInt(KEY_UID, -1)
  }

  private fun uidValue(context: Context): Int =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_UID, -1)

  /** 当前是否已授权（供 [RootGrant] 的策略门消费；只认缓存，不触发弹窗）。 */
  fun isGranted(context: Context): Boolean {
    return cachedState(context).first == STATE_GRANTED
  }

  private fun writeState(context: Context, state: String, uid: Int) {
    memState = state
    runCatching {
      context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(KEY_STATE, state).putInt(KEY_UID, uid).apply()
    }
  }

  /**
   * 状态读面（**永不触发弹窗**）。字段：
   * `suExists` / `state` / `uid` / `granted` / `requesting` / `manager{package,label,installed}` / `guidance`。
   */
  fun state(context: Context, includeOwnership: Boolean = true): JSONObject {
    val su = suPath()
    val (state, uid) = cachedState(context)
    val effective = if (su == null && state != STATE_REQUESTING) STATE_NO_SU else state
    val mgr = manager(context)
    val out = JSONObject()
      .put("suExists", su != null)
      .put("suPath", su ?: "")
      .put("state", effective)
      .put("uid", if (effective == STATE_GRANTED) uid else -1)
      .put("granted", effective == STATE_GRANTED)
      .put("requesting", requesting)
    out.put(
      "manager",
      JSONObject()
        .put("package", mgr?.first ?: "")
        .put("label", mgr?.second ?: "")
        .put("installed", mgr != null),
    )
    out.put("guidance", guidance(effective, mgr?.second, UiText.isEnglish(context)))
    // 读面折进 ownership 会连带读租约并做启动判断；省掉这一层可让状态读面保持廉价。
    if (includeOwnership) out.put("ownership", RootOwnershipJobs.state(context))
    return out
  }

  /**
   * 每态都能说清「下一步做什么」（页面直接展示，不静默）。
   *
   * 口径（2026-09-30 主人指正）：**多数 Root 管理器（KernelSU / SukiSU 等）不再自动弹授权框**
   * ——除 Magisk 外，用户得自己打开管理器授予 ✗ ⇒ 引导语一律说「在你使用的 Root 管理器里允许本应用」，
   * **不承诺"点一下就会弹窗"** ✗（旧文案这么写，是把管理器行为当成了统一的 ✗）。
   * 管理器名只在**识别到时**作为提示带上（识别不到就说"你使用的 Root 管理器"，不猜 ✗）。
   */
  private fun guidance(state: String, managerLabel: String?, english: Boolean): String {
    val manager = managerLabel ?: if (english) "your root manager" else "你使用的 Root 管理器"
    return when (state) {
      STATE_GRANTED -> if (english) "Root access granted (uid 0)." else "已获得 root 授权（uid 0）。"
      STATE_REQUESTING -> if (english) {
        "Waiting for the root grant. If no dialog appeared, open $manager and allow this app."
      } else {
        "正在等待 root 授权结果——若管理器没有弹出授权框，请自己打开" + manager + "允许本应用。"
      }
      STATE_DENIED -> if (english) {
        "Root access was denied. Allow this app in $manager, then check again here."
      } else {
        "root 授权被拒绝——请在" + manager + "里允许本应用使用 root，然后回到本页重新检测。"
      }
      STATE_TIMEOUT -> if (english) {
        "The root request returned no result. Allow this app in $manager and retry."
      } else {
        "root 授权没有结果——请在" + manager + "里允许本应用后重试。"
      }
      STATE_NO_SU -> if (english) {
        "No usable su on this device (not rooted or no root manager). Set up root in $manager, then return here."
      } else {
        "本机没有可用的 su（未 root 或未安装 Root 管理器）——请先在" + manager + "中完成 root，再回到本页。"
      }
      else -> if (english) {
        "Not checked yet. Check root access tries once; most managers need you to allow this app yourself."
      } else {
        "尚未检测——点「检测 root 授权」会尝试取一次 root 身份（多数管理器不会自动弹授权框，需你在管理器里允许）。"
      }
    }
  }

  /**
   * 显式检测 root 授权：后台跑 `su -c id -u` 取真实 uid，立即返回；不保证管理器自动弹窗。
   *
   * 幂等：已有请求在飞时不重复起（否则用户会看到一堆弹窗）。
   * 结果（granted / denied / timeout）写回缓存，页面靠既有 2s 轮询看到。
   */
  fun requestGrant(context: Context): JSONObject {
    val app = context.applicationContext
    val su = suPath() ?: run {
      writeState(app, STATE_NO_SU, -1)
      return state(app).put("ok", false).put("code", "no-su")
    }
    synchronized(lock) {
      if (requesting) return state(app).put("ok", true).put("code", "already-requesting")
      requesting = true
    }
    writeState(app, STATE_REQUESTING, -1)
    Thread({
      var state = STATE_DENIED
      var uid = -1
      try {
        val process = ProcessBuilder(su, "-c", "/system/bin/id -u").redirectErrorStream(true).start()
        // **有界读取**（门禁 `check-bounded-io.mjs` 强制）：裸 `inputStream.readText()` 会读到 EOF
        // 才返回 ⇒ 超时形同虚设（用户在弹窗上不点、进程不退出时永久阻塞）；且「先 waitFor 再读」
        // 还会被子进程写满管道缓冲（~64KB）反卡。`ProcIo.readBounded` 同时给出三态
        // （exitTimedOut / drainTimedOut / truncated），「弹窗没响应」与「拒绝」得以分开。
        val result = ProcIo.readBounded(process, REQUEST_TIMEOUT_MS / 1000, 64 * 1024)
        state = when {
          !result.complete -> STATE_TIMEOUT
          !result.truncated && result.text.trim() == "0" -> {
            uid = 0
            STATE_GRANTED
          }
          else -> STATE_DENIED
        }
      } catch (t: Throwable) {
        state = STATE_DENIED
      } finally {
        writeState(app, state, uid)
        synchronized(lock) { requesting = false }
      }
    }, "dsh-root-request").start()
    return state(app).put("ok", true).put("code", "request-started")
  }

  // ── su 直连执行面（2026-09-30 主人定例：「我们不是做 root 适配吗」）──────────────────
  //
  // 为什么要有它：issue #262 的通道设计建立在 Shizuku 上（写 issue 的测试机 su 不可达），
  // 但**本机 su 是好的**（KernelSU）。让 root 能力只依赖 Shizuku，等于把「能不能用 root」
  // 押在另一个应用的授权与运行状态上——Shizuku 一旦未授权/未以 root 启动，整条链就死。
  // 这里给出直连 su 的执行与自愈面：应用自身获 Root 管理器授权即可用，不经过 Shizuku。

  /**
   * 以 root 执行一条命令（`su -c <command>`），捕获 stdout/stderr/退出码。
   *
   * 纪律：①要求**已授权**（未授权时 su 会弹窗——模型驱动的批量操作绝不能靠弹窗推进，
   * 如实回 `root-not-granted` 让页面引导用户去授权）；②有界超时；③超时即 `destroyForcibly`。
   *
   * 每个失败分支都带 `reason`（= code）：页面对 `ok:false` 只读 `reason` 翻人话
   * （`user-copy.ts` 的 CALL_REASON 唯一真源），只带 code 会落「未在本版登记」兜底。
   */
  fun execRoot(context: Context, command: String, timeoutMs: Int = 20_000,
    authorize: () -> Boolean = { true }): JSONObject =
    RootExecutionFence.command(context) {
      val app = context.applicationContext
      val lease = RootMaintenanceLease.beginOperation(app, "su-shell")
      lease.second?.let { return@command it }
      val operationId = lease.first
      val result = execPrivileged(app, command, timeoutMs, requireAiGrant = true, authorize = authorize)
      // C1/C2：拒绝集只收「进程确实没起来」的原因。su-exec-failed 覆盖了 start() 之后的读取异常，
      // 一律按结果不明处理（旧实现把它当零副作用并清租约，会抹掉已派发证据）。
      val refusedBeforeDispatch = !result.has("exitCode") && result.optString("code") in
        setOf("no-su", "root-not-granted", "requesting", "empty-command", "root-grant-required",
          "root-lease-evidence-unavailable", "authorize-denied")
      val acknowledged = suAcknowledgement(result)
      if (refusedBeforeDispatch || acknowledged) {
        if (RootMaintenanceLease.finish(app, operationId)) result
        else RootMaintenanceLease.markUnknown(app, "lease-clear-failed")
      } else RootMaintenanceLease.markUnknown(app, "su-command-settlement-unknown").put("noReplay", true)
    }

  /**
   * su 结果的结算判据（纯函数，JVM 可直测）。
   *
   * C2：只有「完整读取 + 非超时 + 无排水超时 + 无清理未完成 + 无读错误 + 退出码非负」才算已确认。
   * 退出码 -1 不能冒充确认——Shizuku 侧 executionDefinitive 早就是这条口径，此处补齐对称。
   */
  internal fun suAcknowledgement(result: JSONObject): Boolean =
    result.has("exitCode") && result.optInt("exitCode", -1) >= 0 &&
      !result.optBoolean("exitTimedOut") && !result.optBoolean("drainTimedOut") &&
      !result.optBoolean("cleanupIncomplete") && result.optString("readError").isEmpty() &&
      !result.optBoolean("truncated")

  // Only the fixed native ownership-maintenance operation may use this private primitive without AI consent.
  private fun execPrivileged(context: Context, command: String, timeoutMs: Int, requireAiGrant: Boolean,
    authorize: () -> Boolean = { true }): JSONObject {
    if (command.isBlank()) return fail("empty-command", "命令为空。")
    val su = suPath() ?: return fail("no-su", "本机没有可用的 su。")
    if (!isGranted(context)) {
      // 授权请求在飞时如实说「等待中」，不要报成「未授权」——那会让用户在弹窗还开着时看到莫名错误。
      return if (requesting) {
        fail("requesting", "root 授权检测进行中；若没有弹窗，请在你使用的 Root 管理器里允许本应用。")
      } else {
        fail("root-not-granted", "应用尚未获得 root 授权——请在你使用的 Root 管理器里允许本应用，再到设置页检测授权。")
      }
    }
    val timeout = timeoutMs.coerceIn(500, 600_000)
    return try {
      if (requireAiGrant && !RootGrant.isGranted(context)) {
        return fail("root-grant-required", "AI root 权限未开启或当前版本的免责确认已失效。")
      }
      // Keep the same merged-output convention as the Shizuku shell route, with a hard byte cap.
      // 派发证据（复审第 2、4 点）：只要此刻有维护租约在场，就把「已派发」写进租约 —— 外部 su 子进程
      // 是否随本进程一起死，本进程证明不了，所以此后不允许自动清算（只能用户显式清除）。
      // **证据落不了盘就不派发**：只置 unknown 却照样跑 su，会让后续 `dispatched=false` 变成
      // 「证据没落盘」的假象 ⇒ 有误清风险（与 begin() 的耐久性纪律同源）。
      if (RootMaintenanceLease.outstanding(context) != null &&
        !RootMaintenanceLease.markDispatched(context, "su")) {
        return fail("root-lease-evidence-unavailable",
          "无法把「已派发」证据落盘，本次不派发特权工作（避免以后误判为未派发）。")
      }
      // 上层只读快速授权检查：紧贴派发，之后立刻 start；拒绝即零副作用（未置 dispatched、
      // 未起进程），调用方按「确定没派发」结算租约。
      if (!safeAuthorize(authorize)) {
        return fail("authorize-denied", "本机当前授权已不成立，本次不派发 root 命令。")
      }
      val process = ProcessBuilder(su, "-c", command).redirectErrorStream(true).start()
      val output = ProcIo.readBoundedMillis(process, timeout.toLong())
      val exit = if (output.exitTimedOut) -1 else runCatching { process.exitValue() }.getOrDefault(-1)
      val code = if (output.timedOut) "su-timeout" else if (exit != 0) "su-command-failed" else ""
      JSONObject()
        .put("ok", output.complete && exit == 0)
        .put("transport", "su")
        .put("exitCode", exit)
        .put("stdout", output.text)
        .put("stderr", "")
        .put("exitTimedOut", output.exitTimedOut)
        .put("drainTimedOut", output.drainTimedOut)
        .put("truncated", output.truncated)
        .put("cleanupIncomplete", output.cleanupIncomplete)
        .put("readError", output.readError ?: "")
        .put("code", code)
        .put("reason", code)
        .put("error", if (output.timedOut) output.marker() else if (exit == 0) "" else "exit=$exit")
    } catch (t: Throwable) {
      // 异常只进日志，不上屏（页面文案一律来自 CALL_REASON 真源）。
      android.util.Log.w("dsh-root", "execRoot failed: " + t.javaClass.simpleName)
      // granted 缓存不能比 su 本体活得久：进程都拉不起来（二进制损坏/被移除/SELinux 拒绝 exec）
      // 说明「有 root 路」的前提已失效，立刻降级，否则启动自愈每次都按旧缓存误判并撞进隔离。
      runCatching { writeState(context.applicationContext, STATE_DENIED, -1) }
      fail("su-exec-failed", "root 命令执行失败——请稍后重试；多次失败可复制日志反馈。")
    }
  }


  /** 结构化失败（`ok:false` + `code` + `reason` 同码 + 人话 guidance）。 */
  private fun fail(code: String, guidance: String): JSONObject = JSONObject()
    .put("ok", false).put("code", code).put("reason", code).put("guidance", guidance)

  /** shell 单引号安全包裹（路径可能含空格/引号；命令由本文件拼，不接受调用方原始拼接）。 */
  private fun shq(raw: String): String = "'" + raw.replace("'", "'\\''") + "'"

  /**
   * authorize 的求值纪律：回调抛异常按「不授权」处理，绝不因为上层检查出错而放行特权派发。
   */
  internal fun safeAuthorize(authorize: () -> Boolean): Boolean = try {
    authorize()
  } catch (_: Throwable) {
    false
  }

  /** Fixed signed-APK ownership maintenance; this private transport exception is not a model shell. */
  fun repairOwnership(context: Context, path: String, maxEntries: Int = 20_000,
    timeoutMs: Long = OwnershipRepair.DEFAULT_TIMEOUT_MS): JSONObject = RootExecutionFence.maintenance(context) {
      repairOwned(context, path, maxEntries, timeoutMs)
    }

  private fun repairOwned(context: Context, path: String, maxEntries: Int, timeoutMs: Long): JSONObject {
    val app = context.applicationContext
    if (!isGranted(app)) return fail("root-not-granted", "应用尚未获得 root 授权，无法修复属主。")
    val uid = app.applicationInfo.uid
    val dataDir = app.applicationInfo.dataDir
    if (!OwnershipRepair.isTrustedAppDataAnchor(dataDir, uid)) return fail("invalid-app-data-anchor", "应用数据目录无法确认。")
    val relative = when {
      path == dataDir -> ""
      path.startsWith(dataDir + "/") -> path.substring(dataDir.length + 1)
      path.startsWith('/') -> return fail("out-of-app-data", "仅允许修复本应用数据目录。")
      else -> path
    }
    val cap = maxEntries.coerceIn(1, OwnershipRepairCore.MAX_ENTRIES)
    val budget = timeoutMs.coerceIn(1, OwnershipRepairCore.MAX_TIMEOUT_MS)
    val args = arrayOf(uid.toString(), dataDir, relative, cap.toString(), budget.toString())
    if (RootRepairMain.parse(args) == null) return fail("invalid-repair-arguments", "属主修复参数不合法。")
    // The system-provided installed APK path is never replaced by a writable snapshot dex/JAR.
    val apk = app.applicationInfo.sourceDir
    if (apk.isNullOrBlank() || !File(apk).isFile) return fail("installed-apk-unavailable", "无法读取已安装的应用代码。")
    val command = "CLASSPATH=" + shq(apk) + " /system/bin/app_process /system/bin " +
      "com.dsharnessmobile.shell.RootRepairMain " + args.joinToString(" ") { shq(it) }
    val lease = RootMaintenanceLease.beginOperation(app, "su-ownership")
    lease.second?.let { return it }
    val operationId = lease.first
    val transport = execPrivileged(app, command, budget.toInt(), requireAiGrant = false)
    // 与 execRoot 同一条口径：su-exec-failed 不在「确定没派发」集合里，只能按结果不明处理。
    if (!transport.has("exitCode") && transport.optString("code") in
      setOf("no-su", "root-not-granted", "requesting", "empty-command", "root-lease-evidence-unavailable")) {
      return if (RootMaintenanceLease.finish(app, operationId)) transport
      else RootMaintenanceLease.markUnknown(app, "lease-clear-failed")
    }
    if (transport.optBoolean("exitTimedOut") || transport.optBoolean("drainTimedOut") || transport.optBoolean("truncated") ||
      transport.optBoolean("cleanupIncomplete") || transport.optString("readError").isNotEmpty()) {
      return RootMaintenanceLease.markUnknown(app, "repair-transport-incomplete").put("transport", "su")
    }
    val parsed = runCatching {
      val text = transport.optString("stdout").trim()
      if (!text.startsWith('{') || !text.endsWith('}')) throw IllegalArgumentException("non-json-helper-output")
      JSONObject(text)
    }.getOrNull() ?: return RootMaintenanceLease.markUnknown(app, "repair-helper-output-invalid").put("transport", "su")
    // An acknowledged helper result (even a rejected/partial repair) proves it has completed its fixed work.
    val completeEnvelope = parsed.opt("ok") is Boolean &&
      listOf("checked", "healed", "failures", "unverifiedMutations").all { key ->
        parsed.opt(key) is Int && parsed.optInt(key, -1) >= 0
      } && parsed.opt("remaining") is Int && parsed.optInt("remaining", -2) in setOf(-1, 0) &&
      parsed.opt("truncated") is Boolean && parsed.opt("deadlineExceeded") is Boolean &&
      transport.optInt("exitCode", -1) in setOf(0, 2)
    if (!completeEnvelope) return RootMaintenanceLease.markUnknown(app, "repair-helper-envelope-incomplete").put("transport", "su")
    if (!RootMaintenanceLease.finish(app, operationId))
      return RootMaintenanceLease.markUnknown(app, "lease-clear-failed").put("transport", "su")
    val verified = transport.optInt("exitCode", -1) == 0 && parsed.optBoolean("ok") &&
      parsed.has("checked") && parsed.has("healed") && parsed.optInt("failures", -1) == 0 &&
      parsed.optInt("unverifiedMutations", -1) == 0 && parsed.optInt("remaining", -1) == 0 &&
      !parsed.optBoolean("truncated") && !parsed.optBoolean("deadlineExceeded")
    return parsed.put("ok", verified).put("transport", "su").put("operationId", operationId ?: "").apply {
      if (!verified && optString("reason").isBlank()) {
        put("reason", "repair-incomplete").put("code", "repair-incomplete").put("remaining", -1)
      }
    }
  }
}
