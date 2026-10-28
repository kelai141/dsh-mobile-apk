package com.dsharnessmobile.shell

import android.app.Activity
import org.json.JSONObject
import java.io.File

/**
 * 「检查更新 = 下载 APK 然后更新」（0.14.6，用户指令）在壳侧的**单一真源**状态机。
 *
 * ## 为什么必须是一份状态（Lead 裁决，2026-10-11）
 *
 * 旧实现把更新状态放在 [GuidePageRenderer] 的私有字段里（apkPending / apkReadyToInstall / apkBusy），
 * 推进逻辑全在引导页渲染器内部，状态**只通过改引导页按钮文案**表达；而健康态走 showWeb() 把引导页
 * 藏起来 —— 于是「状态机长在视图里，视图一藏状态就不可达」，这既是「健康态没有更新入口」的代码级成因，
 * 也意味着**任何新入口只要另起一套状态就会与引导页打架**（引导页下载到 50%，设置页显示「未开始」）。
 *
 * 故本文件是**唯一**状态持有者与推进者：引导页按钮与设置页那一行读同一份状态（[observe]）。
 * 禁止在任何其它文件里新写第二套更新状态。
 *
 * ## 职责切分
 *  - [ApkUpdateState]：纯状态 + JSON，无 Android 依赖 → JVM 单测（取值、转移、文案）；
 *  - [ApkUpdateController]：把动作接到**既有**能力上（[UpdateChecker.checkLatest] / [UpdateChecker.download] /
 *    [verifyApkArtifact] / [UpdateChecker.verifySha256] / [UpdateChecker.invokeInstaller] /
 *    [UpdateChecker.canInstall] / [UpdateChecker.requestInstallPermission]）——**不重写任何一条**。
 *
 * ## 纪律
 *  - **未知/只读动作不改状态**；只有 check / start 推进状态机；
 *  - 检查失败与「已是最新」**都不进引擎快照更新链**（那条链已下线：UpdateManager.DEFAULT_MANIFEST_URL
 *    为空且零生产覆盖点，留着只会让用户以为在更新应用）；
 *  - 全程**无自动请求**：没有任何自动检查、自动下载路径，必须用户显式点击。
 */
internal class ApkUpdateState {

  private val lock = Any()

  private var state: String = STATE_IDLE
  private var version: String? = null
  private var tag: String? = null
  private var name: String? = null
  private var sizeBytes: Long = 0L
  /**
   * 本次发布声明的产物摘要（小写十六进制）。可下载更新必须带有有效摘要。
   *
   * 为什么在这里留一份而不是每次回查 [UpdateChecker.CheckResult]：快照是渲染层唯一能读到的事实面，
   * 而 Available 只在检查那一瞬间在场。缺失时快照里直接不出现该字段——界面据此如实说明
   * 「本次发布未提供校验值」，不能把「缺席」说成「已校验通过」。
   */
  private var sha256: String? = null
  private var percent: Int = -1
  private var reused: Boolean = false
  private var reason: String? = null
  private var kind: String? = null
  private var current: String? = null
  /**
   * 当前状态 JSON（`ok` 只表达「这次调用受理了没有」，**不表示更新成功**）。
   *
   * `canStart` = `state == available` —— 与 [beginDownload] 的受理判据**同一表达式**。
   *
   * 真因：旧实现把 canStart 绑在一个单独的「有没有待装新版」字段上，而 beginDownload 的受理条件是
   * 「state == available **且** 该字段非空」——**canStart 的语义弱于真实受理条件**，于是允许出现
   * 「说可以开始、其实不受理」的分裂。0.14.6 实测形态：`onDownloadFailed` 漏清该字段 =>
   * `state:"failed"` 与 `canStart:true` 并存 => 页面按契约改发 install => 壳侧回 busy =>
   * 用户点重试永远得到「上一次更新动作仍在进行中」，除杀应用外无出路。
   * 现在只有一个真源（state），分裂在结构上不可能出现，并由 [ApkUpdateController.invariantViolation] 断言。
   *
   * `hasReadyArtifact` 走**入参**而不是本类字段：那个事实的持有者是控制器（readyToInstall 的生命周期
   * 与 state 刻意不同，见控制器字段说明），在 state 里再存一份就是第二个真源——正是上面这段讲的病。
   * 本类只负责把给进来的事实按统一形状写进 JSON，且**每个相位都写**：页面按「缺席即没有」兼容，
   * 但恒有布尔值才是干净事实，也不会被误读成「这一相位不适用」。
   *
   * @param ok 这次调用受理了没有（不表示更新成功）。
   * @param hasReadyArtifact 已下载且校验通过、仍在等安装的包是否还在（由控制器传入）。
   */
  fun snapshotJson(ok: Boolean = true, hasReadyArtifact: Boolean = false): String = synchronized(lock) {
    val o = JSONObject()
    o.put("ok", ok)
    o.put("state", state)
    version?.let { o.put("version", it) }
    tag?.let { o.put("tag", it) }
    name?.let { o.put("name", it) }
    current?.let { o.put("current", it) }
    if (sizeBytes > 0) o.put("sizeBytes", sizeBytes)
    sha256?.let { o.put("sha256", it) }
    if (percent >= 0) o.put("percent", percent)
    if (state == STATE_INSTALLING) o.put("reused", reused)
    reason?.let { o.put("reason", it) }
    kind?.let { o.put("kind", it) }
    o.put("canStart", state == STATE_AVAILABLE)
    o.put("hasReadyArtifact", hasReadyArtifact)
    o.toString()
  }

  fun stateName(): String = synchronized(lock) { state }
  fun reasonText(): String? = synchronized(lock) { reason }
  fun tagText(): String? = synchronized(lock) { tag }
  /** 已是最新时的当前版本（形如 `v0.14.5-fx-2`）。 */
  fun versionText(): String? = synchronized(lock) { version }
  fun sizeBytesValue(): Long = synchronized(lock) { sizeBytes }
  /** 下载进度（0..100；未在下载时为 -1）。 */
  fun percentValue(): Int = synchronized(lock) { percent }

