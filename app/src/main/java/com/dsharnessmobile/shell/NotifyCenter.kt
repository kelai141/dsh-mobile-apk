package com.dsharnessmobile.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

/**
 * 通知中心（0.14.0-preview §6.1 / §6.3）：五类信道 + 渠道一次性定案 + 迁移 + 自检 + 弹窗/静默形态。
 *
 * 三条不可逆 / 硬约束（写第一行代码前就定死，写在代码里防下一轮被改）：
 *  1. 渠道 importance 创建后应用不能调高（API 26+ setPriority 无效；删除后同 ID 重建是
 *     un-deleted，设置原样回来）。所以弹窗语义的渠道第一次就必须用 HIGH 建；静默语义用
 *     LOW 建。静默将来要变弹窗只能换新渠道 ID（Face.candidates 的候选序列）。
 *  2. 不使用 full-screen intent（§6.1.3 R3 / §6.6 反例 4）：打断性强、授权不确定；
 *     通知点击一律 getActivity 拉起 Activity，动作一律 getBroadcast（规避 trampoline 禁令）。
 *  3. 权限未授予 / 渠道被降级时降级不静默：权限拒绝要回调界面（D9），渠道被用户降级
 *     要在自检面显示「系统已降级，应用无法调回」+ 深链（NT-03）。
 *
 * 形态归属（§6.1.1）：silent/todo = 静默（LOW + setSilent(true) 双保险）；report/question/approval
 * = 弹窗（HIGH + VISIBILITY_PRIVATE + publicVersion）。分类开关五类默认全开（NT-10）。
 */
object NotifyCenter {

  // ── 偏好键（PREFS 沿用历史 "dsh-notify"；channelsInitialized 是 §6.1.2 S6 的一次性标记）──
  const val PREFS = "dsh-notify"

  /**
   * 通知点击的落点载荷（P0-1）。
   *
   * 旧实现把 `sessionId` 与 `agentId` **依次写进同一个 key** `"dsh.notify.target"`（后写覆盖先写），
   * 且全仓没有任何读取者——点通知只是把应用拉到前台，停在原页面。现在按键的**语义**分开，
   * 由 [MainActivity] 读取并路由到对应会话。
   */
  const val EXTRA_KIND = "dsh.notify.kind"
  /** 目标**会话** id（落点主键：打开这个会话）。 */
  const val EXTRA_TARGET_SESSION = "dsh.notify.session"
  /** 目标**agent** id（辅助键：会话尚未建立时的兜底匹配，与 sessionId 不是同一个东西）。 */
  const val EXTRA_TARGET_AGENT = "dsh.notify.agent"
  private const val KEY_CHANNELS_INITIALIZED = "channelsInitialized"
  private const val KEY_SELECTED_PREFIX = "channel."
  private const val KEY_SUPPRESS_FOREGROUND = "suppressForeground"

  /**
   * 前台抑制默认值（0.14.1 块J FIX-3，用户 2026-09-19 拍板取 A）：
   * **false = 前台也投递系统通知（真·实时）**。
   *
   * 旧默认值 true 的后果（详档 §3.1 假设②，源码级确证）：前台时 `Face.REPORT` 命中
   * `deliverEvent` 的抑制分支并 `return SUPPRESSED_FOREGROUND`——终态、不入队、无补投，
   * 而消费侧已推进字节偏移，于是该条永久消失；退到后台后 `isForeground()` 为 false，
   * 条件整体不成立，通知照常投递。**这就是用户上报的「必须划到后台才会推送」**。
   *
   * 公开成常量是为了让门禁/单测断言「默认值」本身，而不是断言源码里的字面量。
   */
  const val DEFAULT_SUPPRESS_FOREGROUND = false

  /**
   * 前台抑制偏好的 schema 代次（存量升级一次性归一化用）。
   * 1 = 「默认不抑制」语义首次生效的那一代。
   */
  private const val KEY_SUPPRESS_SCHEMA = "suppressForegroundSchema"
  private const val SUPPRESS_SCHEMA_CURRENT = 1

  /** 归一化时把**旧值**备份到此键——绝不静默丢弃，便于事后核对存量设备。 */
  private const val KEY_SUPPRESS_LEGACY = "suppressForegroundLegacy"

  /** 固定通知 ID（静默两类单条覆盖，NT-06「通知栏只有 2 条」）。 */
  const val ID_WATCHDOG = 0x1001
  const val ID_TODO = 0x1002

  /**
   * 提问通知的超时：**0 = 不超时**（0.14.1 批 8 / S3-6 起）。
   *
   * 旧值是 30 分钟，行为是 `setTimeoutAfter` 到点撤掉通知——而引擎侧的提问**没有超时**
   * （§6.3.2 注），于是「30 分钟后通知无声消失、引擎仍在等」＝ 用户丢掉唯一作答入口，
   * 与 P0-5（关掉提醒 = 任务永久挂起）同一形态。通知寿命现在与请求寿命一致：由 cancel 帧
   * （他人已答 / 引擎撤销）或本机提交结算。常量保留为 0，让这条决定**显式可 grep**。
   */
  const val QUESTION_TIMEOUT_MS = 0L

  /** 审批动作是否要求解锁（NT-18，B4 批）。B3 保持 false：真机 keyguard 行为未确证，先不阻塞开发循环。 */
  const val APPROVAL_REQUIRE_UNLOCK = false

  /**
   * 五类信道定案（§6.1.1 表）。信道名 = kind。候选 ID 序列的第一个是首选；后续是
   * 「历史构建把首选建成了低 importance」时的迁移代次（h<n> = 高 importance 代次）。
   * 既有渠道 engine / dsh / dsh-task / dsh-todo 不动、不复用。
   */
  enum class Face(
    val category: String,
    val description: String,
    val candidates: List<String>,
    val importance: Int,
    val popup: Boolean,
    /**
     * 引擎是否**在等一个回答**（P0-5）。
     *
     * 提问与审批：引擎侧 `ask_user_question` / 授权请求**没有超时**，通知被丢弃 = 任务永久挂起，
     * 用户看到的现象是「AI 不动了」。故这两类的类别开关语义只能是「不弹窗」（降到静默渠道），
     * **绝不能**是「不投递」。汇报/进度类丢了只是少一条消息，引擎不等它。
     */
    val interactive: Boolean,
  ) {
    SILENT(
      "silent", "看门狗与引擎状态；静默更新，不弹出",
      listOf("dsh-silent"), NotificationManager.IMPORTANCE_LOW, false, false,
    ),
    TODO(
      "todo", "任务步骤进度；静默更新，不弹出",
      listOf("dsh-todo-progress"), NotificationManager.IMPORTANCE_LOW, false, false,
    ),
    REPORT(
      "report", "每轮任务结束的汇报；需要出现在锁屏之上",
      listOf("dsh-report", "dsh-report-h2"), NotificationManager.IMPORTANCE_HIGH, true, false,
    ),
    QUESTION(
      "question", "引擎向你提问；可直接在通知栏回复",
      listOf("dsh-question", "dsh-question-h2"), NotificationManager.IMPORTANCE_HIGH, true, true,
    ),
    APPROVAL(
      "approval", "工具执行前的授权请求；请确认不是他人代答",
      listOf("dsh-auth", "dsh-auth-h2", "dsh-auth-h3"), NotificationManager.IMPORTANCE_HIGH, true, true,
    );

    /**
     * 渠道名 / 设置页标签（**唯一真源** [UserCopy.notifyCategory]）。
     *
     * 为什么是 getter 而不是构造参数（0.14.1 批 3 / P3-2）：旧形态把「需要回答」写在这里、
     * 把「提问」写在设置页，同一个东西两个名字（审查档 §4.3）；本批把用词收到一处，
     * 这里派生取值，设置页标签同源于同一张表。
     */
    val label: String get() = UserCopy.notifyCategory(category)

    companion object {
      fun of(category: String): Face? = values().firstOrNull { it.category == category }
    }
  }

  /** 未授权 / 前台抑制 / 渠道降级的界面回调（D9：不再只写日志）。 */
  interface Listener {
    /** POST_NOTIFICATIONS 未授予：界面显示一行 + 授权入口。 */
    fun onPermissionDenied()

    /** 弹窗类被前台抑制（可选提示）。 */
    fun onForegroundSuppressed(category: String) = Unit

    /** 渠道被用户降级 → 该语义只能静默（设置页显示降级文案）。 */
    fun onChannelDegraded(category: String) = Unit
  }

  @Volatile
  var listener: Listener? = null

  /**
   * 默认 listener（0.14.1 块J FIX-2）：把「被抑制」从**静默**变成用户可见反馈。
   *
   * 旧形态：`listener` 在全仓**从未被赋值**（详档 §1.2 第 6 项，源码级确证），于是
   * `listener?.onForegroundSuppressed(...)` 是空操作——抑制发生时用户既没有系统通知、
   * 也没有应用内提示，是「一切正常与彻底失败不可区分」的静默失败形态。
   *
   * 本实现只依赖**既有公开面**：`OverlayService.instance`（companion 里已有）与
   * `OverlayService.flashStatus`（`OverlayService.kt:669`，internal，同模块可见）。
   * 因此在**调用时刻**惰性解析实例——不持有 Activity/Service 引用，无泄漏面；服务不在时
   * 退化为探针一行（可 run-as 读），绝不抛异常到 MuxClient 读线程。
   */
  private object ShellListener : Listener {
    override fun onPermissionDenied() {
      flash("通知未授权，任务完成不会提醒")
    }

    override fun onForegroundSuppressed(category: String) {
      // FIX-1 起「抑制 = 延后」而非丢弃，文案必须如实反映（不得再说「已丢弃」）。
      flash("通知已延后（前台抑制开启）：" + category)
    }

