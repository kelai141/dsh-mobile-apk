# ARCHITECTURE.md — 模块地图

> 职责：安卓壳源码的权威模块登记（**65 个 .kt 文件**、assets 资产、manifest 组件）。行数为 2026-09-14 当场 wc 实测；「被引用」为名称级 grep（含少量注释提及），调用关系以源码为准。源码根：`app/src/main/java/com/dsharnessmobile/shell/`。

## 1. 宿主 Activity 及拆分协作类

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| MainActivity.kt | 918 | 主 WebView 宿主/生命周期/桥接线/insets/BrowserHost 与 VdisplayHost 生命周期编排 | 几乎所有协作类（构造注入） |
| GuidePageRenderer.kt | 404 | 引导页纯代码 UI 渲染 + GuidePhase 状态机 + WebUI/引导页切换 + APK 自更新交互 | MainActivity |
| GuideChrome.kt | 430 | 引导页控件句柄束（GuideChrome/GuideCallbacks 数据类，DsUi 消费方） | GuidePageRenderer、MainActivity、WatchdogV2、EngineService |
| EngineStartFlow.kt | 539 | 启动流/失败重试/前台监控/冻结看门狗/更新编排（onCreate/onResume 委托入口） | MainActivity、GuidePageRenderer |
| ConfigTransfer.kt | 355 | 配置导入导出纯逻辑 + DirectoryPickerController（SAF）+ MediaPickController + PickImageContract | MainActivity（含 AndroidBridge lambda 接线） |
| DownloadSaver.kt | 262 | 引擎源下载落盘（exports 优先/MediaStore 回退）+ 外链系统浏览器打开 | MainActivity、UpdateChecker |
| WebUiChrome.kt | 123 | 窗口 UI chrome：沉浸式/剪贴板/常亮/主题推送（真源统一走 ShellState） | MainActivity |
| FileIncoming.kt | 484 | 外部来件（VIEW/SEND）校验净化→临时工作区→通知引擎；queued source 保留到浏览器草稿 claim 或 TTL | MainActivity、EngineService |
| AndroidBridge.kt | 383 | `window.androidBridge` 全部 @JavascriptInterface（计数由 check-bridge-symmetry 守；含设置/chooser/ScreenScope/BrowserHost/虚拟屏/BackGate 接线） | MainActivity（唯一 addJavascriptInterface 点） |
| BrowserHost.kt / BrowserHostNavigationPolicy.kt / BrowserOverlayPolicy.kt | 1813 / 210 / 82（`wc -l` 现数；**不要写死**，行数每次改都会漂） | 惰性隔离第二 WebView（无 bridge）；准入 = http(s)/about:blank 且**主机规范化后**拒回环等价写法（数值/八进制/十六进制/结尾点/IPv4-mapped）；请求级过滤另拒回环/链路本地/元数据段；stage bounds + viewport letterbox；覆盖层可见性判据（fail-closed + 发布者保鲜 TTL） | MainActivity |
| ScreenScope.kt | 55 | 0.14 新增：ScreenScope/ScreenTargets/ScreenScopePrefs——用户屏幕范围的 native 真源（损坏/未知回落 virtual-only） | AndroidBridge、DeviceControlService |

注入方向：MainActivity 字段初始化阶段 `by lazy`/直接构造各协作类并传 `this`（如 `engineFlow = EngineStartFlow(this)`）；ActivityResult 注册必须在 STARTED 前，故 dirPickerController/mediaPickerController 为字段直接构造。协作类只回调 MainActivity 的 internal 方法，不持有彼此。

