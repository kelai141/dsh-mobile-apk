package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * 「AI root 权限」授权门（issue #262 方案 A：策略门 + 免责确认门 + 通道身份探测）。
 *
 * ── 本开关**不授予任何能力**（诚实性要求，issue 原文）────────────────────────────
 * root 能力来自真实 root Shizuku 或显式授权的 su，不是本开关给的；两条路径是替代关系。
 * 本开关真实的作用只有两件：
 *  1. **策略门**：通道身份为 root 且未授权时，特权执行面整体拒绝（见 [ShizukuTransport]
 *     的 rootGateRefusal）——不是按 op 分类放行（uid 0 下 `shExec` 是任意 shell，
 *     op 白名单挡不住引号逃逸，分类隔离是假的，故整体 fail-closed）。
 *  2. **知情同意与免责**：开启前必须勾选「已阅读」并打开过免责声明；同意绑定的是
 *     [DISCLAIMER_REVISION]（免责声明**内容**版本），**不是** APK 的 versionCode。
 *
 * ── 0.14.7 修复：同意不再随 APK 升级失效 ────────────────────────────────────────
 * 旧实现要求同意值「必须等于当前 BuildConfig.VERSION_CODE」，于是每次版本号 +1 都会
 * 清掉用户的「已阅读」并把开关一起关掉（用户实测：「root 免责声明每次更新怎么都会掉」）。
 * 现在只在免责声明**内容**变更（[DISCLAIMER_REVISION] +1）时才要求重新确认，APK 升级
 * 不再误伤。安全属性一律不变：取消勾选仍然立即撤销同意并同时关闭开关；未同意者仍开不了。
 *
 * ── 通道身份 ≠ 设备是否 root（探测判据，issue 原文）────────────────────────────
 * 已 root 但 Shizuku 以 ADB（uid 2000）启动的设备，通道只有 shell 权限——此时本开关
 * 若也没有显式授权 su，开关才置灰并给通道/管理器引导；不能据 uid2000 猜设备未 root。
 *
 * ── 纯逻辑与持久化分离（与 [ShizukuBindState] 同纪律）──────────────────────────
 * 决策核心 [decision] 是纯函数（JVM 可测，不需要 Robolectric）：
 *  - 未勾选/同意落后于当前免责声明版本 → 不许开启（`consent-required`）；
 *  - 通道身份非 root → 不许开启（`not-root-channel`，界面对应置灰+红字）；
 *  - 取消勾选「已阅读」→ 撤销同意并**同时关闭开关**（不留「已授权但未同意」的矛盾态）。
 * 持久化是薄壳：`granted` 与 `consentRevision` 存私有 SharedPreferences；旧键
 * `consentVersionCode`（旧语义 = APK versionCode）只读迁移一次，见 [consentRevision]。
 */
object RootGrant {

  /** 拒绝码：通道身份不是 root（uid≠0），开关应当置灰。 */
  const val CODE_NOT_ROOT_CHANNEL = "not-root-channel"

  /** 拒绝码：免责确认（勾选「已阅读」）缺失，或落后于当前免责声明内容版本。 */
  const val CODE_CONSENT_REQUIRED = "consent-required"

  /**
   * 拒绝码：应用自身尚未从 Root 管理器获得 root 授权（2026-09-30 主人定例）。
   * 应用 su 未授权时的拒绝词；检测只由用户显式请求，不保证管理器自动弹窗。
   */
  const val CODE_ROOT_NOT_GRANTED = "root-not-granted"

  /** 通道 uid 的 root 判据（与 [ShizukuProbe]/[ShizukuTransport.status] 的 identity 同源）。 */
  const val ROOT_UID = 0

  /**
   * 免责声明**内容**版本——这是同意真正绑定的东西，**不是** APK 版本号。
   *
   * 只在 `assets/docs/root-disclaimer.html` 的实质内容变更（新增/删除条款、改变风险
   * 披露口径）时才 +1；APK 版本号递增与它无关。+1 会要求所有用户重新勾选「已阅读」，
   * 所以改它必须同时改文案（`user-copy.ts` / `phone-control.tsx` 的提示）与相关测试。
   * 1 = 0.14.2 首发内容（0.14.7 起由 versionCode 绑定改为内容版本绑定）。
   */
  const val DISCLAIMER_REVISION = 1

