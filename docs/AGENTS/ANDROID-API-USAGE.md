# ANDROID-API-USAGE.md — android.* 使用面分组登记

> 职责：壳源码 android/androidx 平台 API 的按域分组清单与 API 等级约束。统计口径：`grep "^import android"` 当场实测（2026-09-12，0.14.0-preview 通知面落地后）——android.* 导入行 272 处、去重 98 类，分布于 44/55 个源文件（11 个零 android 导入：ApkArtifactCheck / ControlPoller / ControlProtocolV2 / EngineProbe / FactoryProfilePatch / LiveProbe / ProcIo / SnapshotFileMode / SnapshotFs / SnapshotTransaction / SnapshotUserData，纯 java.net/java.io/java.security）；androidx 导入 27 处、去重 14 类。源码根 `app/src/main/java/com/dsharnessmobile/shell/`。

## 1. 按域分组（85 类去重口径）

| 域 | 类 | 关键调用点 |
|---|---|---|
| WebView 全家桶（8） | WebView、WebViewClient、WebChromeClient、WebSettings、WebResourceRequest、JsResult、ValueCallback、JavascriptInterface | MainActivity.kt:313-393（配置 + shouldOverrideUrlLoading/onReceivedError/onPageFinished/onShowFileChooser/onJsAlert）、ConsoleActivity.kt:79-117、WebUiChrome.kt（主题/字体回推） |
| 通知（5） | NotificationChannel、NotificationManager、PendingIntent、（androidx）NotificationCompat、（androidx）RemoteInput | **NotifyCenter.kt**（0.14.0-preview §6：五类渠道一次性定案 + 候选 ID 迁移 + 六类 kind 分流 + 弹窗/静默形态 + 自检面）、**NotifyStore.kt**（.notify.ndjson 偏移消费）、**NotifyBridge.kt**（专用 $events 流投放）、**NotifyDecisionQueue.kt**（失败态可见通知）、MainActivity.showTestNotification、EngineService.kt（前台通知）、WatchdogV2.kt（旧信道回退） |
| 存储 SAF / MediaStore（6） | DocumentsContract、MediaStore、ContentValues、Environment、MediaScannerConnection、provider.Settings | ConfigTransfer.kt:80-306（Directory/MediaPick 双控制器 + PickImageContract :412）、DownloadSaver.kt:185-193（MediaStore.Downloads + IS_PENDING + 200MB 上限）、EngineManager.kt:262（MediaScannerConnection.scanFile）、LogCollector.kt:76（落盘路径分代） |
| IME 输入法（3） | InputMethodService、InputMethodManager、EditorInfo（全限定引用） | AdbKeyboardService.kt:30-118（ADBKeyboard 协议 IME）、OverlayPanel.kt:241,535（IME_ACTION_SEND/DONE） |
| 悬浮窗 WindowManager（4） | WindowManager、PixelFormat、view.Gravity、MotionEvent | OverlayService.kt:173-256（TYPE_APPLICATION_OVERLAY 三窗口：球/光环/面板）、OverlayController.kt:33-65（canDrawOverlays 判定 + ACTION_MANAGE_OVERLAY_PERMISSION 授权页引导） |
| FileObserver（1） | os.FileObserver | OverlayLiveFeed.kt（.live.ndjson 的 MODIFY/CREATE + debug 注入文件 .overlay-test-pending）、NotifyStore.kt:start（.notify.ndjson，偏移持久化 + 轮转残段补读） |
| 动效（9） | animation.ObjectAnimator、ValueAnimator、AlphaAnimation、PathInterpolator、graphics.LinearGradient、graphics.Shader、（androidx）SpringAnimation、SpringForce、DynamicAnimation | ShimmerTextView.kt（Deep diving 扫光，gradient 250% 平移）、OverlayService.kt:369-408（贴边吸附 spring 380/0.8）、OverlayHalo.kt:54-59（WORKING 呼吸脉动）、GuidePageRenderer.kt（引导页 stagger 入场）、DsUi.kt:8（PathInterpolator 缓动） |
| WakeLock（1） | os.PowerManager | MainActivity.kt:575-592（SCREEN_BRIGHT_WAKE_LOCK 常亮，单例成对 acquire/release）、WatchdogV2.kt:125（PARTIAL_WAKE_LOCK 前台保活 + 30min 续期） |
| 剪贴板（2） | ClipData、ClipboardManager | MainActivity.kt:487-497、WebUiChrome.kt（copyText 桥）、ConsoleActivity.kt:154-163 |
| 广播（4） | BroadcastReceiver、IntentFilter、content.Intent、os.Bundle（RemoteInput 结果） | BootReceiver.kt（BOOT_COMPLETED）、AdbKeyboardReceiver.kt（ADB_INPUT_TEXT/ADB_CLEAR_TEXT）、**NotifyActionReceiver.kt**（通知动作：回复/选项/批准/拒绝/重试；exported=false + 显式 Intent）、WatchdogV2.kt（用户交互复位监听） |
| 进程/线程基础（6） | os.Handler、os.Looper、os.Bundle、os.Build、os.IBinder、app.ActivityManager | 全壳主线程 post 面；Build 用于全部 SDK 分支；ActivityManager 用于 WatchdogV2 进程级检查 |
| 图形与控件（约 30） | GradientDrawable、RippleDrawable、LayerDrawable、ClipDrawable、ColorStateList、Typeface、TypedValue、Color + widget.LinearLayout/TextView/EditText/ImageView/Button/Spinner/ArrayAdapter/AdapterView/ScrollView/FrameLayout/ProgressBar 等 | GuideChrome/GuidePageRenderer/DsUi（引导页纯代码 UI）、OverlayPanel（面板）、OverlayService.buildRoot（白球黑鲸 Matrix 裁剪 :147-168） |
| 其他（4） | util.Base64、text.InputType、text.TextUtils、net.Uri | MuxClient.kt:75-97（WS 握手 key/accept 编解码）、OverlayPanel.kt:240（输入框类型）、FileIncoming.kt（Uri 白名单校验）、权限判定各处 |

