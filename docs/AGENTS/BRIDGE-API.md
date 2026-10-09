# BRIDGE-API.md — 当前桥与通道说明

> 桥方法与签名以 AndroidBridge/BackGateBridge/consoleBridge 源码为准，计数由门禁现取；不沿用旧版数量。0.14.3为源码交接，尚未构建/验收；后文版本增量用于历史溯源，当前契约以本节为准。

## 1. 信任与线程边界

主WebView只对精确受管引擎origin开放androidBridge与dshBackBridge；匿名BrowserHost网页不挂桥、不注入EngineAuth cookie/token。@JavascriptInterface运行在JavaBridge线程；涉及UI的调用必须marshal主线程且返回真实结算/超时，不把任务已提交写成已完成。bridge不存在、畸形/空回包均结构化拒绝。

| 通道 | 当前职责 |
|---|---|
| androidBridge | 用户设置/授权、目录选择、活动配置、窄BrowserHost与虚拟屏控制、通知、自检、console入口；AI能力由插件注册。 |
| dshBackBridge | setAvailable/getBackAvailable层栈信号；原生返回决策不接受网页任意Intent。 |
| consoleBridge | 仅本地console页面的输入/尺寸/退出等契约，不复用BrowserHost网页桥。 |
| 壳↔引擎 | 精确受保护Android路由、控制队列、file-incoming与通知$events；本地HTTP/TCP探针NO_PROXY；回包须lossless JSON。 |
| 插件↔壳 | androidPrivilege与ControlCarrier/ControlPoller；会话权限和native screen范围在执行点复查，不因UI展示值推断授权。 |

## 2. 0.14.3 当前增量

### 2.1 Root状态、维护与结果

rootGrantState返回有效AI授权（raw switch且当前versionCode consent），rootAccessState仅读应用su状态，不触发弹窗。requestRootAccess显式发起有界真实UID检测，不保证管理器弹窗；setRootConsent(false)同时关开关。root Shizuku与显式su授权为替代路径，uid2000不是root。repairRootOwnership立即返回repair-started/repair-running，rootGrantState().ownership轮询结果。

ownership包含running/overdue/startedAt/completedAt/elapsedMs/operation/result?/lease?；当前耐久lease未finish即保持pending、completedAt=0，旧result不能覆盖当前UNKNOWN。UID0派发前耐久commit，完整回执才finish；部分已确认helper信封可结算但不报修复成功。timeout/drain/read/cleanup/Binder未知阻止新派发/维护/启动，不fallback重放；同boot应用重启或resetShizuku不清lease，只有同epoch方案真boot变化可解除。详见 [Root维护契约](<dsh-mobile-apk/docs/AGENTS/ROOT-MAINTENANCE.md>)。

Shizuku v4以追加configuration()回读完整app UID/anchor，AIDL旧transaction不重编号；root执行点查真实UID和有效consent。每个pull/push chunk在RPC紧前复查，回包offsetFact=acknowledged-bytes、partial/noReplay是事实，不表示失败chunk毫无副作用。exec/capture回包保留exitTimedOut/drainTimedOut/cleanupIncomplete/truncated/readError/resultComplete/spoolReady；私有不完整capture不发布路径。

### 2.2 窄browserHostCommand与Session/tab归属

browserHostCommand(payloadJson)由MainActivity转交Activity拥有的BrowserHost.command；payload须受长度/词汇/session/uiTabId/tabId约束，action仅status/tabs/open/select/close/back/forward/reload。它不是任意JS、shell或controlExec通道。status/tabs不创建renderer、不抢UI舞台，返回available/profileAvailable/profileReason/session/ownerSessionId/tabs/activeTabId/tabId及每页真实导航状态。