  private const val PREFS = "dsh_root_grant"
  private const val KEY_GRANTED = "granted"

  /** 当前键：同意所绑定的免责声明内容版本（0 = 从未同意或已撤销）。 */
  private const val KEY_CONSENT_REV = "consentRevision"

  /**
   * 旧键（0.14.6 及以前）：值 = 当时的 APK versionCode。**只读**，仅用于一次性迁移。
   * 撤销时会被一并清零（见 [setConsent]），否则迁移逻辑会把已撤销的旧同意复活。
   */
  private const val KEY_CONSENT_VC = "consentVersionCode"

  /**
   * 开关决策（纯函数）。
   *
   * @param channelUid Shizuku 通道身份（服务端 uid；读不到时传 -1，按非 root 处理——fail-closed）。
   * @param granted 当前开关位。
   * @param consentRevision 已记录的同意所绑定的免责声明版本；0 = 从未同意（fail-closed）。
   * @param currentRevision 当前要求的免责声明版本（生产环境恒为 [DISCLAIMER_REVISION]；
   *   **不传 APK versionCode**——传了就等于恢复「升级即失效」的旧缺陷）。
   * @param wantOn 用户想要开启还是关闭。
   * @return `null` = 允许按 [wantOn] 变更；非空 = 结构化拒绝（code 见上方常量）。
   */
   fun decision(
    channelUid: Int,
    rootGranted: Boolean,
    granted: Boolean,
    consentRevision: Int,
    currentRevision: Int,
    wantOn: Boolean,
    /** When set, guidance text follows this locale instead of the process default. */
    context: Context? = null,
  ): JSONObject? {
    if (!wantOn) return null // 关闭永远允许（撤销不是需要资格的动作）
    if (channelUid != ROOT_UID && !rootGranted) {
      return JSONObject().put("ok", false).put("code", CODE_NOT_ROOT_CHANNEL)
        .put("guidance", UiText.t(context, "无法在未 root 的设备上赋予该权限", "This permission needs a rooted device"))
    }
    if (!consentValidFor(consentRevision, currentRevision)) {
      return JSONObject().put("ok", false).put("code", CODE_CONSENT_REQUIRED)
        .put("guidance", UiText.t(context, "先阅读并同意免责声明，才能开启 AI root 权限。", "Read and accept the disclaimer to enable AI root access."))
    }
    // Shizuku-root and explicitly granted su are independent root transports.
    // Neither route bypasses the effective current-revision AI consent at dispatch.
    return null
  }

  /**
   * 同意判据（纯函数）：勾选过（>0）且覆盖当前要求的免责声明版本。
   * **0/负数不算同意**（fail-closed）；这里刻意不出现 `BuildConfig.VERSION_CODE`——
   * 「同意与 APK 版本号解绑」是本类的核心不变量，谁把 versionCode 加回来谁就复活了旧缺陷。
   */
  internal fun consentValidFor(revision: Int, requiredRevision: Int): Boolean =
    revision > 0 && revision >= requiredRevision

  /** 「已阅读」同意是否对当前免责声明版本有效（**0 不算同意**——fail-closed）。 */
  fun consentValid(context: Context): Boolean =
    consentValidFor(consentRevision(context), DISCLAIMER_REVISION)

  /** 当前开关位（默认 false——fail-closed：装完/从未同意时 root 通道保持关闭）。 */
  internal fun effectiveGrant(granted: Boolean, consentRevision: Int, requiredRevision: Int): Boolean =
    granted && consentValidFor(consentRevision, requiredRevision)

  fun isGranted(context: Context): Boolean = effectiveGrant(
    prefs(context).getBoolean(KEY_GRANTED, false),
    consentRevision(context),
    DISCLAIMER_REVISION,
  )

