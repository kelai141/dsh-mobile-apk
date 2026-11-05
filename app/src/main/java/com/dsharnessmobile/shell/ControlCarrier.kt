package com.dsharnessmobile.shell

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject

/**
 * 控制队列承载者：把长轮询从无障碍服务拆出——**a11y 关着也能跑**。
 *
 * 背景：browser 与 vd 两组 op 是 neverA11y 的壳桥 op，此前只由 DeviceControlService 的队列承载；
 * 无障碍关闭时无人轮询 → 「AI 自主建屏 / 浏览器工作台」整条不可达（架构缺口）。
 * 现在承载者随前台引擎服务起停（`EngineService`），op 分发：
 * - browser 与 vd 两组 → 直连各 Holder/分发器（不经过无障碍）；
 * - 其余（语义树/点击/截屏等）→ 已连接的无障碍服务；缺席时结构化拒绝，而不是静默超时。
 *
 * 两条通道独立可用是本类的存在意义：Shizuku 通道与无障碍通道互不为前提，
 * 模型侧任何一套工具都拿到同一份 op 面与同一套结构化错误（体验一致）。
 */
internal object ControlCarrier {
  private const val TAG = "dsh-control-carrier"

  /**
   * neverA11y 的壳桥 op 组（与 scripts/control-ops-pending.json 的 browser/vdisplay 两族逐字对应）。
   *
   * 雷点（0.14.0 设备实测）：本集合**必须与契约逐条对齐**——漏一条的后果不是「拒绝」，
   * 而是该 op 落进 a11y 分支后报**误导性错误**。实测 browserTabs（= browser_list_tabs）漏登记
   * 时，模型拿到的是「需要无障碍服务支持」，于是去开无障碍——而它与无障碍毫无关系。
   */
  private val BROWSER_OPS = setOf(
    "browserCaps", "browserShow", "browserHide", "browserClose", "browserOpen", "browserJs",
    "browserInput", "browserShot", "browserState", "browserSetUa", "browserViewport",
    // 多页签（0.14.0）：AI 同时控制多个网页
    "browserTabs", "browserFollowTab", "browserCloseTab",
  )
  private val VD_OPS = setOf("vdCreate", "vdDestroy", "vdLaunch", "vdMoveTask", "vdInfo", "vdLaunchApp", "vdInput")
  /** 特权 shell 通道（0.14.0 §6：替换内置 adb；同样 neverA11y）。 */
  private val SHELL_OPS = setOf("shExec", "shPull", "shPush", "shRemove")

  /** 无障碍服务连接时登记；断开即清（null = 语义/输入类 op 不可用）。 */
  @Volatile
  var a11y: DeviceControlService? = null

  private var poller: ControlPoller? = null
  private var appContext: Context? = null

  /** Shizuku 特权通道就绪（caps 上报；TTL 缓存——回填信封不为此反复打 binder）；三态，null = 尚未探测完（issue #1506，不作折平）。 */
  private const val SHIZUKU_CACHE_MS = 5_000L
  @Volatile private var shizukuReady: Boolean? = null
  @Volatile private var shizukuCheckedAt = 0L

  private fun shizukuReady(app: Context): Boolean? {
    val now = SystemClock.elapsedRealtime()
    if (now - shizukuCheckedAt < SHIZUKU_CACHE_MS) return shizukuReady
    val ready = runCatching { readinessTriState(ShizukuTransport.status(app)) }.getOrNull() // 三态，不折平：null = 尚未探测完
    shizukuReady = ready
    shizukuCheckedAt = now
    return ready
  }

  /**
   * 让 Shizuku caps 缓存立即失效（设置页「重置链接」调用）。
   *
   * 为什么必须由重置路径调用：本类用 [SHIZUKU_CACHE_MS]（5s）缓存 `shizukuReady`，目的是
   * 「回填信封不为此反复打 binder」。但那个缓存在**用户主动重置**后就成了假信息源：
   * 重置后最多 5 秒内 `caps.shizuku` 仍报旧值，用户会认为按钮没生效。
   * 只把时间戳置 0（而不是顺手改 ready 值）：下一次读取会**重新真问一次** Shizuku——
   * 那是唯一权威面，猜一个值就把「缓存失效」变成了「伪造状态」。
   */
  fun invalidateShizukuCache() {
    shizukuCheckedAt = 0L
  }