## 2. 悬浮球（OverlayService 及协作模块）

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| OverlayService.kt | 772 | 三窗口（球/光环/面板）生命周期、拖动与四向钳制（0.14.1 块I 起**无贴边吸附**）、块H 完成位与报告栏窗口收口、探活与发送编排（session.prompt/cancel/create） | OverlayController、MainActivity、EngineService、协作类 |
| OverlayHalo.kt | 164 | 光环 drawable（**glow+ring 两层 LayerDrawable**，0.14.1 块I）/四态切换/syncHalo 同心 + deriveHalo 派生唯一权威；Halo 枚举（纯 Kotlin ARGB 字面量） | OverlayService |
| OverlayPanel.kt | 1217 | 展开面板视图构建/状态模板/待答卡渲染 + MuxClient 消费 + POST /api/respond 应答 + 状态行手势（块H：长按报告栏/三击跳转） | OverlayService、OverlayLiveFeed |
| OverlayLiveFeed.kt | 196 | FileObserver 监听 .live.ndjson 逐行 drain（turn_start/tool_call/tool_result/turn_end **+ 块H 的 kind 语义标签**）+ android_* 自动化避让 + debug 合成注入 | OverlayService |
| OverlayTheme.kt | 38 | 系统明暗判定 + 展开态色板（ThemeColors） | OverlayService、OverlayPanel |
| MuxClient.kt | 232 | 手写 WebSocket 客户端（/api/remote.mux 下行，协议见 BRIDGE-API.md；可选 streamId 供通知应答流复用） | OverlayPanel、NotifyBridge |
| ShimmerTextView.kt | 92 | Deep diving 扫光动效 TextView（LinearGradient shader） | OverlayService、OverlayPanel |
| OverlayReport.kt | 325 | 0.14.1 块H 新增：报告栏独立顶层窗口（buildReportBar/showReport/hideReport/isShowing）+ 完成位状态机 CompletionNotice + 纯逻辑 reportLines/turnEndLabel/手势裁决函数 | OverlayService |
| OverlayController.kt | 92 | 悬浮球开关持久化 + 服务起停 + SYSTEM_ALERT_WINDOW 权限引导（偏好 ∧ 权限 ∧ 服务在场） | AndroidBridge lambda、MainActivity、OverlayService（注释） |

注入方向：`OverlayService` 构造 `OverlayHalo(this)/OverlayPanel(this)/OverlayLiveFeed(this)`，OverlayPanel 内部再构造 `OverlayTheme(svc)`——统一为「构造注入服务引用、同包顶层类、无静态单例」。协作类只经 `svc.internal` 字段/方法读写共享状态，调用方向单向：Service → 协作类，协作类 → Service 公开面。

## 3. 引擎运行时与保活

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| EngineManager.kt | 1378 | 快照部署/指纹刷新（事务化）/引擎 spawn（linker64 回退）/shellEnv/运行时补丁部署 | AdbState、EngineService、EngineStartFlow、ConsoleSession、MainActivity、UpdateManager、UndoGate |
| EngineService.kt | 201 | 前台服务 + 5s 看门狗 tick + onTaskRemoved 礼仪 | BootReceiver、EngineStartFlow、MainActivity、WatchdogV2、UpdateManager（注释） |
| WatchdogV2.kt | 361 | 深度探活/熔断指数退避/PARTIAL_WAKE_LOCK + task-done 标记按字节偏移消费（ST-12） | EngineService、BootReceiver、EngineStartFlow、UndoGate、GuideChrome（注释） |
| UndoGate.kt | 198 | 连败 6 次急救回退：调 assets/undo-emergency.mjs restore-last-good（幂等/防循环） | EngineService、EngineStartFlow、EngineManager（注释）、AdbState（注释） |
| SnapshotExtractor.kt | 160 | xz tar 流式解压（commons-compress）+ security.android.exec xattr 补章 + zip-slip 防护 | EngineManager、UpdateManager |
| SnapshotTransaction.kt | 492 | 运行时替换事务：暂存解压→原子交换→指纹提交；中断恢复（前滚/回滚/丢弃） | EngineManager |
| SnapshotFs.kt / SnapshotFileMode.kt / SnapshotUserData.kt | 88 / 23 / 135 | NOFOLLOW 文件原语（目录枚举走 `newDirectoryStream`，避 `Stream.toList()` 的 API 34 依赖）/ 权限位 / ≤0.13.2 遗留 `.dsh-backup` 一次性补写 | SnapshotTransaction、EngineManager |
| FactoryProfilePatch.kt | 241 | 0.14（#214）：profile `cordis.patch.yml` 工厂语义定点纠正（按 id 以工厂为准，退役 disabled 残行清理，用户独有条目不动） | EngineManager、SnapshotTransaction |
| UpdateManager.kt | 145 | 快照在线更新（manifest/sha256/换 usr，usr-old 回退） | EngineManager、EngineStartFlow、UndoGate（注释） |
| EngineProbe.kt | 93 | 引擎探活（Proxy.NO_PROXY 直连 #118；401/303 视作 alive） | 壳侧全部探活唯一入口 |
| ConsoleActivity.kt | 168 | 内置 bash 控制台（assets/console.html + consoleBridge 6 方法） | MainActivity、GuidePageRenderer |
| ConsoleSession.kt | 150 | 快照 bash 子进程（stdin 管道 + Listener 回调，随 Activity 生死） | ConsoleActivity |

