# DeepCode Android 悬浮交互系统重构 — 实施计划（implementation-plan）

> 阶段：Phase 1 产出（本文件只规划，不含代码改动）。
> 代码基线：`origin/main` = `5f533907`。现状与证据见 `investigation.md`，方案见 `design.md`，验收见 `test-plan.md`。
> 本计划按「前置收敛 → 窗口框架 → 卡片 → 药丸/入口 → 输入 → 命令 → 视觉性能 → 发布收口」推进；**每一阶段都可独立交付、独立回滚**。

---

## 1. 阶段总览

| 阶段 | 交付物 | 依赖 | 可并行的另一条线 | 回滚单位 |
|---|---|---|---|---|
| P0 前置收敛 | 4 个修复 PR + 1 份 spike 结论 | — | — | 单 PR revert |
| P1 窗口框架 | 窗口几何/持有者/开关骨架（无可见变化） | P0 | 插件 `k=think` / `callId`（P2 前置） | 开关关闭 = 旧路径 |
| P2 顶部事件卡片 | 卡片窗 + 事件聚合 + 思考行 | P1 | 页面宿主 API（P5 前置） | 开关 + 单 PR revert |
| P3 药丸与入口形态 | 药丸窗 + 双入口形态 + 手势路由 + 本体前台隐藏 | P1 | 附件入口（P4 前置） | 开关 + 单 PR revert |
| P4 底部输入区 | 输入窗 + 工作区/会话药丸 + 附件预览 | P1，建议在 P3 后 | 命令抽屉 UI（P5） | 开关 + 单 PR revert |
| P5 命令抽屉 | 「＋」抽屉 + 动态命令 + 执行链路 | P4；页面宿主 API | — | 开关 + 单 PR revert |
| P6 视觉与性能收口 | token 收敛 + 动效门控 + 性能基线 | P2/P3/P4 | — | 文档/常量级 |
| P7 兼容与发布收口 | 兼容矩阵通过 + 三层验收 + 文档更新 | 全部 | — | 发版前整体回退（关开关） |

**功能开关**：`overlay_display/entry_ui_v2`（默认 `false`）。P1 起所有新路径由该开关门控；P7 验收通过后才默认开启。开关是**第一回滚手段**，代码回滚是第二手段。

**并行边界**：P2（卡片）与 P3（药丸/入口）在 P1 完成后可并行；P4（输入）与 P5（命令）串行；插件侧改动（`k=think`、`callId`）可在 P1 期间先行合入（向后兼容）。

---

## 2. 交付纪律（与仓库铁律对齐）

1. **一个 PR = 一个逻辑改动**：禁止把「修缺陷 + 加功能 + 顺手重构」混在一起（AGENTS.md 铁律 3）。
2. **壳侧 Kotlin 改动必须走 APK 全链**，不能用热推（AGENTS.md §2 热推适用范围）。插件 JS 改动可热推开发，但最终候选必须回全链。
3. **高风险面即时三层验收**：本重构属于 L3（UI/UX 与壳侧行为），每个 PR 当轮跑「代码层 + CDP/JS 层 + ADB 用户层」，缺一层即未验收。
4. **门禁必跑**：`check-bridge-symmetry`（如新增桥方法）、`check-kotlin-comments`、`check-code-map`、`check-kotlin-test-count`、`check-tool-surface-budget`（若涉及工具面）。
5. **文档同步**：`.kt` 增删/职责变化 → `docs/AGENTS/modules.md`；模块边界 → `ARCHITECTURE.md`；执行顺序 → `EXECUTION-MAP.md`（并跑 `check-code-map.mjs`）；新增持久化键 → `PERSISTENT-DATA.md`；新发现坑位 → `docs/contrib/<account>/`。
6. **禁 emoji**；中英双语文案同时补齐。

---

## 3. P0：前置收敛（4 个修复 PR + 1 份 spike）

> 目的：先把会让新 UI「错得更明显」的既有缺陷与未知事实收敛掉。P0 不改任何视觉。

### P0-1 切清 agentId / sessionId 域（缺陷修复）