模型controlOp捕获自己的Session/tab（包括modelTabId）供后续main-thread片段/异步回调，校验同一workspace/tab/view/generation，不依赖当时UI焦点。UI bounds/viewport/identity必须指定自己的Session/nativeTab/GUI occurrence，暂切上下文后恢复前台；陈旧hide/HMR detach不能盖掉邻页。identity、viewport、error、refs均per-tab。主状态旧入口为兼容面，不是0.14.3多Session查询真源。

BrowserHostProfile在新WebView任何settings、JS、load、attach-root前setProfile并getProfile确认非Default；失败或不支持MULTI_PROFILE即明确拒绝，不回Default。仅验证隔离后允许HTTP/LAN/loopback；3080受保护引擎origin默认仍拒，非profile调用仍拒loopback，匿名engine访问构造开关默认false。file/content/javascript/data/userinfo/未指定/link-local/metadata继续拒、TLS不override；profile拥有cookie/worker策略。limited profile clear不承诺彻底擦除IndexedDB/CacheStorage/worker注册。官方MIT UI、自定义真实tab-menu与native adapter不暴露主桥凭据。

Windows identity的native UA/JS platform/UA-CH分别选择Windows NT/Win32/Windows，UA-CH Chromium版本取实际应用UA优先；metadata不支持或设置失败如实返回未应用，不能声称桌面站点实测通过。

### 2.3 活动配置桥（#304）

exportConfig()/importConfig()/settingsPath()/exportSettingsDocument()现由MainActivity→EngineManager→SnapshotUserData接线，不再挂载legacy ConfigTransfer。settingsPath是当前configurationDocument：已有/已迁移web profile时指向cordis.patch.yml，未迁移且无patch才用legacy settings.yaml；.imported是历史marker，不是导出源，patch缺失不回factory/历史YAML。

exportConfig返回实际path与可能含provider密钥的共享目录警告hint；importConfig只读exports/config下匹配当前格式的文件、先保存.import-backup再原子替换。旧共享settings.yaml不覆盖已迁移patch；settingsDocumentExport是用户显式公共副本动作，不把private配置目录授予外部app。DirectoryPickerController仍在同名源码文件中承载SAF，未退役。

页面恢复由ForegroundPageRecoveryPolicy限定前台generation和一次quiet retry/recreate，不把destroyed WebView重新reload；Activity recreation重绑所有holder且保留userClosed/userShutdown，不重启共享引擎。新增fixture仅登记、未执行；详见 [外部测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>)。

## 3. 历史增量（不作为当前构建或验收证据）

## 0.13.3 W2/W3/W10 桥协议增量

- MuxClient：`/api/remote.mux` + `$events` 流（waterfall/emit/ready 帧）——grep `remote.mux`
- EngineAuth：`/api` 全前缀浏览器 Cookie（P0 token 交换 / P1 自 mint）——grep `EngineAuth`

## 0.13.5 W4 桥协议增量（设备控制授权面）

- `a11yStatus()`：无障碍控制通道状态 JSON `{enabled,label,sdk,restrictedSettingsApplies,hint,tokenConfigured}`（壳侧 `DeviceControlService.statusJson`）。
- `openA11ySettings()`：官方 Intent `Settings.ACTION_ACCESSIBILITY_SETTINGS` 跳系统无障碍页（失败回退 `ACTION_SETTINGS` + Toast 引导）。
- `unlockRestrictedSettings()`：Android 13+ 一键解锁受限设置（`appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow`，**0.14.0 起走 Shizuku 特权 shell**——内置 adb 已退役，旧文写的「壳侧 ADB 通道」是遗留措辞；未授权/未就绪失败关闭，返回 `{ok,message}`）。
- 引擎侧只读状态端点 `/api/android/privilege/status` 新增 `control:{a11yEnabled,queue,tokenConfigured}` 与工具 `android_privilege_status` 的 `gates`/`control` 字段。

## 0.14.2 增量（Shizuku「重置链接」——P1，2026-09-26）

