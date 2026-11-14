# DeepCode Android 悬浮交互系统重构 — 设计

> 阶段：Phase2已明确授权续工实现与验证（2026-11-13）；此前“仅文档、不编码/构建/设备”属于上一轮停止点。本文是当前目标及§5.5源码合同，不是执行报告；**CURRENT VERIFICATION PENDING**，旧实现/绿色证据按当时输入保留，不等于最新交互通过。
> Phase 1 调查基线：`5f533907`；本文已按当前工作树源码与 [Phase 2 交接](<docs/overlay-refactor-2026-11/handoff-phase2.md#L197-L205>) 修订实现差异。未改动的旧行号仅用于定位调查基线，当前落点以符号检索为准。
> 需求优先级：[用户基线](<docs/overlay-refactor-2026-11/user-baseline.md>) 高于交接施工差异；配套 [调查](<docs/overlay-refactor-2026-11/investigation.md>) / [实施计划](<docs/overlay-refactor-2026-11/implementation-plan.md>) / [验收矩阵](<docs/overlay-refactor-2026-11/test-plan.md>)。
> 阅读约定：调查期行号只作历史定位；当前源码链接与符号用于检索。最新直接澄清优先，原F17「点外部关顶部」、inline height抽屉只属旧解释（§0.1），不再与当前规范并行生效。**需求目标不因施工差异而缩减**：本文标「当前/已实现」只表示源码事实，不表示获准降级或已经验收；目标与实现不一致必须列待补并按原始用户基线回归，不能据交接把缺口变成不做项。

---

## 0. 结论摘要

1. **架构：多窗口 + 原生 View，不做单窗口全屏方案。** 悬浮入口（球/侧边细条）、顶部事件卡片、状态药丸、底部输入区、召回条各自独立 `WindowManager` 窗口，全部 `TYPE_APPLICATION_OVERLAY`；每个窗口的**窗口矩形 = 可视矩形**（继承 0.13.2 起「互吞」根治纪律，见 `OverlayService.kt:280-294`）。顶部输出与底部输入独立：中间空白outside只收底部输入/键盘，不关顶部；＋选择另用独立底部sheet覆盖其它app，不inline撑composer。触摸与IME语义见§3.4，禁止全屏透明拦截窗。
2. **技术栈：Kotlin 原生实现全部 UI/手势/窗口生命周期；不引入 Compose；不新增 Rust 模块。** Rust 现有用途（快照 xz 解码等）与本系统无性能交集，见 §2.4。
3. **数据面 100% 复用现有通道，不新增对 DSH 上游接口的改动**：`session/list`、`session/prompt`、`session/create`、`session/cancel`、`session/respond`（`postRpc` 见 `OverlayService.kt:712-730`）、`/api/remote.mux` 的 `api-session/status` 事件（`OverlayPanel.kt:107`、`:181-190`）、`files/home/.dsh/.live.ndjson` 增量流（`OverlayLiveFeed.kt:26-100`）、`EngineProbe` 探活。
4. **新增能力只落在本仓自己的插件（`plugins/dsh-android-bridge`）与壳侧**：live 流新增 `k=think` 思考摘要行，`tool_call/tool_result` 以 `callId` 配对；命令清单不走 live 事件，而由本仓页面宿主 API 读取上游菜单。线格式保持加法兼容（旧壳忽略未知 `k`）。这满足「能力来自插件」「不改 DSH 现有接口」两条仓库铁律。
5. **视觉：复用既有ds_* design token**。当前用户截图已指出旧文字重叠/透底，文字承载card/pill/input/sheet采用实色ds_surface，chips/附件tiles采用实色ds_chip，以描边/圆角/有方向的finite动效分层；不把旧92–96%静态半透明阅读面当现行要求。保留低成本材质原则，不做窗口外阴影或Liquid Glass动态折射；可读性与真实触摸须分别验收（§7）。
6. **性能以「静止时零刷新、事件合并渲染、窗口尺寸量化变更」为设计前提**，并给出可测指标与采集方法（§7.7 与 test-plan 的性能矩阵），不预填任何实测数字。
7. **最新明确指示优先**：card连续形变为显示最新真实Agent输出的长胶囊；长条顶限位后经宽容距离再渐淡收起，并联动收input/IME/sheet。顶部无X/形态/隐藏按钮，球↔strip仅应用设置或左右对称边滑；旧短pill/高速二次阈值不可与当前目标并行。F19与原业务安全边界继续保持，完整体验仍须验证。

---

### 0.1 澄清时序与当前优先级（更新至2026-11-13本轮）

1. 早期“外部tap关顶部”、贴底共板input、inline height抽屉已被纠正：空白仅收底部输入/IME，顶部保真实历史，chips独立浮动、sheet覆盖input不抬移。
2. 旧prepare主动暂收card/pill/composer、receipt后show重建方案已被否定：picker/camera必须保同View、session/text/selection，仅临时NOT_FOCUSABLE/NOT_TOUCHABLE让系统交互，结束逐窗原flags恢复；取消原样、成功只append到原目标。旧取件证据按当时输入保留，不授权继续旧策略。
3. 白条曾仅快fling，后补“系统longpress后48dp慢推”；长条消散还曾采用短pill44dp、16dp/500dp/s、8dp顶缘/新DOWN等参数。**这些数值与二次高速触发是历史施工，不是当前产品门**，不能据旧单测或旧green拒绝本轮连续形变与距离宽容区收起。
4. 最新目标：顶部正文Markdown、工具调用呈现接近DSH，idle仍是真记录；card经白条跟手非线性形变直接收成显示最新真实Agent输出的一行长胶囊。长条到顶限位不隐藏，继续上推先宽容、超出再随距离渐淡收起，并联动收当前input/IME/sheet；不足回弹，无高速或另一次新DOWN要求。
5. 顶部右上X/形态/隐藏按钮全部移除，不占内容或留透明热区；显式球/条选择仅应用设置。默认自由球贴左/右边后继续向该侧边缘滑入strip；strip向屏内拉出为自由球，可跨屏换侧再收条，左右对称。点击/双击/长按原语保持。
6. 当前规范已就地替换下文表格、状态、§8.3与§9；未确认曲线、尺寸、宽容区和距离均可配置/待实测。当前已继续实现，§5.5及[续工交接](<handoff-phase2-continued.md>)描述已核读源码，模块/EXEC同步更新；本文**不新增测试或验收通过结论**，结果仅由lead维护[测试报告](<test-report-phase2.md>)。

## 1. 需求到技术约束的转化

| # | 交互需求 | 技术策略 | 主要风险 |
|---|---|---|---|
| R1 | 默认自由球；球贴左/右边后继续朝边缘侧滑才收strip，strip向屏内拉出恢复球，可跨屏换侧；显式选择仅应用设置 | 同一入口对象/业务生命周期与方向性边滑状态，左右对称；顶部不设按钮 | 距离/热区可配置待实测，不能单到边误收或只支持一侧 |
| R2 | 单击展开卡片、双击进本体、长按卡片+输入 | 纯 Kotlin `OverlayGestureRouter` + `ViewConfiguration` 的双击/长按超时与 `touchSlop`；由入口触摸监听与主线程定时回调驱动 | 双击与单击的延迟取舍（单击要等双击判定） |
| R3 | 本体在前台时隐藏自身入口 | 宿主 Activity 生命周期上报（新增），入口窗 `removeView` 而非 alpha | 初版仅 MainActivity；续工新增应用级 OverlayHostVisibility，覆盖 Console/Repair 并排除透明附件代理，设备切换待验 |
| R4 | 顶部最高32%可用高、白条下拉至40% | 硬比例frame+内部滚动；内容档/手势结算时一次layout，跟手alpha/translation | 不用逐帧height/WM resize当动效；溢出在内部滚动 |
| R5 | 运行/idle均显示当前真实user/assistant历史；助手正文Markdown、工具调用呈现接近DSH，多行内滚 | 公开history/current-session真源，稳定row id增量更新并保滚动（§5.5） | 工具/状态/摘要不代正文，切sid/idle重开/长内容须反证 |
| R6 | 连续思考合并同一行，避免频繁布局与闪烁 | 400ms 合并窗口 + 文本原地替换（不重建 View）+ 变更节流 | 合并窗口与「实时感」的取舍 |
| R7 | 白条上推拖动时跟手非线性形变，直接收成长胶囊，不要求高速 | 保原长按识别原语，慢推成立，未足/CANCEL回位；下拉40%能力保留 | 形变/距离参数可配置待实测，旧48dp/500仅历史 |
| R8 | 长胶囊单行显示最新真实Agent可见输出，非仅状态 | 从真实assistant可见输出派生单行，状态只辅助，恢复card可读全文 | 无真实输出如实表达；旧短状态pill尺寸/时长不是当前判据 |
| R9 | 长条到顶限位本身不隐藏；继续上推经宽容区，超出按距离渐淡/收起，不足回弹 | 距离进度与可见alpha连续；完成同时收长条/input/IME/sheet保草稿业务 | 不高速门、不强制新DOWN；未确认距离/曲线可配置待实测 |
| R10 | chips各自浮动无共用底板，输入全圆角离底药丸；文字/附件/预览真源不变 | 透明有界composer根、chips各自surface、独立input pill与IME；sheet另窗 | 输入与sheet不能合成贴底大面板；中间空白收输入不动顶部 |
| R11 | ＋打开独立底部选择sheet覆盖其它app，上附件/下动态命令 | 独立WindowManager槽位、有界滚动，alpha/translation显隐；官方menu真源不变 | 不inline撑高、不改composer位置/y作避让，sheet直接覆盖input；不height动画、不扩大为全屏透明触区 |
| R12/F17 | 中间空白/输入外部只收input/sheet/IME，顶部保持；顶部无X/形态/隐藏按钮 | 入口原语/白条与长条距离手势负责顶部变化，outside仅底部域 | 旧外部关顶部/顶部按钮不可当当前保底 |
| R13 | 收起/隐藏不中断后台 Agent | 服务与 Mux/探活/live 流不随 UI 收起停止（沿用 `hideBall` 既有语义 `OverlayService.kt:448-457`） | 无 |
| R14 | 手势冲突、触摸穿透、系统手势区、版本差异 | 逐窗 flags 表 + 边缘热区退让 + API 26..36 矩阵（§10） | 导航手势与入口/召回条重叠 |

---

## 2. 架构选型

### 2.1 候选方案对比

| 方案 | 做法 | 收益 | 成本/风险 | 结论 |
|---|---|---|---|---|
| **A. 多窗口 + 原生 View（选定）** | 每个 UI 区一个 overlay 窗口，View 树手写或 XML | 命中区可控（窗口=可视）、IME 可单独处理、复用现有 `OverlayService/OverlayPanel` 65% 以上代码、无新依赖 | 目标方案与施工窗口集合见§3.1，生命周期与z序须独立验证，生命周期与 z 序纪律要求高 | 采用 |
| B. 单全屏窗口 + 分区 | 一个全屏透明窗，内部按区域布 View | 布局简单、实现 outside-tap 容易 | 全屏窗吃全部触摸（必须 `FLAG_NOT_TOUCHABLE` → 又收不到触摸），或形成大面积隐形触区；与 0.13.2「互吞」根治结论直接冲突 | 否决 |
| C. WebView 渲染悬浮 UI | 复用 Web 前端组件画卡片 | UI 迭代快 | 每帧合成与 JS 桥成本、进程/内存压力、离屏 WebView 在 overlay 上的焦点与 IME 问题 | 否决 |
| D. Compose overlay | ComposeView 放进 overlay 窗口 | 声明式 | 新增 Compose 依赖与 BOM（`DEPENDENCIES.md` 需增项）、与现有 View 体系两套并存、首帧成本更高 | 否决（Phase 2 若 UI 复杂度显著上升可重评，但不作为首版） |
| E. Rust 渲染/数据面 | 用 Rust 做绘制或事件解析 | 理论上更快 | 事件量级为「每轮几十条」，Kotlin/JSON 解析远未成为瓶颈；引入 JNI + 双 ABI 构建成本 | 否决（§2.4） |

### 2.2 为什么是「多窗口」

- 现有系统已经是多窗口：球窗、光环窗、面板窗、召回条窗（`docs/AGENTS/ARCHITECTURE.md:32-47` 与 `docs/AGENTS/BRIDGE-API.md:85-105`），z 序与生命周期纪律已有测试守着（`CallSiteContractTest`、`OverlayRecallTest`）。目标是**演进**而不是重写。
- 需求本身是「分区独立显示、独立收起」：卡片、药丸、输入互斥关系弱（卡片可与输入同屏，药丸可单存），单窗口会被迫在窗口内做大量「假窗口」状态机。
- IME 只能被 focusable 窗口原生顶起（现行面板已验证这条路径，`OverlayService.kt:361-388`）；把输入框放进独立窗口可以让键盘逻辑完全不牵连卡片。

### 2.3 为什么不做全屏单窗

`docs/0.14.9-preview-OVERLAY-BALL-HIDE.md` §2 已经把结论写死：留在 WindowManager 里的「不可见」窗口照样吃触摸，alpha=0 / GONE 都不改变命中矩形；而「窗口矩形 = 可视矩形」是 0.13.2 互吞缺陷的根治依据（`OverlayService.kt:280` 注释）。全屏窗要么吃光触摸，要么加 `FLAG_NOT_TOUCHABLE` 后自身收不到事件——两个方向都不可接受。

### 2.4 Rust 的取舍

- 现状：仓库内 Rust 相关是快照/解码/原生 loader 方向（见 `scripts/check-native-linux-loader.mjs` 的原生 loader 校验面，以及 `docs/AGENTS/EXECUTION-MAP.md` 中启动链相关条目），与悬浮层的 UI 线程、事件循环无交集。
- 悬浮层数据量级：一轮对话的工具事件为**几十条**，live 文件单行 ≤240 字节、批量写 100ms（`plugins/dsh-android-bridge/src/index.ts:2114-2147`）。JSON 解析与 View 绑定不构成瓶颈；瓶颈在**布局与窗口 resize**，Rust 帮不上。
- 结论：Phase 2/3 不新增 Rust 模块。若将来要做「大规模事件持久化检索」或「图像处理」，再单独评估，并需在 `docs/AGENTS/DEPENDENCIES.md` 登记。

---

## 3. 窗口与 z 序设计

### 3.1 窗口总表（目标形态）

| 窗口 | 承载 | 尺寸 | Flags | 位置 | z 序纪律 |
|---|---|---|---|---|---|
| W1 入口（球/左或右strip） | 默认自由球及方向性边滑变形 | 沿既有资源起步，尺寸/触区未确认项可配置待实测 | NOT_FOCUSABLE + NOT_TOUCH_MODAL | 球自由拖，贴边后继续外滑入条，条向内拉出球，可跨屏换侧 | 顶部无形态按钮，显式设置仅应用设置 |
| W2 光环（Phase 1 方案项，v2 当前缺席） | 状态光晕 | 旧路径为 50dp，与球/边距同源 | `NOT_FOCUSABLE` + `NOT_TOUCHABLE` | 与球同心 | v2 当前只有白底鲸鱼，状态在卡片/药丸；这是施工差异，不是取消方案的授权，也不能据此把 F-10 的光环/z 序验收记通过。需按原始需求基线由 lead 收口 |
| W3 顶部输出卡片 | 真实Markdown历史、DSH式工具调用/状态/白条；右上无X/形态/隐藏按钮 | 32%/40%硬上限保持，内容内滚 | focusable + ALT_FOCUSABLE_IM + NOT_TOUCH_MODAL，不接outside关闭 | 顶部固定避状态栏 | 与底部收口独立，不留按钮占位/透明热区 |
| W4 横向长胶囊（旧名PILL兼容） | 最新真实Agent输出单行，状态仅辅助 | 长条形态，尺寸/曲线可配置待实测，不锁旧44dp短pill | NOT_FOCUSABLE + NOT_TOUCH_MODAL | 自由拖至顶限位，继续上推经宽容区再渐淡/收起 | card跟手非线性直接形变而来，完成联动收底部域 |
| W5 浮动输入区 | 各自surface的工作区/会话chips + 全圆角input pill + 附件预览；无sheet子树 | 宽=屏宽−2×12dp，高wrap，根透明有界 | focusable + NOT_TOUCH_MODAL + ADJUST_PAN，outside只收底部域 | input与物理底边留隙（目标12dp并避导航栏/IME），不是贴底整板 | 与顶部独立，选择sheet另槽 |
| W6 召回条（隐藏态） | 隐藏后唯一入口 | 8×44dp（沿用，`OverlayRecall`） | NOT_FOCUSABLE + NOT_TOUCH_MODAL | 贴最近水平边缘 | 隐藏态下替代W1/W2 |
| W7 独立底部选择sheet | 上附件瓦片/下动态命令；可复用会话/工作区列表模型 | 最大可用高40%、内部滚动 | 单独有界overlay，返回/外部收sheet不连带顶部 | 从屏幕底部覆盖当前app与W5 input，W5不抬移、不改x/y/尺寸作sheet避让 | 独立槽位，移除与动画回调须防旧generation误收新窗 |

> 当前目标常规窗口：入口 + 顶部卡片或药丸 + 浮动输入 + 按需独立sheet；无W2的旧施工差异仍按原目标收口，隐藏态召回条沿用。问题文字作答复用W5 answer模式；完整form与审批额外复用旧focusable面板，由Service而非OverlayWindows管理，不计新增常驻槽位。工作区/会话/命令可复用同一列表数据模型，但选择surface不属于W5子树；＋底部sheet必须独立W7并覆盖input，不得以数据共用为由inline撑输入，亦不得改composer y/位置把它抬到sheet上方。旧细条曾为窗口8×88/可视8×64dp，此为历史触区参考，不是本轮新边滑尺寸确认；应验证有界命中，不泛称所有像素严格窗口=可视。

### 3.2 布局参数要点

- `TYPE_APPLICATION_OVERLAY`（API 26+ 统一；不需要 `TYPE_PHONE` 这类旧类型，`minSdk 26` 下没有历史包袱）。
- `PixelFormat.TRANSLUCENT`；禁止设置 `FLAG_LAYOUT_NO_LIMITS`（会绕过钳制）。
- `softInputMode = SOFT_INPUT_ADJUST_NOTHING`（非输入窗）——现行先例：球/光环窗设它治「键盘弹出整体上跳」（`OverlayService.kt:289-290`、`:315-316`）。
- 输入窗保留 `SOFT_INPUT_ADJUST_PAN` 的原生顶起（`OverlayService.kt:375-377` 已验证），**不要**改成自己监听 IME insets（旧方案已废，见 `:327-329` 注释）。
- 入口/药丸/召回条用 `FLAG_NOT_FOCUSABLE`；**卡片是返回键需求的例外**：NOT_FOCUSABLE 窗收不到 BACK，因此改 focusable + ALT_FOCUSABLE_IM，在窗口根 BackKeyPanelLayout 消费 BACK。卡片不应弹 IME；输入区打开时仍由输入窗持焦。该调整是满足 F-18 的最小方案，若干扰底层 IME 必须继续修，不能据 flags 宣称验收通过。

### 3.3 可用高度与避让

- 「可用屏幕的 32%」中的**可用高度**定义：`currentWindowMetrics.bounds - 状态栏 - 导航/手势条`（API 30+ 用 `WindowMetrics`；API 26-29 回退 `displayMetrics.heightPixels` 与资源取状态栏高度）。该定义必须写进代码常量注释，并在测试里用两种取值方式各断言一次。
- 卡片顶部避开状态栏；下拉到40%不改变顶点。32%/40% 是**硬上限**，量化不得向上越界，180dp小屏地板建议无效；内部滚动/压缩chrome解决空间不足，不得以可用性为由放宽比例。
- 横竖屏均按「短边/长边无关，按当前可用高度」计算，转屏时重算（现行 `panelWindowWidth()` 已给出「必须每次重算」的先例与理由，`OverlayService.kt:339-350`）。

### 3.4 中间空白/输入外部收底部，不关顶部（当前F17）

**当前裁决**：用户2026-11-12直接澄清「中间空白点击收下面输入和键盘，不关上面输出」。旧版把ACTION_OUTSIDE接顶部hideCard的解释已废止，不可再把它当F17通过条件。

| 触发位置/动作 | 当前目标 | 不允许的副作用 |
|---|---|---|
| 顶部与底部之间空白，或底部input外部 | 退出底部编辑、隐藏IME/浮动composer；选择sheet若开则收sheet，消息/答案草稿保留 | 不能hide顶部card、清历史、收pill或停Agent |
| 选择sheet的外部/返回 | 收选择sheet并按底部编辑状态处理IME；顶部不变 | 不能以sheet退出为由取消提交或重建顶部 |
| 入口原语、白条形变、长条距离收起 | 按当前动作改变顶部形态，无顶部X/形态/隐藏按钮 | 不能把空白tap当顶部关闭，也不能恢复旧按钮作替代 |
| 输入可见时返回 | 优先底部编辑/answer或sheet退栈，隐藏IME规则明确 | 不可穿透到顶部同一次关闭，不能顺带丢草稿 |

实现约束：底部窗口可用NOT_TOUCH_MODAL/WATCH_OUTSIDE_TOUCH接收失效边界，但必须把outside路由限制在底部域，FLAG本身不是验收证据；不能用全屏透明overlay捕中间空白。透明根只容纳有界浮动chips/input，不能把不可见整块根当按钮拦截。顶部即使监听outside也不得调用hideCard。一次底层tap尽量仍到目标app，需真实tap+截图/IME与窗口事实证明。

历史时序：此前同DOWN/outsideClosedCardDownTime修复针对“outside先收顶部后入口延迟tap误重开”的旧路由；其日志/报告保持历史，新语义下入口显式tap仍按自身DOWN状态裁决，但不能用旧outside关闭动作证明当前F17。

### 3.5 z 序与增删纪律

- 同 `TYPE_APPLICATION_OVERLAY` 的窗口按 `addView` 顺序叠，后加者在上（`OverlayService.kt:300-305` 的真机结论）。
- 目标顺序：旧路径光环→入口/召回；v2入口→顶部卡片或药丸→浮动输入→独立选择sheet。sheet与input不是父子layout；remove/add须成对，不以全屏透明父窗统一捕触摸。
- 隐藏/召回沿用现有例外写法：例外只允许集中在一个函数里，并用契约测试钉住（`recallBall` 先例，`OverlayService.kt:459-485`）。
- `onDestroy` 必须逐窗收口；任何「面板/卡片不在了但子窗还在」都是缺陷（`hidePanel` 的 FX-212.1 纪律，`OverlayService.kt:408-430`）。

---

## 4. 当前UI状态与交互约束

### 4.1 正交展示域

- 顶部为CARD（真实Markdown/工具调用/多行历史）、CARD_EXPANDED（40%上限）或CAPSULE（横向长胶囊，一行最新真实Agent输出）；兼容旧源码名PILL不代表继续短状态pill外观。
- 底部INPUT与独立SHEET分别管理；sheet覆盖input，不改input的x/y/尺寸作避让。顶部收成长条不自动收input；长条明确收起完成才联动收当前input/IME/sheet。
- 入口默认自由球，另有左/右strip，显式形态设置只在应用设置。Agent态、sid、消息/答案草稿、IME、系统取件期间flags让行是独立数据/交互状态。

### 4.2 当前转换表

| 当前态 | 触发 | 目标与副作用 | 必须避免 |
|---|---|---|---|
| 任意 | 入口点击/双击/长按 | 保既有展开/切换顶部、进入本体、顶部+独立输入原语；平台超时/手势裁决保留 | 拖动/侧滑后补发tap；恢复顶部按钮代动作 |
| CARD/CARD_EXPANDED | 白条上推拖动，保既有长按识别 | 跟手非线性连续收为CAPSULE，慢推/停顿也可，不以末速过门；不足/CANCEL平滑回位 | UP后突然删card加短pill；以旧48dp/500门拒慢推 |
| CARD | 白条下拉 | 32%→40%能力保留，稳定row不重建，结算必要几何 | 每帧WM height/历史列表重测制造形变 |
| CAPSULE | 单击长条 | 恢复当前真实会话顶部卡片 | 清空history或显示另一sid内容 |
| CAPSULE | 自由拖到顶部限位区 | 保持可见；停止拖动只停住 | 单到顶、仅停住就隐藏 |
| CAPSULE（顶限位） | 继续向上距离进入/超出宽容区 | 先容错保持，超出后按距离连续渐淡/收起；未达完成条件松手回弹 | 要另一次新DOWN/高速，跳过宽容区直接隐藏 |
| CAPSULE收起完成 | 距离驱动收起明确完成 | 收长条及当前input/IME/sheet，保草稿/历史/Agent，保入口恢复路径 | 业务取消、清草稿、残留键盘/sheet或透明触区 |
| 顶部与INPUT并存 | 中间空白/输入外部tap | 只收底部input/sheet/IME，顶部保持、草稿不变 | outside关闭顶部 |
| 自由球 | 拖到左/右边，再继续朝同一边缘侧滑 | 进入相应侧strip；距离/曲线可配置待实测 | 单到边即变条、只支持右侧 |
| strip | 朝屏内拉出 | 恢复自由球，可跨屏拖到另一侧再侧滑收条 | 松手强吸回原侧、禁止跨屏或左右规则不同 |
| 系统取件/相机 | 发起/结束/取消 | 原窗/原sid/text/selection不移不重建；临时交互flags让行后恢复，成功只append附件 | 主动hide/remove/receipt-show重建，“保文本”代保同View |
| 真Service销毁 | 生命周期终止 | 收口窗口/订阅/本地回调，保业务unknown边界 | 把Picker/sheet打开当销毁信号 |

### 4.3 稳定内容与距离进度

- 当前sid真实user/assistant记录为主体；助手正文Markdown、工具调用可辨识且接近DSH，reasoning/工具结果不伪作正文。按稳定id增量更新、保滚动锚，仅原本贴底时跟随新内容。
- 长胶囊使用最新真实Agent可见输出派生单行，可省略并恢复card查看正文；状态可辅助但不能占唯一输出位。无输出如实说明，不编造或只填“空闲”。
- 分别定义card→capsule非线性形变进度，以及顶限位后的宽容距离、渐淡距离、完成距离；未确认参数可配置/待实测，不带回旧测试阈值作产品门。
- 跟手在已有有界窗口内做局部形状/裁剪/位置/透明度插值，保证可视与命中一致；不全屏透明、不逐帧WM高度/历史重测。sheet仍只alpha/translation显隐，不height动画。

### 4.4 动画与终态

| 场景 | 当前要求 |
|---|---|
| card→长胶囊 | 白条拖动直接跟手非线性形变，内容收敛到最新真实输出单行；慢拖成立，不足/CANCEL回位 |
| 长条顶缘收起 | 限位→宽容区→超出距离渐淡；不足回弹至清晰可见，完成联动收input/IME/sheet |
| 输出更新 | 稳定row/文本增量，淡化时长可配置待实测；旧60+60/120等只属历史 |
| sheet显隐 | 独立窗alpha/translation，不抬input，不height/每帧WM resize |
| 关动画/detach/快速往返 | 即时最新终态，旧onEnd/generation不得误移新窗或改草稿 |

旧动画读数与设备结论只对应当时输入，本节没有预填帧时/延迟/性能PASS。

## 5. 数据流

### 5.1 数据源与职责

| 数据 | 来源 | 现状位置 | 新设计用法 |
|---|---|---|---|
| 引擎是否在线 | `EngineProbe.check()` 10s tick | `OverlayService.kt:663-680` | 卡片状态行 + 药丸「引擎离线」 |
| Agent运行态 | mux api-session/status | 既有Service/Panel通道 | 仅辅助状态与轮次边界，不能取代长胶囊最新真实输出 |
| 工具调用 | `.live.ndjson` `k=tool_call/tool_result` | `OverlayLiveFeed.kt:101-143` | 卡片工具列表 |
| 当前会话真实历史正文 | 上游公开Session conversation/history/events snapshot及可见follow订阅 | task29宿主投影施工中 | user/assistant多行正文为顶部主体，空闲/reopen仍显示，不能用live摘要或工具结果冒充历史 |
| live助手摘要 | `.live.ndjson` k=text，sum≤160 | bridge投影（历史实现） | 只作进度辅助，不替代真实正文 |
| 思考摘要 | `.live.ndjson` `k=think`，`sum` 首行 ≤120 字符 | 插件 `reasoningSummary` + `assistant/message` | 消费已实现；不承诺逐字流（§5.3） |
| 轮次结局 | `k=turn_end`（`ok`/`kind`） | `index.ts:2189-2200` | 完成/失败/中断文案 |
| 待答/审批 | Mux `$events` + Panel原pending真源 | `questionTextTarget/questionTextAnswer` strict helper + full form | v2问题进入底部answer模式，逐题保存并保持原message草稿；完整表单保选项/多选/跳过，审批reason/二步确认不变 |
| 会话列表 | 页面sessions()优先、合法RPC降级 | OverlayPageHost/服务真源 | 数据可与工作区/命令复用；选择用独立W7 surface不嵌W5，失败与真空区分 |
| 工作区列表 | 页面`workspaces.list.getSnapshot()`优先；文件仅降级 | `OverlayHost.state/workspaceSnapshot` + `WorkspaceListParse` | ready/error/pending/真空列表分开，openWorkspace只走页面真源（§6.3） |
| 命令清单 | 上游官方per-session input-trigger menu snapshot | 页面commands()/公开controller | 独立sheet只渲染动态items，兼容DOM旧链不是后台主路（§6.4） |

### 5.2 聚合模型（已新增，独立轮次/连接维度）

```
OverlayUiModel.kt（纯 Kotlin，可单测）
  // 当前设计示意，非已验证源码签名；CARD正文支持Markdown/工具调用结构
  data class CardModel(
    val agentState: AgentState,        // idle/running/waiting/error
    val headline: String,              // 单行当前动作：工具名+摘要 / 思考摘要 / 状态文案
    val thinkingLine: String,          // 最近一次合并后的思考行（≤120 字符）
    val toolRows: List<ToolRow>,       // 状态辅助，最多50
    val transcript: List<TranscriptRow>, // 当前sid真实user/assistant多行正文，独立预算见§5.5
    val pending: List<PendingItem>,    // 审批/提问
    val turnStartedAt: Long,
    val lastEventAt: Long,
  )
  data class CapsuleModel(val latestAgentOutput: String, val tone: Tone) // text必须是真实可见输出；tone仅辅助，旧PillModel名字可兼容
  data class ComposerModel(
    val workspace: WorkspaceChip,
    val session: SessionChip,
    val draft: String,
    val attachments: List<AttachmentPreview>,
    val commands: List<CommandItem>,
    val pendingQuestion: QuestionPrompt?,
  )
```

- 聚合层必须是**纯函数 + 不可变模型**：输入是事件，输出是模型差异（`CardModel → CardModel`），渲染层比较差异后决定是否动 View。这样事件合并、去重、上限、排序全部可单测，不需要设备。
- 当前聚合模型以 `OverlayCardModel` 为真源，增加独立 `turnActive` / `engineOnline`：`onRuntimeStatus` 只在首次或下一轮 true 清理，重复 true 不清内容；`onEngineStatus` 只改连接态，离线优先展示但不伪造失败/结束。不同非空 callId 的同名工具不合并，结果可标 failed；切会话由编排层重置模型并推进 generation，迟到页面/发送回执不得污染新会话。
- 渲染层只做三件事：绑定文本/可见性、量化尺寸、播放动画；不能把离线 ERROR 与轮次失败混为一维。

### 5.3 思考摘要的数据源（旧施工已实现，仍仅作状态辅助）

施工现状：
- 插件在 `assistant/message` 分别投影可见正文与 reasoning 摘要，`reasoningSummary` 只取 reasoning 首个非空行并限长 120；两条 live 行互不混合。见 [插件事件投影](<plugins/dsh-android-bridge/src/index.ts>) 与 [摘要纯函数](<plugins/dsh-android-bridge/src/notify-projection.ts>)。
- 上游 `TextBlock` 与 `ReasoningBlock` 共用 `text` 字段——该判断来自本仓插件注释的转述（`plugins/dsh-android-bridge/src/index.ts:2181-2182`，注释原引 `dsh/packages/llm/llm/src/types.ts:54-64`），**上游类型未在本地独立核对**。

已实现线格式（本仓 bridge 插件 0.2.5）：

```json
{"t":<ms>,"s":"<sessionId>","k":"think","sum":"<首行/前120字符>"}
```

- 触发点与 `assistant/message` 同一事件：从 content 中取 `type==='reasoning'` 块的 `text`，按「首行 + 截断 120 字符」投影；空/纯空白不写。
- 每个 `assistant/message` 写一条非空 reasoning 摘要；壳侧 `OverlayUiModel` 原地替换单行（400ms 语义合并窗口）并由编排层 100ms 合并渲染。插件没有独立的逐字 delta 通路，不能把消息级摘要写成实时流。
- 兼容：壳侧 `when (k)` 的 `else` 分支忽略未知 `k`（现有实现即如此），旧壳不受影响；插件需 bump 版本并同步镜像到本仓 `plugins/<同名目录>`（AGENTS.md 铁律 5）。
- 若 Phase 2 发现上游存在**流式 delta 事件**（例如 `assistant/delta`，本仓源码里**未确认**存在），则可升级为真流式；验证方法：在插件 `session/event` 回调里对未知 `ev.type` 记一次日志，跑一轮长思考任务后读日志（`docs/AGENTS/gotchas.md` 记录日志落盘位置）。

**未确认项**：reasoning 块在 `assistant/message` 时是否已经完整（一次性到齐）——若是，单行摘要只能是「每条消息更新一次」，不是逐字流。该事实决定 R6 的观感上限，必须在 Phase 2 第一周用真机日志确认。

### 5.4 线程与背压

- 全部 UI 状态在**主线程**（`Handler(Looper.getMainLooper())`，沿用 `OverlayService.kt:55`）。
- 文件/网络读取在后台线程，结果 `post` 回主线程（沿用 `drainLive()` 模式，`OverlayLiveFeed.kt:67-94`）。
- 合并策略：每类事件最多 `1 次/100ms` 触发聚合；聚合函数为纯函数，可丢弃中间态（幂等）。
- 状态辅助仍toolRows≤50/pending≤8/thinkingLine≤120；真实历史独立有界投影（§5.5），不能将120字单行思考约束套给user/assistant正文；超界明确截断/加载边界，不冒充完整历史。

---

### 5.5 当前会话真实对话与工具历史（当前源码合同，验收待补）

- 顶部主体来自当前会话公开SessionBinding.eventSource的snapshot/follow；运行与空闲/完成后都可查看，重开已有会话需回读。user只取source.kind=user的可见text，assistant只取text块并保多行；reasoning/system注入排除，真实工具单独投影，不能伪作assistant，不用DOM innerText/私有缓存或编造消息。
- 当前线格式为transcript[{id,role,text,toolName?,arguments?,result?,state?,truncated?}]；role仅user/assistant/tool。工具由tool/call或assistant/message的tool-call块取名/参数，与tool/result按session+turn+step+callId配对；state为running/success/failed，不把结果meta或任意对象JSON.stringify成正文。稳定ID不截短，ID超1024字符拒收。最近40行共享预算：对话text≤4000 codepoints，toolName≤256 codepoints，arguments/result各≤1600 codepoints；包括ID/转义/metadata在内的完整transcript JSON UTF-8≤24576 bytes。页面与Kotlin分别复验；省略旧行或截断字段须truncated标记。空历史/加载中/读取失败分开，idle/running不是清历史条件。
- 顶部card/长胶囊或composer可见时watchState订阅公开snapshot/follow变化，切sid/隐藏/销毁撤旧订阅，不新增永久poll；live状态独立合并，不重置真实记录。[页面host](<../../dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>)→[Kotlin解析](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>)→[唯一类型](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayViewTypes.kt>)→[原生卡片](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardView.kt>)为当前链，源码合同不代表设备通过。
- native按id复用row并就地更新语义字段，用户读旧消息保滚动锚，头部淘汰有存活行回退锚；仅原本贴底时跟随，流式新内容不强抢滚动。assistant由[OverlayMarkdown](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayMarkdown.kt>)投影native spans，user/工具参数与结果保持literal；链接只显示不执行，HTML/图片/危险URI不执行不抓取。32%/40%硬上限不变，溢出内滚；不得以单行120字摘要代正文、不得每批重建全树。

## 6. 与 DSH 的接口面

### 6.1 复用（不改动）

| 能力 | 接口 | 证据位置 |
|---|---|---|
| 会话列表 | RPC `session/list`（`{_request:{}}` → `result.value.items[]`） | `OverlayPanel.kt:1250-1328` |
| 发消息 | RPC `session/prompt`（`{request:{requestId,sessionId,mode,content:[{type:'text',text}]}}`） | `OverlayService.kt:762-822` |
| 取消轮次 | RPC `session/cancel` | `OverlayService.kt:748-759` |
| 新建会话 | RPC `session/create`（可带 `workspaceId`） | `OverlayService.kt:799-818` |
| 执行命令 | `POST /api/commands/execute`（`{agentId,line,submittedAttachments}`） | `docs/AGENTS/gotchas.md:862-867` |
| Agent 运行态 | `$events` 的 `api-session/status`（`args=[agentId,running]`） | `OverlayPanel.kt:179-192` |
| 审批/提问应答 | `POST /api/$events/result` | `OverlayPanel.kt:1023-1147` |
| 工具/正文/结局事件 | `.live.ndjson`（`tool_call`/`tool_result`/`text`/`turn_end`/`title`） | 插件 `index.ts:2159-2205`；壳 `OverlayLiveFeed.kt:96-165` |
| 引擎探活 | `EngineProbe.check()` | `OverlayService.kt:663-701` |
| 端点与鉴权 | `EngineEndpoint` + `EngineAuth.attach` | `EngineEndpoint.kt:10-71` |

### 6.2 新增能力（全部是「加法」，不改既有签名/协议）

> 约束复述：不改 DSH 上游；不改既有桥方法签名；不改 `$events` 帧形；不删改 `.live.ndjson` 既有字段。

| # | 新增项 | 落点 | 用途 | 风险/代价 |
|---|---|---|---|---|
| N1 | live 行 `k=think`（`{t,s,k,sum}`，首行 ≤120 字符） | `plugins/dsh-android-bridge` | 卡片思考摘要（§5.3） | 插件版本 bump + 镜像同步 |
| N2 | `tool_call` 行**追加** `callId` | 同上 | 工具行「进行中/完成」配对 | 纯加字段，旧消费者忽略 |
| N3 | 页面宿主 API `window.__dshOverlayHost` | `dsh-client-ui-responsive`（本仓） | 原生读取「当前会话 id / 工作区 id / 命令清单」，并执行 `openSession` | 新增本仓前端面，需单元测试 |
| N4 | 原生侧 `OverlayPageHost`（Kotlin→JS 单次求值 + JSON 回执） | `MainActivity`/`OverlayService` | 调 N3、拿回执 | 复用现有 `evaluateJavascript` + `jsString()` 转义（`AndroidBridge.kt:845-853`），只在主线程发起 |
| N5 | `OverlayUiModel` 聚合层 | 壳侧新文件 | 事件合并（§5.2） | 纯 Kotlin，可单测 |

**为什么用「页面宿主 API + 原生求值」而不是新增多个 `@JavascriptInterface`：**

- 会话/工作区权威真源在页面（`<html data-dsh-session-id>`，`session-marker.ts:26,63-75`；工作区在 `uiWorkspace` store）。原生反查一个页面 API 比让页面主动推多个桥方法更简单，也不扩大「JS→原生」安全面。
- `check-bridge-symmetry.mjs` 守桥面对称性；新增 JS→Kotlin 方法需要同步桥协议文档与基线，成本高于加一个只读页面 API。
- 若 Phase 2 发现 N3 无法稳定获取某字段，再降级为「新增单个桥方法 `publishUiState(json)`」（只加不改），并在 `BRIDGE-API.md` 登记。

### 6.3 会话身份与工作区身份（必须先解决的真源问题）

**更正Phase1推论并保留取证时序**：不能由非目标状态事件猜发送目标，但agentId/sessionId不是必异域。前轮在错误实装0.2.1-rc.2依赖读到same-axis契约，此历史证据不能冒充rc.1；本轮独立重读正确 [session-controller 0.2.2-rc.1](<dsh-client-ui-responsive/node_modules/@deepseek-ai/dsh-api-session-controller/package.json#L2-L4>)，其 [ISession](<dsh-client-ui-responsive/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/session.d.ts#L62-L65>) 仍明确host identity（agent id—same axis），[create链](<dsh-client-ui-responsive/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js#L430-L438>) 传sessionId，[status生产](<dsh-client-ui-responsive/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js#L3836-L3837>) 发agent.id。变量按“发送目标/忙态匹配”用途区分，页面实际session face给agentId，服务先过滤目标再写状态；同轴不授权任意事件覆盖用户选择。最终运行依赖/设备关联仍按测试报告验证。

新设计三条硬规则：

1. **用途与选择分开，不制造假异域约束**：`currentAgentId` 用于运行态匹配，`currentSessionId` 用于发送目标；即使当前版本同轴，也必须先校验事件属于选中会话再写忙态，不能任何 running 事件都改发往目标。反证应是「非目标会话事件不污染、已选目标不丢关联」，不是要求这两个 ID 永不相等。
2. **会话身份页面优先、合法来源降级**：从 N3 的 `__dshOverlayHost.state().sessionId` 采纳；页面通道不可用可显式选择 `session/list` 的真实 sessionId，新会话采用 `session/create` 回包。不得用非目标事件猜发送目标；`state.agentId` 由页面实际 session face 提供（本版本同轴）。当前并非「页面不可用即完全禁发」。
3. **工作区/命令只走真源**：工作区当前归属按页面 workspace 快照查 sessionIds；续工 `openWorkspace(id)` 走页面 uiWorkspace，成功后再设新会话目标 override，不再只本地改标签。命令execute在官方菜单能力在场时走当前scope的menu/pick并前台UI交接，不由Kotlin拼agentId/命令HTTP payload；无menu保留resolveClaim/claim.submit兼容分支，详见§6.4的handedOff边界。

**工作区列表**：真实页面真源是`ctx.workspaces.list.getSnapshot()`，不是service.getSnapshot；列表phase必须ready且state非error才可用。PageState新增`workspacesReady`（缺省false）与`workspacesError`，明确区分服务缺席、pending、error与ready空表；不得把前三者画成「没有工作区」。`openWorkspace(id)`先验ready/成员，走页面uiWorkspace并等实际operation结果，成功后刷新真源与新会话目标。页面不可用时`WorkspaceListParse`只读HOME中的workspace.json作降级，不可冒充页面已切换；端到端同步仍需设备证据。

### 6.4 动态命令（真源已定位）

- **真源**：上游 `ui-input-trigger` 命令目录 / 客户端命令贡献，不是壳侧也不是硬编码表。本仓已有两处同源消费先例：`dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts:3-19`（打开上游菜单后读 `[data-composer-card] [role="listbox"] [role="option"]` 逐项复制，「本模块不认识任何具体项」）、`reference-menu.ts:32-34`（按上游注册名定位行）。
- **当前执行链（官方菜单主路，已落盘/设备未验）**：Kotlin捕获commandSession并jumpToApp；页面execute先等document.visibilityState=visible（最多10s），再新借官方菜单、定位canonical candidate.name对应行，调用controller.pick("command",index)，返回`ok+handedOff`仅表示已交官方输入prepare/popup/action/bare-host管道，**不是handler执行完成或任务成功**。原生文案为「已交给主界面命令菜单，请完成后续选项」。无menu能力时保留resolveClaim/claim.submit兼容分支，其结果语义与主路handedOff不能混同。
- **唯一允许的固定集合**：附件行标题闭集 `ATTACHMENT_ROW_TITLES = {文件,本地文件,file,files,local file,local files}`（`composer-sheet.ts:191-193`），仅用于去重，注释要求精确匹配、禁止按位置/前缀。
- **落地**：commandsJson→refreshCommands→withOfficialMenu默认读官方per-session controller.menu，不依赖后台DOM/focus；测试注入readCommands时保留兼容读取面，不能说当前主路仍读composer-sheet DOM。canonical name已有/则保留，否则补/作token，label仅展示；按session隔离缓存1s，未就绪显式error/重读。原生commandsOrNull5s预算读取不冒充空表；25s/30s操作未知态预算见§6.5，不授权重发。
- **禁止**：Kotlin 里写命令清单；按固定顺序/位置识别菜单项；复制私有实现而不抽公共函数。
- **官方菜单最小校正已实现（57轮保留历史，ready4s轮58保历史，冻结附件62/全量1274结果见实施计划§20，设备边界由测试报告单一维护）**：后台DOM链连续commands-not-ready促成主路改官方menu。独立核读 [withOfficialMenu](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts#L309-L358>) 与 [装配](<dsh-client-ui-responsive/src/client/index.ts#L598-L607>)：仅menu未open且输入有真实draftRev/非submitting或adjudicating时借用，retain确切session/scope，构造真实revision的[0,0]leading / hit；先将SessionReference.ready等待限制为4s（超时session-not-ready），**菜单command group另有独立4s预算**；finally清readiness timer并release引用，迟到ready后下一轮可重试、不cache空目录。sid/scope/draftRev或hit/generation变化即拒绝。finally仅在仍为自身hit同generation时dismiss，不抢关用户菜单、不读private candidates/directory、不硬编码命令清单。公开 [controller契约](<.deploy-tmp/overlay-host-evidence/command-discovery/trigger/package/lib/types/client/controller.d.ts#L35-L38>)、[MenuState](<.deploy-tmp/overlay-host-evidence/command-discovery/trigger/package/lib/types/core/contract.d.ts#L29-L45>) 与 [candidate字段](<.deploy-tmp/overlay-host-evidence/command-discovery/trigger/package/lib/types/types.d.ts#L34-L52>) 是来源；旧51定向属上一输入，不覆盖本次新增菜单逻辑。

### 6.5 最终操作回执、未知态与附件移交（页面宿主v2）

权威实现：[页面OverlayHost](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts>)、[原生OverlayPageHost](<app/src/main/java/com/dsharnessmobile/shell/OverlayPageHost.kt>)、[v2编排](<app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>)；不新增JS→Kotlin接口。

1. 方法调用仍同步返回JSON字符串，evaluateJavascript单次2500ms；异步send/execute/openWorkspace回`{pending:true,operationId}`。operationId由**每个页面宿主实例nonce+递增序号**组成，避免页面重建后旧票据撞号。同一未结操作key返回原票据，不再次调用提交。send/execute带捕获的expectedSessionId，并retain确切session/scope，代次不符不能提交到新会话。
2. 页面25s计时只把结果标为`pending+unknown`，**不Abort已调用handler、不伪造false、不释放active key或在途附件**；调用后抛异常也只能unknown。只有实际success/error结果才能结算Boolean。operation-not-found也是unknown，不得据旧页面票据失联重发。明确调用前校验拒绝才可直接返回失败。
3. 原生PendingAction按票据追踪，自动poll最多一轮30s，间隔100ms指数退避至1s。页面不可用、单次空回包、票据缺席或预算耗尽触发onUnknown，保留待确认操作；`recheckPendingActions()`只重查原票据。v2保留sending/commandPending锁，用户再次点击改为重查而非重发。`cancelPendingActions()`由v2.destroy调用，只撤原生查询/回调并通知unknown，**不证明引擎未执行，也不撤销页面handler**。初次求值丢失票据时的unconfirmed占位同样不能自动重试业务。
4. 带附件发送在可编辑phase、完整附件存在且上传ready等前置通过后，**同步把本批稳定附件ID从页面输入rail detach为in-flight**；注册表仍保留字节，页面不能再提交这批。页面使用捕获ID快照，原文字/结构化refs不setDraft、不覆盖。带附件且公开serializeDraftAttachments与确切Session.prompt在场时，优先无RAF提交：序列化捕获IDs得到content，一次生成fixed UUID，沿exact Session.prompt(content,queue,signal,requestId)，不等待可见帧；只有literal receipt.ok===true且value.accepted===true才释放本批registry附件。明确非gateway/的非空业务error code才保原code/message并restore/keeper；rc.1实际carrierFailure折成ok=false+gateway/internal，及gateway/cancelled/unmounted/新gateway码、空code/缺字段、accepted非true均UNKNOWN，不能当业务拒绝归还重发；旧runtime缺能力仍保sendSession兼容分支。真实拒绝或调用前代次/移交拒绝只补回当前缺失ID；若输入仍submitting/adjudicating，订阅等待恢复可编辑再补，不能抢写。真实成功结算该批；调用后unknown继续持session/在途附件/锁。明确拒绝恢复附件后，若仍为确切session generation，将retain转交共用keepDraftReference的rail keeper；切A→发→切B→拒绝→回A仍持有附件，只有rail真正为空或host/runtime dispose才release。不是恢复ID后立即release把A字节回收。
5. 命令官方menu主路pick交接给上游输入管道，handedOff只表示交接，不证明handler完成；兼容resolveClaim/claim.submit分支使用空附件列表。取件targetSessionId/requestId与draft-ready只证明进入确切草稿，不等于消息发送。nonce/operation表/native pending/sending锁/in-flight与rail keeper均为页面/进程临时状态，不新增持久prefs。附件图片/文件可纯附件发送，V2不能在trimmed为空时先拒绝；须同一activeSession的pageState且无Bus pending，页面未就绪不能误降为纯文本发送。

### 6.6 冻结P1：原生RPC严格受理与附件确认

- [Service解析器](<app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt>) 的prompt/cancel/create不再把HTTP200当成功：postRpc先校验type=server-response且rpcId与本次外层请求精确相等（错type/错id即-1/UNKNOWN），之后须Boolean result.ok=true；prompt/cancel还需Boolean value.accepted=true，create需非空字符串sessionId。result.ok=false/accepted=false/非200为明确拒绝；transport=-1、损坏/截断/缺字段、字符串true或错误类型保UNKNOWN，不能据200清草稿或乐观忙态。
- 文本unknown保PendingOverlayTextSend与一次生成的requestId；再次发送仅recheck原票据，读session/state.queue[].rpcId，再读session/events中的event/user-message/source(kind=user,rpcId)。找不到/截断/无权查询不证明拒绝，不重发prompt或create；正面证据才结算accepted，且不将已完成轮次重亮busy。回滚旧面板也尊重cachedV2未知锁。
- Proxy/Bus回执为kind/path/error/sessionId/requestId；V2只接activeSession且已知requestId，旧三参handler仅兼容口。Bus最多64 outstanding，同sid+kind再次点击只recheck原request，不开新picker/不新POST；交付HTTP或查询超时只attachment-pending未知，removed才明确fail，draft-ready才成功。pending附件挡住发送并触发同request重查，不把缺回执视为没附件而发纯文本。
- 入件runtime retainSession的ready限4s，timeout释放引用并保条目可重试；成功后retain移交rail keeper。consumer admittedEntries防重复add、pendingAcks只重试complete，插件completedDraftTickets同ticket幂等并有256项上限；ack丢失不能再attach或自动发送。
- 来件超时仅施于安全阶段：list GET连同JSON、complete ACK、receipt GET连同JSON为4s且释放busy/同票据可重查；receipt晚body不回写旧状态。claim会移除durable记录再回process-local ticket，content持同ticket读blob，**不能一律race 4s丢掉迟到ticket或标removed**；晚于4s仍保持原hydrate attempt/retain，不二次claim，最终只attach一次。
- MIME取contentResolver.getType并随saved state恢复，camera压缩明确JPEG，未知/非法MIME回application/octet-stream，禁止按扩展名猜JPEG。不承诺进程死亡耐久恢复/exactly-once。

### 6.7 冻结P1：UI-only重建、语言与回滚

- [Service](<app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt>) 缓存同一cachedV2。entry_ui_v2关闭只suspendUi撤窗口/停可见时钟；重开resumeUi，不destroy、不cancelPendingActions、不换模型/票据。live/探活/status/pending仍更新缓存实例。真正Service.onDestroy才清RPC回调、destroy cachedV2、cancel原生观察/注销motion，UI开关不是业务取消。resumeUi重新读取真实前台态，UI重建后后台且用户未隐藏时必确保入口：前台采集的无entry快照不能使后台恢复后无入口；[Recreation反证](<app/src/test/java/com/dsharnessmobile/shell/OverlayV2RecreationTest.kt#L101-L105>)覆盖该形态。
- [OverlayV2.recreateViewsPreservingState](<app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>) 对locale/uiMode/fontScale/density变化只重建缓存资源View，保存text/selection/focus、展开档/DrawerMode、可见面与入口/药丸坐标；model、session/page generation、sending/commandPending/宿主tickets不重置，不创建第二份操作observer。
- 语言真源仍AppLanguage.PREFS/ui_language：Service订阅该key覆盖全部写入入口，MainActivity setter即时接onLanguageChanged；完成态存completionKind，渲染时按当前语言派生label，自定义旧label兼容。两轨草稿按会话baseline移交，仅无冲突才导入，不覆盖另一轨新增文本；unknown动作同实例保锁，再次点击只查原结果。

调试验证仅复用既有`home/.dsh/.overlay-test-pending` FileObserver分支：debuggable包接受v2-on/v2-off并只写原`overlay_display/entry_ui_v2`，由相同prefs监听不停Service切换；release不进入该分支，不增加桥/模型能力。此口用于真实回滚和同口径新旧性能取证，不是发布设置或绕过验收。[本轮验证构建日志](<.deploy-tmp/overlay-continue/kotlin-validation-hook.log#L49-L59>)显示全量单测/assemble成功，设备与性能仍以lead报告为准。

### 6.8 当前集成：F19、可见订阅、真实缩略图与UNKNOWN核对

- [Panel](<app/src/main/java/com/dsharnessmobile/shell/OverlayPanel.kt>) 文本helper拒空/重复题ID，绑定pending对象、活动sid/agent、选中event/question；非末题只保存/推进，末题有未答项则要求完整表单补齐/明确跳过。新文本应答strict结果与原审批传输面分开，ACCEPTED仍待cancel/turn-end移除，UNKNOWN保锁/草稿。
- [V2](<app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt>) 答案缓存最多64个event:question，普通消息草稿按sid映射最多32项，A→B→A不把A文本带到B；切会话清旧pageState并推进generation。工作区标签只读同activeSid的真实PageState.workspaceName，不用targetWorkspaceIdOverride伪装已切换。
- 当前可见观察目标：顶部历史或底部输入任一需要数据时watchState(true)，真历史eventSource/Session lifecycle与输入session/workspace/input stores按当前sid订阅，true应幂等、切sid重绑；两者都不可见/暂停/销毁才false退订/清timer，无常驻poll。旧“仅composer可见”是历史接线，不能使空闲顶部失去history更新。页面100ms合并仅console失效通知，Main双engine source门禁后native100ms去抖拉真state，不推第二份状态。此澄清对应的新接线仍待冻结核读/验收。
- 图片从公开draft registry的blob previewUrl取，最多2并发/缓存8，fetch4s；ImageBitmap/canvas最长边256px，JPEG quality0.7 dataURL总长≤49152字符才发。原生再验JPEG/base64/长度与解码尺寸1..256，显示实际40dp缩略图点按160dp预览，失败明确预览不可用，不传原图或任意URL。
- 无RAF发送前Session.ready4s、serialize8s前置deadline，超时未调用prompt可恢复rail/keeper，迟到完成不得再提交；调用后carrier未知保持fixed request与原operation。operation(id)仅查询原request正证：同sid state.queue.rpcId或events user/message source.kind=user/rpcId；查询wire还须精确type/rpcId/literal ok。缺证/查询失败不解锁、不重发。dispose中止本地observer/查询、移除restore订阅并释放ref/keeper，不证明已撤销Host动作。
- 历史实现曾对短状态pill采用60ms出+60ms入；当前长胶囊必须显示最新真实Agent输出，状态只辅助，更新动效按新内容/形变目标待实测，不把旧时长/旧输入2881绿当本轮目标已完成。

## 7. 视觉设计

### 7.1 设计原则（借鉴 Apple HIG，不做 SwiftUI 实现）

- HIG 对材质的定位是「建立前景与背景的层次」，并强调厚度（thin/thick）决定透出程度与文字对比度（[Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[SwiftUI Material](https://developer.apple.com/documentation/swiftui/material)）。
- 当前只借层次、统一圆角和有方向短动效。文字承载surface改实色以免下层文字透入；不借vibrancy、不做多档高成本模糊。旧半透明取舍是此前设计，不得覆盖用户截图确认的重叠缺陷。
- 与现有壳视觉保持一致：现有 token 体系是「Apple 式黑白极简」且由 `GuidePaletteMonochromeTest` 守护（`app/src/main/res/values/colors.xml:6-7`），新 UI 必须复用同一套 token，不新造色相。

### 7.2 色板归属（先拍板，避免第三套配色）

壳侧现有**两套并行色板**：

| 色板 | 代表值 | 用于 | 文件 |
|---|---|---|---|
| `ds_*` 中性 token（Apple 式黑白） | `ds_surface` #FFFFFF/#1C1C1E、`ds_hairline`、`ds_radius_card` 18dp | 启动页/引导页/设置页/控制台 | `app/src/main/res/values*/colors.xml`、`dimens.xml` |
| 悬浮面板自有色板 | `unitBg` #F2F8F9FA / #F21E1F24、品牌蓝 #4176E6、圆角 30dp | 眼下的 OverlayPanel | `OverlayTheme.kt:48-71`、`OverlayPanel.kt:266` |

**决策：新悬浮UI全部走ds_*色板**；当前文字承载面用实色token，有限入退场alpha动画不等于常态静态半透明。旧作答/回滚面保原色板，不向新UI增加旧色板使用点。

理由（按权重排序）：

1. 需求原文要求「优先复用现有启动页的颜色与视觉规范」——启动页用的就是 `ds_*`（`app/src/main/res/values/colors.xml:6-27`、`values-night/colors.xml`）。
2. `ds_*` 是资源化 token，双主题成对维护，且有 `GuidePaletteMonochromeTest` 守护；面板色板是 Kotlin 字面量（`OverlayTheme.kt:49-70`），继续扩展会让字面量散落。
3. 蓝 #4176E6 在 `OverlayPanel.kt` 内是裸字面量（`:266`、`:406`），不是 token；若新 UI 要用蓝，必须先把蓝收敛成资源，本期不做（避免扩大改动面）。

代价与处置：新卡片与旧作答面板**会并存且观感不同**；旧面板保留既有问答语义是明确的施工取舍，不能写成已退役。P6 仍需检查视觉衔接。若 Phase 2 想保留品牌蓝作为强调色，先新增 `ds_brand`（`values` + `values-night` 双份）并登记到 `docs/AGENTS/DEPENDENCIES.md` 之外的视觉清单，再使用。

### 7.3 Token 映射（直接复用，不新增）

| 语义 | 浅色 | 深色 | 来源 |
|---|---|---|---|
| 卡片/长pill/input/sheet底 | ds_surface实色，不额外叠静态alpha | ds_surface实色，不额外叠静态alpha | [卡片](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardView.kt>)、[长pill](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayPillView.kt>)、[Composer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>) |
| chips/附件tiles底 | ds_chip实色 | ds_chip实色 | [Composer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayComposer.kt>)、[Drawer](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCommandDrawer.kt>) |
| 描边 | `ds_border` #14000000 | `ds_border` #26FFFFFF | `:13` / `values-night:9` |
| 主文字 | `ds_text_primary` #1D1D1F | #F5F5F7 | `:15` |
| 次文字 | `ds_text_secondary` #6E6E73 | #98989D | `:16` |
| 成功/警告/危险 | `ds_ok`/`ds_warn`/`ds_danger` | 同名（夜值不同） | `:22-24` |
| 圆角 卡片 | `ds_radius_card` 18dp | 同 | `values/dimens.xml:14` |
| 圆角 药丸 | `ds_radius_pill` 999dp | 同 | `:19` |
| 间距 | `ds_space_4/8/12/16/20/24` | 同 | `:3-9` |
| 卡片最大高度 | 32% 可用高（新增常量，写入 `dimens.xml` 或 Kotlin 常量并注释理由） | 同 | 新增 |

> 32%/40%等未被改动约束保持；新增形变曲线、长条尺寸、顶限位/宽容区/渐淡距离与球条边滑参数均可配置/待实测，不把资源默认值或旧门限当用户已确认数值。确需token仍须双主题一致。

### 7.4 层次与形状

| 层 | 内容 | 形状 | 视觉手法 |
|---|---|---|---|
| L1 顶部卡片 | 真实Markdown历史+DSH式工具调用/状态，右上无按钮 | 复用圆角/token，不留X/形态/隐藏栏 | 稳定row/滚动与可读性优先，具体材质待实测 |
| L2 长胶囊 | 一行最新真实Agent输出，状态辅助 | 横向长条圆角，非旧44dp短状态pill；尺寸可配置待实测 | card上推非线性跟手形变，顶限位后距离容错/渐淡收起 |
| L3 输入区 | 各自独立有界chip窗口+输入/附件 | 无整行共用底板；input四周完整圆角离底 | chip实色ds_chip、input实色ds_surface；常态WM alpha1，间隙触摸风险另验 |
| L3b 独立选择sheet | 附件瓦片/动态命令或列表 | 独立底部窗口、顶部圆角、内部有界滚动 | 实色surface含ScrollView覆盖input/其它app，不加入input根、不透出原发送/chips |
| L4 入口 | 默认自由球/左右strip | 复用既有球/条视觉起点，边滑方向/触区与曲线待实测配置 | 外滑收条/内拉出球、可跨屏换侧；不是顶部按钮切换 |

- **阴影**：overlay 窗口的 `View.elevation` 只在窗口内生效，不能把阴影投射到窗口矩形之外（平台行为，Phase 2 spike 复核；仓内既有 picker 6dp / 报告栏 8dp 均为窗口内 elevation，不矛盾）。用「窗口内 padding + 自绘渐变」模拟 4dp 柔和边（窗口矩形会因此比可见卡片大 6dp——**这违反窗口=可视纪律**）。因此决策：**不模拟阴影**，靠 1px 描边 + 底色不透明度区分层次；如需阴影，仅接受「窗口内边缘渐隐」（视觉上是内阴影）。这条是硬取舍，写入实现注释，防止后人加 elevation 后发现无效。

### 7.5 毛玻璃 / 模糊

| 方案 | 可行性（代码/平台事实） | 结论 |
|---|---|---|
| 轻量跨窗口背景模糊 | API31+有相关能力；是否作用于目标overlay/成本/ROM差异无完整结论，不写平台绝不支持 | 不作当前功能依赖，实色文字面不为模糊退回透底 |
| `RenderEffect.createBlurEffect`（API 31+） | 只能模糊**自身窗口内**已经绘制的内容，模糊不到窗口背后 | 不采用（对「透出底层内容」无效） |
| 实色token+描边/有限动效 | 纯View绘制，文字可读性优先 | 当前文字承载面采用；不声明性能/跨版本体验已通过 |
| Liquid Glass 动态折射 | 需实时采样背景 | 明确禁止（需求原文） |

当前低成本实现采用实色token+描边/圆角，不让不相关下层正文透入阅读面；finite进退场动画仍可用alpha/translation。当前[OverlayCardMorphVisual](<../../app/src/main/java/com/dsharnessmobile/shell/OverlayCardMorphVisual.kt>)以smoothstep让旧status/history/handle在0..0.3退尽，capsule从0.5后进入，两文字层不同时可见；该分段是视觉调参，不是手势提交阈值。V2常态composer WM alpha1；最新API33 morph通过Card绘制同源真实圆角Region，不加NOT_TOUCHABLE，false才旧fallback，picker九槽.15独立。**lead设备已确认旧NOT_TOUCHABLE把alpha1请求强制cap至.80并仍透底**，API26–32/Region失败fallback限制未解决。现代Region在apply/reset/attach/layout更新、整数相同缓存去重，setter内部traversal成本待测，不称全morph纯draw-only；Region外间隙/跨UID新DOWN亦未由源码证明。用户截图重叠必须由当前包前后图验证，旧SCOPED_PASS仅驱动范围，不是UI acceptance；结果由[测试报告](<test-report-phase2.md>)单独维护。

### 7.6 字体与排版

- 正文 13sp（沿用面板现状 `OverlayPanel.kt:229/249`），标题/状态 13sp 加粗，辅助信息 11sp，时间 12sp。
- 单行思考用 `ellipsize=END` + `maxLines=1`；工具行两行（名字 + 摘要）时摘要 `maxLines=1`。
- 数字/英文用系统默认字体，不引入新字体资源（沿用现行）。
- 中文/英文文案双份：所有新文案必须同时给 `zh`/`en`，走 `UiText.t(zh,en)`（`UiText.kt`）与 `values-en/strings.xml`（AGENTS.md §5.1 强制）。

### 7.7 性能设计与可测指标

设计约束：
1. **静止零刷新**：无事件时不得有动画/定时重绘（现行 `ShimmerTextView` 只在 busy 时开，沿用）。
2. **窗口尺寸量化**：卡片高度只在跨 4dp 档位时变更，且变更间隔 ≥120ms。
3. **文本原地更新**：思考/状态行只改 `TextView.text`，不 `removeAllViews`。
4. **稳定行/滚动锚**：真实历史与工具辅助按稳定id增量更新并复用View；仅用户本来接近末尾才跟随新内容，读旧消息不得每批强拉到底。禁止每100ms removeAllViews重建全列表。
5. **单次事件处理 ≤ 2ms**（纯函数聚合 + 文本绑定），在主线程完成。

可测指标（基线与阈值方法；**本文不填数字**，由 test-plan 的 P 系列用例在设备上采集）：

| 指标 | 定义 | 采集方法 | 阈值产生方式 |
|---|---|---|---|
| 卡片展开/收起耗时 | 从点击入口到首帧稳定 | `Choreographer` 打点或 `adb shell dumpsys gfxinfo` 帧时间 | Phase 2 实测后定，先记录 p50/p95 |
| 掉帧数 | 操作期间帧时间 > 2×刷新周期的帧数 | `dumpsys gfxinfo <pkg> framestats` | 同上 |
| 拖动流畅度 | 拖动 3s 内掉帧数 | 同上 | 同上 |
| 空闲 CPU | 无事件 60s 内进程 CPU 时间增量 | `adb shell top -b -n 5 -p <pid>` | 同上 |
| 常驻内存 | 悬浮层 UI 占用的 PSS 增量 | `dumpsys meminfo <pkg>` | 同上 |
| 事件延迟 | 事件写入 .live.ndjson → 屏上可见 | 注入带时间戳事件 + 截图时序 | 同上 |

---

## 8. 输入系统

### 8.1 结构

```
W5 浮动输入（透明有界根；focusable, ADJUST_PAN）
 ├─ [工作区 ▾]    [会话 ▾]        ← 各自浮动chips，无整行底板
 ├─ 附件预览条（有内容才显示，实际图片/文件可删）
 └─ ( ＋  EditText多行  发送/停止 ) ← 完整圆角input药丸，底边留隙
W7 独立底部选择sheet（另WindowManager槽位，不是W5子View）
 ├─ 附件入口：拍照 / 照片 / 文件
 └─ 实际动态命令列表（有界滚动），覆盖下层app而不撑高W5
```

- ＋只打开/关闭W7独立sheet，最大可用高40%、内部滚动；显隐alpha/translation（≤160ms建议），不height动画，不把drawerHost加入W5。
- input正文自然多行可一次重测；＋sheet开闭**不得改变composer的x/y/测量尺寸作避让**，不能syncDrawerWindow时抬y、hideDrawer时再降回。sheet直接覆盖输入；input自身四周完整圆角，离底间距只随真实IME/导航/配置调整，不随sheet高度调整。
- 发送：同目标pageState就绪且Bus无pending时，纯文本走strict RPC；附件走页面sendSession（允许空text纯附件），unknown均保原request/ticket只读recheck。页面不在不能误降为无附件文本；拒绝missing-ID恢复后exact retain移交rail keeper，不改text/refs。prompt无新增附件字段，完整判据见§6.5-6.6，设备只据lead本轮报告。
- 停止：busy 时发送按钮变「停止」→ `session/cancel`（`:756`）。
- 待答问答（F19已实现、设备证据另验）：卡片问题通过Panel.questionTextTarget绑定原event/question/session/agent实例，在底部输入进入answer模式；messageDraftBeforeAnswer与questionDrafts按eventId:questionId隔离原消息/答案，多题逐题保存/推进，最后一题确认所有题已答或明确跳过后才按原题序提交。Back/取消回消息草稿，完整问答按钮保留选择/多选/分页/跳过；审批始终旧protected面reason+二步。新文本入口strict读取`$events/result` literal result.ok，200/损坏/流clientId换代不能作受理；UNKNOWN保答案与event锁，不重提。

### 8.2 键盘与尺寸变化

- focusable/ADJUST_PAN是既有IME基础，但旧布局通过不能证明新浮动pill/sheet适配；两向IME收放后留隙/完整圆角需新证据。中间空白须退出底部编辑/隐藏IME而不关顶部，不能只改visibility留焦点。
- 转屏/分屏/折叠：`onConfigurationChanged` 中重算所有窗口几何（现行做法 `OverlayService.kt:163-190` 附近）；输入窗存在时重新 `updateViewLayout`。
- 键盘弹起时卡片若开着：卡片不动（它在上方），但药丸/入口可能被顶——统一策略：**只有输入窗受键盘影响**，其他窗 `ADJUST_NOTHING`。

### 8.3 附件

复用现有链路（详见 `investigation.md` 第 2 节）：

| 附件类型 | 现有能力 | 新 UI 落点 |
|---|---|---|
| 拍照 | `OverlayAttachProxyActivity`复用`PhotoCaptureController` | 独立W7 sheet「拍照」瓦片 |
| 相册图片 / 文件 | 同一代理Activity→系统选择器/FileIncoming有界拷贝 | 独立W7 sheet「照片」/「文件」瓦片 |
| 交付页面草稿 | 文件置于来件工作区 → `processTargetedIncomingPath(targetSessionId,requestId,mediaType)` → incoming队列 → 页面定向认领 | 取件前绑定target/request，页面incoming(requestId)回draft-ready才报成功；不是仅靠camera origin猜当前会话 |
| 附件预览/删除 | 页面公开draft registry → 有界缩略图投影 / `removeAttachment(id)` | 图片在原生输入区显示实际缩略图，可点缩略图放大/收回；文件显示名称/类型并可删；不复制完整WebView富预览 |

> 需求基线要求真实图片预览，不能仅文件名chip冒充；已有公开blob→有界JPEG/native预览链可复用，其历史尺寸/缓存/构建证据以对应输入记录为准。本轮系统取件/相机的**当前交互**：不得主动hide/remove卡片、长胶囊、input或重建View；保同窗、原session/text/selection/草稿对象。为不抢系统焦点触摸，可临时给已有窗加NOT_FOCUSABLE/NOT_TOUCHABLE，完成/取消恢复每窗原flags，不改位置或setText模拟恢复。成功只append到发起时原目标，不覆盖text/refs、不隐式新建会话；取消/返回原样。pending仍查原request，不重复开取件器。旧prepareAttachmentUi暂收、receipt后showComposer重建是已否定的历史策略，不因其旧测试绿继续生效。

### 8.4 独立底部选择sheet（不是inline命令抽屉）

数据/执行沿§6.4公开动态菜单，不新增固定目录。W7是独立底部overlay，上附件/下命令、最大40%内滚，alpha/translation入退场，退场完成才移窗；关动画立即终态并弃旧回调。sheet不进入W5树，不用height ValueAnimator/每帧WM resize；当前height=max(自然内容高,composer高+chip高+gap+24dp)后钳可用高40%，防短sheet露半截chips；不改W5 y/尺寸避让，必须覆盖input而非抬走，小屏上限内实际覆盖另验；不扩大成全屏透明触区；outside/返回仅收底部域，顶部保持（§3.4）。

---

## 9. 当前入口、白条形变与长条收起

### 9.1 无顶部按钮；默认自由球与对称边滑

- 顶部右上X、形态、隐藏按钮全部移除，不能留下占位栏/透明点击区。显式球/条选择仅应用设置；点击/双击/长按入口的既有展开顶部、进本体、顶部+独立输入原语保持，不把形态设置混入顶部内容。
- 默认球可自由拖，单纯碰到侧边只贴边不立即变条；贴左后继续向左边缘侧滑转左strip，贴右后继续向右边缘侧滑转右strip。strip朝屏内拉出恢复自由球，恢复后可跨屏到另一侧再向外收条，左右完全对称。
- 边滑方向、位移、热区、变形曲线均可配置/待实测；与系统返回手势/普通拖动/tap严格区分，已消费的拖动/边滑不得补单击或双击。旧“松手无吸附/固定只纵向拖条”等施工描述不再阻止当前规则。

### 9.2 顶部Markdown与长胶囊的内容

- CARD运行/idle都显示当前真实user/assistant历史；助手正文Markdown、工具调用结构与DSH相近且可辨识，reasoning/工具结果不冒充助手正文。复用稳定row和滚动锚，旧单行摘要不能替代真实记录。
- 白条上推直接收成横向长胶囊；长条是**最新真实Agent输出**的一行窗口，不是只有运行/空闲状态。可省略并点回card看正文，无输出如实说明；顶部不为X/形态/隐藏腾位置。

### 9.3 白条拖动上推：跟手非线性形变

- 保留既有长按识别原语；白条上推以手势距离进度驱动卡片到长胶囊的连续非线性形变，慢拖/停顿可完成，不能再要求高速。下拉40%展开能力保留；不足/CANCEL平滑回原卡片。
- 不能只在UP删除card后突然加短状态pill；形状/裁剪/位置/透明度在有界表面内连续过渡，内容逐步收敛到最新真实输出单行。旧48dp/500dp/s快fling及后补48dp慢推是当时参数，不是本轮数值验收门；新距离、时长和曲线待实测配置。
- 不逐帧WM高度、不反复测量历史列表；sheet仍不height动画。系统关动画时直接最新终态，旧onEnd/generation不得误收新窗或改草稿。

### 9.4 长条顶限位→宽容区→距离渐淡与联动收口

- 自由拖到顶部限位区**保持可见**，到顶停住不隐藏；继续向上先进入容错宽容区，超出后根据继续上推的距离渐淡/收起。无需另一次新DOWN或高速，不能把旧16dp/500dp/s、8dp顶缘和短pill尺寸作为当前判据。
- 宽容/渐淡/完成距离与alpha曲线均可配置待实测。未达明确收起条件松手或取消时回弹到清晰可见的顶限位态；不能留下半透明残态，也不能用负屏坐标造通过。
- 收起完成时同时收当前长条、input、IME与sheet，保session/message/answer草稿和历史，Agent/服务继续。中间空白只是底部收口的F17，与长条明确收起触发的全展示域收口区分。
- 反证至少覆盖单到顶保持、宽容区慢推不误收、超区连续渐淡、未足/CANCEL回弹、联动IME/sheet收口、慢拖无高速门与入口恢复。旧参数测试/旧性能绿只属历史，不据此预填新行为通过。

## 10. 兼容与降级矩阵

| 维度 | 影响 | 设计处理 | 验证 |
|---|---|---|---|
| API 26-29 | 无 `WindowMetrics`、无 `RenderEffect`、overlay 类型已是 `APPLICATION_OVERLAY` | 几何回退 `displayMetrics` + 资源取状态栏高；不使用新 API | 模拟器 API 26 一台（若有）或真机 |
| API 30+ | `WindowMetrics`/`WindowInsets` 可用 | 优先新 API，带 fallback | 现有 16416/16384 模拟器（API 见 `AGENTS.md`） |
| 手势导航（API 29+） | 底部上滑/侧边返回与入口、召回条冲突 | 入口不与底部手势带重叠；细条纵向扩展只沿边缘；召回条风险沿用登记 | 真机 + 模拟器手势模式 |
| 三键导航 | 导航栏占底部空间 | 输入窗底部留导航栏高度 | 同上 |
| 系统深色/浅色 | 底色/文字对比 | 全部走 `values-night` token | 截图对比 |
| 字体缩放/显示大小 | 文案溢出、窗口高度 | 文本行高与卡片上限按 `sp` 测量；兜底 `ellipsize` + 滚动 | 系统字号 1.3x/1.5x |
| 分屏/自由窗口/折叠 | 可用高度变化 | `onConfigurationChanged` 全量重算；卡片上限按新的可用高 | 模拟器分屏 |
| 厂商 ROM（MIUI/EMUI 等） | 悬浮窗权限入口差异、后台限制 | 仅依赖官方 `Settings.canDrawOverlays`；权限引导沿用 `OverlayController` | 真机 V2425A |
| 前台服务类型 | targetSdk 34 限制 | 不改 `EngineService` 声明 | 不涉及 |

---

## 11. 代码落点与新增文件

### 11.1 复用 / 改造 / 新增

| 现有文件 | 处置 | 说明 |
|---|---|---|
| `OverlayService.kt` | **改造（核心）** | 从「球+面板+报告栏」扩展为 §3.1 的窗口集合；保留探活/Mux/发送/pending 逻辑；把窗口几何抽成独立类 |
| `OverlayPanel.kt` | **问答/审批协议真源 + 完整表单 + 回滚面** | 新底部answer复用strict helper与原answers构造，完整表单保选项/多选/custom/分页/跳过；审批仍reason/二步。打开旧面时expanded=true，不能说v2全程false |
| `OverlayTheme.kt` | 复用 | 增补卡片/输入的 token 读取（尽量不改结构） |
| `OverlayHalo.kt` | 旧回滚路径保留；v2 差异待收口 | v2 当前未创建光环，不能将此事实等同于获准删除目标；按原始基线确认补齐/取舍与验收 |
| `OverlayLiveFeed.kt` | 改造 | 新增 `k=think` 分支；事件转发到新的聚合层 |
| `OverlayRecall.kt` | 复用 | 隐藏态召回条；与新入口形态共存（细条形态隐藏后同样用召回条） |
| `OverlayReport.kt` | 保留观察 | 报告栏与卡片功能重叠，Phase 3 决定是否合并；本期不动 |
| `MuxClient.kt` | 复用 | 不改协议 |
| `OverlayController.kt` | 复用 | 开关与权限引导不变 |
| `DsUi.kt` / `UiText.kt` | 复用 | 圆角/ripple/动画开关/文案 |
| `MotionCoalescer.kt` | 不用于悬浮层 | 仅浏览器触摸合帧；悬浮层用OverlayV2主线程100ms渲染合并与UiModel纯聚合，不能误称共用 |
| `OverlayPanelBackKey.kt` | 复用窗口根返回派发 | 续工卡片/输入与旧作答面各接返回，卡片 focusable+ALT_FOCUSABLE_IM；真实焦点与 IME 需设备验 |

当前新增文件（Phase 2；实现存在不等于设备验收）：

| 新文件 | 职责 | 单测 |
|---|---|---|
| `OverlayWindowFrames.kt` | 顶部/浮动输入/独立sheet窗口几何（32%/40%、离底、钳制/贴边） | 是，新布局需重验 |
| `OverlayV2.kt` | 顶部/浮动输入/独立sheet正交编排、底部outside/白条长按intent，历史状态分源且保草稿票据 | 新澄清施工中，待新编排/设备证据 |
| `OverlayHostVisibility.kt` | Application回调的 resumed Activity集合、代理排除、前后台去抖与创建前初态 | 生命周期接线反证 + 设备待验 |
| `OverlayWindows.kt` | 单槽唯一、addView 失败回执、实际 z 序记录与收口 | 是 |
| `OverlayViewTypes.kt` | 卡片/输入区/抽屉唯一 View 数据契约 | 是 |
| `OverlayPageHost.kt` / `WorkspaceListParse.kt` | 页面求值回包与工作区文件降级解析 | 是 |
| `OverlayCommandDrawer.kt` / `OverlayEntryView.kt` | 共用列表/附件瓦片与入口双形态 | 纯模型契约 + 设备待验 |
| `OverlayAttachProxyActivity.kt` | 附件选择/拍照代理与来件投递 | 端到端待设备验 |
| `OverlayUiModel.kt` | CardModel/PillModel/ComposerModel 聚合 | 是 |
| `OverlayCardView.kt` | 卡片窗口内容构建与渲染 | 部分（渲染契约） |
| `OverlayPillView.kt` | 兼容类名，当前目标为真实最新输出长胶囊及距离容错渐淡联动 | 新目标未验，不以旧短状态pill契约代替 |
| `OverlayComposer.kt` | 底部输入区（从 OverlayPanel 抽出） | 部分 |
| `OverlayGestureRouter.kt` | 入口手势裁决（单/双/长按/拖动） | 是（纯判定） |

> 文件数量与拆分粒度是建议值；Phase 2 实测若某项收益不成立可合并，但**纯逻辑（几何/状态机/聚合/手势判定）必须可单测**这条不可放宽。

### 11.2 禁止事项

- 不在 Kotlin 里硬编码命令列表、不复制 DSH 命令元数据。
- 不改 DSH 上游代码；不改现有桥方法签名（`check-bridge-symmetry.mjs` 会拦）。
- 不为第三方插件写专用适配。
- 不引入 Compose/新图片解码库等依赖（若必须，先改 `DEPENDENCIES.md` 并在 PR 说明）。

---

## 12. 未确认项（必须在 Phase 2 收敛）

| # | 未确认 | 影响 | 收敛方式 | 若失败的退路 |
|---|---|---|---|---|
| U1 | 中间空白只收底部输入/IME且顶部保持、下层点击不被误吞 | 当前F17 | 新路由需outside/触摸/IME真实反证 | 顶部误收或底部不收均FAIL；不再接受旧「外部关顶部」保底 |
| U2 | reasoning 块是否在 `assistant/message` 时一次性到齐、是否另有流式事件 | 思考摘要实时性 | 插件记录未知事件类型 + 真机跑一轮 | 接受「每条消息一次」的摘要节奏 |
| U3 | 当前动态命令注册/缓存变化反映 | R11命令抽屉 | 官方menu store+1s缓存/前台pick交接已落盘，新57定向通过；真实注册变化/后续UI待设备验 | 失败须可见，handedOff不等handler完成，不能拿旧缓存/交接回包冒充业务成功 |
| U4 | 页面工作区切换与会话/输入同步 | 工作区药丸 | 已接openWorkspace真源并等operation；端到端待验 | 页面不可用不能假装本地标签即切换成功；文件只供读取降级 |
| U5 | 跨应用窗口模糊在目标机型上的真实行为 | 视觉预期 | 设备spike，仅记录非功能依赖 | 当前实色文字面，不以透底换材质 |
| U6 | 细条与系统边缘返回手势的实际冲突程度 | R1 手感 | 真机 + 模拟器手势模式 | 增大贴边内缩 `edgeMargin`，或退回球形态 |
| U7 | 卡片 32%/40% 在小屏与横屏下的可用性 | 布局 | 多分辨率截图与严格比例反证 | 不得设180dp等地板突破比例；压缩chrome/滚动内容解决，小屏不足仍是待修而非扩大上限 |
| U8 | 离底input药丸/独立sheet横屏IME可达 | R10/R11 | 两向真实tap/IME/窗口证据 | 约束内压缩/内滚，不能退回贴底共板或inline height展开 |

---

## 13. 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|---|---|---|---|
| 窗口数量增加导致生命周期遗漏（残窗） | 高 | 单一 `OverlayWindows` 持有者 + `onDestroy` 逐窗收口 + 契约测试断言窗口数 | 回到当前三窗口实现（保留旧类到 Phase 3） |
| outside路由串域（空白误关顶部/底部与IME没收） | 高 | 按新F17双窗真tap反证，底部路由不得调用顶部hide | 修路由不降低目标；旧设备证据不得豁免 |
| 事件风暴导致掉帧 | 高 | 聚合 + 量化 + 节流（§5.4、§7.7） | 降低合并频率上限、缩短列表上限 |
| 插件新 live 行与旧壳不兼容 | 低 | 未知 `k` 忽略；版本号 bump | 插件回退上一版本 |
| 需求新增「工作区/命令」依赖未确认真源 | 中 | U3/U4 提前一周收敛 | 降级路径已写明 |
| 与 DSH 上游升级冲突 | 中 | 只依赖既有事件/ RPC；新事件由本仓插件产出 | 插件侧关闭新事件 |
| 轻量材质能力/成本不满足或文字透底 | 中 | 同设备前后图/成本取证，不把未测写不可实现 | 当前实色token保可读，finite动效保留，不做动态折射；触摸遮挡风险另验 |

**分阶段开关与设置边界**：既有overlay_display/entry_ui_v2默认false、entry_style默认ball作为历史已登记偏好保持，未授权本轮改值。UI回滚同cachedV2保草稿/model/inflight，真Service销毁才收观察者，规则不变；**顶部不再有“形态/隐藏/X”按钮**，显式球/条选择仅应用设置，运行中球↔strip按§9方向边滑实现，业务/草稿不受形态影响。当前新手势/材质/距离参数未实现/未测处保持未验收，不据文档推出通过。

---

## 14. 与 investigation.md 的关系

- 本文只回答「做成什么样、为什么、怎么落到代码」。
- `investigation.md` 回答「现在是什么、证据在哪、哪些能复用」。
- 两者的每个交叉引用都以 `path:line` 对齐；若实现阶段源码行号漂移，以 `investigation.md` 的证据附录重新定位，不在本文里维护行号快照。