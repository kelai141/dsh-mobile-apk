# ANDROID-API-USAGE.md — android.* 使用面分组登记

> 职责：壳源码 android/androidx 平台 API 的按域分组清单与 API 等级约束。统计口径：`grep "^import android"` 当场实测（2026-09-14，0.14.0-preview 发布后的工作区）——android.* 导入行 327 处、去重 116 类，分布于 53/65 个源文件（12 个零 android 导入：ApkArtifactCheck / BrowserHostNavigationPolicy / ControlPoller / ControlProtocolV2 / EngineProbe / FactoryProfilePatch / LiveProbe / ProcIo / SnapshotFileMode / SnapshotFs / SnapshotTransaction / SnapshotUserData，纯 java.net/java.io/java.security）；androidx 导入 28 处、去重 15 类。源码根 `app/src/main/java/com/dsharnessmobile/shell/`。

## 1. 按域分组（116 类去重口径）

| 域 | 类 | 关键调用点 |
|---|---|---|
| WebView 全家桶（8） | WebView、WebViewClient、WebChromeClient、WebSettings、WebResourceRequest、JsResult、ValueCallback、JavascriptInterface | MainActivity.kt（配置 + shouldOverrideUrlLoading/onReceivedError/onPageFinished/onShowFileChooser/onJsAlert）、**BrowserHost.kt（第二 WebView：导航策略/标题/渲染进程回收）**、ConsoleActivity.kt、WebUiChrome.kt（主题/字体回推） |
| 显示与虚拟屏（10） | hardware.display.DisplayManager、hardware.display.VirtualDisplay、view.Display、view.Surface、view.SurfaceView、view.SurfaceHolder、media.ImageReader、util.DisplayMetrics、graphics.PixelFormat、os.HandlerThread | **VdisplayController.kt**（createVirtualDisplay/release/setSurface/displayId/state）、**VdisplayHost.kt**（SurfaceView/SurfaceHolder 生命周期）、**VirtualDisplayProbe.kt**、**ScreenScope.kt（display 别名）**、MainActivity（viewer 宿主接线） |
| 通知（5） | NotificationChannel、NotificationManager、PendingIntent、（androidx）NotificationCompat、（androidx）RemoteInput | **NotifyCenter.kt**（五类渠道 + 六类 kind 分流 + 弹窗/静默形态 + 自检面）、**NotifyStore.kt**（.notify.ndjson 偏移消费）、**NotifyBridge.kt**（专用 $events 流投放）、**NotifyDecisionQueue.kt**（失败态可见通知）、MainActivity.showTestNotification、EngineService.kt（前台通知）、WatchdogV2.kt（旧信道回退） |
| 存储 SAF / MediaStore（6） | DocumentsContract、MediaStore、ContentValues、Environment、MediaScannerConnection、provider.Settings | ConfigTransfer.kt（Directory/MediaPick 双控制器 + PickImageContract）、DownloadSaver.kt（MediaStore.Downloads + IS_PENDING + 200MB 上限）、EngineManager.kt（MediaScannerConnection.scanFile）、LogCollector.kt（落盘路径分代）、PathOpen.kt（FileProvider URI） |
| IME 输入法（3） | InputMethodService、InputMethodManager、EditorInfo（全限定引用） | AdbKeyboardService.kt（ADBKeyboard 协议 IME）、OverlayPanel.kt（IME_ACTION_SEND/DONE） |
| 悬浮窗 WindowManager（4） | WindowManager、PixelFormat、view.Gravity、MotionEvent | OverlayService.kt（TYPE_APPLICATION_OVERLAY 三窗口：球/光环/面板）、OverlayController.kt（canDrawOverlays 判定 + ACTION_MANAGE_OVERLAY_PERMISSION 授权页引导） |
| FileObserver（1） | os.FileObserver | OverlayLiveFeed.kt（.live.ndjson 的 MODIFY/CREATE + debug 注入文件 .overlay-test-pending）、NotifyStore.kt（.notify.ndjson，偏移持久化 + 轮转残段补读） |
| 动效（9） | animation.ObjectAnimator、ValueAnimator、AlphaAnimation、PathInterpolator、graphics.LinearGradient、graphics.Shader、（androidx）SpringAnimation、SpringForce、DynamicAnimation | ShimmerTextView.kt（Deep diving 扫光）、OverlayService.kt（贴边吸附 spring 380/0.8）、OverlayHalo.kt（WORKING 呼吸脉动）、GuidePageRenderer.kt（引导页 stagger 入场）、DsUi.kt（PathInterpolator 缓动） |
| WakeLock（1） | os.PowerManager | MainActivity.kt（SCREEN_BRIGHT_WAKE_LOCK 常亮，单例成对 acquire/release）、WatchdogV2.kt（PARTIAL_WAKE_LOCK 前台保活 + 30min 续期） |
| 剪贴板（2） | ClipData、ClipboardManager | MainActivity.kt、WebUiChrome.kt（copyText 桥）、ConsoleActivity.kt |
| 广播（4） | BroadcastReceiver、IntentFilter、content.Intent、os.Bundle（RemoteInput 结果） | BootReceiver.kt（BOOT_COMPLETED）、AdbKeyboardReceiver.kt（ADB_INPUT_TEXT/ADB_CLEAR_TEXT）、**NotifyActionReceiver.kt**（通知动作：回复/选项/批准/拒绝/重试；exported=false + 显式 Intent）、WatchdogV2.kt（用户交互复位监听） |
| 进程/线程基础（8） | os.Handler、os.Looper、os.Bundle、os.Build、os.IBinder、os.Process、os.SystemClock、app.ActivityManager | 全壳主线程 post 面；Build 用于全部 SDK 分支；ActivityManager 用于 WatchdogV2 进程级检查；ShizukuUserService（Process.myUid/exec） |
| 图形与控件（约 30） | GradientDrawable、RippleDrawable、LayerDrawable、ClipDrawable、ColorStateList、Typeface、TypedValue、Color + widget.LinearLayout/TextView/EditText/ImageView/Button/Spinner/ArrayAdapter/AdapterView/ScrollView/FrameLayout/ProgressBar 等 | GuideChrome/GuidePageRenderer/DsUi（引导页纯代码 UI）、OverlayPanel（面板）、OverlayService.buildRoot（白球黑鲸 Matrix 裁剪） |
| 其他（4） | util.Base64、text.InputType、text.TextUtils、net.Uri | MuxClient.kt（WS 握手 key/accept 编解码）、OverlayPanel.kt（输入框类型）、FileIncoming.kt（Uri 白名单校验）、权限判定各处 |