> 背景：现场报障 —— Shizuku 已授权、通道一度「可创建」，随后跳成「需要准备」，**重新授权与重启 App 均无效**。
> 「App 重启无效」排除了「进程内标志位脏了」（那会被重启清掉），指向 **Shizuku 侧的 UserService 实例已僵尸化**。
> 既有 `readyService` 文案早就写着「在设置页「手机控制」重新连接 Shizuku 会重启 UserService（无需重装）」，
> 但那条路此前**并不存在**。本节是该承诺被真正实现后的桥面增量。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `resetShizukuConnection()` | `AndroidBridge.kt`（`@JavascriptInterface`）→ MainActivity `onResetShizukuConnection` → `ShizukuTransport.resetConnection(context)` | 用户显式「重置链接」。**非阻塞**：本方法在设置页每次点击上同步执行，**绝不 await 新绑定**（与 `kickBind` 同纪律），重置后的收敛交给既有 2s 轮询 + `kickBind`。**写后回读**：返回 `ShizukuTransport.status()` 的 status JSON（`ok/installed/running/granted/bound/binding/bindAttempts/bindAgeMs/lastError/code/guidance`），页面据此如实展示，**不承诺「已修好」**——能否恢复取决于 Shizuku 服务本身是否还在运行 |
| 同上（承重墙） | — | `ShizukuTransport.resetConnection` | 三件事缺一不可：① 调 `Shizuku.unbindUserService(args(app), connection, remove = true)` 让 Shizuku 管理器**移除**该 UserService（AAR 实现 = `IShizukuService.removeUserService(conn, forRemove = true)`，本仓实测 disassemble 确认），下次绑定重建干净的；**失败不中断**（`runCatching` + `Log.w`）。② 清我们这一侧：`service/connectedAt` 归零、**僵尸 `bindLatch` countDown 并置 null**（留着会让下一次 `ensureBound` 复用一个永不 countDown 的 latch）、`ShizukuBindState.onReset()` 令 `bindingFlag=false` 使下一次 `beginAttempt` 放行。③ `ControlCarrier.invalidateShizukuCache()` 让 caps 的 5s TTL 缓存立即失效 |
| 同上（新增结构化 code） | `ShizukuBindCodes.RESET` = `shizuku-user-service-reset` | `ShizukuBindState.kt` | 语义边界：既有四个 mutator 描述「一次尝试的结果」，`onReset()` 描述「用户主动放弃当前通道」——它不假装连上也不假装失败，而是回到「尚未发起」的可重试起点，并让 UI 如实说「已重置」而不是「正在建立」 |
| 同上（页面消费） | — | `dsh-client-ui-responsive` 手机控制「刷新状态」同行新增「重置链接」 | 复用既有 `settleLinkCall` 结算口径，**不新造口径、不新增定时器**（沿用既有 2s 轮询） |

**计数**：`@JavascriptInterface` 方法数一律由 `scripts/check-bridge-symmetry.mjs` 从源码现取，本节不写死数字。
**门禁面（已更新）**：`check-bridge-symmetry.mjs` 现扫**三个** surface —— `androidBridge`、`backGateBridge`、**`consoleBridge`（0.14.2 新纳入；此前该桥面的方法不在任何门禁面）**。各 surface 的方法与成员数一律由门禁从源码现取（`node scripts/check-bridge-symmetry.mjs` 的输出行），本节不写死。

## 0.14.2-fx-2-root.1 增量（AI root 权限授权开关——issue #262 方案 A，2026-09-30，本地变体）

