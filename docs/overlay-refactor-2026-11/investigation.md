# DeepCode Android 悬浮交互系统重构 — 现状调查（investigation）

> 阶段：Phase 1（只调查与规划）。本文件是**现状与证据**，不含实现方案；方案见 `design.md`，施工见 `implementation-plan.md`，验收见 `test-plan.md`。
> 代码基线：`origin/main` = `5f533907`（本地 `git fetch` 后确认；所有行号以该提交为准）。调查在独立 worktree `_dsh-wt/ovl-phase1` 进行，未改任何产品代码。
> 需求原文由委托方在会话中给出；本文件第 4.2 节把它拆成 R1-R14 逐条对照现状（原文未落盘，故不引用文件路径）。
> 行号漂移提醒：施工前请按第 6 节命令重新定位，不要直接相信行号。

## 0. 一页结论（跨三份调查的裁决）

| # | 结论 | 影响 |
|---|---|---|
| 1 | **悬浮层完全不过 WebView 桥取数**：它直连三条通道——`$events` WS（`MuxClient`）、`.live.ndjson` 文件 tail、`POST /api/session/*` RPC。桥面上与会话/工作区相关的方法为 0。 | 新卡片/药丸/输入区必须继续用这三条通道；不要设计「经 WebView 转发」的数据路径 |
| 2 | 现有窗口结构是「常态 3 窗 + 懒建窗」，全仓 **8 处 `wm.addView` / 6 类窗口**；z 序 = addView 顺序，光环必须先于球；隐藏态**只能 removeView**（alpha/GONE 会留隐形触区）。 | 新窗口必须遵守「窗口矩形 = 可视命中区」；z 序表与收口纪律见 design 第 3 节 |
| 3 | 现面板**没有事件列表、没有 ScrollView、没有刷新节流器**：内容超高只把 y 夹进屏内（代码推断，未设备验证）；`MotionCoalescer` 只服务浏览器渲染进程，与悬浮层无关。 | 顶部卡片是**新建**，不是改造；必须自带滚动、上限与合并渲染 |
| 4 | 目标里的「单行思考摘要」**当前无数据源**：插件投影明确排除 reasoning 块（`TextBlock`/`ReasoningBlock` 共用 `text` 字段；该判断来自插件注释 `plugins/dsh-android-bridge/src/index.ts:2181-2182` 的转述，上游类型未独立核对），live 流只有 `tool_call/tool_result/text/turn_end/title`。 | 需插件新增 `k=think` 行（design 5.3 / N1）；实时性上限待验证（V2） |
| 5 | 「＋」命令抽屉的真源已定位：上游 `ui-input-trigger` 命令目录；现有 `composer-sheet.ts` 靠读上游菜单 DOM 逐项复制，执行走 `POST /api/commands/execute`；仓内**无硬编码命令表**。 | 原生层必须复用同一真源（design 6.4），否则必然出现第二份清单 |
| 6 | **会话身份存在已登记缺陷**：`api-session/status` 的 agentId 被写进 `activeSessionId`；页面 `<html data-dsh-session-id>` 才是权威。工作区**没有任何列表/切换接口**。 | 新 UI 第一件事是切清 id 域 + 建立页面宿主 API（design 6.3） |
| 7 | 壳侧有**两套并行色板**：`ds_*`（启动页/设置页，Apple 式黑白）与 OverlayTheme（面板蓝 #4176E6）。需求要求复用启动页视觉，故新 UI 全走 `ds_*`。 | 直接决定 design 7.2；避免第三套配色 |
| 8 | 模糊唯一正路是 `LayoutParams.setBlurBehindRadius` + `FLAG_BLUR_BEHIND`（API 31+，本机 SDK `api-versions.xml` 取证）；`RenderEffect` 也是 31+ 且**采不到别的窗口**；26-30 只能降级。 | 视觉主方案必须是半透明，不做真模糊（design 7.5） |
| 9 | **仓库内没有帧级性能基线**：`app/src` 全树 `FrameMetrics|JankStats|Choreographer|Trace.beginSection` 命中 0，`dumpsys gfxinfo` 从未被脚本用于采集；既有基线都在启动链与注入层 JS。 | 性能指标全部是 Phase 2 首测项；现成采集器只有 `scripts/perf/measure-steady.ps1` 与 `scripts/verify-frame-timing.mjs`（test-plan P 系列） |
| 10 | 悬浮层相关测试 **12 类 119 例**，另有 `CallSiteContractTest` 源码契约；Kotlin 测试基线 2257 例/216 类，但 BackKey/PickerTeardown 共 8 例未入基线（基线日期早于测试新增）。 | 重构必须同步刷新测试基线（只许升），并保留源码契约式反证 |
| 11 | 角色分工现状清晰：**Kotlin 壳**负责全部窗口/手势/绘制/生命周期；**Node 引擎 + 插件**负责事件与命令；**WebView 页面**持有会话/工作区/命令真源；**Rust** 与本系统无交集。 | 选型沿用该分工（design 2），不为「技术栈统一」重写 |
| 12 | 多条历史硬约束与新需求直接相关：球 34dp 低于仓内 44dp 触摸下限；光环尺寸恒等式；面板宽度单一真源；`frameConsumer` 是恒 0px 死通道；`addView` 失败被静默吞掉。 | 逐条列在第 1.9 节，施工前必读 |

---

## 1. Kotlin 悬浮层现状

### 1.0 调查基线与口径

- 权威代码：独立 worktree D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\ovl-phase1，HEAD = 5f533907（Merge pull request #1716），git status 干净（空输出）。以下所有路径均为该 worktree 的仓库相对路径。
- 行数口径统一用 (Get-Content <file>).Count（含空行）。注意：Measure-Object -Line 会少计空行（同一文件会得到 996 与 1069 两个值），本报告一律用前者口径。
- 本报告是**只读调查**：未修改任何产品代码/配置/测试，未 git add/commit/push，未打包、未跑设备命令。
- 新需求文档目录 docs/overlay-refactor-2026-11/ 当前为空（Get-ChildItem -Force 计数 0；glob 无命中），docs 下也 grep 不到「悬浮交互 / overlay 重构 / Phase 1」。因此**本文件的「与新需求冲突」只能写成对新重构的硬约束继承清单，无法逐条对照需求文档**（未确认：新需求原文未在本 worktree 落盘）。
- 文档失真登记（施工前先读这段，避免按文档改错文件）：
  - docs/AGENTS/modules.md:60 写作 **OverlayBackKey.kt**，实际文件是 app/src/main/java/com/dsharnessmobile/shell/OverlayPanelBackKey.kt，其中类名是 BackKeyPanelLayout。
  - docs/AGENTS/ARCHITECTURE.md:32-45 的「悬浮球」表**没有收录** OverlayPanelBackKey.kt（也没有 ShimmerTextView 以外的动效协作面说明）。
  - 多处源码注释引用的「详档 docs/0.14.1-preview-OVERLAY-COMPLETION-CARD.md」不在本仓（glob docs 无此文件），只有 docs/0.14.9-preview-OVERLAY-BALL-HIDE.md 在仓。相关「详档 §x.y」的结论无法在本仓核对（未确认：详档缺席）。
  - docs/AGENTS/EXECUTION-MAP.md:297-299 自己登记了行数漂移（该表数字已过期），本报告行数一律现场数。

### 1.1 模块清单（行数 / 职责 / 关键公开符号）

| 文件（app/src/main/java/com/dsharnessmobile/shell/） | 行数 | 职责 | 关键公开/internal 符号（行号） |
|---|---|---|---|
| OverlayService.kt | 1069 | 悬浮球服务：生命周期、常态三窗口 + 隐藏态第四窗（+ picker/report 两个懒建窗口）的 WindowManager 参数、拖动与四向钳制、隐藏/召回、探活与发送/停止编排、完成位/报告栏收口 | class OverlayService:52；onCreate:187；onStartCommand:211；onTaskRemoved:223；onDestroy:228；buildRoot:251；showPanel:352；hidePanel:408；hideBall:448；recallBall:469；attachBallTouch:489；clampBallPos:543；panelWindowWidth:347；positionPanel:392；applyAgentStatus:608；probeEngine:663；postRpc:705；requestStop:748；requestSend:762；flashStatus:878；jumpToApp:912；emitFrame:961；replayFrame:969；instance:995；frameConsumer:1003；BALL_EDGE_MARGIN_DP:986；顶层纯函数 payloadSessionId:1023 / failureBackfillPlan:1051 |
| OverlayPanel.kt | 1673 | 展开面板视图构建与渲染、状态行手势、待答卡（审批/提问）、MuxClient 消费与应答、会话选择器独立窗口、双语/换肤/动效落点 | buildUnit:217；applyThemeColors:441；attachStatusGesture:520；renderPendingCard:736；animationsOn:626；animateCardIn:629；animateTextColor:640；setStatusText:655；setAmberBreathing:718；postEventResult:1023；respondApproval:1062；respondQuestion:1088；dismissQuestion:1125；dropPendingFor:1154；hasDraft:1168；updateBallOnly:1171；updateClock:1239；refreshSessionPicker:1250；applyLanguage:1337；openPickerWindow:1391；closePicker:1385；fillPickerRows:1484；PendingApproval:1531；PendingQuestion:1534；inputHintFor:1551；pagerIndex:1640；approvalArmed:1667 |
| OverlayReport.kt | 691 | 报告栏独立顶层窗口（底部抽屉 + 拖拽手柄）+ 完成位状态机 CompletionNotice + 手势裁决/文案纯函数 | buildReportBar:52；showReport:240；hideReport:310；toggleReport:46；attachDragGesture:204；reportBodyText:338；reportBarInitialHeight:419；reportBarHeightAfterDrag:433；reportLines:458；turnEndLabel:545；CompletionNotice:576；MIN_TOUCH_TARGET_DP:503；nextTapCount:513；tripleTapWindowMs:526；statusUpAction:534 |
| OverlayHalo.kt | 244 | 光环维度：glow+ring 两层 LayerDrawable、四态 setHalo、光环窗与球窗同心、状态派生唯一权威 | syncHalo:72；newHaloDrawable:86；setHaloColors:109；setHalo:141；refreshTheme:197；deriveHalo:202；Halo 枚举:222；haloColorsFor:243 |
| OverlayLiveFeed.kt | 219 | live 流消费：FileObserver 监听 home/.dsh/.live.ndjson，按字节偏移 drain；tool_call/tool_result/turn_end 分发；android_* 自动化避让；debug 合成 pending 注入 | startWatcher:28；drainLive:67；toolSummaryOf:201；LIVE_READ_CAP_BYTES:15 |
| OverlayRecall.kt | 198 | 隐藏态召回条：懒建第 4 个窗口（8x44dp）、贴边与召回落点纯函数 | show:49；hide:85；reposition:109；refreshTheme:124；ballPlacementForRecall:96；recallStripPlacement:155；recallBallPlacement:182；RECALL_STRIP_WIDTH_DP:142；RECALL_STRIP_HEIGHT_DP:143 |
| OverlayController.kt | 159 | 悬浮球开关真源：prefs 持久化 + 服务起停 + SYSTEM_ALERT_WINDOW 引导 + 待启意图结算 | enableWithPermission:53；settlePendingEnable:72；isEnabled:87；setEnabled:91；ensureStarted:107；stop:136；canDrawOverlays:157 |
| OverlayTheme.kt | 72 | 系统明暗判定 + ThemeColors 色板（含 haloIdle/haloIdleFade/recallStrip 按主题分档） | isDarkTheme:9；ThemeColors:14；themeColors:48 |
| OverlayPanelBackKey.kt | 54 | 面板返回键：纯函数 consumePanelBack + BackKeyPanelLayout 在窗口根 dispatchKeyEvent 拦截 | consumePanelBack:22；BackKeyPanelLayout:41；dispatchKeyEvent:46；dispatchPanelKey:53 |
| MotionCoalescer.kt | 133 | （**不属于悬浮层**）触摸事件流合帧器：MOVE 覆盖、DOWN/UP/CANCEL 保序、容量 64；TabMotionQueues 按 tab 隔离 | MotionCoalescer:16；offer:45；drain:64；TabMotionQueues:97 |
| ShimmerTextView.kt | 126 | Deep diving 扫光 TextView（LinearGradient Shader + 1.8s 循环；reduced-motion 降级静态） | setShimmering:41；startShimmer:69；applyShimmerState:115 |
| SplashOverlay.kt | 206 | （**不属于悬浮层**）Activity 内开屏视频 TextureView + MediaPlayer | play:37；dismiss:83；pause:107；resume:114 |
| DsUi.kt | 241 | 原生壳共享 UI 原语：动效总开关 + 订阅、roundRect/oval/ripple、bindPressScale | animationsEnabled:31；animationsEnabledFrom:44；registerMotionListener:74；roundRect:143；ripple:159；bindPressScale:230 |
| UiText.kt | 28 | 双语选词入口 | isEnglish:15；t:18；t(english,...):27 |

相邻但不在悬浮层内的数据/协议协作类（复用时要一起看）：
- MuxClient.kt：手写 WebSocket，/api/remote.mux；悬浮层经 OverlayPanel.startMux:103 构造（末尾 lambda 绑定最后一个形参 streamId 的坑见 OverlayPanel.kt:104-107）。
- NotifyStore.kt / NotifyCenter.kt：报告栏内容来源 NotifyStore.latestReportLine()（OverlayReport.kt:321-325）；NotifyCenter 反向调用 OverlayService.flashStatus（NotifyCenter.kt:208）。
- EngineProbe / EngineEndpoint / EngineAuth：探活与 RPC 鉴权（OverlayService.kt:663-691、705-745）。

### 1.2 窗口层（OverlayService 里每个 WindowManager.addView）

共 **8 处 wm.addView 调用、6 个窗口类型**（其中 OverlayService.kt:480-481 是隐藏召回时对已有光环/球窗的重新 add，不新增窗口类型）：

| # | 窗口 | addView 行 | 尺寸 | 坐标策略 | TYPE | FLAGS | 触摸区 / 可视区 | z 序 |
|---|---|---|---|---|---|---|---|---|
| 1 | 光环 haloView | OverlayService.kt:322 | haloSizeDp = ballSizeDp + 2*edgeMarginPx = 34 + 16 = 50dp（OverlayService.kt:83） | syncHalo 使光环窗中心 = 球窗中心：x = ball.x + ball/2 - halo/2（OverlayHalo.kt:72-78） | TYPE_APPLICATION_OVERLAY | FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCHABLE（OverlayService.kt:308-321） | 纯视觉：NOT_TOUCHABLE，触摸全部穿透到下层；窗口 50dp 但可见光晕半径 24dp（OverlayHalo.kt:35） | **先 add**，在同 TYPE 下位于球之下（同 TYPE 按 add 顺序，后加者在上） |
| 2 | 球窗 rootView | OverlayService.kt:324 | 34dp x 34dp（ballSizeDp，OverlayService.kt:70，by lazy） | 初始 x = 屏宽 - 球 - 12dp，y = 屏高/3（OverlayService.kt:292-293）；拖动 + clampBallPos | TYPE_APPLICATION_OVERLAY | FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCH_MODAL + PixelFormat.TRANSLUCENT + SOFT_INPUT_ADJUST_NOTHING（OverlayService.kt:282-294） | **窗口 = 球 = 触摸命中区**（无空白吞区）；34dp < 44dp 触摸下限（见 1.9） | 后于光环 add，位于光环之上 |
| 3 | 面板 unitView | OverlayService.kt:382（懒建：unitView==null 时 buildUnit，showPanel:355-356） | 宽 = panelWindowWidth() = min(屏宽 - 34dp - 64dp, 400dp)（OverlayService.kt:347-350）；高 = WRAP_CONTENT | gravity TOP or START；positionPanel：优先球右侧（gap 4dp），放不下翻到左侧；y 夹进 [gap, 屏高-高-gap]（OverlayService.kt:392-406） | TYPE_APPLICATION_OVERLAY | FLAG_NOT_TOUCH_MODAL（可聚焦，弹输入法）+ SOFT_INPUT_ADJUST_PAN（OverlayService.kt:367-377） | 面板矩形内可触摸，矩形外穿透（NOT_TOUCH_MODAL）；可聚焦 → 有 IME | add 在球之后，位于球/光环之上；收起时 removeView（OverlayService.kt:424-428） |
| 4 | 会话选择器 pickerWindow | OverlayPanel.kt:1476（懒建 openPickerWindow:1391） | 宽 = 触发行的 width，未布局时 300dp；高 = min(内容测量高, 屏高*45%)（OverlayPanel.kt:1444-1460） | 触发 sessionPicker 行下方 4dp，x/y 均钳制在屏内（OverlayPanel.kt:1466-1468） | TYPE_APPLICATION_OVERLAY | FLAG_NOT_TOUCH_MODAL or FLAG_WATCH_OUTSIDE_TOUCH（OverlayPanel.kt:1447-1450） | 独立窗口，点栏外（ACTION_OUTSIDE）关闭（OverlayPanel.kt:1469-1472） | add 时最后出现，位于面板之上 |
| 5 | 报告栏 window | OverlayReport.kt:292（懒建 showReport:240） | 宽 = min(屏宽-32dp, 440dp)，下限 200dp；高 = reportBarInitialHeight(自然高, minH=140dp, compactCap)；拖拽夹在 [minH, expandCeil]（OverlayReport.kt:254-285、388-437） | gravity BOTTOM or START，x 居中，y=0（OverlayReport.kt:280-284） | TYPE_APPLICATION_OVERLAY | FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCH_MODAL or FLAG_WATCH_OUTSIDE_TOUCH（OverlayReport.kt:276-279） | 点栏外即关（ACTION_OUTSIDE，:287-290）；不抢输入法焦点（S2-5 注释 :273-275） | add 时最后出现 |
| 6 | 召回条 stripView | OverlayRecall.kt:81（懒建，仅隐藏态） | 8dp x 44dp（RECALL_STRIP_WIDTH_DP/ HEIGHT_DP，OverlayRecall.kt:142-143） | recallStripPlacement：球心左半屏 x=0，否则 x=屏宽-条宽；y 与球心对齐后夹进屏内（OverlayRecall.kt:155-169） | TYPE_APPLICATION_OVERLAY | FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCH_MODAL（OverlayRecall.kt:65-78） | **窗口尺寸 = 可视尺寸**，命中区就是看得见的那一条（类注释 :22-23） | 隐藏态才 add，正常态不在窗口表 |

z 序纪律（F8，硬约束，源码明文）：
- 同 TYPE_APPLICATION_OVERLAY 窗口的 z 序 = addView 顺序，后加者在上；**光环必须先于球 addView**，否则辉光整窗盖住球面（真机实测「不是一圈氛围光而是整个球变红」）。出处：OverlayService.kt:300-305、OverlayHalo.kt:11-12、docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:38-39。
- 状态切换只走 setHalo()/syncHalo()（换 drawable / updateViewLayout），**不改 z 序**；三窗口生命周期内禁止 remove/re-add 重排。
- 唯一例外 = 隐藏/召回这一对：hideBall 移除球+光环（OverlayService.kt:453-454），recallBall **按先光环后球**重新 add（OverlayService.kt:480-481）；顺序被写死在一个函数里，并由 CallSiteContractTest.recallReAddsTheHaloBeforeTheBallToKeepZOrder 钉住（app/src/test/java/com/dsharnessmobile/shell/CallSiteContractTest.kt:554-562）。

触摸区与可视区的历史教训（必须继承）：
- 0.13.2「互吞」根因：光环与球曾放在同一个大矩形窗口，球周约 2940dp² 空白 + 四角看不见却照吃触摸（docs/AGENTS/gotchas.md:2469-2470）。修法 = 双窗口 + 光环 NOT_TOUCHABLE，触摸命中区 = 球窗（OverlayService.kt:60-63）。
- 「看不见 ≠ 不在」：alpha=0 / visibility=GONE 只不绘制，窗口命中矩形仍吃触摸；唯一正确的隐藏是 removeView（gotchas.md:2471-2472；docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:26-36）。
- 光环窗尺寸 50dp 的定量推导：= 2*(贴边 margin 8dp + 球半径 17dp)，贴边时窗口恰好内切屏幕；旧 64dp 窗贴边越界 7dp 被 WMS 整窗平移回屏（dumpsys 请求 x=-14 → frame x=0），产生「吸边后球/光环不同心」（OverlayService.kt:80-83；OverlayHaloInvariantTest 锁死恒等式）。
- 位置策略：positionPanel 右溢出翻左侧；面板宽度必须是函数 panelWindowWidth()（转屏无人重建 Activity，见 gotchas.md:1097-1112）；pick/rpt 的 x/y 必须钳制在屏内（OverlayPanel.kt:1461-1468、S2-8）。

### 1.3 悬浮球

- 绘制方式：**纯代码构建，无 XML 布局**。LinearLayout(VERTICAL, CENTER) + GradientDrawable(OVAL, Color.WHITE) 作白球底，内放 ImageView(ic_launcher_foreground)，用 Matrix 按内容 bbox (102,130)-(328,300) 裁剪并缩放到 26x20dp（OverlayService.kt:256-278）。
- 形状/尺寸/命中区：圆形白球 34dp（ballSizeDp:70）；窗口 = 球尺寸，整窗即可触摸（:280-281）；全仓 MIN_TOUCH_TARGET_DP=44（OverlayReport.kt:503）但 **OverlayService.kt 里 0 处引用**，即当前球低于仓内触摸下限口径（见 1.9 冲突项）。
- 拖动实现 attachBallTouch（OverlayService.kt:489-536）：
  - ACTION_DOWN：记 rawX/rawY 与窗口起点 startX/startY，moved=false。
  - ACTION_MOVE：位移超 scaledTouchSlop 即 moved=true；此后每帧 p.x/p.y = start + delta，clampBallPos，wm.updateViewLayout(v.parent)，syncHalo()，positionPanel()（光环与面板逐帧跟随）。
  - ACTION_UP：未 moved → **togglePanel()**（唯一的单击语义）；已 moved → 按手指最终位置落位并 clamp，随后 emitFrame()。
  - ACTION_CANCEL：只重置 moved。
  - 无贴边吸附：0.14.1 块I 起删除 spring 吸附，松手停在手指位置（OverlayService.kt:36-37、527-528）。
- 贴边钳制 clampBallPos（OverlayService.kt:543-551）：x 夹 [margin, 屏宽-winW-margin]，y 夹 [margin, 屏高-winH-margin]；margin = edgeMarginPx = 8dp（:79）；winW/winH 取 p.width/p.height，保留窗口变大时的鲁棒性。
- 手势绑定全量（**双击不存在**；grep setOnLongClickListener / GestureDetector 在 OverlayService/OverlayRecall 零命中）：

| 控件 | 单击 | 双击 | 长按 | 滑动 |
|---|---|---|---|---|
| 悬浮球 | togglePanel（展开/收起面板） | 无绑定 | 无绑定 | 拖动球（被球窗消费） |
| 面板状态行 statusText | 无（仅触摸状态机） | 无 | 长按 → toggleReportBar（开/关报告栏） | 超 touchSlop 即取消长按/三击 |
| 面板状态行 | 三击（累计 3 次 UP）→ jumpToApp | — | — | 同上 |
| 面板顶行「隐藏」 | hideBall | 无 | 无 | 无 |
| 面板顶行 ✕ | hidePanel | 无 | 无 | 无 |
| 召回条 | recallBall | 无 | 无 | 无 |
| 报告栏手柄行 | 无 | 无 | 无 | 上下拖动改栏高（OverlayReport.kt:204-234） |
| 会话选择器 | 每行单击即选目标并关窗（OverlayPanel.kt:1497-1516） | 无 | 无 | 列表可滚 |

- 隐藏与召回：
  - hideBall（OverlayService.kt:448-457）：hidePanel() → hidden=true → removeWindow(rootView) + removeWindow(haloView) → recall.show(球的 x/y, ballSizeDp) → emitFrame。服务不停，探活/Mux/live 流继续跑（:443-445）。
  - recallBall（OverlayService.kt:469-485）：hidden=false → recall.ballPlacementForRecall（纯函数，与 clampBallPos 同边界）→ recall.hide() → 先 add 光环、后 add 球 → syncHalo + setHalo(deriveHalo) → emitFrame。
  - 隐藏态**刻意不落盘**（无 prefs 键，OverlayService.kt:113-120；CallSiteContractTest J-A5 反向契约），服务重启即回位。
  - 召回条：OverlayRecall 懒建，8x44dp 半透明药丸（圆角 = 半宽，OverlayRecall.kt:129-133），底色唯一来源 ThemeColors.recallStrip，contentDescription「唤回悬浮球」，点它 = recallBall（OverlayRecall.kt:57-63）。

### 1.4 面板

视图树（buildUnit，OverlayPanel.kt:217-438）：

    BackKeyPanelLayout(vertical, 圆角 30dp, 背景 unitBg + 1dp unitStroke)     :421-435
    ├─ pickerRow (horizontal)                                                :329-336
    │   ├─ sessionPicker TextView (weight=1, 44dp 高, ripple)                :226-245
    │   ├─ hideEntry TextView「隐藏」(44x44dp, chevron 色)                   :310-323
    │   └─ close FrameLayout(44dp 命中区) > ImageView dsh_ic_close(20dp)     :289-299
    ├─ row1 (horizontal)                                                     :360-368
    │   ├─ statusText ShimmerTextView (weight=1, minHeight 44dp)             :247-259
    │   ├─ reportEntry「查看汇报」(44dp 热区)                                 :344-358
    │   ├─ toolChip「工具 ×N」(默认 GONE)                                    :261-270
    │   └─ clockText (默认 GONE)                                             :272-280
    ├─ divider (1px, c.divider)                                              :430-432
    ├─ pendingBox (vertical, 默认 GONE)                                      :591-596
    └─ row2 (horizontal)                                                     :412-419
        ├─ inputBox EditText (weight=1, IME_ACTION_SEND)                     :371-387
        ├─ sendBtn(44dp 命中区/36dp 视觉圆)                                  :393-407
        └─ stopBtn(44dp 命中区/36dp 视觉圆)                                  :409

