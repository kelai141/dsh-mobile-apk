# DeepCode Android 悬浮交互系统重构 — 设计

> 阶段：Phase 1（只调查与规划，不含实现）。
> 代码基线：`origin/main` = `5f533907`（2026-11-11 本地 git fetch 后确认；本文所有源码位置以该提交为准）。
> 配套文档：`investigation.md`（现状与证据）、`implementation-plan.md`（施工步骤）、`test-plan.md`（验收矩阵）。
> 阅读约定：`path:line` 均为仓库相对路径；标「未确认」的条目必须由 Phase 2 的 spike 或设备验证收敛，不得当成已解决。

---

## 0. 结论摘要

1. **架构：多窗口 + 原生 View，不做单窗口全屏方案。** 悬浮入口（球/侧边细条）、顶部事件卡片、状态药丸、底部输入区、召回条各自独立 `WindowManager` 窗口，全部 `TYPE_APPLICATION_OVERLAY`；每个窗口的**窗口矩形 = 可视矩形**（继承 0.13.2 起「互吞」根治纪律，见 `OverlayService.kt:280-294`）。入口与卡片、药丸、输入之间不共享窗口，因此点卡外部收起的实现方式必须是 `FLAG_WATCH_OUTSIDE_TOUCH` + `ACTION_OUTSIDE`（而非全屏透明窗），该能力需设备验证（§3.4）。
2. **技术栈：Kotlin 原生实现全部 UI/手势/窗口生命周期；不引入 Compose；不新增 Rust 模块。** Rust 现有用途（快照 xz 解码等）与本系统无性能交集，见 §2.4。
3. **数据面 100% 复用现有通道，不新增对 DSH 上游接口的改动**：`session/list`、`session/prompt`、`session/create`、`session/cancel`、`session/respond`（`postRpc` 见 `OverlayService.kt:712-730`）、`/api/remote.mux` 的 `api-session/status` 事件（`OverlayPanel.kt:107`、`:181-190`）、`files/home/.dsh/.live.ndjson` 增量流（`OverlayLiveFeed.kt:26-100`）、`EngineProbe` 探活。
4. **新增能力只落在本仓自己的插件（`plugins/dsh-android-bridge`）与壳侧**：live 流新增「思考摘要行」与「命令清单」两类事件，格式向后兼容（旧壳忽略未知 `k`）。这满足「能力来自插件」「不改 DSH 现有接口」两条仓库铁律。
5. **视觉：复用既有 `ds_*` design token**（`app/src/main/res/values/colors.xml`、`values-night/colors.xml`、`values/dimens.xml`），借鉴 Apple HIG「材质用于建立前后景层次」的原则，但用**半透明底色 + 1px 描边 + 内侧渐变高光**表达层次（不做窗口外阴影，理由见 §7.4），**不做跨应用窗口的真实背景模糊**（技术上受限，见 §7.4），也不做 Liquid Glass 动态折射。
6. **性能以「静止时零刷新、事件合并渲染、窗口尺寸量化变更」为设计前提**，并给出可测指标与采集方法（§7.7 与 test-plan 的性能矩阵），不预填任何实测数字。

---

## 1. 需求到技术约束的转化

| # | 交互需求 | 技术策略 | 主要风险 |
|---|---|---|---|
| R1 | 侧边细条 / 悬浮球两种形态可选 | 入口窗按偏好二选一渲染；同一套拖动/手势/生命周期 | 细条命中区与边缘手势冲突（§9.2） |
| R2 | 单击展开卡片、双击进本体、长按卡片+输入 | `GestureDetector`（双击 300ms、长按 500ms）+ 触摸阈值；拖动与点击用 `touchSlop` 区分（现有先例 `OverlayService.kt:489-536`） | 双击与单击的延迟取舍（单击要等双击判定） |
| R3 | 本体在前台时隐藏自身入口 | 宿主 Activity 生命周期上报（新增），入口窗 `removeView` 而非 alpha | 新增 `ActivityLifecycleCallbacks` 与现有两 Activity 的对齐 |
| R4 | 顶部卡片随内容增长，上限可用屏高 32%，下拉白条可到 40% | 卡片窗高度由「内容测量高度」量化后 `updateViewLayout`；上限常数按可用高度比例 | 窗口高度动画的逐帧 layout 成本（§7.7） |
| R5 | 显示 Tool Call、单行思考摘要、任务状态，溢出内部滚动 | 事件聚合模型 `CardModel`（环形缓冲 + 单行思考合并），内部 `ScrollView` | 思考摘要当前**无数据源**，需插件补事件（§5.3） |
| R6 | 连续思考合并同一行，避免频繁布局与闪烁 | 400ms 合并窗口 + 文本原地替换（不重建 View）+ 变更节流 | 合并窗口与「实时感」的取舍 |
| R7 | 上推白条收缩成可自由移动横向药丸 | 卡片收起 = 移除卡片窗 + 添加药丸窗（原位/顶部），动画在药丸窗内做 | 两窗交替时的闪烁与 z 序 |
| R8 | 药丸单行状态、事件间淡入淡出 | 药丸窗内单个 TextView + `animate()` alpha 交叉；事件去重 | 高频事件导致持续动画（需节流） |
| R9 | 药丸可自由移动、可到屏幕顶缘、顶部不自动隐藏、明确上推才消散 | 拖动钳制到 `[0, H-h]`（允许 y=0）；消散手势阈值见 §9.4 | 消散后如何恢复到入口（保留入口即可） |
| R10 | 底部输入系统独立按需显示，含工作区/会话药丸、文字/拍照/相册/文件/附件预览 | 输入窗（focusable、`ADJUST_PAN`）+ 复用现有选择器/拍照/来件桥能力 | 键盘与窗口几何（§8.2）、命令真源（§6.4） |
| R11 | 「＋」抽屉：上部附件、下部**动态**命令 | 附件复用现有能力；命令来自插件暴露的真源，禁止硬编码 | 命令真源需新增插件事件（§6.4） |
| R12 | 点卡片外部收起，尽量不干扰底层应用 | `FLAG_WATCH_OUTSIDE_TOUCH` + `ACTION_OUTSIDE`（§3.4），失败时降级为返回键/再点入口收起 | `ACTION_OUTSIDE` 在非焦点窗上的投递行为未确认 |
| R13 | 收起/隐藏不中断后台 Agent | 服务与 Mux/探活/live 流不随 UI 收起停止（沿用 `hideBall` 既有语义 `OverlayService.kt:448-457`） | 无 |
| R14 | 手势冲突、触摸穿透、系统手势区、版本差异 | 逐窗 flags 表 + 边缘热区退让 + API 26..36 矩阵（§10） | 导航手势与入口/召回条重叠 |