  /**
   * 是否处于「不能并发再发起」的相位（check 与 start 共用这一判据）。
   *
   * #12（2026-10-25 审计）：**不再含 [STATE_INSTALLING]**。INSTALLING 是「控制权已交给系统安装器」
   * 的相位：用户在系统侧**取消安装器**后没有任一路径能把状态推走，而旧 busy 含它 ⇒
   * `beginCheck` 永久拒绝——引导页却在 INSTALLING 态把检查按钮渲染为**可点**（渲染层注释
   * 「恢复可检查」），按钮点了恒无响应，更新面死锁到杀应用。取消安装器的事实出路就是再查一轮：
   * 安装器已拿到 APK，重新 check 不丢任何载荷。与 [inFlight] 的分工见该函数注释。
   */
  fun busy(): Boolean = synchronized(lock) {
    state == STATE_CHECKING || state == STATE_DOWNLOADING
  }

  /**
   * 是否**在本进程手里进行中**（检查/下载）。判据与 [busy] 刻意分开：
   * [STATE_INSTALLING] 已把控制权交给系统安装器，本进程不再有可超时的动作，
   * 故超时兜底定时器在这种情况下必须解除（否则会留一个到点必然 no-op 的悬空任务）。
   */
  fun inFlight(): Boolean = synchronized(lock) {
    state == STATE_CHECKING || state == STATE_DOWNLOADING
  }

  /**
   * 受理一次检查：正在检查/下载/安装中则**拒绝**（不排队、不抢占）。
   * @return true = 已进入 checking（调用方负责真正发起网络检查）
   */
  fun beginCheck(): Boolean = synchronized(lock) {
    if (busy()) return false
    state = STATE_CHECKING
    version = null; tag = null; name = null; sizeBytes = 0; percent = -1; reused = false
    // 新一轮检查带的是新发布的元数据：上一轮的摘要留着会把旧值贴到这次的结果上。
    sha256 = null
    reason = null; kind = null
    true
  }

  /** 检查完成：已是最新（带当前版本）/ 发现新版（带 tag 与体积）/ 失败（带分类与**原样**可读原因）。 */
  fun onCheckResult(result: UpdateChecker.CheckResult, currentVersion: String) = synchronized(lock) {
    when (result) {
      is UpdateChecker.CheckResult.UpToDate -> {
        state = STATE_UP_TO_DATE
        version = "v" + currentVersion
        current = currentVersion
      }
      is UpdateChecker.CheckResult.Available -> {
        state = STATE_AVAILABLE
        tag = result.tag; name = result.name; sizeBytes = result.sizeBytes
        sha256 = result.sha256
        current = currentVersion
      }
      is UpdateChecker.CheckResult.Failed -> {
        state = STATE_FAILED
        reason = result.reason
        kind = result.kind.name
      }
    }
  }

  /**
   * 受理一次下载安装：只有「已发现新版」（`state == available`）才受理。
   * **本判据与快照里的 `canStart` 是同一表达式**（单一真源，见 snapshotJson 的说明）——
   * 页面读 canStart 决策时，得到的就是这里会不会受理的事实。
   */
  fun beginDownload(): Boolean = synchronized(lock) {
    if (state != STATE_AVAILABLE) return false
    state = STATE_DOWNLOADING
    percent = 0
    reason = null; kind = null
    true
  }

  fun onDownloadProgress(pct: Int) = synchronized(lock) {
    if (state == STATE_DOWNLOADING) percent = pct.coerceIn(0, 100)
  }

  /**
   * 下载/校验失败：kind ∈ [KIND_DOWNLOAD_FAILED] / [KIND_ARTIFACT_REJECTED]。
   *
   * 与 [onFailed] 同形（同一批终态字段一起落），**不需要**再手工清一个「待装新版」标记——
   * 该标记已删除，`canStart` 由 state 派生：失败即不可 start，页面据此改发 check 重试。
   */
  fun onDownloadFailed(reasonText: String, kindName: String) = synchronized(lock) {
    state = STATE_FAILED
    reason = reasonText
    kind = kindName
    percent = -1
    // 失败的产物已删除：这份摘要不再对应任何在场文件，留着就成了一句没根据的「已校验」。
    sha256 = null
  }

  /** 下载完成且产物校验通过、系统安装器已拉起（reused = 复用了上次下好的包，没重复拉 169MB）。 */
  fun onInstalling(reused: Boolean) = synchronized(lock) {
    state = STATE_INSTALLING
    this.reused = reused
    percent = -1
    reason = null
  }

  /**
   * 未持「安装未知应用」权限、授权页已拉起：等用户授权返回后由 settle 续继。
   *
   * **刻意不是「终态」**（因此不适用「终态要清干净」的直觉）：`need-permission` 是**中间相位**，
   * 用户去系统页授权后仍要续继安装 —— 续继链靠 `ApkUpdateController.readyToInstall`，
   * 清掉它就断了续继（用户授权回来却发现无事可做），那比本轮的 busy 死循环更坏。
   * 将来做「统一清理」必须按判据「**是否还有一条路会用到它**」决定，而不是「是否已脱离进行中」。
   * 本相位不得被当作终态处理，由 `ApkUpdateControllerTest` 的续继链用例钉住。
   */
  fun onNeedPermission() = synchronized(lock) {
    state = STATE_NEED_PERMISSION
    percent = -1
  }

  fun onFailed(reasonText: String, kindName: String? = null) = synchronized(lock) {
    state = STATE_FAILED
    reason = reasonText
    kind = kindName
    percent = -1
    // 同上：失败态不保留一份找不到对应文件的摘要。
    sha256 = null
  }

  fun awaitingPermission(): Boolean = synchronized(lock) { state == STATE_NEED_PERMISSION }

