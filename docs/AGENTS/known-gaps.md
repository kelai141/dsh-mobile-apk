# known-gaps.md — 待办与已知缺口（非本轮范围，防再探）

## 8. 待办与已知缺口（非本轮范围，记录防止再探）

- F2「T1 授权豁免自动升级」未落地（电池白名单仅引导 Intent；指数退避仅日志不改调度）——涉及系统策略写面，不自动执行。
- F1.10 引擎更新通道未实现；F0.3 引擎事件桥未实现。
- 子代理 PRD 评审完整清单见协调仓库 `docs/review-0.13.0-20260823.md §九` 与 `.deploy-tmp/prd-gap-review.md`（U4/U5、A4/A6/A8、B4/B5/B7、F4、P4 未修项）。
- **~~扫描/图片版 PDF → 页图渲染受限~~（0.13.1 已修，0.13.0 记录作废）**：原记录「`@napi-rs/canvas` 仅 glibc 预编译装不上」系**误判**——npm 有 `@napi-rs/canvas-android-arm64`（N-API/Bionic 预编译，os=android cpu=arm64，真机 createCanvas 实测可用）。0.13.1 起随出厂快照装配（profiles/web package.json 登记 + tarball 解入，仅 arm64；npm 无 android-x86_64 triple，x86_64 模拟器维持守卫降级）。构建脚本 7c2 段。
- **marketplace 惰性加载决策（0.13.0 D4）**：cordis 装配层无惰性概念；拆装配违反 F4「内置市场」。启动速度优化由 D2（快照瘦身）+ D3（NODE_COMPILE_CACHE）承担，marketplace 保持启动装配。
- **provider 命名混淆（0.13.0 C3 实锤）**：默认 pin 曾为 `opencode-go`（OpenCode Zen Go 网关，`opencode.ai/zen/go/v1`，实测 404）——用户误以为配了 OpenRouter。0.13.0 默认 pin 改 `deepseek-official`（壳注 DEEPSEEK_API_KEY），opencode-go/OpenRouter 需在「添加自定义供应商」显式配置；设置页文案与文档需持续提醒区分。

---

## 无障碍通道待办（0.13.5 W4 未完项，2026-09-14 对账）

- **无障碍输入法**（API 33+，`FLAG_INPUT_METHOD_EDITOR` + `InputMethod`）：**【已核实不可行】**——javap 校验 android-36 的 `android.jar`，`AccessibilityNodeInfo` 无相关符号（见下方 0.13.8 批 F 登记）；非编辑节点中文输入继续由 `ACTION_SET_TEXT` + ADBKeyboard 承担。
- **`getSystemActions()` 驱动全局动作面**：**【0.13.8 E6 已落地】**——由系统动作集合驱动（核心 back/home/recents/notifications 恒放行），见 `GlobalActionCatalog.kt`。
- **节点动作面**：**【部分落地】**长按（`ACTION_LONG_CLICK`/`ACTION_PRESS_AND_HOLD`）已接；展开折叠/复制粘贴/翻页/拖拽仍未暴露为工具参数。
- **单窗口截屏**（API 34 `takeScreenshotOfWindow`）与多窗口选择（`getWindows()`）未接。
- **API <30 设备**：**【已回落】**0.13.8 E6 起无障碍截屏失败自动回落 ADB `screencap`；回落分支的真实触发设备验证仍未做（本机 API 35 无障碍截屏可用）。
- **arm64 真机验证**：0.13.6 曾完成 V2425A 链路验证；0.13.7fx-1 之后各版发布说明均标注「arm64 真机待验」，0.14.0-preview 同样待补。

## 0.14.0 收尾登记（2026-09-14，发布后工作区）