    override fun onChannelDegraded(category: String) {
      // P3-1/P3-6：类别码不上屏——用户看到的是「哪一类通知」，码只进探针日志。
      flash("「" + UserCopy.notifyCategory(category) + "」通知已被系统降级为静默——请到系统设置里改回")
    }

    private fun flash(msg: String) {
      try {
        OverlayService.instance?.flashStatus(msg)
      } catch (t: Throwable) {
        // 反馈面本身不得成为故障源（服务已销毁 / 主线程不可用）。
        LogCollector.log("dsh-notify", "listener feedback failed: " + (t.message ?: t.javaClass.simpleName))
      }
    }
  }

  /**
   * 有界注册（幂等；进程级一次）。调用点是 `NotifyStore.start`——通知消费的真实生命周期入口
   * （EngineService.onCreate / 动作冷启动都会经它），而不是某个 Activity，因此不会随旋转/重建重复注册。
   * @return true = 本次安装了默认实现（false = 已有（含外部）实现，不覆盖）
   */
  @Synchronized
  fun installShellListener(): Boolean {
    if (listener != null) return false
    listener = ShellListener
    return true
  }

  /** 解绑（测试 / 停机清理用）；已注册的默认实现同样被清掉。 */
  @Synchronized
  fun uninstallListener() {
    listener = null
  }

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ── 分类开关（NT-10：开关必须参与投递判定，不能只写 prefs）──

  fun enabled(context: Context, category: String): Boolean =
    prefs(context).getBoolean("cat." + category, true)

  fun setEnabled(context: Context, category: String, value: Boolean) {
    prefs(context).edit().putBoolean("cat." + category, value).apply()
  }

  fun suppressForeground(context: Context): Boolean =
    prefs(context).getBoolean(KEY_SUPPRESS_FOREGROUND, DEFAULT_SUPPRESS_FOREGROUND)

  fun setSuppressForeground(context: Context, value: Boolean) {
    prefs(context).edit().putBoolean(KEY_SUPPRESS_FOREGROUND, value).apply()
    // 用户显式选择后即视为本代次已归一化：不得让一次性迁移再回头覆盖它。
    prefs(context).edit().putInt(KEY_SUPPRESS_SCHEMA, SUPPRESS_SCHEMA_CURRENT).apply()
    NotifyProbe.log(context.applicationContext, "dsh-notify", "suppressForeground set to " + value)
  }

  /**
   * 存量升级迁移（0.14.1 块J FIX-3）：一次性、幂等、可审计。
   *
   * **为什么需要它 + 为什么形态是「不动 prefs」**：
   *
   * 1. 旧缺陷对用户的传导**不经过 prefs**——`suppressForeground()` 缺键即返回 true。即「存量用户」
   *    的 prefs 里根本**没有** `suppressForeground` 键，抑制是**默认值**造出来的。全仓 `setSuppressForeground`
   *    零调用（详档 §1.2 第 5 项，源码级确证），0.14.0-preview 起也从未接线——**没有任何发行版写过
   *    这个键**。⇒ 把默认值改成 false，存量用户**立即**被修好，且无需改他们任何一个 prefs 字节。
   * 2. 因此本函数**不覆盖**任何已存在的值：若磁盘上确有 `suppressForeground`，那只能是用户/自动化
   *    显式写入的**真实意志**，静默改写它属于「代理信号当作真实状态」的反面错误（F-APK-02 同族）。
   *    显式值原样保留，仅备份到 [KEY_SUPPRESS_LEGACY] 并在探针留痕，随后由设置页（FIX-4）可见可控。
   * 3. schema 代次保证**只跑一次**：升级后用户再手动改开关，不会被下一轮启动的迁移抹掉。
   *
   * 双起点验收口径（与详档 §5.1 FIX-3 要求的「全新安装 + 存量升级各验一次」一致）：
   *  - 全新安装：无键 → 生效值 false（前台真发）；
   *  - 存量升级：无键（旧默认造出的抑制）→ 生效值 false（被修好）；
   *  - 显式 true：原样保留 true（尊重用户），但探针记 explicit=true 供事后核对。
   *
   * @return 迁移后的生效值
   */
  fun ensureSuppressForegroundMigrated(context: Context): Boolean {
    val app = context.applicationContext
    val p = prefs(app)
    if (p.getInt(KEY_SUPPRESS_SCHEMA, 0) >= SUPPRESS_SCHEMA_CURRENT) return suppressForeground(app)
    val explicit = p.contains(KEY_SUPPRESS_FOREGROUND)
    if (explicit) {
      val old = p.getBoolean(KEY_SUPPRESS_FOREGROUND, DEFAULT_SUPPRESS_FOREGROUND)
      p.edit().putBoolean(KEY_SUPPRESS_LEGACY, old).putInt(KEY_SUPPRESS_SCHEMA, SUPPRESS_SCHEMA_CURRENT).apply()
      NotifyProbe.log(app, "dsh-notify", "suppressForeground migration: explicit=" + old +
        " preserved (user choice, now surfaced in settings); default=" + DEFAULT_SUPPRESS_FOREGROUND)
    } else {
      // 唯一「无事可做」的分支：缺键即走新默认值。仍然记一行，让存量升级在设备上可被证实跑过。
      p.edit().putInt(KEY_SUPPRESS_SCHEMA, SUPPRESS_SCHEMA_CURRENT).apply()
      NotifyProbe.log(app, "dsh-notify", "suppressForeground migration: implicit (no stored key) -> default=" +
        DEFAULT_SUPPRESS_FOREGROUND)
    }
    return suppressForeground(app)
  }

  // ── 设置页读写能力（0.14.1 块J FIX-4：把零调用的 setter 接到可观测的单一入口）──
  //
  // 壳侧只交付**读写能力**：设置页 UI 若落在 dsh-client-ui-responsive，属 T8 写面——本处给出
  // T8 需要的唯一入口（一个读 + 一个写），JS 接线清单随交付说明交给 Lead 转 T8。
  // 「先写后读回」而非回显入参：拒绝乐观置位（与 ShellState.DevLogControl 同纪律）。

  /** 通知设置快照（可用作设置页初始态 + 写回后的读回值）。 */
  fun settingsSnapshot(context: Context): JSONObject {
    val app = context.applicationContext
    val out = JSONObject()
    out.put("ok", true)
    out.put("suppressForeground", suppressForeground(app))
    out.put("suppressForegroundDefault", DEFAULT_SUPPRESS_FOREGROUND)
    val cats = JSONObject()
    for (face in Face.values()) cats.put(face.category, enabled(app, face.category))
    out.put("categories", cats)
    return out
  }

  /**
   * 设置项 key 是否合法（key 取值：`suppressForeground` / `cat.<category>`）。
   *
   * 抽成纯函数是为了让「未知 key 必须拒绝」在 JVM 上可断言——该判定**先于**任何 prefs 读写，
   * 不依赖 Context。`applySetting` 是唯一调用方（单一真源，防两处漂移）。
   */
  fun settingKeyKnown(key: String): Boolean {
    val category = key.removePrefix("cat.")
    return key == KEY_SETTING_SUPPRESS || (key.startsWith("cat.") && Face.of(category) != null)
  }

  /**
   * 设置页写入口（key 取值：`suppressForeground` / `cat.<category>`）。
   * 未知 key 一律拒绝且不改任何 prefs（不得静默吞掉一次误写）。
   * @return 写后读回的快照，附 `applied` 与 `reason`。
   */
  fun applySetting(context: Context, key: String, value: Boolean): JSONObject {
    val app = context.applicationContext
    val category = key.removePrefix("cat.")
    if (!settingKeyKnown(key)) {
      NotifyProbe.log(app, "dsh-notify", "notify setting rejected (unknown key): " + key)
      return settingsSnapshot(app).put("applied", false).put("reason", "unknown-key")
    }
    if (key == KEY_SETTING_SUPPRESS) {
      setSuppressForeground(app, value)
      // 关掉抑制必须立刻把延后条目补投出去（否则用户以为关了却还在等）。唯一 flush 权威是
      // [onSuppressForegroundChanged]（本处不得再直接调 NotifySuppressQueue.flush——两处判定会漂移）。
      onSuppressForegroundChanged(app)
    } else {
      setEnabled(app, category, value)
    }
    val snap = settingsSnapshot(app)
    // 读回必须按**同一结构**取（cat.* 落在 categories 子对象里，不在顶层）——否则读回恒 false，
    // 会把每一次合法写入都误报成 readback-mismatch（乐观置位的反面：假阴性）。
    val readBack = if (key == KEY_SETTING_SUPPRESS) {
      snap.optBoolean(KEY_SETTING_SUPPRESS, false)
    } else {
      snap.optJSONObject("categories")?.optBoolean(category, false) ?: false
    }
    val ok = readBack == value
    NotifyProbe.log(app, "dsh-notify", "notify setting applied key=" + key + " value=" + value +
      " readBack=" + readBack + " ok=" + ok)
    return snap.put("applied", ok).put("reason", if (ok) "ok" else "readback-mismatch")
  }

  /** 设置项 key（与 prefs 键同名字面量集中一处，避免设置页/迁移两处漂移）。 */
  const val KEY_SETTING_SUPPRESS = "suppressForeground"

  /** 设置页/长按入口的开关生效即时反馈：关掉抑制时立刻补投被延后的条目。 */
  fun onSuppressForegroundChanged(context: Context) {
    if (!suppressForeground(context)) NotifySuppressQueue.flush(context)
  }

  // ── 渠道选择：纯逻辑（JVM 可测）+ Android 胶水 ─────────────────────────

  /** 单渠道运行时可观测事实（把 Android API 面抽成数据，迁移三态才可单测）。 */
  data class ChannelFact(val id: String, val importance: Int, val userSetImportance: Boolean)