> 背景：issue #262（feature 登记）——已 root 设备上把设备完全开放给 AI 前需要一个**策略门 + 免责确认门**。
> 已确证前提：root 能力来自「Shizuku 服务端以 root 启动」（通道身份 uid=0），**开关不授予任何能力**；
> 探测判据必须用**通道身份**而不是「设备是否 root」（已 root 但 Shizuku 以 ADB 启动 ⇒ 通道只有 uid 2000，置灰）。
> 审计前置（`ControlAudit` result 三态化）已于 0.14.2 G-7 修复，本增量直接落地。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `rootGrantState()` | AndroidBridge → RootGrant.state | `granted` 是有效授权（raw switch 且当前版本同意）；`channelRoot` 与显式授权的 `rootGranted` 是替代 root 路径；`ownership={running,overdue,startedAt,completedAt,elapsedMs,operation,result?,lease?}` 回读共享维护。未知通道/状态不猜权限。 |
| 页面 → 壳 | `setRootGranted(on)` | AndroidBridge → RootGrant.setGranted | root Shizuku 或显式 su 授权在场，且当前版本同意有效才允许开启；关闭永远允许。重新同意不自动复活升级前开关。返回真实写后状态与拒绝码；应用 root 检测是独立显式动作。 |
| 页面 → 壳 | `setRootConsent(on)` | AndroidBridge → `RootGrant.setConsent` | 「已阅读」确认写面。勾选 = 同意并**与 versionCode 绑定**（升级后自动失效需重新确认）；**取消勾选即撤销同意并同时关闭开关**（issue 用户指定语义，不留矛盾态） |
| 页面 → 壳 | `openRootDisclaimer()` | AndroidBridge → MainActivity `onOpenRootDisclaimer` → `LocalDocs.open` | 免责声明文档通道：APK 内 assets（`docs/root-disclaimer.html`，离线/随版本/不可远端替换）。**不复用 [ExternalLinks]**（其 classify 只允许 https），新开同形本地通道：页面只传 key（固定 `root-disclaimer`），登记表在壳侧 `LocalDocs.kt`。应用内 AlertDialog+WebView 渲染 |
| 同上（承重墙：策略门） | — | `ShizukuTransport.rootGateRefusal` + `readyService`/`runController` 入口 | 通道 uid==0 且未授权 ⇒ 特权执行面（runShell/pullFile/pushFile/removeRemote/runController）**整体 fail-closed**（code `root-grant-required`）。不做按 op 分类的假隔离（issue 已确证 uid 0 下 shExec 任意 shell，白名单挡不住引号逃逸） |
| 同上（页面消费） | — | `dsh-client-ui-responsive` 手机控制 Shizuku 区块下方 | 开关 + 「已阅读」复选（带蓝色超链接开免责声明）；非 root 通道：开关置灰 + **红字「无法在未 root 的设备上赋予该权限」**（用户指定文案，逐字） |

**计数**：方法数由 `scripts/check-bridge-symmetry.mjs` 从源码现取（四方法 Kotlin/TS 两侧同批声明，无需登记 kotlinOnly）。

## 0.14.2-fx-2-root.2 增量（应用级 root 授权面 + 属主自愈，2026-09-30，本地变体）

