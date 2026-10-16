package com.dsharnessmobile.shell

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * App-side lifecycle owner for the Shizuku UserService.
 *
 * The manager application remains the only authority that can grant Shizuku permission. This class
 * may request its standard confirmation from an explicit user action but never treats the request
 * as a grant. WebView/engine code gets no raw binder and no arbitrary shell surface.
 */
object ShizukuTransport {
  private const val TAG = "dsh-shizuku"
  private const val REQUEST_CODE_VDISPLAY = 0xD514
  private const val USER_SERVICE_TAG = "dsh-mobile-vdisplay-v1"
  /** 单次 latch 等待片（保持既有 4s 语义：到点先复用/汇报，不无限阻塞调用方）。 */
  private const val BIND_TIMEOUT_MS = 4_000L
  /**
   * 首次绑定允许等待的**总预算**（0.14.0 设备实锤修正）。
   *
   * 缺陷形态：`ensureBound()` 只 await 一片 4s 就返回，而 `Shizuku.bindUserService` 在真机/模拟器上
   * 实测要 5s 量级才回调 `onServiceConnected`。于是**同一条命令第一次必然报「通道失败」、第二次必然成功**——
   * 那不是「Shizuku 抖动」，是状态机时序的确定结果。设备会话实录里 agent 因此判定特权通道不可靠、
   * 转投 Termux 通道，又撞上该通道的环境缺陷，两个缺陷串联把整条链路打崩。
   *
   * 现在在预算内循环等待：绑定完成即返回，超预算才如实汇报「正在建立」并给出可重试建议。
   */
  private const val BIND_TOTAL_MS = 15_000L

  /**
   * 绑定看门狗阈值（0.14.1 设备实锤，Redmi K70E）：一次绑定超过本阈值仍**既无回调也无同步异常**，
   * 就判定这次尝试已死并复位——否则 `binding` 永久为 true，`kickBind` 从此不再发起任何尝试，
   * UI 永久停在「正在建立」（本缺陷的形态）。详见 [ShizukuBindState] 的类注释。
   *
   * 取值依据：真机/模拟器实测回调耗时 ~5s（[BIND_TOTAL_MS] 的注释已录），阈值取 4 倍余量；
   * 且**大于**单次调用的总预算（15s），使第一次 `ensureBound` 能先正常用满自己的窗口、
   * 不会在半途被判定为僵尸（否则会与调用方语义打架）。该值未经多机型校准，调整只改这一处。
   */
  private const val BIND_WATCHDOG_MS = 20_000L

  /** 「正在建立」的结构化 code（可重试语义，与「未绑定需排查」区分）。 */
  private const val CONNECTING_CODE = ShizukuBindCodes.CONNECTING

  private val lock = Any()
  @Volatile private var service: ShizukuUserService? = null

  /**
   * 绑定状态机（绑定闩 / 次数 / 最近错误码 / 看门狗）。替代原先裸的 `@Volatile binding + lastError`：
   * 那对字段没有超时面，一次不回调的 bind 就能把整条通道永久闩死。
   */
  private val bindState = ShizukuBindState(BIND_WATCHDOG_MS)

  @Volatile private var connectedAt = 0L
  private var activeAttempt: BindAttempt? = null
  // SDK 13.1.5 在主线程遍历未同步的连接集合；注册、注销也必须走同一线程。
  private val connectionMain by lazy { Handler(Looper.getMainLooper()) }

  /** v3：本连接是否已把「应用 uid + 数据目录」回填给 UserService（按连接代次去重）。 */
  @Volatile private var configuredForAge = -1L

  private class BindAttempt(val userArgs: Shizuku.UserServiceArgs, val generation: Long) {
    val latch = CountDownLatch(1)
    val connection: ServiceConnection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        synchronized(lock) {
          if (activeAttempt !== this@BindAttempt) return
          val valid = runCatching { binder.pingBinder() }.getOrDefault(false)
          if (!bindState.onConnected(valid, generation)) return
          service = if (valid) ShizukuUserService.Stub.asInterface(binder) else null
          connectedAt = if (valid) SystemClock.elapsedRealtime() else 0L
          configuredForAge = -1L
          latch.countDown()
          if (!valid) {
            activeAttempt = null
            discardOnMain(userArgs, connection, remove = true)
          }
        }
        ControlCarrier.invalidateShizukuCache()
        Log.i(TAG, "user service callback " + name.className + " generation=" + generation)
      }

