# ARCHITECTURE.md — 模块地图

> 职责：安卓壳源码的权威模块登记（35 个 .kt 文件、assets 资产、manifest 组件）。数字（行数/引用）为 2026-09-05 当场 wc/grep 实测；「被引用」为名称级 grep（含少量注释提及），调用关系以源码为准。源码根：`app/src/main/java/com/dsharnessmobile/shell/`。

## 1. 宿主 Activity 及拆分协作类（2026-09-05 拆分重构）

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| MainActivity.kt | 708 | WebView 宿主/生命周期/桥接线/insets 核心；拆分后只保留编排与写回 | 几乎全部协作类（构造注入） |
| GuidePageRenderer.kt | 220 | 引导页纯代码 UI 渲染 + GuidePhase 状态机 + WebUI/引导页切换 | MainActivity |
| GuideChrome.kt | 430 | 引导页控件句柄束（GuideChrome/GuideCallbacks 数据类，DsUi 消费方） | GuidePageRenderer、MainActivity、WatchdogV2、EngineService |
| EngineStartFlow.kt | 429 | 启动流/失败重试/前台监控/冻结看门狗/更新编排（onCreate/onResume 委托入口） | MainActivity、GuidePageRenderer |
| ConfigTransfer.kt | 421 | 配置导入导出纯逻辑 + DirectoryPickerController（SAF）+ MediaPickController + PickImageContract（四类同居一文件） | MainActivity（含 AndroidBridge lambda 接线） |
| DebugLogExporter.kt | 81 | 调试日志 zip 导出（复用 DownloadSaver 落盘与结果弹窗） | MainActivity |
| DownloadSaver.kt | 244 | 引擎源下载落盘（exports 优先/MediaStore 回退）+ 外链系统浏览器打开 | MainActivity、DebugLogExporter |
| WebUiChrome.kt | 178 | 窗口 UI chrome：沉浸式/textZoom/剪贴板/常亮/主题推送 | MainActivity |
| FileIncoming.kt | 279 | 外部来件（VIEW/SEND）校验净化→临时工作区→通知引擎；TTL 清扫 | MainActivity、EngineService |
| AndroidBridge.kt | 264 | 全部 @JavascriptInterface 桥（window.androidBridge，35 方法；0.14.0-preview 实测计数，0.13.x 文档写 31 已失真）+ resolvePickedPath | MainActivity（addJavascriptInterface 唯一注册点 :394） |

注入方向：MainActivity 字段初始化阶段 `by lazy`/直接构造各协作类并传 `this`（如 `engineFlow = EngineStartFlow(this)`，MainActivity.kt:64-76）；ActivityResult 注册必须在 STARTED 前，故 dirPickerController/mediaPickerController 为字段直接构造（MainActivity.kt:71-74）。协作类只回调 MainActivity 的 internal 方法（如 `activity.applyGuidePhase`），不持有彼此。

## 2. 悬浮球（OverlayService 及四协作模块）

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| OverlayService.kt | 614 | 三窗口（球/光环/面板）生命周期、拖动吸附、探活与发送编排（session.prompt/cancel/create） | OverlayController、MainActivity、EngineService、四协作类 |
| OverlayHalo.kt | 79 | 光环 drawable/四态切换/syncHalo 同心 + deriveHalo 派生唯一权威；Halo 枚举 | OverlayService |
| OverlayPanel.kt | 749 | 展开面板视图构建/状态模板/待答卡渲染 + MuxClient 消费 + POST /api/respond 应答 | OverlayService、OverlayLiveFeed |
| OverlayLiveFeed.kt | 167 | FileObserver 监听 .live.ndjson 逐行 drain（turn_start/tool_call/tool_result/turn_end）+ android_* 自动化避让 + debug 合成注入 | OverlayService |
| OverlayTheme.kt | 38 | 系统明暗判定 + 展开态色板（ThemeColors） | OverlayService、OverlayPanel |
| MuxClient.kt | 185 | 手写 WebSocket 客户端（/api/events.mux 下行，协议见 BRIDGE-API.md） | OverlayPanel、OverlayLiveFeed（注释） |
| ShimmerTextView.kt | 91 | Deep diving 扫光动效 TextView（LinearGradient shader） | OverlayService、OverlayPanel |
| OverlayController.kt | 65 | 悬浮球开关持久化 + 服务起停 + SYSTEM_ALERT_WINDOW 权限引导 | AndroidBridge lambda、MainActivity、OverlayService（注释） |

