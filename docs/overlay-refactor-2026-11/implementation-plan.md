# DeepCode Android 悬浮交互系统重构 — 实施计划（implementation-plan）

> 当前优先项：按用户最新交互澄清继续实现与测试；此前“本轮仅文档”限制属于上一轮历史，现已获明确续工授权。§0.2记录当前源码落点；§1–§15为目标施工计划，§16–§23保留旧输入的施工与测试历史。**CURRENT VERIFICATION PENDING**：旧参数、旧按钮、旧取件暂收方案和旧绿色证据不能证明最新输入通过。
> 需求最高基线：[用户原始要求追溯](<docs/overlay-refactor-2026-11/user-baseline.md>)；Phase1 调查基线 `5f533907`。调查/设计/验收分别见 [investigation](<docs/overlay-refactor-2026-11/investigation.md>)、[design](<docs/overlay-refactor-2026-11/design.md>)、[test-plan](<docs/overlay-refactor-2026-11/test-plan.md>)；[交接](<docs/overlay-refactor-2026-11/handoff-phase2.md>) 只代表上轮快照。
> 本计划按「前置收敛 → 窗口框架 → 卡片 → 药丸/入口 → 输入 → 命令 → 视觉性能 → 发布收口」推进；**每一阶段都可独立交付、独立回滚**。

---

## 0. 此前施工与证据快照（历史输入）

下表与本节后续inset修复说明保留上一轮时序；“当前/本次”等词均指当时输入，不能当成本轮最新结果。新增实现见§0.2，最新代码/产物/设备执行只读lead的[测试报告](<test-report-phase2.md>)。