  /**
   * 迁移判定的结果。
   * @param channelId 选中渠道；null = 该语义降级为静默（S4 用户降级 / S5 候选耗尽）
   * @param reason 可 grep 的判定原因（selected / create / migrated / user-demoted / exhausted）
   * @param create 该 ID 首次创建（必须以目标 importance 建）
   */
  data class ChannelSelection(
    val channelId: String?,
    val reason: String,
    val create: Boolean,
    /** S3-2：被本次迁移**替代**的旧候选（调用方负责删除，避免同名重复渠道）。 */
    val retire: List<String> = emptyList(),
  ) {
    val degraded: Boolean get() = channelId == null
  }

  /**
   * §6.1.2 S2-S5 的三态判定（纯函数：事实由调用方查 getNotificationChannel 得来）：
   *  - 不存在 → 首次创建（HIGH/LOW 一次到位）
   *  - importance >= 目标 → 直接用
   *  - importance < 目标 且用户没改过 → 判定为历史构建建错，切下一个候选（migrated）
   *  - importance < 目标 且用户改过 → 不换 ID（换 ID 等于绕过用户意志），降级为静默
   *  - 候选耗尽 → 降级为静默（不得静默失败）
   */
  fun selectChannel(
    candidates: List<String>,
    targetImportance: Int,
    facts: Map<String, ChannelFact?>,
  ): ChannelSelection {
    for ((index, id) in candidates.withIndex()) {
      val fact = facts[id]
      when {
        fact == null -> return ChannelSelection(
          id,
          if (index == 0) "create" else "migrated",
          true,
          // 首次创建时前面的候选都不存在（facts 为 null 才走到这里），retire 取「前面所有存在的」——
          // 事实上只有迁移那一支会命中非空（前面的候选 importance 太低但确实存在）。
          retire = candidates.take(index).filter { facts[it] != null },
        )
        fact.importance >= targetImportance -> return ChannelSelection(id, "selected", false)
        !fact.userSetImportance -> continue // 历史代码建错 → 下一个候选（S3）
        else -> return ChannelSelection(null, "user-demoted", false) // S4
      }
    }
    return ChannelSelection(null, "exhausted", false) // S5
  }

  private val selectedCache = HashMap<String, String?>()

  /** 渠道解析入口（幂等；channelsInitialized 后只读 prefs 映射，不再重建——S6）。 */
  @Synchronized
  fun channelFor(context: Context, face: Face): String? {
    val app = context.applicationContext
    selectedCache[face.category]?.let { return it.ifEmpty { null } }
    val p = prefs(app)
    if (p.getBoolean(KEY_CHANNELS_INITIALIZED, false)) {
      val stored = p.getString(KEY_SELECTED_PREFIX + face.category, null)
      if (stored != null) {
        selectedCache[face.category] = stored
        return stored.ifEmpty { null }
      }
    }
    val id = resolveChannel(app, face)
    selectedCache[face.category] = id ?: ""
    return id
  }

  /** 解析（必要时创建）一个信道的渠道 ID；结果落 prefs（投递路径一律读映射，不硬编码）。 */
  private fun resolveChannel(app: Context, face: Face): String? {
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val facts = HashMap<String, ChannelFact?>()
    for (id in face.candidates) {
      val ch = manager.getNotificationChannel(id)
      facts[id] = ch?.let { ChannelFact(it.id, it.importance, it.hasUserSetImportance()) }
    }
    val selection = selectChannel(face.candidates, face.importance, facts)
    val chosen = selection.channelId
    // S3-2：迁移（历史构建把首选建成了低 importance）会新建 `*-h2`/`*-h3`，而它们与首选**同名**
    // （都用 Face.label）——系统设置里于是出现两三条都叫「授权请求」的渠道，用户无从分辨。迁移既已
    // 选定新候选，就把被替代的旧候选删掉：此时用户从未改过它的 importance（改了就不会迁移），
    // 删除不丢用户设置。
    if (chosen != null && selection.retire.isNotEmpty()) {
      for (old in selection.retire) {
        try {
          manager.deleteNotificationChannel(old)
          LogCollector.log("dsh-notify", "channel " + face.category + " retired duplicate: " + old)
        } catch (t: Throwable) {
          LogCollector.log("dsh-notify", "channel retire failed " + old + ": " + t.message)
        }
      }
    }
    if (chosen != null && selection.create) {
      manager.createNotificationChannel(buildChannel(chosen, face))
      val created = manager.getNotificationChannel(chosen)
      // 少数 ROM 会把新建渠道的 importance 打回默认值：这里以设备实际值为准再判一次。
      if (created != null && created.importance < face.importance) {
        LogCollector.log("dsh-notify", "channel " + face.category + " created but importance=" + created.importance +
          " < " + face.importance + " (ROM override)")
      }
    } else if (chosen != null) {
      // 0.14.1 批 3（P3-2）：既有渠道的**展示名迁移**。
      // 缺陷现场（设备实测 2026-09-23）：本批把 `Face.QUESTION.label` 从「需要回答」改成「提问」，
      // 但 `createNotificationChannel` 只在 `selection.create` 时被调用——importance 已达标的老渠道
      // 永远不再走创建分支，于是**改代码到不了老装机**：应用内说「提问」，系统设置里仍是「需要回答」
      // （S3-13 要的正是两侧同名，光改字面量不够）。
      // 这里按 id 校正展示名与说明：**用渠道当前 importance 重建**，不尝试提升/降低 importance,
      // 因此不会干扰「用户改过的重要性」判定（那是降级检测的输入）。
      renameChannelIfNeeded(manager, chosen, face)
    }
    prefs(app).edit()
      .putBoolean(KEY_CHANNELS_INITIALIZED, true)
      .putString(KEY_SELECTED_PREFIX + face.category, chosen ?: "")
      .apply()
    LogCollector.log("dsh-notify", "channel " + face.category + ": selected=" + (chosen ?: "<none>") +
      " reason=" + selection.reason + " candidates=" + face.candidates.joinToString(","))
    if (chosen == null) listener?.onChannelDegraded(face.category)
    return chosen
  }

  /**
   * 一次性初始化（首启/自检/设置页可显式调用；幂等）。
   *
   * 0.14.1 批 3（P3-2）：本方法同时负责**渠道展示名的用词迁移**（见 [syncChannelNames]）。
   * 为什么迁移必须挂在这里、而不能只挂在 `resolveChannel` 里：`channelFor` 在
   * `KEY_CHANNELS_INITIALIZED` 之后**只读 prefs 映射、不再重建**（S6 的设计），于是
   * `resolveChannel` 对老装机永远不会再被调用——改名代码写在里面等于没写（本轮设备实测撞到）。
   */
  fun ensureChannels(context: Context) {
    for (face in Face.values()) channelFor(context, face)
    syncChannelNames(context)
  }

  /**
   * 渠道展示名同步（0.14.1 批 3 / P3-2）：把每个已选渠道的**展示名与说明**对齐到唯一真源。
   *
   * 幂等且廉价：先 `getNotificationChannel` 读现状，只在 `channelRenameNeeded` 为真时才重建渠道，
   * 且重建时**保留渠道当前 importance**（改名不得变成一次重要性调整，见 [buildChannelKeepingImportance]）。
   * @param context - 任意 context（内部取 applicationContext）。
   * @returns 实际改名的渠道数（诊断/测试用）。
   */
  fun syncChannelNames(context: Context): Int {
    val app = context.applicationContext
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    var renamed = 0
    for (face in Face.values()) {
      val id = channelFor(app, face) ?: continue
      val existing = manager.getNotificationChannel(id) ?: continue
      if (!channelRenameNeeded(existing.name?.toString().orEmpty(), existing.description, face.label, face.description)) continue
      renameChannelIfNeeded(manager, id, face)
      renamed += 1
    }
    return renamed
  }

  private fun buildChannel(id: String, face: Face): NotificationChannel {
    val ch = NotificationChannel(id, face.label, face.importance)
    ch.description = face.description
    ch.setShowBadge(true)
    if (face.popup) {
      ch.enableVibration(true)
    } else {
      // 静默的第一道保险（第二道是实例级 setSilent(true)）：渠道层就没有声音与振动。
      ch.setSound(null, null)
      ch.enableVibration(false)
    }
    return ch
  }

  /**
   * 既有渠道的展示名/说明校正（0.14.1 批 3 / P3-2：用词迁移必须能到老装机）。
   *
   * 纯判据部分（[channelRenameNeeded]）抽成顶层函数以便 JVM 直测；本方法只做 Android 胶水。
   * 关键约束：**保留渠道当前 importance**（不传入 `face.importance`），否则一次改名会变成一次
   * 「重要性调整」，可能扰动用户改过的重要性与降级检测。
   * @param manager - 系统通知管理器。
   * @param id - 已选中的渠道 id。
   * @param face - 该渠道对应的语义。
   */
  private fun renameChannelIfNeeded(manager: NotificationManager, id: String, face: Face) {
    val existing = manager.getNotificationChannel(id) ?: return
    if (!channelRenameNeeded(existing.name?.toString().orEmpty(), existing.description, face.label, face.description)) return
    manager.createNotificationChannel(buildChannelKeepingImportance(existing, face))
    LogCollector.log("dsh-notify", "channel " + face.category + " renamed to '" + face.label + "' (id=" + id +
      ", importance kept=" + existing.importance + ")")
  }

  /** 按既有渠道的**当前** importance 重建，只改展示名与说明（其余保持系统现状）。 */
  private fun buildChannelKeepingImportance(existing: NotificationChannel, face: Face): NotificationChannel {
    val ch = NotificationChannel(existing.id, face.label, existing.importance)
    ch.description = face.description
    ch.setShowBadge(true)
    ch.enableVibration(existing.shouldVibrate())
    ch.setSound(existing.sound, existing.audioAttributes)
    return ch
  }

