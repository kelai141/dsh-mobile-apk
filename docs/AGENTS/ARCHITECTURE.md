# ARCHITECTURE.md — 模块地图

## fx2 生命周期与恢复增量

`EngineService` 的启动属主快速复查预算耗尽后转为五分钟慢速复查；定时任务绑定 Service epoch，销毁时取消，迟到回调不得启动旧世代引擎。端口外来占用、启动门和用户开机选项仍按原有失败分类处理。

`NotifySuppressQueue` 在现有 `dsh-notify` 私有 preferences 内保存 v1 有界延后日志，`NotifyStore.start` 恢复并重启 tick。延后成功必须先同步提交；失败不消费来源偏移。补投后同步结算，借助完整条目哈希和系统活动通知回执缩小崩溃重复窗口，不承诺跨 Android 通知与 preferences 的原子 exactly-once。容量、TTL、会话覆盖语义不变，不迁移模型、HOME 或用户插件目录。

插件授权增量见 `BRIDGE-API.md`：固定动画设置 API 与私有 SurfaceFlinger 查询分离，公共调用不能声明 `internal` 权限。

> 职责：安卓壳源码的权威模块登记（assets 资产、manifest 组件）。**文件数与行数请用命令现数**（`find app/src/main -name '*.kt' | wc -l`、`wc -l <file>`）；本表不维护这些易漂移的数字。「被引用」为名称级 grep（含少量注释提及），调用关系以源码为准。源码根：`app/src/main/java/com/dsharnessmobile/shell/`。

## 1. 宿主 Activity 及拆分协作类

| 文件 | 职责一句话 | 被引用 |
|---|---|---|
| MainActivity.kt | 主 WebView 宿主/生命周期/桥接线/insets（手机/宽屏动态top单层消费）/BrowserHost 与 VdisplayHost 生命周期编排 | 几乎所有协作类（构造注入） |
| GuidePageRenderer.kt | 引导页纯代码 UI 渲染 + GuidePhase 状态机 + 结构化启动诊断/端口重试与SafeMode分流 + WebUI/引导页切换 + APK 自更新交互 | MainActivity |
| GuideChrome.kt | 引导页控件句柄束（GuideChrome/GuideCallbacks 数据类，DsUi 消费方） | GuidePageRenderer、MainActivity、WatchdogV2、EngineService |
| EngineStartFlow.kt / ForegroundPageRecoveryPolicy.kt | CAS generation/token启动所有权；前台页面generation与一次安静恢复，后台不运行freeze监控；销毁取消caller不取消共享root worker。0.14.8 P1：拿不到所有权时按 destroyed（不启动）/ running（boot-fail 留痕 + 有界等待后续跑）分开处置，不再静默丢弃 | MainActivity、GuidePageRenderer |
| ConfigTransfer.kt | legacy 配置导入导出未挂载；同文件 DirectoryPickerController 的 SAF 注册仍在用；活动配置读写归 EngineManager→SnapshotUserData | MainActivity（仅选择器） |
| DownloadSaver.kt | 引擎源下载落盘（exports 优先/MediaStore 回退）+ 外链系统浏览器打开 | MainActivity、UpdateChecker |
| WebUiChrome.kt | 窗口 UI chrome：沉浸式/剪贴板/常亮/主题推送（真源统一走 ShellState） | MainActivity |
| FileIncoming.kt | 外部来件（VIEW/SEND）校验净化→临时工作区→通知引擎；queued source 保留到浏览器草稿 claim 或 TTL | MainActivity、EngineService |
| AndroidBridge.kt | `window.androidBridge` 全部 @JavascriptInterface（计数由 check-bridge-symmetry 守；含设置/chooser/ScreenScope/BrowserHost/虚拟屏/BackGate 接线） | MainActivity（唯一 addJavascriptInterface 点） |
| BrowserHost.kt / BrowserHostNavigationPolicy.kt / BrowserOverlayPolicy.kt / BrowserHostProfile.kt | Session/tab 捕获目标与 model/UI focus 分离；每tab无桥WebView先验证nonDefault profile，再允许HTTP/loopback并保留受保护控制origin拒绝；stage/letterbox/TTL租约（客户端可见时1000ms续租、原生4000ms过期）；前台只重放新鲜舞台；不支持profile拒绝、不回Default | MainActivity、可信browserHostCommand、模型controlOp |
| ScreenScope.kt | 0.14 新增：ScreenScope/ScreenTargets/ScreenScopePrefs——用户屏幕范围的 native 真源（损坏/未知回落 virtual-only） | AndroidBridge、DeviceControlService |
| WebViewShim.kt | WebView 版本敏感面唯一入口：provider 回读（`getCurrentWebViewPackage`+major 解析单实现）、androidx.webkit 特性门、settings 两档（baseline=引擎页/控制台，+isolation=BrowserHost）；LocalDocs 静态文档面刻意不走 baseline | MainActivity、BrowserHost、ConsoleActivity、EngineManager |

注入方向：MainActivity 字段初始化阶段 `by lazy`/直接构造各协作类并传 `this`（如 `engineFlow = EngineStartFlow(this)`）；ActivityResult 注册必须在 STARTED 前，故 dirPickerController/mediaPickerController 为字段直接构造。协作类只回调 MainActivity 的 internal 方法，不持有彼此。

## 2. 悬浮交互（OverlayService 及协作模块）

> Phase 2 施工状态，不代表功能验收；目标与当前差异见 [设计](<docs/overlay-refactor-2026-11/design.md>)，证据边界见 [实施计划](<docs/overlay-refactor-2026-11/implementation-plan.md>)。不因交接或开关默认关闭而豁免原始需求。