      override fun onServiceDisconnected(name: ComponentName) {
        synchronized(lock) {
          if (activeAttempt !== this@BindAttempt || !bindState.onDisconnected(generation)) return
          service = null
          connectedAt = 0L
          configuredForAge = -1L
          activeAttempt = null
          latch.countDown()
        }
        ControlCarrier.invalidateShizukuCache()
        Log.w(TAG, "user service disconnected " + name.className + " generation=" + generation)
      }
    }
  }

  /**
   * SDK 的 remove=true 只移除远端服务，不清应用内的连接缓存。必须先 remove=false 注销旧回调，
   * 再按需移除远端；否则旧服务的迟到 died 回调会清掉新绑定，页面重新陷入「建立中」。
   * 始终排队，避免在 SDK 正遍历回调集合时修改它；与后续 bind 按同一主线程 FIFO 排序。
   */
  private fun discardOnMain(userArgs: Shizuku.UserServiceArgs, connection: ServiceConnection?, remove: Boolean) {
    connectionMain.post {
      runCatching { Shizuku.unbindUserService(userArgs, connection, /* remove = */ false) }
        .onFailure { Log.w(TAG, "detach user service failed", it) }
      if (remove) {
        runCatching { Shizuku.unbindUserService(userArgs, connection, /* remove = */ true) }
          .onFailure { Log.w(TAG, "remove user service failed", it) }
      }
    }
  }

  private fun bindOnMain(attempt: BindAttempt) {
    connectionMain.post {
      if (synchronized(lock) { activeAttempt !== attempt || !bindState.binding }) return@post
      try {
        // 清 SDK 中上一代连接（包括同步 bind 抛错留下的记录），不能复用它的回调集合。
        Shizuku.unbindUserService(attempt.userArgs, attempt.connection, /* remove = */ false)
        Shizuku.bindUserService(attempt.userArgs, attempt.connection)
      } catch (failure: Throwable) {
        synchronized(lock) {
          if (activeAttempt !== attempt) return@post
          bindState.onBindThrew(ShizukuBindCodes.bindFailed(failure), attempt.generation)
          activeAttempt = null
          attempt.latch.countDown()
        }
        Log.w(TAG, "bind user service failed", failure)
      }
    }
  }

  /** 用户主动重置：立即作废本地连接，异步注销旧回调并移除远端；下一次轮询自然重建。 */
  fun resetConnection(context: Context): JSONObject {
    val app = context.applicationContext
    synchronized(lock) {
      val previous = activeAttempt
      activeAttempt = null
      service = null
      connectedAt = 0L
      configuredForAge = -1L
      bindState.onReset()
      previous?.latch?.countDown()
      discardOnMain(previous?.userArgs ?: args(app), previous?.connection, remove = true)
    }
    ControlCarrier.invalidateShizukuCache()
    Log.i(TAG, "shizuku connection reset (user action); attempts=" + bindState.attempts)
    return shizukuResetResponse(status(app))
  }

  /** 超时既回收本地等待，也移除远端僵尸服务；读路径只排队，不等 Binder。 */
  private fun reapStaleBind() {
    synchronized(lock) {
      if (!bindState.reapIfStale(SystemClock.elapsedRealtime())) return
      val previous = activeAttempt
      activeAttempt = null
      service = null
      connectedAt = 0L
      configuredForAge = -1L
      previous?.latch?.countDown()
      if (previous != null) discardOnMain(previous.userArgs, previous.connection, remove = true)
    }
    ControlCarrier.invalidateShizukuCache()
    Log.w(TAG, "bind watchdog: remove stale user service (attempts=" + bindState.attempts + ")")
  }

  private fun args(context: Context): Shizuku.UserServiceArgs = Shizuku.UserServiceArgs(
    ComponentName(context.packageName, ShizukuUserServiceBridge::class.java.name),
  )
    .daemon(false)
    .tag(USER_SERVICE_TAG)
    .processNameSuffix("dsh-vdisplay")
    .debuggable(BuildConfig.DEBUG)
    .version(BuildConfig.VERSION_CODE * 10 + ShizukuUserServiceBridge.PROTOCOL_VERSION)

  /** Stable JSON state suitable for the native bridge and VirtualDisplay controller. */
  fun status(context: Context): JSONObject {
    // 看门狗先跑：它是**读路径**上唯一的自愈点（设置页与面板每 2s 轮询 status）。
    // 不放在这里的话，一次不回调的 bind 会让状态永远停在「正在建立」，没有任何人会发现。
    reapStaleBind()
    // 能力判据（0.14.8）：**只看 binder 是否连上**——包名不参与放行。分支实现（Stellar 等，
    // 管理器包名不同、经兼容层提供同一套 API）因此在 binder 一连上时即可用，不必先装官方 APK。
    val running = binderAlive()
    val managerPresent = managerInstalled(context)
    val out = JSONObject().put("installed", managerPresent || running)
    out.put("running", running)
    out.put("granted", false)
    out.put("bound", service?.asBinder()?.pingBinder() == true)
    out.put("userServiceAgeMs", if (connectedAt > 0L) SystemClock.elapsedRealtime() - connectedAt else -1)
    // 绑定面三态的可观测出口（0.14.1）：调用方（设置页 / 工具面 / 诊断）据此区分
    // 「尚未发起」「正在建立（确有 bind 在飞）」「已失败」，而不是由一句文案猜。
    out.put("binding", bindState.binding)
    out.put("bindAttempts", bindState.attempts)
    out.put("bindAgeMs", bindState.attemptAgeMs(SystemClock.elapsedRealtime()))
    out.put("lastError", bindState.lastError)

    if (!running) {
      // 没连上才分流文案：装了哪个管理器（去启动 / 去授权）还是都没装（去下载）。这是**引导**分流，
      // 不是能力门——binder 一旦连上就走下面的就绪路径；包名不在表内的分支同样不受影响。
      return if (managerPresent) {
        out.put("ok", false).put("code", "shizuku-not-running")
          .put("guidance", "Shizuku 已安装但服务未运行。非 root 设备可通过 USB/有线 ADB 或无线调试启动它；重启设备后需再次启动。")
      } else {
        out.put("ok", false).put("code", "shizuku-absent")
          .put("guidance", "未检测到 Shizuku 及其兼容实现；虚拟屏需要用户安装、启动并授权其中之一。")
      }
    }

    val version = runCatching { Shizuku.getVersion() }.getOrDefault(-1)
    val uid = runCatching { Shizuku.getUid() }.getOrDefault(-1)
    out.put("version", version).put("uid", uid)
    if (version < 12) {
      return out.put("ok", false).put("code", "shizuku-prev11")
        .put("guidance", "Shizuku 版本过低，虚拟屏需要 v12 及以上的 UserService 支持。")
    }

    val granted = runCatching {
      Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)
    out.put("granted", granted)
    if (!granted) {
      return out.put("ok", false).put("code", "shizuku-denied")
        .put("guidance", "尚未获得 Shizuku 授权。点击创建虚拟屏后会由 Shizuku 管理器显示用户确认；DSH 不会自行授予权限。")
    }
    if (service?.asBinder()?.pingBinder() != true) {
      // 三态化（0.14.1）：code 只报「正在建立」当且仅当确有 bind 在飞。
      // 旧实现在这里恒报 connecting + 「正在建立 shell UserService」，把「从未发起」与
      // 「绑定已失败（超时/无效 binder/被拒）」都盖成了同一句——正是本缺陷的文案面。
      val binding = bindState.binding
      val ageMs = bindState.attemptAgeMs(SystemClock.elapsedRealtime())
      val code = if (binding) CONNECTING_CODE else bindState.lastError.ifBlank { ShizukuBindCodes.NOT_BOUND }
      val answer = out.put("ok", false).put("code", code)
        .put("guidance", shizukuBindGuidance(code, binding, ageMs, BIND_WATCHDOG_MS))
      if (binding) answer.put("retryAfterMs", BIND_TIMEOUT_MS)
      return answer
    }
    return out.put("ok", true).put("code", "shizuku-ready")
      .put("guidance", "Shizuku shell UserService 已就绪（uid=$uid）。")
  }

  /**
   * 非阻塞「催一下」：已装 + 已运行 + 已授权但尚未绑定时，在后台发起一次 UserService 绑定。
   *
   * 为什么需要它（0.14.0 设备实锤缺陷）：status() 是**纯读**且不得阻塞（它在控制队列与 UI
   * 轮询路径上被高频调用，绝不能等 binder）。但设置页「刷新 Shizuku 状态」与面板的
   * vdisplayStatus 轮询走的正是 status()——此前唯一会发起绑定的是建屏路径的 ensureBound()，
   * 于是「用户已授权、Shizuku 在运行」的机器上，那条 UI 路径**无论刷新多少次都不会建连**，
   * 永远停在 shizuku-user-service-not-bound（用户实测「会一直卡在这」）。
   *
   * 这里把绑定动作与读取动作解耦：读路径只负责**触发**一次后台绑定并立即返回当前状态，
   * 真正的等待交给下一次轮询（2s）自然收敛。绑定成功后 status() 会如实报 ok=true。
   */
  fun kickBind(context: Context) {
    val app = context.applicationContext
    // status() 内部先跑看门狗：若上一次绑定已成僵尸，这里读到的 binding 已是 false，
    // 下面的守卫不会再把它挡回去——「一次不回调的 bind 永久关掉重试」的闭环由此打开。
    val current = status(app)
    // 能力门只看 binder（0.14.8）：包名不再参与放行。
    if (!current.optBoolean("running")) return
    if (!current.optBoolean("granted")) return
    if (current.optBoolean("bound")) return
    // 已有绑定在飞（binding=true）时不重复发起——Shizuku.bindUserService 幂等但没必要抖动。
    if (bindState.binding) return
    Thread({
      runCatching { ensureBound(app) }.onFailure {
        Log.w(TAG, "background bind failed: " + it.javaClass.simpleName + ": " + (it.message ?: ""))
      }
    }, "dsh-shizuku-kick").start()
  }

  /** Establish the UserService on an explicit user action. */
  fun ensureBound(
    context: Context,
    requestPermission: Boolean = true,
    ignoreGranted: Boolean = false,
  ): JSONObject {
    val before = status(context)
    // 能力门只看 binder（0.14.8）：包名不再参与放行（旧式 (!installed || !running) 与 !running 等价）。
    if (!before.optBoolean("running")) return before
    // ignoreGranted=true 只给**探测面**用（复审第 1 点）：`checkSelfPermission()` 在本机恒报 denied，
    // 若在这里就返回，探测就永远没真绑过，判据只能退回那个已证明不可靠的信号 ⇒ 误清隔离的风险。
    if (!ignoreGranted && !before.optBoolean("granted")) {
      // requestPermission=false：**只探测、不弹框**（2026-10-02 复审实测：本机 checkSelfPermission()
      // 假阴性恒为 false ⇒ 无脑发请求会把启动卡在系统确认框上；探测面绝不能有 UI 副作用）。
      if (!requestPermission) {
        return status(context).put("requested", false).put("code", "shizuku-denied")
          .put("guidance", "本应用尚未获得 Shizuku 授权（探测面不发起确认框）。")
      }
      val requested = runCatching {
        if (!Shizuku.shouldShowRequestPermissionRationale()) Shizuku.requestPermission(REQUEST_CODE_VDISPLAY)
        true
      }.getOrDefault(false)
      return status(context)
        .put("requested", requested)
        .put("code", if (requested) "shizuku-permission-requested" else "shizuku-denied")
        .put("guidance", "已向 Shizuku 发起授权请求；请在其系统确认页批准后再次点击创建虚拟屏。")
    }
    if (service?.asBinder()?.pingBinder() == true) return status(context)

    // 进入等待前先回收僵尸绑定：否则 `beginAttempt` 会因 binding=true 直接返回 false，
    // 而调用方只能一路空等满预算——「每轮都报正在建立、永远不重试」正是本缺陷的形态。
    reapStaleBind()

    val deadline = SystemClock.elapsedRealtime() + BIND_TOTAL_MS
    while (true) {
      val latch: CountDownLatch
      synchronized(lock) {
        if (service?.asBinder()?.pingBinder() == true) return status(context)
        if (bindState.beginAttempt(SystemClock.elapsedRealtime())) {
          val attempt = BindAttempt(args(context.applicationContext), bindState.currentGeneration)
          activeAttempt = attempt
          bindOnMain(attempt)
        }
        latch = activeAttempt?.latch ?: return status(context)
      }
      if (service?.asBinder()?.pingBinder() == true) return status(context)
      // SDK 的连接回调也在主线程；主线程调用者必须先返回，不能阻塞自己的回调。
      if (Looper.myLooper() == Looper.getMainLooper()) return status(context)
      val remaining = deadline - SystemClock.elapsedRealtime()
      if (remaining <= 0L) break
      // 到点即复用当次结果，不把 4s 片拉长到整段预算——调用方的超时语义不变。
      latch.await(minOf(BIND_TIMEOUT_MS, remaining), TimeUnit.MILLISECONDS)
      if (service?.asBinder()?.pingBinder() == true) return status(context)
      // 回调已发生但服务仍不可用（invalid-binder / disconnected）：不要继续等，如实汇报。
      // 僵尸超时不能走这条 break——那会把「这次尝试已死」当成「已失败并就此定论」，
      // 而正确的语义是「已复位、可立即再试」，故先跑看门狗再看 binding。
      reapStaleBind()
      if (!bindState.binding) break
    }
    // status 自己跑看门狗并生成三态，不能用等待前的 binding 覆盖刚到达的结果。
    return status(context)
  }

  /**
   * v3（2026-09-30）：把「本应用 uid + 数据目录」回填给 UserService（每次连接一次）。
   *
   * 为什么必须做：root 通道里 UserService 的 uid=0，它写的文件属主是 root:root——落进应用
   * 数据目录就是**应用自己读不回来**（0600），watcher / 插件更新 / 引擎读写随之失败。
   * 回填后 UserService 才能把 [writeChunk] 的产物与 [repairOwnership] 的目标修回应用 uid。
   * 旧服务或未确认配置返回 false，执行面拒绝派发；不能在身份/归一化能力未知时继续写入。
   */
  private fun configureIfNeeded(context: Context): Boolean {
    val remote = service ?: return false
    val age = connectedAt
    if (age <= 0L) return false
    if (configuredForAge == age) return true
    val app = context.applicationContext
    val uid = app.applicationInfo.uid
    val root = app.applicationInfo.dataDir
    return try {
      if (remote.protocolVersion() < ShizukuUserServiceBridge.PROTOCOL_VERSION) return false
      remote.configure(uid, root)
      val ack = remote.configuration()
      val valid = ack.getBoolean("ok") && ack.getInt("appUid", -1) == uid &&
        ack.getString("appDataDir") == root && ack.getInt("protocolVersion", -1) >= ShizukuUserServiceBridge.PROTOCOL_VERSION
      if (valid) configuredForAge = age
      valid
    } catch (failure: Throwable) {
      Log.w(TAG, "configure not acknowledged: " + failure.javaClass.simpleName)
      false
    }
  }

  /**
   * 属主归一（root 通道写盘污染的固定自愈原语，v4）。**不受 AI 授权门约束**——它不是模型能力，
   * 而是应用修自己文件的自愈面：目标必须落在应用数据目录内、uid/gid 由 UserService 侧
   * 固定为已配置的应用 uid（不接受任意 uid/gid）。
   */
  fun repairOwnership(context: Context, path: String, maxEntries: Int = 20_000): JSONObject =
    RootExecutionFence.maintenance(context) {
      // 后台自愈面两条硬约束：**不弹授权框**（requestPermission = false，本机 checkSelfPermission() 有假阴性，
      // 若在这里发起请求会把维护卡在系统确认页上，2026-10-02 真机实测）＋ **绕过不可靠的客户端权限预检**
      // （ignoreGranted = true，否则自检假阴性会让自愈永远拿不到 `shizuku-denied` 之外的结论而不修 ✗）。
      // 这里只归一本应用数据目录里的属主，不构成权限放大（与 `applyGate = false` 的豁免理由同源）。
      val (remote, refusal) = readyService(context, applyGate = false, requestPermission = false, ignoreGranted = true)
      if (remote == null) return@maintenance refusal ?: unavailableShell()
      if (!configureIfNeeded(context)) return@maintenance JSONObject().put("ok", false)
        .put("code", "repair-configuration-required").put("reason", "repair-configuration-required")
        .put("guidance", "UserService 未确认应用身份，请重置 Shizuku 连接后再试。")
      val lease = RpcLease(context, "shizuku-ownership-repair", applyGate = false)
      try {
        lease.beforeRpc(remote)?.let { return@maintenance it }
        val reply = remote.repairOwnership(path, maxEntries)
        lease.acknowledged()
        val result = bundleJson(reply).put("transport", "shizuku")
        // ROOT-MAINTENANCE.md §2：拿到**完整信封**的回执（即使修复部分失败/超预算）就算结算，
        // 租约可以 finish、结果如实回 ok=false/repair-incomplete；只有信封缺失或传输不完整才
        // 停在 UNKNOWN。此前 definitive=verified 把「已确认的部分修复/超时」也判成结果不明 ⇒
        // 耐久租约把每次启动都挂成「等待属主维护」，直到整机重启才解。
        val envelopeComplete = result.opt("ok") is Boolean &&
          listOf("checked", "healed", "failures", "unverifiedMutations").all {
            result.opt(it) is Int && result.optInt(it, -1) >= 0
          } &&
          result.opt("remaining") is Int && result.optInt("remaining", -2) in setOf(-1, 0) &&
          result.opt("truncated") is Boolean && result.opt("deadlineExceeded") is Boolean
        if (!envelopeComplete) return@maintenance lease.complete(result, definitive = false)
        val verified = result.optBoolean("ok") && result.has("checked") && result.has("healed") &&
          result.optInt("failures", -1) == 0 && result.optInt("unverifiedMutations", -1) == 0 &&
          result.optInt("remaining", -1) == 0 && !result.optBoolean("truncated") && !result.optBoolean("deadlineExceeded")
        val settled = if (verified) result else result.put("ok", false).apply {
          if (optString("reason").isBlank()) {
            put("reason", "repair-incomplete").put("code", "repair-incomplete").put("remaining", -1)
          }
        }
        lease.complete(settled, definitive = true)
      } catch (failure: Throwable) {
        lease.complete(JSONObject().put("ok", false).put("transport", "shizuku")
          .put("code", "repair-result-unknown").put("reason", "repair-result-unknown")
          .put("failures", 1).put("remaining", -1)
          .put("guidance", "属主维护未返回完整验证结果；不重放，需先处理隔离状态。"), definitive = false)
      }
    }

  /** Bounded deep walk reaches polluted startup leaves even when their ancestors are app-owned. */
  fun autoHealOwnership(context: Context): JSONObject = RootOwnershipJobs.runBlocking(context)

  /**
   * root 通道三态，只描述「本应用此刻能否派发 root 工作」这一件事。
   * [ABSENT] 是**肯定结论**（探测完整且判定不可用），只有它允许清算残留租约；
   * [UNKNOWN] 表示探测不完备（binder 未就绪 / API 抛异常），不得据此做不可逆处置。
   */
  internal enum class RootChannel { AVAILABLE, ABSENT, UNKNOWN }

  /** 探测结果：三态 + 服务端 uid（供结果如实回报 `channelUid`）+ 原始信号明细（诊断留痕）。 */
  internal data class RootChannelProbe(val state: RootChannel, val serverUid: Int, val detail: String = "")

  /**
   * 已有真实取值时的可用判定（**纯函数**，真值表用例见 `RootChannelDecisionTest`）：
   * su 直连已授权，**或** 服务端以 root 运行（uid 0）且**本应用确实派发得出去**。
   *
   * ⚠️ 第三参的语义是「已确认本应用可用」，**不是** `checkSelfPermission()` 的原值——后者在本机
   * 服务端 v13.6 上恒报 denied（假阴性，见 [classifyRootChannel] 的限制说明）。运行期由
   * [decideNoRootChannel] 用「真绑定成功 + `remote.uid()`」给出该值。
   */
  internal fun rootChannelAvailable(suGranted: Boolean, serverUid: Int, selfPermissionGranted: Boolean): Boolean =
    suGranted || (serverUid == RootGrant.ROOT_UID && selfPermissionGranted)

  /** 拒绝码里「肯定派发不了」的那一组（未安装 / 服务端没跑 / 版本过低 / UserService 协议过旧）。 */
  private val ABSENT_CODES = setOf(
    "shizuku-absent", "shizuku-not-running", "shizuku-prev11", "shizuku-user-service-too-old",
  )

  /** 权限面拒绝码——**只用于解释与审计**，不再作为「通道不存在」的证据（复审第 1 点）。 */
  private val PERMISSION_DENIED_CODES = setOf("shizuku-denied", "shizuku-permission-requested")

  /**
   * 真绑定尝试的结果（探测的**原始信号**，不经任何不可靠 API 转述）。
   * [NOT_ATTEMPTED] 是独立取值——它让「压根没真去绑」在审计里一眼可见（复审第 1、4 点）。
   */
  internal enum class BindOutcome { NOT_ATTEMPTED, BOUND, DENIED, SERVER_ABSENT, PROTOCOL_TOO_OLD, TIMEOUT, BINDER_THREW, UNKNOWN }

  /**
   * 探测环境（**可注入**）：生产实现走 Shizuku binder，测试注入假实现 ⇒「真绑定尝试 → 判据 →
   * 自动清算准入」整条链能在离线单测里跑（复审第 5.8 点），而不是只测纯函数。
   */
  internal interface RootProbeEnv {
    val suGranted: Boolean
    val suBinaryPresent: Boolean
    val shizukuInstalled: Boolean
    /** null = 抛异常（binder 未就绪）。 */
    fun binderPing(): Boolean?
    /** 已有活绑定的 UserService uid（零代价路径）；没有则 null。 */
    fun boundServiceUid(): Int?
    /** **真正**尝试绑定 UserService（不弹框、不因 `checkSelfPermission()` 假阴性而跳过）。 */
    fun bindUserService(): BindOutcome
  }

  /**
   * 通道判据（纯函数，真值表 `RootChannelDecisionTest`）——**安全优先**：只有能**证明**通道不存在
   * 才给 ABSENT；证明不了一律 UNKNOWN。
   *
   * 复审第 1 点的教训：曾经的实现里「`status.granted == false` ⇒ 直接返回 denied、**根本没尝试绑定**」
   * ⇒ 本机 `checkSelfPermission()` 假阴性时会把**真实存在的 root 通道**判成 ABSENT ⇒ 误清隔离。
   * 现在 `DENIED` 只算 UNKNOWN（客户端权限面不可信），只有三类算证明：
   * ①真绑上了且**非 root uid**；②两条通道在场面上都不存在（未装 Shizuku 且无 su 二进制）；
   * ③服务端明确不在（ping=false）或协议明确不支持。
   */
  internal fun decideNoRootChannel(
    shizukuInstalled: Boolean,
    suBinaryPresent: Boolean,
    binderPing: Boolean?,
    bindOutcome: BindOutcome,
    boundUid: Int,
  ): RootChannel = when {
    bindOutcome == BindOutcome.BOUND ->
      if (boundUid == RootGrant.ROOT_UID) RootChannel.AVAILABLE else RootChannel.ABSENT
    !shizukuInstalled && !suBinaryPresent -> RootChannel.ABSENT
    !shizukuInstalled -> RootChannel.UNKNOWN
    bindOutcome == BindOutcome.SERVER_ABSENT -> RootChannel.ABSENT
    bindOutcome == BindOutcome.PROTOCOL_TOO_OLD -> RootChannel.ABSENT
    // DENIED / TIMEOUT / BINDER_THREW / NOT_ATTEMPTED / ping 抛异常：都证明不了 ⇒ 保留隔离
    binderPing == null -> RootChannel.UNKNOWN
    else -> RootChannel.UNKNOWN
  }

  /**
   * 自动清算的**准入**（纯函数）：四个条件缺一不可 ——
   * ①通道被**证实不存在**；②这条租约**从未派发**过特权工作（`dispatched=false`）；
   * ③**租约自身的结算/持久化状态可信**（`leaseUnknown=false`）；④进程内没有在飞维护。
   *
   * ②③是关键：
   * - ②（复审第 2 点）：本模块的锁只覆盖**本进程**，`synchronized` 证明不了外部 su 子进程 / Shizuku
   *   UserService 已经退出。已派发的租约一律保留，只能由用户在明示「终止无法证明」之后手工清除。
   * - ③（复审第四轮）：**「没有派发证据」≠「证明没有派发」**。`markDispatched` 持久化失败时只置了
   *   unknown（`dispatched` 仍是 false ✗），本进程**恢复**别的进程留下的租约时 `restore()` 也置 unknown
   *   ⇒ 这两种情况下 `dispatched=false` 可能意味着「证据没落盘」而不是「没派发过」⇒ 一律否决自动清算。
   */
  internal fun autoClearAllowed(
    channel: RootChannel,
    dispatched: Boolean,
    leaseUnknown: Boolean,
    maintenanceActive: Boolean,
  ): Boolean = channel == RootChannel.ABSENT && !dispatched && !leaseUnknown && !maintenanceActive

  /**
   * 唯一的 root 通道判据（**两条消费面同源**：入口清算与维护 worker 都用它）。
   *
   * 为什么不能用廉价信号收尾：本机（Shizuku 服务端 v13.6）上 `getUid()` 在**撤权后仍返回 0**、
   * `checkSelfPermission()` 又恒报 denied —— 两个廉价信号都不可信。所以先做廉价否决（su 已授权 /
   * 未安装 / ping 不通，这三条结论是确定的），剩下的**必须真去绑定 UserService 并读回
   * `remote.uid()`**（[readyService] 的 `applyGate = false` 面，只在确有需要时调用）。
   * 判定交给纯函数 [decideNoRootChannel]，保证与真值表同源。
   */
  internal fun probeRootChannel(context: Context): RootChannelProbe =
    probeRootChannel(SystemRootProbeEnv(context.applicationContext))

  internal fun probeRootChannel(env: RootProbeEnv): RootChannelProbe {
    if (env.suGranted) return RootChannelProbe(RootChannel.AVAILABLE, -1, "su=granted")
    val ping = env.binderPing()
    val already = if (ping == true) env.boundServiceUid() else null
    val outcome = when {
      already != null -> BindOutcome.BOUND
      ping == false -> BindOutcome.SERVER_ABSENT
      ping == null -> BindOutcome.NOT_ATTEMPTED
      else -> env.bindUserService()
    }
    val uid = if (outcome == BindOutcome.BOUND) (already ?: env.boundServiceUid() ?: -1) else -1
    val state = decideNoRootChannel(env.shizukuInstalled, env.suBinaryPresent, ping, outcome, uid)
    return RootChannelProbe(state, uid, "installed=" + env.shizukuInstalled + " suBinary=" + env.suBinaryPresent +
      " ping=" + (ping?.toString() ?: "throw") + " bind=" + outcome.name + " uid=" + uid)
  }

  /** 把 `readyService` 的拒绝码归成 [BindOutcome]（原始信号，不做「不可靠 ⇒ 不存在」的转述）。 */
  private fun classifyBindOutcome(refusal: JSONObject?): BindOutcome {
    if (refusal == null) return BindOutcome.BOUND
    val code = refusal.optString("code")
    return when {
      code == "shizuku-not-running" || code == "shizuku-absent" -> BindOutcome.SERVER_ABSENT
      code == "shizuku-prev11" || code == "shizuku-user-service-too-old" -> BindOutcome.PROTOCOL_TOO_OLD
      code in PERMISSION_DENIED_CODES -> BindOutcome.DENIED
      code.startsWith("shizuku-user-service-bind-failed:") -> BindOutcome.BINDER_THREW
      code == ShizukuBindCodes.CONNECTING || code == ShizukuBindCodes.NOT_BOUND ||
        code == ShizukuBindCodes.BIND_TIMEOUT || code == ShizukuBindCodes.INVALID_BINDER ||
        code == ShizukuBindCodes.DISCONNECTED -> BindOutcome.TIMEOUT
      else -> BindOutcome.UNKNOWN
    }
  }

  /** 生产探测环境：真 binder 调用；**不弹框**、**不因自检假阴性跳过绑定**（复审第 1 点两条硬约束）。 */
  private class SystemRootProbeEnv(private val app: Context) : RootProbeEnv {
    override val suGranted: Boolean get() = RootAccess.isGranted(app)
    override val suBinaryPresent: Boolean get() = RootAccess.suPath() != null
    override val shizukuInstalled: Boolean get() = installed(app)
    override fun binderPing(): Boolean? = try { Shizuku.pingBinder() } catch (_: Throwable) { null }
    override fun boundServiceUid(): Int? {
      val bound = service ?: return null
      if (bound.asBinder()?.pingBinder() != true) return null
      return runCatching { bound.uid() }.getOrNull()
    }
    override fun bindUserService(): BindOutcome {
      // requestPermission=false：探测面绝不弹授权框（真机实测会把启动卡在系统确认页）；
      // ignoreGranted=true：**绕过不可信的客户端权限预检**，真正去尝试绑定（复审第 1 点的正解）。
      val (remote, refusal) = readyService(app, applyGate = false, requestPermission = false, ignoreGranted = true)
      return if (remote == null) classifyBindOutcome(refusal) else BindOutcome.BOUND
    }
  }

  /**
   * 残留租约的**入口级**清算：只有「真实 root 通道仍存在」时隔离才有意义。root 路已消失
   * 却还留着租约，就会让 [RootOwnershipJobs.start] 的 outstanding 短路把每次启动挂成
   * 「等待属主维护」——真机实测（2026-10-02）：注入同 boot 残留租约 + 撤掉 root 路后，
   * 5 分钟没有任何 boot-start 记录、引擎起不来。清算放在 worker 里够不到这条路径（worker
   * 内的清算已移除），所以必须在咨询租约之前先跑。
   *
   * **判据用决定性探测**（[decideNoRootChannel] + [decisiveChannelState]）：真去绑定 UserService
   * 并读回 `remote.uid()`——不能再用 `getUid()` 是否可读当「已授权」的替身，因为本机服务端
   * v13.6 在**撤权后仍返回 0**，会把「撤权但服务端 root」误判成有 root 路（2026-10-02 复审真机
   * 复现：120s 无启动、租约原封不动）。只有肯定判定的 ABSENT 才清；绑定进行中/失败原因不明一律
   * 保留（UNKNOWN）。
   *
   * **原子性**：在飞维护（写锁在持）与清除在 [RootMaintenanceLease] 的**同一临界区**内求值，
   * 且与 `begin()` 互斥——不会清掉 worker 刚拿到的租约。探测结果与清除之间通道可能重新出现，
   * 故 guard 内再复核一次 su 缓存与维护态（廉价、无悔），残余竞态如实标注。
   * @returns 是否真的清掉了一条残留租约。
   */
  internal fun clearLeaseWhenNoRootChannel(context: Context): Boolean {
    val app = context.applicationContext
    val lease = RootMaintenanceLease.outstanding(app)
    val probe = probeRootChannel(app)
    val dispatched = lease?.optBoolean("dispatched") == true
    // 复审第四轮：`unknown` 是**明确否决项**——「没有派发证据」≠「证明没有派发」
    // （markDispatched 写不进时只置 unknown；恢复别的进程的租约也会 unknown）。
    val leaseUnknown = lease?.optBoolean("unknown") == true || RootMaintenanceLease.unknown(app)
    val allowed = autoClearAllowed(probe.state, dispatched, leaseUnknown, RootExecutionFence.maintenanceActive)
    LeaseClearProbe.record(app, probe, decisive = true, dispatched = dispatched, allowed = allowed,
      leaseUnknown = leaseUnknown)
    if (!allowed) return false
    return RootMaintenanceLease.clearWhenNoRootChannel(app) {
      // 锁内复核（判断—清除之间）：通道可能复活、维护可能刚好开始、租约可能刚被派发、
      // 或租约状态刚变成不可信（unknown）⇒ 任一变化都不得清除。
      !RootExecutionFence.maintenanceActive && !RootAccess.isGranted(app) &&
        !RootMaintenanceLease.dispatched(app) && !RootMaintenanceLease.unknown(app)
    }
  }

  /**
   * 用户显式确认后的清除出口（引导页「清除维护隔离并重试」）。
   *
   * **语义边界（复审第 3 点）**：用户确认**不是**「旧特权任务已结束」的技术证明 —— 本函数只在
   * 一条证据上把关：进程内确有在飞维护时**拒绝**（那会破坏在飞结算）；对「已派发但结果不明」的
   * 租约，它照清，但把 `terminationUnproven=true` 如实回给调用方并写进审计，由引导页向用户讲明。
   * 也就是说：**自动**清算要求证明（[autoClearAllowed]），**人工**清算是明确授权的取舍并留痕。
   */
  internal fun forceClearMaintenanceLease(context: Context): JSONObject {
    val app = context.applicationContext
    if (RootExecutionFence.maintenanceActive) {
      return JSONObject().put("ok", false).put("code", "maintenance-active")
        .put("reason", "maintenance-active")
        .put("guidance", "维护正在运行，请等它结束再清除隔离（当前清除会破坏在飞结算）。")
    }
    val lease = RootMaintenanceLease.outstanding(app)
    val dispatched = lease?.optBoolean("dispatched") == true
    val leaseUnknown = lease?.optBoolean("unknown") == true || RootMaintenanceLease.unknown(app)
    val cleared = RootMaintenanceLease.clearWhenNoRootChannel(app) {
      // 复审第五轮：人工清算**同样**要锁内最终复核 —— 上面那次检查在锁外，中间有窗口能让另一个入口
      // 启动维护（maintenanceActive=true 且刚拿到新租约），此时清掉就会破坏在飞结算 ✗。
      // 用户授权 ≠ 可以拆掉并发保护。
      !RootExecutionFence.maintenanceActive
    }
    LeaseClearProbe.record(app, RootChannelProbe(
      if (cleared) RootChannel.ABSENT else RootChannel.UNKNOWN, -1, "manual"), decisive = false,
      // `allowed=false`：**自动清算准入没有通过**（本条是用户显式授权，不是自动判据放行）——
      // 用 forced=true 区分人工；免得日志里出现「allowed 又 unknown」这种自相矛盾的读法。
      forced = true, dispatched = dispatched, allowed = false, leaseUnknown = leaseUnknown)
    // 复审第四轮：租约状态不可信时也**无法证明终止**（`dispatched=false` 恰恰可能是「证据没落盘」），
    // 所以 terminationUnproven 必须把 unknown 也算进去。
    val unproven = dispatched || leaseUnknown
    return JSONObject().put("ok", cleared).put("cleared", cleared).put("terminationUnproven", unproven)
      .put("code", if (cleared) "lease-cleared" else "lease-clear-failed")
      .put("reason", if (cleared) "lease-cleared" else "lease-clear-failed")
      .put("guidance", when {
        !cleared -> "清除未成功（存储写入失败），请重试或重启设备。"
        unproven -> "已清除维护隔离并重试启动。注意：这条隔离记录的状态不可信（可能留有已派发的特权工作痕迹），本次无法证明那次工作已经结束——若随后出现异常，请重启设备再排查。"
        else -> "已清除维护隔离，正在重试启动。"
      })
  }

  /** Shared Activity/Service startup guard; coalesce near-simultaneous completed scans only. */
  fun prepareStartupOwnership(context: Context): JSONObject = RootOwnershipJobs.runBlocking(context, reuseRecent = true)

  internal fun autoHealOwnershipDirect(context: Context): JSONObject {
    val app = context.applicationContext
    // 与入口清算**同一判据**（同一个三态探测 + 同一个纯函数）：判定为不可用或探测不完备
    // 都不做维护，如实回报。残留租约的清算只发生在 RootOwnershipJobs 入口（那里才够得到
    // start() 的 outstanding 短路，worker 内清算够不到）。
    val probe = probeRootChannel(app)
    if (probe.state != RootChannel.AVAILABLE) {
      return JSONObject().put("ok", true).put("checked", 0).put("healed", 0).put("failures", 0)
        .put("skipped", if (probe.state == RootChannel.ABSENT) "no-root-path" else "root-channel-unknown")
    }
    val viaSu = RootAccess.isGranted(app)
    return RootExecutionFence.maintenance(context) {
      val root = java.io.File(app.applicationInfo.dataDir, "files").path
      val result = if (viaSu) RootAccess.repairOwnership(app, root, OwnershipRepairCore.MAX_ENTRIES, 20_000L)
        else repairOwnership(app, root, OwnershipRepairCore.MAX_ENTRIES)
      result.put("channelUid", probe.serverUid).put("transport", if (viaSu) "su" else "shizuku")
    }
  }


  /**
   * 显式请求 Shizuku 授权（**必须在 UI 线程 + 有前台 Activity**）。
   *
   * 为什么单独成方法（2026-09-30 实测）：`ensureBound` 里的自动请求跑在**后台线程**
   * （repairOwnership / kickBind 的路径），Shizuku 的 `requestPermission` 需要当前 Activity
   * 才能把授权对话框落到用户眼前——后台调用静默失败，结果是「管理器列表里根本没有本应用」
   * 且状态恒为 denied（用户看不到任何可点的授权入口）。
   *
   * 返回写后回读的 [status]，并带 `requested` 说明这次是否真的发起了请求。
   */
  fun requestPermission(activity: Activity): JSONObject {
    val requested = runCatching {
      activity.runOnUiThread { runCatching { Shizuku.requestPermission(REQUEST_CODE_VDISPLAY) } }
      true
    }.getOrDefault(false)
    return status(activity).put("requested", requested)
  }

  /** Native-only fixed argv execution. Never pass user/model-controlled shell text here. */
  fun runController(context: Context, argv: Array<String>): JSONObject = RootExecutionFence.command(context) {
    runControllerInternal(context, argv)
  }

  private fun runControllerInternal(context: Context, argv: Array<String>): JSONObject {
    val (remote, refusal) = readyService(context)
    if (remote == null) return refusal ?: unavailableShell()
    val lease = RpcLease(context, "shizuku-controller")
    return try {
      lease.beforeRpc(remote)?.let { return it }
      val reply = remote.exec(argv, 8_000)
      lease.acknowledged()
      lease.complete(bundleJson(reply).put("transport", "shizuku"), executionDefinitive(reply))
    } catch (failure: Throwable) {
      lease.complete(shellFailure(failure), definitive = false)
    }
  }

  fun identity(context: Context): JSONObject {
    val ready = ensureBound(context)
    if (!ready.optBoolean("ok")) return ready
    return try {
      val remote = service ?: return JSONObject().put("ok", false).put("code", "shizuku-user-service-not-bound")
      JSONObject().put("ok", true).put("uid", remote.uid()).put("protocolVersion", remote.protocolVersion())
    } catch (t: Throwable) {
      JSONObject().put("ok", false).put("code", "shizuku-identity-failed")
        .put("guidance", t.javaClass.simpleName + ": " + (t.message ?: ""))
    }
  }

  // ── 0.14.0 特权 shell 通道（替换退役的内置 adb：execAdbShell / execAdbLine 的壳侧执行面） ──────

  /** 单次 shell 调用默认 / 上限超时（§6「放宽超时」；旧 adb 路径为 8s 级）。 */
  private const val SHELL_TIMEOUT_MS = 20_000
  private const val MAX_SHELL_TIMEOUT_MS = 120_000
  private const val PULL_CHUNK = 512 * 1024
  private const val MAX_TRANSFER_BYTES = 512L * 1024 * 1024
  private const val SHELL_PATH_PREFIX = "export PATH=/system/bin:/system/xbin:\$PATH; "

  /** v2 协议面就绪判定：返回 (service, refusal)——refusal 非空即结构化拒绝，调用方直接透传。 */
  private fun readyService(
    context: Context,
    applyGate: Boolean = true,
    requestPermission: Boolean = true,
    ignoreGranted: Boolean = false,
  ): Pair<ShizukuUserService?, JSONObject?> {
    // issue #262 方案 A 策略门（runShell/pullFile/pushFile/removeRemote 四个执行面的共同入口）：
    // 通道身份为 root 且未授权时，在**发起任何绑定/执行之前**拒绝——不是按 op 分类放行，
    // uid 0 下 shExec 是任意 shell，分类隔离不存在（诚实性要求），故整体关闭。
    //
    // applyGate=false 仅供**应用自愈面**（repairOwnership）使用：它只把应用自己数据目录里的文件
    // 属主修回应用自己的 uid，不是模型能力、也不构成权限放大；被自己的策略门挡住会让
    // 「root 通道 + AI 未授权」这一组合失去自愈能力（文档已如此承诺，实现必须一致）。
    if (applyGate) rootGateRefusal(context)?.let { return null to it }
    val ready = ensureBound(context, requestPermission, ignoreGranted)
    if (!ready.optBoolean("ok")) return null to ready
    val remote = service
    if (remote == null || remote.asBinder()?.pingBinder() != true) {
      return null to status(context).put("ok", false).put("code", "shizuku-user-service-not-bound")
    }
    val pv = runCatching { remote.protocolVersion() }.getOrDefault(-1)
    if (pv < ShizukuUserServiceBridge.PROTOCOL_VERSION) {
      return null to JSONObject().put("ok", false).put("code", "shizuku-user-service-too-old")
        .put("protocolVersion", pv)
        .put("guidance", "Shizuku UserService 协议为 v$pv，本机需要 v${ShizukuUserServiceBridge.PROTOCOL_VERSION}；" +
          "请在设置页「手机控制」重置连接，重启旧 UserService（无需重装）。")
    }
    if (!configureIfNeeded(context)) return null to JSONObject().put("ok", false)
      .put("code", "shizuku-configuration-required").put("reason", "shizuku-configuration-required")
      .put("guidance", "UserService 未确认本应用身份，请重置连接后重试。")
    if (applyGate) actualIdentityRefusal(context, remote)?.let { return null to it }
    return remote to null
  }

  /**
   * 特权 shell 执行（uid 2000）：`sh -c <command>`，PATH 前置系统目录（F3 远端 PATH 污染修复同源）。
   * capture=true 时大输出落 shell 侧 spool 文件，只回报前 8 KiB 与文件坐标（filePath/size）。
   *
   * ── issue #262「命令面引号逃逸」在本方案下的处置（2026-09-30 对账登记）──────────────
   * issue 原文点名：`argv = [sh, -c, PREFIX+command]` 形态下，模型传 `'; id -u; '` 会**逃逸回 root**，
   * 并规定「任何**降权/包装**方案必须走 argv（命令作为单个 argv 元素）」。
   *
   * 本仓现状 = issue 的**方案 A**（策略门 + 免责门 + 通道身份探测，**不做降权包装**）：
   * 命令本就按通道身份（uid 0 或 2000）执行，不存在「被包装后逃逸出去」的对象 ⇒ 该向量在 A 下
   * **不成立**，故此处不改为 argv 形态（改了也只是同一件事换个写法，不增加任何隔离）。
   *
   * ⚠️ **硬约束（留给将来）**：一旦引入任何降权/包装（如 `su -c "setuidgid N ..."` 形态），
   * 必须把待执行命令作为**单个 argv 元素**传入（`ProcessBuilder(listOf(wrapper, "sh", "-c", command))`
   * 或 AIDL 的 argv 数组），**绝不把 command 拼进被包装的 shell 字符串里**——否则模型可用引号
   * 逃出包装、以包装者的身份执行（issue 已实测该逃逸）。
   */
  fun runShell(context: Context, command: String, timeoutMs: Int = SHELL_TIMEOUT_MS, capture: Boolean = false): JSONObject = RootExecutionFence.command(context) {
    runShellInternal(context, command, timeoutMs, capture)
  }

  private fun runShellInternal(context: Context, command: String, timeoutMs: Int = SHELL_TIMEOUT_MS, capture: Boolean = false): JSONObject {
    if (command.isBlank()) {
      return JSONObject().put("ok", false).put("code", "shell-empty").put("guidance", "空命令")
    }
    val (remote, refusal) = readyService(context)
    if (remote == null) return refusal ?: unavailableShell()
    val timeout = timeoutMs.coerceIn(1_000, MAX_SHELL_TIMEOUT_MS)
    val argv = arrayOf("sh", "-c", SHELL_PATH_PREFIX + command)
    val lease = RpcLease(context, if (capture) "shizuku-capture" else "shizuku-exec")
    return try {
      // argv/timeout and all local setup are complete before the final dispatch-point check.
      lease.beforeRpc(remote)?.let { return it }
      val reply = if (capture) remote.execCapture(argv, timeout, 8 * 1024) else remote.exec(argv, timeout)
      lease.acknowledged()
      val result = bundleJson(reply).put("transport", "shizuku")
      if (capture) {
        result.remove("inline")
        result.remove("path")
        result.put("stdout", String(reply.getByteArray("inline") ?: ByteArray(0), Charsets.UTF_8))
          .put("filePath", if (reply.getBoolean("spoolReady")) reply.getString("path") ?: "" else "")
      } else result.put("stdout", reply.getString("stdout") ?: "")
      lease.complete(result, executionDefinitive(reply) && (!capture || reply.getBoolean("spoolReady")))
    } catch (failure: Throwable) {
      lease.complete(shellFailure(failure), definitive = false)
    }
  }

  /** 远端 → 应用私有目录（files/...）分块取回（pull 语义）。 */
  fun pullFile(context: Context, remote: String, local: String): JSONObject = RootExecutionFence.command(context) {
    pullFileInternal(context, remote, local)
  }

  private fun pullFileInternal(context: Context, remote: String, local: String): JSONObject {
    val target = engineLocalFile(context, local)
      ?: return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地落点必须是应用私有目录内的路径（files/...）：$local")
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    val lease = RpcLease(context, "shizuku-pull")
    var offset = 0L // Only bytes acknowledged by the remote and committed to the local sink.
    return try {
      target.parentFile?.mkdirs()
      java.io.FileOutputStream(target).use { sink ->
        while (true) {
          lease.beforeRpc(remoteSvc)?.let { return transferFacts(it, offset) }
          val chunk = remoteSvc.readChunk(remote, offset, PULL_CHUNK)
          lease.acknowledged()
          if (chunk == null) return transferFacts(lease.complete(shellFailure(
            IllegalStateException("远端不可读（不存在或权限不足）：$remote"))), offset)
          if (chunk.isEmpty()) break
          if (chunk.size > PULL_CHUNK || chunk.size.toLong() > MAX_TRANSFER_BYTES - offset) {
            return transferFacts(lease.complete(JSONObject().put("ok", false).put("code", "shell-output-too-large")
              .put("guidance", "远端文件超过传输上限：$remote")), offset)
          }
          sink.write(chunk)
          offset += chunk.size
        }
      }
      lease.complete(JSONObject().put("ok", true).put("code", "shell-ok")
        .put("localPath", target.absolutePath).put("path", target.absolutePath).put("size", offset).put("offset", offset))
    } catch (failure: Throwable) {
      transferFacts(lease.failed(failure), offset)
    }
  }

  /** 应用私有目录（files/...）→ 远端分块写入（push 语义）。 */
  fun pushFile(context: Context, local: String, remote: String): JSONObject = RootExecutionFence.command(context) {
    pushFileInternal(context, local, remote)
  }

  private fun pushFileInternal(context: Context, local: String, remote: String): JSONObject {
    val source = engineLocalFile(context, local)
      ?: return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地来源必须是应用私有目录内的路径（files/...）：$local")
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    if (!source.isFile) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地文件不存在：$local")
    }
    if (source.length() > MAX_TRANSFER_BYTES) {
      return JSONObject().put("ok", false).put("code", "shell-output-too-large")
        .put("guidance", "本地文件超过传输上限：$local")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    val lease = RpcLease(context, "shizuku-push")
    var offset = 0L // Acknowledged successful chunks; never guess bytes written by a failed RPC.
    return try {
      java.io.FileInputStream(source).use { input ->
        val buf = ByteArray(PULL_CHUNK)
        var sent = false
        while (true) {
          val n = input.read(buf)
          if (n < 0 && sent) break
          if (n == 0) continue
          val count = n.coerceAtLeast(0) // Empty source still dispatches one truncating empty write.
          if (count.toLong() > MAX_TRANSFER_BYTES - offset) return transferFacts(lease.complete(
            JSONObject().put("ok", false).put("code", "shell-output-too-large")), offset)
          val slice = if (count == buf.size) buf else buf.copyOf(count)
          val append = offset > 0
          // Local read/copy completed: recheck actual UID + current effective consent EVERY chunk.
          lease.beforeRpc(remoteSvc)?.let { return transferFacts(it, offset) }
          val reply = remoteSvc.writeChunk(remote, slice, append)
          lease.acknowledged()
          if (!reply.containsKey("ok")) return transferFacts(lease.complete(
            JSONObject().put("ok", false).put("code", "shell-write-failed"), definitive = false), offset)
          if (!reply.getBoolean("ok")) {
            return transferFacts(lease.complete(JSONObject().put("ok", false).put("code", "shell-write-failed")
              .put("failedChunkMayBePartial", true)
              .put("guidance", "远端写入失败：" + (reply.getString("error") ?: "") + "（$remote）")), offset)
          }
          offset += count
          sent = true
        }
      }
      lease.complete(JSONObject().put("ok", true).put("code", "shell-ok")
        .put("remotePath", remote).put("path", remote).put("size", offset).put("offset", offset))
    } catch (failure: Throwable) {
      transferFacts(lease.failed(failure), offset)
    }
  }

  /** 远端删除（rm -f 语义；幂等）。 */
  fun removeRemote(context: Context, remote: String): JSONObject = RootExecutionFence.command(context) {
    removeRemoteInternal(context, remote)
  }

  private fun removeRemoteInternal(context: Context, remote: String): JSONObject {
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    val lease = RpcLease(context, "shizuku-remove")
    return try {
      lease.beforeRpc(remoteSvc)?.let { return it }
      val reply = remoteSvc.removePath(remote)
      lease.acknowledged()
      lease.complete(JSONObject().put("ok", reply.getBoolean("ok"))
        .put("code", if (reply.getBoolean("ok")) "shell-ok" else "shell-remove-failed")
        .put("guidance", reply.getString("error") ?: "").put("remotePath", remote), reply.containsKey("ok"))
    } catch (failure: Throwable) {
      lease.complete(shellFailure(failure), definitive = false)
    }
  }

  /** 引擎相对路径（`files/...`）→ 应用私有目录内的绝对文件；越界一律拒绝（fail-closed）。 */
  private fun engineLocalFile(context: Context, raw: String): java.io.File? {
    if (raw.isBlank()) return null
    val f = if (raw.startsWith("/")) java.io.File(raw) else java.io.File(context.dataDir, raw)
    val canon = runCatching { f.canonicalFile }.getOrNull() ?: return null
    val root = runCatching { context.filesDir.canonicalFile }.getOrNull() ?: return null
    val rootPath = root.path
    return canon.takeIf { it.path == rootPath || it.path.startsWith(rootPath + java.io.File.separator) }
  }

  private fun shellFailure(t: Throwable): JSONObject = JSONObject()
    .put("ok", false)
    .put("code", "shell-transport-failed")
    .put("guidance", "Shizuku shell 通道失败：" + t.javaClass.simpleName + ": " + (t.message ?: ""))

  /**
   * issue #262 方案 A：root 通道授权门（策略门 + 知情同意，**不是技术沙箱**）。
   *
   * 判据用**通道身份**而不是「设备是否 root」：只有 Shizuku 服务端以 root 启动（uid=0）
   * 时本门才生效；uid=2000（ADB 启动）或读不到 uid 的通道维持既有语义，不受影响。
   * uid 0 且未授权 ⇒ 特权执行面整体拒绝——uid 0 下任意 shell 本就无限制，
   * 「按 op 分类只关掉 root 级 op」是做不到的假隔离（issue 已确证），故不装样子。
   *
   * @return `null` = 放行（非 root 通道，或已授权）；非空 = 结构化拒绝 JSON。
   */
  internal fun rootGateRefusal(context: Context): JSONObject? {
    if (RootGrant.isGranted(context)) return null
    val uid = runCatching { Shizuku.getUid() }.getOrDefault(-1)
    if (uid != RootGrant.ROOT_UID) return null
    return JSONObject()
      .put("ok", false)
      .put("code", "root-grant-required")
      .put("guidance", "Shizuku 通道正以 root（uid 0）运行，而「AI root 权限」未授权：特权通道已按策略关闭。" +
        "到设置页「手机控制」查看免责声明、勾选「已阅读」并开启「AI root 权限」。")
  }

  private fun actualIdentityRefusal(context: Context, remote: ShizukuUserService): JSONObject? =
    dispatchIdentity(context, remote).second

  private fun dispatchIdentity(context: Context, remote: ShizukuUserService,
    applyGate: Boolean = true): Pair<Int, JSONObject?> {
    val uid = runCatching { remote.uid() }.getOrDefault(-1)
    if (uid != 0 && uid != 2000) return uid to JSONObject().put("ok", false)
      .put("code", "shizuku-identity-failed").put("reason", "shizuku-identity-failed")
      .put("guidance", "无法确认实际 UserService 通道身份，请重置连接后再试。")
    if (applyGate && uid == 0 && !RootGrant.isGranted(context)) return uid to JSONObject().put("ok", false)
      .put("code", "root-grant-required").put("reason", "root-grant-required")
      .put("guidance", "AI root 权限未开启或当前版本的免责确认已失效。")
    return uid to null
  }

  /** One lease per actual-root operation; never replay an RPC whose acknowledgement is unknown. */
  private class RpcLease(private val context: Context, private val operation: String,
    private val applyGate: Boolean = true) {
    private var leased = false
    private var inFlight = false
    private var settledResult: JSONObject? = null

    fun beforeRpc(remote: ShizukuUserService): JSONObject? {
      val (uid, refusal) = dispatchIdentity(context, remote, applyGate)
      if (refusal != null) return complete(refusal)
      if (uid == 0 && !leased) {
        RootMaintenanceLease.begin(context, operation)?.let { return it }
        leased = true
        // 派发证据（复审第 2、4 点）：这条租约从此**不能**再被自动清算。证据**落不了盘就不派发**——
        // 与 `begin()` 同一条纪律（"If durability cannot be established, do not launch privileged work"）：
        // 只置 unknown 而照样派发，会让后续 `dispatched=false` 变成「证据没落盘」的假象 ⇒ 有误清风险 ✗。
        if (!RootMaintenanceLease.markDispatched(context, "shizuku")) {
          return complete(JSONObject().put("ok", false)
            .put("code", "root-lease-evidence-unavailable").put("reason", "root-lease-evidence-unavailable")
            .put("guidance", "无法把「已派发」证据落盘，本次不派发特权工作（避免以后误判为未派发）。"), definitive = false)
        }
        // Persisting the lease is local setup: consent/actual identity must be current AFTER it.
        dispatchIdentity(context, remote, applyGate).second?.let { return complete(it) }
      }
      inFlight = true
      return null
    }

    fun acknowledged() { inFlight = false }

    fun complete(out: JSONObject, definitive: Boolean = true): JSONObject {
      if (!definitive || inFlight) out.put("ok", false)
      if (!leased) {
        if (!definitive || inFlight) out.put("noReplay", true).put("rpcResultUnknown", inFlight)
        return out
      }
      settledResult?.let { return it }
      val result = if (!definitive || inFlight) unknown(out, operation + "-result-incomplete")
      else {
        val finished = try { RootMaintenanceLease.finish(context) } catch (_: Throwable) { false }
        if (finished) out else unknown(out, operation + "-lease-finish-failed")
      }
      settledResult = result
      return result
    }

    fun failed(failure: Throwable): JSONObject = complete(shellFailure(failure), definitive = !inFlight)

    private fun unknown(out: JSONObject, reason: String): JSONObject {
      val result = RootMaintenanceLease.markUnknown(context, reason)
      // Keep timeout/drain/read/offset facts at the top level without replacing the quarantine code.
      for (key in out.keys()) if (key !in setOf("ok", "code", "reason", "guidance")) result.put(key, out.get(key))
      return result.put("operationResult", out).put("noReplay", true).put("rpcResultUnknown", inFlight)
    }
  }

  private fun bundleJson(reply: Bundle): JSONObject = JSONObject().apply {
    for (key in reply.keySet()) put(key, reply.get(key))
  }

  private fun executionDefinitive(reply: Bundle): Boolean = reply.getBoolean("resultComplete") &&
    reply.containsKey("exitCode") && reply.getInt("exitCode", -1) >= 0 &&
    !reply.getBoolean("exitTimedOut") && !reply.getBoolean("drainTimedOut") &&
    !reply.getBoolean("cleanupIncomplete") && !reply.getBoolean("truncated") &&
    reply.getString("readError").isNullOrEmpty()

  private fun transferFacts(out: JSONObject, offset: Long): JSONObject = out
    .put("offset", offset).put("size", offset).put("offsetFact", "acknowledged-bytes")
    .put("partial", offset > 0 || out.optBoolean("rpcResultUnknown") || out.optBoolean("failedChunkMayBePartial"))
    .put("noReplay", true)


  private fun unavailableShell(): JSONObject = JSONObject()
    .put("ok", false).put("code", "shizuku-user-service-not-bound")
    .put("guidance", "Shizuku shell 通道未就绪；请在设置页「手机控制」查看状态与引导。")

  /**
   * 「Shizuku 兼容服务在场」的事实判定（0.14.8）。
   *
   * 事实面 = **任一已知管理器包在场**（官方 Shizuku / 分支实现如 Stellar）**或** Shizuku API
   * binder 已收到并 ping 通。旧实现只查官方包名 `moe.shizuku.privileged.api` 并据此短路，
   * 分支实现（管理器包不同、经兼容层提供同一套 API）即使 binder 活着也被判成
   * 「未检测到 Shizuku」——用户可见现象就是「只认官方 Shizuku，不认分支」。
   *
   * 包名表只用于引导（见 [ExternalLinks.SHIZUKU_MANAGER_PACKAGES]）；能力判据以 binder 为准。
   */
  private fun installed(context: Context): Boolean = managerInstalled(context) || binderAlive()

  /** 已知管理器包（官方 + 兼容分支）装了任一：只作引导/兜底事实，不单独否决能力。 */
  @Suppress("DEPRECATION")
  private fun managerInstalled(context: Context): Boolean =
    ExternalLinks.SHIZUKU_MANAGER_PACKAGES.any { pkg ->
      runCatching { context.packageManager.getPackageInfo(pkg, 0) }.isSuccess
    }

  /** Shizuku API binder 是否已收到且存活（官方与兼容实现同一条判据，不猜实现方是谁）。 */
  private fun binderAlive(): Boolean = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
}