## 4. ADB / Shizuku / 设备控制 / 通知 / 日志 / UI 工具

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| AdbState.kt | 687 | ADB 授权单一事实源：三道门/真实 pair 握手/NSD 端口发现/adbShellExecute/审计（AdbAudit）；0.14 起定位为迁移/诊断面，正式特权通道转 Shizuku | AndroidBridge、EngineManager、MainActivity、ShizukuProbe（注释） |
| AdbKeyboardService.kt | 168 | 内嵌 ADBKeyboard 协议 IME（android_ui_input 中文输入；仅活跃时提交） | AdbKeyboardReceiver（静态 handle 转发） |
| AdbKeyboardReceiver.kt | 32 | ADB_INPUT_TEXT/ADB_CLEAR_TEXT 广播入口 | manifest 注册（无代码调用方） |
| BootReceiver.kt | 48 | BOOT_COMPLETED 恢复用户同意状态 + BatteryWhitelist 引导 | manifest 注册（无代码调用方） |
| ShizukuSupport.kt | 58 | Shizuku 反射探活（历史：引导页状态行只读展示） | EngineStartFlow（状态行） |
| ShizukuProbe.kt | 117 | Shizuku 五态探针（absent/not-running/denied/prev11 等错误码 + guidance，fail-closed） | MainActivity、DeviceControlService、VdisplayController |
| ControlPoller.kt | 222 | 无障碍控制队列客户端（引擎侧 exact 路由长轮询 + 心跳 + 回填；协议版本/能力声明） | EngineStartFlow、DeviceControlService |
| ControlProtocolV2.kt | 227 | 控制协议 V2 列式编码器（壳侧唯一编码入口；句柄 = 原始行号；与引擎解码器由跨语言门禁锁定） | ControlPoller、DeviceControlService |
| DeviceControlService.kt | 1094 | 无障碍服务（语义控制面）：能力声明、树快照、动作执行、截屏、屏幕范围执行点复查 | ControlPoller、ControlPolicy（引擎侧） |
| GlobalActionCatalog.kt | 53 | 全局动作目录（名称 ↔ 平台常量 ↔ minSdk，纯数据；可用性由 getSystemActions() 驱动） | DeviceControlService |
| NotifyCenter.kt | 834 | 引擎事件→系统通知：五类渠道、六类 kind 分流、弹窗/静默形态、自检面 | MainActivity、WatchdogV2、NotifyStore |
| NotifyStore.kt | 287 | `.notify.ndjson` 偏移消费（FileObserver + 字节偏移持久化 + 双读不双发） | NotifyCenter |
| NotifyBridge.kt | 352 | 专用 `$events` 应答流（waterfall 投放 / cancel 撤通知 / $events/result 投递） | NotifyCenter、NotifyDecisionQueue |
| NotifyDecisionQueue.kt | 402 | 决策耐久队列（先落盘再投递、指数退避 ≤60s、失败态可见、NOT_READY 墙钟预算） | NotifyActionReceiver |
| NotifyActionReceiver.kt | 133 | 通知动作接收器（回复/选项/批准/拒绝/重试）：outcome 构造 + 入队 + 快速投递，不 startActivity | manifest 注册 |
| NotifyProbe.kt | 40 | 通知面耐久探针（`files/notify-responder.log` 追加 + 轮转） | NotifyBridge |
| LogCollector.kt | 332 | 开发者日志收集（logcat+engine.log + 启动分段插桩；进程级单例） | 全壳日志面 |
| DsUi.kt | 82 | 引导页共享 drawable/动效/按压反馈 | GuidePageRenderer、GuideChrome |
| PathOpen.kt | 122 | 系统「打开方式」选择器（FileProvider content:// + MIME；目录走树选择器；canonical 白名单） | AndroidBridge → MainActivity |
| ProcIo.kt | 137 | 子进程有界 I/O（readBounded 三态 timedOut/truncated；禁裸 readText，check-bounded-io 门禁） | AdbState、UndoGate、EngineManager |
| ShellState.kt | 125 | ST 真源收敛：沉浸式/开发者日志两处「展示值 ≠ 事实」的统一读写面（仅偏好 ∧ 运行时合取） | MainActivity、WebUiChrome、AndroidBridge |
| LiveProbe.kt | 54 | 轻量真源探测原语（TCP connect + TTL ≤ 页面轮询周期；时钟/探测体可注入单测） | AdbState |
| ApkArtifactCheck.kt | 38 | 启动页 APK 自更新产物校验（缓存/新下载两路径共用同一严格度：存在/大小/sha256） | GuidePageRenderer、UpdateChecker |