| 文件 | 职责一句话 | 被引用 |
|---|---|---|
| [OverlayService.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt>) / [OverlayController.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayController.kt>) | 服务与权限/启用真源；旧球/光环/面板回滚路径和 v2 二选一，共用探活/Mux/live、会话身份与 RPC 发送/停止 | MainActivity、EngineService、协作类 |
| [OverlayHostVisibility.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayHostVisibility.kt>) | 应用级 resumed Activity 集合/前台发布；排除附件代理、pause 120ms 去抖；建窗前可读初态 | MainActivity 安装；Service/v2 消费，Console/Repair 同属跟踪目标 |
| [OverlayV2.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>) | 入口/卡片/药丸/输入的生命周期与 UI 子状态编排、事件合并渲染、共用抽屉与附件/页面通道 | OverlayService |
| [OverlayWindows.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayWindows.kt>) / [OverlayWindowFrames.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayWindowFrames.kt>) | v2 窗口槽位持有者（唯一/回执/z 序日志/收口）与屏幕/卡片/药丸/细条几何纯判据 | OverlayV2；Frames 不依赖 Android View |
| [OverlayUiModel.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayUiModel.kt>) / [OverlayViewTypes.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayViewTypes.kt>) | live不可变聚合与View唯一契约；真实transcript另有user/assistant/tool、工具参数/结果/状态与截断标记 | OverlayV2、各View；投影预算见[设计§5.5](<docs/overlay-refactor-2026-11/design.md>) |
| [OverlayCardMorphVisual.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayCardMorphVisual.kt>) | 纯文字分阶段alpha：旧history/status/handle先退尽，新capsule后进入，避免同位双文字 | CardView.applyMorph；视觉调参不是手势提交条件，无View/WM副作用 |
| [OverlayMarkdown.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayMarkdown.kt>) | 纯、有界Markdown→文本/span，不执行HTML/URI/图片或发网络请求 | OverlayCardView仅assistant正文使用；user/tool literal |
| [OverlayMotion.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayMotion.kt>) | 可配置距离motion纯数学：card形变、顶缘宽容fade/rebound、双侧球条状态与长胶囊尺寸 | OverlayV2/Entry/Pill；无Android/时钟/速度/WM副作用，provisional参数待实测 |
| [OverlayTouchRegion.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayTouchRegion.kt>) | API33+公开touchable Region，rounded/可见子表面union与缓存，和绘制clip分离 | 不改flags/focus/frame；setTouchableRegion内部请求traversal，不是draw-only；低API返回false及跨UIDopacity需要调用方策略，Composer按attached layout/scroll合并post surface union；Card在apply/reset/attach/layout按绘制同源圆角bounds更新真实morph输入Region，相同整数Region+surface缓存去重。框架内部traversal可随变化进度发生，不是纯draw-only输入路径，性能待测；低API/失败回false，fallback与额外间隙未验收 |
| [OverlayEntryView.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayEntryView.kt>) / [OverlayGestureRouter.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayGestureRouter.kt>) / [OverlayCardView.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayCardView.kt>) / [OverlayPillView.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayPillView.kt>) / [OverlayComposer.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>) / [OverlayCommandDrawer.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayCommandDrawer.kt>) | 原生双入口、纯手势裁决、卡片/药丸/输入/抽屉内容，不直接解释协议 | OverlayV2；Listener 回调 |
| [OverlayPageHost.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>) / [WorkspaceListParse.kt](<app/src/main/java/com/dsharnessmobile/shell/WorkspaceListParse.kt>) | evaluateJavascript → 页面宿主同步 JSON 回包（2500ms 超时）；workspace.json 纯解析 | MainActivity 注册求值器；OverlayV2 消费 |
| [OverlayAttachProxyActivity.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt>) | 拍照/相册/文件代理与MIME resolver/saved恢复；Bus携sid/request回执及64有界pending/recheck，超时未知不重投；FileIncoming定向入队 | OverlayV2；非导出 Activity |
| [OverlayPanel.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt>) / [OverlayPanelBackKey.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayPanelBackKey.kt>) | 旧主面板、v2 作答面/回滚面；Mux pending 解析与应答唯一真源；根派发 BACK | OverlayService、LiveFeed、OverlayV2 |
| [OverlayLiveFeed.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayLiveFeed.kt>) | FileObserver tail → liveEventOf → v2 sink 与旧消费；think/text/tool_call/tool_result/turn_end | OverlayService；生产在 bridge 插件 |
| [OverlayHalo.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayHalo.kt>) / [OverlayTheme.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayTheme.kt>) | 旧四态 glow+ring/同心/动效与主题；v2 当前未建光环是待按目标收口的施工差异 | OverlayService、Panel、Recall、Report |
| [OverlayRecall.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayRecall.kt>) / [OverlayReport.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayReport.kt>) | 既有召回条与报告栏/CompletionNotice，由服务收口，不归 v2 持有者 | OverlayService；报告读 NotifyStore |
| [MuxClient.kt](<app/src/main/java/com/dsharnessmobile/shell/MuxClient.kt>) / [ShimmerTextView.kt](<app/src/main/java/com/dsharnessmobile/shell/ShimmerTextView.kt>) | 鉴权 WS 事件流与旧面板扫光，不新增上游协议/依赖 | OverlayPanel、NotifyBridge / Panel |