  /** 幂等启动（EngineService.onCreate 与无障碍服务连接路径都可调用）。 */
  @Synchronized
  fun ensureStarted(context: Context) {
    val app = context.applicationContext
    appContext = app
    if (poller != null) return
    val created = ControlPoller(
      context = app,
      handler = { op, args -> handle(op, args) },
      // 两条通道的能力事实（0.14.0 §6）：a11y = 无障碍服务在场；shizuku = 特权 shell 通道就绪。
      capsExtra = { JSONObject().put("a11y", a11y != null).put("shizuku", shizukuReady(app) ?: JSONObject.NULL) },
      heartbeat = { if (a11y != null) DeviceControlService.heartbeat(app) },
    )
    poller = created
    created.start()
    LogCollector.log(TAG, "control carrier started (a11y=" + (a11y != null) + ")")
  }

  @Synchronized
  fun stop() {
    poller?.stop()
    poller = null
    LogCollector.log(TAG, "control carrier stopped")
  }

  /** 统一分发：neverA11y 壳桥 op 直连；a11y 类 op 交给已连接的服务；都不可用则结构化拒绝。 */
  fun handle(op: String, args: JSONObject): JSONObject = when {
    op in BROWSER_OPS -> BrowserHostHolder.control(op, args)
    op in VD_OPS -> {
      val current = appContext
      if (current == null) {
        JSONObject()
          .put("__error", "控制承载尚未启动（应用上下文缺失）——请重新打开应用。")
          .put("reason", "carrier-not-started")
          .put("op", op)
      } else {
        VdisplayOps.handle(current, op, args)
      }
    }
    op in SHELL_OPS -> {
      val current = appContext
      if (current == null) {
        JSONObject()
          .put("__error", "控制承载尚未启动（应用上下文缺失）——请重新打开应用。")
          .put("reason", "carrier-not-started")
          .put("op", op)
      } else {
        ShellOps.handle(current, op, args)
      }
    }
    else -> {
      // #648 自愈：只有当**无障碍处理器引用为 null**（= 服务未绑定，内存态确定事实）时，
      // 才把 prefs 的 a11yEnabled 回写成 false。
      //
      // 为什么必须限定在这个判据上：prefs 里的 a11yEnabled 会在进程被 force-stop 后变成
      // 「僵尸 true」（onDestroy 不保证执行），而引擎侧 a11ySource() 只认新鲜心跳——心跳
      // 同样会断，于是引擎侧判定为离线、prefs 却还写着 true，两边长期不一致。
      //
      // 明确**不**触发回写的情形（这里是 a11y 已死的确定事实，不是调用成败的推断）：
      //  - handle() 抛异常 / 超时 / 返回 __error：服务在场但操作失败，原因未知，不得据此改状态；
      //  - op 属于 BROWSER_OPS / VD_OPS / SHELL_OPS：与无障碍无关，前面已分流，走不到这里；
      //  - a11y 非 null 但内部失败：同上，不写。
      // 换句话说：回写的唯一依据是「a11y == null」这个引用事实，与任何一次调用的结果无关。
      //
      // 闭环：服务重新连上时 DeviceControlService.onServiceConnected() 会 setEnabledFlag(true)
      // 把 prefs 改回 true（DeviceControlService.kt:459），所以一次回写不会永久写成 false。
      val handler = a11y
      if (handler == null) {
        val ctx = appContext
        if (ctx != null) DeviceControlService.markUnavailable(ctx)
      }
      handler?.handle(op, args) ?: JSONObject()
        .put("__error", "无障碍服务未开启——该操作需要「" + UserCopy.A11Y_SERVICE_NAME + "」无障碍通道；浏览器与虚拟屏操作不受影响。")
        .put("reason", "a11y-unavailable")
        .put("op", op)
    }
  }
}