- 展开/收起动画：
  - 展开：unit.alpha 0 → 1，duration 200ms，未指定 interpolator（默认 AccelerateDecelerate）；先 addView 再 unit.post { positionPanel() } 做首帧精确对位（OverlayService.kt:381-385）。
  - 收起：无动画——unit.visibility=GONE 后立即 wm.removeView(unit)，panelParams=null（OverlayService.kt:424-428）。展开/收起不对称。
  - 会话选择器：WMS 原生进场动画 R.style.OverlayPickerAnim → app/src/main/res/anim/picker_enter.xml：duration 220ms、decelerate_quad、alpha 0→1 + translateY -6%→0；退场无 WMS 动画，直接 removeView（overlay 窗口没有 windowExitAnimation，OverlayPanel.kt:1473-1476 注释）。
  - 报告栏：无进场动画（addView 即显示，OverlayReport.kt:291-306）。
- 顶行会话选择行：sessionPicker 显示「＋ 新会话」或「会话名（当前）」（updatePickerRowText:1353-1361）；点击 togglePickerWindow 打开独立窗口（:1381-1383）；列表数据来自 session/list（refreshSessionPicker:1250-1328），按官方可见性过滤（origin=="subagent" 不可见；blank 且非当前不可见），默认只列 8 条 + 「全部会话(N)」入口，失败时页脚红字「读取失败（点此重试）」（:1408-1441）。
- 隐藏入口：面板顶行「隐藏」文字入口（tag overlay-hide-entry，contentDescription「隐藏悬浮球」），点击 svc.hideBall()；与 ✕ 语义不同（✕ 只收面板，隐藏是球离屏）（OverlayPanel.kt:301-323；docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:11-13）。
- 状态行渲染 updateBallOnly（OverlayPanel.kt:1171-1237）分支优先级：待答 question → 待答 approval → sessionBusy（有工具名走 template_tool；否则 template_thinking + 扫光）→ 完成态（completionLabel + completionHint）→ 常态（引擎离线/空闲）；随后刷新 toolChip、clock、stopBtn 真禁用、renderPendingCard。
- 待答卡（renderPendingCard:736-1014）：同一时刻只渲染一条（currentPending:197-203，审批优先）；审批卡 = 工具名 + reason + 「批准一次/确认批准」+「拒绝」，批准需二次确认（首点 arm，10s 窗口，approvalArmed:1667）；提问卡 = header + ✕ + 题干 + 编号选项（折叠默认 6 项，超出给「还有 N 项（点此展开）」）+ ✎ 自定义答案 + ‹1/N› 翻页（钳制不回卷，pagerIndex:1640）+ 跳过/下一题/提交；会话项按 agentId 过滤。
- 事件列表渲染与滚动/溢出：
  - 面板**没有事件列表，也没有 ScrollView**：内容只有会话行、状态行、待答卡、输入行，全部 WRAP_CONTENT 竖直堆叠。
  - 溢出风险：面板窗高 WRAP_CONTENT，positionPanel 只把 y 夹进 [gap, 屏高-高-gap]，若内容高度 > 屏高，y=gap 且底部超出屏幕且无法滚动（OverlayService.kt:404）。当前靠「待答卡单条 + 选项折叠 6 项」控制高度；**未在设备上验证多问长卡是否顶出屏幕**（未确认：未做设备验证）。
  - 真正可滚动的是两个独立窗口：会话选择器（ScrollView，OverlayPanel.kt:1403-1407）和报告栏（ScrollView，OverlayReport.kt:118-125）。
- 实时刷新节流现状：
  - **没有合帧/节流器**。live 事件经 FileObserver → drainLive → 每批 lines 一次 svc.main.post → 逐行同步更新字段 → 末尾 renderPanelOnly() + updateBallOnly()（OverlayLiveFeed.kt:94-179）。面板每次全量走 updateBallOnly 的分支链。
  - 去重只有两处：renderPendingCard 用 renderedCardKey=pendingKey@qPage + visibility + childCount 短路（OverlayPanel.kt:740-743）；setStatusText 在文案未变时直接 return（:655-657）。
  - 运行时钟不是定时器：updateClock 只在 updateBallOnly 内被调用（:1224），刷新节奏 = live 事件 + 探活 10s tick（OverlayService.kt:663-701）。两次事件之间时钟最多滞后约 10s（未在设备上量化，属推断）。
  - **MotionCoalescer 与悬浮层无关**：它只被 BrowserProcessService 使用（BrowserProcessService.kt:94 motionQueues = TabMotionQueues(...)），是浏览器渲染进程触摸转发的合帧器，不是 UI 刷新节流；悬浮层若需节流需新建机制。
- 输入与键盘：inputBox IME_ACTION_SEND → requestSend（OverlayPanel.kt:377-379）；面板窗可聚焦 + ADJUST_PAN，系统原生把面板整体顶到键盘上方，球窗 NOT_FOCUSABLE 且 ADJUST_NOTHING（OverlayService.kt:361-377、289-290）；球窗收不到 IME insets 已实测（OverlayService.kt:327-329）。
- 返回键：面板根容器必须是 BackKeyPanelLayout（OverlayPanel.kt:421），其 dispatchKeyEvent 只拦 KEYCODE_BACK 且只在 ACTION_UP 时 hidePanel，返回 true 表示消费（OverlayPanelBackKey.kt:22-27、41-53）；不用 OnKeyListener 的原因见该类注释（ViewGroup.dispatchKeyEvent 在无子 View 持焦时直接 false）。

### 1.5 事件数据源（谁解析、字段是什么）

| 数据源 | 通道/位置 | 字段 | 解析点 | 进入 UI 的路径 |
|---|---|---|---|---|
| live 流 | FileObserver(MODIFY or CREATE) 监听 filesDir/home/.dsh 目录，文件 .live.ndjson | 每行 JSON：k（"tool_call"/"tool_result"/"turn_end"；turn_start 已退役）、s（会话 id）、name（工具名）、args（工具参数 JSON 串）、ok（布尔）、kind（语义结果，如 completed/error/blocked/aborted/max-tokens/interrupted） | OverlayLiveFeed.drainLive:67-180；按字节偏移推进，只消费到最后一个换行，CAP 256KB（:15、:77-87）；toolSummary 委托顶层 toolSummaryOf（:201-219，24 字符 + 省略号） | 更新 sessionBusy/toolCount/currentToolName/optimisticBusyAt → svc.setHalo(svc.deriveHalo()) → renderPanelOnly/updateBallOnly；android_* 工具调用时若面板展开则自动 hidePanel + Toast 说明（:125-128） |
| debug 合成 pending | 同目录文件 .overlay-test-pending（仅 debuggable 包） | 文本 question / approval / clear | OverlayLiveFeed.startWatcher:35-55 | 直接写入 svc.panel.pendingApprovals / pendingQuestions，再 onPendingChanged |
| Mux WS 流 | MuxClient 连 /api/remote.mux，streamId=dsh-overlay-events（OverlayPanel.startMux:103-108） | item.value.type：ready{clientId}；waterfall{event=approval/request 或 user-questions/request, eventId, agentId, request}；cancel{eventId}；emit{event=api-session/status, args=[agentId,running]}；另 end/error 触发重连 | handleMuxFrame:110-125；handleEventValue:132-194；generation 对账 3s 宽限（:129-149） | 写入 pendingApprovals/pendingQuestions（PendingApproval:1531 / PendingQuestion:1534）→ onPendingChanged → updateBallOnly；emit 转 svc.applyAgentStatus（:183-190） |
| HTTP RPC | POST /api/<method>，信封 {type:client-request, rpcId, method, payload:{args}}，EngineAuth cookie + 401 重试一次 | method = session/list、session/create、session/prompt（requestId 幂等键/sessionId/mode steer|queue/content）、session/cancel | OverlayService.postRpc:705-745；extractSessionId:861-872；failureBackfillPlan:1051 | 选择器列表、发送/停止、状态行 flashStatus |
| 引擎探活 | EngineProbe.check() 后台线程，每 10s 一次 | running:boolean | OverlayService.probeEngine:663-691、scheduleProbe:694-701 | engineRunning → deriveHalo + 展开态文案；乐观忙 45s 超时回退（:570-576） |
| 报告 | NotifyStore.latestReportLine() → NotifyStore.parseEntry | NotifyEntry（outcomeLabel/outcome/summary/body/text/durationLabel/toolCount/presentedFiles 等） | OverlayReport.latestEntry:321-325；reportLines:458-474；reportBodyText:338-344 | 长按状态行或点「查看汇报」→ report.toggleReport |
| 页面向 WebView 注入 | frameConsumer（MainActivity 注册） | JS 片段（当前恒 padding 0px） | OverlayService.emitFrame:961-966 / replayFrame:969-973；MainActivity.kt:960-967、1147、1506 | 球拖动/开合面板/onDestroy/onPageFinished 时注入，避免页面被挤开（0.13.2 起不再注入实际避让量） |

补充：engine 维（engineRunning，应用级）与会话维（sessionBusy/toolCount，对话级）双维解耦；applyAgentStatus 里未钉住时自动跟随 running 的 agentId（OverlayService.kt:609-616），但 **agentId 与 sessionId 的 id 域混用**是已登记缺陷（EXECUTION-MAP.md:292；OverlayService.kt:473/611 与 OverlayPanel.kt 的 A-R5 口径冲突），重构时必须先切清。

### 1.6 生命周期

- 启动：MainActivity.onResume 里 OverlayController.ensureStarted(this) + settlePendingEnable(this)（MainActivity.kt:968-973）；桥开关 onGetOverlayEnabled/onSetOverlayEnabled（MainActivity.kt:1710-1711 → AndroidBridge.kt:455/459 → OverlayController.setEnabled/isEnabled）。
- 真源判定：OverlayController.isEnabled = enabledPref && canDrawOverlays && OverlayService.instance != null（OverlayController.kt:87-88）；prefs 名 dsh-overlay，键 enabled / pendingEnable（:21-34）。缺权限时偏好回落 false + 只引导一次 + 待启意图（S2-17），授权回前台 settlePendingEnable 自动补启（:53-80、107-123）。
- 服务启动后的初始化顺序（OverlayService.onCreate:187-200）：instance=this → wm → buildRoot()（建光环+球，注册触摸）→ live.startWatcher() → probeEngine() → scheduleProbe() → panel.startMux() → halo.startMotionWatch() + panel.startMotionWatch()。
- 停止/撤窗：OverlayService.onDestroy:228-247 依次 stopMotionWatch（halo/panel）→ live.stopWatcher → panel.destroy()（closePicker + mux.close）→ report.hideReport() → recall.hide() → 避让帧清零 → removeWindow(root/halo/unit) → instance=null。
- onStartCommand：intent==null（系统重建）→ stopSelf() + START_NOT_STICKY；显式启动也返回 START_NOT_STICKY（:211-217）；测试 OverlayServiceLifecycleTest 2 例锁死。onTaskRemoved → stopSelf（:223-226）。EngineService.onTaskRemoved 会主动 stopService(OverlayService)（EngineService.kt:92-105）。
- onConfigurationChanged（OverlayService.kt:154-185）：展开态 applyThemeColors；halo.refreshTheme + recall.refreshTheme；clampBallPos 把球夹回新屏；**hidden 分支提前 return**，只 recall.reposition 让条重新贴边；否则 updateViewLayout(root) + syncHalo；展开态重算 panelWindowWidth 并 updateViewLayout + positionPanel；emitFrame。旋转不重建 Activity（configChanges，见 OverlayService.kt:342-345 注释），所以窗口尺寸没有第二个人替它重算。
- 锁屏/亮屏：**悬浮层没有任何处理**。全仓 grep SCREEN_ON / USER_PRESENT / Keyguard 在悬浮层文件零命中（仅 NotifyCenter 有锁屏脱敏与「需出现在锁屏之上」的通知渠道说明，NotifyCenter.kt:94-95、135）。悬浮窗也未加 SHOW_WHEN_LOCKED 类 flag（overlay 窗口不支持该 flag 语义）→ 锁屏上是否可见/触摸行为**未确认（未做设备验证，也没有相关代码路径）**。
- 前后台检测：悬浮层自身不做。只有 MainActivity.onResume/onPause/onStop（MainActivity.kt:894、1066-1074、1115-1124）与 pageUiActive（MainActivity.kt:106）驱动 frameConsumer 注册/清除、补启、replayFrame。**球不随 App 前后台显隐**：只要服务在，球始终在屏上（与 VdisplayFloat 的「退后台才显示只读浮窗」是两套逻辑，compare VdisplayHost.kt:333-346）。
- 与 MainActivity/WebView 共存时现有的显隐逻辑（全部）：
  1. 设置页开关（DevSection）→ 桥 setOverlayEnabled → 服务启停（dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx:236-252、339-345）。
  2. MainActivity.onResume 幂等补启 + 待启意图结算（:972-973）。
  3. 展开/收起面板（togglePanel/hidePanel）；自动化工具执行时自动收面板（OverlayLiveFeed:125-128）；轮次完成自动收面板（默认开，overlay_display/auto_collapse_on_done，OverlayService.kt:564-568、647-656）。
  4. 隐藏态：球/光环离屏，只剩召回条（hideBall/recallBall）。
  5. 服务销毁/划后台：撤掉全部窗口（onDestroy、onTaskRemoved、EngineService.onTaskRemoved）。
  - 不存在「App 在前台时隐藏球」「App 退后台时显示球」这类共存开关（grep 无对应代码）。

### 1.7 主题与视觉现状

- 明暗判定：OverlayTheme.isDarkTheme 读 uiMode（OverlayTheme.kt:9-11）；没有跟随 WebView 页面主题的任何通道，只跟系统 uiMode。
- 色板（OverlayTheme.kt:48-71）：

| token | 深色 | 浅色 |
|---|---|---|
| unitBg / unitStroke | 0xF21E1F24 / 0xFF3A3D45 | 0xF2F8F9FA / 0xFFDADCE0 |
| idleText / offText / clockText | 0xFF8A8F98 / 0xFFE04848 / 0xFF81858C | 0xFF5F6368 / 0xFFC5221F / 0xFF5F6368 |
| inputBg / inputStroke / inputText / inputHint | 0xFF2A2D33 / 0xFF3A3D45 / 0xFFE8EAED / 0xFF9AA0A6 | 0xFFFFFFFF / 0xFFDADCE0 / 0xFF202124 / 0xFF80868B |
| divider / chevron | 0xFF2A2D33 / 0xFF8AB4F8 | 0xFFE8EAED / 0xFF5F6368 |
| haloIdle / haloIdleFade | 0x60FFFFFF / 0x3AFFFFFF | 0x8A3D3D3D / 0x523D3D3D |
| recallStrip | 0x99FFFFFF | 0x993D3D3D |