注入方向：`OverlayService` 构造 `OverlayHalo(this)/OverlayPanel(this)/OverlayLiveFeed(this)`，OverlayPanel 内部再构造 `OverlayTheme(svc)`（OverlayService.kt:91-93、OverlayPanel.kt:27）——统一为「构造注入服务引用、同包顶层类、无静态单例」。协作类只经 `svc.internal` 字段/方法读写共享状态（activeSessionId/sessionBusy/pendingKind 等），调用方向单向：Service → 协作类，协作类 → Service 公开面。

## 3. 引擎运行时与保活

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| EngineManager.kt | 968 | 快照部署/指纹刷新/引擎 spawn（linker64 回退 :597-598）/shellEnv(:858)/运行时补丁(:409)/坏 seed 迁移(:692) | AdbState、EngineService、EngineStartFlow、ConsoleSession、MainActivity、UpdateManager、UndoGate |
| EngineService.kt | 160 | 前台服务 + 5s 看门狗 tick（scheduleWithFixedDelay :97-128）+ onTaskRemoved 礼仪 | BootReceiver、EngineStartFlow、MainActivity、WatchdogV2、UpdateManager（注释） |
| WatchdogV2.kt | 160 | 深度探活/熔断指数退避（12 次阈值）/PARTIAL_WAKE_LOCK(:125) | EngineService、BootReceiver、EngineStartFlow、UndoGate、GuideChrome（注释） |
| UndoGate.kt | 160 | 连败 6 次急救回退：调 assets/undo-emergency.mjs restore-last-good（幂等/防循环） | EngineService、EngineStartFlow、EngineManager（注释）、AdbState（注释） |
| SnapshotExtractor.kt | 129 | xz tar 流式解压（commons-compress）+ security.android.exec xattr 补章 | EngineManager、UpdateManager |
| UpdateManager.kt | 144 | 快照在线更新（manifest/sha256/换 usr，usr-old 回退） | EngineManager、EngineStartFlow、UndoGate（注释） |
| EngineProbe.kt | 84 | 引擎探活（check :38/portReachable :72；Proxy.NO_PROXY 直连 #118） | 12 个文件（壳侧全部探活唯一入口） |
| ConsoleActivity.kt | 168 | 内置 bash 控制台（assets/console.html + consoleBridge 6 方法） | MainActivity、GuidePageRenderer |
| ConsoleSession.kt | 150 | 快照 bash 子进程（stdin 管道 + Listener 回调，随 Activity 生死） | ConsoleActivity |

## 4. ADB / 通知 / 日志 / UI 工具

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| AdbState.kt | 574 | ADB 授权单一事实源：三道门/真实 pair 握手/NSD 端口发现(:141)/adbShellExecute(:318)/审计（AdbAudit :552） | AndroidBridge、EngineManager、MainActivity、ShizukuSupport（注释） |
| AdbKeyboardService.kt | 118 | 内嵌 ADBKeyboard 协议 IME（android_ui_input 中文输入；仅活跃时提交） | AdbKeyboardReceiver（静态 handle 转发） |
| AdbKeyboardReceiver.kt | 19 | ADB_INPUT_TEXT/ADB_CLEAR_TEXT 广播入口 | manifest 注册（无代码调用方） |
| BootReceiver.kt | 49 | BOOT_COMPLETED 恢复用户同意状态 + BatteryWhitelist 引导 | manifest 注册（无代码调用方） |
| NotifyCenter.kt | 102 | 引擎事件→系统通知（task/todo/auth 三渠道 + 节流合并） | MainActivity、WatchdogV2 |
| LogCollector.kt | 163 | 开发者日志收集（logcat+engine.log → dshdata/log 按天轮转；进程级单例） | 14 个文件（全壳日志面） |
| ShizukuSupport.kt | 58 | Shizuku 反射探活（零依赖，仅状态展示不参与授权链） | EngineStartFlow（:393 状态行） |
| DsUi.kt | 68 | 引导页共享 drawable/动效/按压反馈 | GuidePageRenderer、GuideChrome |

## 5. assets/ 结构（app/src/main/assets/）