androidx 面（15 类，28 处导入）：ComponentActivity、ActivityResultContracts / ActivityResultContract、**OnBackPressedCallback**（MainActivity 返回网关，0.14）、NotificationCompat、**RemoteInput**（通知栏直接回复）、ViewCompat / WindowCompat / WindowInsetsCompat / WindowInsetsControllerCompat（insets 与沉浸式）、dynamicanimation 三件（SpringAnimation/SpringForce/DynamicAnimation）、**annotation.Keep**（ShizukuUserService 反射构造保留）。

## 2. 单文件导入密度（前 10，grep -c 实测，2026-09-14）

MainActivity 33 / OverlayService 20 / **BrowserHost 18** / OverlayPanel 15 / ConsoleActivity 15 / GuideChrome 14 / DeviceControlService 12 / **VdisplayController 11** / NotifyCenter 10 / DsUi·EngineService·GuidePageRenderer 各 9。引擎域文件（EngineManager、UndoGate、UpdateManager、MuxClient、SnapshotExtractor）刻意保持最小 android 面。

## 3. 线程与生命周期约束（与 API 使用强绑定，源码注释实测）

| 约束 | 锚点 | 要点 |
|---|---|---|
| @JavascriptInterface 跑在 JavaBridge 线程 | MainActivity.kt:473-474 注释 | WebView 方法必须切回主线程（runOnUiThread / webView.post）——textZoom/evaluateJavascript 全遵守 |
| EngineProbe 探活禁主线程 | EngineProbe.kt（check 注释 "never the main thread"） | 全部调用方自起线程或 Handler 后台 |
| FileObserver.onEvent 非主线程 | OverlayLiveFeed.kt:78（svc.main.post） | live 事件解析后统一 post 主线程再改状态 |
| MuxClient.onFrame 在客户端线程 | MuxClient.kt:25（上层自行 post 主线程） | OverlayPanel.handleMuxFrame 内 svc.main.post（:83-101） |
| evaluateJavascript 晚到回调 | MainActivity.kt:509-510、WebUiChrome.kt:148-149 | Runnable 体内 try/catch + onDestroy removeCallbacks（防销毁后主线程异常） |
| PendingIntent 默认 FLAG_IMMUTABLE | MainActivity.kt:620、NotifyCenter.kt:actionPending | targetSdk 31+ 硬约束；**唯一例外 = 提问通知的回复动作（FLAG_MUTABLE）**：RemoteInput 结果经 ClipData 注入，mutable 缺失会让回复静默失败（§6.3.1/NT-16）。该动作仍用显式 Intent（component=本包 receiver，exported=false） |