依赖方向：Service持有cachedV2业务实例，旧/新UI二选一但回滚只suspend/resume，不取消unknown动作；Service真销毁才destroy/cancel观察。原生RPC经strict result.ok/accepted，unknown保原requestId并只读state/events正面证据，不重发。Service → v2 编排 → 纯模型/几何/窗口持有者/View；View 只经 Listener 回编排。Service → 旧 Panel/LiveFeed/Halo/Recall/Report 共用状态，pending/应答继续走Panel的POST /api/$events/result；F19底部answer模式经Panel strict helper绑定原event/question/sid/agent并逐题保存，普通message草稿隔离，多题末题漏答不得静默提交；完整form与审批二步保留，不造第二份协议。旧作答面打开时 `expanded=true`，不是 v2 全程 false。

页面依赖是受控求值，不是新增 `@JavascriptInterface`：MainActivity → OverlayPageHost evaluator → 页面 `window.__dshOverlayHost` → 页面现有 session/workspace/input 真源；目录主路读官方controller.menu；composer-sheet另保留 [composer-commands](<dsh-client-ui-responsive/src/client/mobile/composer-commands.ts>) 的兼容DOM读取，不能混称主路依赖。同步JSON调用面之下，action以每页面实例nonce+seq票据去重；25s只标pending+unknown，不Abort handler、不判拒绝；原生每轮自动查30s、100ms退避至1s，onUnknown保业务锁，recheck只查原票据，destroy的cancel仅停原生查询不证明撤销。工作区真实源为workspaces.list.getSnapshot，PageState的ready/error/pending与真空列表分开。命令官方menu主路通过pick交给输入prepare/popup/action等管道，handedOff不代表handler完成；无menu兼容分支resolveClaim/claim.submit不携草稿附件；附件先同步detach该批ID至in-flight、registry保字节；公开能力在场时serializeDraftAttachments→exact Session.prompt固定UUID不依赖RAF，literal ok/accepted才清本批（旧runtime保sendSession兼容），明确非gateway业务error才归还missing IDs/keeper；真实carrierFailure为ok=false+gateway/internal及cancelled等仍unknown保原request。ready4s/serialize8s前置未调用失败可恢复，operation查询只读state/events exact request正证+精确wire type/rpcId；dispose清ref/restore订阅，不证明Host动作撤销。代理targetSessionId/requestId→定向incoming→draft-ready仅证明草稿认领；完整唯一协议见 [设计§6.5](<docs/overlay-refactor-2026-11/design.md>)。

命令目录官方服务主路已落盘：[OverlayHost.withOfficialMenu](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>) 先等session.ready≤4s，超时session-not-ready并finally清timer/release、迟到ready可下一轮重试，不cache空；菜单阶段另4s，以真实draftRev/[0,0]hit借per-session menu，menu已open不抢、sid/scope/revision/hit/generation变动拒绝，finally仅dismiss本hit同代；canonical name是token、label只展示。V2先jumpToApp，execute等待visible最多10s后新借并官方pick，`ok+handedOff`仅UI管道交接，可能仍需后续输入/弹层，非handler完成。57/58/62/32及旧full1274保历史；当前87专项、2894原生与full worker加载失败/独立phone119定向结果及产物身份见 [实施计划§22](<docs/overlay-refactor-2026-11/implementation-plan.md>)；设备未验，旧51/全量失败记录保留。

冻结P1生命周期：配置/语言仅recreateViewsPreservingState，保存UI草稿/选择/焦点/布局/模型/业务generation与票据，不借重建取消动作；Service订阅AppLanguage key覆盖任意setter，Main setter即时接入，completionKind按新语言重译。附件Bus的sid/request Receipt与pending/recheck隔离会话，超时未知不重投；retainSession4s/keepDraftReference rail keeper与consumer admittedEntries/pendingAcks、plugin ticket幂等256共同保证拒绝恢复引用不提前回收/ack重试不重复add，MIME不按扩展名猜。唯一详细协议见 [设计§6.6-6.7](<docs/overlay-refactor-2026-11/design.md>)。

可见状态与预览：card/pill/composer任一可见才watchState订阅公共session/workspace/input stores，页面仅100ms console invalidation；Main同时验可信顶层/消息source，再native100ms去抖拉真state，hide/suspend/destroy退订无常驻poll。图片blob→最长256/总dataURL≤49152 JPEG→原生40↔160预览，缓存8/并发2；失效源不传全量图/任意URL。V2工作区仅同sid真state，message A/B映射不覆盖答案/原草稿。

取件同窗：V2发起前通过OverlayWindows交互租约保存各槽原View/flags/alpha，仅临时NOT_FOCUSABLE+NOT_TOUCHABLE并降低opacity，避免Android12+不可信overlay遮挡系统触摸；不hide/remove/show、不重建编辑器或setText。恢复只作用同View及发起请求，不把pickerReturned当草稿认领成功；空sid拒绝取件，不隐式create。picker活跃时outside不收底部、visual配置不重建，真实旋转仍可对原View重算几何；frame不变判据以屏幕几何未变为前提。yield失败rollback后回null，rollback失败另保pendingInteractionRestore；精确sid/request先登记再launch，restore回Boolean成功才清租约，失败最多三次120ms额外重试，迟到错request/替换View不得改新窗。相关反证与设备验收仍以当前输入为准。