- **BrowserHost 与浏览器控制面：工作区已实现、未设备回归**：壳侧 `BrowserHost`（隔离 WebView + 拒绝面 + 视口 letterbox）与六条桥 op、面板视口下拉已就绪；`plugins/dsh-android-browser` 的 17 条工具契约与 `tools.ts` 实现（open/snapshot/click/type/press/scroll/get_text/wait/navigate/back/forward/reload/tabs/identity/viewport/screenshot/tier）已在工作区落地——**但 0.14.0-preview 发布时壳侧宿主未落地（面板只读），工作区代码未过设备端到端回归**；页代次/旧 ref 拒绝、截图权限与身份切换的设备验收待补。
- **虚拟屏多屏能力：工作区已实现、未设备回归**：壳侧已含实时 display registry（stable alias + 动态 displayId）、controller 自有选择目标、每查看器独立 bounds、查看器仲裁（同一 Surface 不能挂两个查看器，冲突返回 `viewer-target-occupied`）、`MAX_VIRTUAL_DISPLAYS=1`（0.14.0 发布提交起就是 1；旧文档写 2 是漂移）；面板已渲染「呈现目标」下拉（调 `vdisplaySelect`）。**发布版（0.14.0-preview）不含这些；工作区的 viewer 接管/重挂、双查看器冲突、横竖屏几何与截图仍未过设备回归。** 真实屏明确不可镜像（`screen-not-selectable`）。
- **Shizuku 完整特权体验未收口**：UserService/AIDL v1 与固定 argv 执行已落地、建屏/launch/back 探针设备通过；「无障碍关闭时 Shizuku 提供完整特权体验」（U-4）仍缺工具面改名/能力迁移与设备矩阵；ADB 配对页仍作为迁移/诊断面保留，未按 U-4 退役。
- **开放屏幕范围**：native 真源与执行点复查已落地；`virtual-only` 下真实屏观察面（含无障碍直连队列）的完整设备矩阵未跑。
- **按需 skill 注入（U-5）未实施**：控制流程仍会进入常驻上下文/schema 的部分未清点，token 预算门禁未做。
- **Shizuku 许可登记缺口**：gradle aar 依赖不在 `check-third-party.mjs` 的 dpkg 矩阵覆盖内，`assets/licenses/THIRD_PARTY_NOTICES.md` 无 Shizuku 条目（Apache-2.0）——发版合规需补。
- **性能 A1 结论未定**：`check-perf-instrumentation` 的 P-AC-01 要求出厂值 `patchReload: startup`，但 0.14.0 设备 A/B 观测 `live` 组中位约 12.5-13.0s 快于 `startup` 组 14.6-15.0s（n 小、compose 探针缺失、单机型）——方向与方案主张相反，需 owner 拍板是锁正确性语义还是改基线（见 `docs/0.14.0-preview-VERIFICATION-LOG.md` §50）。
- **单 ABI 静默交付**：0.13.8-b 实测「某 ABI 被拒后链路仍 exit 0」已由 `check-build-chain-abort.mjs` 拦下（坑 94），门禁已入 17 项集合。

## 0.13.8 收尾新增登记（2026-09-12 晚）

- **滚动条未吸附到最右侧（布局边界不匹配）**：用户真机反馈——滚动条与容器右边界之间有缝，
  没有贴在屏/面板最右（与 apk #197 的布局视口/边界同族，但独立现象，本轮未修）。待定位：
  ① WebView 右侧是否残留 padding 或系统手势区（壳侧 `setPadding` 目前只动 bottom）；
  ② 页面侧滚动容器的 `scrollbar-gutter`/`padding-right`/`max-width` 与
  `--dsh-mobile-popup-max-width` 等钳制变量是否把滚动条挤离边界（`composer-menu.css.ts` 的
  viewport 宽度钳制是重点嫌疑）；③ 移动形态下轨道宽度是否被 `ComposerPopupGuard` 按 CSS 宽度
  而非内容盒计算。定位方法：设备上量 `scrollContainer.getBoundingClientRect().right` 与
  `innerWidth`，以及 `getComputedStyle(el).scrollbarGutter / paddingRight`——先取数再改。
- **悬浮球动效手感（M4-M8）**：时长/幅度未经人眼走查（静态截图断言不了），发布前真机确认一次。
- **`KeyboardBoundary` 机制①的最终形态**：壳侧已把 IME inset 施加到 WebView 布局尺寸，
  页面侧的 `visualViewport.offsetTop` 补偿因此**刻意没有实现**（按 #197 建议修法 1，机制①
  从根上消失后该补偿即冗余）。若真机仍见残留平移，再补页面侧补偿——届时它是第二道防线而非主修。