## 4. API 等级约束（minSdk 26 / targetSdk 34 / compileSdk 36）

| 约束点 | 等级 | 守卫写法 |
|---|---|---|
| TYPE_APPLICATION_OVERLAY 悬浮球三窗口 | API 26+ | minSdk 26 直用，无分支（OverlayService.kt:175,199,242） |
| NotificationChannel | API 26+ | minSdk 26 直用（MainActivity.kt:616、NotifyCenter.kt） |
| isExternalStorageManager（All Files Access） | API 30 | 显式分支 7 处：AndroidBridge.kt:133、AdbState.kt:307、ConfigTransfer.kt:229,272、GuidePageRenderer.kt:161、LogCollector.kt:76、DownloadSaver.kt:140（SDK<30 走 SAF+legacy 权限分代，#120） |
| POST_NOTIFICATIONS 运行时权限 | API 33 | Build.VERSION 分支 + ActivityResult 请求（MainActivity.kt:84-85,598-613）；NotifyCenter.hasPermission 在投递前复判并回调界面（D9，不再只写日志） |
| 渠道 importance 只能降不能升 | 全等级（API 26+ 语义） | NotifyCenter.Face 候选 ID 序列 + getNotificationChannel/getImportance/hasUserSetImportance 三态判定；弹窗类首次即 HIGH 建，静默类换新 ID（§6.1.2） |
| PendingIntent.FLAG_MUTABLE | 常量 API 31+ | minSdk 26 上该常量可用（未知标志被平台忽略），语义仅在 31+ 生效；只对 RemoteInput 回复动作用 |
| setSilent / setTimeoutAfter / setPublicVersion / setAuthenticationRequired | NotificationCompat 面（API 26+ 直用） | setSilent 是静默类第二道保险；setTimeoutAfter 只撤弹窗不发 rejected；setAuthenticationRequired 在 APPROVAL_REQUIRE_UNLOCK=true 时启用（B4 NT-18） |
| forceDark / GradientDrawable.setColors(colors, offsets) | API 29 | 分支降级（MainActivity.kt:330、ConsoleActivity.kt:90、OverlayHalo.kt:41） |
| 沉浸式 WindowInsetsController vs systemUiVisibility | API 30 | 双路分支（MainActivity.kt:243-268、WebUiChrome.kt:17-32） |
| security.android.exec xattr 补章 | Android 15+ 强制 | 无条件 setfattr 尽力而为（SnapshotExtractor.kt 类注释；不 enforcing 的内核为 no-op） |
| SYSTEM_ALERT_WINDOW | 全等级 | Settings.canDrawOverlays + 授权页引导 + onResume 补启（OverlayController.kt:33-65、MainActivity.kt:206） |
| WRITE_EXTERNAL_STORAGE | maxSdk 29 | manifest 分代声明（分区存储后不再需要） |
| READ_EXTERNAL_STORAGE | maxSdk 32 | Android 13+ 并入 READ_MEDIA_* 且工作区走 All Files Access |
| VirtualDisplay（createVirtualDisplay/release/setSurface） | API 17+ | 直接使用（minSdk 26）；flags 位值本地位常量（`VIRTUAL_DISPLAY_FLAG_*` 多个为 @hide，见 VirtualDisplayProbe.kt 文件头） |
| SurfaceView / SurfaceHolder 回调 | API 1+ | VdisplayHost 直接使用；surfaceDestroyed 必须 detach，防止 Surface 泄漏 |
| OnBackPressedCallback / onBackPressedDispatcher | androidx.activity 1.6+（本项目 1.10.1） | MainActivity 返回网关；与 legacy onBackPressed 覆写不能并用 |
| Shizuku api/provider 13.1.5 | Android 6+（API 23+） | 外部依赖；Shizuku 服务不在场时所有调用 fail-closed（ShizukuTransport/ShizukuProbe） |

## 5. SDK 档位理由（app/build.gradle.kts:13-16 注释为权威）