窗口与呈现纪律：workspaceView/sessionView原稳定对象各进WORKSPACE/SESSION独立有界窗，COMPOSER→WORKSPACE→SESSION→DRAWER为z目标，不再保fullwidth pillRow；chips实际位置跟随composer的getLocationOnScreen/IME，sheet不抬移。主输入根仅hint/answer/attachments/input，API33按layout/scroll可见surface union缩触区，setTouchableRegion会内部traversal；旧API额外透明间隙须独立验。最新morph先调用Card.updateMorphTouchableRegion：API33成功时按与绘制同源visibleHeight/cornerRadius的真实圆角Region更新输入，不加NOT_TOUCHABLE，保实色阅读；仅false（API26–32/未attach/失败）才保存flags/alpha走旧NOT_TOUCHABLE fallback。lead设备复核已证实旧fallback即使请求alpha1也会被WMS强制cap至.80，曾继续透出Gallery，不能把源码/WM请求值当实际不透明证明。该旧路径视觉/新DOWN/跨UID透传限制尚未解决；正常composer仍alpha1，Region外间隙单验。picker九槽.15是独立取件策略。现代Region在apply/reset/attach/layout更新，整数Region+surface相同不重复提交；公共setter内部schedule traversal，变化进度可能触发框架layout，不得称全morph纯draw-only或无逐帧框架工作；无显式历史measure或逐帧WM height resize，性能仍待设备。入口/长胶囊不抢焦点；卡片为BACK使用focusable+ALT_FOCUSABLE_IM，输入独立focusable+ADJUST_PAN。独立DRAWER在COMPOSER之上覆盖输入，只改自身frame，不为sheet抬移/resize输入；height取max(自然内容高,composer高+chip高+gap+24dp)后钳在可用高40%内，避免短sheet露半截chips；小屏上限不足时覆盖完整性仍须真实截图。普通空白只收底部；长胶囊最终收起才联动输入/IME/sheet，Agent与草稿继续。长按白条后按距离连续绘制非线性形变（现代输入Region另有框架traversal），固定card root到终态才移除card/交接长pill；[OverlayCardMorphVisual](<app/src/main/java/com/dsharnessmobile/shell/OverlayCardMorphVisual.kt>)把旧状态/历史/把手在进度0..0.3退尽，再从0.5之后进入新单行，smoothstep两文字层不同时可见；这是视觉调参不是手势提交门。卡片/长pill/input/sheet/ScrollView用实色ds_surface，chips/附件tiles用实色ds_chip，有限进退场alpha动画仍保留；形变帧不测量历史、不逐帧WM resize。长胶囊一行最近真实assistant输出，状态辅助；到顶限位、继续推宽容后距离fade，同DOWN可完成，取消/不足回弹，非旧速度/新DOWN开关。球首次到边仅arm，后续向边缘滑收strip，向内拉恢复球，左右对称；router consumed抑制tap。顶部X/形态/隐藏及占位已移除，显式形态设置见[桥协议](<docs/AGENTS/BRIDGE-API.md>)。attach/detach/generation收动画；suspend/recreate经cancelCardInteraction撤hold/morph，finish守card owner身份，旧回调不消散新窗；pill-only页面刷新与watchState保持。provisional参数待实测，不称完成。当前OverlayMotionConfig.feasibleCollapseDistancePx使用handle屏幕TOP（不是中心，保证把手内任意DOWN均有该保守预算）：travel=handleTop−safeTop−reserve，distance=min(provisional,travel×.8)。参数非有限/非法或travel非正时回null，不造1px等最小提交距离；V2.measureMotion仅对可见已layout handle传状态栏safeTop及4dp reserve，有有效值才覆盖base，否则仍保留provisional配置，不把fallback当可达/验收证明。cardGestureMotion在DOWN测量并锁定，整个MOVE/UP及settle沿同一配置，hide/cancelCardInteraction/settle终态清理；基础84dp与.8均只是调参起点，不是确认产品门。chips在View attach时注册GL/PreDraw及一次guarded post，detach移除同observer监听/回调；单个View lifetime仅安装一次layout监听，不每show累加。chipSizesPx在测量前以width/两label/densityDpi/fontScale查缓存；实际screen top先规范化≥0再比较/写回，几何不变不更新WM，避免紧凑横屏更新环；picker租约守卫在任何chip membership移除前。syncDrawer同样先守租约，hideDrawer仅真正suspend/前台/销毁例外可撤窗。API30+ screen读getInsetsIgnoringVisibility(systemBars)保稳定系统栏预算，配置变化重新注入40% drawer height cap/syncDrawer并post读取chip实际几何，避免隐藏系统栏或旧横屏上限挤压sheet。showComposer捕获identity/generation与visibility/foreground/suspend/closing/picker守卫，外层main.post及Composer内部input.post/showSoftInput前都复查，禁止取件或关闭后的排队焦点抢回。

真实历史链：公开SessionBinding.eventSource → 页面有界transcript → Kotlin独立复验 → 原生CardView。工具按session/turn/step/callId关联，thought/system不混assistant；assistant用安全native Markdown spans，user/tool literal，稳定row及scroll锚保留。长条/card/composer可见时订阅；debug只读快照提供ViewId/flags/alpha、节点bounds与session/text/selection/refs，不能代替真实ADB截图/WM事实。**CURRENT VERIFICATION PENDING**；结果由[测试报告](<docs/overlay-refactor-2026-11/test-report-phase2.md>)单一维护。

## 3. 引擎运行时与保活