  // ── 自检面（NT-03：四类事实齐全 + 不可自检项如实写「无法检测」）──────────

  const val UNDETECTABLE = "无法检测"

  fun selfCheck(context: Context): JSONObject {
    val app = context.applicationContext
    // P3-2：自检是用户会主动打开的诊断面，顺手把渠道展示名对齐到当前用词（幂等，未变则零写入）。
    syncChannelNames(app)
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val out = JSONObject()
    val granted = hasPermission(app)
    out.put("notificationsEnabled", manager.areNotificationsEnabled())
    out.put("permissionGranted", granted)
    out.put("permissionLabel", if (granted) "已授予" else "未授予（任务完成不会提醒）")
    // 用户是否关掉了「弹出」：应用不可读（getUserLockedFields 是 @hide @SystemApi 且不含该字段）
    out.put("popupEnabled", UNDETECTABLE)
    val channels = org.json.JSONArray()
    for (face in Face.values()) {
      val row = JSONObject()
      row.put("category", face.category)
      row.put("label", face.label)
      val selected = channelFor(app, face)
      row.put("selected", selected ?: "")
      row.put("popup", face.popup)
      if (selected == null) {
        row.put("exists", false)
        row.put("importance", -1)
        row.put("importanceLabel", "已降级为静默")
        row.put("userSetImportance", false)
        row.put("userSetSound", false)
        row.put("degraded", true)
        row.put("guidance", "系统已把该渠道降级，应用无法调回，请在系统设置里改")
      } else {
        val ch = manager.getNotificationChannel(selected)
        row.put("exists", ch != null)
        row.put("importance", ch?.importance ?: -1)
        row.put("importanceLabel", importanceLabel(ch?.importance ?: -1))
        row.put("userSetImportance", ch?.hasUserSetImportance() ?: false)
        row.put("userSetSound", ch?.hasUserSetSound() ?: false)
        row.put("degraded", ch != null && ch.importance < face.importance)
        row.put("guidance", if (ch != null && ch.importance < face.importance && ch.hasUserSetImportance()) {
          "系统已把该渠道降级，应用无法调回，请在系统设置里改"
        } else {
          ""
        })
      }
      channels.put(row)
    }
    out.put("channels", channels)
    val cats = JSONObject()
    for (face in Face.values()) cats.put(face.category, enabled(app, face.category))
    out.put("categories", cats)
    return out
  }

  /**
   * 渠道重要性 → 人话（唯一真源 [UserCopy.importance]，P3-1）。
   *
   * 旧实现回的是 `HIGH(4)` 这样的档位名——那是**诊断口径**，页面上出现过「（重要性 4）」。
   * 现在两侧同源：本方法（自检面用）与页面侧 `describeImportance` 覆盖同一档位集合，且都不回数字。
   */
  fun importanceLabel(importance: Int): String = UserCopy.importance(importance)