---

## 2. 架构选型

### 2.1 候选方案对比

| 方案 | 做法 | 收益 | 成本/风险 | 结论 |
|---|---|---|---|---|
| **A. 多窗口 + 原生 View（选定）** | 每个 UI 区一个 overlay 窗口，View 树手写或 XML | 命中区可控（窗口=可视）、IME 可单独处理、复用现有 `OverlayService/OverlayPanel` 65% 以上代码、无新依赖 | 窗口类型 6 个、同屏上限 4 个（见 §3.1），生命周期与 z 序纪律要求高 | 采用 |
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
| W1 入口（球或细条） | 常驻入口 | 球 34dp；细条 8×88dp（见 §9.2） | `NOT_FOCUSABLE` + `NOT_TOUCH_MODAL` | 自由拖动，四向钳制（球）/贴左或右边缘（细条） | 最先添加的同层窗口之一，永不被卡片/药丸遮挡 |
| W2 光环（仅球形态） | 状态光晕 | 球径 + 2×24dp | `NOT_FOCUSABLE` + `NOT_TOUCHABLE` | 与球同心 | **必须先于 W1 addView**（`OverlayService.kt:300-305`，F8 真机回归） |
| W3 顶部事件卡片 | Tool Call / 思考行 / 状态 / 白条把手 | 宽 = 屏宽 − 2×12dp；高 = min(内容测量高, 32% 可用高) | `NOT_FOCUSABLE` + `NOT_TOUCH_MODAL` + `WATCH_OUTSIDE_TOUCH`（§3.4） | 顶部固定，避开状态栏（§3.3） | 在 W1 之后添加（覆盖入口下沿） |
| W4 状态药丸 | 单行当前操作 | 高 44dp、宽 wrap（含内边距） | `NOT_FOCUSABLE` + `NOT_TOUCH_MODAL` | 自由拖动，允许 y=0 | 与 W3 互斥显示（收起卡片 → 加药丸） |
| W5 底部输入区 | 工作区/会话药丸 + 输入框 + 附件预览 + 命令抽屉 | 宽 = 屏宽 − 2×12dp；高 wrap | **focusable** + `NOT_TOUCH_MODAL` + `SOFT_INPUT_ADJUST_PAN` | 底部贴边，键盘原生顶起 | 最后添加（在地键盘之上、其他窗之下） |
| W6 召回条（隐藏态） | 隐藏后唯一入口 | 8×44dp（沿用，`OverlayRecall`） | `NOT_FOCUSABLE` + `NOT_TOUCH_MODAL` | 贴最近水平边缘 | 隐藏态下替代 W1/W2 |

> 同时存在的窗口上限：球形态且卡片+输入同开 = W1+W2+W3+W5（4 个）；药丸态 = W4（+W5 可选）。每个窗口都必须满足「窗口 = 可视」与「可被单独移除」。

### 3.2 布局参数要点

- `TYPE_APPLICATION_OVERLAY`（API 26+ 统一；不需要 `TYPE_PHONE` 这类旧类型，`minSdk 26` 下没有历史包袱）。
- `PixelFormat.TRANSLUCENT`；禁止设置 `FLAG_LAYOUT_NO_LIMITS`（会绕过钳制）。
- `softInputMode = SOFT_INPUT_ADJUST_NOTHING`（非输入窗）——现行先例：球/光环窗设它治「键盘弹出整体上跳」（`OverlayService.kt:289-290`、`:315-316`）。
- 输入窗保留 `SOFT_INPUT_ADJUST_PAN` 的原生顶起（`OverlayService.kt:375-377` 已验证），**不要**改成自己监听 IME insets（旧方案已废，见 `:327-329` 注释）。
- 非输入窗一律 `FLAG_NOT_FOCUSABLE`：避免抢占输入焦点、避免把 IME 抢过来（这也是「点外部收起」不能靠 focus 变化实现的原因）。

### 3.3 可用高度与避让

- 「可用屏幕的 32%」中的**可用高度**定义：`currentWindowMetrics.bounds - 状态栏 - 导航/手势条`（API 30+ 用 `WindowMetrics`；API 26-29 回退 `displayMetrics.heightPixels` 与资源取状态栏高度）。该定义必须写进代码常量注释，并在测试里用两种取值方式各断言一次。
- 卡片顶部 y 初始 = 状态栏下沿；下拉到 40% 时不改变顶部 y，只增高。
- 横竖屏均按「短边/长边无关，按当前可用高度」计算，转屏时重算（现行 `panelWindowWidth()` 已给出「必须每次重算」的先例与理由，`OverlayService.kt:339-350`）。

### 3.4 「点卡片外部收起」的实现选择

| 方案 | 说明 | 问题 |
|---|---|---|
| 全屏透明窗拦截 | 一个透明全屏窗，点击即收起 | 违反窗口=可视纪律；会吃光底层应用触摸 |
| `FLAG_WATCH_OUTSIDE_TOUCH` | 卡片窗加该 flag，收到 `MotionEvent.ACTION_OUTSIDE` 即收起 | **未确认**：非焦点 overlay 窗是否稳定收到、一次手势是否只投递给一个窗口；需 Phase 2 spike |
| 无障碍服务监听触摸 | 复用 `DeviceControlService` | 依赖用户开无障碍；超出「收起卡片」的成本 |
| 再点入口收起 + 返回键 | 现行行为（`OverlayPanelBackKey`） | 交互不如「点外部」直觉，但零风险 |