- **targetSdk 34**：Android 15+ 对 targetSdk 35+ 禁止 exec 应用数据目录 ELF（w^x）——内嵌引擎的 node/bash/全部子命令都是 app-data ELF，升 35 需要全部套 /system/bin/linker64 包装（现有回退只兜底直 exec 被拒场景，EngineManager.kt:581-598）；34 保有 Android 15/16 设备上的原生 exec。配套措施：SnapshotExtractor 对每个可执行文件补 security.android.exec 属性。
- **minSdk 26**：TYPE_APPLICATION_OVERLAY（悬浮球三窗口）与 NotificationChannel 均 API 26 起步；低于 26 需两套 overlay/通知降级路径，与壳定位（Android 8+ 设备）不符。
- **compileSdk 36**：跟随最新 SDK 编译取新 API 签名与 lint 规则；运行时行为由 targetSdk 34 封顶（gradle.properties 以 suppressUnsupportedCompileSdk=36 压制告警）。

## 6. 相关构建配置（与 android API 面配套，build.gradle.kts 实测）

- `androidResources.noCompress += "xz"`（build.gradle.kts 注释：snapshot.tar.xz 已 xz 压缩，AAPT 二次压缩会破坏 openFd/流式读取）——SnapshotExtractor 依赖拿到原始 xz 字节流。
- `usesCleartextTraffic="true"`（AndroidManifest.xml application 节点）：引擎是 http://127.0.0.1:3080 明文回环，WebView 与直连 RPC 均依赖。
- targetSdk 34 下前台服务启动须声明 foregroundServiceType（dataSync，EngineService/开机自启路径）。

## 7. 无障碍 API（0.13.5 W4 新增，全量参考见 ACCESSIBILITY-API.md）

- 服务级能力：`canRetrieveWindowContent`(18) / `canPerformGestures`(24) / **`canTakeScreenshot`(30)** / `flagRetrieveInteractiveWindows`(21) / `flagReportViewIds`(18) —— 全部在 `res/xml/accessibility_service_config.xml` 声明。
- 代码级 API 守卫：`takeScreenshot()`（API 30，`Build.VERSION_CODES.R` 分支，低于则明确报错引导 ADB）；`getSoftKeyboardController().switchToInputMethod()`（API 24）；`onCreateInputMethod()`（API 33，未接）。
- 无需额外运行时权限：截屏/手势/读树都靠服务能力声明 + 用户在系统设置开启一次；`FLAG_SECURE` 窗口系统直接拒绝截屏。
- Android 13+ 侧载受限设置：`appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow`（`AdbState.unlockRestrictedSettings`）。

## 8. 通知 API（0.14.0-preview §6 新增）

**五类渠道（ID 与 importance 一次性定死；创建后只能降不能升）**

| 语义 | 渠道 ID（候选序列） | importance | 形态 |
|---|---|---|---|
| 静默：看门狗/引擎状态 | `dsh-silent` | LOW | 单条覆盖 + setSilent(true)，通知 ID 0x1001 |
| 静默：待办进度 | `dsh-todo-progress` | LOW | setProgress + 文本「步骤 n/N」，通知 ID 0x1002 |
| 弹窗：工作汇报 | `dsh-report` → `dsh-report-h2` | HIGH | 每会话同 ID 覆盖 + BigTextStyle |
| 弹窗：提问 | `dsh-question` → `dsh-question-h2` | HIGH | RemoteInput 直接回复 + 选项动作（≤2） |
| 弹窗：授权 | `dsh-auth` → `dsh-auth-h2` → `dsh-auth-h3` | HIGH | 批准一次 / 拒绝（闭集 allowed-once｜rejected） |