  /** 应用级通知设置深链（设置页按钮用；不在此处 startActivity）。 */
  fun appSettingsIntent(app: Context): Intent =
    Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, app.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  /** 渠道级设置深链（NT-03 的深链按钮用）。 */
  fun channelSettingsIntent(app: Context, channelId: String): Intent =
    Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
      .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, app.packageName)
      .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, channelId)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  // ── 投递 ────────────────────────────────────────────────────────────────

  /** 投递结果（可 grep / 可断言；降级不静默要求每种分支都能解释自己）。 */
  enum class Result {
    POSTED, DISABLED, PERMISSION_DENIED, UNKNOWN_KIND, SUPPRESSED_FOREGROUND, RESOLVED,
    /** DEF-NOTIFY-02：投递过程抛异常（已吞掉并落探针），绝不让异常冒到 MuxClient 读线程。 */
    ERROR,

    /**
     * P3 去重：同一通知身份 + 同一内容在 [DEDUP_WINDOW_MS] 内被重复投递，后到的那次丢弃。
     *
     * 真机实测：同一 `id=1949540996` 在约 80 ms 内被投 5 次（积压被一次性放出来）。同一 id 覆盖式
     * 投递 5 次不会在通知栏留 5 条，但会**连打 5 次 heads-up**——用户看到的是横幅一闪一闪，
     * 系统侧也可能因此取消正在展示的横幅（「消息有、不弹横幅」的观感来源之一）。
     */
    DUPLICATE_SUPPRESSED,
  }

  /** P3 去重窗口：同 id 同内容在该窗口内只投一次。取值依据：真机突发间隔约 80 ms，两秒足够覆盖。 */
  const val DEDUP_WINDOW_MS = 2_000L

  // 三个驱动线程（消费、看门狗、Mux 读线程）都会走到投递，故用 @Volatile：去重本身是尽力而为，
  // 竞态最坏结果是少去重一次（多打一次横幅），不值得为它引入锁序。
  @Volatile
  private var lastPostId = 0

  @Volatile
  private var lastPostSig: String? = null

  @Volatile
  private var lastPostAt = 0L

  /**
   * 纯逻辑：这次投递是否该按重复丢弃（JVM 单测覆盖）。
   *
   * 三个条件缺一不可：**同一通知身份**（id）、**同一可见内容**（[contentSignature]）、**窗口内**。
   * 只比 id 会把「同一会话先后两轮汇报」当成重复（第二轮被吞，用户永远看不到新结果）。
   */
  fun isDuplicatePost(
    lastId: Int,
    lastSig: String?,
    lastAt: Long,
    id: Int,
    sig: String,
    now: Long,
    windowMs: Long = DEDUP_WINDOW_MS,
  ): Boolean = lastSig != null && lastId == id && lastSig == sig && now - lastAt in 0..windowMs

  /**
   * 纯逻辑：条目的**可见内容**指纹（不含 `ts`/延迟等不可见字段；同内容两次投递必须同指纹）。
   *
   * 覆盖 build() 真正渲染出来的每个字段（标题/正文/汇报行/进度/产出清单/交互字段），漏一个就会把
   * 「内容变了但指纹相同」的两次投递判成重复——即用户看不到更新后的那条。反向（多含一个字段）
   * 只会少去重一次，代价是横幅多打一次，属于可接受侧。
   */
  fun contentSignature(entry: NotifyEntry): String = listOf(
    entry.kind, entry.title, entry.text, entry.summary, entry.outcome, entry.outcomeLabel,
    entry.durationMs.toString(), entry.durationLabel, entry.toolCount.toString(),
    entry.done.toString(), entry.total.toString(), entry.current,
    entry.presentedFiles.joinToString(","), entry.event, entry.eventId, entry.sessionId,
    entry.reason, entry.toolName, entry.count.toString(), entry.popup.toString(),
  ).joinToString("\u0001")

  // ── §3.3 通知结构族（0.14.1 批 8）的纯判据 ─────────────────────────────
  //
  // 这几条都曾以「界面上看起来对、实际不是那么回事」的形态活着，只能靠设备复现；抽成纯函数
  // 之后每条都能在 JVM 上判红（详见各函数注释里的缺陷现场）。

  /**
   * 汇报通知的**分桶键**（S3-3；纯函数）。
   *
   * 缺陷现场：`notificationId` 用 `"dsh-report:" + entry.sessionId` 当键，而 sessionId 可能为空
   * （引擎事件缺会话身份时）——于是**所有会话的汇报挤进同一个通知 ID**，后来的覆盖先前的，
   * 用户只看到最后一条。这里给出稳定回退：会话 → 事件 → 标题，保证不同来源不同桶。
   *
   * 与 [deferredKey]（延后队列的覆盖式去重键）**必须同粒度**：两者若不同，退后台补投会为同一
   * 会话补弹一串陈旧汇报，与「覆盖式 ID」的语义自相矛盾。故两者共用本函数。
   * @param entry - 通知条目。
   * @returns 稳定的分桶键（空串代表无法区分：此时退化到内容指纹，至少不互相吞掉）。
   */
  internal fun reportBucketKey(entry: NotifyEntry): String = when {
    entry.sessionId.isNotEmpty() -> "s:" + entry.sessionId
    entry.eventId.isNotEmpty() -> "e:" + entry.eventId
    entry.displayTitle().isNotEmpty() -> "t:" + entry.displayTitle()
    else -> "k:" + entry.kind
  }

  /**
   * 结算回执的文案（S3-9；纯函数）。
   *
   * 缺陷现场：`cancel` 帧（别人答了 / 引擎撤销）与「本机提交成功」走同一条结算路径、同一句
   * **「已提交」**——用户没答任何东西，却在本机收到「已提交」的回执。作答方与旁观方必须说不同的话。
   * @param kind - `question` / `approval`。
   * @param remote - true = 本机没提交（别人答了或引擎撤销了）。
   * @returns 回执标题与正文。
   */
  internal fun settleCopy(kind: String, remote: Boolean): SettleCopy = when {
    remote && kind == "approval" -> SettleCopy("该请求已结束", "这条授权请求已在别处处理或已撤销——无需你再操作")
    remote -> SettleCopy("已作答", "这个问题已在别处作答或已撤销——无需你再回答")
    kind == "approval" -> SettleCopy("已提交", "决定已提交，等待引擎确认")
    else -> SettleCopy("已提交", "回答已提交，等待引擎确认")
  }

  /** 结算回执文案载体（见 [settleCopy]）。 */
  internal data class SettleCopy(val title: String, val text: String)

  /**
   * 授权正文的**目标保留**脱敏（S3-7；纯函数）。
   *
   * 缺陷现场：`sanitize` 把 `/data/...` 整段替换成 `[路径]`，而审批要确认的**正是那个目标**——
   * 用户在通知栏看到的是一句「工具 bash：[路径]」，无从判断放行的是什么。这里保留路径的**末段**
   * （文件名/目录名），去掉目录树：既说清「动的是什么」，又不把完整目录结构摊在锁屏上。
   * token 形态的遮挡与总长上限沿用 [sanitize] 的口径。
   * @param text - 原始正文。
   * @returns 保留目标末段的脱敏文本。
   */
  internal fun redactPathsKeepingTail(text: String): String {
    val kept = text.replace(Regex("""(/[^\s:，。；]*/)([^\s:，。；/]+)""")) { m -> "…/" + m.groupValues[2] }
    return sanitize(kept)
  }

  /** 单条事件的形态决策（DEF-NOTIFY-01；纯函数，JVM 单测覆盖）。 */
  data class FormDecision(val degradeToSilent: Boolean, val keepPopup: Boolean, val note: String)

  /**
   * 引擎可对**单条事件**否决弹窗（.notify.ndjson 的 popup=false；NT-05 的 aborted(kind=user)）。
   * 这是 DEF-NOTIFY-01 的修法：旧实现只认类别静态 face.popup，entry.popup 解析了却没消费点，
   * 用户按下停止后仍收到「工作汇报」heads-up 并落在 dsh-report 高优渠道。
   *  - 静默类本来就静默 → 无需动作
   *  - 弹窗类且 popup=false → **降级为静默条目**（条目仍可见、可点开，但不再 heads-up）
   *  - 例外：提问/审批是**交互入口**，静默等于丢掉唯一可作答通道 → 保留弹窗并留日志
   */
  fun formDecision(face: Face, entryPopup: Boolean): FormDecision = when {
    entryPopup -> FormDecision(false, face.popup, "popup-honored")
    !face.popup -> FormDecision(false, false, "already-silent")
    face == Face.QUESTION || face == Face.APPROVAL -> FormDecision(false, true, "interactive-popup-kept")
    else -> FormDecision(true, false, "degraded-to-silent")
  }

  /**
   * 六类事件投递入口（NotifyStore / NotifyBridge 的唯一出口）。
   * @param foreground 应用在前台（弹窗类按设置抑制；DEF-NOTIFY-02 起抑制只作用于 report）
   */
  fun notifyEvent(context: Context, entry: NotifyEntry, foreground: Boolean = false): Result {
    val app = context.applicationContext
    return try {
      deliverEvent(app, entry, foreground)
    } catch (t: Throwable) {
      // DEF-NOTIFY-02：投递异常绝不能冒泡到 MuxClient 的读线程——那会整条应答流断开重连，
      // 之后所有提问/审批通知一起消失（而且只在 logcat 留一行 Log.w）。这里吞掉并留下探针。
      NotifyProbe.log(app, "dsh-notify", "notifyEvent THREW kind=" + entry.kind + ": " + t)
      Result.ERROR
    }
  }

  /** 投递主体（由 [notifyEvent] 包异常边界调用）。 */
  private fun deliverEvent(app: Context, entry: NotifyEntry, foreground: Boolean): Result {
    val kind = entry.kind.lowercase()
    val face = when (kind) {
      "resolve" -> {
        cancel(app, entry.eventId)
        return Result.RESOLVED
      }
      "silent" -> Face.SILENT
      "todo" -> Face.TODO
      "report" -> Face.REPORT
      "question" -> Face.QUESTION
      "approval" -> Face.APPROVAL
      else -> {
        NotifyProbe.log(app, "dsh-notify", "notify skipped (unknown kind): " + entry.kind)
        return Result.UNKNOWN_KIND
      }
    }
    // P0-5：类别被关掉 ≠ 可以把引擎的问题丢掉。
    // 旧实现一律 `return Result.DISABLED` 且**没有任何 listener 回调**——而提问/审批在引擎侧
    // 没有超时，于是「少点打扰」的实际后果是任务永久挂起，界面上只表现为「AI 不动了」，
    // 设置页也一个字都没解释。现在：交互类降级为**静默投递**（不弹窗、不响，但仍在通知栏可作答），
    // 非交互类（汇报/进度）才允许丢弃。
    val categoryOff = !enabled(app, face.category)
    if (categoryOff && !face.interactive) {
      NotifyProbe.log(app, "dsh-notify", "notify skipped (category disabled): " + face.category)
      return Result.DISABLED
    }
    if (categoryOff) {
      NotifyProbe.log(app, "dsh-notify", "notify degraded to silent (category disabled, interactive): " + face.category)
      listener?.onForegroundSuppressed(face.category)
    }
    if (!hasPermission(app)) {
      NotifyProbe.log(app, "dsh-notify", "notify skipped (POST_NOTIFICATIONS not granted): " + face.category)
      listener?.onPermissionDenied()
      return Result.PERMISSION_DENIED
    }
    if (face == Face.REPORT && NotifySuppressQueue.isSettled(app, entry)) return Result.DUPLICATE_SUPPRESSED
    // DEF-NOTIFY-02：前台抑制只作用于工作汇报（计划 §5.3 R）。提问/审批**永不**因前台抑制丢弃：
    // isForeground 是 ActivityManager 粒度判定，一次假阳性就会让「通知内应答」整条能力消失，
    // 而应用在前台时本来就有应用内提问 UI 兜底。
    if (face == Face.REPORT && foreground && suppressForeground(app)) {
      NotifyProbe.log(app, "dsh-notify", "notify suppressed (foreground): " + face.category)
      // FIX-1：抑制 = **延后**，不是丢弃。旧实现此处直接 return 终态，而消费侧已推进字节偏移
      // ⇒ 该条永久消失（「必须划到后台才推送」的另一半成因）。改由待投队列承载，TTL 防陈旧。
      if (!NotifySuppressQueue.enqueue(app, entry, deferredKey(entry))) return Result.ERROR
      listener?.onForegroundSuppressed(face.category)
      return Result.SUPPRESSED_FOREGROUND
    }
    // DEF-NOTIFY-01：消费 entry.popup（引擎可对单条事件否决弹窗）
    val form = formDecision(face, entry.popup)
    if (form.note == "interactive-popup-kept") {
      NotifyProbe.log(app, "dsh-notify", "popup=false ignored for interactive kind: " + face.category)
    }
    // 类别关闭的交互类：一律走静默渠道（用户要的是「别打扰」，不是「别告诉我」）。
    val channelId = if (form.degradeToSilent || categoryOff) channelFor(app, Face.SILENT) else channelFor(app, face)
    val fallback = channelId ?: channelFor(app, Face.SILENT)
    // S3-1：**系统把渠道降级**（channelFor 回 null）时，交互类会改投静默渠道。旧实现只把这件事写进
    // 探针与一行 flashStatus（面板收起时看不到），用户看到一条不响的提问通知却不知道原因。这里让
    // 「为什么静默 + 怎么恢复」**跟着通知本身走**：通知在哪儿，解释就在哪儿。
    val degradedNotice = if (channelId == null && face.interactive) {
      "系统已把「" + face.label + "」通知降级为静默——到系统设置里可恢复"
    } else null
    if (fallback == null) {
      // 连静默渠道都不可用（极端：用户逐个降级）——明确记录，绝不静默失败
      NotifyProbe.log(app, "dsh-notify", "notify dropped (no usable channel): " + face.category)
      listener?.onChannelDegraded(face.category)
      return Result.DISABLED
    }
    val id = notificationId(entry, face)
    val reportIdentity = if (face == Face.REPORT) NotifySuppressQueue.identity(entry) else null
    val sig = reportIdentity ?: contentSignature(entry)
    val now = System.currentTimeMillis()
    // P3：交互类（提问/审批）**不做**去重——它们按 eventId 各一条，而「同内容再问一次」是需要用户
    // 再答一次的真实事件，吞掉它等于丢掉唯一作答入口（与 DEF-02 的前台抑制例外同一条理由）。
    val interactive = face == Face.QUESTION || face == Face.APPROVAL
    if (!interactive && isDuplicatePost(lastPostId, lastPostSig, lastPostAt, id, sig, now)) {
      NotifyProbe.log(app, "dsh-notify", "notify dropped (duplicate within " + DEDUP_WINDOW_MS + "ms): id=" + id + " kind=" + kind)
      return Result.DUPLICATE_SUPPRESSED
    }
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // The OS notification is the receipt when posting succeeded but journal settlement did not.
    if (reportIdentity != null && NotifySuppressQueue.isPending(app, entry) && manager.activeNotifications.any {
      it.id == id && it.notification.extras.getString("dsh.deferred.identity") == reportIdentity
    }) return Result.DUPLICATE_SUPPRESSED
    val notification = build(app, face, entry, fallback, form.degradeToSilent, degradedNotice)
    if (reportIdentity != null) notification.extras.putString("dsh.deferred.identity", reportIdentity)
    manager.notify(id, notification)
    lastPostId = id
    lastPostSig = sig
    lastPostAt = now
    val note = if (form.degradeToSilent) " silentDegrade=true" else ""
    NotifyProbe.log(
      app, "dsh-notify",
      "notify: kind=" + kind + " id=" + id + " channel=" + fallback + " title=" + entry.displayTitle() + note,
    )
    return Result.POSTED
  }

  /**
   * 待投队列的覆盖式去重键（FIX-1）。
   *
   * 同会话的多次汇报共用一个 `notificationId`（[notificationId] 的 `dsh-report:<sessionId>`），
   * 因此延后队列必须用**同一粒度**去重——否则退后台会为同一会话补弹一串陈旧汇报，
   * 与「覆盖式 ID」的既有语义自相矛盾。会话为空时退化为事件身份（不得让不同事件互相吞掉）。
   */
  internal fun deferredKey(entry: NotifyEntry): String = when {
    entry.sessionId.isNotEmpty() -> "report:" + entry.sessionId
    entry.eventId.isNotEmpty() -> "report:" + entry.eventId
    else -> "report:" + entry.kind + ":" + entry.displayTitle()
  }

  /**
   * 补投一条**被延后**的条目（FIX-1）：以 `foreground = false` 走正常投递主体，因此不再命中抑制判定。
   *
   * 为什么必须复用 [deliverEvent] 而不是自己拼通知：渠道选择、`entry.popup` 形态决策、权限/类别门、
   * 通知 ID 覆盖、探针记账五处都只应有一个实现。补投路径另写一份等于制造第二真源。
   */
  fun deliverDeferred(context: Context, entry: NotifyEntry): Result = notifyEvent(context, entry, foreground = false)

  fun hasPermission(app: Context): Boolean =
    Build.VERSION.SDK_INT < 33 ||
      app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED

  /** 通知 ID：静默两类各一条固定 ID；汇报按会话同 ID 覆盖；提问/审批按 eventId 各一条。 */
  fun notificationId(entry: NotifyEntry, face: Face): Int = when (face) {
    Face.SILENT -> ID_WATCHDOG
    Face.TODO -> ID_TODO
    // S3-3：分桶键走 [reportBucketKey]（会话缺失时回退到事件/标题），否则无会话身份的汇报
    // 会全部挤进同一个 ID 互相覆盖。
    Face.REPORT -> stableId("dsh-report:" + reportBucketKey(entry))
    else -> stableId("dsh-" + face.category + ":" + entry.eventId)
  }

  /** 稳定正整数 ID（同键恒同 ID＝覆盖式更新）。 */
  fun stableId(key: String): Int = (key.hashCode() and 0x7fffffff).let { if (it == 0) 1 else it }

  /** cancel 帧 / resolve 行 → 撤对应提问与审批通知（NT-13）。 */
  fun cancel(context: Context, eventId: String) {
    if (eventId.isEmpty()) return
    val app = context.applicationContext
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    for (face in listOf(Face.QUESTION, Face.APPROVAL)) {
      manager.cancel(stableId("dsh-" + face.category + ":" + eventId))
    }
    LogCollector.log("dsh-notify", "cancel(eventId=" + eventId + ")")
  }

  /** 结算后撤掉弹窗（NT-19：审批结算后立即 cancel，不留历史）。 */
  fun cancelEvent(context: Context, face: Face, eventId: String) {
    if (eventId.isEmpty()) return
    val app = context.applicationContext
    (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .cancel(stableId("dsh-" + face.category + ":" + eventId))
    LogCollector.log("dsh-notify", "cancel(" + face.category + " eventId=" + eventId + ")")
  }

  /**
   * 结算一条**交互类**通知（DEF-NOTIFY-03b，平台契约）：先同 (tag,id) 重投一次「已提交」版本，
   * 再撤。
   *
   * 为什么不能直接 cancel：经 RemoteInput 直接回复过的通知会被系统打上
   * LIFETIME_EXTENDED_BY_DIRECT_REPLY，并把 mCanceledAfterLifetimeExtension 置 true ——
   * 此后应用侧 cancel() 被平台忽略（实测 id 仍在活跃列表、when 不变），目的就是不让
   * 「正在发送」的回复 UI 在应用收尾前消失。官方流程是**再 notify() 一次**（重投即清掉该标志），
   * 之后才能真正撤掉。所以这里两步走：notify(已提交/静默) → 短延时 cancel。
   */
  fun settleInteractive(context: Context, kind: String, eventId: String, remote: Boolean = false) {
    val app = context.applicationContext
    val face = Face.of(kind.lowercase()) ?: Face.QUESTION
    val channelId = channelFor(app, face) ?: channelFor(app, Face.SILENT) ?: return
    val copy = settleCopy(kind, remote)
    val entry = NotifyEntry(kind = kind, eventId = eventId, title = copy.title)
    val id = notificationId(entry, face)
    val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    try {
      manager.notify(
        id,
        NotificationCompat.Builder(app, channelId)
          .setSmallIcon(android.R.drawable.stat_notify_chat)
          .setContentTitle(copy.title)
          .setContentText(copy.text)
          .setAutoCancel(true)
          .setSilent(true)
          .setOnlyAlertOnce(true)
          .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
          .build(),
      )
      NotifyProbe.log(app, "dsh-notify", "settle re-post ok kind=" + kind + " id=" + id)
    } catch (t: Throwable) {
      NotifyProbe.log(app, "dsh-notify", "settle re-post failed kind=" + kind + " id=" + id + ": " + t)
    }
    // 重投已清掉 LIFETIME_EXTENDED_BY_DIRECT_REPLY，稍后再撤（同一次 binder 序列里立即撤有竞态风险）
    try {
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        cancelEvent(app, face, eventId)
      }, 400L)
    } catch (_: Throwable) {
      cancelEvent(app, face, eventId)
    }
  }

  /** 静默类（看门狗/引擎状态）单条覆盖式投递的便捷入口（W 类）。 */
  fun silent(context: Context, event: String, title: String, text: String, sessionId: String = "", count: Int = 1): Result =
    notifyEvent(
      context,
      NotifyEntry(
        kind = "silent", event = event, title = title, text = text,
        sessionId = sessionId, count = count, dedupeKey = "wd:" + event,
      ),
    )

  /**
   * @param silentOverride DEF-NOTIFY-01：单条事件被引擎否决弹窗（entry.popup=false）时，
   *   用静默渠道 + 静默标志投递（条目仍可见），不再 heads-up。
   */
  private fun build(
    app: Context,
    face: Face,
    entry: NotifyEntry,
    channelId: String,
    silentOverride: Boolean = false,
    degradedNotice: String? = null,
  ): Notification {
    val b = NotificationCompat.Builder(app, channelId)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setAutoCancel(true)
      .setOnlyAlertOnce(!face.popup || silentOverride)
      .setWhen(System.currentTimeMillis())
    when (face) {
      Face.SILENT -> {
        b.setContentTitle(entry.displayTitle())
        b.setContentText(entry.text.ifBlank { "引擎状态更新" })
        b.setSilent(true) // 第二道保险（javadoc 明写它同时阻止 peek）
        if (entry.count > 1) b.setSubText("共 " + entry.count + " 条")
      }
      Face.TODO -> {
        b.setContentTitle(entry.displayTitle())
        b.setContentText(if (entry.current.isBlank()) "步骤 " + entry.done + "/" + entry.total else "当前：" + entry.current)
        b.setSubText("步骤 " + entry.done + "/" + entry.total)
        b.setProgress(entry.total.coerceAtLeast(0), entry.done.coerceAtLeast(0), false)
        b.setSilent(true)
        b.setCategory(NotificationCompat.CATEGORY_PROGRESS)
        b.setOnlyAlertOnce(true)
      }
      Face.REPORT -> {
        b.setContentTitle(entry.displayTitle())
        b.setContentText(reportLine(entry))
        b.setStyle(NotificationCompat.BigTextStyle().bigText(reportBigText(entry)))
        b.setSubText(UserCopy.reportMetaLine(entry.durationLabel(), entry.toolCount))
        if (!silentOverride) b.setPriority(NotificationCompat.PRIORITY_HIGH)
      }
      Face.QUESTION -> {
        val questions = entry.questions
        val first = questions.firstOrNull()
        b.setContentTitle(first?.header?.ifBlank { null } ?: UserCopy.notifyCategory(Face.QUESTION.category))
        // S3-4：旧写法是 `first?.question ?: entry.text.ifBlank {...}`——`first.question` 是**空串**
        // （非 null）时 elvis 不触发，通知正文于是空白。`ifBlank { null }` 才能让空串也落到兜底。
        b.setContentText(first?.question?.ifBlank { null } ?: entry.text.ifBlank { "引擎正在等待你的回答" })
        b.setStyle(NotificationCompat.BigTextStyle().bigText(questionBigText(entry)))
        b.setPriority(NotificationCompat.PRIORITY_HIGH)
        // S3-6：**不再** setTimeoutAfter(30 分钟)。引擎侧的提问没有超时，而通知栏是唯一的作答入口
        // ——「30 分钟后无声消失、引擎仍在等」与 P0-5（关掉提醒 = 任务永久挂起）是同一形态的静默失败。
        // 通知寿命现在与请求寿命一致：由 cancel 帧（引擎撤销/他人已答）或本机提交来结算。
        addQuestionActions(app, b, entry)
      }
      Face.APPROVAL -> {
        // S3-8：旧标题恒为类别词「需要授权」，把引擎给的**具体对象**（工具名）丢在正文里——用户
        // 一眼看到「需要授权」四个字，不知道要放行什么。标题带上具体对象，类别词只作兜底。
        b.setContentTitle(
          entry.toolName.ifBlank { null }?.let { "「" + it + "」需要授权" }
            ?: entry.displayTitle().ifBlank { UserCopy.notifyCategory(Face.APPROVAL.category) },
        )
        b.setContentText(approvalLine(entry))
        b.setStyle(NotificationCompat.BigTextStyle().bigText(approvalLine(entry) + "\n仅本次生效"))
        b.setSubText("仅本次生效")
        b.setPriority(NotificationCompat.PRIORITY_HIGH)
        addApprovalActions(app, b, entry)
      }
    }
    // S3-1：降级告示只在传了它时出现，且不覆盖更具体的 subText（如提问的「仅本次生效」）。
    if (degradedNotice != null) b.setSubText(degradedNotice)
    b.setContentIntent(contentIntent(app, entry))
    // DEF-NOTIFY-01：降级为静默条目时补静默标志（渠道已是 dsh-silent，这是第二道保险）
    if (silentOverride) {
      b.setSilent(true)
      b.setOnlyAlertOnce(true)
    }
    // 弹窗类锁屏脱敏（NT-19 初版：锁屏只看见通用文案）；静默降级条目不需要公版
    if (face.popup && !silentOverride) {
      b.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      b.setPublicVersion(
        NotificationCompat.Builder(app, channelId)
          .setSmallIcon(android.R.drawable.stat_notify_chat)
          .setContentTitle(UserCopy.APP_NAME)
          .setContentText("有一项需要你的决定")
          .build(),
      )
    }
    return b.build()
  }

  private fun reportLine(entry: NotifyEntry): String {
    val head = entry.outcomeLabel.ifBlank { entry.outcomeLabel() }
    val summary = if (entry.summary.isNotBlank()) entry.summary else entry.text
    return if (summary.isBlank()) head else head + " · " + summary
  }

  private fun reportBigText(entry: NotifyEntry): String {
    val sb = StringBuilder(reportLine(entry))
    sb.append("\n").append(UserCopy.reportMetaLine(entry.durationLabel(), entry.toolCount))
    if (entry.presentedFiles.isNotEmpty()) {
      sb.append("\n产出：").append(entry.presentedFiles.joinToString("、"))
    }
    return sb.toString()
  }

  /**
   * 审批正文（S3-7）：保留被操作目标的可辨识末段，而不是把整条路径抹成 `[路径]`。
   * 用户要确认的**正是那个目标**；抹掉它等于让用户在不知道放行什么的情况下点「批准一次」。
   */
  private fun approvalLine(entry: NotifyEntry): String {
    val tool = entry.toolName.ifBlank { "未知工具" }
    val reason = entry.reason.trim()
    return if (reason.isBlank()) "工具 " + tool + " 请求执行" else "工具 " + tool + "：" + redactPathsKeepingTail(reason)
  }

  /** 正文脱敏：绝对路径截断 + token 形态遮挡（§5.6；不改写 engine.log 本体）。 */
  fun sanitize(text: String): String {
    var s = text.replace(Regex("""(/data/[^\s:，。；]+)"""), "[路径]")
    s = s.replace(Regex("""(?i)\b(token|secret|password|apikey|api_key)=([^\s&]+)"""), "\$1=***")
    return if (s.length > 180) s.take(179) + "…" else s
  }

  /** 通知点击只能拉起 Activity（Android 12+ trampoline 禁令：动作一律广播）。 */
  private fun contentIntent(app: Context, entry: NotifyEntry): PendingIntent {
    val intent = Intent(app, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(EXTRA_KIND, entry.kind)
      // P0-1：目标键按**语义**分开（旧实现把 sessionId 与 agentId 依次写进同一个
      // "dsh.notify.target"——后写覆盖先写，两种 id 混用，接线必读错）。落点由
      // MainActivity 读取并路由到对应会话（页面侧 window.__dshOpenSession）。
      if (entry.sessionId.isNotEmpty()) putExtra(EXTRA_TARGET_SESSION, entry.sessionId)
      entry.target?.let { if (it.isNotEmpty()) putExtra(EXTRA_TARGET_AGENT, it) }
    }
    return PendingIntent.getActivity(
      app,
      stableId("dsh.open:" + entry.kind + ":" + entry.sessionId + ":" + entry.eventId),
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun actionIntent(
    app: Context,
    entry: NotifyEntry,
    action: String,
    option: String? = null,
    questionId: String? = null,
  ): Intent =
    Intent(app, NotifyActionReceiver::class.java).apply {
      // 显式 Intent（component 指向本包 receiver，exported=false）——动作处理器不 startActivity
      this.action = NotifyActionReceiver.ACTION_NOTIFY_ACTION
      putExtra(NotifyActionReceiver.EXTRA_ACTION, action)
      putExtra(NotifyActionReceiver.EXTRA_EVENT_ID, entry.eventId)
      putExtra(NotifyActionReceiver.EXTRA_KIND, entry.kind)
      option?.let { putExtra(NotifyActionReceiver.EXTRA_OPTION, it) }
      questionId?.let { putExtra(NotifyActionReceiver.EXTRA_QUESTION_ID, it) }
    }

  /** 动作 PendingIntent requestCode 必须按 (eventId, action) 唯一：Intent 过滤等价不含 extras。 */
  private fun actionPending(
    app: Context,
    entry: NotifyEntry,
    action: String,
    mutable: Boolean,
    option: String? = null,
    questionId: String? = null,
  ): PendingIntent {
    val flags = (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE) or PendingIntent.FLAG_UPDATE_CURRENT
    val key = "dsh.action:" + entry.eventId + ":" + action + (option?.let { ":" + it } ?: "")
    return PendingIntent.getBroadcast(app, stableId(key), actionIntent(app, entry, action, option, questionId), flags)
  }

  /**
   * 提问正文的多问形态（S3-5）：逐个列出问题，并在**不能给按钮**时明说去哪儿作答。
   *
   * 旧行为：正文只 join 各问的 `question`，而选项多于两个的问句在通知里没有任何动作——用户看到
   * 三四个选项的问句，却发现通知栏里点不出东西，也没人告诉他去应用里答。
   */
  private fun questionBigText(entry: NotifyEntry): String {
    val lines = entry.questions.map { it.question }.filter { it.isNotBlank() }
    val body = if (lines.isEmpty()) "引擎正在等待你的回答" else lines.joinToString("\n")
    return if (questionNeedsAppEntry(entry)) body + "\n（本题选项多于两个，请打开应用作答）" else body
  }

  /**
   * 纯判据：这条提问是否**无法**在通知栏作答（选项多于两个 ⇒ 通知里没有对应按钮）。
   * @param entry - 通知条目。
   * @returns true = 需要在通知里显式给出「打开应用作答」的入口。
   */
  internal fun questionNeedsAppEntry(entry: NotifyEntry): Boolean =
    entry.questions.any { it.options.size > 2 }

  private fun addQuestionActions(app: Context, b: NotificationCompat.Builder, entry: NotifyEntry) {
    // 动作 1：直接回复（RemoteInput）。只有回复动作开 mutable——结果经 ClipData 注入，
    // FLAG_IMMUTABLE 会让回复静默失败（§6.3.1 / NT-16）。
    val remote = RemoteInput.Builder(NotifyActionReceiver.REPLY_KEY)
      .setLabel("回复")
      .build()
    val firstQuestionId = entry.questions.firstOrNull()?.id
    val reply = NotificationCompat.Action.Builder(
      android.R.drawable.ic_menu_send,
      "回复",
      actionPending(app, entry, NotifyActionReceiver.ACTION_REPLY, mutable = true, questionId = firstQuestionId),
    )
      .addRemoteInput(remote)
      .setAllowGeneratedReplies(false)
      .build()
    b.addAction(reply)
    // 选项动作：仅当 options 存在且 <= 2（多问/多选引导回应用/悬浮球）
    for (q in entry.questions) {
      if (q.options.size in 1..2) {
        for (opt in q.options) {
          b.addAction(
            NotificationCompat.Action.Builder(
              android.R.drawable.ic_menu_agenda,
              opt,
              actionPending(app, entry, NotifyActionReceiver.ACTION_OPTION, mutable = false, option = opt, questionId = q.id),
            ).build(),
          )
        }
      }
    }
    // S3-5：选项多于两个 ⇒ 上面一个按钮都加不出来，用户在通知栏无从作答。旧实现什么都不加、
    // 也不提示；现在显式给一个「打开应用作答」的入口（与通知点击同一条 contentIntent）。
    if (questionNeedsAppEntry(entry)) {
      b.addAction(
        NotificationCompat.Action.Builder(
          android.R.drawable.ic_menu_view,
          "打开应用作答",
          contentIntent(app, entry),
        ).build(),
      )
    }
  }

  private fun addApprovalActions(app: Context, b: NotificationCompat.Builder, entry: NotifyEntry) {
    // 审批动作恒为两个（NT-21）：批准一次 / 拒绝。不提供任何常驻授权承诺。
    val approve = NotificationCompat.Action.Builder(
      android.R.drawable.ic_menu_edit,
      "批准一次",
      actionPending(app, entry, NotifyActionReceiver.ACTION_APPROVE, mutable = false),
    )
    val reject = NotificationCompat.Action.Builder(
      android.R.drawable.ic_menu_close_clear_cancel,
      "拒绝",
      actionPending(app, entry, NotifyActionReceiver.ACTION_REJECT, mutable = false),
    )
    if (APPROVAL_REQUIRE_UNLOCK) {
      approve.setAuthenticationRequired(true)
      reject.setAuthenticationRequired(true)
    }
    b.addAction(approve.build())
    b.addAction(reject.build())
  }

  /**
   * 投递失败的**可见态**（NT-17；§3.3 批 8 重做）。
   *
   * 三处旧形态在本批被收掉：
   *  - **S3-12 覆盖原内容**：旧实现用 `notificationId(entry, face)`（与原提问/审批**同一个 ID**），
   *    于是失败通知把用户正在看的提问内容整个替换掉——用户既看不到自己答的是什么，也看不到原问题。
   *    现在失败通知有**自己的 ID 桶**，并且**主动撤掉**原交互通知（它的按钮已经无意义）。
   *  - **S3-11 死按钮**：旧实现无条件加「重试」按钮，而「该请求已失效」（引擎重启后 eventId 不在
   *    交付表）这一类失败**重试必然同样失败**——按钮点下去什么也不会发生。现在按 [retryable] 决定
   *    是否有重试动作：不可重试的只说清后果与下一步。
   *  - **上下文丢失**：旧实现只给一句「提交失败」。现在 [detail] 带上失败的那次作答（已截断），
   *    用户知道「我答的是哪一条没送到」。
   *
   * @param kind - 交互类型（question/approval）。
   * @param eventId - 事件 id。
   * @param title - 失败标题（如「提交失败」/「该请求已失效」）。
   * @param text - 用户可读正文（含下一步）。
   * @param retryable - 重试是否**可能**成功（false ⇒ 不加重试动作，避免死按钮）。
   * @param detail - 失败上下文（如被提交的答案文本），可为空；只作正文补充。
   */
  fun postDeliveryFailure(
    context: Context,
    kind: String,
    eventId: String,
    title: String,
    text: String,
    retryable: Boolean = true,
    detail: String = "",
  ) {
    val app = context.applicationContext
    val face = Face.of(kind.lowercase()) ?: Face.QUESTION
    if (!hasPermission(app)) {
      LogCollector.log("dsh-notify", "delivery failure visible skipped (no permission): " + title)
      return
    }
    val channelId = channelFor(app, face) ?: channelFor(app, Face.SILENT) ?: return
    // S3-12：撤掉原交互通知（同 eventId 的两个候选 ID 都撤），否则通知栏上会同时留着一条
    // 「点了没反应」的旧提问/审批。
    cancel(app, eventId)
    val body = if (detail.isBlank()) text else text + "\n你所提交的内容：" + UserCopy.truncateWithEllipsis(detail, 60)
    val b = NotificationCompat.Builder(app, channelId)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      // 点击打开应用（用户下一步多半是去应用里重做）——比一个死按钮有用。
      .setContentIntent(contentIntent(app, NotifyEntry(kind = kind, eventId = eventId, title = title)))
    if (retryable) {
      val retry = Intent(app, NotifyActionReceiver::class.java).apply {
        action = NotifyActionReceiver.ACTION_NOTIFY_ACTION
        putExtra(NotifyActionReceiver.EXTRA_ACTION, NotifyActionReceiver.ACTION_RETRY)
        putExtra(NotifyActionReceiver.EXTRA_EVENT_ID, eventId)
        putExtra(NotifyActionReceiver.EXTRA_KIND, kind)
      }
      val pending = PendingIntent.getBroadcast(
        app,
        stableId("dsh.retry:" + eventId),
        retry,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      b.addAction(NotificationCompat.Action.Builder(android.R.drawable.ic_menu_rotate, "重试", pending).build())
    }
    (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
      .notify(failureId(kind, eventId), b.build())
    LogCollector.log(
      "dsh-notify",
      "delivery failure visible: kind=" + kind + " eventId=" + eventId + " retryable=" + retryable + " text=" + text,
    )
  }

  /** 失败通知的独立 ID 桶（S3-12：不得覆盖原提问/审批通知的 ID）。 */
  internal fun failureId(kind: String, eventId: String): Int =
    stableId("dsh-failure:" + kind.lowercase() + ":" + eventId)

  /**
   * 发送**全部五类**测试通知（设置页「通知」分区的自证按钮；0.14.1 批 8 / S3-26）。
   *
   * 为什么需要它：`sendTest` 此前**全仓零调用点**——「能力在、入口无」，与 J-1 同形。而通知这一族
   * 最需要用户自证的问题恰恰是：「我把某个提醒关了 / 系统把渠道降级了之后，任务完成还会不会提醒我？」
   * 自检面告诉用户**渠道状态**，这个按钮让用户看到**实际到达效果**（哪几条真的弹出来、哪几条是静默）。
   *
   * 五类各发一条（静默类也会发，但用户在通知栏能看见它——「没弹出来」正是要观察的事实）。
   * 权限缺失时不发送并如实回 0，由界面提示（不静默）。
   * @param context - 任意 context。
   * @returns 实际投递成功的条数（0..5）。
   */
  fun sendTestAll(context: Context): Int {
    val app = context.applicationContext
    if (!hasPermission(app)) {
      NotifyProbe.log(app, "dsh-notify", "sendTestAll skipped (POST_NOTIFICATIONS not granted)")
      listener?.onPermissionDenied()
      return 0
    }
    var posted = 0
    for (category in listOf("report", "question", "approval", "todo", "silent")) {
      if (sendTest(app, category) == Result.POSTED) posted++
    }
    NotifyProbe.log(app, "dsh-notify", "sendTestAll posted=" + posted + "/5")
    return posted
  }

  /** 发送测试通知（设置页自证按钮；按类各一条；权限缺失时二次请求由界面负责）。 */
  fun sendTest(context: Context, category: String): Result {
    val entry = when (category) {
      "todo" -> NotifyEntry(kind = "todo", sessionId = "test", total = 5, done = 2, current = "测试进度")
      "report" -> NotifyEntry(
        kind = "report", sessionId = "test", title = "测试会话", outcome = "completed",
        outcomeLabel = "已完成", summary = "这是一条工作汇报测试", durationMs = 12_000, toolCount = 3,
      )
      "question" -> NotifyEntry(
        kind = "question", eventId = "test-q",
        questions = listOf(NotifyQuestion("q1", "测试提问", "现在方便吗？", emptyList())),
      )
      "approval" -> NotifyEntry(kind = "approval", eventId = "test-a", toolName = "bash", reason = "测试授权请求")
      else -> NotifyEntry(kind = "silent", event = "test", title = "后台动态测试", text = "引擎状态正常")
    }
    return notifyEvent(context, entry)
  }

  /**
   * 旧调用点兼容（WatchdogV2.consumeTaskDoneMarkers / MainActivity.onNotify 仍在用旧签名）。
   * 语义已降级为静默类；.task-done.ndjson 兼容期只做回退（双读不双发，见 NotifyStore）。
   */
  fun notify(context: Context, category: String, title: String, text: String, target: String? = null) {
    notifyEvent(
      context,
      NotifyEntry(
        kind = "silent",
        event = "legacy:" + category,
        title = title,
        text = text,
        sessionId = target ?: "",
        target = target,
        dedupeKey = "legacy:" + category,
      ),
    )
  }
}

/**
 * 渠道展示名是否需要校正（0.14.1 批 3 / P3-2；**顶层纯函数**，JVM 可直接测）。
 *
 * 为什么需要它：`createNotificationChannel` 只在「需要创建/迁移」时被调用，importance 已达标的
 * 既有渠道**永不再走创建分支** ⇒ 改代码里的用词到不了老装机（设备实测：把「需要回答」改成
 * 「提问」后，系统通知设置里仍是「需要回答」）。判据只看「现状与期望是否一致」，不碰 importance。
 * @param currentName - 系统里该渠道的当前展示名。
 * @param currentDescription - 系统里该渠道的当前说明。
 * @param expectedName - 期望展示名（唯一真源 [UserCopy.notifyCategory] 派生的 `Face.label`）。
 * @param expectedDescription - 期望说明（`Face.description`）。
 * @returns true = 需要重建该渠道以更新展示名/说明。
 */
internal fun channelRenameNeeded(
  currentName: String,
  currentDescription: String?,
  expectedName: String,
  expectedDescription: String,
): Boolean = currentName != expectedName || (currentDescription ?: "") != expectedDescription

/** 一条提问（通知里只重建展示所需字段；应答仍走引擎 waterfall / $events/result）。 */data class NotifyQuestion(
  val id: String,
  val header: String = "",
  val question: String = "",
  val options: List<String> = emptyList(),
)

/**
 * 通知信道条目（.notify.ndjson 一行 / NotifyBridge 的 waterfall 帧投影）。
 * 解析在 NotifyStore.parseEntry（纯逻辑 + org.json），投递在 NotifyCenter.notifyEvent。
 */
data class NotifyEntry(
  val kind: String,
  val title: String = "",
  val text: String = "",
  val event: String = "",
  val dedupeKey: String = "",
  val sessionId: String = "",
  val eventId: String = "",
  val count: Int = 1,
  val done: Int = 0,
  val total: Int = 0,
  val current: String = "",
  val outcome: String = "",
  val outcomeLabel: String = "",
  val summary: String = "",
  /**
   * 该轮可见正文全文（有界 8 KiB，保留换行；0.14.1 D6）。报告栏可滚动区的内容来源。
   * 空串 = 该轮没有可见正文或条目来自旧版引擎（此时报告栏回落 summary，见 reportBodyText）。
   */
  val body: String = "",
  val durationMs: Long = 0,
  val durationLabel: String = "",
  val toolCount: Int = 0,
  val turn: Int = 0,
  val presentedFiles: List<String> = emptyList(),
  val popup: Boolean = true,
  val toolName: String = "",
  val reason: String = "",
  val questions: List<NotifyQuestion> = emptyList(),
  val target: String? = null,
) {
  fun displayTitle(): String = title.ifBlank {
    if (kind == "report") {
      UserCopy.notifyCategory(NotifyCenter.Face.REPORT.category)
    } else {
      UserCopy.APP_NAME
    }
  }

  fun outcomeLabel(): String = when (outcome) {
    "completed" -> "已完成"
    "error" -> "失败"
    "blocked" -> "被阻塞"
    "aborted" -> "已中止"
    "max-tokens" -> "输出超限"
    "interrupted" -> "被中断"
    else -> if (outcome.isBlank()) "" else "结果未知"
  }

  /**
   * 时长标签（P3-3，唯一口径 [UserCopy.durationText]）。
   *
   * 引擎侧若已给出 `durationLabel` 则原样透传（那是引擎的事实，不在这里改写）；否则按统一口径由
   * 毫秒数算。**未知返回空串**——旧实现回 `-`（用户分不清「未知」与「零」），调用方现在整段省略。
   */
  fun durationLabel(): String =
    if (this.durationLabel.isNotBlank()) this.durationLabel else UserCopy.durationText(durationMs)
}