| 文件 | 职责一句话 | 被引用 |
|---|---|---|
| EngineManager.kt | 快照部署/指纹刷新（事务化）/引擎 spawn（linker64 回退）/shellEnv/运行时补丁部署 | EngineService、EngineStartFlow、ConsoleSession、MainActivity、UpdateManager、UndoGate |
| EngineService.kt | ServiceEpoch拥有startup/watchdog/undo caller与WakeLockOwner；等待后重复epoch检查；pending最多六次2/4/8/16/30/30秒重查，耗尽不自旋 | BootReceiver、EngineStartFlow、MainActivity、WatchdogV2 |
| WatchdogV2.kt | 深度探活/熔断指数退避/PARTIAL_WAKE_LOCK + task-done 标记按字节偏移消费（ST-12） | EngineService、BootReceiver、EngineStartFlow、UndoGate、GuideChrome（注释） |
| UndoGate.kt | 看门狗/启动失败恢复：按当前 transaction-authorized Hard `{id,name}` manifest 判归属；非 Hard 故障只追加 disabled override 保留原配置；整份恢复要求同一 Soft digest 在两次实际引擎 spawn 上通过 authenticated Cordis/preset/session/modelCatalog health | EngineService、EngineStartFlow |
| SnapshotExtractor.kt | xz tar 流式解压（commons-compress）+ security.android.exec xattr 补章 + zip-slip 防护 | EngineManager、UpdateManager |
| SnapshotTransaction.kt | 工厂刷新与在线更新共用事务 journal/stage/previous；在线事务仅换 usr、冷启动回滚未健康提交，工厂事务保持原契约 | EngineManager、UpdateManager |
| SnapshotFs.kt / SnapshotFileMode.kt / SnapshotUserData.kt / SnapshotFingerprintPolicy.kt / ProfilePackageManifest.kt | NOFOLLOW文件原语、权限；迁移marker与活动profile配置保留/传输/旧blank seed隔离；未知 `.dsh` 冲突项默认保留；严格内嵌SHA与durable fingerprint准入；profile manifest merge 与快照刷新共用 | SnapshotTransaction、EngineManager |
| FactoryProfilePatch.kt | 0.14（#214）：profile `cordis.patch.yml` 工厂语义定点纠正（按 id 以工厂为准，退役 disabled 残行清理，用户独有条目不动） | EngineManager、SnapshotTransaction |
| UpdateManager.kt | SHA 校验后把在线包解到共享 stage，经 ONLINE_UPDATE journal 只换 usr；探活健康提交，冷启动恢复未提交事务 | EngineManager、EngineStartFlow |
| EngineProbe.kt | 引擎探活（Proxy.NO_PROXY 直连 #118；401/303 视作 alive）；Soft promotion 的只读健康证据另要求 Cordis inventory、启用的主插件与 preset fibers active、session/list 与 modelCatalog 形状完整 | 壳侧全部探活唯一入口 |
| RepairActivity.kt / RepairModelClient.kt | 引擎启动失败后的原生聊天式诊断与修复面 | 不依赖 Node、WebView 或插件；读取 DSH 模型路由与凭据，历史保持 provider 原生 tool 形状，工具面限定私有运行时与公共诊断目录 |
| ConsoleActivity.kt | 内置 bash 控制台（assets/console.html + consoleBridge 6 方法） | MainActivity、GuidePageRenderer |
| ConsoleSession.kt | 快照 bash 子进程（stdin 管道 + Listener 回调，随 Activity 生死） | ConsoleActivity |

## 4. ADB / Shizuku / 设备控制 / 通知 / 日志 / UI 工具

| 文件 | 职责一句话 | 被引用 |
|---|---|---|
| AdbKeyboardService.kt | 内嵌 ADBKeyboard 协议 IME（android_ui_input 中文输入；仅活跃时提交） | 运行期注册 AdbKeyboardReceiver（隐式广播）+ 注销 |
| AdbKeyboardReceiver.kt | ADB_INPUT_TEXT/ADB_CLEAR_TEXT 广播入口；来源校验（root 隐式信任 + nonce；#679 起 uid 2000 不再白名单）并写回结果码 | manifest 注册（只收点名组件广播）＋ IME 运行期注册（隐式广播） |
| BootReceiver.kt | BOOT_COMPLETED 恢复用户同意状态 + BatteryWhitelist 引导 | manifest 注册（无代码调用方） |
| ShizukuSupport.kt | Shizuku 反射探活（历史：引导页状态行只读展示） | EngineStartFlow（状态行） |
| ShizukuProbe.kt | Shizuku 五态探针（absent/not-running/denied/prev11 等错误码 + guidance，fail-closed） | MainActivity、DeviceControlService、VdisplayController |
| ControlPoller.kt | 无障碍控制队列客户端（引擎侧 exact 路由长轮询 + 心跳 + 回填；协议版本/能力声明） | EngineStartFlow、DeviceControlService |
| ControlProtocolV2.kt | 控制协议 V2 列式编码器（壳侧唯一编码入口；句柄 = 原始行号；与引擎解码器由跨语言门禁锁定） | ControlPoller、DeviceControlService |
| DeviceControlService.kt | 无障碍服务（语义控制面）：能力声明、树快照、动作执行、截屏、屏幕范围执行点复查 | ControlPoller、ControlPolicy（引擎侧） |
| GlobalActionCatalog.kt | 全局动作目录（名称 ↔ 平台常量 ↔ minSdk，纯数据；可用性由 getSystemActions() 驱动） | DeviceControlService |
| NotifyCenter.kt | 引擎事件→系统通知：五类渠道、六类 kind 分流、弹窗/静默形态、自检面 | MainActivity、WatchdogV2、NotifyStore |
| NotifyStore.kt | `.notify.ndjson` 偏移消费（FileObserver + 字节偏移持久化 + 双读不双发） | NotifyCenter |
| NotifyBridge.kt | 专用 `$events` 应答流（waterfall 投放 / cancel 撤通知 / $events/result 投递） | NotifyCenter、NotifyDecisionQueue |
| NotifyDecisionQueue.kt | 决策耐久队列（先落盘再投递、指数退避 ≤60s、失败态可见、NOT_READY 墙钟预算） | NotifyActionReceiver |
| NotifyActionReceiver.kt | 通知动作接收器（回复/选项/批准/拒绝/重试）：outcome 构造 + 入队 + 快速投递，不 startActivity | manifest 注册 |
| NotifyProbe.kt | 通知面耐久探针（`files/notify-responder.log` 追加 + 轮转） | NotifyBridge |
| LogCollector.kt | 开发者日志收集（logcat+engine.log + 启动分段插桩；进程级单例） | 全壳日志面 |
| DsUi.kt | 引导页共享 drawable/动效/按压反馈 | GuidePageRenderer、GuideChrome |
| PathOpen.kt | 系统「打开方式」选择器（FileProvider content:// + MIME；目录走树选择器；canonical 白名单） | AndroidBridge → MainActivity |
| ProcIo.kt | 有界排水与waiter外独立kill/close workers；不可变partial/exit/drain/read/cleanup facts，local cleanup不证明特权后代结算 | RootAccess、ShizukuUserService、UndoGate、EngineManager、LogCollector |
| ShellState.kt | ST 真源收敛：沉浸式/开发者日志两处「展示值 ≠ 事实」的统一读写面（仅偏好 ∧ 运行时合取） | MainActivity、WebUiChrome、AndroidBridge |
| LiveProbe.kt | 轻量真源探测原语（TCP connect + TTL ≤ 页面轮询周期；时钟/探测体可注入单测） | 迁移保留，无当前调用者 |
| ApkArtifactCheck.kt | 启动页 APK 自更新产物校验（缓存/新下载两路径共用同一严格度：存在/大小/sha256） | GuidePageRenderer、UpdateChecker |