- **问题**：`api-session/status` 的 agentId 被写进 `activeSessionId`（`OverlayService.kt:473-474`、`:608-659`），与同仓 `A-R5` 口径冲突（`EXECUTION-MAP.md:292`）。
- **改动**：新增 `currentAgentId` 字段，只服务忙态匹配；`currentSessionId` 只接受 `session/list` 的 `sessionId` 与页面宿主 API（P0 阶段可先只做前者）；所有 RPC 的 `sessionId` 字段断言非空且来源合法。
- **完成条件**：新增单测（agentId 不得进入 session 字段）；发一条消息落到正确会话（CDP 断言 + adb 观察）；回归「待答卡显示 / 完成位文案」两处受该缺陷影响的行为。
- **回滚**：独立 revert；无 UI 变化。

### P0-2 `addView` 失败必须有回执与回滚

- **问题**：面板窗 `addView` 异常被吞（`OverlayService.kt:382`），而 `expanded` 已置 true → 「点球没反应」。
- **改动**：统一 `addOverlayWindow(...)` 包装：失败 → `LogCollector` 记录 + 状态回滚 + 用户可见回执（Toast 或状态行提示）。
- **完成条件**：用一个可控失败用例（如注入抛异常的 WM 代理或模拟权限撤销）证明状态不被置为已展开；日志有记录。
- **回滚**：独立 revert。

### P0-3 刷新 Kotlin 测试基线

- **问题**：基线 2257 例/216 类，实际含 BackKey/PickerTeardown 共 8 例未入基线（基线日期早于测试文件）。
- **改动**：**真跑**测试后执行 `node scripts/check-kotlin-test-count.mjs --update-baseline`（只许升）。
- **完成条件**：门禁绿；基线文件 diff 只增不减；记录执行命令与时间。
- **回滚**：不适用（基线是本轮事实）。

### P0-4 Spike 套件（把未确认项一次收敛）

| Spike | 问题 | 方法 | 产出 |
|---|---|---|---|
| S1 outside-touch | 非焦点 overlay 窗能否收到 `ACTION_OUTSIDE` | 最小 demo（一个 overlay 窗 + `FLAG_WATCH_OUTSIDE_TOUCH`）+ 两个 API 档设备 | 结论 + 设备/API 清单 |
| S2 思考事件 | reasoning 是否一次性到齐；有无 delta 事件 | 插件对未知 `session/event.type` 记日志，跑一轮长思考任务 | 事件类型清单 + 时序 |
| S3 命令目录 | 是否有非 DOM 的命令枚举 API | 插件能力探查 + 上游类型检索 | 可用/不可用 + 备选 |
| S4 工作区 | 是否有工作区列表 RPC；会话↔工作区归属字段 | RPC 探查 + `session/list` 字段核对 | 字段清单 |
| S5 模糊 | overlay 窗跨应用模糊是否生效 | `setBlurBehindRadius` demo，2 台设备 | 结论（仅记录，不作依赖） |
| S6 边缘手势 | 细条/召回条与返回手势冲突率 | 真机 + 模拟器手势模式，各 20 次操作 | 冲突率与建议内缩值 |

- **统一产出**：`docs/overlay-refactor-2026-11/spike-results.md`（每条：结论 / 设备与 API / 命令与证据 / 对设计的影响 / 若失败走哪条退路）。
- **完成条件**：V1-V6 全部有结论；影响 design 的条目同步修订 design.md（不允许只写在 spike 文档里）。

> P0 的 4 个 PR 可以并行；P0-4 的 S2/S3/S4 依赖插件侧能力，可与 P1 并行。

---

## 4. P1：窗口框架（无可见变化）

**目标**：把「窗口数量从 3 变 5-6」这件事的影响面限制在一个框架层，后续每个 UI 只加窗口内容。

**改动面**：

| 文件 | 动作 | 说明 |
|---|---|---|
| `OverlayWindowFrames.kt`（新） | 新增 | 纯函数：可用高计算、卡片 32%/40%、药丸钳制、细条贴边、输入窗底部定位；全部可单测 |
| `OverlayWindows.kt`（新） | 新增 | 窗口持有者：`add/remove/update` 统一包装（含失败回执、z 序表、`onDestroy` 逐窗收口） |
| `OverlayService.kt` | 改造 | 窗口构建/移除改走持有者；保留探活/RPC/发送/隐藏召回逻辑不变 |
| `OverlayController.kt` | 不动 | 开关与权限引导 |
| 测试 | 新增 | `OverlayWindowFramesTest`（至少 20 例：各 API 档可用高、横竖屏、小屏下限、钳制边界、贴边） |