| 资产 | 作用 | 消费方 |
|---|---|---|
| snapshot.tar.xz | 内嵌 Termux 运行时快照（usr/ + home/，含 node + @deepseek-ai/dsh 0.1.1-rc.2） | SnapshotExtractor（首启解压到 filesDir） |
| snapshot.sha256 | 快照指纹（当前 9e591b4d…，x86_64 形态） | EngineManager.kt:64-71 读取；与 filesDir/.snapshot-fingerprint(:71) 比对——指纹翻转触发全量重解压（refreshSnapshot :93），`snapshotRefreshing` 伴生闸门(:945) 在刷新期禁止拉引擎 |
| patched/ 六文件 | 运行时补丁（全量覆盖式，登记见 RUNTIME-PATCHES.md） | EngineManager.applyRuntimePatches(:409)——仅 5 个被消费，llm-deepseek-index.js 在场未启用 |
| console.html | 控制台终端 UI（consoleBridge 页面侧） | ConsoleActivity.kt:117 加载 |
| undo-emergency.mjs | undo 急救 CLI（list/restore/safe-mode，独立于引擎可运行） | EngineManager.deployUndoCli(:40 部署到 filesDir) → UndoGate.execute 调用 |
| licenses/ | GPL 全文四件 + THIRD_PARTY_NOTICES.md（第三方合规随包分发） | 门禁 check-third-party.mjs 校验其来源 |

## 6. manifest 组件（app/src/main/AndroidManifest.xml）

| 组件 | 类型 | 源文件 | 要点 |
|---|---|---|---|
| .MainActivity | activity（exported，LAUNCHER + VIEW/SEND intent-filter） | MainActivity.kt | configChanges 四向 + adjustResize |
| .ConsoleActivity | activity（exported=false） | ConsoleActivity.kt | 引擎未运行也可用 |
| .EngineService | service（foregroundServiceType=dataSync） | EngineService.kt | 保活+看门狗宿主 |
| .AdbKeyboardService | service（BIND_INPUT_METHOD，exported=true） | AdbKeyboardService.kt | @xml/input_method 注册 IME |
| .OverlayService | service（exported=false） | OverlayService.kt | SYSTEM_ALERT_WINDOW 悬浮球 |
| .AdbKeyboardReceiver | receiver（exported=true，ADB_INPUT_TEXT/ADB_CLEAR_TEXT） | AdbKeyboardReceiver.kt | 仅 IME 活跃时生效 |
| .BootReceiver | receiver（exported=true，BOOT_COMPLETED） | BootReceiver.kt | 开机恢复 |
| androidx FileProvider | provider（${applicationId}.fileprovider） | （框架类） | 路径白名单 @xml/file_paths：仅 Documents/dshdata + workspaces/home/tmp/usr/bin，不映射 .credentials.yaml 等机密区 |

权限 12 项（INTERNET / MANAGE_EXTERNAL_STORAGE / READ_EXTERNAL_STORAGE maxSdk32 / WRITE_EXTERNAL_STORAGE maxSdk29 / POST_NOTIFICATIONS / FOREGROUND_SERVICE(+DATA_SYNC) / RECEIVE_BOOT_COMPLETED / WAKE_LOCK / REQUEST_IGNORE_BATTERY_OPTIMIZATIONS / QUERY_ALL_PACKAGES / SYSTEM_ALERT_WINDOW），逐条理由见 AndroidManifest.xml 注释。

## 0.13.5 设备控制面（双通道）

```
AI 工具（dsh-android-manage）
   └─ androidPrivilege.gateFor(session)   ← 会话档位 danger-full-access 恒需
        ├─ 无障碍通道在线（prefs a11yEnabled + 队列心跳 <20s）
        └─ 或 ADB 三道人门齐备（完全访问 + 允许访问 + 配对）
   └─ ControlPolicy.decideControl(op)     ← 后端选择（a11y 优先，ADB 回退，fail-closed）
        ├─ a11y → ControlQueue（引擎侧 exact 路由 /api/android/ui/{pending,result}，共享令牌）
        │        ↕ 长轮询（壳侧 ControlPoller，空闲 5s/有活即时，轮询即心跳）
        │        DeviceControlService（AccessibilityService：树快照 + performAction + takeScreenshot）
        └─ adb  → execAdbLine/execAdbShell（shell 执行、原图截图、pm/dumpsys 等系统面）
```

两条通道**等价且无障碍优先**（PRD-0.13.2 §3.3 B3）；授权面在设置页「设备控制授权」：无障碍为主入口，ADB 折叠为高级/脚本面。
