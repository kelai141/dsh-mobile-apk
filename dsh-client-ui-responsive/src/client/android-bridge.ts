/**
 * Android shell bridge types (window.androidBridge): every method injected by MainActivity's
 * addJavascriptInterface. Single source of truth — theme-bridge and dev-section share this
 * declaration; all methods optional (safe degradation on desktop/non-shell hosts).
 */
/** How the shell should hand a path to the system chooser. */
export type OpenPathMode = 'view' | 'folder'

/** Outcome of one `openPathChooser` call, decoded from the bridge's JSON answer. */
export interface OpenPathResult {
  /** True when the chooser was raised (the user's pick is the system's business). */
  ok: boolean
  /** Failure reason: `unavailable` (no bridge), `no-handler`, `not-allowed`, or a shell error. */
  reason?: string
}

export interface AndroidShellBridge {
  /** H1: sync system-dark query (fallback for vendor WebViews whose matchMedia is stuck on light). */
  getSystemDark?: () => boolean
  /**
   * Linux 环境资产准备（实验性内部插件，默认不启用）。
   *
   * 请求体只有资产清单 `{url, sha256, size}`；落点由壳侧按摘要自行推导，页面无法指定目标路径。
   * 除非 Linux 环境在场（根目录 + bootstrap 状态文件）一律拒绝，故它不是通用下载器。
   * 立即返回 `{ok, phase}`，结果用 `linuxAssetPrepareStatus()` 轮询（下载不得阻塞页面线程）。
   */
  linuxAssetPrepare?: (specJson: string) => string
  /** 读取上一次准备的阶段与失败原因（`phase`/`code`/`detail`/`stagedPath`）。 */
  linuxAssetPrepareStatus?: () => string
  /** Restart the engine service process (kill + watchdog relaunch). */
  /**
   * 重启引擎；返回是否**真的发起了**（false = 已在重启中或上下文缺失）。
   * S3-15：页面据此决定要不要进入「重启中…」的忙碌态——旧签名是 void，页面只能假装忙碌。
   */
  restartEngine?: () => boolean
  /** Shut down the harness: stop the engine and fall back to the init (startup/test) screen (no auto-restart). */
  shutdownToGuide?: () => void
  /** Refresh the Web UI (reload the engine page). */
  reloadWebUI?: () => void
  /** Open the built-in console (snapshot bash interactive terminal). */
  openConsole?: () => void
  /** Dev debug-log toggle state (default off). */
  getDevLogEnabled?: () => boolean
  /** Set the dev debug-log toggle; when on, logs are written daily under dshdata/log/. */
  setDevLogEnabled?: (enabled: boolean) => void
  /** 0.13.1 W4: export the private settings.yaml to Documents/dshdata/exports/config/.
   *  Returns JSON {ok, path?, error?} (synchronous bridge call). */
  exportConfig?: () => string
  /** 0.13.1 W4: import Documents/dshdata/exports/config/settings.yaml back into the
   *  private DSH_HOME (engine hot-reloads via chokidar). Returns JSON {ok, path?, hint?, error?}. */
  importConfig?: () => string
  /** Whether "All Files Access" is granted (prerequisite for external workspaces / public logs). */
  /**
   * 本壳（APK）版本名，来自 `BuildConfig.VERSION_NAME`。
   * 「设置 → 通用」用它显示安装包版本——上游那行「当前版本」只写引擎版本。
   */
  version?: () => string
  hasAllFilesAccess?: () => boolean
  /** Immersive status-bar toggle (true = status bar normally hidden), persisted by the shell. */
  setImmersiveMode?: (enable: boolean) => void
  /** ST-10: current immersive state from the shell truth source (ShellState.ImmersiveMode).
   *  Prefer this over any page-side copy; absent on desktop / older shells (storage fallback applies). */
  getImmersiveMode?: () => boolean
  /** UI language preference from the shell: system, zh, or en. */
  getUiLanguage?: () => string
  /** Store a UI language in the shell and sync it to dsh; returns the stored mode. */
  setUiLanguage?: (mode: string) => string
  /** 0.13.7: open a path through the Android system chooser (MT Manager, system files).
   *  Returns a JSON `{ok, launched?, reason?}` answer; `folder` targets the directory. */
  openPathChooser?: (path: string, mode?: OpenPathMode) => string
  /** 0.13.5 W4: 无障碍控制通道状态 JSON（enabled/label/restrictedHint）。 */
  a11yStatus?: () => string
  /** 0.13.5 W4: 跳系统无障碍设置页，由用户手动开启「DSH 设备控制」。 */
  openA11ySettings?: () => void
  /** 0.14.0: 解锁 Android 13+ 受限设置（appops，经 Shizuku 特权 shell）。返回 JSON {ok, message}。 */
  unlockRestrictedSettings?: () => string
  /** 0.14.1「手机控制」：打开登记在册的外部链接（系统浏览器/默认应用）。
   *  key 只能是 `shizuku-download` / `shizuku-tutorial`——页面不传 URL，URL 表在壳侧。
   *  返回 JSON `{ok, reason?}`（reason ∈ unknown-key / insecure-url / no-handler / 异常类名）。 */
  openExternalLink?: (key: 'shizuku-download' | 'shizuku-tutorial') => string
  /** 0.14.1「手机控制」：拉起 Shizuku 管理器界面（授权只能由用户在 Shizuku 内完成）。
   *  未安装 → `{"ok":false,"reason":"not-installed"}`。 */
  openShizukuManager?: () => string
  /** 0.14.1「手机控制」：Shizuku 特权通道真实状态 JSON（installed/running/granted/bound/binding/code/guidance）。
   *  这是「装没装」的事实判定来源——不是 vdisplayStatus()（后者是虚拟屏状态）。 */
  shizukuStatus?: () => string
  /** 2026-09-30：**显式请求 Shizuku 授权**（UI 线程 + 前台 Activity 发起，管理器弹授权对话框）。
   *  后台自动请求落不到用户眼前（实测：管理器「应用管理」列表里根本没有本应用、状态恒 denied）。
   *  返回写后回读的 status JSON + `requested`。 */
  requestShizukuPermission?: () => string
  /**
   * 0.14.2「重置链接」：强制移除 Shizuku 侧的 UserService 并清空本地绑定态，然后**写后回读**返回
   * 与 [shizukuStatus] 同构的状态 JSON。
   *
   * 为什么需要它：现场「已授权 → 跳成需要准备 → 重新授权和重启 App 都不行」——重启 App 无效这条
   * 排除了进程内标志位脏，指向 Shizuku 侧 UserService 处于坏态（绑定请求既不回调也不抛）。因此本方法
   * 必须调 `Shizuku.unbindUserService(..., remove = true)` 让管理器移除该实例，下次绑定重建干净的。
   *
   * 两侧都声明（Kotlin `AndroidBridge.resetShizukuConnection` 同批落地），故**不需要**登记进
   * bridge-symmetry-baseline.json 的 kotlinOnly。
   *
   * 本方法**不在壳侧同步等待新绑定**（UI 路径，绝不阻塞）：返回后由本页既有的 2 秒轮询收敛。
   */
  resetShizukuConnection?: () => string
  /**
   * issue #262「AI root 权限」读面：`{ok, granted, consentValid, consentRevision,
   * currentRevision, consentVersionCode, currentVersionCode, channelUid, channelRoot,
   * canToggle, honesty, ownership}`。
   *
   * 0.14.7 起 `consentVersionCode` / `currentVersionCode` 的**单位是免责声明内容版本**
   * （壳侧 `RootGrant.DISCLAIMER_REVISION`），不再是 APK versionCode——同意不随应用升级
   * 失效（用户实测「root 免责声明每次更新怎么都会掉」）。字段名保留只为桥面对称，新代码请读
   * `consentRevision` / `currentRevision`；`consentValid` 始终是唯一权威判据。
   *
   * `channelRoot` 是**通道身份**判据（Shizuku 服务端 uid==0），不是「设备是否 root」——
   * 已 root 但 Shizuku 以 ADB（uid 2000）启动时此值为 false；显式授权的 su 是独立替代通道。
   */
  rootGrantState?: () => string
  /** issue #262 开关写面：判据（通道 root + 同意有效）全满足才写入；返回写后读回 JSON，
   *  拒绝时带 `code`（`not-root-channel` / `consent-required`）与 `guidance`。 */
  setRootGranted?: (on: boolean) => string
  /** issue #262「已阅读」确认写面：取消勾选即撤销同意并**同时关闭开关**；
   *  同意绑定免责声明内容版本，APK 升级不失效，仅在免责声明内容更新后需重新确认。 */
  setRootConsent?: (on: boolean) => string
  /** issue #262 免责门：打开 APK 内免责声明（`LocalDocs` 通道，页面不传路径）。
   *  返回 JSON `{ok, reason?}`（reason ∈ unknown-key / missing-asset / no-handler / 异常类名）。
   *  声明内容修订时，对应的 `RootGrant.DISCLAIMER_REVISION` 必须同步 +1（那才是要求
   *  用户重新确认的唯一触发器），并同步 `user-copy.ts` / 本页提示文案。 */
  openRootDisclaimer?: () => string
  /** 2026-09-30 主人定例：应用级 root 授权状态（**纯读，永不触发弹窗**）。
   *  `{ok, suExists, suPath, state: 'unknown'|'requesting'|'granted'|'denied'|'timeout'|'no-su',
   *  uid, granted, requesting, manager:{package,label,installed}, guidance}`。 */
  rootAccessState?: () => string
  /** 2026-09-30 主人定例：显式检测 root 授权——后台 `su -c id -u` 取真实 uid；不保证所有管理器自动弹窗。
   *  非阻塞（立即返回 `{ok:true,code:'request-started'}`，结果靠轮询 rootAccessState 收敛）；
   *  幂等（在飞时不重复起，避免弹窗连发）。 */
  requestRootAccess?: () => string
  /* 2026-09-30 主人指正后**移除**了 `openRootManager`：各家 Root 管理器包名/入口不一
     （还可能根本没有管理器 App，如部分 ROM 内置 su），打开不保证成功 ✗；而能刷 root 的用户
     自己会开管理器 ✓ ⇒ 只保留「检测/请求 root 授权」＋诚实引导文案。勿再加回来。 */
  /** Single-flight asynchronous native app-data ownership maintenance; never an AI shell entry.
   * Returns `{ok, code:repair-started|repair-running, running, startedAt, ...}` immediately.
   * Only `rootGrantState().ownership.result` settles checked/healed/failures and complete/partial status. */
  repairRootOwnership?: () => string
  /** Pre-0.13.7 implicit ACTION_VIEW on a single path (kept: the page's path clicks
   *  fall back to it when the chooser is unavailable). Returns whether it launched. */
  openNativePath?: (path: string) => boolean
  /** 0.13.2 W7: floating-ball toggle state (persisted by the shell). */
  getOverlayEnabled?: () => boolean
  /** 0.13.2 W7: floating-ball toggle; returns whether the overlay actually started
   *  (false = SYSTEM_ALERT_WINDOW not granted — the shell opens the settings page). */
  setOverlayEnabled?: (enable: boolean) => boolean
  /** 0.14: user-owned model screen-access scope. This is settings-only, not a model tool. */
  getScreenScope?: () => 'virtual-only' | 'real-only' | 'all'
  /** Persist a user-selected screen scope and return the normalized shell value. */
  setScreenScope?: (scope: 'virtual-only' | 'real-only' | 'all') => 'virtual-only' | 'real-only' | 'all'
  /** Trusted shell-only CWD for one blank external-open Session; no source file path is exposed. */
  incomingWorkspacePath?: () => string
  /** BrowserHost workbench lifecycle/navigation state (JSON string). */
  browserHostStatus?: () => string
  /** Narrow session/tab-addressed navigation; JSON replies echo session and authoritative native tabs. */
  browserHostCommand?: (payload: string) => string
  browserHostShow?: (url?: string | null) => string
  browserHostHide?: () => string
  browserHostReload?: () => string
  browserHostBounds?: (bounds: string) => string
  browserHostViewport?: (viewport: string) => string
  /** 0.14.0: close (destroy) the current page; the workbench can be opened fresh afterwards. */
  browserHostClose?: () => string
  /** 0.14.0: switch identity profile (PC / mobile); payload is JSON `{profile, ua}`. */
  browserHostIdentity?: (payload: string) => string
  /** VirtualDisplay state/actions, exposed only to the trusted Files-sidebar UI. */
  vdisplayStatus?: () => string
  vdisplayCreate?: () => string
  vdisplayDestroy?: () => string
  vdisplayBounds?: (bounds: string) => string
  /** Select the controller-owned presentation target (only owned virtual aliases are selectable). */
  vdisplaySelect?: (alias: string) => string
  /** 0.14.0 设置页「手机控制」：虚拟屏分辨率档位（0.5 / 0.75 / 1.0）。 */
  getVdisplayScale?: () => number
  setVdisplayScale?: (value: number) => number
  /** 0.14.0 设置页「手机控制」：app 退后台自动浮窗开关。 */
  getVdisplayFloatEnabled?: () => boolean
  setVdisplayFloatEnabled?: (enable: boolean) => boolean
  /** 0.14.0 设置页「手机控制」：强制销毁全部虚拟屏（三连点确认后调用）。 */
  forceDestroyVdisplay?: () => string
  /** 0.14.1 块J FIX-4：通知设置读回（JSON：suppressForeground / suppressForegroundDefault / categories）。
   *  `key` 为空串 = 全量快照；回读始终取壳侧真源，不回显入参。 */
  getNotifySetting?: (key?: string) => string
  /** 0.14.1 块J FIX-4：通知设置写入（key = `suppressForeground` 或 `cat.<category>`）。
   *  返回写后读回的 JSON；`applied=false` 即未生效（未知 key / 读回不一致）。 */
  setNotifySetting?: (key: string, value: boolean) => string
  /** 0.14.1 批 4：通知自检（每渠道的系统实际状态 + 是否被降级）。JSON 字符串。 */
  notifySelfCheck?: () => string
  /** 0.14.1 批 4：打开系统「本应用通知设置」；false = 该 ROM 无此页（页面须如实提示）。 */
  openNotifyAppSettings?: () => boolean
  /** 0.14.1 批 4：打开某渠道的系统设置页；false = 拉起失败。 */
  openNotifyChannelSettings?: (channelId: string) => boolean
  /** 发送五类测试通知，返回实际投递条数（0..5）；0 = 没发出去（权限/渠道不可用）。 */
  notifySendTest?: () => number
  /**
   * 0.14.6「检查更新 = 下载 APK 然后更新」（用户指令）的设置页入口。
   *
   * **单方法 + action 参数**，与壳侧 `AndroidBridge.apkUpdate(action)` **逐名对称**
   * （`scripts/check-bridge-symmetry.mjs` 会拦不对称面；壳侧动作名是闭集，未知动作只读回状态）。动作：
   *  - `"status"`：**只读**当前状态，不发起任何网络/安装动作；
   *  - `"check"`：发起检查；
   *  - `"install"`：对上次检查到的新版执行「下载 -> 校验 -> 拉起系统安装器」。
   *
   * 返回 JSON 字符串：{ok, state, version?, tag?, name?, current?, sizeBytes?, percent?, reused?, reason?, kind?, canStart, code?}
   * —— ok 只表示**这次调用是否被受理**，**不表示更新成功**；reason 是壳侧给的用户可读中文，页面**原样展示**。
   *
   * 为什么是同步返回 JSON 而不是 Promise：`@JavascriptInterface` 不能回 Promise。
   * 故页面用「发起 + 轮询读 status」两段式收敛（同 notify 面范式），**不依赖任何回调**——
   * `window.__dshBridge` 有幂等守卫且被整体赋值，挂回调有被整体跳过/被覆盖的风险（见 host-web-compat 的 PICKER_SCRIPT）。
   */
  apkUpdate?: (action: string) => string
}

declare global {
  interface Window {
    /** JS bridge injected by the shell APK (MainActivity). */
    androidBridge?: AndroidShellBridge
  }
}