**决策**：以 `WATCH_OUTSIDE_TOUCH` 为主路径（spike 通过即采用），**返回键/再点入口/自动收起为保底路径**，三条路径都必须实现并通过测试；spike 失败只影响「点外部」这条便利行为，不影响功能成立。

### 3.5 z 序与增删纪律

- 同 `TYPE_APPLICATION_OVERLAY` 的窗口按 `addView` 顺序叠，后加者在上（`OverlayService.kt:300-305` 的真机结论）。
- 固定顺序：光环 → 入口/召回条 → 卡片 → 药丸 → 输入。任何 `removeView`/`addView` 必须成对并保持该顺序。
- 隐藏/召回沿用现有例外写法：例外只允许集中在一个函数里，并用契约测试钉住（`recallBall` 先例，`OverlayService.kt:459-485`）。
- `onDestroy` 必须逐窗收口；任何「面板/卡片不在了但子窗还在」都是缺陷（`hidePanel` 的 FX-212.1 纪律，`OverlayService.kt:408-430`）。

---

## 4. UI 状态机

### 4.1 状态定义

```
界面态 UiState:
  ENTRY            // 仅入口（球/细条）+ 光环
  CARD             // 入口 + 顶部卡片（卡片内可滚动）
  CARD_EXPANDED    // 卡片被下拉白条拉到 40%
  PILL             // 入口 + 状态药丸（卡片收起后的形态）
  INPUT            // 入口 + 底部输入区（卡片/药丸可并存）
  HIDDEN           // 仅召回条（W1/W2 离窗）
```
正交子状态（可与上面任意状态并存）：

| 子状态 | 取值 | 说明 |
|---|---|---|
| `agentState` | `idle / running / waiting(approval\|question) / error` | 由 `api-session/status` + `turn_end.kind` + pending 事件派生 |
| `cardContent` | `empty / tools / thinking / mixed` | 决定单行摘要还是多行列表 |
| `ime` | `hidden / shown` | 只影响输入区几何 |
| `hostForeground` | `true / false` | 本体在前台时入口隐藏（R3） |
| `recallPending` | `true/false` | 药丸消散后等待入口恢复 |

### 4.2 转换表（事件 → 状态）

| 当前态 | 触发事件 | 目标态 | 副作用（必须显式） |
|---|---|---|---|
| 任意 | 入口**单击** | CARD | 建卡片窗（若已存在则仅为展开）；播放入场（≤180ms） |
| 任意 | 入口**双击** | 本体前台 | `startActivity(MainActivity)`（`FLAG_ACTIVITY_NEW_TASK`），不改变悬浮态 |
| 任意 | 入口**长按** | CARD + INPUT | 同时展开卡片与输入区；不自动聚焦输入框（避免刚长按就弹键盘） |
| CARD | 白条下拉 ≥ 24dp 或速率 ≥ 300dp/s | CARD_EXPANDED | 高度 32% → 40%，量化到 4dp；内容不重建 |
| CARD_EXPANDED | 白条上推 ≥ 24dp | CARD | 高度回 32% |
| CARD / CARD_EXPANDED | 白条快速上推（≥ 48dp 且速率 ≥ 500dp/s） | PILL | 移除卡片窗、加药丸窗；药丸初位置 = 卡片下沿水平居中 |
| CARD / CARD_EXPANDED | 点外部 / 返回键 / 入口单击 | ENTRY | 移除卡片窗；**不**改变 Agent |
| INPUT | 键盘收起且无草稿 | ENTRY 或 CARD（取决于卡片是否开） | 输入窗可保持隐藏（懒建） |
| PILL | 单击药丸 | CARD | 药丸移除，卡片重新测量内容 |
| PILL | 拖动 | PILL | y 钳制 `[0, H-h]`；到顶不隐藏 |
| PILL（y=0） | **再次**上推 ≥ 48dp 且速率 ≥ 500dp/s | ENTRY（药丸消散） | 淡出+缩放到 0.92（≤160ms），移除药丸窗；入口保留 |
| ENTRY | 入口长按 → 面板「隐藏」入口（沿用）或长按白条下方手势 | HIDDEN | 入口/光环离窗，召回调出 |
| HIDDEN | 点召回条 | ENTRY | 按 z 序恢复光环→入口 |
| 任意 | `hostForeground=true` | 入口隐藏（UI 子状态） | 只移除 W1/W2，**服务不停** |
| 任意 | 服务 `onDestroy` | — | 全窗收口 |

> 原则：**一切「收起 / 隐藏」只动窗口，不动服务与数据流**。这条是 R13 的落地判据，测试必须反向断言（收起后 Mux/探活/live 仍工作）。

### 4.3 事件合并与防闪烁

- 思考/正文行：`400ms` 合并窗口（`MotionCoalescer` 现有机制可复用/扩展，`MotionCoalescer.kt`）；同轮内连续更新只替换同一 `TextView` 文本，**不重建 View、不改窗口尺寸**，仅当文本从空到非空/换行数变化时才触发一次尺寸量化。
- 工具调用行：`tool_call` 立即占位（名字 + 参数摘要），`tool_result` 到达后就地更新耗时/结果标记；列表用环形缓冲上限 50 条，超出只保留最新。
- 卡片高度：仅在「内容测量高度」跨过 4dp 量化档时才 `updateViewLayout`，且相邻两次变更间至少 120ms（避免事件风暴下的窗口 resize 抖动）。
- 药丸文案：事件切换用 `alpha 120ms out → 改文本 → alpha 120ms in`；同类事件（仍是 running 的工具）只改文本不播动画。

### 4.4 动画规范（可测）