## 0.13.8 批 F 收尾登记（2026-09-12）

- **API 33+「无障碍输入法」（E6d）无法实现**：`javap` 校验 android-36 的 `android.jar`，
  `AccessibilityNodeInfo` 无 `INPUT_METHOD_EDITOR` 相关符号，设计文档设想的路径在当前 SDK
  上不存在。`ACTION_SET_TEXT` 不被接受的场景由 ADB-IME 通道（`AdbKeyboardService`）承担。
- **截图回落 ADB 的触发路径未在设备上跑通**：本机 API 35 无障碍截屏可用，回落分支只能在
  API<30 设备上真实触发（ADB `screencap` 本身已多次实测）。
- **profile patch 合并语义「按 id 只增不删」**（坑 70）：我们注入的 row 一旦写进设备
  `home/.dsh/profiles/web/cordis.patch.yml` 就**删不掉**（改代码 + 重装 + 重解压都不生效）。
  影响：0.13.8 之后若要下线已注入 row，需要在 `SnapshotTransaction.mergePatchYamlById` 上给
  「上游注入行以 staged 为准」留口子（当前无标记区分「我们注入的」与「用户手改的」，
  实现前先设计标记方式，勿草率改成覆盖语义——那会吃掉用户手改）。
- **悬浮球动效 M4–M8 未做**（G3 余项）：待答卡位移渐隐 / 状态行 TextSwitcher / 琥珀呼吸 /
  PENDING 脉冲。M1/M2/M9/M10/M11 与降级门（`DsUi.animationsEnabled`）已在 #191 落地。

## 0.14.1 undo 链（2026-09-19）

- **`UndoGate.clearMarker` / `armedToDisplay` 仍是死代码（本轮只登记不修）**：两函数在全仓
  **零调用点**（`clearMarker` 仅自身定义，`armedToDisplay` 同），与 `UndoGate.kt` 类注释声称的
  「用户手动重试/手动 undo 后清除标记」及「供启动页显示」两处文档不符。实际只有 `disarm`
  （被 `EngineService` 在 IDLE 时调用）会删 `.undo-auto-armed`，而 `.undo-auto-done` marker
  **永不被清**——于是「上次自动 undo 成功」在 `RETRY_WINDOW_MS`（30 分钟）内持续压制后续崩溃纪元
  的自动回撤。**未修的真实原因**：清除时机是一个产品判断（哪些用户动作算「新的崩溃纪元」），
  仓促接线会把「用户刚修好又立刻崩溃」误判成旧纪元而拒绝自救，风险高于收益。
  最小落点：把 `clearMarker` 接在「用户显式重启引擎」（`EngineStartFlow.restart`）与
  「引擎健康确认跨越 N 拍」两处，并为其补一条能判红的单测。
- **0.14.1 已修的同类缺陷（留档对照）**：`WatchdogV2.planTick` 的熔断锁存盲区——`tripped()` 曾排在
  `undoReady()` 之前且一旦为真即永久 HOLD，而熔断在 60s 打开、托管子进程启动预算却是 90s，导致
  「子进程存活但 HTTP 永不健康」时 undo 与 restart 双双永久失效。修法 = undo 提到熔断之前
  + undo 成功路径补 `WatchdogV2.reset()`；防线见 `WatchdogLadderTest` 三个新用例与
  `UndoGateDecisionTest`。真因见坑 153。

## 0.14.1 预览轮登记（2026-09-19，T6）