**步骤**：
1. 抽 `OverlayWindowFrames`（先只服务现有 3 窗，保证行为不变）。
2. 抽 `OverlayWindows` 持有者，把现有 `addView/removeView/updateViewLayout` 全部改走它。
3. 落地 `onDestroy` 统一收口 + z 序常量表；补契约测试（窗口数、z 序、收口顺序）。
4. 引入 `entry_ui_v2` 开关读取（默认 false，不影响现状）。

**完成条件**：现有全部测试绿；`check-code-map` / `check-kotlin-test-count` 绿；设备上现有球/面板行为与改前一致（三层验收，截图对比）；新增 `OverlayWindowFramesTest` 覆盖关键常数。

**回滚**：框架层与旧路径并存，关闭 `entry_ui_v2` 即回到旧行为。

---

## 5. P2：顶部事件卡片

**目标**：R4/R5/R6 落地。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayUiModel.kt`（新） | 新增：`CardModel/PillModel/ComposerModel` 聚合纯函数 |
| `OverlayCardView.kt`（新） | 新增：卡片内容构建与增量渲染（工具行环形 50、思考单行、状态行、白条把手、内部 ScrollView） |
| `OverlayService.kt` | 改造：卡片窗生命周期、高度量化变更、收起/展开 |
| `OverlayLiveFeed.kt` | 改造：新增 `k=think` 分支；事件转发到聚合层 |
| `plugins/dsh-android-bridge/src/index.ts` | 改造：新增 `k=think`；`tool_call` 加 `callId` |
| `OverlayUiModelTest.kt`（新） | 新增：合并/去重/上限/排序/尺寸量化 |

**步骤**：
1. 插件先加 `k=think` 与 `callId`（向后兼容，热推可验），补插件单测。
2. 聚合层 + 单测（不依赖 Android）。
3. 卡片视图 + 窗口（开关门控）；滚动与高度量化。
4. 接入事件源：live 流 + `$events` + 探活。
5. 白条下拉/上推手势（40% / 收成药丸在 P3 接）。

**完成条件**：卡片在竖屏/横屏、深/浅色下正确；内容超 32% 时内部滚动且窗口不超限；连续 50 条工具事件不闪不卡（P 系列指标采集成功）；「点外部收起」按 S1 结论实现；三层验收通过。

**回滚**：开关关闭回旧面板；插件改动可单独回退（旧壳忽略 `k=think`）。

---

## 6. P3：状态药丸与入口形态

**目标**：R1/R2/R3/R7/R8/R9 落地。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayPillView.kt`（新） | 药丸窗：单行文本、淡入淡出、拖动、消散手势 |
| `OverlayGestureRouter.kt`（新） | 入口手势裁决（单/双/长按/拖动，纯判定可单测） |
| `OverlayEntryView.kt`（新） | 球 / 细条两种形态渲染；窗口尺寸按形态 |
| `OverlayService.kt` | 改造：入口形态切换、本体前台隐藏、药丸与卡片互斥 |
| `MainActivity.kt` / 新 `HostVisibilityTracker` | 新增：本体前后台上报（`onResume/onPause` 或 `ActivityLifecycleCallbacks`） |
| `OverlayRecall.kt` | 适配：隐藏态与细条形态共存 |
| `overlay_display` prefs | 新增键 `entry_style`（`ball|strip`） |

**步骤**：
1. 手势路由器 + 单测（含「双击窗口内不触发单击」「拖动不触发点击」等边界）。
2. 入口形态切换（重建窗口，不能只换 View）。
3. 药丸窗 + 拖动钳制（允许 y=0）+ 消散阈值。
4. 本体前台隐藏（入口移除/恢复，服务不停）。
5. 隐藏/召回与新形态适配。

**完成条件**：单/双/长按在真机可稳定复现（各 10 次全中）；药丸可拖到屏顶且不自动隐藏；明确上推才消散；本体前台时入口消失、退到后台恢复；三层验收通过。

**回滚**：开关关闭；`entry_style` 单独可回退到球形态。

---

## 7. P4：底部输入区