| 场景 | 时长 | 曲线 | 备注 |
|---|---|---|---|
| 卡片入场 | 180ms | `DecelerateInterpolator`（≈ 0.0→1.0） | alpha 0→1 + translateY −8dp→0 |
| 卡片收起 | 140ms | `AccelerateInterpolator` | 用户主动动作要更快 |
| 卡片高度变化 | 160ms | `FastOutSlowIn`（或自家等价） | 只在量化档位变化时 |
| 药丸切换文本 | 2×120ms | linear | 不缩放，避免抖动 |
| 药丸消散 | 160ms | `AccelerateInterpolator` | alpha→0 + scale 1→0.92 |
| 药丸出现 | 120ms | `DecelerateInterpolator` | alpha 0→1 |

所有动画必须在 `DsUi.animationsEnabled()` 为假时**归零时长**（系统「移除动画」/无动画偏好），并为每个动画提供「动画关闭时立即到终态」的测试。参考现有实现 `OverlayPanel.kt:626-654`。

---

## 5. 数据流

### 5.1 数据源与职责

| 数据 | 来源 | 现状位置 | 新设计用法 |
|---|---|---|---|
| 引擎是否在线 | `EngineProbe.check()` 10s tick | `OverlayService.kt:663-680` | 卡片状态行 + 药丸「引擎离线」 |
| Agent 运行态 | mux `api-session/status`（`args=[agentId, running]`） | `OverlayPanel.kt:181-190`、`OverlayService.kt:608-659` | 卡片/药丸主状态；开启/结束轮次 |
| 工具调用 | `.live.ndjson` `k=tool_call/tool_result` | `OverlayLiveFeed.kt:101-143` | 卡片工具列表 |
| 助手可见正文 | `.live.ndjson` `k=text`（`sum` ≤160 字符） | `plugins/dsh-android-bridge/src/index.ts:2179-2187` | 卡片「最新进展」行 |
| 思考摘要 | **当前不存在**（`visibleText` 刻意排除 reasoning，`notify-projection.ts:124-129`） | — | 需新增 `k=think` 行（§5.3） |
| 轮次结局 | `k=turn_end`（`ok`/`kind`） | `index.ts:2189-2200` | 完成/失败/中断文案 |
| 待答/审批 | mux `$events` 事件（现有 waterfall 解析） | `OverlayPanel.kt:132-205` | 卡片待答区 + 输入区回答 |
| 会话列表 | `session/list` RPC | `OverlayPanel.kt:1249-1328` | 会话药丸 |
| 工作区列表 | 仅直接读 `home/.dsh/storages/workspace.json` | `OverlayService.kt:585-600` | 工作区药丸（优先找官方 RPC，见 §6.3） |
| 命令清单 | **未确认真源** | — | 命令抽屉（§6.4） |

### 5.2 聚合模型（建议新增）