  companion object {
    const val STATE_IDLE = "idle"
    const val STATE_CHECKING = "checking"
    const val STATE_UP_TO_DATE = "up-to-date"
    const val STATE_AVAILABLE = "available"
    const val STATE_DOWNLOADING = "downloading"
    const val STATE_INSTALLING = "installing"
    /** 未持安装权限、授权页已拉起（等用户授权返回）。 */
    const val STATE_NEED_PERMISSION = "need-permission"
    const val STATE_FAILED = "failed"

    /** 安装路径的三类失败（与 [UpdateChecker.CheckResult.FailureKind] 的 8 类合起来构成 kind 闭集）。 */
    /** 超时未收敛（检查或下载）：与「服务端明确报错」区分开——这是本地判定，不是上游结论。 */
    const val KIND_TIMEOUT = "TIMEOUT"
    const val KIND_DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    const val KIND_ARTIFACT_REJECTED = "ARTIFACT_REJECTED"
    const val KIND_INSTALLER_UNAVAILABLE = "INSTALLER_UNAVAILABLE"
  }
}

/**
 * 更新动作的唯一推进者（进程内、Activity 作用域）。
 *
 * 两种消费面读**同一对象**：
 *  - 设置页（React 页面）经**唯一的**桥方法 [AndroidBridge.apkUpdate]`(action)` 发起动作
 *    （`"status"` / `"check"` / `"install"`），再「轮询读 status」收敛（同步桥不能回 Promise，
 *    故不能用 await）；壳侧**不向 `window.__dshBridge` 写任何回调** —— 那个共享对象被页面侧
 *    PICKER_SCRIPT 整体赋值且有幂等守卫，挂回调有「被整体跳过」或「覆盖掉 onDirectoryPicked」的风险；
 *  - 引导页两个按钮经 [onCheckPressed] / [onDownloadPressed] 发起、经 [observe] 渲染
 *    （与设置页共用同一份状态与同一对受理入口：桥面的 check/install 就是转发到这两个方法）。
 *
 * @param onEvent 事件出口（函数名 + JSON），由 Activity 注入并投递到页面；默认空实现 = 无页面消费。
 */
internal class ApkUpdateController(private val activity: Activity) {

  private val state = ApkUpdateState()

  /**
   * 已下载待安装的包。**生命周期刻意与 [state] 不一致**（后者只是「对外事实」）：
   *  · 置位：产物校验通过后暂存，等待安装；
   *  · 留在原地的相位：`need-permission`（用户去系统页授权，返回后必须还能续继安装——**清掉它
   *    就断了续继链**，用户授权回来却发现无事可做）与 `installer-unavailable`（可重试）；
   *  · 清空：系统安装器**真的拉起**后（此时这个包不再需要）。
   * 判据是「**是否还有一条路会用到它**」，不是「状态是不是终态」——将来做统一清理必须按这条判据走。
   */
  @Volatile private var readyToInstall: File? = null

  /**
   * 「已校验、允许安装」的产物 + 它的校验依据（issue #676）。
   *
   * 为什么必须留依据：install() 旧实现只判 `dest.exists()`。「安装未知应用」授权页可以停留任意久，
   * 期间另一个持 All Files Access 的应用完全能把同名 APK 换成别的字节——等用户授权回来，装进
   * 安装器的是 T0 时刻的校验结论、T1 时刻的字节。所以这里把结论连同大小/摘要一起存下，
   * 拉起安装器**之前**重跑一次 [verifyApkArtifact]（成本是一次 169MB 的 SHA-256，1-2 秒）。
   */
  private data class VerifiedArtifact(val file: File, val expectedBytes: Long, val expectedSha256: String)
  @Volatile private var verifiedArtifact: VerifiedArtifact? = null

  /**
   * 已检查到的新版（下载入口的载荷）。
   *
   * **生命周期判据 = 「是否还有一条路会用到它」**（与 [readyToInstall] 同一口径，但取值不同）：
   *  · 只有 **state ∈ {available, downloading}** 时它才有意义 —— 前者是 `.available()` 的依据，
   *    后者是下载线程正在用的入口；
   *  · 一旦离开这两个相位（检查无新版 / 下载失败 / 进入安装阶段）就清空，**不留脏载荷**：
   *    下载失败后的重试路径是 **check**（见 [ApkUpdateState.onDownloadFailed] 与 `canStart` 的派生说明），
   *    不是复用一份可能已损坏的元数据。
   * 不变量由 [invariantViolation] 断言（测试逐相位钉住）。
   */
  @Volatile private var currentResult: UpdateChecker.CheckResult.Available? = null
  /**
   * 界面渲染回调的**多播**登记表（引导页与管理中心都要注册；状态每变一次通知一次）。
   *
   * 为什么必须是多播而不是单个槽位：单槽位是「后注册者夺槽」结构，第二个消费方一注册，
   * 第一个就再也收不到通知——启动页那张更新卡片因此永不刷新（用户点第一次没反馈、
   * 点第二次才静默开始下载 169MB）。两个消费方本就不该互相顶替，槽位形态本身就是缺陷。
   * 登记表的读写由 [ObserverRegistry] 自己加锁：登记/取消发生在 UI 线程，通知也可能来自工作线程。
   */
  private val observers = ObserverRegistry()
  /**
   * **终态兜底定时器**（缺陷修复，见 [ApkUpdateState.Companion.CHECK_TIMEOUT_MS] 的说明）。
   * 每次进入进行中相位都重新武装；落到任何终态或释放即解除。到点必收敛，不依赖回执到达。
   */
  private val watchdogHandler = android.os.Handler(android.os.Looper.getMainLooper())
  private val watchdog = Runnable { onTimeout() }

  /**
   * 会话代次（#9，2026-10-25 审计）：每次**受理**新动作 +1；超时/释放等非属主终态也 +1。
   * 后台线程（check / download）带着发起时的代次回写，代次不符即整条作废——否则超时把状态
   * 判成 FAILED 之后，迟到的网络结果还会把 FAILED 覆盖成 AVAILABLE/INSTALLING；最坏形态是
   * 旧下载线程未被取消、用户重试后两个线程并发写同一个目标文件。
   */
  private val epoch = java.util.concurrent.atomic.AtomicInteger(0)
  private val publicationLock = Any()
  private var checkDeadline: UpdateCheckDeadline? = null