  /** 廉价开关位：只读已持久化的开关，不做「是否仍有 su」与 ownership 读面。 */
  internal fun storedSwitch(context: Context): Boolean =
    prefs(context).getBoolean(KEY_GRANTED, false)

  /**
   * 勾选/取消「已阅读」。
   *
   * 勾选 = 记录同意并绑定当前 [DISCLAIMER_REVISION]；**取消勾选即撤销同意并同时关闭开关**
   * （issue 用户指定语义，不留矛盾态）。返回写后读回的状态 JSON。
   *
   * 回包必须带 `ok:true`：页面结算（settleLinkCall）只认 `ok === true`，缺这个字段会把
   * 已成功的写入渲染成失败（2026-09-30 用户实测「撤销同意失败」——状态其实已生效）。
   */
  fun setConsent(context: Context, on: Boolean): JSONObject {
    val app = context.applicationContext
    if (on) {
      // Reconfirming a stale consent must not silently reactivate the persisted old switch.
      val keepGranted = isGranted(app)
      prefs(app).edit().putBoolean(KEY_GRANTED, keepGranted)
        .putInt(KEY_CONSENT_REV, DISCLAIMER_REVISION).apply()
    } else {
      // 撤销同意必须连带关开关：只清同意而留着 granted=true 会让「未同意但已授权」
      // 成为可达状态，而那个状态正是免责门要杜绝的。旧键一并清零，否则 [consentRevision]
      // 的只读迁移会把这次撤销的旧同意复活。
      prefs(app).edit().putInt(KEY_CONSENT_REV, 0).putInt(KEY_CONSENT_VC, 0)
        .putBoolean(KEY_GRANTED, false).apply()
    }
    return state(app, channelUidNow(app)).put("ok", true)
  }

  /**
   * 开/关开关。[decision] 判据全部满足才写入；关闭无需资格。
   * 返回写后读回的状态 JSON（拒绝时带 code/guidance，界面据此说话）。
   */
  fun setGranted(context: Context, on: Boolean): JSONObject {
    val app = context.applicationContext
    val uid = channelUidNow(app)
    val refusal = decision(
      channelUid = uid,
      rootGranted = RootAccess.isGranted(app),
      granted = isGranted(app),
      consentRevision = consentRevision(app),
      currentRevision = DISCLAIMER_REVISION,
      wantOn = on,
      context = app,
    )
    if (refusal == null) {
      prefs(app).edit().putBoolean(KEY_GRANTED, on).apply()
    }
    // 拒绝回包同时带 `reason`（= code）：页面结算的人话翻译只读 reason（user-copy.ts 的
    // CALL_REASON 唯一真源），code 留给 data-code/grep。两个都不带会落「未在本版登记」兜底。
    return state(app, uid).let {
      if (refusal != null) {
        it.put("ok", false).put("code", refusal.optString("code"))
          .put("reason", refusal.optString("code"))
          .put("guidance", refusal.optString("guidance"))
      } else {
        it.put("ok", true)
      }
    }
  }