## 5. 0.14 新增：Shizuku 特权 transport、虚拟屏与浏览器宿主

| 文件 | 行数 | 职责一句话 | 被引用 |
|---|---|---|---|
| ShizukuTransport.kt | 177 | 应用侧 Shizuku UserService 生命周期（权限状态、bind/解绑、固定 argv 执行；不向页面/引擎暴露任意 shell 面） | VdisplayController、MainActivity |
| ShizukuUserService.kt | 75 | shell/root 侧 UserService 实现（现有 AIDL v1：uid/protocolVersion/exec(argv)，16KB 输出上限；只收原生控制器持有的 argv） | ShizukuTransport |
| VdisplayController.kt | 389 | VirtualDisplay 创建/销毁、Settings launch 探针、`input -d` 回退探针、viewer Surface attach/detach | MainActivity、VdisplayHost、DeviceControlService |
| VdisplayHost.kt | 177 | 原生 viewer SurfaceView 宿主：把可信 Files stage 几何映射到根 FrameLayout 并 attach 到 controller | MainActivity |
| VirtualDisplayProbe.kt | 146 | 建屏 flags 探针（本地位值常量，不引用 @hide 常量；金丝雀/无泄漏断言） | 调试验收（device probe） |
| BackGate.kt | 149 | 返回网关决策器（页内层栈可用性 → 消费/退出）+ `BackGateBridge`（setAvailable/getBackAvailable 2 个 @JavascriptInterface） | MainActivity（OnBackPressedCallback 接线） |

## 6. assets/ 结构（app/src/main/assets/）

| 资产 | 作用 | 消费方 |
|---|---|---|
| snapshot.tar.xz | 内嵌 Termux 运行时快照（usr/ + home/，含 node + @deepseek-ai/dsh 0.1.5-rc.1） | SnapshotExtractor（首启解压到 filesDir） |
| snapshot.sha256 | 快照指纹（随 ABI/批次变化，现数用 `check-snapshot-fingerprint` 对账） | EngineManager 读取；与 filesDir/.snapshot-fingerprint 比对——指纹翻转触发事务化全量重解压，`snapshotRefreshing` 闸门在刷新期禁止拉引擎 |
| patched/ 两文件 | 运行时补丁（全量覆盖式：attachment-local-index.js 48,404B、session-persistence-jsonl-index.js 138,025B；登记见 RUNTIME-PATCHES.md） | EngineManager.applyRuntimePatches()（内容指纹判定，目标包缺席跳过） |
| console.html | 控制台终端 UI（consoleBridge 页面侧） | ConsoleActivity 加载 |
| undo-emergency.mjs | undo 急救 CLI（list/restore/safe-mode，独立于引擎可运行） | EngineManager.deployUndoCli → UndoGate.execute 调用 |
| licenses/ | GPL 全文四件 + THIRD_PARTY_NOTICES.md（第三方合规随包分发） | 门禁 check-third-party.mjs 校验其来源 |

## 7. manifest 组件（app/src/main/AndroidManifest.xml）