- 迁移判定：`getNotificationChannel(id)` 缺失 → 以目标 importance 创建；已存在且 `getImportance() >= HIGH` → 直接用；低于目标且 `hasUserSetImportance()==false` → 判定历史构建建错，切下一个候选；`hasUserSetImportance()==true` → **不换 ID**，降级为静默 + 设置页文案（`NotifyCenter.selectChannel`，纯函数单测覆盖）。
- 一次性初始化标记 `SharedPreferences("dsh-notify").channelsInitialized`；选中渠道落 `channel.<category>`，投递路径只读映射（不硬编码渠道 ID）。
- 自检面 `NotifyCenter.selfCheck(context)`：应用级 `areNotificationsEnabled()` / 渠道存在性 / `getImportance()` / `hasUserSetImportance()`+`hasUserSetSound()`；「用户是否关掉弹出」**无公开读 API**，如实显示 `无法检测`；深链 `ACTION_APP_NOTIFICATION_SETTINGS` / `ACTION_CHANNEL_NOTIFICATION_SETTINGS`。
- **不使用 full-screen intent**（`setFullScreenIntent` 在新代码 0 命中）：通知点击只能 `getActivity`；动作一律 `getBroadcast`（Android 12+ trampoline 禁令 + BAL 回收）。
- 动作接收器加固：`NotifyActionReceiver` `android:exported="false"` + 显式 Intent；断言口径是「存在处理通知动作的 receiver 且 exported=false」，**不是**「receiver 数量 == 0」（本 manifest 另有 AdbKeyboardReceiver / BootReceiver 两个 exported=true）。
- **单条事件可否决弹窗**：`.notify.ndjson` 的 `popup=false`（NT-05 的 aborted）经 `NotifyCenter.formDecision` 消费 → 工作汇报降级为静默条目（`dsh-silent` 渠道 + `setSilent(true)`，保留会话级通知 ID）；提问/审批是交互入口，不参与静默降级。
- **前台抑制默认关闭**（0.14.1 块J FIX-3，用户 2026-09-19 拍板取 A，`NotifyCenter.DEFAULT_SUPPRESS_FOREGROUND = false`）：前台也投递系统通知（真·实时）。旧默认值 `true` 的后果是前台工作时整条工作汇报**被永久丢弃**（命中即 `return SUPPRESSED_FOREGROUND`、无入队无补投，而消费侧已推进字节偏移），退到后台后 `isForeground()` 为 false、条件不成立才照常投递——这正是用户上报的「必须划到后台才推送」。判定表达式不变：`face == Face.REPORT && foreground && suppressForeground(app)`。`isForeground()` 是 ActivityManager 粒度判定、存在假阳性；把它套在提问/审批上会让「通知内应答」整条能力消失（应用在前台本来就有应用内提问 UI 兜底）。
- **抑制 = 延后，不是丢弃**（FIX-1，`NotifySuppressQueue`）：用户在设置页显式打开抑制时，命中条目进入待投队列（TTL 5min、容量 8、单次补投上限 3、同会话覆盖式去重），回到后台或关掉开关时补投；`onSuppressForegroundChanged` 在关闭时立刻 flush。补投复用正常投递路径（`deliverDeferred`），不另写第二份渠道/形态/记账实现。
- **存量升级迁移**（FIX-3，`ensureSuppressForegroundMigrated`，在 `NotifyStore.start` 执行、schema 代次只跑一次）：旧抑制是**默认值**造出来的——全仓 `setSuppressForeground` 零调用、没有任何发行版写过该键 ⇒ 改默认值即修好存量用户，**无需改其 prefs 任何一个字节**。缺键分支**不写** `suppressForeground`；磁盘上**显式存在**的值原样保留（那只能是用户真实意志，静默改写属 F-APK-02 同族错误），仅备份到 `suppressForegroundLegacy` + 探针留痕。
- **抑制可见反馈**（FIX-2，`NotifyCenter.ShellListener` + `installShellListener`，由 `NotifyStore.start` 有界安装）：旧态 `listener` 全仓零赋值 ⇒ `onForegroundSuppressed` 是空操作（静默失败形态）。实现只依赖既有公开面（`OverlayService.instance` + `flashStatus`），调用时刻惰性解析实例、不持有引用、失败只记探针，绝不冒泡到 MuxClient 读线程。
- **设置页读写能力**（FIX-4）：`NotifyCenter.settingsSnapshot(context)`（读快照，含 `suppressForeground` 及其默认值 + 五类 `categories`）与 `NotifyCenter.applySetting(context, key, value)`（key ∈ `suppressForeground` / `cat.<category>`；未知 key 显式拒绝；**写后读回**判定 `applied`/`reason`，拒绝乐观置位）。壳侧只交付能力，设置页 UI 落 dsh-client-ui-responsive。
- **最近汇报窄接口**（为 T5 交付，签名稳定）：`NotifyStore.latestReportLine(): String?` 返回最近一条 `kind=="report"` 的**原始 ndjson 行**（未解析未渲染；本进程未见过 report 时为 null）。挂点在 `dispatch` 的 report 分支且**在投递判定之前** ⇒ 被抑制/被关也能看到内容。用原始行是为了避免在 NotifyStore 再造一份 `reportLine`/`reportBigText` 渲染口径（第二真源）。
- **启动分段判据字段**（P-AC-04 + C1，`files/boot-segments.log`，字段恒在场、未知一律 -1）：`t_boot_start` / `t_listen` / `t_listen_ms` / `t_first_http` / `t_first_http_ms` / `t_compose_total` / `t_compose_source` + `note=`。`t_first_http` 由壳侧探活标定（`EngineStartFlow` 三条路径），**不依赖引擎侧插桩**；`t_compose_total` 依赖引擎 stdout 的 `[perf] TOTAL calls=… totalMs=…`（只有测量 preload `scripts/perf/count-compose.mjs` 会产；**该脚本目前不在出厂发行路径**，故产品上 `t_compose_total=-1`）。
- **compose 口径分流**（`t_compose_source`，用于把拒因指向正确的层，**不是**取值面）：`preload-total`（TOTAL 在场，唯一能产出耗时值）／`preload-compose-only`（preload 已装但 TOTAL 未到——TOTAL 是 `process.on('exit')` 汇总、启动窗口内通常还没打印）／`a5-singles`（A5 的 `[perf] boot singles=` 或 `[perf] single #n` 在场）／`a3-cache-only`（`combo cache (A3)` 行在场）／`none`（**探针完全没装**）。A5/A3 都**不含耗时**，绝不用来填 `t_compose_total`（缓存/计数规模冒充耗时是假绿形态）；收口行相应区分为 `note=probe-absent`（source=none）与 `note=probe-no-total`（探针在场但无耗时口径）。
- **boot 卡住诊断**（块L，`files/boot-diag.log`，`dsh-boot-diag` 标记）：页面超过 40s 仍不就绪且**引擎 HTTP 健康**时落盘（`run-as cat` 可取，不依赖调试采集器）；页面侧 fiber 装配状态从壳侧不可得时**显式写 `pageSideRuntime=unavailable`**而非空数组（空数组正是 issue 误导根源，详档 §6.2 硬约束 1）。
- **WS 应答流不得被单帧异常杀死**：`NotifyBridge.onFrame` 与 `NotifyCenter.notifyEvent` 都有 Throwable 边界（返回 `Result.ERROR`），否则异常冒到 `MuxClient.frameLoop` 会让整条 `$events` 流反复重连、后续提问/审批通知全部消失。
- **耐久探针**：`files/notify-responder.log`（`NotifyProbe`，追加 + 128KB 轮转）记 `start / ready / waterfall / notify result / 异常 / 连接心跳`，设备复验用 `run-as cat` 读取，不依赖调试日志采集器；判据口径见计划 §6.2.2「NT-11 四段可判定」。
- **提交成功必须本地结算**（DEF-NOTIFY-03）：网关只给其它持有者发 `cancel`，提交者不会收到——`NotifyDecisionQueue` 的 `OK` 分支立即 `markSettled`（`markSettled` 无条件 `cancelEvent`，不依赖 pending 表存在），否则通知停在「正在发送」。