  private fun advanceEpoch(): Int = synchronized(publicationLock) { epoch.incrementAndGet() }

  private fun isCurrentEpoch(e: Int): Boolean = epoch.get() == e

  /** 作废一切在途回写（超时、界面销毁等非属主终态调用）。 */
  private fun invalidateInFlight() {
    advanceEpoch()
  }

  /**
   * 状态与私有载荷的一致性不变量（纯读，供测试逐相位钉住）。
   *
   * 存在理由：两个字段表示同一件事（「有没有一个可下载的新版」）是 0.14.6 那个死循环的温床。
   * 已经消掉一半（`canStart` 改为由 state 派生），另一半用本断言守住：
   * 载荷非空 ⟺ state ∈ {available, downloading}。
   * @return null = 一致；非 null = 违反说明。
   */
  internal fun invariantViolation(): String? {
    val s = state.stateName()
    val hasPayload = currentResult != null
    val payloadAllowed = s == ApkUpdateState.STATE_AVAILABLE || s == ApkUpdateState.STATE_DOWNLOADING
    if (hasPayload != payloadAllowed) {
      return "载荷/状态不同步：state=" + s + " 但 " + (if (hasPayload) "有" else "无") + "待下载载荷"
    }
    // canStart 必须与「真的能开始下载」一致 —— 页面正是按它决定发 install 还是 check。
    val canStart = JSONObject(state.snapshotJson()).optBoolean("canStart")
    if (canStart != (s == ApkUpdateState.STATE_AVAILABLE)) {
      return "canStart 与状态不一致：state=" + s + " canStart=" + canStart
    }
    return null
  }

  /**
   * 界面注册渲染回调：**读的就是本对象的状态**（单一真源）。
   *
   * 注册即先渲染一次（否则新出现的消费方要等下一次状态变化才有内容）；返回的句柄用于注销，
   * 视图销毁时必须调用，否则已死的渲染闭包会一直被通知到。
   * @return 取消句柄（幂等：重复调用无副作用）。
   */
  fun observe(render: () -> Unit): () -> Unit {
    observers.add(render)
    render()
    return { observers.remove(render) }
  }

  private fun notifyChanged() {
    if (observers.size() == 0) return
    if (activity.isFinishing || activity.isDestroyed) return
    activity.runOnUiThread {
      if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
      // 在 UI 线程重新取快照：投递到执行之间被注销的观察者，不该再收到这一次通知。
      observers.dispatch()
    }
  }

  /**
   * **桥面唯一入口**：路由 status / check / install（见 [ApkUpdateController.route]）。
   * 未知动作只读——绝不因为页面传了个没见过的动作就推进状态机。
   */
  fun handleBridgeAction(action: String): String =
    // check / install 与原生按钮走**同一对**受理入口：两条面各维护一套受理条件，迟早给出
    // 不同答案（页面显示的按钮与壳侧会不会受理脱节）。下载入口已把续继链算进去，并把拒绝原因
    // 做成机器可读的 code（busy / no-pending / not-available）——回执面因此没有丢。
    ApkUpdateController.route(action, { statusJson() }, { onCheckPressed(); statusJson() }, { onDownloadPressed() })

  /** 引导页/设置页渲染用的只读状态视图（**读的就是那份唯一状态**）。 */
  fun stateName(): String = state.stateName()
  fun reason(): String? = state.reasonText()
  fun tag(): String? = state.tagText()
  fun version(): String? = state.versionText()
  fun sizeBytes(): Long = state.sizeBytesValue()
  fun percent(): Int = state.percentValue()

  /**
   * 已下载且校验通过、还在等安装的包是否仍在。
   *
   * 判据给渲染层用：失败态只有「手上还有一个验证过的包」时重试安装才真的会受理，
   * 否则按钮点下去只是再失败一次。这是 [readyToInstall] 的只读面——渲染层不可能靠
   * kind 之类旁证推断出它（那是假判据）。
   */
  fun hasReadyArtifact(): Boolean = readyToInstall?.isFile == true

  /**
   * 快照的统一出口：state 的那份对外事实 + 控制器私有载荷派生出的 `hasReadyArtifact`。
   *
   * 为什么由控制器传而不是在 [ApkUpdateState] 里存一个字段：readyToInstall 的生命周期与 state
   * 刻意不同（见字段说明），在 state 里再存一份同义标记就是本文件反复警告的双源温床。
   * 这里只是把**已有的**只读事实（[hasReadyArtifact]）作为入参交给 state 写进同一份 JSON。
   *
   * `hasReadyArtifact` 每个相位都发、恒为布尔：页面据此决定失败态要不要露出「重试安装」。
   * 若缺席，页面只能按旁证猜——那会把按钮摆在点了必然被拒的相位上。
   */
  private fun snapshotObject(ok: Boolean = true): JSONObject = synchronized(publicationLock) {
    JSONObject(state.snapshotJson(ok, hasReadyArtifact()))
  }

  /**
   * 只读当前状态 JSON（不发起任何网络/安装动作）。唯一消费方是桥面 `status` 动作。
   * 状态内容的结构化事实与回调载荷同源，页面文案自出。
   */
  fun statusJson(): String = snapshotObject().toString()

  // ── 终态兜底（收敛保证） ─────────────────────────────────────────────────────

  private fun armWatchdog(ms: Long) {
    watchdogHandler.removeCallbacks(watchdog)
    watchdogHandler.postDelayed(watchdog, ms)
  }

  private fun disarmWatchdog() {
    watchdogHandler.removeCallbacks(watchdog)
  }

  /**
   * 到点仍未收敛 → 落如实终态。
   *
   * 只对**进行中**相位生效（终态已被别的路径报过就不再覆盖，避免把「真实失败原因」换成超时文案）。
   */
  private fun onTimeout() {
    synchronized(publicationLock) {
      val text = timeoutReason(state.stateName()) ?: return
      fail(text, ApkUpdateState.KIND_TIMEOUT)
    }
  }