  /**
   * 设置页读面：授权位 + 同意有效性 + 通道身份三件事一次带出。
   *
   * `channelRoot=false` 不排除显式 su 授权；两条路径都不可用才禁止开启。
   * 通道 uid 读不到按 -1，不猜 root；已开启的开关仍允许关闭，consent 始终可撤销。
   *
   * 兼容面：`consentVersionCode` / `currentVersionCode` **字段名保留**（页面与桥对称
   * 门禁读它们，删除或改名即红），但 0.14.7 起其单位是免责声明内容版本而不是 APK 版本号；
   * 新增 `consentRevision` / `currentRevision` 表达同一事实，新代码用新字段。
   * `consentValid` 是唯一权威判据（= consentValidFor(consentRevision, currentRevision)）。
   */
  fun state(context: Context, channelUid: Int): JSONObject {
    val revision = consentRevision(context)
    val valid = consentValidFor(revision, DISCLAIMER_REVISION)
    // E1：这几个读面原先各自重复求值 suPath()/SharedPreferences（最多 7 次），每 2s 轮询都做一遍。
    // 本轮收敛成一次：结论不变（仍是「已授权且同意有效」），只是不再重复付出探测成本。
    val granted = effectiveGrant(storedSwitch(context), revision, DISCLAIMER_REVISION)
    val rootGranted = RootAccess.isGranted(context)
    return JSONObject()
      .put("granted", granted)
      .put("consentValid", valid)
      .put("consentRevision", revision)
      .put("currentRevision", DISCLAIMER_REVISION)
      .put("consentVersionCode", revision)
      .put("currentVersionCode", DISCLAIMER_REVISION)
      .put("channelUid", channelUid)
      .put("channelRoot", channelUid == ROOT_UID)
      .put("canToggle", channelUid == ROOT_UID || rootGranted)
      // 应用级 root 授权（Root 管理器）——开关放行的第三道门，UI 单独一行展示进度与引导。
      .put("rootGranted", rootGranted)
      .put("rootState", RootAccess.state(context, includeOwnership = false).optString("state"))
      .put("ownership", RootOwnershipJobs.state(context))
      // 诚实性说明（issue 要求：做不到技术隔离时不得把不成立的隔离写成事实）：
      .put(
        "honesty",
        UiText.t(context, "这是知情同意门，不是沙箱：root 通道下的命令不受限制。", "This is a consent gate, not a sandbox: commands over the root channel are unrestricted."),
      )
  }

  /**
   * 迁移的**纯逻辑核心**（JVM 可直测，不碰 SharedPreferences）。
   *
   * 语义（0.14.7）：
   *  - 新键 [KEY_CONSENT_REV] `> 0` ⇒ 它已经权威，原样返回（迁移幂等，绝不覆盖新值）；
   *  - 新键为 0 且旧键 [KEY_CONSENT_VC] `> 0` ⇒ 老用户（0.14.6 及以前，旧值 = 当时的 APK
   *    versionCode）同意过的事实必须保住，返回 [currentRevision]（默认 = [DISCLAIMER_REVISION]）；
   *  - 两键都非正数 ⇒ 0（从未同意或已撤销，fail-closed）。
   *
   * **绝不**拿旧值去比 APK versionCode——那正是被修掉的旧缺陷（用户实测「每次更新都掉」）。
   * 迁移只认「旧值 > 0」这一个与版本号无关的事实。
   *
   * @param currentRevision 迁移成功时记入的免责声明版本（生产恒为 [DISCLAIMER_REVISION]）。
   */
  internal fun migratedConsentRevision(
    storedRevision: Int,
    legacyVersionCode: Int,
    currentRevision: Int = DISCLAIMER_REVISION,
  ): Int {
    if (storedRevision > 0) return storedRevision
    if (legacyVersionCode > 0) return currentRevision
    return 0
  }

  /**
   * 已记录的同意所绑定的免责声明版本；0 = 从未同意或已撤销。
   *
   * 持久化薄壳：读两键 → 交给纯函数 [migratedConsentRevision] 裁决 → 迁移发生时把新值
   * 落盘（一次性；此后新键即权威）。判定逻辑全部在纯函数里，故可被 JVM 用例真值驱动。
   */
  private fun consentRevision(context: Context): Int {
    val store = prefs(context)
    val stored = store.getInt(KEY_CONSENT_REV, 0)
    val legacy = store.getInt(KEY_CONSENT_VC, 0)
    val effective = migratedConsentRevision(stored, legacy)
    // 只在「确实是首次迁移」时写回：新键已有值时不写（幂等），两键都非正数时不写（保持 0）。
    if (stored <= 0 && effective > 0) {
      store.edit().putInt(KEY_CONSENT_REV, effective).apply()
    }
    return effective
  }

  /** 当前 Shizuku 通道的服务端 uid（读不到 = -1，不阻塞、不抛出）。 */
  internal fun channelUidNow(context: Context): Int =
    runCatching { rikka.shizuku.Shizuku.getUid() }.getOrDefault(-1)

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