| 组件 | 类型 | 源文件 | 要点 |
|---|---|---|---|
| .MainActivity | activity（exported，LAUNCHER + VIEW/SEND intent-filter） | MainActivity.kt | configChanges 四向 + adjustResize |
| .ConsoleActivity | activity（exported=false） | ConsoleActivity.kt | 引擎未运行也可用 |
| .EngineService | service（foregroundServiceType=dataSync） | EngineService.kt | 保活+看门狗宿主 |
| .AdbKeyboardService | service（BIND_INPUT_METHOD，exported=true） | AdbKeyboardService.kt | @xml/input_method 注册 IME |
| .DeviceControlService | service（BIND_ACCESSIBILITY_SERVICE，exported=true） | DeviceControlService.kt | @xml/accessibility_service_config 能力声明 |
| .OverlayService | service（exported=false） | OverlayService.kt | SYSTEM_ALERT_WINDOW 悬浮球 |
| .AdbKeyboardReceiver | receiver（exported=true，ADB_INPUT_TEXT/ADB_CLEAR_TEXT） | AdbKeyboardReceiver.kt | 仅 IME 活跃时生效 |
| .BootReceiver | receiver（exported=true，BOOT_COMPLETED） | BootReceiver.kt | 开机恢复 |
| .NotifyActionReceiver | receiver（exported=false，显式 Intent） | NotifyActionReceiver.kt | 通知动作（回复/选项/批准/拒绝/重试） |
| androidx FileProvider | provider（${applicationId}.fileprovider） | （框架类） | 路径白名单 @xml/file_paths，不映射 .credentials.yaml 等机密区 |
| rikka.shizuku.ShizukuProvider | provider（${applicationId}.shizuku，`android:permission=INTERACT_ACROSS_USERS_FULL`） | （Shizuku 框架类） | Shizuku binder bootstrap；Shizuku 仍是唯一授权方；check-manifest-hardening 显式白名单放行 |

权限 13 项（INTERNET / MANAGE_EXTERNAL_STORAGE / READ_EXTERNAL_STORAGE maxSdk32 / WRITE_EXTERNAL_STORAGE maxSdk29 / POST_NOTIFICATIONS / FOREGROUND_SERVICE(+DATA_SYNC) / RECEIVE_BOOT_COMPLETED / WAKE_LOCK / REQUEST_IGNORE_BATTERY_OPTIMIZATIONS / REQUEST_INSTALL_PACKAGES / QUERY_ALL_PACKAGES / SYSTEM_ALERT_WINDOW），逐条理由见 AndroidManifest.xml 注释。

## 8. 0.14 当前屏幕控制构造（施工中）

```
android_screen_list (metadata only; no screen content)
   └─ androidPrivilege.screenAccess(screenId)  ← reads native dsh_screen_scope.xml every operation
        ├─ virtual-only / real-only / all user range check
        ├─ virtual-1 not ready (no VirtualDisplay yet) → screen-not-ready, never display 0
        └─ allowed real → gateFor(session) requires danger-full-access
             └─ ControlPolicy.decideControl(op) → a11y or legacy ADB fallback
                  └─ DeviceControlService repeats scope check and invalidates old refs on range change
```

`VdisplayController` 已能建真实 VirtualDisplay（公开 `PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH`）并把
别名 `virtual-1` 映射到运行时 displayId；viewer Surface 重挂与多屏选择面仍未收口（见 known-gaps.md）。
本节记录代码施工状态，不表示已通过设备验收。

## 9. 0.13.5 设备控制面（双通道）

```
AI 工具（dsh-android-manage）
   └─ androidPrivilege.gateFor(session)   ← 会话档位 danger-full-access 恒需
        ├─ 无障碍通道在线（prefs a11yEnabled + 队列心跳 <20s）
        └─ 或 ADB 三道人门齐备（完全访问 + 允许访问 + 配对；0.14 起为迁移面，正式通道转 Shizuku）
   └─ ControlPolicy.decideControl(op)     ← 后端选择（a11y 优先，ADB 回退，fail-closed）
        ├─ a11y → ControlQueue（引擎侧 exact 路由 /api/android/ui/{pending,result}，共享令牌）
        │        ↕ 长轮询（壳侧 ControlPoller，空闲 5s/有活即时，轮询即心跳）
        │        DeviceControlService（AccessibilityService：树快照 + performAction + takeScreenshot）
        └─ adb  → execAdbLine/execAdbShell（shell 执行、原图截图、pm/dumpsys 等系统面）
```

两条通道**等价且无障碍优先**（PRD-0.13.2 §3.3 B3）；授权面在设置页「设备控制授权」：无障碍为主入口，ADB 折叠为高级/脚本面。