  /**
   * 界面销毁时释放（MainActivity.onDestroy）：解除定时器、**把进行中相位收敛为可解释终态**
   * （否则用户切回来会看到一个永远不会动的「更新中」）。
   */
  fun release() {
    synchronized(publicationLock) {
      disarmWatchdog()
      observers.clear()
      invalidateInFlight() // #9：销毁后仍在跑的网络线程不得再回写状态。
      if (!state.busy()) return
      // 载荷与相位成对作废（同 fail()）：不变量在任何退出路径上都成立。
      currentResult = null
      state.onFailed("更新已中断（应用界面已关闭）——请重新打开后重试")
    }
  }

  /**
   * 相位收尾：**终态一律解除定时器**（不留悬空 Runnable，也不再触发超时覆盖），
   * 然后通知界面观察者按新状态重渲染。
   *
   * 页面（设置页那一行）不用回调，用「发起 + 轮询读 status」两段式读回同一份状态
   * —— 见 dev-section/apk-update.tsx 的口径与 [AndroidBridge.apkUpdate] 的说明。
   */
  private fun settle() {
    if (!state.inFlight()) disarmWatchdog()
    // 每次状态落定都自查一次「载荷/状态」一致性并留痕：这类不一致（正是本轮死循环的成因）
    // 若只靠测试守，运行时仍会静默积累。判据见 [invariantViolation]。
    invariantViolation()?.let { android.util.Log.w(TAG, "apk update state invariant: " + it) }
    notifyChanged()
  }

  // ── 桥面动作（闭集三个：status 只读 / check 发起检查 / install 下载安装） ──────

  /**
   * 发起检查（桥面 `apkUpdate("check")`）。忙时如实回 `{"ok":false,"code":"busy"}`，并**附带当前状态字段**——
   * 页面重新加载后（回调已丢）据此重水合，不必新增只读方法。
   */
  fun check(): String {
    synchronized(publicationLock) {
      if (!state.beginCheck()) {
        // beginCheck 只在真有在途动作（checking/downloading）时拒绝 => busy 是**事实**，不是兜底话术。
        return reject("busy", "上一次更新动作仍在进行中，请稍候")
      }
      val e = advanceEpoch()
      currentResult = null // 进入 checking：旧载荷（若有）立即作废，避免与新一轮检查的结果混用
      val deadline = UpdateCheckDeadline.start(isActive = { isCurrentEpoch(e) })
      checkDeadline = deadline
      armWatchdog(deadline.remainingMs())
      notifyChanged()
      Thread({ runCheck(e, deadline) }, "dsh-apk-update-check").start()
      return snapshotObject().put("code", "accepted").toString()
    }
  }

  /**
   * 对上次检查到的新版执行「下载 → 校验 → 拉起系统安装器」（桥面 `apkUpdate("install")`）。
   *
   * 拒绝时**按真实原因分档**，不得笼统说自己忙（旧实现只要 `currentResult` 非空就回 `busy`，
   * 于是**下载失败后**点重试恒得「上一次更新动作仍在进行中」——而当时没有任何东西在进行中，
   * 用户除杀应用外无出路）。分档判据是 `state.busy()`（真有在途动作）与 state 名：
   *  · 没有待装新版 → `no-pending`；· 确实在途 → `busy`；· 其余（如 failed/up-to-date）→ `not-available`。
   */
  fun start(): String {
    synchronized(publicationLock) {
      // 「下载」这个动作不是只有一种含义：包已经下好并校验通过、只等授权或重试安装时，
      // 它走的是续继链（载荷是 readyToInstall，不是 currentResult）。页面上的「授权后继续安装」
      // 与原生下载按钮发的是同一个动作，此处不先看续继链，那条路就只有原生一侧能走通。
      if (readyToInstall != null || state.awaitingPermission()) return onDownloadPressed()
      val pending = currentResult
      if (pending == null) return reject("no-pending", "没有待安装的新版本，请先点「检查更新」")
      if (!state.beginDownload()) {
        return if (state.busy()) reject("busy", "上一次更新动作仍在进行中，请稍候")
        else reject("not-available", "当前状态（" + state.stateName() + "）不能开始下载，请先点「检查更新」")
      }
      armWatchdog(downloadTimeoutMs(pending.sizeBytes))
      val e = advanceEpoch()
      settle() // 页面立刻看到 downloading（两段式：受理 + 轮询读状态面）
      Thread({ downloadAndInstall(pending, e) }, "dsh-apk-update-download").start()
      return snapshotObject().put("code", "accepted").toString()
    }
  }

  /**
   * 拒绝一次动作：回 `ok:false` + 机器可读 `code` + **用户可读原因**（页面按 code 决策、按 reason 说明）。
   * 附带当前状态字段，页面据此重水合，不做乐观置位。
   */
  private fun reject(code: String, reason: String): String =
    snapshotObject(false).put("code", code).put("reason", reason).toString()

  // ── 引导页动作（与桥面共用同一状态） ────────────────────────────────────────

  /**
   * 原生界面的「检查更新」按钮：**只发检查**。
   *
   * 为什么不再让同一个按钮兼任三态：按钮语义随状态漂移时，用户点下去会得到什么取决于
   * 「上一次操作到哪一步」，同一枚按钮有时检查、有时静默开始下载 169MB。现在检查与下载
   * 各有自己的按钮，且受理判据与渲染层同源（available 态的检查按钮由渲染层禁用，
   * 因为 beginCheck 会清掉待下载载荷——两处表达式一致，见 [ApkUpdateState.snapshotJson] 的 canStart）。
   */
  fun onCheckPressed() {
    if (state.busy()) return
    check()
  }