（`AdbState.kt` 已于 8141e5c「0.14.0 正式轮」删除：ADB 授权/审计职责拆进 `EngineAuth`/`ShizukuTransport`/`ControlAudit`/`LiveProbe`/`ProcIo`；旧行保留在 git 历史里，不再列于本表。）

## 5. 0.14 新增：Shizuku 特权 transport、虚拟屏与浏览器宿主

| 文件 | 职责一句话 | 被引用 |
|---|---|---|
| ShizukuTransport.kt | 应用侧 Shizuku UserService 生命周期（权限状态、bind/解绑、固定 argv 与经授权的 `sh -c` 执行） | VdisplayController、MainActivity、ShellOps |
| ShizukuUserService.kt | shell/root 侧 v4 服务，确认完整 app UID/可信数据 anchor；有界执行、文件传输和共享 FD 属主修复 | ShizukuTransport |
| RootGrant.kt / RootAccess.kt | 有效 AI 同意与 su 授权是独立门；最后可信派发点检查，固定维护例外不暴露任意 shell | ShizukuTransport、ShellOps、AndroidBridge |
| OwnershipRepairCore.kt / OwnershipRepair.kt / RootRepairMain.kt | 共享有界遍历与 Android FD 适配；su 只加载已安装 APK 的固定 helper | RootAccess、ShizukuUserService |
| RootExecutionFence.kt / RootMaintenanceLease.kt / RootOwnershipJobs.kt | Context感知公平零时限读栅栏/维护写栅栏；UID0派发前耐久lease；同boot UNKNOWN阻止新派发/维护/启动；共享job状态按当前lease诚实pending | RootAccess、ShizukuTransport、EngineStartFlow、EngineService、RootGrant |
| VdisplayController.kt | VirtualDisplay 创建/销毁、Settings launch 探针、`input -d` 回退探针、viewer Surface attach/detach | MainActivity、VdisplayHost、DeviceControlService |
| VdisplayHost.kt | 原生 viewer SurfaceView 宿主：把可信 Files stage 几何映射到根 FrameLayout 并 attach 到 controller | MainActivity |
| VirtualDisplayProbe.kt | 建屏 flags 探针（本地位值常量，不引用 @hide 常量；金丝雀/无泄漏断言） | 调试验收（device probe） |
| BackGate.kt | 返回网关决策器（页内层栈可用性 → 消费/退出）+ `BackGateBridge`（setAvailable/getBackAvailable 2 个 @JavascriptInterface） | MainActivity（OnBackPressedCallback 接线） |

### 5.1 0.14.3 依赖与线程边界

维护实现与限制的唯一详述见 [Root维护](<dsh-mobile-apk/docs/AGENTS/ROOT-MAINTENANCE.md>)：RootGrant策略不向固定helper暴露任意shell；RootMaintenanceLease先持久化再UID0派发；RootOwnershipJobs共享worker不归某Activity/Service caller所有。ProcIo/ShizukuCaptureIo的本地有界返回与远端确定完成是两件事，不完整capture不发布ready spool。

浏览器UI私有复用官方MIT BrowserBody/Title/controller契约，官方Sidebar指南/标签框架通过注册消费，不拷Electron/Iframe后端。NativeBrowserSession把GUI occurrence绑定native tab，自定义菜单使用真实sidebar.right.tab.menu.item扩展点；HMR/unmount hide而非销毁AI页。BrowserHostProfile按Session隔离cookie/storage/worker，UI geometry focus不替代模型captured Session/tab。Windows UA字符串、JS platform与UA-CH均按目标identity选择；是否实际生效依赖provider能力并在回执如实标注，未设备验证。