- **[已闭合，2026-09-19 设备实测] `t_compose_total` 产品口径**：原文（本轮早些时候）称「出厂件上
  `t_compose_total` 仍会是 -1」——**该状态已被设备推翻**。引擎侧落点选了「产品内探针」形态：
  新增引擎树补丁 `combo-probe-P1`（`scripts/patches/apply-patches.mjs`）在 `dsh-client-modules` 的
  `compose()` 返回处直接打印 `[perf] compose #N at=… dur=…` / `[perf] TOTAL calls=… totalMs=… …
  loopP99Ms=… loopSamples=…`（只主线程安装，worker 不得冒充；不新增快照成员），壳侧解析器**零改动**
  （口径早已兼容）。设备（MuMu x86_64 / API 35 / 出厂树 + A5/C3/P1 补丁）实测：
  ```
  engine.log:            [perf] TOTAL calls=1 totalMs=1024 instances=1 firstAt=2079ms singles=0 loopP99Ms=37.0 loopSamples=55 comboCache=loaded hits=56 misses=0
  boot-segments.log:     t_compose_total=1024 t_compose_source=preload-total   ← 非 -1
  ```
  `t_compose_source` 的合法取值与含义：`preload-total` = 引擎产品内探针已落 TOTAL（本轮形态）；
  `none` = 该 boot 尚未收到 TOTAL（通常为 boot-start / listen 阶段的行，属正常中间态，**不是缺陷**）。
  - **仍缺席**：可用的**测量用 preload 发行路径**（`scripts/perf/count-compose.mjs` 仍不进快照）——
    已**不再需要**：产品内探针取代了它的发行角色，preload 仅用于设备取证时的对照。
  - **仍未闭合**：C4 的目标口径。产品内探针报的是**冷启动窗口内**的 `monitorEventLoopDelay()` p99
    （设备实测 37.0 / 56.2 / 61.6 / 77.1 ms，样本 25~92），**不是稳态 p99**；「稳态 <50ms」这条
    既有口径目前**没有任何探针在测**，见 `docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md` §6。
- **块L 页面侧字段（pendingEntries / failedEntries / graphLoaded / waitingForMs 等）本轮未做**：
  其取数面在 `dsh-host-web-compat/lib/index.js` 的 `BOOT_WATCHDOG_SCRIPT`（注入层，本仓可改）
  与页面侧 `BootPage.states`（上游 dist，需构建链降级），**属别的写面**。本轮壳侧只交付
  「落盘 + 不可得时显式标注」，故详情档 §6.2 建议字段中的页面侧部分仍缺席。
  最小落点：把逐条 fiber 状态由页面侧**主动发布到一个全局**（一个赋值语句），诊断脚本只读；
  全局缺失时必须输出「页面侧状态不可得」而不是空数组（空数组正是本次误导的根源）。
- **NSC 明文放行未收敛到私有网段**（0.14.1 块K）：`base-config cleartextTrafficPermitted="true"`
  是全域明文。Android NSC 的 `<domain>` 不支持 CIDR/前缀，无法用静态 XML 表达「192.168.0.0/16」，
  故按用户裁定取全域撑开；若将来要收敛，需**设置页显式开关 + 安全提示**（详档 §3.2 F6 的建议形态），
  或改用运行时 `NetworkSecurityPolicy` 无法覆盖的方案——属未做项。

## 0.14.1 块G F6 收口状态（2026-09-19，T6）

- **已收口（三层都落地，各有反证）**：
  1. 桥侧范围门禁接受「已注册虚拟屏的 SurfaceFlinger token」（`screen-scope.ts` 的
     `adbCommandDisplayTokens` / `screenTokensFromSfDump` + `index.ts` 的 `registeredVirtualScreens` /
     `shellSfVirtualDisplayTokens`）。真因与设备读数见坑 147。
  2. 壳侧执行点门禁（F5，`ShellOps.targetsRegisteredVirtualScreen`）同样接受 token——否则桥侧放行后
     会被壳侧二次拦死（F5 的由来）。
  3. manage 的 ADB 回落路径（`android_screenshot`）已**真正消费**反查：虚拟屏目标先 `resolveVirtualDisplayToken`
     拿 SF token 再 `screencap -d <token>`；反查失败**fail-closed**（不回 displayId、不回真实屏）。