  /**
   * 原生界面的「下载并安装」按钮：只做「开始下载 / 续继安装」。
   *
   * 分档**只读状态**、不读私有字段：与设置页那一行完全同一套判据。先看续继链（已有下好的包
   * 或正等授权），再看能否开始下载，其余情况什么都不做——状态机没走到那一步时，
   * 受理与否由状态本身回答。
   *
   * 返回受理回执，供桥面的 `install` 动作原样回给页面（原生按钮忽略返回值即可）：
   * 桥面若自己另写一套受理条件，两条面迟早给出不同答案。
   */
  fun onDownloadPressed(): String {
    synchronized(publicationLock) {
      if (state.busy()) return reject("busy", "上一次更新动作仍在进行中，请稍候")
      return when {
        readyToInstall != null || state.awaitingPermission() -> {
          continueInstallIfPermitted()
          snapshotObject().put("code", "accepted").toString()
        }
        state.stateName() == ApkUpdateState.STATE_AVAILABLE -> start()
        // 剩余相位（idle / up-to-date / 没有待装包的 failed）本来就没有可下载的东西。
        // 这里不能说「受理了」：回执要如实，页面才不会按一个不会发生的事实去渲染。
        else -> reject("not-available", "当前状态（" + state.stateName() + "）没有可下载的新版本，请先点「检查更新」")
      }
    }
  }

  // ── 内部推进 ────────────────────────────────────────────────────────────────

  private fun runCheck(e: Int, deadline: UpdateCheckDeadline) {
    val r = try {
      UpdateChecker.checkLatest(deadline)
    } catch (t: Throwable) {
      android.util.Log.w(TAG, "check threw: " + (t.message ?: t.javaClass.simpleName))
      UpdateChecker.CheckResult.Failed("检查更新未完成（详细原因已写入日志）——可重试，或复制日志反馈")
    }
    publishCheckResult(r, e)
  }

  /** Publish the generation check and its result as one operation. */
  internal fun publishCheckResult(r: UpdateChecker.CheckResult, e: Int) {
    synchronized(publicationLock) {
      if (!isCurrentEpoch(e)) return
      if (runCatching { checkDeadline?.remainingMs() }.isFailure) {
        onTimeout()
        return
      }
      if (r is UpdateChecker.CheckResult.Available) currentResult = r else currentResult = null
      state.onCheckResult(r, UpdateChecker.currentVersion())
      settle()
    }
  }

  /** 下载 → 校验 → 安装（复用既有下载链与 [verifyApkArtifact]，判定强度与旧引导页路径完全一致）。 */
  private fun downloadAndInstall(r: UpdateChecker.CheckResult.Available, e: Int) {
    // 名字来自发布元数据 ⇒ 必须过形态白名单与 canonical 父目录判据（见 resolveUpdateTarget）。
    // 直接 File(updatesDir, r.name) 会让带分隔符的 tag 落到任意可写目录，而下面的
    // pruneUpdatesDir(dest.parentFile) 会跟着在那个目录里删 `*.apk`/`*.tmp`。
    val dir = UpdateChecker.updatesDir(activity)
    val dest = UpdateChecker.resolveUpdateTarget(dir, r.name)
      ?: run {
        fail(
          "更新产物的文件名不合法（发布元数据可疑）——请稍后重试或到 GitHub Releases 手动下载",
          ApkUpdateState.KIND_ARTIFACT_REJECTED,
        )
        return
      }
    // issue #676：动手前先清一次目录（留本次目标包），否则每换一版就多一个 169MB 的旧包，
    // 中断下载留下的 .tmp 也永远没人收拾。
    runCatching { UpdateChecker.pruneUpdatesDir(dest.parentFile ?: return, r.name) }
    var reused = false
    try {
      // 摘要随元数据一起来（MANIFEST / releases.json 已带 sha256 列）。旧实现把 sha256Url 当资产去下载，
      // 而发布链从来没产出过 .sha256 附件——那一步恒定失败，校验链因此长期形同虚设。
      val expectedSha = r.sha256
      fun artifactVerdict(): ApkArtifactVerdict = verifyApkArtifact(
        fileExists = dest.exists(),
        actualBytes = dest.length(),
        expectedBytes = r.sizeBytes,
        expectedSha256 = expectedSha,
        sha256Matches = { UpdateChecker.verifySha256(dest, it) },
      )
      if (artifactVerdict() is ApkArtifactVerdict.Accept) {
        reused = true // 上次下完但没装成（授权中断/安装取消）→ 复用已验证的包，不重复拉 169MB
      } else {
        val used = UpdateChecker.download(
          r.apkUrl, dest,
          { pct -> onDownloadProgress(pct, e) },
          allowMirrors = true,
          isActive = { isCurrentEpoch(e) },
          publishIfActive = { publish ->
            synchronized(publicationLock) {
              if (!isCurrentEpoch(e)) false else {
                publish()
                true
              }
            }
          },
        )
        if (used == null) {
          failDownload("下载失败：镜像链全部不可用（直连与加速镜像均失败）——请稍后重试", ApkUpdateState.KIND_DOWNLOAD_FAILED, e)
          return
        }
        // #9：下载期间若已换代（超时/重试），不再碰状态与 dest——新的会话自己会重下/校验。
        if (!isCurrentEpoch(e)) return
        when (val verdict = artifactVerdict()) {
          is ApkArtifactVerdict.Accept -> Unit
          is ApkArtifactVerdict.Reject -> synchronized(publicationLock) {
            if (!isCurrentEpoch(e)) return
            dest.delete()
            failDownload("下载失败：" + verdict.reason + "（文件已删除，请重试）", ApkUpdateState.KIND_ARTIFACT_REJECTED, e)
            return
          }
        }
      }
    } catch (t: Throwable) {
      android.util.Log.w(TAG, "apk download threw: " + (t.message ?: t.javaClass.simpleName))
      failDownload("下载失败：" + (t.message ?: "未知原因") + "——请稍后重试", ApkUpdateState.KIND_DOWNLOAD_FAILED, e)
      return
    }
    // issue #676：把这次的校验依据绑在产物上（下面 install() 拉起安装器前会用它重验字节）。
    verifiedArtifact = VerifiedArtifact(dest, r.sizeBytes, r.sha256)
    val reusedFlag = reused
    // 注意：此处**不**清载荷——install() 在 UI 线程跑且可能落到「需授权」相位，而那一刻才离开
    // downloading。载荷的清零与相位切换成对发生（见 install/failDownload），不变量因此始终成立。
    activity.runOnUiThread {
      synchronized(publicationLock) { if (isCurrentEpoch(e)) install(dest, reusedFlag) }
    }
  }