### 5.2 0.15 Linux 环境（Bionilux + Debian）的依赖链与失败边界

页面 → 宿主 → bootstrap → runtime 的单向依赖，每一层各自校验，下一层从不把上一层的成功当可用性依据：

LinuxEnvironmentSection / transport.ts        （ui-responsive，settings.section 唯一注册方）
  ├─ GET  /api/android/linux-environment/status|manifest
  ├─ POST /api/android/linux-environment/check|install|reinstall|uninstall|auto-update-on|off
  └─ window.androidBridge.linuxAssetPrepare / linuxAssetPrepareStatus
        └─ LinuxAssetPrepare → LinuxAssetIO.download/debugMappedUrl → LinuxAssetExtractor.extract
              └─ <DSH_FILES_DIR>/linux-environment/staging/<sha256>/{asset.tar.xz,unpacked/}

dsh-android-linux-env.apply(ctx)              （宿主 Cordis 插件，随 profile 装配）
  ├─ provide('linuxPluginHost')               ← install/uninstall/isInjected；父 apply() 返回后才可信
  ├─ mountLinuxBootstrap(ctx, config)         ← 故意 void，非阻塞
  │     └─ dsh-linux-bootstrap.apply(ctx, config)
  │           ├─ inject=['linuxPluginHost']
  │           └─ provide('linuxBootstrap')     ← status/check/install/…
  └─ serviceOf(ctx,'linuxBootstrap')          ← 路由每请求现取；缺席即 503


启动期有三个独立的失败点，不能合并成一个“配置缺失”：

1. **Cordis 访问声明**：dsh-linux-bootstrap.apply() 取 ctx.filesDir 或 ctx.get('filesDir')，但它只声明 inject=['linuxPluginHost']。宿主当前改为在配置里显式给出 dataDir，所以正常路径不再依赖未声明的 filesDir 服务；若把 dataDir 拿掉、又寄望 ctx.filesDir 自动可见，bootstrap 会在 apply() 抛出 dataDir or ctx.filesDir is required，fiber 不进入 ACTIVE。新的装载器即使收窄了访问面，也不会替调用方补 dataDir。
2. **父级挂载顺序**：linuxPluginHost 由父作用域在 apply() 内 provide，而子插件按注入等待它。父 apply() 末尾若 await mountLinuxBootstrap(...)，父 fiber 要等子 fiber 落定，子 fiber 又要等父作用域的服务就绪，形成互相等待；现实现用 void mountLinuxBootstrap(...).catch(warn) 断开这条等待，父 fiber 先落定，子 fiber 随后启动。失败只记一行 warn，linuxBootstrap 缺席由路由的 503 如实暴露。
3. **ACTIVE 判定本身也有等待面**：装载器 await fiber 之后检查 fiber.state === FiberState.ACTIVE；linuxPluginHost.install 则等待 activated.ready（fiber 可等待性）再做 ACTIVE 检查。这里不能用调用瞬间的状态快照：Cordis fiber 异步激活，快照会读到 PENDING，导致“实际成功却报激活失败”。

runtime 激活还有一层**工具面**判据：linuxRuntimeManager.status().healthy 为真时才注册 linux_bash / linux_session，而 fiber ACTIVE 只证明插件体加载成功，不证明工具已登记。旧 runtime 的 schema 把 required: true 写在字段内部，clock 这类真实 ToolRuntime 校验会拒绝；syncTool 又吞掉了注册异常，于是状态仍报 healthy、Agent 却一个 Linux 工具都看不到。修法是标准 JSON schema（对象级 type、required 数组、additionalProperties）、注册失败即抛并回滚已注册的部分，并用真实 rc3 ToolRuntime 的注册 + execute 用例固定这条链路。

**首次 manifest 为空**：GET /manifest 只读持久状态；从未 check 过时 readLinuxManifest 返回 null。页面此时先 POST /check（只报告可用版本，不安装）再重读 manifest；/manifest 返回 404/405 的旧宿主则直接回退单次 check。只有重读仍为空才报“宿主没有发布清单”。

**四类 native assets**：安装前页面按顺序准备 plugins.runtime（kind=plugin）与所选 runtime 的 backendAsset、rootfsAsset、nodeAsset（kind=backend/rootfs/node）。宿主按摘要推导落点、流式下载、逐跳复核来源、验摘要与字节数，再按 kind 解包并原子发布；bootstrap 只消费宿主已暂存的归档与树，自行重算摘要/体量、重算 unpackedSize、校验包名与入口后才激活。stagingDirectory 与宿主暂存目录必须分开，避免 bootstrap 的包槽位替换删掉复验源。

**Debug loopback 仅用于 debug 回放**：生产构建不读取 debug-download-origin，官方 URL 只按正式白名单校验；DSH_DEBUG_BUILD=1 时若文件存在，只接受 http://127.0.0.1:<port>/，并只替换官方 URL 的 origin。这样测试服务器可以按正式 Releases 路径供字节，HTTP 与任意局域网地址仍失败关闭，响应 url 保留官方身份供清单来源复核。