> 背景（主人两问换来）：①「这个开关应该调用一下 root 弹窗，并且检测 root 是否授权，如果没有，请写好引导去 Root 管理器，授予 root」；
> ②「为什么要弄 shizuku 的事情我们不是做 root 适配吗？」——issue #262 的设计建立在 Shizuku 上（其测试机 su 不可达），
> 而本机 **su 可用**（KernelSU）⇒ root 能力不该押在「Shizuku 已装+在跑+已授权+服务端为 root」四件事上。
> 另有一条实测缺陷：**Shizuku 授权请求此前只在后台路径自动发起**，而 `requestPermission` 需要前台 Activity
> ⇒ 静默失败（管理器「应用管理」列表里根本没有本应用、状态恒 denied，用户没有任何可点的授权入口）。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `rootAccessState()` | AndroidBridge（默认实现钉真源）→ `RootAccess.state` | 应用级 root 授权**纯读**面（**永不触发弹窗**）：`suExists/suPath/state(unknown\|requesting\|granted\|denied\|timeout\|no-su)/uid/granted/requesting/manager{package,label,installed}/guidance` |
| 页面 → 壳 | `requestRootAccess()` | AndroidBridge → `RootAccess.requestGrant` | **显式检测/请求 root 授权**：后台 `su -c id` 取一次真实身份。★**多数管理器不会因此自动弹授权框**（除 Magisk 外得用户自己打开管理器授予，2026-09-30 主人指正）⇒ 本方法只承诺「取一次真实身份并如实回报」，不承诺弹窗。非阻塞（立即返回 `request-started`，结果靠 2s 轮询收敛）；**幂等**（在飞时不重复起）；25s 有界超时，超时如实回 `timeout`（**不是拒绝**） |
| 页面 → 壳 | ~~`openRootManager()`~~ **已移除**（2026-09-30 主人指正） | — | **不做「打开 Root 管理器」入口**：各家管理器包名/入口不一（KernelSU / Magisk / APatch 之外还有 SukiSU 等分支，部分 ROM 甚至没有管理器 App）⇒ `getLaunchIntentForPackage` 不保证拿得到入口 ✗；而"能刷 root 的用户自己会开管理器" ✓ ⇒ 改为**诚实引导**（识别到管理器就报它的名字，识别不到就说"你使用的 Root 管理器"）。`rootAccessState` 保留 `manager{package,label,installed}` 只读字段供展示 |
| 页面 → 壳 | `repairRootOwnership()` | AndroidBridge → RootOwnershipJobs.request | 立即返回 `repair-started`/`repair-running` 与维护状态，不表示已修好；既有 `rootGrantState().ownership` 轮询真实 `result`。固定本应用维护不受 AI 开关约束，无任意命令入口；完整/部分/未知结果分别显示。 |
| 页面 → 壳 | `requestShizukuPermission()` | AndroidBridge → MainActivity → `ShizukuTransport.requestPermission` | **显式请求 Shizuku 授权**（UI 线程 + 前台 Activity；后台自动请求落不到用户眼前——实测管理器列表里没有本应用）。返回写后回读 status + `requested` |
| 同上（su 直连） | — | RootAccess.execRoot + ShellOps.canFallbackBeforeDispatch | 仅确知未派发的通道不可用可回退一次，且须有效 AI consent 与 su 授权；root-policy refusal、命令 exit≠0、超时、Binder/派发后结果不明不重跑。AIDL v4 追加 `configuration()=10`，确认完整 app UID/anchor 后才派发；旧/未确认服务拒绝。 |
| 同上（启动路径） | — | EngineStartFlow / EngineService / GuidePageRenderer | Activity 与前台 Service 的后台 worker 在快照事务恢复、fresh 判定和 Node 启动前调用共享单飞机制；相近启动复用5s内结算，未知结果延后启动，不重复派发。失败相位只在完整结果时报告完成，部分失败与未知明确提示。旧 head 的真机证据不能替代维护者修订后的验收。 |

## 0.14.1 增量（Shizuku 引导面与外部链接通道，2026-09-22）