```
OverlayUiModel.kt（纯 Kotlin，可单测）
  data class CardModel(
    val agentState: AgentState,        // idle/running/waiting/error
    val headline: String,              // 单行当前动作：工具名+摘要 / 思考摘要 / 状态文案
    val thinkingLine: String,          // 最近一次合并后的思考行（≤120 字符）
    val toolRows: List<ToolRow>,       // 最近 N 条（N=50 环形）
    val pending: List<PendingItem>,    // 审批/提问
    val turnStartedAt: Long,
    val lastEventAt: Long,
  )
  data class PillModel(val text: String, val tone: Tone)   // tone: idle/working/warning/error
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
- 渲染层只做三件事：绑定文本/可见性、量化尺寸、播放动画。

### 5.3 思考摘要的数据源（设计缺口 + 方案）

现状事实：
- 插件在 `assistant/message` 时只投影**可见正文**（`text` 块），并明确排除 reasoning 块；`.live.ndjson` 因此没有思考文本（`plugins/dsh-android-bridge/src/index.ts:2179-2187`、`plugins/dsh-android-bridge/src/notify-projection.ts:124-129`）。
- 上游 `TextBlock` 与 `ReasoningBlock` 共用 `text` 字段——该判断来自本仓插件注释的转述（`plugins/dsh-android-bridge/src/index.ts:2181-2182`，注释原引 `dsh/packages/llm/llm/src/types.ts:54-64`），**上游类型未在本地独立核对**。

方案（推荐）：在 **本仓插件**里新增一条 live 行：

```json
{"t":<ms>,"s":"<sessionId>","k":"think","sum":"<首行/前120字符>"}
```

- 触发点与 `assistant/message` 同一事件：从 content 中取 `type==='reasoning'` 块的 `text`，按「首行 + 截断 120 字符」投影；空/纯空白不写。
- 同轮内连续 reasoning 块只写**最新一版**（合并），配合壳侧 400ms 合并窗口，做到「同一行不断替换」。
- 兼容：壳侧 `when (k)` 的 `else` 分支忽略未知 `k`（现有实现即如此），旧壳不受影响；插件需 bump 版本并同步镜像到本仓 `plugins/<同名目录>`（AGENTS.md 铁律 5）。
- 若 Phase 2 发现上游存在**流式 delta 事件**（例如 `assistant/delta`，本仓源码里**未确认**存在），则可升级为真流式；验证方法：在插件 `session/event` 回调里对未知 `ev.type` 记一次日志，跑一轮长思考任务后读日志（`docs/AGENTS/gotchas.md` 记录日志落盘位置）。

**未确认项**：reasoning 块在 `assistant/message` 时是否已经完整（一次性到齐）——若是，单行摘要只能是「每条消息更新一次」，不是逐字流。该事实决定 R6 的观感上限，必须在 Phase 2 第一周用真机日志确认。

### 5.4 线程与背压

- 全部 UI 状态在**主线程**（`Handler(Looper.getMainLooper())`，沿用 `OverlayService.kt:55`）。
- 文件/网络读取在后台线程，结果 `post` 回主线程（沿用 `drainLive()` 模式，`OverlayLiveFeed.kt:67-94`）。
- 合并策略：每类事件最多 `1 次/100ms` 触发聚合；聚合函数为纯函数，可丢弃中间态（幂等）。
- 上限：`toolRows ≤ 50`、`pending ≤ 8`、`thinkingLine ≤ 120 字符`、命令列表 `≤ 200`（超出截断并显示「更多」）。

---

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
| N4 | 原生侧 `EnginePageBridge`（Kotlin→JS 单次求值 + JSON 回执） | `MainActivity`/`OverlayService` | 调 N3、拿回执 | 复用现有 `evaluateJavascript` + `jsString()` 转义（`AndroidBridge.kt:845-853`），只在主线程发起 |
| N5 | `OverlayUiModel` 聚合层 | 壳侧新文件 | 事件合并（§5.2） | 纯 Kotlin，可单测 |

**为什么用「页面宿主 API + 原生求值」而不是新增多个 `@JavascriptInterface`：**

- 会话/工作区权威真源在页面（`<html data-dsh-session-id>`，`session-marker.ts:26,63-75`；工作区在 `uiWorkspace` store）。原生反查一个页面 API 比让页面主动推多个桥方法更简单，也不扩大「JS→原生」安全面。
- `check-bridge-symmetry.mjs` 守桥面对称性；新增 JS→Kotlin 方法需要同步桥协议文档与基线，成本高于加一个只读页面 API。
- 若 Phase 2 发现 N3 无法稳定获取某字段，再降级为「新增单个桥方法 `publishUiState(json)`」（只加不改），并在 `BRIDGE-API.md` 登记。

### 6.3 会话身份与工作区身份（必须先解决的真源问题）

**已登记缺陷（不得在新代码里复用）：** `OverlayService.kt:611-616` 与 `:608-659` 把 `api-session/status` 的 **agentId** 写进 `activeSessionId`；同文件注释与 `docs/AGENTS/EXECUTION-MAP.md:292` 均写明「agent id 不得当 session id」，且该映射未确证。后果：发送落到错误会话、待答卡不显示、完成位文案永不出现。

新设计三条硬规则：

1. **两个变量分开**：`currentAgentId`（仅用于忙态匹配）与 `currentSessionId`（仅用于 RPC 的 `sessionId` 字段）。**禁止互相串用**，用命名 + 单测（`OverlayUiModelTest`：agentId 不得进入 session 字段）锁住。
2. **会话身份以页面为权威**：`currentSessionId` 只从 N3 的 `__dshOverlayHost.getState().sessionId` 获取；取不到时显示「会话未知」，**不得猜测**。
3. **工作区身份同理**：`currentWorkspaceId` 从 N3 获取；命令执行（`/api/commands/execute` 需要 `agentId`）用 `currentAgentId`，缺失时禁用命令抽屉，不回退到 sessionId。

**工作区列表**：本仓只有文件真源 `files/home/.dsh/storages/workspace.json`（`tables.workspaces[*].title`，`OverlayService.kt:585-600`），无 RPC/桥入口。设计：由 N3 页面 API 返回列表（页面 store 有真源）；页面不可用时回退读 `workspace.json`（抽纯函数 `WorkspaceListParse` 并单测）。**「切换工作区」语义需产品确认**（§12 U4），本期按「设置新会话目标工作区 + 会话列表过滤」实现。

### 6.4 动态命令（真源已定位）

- **真源**：上游 `ui-input-trigger` 命令目录 / 客户端命令贡献，不是壳侧也不是硬编码表。本仓已有两处同源消费先例：`dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts:3-19`（打开上游菜单后读 `[data-composer-card] [role="listbox"] [role="option"]` 逐项复制，「本模块不认识任何具体项」）、`reference-menu.ts:32-34`（按上游注册名定位行）。
- **执行**：`POST /api/commands/execute`，payload `{agentId, line, submittedAttachments}`（`docs/AGENTS/gotchas.md:862-867`；字段名与 `session/prompt` 的 `request` **不同**，错字段得 `gateway/arguments-invalid`）。
- **唯一允许的固定集合**：附件行标题闭集 `ATTACHMENT_ROW_TITLES = {文件,本地文件,file,files,local file,local files}`（`composer-sheet.ts:191-193`），仅用于去重，注释要求精确匹配、禁止按位置/前缀。
- **落地**：N3 的 `__dshOverlayHost.getCommands()` 复用同一 DOM 读取逻辑（抽公共函数给 composer-sheet 与宿主 API 共用，避免两份口径），返回 `{name,label,description,section}`；点击时原生调 `executeCommand(line)` → 页面走 `/api/commands/execute`。
- **禁止**：Kotlin 里写命令清单；按固定顺序/位置识别菜单项；复制私有实现而不抽公共函数。
- **未确认**：是否存在可直接读取命令目录的官方 API（本仓只见 DOM 选择器与 `docs/AGENTS/known-gaps.md:127` 的描述）。若 Phase 2 找到目录 API，优先替换 DOM 读取，DOM 读取作兜底。

## 7. 视觉设计

### 7.1 设计原则（借鉴 Apple HIG，不做 SwiftUI 实现）

- HIG 对材质的定位是「建立前景与背景的层次」，并强调厚度（thin/thick）决定透出程度与文字对比度（[Apple HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[SwiftUI Material](https://developer.apple.com/documentation/swiftui/material)）。
- 本设计只借三条：**层次靠半透明+描边+内侧高光**、**圆角统一**、**动效短促且有方向**。不借 vibrancy、不做材质厚度分级的多档模糊。
- 与现有壳视觉保持一致：现有 token 体系是「Apple 式黑白极简」且由 `GuidePaletteMonochromeTest` 守护（`app/src/main/res/values/colors.xml:6-7`），新 UI 必须复用同一套 token，不新造色相。

### 7.2 色板归属（先拍板，避免第三套配色）

壳侧现有**两套并行色板**：

| 色板 | 代表值 | 用于 | 文件 |
|---|---|---|---|
| `ds_*` 中性 token（Apple 式黑白） | `ds_surface` #FFFFFF/#1C1C1E、`ds_hairline`、`ds_radius_card` 18dp | 启动页/引导页/设置页/控制台 | `app/src/main/res/values*/colors.xml`、`dimens.xml` |
| 悬浮面板自有色板 | `unitBg` #F2F8F9FA / #F21E1F24、品牌蓝 #4176E6、圆角 30dp | 眼下的 OverlayPanel | `OverlayTheme.kt:48-71`、`OverlayPanel.kt:266` |

**决策：新悬浮 UI 全部走 `ds_*` 色板**（含半透明档位），悬浮面板的旧色板随重构退役，不再新增使用点。

理由（按权重排序）：

1. 需求原文要求「优先复用现有启动页的颜色与视觉规范」——启动页用的就是 `ds_*`（`app/src/main/res/values/colors.xml:6-27`、`values-night/colors.xml`）。
2. `ds_*` 是资源化 token，双主题成对维护，且有 `GuidePaletteMonochromeTest` 守护；面板色板是 Kotlin 字面量（`OverlayTheme.kt:49-70`），继续扩展会让字面量散落。
3. 蓝 #4176E6 在 `OverlayPanel.kt` 内是裸字面量（`:266`、`:406`），不是 token；若新 UI 要用蓝，必须先把蓝收敛成资源，本期不做（避免扩大改动面）。

代价与处置：新卡片与旧面板**观感不同**——重构后旧面板形态被卡片+输入区取代，不存在长期并存，故不视为视觉断裂。若 Phase 2 想保留品牌蓝作为强调色，先新增 `ds_brand`（`values` + `values-night` 双份）并登记到 `docs/AGENTS/DEPENDENCIES.md` 之外的视觉清单，再使用。

### 7.3 Token 映射（直接复用，不新增）

| 语义 | 浅色 | 深色 | 来源 |
|---|---|---|---|
| 卡片底 | `ds_surface` #FFFFFF（叠 92% alpha） | `ds_surface` #1C1C1E（叠 92%） | `values/colors.xml:9`、`values-night/colors.xml:5` |
| 药丸底 | `ds_chip` #F2F2F4 | `ds_chip` #2C2C2E | `values/colors.xml:11` |
| 描边 | `ds_border` #14000000 | `ds_border` #26FFFFFF | `:13` / `values-night:9` |
| 主文字 | `ds_text_primary` #1D1D1F | #F5F5F7 | `:15` |
| 次文字 | `ds_text_secondary` #6E6E73 | #98989D | `:16` |
| 成功/警告/危险 | `ds_ok`/`ds_warn`/`ds_danger` | 同名（夜值不同） | `:22-24` |
| 圆角 卡片 | `ds_radius_card` 18dp | 同 | `values/dimens.xml:14` |
| 圆角 药丸 | `ds_radius_pill` 999dp | 同 | `:19` |
| 间距 | `ds_space_4/8/12/16/20/24` | 同 | `:3-9` |
| 卡片最大高度 | 32% 可用高（新增常量，写入 `dimens.xml` 或 Kotlin 常量并注释理由） | 同 | 新增 |

> 新增唯一常量 = 卡片高度比例（32% / 40%）；其余一律复用。若确有新增 token，必须在 `values` 与 `values-night` 同时加，并在 `GuidePaletteMonochromeTest` 的白名单/规则里处理。

### 7.4 层次与形状

| 层 | 内容 | 形状 | 视觉手法 |
|---|---|---|---|
| L1 卡片 | 事件列表 | 圆角 18dp，四周 1px `ds_border` | 底色 92% 不透明 + 顶部 1dp 高光（`#0DFFFFFF` 叠加）+ 内侧边缘渐隐（**不做窗口外阴影**；elevation 只在窗口内生效、不能跨窗口投射，见 §7.4） |
| L2 药丸 | 单行状态 | 圆角 999dp，高 44dp | 底色 94% + 描边 + 无阴影 |
| L3 输入区 | 输入/附件/命令 | 上下圆角（上 18dp），可选顶部 hairline | 底色 96% + 描边 |
| L4 入口 | 球/细条 | 球 34dp 圆形/细条 8dp 圆角 | 球：白底 + 鲸鱼图标（沿用）；细条：中性灰 60% alpha（沿用 `recallStrip` 口径 `OverlayTheme.kt:36-45`） |