  private fun onDownloadProgress(pct: Int, e: Int) {
    synchronized(publicationLock) {
      if (!isCurrentEpoch(e)) return
      state.onDownloadProgress(pct)
      notifyChanged()
    }
  }

  private fun failDownload(text: String, kind: String, e: Int) {
    synchronized(publicationLock) {
      // #9：作废会话的失败不落盘（它的超时文案已由 watchdog 写过；再写会把新一轮的状态盖掉）。
      if (!isCurrentEpoch(e)) return
      // 载荷随相位一起作废：失败后的重试路径是 check（重新取元数据），不再复用它。
      currentResult = null
      state.onDownloadFailed(text, kind)
      settle()
    }
  }

  /** 安装步骤必须在 UI 线程（拉起授权页/安装器都是 Activity 动作）。 */
  private fun install(dest: File, reused: Boolean) {
    synchronized(publicationLock) {
      if (activity.isFinishing || activity.isDestroyed) {
        fail("应用界面已关闭，安装已取消——请重新检查更新", ApkUpdateState.KIND_INSTALLER_UNAVAILABLE)
        return
      }
      if (!dest.exists()) {
        // 成组清载荷：这个分支是"作者已经预见到会被清理"的那一支，与下面另两个失败分支一样，
        // 必须把续继链的载荷一起清掉。否则 `readyToInstall` 恒指向一个不存在的文件 ⇒
        // `start()` 永远把请求交给续继链、`hasReadyArtifact()` 恒 true（页面一直摆着「重试安装」），
        // 而真正的新版**永远下不下来**（点「下载并安装」被 redirect 到续继链 → 又落回这支）。
        readyToInstall = null
        currentResult = null
        verifiedArtifact = null
        fail("安装包已不存在（可能被清理）——请重新检查更新", ApkUpdateState.KIND_ARTIFACT_REJECTED)
        return
      }
      // issue #676：授权页可以停任意久，文件在此期间可能被换掉。拉起安装器之前按**当初的校验依据**
      // 重跑一次；字节对不上就拒绝安装（并清掉续继载荷，避免下次「继续安装」把同一个坏包装进去）。
      val verified = verifiedArtifact
      if (verified == null || verified.file.canonicalFile != dest.canonicalFile) {
        readyToInstall = null
        currentResult = null
        verifiedArtifact = null
        fail("安装包的校验依据已丢失（应用可能被重启）——请重新检查更新", ApkUpdateState.KIND_ARTIFACT_REJECTED)
        return
      }
      val recheck = verifyApkArtifact(
        fileExists = dest.exists(),
        actualBytes = dest.length(),
        expectedBytes = verified.expectedBytes,
        expectedSha256 = verified.expectedSha256,
        sha256Matches = { UpdateChecker.verifySha256(dest, it) },
      )
      if (recheck !is ApkArtifactVerdict.Accept) {
        val why = (recheck as? ApkArtifactVerdict.Reject)?.reason ?: "产物校验未通过"
        readyToInstall = null
        currentResult = null
        verifiedArtifact = null
        fail("安装前复验失败：" + why + "——已拒绝安装，请重新检查更新", ApkUpdateState.KIND_ARTIFACT_REJECTED)
        return
      }
      if (!UpdateChecker.canInstall(activity)) {
        // 续继链靠 readyToInstall（**不**靠 currentResult）：载荷已消费完，清掉以满足不变量。
        readyToInstall = dest
        currentResult = null
        val opened = UpdateChecker.requestInstallPermission(activity)
        if (opened) {
          state.onNeedPermission()
          settle()
        } else {
          fail(
            "这个系统没有「安装未知应用」授权页（未能打开）——请在系统设置里手动允许本应用安装应用后重试",
            ApkUpdateState.KIND_INSTALLER_UNAVAILABLE,
          )
        }
        return
      }
      if (UpdateChecker.invokeInstaller(activity, dest)) {
        readyToInstall = null
        currentResult = null
        // issue #676：安装器已拉起，这次的校验依据用完即弃——留着只会让下一轮误以为
        // "手里还有个已校验的包"（真正的依据必须来自本轮的 downloadAndInstall）。
        verifiedArtifact = null
        state.onInstalling(reused)
        settle()
      } else {
        readyToInstall = dest
        fail("安装器拉起失败，请再点「下载并安装」重试", ApkUpdateState.KIND_INSTALLER_UNAVAILABLE)
      }
    }
  }

  private fun fail(text: String, kind: String) {
    synchronized(publicationLock) {
      // #9：非属主终态（超时/安装失败/界面关闭）一律作废在途回写，防迟到线程复活本会话。
      invalidateInFlight()
      // 载荷与相位成对：进入 FAILED 即作废（重试路径是 check / readyToInstall 续继，都不用它）。
      currentResult = null
      state.onFailed(text, kind)
      settle()
    }
  }

  /**
   * 从系统「安装未知应用」授权页返回（MainActivity.onResume）：已授权则续继安装，否则如实说明。
   * 与旧 [GuidePageRenderer.settlePendingInstall] 同一闭环——两入口都不会卡在「等一个不会来的页面」。
   */
  fun settleAfterResume() {
    synchronized(publicationLock) {
      if (!state.awaitingPermission()) return
      val dest = readyToInstall ?: return
      if (activity.isFinishing || activity.isDestroyed) return
      if (UpdateChecker.canInstall(activity)) install(dest, false)
      else fail("尚未获得「安装未知应用」权限——请在系统设置里授权后再试", ApkUpdateState.KIND_INSTALLER_UNAVAILABLE)
    }
  }