- 圆角：面板 unit 30dp（OverlayService.kt:425）、输入框 17dp（OverlayPanel.kt:383）、chip 10dp、pending chip 14dp、picker 容器 14dp（OverlayPanel.kt:1398）、报告栏 16dp（OverlayReport.kt:150）、球/光环 OVAL、召回条圆角 = 半宽（药丸）。
- 透明度：三个常态窗口 + picker/report 都是 PixelFormat.TRANSLUCENT；unitBg 0xF2（约 95%）、picker 背景 0xF0、recallStrip 0x99（60%）。
- 阴影：仅 picker elevation=6dp（OverlayPanel.kt:1399）与报告栏 elevation=8dp（OverlayReport.kt:151）；面板/球/光环/召回条无 elevation、无 setShadowLayer。
- 模糊：**全仓悬浮层无 blur / RenderEffect**（grep 7 处命中里只有 elevation 与 ShellOps 的 disable-blur 白名单，与 UI 无关）。
- 光环视觉：LayerDrawable 两层——glow（OVAL 径向渐变，半径 24dp；API29+ 四段 stop 0/0.45/0.74/1）与 ring（硬边 OVAL 描边 2dp，内缩 4.5dp），两层同一次 resolveColors 取色（OverlayHalo.kt:86-134）；脉冲 AlphaAnimation WORKING 1100ms 1→0.7 往返、PENDING 900ms 1→0.55 往返，受 DsUi.animationsEnabled 降级（OverlayHalo.kt:160-167）。
- 与启动页主题的关系：**无共享主题 token**。开屏视频是 Activity 视图树内的 TextureView + 硬编码黑色 FrameLayout 背板（SplashOverlay.kt:41-58），不读 OverlayTheme，也不读 Theme.Dsh（app/src/main/res/values/themes.xml:3-13）；OverlayTheme 的消费方只有 OverlayHalo:23、OverlayPanel:28、OverlayReport:39、OverlayRecall:30 四处（grep OverlayTheme( 结果）。因此重构若要求「启动页与悬浮层统一视觉」，需要新建共享 token 层，现有代码无法直接复用。

### 1.8 测试覆盖

现有可能失败的边界：本 worktree 没有 app/build/test-results/testDebugUnitTest（Test-Path False），因此**未运行** node scripts/check-kotlin-test-count.mjs（它会因缺结果判红）；以下统计来自只读读取脚本与基线文件。

总量口径：
- 基线文件 scripts/kotlin-test-baseline.json：totalTests = 2257，testsByClass 共 216 个类。
- 测试源目录 app/src/test/java/com/dsharnessmobile/shell 共 268 个 .kt（268 > 216，因为一个文件可声明多个测试类，且部分类未入基线）。
- 门禁：scripts/check-kotlin-test-count.mjs（判据 A 每个测试源类必须有结果；判据 B 每类用例数不得低于基线；结果必须新鲜），接入 scripts/build-apk.mjs:150/304。
- 基线时效问题（已确认）：OverlayPanelBackKeyTest.kt 与 OverlayPickerTeardownTest.kt **不在 testsByClass 里**；两文件最新提交分别是 e6128ef1(2026-11-05)、dfc4e89f(2026-11-04)，而基线最后一次提交是 e752b188(2026-11-01) → 基线未升档，这两类共 8 例未被计入 2257。不阻断现状（基线只对已登记类做下限），但下次 --update-baseline 应 +8。

悬浮层相关测试类（@Test 数取基线；骨架两个类现场数 @Test）：

| 测试文件（app/src/test/java/com/dsharnessmobile/shell/） | 用例数 | 断言什么 |
|---|---|---|
| OverlayBatch5Test.kt | 20 | 视觉/文案契约：深色空闲光环逐字节不变、浅色白底可见（对比度复算）、另三态不随主题变、换肤必须重刷、44dp 热区常量与手柄 padding、圆钮 contentDescription、状态行可见汇报入口、完成提示不写「长按」、元信息三行在正文前、正文与摘要同句不渲染两遍、三击窗口宽于双击超时、空闲提示不说插话、目标行不显示 sessionId、报告条不抢焦点、picker 钳制在屏内且可重试、手选会话走同一切换通知、状态行不再英文模板、探活不覆写待答文案 |
| OverlayCompletionNoticeTest.kt | 20 | 完成位状态机：普通完成置位并显示、首次打开才消费、展示期常驻/收起后回常态、两轮不残留、失败类不读成已完成、语义标签优先于权威默认、别的会话 idle 不改写、目标会话不符不显示、切会话清除、已展开时完成立即消费、晚到语义标签升级而非撤下；另含 reportLines 占位/口径/兜底与手势裁决（两次点击不跳、长按不再跳、拖动不跳、三击窗口运行时读） |
| OverlayHaloInvariantTest.kt | 7 | 光环颜色可读性（JVM 桩下不为 0）、ring 与 glow 同源、fade 同色相低 alpha、通道顺序、8 个 ARGB 字面量逐字节等价、haloSize/2 == ballSize/2 + edgeMargin 跨密度恒等、ring 落在 (17dp,25dp) 可用环带内 |
| OverlayPendingCardTest.kt | 15 | 翻页 -1/+1 且不回卷、翻页不得用取模、折叠不丢项且给展开入口、审批首点待确认二点放行、不得单击直通、停止按钮真禁用、安装权限缺失按钮复原、授权结果可见且永久拒绝与本次拒绝分述、两级设置页失败必说话、未配置发布源不是失败、失败文案可执行、maxLines 必配 ellipsize、修复不得靠删 maxLines |
| OverlayPanelBackKeyTest.kt | 4 | 返回键一次按压只收一次（DOWN/UP 都消费）、别的键（音量/回车/ESC/MENU）不被吞、真类 BackKeyPanelLayout 在派发口拦下、面板根容器必须是该类（源码契约：unit 只能有一处构造且类型为 BackKeyPanelLayout） |
| OverlayPickerTeardownTest.kt | 4 | panel.destroy() 先 closePicker 再断 mux、closePicker 幂等（先判空、无条件置空两个引用、removeView 包 try）、onDestroy 必须调用 panel.destroy() 且 report/recall 各自收口、picker 必须仍是独立顶层窗口（源码契约） |
| OverlayRecallTest.kt | 11 | 条贴最近水平边、用球心判边、x 不为负、纵向与球心对齐、球在底部/顶部时条完整可见、召回落同一条边、条与召回选边同源、落点在 clampBallPos 区间内、退化屏幕不炸、条高够触摸目标 |
| OverlayReportBarTest.kt | 10 | 滚动区承载全文而非仅摘要、缺 body 回落 summary→text、空 body 视为无、元信息三行口径、短汇报不占满上限、上下限反转时归一、拖拽上增下减且夹取、越界回拉恢复中间高度、零位移也合法、内容溢出时视口确实小于内容 |
| OverlayReportExpandTest.kt | 7 | 竖屏打开上限 40%、横屏 300dp 地板、展开天花板严格高于打开上限（双向否定「两个上限合并」的回归）、横屏同样成立、合并两上限会判红、全展开后长内容仍可滚、天花板不越屏且不低于地板 |
| OverlaySendBackfillTest.kt | 11 | 新会话发送前 payload sessionId 为空、已知会话取该 id、发送时刻才解析 sessionId、requestId 一次发送只生成一次（幂等）、用户未动输入框时回填、内容是原文时回填、用户改过不回填、空白视为未动、失败分支必须问 plan 不得盲回填、回填守卫读当前输入并在文案里写出去向、原文落剪贴板可找回 |
| OverlayServiceLifecycleTest.kt | 2 | intent==null 的系统重建不得选择粘性重启；显式启动同样 START_NOT_STICKY |
| MotionCoalescerTest.kt | 8 | 连续 MOVE 合为最后一条、DOWN/MOVE/MOVE/UP 保序合帧、drain 后 MOVE 不丢、超限丢最老 MOVE 但保 DOWN/UP/CANCEL、无 MOVE 可丢时拒绝新事件保结构、CANCEL 不被合并、tab 间隔离、forget 一个 tab 不影响其它 |

源码契约测试（CallSiteContractTest.kt，共 874 行）里的悬浮层组：
- ST-02：isEnabled 必须活体查 canDrawOverlays + 要求实例在场（:97-106）。
- I-A2：haloView.background 初值必须走 newHaloDrawable(Halo.IDLE)（:345-350）；setHalo 取层失败不得静默吞（:308-315）。
- I-A3：ring 与 glow 合成在同一 View、setHaloColors 恰两处调用、ring 符号封闭在 OverlayHalo.kt、8 个 ARGB 全在 Halo 枚举内、Halo 构造参数恰两档、setHalo 是唯一委托入口、不得回退 Color.argb（:213-343）。
- A1：完成态必须是 updateBallOnly 分支链的一支且文案经 setStatusText（:366-376）。
- A2：报告栏是独立协作类、不复用 unit 面板（:409-435）；自动收起守卫必须含 !panelOccupied 且保留 !panel.hasDraft()（:493-512）。
- A3：状态行三击/长按手势接线（:455-493）。
- J-A1…J-A5：隐藏入口在场并走 hideBall、换肤同步、hideBall 真 remove 两窗且留召回条、recallBall 先光环后球且先收条并复位光环、buildRoot 不得建条（窗口计数）、条 NOT_FOCUSABLE + contentDescription + 唯一点击动作、隐藏不得读写偏好（:514-593）。

结论：悬浮层现有防线以**纯函数单测 + 源码切片契约**为主，真正跑 Android 视图/WindowManager 的用例为零（JVM 桩下 Color/KeyEvent 等都退化为 0，测试里也专门反桩）。重构时若改函数签名/文件位置，会大面积打红 CallSiteContractTest 的源码契约断言——这是有意的防线，不是噪声。

### 1.9 坑位与硬约束（与新重构冲突 / 必须继承）

| # | 来源（仓库相对路径:行号） | 约束原文要点 | 对新重构的含义 |
|---|---|---|---|
| G328 | docs/AGENTS/gotchas.md:2469-2474；docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:26-43 | TYPE_APPLICATION_OVERLAY 窗口命中矩形 = 窗口矩形，alpha/GONE 不改变命中；隐藏只能 removeView；召回条窗口尺寸必须 = 可视尺寸 | 任何新增/改造悬浮面（展开卡片、手势条、提示气泡）都必须让窗口矩形 = 可视命中区；禁止用透明度/visibility 假冒隐藏；新增窗口要走「懒建 + onDestroy/onPanelHidden 收口」纪律 |
| F8 | OverlayService.kt:60-63、300-305；OverlayHalo.kt:11-12 | 同 TYPE 窗口 z 序 = addView 顺序；光环必须先于球；状态切换不得 remove/re-add 重排 | 新增窗口时先定 z 位置与 add 顺序；隐藏/召回是唯一例外且必须写在一个函数内 |
| 光环几何恒等式 | OverlayService.kt:71-83；OverlayHaloInvariantTest.kt:205-244 | haloSizeDp/2 == ballSizeDp/2 + edgeMarginPx；edgeMargin 太小会让光环窗左缘为负 → WMS 整窗平移 → 偏心 | 若改球径（34dp）或边距（8dp），必须同步 haloSizeDp 并改测试；不能只改球 |
| 面板宽度单一真源 | docs/AGENTS/gotchas.md:1097-1112；OverlayService.kt:347-350、154-185 | 面板宽度只能由 panelWindowWidth() 算；转屏无人重建 Activity，必须在该函数/onConfigurationChanged 重算 | 新面板若换容器/宽度策略，必须收敛到唯一函数，并覆盖横竖屏 |
| 触摸目标 44dp | OverlayReport.kt:503；OverlayPanel.kt:235/255/316-317/334-335/351-352/417-418；OverlayRecall.kt:138 | 仓内可点元素热区下限 44dp（视觉可更小） | **现存冲突**：球窗就是 34dp，低于该下限且 OverlayService 零处引用 MIN_TOUCH_TARGET_DP。新需求若要「更好点按」，必须同时处理球径、haloSize 恒等式、clamp 边距、召回点手感 |
| 隐藏态不落盘 | OverlayService.kt:113-120；docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:57-61；CallSiteContractTest.kt:585-593 | 隐藏是会话内临时动作，不新增 prefs、不在 onResume 补隐藏 | 新需求若要求「记住隐藏」，属于推翻既有契约，需先改文档与 J-A5 反向契约测试 |
| 召回条 8dp 宽度风险 | docs/0.14.9-preview-OVERLAY-BALL-HIDE.md:83-93 | 条只有 8dp 宽，真人手感未验证；2026-10-18 复核建议 ≥22dp，用户拍板保持 8dp | 若重构要改召回形态，这里是已知风险点（改宽 = 同时改窗口与可视，改内缩 = 改纯函数） |
| agent/session id 混用 | docs/AGENTS/EXECUTION-MAP.md:292；OverlayService.kt:611-617；OverlayPanel.kt:1316-1324 | api-session/status 的 agentId 被写进 activeSessionId，而 A-R5 口径说 agent id 不得当 session id；清理只在 pinned 时发生 | **重构前必须先切清 id 域**，否则「按会话分桶」的新 UI 会把状态挂错会话 |
| addView 失败被吞 | docs/AGENTS/EXECUTION-MAP.md:293；OverlayService.kt:382（expanded 已在 :357 置 true） | 面板 addView 异常无日志无回滚，状态说面板在、屏上没有 | 新面板必须补失败回执（日志 + expanded 回滚），否则同类「点球没反应」复发 |
| 自动收起守卫覆盖不足 | docs/AGENTS/EXECUTION-MAP.md:294；OverlayService.kt:647-656；OverlayPanel.kt:1168 | 守卫只看输入行草稿，待答卡里输入的自定义答案不算草稿 → 可能收掉用户正在答的卡 | 若新面板有更多输入面，自动收起判据必须扩展 |
| 死通道/死调用 | docs/AGENTS/EXECUTION-MAP.md:295-296；OverlayService.kt:961-973、653-655 | frameConsumer 恒 0px（0.13.2 起不再挤开页面）；自动收起分支里的 flashStatus 永不显示 | 重构可清理，但清理前要确认无外部依赖；不要把它当「还在生效的避让机制」 |
| 返回键 | OverlayPanelBackKey.kt:7-27；CallSiteContractTest 无，OverlayPanelBackKeyTest 4 例 | 面板可聚焦 → BACK 必须先被面板消费；只能挂在窗口根 dispatchKeyEvent；只收 ACTION_UP | 任何新面板窗口只要 focusable，就必须接返回键，否则「返回键死了」复发 |
| 动效降级 | DsUi.kt:22-49、74-96；OverlayHalo.kt:155-167、180-189；OverlayPanel.kt:626-734；ShimmerTextView.kt:95-125 | 常驻无限动画必须订阅系统动效开关并在开关翻转时停下（判定不是订阅） | 新动画必须走 DsUi.animationsEnabled + registerMotionListener；否则 144Hz 设备永不空闲 |
| 文档不许写死行数 | docs/AGENTS/ARCHITECTURE.md:11 | 文件数与行数用命令现数 | 重构后更新 modules.md / ARCHITECTURE.md / EXECUTION-MAP 时不要抄本报告数字 |

### 1.10 复用评估表

| 现有代码/接口 | 结论 | 理由 + 行号 |
|---|---|---|
| OverlayController（开关真源/权限引导/幂等起停） | 可直接复用 | 159 行、职责单一；isEnabled 三源合成与 pendingEnable 意图已有测试（CallSiteContractTest.kt:97-106），与 UI 形态无关 |
| 悬浮球服务骨架（Service 生命周期/探活/RPC/发送停止） | 需改造 | 服务本身可留；但窗口增至 6 个、面板构建在 OverlayPanel、onDestroy 收口顺序脆弱；重构应保留 postRpc/requestSend/applyAgentStatus 的协议逻辑（OverlayService.kt:705-822、608-659），把窗口与视图搬走 |
| 球绘制（白球+鲸鱼 Matrix） | 需改造 | 34dp 低于 44dp 触摸下限（OverlayService.kt:70 与 OverlayReport.kt:503 冲突）；尺寸变更会连锁 haloSize/clamp（1.9）。绘制代码本身可留 |
| 拖动 + clampBallPos | 可直接复用 | 四向钳制是纯数值逻辑且与召回纯函数同边界（OverlayService.kt:543-551、OverlayRecall.kt:182-198），有 OverlayRecallTest 覆盖 |
| 光环（glow+ring/四态/deriveHalo/动效订阅） | 可直接复用 | 结构自洽：颜色单一漏斗、两层同源、几何恒等式有测试；仅在改球径时需要同步尺寸。OverlayHalo.kt:66-207 |
| 隐藏/召回（hideBall/recallBall/OverlayRecall） | 可直接复用 | 行为与约束已被文档 + J-A1…J-A5 + OverlayRecallTest 11 例钉住；条 8dp 手感是唯一已知风险（doc §6） |
| 面板视图树 buildUnit + updateBallOnly | 需改造 | 单窗口、无滚动、无事件列表、状态行承载 5 种语义、手势/换肤/双语都塞在 1673 行里；新需求若要事件列表/滚动/多卡片，unit 结构必须重排。可保留：44dp 热区规则、BackKeyPanelLayout、ADJUST_PAN、双语文案入口 |
| 会话选择器（独立窗口 + ScrollView + 可见性过滤） | 需改造（可保留逻辑） | 数据口径（可见性过滤/存活集分离/browser 对账）是硬需求（OverlayPanel.kt:1249-1328，含 #1573/#1364 两个修）；但窗口形态与 maxH=45% 未验证（gotchas.md:1111），重构时建议保留过滤逻辑、重做展示层 |
| 待答卡（审批/提问）+ Mux 协议 + 应答 | 可直接复用 | 协议细节多且有反证（generation 对账、15s 兜底、审批二次确认、选项折叠、翻页钳制、selected 用 label）；见 OverlayPanel.kt:1023-1147、1624-1673。不要重写协议层 |
| live 流消费（FileObserver/字节偏移/字段） | 可直接复用 | 字节偏移与半行处理是修过的真缺陷（#178），字段 k/s/name/args/ok/kind 已稳定（OverlayLiveFeed.kt:67-180） |
| 报告栏（独立窗口 + 拖拽 + reportLines） | 可直接复用 | 纯函数 + 上下限分离（reportBarCompactCap/ExpandCeil）是设备实报修出来的（OverlayReport.kt:373-437）；若新 UI 要合并报告入口，先保留这两条上限语义 |
| CompletionNotice 完成位 | 可直接复用 | 服务级字段 + 会话比对 + 消费语义有 20 例测试（OverlayReport.kt:576-691）；重构若改状态模型，这是必须继承的语义 |
| OverlayTheme 色板 | 需改造 | 只有 20 个颜色 token，无圆角/间距/阴影/模糊 token；与启动页无共享层（1.7）。建议抽 token 层后保留现有 dark 值逐字节不变 |
| ShimmerTextView / DsUi | 可直接复用 | 动效降级与订阅语义完整（DsUi.kt:74-96）；注意扫光颜色硬编码 brand500/brand200（ShimmerTextView.kt:28-29），主题化需另行处理 |
| 返回键 BackKeyPanelLayout | 可直接复用 | 4 例测试含源码接线契约；新面板根容器继续用它即可 |
| MotionCoalescer / TabMotionQueues | 不适用于悬浮层 | 只服务 BrowserProcessService 的渲染进程触摸转发（BrowserProcessService.kt:94）；悬浮层没有使用它，也没有别的 UI 刷新节流器 |
| SplashOverlay | 不适用 | Activity 视图树内的开屏视频播放器，不是 overlay 窗口；与悬浮层唯一的交集是「视觉/主题统一」需求（当前零共享） |
| 建议重写（局部） | 面板 unit 视图树 + 状态行渲染分支链 | 理由：1673 行里视图构建/渲染/协议/手势耦合；分支优先级靠注释与源码契约维持（OverlayPanel.kt:1171-1237）。重写时保留 1.9 的硬约束与 1.8 的测试口径 |

### 未确认清单（明确列出，供后续施工前补证）

1. 新需求原文不在本 worktree（docs/overlay-refactor-2026-11/ 为空），无法逐条判定「直接冲突」，只能给继承约束（1.9）。
2. 面板内容高度超过屏幕时是否真的顶出屏（无滚动）——代码推断成立（OverlayService.kt:404 + 无 ScrollView），**未做设备验证**。
3. 锁屏/亮屏时悬浮球是否可见/可点、是否被系统裁掉——无代码路径，**未做设备验证**。
4. 球 34dp 在真机/模拟器上的实际点按命中率、是否被判定为「按不准」——无设备证据；仓内 44dp 口径是既有结论（S2-18），球尚未达标。
5. 时钟刷新最长滞后时间（推断约 10s，探活 tick 周期）——未在设备上量化。
6. 引用「docs/0.14.1-preview-OVERLAY-COMPLETION-CARD.md 详档 §x」的结论（完成位判定 1/2、§6.2 反证 4 等）无法在本仓核对。
7. 会话选择器窗口高度 45% 屏高在横屏下的可读性——gotchas.md:1109-1112 明确「同形态未改」，未验证。

### 证据附录（实际执行过的只读命令）

工作目录统一为 D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\ovl-phase1。

1. git rev-parse HEAD; git log -1 --oneline; git status --porcelain
   - 输出：5f533907baadaf37963f00b5c56da3777b79c637；Merge pull request #1716 from kelai141/perf/prefix-rewrite-single-stat；status 空。
2. git log -3 --date=short -- scripts/kotlin-test-baseline.json
   - 输出：e752b188 2026-11-01 …（基线最后更新）。
3. git log -2 --date=short -- app/src/test/.../OverlayPanelBackKeyTest.kt app/src/test/.../OverlayPickerTeardownTest.kt
   - 输出：e6128ef1 2026-11-05、dfc4e89f 2026-11-04（晚于基线）。
4. Get-ChildItem app/src/main/java/com/dsharnessmobile/shell -Filter '*.kt' + (Get-Content <file>).Count
   - 用途：模块清单行数（OverlayService 1069 / OverlayPanel 1673 / OverlayReport 691 / OverlayHalo 244 / OverlayLiveFeed 219 / OverlayRecall 198 / OverlayController 159 / OverlayTheme 72 / OverlayPanelBackKey 54 / MotionCoalescer 133 / ShimmerTextView 126 / SplashOverlay 206 / DsUi 241 / UiText 28）。
5. glob **/Overlay*.kt（worktree 根）
   - 输出：主源 9 个 Overlay*.kt + 测试 11 个 Overlay*.kt（列表见 1.1/1.8）。
6. read 逐文件（带行号）：OverlayService.kt 全文 1069 行、OverlayPanel.kt 全文 1673 行、OverlayHalo.kt、OverlayLiveFeed.kt、OverlayRecall.kt、OverlayReport.kt、OverlayController.kt、OverlayTheme.kt、OverlayPanelBackKey.kt、MotionCoalescer.kt、ShimmerTextView.kt、SplashOverlay.kt、DsUi.kt、UiText.kt。
7. grep "wm\.(addView|removeView|updateViewLayout)"（OverlayService/OverlayPanel/OverlayReport/OverlayRecall）
   - 输出：8 处 addView —— OverlayService.kt:322（光环）、:324（球）、:382（面板）、:480（召回重加光环）、:481（召回重加球）；OverlayPanel.kt:1476（picker）；OverlayReport.kt:292（报告栏）；OverlayRecall.kt:81（召回条）。前 6 类窗口，480/481 是对已有窗口的重新 add。
8. grep "OverlayTheme\(" app/src
   - 输出：OverlayHalo.kt:23、OverlayPanel.kt:28、OverlayReport.kt:39、OverlayRecall.kt:30（无 Splash/MainActivity）。
9. grep "MIN_TOUCH_TARGET_DP" app/src/main/.../shell
   - 输出：仅 OverlayPanel/OverlayReport/OverlayRecall 引用；OverlayService.kt 0 处。
10. grep "setOnLongClickListener|GestureDetector|DoubleTap|ACTION_OUTSIDE"（四个 overlay 文件）
   - 输出：OverlayService/OverlayRecall 0 命中；OverlayPanel/OverlayReport 仅 ACTION_OUTSIDE 与注释里的 DoubleTapTimeout（三击窗口）。
11. grep "SCREEN_ON|USER_PRESENT|Keyguard|KeyguardManager|ACTION_SCREEN|isScreenOn|锁屏|亮屏" app/src/main/.../shell
   - 输出：仅 NotifyCenter.kt:94-95/135/811/1184/1191，悬浮层无命中。
12. grep "MotionCoalescer|TabMotionQueues" app/src
   - 输出：只被 BrowserProcessService.kt:72/81/82/94/255 与 MotionCoalescer 自身/测试引用。
13. grep "blur|Blur|RenderEffect|elevation|setShadowLayer" app/src/main/.../shell
   - 输出：elevation 两处属 overlay（OverlayPanel.kt:1399 6dp、OverlayReport.kt:151 8dp），无 blur/RenderEffect 命中。
14. grep "frameConsumer|replayFrame|OverlayService\.instance|OverlayController\." app/src/main/.../shell
   - 输出：MainActivity.kt:960-967（注册）、:1147（清除）、:1506（replay）、:1661（applyLanguage）、:1710-1711（桥开关）；NotifyCenter.kt:208（flashStatus）；OverlayController.kt:72/87。
15. grep "Overlay|悬浮|overlay" docs/AGENTS/modules.md / EXECUTION-MAP.md / ARCHITECTURE.md
   - 输出：modules.md:60（OverlayBackKey.kt 命名失真）、:73-75（Overlay 族行）；ARCHITECTURE.md:32-45（悬浮球表，缺 OverlayPanelBackKey.kt）；EXECUTION-MAP.md:221（K09 addView 静默）、:292-299（K09 已知缺陷与行数漂移）、:469/532-546（接线表）。
16. grep "悬浮|overlay|Overlay|互吞|窗口" docs/AGENTS/gotchas.md
   - 输出：75 行命中；本报告引用 53（:528）、155（:705-719）、169/175（:1097-1112）、328（:2469-2474）。
17. read docs/0.14.9-preview-OVERLAY-BALL-HIDE.md（93 行）
   - 用途：隐藏/召回形态、三种「留着窗口」的死因、明确不做与风险（§2/§4/§6）。
18. Get-ChildItem -Force docs/overlay-refactor-2026-11；(… | Measure-Object).Count
   - 输出：0（空目录）；grep "悬浮交互|overlay 重构|Phase 1" docs 零命中。
19. read scripts/check-kotlin-test-count.mjs:1-80 + read scripts/kotlin-test-baseline.json
   - 输出：判据 A/B 说明；totalTests=2257；testsByClass 216 类；OverlayPanelBackKeyTest/OverlayPickerTeardownTest 缺席；悬浮层各类用例数见表。
20. (Get-ChildItem app/src/test/java/com/dsharnessmobile/shell -Filter '*.kt').Count；Test-Path app/build/test-results/testDebugUnitTest
   - 输出：268；False（故未运行 check-kotlin-test-count）。
21. grep "@Test"（OverlayPanelBackKeyTest.kt / OverlayPickerTeardownTest.kt）
   - 输出：各 4 例。
22. read app/src/main/res/values/themes.xml + app/src/main/res/anim/picker_enter.xml
   - 输出：Theme.Dsh 定义；OverlayPickerAnim → picker_enter（220ms decelerate_quad，alpha 0→1，translateY -6%→0）。
23. read MainActivity.kt 选定区段（:894-1000、:1066-1124、:1135-1158、:1490-1514、:1650-1715、:655-700）
24. read EngineService.kt:80-118；read NotifyCenter.kt 相关 grep 行；read dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx 相关 grep 行

---

## 2. 壳与 DSH 的集成面

> 调查基线：worktree `_dsh-wt/ovl-phase1`，HEAD = `5f533907`（与 origin/main 对齐，工作树干净）。
> 本文所有路径均为**仓库相对路径**；行号以该提交的 `read` 计数为准。
> 只读调查，未改动任何产品代码。

### 2.1 进程与数据流总图

#### 2.1.1 参与者

| 层 | 组件 | 关键文件 |
|---|---|---|
| 壳 / 主进程（`com.dsharnessmobile.shell`） | MainActivity + WebView（引擎 Web UI）、AndroidBridge、BackGateBridge、OverlayService（悬浮球三窗口 + 面板/报告栏/召回条）、NotifyBridge、FileIncoming、PhotoCaptureController | `app/src/main/java/com/dsharnessmobile/shell/` |
| 引擎子进程 | 内嵌 Termux 快照里的 Node 引擎（`@deepseek-ai/dsh`）+ 网关 `dsh-api-gateway` + 插件树 | 快照 `assets/snapshot.tar.xz` → `files/usr` + `files/home` |
| 引擎侧插件 | `@dsh-android/dsh-android-bridge`（产 `.live.ndjson`/`.notify.ndjson`）、`dsh-android-file-open`（来件队列 + `/api/android/file-incoming*`） | `plugins/dsh-android-bridge/src/index.ts`、`plugins/dsh-android-file-open/src/index.ts` |
| 页面插件 | `dsh-client-ui-responsive`（「+」sheet、会话标记、来件草稿消费等）、`dsh-host-web-compat`（注入 `window.__dshBridge`、polyfill） | `dsh-client-ui-responsive/src/client/`、`dsh-host-web-compat/lib/index.js` |

#### 2.1.2 数据流（文字 + ascii）

```
                      ┌──────────────────────────── 主进程（壳） ────────────────────────────┐
                      │                                                                       │
 引擎子进程             │  MainActivity (WebView)          AndroidBridge (JS→Kotlin)           │
 ┌───────────────┐     │   │ 引擎 Web UI 页面              ▲ window.androidBridge            │
 │ Node 引擎 +    │     │   │  ├─ dsh-client-ui-responsive  │  （全部 @JavascriptInterface，   │
 │ 网关 :<动态>   │     │   │  └─ dsh-host-web-compat 注入   │    同步返回字符串/布尔）          │
 │               │◄────┼───┤      window.__dshBridge        │                                  │
 │ 插件树         │ HTTP │   │        ├ onDirectoryPicked ◄───┼── pickDirectory(callbackId)      │
 │  bridge 插件   │ /api │   │        └ onPhotoCaptured  ◄───┼── capturePhoto(action)          │
 │  file-open 插件│      │   │                               │                                  │
 └──────┬────────┘     │   │                               │                                  │
        │ 写文件         │   │                               │                                  │
        │ .live.ndjson  │   │  OverlayService（独立 overlay 窗口）                            │
        ▼               │   │   ├─ MuxClient ── WS /api/remote.mux open $events ──► 网关       │
 ┌───────────────┐     │   │   │    收 ready/waterfall/emit/cancel 帧（审批/提问/忙态）        │
 │ files/home/   │     │   │   ├─ OverlayLiveFeed ── FileObserver tail .live.ndjson          │
 │  .dsh/        │─────┼───┤   │    收 tool_call / tool_result / turn_end / text              │
 │  .live.ndjson │     │   │   ├─ postRpc ── POST /api/session/{list,create,prompt,cancel}    │
 │  .notify.ndjson│    │   │   ├─ 应答 ── POST /api/$events/result（clientId+eventId+outcome）│
 │  storages/    │     │   │   ├─ tempWorkspaceId() 直读 storages/workspace.json             │
 │   workspace.json    │   │   ├─ EngineProbe ── HTTP 探活（10s tick）                       │
 └───────────────┘     │   │   └─ frameConsumer ── evaluateJavascript（单向注入 body padding）│
                       │   │                                                                  │
                       │  NotifyBridge：第二条 $events 流（streamId=dsh-notify-responder）     │
                       │  FileIncoming / PhotoCaptureController：来件 → POST /api/android/...  │
                       └───────────────────────────────────────────────────────────────────────┘
```

**结论（悬浮层在哪一环）**：悬浮层**不经过 WebView 桥**拿数据，它是主进程内的一个前台 Service，直接对引擎的三条通道取数：

1. **WS 事件流**（`MuxClient` → 网关 `/api/remote.mux`，open `$events`）：审批/提问 waterfall、`api-session/status` 忙态锚点、cancel 帧。见 `OverlayPanel.kt:107`、`MuxClient.kt:71-75`。
2. **文件事件流**（`FileObserver` tail `files/home/.dsh/.live.ndjson`）：tool_call / tool_result / turn_end / text / title。见 `OverlayLiveFeed.kt:26-59`、生产者 `plugins/dsh-android-bridge/src/index.ts:2117-2205`。
3. **HTTP RPC**（`POST /api/<ns>/<method>`）：session/list、session/create、session/prompt、session/cancel、`$events/result`。见 `OverlayService.kt:705-745`。

唯一从悬浮层流向 WebView 的是**单向避让帧** `OverlayService.frameConsumer`（`OverlayService.kt:961-973`，消费方 `MainActivity.kt:960-967`），且当前恒注入 0px（`emitFrame` 把 `lastRight/lastBottom` 恒置 0，`OverlayService.kt:961-966`）——即事实上的死通道，新设计不要依赖它。

**端点真源**：`EngineEndpoint` 单例。`HOST="127.0.0.1"`、`DEFAULT_PORT=4145`、`port` 只有在「本进程确认过当前生成代」后才非 0（`EngineEndpoint.kt:10-22`）；`.engine-endpoint.json` 只在 `publishReportedPort` 里原子写（`EngineEndpoint.kt:57-71`）。所有消费方都必须走 `EngineEndpoint.url` / `EngineEndpoint.port`，不得写死端口（正例：`OverlayService.kt:721`、`FileIncoming.kt:541`、`NotifyBridge.kt:29-32`、`MuxClient.kt:151` 每次建连现取）。

### 2.2 桥面：AndroidBridge 全量方法（JS→Kotlin）

#### 2.2.1 通道约定

- 注入名：`webView.addJavascriptInterface(AndroidBridge(...), "androidBridge")`（`MainActivity.kt:1609-1762`）；另有独立窄面 `dshBackBridge`（`MainActivity.kt:1767`）。
- **方向**：`@JavascriptInterface` 方法一律 **JS→Kotlin 同步调用**，返回值只能是 String/Boolean/Double/Int；Kotlin→JS 的异步回调**只有两条**：
  - `window.__dshBridge.onDirectoryPicked(callbackId, path)`（定义 `dsh-host-web-compat/lib/index.js:1051-1060`），由 `pickDirectory` 驱动；
  - `window.__dshBridge.onPhotoCaptured(payload)`（`PhotoCaptureController.kt:394-406`），由 `capturePhoto` 驱动；页面侧挂在同一宿主对象上（`composer-sheet.ts:1192-1196`，且**只增属性、绝不创建 `window.__dshBridge` 本身**，`composer-sheet.ts:1183-1191`）。
- **帧来源门禁**：每个入口第一件事是 `trusted{}` / `checkTrustedFrame()`（`AndroidBridge.kt:226-238`，接线 `MainActivity.kt:1614`），不可信顶层帧直接抛 `BridgeFrameDenied`。
- **全部方法**（`@JavascriptInterface` 共 81 个，逐个见 §2.2.2 表；此处只列与悬浮层/事件/附件/拍照/选文件/会话/工作区相关的子集）。

#### 2.2.2 与悬浮层/事件/附件/拍照/选文件/会话/工作区相关的方法

| # | 签名（行号） | 方向 | 参数语义 / 返回值 | 归属 |
|---|---|---|---|---|
| 1 | `getOverlayEnabled(): Boolean`（`AndroidBridge.kt:455`） | JS→Kotlin | 悬浮球开关真源 = 偏好∧权限∧服务实例（`OverlayController.kt:87-88`） | **悬浮层专用** |
| 2 | `setOverlayEnabled(enable: Boolean): Boolean`（`:459`） | JS→Kotlin | 持久化 + 启停；返回「此刻是否已启动」；未授权时引导一次系统页 | **悬浮层专用** |
| 3 | `capturePhoto(action: String): String`（`:766`） | JS→Kotlin | action 闭集，目前只有 `capture`；返回 `{ok:true,accepted:true}` **只表示受理**，最终结果走 `onPhotoCaptured` | 附件/拍照 |
| 4 | `pickDirectory(callbackId: String)`（`:277`） | JS→Kotlin（异步回 `onDirectoryPicked`） | SAF 目录选择；callbackId 由页面轮询 `/api/android/dir-pick/poll` 取得（`index.js:1092-1099`） | 选文件/目录 |
| 5 | `getPickToken(): String?`（`:397`） | JS→Kotlin | 目录选择一次性令牌，页面以 `x-dsh-pick-token` 头回带（`index.js:1055`、`:1079`） | 选文件 |
| 6 | `incomingWorkspacePath(): String`（`:471`） | JS→Kotlin | 外部来件的**临时工作区 cwd**（`FileIncoming.tmpWorkspace`，接线 `MainActivity.kt:1715`）；不含源文件名/路径 | 附件（工作区） |
| 7 | `hasAllFilesAccess(): Boolean`（`:341`） | JS→Kotlin | 外部工作区前置（API30+ 特批权限） | 工作区/文件 |
| 8 | `requestAllFilesAccess()`（`:382`） | JS→Kotlin | API26-29 运行时权限 / 30+ 特殊访问 | 工作区/文件 |
| 9 | `openNativePath(path: String): Boolean`（`:451`） | JS→Kotlin | 外部阅读器打开路径（回退语义由页面处理） | 附件/文件 |
| 10 | `openPathChooser(path: String, mode: String?): String`（`:350`） | JS→Kotlin | 系统「打开方式」选择器，返回 `{ok,reason?}` | 附件/文件 |
| 11 | `openFileExternal(path: String, mime: String): String`（`:362`） | JS→Kotlin | ACTION_VIEW 打开（`FileExternalBridge.KIND_OPEN`） | 附件 |
| 12 | `shareFile(path: String, mime: String): String`（`:376`） | JS→Kotlin | ACTION_SEND 转发（`KIND_SHARE`） | 附件 |
| 13 | `showNotification(title: String, text: String)`（`:271`） | JS→Kotlin | 通知中心投递 | 事件/提醒 |
| 14 | `keepScreenOn(enable: Boolean)`（`:265`） | JS→Kotlin | 屏幕常亮 | 通用 |
| 15 | `copyText(text: String): Boolean`（`:325`） | JS→Kotlin | 原生剪贴板写 | 通用 |
| 16 | `checkEngine(): String`（`:249`） | JS→Kotlin | `EngineProbe.check()` JSON | 引擎状态 |
| 17 | `restartEngine(): Boolean`（`:406`） | JS→Kotlin | 重启引擎（返回是否真的发起） | 引擎控制 |
| 18 | `shutdownToGuide()`（`:410`） | JS→Kotlin | 停引擎回引导页 | 引擎控制 |
| 19 | `reloadWebUI()`（`:417`） | JS→Kotlin | 刷新 Web UI | 引擎控制 |
| 20 | `getScreenScope()/setScreenScope(scope)`（`:463`/`:467`） | JS→Kotlin | 模型可访问屏幕范围（`virtual-only` 缺省），用户独占写 | 设备控制 |
| 21 | `setUiLanguage(mode)/getUiLanguage()`（`:317`/`:310`） | JS→Kotlin | 壳偏好真源，setter 同步 dsh 语言与悬浮面板文案（`MainActivity.kt:1661`） | 通用/悬浮层联动 |
| 22 | `getNotifySetting/setNotifySetting`（`:720`/`:729`） | JS→Kotlin | 通知设置读写，默认实现钉在 `NotifyCenter` 真源 | 事件/提醒 |
| 23 | `browserHost*/vdisplay*/a11y*/shizuku*/root*`（`:475-710`） | JS→Kotlin | 浏览器工作台、虚拟屏、无障碍/特权通道 —— 与悬浮层无直接关系，但同一桥对象 | 其他 |

**会话/工作区相关的关键结论**：桥面上**没有**任何 `listSessions / switchSession / createSession / sendPrompt / listWorkspaces / switchWorkspace` 方法。会话与工作区的现有入口只有三条：① 引擎 HTTP RPC（壳侧 `postRpc`）；② `incomingWorkspacePath()`（只给临时工作区路径）；③ 页面内部的客户端 store/service（`uiWorkspace.openSession`、`connectWorkspace`，`incoming-runtime.ts:7`、`:24-28`）。原生悬浮层要显示「工作区/会话切换药丸」，必须**新增桥方法或新增 RPC 消费**（见 §2.10 建议）。

### 2.3 帧 / 事件通道

#### 2.3.1 WS $events 流（MuxClient）

- 连接：`ws://127.0.0.1:<EngineEndpoint.port>/api/remote.mux`，握手带浏览器 Cookie（`MuxClient.kt:161-167`），连上即发
  `{"type":"open","streamId":"dsh-overlay-events","endpoint":"$events","payload":{"args":{}}}`（`MuxClient.kt:71-75`、发送点 `:197`）。
- 客户端唯一合法消息：`open` / `cancel`（`MuxClient.kt:20-32` 类注释，含协议出处 `dsh-api-gateway/lib/{index,client}.js`）。
- 服务端帧：`{type:"item",streamId,value}` / `{type:"end"}` / `{type:"error"}`（`MuxClient.kt:25`）。
- 心跳：网关 ping → 本端 pong（`MuxClient.kt:254`）；读超时 60s 判半开（`:61`）；重连退避 2s→10s 上限（`:339-363`）。
- 解析：`OverlayPanel.handleMuxFrame`（`OverlayPanel.kt:110-125`）→ `handleEventValue`（`:132-194`）：

| `value.type` | 字段 | 落点 |
|---|---|---|
| `ready` | `clientId`、`host.home` | 记 `eventsClientId`（`OverlayPanel.kt:134-149`），应答必须回带；并做 generation 对账 |
| `waterfall` / `event="approval/request"` | `eventId`、`agentId`、`request.toolName`、`request.reason` | `pendingApprovals[eventId] = PendingApproval(eventId, agentId, toolName, reason)`（`:157-161`） |
| `waterfall` / `event="user-questions/request"` | `eventId`、`agentId`、`request.questions[]`（`id/header/question/options[{label,description}]/multiSelect`） | `pendingQuestions[eventId] = PendingQuestion(...)`（`:162-166`）；字段消费见 `OverlayPanel.kt:803-948` |
| `cancel` | `eventId` | 无条件丢弃对应 pending（引擎侧权威「已结清」）（`:169-178`） |
| `emit` / `event="api-session/status"` | `args = [agentId, running]` | `svc.applyAgentStatus(agentId, running)`（`:179-192`） |

- 应答：`POST /api/$events/result`，信封 `{type:"client-request",rpcId,method:"$events/result",payload:{args:{clientId,eventId,outcome}}}`（`OverlayPanel.kt:1023-1060`）。
  - 审批 `outcome={kind:"result",value:"allowed-once"|"rejected"}`（`:1062-1084`）；
  - 提问 `outcome={kind:"result",value:{answers:[{id,selected:[label...],custom?}]}}`（`:1088-1122`）；
  - 跳过提问 `outcome={kind:"rejected",error:{name:"UserQuestionError",message,code:"cancelled"}}`（`:1125-1147`）。

#### 2.3.2 live 文件流（`.live.ndjson`）

生产者：`plugins/dsh-android-bridge/src/index.ts`
- 文件路径 `$DSH_HOME/.live.ndjson`（`:2117`），上限 512KB 轮转 `.1`（`:2118`、`:2135-2140`），100ms 批量写（`:2123-2129`）。
- 事件来源 `ctx.on('session/event', ...)`（`:2207`）；投影函数 `live()`（`:2150-2206`）：

| `k` | 字段 | 行号 |
|---|---|---|
| `tool_call` | `t`(epoch ms) `s`(sessionId) `name` `args`(≤240 字符) | `:2159-2165` |
| `tool_result` | `t s name args dur err` | `:2166-2178` |
| `text` | `t s sum`（只取 `type==='text'` 的可见正文，≤160 字符） | `:2179-2188` |
| `turn_end` | `t s ok`(boolean) `kind`(completed/aborted/blocked/error/max-tokens/interrupted/unknown) | `:2189-2201` |
| `title` | `t s title`（≤80 字符） | `:2202-2205` |

消费者：`OverlayLiveFeed`（`OverlayLiveFeed.kt:26-59` watcher；`:67-180` 行边界安全 drain，只消费到最后一个 `\n`；`:99-173` 分支）。语义：`tool_call` 置忙并刷新 `currentToolName/currentToolSummary`（`:101-133`）；`tool_result` 回「思考」态（`:134-142`）；`turn_end` 回空闲 + 语义标签（`:143-169`）。**注意**：`turn_start` 分支已退役（`OverlayLiveFeed.kt:100`、插件 `index.ts:2155-2158`），忙态锚点是 `api-session/status`。

#### 2.3.3 通知信道（`.notify.ndjson`）与第二条 $events 流

- `.notify.ndjson` 由同一插件投影（`index.ts:2097-2103`、`:2213-2299`，`kind=todo|report`，report 含 `outcome/outcomeLabel/sessionId/title/summary/body/durationMs/toolCount/presentedFiles/popup`）。
- 壳侧消费：`NotifyStore`（`latestReportLine` `NotifyStore.kt:129`；`OverlayReport.kt:322`），报告栏内容即取它（`OverlayReport.kt:23-27`）。
- 第二条 $events 流：`NotifyBridge`（`NotifyBridge.kt:13-31`，`streamId="dsh-notify-responder"`，`MuxClient` 创建 `:88`，应答 `postResult` `:318-345`）。与悬浮球流并行，首个应答者结算、另一方收 `cancel`。

#### 2.3.4 「当前会话 / 当前 run 状态」是否有真源

**结论：没有单一真源，现有实现是三条互相独立的事实源，且存在已登记的 id 域混用缺陷。**

- **run 状态**（应用级 / 会话级）：主锚点 = `api-session/status` 的 `running`（`OverlayService.applyAgentStatus` `OverlayService.kt:608-659`），辅以 `.live.ndjson` 的 `tool_call/turn_end`（`OverlayLiveFeed.kt:99-169`），再加 45s 乐观忙态兜底（`OverlayService.kt:557-576`）。
- **目标会话**：`OverlayService.activeSessionId`（`OverlayService.kt:86`）+ `userPinnedSession`（`:88`）+ 会话选择器投影 `pickerSessions`（`OverlayPanel.kt:57`、`:1250-1328`）。
- **已确认缺陷（EXECUTION-MAP 已登记）**：`api-session/status` 给的 `agentId` 被直接写进 `activeSessionId`（`OverlayService.kt:611-616`），而 `OverlayPanel.kt:1317-1318` 明说「agent id 不得当 session id」；源码自述该映射未确证（`OverlayService.kt:639-641`）。登记见 `docs/AGENTS/EXECUTION-MAP.md:292`（K09 第 1 条，列出 3 个消费点）。**新设计必须显式定义 agentId→sessionId 的映射或改用会话级事件，不能复用这条混用链。**
- **页面侧真源**（可直接复用）：`<html data-dsh-session-id>`，由 `SessionMarker` 从客户端会话快照发布（`dsh-client-ui-responsive/src/client/mobile/session-marker.ts:26`、`:63-75`；依据 `snapshot.byId[*].retainedBy.mainView` 判当前会话）。原生层要「当前会话」最稳的来源是**引擎 RPC + 页面标记核对**，而不是悬浮层自己的内存字段。

### 2.4 插件侧（plugins/dsh-android-bridge）

- **client 半边是空的**：`src/client/index.ts:1-19` 明确「0.14.0 起不再注册任何 UI」「手机控制面在 dsh-client-ui-responsive」；client 产物由 `build-client.mjs:25-46` 打到 `lib/client.js`（`window.__ModuleLoader__.load` 闭包工厂）。
  - **注意**：本 worktree 里 `plugins/dsh-android-bridge/lib/` **不存在**（`Get-ChildItem` 只列出 `src/test/package*.json/build-client.mjs/tsconfig*`），所以只能审 `src`；发布产物内容未确认（见 §2.11）。
- **与 overlay / 事件上报相关的只有一处（服务端 `ctx.on('session/event')` 投影）**：`index.ts:2207-2299`，写 `.live.ndjson`（`:2141-2206`，供悬浮球）与 `.notify.ndjson`（`:2097-2103`，供通知/报告栏）。没有「面板」概念、没有 `overlay` 事件名、没有 UI 注册。
- **附件/文件插件**：`plugins/dsh-android-file-open/src/index.ts` 注册 5 条 exact 路由：
  `/api/android/file-incoming`（`:794`）、`/claim`（`:883`）、`/content`（`:988`）、`/complete`（`:1052`）、`/clean`（`:1119`）；队列落盘在临时工作区 `.sessions/<entryId>.json`（`:50-51`、`:483-503`）；来源归一 `origin: 'external'|'camera'`（`:346-356`）；鉴权见 `route-auth.ts`。
- **壳 ↔ 插件的事件名清单**（当前全部）：

| 方向 | 名称 | 载体 | 证据 |
|---|---|---|---|
| 插件→壳 | `.live.ndjson` 行 `k=tool_call/tool_result/text/turn_end/title` | 文件 tail | `index.ts:2159-2205`；`OverlayLiveFeed.kt:99-173` |
| 插件→壳 | `.notify.ndjson` 行 `kind=todo/report` | 文件 tail | `index.ts:2243-2288`；`NotifyStore.kt:129` |
| 插件→壳 | `.task-done.ndjson`（老信道，保留兼容） | 文件 tail | `index.ts:2263-2270` |
| 引擎→壳 | `$events`: `ready` / `waterfall`(approval/request, user-questions/request) / `cancel` / `emit`(api-session/status) | WS | `OverlayPanel.kt:132-194` |
| 壳→引擎 | `POST /api/$events/result` | HTTP | `OverlayPanel.kt:1023-1060`；`NotifyBridge.kt:318-345` |
| 壳→引擎 | `POST /api/android/file-incoming`（body `{path,origin}` + `X-DSH-Control-Token`） | HTTP | `FileIncoming.kt:526-560` |
| 页面→引擎 | `GET/POST /api/android/file-incoming{,/claim,/content,/complete}` | HTTP | `incoming-draft.ts:182,382,394,415` |

### 2.5 工作区与会话：现有接口

| 能力 | 现有接口 | 真实路径 | 行号 | 说明 |
|---|---|---|---|---|
| 列出会话 | RPC `session/list`，payload `{_request:{}}` | `POST /api/session/list`（`OverlayService.postRpc` 拼 `/api/<method>`） | `OverlayPanel.kt:1250-1328`；信封 `OverlayService.kt:705-745` | 读 `result.value.items[]`：`sessionId`、`origin`、`blank`、`running`、`projections.values.title`、`cwd`、`updatedAt`（`:1277-1304`）；官方可见性过滤 `:1283-1285` |
| 新建会话 | RPC `session/create`，payload `{request:{workspaceId?}}` | 同上 | `OverlayService.kt:799-818` | 回包取 `result.value.sessionId`（兼容字符串化形态，`:861-872`） |
| 发送消息 | RPC `session/prompt`，payload `{request:{requestId,sessionId,mode:"steer"|"queue",content:[{type:"text",text}]}}` | 同上 | `OverlayService.kt:762-822`（payload `:779-784`） | `requestId` 是幂等键，一次用户发送只生成一次（`:768-771`、`:771`） |
| 停止轮次 | RPC `session/cancel`，payload `{request:{sessionId}}` | 同上 | `OverlayService.kt:748-759` | 仅工作中可用 |
| 切换会话（原生） | 悬浮层自建：`activeSessionId` + 选择器窗口 | `OverlayService.kt:86`、`OverlayPanel.kt:1381-1527` | — | **不是真源**，只是悬浮层本地目标；选择器只允许列表内 id（`OverlayPanel.kt:1374-1376`） |
| 切换会话（页面） | `uiWorkspace.openSession(id)` | 客户端 service | `incoming-runtime.ts:28`；`index.ts:1040-1041` | 原生不可直接调用 |
| 当前会话身份（页面） | `<html data-dsh-session-id>` | DOM | `session-marker.ts:26,63-75` | 页面侧唯一权威、不抛异常的判据（`incoming-draft.ts:197-214` 复用同一属性） |
| 列出工作区 | **本仓无 RPC 调用点**；工作区数据在 `files/home/.dsh/storages/workspace.json`（`tables.workspaces[*].title`） | 文件 | `OverlayService.kt:585-600` | 悬浮层只读它取「临时工作区」id；没有列表/切换接口 |
| 新建工作区（页面） | `workspaces().create({path})` → `uiWorkspace.connectWorkspace(id)` | 客户端 service | `incoming-runtime.ts:19-27` | 原生不可直接调用 |
| 工作区注册（引擎侧） | `workspaceRegistry.create/list/delete` | 引擎 service | `plugins/dsh-android-file-open/src/index.ts:315-333`、`:549-569` | 不是 HTTP 路由；供插件内部使用 |
| 当前工作区（页面） | `uiWorkspace` / pane-tab store | 客户端 store | `mobile-workspaces.ts:81`、`sidebar-bubbles.ts:25-31,255-261` | 只在页面内可见 |

**「工作区/会话切换药丸」所需字段与缺口**：

- 会话药丸**可复用**：`session/list` 的 `sessionId/title/cwd/running/updatedAt` 足够渲染「● 会话名 · 相对时间」，切换只需改目标并（可选）让 WebView 导航到该会话（页面侧 `openSession` 无桥面入口 —— 缺口）。
- 工作区药丸**缺**：① 无「工作区列表」接口（既无 RPC 证据也无桥方法，只有 `workspace.json` 文件可读）；② 无「切换/新建工作区」接口；③ 工作区与会话的归属关系（哪个 session 属于哪个 workspace）**未确认**（`session/list` 项里只有 `cwd`，无 `workspaceId`，`OverlayPanel.kt:1295-1298`）。→ 见 §2.10 建议。

### 2.6 发消息：完整链路与原生直发可行性

#### 2.6.1 现在（WebView 路径）

1. 用户点输入框 → 上游 `InputBar` 的发送按钮 / 软键盘 Enter。页面侧的 Enter 处理被 `enter-guard.ts` 改写为「软键盘 Enter 插入换行、只认发送按钮」（`dsh-client-ui-responsive/src/client/enter-guard.ts:5`、`:43`）。
2. 上游 composer 提交后，客户端 runtime 以 `POST /api/session/prompt` 发给网关（诊断脚本里的实测调用形：`fetch('/api/session/prompt', {request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}]}})`，见 `docs/AGENTS/gotchas.md:860-867`；字段名真源同处 `:866-867`：`session/list` 用 `_request`、`session/prompt` 用 `request`）。
3. 引擎侧会话事件经 `session/event` 回到插件（`plugins/dsh-android-bridge/src/index.ts:2207`）→ 写 `.live.ndjson` / `.notify.ndjson`；`api-session/status` 经 `$events` 回到悬浮球（`OverlayPanel.kt:179-192`）。
4. 附件不在 prompt 里：外部分享/拍照的文件先进 `/api/android/file-incoming` 队列（`FileIncoming.kt:539-560`），页面侧 `IncomingDraftConsumer` 在 4s 轮询（`index.ts:1006-1013`）里 claim → content → `conversation().addFiles(sessionId,[file])`（`incoming-draft.ts:382-401`、`incoming-runtime.ts:30-37`），即**附件进的是编辑器草稿，由用户自己发送**；`session/prompt` 的 wire 是否接受附件字段**未确认**（`submittedAttachments` 只出现在 `commands/execute`，`gotchas.md:863`）。

#### 2.6.2 Kotlin 原生悬浮层直发：可行，已有实现

`OverlayService.requestSend()`（`OverlayService.kt:762-822`）已经是一条完整的原生直发链：

- 读面板输入框 `panel.inputBox`（`:763`）；
- 未选目标时先 `session/create`（带临时工作区 id，`:796-818`），成功后 `activeSessionId=sid` 再发；
- payload `{requestId, sessionId, mode: steer|queue, content:[{type:"text",text}]}`（`:779-784`），`requestId` 生成一次、create+prompt 复用（`:768-771`，防「两条请求」）；
- HTTP 走 `postRpc`：`POST /api/<method>`，`EngineAuth.attach` cookie，401 刷新重试一次（`:705-745`）；
- 失败回填判据 `failureBackfillPlan`（`:1051-1069`），避免 8s 超时窗口内覆盖用户新输入。

**风险**：
1. **sessionId 域**：`activeSessionId` 可能来自 `agentId`（§2.3.4），直发可能落到不存在/别的会话。
2. **模式判定**：`steer` 当且仅当发送瞬间 `sessionBusy`（`:767`），忙态本身是三条事实源合成（含 45s 乐观态），可能选错模式。
3. **附件缺失**：纯文本 content 之外没有附件入口；要带图必须先走 file-incoming 队列 + 页面 addFiles，原生层目前无法把「用户刚拍的照片」直接附到一次 prompt 上（照片是异步进队列、由页面轮询认领，`PhotoCaptureController.kt:356-385` + `incoming-draft.ts:177-195`）。
4. **鉴权与端点**：必须现取 `EngineEndpoint.url` 与 `EngineAuth`（反例：写死端口/裸 `http://` 会打到未确认监听者，`EngineEndpoint.kt:16-22`）。
5. **回执可见性**：原生直发的唯一反馈是面板状态行（`flashStatus` 要求 `expanded`，`OverlayService.kt:878-887`）；面板收起时用户看不到失败（同族缺陷已登记 `docs/AGENTS/EXECUTION-MAP.md:304`）。新设计需要独立的可见回执通道。

### 2.7 主界面「+」菜单与附件

#### 2.7.1 「+」面板实现位置

| 位置 | 文件 | 行号 | 职责 |
|---|---|---|---|
| 拦截与 sheet | `dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts` | 选择器 :30、:41、:43；三瓦片 :809-841；瓦片 kind :195 | 把上游「+」（`[data-composer-card] button[aria-haspopup="listbox"]`）的点击换成底部 sheet：拍照/照片/本地文件 + 自动映射上游菜单项 |
| 样式 | `dsh-client-ui-responsive/src/client/mobile/composer-sheet.css.ts` | — | （未逐行通读，仅确认由 `index.ts:250` 注入） |
| 装配 | `dsh-client-ui-responsive/src/client/index.ts` | :36-38（import）、:249-256（effect 注入样式 + 构造） | 只拦「+」，不碰权限/模型/发送（:249 注释） |
| 上游菜单真源选择器 | 同上 `composer-sheet.ts` | :41 `[data-composer-card] [role="listbox"]`、:43 `[role="option"]` | 注意是 listbox 不是 menu（:35-39 实机取证） |

**patches 里没有「+」菜单实现**：`scripts/patches/registry.json` 无 composer/加号相关补丁（grep 无命中）；「+」改造完全在 `dsh-client-ui-responsive` 插件侧。

#### 2.7.2 附件类型与处理链路

| 类型 | 发起 | 链路 | 证据 |
|---|---|---|---|
| 拍照 | sheet 瓦片 `camera`（`composer-sheet.ts:832-835`）→ `capturePhoto()`（`:1147-1181`）→ `window.androidBridge.capturePhoto('capture')`（`:207-212`、`:1160`） | `AndroidBridge.capturePhoto`（`AndroidBridge.kt:766`，接线 `MainActivity.kt:1671`）→ `PhotoCaptureController.handleBridgeAction`（`PhotoCaptureController.kt:217-224`，立即回 `{ok:true,accepted:true}`）→ `capture()`（`:227-269`，权限 → `launchCamera`）→ 相机结果 `cameraLauncher`（`:173-192`）→ `finish()`（`:313-345`，先压缩后投递）→ `deliver()`（`:356-385`）：`FileIncoming.copyIn`（`:359`）→ `FileIncoming.processIncomingPath(..., ORIGIN_CAMERA)`（`:373-375`）→ 回执 `onPhotoCaptured`（`:394-406`） | 页面回执渲染 `composer-sheet.ts:1201-1218`；错误码映射 `:250-262` |
| 照片（相册） | sheet 瓦片 `photo` → `pickFile('photo')`（`composer-sheet.ts:1103-1127`） | 设 `accept=image/*`，点上游 hidden `input[type=file][multiple]`（`:53`、`:1103-1126`）；**不设 `capture`**（WebView 忽略，:1096-1101） | 上游 `onShowFileChooser` → `mediaPickerController`（`MainActivity.kt:1589-1595`） |
| 本地文件 | sheet 瓦片 `file` → `pickFile('file')` | 清 `accept` 后点同一 input（`composer-sheet.ts:1108-1110`） | 同上 |
| 外部分享进件 | 系统 VIEW/SEND → `MainActivity` | `FileIncoming.processIncomingIntent`（`FileIncoming.kt:593`）→ `enqueuePending`（`:464`）→ `deliverOnce` 投 `/api/android/file-incoming`（`:539-560`，头 `X-DSH-Control-Token`）→ 页面轮询 claim/content/complete → `conversation().addFiles` | `incoming-draft.ts:177-195,382-415`；队列状态端点 `/api/android/file-incoming`（`plugins/dsh-android-file-open/src/index.ts:794`） |

关键顺序约束：`finish()`「先压缩再投递」（`PhotoCaptureController.kt:306-312` 注释），投递必须先把文件拷进临时工作区（`:347-355`，否则 `safeResolveInside` 判越界、HTTP 200 + `ok:false` 静默失败）。

### 2.8 动态命令注册

- **真源**：上游 `ui-input-trigger` 的命令目录 / 客户端命令贡献，**不是**壳侧、也不是本仓任何硬编码表。
  - 证据 1：`dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts:3-19` —— sheet 打开时让上游菜单自己开，再读 `[data-composer-card] [role="listbox"] [role="option"]` 逐项复制，「本模块不认识任何具体项，第三方插件往『+』里加的东西因此自动出现」。
  - 证据 2：`docs/AGENTS/known-gaps.md:127` 明确写出标题规则与来源：上游 `ui-input-trigger` 行标题 = `item.label ?? item.name`（上游 `MenuView.tsx:186`；上游仓不在本 worktree，按 `docs/AGENTS/known-gaps.md:127` 转述），`label` 只有客户端命令贡献能给（`ui-commands` 的 `CommandContribution.label?()`，`contract.ts:105`）；宿主命令目录的 `CommandDescriptor` 只有 `name`+`description`（上游 `packages/interaction/commands/src/types.ts:57-66`（不可本地核对））。
  - 证据 3：`reference-menu.ts:32-34` 用「上游注册名 `command`/`reference`」与 `optionId(source,index)` 前缀定位行，同样是 DOM/注册表驱动。
- **执行**：`POST /api/commands/execute`，payload 为 `{agentId, line, submittedAttachments}`（`docs/AGENTS/gotchas.md:862-867`；该字段名与 `session/prompt` 的 `request` 不同，错字段得 `gateway/arguments-invalid`）。
- **有没有硬编码命令列表？** 没有。悬浮 sheet 里唯一「硬编码」的是**要隐藏的附件行标题闭集** `ATTACHMENT_ROW_TITLES = {文件,本地文件,file,files,local file,local files}`（`composer-sheet.ts:191-193`）；用途是去掉与三瓦片重复的那一条，且注释明确要求精确匹配、禁止按位置/前缀（`:186-189`）。
- **新设计要求**：原生悬浮层的命令/技能入口**必须复用这份真源**（读上游菜单 DOM 或等上游暴露目录 API），不得在 Kotlin 里写第二份 `android_*` 命令清单；否则与 `check-tool-name-promises` / 工具面预算门禁的既有口径分裂。

### 2.9 复用与缺口表

| # | 能力 | 现有接口（行号） | 缺口 | 建议 |
|---|---|---|---|---|
| 1 | 读当前轮次忙态 | `$events` `api-session/status`（`OverlayPanel.kt:179-192` → `OverlayService.kt:608-659`） | agentId/sessionId 域混用；无显式「当前 run id」 | 复用通道；新增 agentId→sessionId 映射或改用带 sessionId 的事件 |
| 2 | 读工具调用流 | `.live.ndjson` `tool_call/tool_result`（插件 `index.ts:2159-2178`；壳 `OverlayLiveFeed.kt:101-142`） | 无「调用 ID / 开始-结束配对」暴露到 UI（插件内部有 `liveCalls`，`:2149`） | 复用；如需配对展示，插件侧加 `callId` 字段（只加不改） |
| 3 | 读思考摘要 | `.live.ndjson` `text.sum`（`index.ts:2179-2188`） | 只有 160 字符、无 reasoning 块 | 复用；不要解析 reasoning（`:2180-2183` 明确 reasoning 与 text 共用 `text` 字段） |
| 4 | 读任务完成语义 | `.live.ndjson` `turn_end.kind`（`index.ts:2189-2201`）+ 报告 `.notify.ndjson report` | 无 | 复用（壳侧映射已存在，`OverlayLiveFeed.kt:151-162`） |
| 5 | 审批/提问交互 | `$events` waterfall + `POST /api/$events/result`（`OverlayPanel.kt:1023-1147`） | 审批只有 allowed-once/rejected 两值；无取消通道 | 复用，不改协议 |
| 6 | 发消息 | `session/prompt`（`OverlayService.kt:762-822`） | 无附件字段（未确认）；无「提交后可见回执」 | 复用 + 新增可见回执通道 |
| 7 | 列/建/切会话 | `session/list|create|cancel`（`OverlayPanel.kt:1250-1328`、`OverlayService.kt:748-818`） | 无「切到该会话」的原生桥（页面 `openSession` 无桥面）；无「会话属于哪个工作区」字段（未确认） | 新增桥方法 `sessionOpen(id)`（或让页面暴露）+ 向引擎要 workspaceId |
| 8 | 工作区列表/切换 | 仅文件 `storages/workspace.json`（`OverlayService.kt:585-600`） | 无列表/切换/新建接口 | 新增桥方法或新增插件 op（见 §2.10） |
| 9 | 当前会话身份 | 页面 `<html data-dsh-session-id>`（`session-marker.ts:26,63-75`）；原生 `activeSessionId`（`OverlayService.kt:86`） | 两处无对账 | 原生向页面取值（新增只读桥方法）或由插件在 `$events` 里发 session 级事件 |
| 10 | 加号菜单 | `composer-sheet.ts` 三瓦片 + 动态映射（:809-841、:868-905） | 只在 WebView 内，原生悬浮层拿不到 | 原生层需自建等价入口；命令真源必须复用上游目录（§2.8） |
| 11 | 拍照/相册/文件 | `capturePhoto` 桥（`AndroidBridge.kt:766`）+ file-incoming 队列 | 原生悬浮层没有附件入口；照片只能进「页面草稿」 | 复用拍照/来件链；如需「原生发图」，需让引擎侧接受附件（未确认）或新增「附件草稿」桥 |
| 12 | 事件回推页面 | `frameConsumer`（`OverlayService.kt:961-973`，恒 0px 死通道） | 无通用 Kotlin→JS 事件通道 | 不要复用；新增带 origin 校验的单向事件注入（见 §2.10） |
| 13 | 引擎存活 | `EngineProbe.check()` 10s tick（`OverlayService.kt:663-701`） | — | 直接复用 |
| 14 | 端点/鉴权 | `EngineEndpoint`（`EngineEndpoint.kt:10-71`）+ `EngineAuth.attach` | — | 所有新通道必须复用 |

### 2.10 「不允许改 DSH 现有接口」前提下需要新增的能力（仅建议）

> 约束：不改引擎 RPC、不改 `$events` 协议、不改既有桥方法签名、不改 `plugins/dsh-android-bridge` 既有导出。以下全部是**加法**。

**A. 新桥方法（`AndroidBridge` 内新增，均需 `trusted{}` 门禁）**

1. `currentSessionId(): String` —— 返回页面 `<html data-dsh-session-id>` 的镜像（由 MainActivity 在 `onEvaluateJavascript`/导航完成时同步到 Kotlin 字段，或由页面主动 setter 推）。用途：原生层与页面会话身份对账，替代 agentId 猜测。
2. `sessionOpen(sessionId: String): String` —— 让 WebView 导航到指定会话（内部 `evaluateJavascript` 调页面 `uiWorkspace.openSession`，经现有 `__dshOpenSession` 口子；见 `index.ts:1040-1051`）。返回 `{ok,reason}`。
3. `workspaceList(): String` —— 返回工作区列表 JSON。数据源优先级：读 `files/home/.dsh/storages/workspace.json`（现有文件真源，`OverlayService.kt:585-600`）> 页面镜像。字段建议 `{id,title,path,sessionIds}`。
4. `workspaceSwitch(payloadJson: String): String` —— 切工作区；必须与页面 store 的 `connectWorkspace` 同源（`incoming-runtime.ts:19-27`），否则原生与页面各说各话。
5. `overlayEventSink(...)` 可选：不建议加；更稳的是新增**独立**注入对象（见 B）。

**B. 壳 ↔ 页面事件通道（不得复用 `frameConsumer`）**

6. 新增第二个 `addJavascriptInterface` 对象（如 `overlayHost`）或新增 `window.__dshOverlay` 回执名，用于 Kotlin→JS 单向事件（如「原生悬浮层发起了发送」）。要求：只用 `evaluateJavascript` 注入、JSON 串经 `jsString()` 转义（`AndroidBridge.kt:845-853`，U+2028/2029 必须转义）。
7. 页面 → 原生新增一个只读发布口（例如 `androidBridge.publishUiState(json)`），把「当前会话 id / 工作区 id / 命令列表摘要」推给壳侧缓存，避免原生层反查 DOM。

**C. 插件侧只增字段（不改既有语义）**

8. `.live.ndjson` 的 `tool_call` 行**追加** `callId`（插件内部已有 `liveCalls` map，`index.ts:2149`）——用于原生 UI 展示「进行中 vs 已完成」配对；旧消费者按现有字段继续工作。
9. 若需要「当前会话/工作区变更」事件：在 `session/event` 投影里**新增**一种 `k`（如 `k:"session" s:... workspaceId:...`），不删不改现有 `k`。壳侧 `OverlayLiveFeed` 增加对应分支即可。
10. 工作区事件如果上游没有可用源：插件侧读 `workspaceRegistry.list()`（`plugins/dsh-android-file-open/src/index.ts:315-333` 形态）后追加一行，而不是让壳侧解析内部 JSON。

**明确不建议**：在 Kotlin 侧新建第二套命令清单；改 `session/prompt` 的字段；改 `$events` 帧形；让原生悬浮层直连页面 DOM；复用 `frameConsumer` 作事件总线。

### 2.11 未确认项（原因）

1. **`plugins/dsh-android-bridge/lib/client.js` 内容未确认**：该 worktree 只有 `src/`，`lib/` 不存在（`Get-ChildItem -Recurse plugins/dsh-android-bridge` 无 `lib`）。产物由 `build-client.mjs` 生成，未在本机构建，故发布包内 client 半边是否仍为空未验证（源码层面 `src/client/index.ts:1-19` 明确为空）。
2. **引擎 RPC 面完整字段未确认**：`session/prompt` 是否接受附件、`session/list` 是否返回 `workspaceId`、是否存在 `workspace/list` RPC —— 上游引擎源码不在本仓（快照二进制），本仓仅有消费侧代码与 `docs/AGENTS/gotchas.md:860-867` 的实测调用形。
3. **`api-session/status` 的 agentId 与 sessionId 是否等价未确认**：源码自述未确证（`OverlayService.kt:639-641`），`docs/AGENTS/EXECUTION-MAP.md:292` 亦按「未在设备复现」登记。
4. **`ui-input-trigger` 命令目录是否有可通过桥/HTTP 读取的稳定接口未确认**：本仓只见到 DOM 选择器与 `known-gaps.md:127` 的第三方描述，未见目录 API。
5. **工作区与会话的归属字段未确认**：`session/list` 项只见 `cwd`（`OverlayPanel.kt:1295-1298`），未见 `workspaceId`；`workspace.json` 的 `tables.workspaces[*].sessionIds` 只在插件内部使用（`plugins/dsh-android-file-open/src/index.ts:322` 形），壳侧只读 `title`。
6. **拍照回执在「页面未就绪」时的最终可达性未确认**：`queueReceipt` 依赖 `webViewReady`（`PhotoCaptureController.kt:159-170`），冷启窗口内的行为无设备证据。

### 证据附录

**只读命令（均在 `_dsh-wt/ovl-phase1` 执行）**

| 命令 | 用途 / 输出摘要 |
|---|---|
| `git rev-parse HEAD; git status --porcelain` | `5f533907baadaf37963f00b5c56da3777b79c637`，工作树干净 |
| `Get-ChildItem -Name app\src\main\java\com\dsharnessmobile\shell\` | 确认 `OverlayService.kt / OverlayPanel.kt / OverlayLiveFeed.kt / OverlayController.kt / OverlayReport.kt / OverlayRecall.kt / MuxClient.kt / AndroidBridge.kt / PhotoCapture(Capture)Controller.kt / FileIncoming.kt` 在场 |
| `Get-ChildItem app\...\Overlay*.kt \| Measure-Object -Line` | OverlayService 996 行（read 计数 1069）、OverlayPanel 1577（read 1673）、OverlayLiveFeed 209、OverlayReport 641、OverlayController 142 |
| 逐字 `read` | `AndroidBridge.kt`(853 行全量)、`MuxClient.kt`(414)、`OverlayService.kt`(1-1069)、`OverlayPanel.kt`(1-1673)、`OverlayLiveFeed.kt`(219)、`OverlayController.kt`(159)、`PhotoCaptureController.kt`(418)、`EngineEndpoint.kt`(86)、`NotifyBridge.kt`(1-100,315-345) |
| `Select-String plugins/dsh-android-bridge/src/index.ts -Pattern '\.live\.ndjson|appendLive'` | 命中 `:146,161,2117-2205`，确认 live 投影位置 |
| `Select-String -Path app/.../AndroidBridge.kt -Pattern '@JavascriptInterface|^  fun '` | 81 个 `@JavascriptInterface` 入口与其行号（§2.2） |
| `Get-ChildItem -Recurse -File plugins\dsh-android-bridge` | 无 `lib/`；仅 `src/test/package*.json/build-client.mjs/tsconfig*`（未确认项 1 的依据） |
| `Select-String -Recurse -Pattern 'file-incoming'` | 路由注册点 `plugins/dsh-android-file-open/src/index.ts:794,883,988,1052,1119`；页面消费 `incoming-draft.ts:182,382,394,415` |
| `Select-String dsh-host-web-compat/lib/index.js -Pattern '__dshBridge'` | `:1051-1060` 定义 `onDirectoryPicked`（Kotlin→JS 回执唯一宿主） |
| `Select-String -Recurse -Pattern 'workspace/list|workspaceRegistry'` | 只有引擎 service（`plugins/dsh-android-file-open/src/index.ts:315-333`），无 RPC/桥入口（未确认项 5） |
| `Select-String -Recurse -Pattern 'submittedAttachments'` | 仅 `docs/AGENTS/gotchas.md:863,867`（`commands/execute`），`session/prompt` 无此字段（未确认项 2） |

**文档交叉引用（非源码，仅作旁证）**

- `docs/AGENTS/EXECUTION-MAP.md:144`（悬浮球三窗口入口）、`:174`（K09 覆盖账本）、`:292`（agentId/sessionId 域混用，已确认代码事实）、`:296`（frameConsumer 恒 0px 死通道）、`:579`（P04 会话/工作区服务）；`:536-538`（K09 的引擎网关/事件流/live 文件三条通道登记）。
- `docs/AGENTS/known-gaps.md:127`（`ui-input-trigger` 命令标题真源与 `CommandContribution.label`）。
- `docs/AGENTS/gotchas.md:860-867`（`/api/commands/execute` 与 `/api/session/prompt` 实测调用形与字段名差异）。
- `docs/AGENTS/BRIDGE-API.md:81-104`（悬浮球隐藏态/召回条块J 契约）、`:202`（`pickFilePath` 已退役，文件引用回上游菜单）、`:226`（通知应答第二条 `$events` 流）。

---

## 3. 视觉规范、性能基线与兼容风险

> 调查员 C 产出。工作树：`_dsh-wt/ovl-phase1`，HEAD = `5f533907`（origin/main 对齐，见证据附录 E0）。
> Phase 1 只调查、只写文档：本轮**未修改任何产品代码/配置/测试**，未跑打包、未跑设备或模拟器命令、未联网。
> 所有结论的证据形如 `仓库相对路径:行号`；本机 Android SDK 文件与命令输出记在证据附录。
> 证据分级沿用 `docs/perf/AUDIT-2026-11-02.md:40-48` 的口径：A 级（字节/行号/计数）= 主证据；C 级（绝对墙钟）只做同轮相对比较。
> **凡「需设备验证」的条目都不是结论，而是待测项**——本文不编造设备读数。

---

### 3.1 一页结论

| # | 结论 | 对 Phase 1 施工的含义 |
|---|---|---|
| 1 | 壳侧存在**两套并行色板**：`res/values*/colors.xml` 的 `ds_*` 中性 token（Apple 式黑白）与悬浮球自己的 `OverlayTheme.themeColors()`（蓝 #4176E6 / 灰阶 Google 风）。新悬浮卡片若直接抄 `OverlayPanel` 的字面量，会产出**第三套**配色。 | 必须先定「卡片归属哪套色板」，否则 Phase 2 必然漂移（3.2.7、3.3） |
| 2 | 可复用的硬 token 是**齐的**：颜色 21 个、尺寸 22 个（`<dimen>` 条目实测）、圆角 5 档、动效原语 4 个（roundRect/ripple/progressLayer/settingsCardBackground）、触摸目标 44dp、动效总开关。 | 新卡片不需要新造资源，只需选对档位（3.3） |
| 3 | 模糊只有一条正路：`WindowManager.LayoutParams.setBlurBehindRadius` + `FLAG_BLUR_BEHIND`，**API 31+**；`RenderEffect` 也是 **31+** 且**不能采样别的窗口**。minSdk 26 意味着 26-30 全部要降到半透明。 | 三档降级路径已写明，见 3.4 |
| 4 | **仓库内没有帧级性能基线**：`app/src` 全树 `FrameMetrics|JankStats|Choreographer|Trace.beginSection` 命中 **0 次**；`dumpsys gfxinfo` 全仓只在一条 doc 里被提到过。既有可量化基线全在**启动链**与**注入层 JS**，不在帧率。 | 「帧耗时 p50/p95、掉帧率、展开时长」全部是 Phase 2 现场首测项（3.5、3.7） |
| 5 | 已有两件**现成只读采集器**可直接用于 Phase 2：`scripts/perf/measure-steady.ps1`（冷启/稳态 CPU/内存）、`scripts/verify-frame-timing.mjs`（帧间隔/longtask/跨桥/启动分段）。 | 不要重写脚本，见 3.6 的命令与口径 |
| 6 | 兼容性主雷区不是「悬浮窗类型」，而是**焦点与手势**：输入法顶起、NOT_FOCUSABLE 抢焦点弹掉键盘、边缘手势热区。三者都有既往实锤。 | 3.9 逐条给出「现有代码是否已处理」 |

---

### 3.2 启动页与悬浮 UI 的视觉现状（逐项）

口径说明：壳侧没有 `styles.xml`，`res/values/styles` 不存在；「styles」实际落在 `themes.xml`。也没有 `res/font/`，字体全部走系统 family（3.2.8）。

#### 3.2.1 颜色资源：`app/src/main/res/values/colors.xml`

浅色（默认）：

| 行 | token | 值 | 语义 |
|---|---|---|---|
| 4 | `ic_launcher_background` | `#ffffff` | 启动图标底 |
| 8 | `ds_bg` | `#F5F5F7` | 页面画布 |
| 9 | `ds_surface` | `#FFFFFF` | 卡片面 |
| 10 | `ds_surface_muted` | `#F5F5F7` | 次级面 |
| 11 | `ds_chip` | `#F2F2F4` | chip 底 |
| 12 | `ds_button_surface` | `#E8E8ED` | 按钮面 |
| 13 | `ds_border` | `#14000000` | 边界（alpha 0x14 = 7.8%） |
| 14 | `ds_hairline` | `#1A000000` | 1px 细线（alpha 0x1A = 10.2%） |
| 15 | `ds_text_primary` | `#1D1D1F` | 主文本 |
| 16 | `ds_text_secondary` | `#6E6E73` | 次文本 |
| 17 | `ds_text_tertiary` | `#86868B` | 三级文本 |
| 18 | `ds_text_on_accent` | `#FFFFFF` | 反色文本 |
| 19 | `ds_accent` | `#1D1D1F` | 主操作色（黑白极简：accent 就是墨色） |
| 20 | `ds_accent_pressed` | `#3A3A3C` | 按下态 |
| 21 | `ds_accent_soft` | `#0D000000` | ripple 色（alpha 0x0D = 5.1%） |
| 22 | `ds_ok` | `#34C759` | 成功（仅语义色族） |
| 23 | `ds_warn` | `#FF9500` | 警告 |
| 24 | `ds_danger` | `#D70015` | 危险 |
| 25 | `ds_danger_soft` | `#14D70015` | 危险底（alpha 0x14） |
| 26 | `ds_progress_track` | `#14000000` | 进度轨道 |
| 27 | `ds_scrim` | `#E6F5F5F7` | 遮罩（alpha 0xE6 = 90.2%，**近乎不透明**） |

`colors.xml:6-7` 的注释是硬约束：**铬面只允许近中性灰，色相只留给 ok/warn/danger**，由 `GuidePaletteMonochromeTest` 守护（该测试文件存在：`app/src/test/java/com/dsharnessmobile/shell/GuidePaletteMonochromeTest.kt`）。新悬浮卡片若引入彩色（如沿用 #4176E6）需要显式说明为何不属于「铬面」。

暗色：`app/src/main/res/values-night/colors.xml`

| 行 | token | 值 |
|---|---|---|
| 4 | `ds_bg` | `#000000` |
| 5 | `ds_surface` | `#1C1C1E` |
| 6 | `ds_surface_muted` | `#2C2C2E` |
| 7 | `ds_chip` | `#2C2C2E` |
| 8 | `ds_button_surface` | `#343437` |
| 9 | `ds_border` | `#26FFFFFF` |
| 10 | `ds_hairline` | `#2EFFFFFF` |
| 11 | `ds_text_primary` | `#F5F5F7` |
| 12 | `ds_text_secondary` | `#98989D` |
| 13 | `ds_text_tertiary` | `#6E6E73` |
| 14 | `ds_text_on_accent` | `#1D1D1F` |
| 15 | `ds_accent` | `#F5F5F7` |
| 16 | `ds_accent_pressed` | `#C7C7CC` |
| 17 | `ds_accent_soft` | `#1EFFFFFF` |
| 18 | `ds_ok` | `#30D158` |
| 19 | `ds_warn` | `#FF9F0A` |
| 20 | `ds_danger` | `#FF6960` |
| 21 | `ds_danger_soft` | `#26FF6960` |
| 22 | `ds_progress_track` | `#2EFFFFFF` |
| 23 | `ds_scrim` | `#E6000000` |

#### 3.2.2 主题：4 个 `themes.xml` 变体（无 styles.xml）

`app/src/main/res/values/themes.xml`（浅色基线，17 行）：

- `:3` `Theme.Dsh` parent = `android:Theme.Material.Light.NoActionBar`
- `:4` `android:windowBackground` = `@color/ds_bg`
- `:5` `android:statusBarColor` = `@color/ds_bg`
- `:8` `android:navigationBarColor` = `@android:color/transparent`（issue #392 真沉浸，注释 `:6-7`）
- `:9` `android:windowLightStatusBar` = `true`
- `:10-12` `android:textColor` / `textColorPrimary` = `@color/ds_text_primary`；`android:colorAccent` = `@color/ds_accent`
- `:14-16` `OverlayPickerAnim`：`android:windowEnterAnimation` = `@anim/picker_enter`

变体差异（同一 `Theme.Dsh` 名，按限定符覆盖）：

| 文件 | parent | 差异项 |
|---|---|---|
| `values/themes.xml:3-13` | `Theme.Material.Light.NoActionBar` | 基线 |
| `values-night/themes.xml:3-12` | `Theme.Material.NoActionBar` | `windowLightStatusBar=false`（`:8`） |
| `values-v27/themes.xml:3-14` | `Theme.Material.Light.NoActionBar` | 增 `windowLightNavigationBar=true`（`:9`）、`navigationBarDividerColor=transparent`（`:10`） |
| `values-night-v27/themes.xml:3-14` | `Theme.Material.NoActionBar` | 同上但 light 两项均为 false（`:8-9`） |

三档/手势导航下的「真沉浸」实现细节不在本主题内，另有壳侧通道：`--dsh-android-system-bottom` 与 `--dsh-android-navbar-bottom` 拆分见 `docs/AGENTS/gotchas.md:3122-3136`（坑 385）。

#### 3.2.3 尺寸：`app/src/main/res/values/dimens.xml`（28 行）

| 行 | token | 值 |
|---|---|---|
| 3-11 | `ds_space_4/8/12/16/20/24/32/40/48` | 4/8/12/16/20/24/32/40/48 dp |
| 12 | `ds_radius_sm` | 8dp |
| 13 | `ds_radius_md` | 16dp |
| 14 | `ds_radius_card` | 18dp |
| 18 | `ds_radius_settings_card` | 12dp（注释 `:15-17`：与 WebView 侧 `.dsh-screen-control-card` 的 12px / 上游 `--dsw-radius-md` 同值；这一档原为缺位） |
| 19 | `ds_radius_pill` | 999dp |
| 20 | `ds_radius_icon` | 18dp |
| 21 | `ds_progress_height` | 5dp |
| 22 | `ds_logo_size` | 28dp |
| 23 | `ds_logo_shell` | 52dp |
| 24 | `ds_btn_height` | 52dp |
| 25 | `ds_btn_secondary_height` | 48dp |
| 26 | `ds_dot` | 8dp |
| 27 | `ds_guide_gutter` | 24dp |

**没有** dimens 里定义阴影/elevation，阴影是代码内 `elevation`（3.2.7）。

#### 3.2.4 drawable / anim / 图标资源

- `app/src/main/res/drawable/`：`dsh_ic_close.xml`(536B)、`dsh_ic_send.xml`(773B)、`dsh_ic_stop.xml`(587B)、`ic_management_gear.xml`(522B)、`repair_ic_back.xml`、`repair_ic_history.xml`、`repair_ic_model.xml` —— 全是矢量图标，**没有**卡片背景/毛玻璃类 drawable（卡片背景一律运行时 `GradientDrawable` 构造）。
- `app/src/main/res/drawable-nodpi/ic_launcher_foreground.png`（8504 B）：悬浮球内部的黑鲸图就是它（`OverlayService.kt:257-277`，裁剪 bbox (102,130)-(328,300)）。
- `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml:3-5`：adaptive icon，background=`@color/ic_launcher_background`，foreground/monochrome=`@drawable/ic_launcher_foreground`。
- `app/src/main/res/anim/picker_enter.xml:3-8`：选择器进场 220ms，`decelerate_quad`，alpha 0→1 且 translateY -6%→0。退场不用它（注释 `:2`：退场用 View 动画 + removeView）。

#### 3.2.5 启动页 Kotlin 侧硬编码（Splash*）

**`SplashOverlay.kt`（全屏开屏视频层）**

| 行 | 事实 |
|---|---|
| `:41-46` | `TextureView` MATCH_PARENT、`isOpaque = true`、`IMPORTANT_FOR_ACCESSIBILITY_NO`、不可点 |
| `:49-54` | 外层 `FrameLayout` 铺底 **`android.graphics.Color.BLACK`（#FF000000）**；注释 `:47-48` 说明 TextureView 不能带 background，黑底必须由外层给 |
| `:61` | `root.bringToFront()`——后挂宿主占位会盖住视频，视频必须最上层 |
| `:99` | 淡出 `alpha(0f)`，时长 `FADE_MS`，`withEndAction` 里才 removeView（先释放会闪黑，注释 `:98`） |
| `:204` | `FADE_MS = 260L` |
| `:132` | `media.setVolume(0f, 0f)` 静音契约 |
| `:129` | `isLooping = true` |
| `:191-201` | `CENTER_CROP` 用 `Matrix` 手算（cover 变换在纯函数 `SplashPolicy.coverTransform`，`SplashPolicy.kt:15-26`） |

**`SplashSettingsPage.kt`（原生「启动页管理」页）**

| 行 | 事实 |
|---|---|
| `:22-25` | 状态行 14sp + `ds_text_secondary`，上内边距 `dp(4)` |
| `:39-42` | body `LinearLayout` 竖排，padding L4/T8/R4/B16 dp |
| `:44` | 标题 24sp |
| `:45-51` | 说明 14sp |
| `:53-60` | 视频卡：`padding(20,16,20,12)` dp，背景 `DsUi.roundRect(ds_surface, dp(8))`，`topMargin=dp(8)` |
| `:61` | 卡内标题 16sp |
| `:67` | toggle 行（`:143-166`） |
| `:143-151` | toggle 行：padding(20,12,20,12)，`minimumHeight=dp(72)`，背景 `DsUi.ripple(roundRect(ds_surface, dp(8)), ds_accent_soft)`，`topMargin=dp(8)` |
| `:168-182` | 按钮：`isAllCaps=false`、`stateListAnimator=null`、`minimumHeight=dp(48)`、文字 `ds_text_primary`、背景 `ripple(roundRect(ds_surface_muted, dp(8)), ds_accent_soft)`、`topMargin=dp(8)` |
| `:184-190` | label：`textSize` 传入、色 `ds_text_primary`、padding 上下 `dp(6)`、`setLineSpacing(0f, 1.2f)` |
| `:122` | 禁用态 `remove.alpha = 0.45f`（**唯一一处硬编码透明度**） |
| `:198` | `dp(n) = n * density`，**不用 `resources.getDimension`，也不引用 dimens`** |

结论：SplashSettingsPage **完全不使用 `dimens.xml`**（只用颜色资源），尺寸以 `dp(数字)` 内联；新卡片若要与它并排一致，应改为引用 `R.dimen.ds_space_*`（已有等值档：20/16/12/8/4 全在）。

**`SplashStore.kt`**：无视觉，但有两条与「启动页感知时长」相关的事实——`MAX_BYTES = 50 MiB`（`SplashPolicy.kt:35`）、导入前后 `MediaMetadataRetriever` 读时长（`SplashStore.kt:147-161`）；视频文件落在 `filesDir/splash/`（`:19,23`），不受快照事务清理。

**`SplashToggle.kt`（自绘 pill 开关，155 行）**：

| 行 | 事实 |
|---|---|
| `:34-37` | 轨道 on=`ds_accent`、off=`ds_hairline`；滑块 on=`ds_bg`、off=`ds_surface` |
| `:45-47` | 触摸区 64×48dp（≥44dp 口径） |
| `:85-86` | 轨道绘制 56×32dp，圆角 = 高/2 |
| `:60-70` | 动效受 `DsUi.animationsEnabled` 门控；开启时 160ms `ValueAnimator` |
| `:42` | `setWillNotDraw(false)`（不清掉则完全不绘制，注释 `:40-41`） |

#### 3.2.6 `DsUi.kt` 原语与硬编码（241 行）

| 行 | 事实 |
|---|---|
| `:20` | `ease = PathInterpolator(0.32f, 0.72f, 0f, 1f)`（全壳统一缓动） |
| `:31-49` | `animationsEnabled`：三个 `Settings.Global` 缩放 + `ValueAnimator.areAnimatorsEnabled()`；`animationsEnabledFrom` 为纯函数（JVM 可测） |
| `:74-96` | `registerMotionListener`：单例 `ContentObserver`，三键任一翻转且**生效值翻转**才回调；返回注销句柄；最后一人注销时撤观察器 |
| `:143-152` | `roundRect(color, radius, strokeColor?, strokePx=1)` → `GradientDrawable` |
| `:154-157` | `oval(color)` |
| `:159-165` | `ripple(fill, rippleColor)` → `RippleDrawable`，mask 用 `0xFFFFFFFF`（`:161`，**唯一硬编码色**） |
| `:167-181` | `progressLayer(track, fill, radius)` → `LayerDrawable` + `ClipDrawable`，setId 到 `android.R.id.background/progress` |
| `:209-217` | `settingsCardBackground(context)`：`ds_surface` + `ds_radius_settings_card` + `ds_hairline` 1 物理像素描边（注释 `:183-207` 写明与 WebView `.dsh-screen-control-card` 的对应关系） |
| `:225-228` | `settingsCardPaddingPx`：四边 = `ds_space_12` |
| `:230-240` | `bindPressScale(view, scale=0.975f)`：按下 90ms、抬起 160ms，均用 `ease` |

#### 3.2.7 悬浮球/面板：**第二套色板**（与 ds_* 无关）

`OverlayTheme.kt:48-71`（`themeColors()`，明暗两档）：

| 字段 | 深色（`:50-58`） | 浅色（`:62-69`） |
|---|---|---|
| `unitBg` | `0xF21E1F24` | `0xF2F8F9FA` |
| `unitStroke` | `0xFF3A3D45` | `0xFFDADCE0` |
| `idleText` | `0xFF8A8F98` | `0xFF5F6368` |
| `offText` | `0xFFE04848` | `0xFFC5221F` |
| `clockText` | `0xFF81858C` | `0xFF5F6368` |
| `inputBg` | `0xFF2A2D33` | `0xFFFFFFFF` |
| `inputStroke` | `0xFF3A3D45` | `0xFFDADCE0` |
| `inputText` | `0xFFE8EAED` | `0xFF202124` |
| `inputHint` | `0xFF9AA0A6` | `0xFF80868B` |
| `divider` | `0xFF2A2D33` | `0xFFE8EAED` |
| `chevron` | `0xFF8AB4F8` | `0xFF5F6368` |
| `haloIdle` / `haloIdleFade` | `0x60FFFFFF` / `0x3AFFFFFF` | `0x8A3D3D3D` / `0x523D3D3D` |
| `recallStrip` | `0x99FFFFFF` | `0x993D3D3D` |

关键注释（可当设计依据直接引用）：`OverlayTheme.kt:21-31` 记录空闲光环按主题分档的**实测对比度**——浅色页 #FFFFFF + `0x8A3D3D3D` 合成 #969696 → 2.96:1；深色页 #1E1F24 + `0x60FFFFFF` 合成 #737373 → 3.48:1。`recallStrip` alpha 取 0x99（60%）的理由在 `:35-44`。

其他悬浮面硬编码（同一套 Google 风）：

| 位置 | 值 | 用途 |
|---|---|---|
| `OverlayService.kt:267` | `Color.WHITE` | 球体纯白 |
| `OverlayService.kt:70` | 球 34dp | 球窗尺寸=球尺寸（无空白吞区） |
| `OverlayService.kt:79,986` | `edgeMarginPx` = `BALL_EDGE_MARGIN_DP(8) * density` | 贴边最小边距、光环窗推导项 |
| `OverlayService.kt:83` | `haloSizeDp = ballSizeDp + 2*edgeMarginPx`（=50dp） | 光环窗 |
| `OverlayService.kt:347-350` | `panelWindowWidth()` = min(屏宽 − 球 − 64dp, 400dp) | 面板窗宽（每次重算，转屏不重建） |
| `OverlayService.kt:385` | 展开 `alpha 0→1`，**200ms** | 面板展开动效（无 spring） |
| `OverlayService.kt:424-427` | 收起 = `visibility=GONE` + `removeView` | **收起无动效**（非对称，见 3.10 待测） |
| `OverlayPanel.kt:424-426` | `unitBg` + `cornerRadius = 30dp` + 1dp `unitStroke` | 展开合体圆角矩形 |
| `OverlayPanel.kt:238-239` | 选择行 `roundRect(TRANSPARENT, 10dp, unitStroke)`，ripple `0x33FFFFFF/0x22000000` | 选择行 |
| `OverlayPanel.kt:266` | chip 底 `0xFF4176E6`，圆角 10dp | 工具计数徽标 |
| `OverlayPanel.kt:406,409` | 发送 `0xFF4176E6`、停止 `0xFFE04848` | 圆按钮 |
| `OverlayPanel.kt:1398-1399` | picker 窗：`0xF01E1F24`/`0xF0FFFFFF`，圆角 14dp，1dp 描边，`elevation = 6dp` | 会话选择器 |
| `OverlayPanel.kt:1428,1434,1494` | ripple `0x22FFFFFF`/`0x22000000` | 列表行 |
| `OverlayHalo.kt:35,43,44` | glow 半径 24dp；ring 2dp；ring 内缩 4.5dp | 光环几何 |
| `OverlayHalo.kt:121-131` | API 29+ 用四段 stop（0/0.45/0.74/1），26-28 退三等分 | 渐变**已有 API 分支的既有先例** |
| `OverlayHalo.kt:223-226` | `IDLE 0x60FFFFFF/0x3AFFFFFF`、`WORKING 0xAA5C84FF/0x665C84FF`、`PENDING 0xCDEBBE3C/0x7BEBBE3C`、`ERROR 0xA0E04848/0x60E04848` | 光环四态 |
| `OverlayHalo.kt:161-167` | WORKING 1100ms 呼吸、PENDING 900ms（alpha 到 0.55），受动效门控 | 脉冲 |
| `OverlayRecall.kt:138` | 召回条高 44dp（`MIN_TOUCH_TARGET_DP`），宽 8dp | 贴边条 |
| `OverlayReport.kt:254` | 报告栏宽 = 屏宽−32dp，封顶 440dp、下限 200dp | 报告栏 |
| `OverlayReport.kt:151` | `elevation = 8dp` | 报告栏 |
| `OverlayReport.kt:503` | `MIN_TOUCH_TARGET_DP = 44` | 全壳触摸目标下限 |

#### 3.2.8 字体

- **没有 `res/font/`**（`res` 下只有 anim/drawable/drawable-nodpi/mipmap-anydpi-v26/values*/xml），即所有文字用系统默认 family。
- 唯一「品牌字重」入口：`GuideChrome.kt:84` `typeMedium() = Typeface.create("sans-serif-medium", Typeface.NORMAL)`；等宽用 `GuideChrome.kt:362` `Typeface.MONOSPACE`。
- 悬浮面板不引用上述 helper，直接用 `setTypeface(null, Typeface.BOLD/NORMAL)`（`OverlayPanel.kt:230,250,277,753,828,874,1492`、`OverlayReport.kt:61,96`）。**新卡片若要保持「气泡/面板」观感一致，用 BOLD/NORMAL 即可；若要与引导页/设置页一致，用 `sans-serif-medium`。**
- 字号档位：启动页 24/16/14/13sp（`SplashSettingsPage.kt:44,61,22,45,68,160`）；悬浮面板 13/12/11sp（`OverlayPanel.kt:229,249,264,275`）；引导页与 WebView 侧对齐说明见 `GuideManagementController.kt:100-136`（14sp ↔ 14px、12sp/18sp line-height ↔ 12px/18px）。

#### 3.2.9 动效时长与门控一览（Phase 2 必须复用现门控）

| 动效 | 时长/参数 | 位置 | 受 `DsUi.animationsEnabled` 门控 |
|---|---|---|---|
| 面板展开 | 200ms alpha | `OverlayService.kt:385` | 否（**未门控**：200ms 一次性，非 INFINITE） |
| 面板收起 | 无 | `OverlayService.kt:424-427` | 不适用 |
| 开屏视频淡出 | 260ms | `SplashOverlay.kt:99,204` | 否（一次性） |
| 选择器进场 | 220ms | `anim/picker_enter.xml:4` | 否（WMS 原生） |
| 按压缩放 | 90ms / 160ms，scale 0.975 | `DsUi.kt:234-236` | 否 |
| pill 开关 | 160ms | `SplashToggle.kt:66` | **是**（`:60`） |
| 光环呼吸（WORKING/PENDING） | 1100ms / 900ms INFINITE | `OverlayHalo.kt:161-167` | **是**（`:167`） |
| 面板待答呼吸 | INFINITE | `OverlayPanel.kt`（`MotionGateContractTest.kt:107-112` 登记） | **是** |
| 状态行扫光 | INFINITE | `ShimmerTextView.kt`（同上登记） | **是** |
| 引导页状态点脉冲 | INFINITE | `GuidePageRenderer.kt:723-725`（`setStatusPulse`） | **是** |

**硬约束**：任何新的常驻动画（INFINITE）都必须同时满足 `app/src/test/java/com/dsharnessmobile/shell/MotionGateContractTest.kt:104-130` 的两条——① 判 `DsUi.animationsEnabled`；② 订阅 `DsUi.registerMotionListener`。四落点清单写死在 `:107-112`。新卡片若加常驻动效，必须把文件加进该表，否则门禁不会守它。

---

### 3.3 可复用 design token 清单（新悬浮卡片能否直接用）

「直接用」= 不改任何资源/常量即可引用；「需新增」= 现值语义不符；「不可用」= 有结构性冲突。

| token 名 | 值 | 来源（文件:行） | 新悬浮卡片可否直接复用 |
|---|---|---|---|
| `ds_surface` | #FFFFFF / #1C1C1E | values/colors.xml:9；values-night/colors.xml:5 | **可**（卡片面首选） |
| `ds_surface_muted` | #F5F5F7 / #2C2C2E | :10 / :6 | 可（次级面/按钮底） |
| `ds_hairline` | #1A000000 / #2EFFFFFF | :14 / :10 | **可**（1px 描边，配合 `DsUi.settingsCardBackground`） |
| `ds_border` | #14000000 / #26FFFFFF | :13 / :9 | 可（更弱的边界） |
| `ds_chip` | #F2F2F4 / #2C2C2E | :11 / :7 | 可（小徽标底） |
| `ds_text_primary` | #1D1D1F / #F5F5F7 | :15 / :11 | **可** |
| `ds_text_secondary` | #6E6E73 / #98989D | :16 / :12 | **可** |
| `ds_text_tertiary` | #86868B / #6E6E73 | :17 / :13 | 可 |
| `ds_accent` | #1D1D1F / #F5F5F7 | :19 / :15 | 可（黑白 accent，注意与悬浮面板蓝冲突） |
| `ds_accent_soft` | #0D000000 / #1EFFFFFF | :21 / :17 | **可**（ripple 色，与 `DsUi.ripple` 默认搭配） |
| `ds_scrim` | #E6F5F5F7 / #E6000000 | :27 / :23 | **可**（90% 不透明遮罩，是 31 以下「毛玻璃替代」的现成底） |
| `ds_progress_track` | #14000000 / #2EFFFFFF | :26 / :22 | 可（配 `DsUi.progressLayer`） |
| `ds_ok/warn/danger` | #34C759/#FF9500/#D70015 | :22-24 | 可——但仅语义信号，不得用于铬面 |
| `ds_radius_settings_card` | 12dp | dimens.xml:18 | **可**（与 WebView 设置卡同值，跨入口肉眼可比） |
| `ds_radius_card` | 18dp | dimens.xml:14 | 可（更大的卡） |
| `ds_radius_md` | 16dp | dimens.xml:13 | 可 |
| `ds_radius_sm` | 8dp | dimens.xml:12 | 可（现有设置页按钮/卡就用它） |
| `ds_radius_pill` | 999dp | dimens.xml:19 | 可（药丸/chip） |
| `ds_space_4/8/12/16/20/24` | 4/8/12/16/20/24dp | dimens.xml:3-8 | **可**（SplashSettingsPage 的 4/8/16/20 内联值全部有对应档） |
| `ds_btn_height` / `ds_btn_secondary_height` | 52dp / 48dp | dimens.xml:24-25 | 可 |
| `MIN_TOUCH_TARGET_DP` | 44 | OverlayReport.kt:503 | **可**（新卡片可点区域下限，跨包内引用需 `OverlayReport.MIN_TOUCH_TARGET_DP`） |
| `DsUi.roundRect / oval / ripple / progressLayer` | — | DsUi.kt:143,154,159,167 | **可**（唯一 drawable 构造入口，勿自写 GradientDrawable） |
| `DsUi.settingsCardBackground / settingsCardPaddingPx` | — | DsUi.kt:209,225 | **可**（与设置页卡片逐像素同规格） |
| `DsUi.ease` | Path(0.32,0.72,0,1) | DsUi.kt:20 | **可** |
| `DsUi.bindPressScale` | 0.975 / 90/160ms | DsUi.kt:230 | 可 |
| `DsUi.animationsEnabled/registerMotionListener` | — | DsUi.kt:31,74 | **必须用**（常驻动效门控） |
| `OverlayTheme.ThemeColors.unitBg` | 0xF21E1F24 / 0xF2F8F9FA | OverlayTheme.kt:50,62 | 需决策：与 `ds_surface` 语义重叠但值不同（半透明 + 蓝灰），**并存会出现两种卡片面** |
| `OverlayPanel` 的 `#4176E6` 品牌蓝 | — | OverlayPanel.kt:266,406 | **需新增 token**：当前是散落字面量，不是资源；新卡片若要用蓝必须收敛为具名常量/资源，否则第三份副本 |
| `OverlayHalo` 的 4 态 ARGB | — | OverlayHalo.kt:223-226 | 不可复用为卡片色（且被 I-A3 反证表锁死在 `Halo` 枚举块内） |
| 阴影强度 | 无 token | OverlayPanel.kt:1399(6dp)/OverlayReport.kt:151(8dp)/VdisplayHost.kt:346(16f) | **需新增**：三处硬编码且量纲不一（dp vs float），新卡片应新增 `ds_elevation_*` |

**结论（可直接施工的取舍）**：新悬浮卡片走 `ds_*` 色板 + `DsUi.settingsCardBackground` 是最省事且不引入第三套配色的路径；但它与现有悬浮面板（`unitBg` 半透明、圆角 30dp、Google 蓝）**观感不一致**。二选一必须在 Phase 1 拍板：① 新卡片 = 设置页风格（`ds_*`，12dp 圆角，1px hairline）；② 新卡片 = 面板风格（`unitBg`，30dp 圆角，品牌蓝，需先把蓝收敛成 token）。**不要混用**。

---

### 3.4 毛玻璃与模糊可行性

#### 3.4.1 API 事实（本机 Android SDK 取证，非网络说法）

证据文件：`D:\Android\Sdk\platforms\android-36\data\api-versions.xml`（compileSdk 36 对应平台，本机存在 android-34/35/36/36.1 四套）。命令与输出摘录见证据附录 E3。

| API | 起始等级 | 证据行 | 说明 |
|---|---|---|---|
| `android.graphics.RenderEffect` 类 | **31** | api-versions.xml:20800 | 类本身 31+ |
| `RenderEffect.createBlurEffect(F,F,Shader$TileMode)` | **31** | :20806 | 位图/内容模糊 |
| `View.setRenderEffect(RenderEffect)` | **31** | :72323 | |
| `RenderNode.setRenderEffect(RenderEffect)` | **31** | :20875 | |
| `WindowManager.LayoutParams.setBlurBehindRadius(I)` | **31** | :73737 | 跨窗口背景模糊的唯一 API |
| `WindowManager.LayoutParams.getBlurBehindRadius()` | **31** | :73726 | |
| `android:windowBlurBehindRadius` 主题属性 | **31** | :1961 | |
| `WindowManager.isCrossWindowBlurEnabled()` | **31** | :73670 | 设备/系统是否允许跨窗口模糊 |
| `WindowManager.addCrossWindowBlurEnabledListener` | **31** | :73663 | 运行期监听开关变化 |
| `WindowManager.LayoutParams.FLAG_BLUR_BEHIND` | 无 since（API 1 遗留） | :73763 | 老 flag 仍存在，但真正生效的模糊半径由 31+ 的 `setBlurBehindRadius` 决定 |
| `android.graphics.BlurMaskFilter` | **1** | :19289 | 仅作用于 `Paint` 阴影/描边的**掩膜**模糊，**不是**背景模糊 |
| `WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY` | **26** | :73832 | 现有全部 overlay 窗口用的就是它 |
| `TYPE_PHONE` | deprecated **26** | :73843 | 8.0 起废弃 |
| `Settings.canDrawOverlays` | 23 | :54651 | |
| `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` | 23 | :54702 | |
| `ValueAnimator.areAnimatorsEnabled()` | **26** | :5432 | 与 minSdk 26 恰好对齐 |
| `PowerManager.isPowerSaveMode` | 21 | :50003 | |
| `PowerManager.isIgnoringBatteryOptimizations` | 23 | :50000 | |

**平台语义（标注为推断/需设备验证，不作为结论）**：

- 推断 1（依据 RenderEffect 的 API 形状：它挂在 `View`/`RenderNode` 上）：`RenderEffect` 只能处理**本窗口自己渲染的内容**，无法采样「窗口背后其他应用」的像素。因此「卡片背后 App 内容毛玻璃」**不能**用 `RenderEffect` 实现；它只能用来模糊卡片内部的子视图（例如把卡片内一张背景图模糊）。
- 推断 2：跨窗口背景模糊（真正看到背后 App 的模糊）只有 `setBlurBehindRadius` + `FLAG_BLUR_BEHIND` 一条路，且 31+；是否对 `TYPE_APPLICATION_OVERLAY` 窗口生效、半径上限、以及设备是否开启，都**需设备验证**（验证方法见 3.4.3）。
- 事实（仓库内可查）：模糊是系统级开关，能被关闭——`app/src/test/resources/screen-scope/screen-scope-cases.json:1329-1336` 记录 `wm disable-blur true` 写 `Settings.Global` 的 blur 开关，且该命令被 screen-scope 判为「操作真实屏显示效果」而拒绝。说明「模糊可能被系统/用户关掉」是既有认知，且 `isCrossWindowBlurEnabled()`（31+）就是这个开关的读口。

#### 3.4.2 minSdk 26 / targetSdk 34 下的三档降级路径

| 档位 | 条件 | 实现 | 视觉一致性 |
|---|---|---|---|
| **A 档：真模糊** | API 31+ **且** `isCrossWindowBlurEnabled()==true` | `lp.flags |= FLAG_BLUR_BEHIND`；`lp.setBlurBehindRadius(dp(20))`；卡片背景用**半透明**（如 `ds_scrim` 或 `unitBg`） | 最佳；需实测半径与功耗 |
| **B 档：伪毛玻璃** | API 26-30（**占 minSdk 覆盖的绝大部分**）或 31+ 但模糊被关 | 不做模糊：卡片背景 = 半透明纯色（现成 `ds_scrim` #E6F5F5F7 = 90% 不透明 / dark #E6000000）+ 1px `ds_hairline` 描边 + `elevation`；必要时叠一层低频噪点 drawable（**当前仓库没有**，需新增） | 与 A 档不同但可接受；因为 `ds_scrim` 已接近不透明，差异很小 |
| **C 档：彻底不透明** | 低端机/省电模式/模糊关闭 | 直接用 `ds_surface`（不透明卡片） | 最稳；推荐作为**默认档**，A 档作为增强 |

重要判断：`ds_scrim` 的 alpha 已经是 0xE6（90.2%），意味着「毛玻璃底」在本仓现有设计里**本来就不是透明材质**，A 档能带来的视觉增量有限，而成本（跨窗口模糊的绘制开销、31 以下无解、系统开关不确定性）全部要付。**若 Phase 1 目标只是「卡片有层次」，用 elevation + hairline + 半透明纯色即可，不必上 blur。** 这一条建议的量化前提（blur 的帧成本）需 Phase 2 实测（3.7）。

#### 3.4.3 必须设备验证的具体项（写成待测，不写成结论）

1. `dumpsys window` 里给本包 overlay 窗口设置 `setBlurBehindRadius` 后，`mAttrs` 是否出现非零 blur 半径、屏幕上是否真的出现背景模糊（API 31/33/34/35/36 各一台）。
2. `WindowManager.isCrossWindowBlurEnabled()` 在用户开启「移除动画/降低透明度」类无障碍设置时的返回值。
3. 模糊开启后悬浮面板展开 200ms 期间的帧耗时 delta（用 3.6 方法测）。
4. 31 以下（26/28/30）上 `FLAG_BLUR_BEHIND` 是否被静默忽略（不应崩溃；需确认不抛异常）。
5. 功耗：模糊常驻（面板长时间展开）时 `/proc/<pid>/stat` 的 CPU 增量。

---

### 3.5 当前性能基线与既有度量点

#### 3.5.1 已有基线数字（全部来自仓库内既有产物）

**启动链（引擎侧，n=24 批次，MuMu x86_64）**

| 指标 | 数字 | 来源 |
|---|---|---|
| 冷启动事件循环 p99 (loader-settle 窗口) | min 1371.4 / median 1811.8 / p75 2533.4 / p90 4709.4 / max 6260.6 ms | `scripts/check-boot-budget.mjs:53-57` |
| 同上阈值（回归哨兵） | `LOOP_P99_BUDGET_MS = 7200`（max×1.15） | `scripts/check-boot-budget.mjs:76` |
| 同批分解：compose 单次 | 4-22 ms；调用数恒 2 | `scripts/check-boot-budget.mjs:60,107` |
| 同批分解：constructor-flush（本仓） | 37.7-552.8 ms | `scripts/check-boot-budget.mjs:61` |
| 同批分解：loader-settle-wait（支配项，上游） | 1532.5-7288.1 ms | `scripts/check-boot-budget.mjs:62` |
| C1：LISTEN→首个 HTTP 观测差预算 | 4000 ms | `scripts/check-boot-budget.mjs:95` |
| C2：单次同步块预算 | 2000 ms | `scripts/check-boot-budget.mjs:83` |
| 真机 boot-segments 样本（2 次冷启） | `t_listen_ms=5408 / t_first_http_ms=7461`；`t_listen_ms=4480 / t_first_http_ms=5237`；同机 `engineHeapMb=2971` | `docs/perf/parts/startup-memory.md:220-221` |
| C-07 结论 | 本仓冷启动可控上界 ~550ms（最坏）/ ~100ms（典型），占 1.8s 窗口约 5% | `docs/perf/parts/startup-memory.md:207-211` |

**首屏注入层（WebView JS）**

| 指标 | 数字 | 来源 |
|---|---|---|
| 首屏 bundle 体量 | 68 个 client bundle，raw 11.23 MiB / gzip(level1) 5.21 MiB | `docs/perf/AUDIT-2026-11-02.md:170` |
| 单包（settings-account） | raw 5,282,386 B（首屏 44.9%）/ gzip 3,849,116 B（70.5%），96.2% 是内联 base64 位图 | `docs/perf/AUDIT-2026-11-02.md:171` |
| 本仓自有首屏 JS | 5 个包 / 413.8 KiB / 3.6% | `docs/perf/AUDIT-2026-11-02.md:174` |
| `dsh-client-ui-responsive/lib/client.js` | raw 1,002,801 B / gzip 299,140 B（v0.14.10 对照 raw 822,297 / gzip 238,947） | `docs/contrib/kelai141/2026-11-06-ui-frame-budget.md:39-41` |
| 每批 DOM 整文档查询 | 10.00 → 1.00 次/批（修复后） | 同上 `:11,147-149` |
| 滚动帧整文档查询（无弹层） | 4.00 → 0.00 次/帧 | 同上 `:12,169` |
| 静止跨语言桥调用 | 1 次/秒 → 0 次/秒 | 同上 `:13` |

**运行时 IO / 唤醒**

| 指标 | 数字 | 来源 |
|---|---|---|
| `audit.ndjson` 单条追加 | 274.2 us/record（open+write+close）；常驻句柄 24.5 us（A/B=11.2x） | `docs/perf/AUDIT-2026-11-02.md:180` |
| 常驻周期唤醒 | 6 处 / 307 次每分钟，其中 3 处无后台门控（后台 135 次/分钟） | `docs/perf/AUDIT-2026-11-02.md:182` |
| 日志轮转 | 默认 0 处周期写盘 | `docs/perf/AUDIT-2026-11-02.md:183` |

**交互实测量（唯一与「每帧」直接相关的一条，来自真机/模拟器）**

| 指标 | 数字 | 来源 |
|---|---|---|
| 单次同步 AIDL 往返 | 24.4 ms/次（`tabState` 20 次均摊） | `docs/AGENTS/gotchas.md:2512` |
| 旧实现在「页面 JS 忙等」窗口内 `dispatchTap` | 阻塞 81.9 ms 才返回 | 同上 |
| 一次滑动 22 条触摸 → 旧同步路径下界 | 约 0.54 s（忙时 issue 复现者数据约 180ms/次 ≈ 4s） | 同上 `:2501,2512` |
| 改造后宿主主线程阻塞 | `delayacct_blkio_ticks` 增量 **0**（5 次滑动期间 utime 0.19s） | 同上 `:2511` |

#### 3.5.2 仓库内已有度量点（Phase 2 应复用，不要新造）

| 度量点 | 落点 | 产物/口径 |
|---|---|---|
| 冷启动四段（引擎侧） | `LogCollector.kt:262-293`（`dsh-boot-segments` 行：`t_boot_start/t_listen/t_first_http/t_compose_total`） | `files/boot-segments.log`；判据由 `scripts/check-boot-budget.mjs` 消费 |
| 冷启动四段（**壳侧细分**，默认关闭） | `BootPhaseTrace.kt:42-45`（`onCreate/webviewConstruct/snapshotExtract/loaderSettle`）；开关 = 开发者调试偏好（`:63-72`） | `files/boot-phase-trace.log`，单次启动 ≤4 行、64KiB 轮转（`:36-39`） |
| 引擎 LISTEN 观测 | `EngineManager.kt:1924-1931,3685-3704`（有界轮询，量化误差 [0,500)ms 已消除，步长 20/20/30/45/67/100…） | 进入 boot-segments |
| compose 探针 | `scripts/perf/count-compose.mjs`（9,292 B） + `LogCollector` 的探针 tail（`LogCollector.kt:314,336`） | `t_compose_total` |
| 冷启+稳态 CPU/内存 | `scripts/perf/measure-steady.ps1`（见 3.6） | k=v 行 |
| 注入层帧/longtask/跨桥/启动分段 | `scripts/verify-frame-timing.mjs`（见 3.6） | 控制台 + `--json` |
| 首屏 prelude 分段 | `docs/BOOT-PRELUDE-SEGMENTS-2026-11-10.md`（文档已存在） | 待查阅该文档口径 |
| 执行顺序/观测点账本 | `docs/AGENTS/EXECUTION-MAP.md:485`（K02：`files/boot-segments.log` 是该门禁唯一产物，`:LogCollector.kt:405-434`）、`:600,602`（B02 依赖）、`:1977`（check-boot-budget 判据摘要） | — |

#### 3.5.3 缺口（明确证否）

- **帧级指标完全没有埋点**：`grep -rn "FrameMetrics|JankStats|Choreographer|Trace.beginSection|Debug.startMethodTracing|systrace" app/src` → **0 命中**（证据附录 E4）。因此不存在「掉帧率 / 帧耗时 p50/p95 / 帧率」的任何既有基线。
- `dumpsys gfxinfo` 全仓只在 `docs/contrib/cmyfqwq/2026-10-28-screen-scope-dumpsys-activity.md:63` 被提到（且是说它仍被 allow）。**从未被任何脚本或文档用作基线采集手段**。
- 悬浮球/面板的展开动画时长只有**名义值**（200ms，`OverlayService.kt:385`），**没有实测分布**。
- 触摸到可见的延迟：**无任何度量点**。
- 结论：**仓库内既有的性能基线全部在启动链、注入层 JS 与 IO/唤醒面；悬浮交互链（拖动、展开、输入、渲染）的帧级基线为零**。

---

### 3.6 可执行、只读的测量方案（Phase 2 直接照跑）

前置约定：全部命令**只读**（不写仓库、不改设备设置）；每条都写明指标定义与采集口径。设备序列号用 `<serial>`（AGENTS.md §2 的两台模拟器 / 一台真机）。

#### 3.6.1 已有脚本（首选，零新增）

**① 冷启动 + 稳态 CPU + 内存（`scripts/perf/measure-steady.ps1`）**

```powershell
pwsh -File scripts/perf/measure-steady.ps1 -Serial <serial> -Label overlay-p2-a [-IdleSec 30]
pwsh -File scripts/perf/measure-steady.ps1 -DryRun -Label smoke   # 离线自检：只打印将执行的命令
```

口径（脚本头注释 `scripts/perf/measure-steady.ps1:4-8`）：

- 引擎就绪 = **设备自身** `/proc/net/tcp` 出现 `0100007F:0C08 ... 0A`（127.0.0.1:3080 LISTEN）；**禁用 `adb forward` 判定**（避免「转发通了」的假阳性）。
- 稳态 CPU = 引擎 node 进程 `/proc/<pid>/stat` 的 utime+stime 差分（USER_HZ=100 → 1 tick=10ms），公式见 `:80`。
- 输出 k=v：`engineListenMs` / `idleCpuPercent` / `threads` / `rssMiB` / `rssPeakMiB`（`:36-38`）。
- 局限：**只测引擎 node 进程**，不测壳进程（`com.dsharnessmobile.shell`）。悬浮交互的性能在**壳进程**，所以 Phase 2 必须按 3.6.2 补壳进程口径。

**② 注入层帧耗时 + 常驻代价 + 启动分段（`scripts/verify-frame-timing.mjs`）**

取 ws（`scripts/verify-frame-timing.mjs:21-23`）：

```powershell
adb shell "cat /proc/net/unix | grep webview_devtools"
adb -s <serial> forward tcp:29225 localabstract:webview_devtools_remote_<pid>
node -e "fetch('http://127.0.0.1:29225/json/list').then(r=>r.json()).then(j=>console.log(j[0].webSocketDebuggerUrl))"
node scripts/verify-frame-timing.mjs --ws <ws-url> --json .deploy-tmp/ovl-p2/frames-a.json
node scripts/verify-frame-timing.mjs --self-test      # 无设备自检（10 例）
```

三组指标定义（脚本头 `:7-14`）：

| 组 | 指标 | 定义 |
|---|---|---|
| A | `p50/p95/max` 帧间隔、`over50`、`longTasks`、`blockedMs`、`verdict` | 120 帧 rAF 序列，每帧滚 40px（`SCROLL_PROBE`，`:112-130`）；`verdict` 三档机械判定在 `summarizeFrames`（`:51-73`）：`main-thread`（有 longtask 且阻塞≥50ms）/ `renderer`（p95>50ms 且 longtask=0）/ `smooth` |
| B | `calls`、`perSecond`、`blockedMs`、`blockedShare`、`worstMs`、`actions` | 5s 窗口内 `window.androidBridge.browserHostCommand` 的调用次数与每次 `performance.now()` 差值（`IDLE_PROBE`，`:133-150`） |
| C | `domContentLoadedMs`、`loadMs`、`firstPaintMs`、`injectionMarkerMs`、`markerAfterFirstPaintMs` | navigation/paint/mark 三段（`STARTUP_PROBE`，`:153-170`）；「启动到可交互」的代理量 = 首绘→注入标记 |

注意：该脚本**只覆盖 WebView 内部**（注入层）。它**测不到**原生悬浮球/面板的帧耗时——那是本方案的缺口，见 3.6.2。

#### 3.6.2 需要新写的口径（仍是只读命令，Phase 2 落地为脚本）

以下命令都是 `adb shell` 只读查询，可直接粘。**指标定义先写死，避免各人各自解释。**

**A. 壳进程常驻 CPU / 内存（补 measure-steady 的缺口）**

```bash
# 1) 壳进程 pid
adb -s <serial> shell pidof com.dsharnessmobile.shell
# 2) 内存
adb -s <serial> shell cat /proc/<pid>/status | grep -E 'VmRSS|VmHWM|Threads'
# 3) CPU ticks（utime=14, stime=15 字段，USER_HZ=100）
adb -s <serial> shell cat /proc/<pid>/stat
```

- 指标定义：`shellIdleCpuPercent = (Δ(utime+stime) * 10ms) / Δt * 100`，静止窗口 30s，**面板收起态**与**面板展开态**各采一次（这样才分得清「常驻成本」与「展开成本」）。
- 采集口径：先 force-stop 再冷启，等引擎 LISTEN 后用 `measure-steady.ps1` 同款等待法，静止 30s 采两次 stat 差分。
- 现状：**无基线**，Phase 2 首测。

**B. 面板展开/收起的帧表现（`dumpsys gfxinfo`）**

```bash
adb -s <serial> shell dumpsys gfxinfo com.dsharnessmobile.shell reset
# 执行一次「点球 → 面板展开 → 收起」的 tap 序列（input tap 坐标由当前球位算）
adb -s <serial> shell input tap <x> <y>
adb -s <serial> shell dumpsys gfxinfo com.dsharnessmobile.shell
```

- 指标定义：
  - `jankyPct` = `Janky frames` / `Total frames`（系统口径，>16.67ms 帧占比）；
  - `p50/p90/p95/p99` 帧耗时 = 从 `framestats` 段的 `FLAGS`+时间戳自算，或直接读 `dumpsys gfxinfo ... framestats` 的 CSV 行（每行一次绘制，含 `IntendedVsync`/`FrameCompleted`）；
  - `expandJankyFrames` = 上面 reset→tap→dump 窗口内的 Janky 增量（**只含本次交互**，因为 reset 清计数）。
- 采集口径：**同一次测量只做一次交互**（reset 是全局计数）；每个方向（竖/横）各 5 次取中位；必须固定动画缩放（`settings get global animator_duration_scale`）后记录，否则跨轮不可比。
- 现状：**无基线**；本仓从未用过 `gfxinfo`。

**C. 悬浮窗口清单与面积（`dumpsys window`）**

```bash
adb -s <serial> shell dumpsys window windows | grep -E 'Window #|mOwnerUid|ty=2038|mFrame|isVisible'
```

- 指标定义：`overlayWindowCount`（本包 `ty=2038` 窗口数）、`overlayVisibleAreaPx2`（各窗口 frame 面积和，**用于抓「隐形触摸黑洞」回归**——窗口在但不可见时面积仍计入）。
- 现状数字可推断（代码事实，非实测）：常驻 3 个（球 + 光环 + 隐藏态召回条按需）；展开再 +1（面板）；picker / report 懒建各 +1（`OverlayService.kt:284,310,369`、`OverlayPanel.kt:1447`、`OverlayRecall.kt:67`、`OverlayReport.kt:270`）。
- 判据意义：对应坑 328（`docs/AGENTS/gotchas.md:2469-2474`）——「隐藏 = removeView，不是 alpha=0/GONE」。

**D. 触摸到响应延迟（`input` + logcat 时间戳）**

```bash
adb -s <serial> logcat -c
adb -s <serial> shell input tap <x> <y>
adb -s <serial> logcat -d -v time | grep -E 'dsh-overlay|Input dispatching'
```

- 指标定义：`touchToVisibleMs` = 触摸事件 `eventTime`（可用 `getEventTime()` 在调试埋点里取，**Phase 1 不允许改代码** → 现阶段只能用 logcat 时间戳近似：`input` 命令完成时刻 → 面板首条渲染日志时刻）。**明确标注为近似量，误差量级为 adb input 往返 + 日志时延（数十 ms）**。
- 更准的做法（Phase 2 允许改代码后）：在 `attachBallTouch` 的 ACTION_DOWN 记 `SystemClock.uptimeMillis()`、在 `showPanel` 的 `unit.post{positionPanel()}` 里记第二次，差值落 `LogCollector`。**Phase 1 只能写成待测项**。

**E. 引擎侧冷启动（既有，Phase 2 只做对照）**

```bash
adb -s <serial> shell am force-stop com.dsharnessmobile.shell
adb -s <serial> shell am start -W -n com.dsharnessmobile.shell/.MainActivity
adb -s <serial> shell run-as com.dsharnessmobile.shell cat files/boot-segments.log
node scripts/check-boot-budget.mjs --segments <拉回的 boot-segments.log> --probe <引擎探针输出> --require
```

- 口径见 `scripts/check-boot-budget.mjs:20-22`（`--require` 档；默认档无设备只 SKIP）。
- 注意：`t_listen` 与 `t_first_http` 来自两条不同采样器，差值是**观测差**不是服务端首字节时间（`:85-94` 明确警告不得把观测差描述成同步阻塞）。

#### 3.6.3 不建议的测法（避免假绿，写清原因）

| 测法 | 为什么不行 |
|---|---|
| 只看 `am start -W` 的 `TotalTime` 当「启动快慢」 | `scripts/build-apk-dev-fast.mjs:177-178` 记录过：它测的是 Activity，不是引擎，`Status: ok` + 合理 TotalTime 时引擎可能根本没起来 |
| 用 `adb forward` 判引擎就绪 | 脚本头注释明确禁用（`scripts/perf/measure-steady.ps1:5-6`） |
| 用 `check-release-gates.mjs --run` 取门禁基线 | 它在第一条非零退出即中止（`docs/perf/AUDIT-2026-11-02.md:190`） |
| 用单轮绝对墙钟跨轮比较 | AUDIT `:48` 实测同一 xz 解码从 19.4s 漂到 39.1s（2.0x）；<2x 的差异不可信 |
| 把「静态代码里有 N 处 querySelector」当帧耗时 | 只是代理量，见 `docs/contrib/kelai141/2026-11-06-ui-frame-budget.md:68-79` 的口径（数调用次数，不读源码字符串） |

---

### 3.7 Phase 1 无法测得的部分（待测清单，不得编数字）

本轮受约束未跑任何设备/模拟器命令，也未改代码加埋点。以下**全部是待测项**：

| 编号 | 待测项 | 为什么现在测不了 | 需要的采集手段 |
|---|---|---|---|
| T1 | 悬浮球拖动 60/120Hz 下的帧间隔 p50/p95 | 无设备；无原生帧埋点 | 3.6.2-B（gfxinfo framestats）或 Phase 2 加 `Choreographer` 埋点 |
| T2 | 面板展开 200ms 动画的实际掉帧率 | 同上 | 3.6.2-B，与 T1 同窗口 |
| T3 | 展开/收起是否对称（收起无动画）是否是观感缺陷 | 需要人眼/录屏 | `screenrecord` + 逐帧 |
| T4 | 触摸到面板可见的真实延迟 | 无埋点（Phase 1 禁改码） | 3.6.2-D（近似）+ Phase 2 精确埋点 |
| T5 | 壳进程常驻 CPU/内存（收起态/展开态） | 无设备 | 3.6.2-A |
| T6 | 毛玻璃（3.4）在 26-36 各档的真实效果与功耗 | 无设备；且需满足 31+ 才可测 A 档 | 3.4.3 五项 |
| T7 | 边缘手势与拖球的冲突率 | 需手势导航设备逐 ROM | 竖/横 + 两支新手势 ROM，`input swipe` 从边缘起手 |
| T8 | 输入法弹起时面板/球的位移是否符合预期 | 需设备；且 MuMu 常有硬键盘导致软键盘不弹（`docs/AGENTS/gotchas.md:108-118`） | `dumpsys input_method` 的 `mInputShown` 复判 + 截图 |
| T9 | 隐藏态召回条的可发现性（对比度/命中） | 需人眼与设备 | 截图 + `uiautomator` 边界 |
| T10 | 真机 arm64 上的帧表现（现有基线全来自 MuMu x86_64） | AUDIT `:338` 明确登记「真机冷启动分布缺失」 | 真机补同口径 |
| T11 | 31 以下设备上 `FLAG_BLUR_BEHIND` 的实际行为 | 无 26-30 设备 | API 26/28/30 各一台 |
| T12 | 面板展开时 WebView 侧帧率是否被拖累 | 需同时采两进程 | 3.6.1-②（注入层）+ 3.6.2-B（原生）同轮对齐时间戳 |

---

### 3.8 已知性能问题（仓库内实锤，逐条）

| # | 问题 | 关键数字 | 路径 |
|---|---|---|---|
| P1 | **每帧触摸路径上的同步 Binder**：tier-2 浏览器档旧实现一次滑动约 22 次同步 AIDL 往返，把渲染进程忙传导成主线程阻塞，偶发 ANR | 单次往返 24.4ms；一次滑动下界约 0.54s（忙时约 4s）；issue #540 实测单事件约 180ms | `docs/AGENTS/gotchas.md:2499-2513`（坑 343）；修法 = `forwardMotion` 改 oneway + `MotionCoalescer`（`MotionCoalescer.kt:1-15`，容量 64，连续 MOVE 合帧） |
| P2 | **「看不见」不等于「不在」**：overlay 窗口 `alpha=0`/`GONE` 仍是触摸黑洞，球周围约 2940dp² 空白吞掉下层手势 | — | `docs/AGENTS/gotchas.md:2469-2474`（坑 328）；修法 = `removeView`；复验 `CallSiteContractTest.hidingRemovesBothWindowsInsteadOfFadingThem` |
| P3 | **动效不随系统开关停**：4 个 INFINITE 动画只在启动那一刻判一次，144Hz 设备上永不空闲 | 4 处：光环/面板待答/扫光/引导页脉冲 | `DsUi.kt:58-73`（注释写明真因）；门禁 `MotionGateContractTest.kt:104-130` |
| P4 | **常驻周期唤醒 307 次/分钟**，其中 3 处无后台门控（后台 135 次/分钟） | 6 处唤醒源 | `docs/perf/AUDIT-2026-11-02.md:182`；Top5 第 4 项（加 `document.hidden` 门）见 `:31` |
| P5 | `audit.ndjson` 每条 open+write+close 且**全仓唯一无上限** | 274.2us/record；常驻句柄可降到 24.5us（11.2x） | `docs/perf/AUDIT-2026-11-02.md:180-181` |
| P6 | **手势热区被当成遮挡高度**：手势导航下凭空留出 46 CSS px 黑带 | navBar=0 / mandatorySystemGestures=138px | `docs/AGENTS/gotchas.md:3122-3136`（坑 385）；修法 = 拆两条通道 |
| P7 | `FileIncoming.sweepExpired` 在 `onCreate` 主线程做目录遍历 + N 次 JSON 解析，上界无硬限（7 天 TTL） | 随用户使用量增长 | `docs/perf/parts/startup-memory.md:119`；AUDIT Top5 第 5 项 `:32` |
| P8 | 首屏注入层每次提交 20 次整文档扫描（会话越长越慢） | 20.0 次/批（n=525→3325 不变，但扫描元素 9,279→65,340/批） | `docs/contrib/kelai141/2026-11-06-ui-frame-budget.md:74-79` |
| P9 | 悬浮面板展开/收起非对称（展开 200ms 渐显、收起瞬切） | 200ms vs 0 | `OverlayService.kt:385` vs `:424-427`（是不是问题需人眼判，T3） |
| P10 | 悬浮面窗口数量随交互增长（picker/report 各为独立顶层窗口，历史上有「漏收口 → 残窗」缺陷） | — | `OverlayService.kt:413-420`（FX-212.1 注释：旧实现收起面板后 picker 窗残留在屏上）；`CallSiteContractTest.kt:406-420` 锁死两处收口 |
| P11 | 悬浮面板每次 live 事件都走 `main.post` + 全量重绘状态行/徽标 | 无量化（Phase 2 待测） | `OverlayLiveFeed.kt:67-96`（drain 后 `svc.main.post`）；`OverlayService.kt:950-953`（renderPanelOnly） |
| P12 | 有界 IO 缺口：`LogCollector` 已异步（历史 UI 卡帧已修）、`WatchdogV2` 已自适应 | 已修项，勿重复 | `docs/perf/parts/io-disk.md:407` |

---

### 3.9 兼容性矩阵（Android 8.0/API 26 → Android 16/API 36）

行口径：影响 / 现有代码是否已处理（含行号）/ 新方案要注意什么。「平台事实」= 本机 SDK api-versions.xml 或 AOSP 行为；「需设备验证」= 本轮未取证。

| # | 议题 | 平台事实 | 影响 | 现有代码是否已处理 | 新方案注意 |
|---|---|---|---|---|---|
| C1 | 悬浮窗类型 | `TYPE_APPLICATION_OVERLAY` since 26（api-versions.xml:73832）；`TYPE_PHONE` deprecated 26（:73843） | 26+ 只能用前者；用 `TYPE_PHONE` 在 targetSdk≥26 上行为不保证 | **已处理**：全部 6 处窗口都用 `TYPE_APPLICATION_OVERLAY`（`OverlayService.kt:284,310,369`、`OverlayPanel.kt:1447`、`OverlayRecall.kt:67`、`OverlayReport.kt:270`、`VdisplayFloat.kt:109,326`）；minSdk 26 故无老分支（`docs/AGENTS/ANDROID-API-USAGE.md:45,66`） | 不要为「兼容」引入 `TYPE_PHONE`；不要在 `OverlayHalo` 里新增窗口（`CallSiteContractTest.kt:211-219` 的 I-A2 会红） |
| C2 | SYSTEM_ALERT_WINDOW 授权 | `canDrawOverlays` since 23（:54651）；`ACTION_MANAGE_OVERLAY_PERMISSION` since 23（:54702） | 未授权则 addView 直接抛（或窗口不显示） | **已处理且收敛**：`OverlayController.kt:87-88` 真源 = 偏好 && canDrawOverlays && 服务实例在场；:53-64 授权引导 + 意图记账（`KEY_PENDING_ENABLE`）；:157-158 版本守卫；`MainActivity.kt:972-973` 回前台自动补启 | 新面板不要绕过 `OverlayController` 直接 `startService`；权限撤销后必须能收敛为「关」 |
| C3 | 悬浮窗内输入法/焦点 | 焦点窗口才收 IME；`FLAG_NOT_FOCUSABLE` 窗口不收 IME | 悬浮窗只读面板抢焦点会**弹掉用户正在用的键盘** | **已处理，且是分区设计**：面板窗 focusable + `SOFT_INPUT_ADJUST_PAN`（`OverlayService.kt:367-377`，注释 :361-364 说明为何必须独立窗口）；球/光环/召回条 `NOT_FOCUSABLE` + `ADJUST_NOTHING`（`:285,290,311,314-316`、`OverlayRecall.kt:68-75`）；报告栏 `NOT_FOCUSABLE`（`OverlayReport.kt:273-278`，注释记录「看一眼汇报，输入法没了」实锤）；picker 窗 `WATCH_OUTSIDE_TOUCH`（`OverlayPanel.kt:1448-1449`） | 新卡片若有输入，**必须**自己开 focusable 窗口 + ADJUST_PAN；若只读，**必须** NOT_FOCUSABLE。禁止把 EditText 放进 NOT_FOCUSABLE 窗口 |
| C4 | 输入法量被两侧各算一次 | — | 键盘高度重复计入 → 内容多抬一个键盘 | **已修**（坑 185）：`MainActivity.kt:254-279` 施加 IME inset 到 WebView 布局，页面侧只用视觉视口 | 新卡片若也做「让开键盘」，不要与壳侧 IME 变量叠加；先读 `docs/AGENTS/gotchas.md:1283-1300` |
| C5 | 边缘手势导航冲突 | Android 10+ 手势返回热区在左右边缘；`mandatorySystemGestures` 是可触摸热区，不是遮挡 | 贴边球（margin 8dp，`OverlayService.kt:79,986`）可能被系统返回手势截获；召回条贴边同样 | **未处理**：全仓 `grep systemGestureExclusion` 无命中（证据附录 E5）；现有规避手段只有「球窗 = 球尺寸」避免大面积遮挡（`:280-281`） | 拖球/点击边缘时的手势竞争需实测（T7）；可考虑 `View.setSystemGestureExclusionRects`（API 29+，需设备验证生效范围） |
| C6 | 通知限制 | API 33+ `POST_NOTIFICATIONS` 运行时权限 | 无权限时通知不显示（引擎前台通知也受影响） | **已处理**：manifest:11 声明；分支请求 `MainActivity.kt:84-85,598-613`；`NotifyCenter.hasPermission` 投递前复判（`docs/AGENTS/ANDROID-API-USAGE.md:48`） | 新交互不要新增依赖通知的通道 |
| C7 | 前台服务类型 | Android 14（34）起 FGS 必须声明 `foregroundServiceType` | 缺类型 → 启动即崩 | **已处理**：`EngineService` =`dataSync`（manifest:42-45）；`EngineService.kt:47-50` `startForeground` | 平台事实（需设备验证）：Android 15（35）对 `dataSync` 有累计运行时长上限；本仓 targetSdk 34 暂不受，但升 targetSdk 前必须复核 |
| C8 | 前台服务后台启动限制 | Android 12（31）起禁止从后台启动 FGS（有豁免，含 BOOT_COMPLETED） | 开机自启路径若被拦，引擎不起 | **已处理**：`BootReceiver.kt:32` `startForegroundService`，广播来源是 `BOOT_COMPLETED`（manifest:104-111） | 不要再加「从任意后台时机 startForegroundService」的路径 |
| C9 | 后台启动 Activity 限制 | Android 10（29）起后台 app 不能直接 startActivity | 从悬浮球「回到应用」可能静默失败 | **部分处理**：`OverlayService.kt:898-923` 带 NEW_TASK|SINGLE_TOP + try/catch + 可见回执（`flashStatus`）；注释 `:908-910` **自认未经真机多 ROM 复核**，豁免依据是持有 SYSTEM_ALERT_WINDOW | 新方案任何「从 overlay 拉起 Activity」都必须：try/catch + 用户可见回执 + 不假设成功（现状即模板）。需设备验证（T-待补：多 ROM） |
| C10 | 省电模式 / 动效 | `ValueAnimator.areAnimatorsEnabled` since 26（:5432）；`PowerManager.isPowerSaveMode` since 21（:50003） | 省电模式会禁 ValueAnimator → 动画卡在中间态或不动 | **已处理**：`DsUi.animationsEnabled` 四因子（`DsUi.kt:31-49`）；四落点全部订阅（`MotionGateContractTest.kt:107-112`） | 新动效必须走同一门控 + 订阅；否则 144Hz/省电设备上「永不空闲」或「停不下来」 |
| C11 | 电池优化豁免 | `isIgnoringBatteryOptimizations` since 23（:50000）；`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`（manifest:17） | 未豁免时后台被杀 → 悬浮球消失（OverlayService 非前台服务） | **部分处理**：`BootReceiver.kt:43-46` 查询 + 引导系统页；`OverlayService` **不是**前台服务（manifest:84-86 无类型；`OverlayController.kt:117` 用 `startService`） | 新方案若要求悬浮面常驻，需接受「进程被杀即消失」；若改前台服务会与引擎通知抢占（需设计） |
| C12 | 不可见窗口的触摸命中 | overlay 窗口命中矩形 = 窗口矩形，与是否绘制无关 | 隐形黑洞吞手势 | **已处理/已立约**：坑 328（`gotchas.md:2469-2474`）；窗口尺寸 = 图形尺寸（`OverlayService.kt:280-281`、`OverlayRecall.kt:138` 高 44dp 宽 8dp） | 新卡片窗口尺寸必须等于可见图形；隐藏用 removeView |
| C13 | z 序 | 同一 `TYPE_APPLICATION_OVERLAY` 按 addView 顺序叠，后加在上 | 光环盖住球/新卡片被盖 | **已处理**：先光环后球（`OverlayService.kt:300-305,322-324`）；召回同样顺序 | 新窗口的 addView 顺序要写进注释并在收口路径成对 remove |
| C14 | 转屏/分屏 | `configChanges` 声明后 Activity 不重建 | 面板宽度/条位置不重算会出新屏越界 | **已处理**：`panelWindowWidth()` 每次重算（`OverlayService.kt:339-350`）；`OverlayRecall.reposition`（`OverlayRecall.kt:105-119`） | 新卡片的位置/宽度必须做成函数而非一次性局部量 |
| C15 | 版本覆盖（实测面） | 仓库实测设备：MuMu x86_64 API 35；真机 V2425A SDK 36；另有 Android 16/17 两台用于广播投递实测 | 8.0(26)-11(30) **没有设备证据** | `docs/AGENTS/gotchas.md:2484`（Android 16/17 实测）；`AGENTS.md` §2 设备清单 | 26-30 上的模糊/手势/IME 行为全部属于 T11/T7 待测 |

---

### 3.10 性能验收指标建议表

阈值纪律：**除已在仓库中有基线的两项外，一律标「待 Phase 2 实测后定」**。给「建议取值」的地方都是**方向性**的（例如「不得比中性基线差 20%」），不是已验证阈值。

| # | 指标 | 定义 | 采集方法 | 基线获取方式 | 阈值建议 |
|---|---|---|---|---|---|
| M1 | 拖动帧间隔 p95 | 连续拖动 2s 内相邻帧 `doFrame` 间隔的 95 分位 | `dumpsys gfxinfo ... framestats` 自算，或 Phase 2 加 Choreographer 埋点 | Phase 2 首测（T1） | 待 Phase 2 实测后定（先取「与静止基线差值」而非绝对值，规避设备差异） |
| M2 | 展开动画掉帧率 | `reset` 后一次「点球→展开」窗口内 Janky/Total | 3.6.2-B | T2 | 待 Phase 2 实测后定 |
| M3 | 展开时长偏差 | 实测首帧可见 → alpha 稳定时长 vs 名义 200ms（`OverlayService.kt:385`） | 录屏逐帧或 Choreographer 时间戳 | 名义值已知，实测缺 | 待 Phase 2 实测后定 |
| M4 | 触摸到可见延迟 | ACTION_DOWN 时刻 → 面板首帧可见时刻 | T4（Phase 1 只能近似） | 无 | 待 Phase 2 实测后定；先要求「不劣于面板展开名义时长 200ms」这条弱判据 |
| M5 | 壳进程常驻 CPU（收起态） | 30s 静止窗口 `(Δutime+Δstime)*10ms/Δt` | 3.6.2-A | T5 | 待 Phase 2 实测后定 |
| M6 | 壳进程常驻 CPU（展开态） | 同上，面板展开静止 30s | 3.6.2-A | T5 | 待 Phase 2 实测后定；必须与 M5 分开报（展开态是「使用中」） |
| M7 | 壳进程 RSS | `/proc/<pid>/status` VmRSS / VmHWM | 3.6.2-A | T5 | 待 Phase 2 实测后定；建议门槛形如「相对改造前 RSS 增量 ≤ x MiB」，x 由实测定 |
| M8 | overlay 窗口数 | 本包 `ty=2038` 可见窗口计数 | 3.6.2-C | 代码事实：常驻 3（球/光环/召回条按需） | 可作为**硬性结构判据**：不因新卡片无条件新增第 5 个常驻窗口；懒建优先 |
| M9 | 隐形命中面积 | 窗口面积和 − 图形面积和 | 3.6.2-C + 截图 | 坑 328 的历史值（约 2940dp² 黑洞） | 硬判据：新卡片窗口面积必须等于图形面积（0 隐形面积），不待实测 |
| M10 | 静止跨桥调用频率 | 5s 窗口内 `browserHostCommand` 次数/秒 | `verify-frame-timing.mjs` 的 `IDLE_PROBE` | 已有基线：1 次/秒 → 0（`2026-11-06-ui-frame-budget.md:13`） | 硬判据：新交互不得引入「静止 1Hz 及以上」的跨桥轮询（有既有基线，不需要重测） |
| M11 | 面板展开时注入层帧表现 | `verify-frame-timing.mjs` A 组（p95/over50/longtask）在面板展开期间采一次 | 3.6.1-② | 已有工具，无基线数字 | 待 Phase 2 实测后定；与 M2 同轮采，用于区分「主线程」还是「渲染层」 |
| M12 | 冷启动不回归 | `t_listen_ms` / `t_first_http_ms` / `loopP99` | 3.6.1-E + `check-boot-budget.mjs` | 已有：p99 median 1811.8ms、budget 7200ms（`check-boot-budget.mjs:53-76`） | **已有判据可直用**：`loopP99 ≤ 7200`、`compose calls ≤ 2`、`LISTEN→HTTP 观测差 ≤ 4000ms`、单次同步块 ≤ 2000ms（`:76,83,95,107`） |
| M13 | 常驻动画门控 | 「系统关动画」后，四落点是否仍在跑动画 | 代码层：`MotionGateContractTest`；设备层：关动画后截两帧比对 | 已有（`MotionGateContractTest.kt:104-130`） | 硬判据：新动效未进门控表 = 不合格 |
| M14 | 窗口泄漏 | 收起面板后 `ty=2038` 窗口数是否回到 3 | 3.6.2-C | 已有既有判据精神（FX-212.1，`OverlayService.kt:413-420`） | 硬判据：收起后窗口数必须回到收起前（含 picker/report） |

---

### 3.11 给施工者的硬约束清单（违反即被现有门禁判红）

1. 任何 `TYPE_APPLICATION_OVERLAY` 窗口的类型/标志改动都会撞 `app/src/test/java/com/dsharnessmobile/shell/CallSiteContractTest.kt`（`:211-219` I-A2：`OverlayHalo` 不得出现 `WindowManager`/`addView`/`TYPE_APPLICATION_OVERLAY`）。
2. 光环的颜色入口只有两处（`newHaloDrawable` + `setHalo`），`setHaloColors` 调用点必须恰为 3（含声明），不得新增 `setRing`/`setRingColors`（`CallSiteContractTest.kt:225-245`）。光环 ARGB 字面量必须留在 `Halo` 枚举块内（`OverlayHalo.kt:210-227` 注释 + 反证表）。
3. 报告栏必须独立窗口、`ACTION_OUTSIDE` 关闭、`hidePanel` 与 `onDestroy` 两处收口（`CallSiteContractTest.kt:406-420`）。
4. 常驻动画必须门控 + 订阅（`MotionGateContractTest.kt:104-130`）。
5. 触摸目标 ≥ 44dp（`OverlayReport.kt:503`；多处使用）。
6. 面板宽度唯一权威是 `panelWindowWidth()`（`OverlayService.kt:347-350`，注释 `:339-346` 说明「两份公式只有一份生效」的历史缺陷）。
7. 球边距唯一权威是 `BALL_EDGE_MARGIN_DP`/`edgeMarginPx`，`clampBallPos` 内不得出现 `8 * dp` 字面量（`CallSiteContractTest.kt:202-209`）。
8. 隐藏 = `removeView`，不得 `alpha=0`/`GONE`（`gotchas.md:2469-2474` + `CallSiteContractTest.hidingRemovesBothWindowsInsteadOfFadingThem`）。
9. 新增/改动的动效与窗口必须同步更新 `docs/AGENTS/EXECUTION-MAP.md` 并跑 `node scripts/check-code-map.mjs`（改代码后必跑，见 `AGENTS.md` §5.3）。

---

### 证据附录

**E0 工作树与提交**

```
$ git -C _dsh-wt/ovl-phase1 log --oneline -3
5f533907 Merge pull request #1716 from kelai141/perf/prefix-rewrite-single-stat
a5ade0ad Merge pull request #1718 from cmyfqwq/fix/ownership-hardlink-guard
59d82a6c Merge pull request #1713 from codex/session-header-identity-recheck
```

`git status --porcelain` 为空（本调查未改任何文件；产出只写 `.deploy-tmp/ovl-phase1-parts/`）。

**E1 资源与 Kotlin 文件清单（本调查实际读过的文件）**

- `app/src/main/res/values/{colors,dimens,themes,strings}.xml`、`values-night/{colors,themes}.xml`、`values-v27/themes.xml`、`values-night-v27/themes.xml`、`values-en/strings.xml`、`anim/picker_enter.xml`、`mipmap-anydpi-v26/ic_launcher.xml`；`res` 下**无** `font/`、**无** `styles.xml`。
- 壳侧：`SplashOverlay.kt`(206 行)、`SplashSettingsPage.kt`(203)、`SplashStore.kt`(162)、`SplashPolicy.kt`(102)、`SplashToggle.kt`(155)、`DsUi.kt`(241)、`OverlayTheme.kt`(72)、`OverlayHalo.kt`(244)、`OverlayPanel.kt`(1673)、`OverlayService.kt`(1069)、`OverlayLiveFeed.kt`(219)、`OverlayRecall.kt`(198)、`OverlayReport.kt`(691)、`OverlayController.kt`(159)、`BootPhaseTrace.kt`(136)、`MotionCoalescer.kt`(133)、`GuideChrome.kt`、`GuidePageRenderer.kt`、`MainActivity.kt`(2413)、`AndroidManifest.xml`(213)。
- 文档：`AGENTS.md`、`docs/AGENTS/{ANDROID-API-USAGE,EXECUTION-MAP,gotchas}.md`（按需 grep + 定点读）、`docs/perf/AUDIT-2026-11-02.md`、`docs/perf/parts/{startup-memory,webview-runtime,io-disk}.md`、`docs/contrib/kelai141/2026-11-06-ui-frame-budget.md`。
- 脚本：`scripts/check-boot-budget.mjs`、`scripts/perf/measure-steady.ps1`、`scripts/verify-frame-timing.mjs`。

**E2 关键 grep（可复跑）**

```
# 模糊 / RenderEffect / BLUR 在壳侧代码里的使用情况：0 命中（本仓完全没有模糊实现）
$ grep -rn "RenderEffect|BLUR_BEHIND|setBlurBehindRadius" app/src --include=*.kt
(无输出)

# 帧指标埋点：0 命中
$ grep -rn "FrameMetrics|JankStats|Choreographer|Trace.beginSection|Debug.startMethodTracing|systrace" app/src
(无输出)

# dumpsys gfxinfo 全仓引用：仅 1 处（doc，且是讨论 screen-scope 放行）
docs/contrib/cmyfqwq/2026-10-28-screen-scope-dumpsys-activity.md:63

# 手势排除 API：0 命中
$ grep -rn "systemGestureExclusion" app/src
(无输出)

# overlay 窗口类型全部为 TYPE_APPLICATION_OVERLAY（6 个落点）
OverlayService.kt:284,310,369 / OverlayPanel.kt:1447 / OverlayRecall.kt:67 / OverlayReport.kt:270 / VdisplayFloat.kt:109,326
```

**E3 Android SDK 取证（本机，非仓库文件）**

文件：`D:\Android\Sdk\platforms\android-36\data\api-versions.xml`（compileSdk 36；本机另有 android-34/35/36.1）

```
L20800: <class name="android/graphics/RenderEffect" since="31">
L20806: <method name="createBlurEffect(FFLandroid/graphics/Shader$TileMode;)Landroid/graphics/RenderEffect;" since="31"/>
L72323: <method name="setRenderEffect(Landroid/graphics/RenderEffect;)V" since="31"/>
L73726: <method name="getBlurBehindRadius()I" since="31"/>
L73737: <method name="setBlurBehindRadius(I)V" since="31"/>
L73763: <field name="FLAG_BLUR_BEHIND"/>
L1961:  <field name="windowBlurBehindRadius" since="31"/>
L73663: <method name="addCrossWindowBlurEnabledListener(Ljava/util/function/Consumer;)V" since="31"/>
L73670: <method name="isCrossWindowBlurEnabled()Z" since="31"/>
L73832: <field name="TYPE_APPLICATION_OVERLAY" since="26"/>
L73843: <field name="TYPE_PHONE" deprecated="26"/>
L54651: <method name="canDrawOverlays(Landroid/content/Context;)Z" since="23"/>
L54702: <field name="ACTION_MANAGE_OVERLAY_PERMISSION" since="23"/>
L5432:  <method name="areAnimatorsEnabled()Z" since="26"/>
L50003: <method name="isPowerSaveMode()Z" since="21"/>
L50000: <method name="isIgnoringBatteryOptimizations(Ljava/lang/String;)Z" since="23"/>
L19289: <class name="android/graphics/BlurMaskFilter" since="1">
```

**E4 基线数字出处（逐条对应正文）**

| 正文数字 | 出处 |
|---|---|
| loop p99 min/median/p75/p90/max = 1371.4/1811.8/2533.4/4709.4/6260.6 | `scripts/check-boot-budget.mjs:54-56` |
| `LOOP_P99_BUDGET_MS=7200`、`SYNC_BLOCK_BUDGET_MS=2000`、`LISTEN_TO_HTTP_OBSERVATION_BUDGET_MS=4000`、`COMPOSE_CALLS_BUDGET=2` | `scripts/check-boot-budget.mjs:76,83,95,107` |
| t_listen/t_first_http 真机两轮 | `docs/perf/parts/startup-memory.md:220-221` |
| 本仓冷启动占比 5% | `docs/perf/parts/startup-memory.md:207-211` |
| 首屏 68 包 / raw 11.23 MiB / gzip 5.21 MiB | `docs/perf/AUDIT-2026-11-02.md:170` |
| 单包 raw 5,282,386 / gzip 3,849,116 | `docs/perf/AUDIT-2026-11-02.md:171` |
| client.js raw 1,002,801 / gzip 299,140 | `docs/contrib/kelai141/2026-11-06-ui-frame-budget.md:39-41` |
| DOM 扫描 10.00→1.00 次/批；滚动 4.00→0.00 次/帧；跨桥 1→0 次/秒 | `docs/contrib/kelai141/2026-11-06-ui-frame-budget.md:11-14` |
| audit.ndjson 274.2us → 24.5us | `docs/perf/AUDIT-2026-11-02.md:180` |
| 唤醒 307 次/分钟、后台 135 次/分钟 | `docs/perf/AUDIT-2026-11-02.md:182` |
| 同步 AIDL 24.4ms/次、dispatchTap 81.9ms、滑动 22 事件 | `docs/AGENTS/gotchas.md:2512` |
| haloIdle 对比度 2.96:1 / 3.48:1 | `app/src/main/java/com/dsharnessmobile/shell/OverlayTheme.kt:27-29` |

**E5 未确认项（显式登记，不得当结论使用）**

1. `setBlurBehindRadius` + `FLAG_BLUR_BEHIND` 对 `TYPE_APPLICATION_OVERLAY` 窗口**是否真正生效**、半径上限、以及在 31-36 各 API 上的差异 —— 未确认（无设备）。
2. `FLAG_BLUR_BEHIND` 在 API 26-30 上的行为（静默忽略 / 抛异常）—— 未确认（无该档设备）。
3. 手势返回热区与贴边球/召回条的实际冲突率 —— 未确认（无手势导航设备实测）。
4. `from overlay 起 Activity` 在 Android 10+ 各 ROM 上的成功率 —— 仓库代码注释自认「未经真机多 ROM 复核」（`OverlayService.kt:908-910`），未确认。
5. `OverlayService`（非前台服务）在电池优化未豁免时的实际存活时长 —— 未确认（无设备长稳测试）。
6. 面板收起无动画是否为观感缺陷 —— 需人眼判（T3），未确认。
7. `docs/BOOT-PRELUDE-SEGMENTS-2026-11-10.md` 的分段口径 —— 本轮只确认文件存在，未通读（避免通读约束下的时间浪费），Phase 2 若要用 prelude 分段需先读该文档。

---

## 4. 跨领域结论与冲突裁决

本节只写三份分领域调查**交叉后**才成立的结论；单项事实不重复（见第 1/2/3 节）。

### 4.1 职责归属（重构后不变）

| 层 | 负责 | 不负责 | 证据 |
|---|---|---|---|
| Kotlin 壳（`app/src/main/java/com/dsharnessmobile/shell`） | 悬浮窗口/视图/手势/动画/生命周期；引擎探活；RPC 与 live 流消费 | 会话状态真源、命令目录、工作区数据 | 第 1 节；桥面与会话/工作区零方法（第 2 节） |
| Node 引擎 + 插件（`plugins/dsh-android-bridge` 等） | `$events` 事件、`.live.ndjson` 投影、`.notify.ndjson`、命令执行入口 | 任何 UI 决策 | 第 2.3 / 2.8 节 |
| WebView 页面（`dsh-client-ui-responsive` 与上游 UI） | 会话/工作区/命令的权威状态；页面 DOM 标记 `data-dsh-session-id` | 悬浮层驻留（页面可能不在前台/未加载） | 第 2.5 节 |
| Rust | 快照解码/原生 loader 等 | 悬浮层一切 | 第 1 节复用评估（无交集） |

**裁决**：新 UI 的全部渲染与状态归属 Kotlin；页面只作为「读取会话/工作区/命令真源」的被调用方（design 6.2 N3/N4）。不允许把卡片/药丸做成 WebView。

### 4.2 现状与目标交互的差距（R1-R14 对照）

| 需求 | 现状 | 差距性质 |
|---|---|---|
| R1 侧边细条 / 悬浮球双形态 | 只有 34dp 球（`OverlayService.buildRoot`），无细条；隐藏态有 8×44dp 召回条但仅是召回入口 | **新建**（细条形态） |
| R2 单击/双击/长按语义 | 球只绑单击（`togglePanel`）；无双击/长按（0.14.9 文档曾明确拒绝手势隐藏） | **新建**（手势路由器） |
| R3 本体前台隐藏入口 | 全仓无 `ActivityLifecycleCallbacks`；仅 `MainActivity.onResume` 补启服务 | **新建** |
| R4 顶部卡片 + 32%/40% | 无顶部卡片；面板贴球侧边、宽 ≤400dp、无高度上限、无滚动 | **新建**（可复用组件级代码） |
| R5 Tool Call/思考/状态 + 溢出滚动 | 面板状态行只显示单行文案；无事件列表、无 ScrollView | **新建** |
| R6 思考合并单行 | 无节流器；live 无 reasoning 数据 | **新建 + 需插件补事件** |
| R7 上推白条 → 药丸 | 面板只有「×」收起入口；无药丸形态 | **新建** |
| R8 药丸单行淡入淡出 | 无药丸 | **新建** |
| R9 药丸自由移动/顶缘/消散手势 | 无药丸 | **新建** |
| R10 底部输入系统（工作区/会话药丸 + 附件 + 预览） | 面板内有输入框、会话选择行、独立选择器窗口；无工作区入口；无附件预览 | **改造 + 新建** |
| R11 「＋」抽屉（附件 + 动态命令） | 仅 WebView 内有 composer-sheet；原生无 | **新建**（真源复用页面） |
| R12 点外部收起 | 无（现行只有「×」/ 返回键 / 自动收起） | **新建**（方案 V1 待验证） |
| R13 收起不中断 Agent | 已成立（隐藏态明确不停服务，`hideBall` 注释与 0.14.9 文档第 4 节） | 保持 |
| R14 手势冲突/穿透/系统手势区 | 部分：面板窗 `NOT_TOUCH_MODAL`、球窗=命中区；边缘手势冲突全仓 0 处理 | **新建**（逐窗 flags + 退让策略） |

> 结论：这是**形态级新建 + 局部复用**，不是纯重构。可复用的高价值资产集中在「协议/事件/存储/状态语义」层（见 4.3），不在视图层。

### 4.3 复用价值排序（跨节汇总，不重复明细）

| 优先级 | 资产 | 复用方式 |
|---|---|---|
| P0 | `postRpc` / `requestSend` / `applyAgentStatus` / `$events` 解析 / live 流消费 / pending 应答协议 | 原样保留；重写即倒退（第 1.10、2.9 节） |
| P0 | 隐藏/召回语义（不落盘、不停服务、removeView） | 原样保留为「入口隐藏」的标准实现 |
| P1 | 拖动 + `clampBallPos` + `OverlayRecall` 纯函数、`OverlayHalo` 四态、`CompletionNotice` 完成位、返回键 BackKeyPanelLayout | 原样保留，尺寸常量同步 |
| P1 | 会话选择器数据口径（可见性过滤 / 存活集分离 / browser 对账） | 保留逻辑，重做展示层 |
| P2 | 面板输入行 / 待答卡渲染 / 双语文案入口 | 抽出重建为输入区与卡片组件 |
| P3 | `OverlayPanel` 单窗口视图树与状态行分支链 | 局部重写（耦合过高） |

### 4.4 必须先修的既有缺陷（重构前收敛项）

| 缺陷 | 证据 | 为什么必须前置 |
|---|---|---|
| agentId 当 sessionId 用 | `OverlayService.kt:611-616`、`EXECUTION-MAP.md:292` | 新 UI 按会话分桶/分卡片，id 域混用会把状态挂错会话 |
| `addView` 失败静默吞掉 | `OverlayService.kt:382`（`expanded` 已置 true） | 新增 5 个窗口后同类「点了没反应」会成倍放大 |
| 自动收起守卫只看输入行草稿 | `OverlayService.kt:647-656`、`OverlayPanel.kt:1168` | 卡片/输入区拆开后守卫条件必须重定义 |
| 球径 34dp < 44dp 触摸下限 | `OverlayService.kt:70` vs `OverlayReport.kt:503` | 新入口形态要一并解决 |
| 测试基线未含新增 8 例 | 第 1.8 节 | 重构前先刷新基线，否则回归判据失真 |

### 4.5 技术栈裁决

- **Kotlin 原生**：承担全部新增 UI（design 2.1 方案 A）。
- **Rust**：不新增模块。本系统事件量级（每轮几十条、单行 ≤240 字节）与瓶颈（布局/窗口 resize）都不在 Rust 收益区间；引入会新增 JNI 与双 ABI 构建成本。
- **Compose / WebView 渲染**：否决，理由与代价见 design 2.1。
- **插件（Node）**：只做数据产出的加法（`k=think`、`callId`、命令目录暴露），不做 UI。

---

## 5. 未确认项汇总（施工前必须收敛）

分领域原始清单见第 1 节「未确认清单」、第 2.11 节、第 3.7 / 3.10 节。以下是**去重后的 Top 清单**；未收敛前不得按假设施工。

| # | 未确认 | 收敛方式 | 归属 |
|---|---|---|---|
| V1 | `FLAG_WATCH_OUTSIDE_TOUCH` 在非焦点 overlay 窗上能否稳定收到 `ACTION_OUTSIDE` | Phase 2 设备 spike（2 个 API 档） | design U1 |
| V2 | reasoning 块是否在 `assistant/message` 一次性到齐；有无流式 delta 事件 | 插件对未知 `ev.type` 记日志 + 真机跑一轮 | design U2 |
| V3 | 命令目录是否有官方 API（非 DOM） | 插件能力探查 / 上游类型检索 | design U3 |
| V4 | 工作区列表/切换的官方接口与业务语义 | RPC 探查 + 产品确认 | design U4 |
| V5 | 跨应用窗口模糊对 overlay 是否生效（机型差异） | 设备 spike（仅记录，不作功能依赖） | design U5 |
| V6 | 细条与系统边缘返回手势的实际冲突率 | 真机 + 模拟器手势模式 | design U6 |
| V7 | 面板内容超高是否真的顶出屏 | 设备复现（现为代码推断） | 第 1 节 U2 |
| V8 | 锁屏/亮屏时球与召回条的可见性 | 设备复现 | 第 1 节 U3 |
| V9 | 球 34dp 的实际点按命中率 | 设备人眼判读 | 第 1 节 U4 |
| V10 | 卡片 32%/40% 在小屏与横屏下的可用性 | 多分辨率截图 | design U7 |
| V11 | 原生发消息是否支持附件字段（`session/prompt` 未确认） | 上游类型 / 实测 | 第 2.11 节 |
| V12 | `plugins/dsh-android-bridge/lib/` 产物缺失（仅 `src/`）是否影响发布包 | 构建链确认（`build-client.mjs`） | 第 2.11 节 |

---

## 6. 如何复现本次调查

```powershell
# 1) 取权威代码（远程为准）
git fetch --all --prune
git worktree add _dsh-wt/<wt> -b <branch> origin/main
git -C _dsh-wt/<wt> log -1 --oneline     # 期望 5f533907

# 2) 定位窗口层（8 处 addView / 6 类窗口）
Select-String -Path app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt -Pattern 'wm.addView|LayoutParams\('

# 3) 定位事件生产（插件侧）
Select-String -Path plugins/dsh-android-bridge/src/index.ts -Pattern 'appendLive|tool_call|tool_result|assistant/message|turn/end'

# 4) 定位命令真源（页面侧）
Select-String -Path dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts -Pattern 'role=.?option|ATTACHMENT_ROW_TITLES'

# 5) 测试计数（只读，不要 --update-baseline）
node scripts/check-kotlin-test-count.mjs --check
```

三份分领域调查各自的「证据附录」记录了实际执行过的命令与输出摘要，是本节的可核查补充。

---

## 7. 文档状态声明

- 本文件所有结论基于 `5f533907` 的只读调查；未运行构建、未安装 APK、未跑设备套件。
- 因此**没有任何设备侧结论**：所有「手感 / 可见性 / 冲突率」类判断都标为待验证（第 5 节）。
- 性能**没有实测数字**：仓库内既有基线全部属于启动链与注入层 JS（第 3.5 节），悬浮层帧级指标为 Phase 2 首测项。
- 本阶段未修改任何产品代码；新增文件仅 `docs/overlay-refactor-2026-11/` 下四份文档。