> 背景：0.14.1 UI 审查发现设置页「手机控制」的 Shizuku 区块**读的是 `vdisplayStatus()`**——
> 标题写「Shizuku 特权通道」，内容却是虚拟屏状态码与 displayId；而插件下发给模型的引导语是
> 「到设置页「手机控制」安装、启动并授权 Shizuku」，那一页却一个入口都没有（死循环）。
> 本节是补上入口之后的桥面增量。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `shizukuStatus()` | AndroidBridge → MainActivity → `ShizukuTransport.kickBind` + `status` | Shizuku 特权通道**真实状态** JSON：`ok/installed/running/granted/bound/binding/bindAttempts/bindAgeMs/lastError/code/guidance`。**读路径自带自愈**（已装+已运行+已授权而未绑定时发起一次后台绑定并立即返回，下一次 2s 轮询收敛；绝不阻塞 UI 轮询路径）。页面的「打开 Shizuku」是否可点由 `installed` 决定——这是「装没装」的唯一事实来源 |
| 页面 → 壳 | `openShizukuManager()` | AndroidBridge → MainActivity → `ExternalLinks.openShizukuManager` | 拉起 Shizuku 管理器界面（`getLaunchIntentForPackage("moe.shizuku.privileged.api")`，不硬编码 Activity 名）。未安装 → `{"ok":false,"reason":"not-installed"}`；**不做任何隐式安装/授权**（授权只能由用户在 Shizuku 内完成） |
| 页面 → 壳 | `openExternalLink(key)` | AndroidBridge → MainActivity → `ExternalLinks.open` | 外部链接的唯一出口。`key ∈ {shizuku-download, shizuku-tutorial}`，**URL 表在壳侧 `ExternalLinks.kt`，页面不传 URL**（页面内容按不可信处理，避免把「拉起任意 Intent」的能力交给页面）。两个 key 共用同一条通道。返回 `{ok, reason?}`，reason ∈ `unknown-key` / `insecure-url` / `no-handler` / 异常类名；登记值一律 https |
| 同上（页面消费） | — | `dsh-client-ui-responsive/src/client/dev-section/phone-control.tsx` | 「下载 Shizuku」与「点击查看教程」→ `openExternalLink`；「打开 Shizuku」→ `openShizukuManager`（未安装时禁用）；受限设置解锁 → `unlockRestrictedSettings`（0.14.1 前该桥方法**零页面调用点**） |

## 0.14.1 增量（通知落点与自检面——批 4，2026-09-22）

> 背景：0.14.1 UI 审查发现整族通知是**单向公告板**——`contentIntent` 一直在写 `dsh.notify.*`
> extras 而全仓没有读取者、`MainActivity` 连 `onNewIntent` 都没有；同时 `selfCheck` 与两个系统设置
> 深链在页面侧零调用点（「系统已降级，应用无法调回」这句用户永远看不到）。另外
> `cat.question` / `cat.approval` 被关掉时通知被**丢弃**，而引擎侧提问/审批**没有超时**
> ⇒ 任务永久挂起（用户看到的是「AI 不动了」），已改为「静默投递」。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 壳 → 页面 | `window.__dshOpenSession(sessionId): boolean` | `dsh-client-ui-responsive/src/client/mobile/notify-landing.ts`（`apply` 里挂到 window） | 通知落点的**页面半**：切到目标会话。契约 = **同步返回 boolean**（true 已确认切换 / false 未切过去），壳侧 `MainActivity.deliverNotifyRoute` 依 evaluateJavascript 回执给可见提示。判据不做事后无验证的成功声明：未加载的会话先 `open()` 再回头确认 `scope()` |
| 页面 → 壳 | `notifySelfCheck()` | AndroidBridge（默认实现读 `ShellAppContext`）→ `NotifyCenter.selfCheck` | 每渠道**系统实际状态**（enabled/importance/是否被降级）JSON。默认实现钉在真源上、不依赖 MainActivity 传参（漏接线这一失效形态从结构上消失） |
| 页面 → 壳 | `openNotifyAppSettings()` | AndroidBridge → MainActivity → `NotifyCenter.appSettingsIntent` | 系统「本应用通知设置」深链；返回 boolean，false = 该 ROM 无此页（页面如实提示，不假装拉起过） |
| 页面 → 壳 | `openNotifyChannelSettings(channelId)` | AndroidBridge → MainActivity → `NotifyCenter.channelSettingsIntent` | 渠道级深链；channelId 来自 `notifySelfCheck` 回执 |
| 同上（页面消费） | — | `src/client/dev-section/notify-settings.tsx` | 「通知自检」+「系统通知设置」两枚入口 + 每渠道一行「系统实际状态 + 打开该渠道设置」；五类开关各配一句「关掉会怎样」（提问/授权两类写明「关闭 = 不弹窗，仍可作答」） |
| 壳侧语义变更 | — | `NotifyCenter.Face.interactive` | 交互类（question/approval）类别关闭 ⇒ **降级为静默渠道**（不弹窗不响铃、仍投递、仍可作答），不再 `return DISABLED`；非交互类（report/todo/silent）才允许丢弃 |
| 壳侧载荷修正 | `dsh.notify.*` extras | `NotifyCenter.EXTRA_KIND / EXTRA_TARGET_SESSION / EXTRA_TARGET_AGENT` | 旧实现把 `sessionId` 与 `agentId` **依次写进同一个 key**（后写覆盖先写）。现按键语义拆开，读取者 = `MainActivity.consumeNotifyRoute` / `onNewIntent` |