androidx 面（14 类，27 处导入）：ComponentActivity、ActivityResultContracts / ActivityResultContract（目录/图片/权限三契约）、NotificationCompat、**RemoteInput**（通知栏直接回复，NotifyCenter.kt addQuestionActions）、ViewCompat / WindowCompat / WindowInsetsCompat / WindowInsetsControllerCompat（insets 与沉浸式）、dynamicanimation 三件（SpringAnimation/SpringForce/DynamicAnimation，OverlayService 贴边吸附）。

## 2. 单文件导入密度（前 10，grep -c 实测）

MainActivity 31 / OverlayService 20 / OverlayPanel 15 / ConsoleActivity 15 / GuideChrome 14 / WebUiChrome 10 / GuidePageRenderer·DsUi·ConfigTransfer 各 9 / WatchdogV2·NotifyCenter·EngineService·AdbKeyboardService 各 8。引擎域文件（EngineManager 4、UndoGate 2、UpdateManager 2、MuxClient 2、SnapshotExtractor 1）刻意保持最小 android 面。

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
- **前台抑制只作用于工作汇报**：`face == Face.REPORT && foreground && suppressForeground()`。`NotifyStore.isForeground()` 是 ActivityManager 粒度判定，存在假阳性；把它套在提问/审批上会让「通知内应答」整条能力消失（应用在前台本来就有应用内提问 UI 兜底）。
- **WS 应答流不得被单帧异常杀死**：`NotifyBridge.onFrame` 与 `NotifyCenter.notifyEvent` 都有 Throwable 边界（返回 `Result.ERROR`），否则异常冒到 `MuxClient.frameLoop` 会让整条 `$events` 流反复重连、后续提问/审批通知全部消失。
- **耐久探针**：`files/notify-responder.log`（`NotifyProbe`，追加 + 128KB 轮转）记 `start / ready / waterfall / notify result / 异常 / 连接心跳`，设备复验用 `run-as cat` 读取，不依赖调试日志采集器；判据口径见计划 §6.2.2「NT-11 四段可判定」。
- **提交成功必须本地结算**（DEF-NOTIFY-03）：网关只给其它持有者发 `cancel`，提交者不会收到——`NotifyDecisionQueue` 的 `OK` 分支立即 `markSettled`（`markSettled` 无条件 `cancelEvent`，不依赖 pending 表存在），否则通知停在「正在发送」。