**目标**：R10 落地（工作区/会话药丸、文字、附件、预览、键盘适配）。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayComposer.kt`（新） | 输入窗内容（药丸行、附件条、输入行、任务态按钮） |
| `OverlayService.kt` | 改造：输入窗生命周期、发送/停止接线 |
| `OverlayPanel.kt` | 抽离：输入行、会话选择器数据口径、待答卡渲染复用 |
| 页面宿主 API（`dsh-client-ui-responsive`） | 新增 `__dshOverlayHost.getState()` / `openSession()` |
| `WorkspaceListParse`（新，纯函数） | 工作区文件回退解析 |
| prefs | 可能需要记录最后一次输入/附件草稿（是否落盘由产品定，默认不落盘） |

**步骤**：
1. 页面宿主 API（先只读 state：sessionId/workspaceId/workspace 列表）。
2. 输入窗骨架 + 键盘（沿用 `ADJUST_PAN` 已验证路径）。
3. 工作区/会话药丸（状态实时同步；切换语义按 S4 结论）。
4. 附件：拍照/相册/文件（复用 `capturePhoto`/`pickImage`/来件链）+ 预览/删除。
5. 待答问答带入输入区（文字作答路径）。

**完成条件**：键盘弹起输入区完整可见（竖/横屏）；发送落到正确会话；三类附件均可添加并预览；待答问题可在输入区作答；三层验收通过。

**回滚**：开关关闭；附件入口可单独隐藏。

---

## 8. P5：命令抽屉

**目标**：R11 落地（附件入口 + 动态命令）。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayCommandDrawer.kt`（新） | 抽屉 UI（上部附件、下部命令列表、搜索可选） |
| 页面宿主 API | 新增 `getCommands()` / `executeCommand(line)`（复用 `composer-sheet` 的 DOM 读取逻辑，抽公共函数） |
| `OverlayService.kt` | 命令执行接线（`/api/commands/execute` 或页面通道） |
| 测试 | 「注入两条假命令 → 抽屉出现两条」的反硬编码用例 |

**步骤**：
1. 抽公共命令读取函数（composer-sheet 与宿主 API 共用）。
2. 宿主 API 返回命令列表；原生渲染。
3. 执行链路（按 S3 结论选页面通道或直接 RPC）。
4. 附件行去重（`ATTACHMENT_ROW_TITLES` 复用，不得按位置过滤）。

**完成条件**：命令列表来自真源（反硬编码测试通过）；点击命令可执行；按 S3 结论选择路径并在文档记录；三层验收通过。

**回滚**：抽屉可隐藏，命令入口不影响主流程。

---

## 9. P6：视觉与性能收口

**目标**：色板统一、动效门控、性能基线可复测。

**内容**：
1. 色板收敛：新 UI 只用 `ds_*`；旧面板字面量不再新增；新增常量仅卡片高度比例。
2. 动效：全部动画走 `DsUi.animationsEnabled` + `registerMotionListener`；关闭动画时立即到终态。
3. 字号/字体缩放下不溢出（系统字号 1.3x / 1.5x 各截图）。
4. 性能基线：用 `scripts/perf/measure-steady.ps1` 与 `scripts/verify-frame-timing.mjs` 采集，另按 test-plan P 系列补 `gfxinfo framestats`；把结果写入 `docs/perf/` 新文件并在 design 7.7 表格回填（**只填实测值**）。

**完成条件**：色板无第三套；动画门控有用例；性能指标有基线值与来源命令；无「静止时仍有动画」。

---

## 10. P7：兼容与发布收口

**内容**：
1. 兼容矩阵逐项过（test-plan C 系列），记录设备/API/结果。
2. 双 ABI 全链构建 + 装机；竖屏 16416 / 横屏 16384 / arm64 真机三层验收。
3. 文档同步：`modules.md`、`ARCHITECTURE.md`、`EXECUTION-MAP.md`（跑 `check-code-map.mjs`）、`PERSISTENT-DATA.md`（新增 prefs 键）、`known-gaps.md`（不做项）、`changelog-archive.md`。
4. `entry_ui_v2` 默认值改为 `true`（独立 PR，可单独回滚）。
5. 发布说明草稿：`release/v<版本>/notes.md`。