## 0.13.7 增量（追上游 dsh 0.1.5，2026-09-10）

> 本节为本轮桥面变更的权威增量；上行各表仍是 0.13.3-0.13.6 的行号锚点，未逐行重排。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `openPathChooser(path, mode)` | AndroidBridge.kt（新增）→ MainActivity `onOpenPathChooser` → PathOpen.kt `openChooser` | 系统「打开方式」选择器；返回 JSON `{ok, reason?}`（not-exists / not-allowed / no-handler / uri-failed / 异常摘要）。mode=`folder` 视为目录 |
| 同上（允许面） | — | PathOpen.`isChooserAllowed`（0.13.7 追加） | 允许面 = FileIncoming 的 canonical 白名单（`files/home/.dsh/workspaces`、`files/home/tmp`、`files/usr/bin`、外部存储 `Documents/dshdata/`）**加外部存储根**——上游右栏 Files 标签能浏览整台设备，用户在那里点开的文件/目录必须能交给 MT 管理器或系统文件管理。`file_paths.xml` 相应新增 `<external-path name="external_shared" path="." />`。**引擎/插件驱动**的「文件提及 → 外部阅读器」（`openNativePath` → `FileIncoming.openWithExternalReader`）仍只走严格白名单，不因这条放宽；应用私有区其余部分（含 `.credentials.yaml`）永不进选择器 |
| 页面 → 壳 | ~~`downloadDebugLogs()`~~ | 已删除（AndroidBridge/MainActivity/DebugLogExporter.kt） | 「导出调试日志」整链退役；日志仍按天落盘（设置页开关不变） |
| 页面 → 壳 | ~~`pickImage(callbackId)`~~ | 已删除（AndroidBridge/MainActivity/ConfigTransfer 图片桥） | 上游 0.1.5 自带附件入口（回形针 → 系统文件选择器 → 官方上传接口）替代 |
| 页面 → 壳 | ~~`pickFilePath(callbackId)`~~ | 已删除（AndroidBridge / MainActivity / ConfigTransfer 的 SAF 文档选择链 + 页面 `onFilePicked`） | 0.13.7fx-1 退役：`@` 文件引用回到上游原生菜单（`ui-input-trigger` + `ui-reference`，候选限定在会话工作区内），自建 `@路径` 桥不再需要 |
| 壳 → 页面 | ~~`window.__dshBridge.onImagePicked`~~ | 已删除（dsh-host-web-compat lib/index.js） | 同上 |
| 页面 → 壳 | `settingsPath()` | AndroidBridge.kt（新增）→ EngineManager.settingsDocumentPath() | 当前活动配置绝对路径（已迁移时为 web profile 的 `cordis.patch.yml`，未迁移才是 legacy YAML），空串 = 活动文档不存在。移动适配层用它把上游「打开配置文件」（本来走 mac/win/linux 原生编辑器，Android 必然失败，apk #152）改走系统选择器 |
| 页面（兼容插件） | `window.__dshOpenPath(path, mode)` | dsh-host-web-compat lib/index.js（新增） | 优先 `openPathChooser`，回退旧 `openNativePath`；聊天 mention 与工具行路径点击统一走它 |

JS interface count is checked from source by `scripts/check-bridge-symmetry.mjs`; do not retain the obsolete 0.13.x count after adding bridge methods.
`<input type=file>` 的 `onShowFileChooser` 通道保留（上游附件按钮依赖）。