- **阴影**：overlay 窗口的 `View.elevation` 只在窗口内生效，不能把阴影投射到窗口矩形之外（平台行为，Phase 2 spike 复核；仓内既有 picker 6dp / 报告栏 8dp 均为窗口内 elevation，不矛盾）。用「窗口内 padding + 自绘渐变」模拟 4dp 柔和边（窗口矩形会因此比可见卡片大 6dp——**这违反窗口=可视纪律**）。因此决策：**不模拟阴影**，靠 1px 描边 + 底色不透明度区分层次；如需阴影，仅接受「窗口内边缘渐隐」（视觉上是内阴影）。这条是硬取舍，写入实现注释，防止后人加 elevation 后发现无效。

### 7.5 毛玻璃 / 模糊

| 方案 | 可行性（代码/平台事实） | 结论 |
|---|---|---|
| 跨窗口真实模糊（模糊底层应用） | Android 12+ 的 blur 主要面向同应用内窗口；overlay 窗口模糊**其它应用**内容不受支持/受厂商限制。本仓无相关实现，**未确认**具体机型行为 | 不采用 |
| `RenderEffect.createBlurEffect`（API 31+） | 只能模糊**自身窗口内**已经绘制的内容，模糊不到窗口背后 | 不采用（对「透出底层内容」无效） |
| 半透明 + 噪点/渐变 | 纯 View 绘制 | **采用**（成本最低、跨版本一致） |
| Liquid Glass 动态折射 | 需实时采样背景 | 明确禁止（需求原文） |

视觉等价做法：卡片/输入区底色用 92-96% 不透明的 token 色 + 1px 描边 + 极轻的内侧渐变高光，观感上是「半透明浮层」，**不做真模糊**。该取舍必须写进 `known-gaps` 或在代码注释说明，避免后续被当成 bug 反复提。

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
4. **列表复用**：工具行用固定上限的 `LinearLayout` 增量添加/移除（≤50 条的规模无需 RecyclerView）；若 Phase 3 实测超 50 条频繁增删再评估。
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
W5 输入窗（focusable, ADJUST_PAN）
 ├─ 药丸行： [工作区 ▾] [会话 ▾]            ← 状态实时同步
 ├─ 附件预览条（横向，最多 5 个缩略/文件 chip，可删）
 ├─ 输入行： [＋] [EditText 多行] [拍照] [发送/停止]
 └─ 命令抽屉（可折叠）： 上=附件入口（拍照/相册/文件） 下=动态命令列表