**恢复工具与恢复边界**：冷启动先 restoreActivation() 再 synchronizeInjectionState()，否则“宿主尚未加载 runtime”会被误读成用户移除并清掉启用记录。恢复只针对持久 enabled && injectionActivated、仍在插件根内且入口文件在场的安装；它是一个已校验目录的 Cordis 重新激活，不下载、不复活用户手工删除的目录。status() 读 active.json，healthy:false 会把恢复标成不健康；ACTIVE 本身仍不等于工具可用。isInjected 只读目录，不创建、不修复。 本轮完整根因、四类资产与设备重验状态见 [Linux 环境接入收口](<docs/contrib/codex/linux-mumu-integration-2026-11-05.md>)。
## 6. assets/ 结构（app/src/main/assets/）

| 资产 | 作用 | 消费方 |
|---|---|---|
| snapshot.tar.xz | 内嵌 Termux 运行时快照（usr/ + home/；引擎版本以构建输入为准） | SnapshotExtractor（首启解压到 filesDir） |
| snapshot.sha256 | 快照指纹（随 ABI/批次变化，现数用 `check-snapshot-fingerprint` 对账） | EngineManager 读取；与 filesDir/.snapshot-fingerprint 比对——指纹翻转触发事务化全量重解压，`snapshotRefreshing` 闸门在刷新期禁止拉引擎 |
| plugin-hard-manifest.json | 最终注入 snapshot 的精确 Hard `{id,name}` 清单，schema 2 含 profile 来源子集与 `factoryBundles: [{name,version,patchSha256}]` 并绑定归档 SHA-256；字段缺席表示旧资产无法证明 bundle ownership，`[]` 表示可信空选择 | `build-hard-manifest.mjs` 从 final tar 的 web profile bundle 顺序及 app-boot install-first/profile-second 解析位置生成；patch SHA-256 使用 `DSHBNDL1` + 按声明顺序的 UTF-8 路径/长度帧/实际 bytes。online sidecar 仅由 verified stage 与当前 APK可信选择名重算身份，不继承 live HOME/旧 sidecar；marker/.online-snapshot 双 fingerprint 选中；SWAPPING 或缺失/错版时归属动作不执行 |
| patched/ | 运行时补丁（文件清单与大小见 RUNTIME-PATCHES.md） | EngineManager.applyRuntimePatches()（内容指纹判定，目标包缺席跳过） |
| console.html | 控制台终端 UI（consoleBridge 页面侧） | ConsoleActivity 加载 |
| undo-emergency.mjs | undo 急救 CLI（list/restore/safe-mode，独立于引擎可运行） | EngineManager.deployUndoCli → UndoGate.execute 调用 |
| Safe Mode / PluginMounts | Exact `{id,name}` identity bound to APK snapshot or transaction-authorized online archive; automatic failure quarantine preserves original insert/config and atomically appends a marked Cordis `disabled: true`. Soft Candidate promotes only across two distinct engine spawns with authenticated inventory, Hard identity presence, enabled preset fibers, session and modelCatalog evidence. | SafeMode / PluginMounts → Safe Console or UndoGate → existing engine restart |
| licenses/ | GPL 全文四件 + THIRD_PARTY_NOTICES.md（第三方合规随包分发） | 门禁 check-third-party.mjs 校验其来源 |

## 7. manifest 组件（app/src/main/AndroidManifest.xml）

| 组件 | 类型 | 源文件 | 要点 |
|---|---|---|---|
| .MainActivity | activity（exported，LAUNCHER + VIEW/SEND intent-filter） | MainActivity.kt | configChanges 四向 + adjustResize |
| .ConsoleActivity | activity（exported=false） | ConsoleActivity.kt | 引擎未运行也可用 |
| .OverlayAttachProxyActivity | activity（exported=false） | [OverlayAttachProxyActivity.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt>) | 透明无界面；excludeFromRecents/taskAffinity空，不设noHistory以等待ActivityResult；绑定target/request并等draft-ready后退出；旋转/取消/超时需设备验 |
| .EngineService | service（foregroundServiceType=dataSync） | EngineService.kt | 保活+看门狗宿主 |
| .AdbKeyboardService | service（BIND_INPUT_METHOD，exported=true） | AdbKeyboardService.kt | @xml/input_method 注册 IME |
| .DeviceControlService | service（BIND_ACCESSIBILITY_SERVICE，exported=true） | DeviceControlService.kt | @xml/accessibility_service_config 能力声明 |
| .OverlayService | service（exported=false） | OverlayService.kt | SYSTEM_ALERT_WINDOW 悬浮球 |
| .AdbKeyboardReceiver | receiver（exported=true，ADB_INPUT_TEXT/ADB_CLEAR_TEXT） | AdbKeyboardReceiver.kt | 只收点名组件/点名包的广播（隐式广播在 targetSdk 26+ 收不到）；纯隐式协议走 IME 运行期注册的同款接收器 |
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

### 移动端覆盖层内的双工作区

响应式插件保持上游 DockLayout 的稳定 TabHost 与原生 row 状态，不重建或迁移正文祖先。`mobile-workspaces.ts` 封装当前固定引擎版本的 adopted Session store 适配点；所有布局写入调用原生 actions，适配面缺席时拒绝动作。竖屏网格呈上下、横屏呈左右；paneId 绑定标题与焦点，交换只改变整个工作区的物理位置。移动端通过 layout.openRightbar(false, fullscreen) 报告覆盖呈现，主对话不预留右侧轨道。

渲染能力逐类型登记。原生 BrowserHost 仍是单 stage，禁止两个浏览器同时进入通用分屏；虚拟屏保留专用 viewer/设备生命周期。会话、子代理、终端开启已有 keepMounted 策略，浏览器保留既有策略。详细交互和验收见 `dsh-client-ui-responsive/docs/mobile-multitask-spec.md`。