| 面 | 已有证据（历史交接，不自动继承为本轮通过） | 当前剩余 |
|---|---|---|
| P0/P1-P5 | 初版代码/编译/单测及插件/页面定向测试有交接记录 | 续工审查发现 liveSink 未订阅、后台求值受前台拦截、药丸 DOWN/二次上推、状态 reset/恢复、审批二步确认、卡片/输入 BACK 与运行中回滚等断链，须修后重跑，不可沿用初版绿 |
| 壳侧编译/全量单测 | 当前同DOWN入口竞态轮 [kotlin-toggle-race](<.deploy-tmp/overlay-continue/kotlin-toggle-race.log#L47-L56>) 全量+assemble成功，lead核2895/0fail/2skip/284类 | 旧2894/2881按各自输入保历史，不外推workload帧时/设备全验/发布；资产与实际10cycle/10tap/drag由lead报告维护 |
| 页面/插件 | 当前安全来件轮85专项/tsc/build通过，独立完整full91文件1308PASS exit0，输入/hash见§23 | 旧87/1299及所有旧FAIL按输入保历史；页面全量绿不代新runtime fresh reload后三取件/性能或完整发布链 |
| 地图文档门禁 | 首次exit1/123项、后续73项完整失败记录保留§16；task8逐项修复后exit0并143/143内存读面负控检出 | task12最终协议与后续源码可能再移动行锚，须再次运行；不改脚本/基线、不删有效判据。新结果见独立日志，不覆盖原FAIL |
| 设备/最终产物 | 早期卡片/旧runtime宿主undefined记录保留；lead确认曾有安装并发active-build污染，旧安装不能算当前候选成功。现稳定copy安装成功并见白条收成pill | 单张pill图不证明顶缘/IME/整套通过。完整设备时序、产物哈希与逐项结果仅由 [测试报告](<docs/overlay-refactor-2026-11/test-report-phase2.md>) 单一维护；非发布候选，不新建release |
| P6/P7 | 无完整视觉性能/兼容/双ABI发布证据 | 不宣布完成、不默认启用、不发布；需求全部完成与证据齐全后才收口 |

本次文档分工仅核读源码与运行地图门禁，**未做设备验证、未跑Gradle、未安装或变更依赖、未提交**。lead设备取证发现非输入overlay重复状态栏inset（WMS parent top36 + lp.y48 = 实际84），正修API30+ setFitInsetsTypes(0)+LAYOUT_IN_SCREEN绝对几何；输入窗不套此方案，IME另验。这里只记缺陷/修复目标，不称坐标已对。

## 0.1 最新交互要求的优先收口顺序

1. 纠正窗口职责：中间空白只收底部输入/IME/sheet，保顶部；sheet覆盖输入而不改变composer位置/尺寸。启动相机/相册/文件选择不得主动收起、移窗、重建或清草稿，返回/取消保同View、session、text与selection；成功仅追加附件。
2. 顶部作为当前会话记录主体：运行/空闲/重开均有真实用户与助手记录，渲染Markdown及工具调用/参数/结果/状态。移除右上X、形态、隐藏及占位触区；显式球/条选择移至应用设置。
3. 球条连续手势：默认自由球，拖到右侧边界贴边停放后，再向该边缘侧滑才收条；条向屏内拉出恢复自由球，可转移到另一侧重复，左右对称。只到边不能直接变条。
4. 白条与长胶囊：长按白条上推时跟手非线性形变成长条，一行显示最新Agent输出；到顶仅限位，继续推先宽容后按距离渐淡并最终收起，同时收输入/IME/sheet且保草稿与Agent；不足提交时自然回弹。宽容距离、阻尼、形变曲线/时长与提交点待验证，不照搬旧16dp/500dp/s开关。
5. 按[测试矩阵F-01..F-42](<test-plan.md>)补对应正反证与真实两向链路。以上均为当前目标；既有开发包中有相反行为的部分必须修正，不能将旧测试改名后当新验收。

## 0.2 当前续工源码落点（2026-11-13）

**CURRENT VERIFICATION PENDING**。本轮已继续实现，不沿用此前“仅文档”停止点；下列是核读源码事实，不是验收结果：

- 独立DRAWER覆盖COMPOSER，打开/关闭不为sheet抬移或resize输入；同窗picker交互租约保存View/flags/alpha，让系统可触而不hide/show/setText，空sid拒绝取件不隐式create。租约守卫配置重建，真实旋转允许原View几何reflow；精确request/失败回滚/恢复重试以最终源码为准。
- 真实公开eventSource投影对话/工具，Kotlin复验预算；assistant安全native Markdown，user/tool literal、稳定row/scroll锚；顶部X/形态/隐藏已移除。设置trusted get/setOverlayEntryStyle共用原entry_style，不改enable/默认v2=false。
- 新OverlayMotion是可配置距离纯数学。白条longpress后固定card root跟手绘制，终态才交接长pill；顶限位/宽容fade可同DOWN完成，不足/CANCEL回弹，终态联动收底部。长条真assistant一行输出，双侧球条分阶段拖动与router consumed已接；provisional参数待实测；当前card collapse距离由handle TOP保守nullable helper自适应，DOWN锁定至MOVE/UP/settle并清理，不是固定84dp产品门，空历史小卡/横屏须正屏可达；chip测前cache/attached GL+PreDraw对称清理/规范化top dedup、lease-first membership/drawer与双post focus守卫均已落源码，须当前包复验。
- 新命中面增量：workspace/session稳定TextView分别进入WORKSPACE/SESSION独立有界窗，无fullwidth pillRow；API33主输入root可见surface touch union仅layout/scroll更新、非逐帧morph，低API额外透明间隙未被该API解决。API33 card真实圆角输入Region成功不加NOT_TOUCHABLE，false才旧fallback；lead设备WMS把旧alpha1请求cap.80的透底失败保留，API26–32/失败fallback限制未解决。公共setter内部traversal成本待测，不称全morph纯draw-only，composer常态1/picker九槽.15独立不变。实色surface+旧文字退尽后新文字入场的MorphVisual修截图重叠，回弹/取消/终态恢复，Android12+ opaque跨UID新DOWN/间隙透传仍待验，旧SCOPED_PASS不等UI acceptance。配置按稳定ignoringVisibility系统栏预算更新drawer cap/reflow。显式新会话send的onCreated迁移inflight草稿/选区，picker不隐式create不变。
- 只读debug UI快照暴露View身份/flags/alpha、节点bounds/草稿sid/text/selection/refs与motion配置，服务真实操作反证；不是新增模型工具或功能成功证明。

详细实现及源码链接见[续工交接§3](<handoff-phase2-continued.md>)、合同见[设计§5.5](<design.md>)，不在本页复制测试数字。lead单一维护[测试报告](<test-report-phase2.md>)的最新测试/产物/安装/两向证据；设备快照初始化不等于最新APK装机。文档分工仅运行地图门禁，**未做设备验证、未跑Gradle、未build/install**。

## 1. 阶段总览

| 阶段 | 交付物 | 依赖 | 可并行的另一条线 | 回滚单位 |
|---|---|---|---|---|
| P0 前置收敛 | 4 个修复 PR + 1 份 spike 结论 | — | — | 单 PR revert |
| P1 窗口框架 | 窗口几何/持有者/开关骨架（无可见变化） | P0 | 插件 `k=think` / `callId`（P2 前置） | 开关关闭 = 旧路径 |
| P2 顶部记录卡片 | 真会话历史 + Markdown + 工具调用 + 状态/思考 + 无多余顶部按钮 | P1 | 页面宿主 API（P5 前置） | 开关 + 单 PR revert |
| P3 长胶囊与入口形态 | 跟手长条 + 顶部宽容渐淡/联动收输入 + 设置/双侧球条拖拽 + 前台隐藏 | P1 | 附件入口（P4 前置） | 开关 + 单 PR revert |
| P4 底部输入区 | 浮动胶囊 + 离底输入药丸 + 同窗取件保草稿 + 附件预览 | P1，建议在 P3 后 | 命令抽屉 UI（P5） | 开关 + 单 PR revert |
| P5 独立选择sheet | 底部覆盖卡片 + 输入不移位 + 动态命令 + 执行链路 | P4；页面宿主 API | — | 开关 + 单 PR revert |
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
| `OverlayCardView.kt`（新） | 当前目标：真实用户/助手多行历史、Markdown与工具调用/参数/结果混排，稳定ID增量渲染、保历史滚动、白条把手；无右上X/形态/隐藏 |
| `OverlayService.kt` | 改造：卡片窗生命周期、高度量化变更、收起/展开 |
| `OverlayLiveFeed.kt` | 改造：新增 `k=think` 分支；事件转发到聚合层 |
| `plugins/dsh-android-bridge/src/index.ts` | 改造：新增 `k=think`；`tool_call` 加 `callId` |
| `OverlayUiModelTest.kt`（新） | 新增：合并/去重/上限/排序/尺寸量化 |

**步骤**：
1. 插件先加 `k=think` 与 `callId`（向后兼容，热推可验），补插件单测。
2. 聚合层 + 单测（不依赖 Android）。
3. 卡片视图 + 窗口（开关门控）；运行与空闲均读真实历史，Markdown与工具调用可读，内部滚动/稳定锚点不被流更新抢走；移除顶部多余控件与空触区。
4. 接入事件源：live 流 + `$events` + 探活。
5. 白条下拉保留40%展开；长按上推的跟手非线性形变与长条衔接在P3完成，不只做瞬间移窗切换。

**完成条件**：竖横屏/深浅色下，运行、空闲与重开均可读同会话真实历史/Markdown/工具；自动≤32%、手动40%且溢出内部滚动；连续工具与正文增量不闪跳、不打断读历史；中间空白只收底部、顶部无X/形态/隐藏；三层验收通过。

**回滚**：开关关闭回旧面板；插件改动可单独回退（旧壳忽略 `k=think`）。

---

## 6. P3：长输出胶囊与入口形态

**目标**：R1/R2/R3/R7/R8/R9 落地。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayPillView.kt`（新） | 长输出胶囊：一行真实Agent输出，非线性跟手形变、自由拖动、顶部限位/宽容渐淡与回弹 |
| `OverlayGestureRouter.kt`（新） | 单/双/长按/自由拖动及边界状态裁决：贴边后独立侧滑收条、条向内拉出成球、左右对称；纯判定可单测 |
| `OverlayEntryView.kt`（新） | 球 / 细条两种形态渲染；窗口尺寸按形态 |
| `OverlayService.kt` | 改造：入口形态切换、本体前台隐藏、药丸与卡片互斥 |
| `MainActivity.kt` / 应用级可见性跟踪 | 初版只有 MainActivity；续工改应用级 ActivityLifecycleCallbacks，覆盖 Console/Repair、排除透明附件代理、读取启动初态并处理切 Activity 去抖；源码与设备待收口 |
| `OverlayRecall.kt` | 适配：隐藏态与细条形态共存 |
| `overlay_display` prefs | 新增键 `entry_style`（`ball|strip`） |

**步骤**：
1. 手势路由器 + 单测（含「双击窗口内不触发单击」「拖动不触发点击」等边界）。
2. 应用设置承载显式球/条选择，不在顶部放形态/隐藏/X；切换保持会话草稿与任务。
3. 默认球自由拖动；到边贴边停放后再次向该边缘侧滑成条，条向屏内拉出成球，可跨侧复用，不能仅到边就变条。
4. 白条长按上推连续非线性收成长条；长条最新Agent正文优先于短状态，宽度按一行可读性适配，不能沿用短pill形态。
5. 顶部限位后继续上推先宽容后距离驱动渐淡，终态联动收输入/IME/sheet；取消/不足回弹。几何/阻尼/时长经新实测收敛，不复用旧速度开关判据。
6. 本体前台隐藏与既有设置/兼容召回保持，服务/Agent不停。

**完成条件**：单/双/长按原语不回归；左右两侧“自由球→贴边→独立侧滑成条→向内拉出成球→跨侧”可完整重复；长输出胶囊非线性跟手，到顶保持/宽容内回弹/越界渐淡收起与输入联动均有反证；本体前后台恢复与三层验收通过。

**回滚**：开关关闭；`entry_style` 单独可回退到球形态。

---

## 7. P4：底部输入区

**目标**：R10 落地（工作区/会话药丸、文字、附件、预览、键盘适配）。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayComposer.kt`（新） | 独立浮动工作区/会话胶囊，无共用底板；离底全圆输入药丸、附件条与任务按钮；sheet在上覆盖时原输入几何不变 |
| `OverlayService.kt` | 改造：输入窗生命周期、发送/停止接线 |
| `OverlayPanel.kt` | 抽离：输入行、会话选择器数据口径、待答卡渲染复用 |
| 页面宿主 API（`dsh-client-ui-responsive`） | 已有 `__dshOverlayHost.state/sessions/commands/execute/send/removeAttachment/openSession`，同步 JSON 回包；页面未就绪/失败不得伪装为空数据 |
| `WorkspaceListParse`（新，纯函数） | 工作区文件回退解析 |
| prefs | 可能需要记录最后一次输入/附件草稿（是否落盘由产品定，默认不落盘） |

**步骤**：
1. 页面宿主 API（先只读 state：sessionId/workspaceId/workspace 列表）。
2. 透明输入域骨架：胶囊各自浮动、输入完整圆角离底，键盘可用；sheet叠盖时不通过改y/resize抬移输入。
3. 工作区/会话胶囊使用实时真源与各会话草稿隔离；设置和选择动作不混用创建override。
4. 附件：绑定targetSessionId/requestId，复用现有相机/选择器与定向入稿。启动、返回、取消都不主动收起/移动/重建原浮窗；保同View/session/text/selection及已有附件，成功仅追加到原目标。系统交互可临时让出焦点/触摸但须恢复flags，不以hide/show恢复。三类取件/取消/认领/提交逐阶段取证。
5. 底部文字作答复用原事件/题目协议，隔离消息与答案草稿；完整表单保选项/多选/分页/跳过，审批保reason/二步确认。中间空白只退底部编辑/IME/sheet，不退顶部记录。

**完成条件**：键盘/输入药丸在双向可用；sheet叠盖前后输入坐标/尺寸相同；带文字/选区/已有附件启动三类取件并取消或返回时，原窗/草稿不丢，成功只追加；消息/作答目标正确；中间空白只收底部；三层验收通过。

**回滚**：开关关闭；附件入口可单独隐藏。

---

## 8. P5：命令抽屉

**目标**：R11 落地（附件入口 + 动态命令）。

**改动面**：

| 文件 | 动作 |
|---|---|
| `OverlayCommandDrawer.kt`（新） | 独立底部覆盖sheet（上附件、下动态命令/选择列表），盖在原输入框和其它应用上，不inline撑高或抬移输入 |
| 页面宿主 API | `commands()` / `execute(line)` 与 composer-sheet 共用 composer-commands；缓存首次未就绪后需重读，执行走页面resolveClaim/claim.submit并以operation回执收敛，不破坏页面草稿，不是 Kotlin 直接拼 commands/execute |
| `OverlayService.kt` | 命令执行接线（`/api/commands/execute` 或页面通道） |
| 测试 | 「注入两条假命令 → 抽屉出现两条」的反硬编码用例 |

**步骤**：
1. 抽公共命令读取函数（composer-sheet 与宿主 API 共用）。
2. 宿主API返回命令列表；原生独立sheet从底部非线性出现并覆盖原输入域，不修改composer坐标/尺寸。
3. 执行链路（按 S3 结论选页面通道或直接 RPC）。
4. 附件行去重（`ATTACHMENT_ROW_TITLES` 复用，不得按位置过滤）。

**完成条件**：命令真源/反硬编码与执行链通过；sheet在原输入之上叠盖而非避让；重复打开/关闭、改列表与启动picker均不收原窗/丢草稿，finite动画取消不误移新窗；三层验收通过。

**回滚**：抽屉可隐藏，命令入口不影响主流程。

---

## 9. P6：视觉与性能收口

**目标**：色板统一、动效门控、性能基线可复测。

**内容**：
1. 色板收敛：新 UI 只用 `ds_*`；旧面板字面量不再新增；新增常量仅卡片高度比例。
2. 动效：白条跟手形变、长条拖动/顶部阻尼宽容渐淡、反向回弹、sheet入退场作为连续非线性交互整体测量，不以“设置了duration”冒充流畅。保`DsUi.animationsEnabled`与生命周期收口，关闭动画到准确终态，不逐帧重建正文或让sheet动画抬移输入。
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
| L1 功能开关 | `overlay_display/entry_ui_v2=false` | Service缓存同cachedV2，suspendUi/resumeUi仅切窗口保草稿/model/inflight/unknown锁，回滚不cancel；真Service销毁才释放观察 | 必须实证往返草稿不覆盖/无残窗/原票据只读核对、不重复prompt，不能只改prefs就宣称验收 |
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
| outside-touch 不生效 | 点外部不收或吞下层点击 | outside-touch 与返回路径都须完成；初版 v2 无 BACK 不能列作现成保底，续工补卡片/输入返回并验证 IME/焦点 |
| 事件风暴掉帧 | P 系列指标超阈值 | 降低合并频率、缩短列表上限、延迟非可见区渲染 |
| 命令真源不可得 | S3 无官方 API 且 DOM 读取不稳 | 降级为「唤起本体命令面板」，并在 known-gaps 登记 |
| 键盘/选择器与浮窗冲突 | 横屏/小屏/取件返回实测 | 保浮动输入与草稿身份，不以贴底整板/抬移sheet输入/撤窗重建规避；临时焦点触摸让行需对称恢复并测取消 |
| 与既有面板代码双轨 | 两套主入口同时生效或遗留窗口 | 主入口二选一；v2 保留旧作答面与回滚面，生命周期要共用收口；保留不代表 F-19 无需验 |
| 测试基线再次漂移 | 门禁报例数不符 | 真跑后 `--update-baseline`，禁止手改数字 |

---

## 15. 明确不做（Out of scope）

1. 不做语音输入（需求原文）。
2. 不做 Liquid Glass 动态折射/真实跨应用模糊（依赖系统能力且收益不确定）。
3. 不做 Compose 重写、不新增 Rust 模块、不改 DSH 上游。
4. 不为第三方插件写专用适配。
5. 不做「悬浮层内嵌完整 WebView 页面」。
6. 不做多用户/多引擎实例的悬浮层多路复用（当前单引擎模型）。
7. Phase1 的「只调查不施工」仅为历史阶段边界；本轮已获 Phase2 续工授权，但不扩大到需求之外的重构。

---

## 16. 文档分工最终门禁（2026-11-12 00:03 后收口）

- 真跑命令：`node scripts/check-code-map.mjs`，工作目录为本worktree；**exit1 / CHECK-CODE-MAP FAILED（73项）**。查点19、覆盖条目494、锚点1033、耦合边153、流程图16、全域文件1169。新增模块覆盖已补齐，本次无uncovered；这不等于门禁通过。
- 下方保留完整失败清单作为本分工门禁日志，禁止以“历史漂移”豁免。lead后续需按最终源码集中重钉并复跑；没有刷脚本/基线，没有删有效判据求绿。当前日志输入在持续变化，最终候选须再次运行。
- 本次只写任务列出的7份docs；源码/test-plan/handoff/依赖未写，未Gradle/设备/提交。设备最终报告由lead单一维护，当前无三层PASS；本节不创建尚未存在报告的链接。
- 当前页面旧基线完整证据：[基线报告](<.deploy-tmp/overlay-baseline-page/summary.md>)。5f533907 archive+同commit补丁/fixture+共享依赖，最终87文件/1225测试=1219pass+6fail(exit1)，定向0pass+6fail(exit1)；六例同名同错，仅在本机实装DSH0.2.1-rc.2/cordis4.0.5的前提成立，不能替代声明0.2.2-rc.1/4.1.0环境，也不能称全量绿。

### 地图失败日志（完整）

```text
[bad-anchor-content] Expected "runOnUiThread {" at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:876, actual line: "}"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:619; expected one of ["LogCollector.start(this)"], actual: "crashFile.delete()"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:193; expected one of ["splashTimeout = task"], actual: "val task = Runnable {"
[anchor-content-drift] Referenced content changed at MainActivity.kt:619; expected one of ["LogCollector.start(this)"], actual: "crashFile.delete()"
[anchor-content-drift] Referenced content changed at MainActivity.kt:422; expected one of ["// 插件装配失败 latch（CONTRACT §4）：latch 期内**不得**把坏页面推回前台。"], actual: "internal fun showWeb() {"
[anchor-content-drift] Referenced content changed at MainActivity.kt:191; expected one of ["finishSplash(\"timeout\", animate = false)"], actual: "private fun scheduleSplashTimeout() {"
[anchor-content-drift] Referenced content changed at MainActivity.kt:549; expected one of ["true"], actual: "pageRecovery.pause()"
[anchor-content-drift] Referenced content changed at MainActivity.kt:583; expected one of ["if (userClosedEngine) EngineService.userShutdown = true"], actual: "} else {"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:45; expected one of ["| OverlayController.kt | 悬浮球开关持久化 + 服务起停 + SYSTEM_ALERT_WINDOW 权限引导（偏好 ∧ 权限 ∧ 服务在场） | AndroidBridge lambda、MainActivity、OverlayService（注释） |"], actual: "| [OverlayAttachProxyActivity.kt](<app/src/main/java/com/dsharnessmobile/shell/OverlayAttachProxyActivity.kt>) | 拍照/相册/文件代理，复用 PhotoCaptureController/FileIncoming 入队；OverlayAttachmentBus 仅回执 | OverlayV2；非导出 Activity |"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:76; expected one of ["| ControlPoller.kt | 无障碍控制队列客户端（引擎侧 exact 路由长轮询 + 心跳 + 回填；协议版本/能力声明） | EngineStartFlow、DeviceControlService |"], actual: "## 4. ADB / Shizuku / 设备控制 / 通知 / 日志 / UI 工具"
[anchor-content-drift] Referenced content changed at MainActivity.kt:507; expected one of ["webView.loadUrl(EngineProbe.ENGINE_URL)"], actual: "} catch (t: Throwable) {"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:68; expected one of [""], actual: "| SnapshotFs.kt / SnapshotFileMode.kt / SnapshotUserData.kt / SnapshotFingerprintPolicy.kt / ProfilePackageManifest.kt | NOFOLLOW文件原语、权限；迁移marker与活动profile配置保留/传输/旧blank seed隔离；未知 `.dsh` 冲突项默认保留；严格内嵌SHA与durable fingerprint准入；profile manifest merge 与快照刷新共用 | SnapshotTransaction、EngineManager |"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:65; expected one of ["| ConsoleSession.kt | 快照 bash 子进程（stdin 管道 + Listener 回调，随 Activity 生死） | ConsoleActivity |"], actual: "| UndoGate.kt | 看门狗/启动失败恢复：按当前 transaction-authorized Hard `{id,name}` manifest 判归属；非 Hard 故障只追加 disabled override 保留原配置；整份恢复要求同一 Soft digest 在两次实际引擎 spawn 上通过 authenticated Cordis/preset/session/modelCatalog health | EngineService、EngineStartFlow |"
[bad-anchor-content] Expected "internal fun isReaderAllowed(activity: MainActivity, file: java.io.File): Boolean {" at app/src/main/java/com/dsharnessmobile/shell/FileIncoming.kt:723, actual line: "val file = java.io.File(path)"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at MainActivity.kt:579; expected one of ["} else {"], actual: "val autoStartOnOpen = SplashStore.autoStart(this)"
[bad-anchor-content] Expected "runOnUiThread {" at MainActivity.kt:876, actual line: "}"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at OverlayService.kt:683; expected one of ["// 这句最要紧的话就被 tick 覆写成「引擎离线」——用户正要作答的提示被抹掉。"], actual: "activeSessionId.isEmpty() || agentId == activeSessionId ||"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:70; expected one of ["|---|---|---|"], actual: "| UpdateManager.kt | SHA 校验后把在线包解到共享 stage，经 ONLINE_UPDATE journal 只换 usr；探活健康提交，冷启动恢复未提交事务 | EngineManager、EngineStartFlow |"
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:71; expected one of ["| AdbKeyboardService.kt | 内嵌 ADBKeyboard 协议 IME（android_ui_input 中文输入；仅活跃时提交） | 运行期注册 AdbKeyboardReceiver（隐式广播）+ 注销 |"], actual: "| EngineProbe.kt | 引擎探活（Proxy.NO_PROXY 直连 #118；401/303 视作 alive）；Soft promotion 的只读健康证据另要求 Cordis inventory、启用的主插件与 preset fibers active、session/list 与 modelCatalog 形状完整 | 壳侧全部探活唯一入口 |"
[anchor-content-drift] Referenced content changed at OverlayService.kt:669; expected one of ["// `!running` 分支里直接改文案，恢复在线时**没有任何人**把它改回来 —— 面板开着、引擎已经起来，"], actual: "}"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt:706; expected one of ["Thread {"], actual: "setHalo(Halo.WORKING)"
[anchor-content-drift] Referenced content changed at app/src/test/java/com/dsharnessmobile/shell/SnapshotFileModeTest.kt:7; expected one of ["class SnapshotFileModeTest {"], actual: ""
[anchor-content-drift] Referenced content changed at app/src/test/java/com/dsharnessmobile/shell/SnapshotFileModeTest.kt:10; expected one of ["fun identifiesOnlyElfAndShebangPayloadsAsDirectExecutables() {"], actual: "@Test"
[bad-anchor-content] Expected "const adbReady = engineLevelReady(st)" at plugins/dsh-android-bridge/src/index.ts:1275, actual line: "/** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "rmSync(join(queueDir(), item.file), { force: true })" at plugins/dsh-android-file-open/src/index.ts:466, actual line: "*/"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "return undefined" at plugins/dsh-android-file-open/src/index.ts:763, actual line: ""（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "private peekHeight" at composer-sheet.ts:1096, actual line: "*/"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "private maxHeight" at composer-sheet.ts:1071, actual line: "/** 展开上限：0.88 × 可见视口高，且不小于 peek。 */"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "private readonly onSheetTouchMove" at composer-sheet.ts:1321, actual line: "*/"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "const DRAG_LOCK_PX" at composer-sheet.ts:89, actual line: "/** 方向锁：起手这么多像素内不判定归属（避免「想滚列表却把卡片拉高」）。 */"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "private readonly onSheetTouchEnd" at composer-sheet.ts:1409, actual line: "*/"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:205; expected one of ["// S1-11：结果如实回执——用户拒绝后下一次「该提醒而没提醒」的原因就是这一下。"], actual: ""
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:391; expected one of ["}"], actual: "if (pageRecovery.rendererGone) {"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:296; expected one of ["internal var observedChromiumVersion: String = \"\""], actual: ""
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:137; expected one of ["internal val splashImportController = SplashImportController(this)"], actual: "internal val dirPickerController = DirectoryPickerController(this)"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:690; expected one of ["// Activity-owned isolated WebView only through the process-wide holder."], actual: "browserHost = BrowserHost(this, root, webView)"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:266; expected one of ["* `syntax_floor_ok:` 字段必须与本处同源（同一个数字），故跨类引用；`private` 会编译不过。"], actual: "* 本常量是诊断字段 `syntax_floor_ok` 的判据门槛，与 `check-browser-syntax-floor.mjs` 的"
[anchor-content-drift] Referenced content changed at MainActivity.kt:145; expected one of ["private var splashTimeout: Runnable? = null"], actual: "private var splashOverlay: SplashOverlay? = null"
[anchor-content-drift] Referenced content changed at MainActivity.kt:354; expected one of [""], actual: "engineManager.clearRefreshLedger()"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:160; expected one of ["val path = SplashStore.filePath(this) ?: return"], actual: "private fun maybePlaySplash(force: Boolean) {"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:742; expected one of ["if (consumePendingSelfRetry()) {"], actual: "// #682 收口：外部可达的特权 action 已全部移除——重试改为进程内一次性标志"
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:794; expected one of ["deliverNotifyRoute()"], actual: "intent?.getStringExtra(NotifyCenter.EXTRA_TARGET_AGENT),"
[bad-anchor-content] Expected "val conn = java.net.URL(EngineEndpoint.url" at app/src/main/java/com/dsharnessmobile/shell/FileIncoming.kt:541, actual line: "/** Overlay targets are immutable, process-local and never fall back to a current/new session. */"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:206; expected one of ["if (!granted) {"], actual: "private val notificationPermission ="
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt:574; expected one of ["sessionBusy = false"], actual: "MotionEvent.ACTION_DOWN -> {"
[bad-anchor-content] Expected "let workspacePromise: { key: string; value: Promise<string | undefined> } | undefined" at plugins/dsh-android-file-open/src/index.ts:536, actual line: "}"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "return lease" at plugins/dsh-android-file-open/src/index.ts:765, actual line: "ctxLogger = ctx.logger"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at OverlayService.kt:299; expected one of ["// 球贴边时球心距屏边 25dp > 24dp，光晕圆完整在屏内（治「吸附后光圈与球错位」）。"], actual: "removeWindow(rootView); rootView = null"
[anchor-content-drift] Referenced content changed at OverlayPanel.kt:837; expected one of ["// 选项时用户看不到剩余候选，只能被迫手打。现在默认列 6 项（卡面高度有限）+ 一行明示入口。"], actual: "header.addView(TextView(svc).apply {"
[anchor-content-drift] Referenced content changed at OverlayService.kt:580; expected one of ["/**"], actual: "MotionEvent.ACTION_MOVE -> {"
[bad-anchor-content] Expected "val generation = pageRecovery.generation" at MainActivity.kt:854, actual line: "pendingNotifySession = null"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "if (callId) liveCalls.delete(callId)" at plugins/dsh-android-bridge/src/index.ts:2175, actual line: "// 0.1.4（0.13.3 D6/W3）：turn/start 专门行退役——壳侧忙态改消费官方"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at MainActivity.kt:795; expected one of ["}"], actual: ") ?: return"
[bad-anchor-content] Expected "consumeNotifyRoute(intent)" at MainActivity.kt:810, actual line: "// 旧实现只在 onCreate 调 FileIncoming.processIncomingIntent，于是「应用已在前台时分享文件」"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at docs/AGENTS/ARCHITECTURE.md:90; expected one of ["| ShellState.kt | ST 真源收敛：沉浸式/开发者日志两处「展示值 ≠ 事实」的统一读写面（仅偏好 ∧ 运行时合取） | MainActivity、WebUiChrome、AndroidBridge |"], actual: "| NotifyStore.kt | `.notify.ndjson` 偏移消费（FileObserver + 字节偏移持久化 + 双读不双发） | NotifyCenter |"
[bad-anchor-content] Expected "render: (_args, v: Record<string, unknown>) => [" at plugins/dsh-android-bridge/src/index.ts:1906, actual line: "stderr: { type: 'string' },"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "stdout: { type: 'string' }," at plugins/dsh-android-bridge/src/index.ts:1901, actual line: "type: 'object',"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at app/src/main/java/com/dsharnessmobile/shell/MainActivity.kt:255; expected one of ["private const val WEB_REVEAL_FADE_MS = 140L"], actual: "* 诊断深色底显形给用户看，否则「有界等待」会退化成「停在引导页毫无反馈」。"
[bad-anchor-content] Expected "return () => { marker.detach() }" at dsh-client-ui-responsive/src/client/index.ts:202, actual line: "}, 'ui-responsive: snapshot panel ancestor ownership')"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "fun processIncomingIntent(context: Context, intent: Intent?, notify: (title: String, text: String) -> Unit) {" at app/src/main/java/com/dsharnessmobile/shell/FileIncoming.kt:593, actual line: "fun flushPending(context: Context): Boolean {"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "pending: { type: 'number', required: true }," at plugins/dsh-android-file-open/src/index.ts:717, actual line: "}"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "let ctxLogger: ((scope: string) => { warn?(msg: string): void; info?(msg: string): void }) | undefined" at plugins/dsh-android-file-open/src/index.ts:667, actual line: "continue"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "* review C10：未认领草稿的生命周期收口（PLAN 约束：草稿只在当前进程有效，进程重启后不恢复" at plugins/dsh-android-file-open/src/index.ts:444, actual line: "bytes,"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "try { org.json.JSONObject(body).optBoolean(\"ok\", false) } catch (_: Exception) { false }" at FileIncoming.kt:553, actual line: "} catch (_: Throwable) { false }"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "export function apply(ctx: ClientContext): void {" at dsh-client-ui-responsive/src/client/index.ts:190, actual line: "/**"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "// Android general-settings rows (issue #59): immersive status-bar toggle." at dsh-client-ui-responsive/src/client/index.ts:423, actual line: "order: 95,"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "/** Fetch eligible queue metadata and hydrate each blank-session attachment once. */" at incoming-draft.ts:176, actual line: "constructor("（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at dsh-client-ui-responsive/tests/incoming-draft.spec.ts:174; expected one of ["expect(document.documentElement.getAttribute('data-dsh-incoming-draft-poll')).toBe('exhausted')"], actual: "expect(String(fetchImpl.mock.calls[3]?.[1]?.body)).toContain('removed')"
[bad-anchor-content] Expected "/** 待建判据（R1）：无 sessionId 或**非 durable 形态**（遗留 session-1 条目自愈重建，IX-TW-02）。 */" at plugins/dsh-android-file-open/src/index.ts:515, actual line: "forcedNewSession: true,"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "try { purgeStaleUnclaimed('boot') } catch { /* 清理失败不阻断装配 */ }" at plugins/dsh-android-file-open/src/index.ts:753, actual line: "pending: 0,"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "const cwd = window.androidBridge?.incomingWorkspacePath?.() ??" at incoming-draft.ts:281, actual line: "* 为一条来件新建空白会话（页面侧是唯一建会话的地方；见文件头注）。"（判据是去缩进后的规范化前缀，不是子串包含）
[bad-anchor-content] Expected "private replaying" at dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts:296, actual line: "*/"（判据是去缩进后的规范化前缀，不是子串包含）
[anchor-content-drift] Referenced content changed at MainActivity.kt:519; expected one of [""], actual: "internal fun retryFailedEnginePage(epoch: Long = 0L) {"
```

---

## 17. 最终宿主安全协议与文档续工（task12）

- 需求与目标未降低：页面宿主v2的nonce票据、unknown/recheck/cancel、workspaces.list真源、附件in-flight与动态motion完整契约统一见 [设计§6.5/§9.4](<docs/overlay-refactor-2026-11/design.md>)。PERSISTENT只登记临时生命周期，无新prefs/default变更。
- task12收口时菜单决策历史：后台DOM连续commands-not-ready，批准官方controller.menu/toggleSource/pick/dismiss主路，彼时实现中待核读，51定向/安全fix前全量均不覆盖；**后续落盘与新57输入的最小追加见§18**。此历史记录不覆盖或洗掉前轮边界。
- 25s页面计时只转pending+unknown；原生自动查询每轮30s/100ms退避至1s，超时不回false、不解锁重发。再点击重查原ticket；destroy取消原生观察不是业务撤销。发送在可编辑前置通过后同步detach该批附件ID到in-flight，明确拒绝补missing IDs，unknown保session/附件与锁，不写text/refs。
- 动态motion：编排start订阅/destroy注销，各View attach订阅/detach停止和丢弃旧onEnd；关动画立即终态，召回不得被旧结束回调移窗。
- ReleaseVelocity保VT非0优先；零值补最近100ms rawY/eventTime并保≤200ms前采样，末移动距UP≤80ms，200ms不是降触发阈值。药丸44dp高在y=0的48dp净上推物理不可达，因此**仅顶部药丸二次距离校正16dp**、末速500dp/s、DOWN已贴顶/首拖到顶不消散保持；卡片白条收成药丸仍48dp/500dp/s，不能全局改阈值。慢/短/横向/非顶与反向负控保留。

### 正确依赖与测试证据（overlay-host运行，本docs分工只读核验）

- 最终安全源码：[定向日志](<.deploy-tmp/overlay-host-evidence/page-safety-final.log#L59-L62>) =4文件/51测试PASS；[构建日志](<.deploy-tmp/overlay-host-evidence/page-safety-build.log#L18-L22>) 完成，包含nonce/unknown/workspaces.list/in-flight/generation/fileUploads前置与新增负控。
- 正确依赖经隔离repo-lock npm ci安装，再由本worktree node_modules junction指向overlay-host-deps；session-controller包独立读为0.2.2-rc.1（旧错依赖证据仅属原轮）。本分工未安装/修改依赖。
- 安全fix**之前**的正确依赖全量：[page-full](<.deploy-tmp/overlay-host-evidence/page-full.log#L1699-L1707>) =89文件，88pass/1fail；1256例，1255pass/1fail，唯一custom-provider初态5000ms timeout，exit1。它未含最新7条安全负控，不能当最终安全源码全量。
- 同file单次复验：[timeout-recheck](<.deploy-tmp/overlay-host-evidence/page-full-timeout-recheck.log#L9-L18>) worker fetch超时/no tests，不是绿、不证明噪声，也不删除原失败。最终51定向绿不等于全量绿/设备绿。
- 本轮地图gate与输入摘要落 [独立文档证据目录](<.deploy-tmp/overlay-docs-final/summary.md>)（完成时生成）；本任务不改test-report/test-plan/user-baseline/contrib，不操作设备/Gradle/提交。

---

## 18. 官方菜单服务主路落盘追加（task14，57轮历史保留）

> 本节57轮源码与bundle身份保留为真实历史；最终session.ready有界4s输入及最新58轮产物见§19，勿把本节旧哈希当最新。

- 已独立核读 [公开窄面/withOfficialMenu](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts#L123-L128>) 与 [装配](<dsh-client-ui-responsive/src/client/index.ts#L598-L607>)：目录默认不借后台DOM焦点，读per-session controller.menu；已有人工menu返回busy不抢。使用真实draftRev的[0,0]leading / hit；等待ready最多4s，sid/scope/rev/hit/generation变化即拒绝；finally只dismiss自己hit同generation。candidate canonical name补/作token，label只展示，不硬编码列表。
- 执行主路 [execute](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts#L426-L455>) 等document.visible最多10s后新借官方菜单，再pick(command,index)；V2捕获commandSession后jumpToApp并提示完成后续选项。**ok+handedOff仅表示交给官方UI输入prepare/popup/action/bare-host管道，绝非handler完成/模型任务成功**；无menu的resolveClaim/claim.submit兼容分支保留，其结果不能混作主路最终完成。unknown去重/原票据recheck规则不变。
- overlay-host运行、docs只读核验：正确DSH0.2.2-rc.1/cordis4.1.0下tsc+tsdown exit0；[新定向日志](<.deploy-tmp/overlay-host-evidence/command-discovery/tests-final.log#L72-L75>) =4文件/57测试PASS，[新构建日志](<.deploy-tmp/overlay-host-evidence/command-discovery/build-final.log#L18-L22>) 完成。含官方菜单新守卫/交接输入，不能反向改写旧51轮结论。
- 新 [client bundle](<dsh-client-ui-responsive/lib/client.js>) 已独立算摘要：1,065,807 bytes，SHA-256 `FEA73B8271C3B1C7EE2BEDF2F71009A1DF1CC9D894AE8C128B053B18B6E7574C`。此为本轮构建产物身份，不是已热推/正式快照/最终APK的证明。
- §17的51定向、较早全量1255pass+1timeout、单次复验worker fetch超时/no tests与更旧6fail全部保留。新57定向不等于当前全量绿，**官方菜单新主路设备未验**；完整交互/前台跳转/后续弹层/取消与最终handler结果仍由lead在 [测试报告](<docs/overlay-refactor-2026-11/test-report-phase2.md>) 单一维护。
- task14仅6docs最小追加，未改PERSISTENT、源码/测试/依赖/门禁基线或设备/Gradle/提交。地图最终结果与输入审计见独立 `.deploy-tmp/overlay-menu-docs` 日志。

## 19. Session.ready四秒上界微补（task15，58轮历史保留）

> 本节58轮是当轮有效输入；最新冻结附件P1、页面full和产物身份见§20，旧hash不再作为最新候选。

- 独立核读 [withOfficialMenu](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts#L321-L365>)：SessionReference.ready以Promise.race限4s，超时session-not-ready；finally清readiness timer并release。ready迟到不使旧borrow继续执行，下轮可重新尝试、不cache空目录。**这是session就绪阶段4s，菜单group ready阶段另有独立4s**，不是把两阶段合成4s或改为2500ms中间版。handedOff仅UI管道交接边界不变。
- overlay-host运行、docs只读核验：[readiness-4s-tests](<.deploy-tmp/overlay-host-evidence/command-discovery/readiness-4s-tests.log#L73-L76>) =4文件/58测试PASS；[readiness-4s-build](<.deploy-tmp/overlay-host-evidence/command-discovery/readiness-4s-build.log#L18-L22>) 构建完成，正确依赖tsc/build exit0。旧57、51、原全量失败与no-tests记录全部保留，不合并成当前全量绿。
- 最终 [client bundle](<dsh-client-ui-responsive/lib/client.js>) 独立计算1,066,106 bytes，SHA-256 `1CF7F4E6DE12FFBEDEC61C626DD3885D71F1561BAC6B3665521943B9A25C5552`。2500ms中间版作废，§18旧57轮哈希只作历史；新输入设备未验，热推/安装/功能结果只由lead测试报告记录。
- task15仅相关六文档短句与独立`.deploy-tmp/overlay-ready-docs`审计，未改源码/测试/依赖/门禁基线，不Gradle/设备/提交。最后地图结果见该目录。

## 20. 最终冻结P1统一收口（task20）

### 协议与生命周期

- 原生RPC：strict server-response/rpcId/Boolean result.ok，prompt/cancel Boolean accepted、create非空sessionId才受理；-1/截断/错误类型保UNKNOWN。再次发送只查原requestId的state.queue.rpcId或events user/message source.rpcId，不重发prompt/create；找不到是无正面证据不是拒绝，正面证据也不将旧轮次重亮busy。
- cachedV2在旧/新UI切换中同对象suspend/resume，不destroy/cancelPendingActions，保草稿/model/unknown锁与宿主票据；两轨按session+baseline只在无冲突时导入。真实Service销毁才清RPC回调/缓存。配置/语言UI-only View重建保text/selection/focus/layout/model/generation，Service语言prefs监听+Main setter全入口接线，completionKind按当前语言重译。
- 附件：Proxy/Bus Receipt携sid/request，64项有界，同sid+kind仅重查原request；attachment-pending为未知不重投，removed才明确fail，draft-ready才成功。V2活动sid/已知request过滤，pending挡发送；纯附件空text允许，页面state不在不能误当无附件发文本。MIME resolver/saved、camera明确JPEG、未知octet，不按扩展名猜。
- retainSession.ready4s超时release/下轮可retry；runtime和send reject共用keepDraftReference，将exact Session移交rail keeper，直到rail空或dispose才release。consumer admittedEntries/pendingAcks防ack丢失重复add，插件complete同ticket幂等256；不宣称耐久outbox/exactly-once。
- 官方menu保留此前nonce/ready4s/菜单4s/前台visible/pick守卫，目录只按ATTACHMENT_ROW_TITLES exact name/label去附件重复，file-preview/file-management负控保留，不维护命令表；handedOff仅UI管道交接，不是handler完成。
- ST01门禁旧9/10FAIL保留；task19只修只读Boolean缺桥/上下文未就绪generation重解析、精确engine主target、旧socket迟close隔离和诊断，不强转false/不改原deadline。新mock9/9含真实源码变异负控、mode解析12/12、原self-test正确检出故意FAIL均exit0；设备重跑归lead，不据mock把旧设备FAIL洗绿。

### 已读取的本轮代码层证据

- 最新正确依赖为DSH0.2.2-rc.1/cordis4.1.0（独立读package）；页面/插件由overlay-host运行，本分工只读核验： [页面附件62](<.deploy-tmp/overlay-host-evidence/attachment-final-tests.log#L77-L80>) 4文件62PASS，[file-open32](<.deploy-tmp/overlay-host-evidence/attachment-plugin-tests.log#L33-L40>) 32PASS；[页面构建](<.deploy-tmp/overlay-host-evidence/attachment-final-build.log#L18-L22>) 完成。
- lead实际跑的本轮正确依赖页面**全量**：[page-full-package](<.deploy-tmp/overlay-continue/page-full-package.log#L580-L583>) 89文件/1274测试PASS，命令exit0；输入冻结到本节62附件组。较早57/58/51定向及旧全量失败按各自输入保留，不再说“当前full仍未过”，也不把full页面绿外推Kotlin/设备。
- 最终冻结Kotlin contracts：[日志](<.deploy-tmp/overlay-continue/kotlin-final-contracts.log#L27-L33>) testDebugUnitTest/BUILD SUCCESSFUL，lead在四条源码形态断言处适配当前cachedV2/overlay语义后重跑，没有靠删判据放绿。精确XML总数由lead报告确认，本分工不跑Gradle/不编数字。
- 独立计算最新runtime产物：[页面bundle](<dsh-client-ui-responsive/lib/client.js>) 1,070,391 bytes，SHA-256 `79B2E5CBD44A8224FDEE1E0C8E19876A4B703E882DEDB16530AC6CA4F0B8E101`；[file-open](<plugins/dsh-android-file-open/lib/index.js>) 59,505 bytes，SHA-256 `C42EFA9F608DE5392677CB56795D96346872C7B6B8033B2085B96E4E15683844`。旧FEA7/1CF7等hash是历史，不当最新。
- 本轮debug APK/热推树、实际安装/自主任务/最终三层/性能由lead的 [测试报告](<docs/overlay-refactor-2026-11/test-report-phase2.md>) 单一维护；没有完整发布链，不能发布。真实任务一轮也不代表全部验收通过。task20只7docs+独立日志，不改源码/测试/依赖/门禁baseline，不设备/Gradle/提交。

## 21. 后台无RAF附件与系统取件避让小修（task23）

- 已核读 [后台附件分支](<dsh-client-ui-responsive/src/client/mobile/overlay-host.ts#L525-L580>)：公开serializeDraftAttachments捕获IDs→exact Session.prompt(content,queue,signal,一次fixedUUID)，不等待requestAnimationFrame；literal ok=true且accepted=true才release本批附件。明确ok=false保原code/message并restore/keeper；accepted false/缺字段/调用后transport未知保inflight/锁与原票据，不能重发。旧runtime无公开能力保sendSession fallback。
- 已核读 [取件避让](<app/src/main/java/com/dsharnessmobile/shell/OverlayV2.kt#L989-L1049>)：新取件移card/pill/composer保draft（已pending仅recheck不重复打开），receipt通过活动sid/已知request过滤后，只在待恢复sid相同且非hostForeground/非uiSuspended/未destroyed时恢复card+showComposer(false)。这是源码修复，不是系统Picker真实无遮挡验收已通过。
- lead运行，docs只读核验：[nonvisual定向](<.deploy-tmp/overlay-continue/nonvisual-tests.log#L19-L22>) 4文件66PASS；[构建](<.deploy-tmp/overlay-continue/nonvisual-build.log#L19-L26>) 完成，tsc日志为空无错误，lead确认tsc/build exit0。四新增反证覆盖hidden无RAF、拒图原code/message+附件恢复、accepted非literal真保unknown、调用后transport unknown去重。
- 当前新bundle独立计算 [client.js](<dsh-client-ui-responsive/lib/client.js>) 1,072,548 bytes，SHA-256 `F5644B5A6B8198E98344BF021C8F658581E03E8CDCEADBB41B6BDEA8201594F8`；§20的79B2/hash与全量1274仅属前输入。新full由lead另跑，本节不预填完成，不把66定向套成全量绿/设备已送达。旧FAIL/58/62/1274记录保留。
- 本分工仅相关docs小段与独立日志，不代码/预算/依赖/门禁baseline，不设备/Gradle/提交；设备/Picker/消息最终结果由lead测试报告单一维护。

## 22. 当前集成冻结：F19/真实预览/可见订阅与carrier恢复（task26）

- 当前规范统一见 [设计§6.8](<docs/overlay-refactor-2026-11/design.md>)：Panel strict helper绑定原event/question/sid/agent，多题逐题保存/末题漏答守卫；底部answer与原message草稿隔离，完整form选项/多选/跳过及审批reason/二步保留。F19不再记待实现；lead真实两题English/include-appendix第一题不RPC、第二题tool_result后Agent续跑等设备证据，仅由测试报告维护。
- 图片公开blob→最长边256px/总dataURL≤49152字符JPEG（quality0.7，最多8缓存/2并发、fetch4s），原生校验JPEG/base64/尺寸并40↔160dp实际预览；无图明确预览不可用。composer可见才watchState公共stores订阅→页面100ms console invalidation→Main双engine源门禁→native100ms去抖拉state，hide/suspend/destroy退订无常驻poll。workspace只同sid真state，A/B message snapshot32及event:question64答案隔离。
- 无RAF附件ready4s/serialize8s为调用前边界；真实rc.1 carrierFailure返回ok=false+gateway/internal/cancelled等不是Host明确拒绝，保原operation/fixed request/inflight/锁，operation只读同sid state/events exact request正证（查询wire type/rpcId/literal ok必须精确）。缺证/失败不归还重发；dispose释放ref/restore监听、撤本地observer不证明Host动作取消。Service postRpc也先校验外壳type及本次rpcId精确匹配，mismatch UNKNOWN。
- Pill文案60ms淡出+60ms淡入已落，generation/attach/motion防旧transition；旧2881输入只作历史。当前native结果见下，不用旧数字替代新输入。

### 当前代码层证据（lead运行；docs只读核验）

- [preview-recovery专项](<.deploy-tmp/overlay-continue/preview-recovery-tests.log#L29-L32>) 5文件87PASS，含实际carrierFailure/gateway未知、4s/8s迟到前置、state/events精确正证与dispose反证；[answer-preview构建](<.deploy-tmp/overlay-continue/answer-preview-build.log#L19-L26>) 完成，answer-preview-tsc日志为空，lead确认tsc/build exit0。此轮为lead接管后新输入，不归overlay-host旧62/32轮。
- 当前bundle独立计算 [client.js](<dsh-client-ui-responsive/lib/client.js>) 1,085,381 bytes，SHA-256 `9451B64D9BE8CF02D21E10C3E59A079234AA37267E8671F88ED74089E0D41A59`。旧79B2/F5644/1CF7等属于旧输入；新APK/热推身份由lead测试报告记账，不当正式快照发布证据。
- [kotlin-answer-current](<.deploy-tmp/overlay-continue/kotlin-answer-current.log#L48-L57>) 全量testDebugUnitTest+assembleDebug成功；lead本轮XML核2894 tests/0fail/2skip/284类，本分工未Gradle/未自编数字。已安装的是本地开发APK，非完整发布链不可发布。
- [当前页面full](<.deploy-tmp/overlay-continue/page-full-preview-recovery.log#L675-L682>) 1 suite failed/89 passed（90）：phone-control在vitest-worker fetch阶段超时未加载，不是已运行case断言失败；实际1180case通过，整次仍非全绿。独立 [phone-control-final](<.deploy-tmp/overlay-continue/phone-control-final.log#L30-L33>) 119/119PASS；不能与前次拼成同次full PASS或把加载失败当噪声豁免。
- 最终完整复跑：[page-full-isolated](<.deploy-tmp/overlay-continue/page-full-isolated.log#L601-L604>) 90文件1299测试PASS，720.33s；[退出记录](<.deploy-tmp/overlay-continue/page-full-isolated-exit.json>) exit0。仍fork1无并行、未放宽测试timeout，bundle9451…41A59不变。此前worker-fetch全量失败及独立119记录保历史；最终绿来自这次独立完整运行而非拼接。
- 原失败记录与各旧轮专项/全量均保留；ST01撤权限仍9/10FAIL按原预算不豁免。最终功能/设备/协议矩阵/发布兼容性仅由lead测试报告与test-plan/protocol维护，本任务不改这些scope。
- task26仅相关7docs/独立日志，一次EXEC覆盖/锚点收口；不改源码/依赖/门禁baseline，不设备/Gradle/提交，后续新源码需重验。

## 23. 同DOWN入口与来件安全边界小修（task27）

- 入口用cardVisibleAtDown+outsideClosedCardDownTime==event.downTime裁决延迟tap，outside先收不重开；后续新tap/拖动不受旧DOWN影响。来件4s仅list GET+JSON、complete ACK、receipt GET+JSON；claim/content不广泛race deadline，保持同attempt/retain/ticket接迟到结果，避免丢ticket、二次claim或误removed。
- lead运行、docs只读核验：[kotlin-toggle-race](<.deploy-tmp/overlay-continue/kotlin-toggle-race.log#L47-L56>) 全量单测+assemble SUCCESS，lead核2895/0fail/2skip/284类；[intake-safe专项](<.deploy-tmp/overlay-continue/intake-safe-tests.log#L27-L30>) 4文件85PASS，[构建](<.deploy-tmp/overlay-continue/intake-safe-build.log#L19-L26>) 完成，tsc空日志/lead确认exit0。claim-fetch/json与content-fetch/blob跨4s仍原attempt仅一次attach、同ticket ACK反证已核读，不改业务超时预算求绿。
- [完整页面全量](<.deploy-tmp/overlay-continue/page-full-intake-safe.log#L626-L629>) 91文件1308PASS，920.84s，[退出记录](<.deploy-tmp/overlay-continue/page-full-intake-safe-exit.json>) exit0。新 [bundle](<dsh-client-ui-responsive/lib/client.js>) 独算1,086,557 bytes，SHA-256 `F27C89F193545079EED2CC20464178370F6A2697A0761A84828747354D51F609`；旧9451/1299/87按前输入保留。
- 真实10cycle/10tap/drag与尚未绿的workload帧时、新热推后fresh页面取件证据由lead报告单一维护；代码层绿不提前当新runtime取件成功/发布通过。本轮只design/impl/EXEC/modules小段+校锚，无源码/依赖/设备/Gradle/提交。