```

- 「＋」展开抽屉用高度动画（≤160ms），抽屉最大高度 = 可用高 40%，内部滚动。
- 输入框多行自适应（1→4 行），避免窗口高度频繁跳变：行数变化也走「量化 + 节流」。
- 发送：复用 `session/prompt`（`mode` 按 busy 状态选 steer/queue，沿用 `:775-790` 的判定）；发送后乐观置忙（`markBusyOptimistic`，`:557-561`）。
- 停止：busy 时发送按钮变「停止」→ `session/cancel`（`:756`）。
- 待答问答：卡片上的审批/提问只显示为 chip/按钮；需要**文字作答**时，把问题提示带入输入区（输入区顶部一行「正在回答：…」），提交走 `$events/result`（沿用 `OverlayPanel.kt:1088-1150` 的语义），这样卡片无需 focusable。

### 8.2 键盘与尺寸变化

- 沿用「输入窗 focusable + `ADJUST_PAN`」的原生顶起（已验证，`OverlayService.kt:361-377`）。不自己监听 IME insets（旧方案已废，理由见 `:327-329`）。
- 转屏/分屏/折叠：`onConfigurationChanged` 中重算所有窗口几何（现行做法 `OverlayService.kt:163-190` 附近）；输入窗存在时重新 `updateViewLayout`。
- 键盘弹起时卡片若开着：卡片不动（它在上方），但药丸/入口可能被顶——统一策略：**只有输入窗受键盘影响**，其他窗 `ADJUST_NOTHING`。

### 8.3 附件

复用现有链路（详见 `investigation.md` 第 2 节）：

| 附件类型 | 现有能力 | 新 UI 落点 |
|---|---|---|
| 拍照 | `PhotoCapture` / `PhotoCaptureController`（桥 `pickImage` 之外的原生拍照路径） | 抽屉「拍照」瓦片 |
| 相册图片 | 桥 `pickImage(callbackId)` + `onImagePicked` | 抽屉「照片」瓦片 |
| 本地文件 | 桥 `pickFile`/`FileIncoming`/SAF 桥 | 抽屉「文件」瓦片 |
| 附件预览/删除 | 现有面板的附件预览（若有） | 输入窗附件条 |

> 若现有附件预览只存在于 WebView 侧，则原生侧按「文件名 + 类型图标 + 删除」最小实现，不复制 WebView 的富预览。

### 8.4 命令抽屉

见 §6.4。UI 上只做：搜索框（可选，Phase 3）+ 列表（图标/名称/描述）+ 点击执行。执行方式取决于命令真源（RPC 直接执行 / 唤起本体命令面板），在 Phase 2 确认后固定。

---

## 9. 入口形态与手势

### 9.1 两种形态

| 形态 | 尺寸 | 视觉 | 命中区 | 说明 |
|---|---|---|---|---|
| 悬浮球 | 34dp 圆 | 白底 + 鲸鱼（沿用，`OverlayService.kt:256-278`） | 窗口 = 34dp（= 可视） | 保持现状 |
| 侧边细条 | 8×64dp 可视 | 中性半透明圆角条（沿用 `recallStrip` 配色） | 窗口 8×88dp（**纵向扩大命中区**，不向屏内扩展） | 新形态；见 §9.2 |

- 形态选择持久化（`overlay_display` prefs 新增键 `entry_style` = `ball|strip`，默认 `ball`）；切换时**移除并重建入口窗**（不能只改 View，因为窗口尺寸变了）。
- 细条贴左或右边缘（按上次位置/默认右侧），纵向可拖动。

### 9.2 为什么细条只纵向扩大命中区

- 需求要求「细条视觉占用小、触摸区域适当扩大」。横向扩大（例如 24dp 宽窗 + 8dp 可视）会在屏幕内部留下 16dp 的**隐形触区**，与「窗口=可视」纪律和边缘手势冲突。
- 纵向扩大（88dp 窗 + 64dp 可视）只在屏幕边缘的**外侧延展方向**上多出 12dp 上下（仍在边缘带内），对屏内应用零侵入。
- 仍需设备验证：细条与系统边缘返回手势区域的冲突（0.14.9 召回条 8dp 宽已被登记为待真机确认风险，`docs/0.14.9-preview-OVERLAY-BALL-HIDE.md` §6）。

### 9.3 手势裁决

| 手势 | 判定 | 动作 |
|---|---|---|
| 单击 | `UP` 且未超过 `touchSlop` 且不在双击窗口内 | 展开卡片（若已展开则收起） |
| 双击 | 两次 `UP` 间隔 ≤300ms 且位移 ≤slop | 打开本体（`MainActivity`） |
| 长按 | `DOWN` 后 500ms 未移动 | 同时展开卡片 + 输入区 |
| 拖动 | 位移 > `touchSlop` | 移动窗口；松手保留位置（无吸附，沿用 0.14.1 块I 结论） |
| 药丸上推消散 | 见 §4.2 | 淡出并移除药丸 |

- 实现用 `GestureDetector`（`SimpleOnGestureListener`）+ 自管 `ACTION_MOVE` 拖动；**不要**在 `onSingleTapConfirmed` 之外再自己判双击（会与 detector 的双击判定打架）。
- 单击与双击冲突：单击动作延迟到「双击窗口过期」后执行（300ms 体感可接受，且现有系统无「单击立即」需求）。若实测延迟明显，可改为「单击立即展开卡片 + 双击在卡片已展开时进本体」，该变体登记为 Phase 2 可选项。

### 9.4 药丸顶缘与消散阈值

- 拖动钳制 `y ∈ [0, H - h]`，**不设顶部额外偏移**，到 y=0 静止不隐藏（需求原文）。
- 消散判定（同时满足）：
  1. 手势起点在药丸内、方向向上；
  2. 累计向上位移 ≥ 48dp（建议值，Phase 2 手感调优）；
  3. 末速度 ≥ 500dp/s（`VelocityTracker`）；
  4. 药丸当前 `y ≤ 8dp`（只有已经贴顶才把「上推」解释为消散，避免任意位置误杀）。
- 消散后：入口保留；用户可再次点入口唤出卡片，药丸可通过「上推白条」再次产生。

---

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
| `OverlayPanel.kt` | **拆分复用** | 输入行、会话选择器、pending 渲染、应答请求可抽出复用；面板整体形态被卡片/输入区取代 |
| `OverlayTheme.kt` | 复用 | 增补卡片/输入的 token 读取（尽量不改结构） |
| `OverlayHalo.kt` | 复用 | 球形态的状态光晕 |
| `OverlayLiveFeed.kt` | 改造 | 新增 `k=think` 分支；事件转发到新的聚合层 |
| `OverlayRecall.kt` | 复用 | 隐藏态召回条；与新入口形态共存（细条形态隐藏后同样用召回条） |
| `OverlayReport.kt` | 保留观察 | 报告栏与卡片功能重叠，Phase 3 决定是否合并；本期不动 |
| `MuxClient.kt` | 复用 | 不改协议 |
| `OverlayController.kt` | 复用 | 开关与权限引导不变 |
| `DsUi.kt` / `UiText.kt` | 复用 | 圆角/ripple/动画开关/文案 |
| `MotionCoalescer.kt` | 复用/扩展 | 事件合并的基础设施 |
| `OverlayPanelBackKey.kt` | 复用 | 返回键收起 |

建议新增（Phase 2 起）：

| 新文件 | 职责 | 单测 |
|---|---|---|
| `OverlayWindowFrames.kt` | 5 个窗口的 LayoutParams/几何纯函数（可用高、32%/40%、钳制、贴边） | 是（纯函数） |
| `OverlayUiStateMachine.kt` | UiState 与转换（事件 → 状态） | 是 |
| `OverlayUiModel.kt` | CardModel/PillModel/ComposerModel 聚合 | 是 |
| `OverlayCardView.kt` | 卡片窗口内容构建与渲染 | 部分（渲染契约） |
| `OverlayPillView.kt` | 药丸窗口 | 部分 |
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
| U1 | `FLAG_WATCH_OUTSIDE_TOUCH` 在非焦点 overlay 窗上能否稳定收到 `ACTION_OUTSIDE` | R12「点外部收起」 | Phase 2 第一周设备 spike（两个 API 档） | 返回键 + 再点入口 + 自动收起 |
| U2 | reasoning 块是否在 `assistant/message` 时一次性到齐、是否另有流式事件 | 思考摘要实时性 | 插件记录未知事件类型 + 真机跑一轮 | 接受「每条消息一次」的摘要节奏 |
| U3 | DSH 命令注册表的可消费真源 | R11 命令抽屉 | 插件能力探查 + 上游类型检索 | 降级为「唤起本体命令面板」 |
| U4 | 工作区切换的官方 RPC 与语义 | 工作区药丸 | RPC 探查 + 产品确认 | 读 `workspace.json` 只读展示 + 新建会话带 workspaceId |
| U5 | 跨应用窗口模糊在目标机型上的真实行为 | 视觉预期 | 设备 spike（仅记录，不作为功能依赖） | 固定用半透明方案 |
| U6 | 细条与系统边缘返回手势的实际冲突程度 | R1 手感 | 真机 + 模拟器手势模式 | 增大贴边内缩 `edgeMargin`，或退回球形态 |
| U7 | 卡片 32%/40% 在小屏（如 720×1280）上的可用性 | 布局 | 模拟器多分辨率截图 | 按短边比例另设下限（例如 ≥180dp） |
| U8 | 输入窗在横屏 + 键盘下是否仍能完整显示 | R10 | 16416/16384 双方向验收 | 横屏改用「抽屉式全宽输入」 |

---

## 13. 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|---|---|---|---|
| 窗口数量增加导致生命周期遗漏（残窗） | 高 | 单一 `OverlayWindows` 持有者 + `onDestroy` 逐窗收口 + 契约测试断言窗口数 | 回到当前三窗口实现（保留旧类到 Phase 3） |
| outside-touch 失效导致「点外部不收起」 | 中 | 多路径收起居（§3.4） | 关闭该 flag 走保底路径 |
| 事件风暴导致掉帧 | 高 | 聚合 + 量化 + 节流（§5.4、§7.7） | 降低合并频率上限、缩短列表上限 |
| 插件新 live 行与旧壳不兼容 | 低 | 未知 `k` 忽略；版本号 bump | 插件回退上一版本 |
| 需求新增「工作区/命令」依赖未确认真源 | 中 | U3/U4 提前一周收敛 | 降级路径已写明 |
| 与 DSH 上游升级冲突 | 中 | 只依赖既有事件/ RPC；新事件由本仓插件产出 | 插件侧关闭新事件 |
| 视觉预期（毛玻璃）无法达成 | 中 | 提前在文档与 PR 里说明取舍 | 无（不实现真模糊） |

**分阶段落地与开关**：所有新 UI 由 `overlay_display` 一个新键（如 `entry_ui_v2=true`）门控；默认关闭，验收通过后默认开启。该开关同时是回滚手段（关闭即回旧形态，无需回滚代码）。开关命名与默认值在实现 PR 中定稿，并登记到 `docs/AGENTS/PERSISTENT-DATA.md`。

---

## 14. 与 investigation.md 的关系

- 本文只回答「做成什么样、为什么、怎么落到代码」。
- `investigation.md` 回答「现在是什么、证据在哪、哪些能复用」。
- 两者的每个交叉引用都以 `path:line` 对齐；若实现阶段源码行号漂移，以 `investigation.md` 的证据附录重新定位，不在本文里维护行号快照。