## 0.14.0 施工增量（部分已随 0.14.0-preview 发布、部分仍未验收）

> 已随 0.14.0-preview（vc38）发布的桥面以 `release/v0.14.0-preview/notes.md` 为准；下表中
> BrowserHost 与虚拟屏两组方法属**发布后工作区施工**（未提交、未验收），ScreenScope 与
> file-incoming 已进入发布会话的验收记录。方法计数一律以 `check-bridge-symmetry.mjs` 从源码现取，
> 本节只登记语义。

| 方向 | 方法/通道 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `getScreenScope()` / `setScreenScope(scope)` | AndroidBridge → MainActivity → `ScreenScopePrefs` | 用户设置唯一写面；wire 值仅 `virtual-only`、`real-only`、`all`，未知值回落 `virtual-only`。模型工具没有 setter。设置页落在开发者选项「屏幕与 Shizuku 控制」。 |
| 页面 → 壳 | `browserHostStatus/show/hide/reload/bounds/viewport/close/identity` | AndroidBridge → MainActivity → `BrowserHost` | Files 右栏的可信页面把 CSS stage bounds 与视口预设传给壳；第二 WebView 只覆盖该 stage（letterbox rect，不做 CSS 缩放），不挂 JavaScript bridge。`browserHostBounds` 可见挂载1000ms续租、4000ms过期隐藏；hidden/detach停止续租，普通几何消息仍去重。 |
| 页面 → 壳 | `vdisplayStatus/create/destroy/launchSettingsProbe/backProbe/bounds` | AndroidBridge → MainActivity → `VdisplayController`/`VdisplayHost` | 建屏/销毁/`am start --display` 探针/`input -d` 回退探针/viewer stage 几何。`virtual-1` 建成前一律 `screen-not-ready`，绝不映射 display 0。 |
| 页面 → 壳 | `dshBackBridge.setAvailable/getBackAvailable` | BackGateBridge（独立 @JavascriptInterface 对象） | 注入层回传页内层栈可用性；URL 由 Activity 决策，`getBackAvailable` 为只读事实。 |
| 引擎 → 壳 | `dsh_screen_scope.xml` 只读 | `androidPrivilege.screenScope/screenAccess` | manage 工具在选 a11y/ADB 前读取 native scope；无障碍执行点仍重复检查，防止直连控制队列绕过。 |
| 引擎 → 壳 | `android_vdisplay_input` → `vdInput` | bridge `controlExec` → `VdisplayOps` → `VdisplayController.input` | `real-only` 下 bridge 与壳执行点均返回稳定 `screen-out-of-scope`，壳在 Shizuku `input -d` 前复核；显式 target 优先于 selected，不能重定向输入。`virtual-only`/`all` 允许已登记虚拟目标。 |
| 壳 ↔ 引擎 ↔ 页面 | file-incoming queue / claim / content / complete / clean | FileIncoming → dsh-android-file-open → ui-responsive | 五条 exact 路由全部受保护；队列状态只给 opaque entry metadata；成功导航后 claim 得进程内 ticket，再经同源 content 读取字节并交给上游 composer 形成未发送 generic file attachment。路径不进入页面或模型，重启不恢复草稿。 |
| 壳 ↔ 引擎 | 通知应答流 `$events`（streamId=`dsh-notify-responder`） | NotifyBridge ↔ MuxClient | 与悬浮球事件流独立；waterfall 投放通知、cancel 撤通知、`$events/result` 投递回答。 |

`VdisplayController` 已能建真实 VirtualDisplay（公开 `PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH`），并把
别名 `virtual-1` 映射到运行时 displayId；viewer Surface 重挂、实时多屏选择与 BrowserHost 视口的
设备回归仍未收口（见 `known-gaps.md`）。本节记录代码施工状态，不表示已通过设备验证。