## 9. 0.14 新增面（Shizuku / 虚拟屏 / 浏览器宿主 / 返回网关）

- **Shizuku（外部依赖，非 android.*）**：`dev.rikka.shizuku:api/provider 13.1.5`。`ShizukuTransport` 管理
  UserService 生命周期（权限状态、bind 超时 4s、`ShizukuUserServiceArgs`）；`ShizukuUserService` 实现既有
  AIDL v1（uid/protocolVersion/exec(argv)，16KB 输出上限）。所有调用 fail-closed；授权只能由用户在
  Shizuku App 内授予。`ShizukuSupport`/`ShizukuProbe` 仍走反射（探针可注入式降级）。
- **虚拟屏**：`VdisplayController` 在**应用进程**建 `PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH|DESTROY_CONTENT_ON_REMOVAL`
  的 VirtualDisplay，输出先用 `ImageReader` 兜底；viewer 挂接后 `setSurface(viewerSurface)`，释放回 reader。
  运行时 displayId 动态，产品别名 `virtual-N` 稳定；`ScreenTargets.REAL` 固定 display 0 且不可镜像。
- **浏览器宿主**：`BrowserHost` 惰性创建第二个 WebView（不 `addJavascriptInterface`），
  `BrowserHostNavigationPolicy` 只放行 http(s)/about:blank 且拒绝 loopback；stage 几何用物理
  letterbox rect（不做 CSS/Android 缩放），视口预设由页面桥 `browserHostViewport` 下发。
- **返回网关**：`BackGate`（决策器）+ `BackGateBridge`（`window.dshBackBridge`，独立 @JavascriptInterface
  对象，2 方法）——页内层栈可用性同步过桥，Activity 用 `OnBackPressedCallback` 消费；层穷尽才退出。