  /** 用户再点按钮时：停在「需授权」且已授权则立刻续继安装。 */
  private fun continueInstallIfPermitted() {
    synchronized(publicationLock) {
      val dest = readyToInstall ?: return
      if (activity.isFinishing || activity.isDestroyed) return
      if (UpdateChecker.canInstall(activity)) install(dest, false)
      else {
        // 仍未授权：再拉一次授权页并如实回执（旧实现此处只改 hint，按钮可点但点了没反应）。
        val opened = UpdateChecker.requestInstallPermission(activity)
        if (opened) {
          state.onNeedPermission()
          settle()
        } else {
          fail("这个系统没有「安装未知应用」授权页（未能打开）——请在系统设置里手动允许后重试", ApkUpdateState.KIND_INSTALLER_UNAVAILABLE)
        }
      }
    }
  }

  companion object {
    private const val TAG = "dsh-update"

    /**
     * 桥面动作路由（唯一入口 [AndroidBridge.apkUpdate]）。
     *
     * 保留「单方法 + action」形态而不是把动作摊成三个桥方法：`status` 这个**只读状态面**是
     * 「发起 + 读状态」两段式里必要的另一半（同步桥不能回 Promise），与既有
     * `getNotifySetting`/`setNotifySetting` 面同构；摊开会让以后每加一个可读状态的动作都要再改一次桥接口。
     * 动作名是**闭集**，未知动作**只读**（只回当前状态 + ok=false，绝不推进状态机）。
     *
     * @param statusOf 只读状态提供者（`controller.statusJson`）。
     */
    fun route(action: String, statusOf: () -> String, check: () -> String, install: () -> String): String =
      when (action.trim().lowercase()) {
        ACTION_STATUS -> statusOf()
        ACTION_CHECK -> check()
        ACTION_INSTALL -> install()
        else -> JSONObject(statusOf()).put("ok", false).put("reason", "未知动作：" + action).toString()
      }

    const val ACTION_STATUS = "status"
    const val ACTION_CHECK = "check"
    const val ACTION_INSTALL = "install"

    /**
     * **收敛上限**（缺陷修复：用户实测「检查更新失败会有弹窗，但启动页持续显示更新中转圈」）。
     *
     * 真因不是「失败没被报出来」，而是**没有终态兜底**：任何一条回执被丢弃（代次失配、
     * Activity 不可跑、线程静默死掉、页面重载）都可能让界面停在「进行中」永不收敛。
     * 因此每一步都有确定的时限，到点必然落到如实终态 —— 判据是「发起方保证终结」，
     * 而不是「依赖某条回执恰好到达」。
     *
     * 超时落到哪个如实终态由 [timeoutReason] 决定（纯函数，JVM 可测）。
     */
    fun timeoutReason(stateName: String): String? = when (stateName) {
      ApkUpdateState.STATE_CHECKING ->
        // 秒数取自 [CHECK_TIMEOUT_MS]，避免预算改动后文案继续写死旧值（曾写死「30 秒」，
        // 而实际预算已从 120 秒抬到 200 秒——用户按文案判断"超时不对劲"时会被误导）。
        "检查更新超时（" + (CHECK_TIMEOUT_MS / 1000) + " 秒内没有拿到结果）——请检查网络后重试；这不是本机架构的问题"
      ApkUpdateState.STATE_DOWNLOADING ->
        "下载超时——网络过慢或已中断，本次已放弃；可稍后重试（不会安装未完成或未校验通过的包）"
      else -> null
    }

    /** Shared total budget; each source and redirect also consumes this deadline. */
    const val CHECK_TIMEOUT_MS = UpdateCheckDeadline.TOTAL_MS
    /** 下载上限下限（小包也不会秒判超时）。 */
    const val DOWNLOAD_TIMEOUT_MIN_MS = 3 * 60_000L
    /** 下载上限上限（169MB 在慢网上也不至于被误判）。 */
    const val DOWNLOAD_TIMEOUT_MAX_MS = 30 * 60_000L
    /** 按 300 KB/s 估算下载需要多久（低于此速率的网络由上限兜底）。 */
    const val DOWNLOAD_BYTES_PER_MS = 300L

    /** 按体积给出下载上限：`clamp(体积 / 300KBps, 3min, 30min)`。 */
    fun downloadTimeoutMs(sizeBytes: Long): Long {
      if (sizeBytes <= 0) return DOWNLOAD_TIMEOUT_MIN_MS
      val estimate = sizeBytes / DOWNLOAD_BYTES_PER_MS
      return estimate.coerceIn(DOWNLOAD_TIMEOUT_MIN_MS, DOWNLOAD_TIMEOUT_MAX_MS)
    }
  }
}

/**
 * 渲染回调的登记表（多播）。
 *
 * 为什么单独抽出来：登记/注销/通知是纯粹的表操作，与 Activity、Handler 无关，因此能在 JVM
 * 单测里逐条钉住「两个消费方都被通知」「注销后不再通知」——这正是单槽位实现漏掉的那条缺陷。
 * 抽在这里也让 [ApkUpdateController] 只负责「什么时候通知」，不掺「通知谁」的簿记。
 */
internal class ObserverRegistry {

  private val lock = Any()
  private val list = mutableListOf<() -> Unit>()

  /** 追加登记；同一回调重复登记按列表语义允许多次（每个句柄各自注销自己那一次）。 */
  fun add(render: () -> Unit) {
    synchronized(lock) { list.add(render) }
  }

  /** 注销一次登记；已注销（或列表已被清空）时无事发生，便于句柄被重复调用。 */
  fun remove(render: () -> Unit) {
    synchronized(lock) { list.remove(render) }
  }

  /** 通知遍历用的快照：回调里登记/注销都不会改变本次遍历的对象。 */
  fun snapshot(): List<() -> Unit> = synchronized(lock) { list.toList() }

  /** 逐个回调当前全部观察者（生产路径由 [ApkUpdateController.notifyChanged] 投递到 UI 线程后调用）。 */
  fun dispatch() {
    snapshot().forEach { it() }
  }

  /** 清空全部登记（界面销毁时释放）。 */
  fun clear() {
    synchronized(lock) { list.clear() }
  }

  /** 当前登记数（诊断与测试用）。 */
  fun size(): Int = synchronized(lock) { list.size }
}