- **a11y 路线的定性已更正（2026-09-19 收口轮，设备实测）**：原记「对虚拟屏**不可用**」——该结论
  **只对当时（0.14.0 装机版、F1 未修）成立**，真因是**范围门按 op 名/real 一刀切**（screen-blind），
  不是 a11y 能力缺失。F1（`bridge/index.ts:832-838` 按 `args.screenId` 经 `screenAccessResolved` 判定）
  之后，virtual-only 下指虚拟屏的 a11y op 不再被门拒。当日设备实测（MuMu x86_64 / API 35，
  虚拟屏 active、a11y 服务 bound）：
  - `dumpsys window windows` → `WindowsForAccessibilityObserver{mDisplayId=10, mInitialized=true}`
  - `uiautomator dump --display 10` → 1916 B 真实节点表（可解析、非空）
  即 **a11y 通道对虚拟屏可达**；原「不可用」判读作废（原文与更正见坑 152）。
  - **仍未确证**：`takeScreenshot(displayId≠0)` 对**应用自建 private display** 是否成功（详档 §6 U5），
    需引擎工具面端到端调用定性。故 **ADB 回落仍是已验证可用的承重路径**，上面的 SF token 修法不是兜底。
  - 注意：上面「不可用」的原始读数取自 0.14.0 装机版（无本轮改动）。
- **仍未做的一项（如实登记）**：`android_screenshot {screenId:"virtual-1"}` 在**装机版上**的
  端到端出图**未验收**——本轮改动未打包装机（禁 gradle/打包）。已完成的替代证据：
  - 用**真实构建产物** `lib/vd-shot.js` 解析设备真实 `dumpsys SurfaceFlinger` 输出 →
    得到 token `11529215047793762666`（字符串，超 2^53 与 2^63-1）→ 真机执行
    `screencap -d <token>` → **成功 5,815 B PNG，675x1200**（虚拟屏像素，3 种 RGB、非全黑）；
    同期 `screencap -p` 真实屏 = 189,141 B / **900x1600**（256 种 RGB）；同期
    `screencap -d 7`（该世代 DisplayManager displayId）→ `Status: -2`、无文件。
  - 三段式子路径（桥侧门禁 / 壳侧 F5 / manage 反查+回落）各有单测，且都做过**改前判红**。
  - 装机后最小复验：调 `android_screenshot {screenId:"virtual-1"}`，断言返回 675x1200 级别像素、
    非真实屏画面（与真机 900x1600 对照）、非全黑。

## 0.14.1 审查轮登记的缺口（承接 `docs/COMPAT-REVIEW-0.14.0-2026-09-19.md`，进度见协调仓 `0.14.1-REVIEW-CHECKLIST-PROGRESS.md`）

| # | 缺口 | 现状 |
|---|---|---|
| K-A | **侧栏浏览器自动落位的时机洞**：`browser-auto-place.ts` 的 `tick()` 在「首次观测到某 owner 且已有页面」时只建基线就 return（`seenEmpty` 守卫）；若 `browserCaps` 与 `browser_open` 落在同一拍 1s 轮询内，该页**永远不会注册成侧栏 tab** | 未修。修法：壳侧 `status()` 增页面创建时间戳（如 `lastPageAtMs`），前端按 `pageCreatedAt > UI 加载时刻` 判真实边沿，替代近似守卫 |
| K-B | **A3 悬浮窗背景启动限制在多 ROM 上未复核**（0.14.1 块 H 自述残留） | 需多 ROM 真机各跑一次（权限缺失/开关关闭/无虚拟屏三种 fail-closed 形态） |
| K-C | **块 J① FIX-3「双起点验收」设备级证据缺**：`files/notify-responder.log` 的 `result=` 判据此前读错文件（真因已修），修后需再装机复验 | 未复验 |
| K-D | **execAdbLine 档位门的会话来源依赖工具入口绑定**（0.14.1 S-5 引入）：会话经 `guard()` 的 AsyncLocalStorage 绑定传递；若将来出现不经工具入口的后台调用路径，会被 fail-closed 拒（预期行为，但需要一条测试钉住） | 已在审查进度文档 §3.4 登记 |