**完成条件**：test-plan 全部 P0 用例通过并留证据；无未登记的不做项；门禁全绿。

---

## 11. 依赖关系图

```
P0-1 ─┐
P0-2 ─┼─> P1 ─┬─> P2（卡片）───────┐
P0-3 ─┘       ├─> P3（药丸/入口）──┤
P0-4（S1..S6）┘                   ├─> P6（视觉/性能）─> P7（发布收口）
              └─> P4（输入）─> P5（命令）─┘
插件 k=think / callId（P2 前置，可提前合入，独立回滚）
页面宿主 API（P4/P5 前置，可在 P1 期间并行开发）
```

关键路径：P0 → P1 → P4 → P5 → P6 → P7。P2/P3 可与 P4 前半并行，但 P4 的「工作区/会话药丸」依赖页面宿主 API。

---

## 12. 回滚策略

| 层级 | 手段 | 影响面 | 验证回滚是否成立 |
|---|---|---|---|
| L1 功能开关 | `overlay_display/entry_ui_v2=false` | 立即回旧形态，保留新代码 | 设备上关闭开关后旧球/面板行为正常 |
| L2 形态开关 | `entry_style` 回 `ball` | 只回入口形态 | 细条→球重建窗口正常 |
| L3 单 PR revert | 按阶段 PR 粒度 revert | 该阶段功能消失，前序保留 | CI 绿 + 三层抽测 |
| L4 插件回退 | 插件回上一版本（`lib/` 与 `src` 同步） | 思考行/命令能力退回 | 旧壳忽略未知事件仍工作 |
| L5 版本回退 | 回上一 APK | 全量 | 用户侧覆盖安装 |

**硬约束**：任何阶段的回滚都不得要求「恢复服务停止」——悬浮服务生命周期与 UI 开关解耦。

---

## 13. 完成条件（Definition of Done，逐阶段套用）

1. 代码层：新增纯逻辑有单测；`check-kotlin-test-count` 只升不降；`check-kotlin-comments`、`check-code-map` 绿。
2. CDP/JS 层：对应 `verify-*.mjs` 绿（页面侧改动时）。
3. ADB 用户层：竖屏 16416 + 横屏 16384 各一次真实操作 + 截图；发布前 arm64 真机补。
4. 证据落盘：命令清单 + 截图路径 + 三层结论行写进 PR 描述。
5. 文档：按 AGENTS.md §5.1 更新对应详档；新增未确认项写进 `known-gaps.md`。
6. 无 emoji；中英双语；无硬编码命令清单；无新增 DSH 上游改动。

---

## 14. 风险登记（施工期）

| 风险 | 触发信号 | 应对 |
|---|---|---|
| 窗口数量增加导致残窗 | `dumpsys window` 窗口数 > 预期；返回后仍有 overlay | 立即用 `OverlayWindows` 收口 + 契约测试加用例 |
| outside-touch 不生效 | 点外部无反应且无日志 | 按 S1 失效退路（返回键/再点入口/自动收起）；不阻塞其他功能 |
| 事件风暴掉帧 | P 系列指标超阈值 | 降低合并频率、缩短列表上限、延迟非可见区渲染 |
| 命令真源不可得 | S3 无官方 API 且 DOM 读取不稳 | 降级为「唤起本体命令面板」，并在 known-gaps 登记 |
| 键盘遮挡输入区 | 横屏/小屏实测 | 输入窗改全宽抽屉 / 减少药丸行高度 |
| 与既有面板代码双轨 | 两套 UI 同时生效 | 开关只允许二选一；旧面板入口在开关为 true 时禁用 |
| 测试基线再次漂移 | 门禁报例数不符 | 真跑后 `--update-baseline`，禁止手改数字 |

---

## 15. 明确不做（Out of scope）

1. 不做语音输入（需求原文）。
2. 不做 Liquid Glass 动态折射/真实跨应用模糊（依赖系统能力且收益不确定）。
3. 不做 Compose 重写、不新增 Rust 模块、不改 DSH 上游。
4. 不为第三方插件写专用适配。
5. 不做「悬浮层内嵌完整 WebView 页面」。
6. 不做多用户/多引擎实例的悬浮层多路复用（当前单引擎模型）。
7. 本阶段（Phase 1）**不做任何施工**。
