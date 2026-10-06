# known-gaps.md — 当前缺口、外部待验与历史记录

## 0.14.3 当前交接（源码已登记；**开发方已构建 + 代码层已验，设备三层验收未做**）

用户当前停止点为#308正常GitHub CI/review合并、完整0.14.3同步、arm64/x86_64 tester APK交付。外部tests/typecheck/门禁反证/CDP/ADB由用户另行安排，本source/doc任务未执行；“待外测”不作为暂停合并的占位阻塞，但也不等于安全、功能、三层或发布验收通过。开发方侧本轮**已构建**（`build-apk-013.ps1 -Suffix ""` exit 0，双 ABI 全链 49 条门禁 PASSED / 0 FAILED）、**代码层已跑**（Kotlin 965 项通过，含 #309 的 19 例）并产出 tester APK 与 SHA256（见 `docs/0.14.3-TEST-REQUIREMENTS.md` §8）。**三层设备验收（代码/CDP/ADB 用户层）明确未做**，由外部测试人员执行；CI/review 与本地构建都不能替代它。发布未授权。

| 项 | 当前源码事实 | 剩余职责 / 外部证据 |
|---|---|---|
| Root授权/属主维护 | 有效versionCode consent、无未知命令重放、held-FD core/helper、v4 configuration、Context公平fence、耐久RootMaintenanceLease、per-lease honest pending已在场 | 真UID0/工作资料、commit失败、同boot应用restart保留UNKNOWN、同方案真boot解除、Binder/late acknowledgement与副作用计数待外验；不以kill su或手工清lease作结算。 |
| ProcIo/capture | waiter外独立cleanup、不可变partial、私有.part仅完整publish、每transfer chunk复查consent | 新settlement/wiring fixtures已写未执行；真实descendant持管道/read/close阻塞与不完整spool待外验。 |
| #304配置迁移 | marker保留/抑factory seed、活web patch导入导出及共享密钥警告、旧blank factory quarantine | 连续冷启动/换树/rollback/中断保留用户provider与key用假配置外验；legacy ConfigTransfer未挂载，SAF controller仍在用。 |
| #305内嵌SHA | SnapshotFingerprintPolicy严格64hex，缺/坏metadata拒refresh/spawn，无legacy/degraded旁路 | 最终包hash/ABI与事务恢复外验；不是仅有源码就已证明快照不匹配被正确打包拒绝。 |
| #306与startup | quiet foreground retry/recreate、holder重绑、userClosed保持；CAS flow generation、ServiceEpoch/wakeowner、finite6次2/4/8/16/30/30秒pending retry | 新policy/wiring/startup fixtures未执行；后台真实任务不中断、陈旧caller无后续effects、重复renderer crash不loop待外验。 |
| 官方浏览器UI | 私有MIT source + neutral native adapter、真实tab-menu，捕获Session/tab与model/UI焦点分离；nonDefault profile先验证后load | 父任务目标0.2组件lib重建/完整自包含镜像；多会话多tab、HMR hide-only、HTTP/loopback cookie/storage/worker隔离及provider不支持拒绝待外验。不回Default；limited clear不保证全浏览数据擦除。 |
| Windows身份 | UA/JS/UA-CH的Windows映射在native源中已改，按provider能力诚实回执 | 实际请求头/脚本/站点行为待外验，不称已测PC身份。 |
| PTC A1 / pi streaming020 | 双文件PTC与六provider官方exact SHA/context在registry/runner/source copy reconciliation已接 | 普通snapshot post-apply已接统一runner --check多目标/exact verifier；父任务仍须目标原始产物重出runtime assets、组件lib/镜像与双ABI终包对账。 |
| #288 快照管理面板 | 插槽包装层识别与标题行包含约束已修，真实结构单测和离线浏览器反证通过；真因与证据见 `gotchas.md` 坑 239 | 用户本轮选择 APK 与离线证据，华为 SGT-AL10/CDP/ADB 三层设备验收未做。 |
| #297及历史缺口 | 按当前真实可达面核实；不把用户授权HTTP当漏洞、不用旧head证据虚关issue | 按各自真实输入与设备证据复核。 |
| #309 运行时树残缺无恢复路径（闸门 A/B 互锁） | **本轮已修**（源码级，未构建/未外验）。修前复核属实：`EngineManager.liveRuntimeComplete()`（`EngineManager.kt:489`）在 spawn 前拒启，且位置先于 `force`/可用性判定；拒启路径只写 boot-fail + `maybeAutoUndo`（不碰 `usr/`）+ `scheduleEngineRetry`；全仓 `refreshSnapshot` 调用点仅冷启动一处（`EngineStartFlow.kt:586`），拒启路径为零。闸门 B 判据取自当拍 `engine.log` 尾部，而不 spawn 就永不产生该日志 ⇒ 自愈不可达。 | **修法与取舍**：闸门 A 拒启路径现在会（① 先取证 → ② 写损坏标记 → ③ 删指纹 → ④ 清账本 → ⑤ 取诊断镜像 → ⑥ 如实写 boot-fail）让下一次冷启动走完整重抽取。**两道闸门**：预算复用 `runtimeTreeHealedThisRun`（每次运行一次，不新增变量，无重抽取死循环）；证据分级只用「快照自身条目」（`RuntimeTree.START_RECOVERY_CONFIRMED_ENTRIES`）触发——`REQUIRED_LIBS` 成员**刻意不触发**，因为 issue 原文告诫「不要贸然补全该表」（它是传递依赖假阴性来源），自动放宽等于每次启动白付一次 8-12 分钟全量抽取并抹掉现场。用户显式出口：错误页主按钮（Error 相位 =「安全模式启动」）在上一次拒启确为 live 残缺时**强制**重做一次（放行分级、**不放**预算）。**修前** `refreshSnapshot` 调用点仅冷启动一处、拒启路径为零；**修后**仍不新增调用点（改走「删指纹让既有的 `!snapshotFresh()` 分支生效」），与 #240 降级闸门不冲突（live 仍不完整 ⇒ `shouldDegrade` 返回 false）。**不改闸门 A 判据本身**：带病的树仍不被 spawn。 | **剩余职责 / 外部证据**：`Issue309StartRecoveryTest`（13 例，含反证：只有低置信度条目时不得花掉重抽取；证据分级/预算/顺序/文案如实性各有断言）本轮已跑 exit 0，且在注入两处变异后**必失败**（实测 2 failed，已还原）——这是**代码层**证据，不是设备验收。待外验：真机/模拟器上人为删 `files/usr/bin/node` 或 `profiles/web` 后冷启动，观察 `.snapshot-fingerprint` 是否消失、boot-fail 是否出现 `live-runtime-incomplete-recovery`、以及重抽取后引擎是否恢复；以及「只删一个 `usr/lib` 符号链接（低置信度）」时自动路径**不动**、点错误页主按钮后才重做。 |
| #309 残留面：看门狗路径无恢复出口（**本轮未修，已知缺口**） | 第三轮独立评审实测确认：`EngineService.kt:281`（自动回撤成功后重启）与 `:319`（看门狗 RESTART 拍）**直接调 `engineManager.startEngine()`**，不经过 `EngineStartFlow` 的拒启分支，因此该路径下闸门 A 拒启后**没有**「删指纹 + 清账本」的恢复动作，也没有任何用户可见出口（服务静默重试）。 | **为什么本轮不改**：看门狗运行在服务上下文里，没有 `MainActivity` 实例，而恢复动作当前签名要 `Activity`（`filesDir`/`writeBootFail`/诊断镜像）。把它下沉成不依赖 Activity 的形式（用 Application Context + 服务侧落盘）是有意义但**独立**的改动面：涉及 boot-fail 写入路径、诊断镜像、以及「服务与 Activity 会不会同时花掉同一次预算」的并发口径，属安全敏感面（预算/快照事务），不应与 #309 的主体修复混在同一轮里顺手改。**影响评估**：只在「用户从不打开 App、纯靠前台服务自愈」这一条路径上成立；一旦用户打开 App（issue 现场的形态就是停在引导页错误页），Activity 路径即恢复出口。**待办**：把恢复动作的 Activity 依赖去掉后在看门狗 RESTART 分支接同一入口（含「同一次预算不得被两条路径各花一次」的判据）。 |
| got@14.6.6 引擎运行时依赖（本轮已修） | 上游 0.2.0-rc.2 的 `otel` 是 enabled 基础服务，其 `lib/index.js` 顶部静态 import `got`；旧快照 1128 个 `package.json` 且不含 `got` ⇒ boot 期 `ERR_MODULE_NOT_FOUND`。已登记进 `engine-overlay.json` 的 `packages` 并重建双 ABI 快照（arm64 1134 个）。 | 双 ABI `check-engine-overlay.mjs` 现 412 条断言全绿（本会话实测 exit 0）。设备侧仍需外验 `otel` 行确实挂载且启动不崩。 |
| 客户端插件装配失败自愈（**本轮新增，源码级 + 代码层已验，设备三层验收未做**） | 页面侧 `publishBootFailure()` 发布 `[dsh-boot-failed]` 契约行（判据：启动页仍在场且容器内有失败投影，幂等），`publishReady()` 判据改为 `rendered() && !bootPagePresent()`；壳侧 `LogCollector` 前缀识别 + `failedIds` 纯解析、`EngineStartFlow` 落盘 + 独立 latch + 一次性回滚编排、`UndoGate.onClientPluginTreeFailure` 一次性入口、`PluginMounts.clientPullCandidate/pullByClientIds` 唯一点名外科拔除。全链有界：一次一轮只自动回滚一次，且受 `RETRY_WINDOW_MS`（30 分钟）约束。 | 判据见 `.deploy-tmp/client-plugin-fail/CONTRACT.md` §8；代码层证据 = 新增 `ClientPluginFailRouteTest`（22 例）与 `ClientRollbackGateTest`（21 例）+ 全量 JVM 1056 tests / 0 failures / 2 skipped；设备侧套件 `scripts/verify-client-plugin-fail-recovery.mjs`（8 条判据，缺证据一律 INCONCLUSIVE）**本轮未跑**，属待外验。 |
| 缺口（本轮如实登记）：自有插件（硬清单成员）在浏览器侧装配失败 | 外科拔除被安全规则拒绝（硬清单保护），配置回滚也修不了代码本身。 | 停在错误页 + 安全模式 + 诊断包，**不假装能自愈**；不给这条造自动出口。 |
| 缺口（本轮如实登记）：注入层自身未加载 | 连契约行都发不出来（`host-web-compat.apply()` 的 `assertInjectionsParse` 失败即抛，脚本根本没注入）时，壳侧仍只有上游 `console.error` 落 `source=console-error`，**不做动作**。 | 属既有块L 面（坑 61 族）；本轮不新增判据。 |
| 缺口（本轮如实登记）：隔离 BrowserHost 页面内的插件失败 | 不在本契约内——本轮只覆盖主 WebView。 | 隔离页无桥、不走 `onConsoleMessage` 的同一路由，需要单独设计（未排期）。 |
| 缺口（本轮如实登记）：WebView 内核过旧导致的 polyfill 缺口（坑 61 族） | 回滚对这类失败无效（要修的是注入脚本对新内核的可解析性，不是插件清单）。 | 属另一条线（`dsh-host-web-compat/scripts/smoke-injections.mjs` 防线③ 目前红，见执行地图 S01 可疑点）。 |

完整限制见 [Root维护](<dsh-mobile-apk/docs/AGENTS/ROOT-MAINTENANCE.md>)；逐项外验见 [测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>)。以下历史章节保留其当时版本/设备证据，不作为0.14.3现状或新head验收。

## 8. 历史待办与缺口（需结合当前源码复核）

- F2「T1 授权豁免自动升级」未落地（电池白名单仅引导 Intent；指数退避仅日志不改调度）——涉及系统策略写面，不自动执行。
- F1.10 引擎在线更新为既存待办；F0.3事件桥已在0.13.x落地，不再登记为未实现。
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

- **BrowserHost 与浏览器控制面：工作区已实现、已多轮设备回归**（2026-09-25 更正，PLAN §4 G-6 第 4 条：原写「未设备回归」与 `docs/CHANGELOG.md` 的 09-15~09-19 多轮全绿记录相矛盾；真正的未闭项是 `EXECUTION-MAP §3.1` 那 10 条高危表里判「已确认、未修」的面，不是「没回归过」）：壳侧 `BrowserHost`（隔离 WebView + 拒绝面 + 视口 letterbox）与六条桥 op、面板视口下拉已就绪；`plugins/dsh-android-browser` 的 17 条工具契约与 `tools.ts` 实现（open/snapshot/click/type/press/scroll/get_text/wait/navigate/back/forward/reload/tabs/identity/viewport/screenshot/tier）已在工作区落地——**但 0.14.0-preview 发布时壳侧宿主未落地（面板只读），工作区代码未过设备端到端回归**；页代次/旧 ref 拒绝、截图权限与身份切换的设备验收待补。
- **虚拟屏多屏能力：工作区已实现、未设备回归**：壳侧已含实时 display registry（stable alias + 动态 displayId）、controller 自有选择目标、每查看器独立 bounds、查看器仲裁（同一 Surface 不能挂两个查看器，冲突返回 `viewer-target-occupied`）、`MAX_VIRTUAL_DISPLAYS=1`（0.14.0 发布提交起就是 1；旧文档写 2 是漂移）；面板已渲染「呈现目标」下拉（调 `vdisplaySelect`）。**发布版（0.14.0-preview）不含这些；工作区的 viewer 接管/重挂、双查看器冲突、横竖屏几何与截图仍未过设备回归。** 真实屏明确不可镜像（`screen-not-selectable`）。
- **Shizuku 完整特权体验未收口**：UserService/AIDL v1 与固定 argv 执行已落地、建屏/launch/back 探针设备通过；「无障碍关闭时 Shizuku 提供完整特权体验」（U-4）仍缺工具面改名/能力迁移与设备矩阵；ADB 配对页仍作为迁移/诊断面保留，未按 U-4 退役。
  **2026-09-19 设备实测更正**：本条登记的「设备矩阵」已由用户手工跑出，结论不是「未测」而是**确已损坏**——
  工具面 `android_capabilities` 在冷启动后报「Shizuku 未就绪」而壳侧实测已授权（模型据此放弃可用能力），
  且 `android_privilege_status` 把 Shizuku 结论挂在 `ADB 提示：` 标签下。根因与落点见协调仓
  `docs/0.14.1-preview-DEVICE-DEFECT-TRIAGE-AND-TEST-REFLECTION.md` §2（A1/A2）。
- **开放屏幕范围**：native 真源与执行点复查已落地；`virtual-only` 下真实屏观察面（含无障碍直连队列）的完整设备矩阵未跑。
  **2026-09-19 设备实测更正**：矩阵已跑，**`virtual-only` 下的工具可用性是坏的**——
  `android_act_input` 声明的 `screenId` 永远无法兑现（`input <verb>` 无屏幕维度，范围门在
  `bridge/src/index.ts:710` 早退恒拒）；`android_ui_tree` 因 `uiautomator` 家族被断言「无目标屏参数」而恒拒
  （与本仓 `:127` 的设备读数冲突）；`android_ui_click` 生效校验不带屏、在 virtual-only 下必然报
  `screen-out-of-scope`（根因是引擎/壳侧两份真实屏 op 清单不一致）；指引承诺的 `android_vdisplay_input`
  从未实现；`android_app_launch {screenId}` 无落点回读，会报成功而应用落在真实屏。
  根因、方案与新增门禁清单见协调仓同名文档 §3/§4/§6/§7。
- **按需 skill 注入（U-5）未实施**：控制流程仍会进入常驻上下文/schema 的部分未清点，token 预算门禁未做。
- **Gradle AAR/JAR 许可产物复核待完成**：源码现已为 Shizuku API/provider 13.1.5 登记 MIT、为 SnakeYAML 2.4 登记 Apache-2.0，并补齐 `LICENSES/` 文本；构建链会复制这些文件到 APK `assets/licenses/`，但修复候选 APK 尚未构建，发版前仍须从终包抽取核对 notices 与许可证全文。
- **性能 A1 结论未定**：`check-perf-instrumentation` 的 P-AC-01 要求出厂值 `patchReload: startup`，但 0.14.0 设备 A/B 观测 `live` 组中位约 12.5-13.0s 快于 `startup` 组 14.6-15.0s（n 小、compose 探针缺失、单机型）——方向与方案主张相反，需 owner 拍板是锁正确性语义还是改基线（见 `docs/0.14.0-preview-VERIFICATION-LOG.md` §50）。
- **`combo-lazy-A4` 退役后的设备侧复验未做（2026-09-25）**：补丁已从 registry/IMPLS 移除、P1 的 `requires` 已清空，静态门禁与 17 个补丁回归全绿；但「撤 A4 后裸树启动期 2 次 compose」这一结论目前只有**离线同基线 A/B** 证据（`.deploy-tmp/retire-sweep/REPORT.md` §3.1.2）。设备侧需补：撤 A4 的快照冷启动读 `[perf] compose #N dur=` 与 `TOTAL calls=`，确认 calls ≤ 2 且首屏未变差（预期略好——A4 原先把那次 compose 压在首个请求路径上）。三层验收留到统一构建窗口。
- **C5 正向对照的设备侧取证依赖一棵打过 P1 的引擎树**：`check-boot-budget.mjs` 的对照在构建链打补丁**之前**跑时必然缺席（记 SKIP，符合设计）；发布前 `--require-real` 档需要 `.deploy-tmp/snapshot-013/<abi>/stage/root/...` 那棵树**已打 P1**，否则 C5 只有 SKIP、拿不到「等价成立」。CI/发布链接线时需确认该前置。
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
    **2026-09-19 判定性实测更正（见坑 165）**：这一条当时被当成「`--display` 生效」的证据，**结论不成立**。
    在虚拟屏 `virtual-1`（displayId=2）上放好 Settings（`dumpsys` 确认 task 在 display 2）后，
    **无参 dump / `--display 2` / `--display 0` 三者输出逐字节相同**（7799 B、19 节点、全是真实屏上的应用）
    ⇒ `uiautomator dump` **收下 `--display` 但不生效**，恒 dump 默认屏。上面那 1916 B 几乎确定是**真实屏**的树。
    由此：`screen-scope.ts` 把 `uiautomator` 家族的目标屏参数判为「无」**实质正确**，不得放开；
    `android_ui_tree` 已删除它无法兑现的 `screenId` 参数（坑 163）。
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

## 0.14.1 设备缺陷修复轮（2026-09-19，三个 P0）

本轮修的是**设备实测**暴露的三类缺陷（定性见协调仓 `docs/0.14.1-preview-DEVICE-DEFECT-TRIAGE-AND-TEST-REFLECTION.md`，
坑 161-165）：A1 工具面把「尚未探测」渲染成「Shizuku 未就绪」；B 缺省 virtual-only 下工具大面积不可用
（跨语言 op 清单漂移 + 参数无法兑现 + 承诺的工具不存在）；C 跨屏拉起以退出码判成功、应用落在真实屏。

**已修并在代码层/门禁层验证**（逐条判据见坑位）：

- A1：三态 + caps 补探（`shizukuChannelProbed`）；`android_privilege_status` 独立特权行；状态路由同步补探。
- B：壳侧 `REAL_SCREEN_OPS` 11 → 8 条并与引擎锁死（新门禁 `check-op-registry-parity.mjs`）；
  `android_act_input` 虚拟屏路径走 `vdInput`；`android_ui_tree` 删掉无法兑现的 `screenId`；
  **补实现 `android_vdisplay_input`**（新门禁 `check-tool-name-promises.mjs` 守承诺面）。
- C：`launchApp` 落点回读（三态：`vd-launched` / `vd-launch-denied` / `vd-launched-unverified`），
  并为避开 16 KiB stdout 截断改用固定字面量过滤（42 KB → 1.97 KB）。

**新增设备套件**：`scripts/verify-screen-scope-matrix.mjs`（跨面一致性 + 落点回读 + 双屏像素对照 +
real-only 反证；判据全在设备事实上，证据不足判 `INCONCLUSIVE` 而非通过；`--self-test` 6 例判别力）。
**它刻意不进聚合门禁**：无设备环境下强行声明只会制造「SKIP 即通过」的假绿；当前定位是
**发布前设备门禁**，由操作者按 `docs/AGENTS/emulator-test-protocol.md` 在真机/模拟器上跑。

**仍未做 / 待设备判定（如实登记）**：

- **本套件尚未在装机版上跑过一次**：本轮改动完成打包，但套件的首次真跑证据尚未产出——
  下一个动作就是跑它并把结论贴进 PR 描述（三层验收的 B 轨）。
- **`takeScreenshot(displayId≠0)` 对应用自建 private display 是否成功**仍未知（承接上文 U5；
  套件的 P3 用 SF token 的 `screencap -d <token>` 取虚拟屏像素，走的是另一条路，不回答这个问题）。
- **第三方应用能否被拉起到 private 虚拟屏**：本次判定性实测在 MuMu x86_64/API 35 上**成功**
  （`com.endday.game` 落在 display 2），且 `am start --display 2` 经普通 adb shell（uid 2000）也成立——
  这与 `VdisplayController.kt` 创建处注释「uid 2000 与 10053 两条路实测被拒」**冲突**；
  只在本机型证实，未在第二台 ROM 复核。注释已按实测改写为「本机型成立、他机型待复核」。
- **虚拟屏上限仍为 1**（`MAX_VIRTUAL_DISPLAYS`）：套件的多屏分支未覆盖。

## 0.14.1 审查轮登记的缺口（承接 `docs/COMPAT-REVIEW-0.14.0-2026-09-19.md`，进度见协调仓 `0.14.1-REVIEW-CHECKLIST-PROGRESS.md`）

| # | 缺口 | 现状 |
|---|---|---|
| K-A | **侧栏浏览器自动落位的时机洞**：`browser-auto-place.ts` 的 `tick()` 在「首次观测到某 owner 且已有页面」时只建基线就 return（`seenEmpty` 守卫）；若 `browserCaps` 与 `browser_open` 落在同一拍 1s 轮询内，该页**永远不会注册成侧栏 tab** | 未修。修法：壳侧 `status()` 增页面创建时间戳（如 `lastPageAtMs`），前端按 `pageCreatedAt > UI 加载时刻` 判真实边沿，替代近似守卫 |
| K-B | **A3 悬浮窗背景启动限制在多 ROM 上未复核**（0.14.1 块 H 自述残留） | 需多 ROM 真机各跑一次（权限缺失/开关关闭/无虚拟屏三种 fail-closed 形态） |
| K-C | **块 J① FIX-3「双起点验收」设备级证据缺**：`files/notify-responder.log` 的 `result=` 判据此前读错文件（真因已修），修后需再装机复验 | 未复验 |
| K-G | **发布链 `build-release.ps1` 的两处顺序/耦合缺口**（0.14.1-preview 组装实测） | ① **注入后组合缓存失配**：`check-combo-cache.mjs` 要求「快照内每个客户端 bundle 都能在 `.combo-cache/*.json` 里按 sha256 命中」，而注入会**替换**插件文件（本轮实测 `replaced entries: 194`）——若注入后没有按新字节重算缓存清单，门禁就在 `check-combo-cache.mjs(<abi>)` 判红（实测复现两次，与插件是否重构建无关地偶发）。② **前置门禁跑在注入之前**：`build-release.ps1:60` 用 `--snapshot-dir dsh-mobile-apk/snapshot` 跑全量门禁，而该目录在链内**随后**才被注入（`:109`）——于是「注入后产物」类断言（api-route-auth 的 post-injection marker、boot-budget 的 C5 正向对照）在第一次运行时必然取不到判据；本轮已把 boot-budget 的该 SKIP 具名声明化（`scripts/gate-skips-declared.json`），但**根治应是把前置门禁换成「注入后快照」或把该步移到注入之后**。现状：本轮发布资产按 `build-apk-013.ps1 -Suffix "-preview"` 的双 ABI 产物 + 注入后快照手工组装，门禁已用 `--snapshot-dir release/v0.14.1-preview/snapshot` 实跑 29/29（4 处 SKIP 全部具名声明）。 |
| K-F | **自动回滚（UndoGate + 急救 CLI）** | **已修并设备验收**（2026-09-21）：① 回滚目标改为**壳侧探活 HEALTHY 时记录的 known-good 快照**（不再认插件自报的 `boot-state.lastGoodAt`——它会在崩溃那次启动就写 ok）；② 加**安装指纹护栏**：跨版本一律不自动回滚，避免「新 APK + 旧配置」把新版本改动吃掉；③ 回滚被拒时复位看门狗锁存（否则引擎再也不被重试）。判据 `scripts/verify-auto-undo.mjs`（P1-P4 PASS：坏插件被剔除装配、171 个自带插件文件逐条 sha256 不变；`--cross-version` 验跨版本护栏）。**同轮补第③条**：坏插件让引擎进入 `DEGRADED_LOG`（日志 `plugin tree failed to load`、HTTP 仍活着）时，`planTick` 原本直接早退 IDLE ⇒ 自动回滚**根本不会触发**（设备实测：`undo-gate.log` 连 armed 都没有，只能手动重启）。已修：只对**装配失败**这一条签名放行到 undo 决策，且不让熔断把它锁成永久 HOLD（`WatchdogPluginTreeTest` 5 例，含「改前必红」的 IDLE→UNDO 断言与「活动 turn 不得被打扰」的反向对照）。**同轮改设计（2026-09-21 用户拍板）**：整份配置回滚会静默吞掉「最后一次健康启动之后用户装的插件」，故改为**清单式外科拔除**——硬清单（随版本并集，强制保留）+ 软清单（只在「清单变化 + 壳侧探活健康」时更新）；故障时能点名则**只拔坏的那一块**，点不出名且清单变过则拒绝整份回滚。设备验收（`-SN-1-18`）：`PASS=12 FAIL=0`，`pulled plugin=@dsh-android/dsh-bad-probe` 后清单**与基线逐字节相同**。**遗留**：插件**代码树不在快照范围内**（本机 20 份快照恒为「文件6 插件0」，坏插件「只改代码不改配置」这一类仍无法回滚）→ `#239`；坏插件**目录残留**仍在（剔除的是装配，不是文件） |
| K-E | **通知消费停摆（真机 #238：有消息不弹横幅 / 长按查看汇报空白）** | **已修并设备验收**：消费不再只靠一次文件事件——看门狗 5 s tick 兜底 `NotifyStore.drainTick` + 监听位扩到 `MOVED_TO/CLOSE_WRITE` + `drain` 加锁且先投递再推进偏移 + 长按面板文件回落 + 同内容 2 s 去重。设备判据 `scripts/verify-notify-consumption.mjs`（PASS=5/FAIL=0，含「硬链接注入只有兜底能消费」这条主判据）与横幅截图见 `dsh-mobile/docs/0.14.1-preview-NOTIFY-CONSUMPTION-STALL-FIX-PLAN.md` §9.4。**遗留**：真机停摆的触发源未坐实（候选 C5：目录 inode 被换后 inotify 静默失效）；长按面板本身未在设备上截到（本机未开悬浮球开关） |
| K-D | **execAdbLine 档位门的会话来源依赖工具入口绑定**（0.14.1 S-5 引入）：会话经 `guard()` 的 AsyncLocalStorage 绑定传递；若将来出现不经工具入口的后台调用路径，会被 fail-closed 拒（预期行为，但需要一条测试钉住） | 已在审查进度文档 §3.4 登记 |

### 0.14.1 设备验收轮补充发现（2026-09-19 晚）

- **`com.endday.game`（Godot 游戏）在虚拟屏上会 SIGSEGV 崩溃**：crash 缓冲实测两次
  （`19:30:30` 与 `21:05:53`，`fault addr 0x134`），栈落在
  `org.godotengine.godot.input.GodotInputHandler.onInputDeviceAdded / handleJoystickConnectionChangedEvent`
  ——输入设备变化事件触发。**本包一次都没崩**（crash 缓冲内 `grep -c dsharnessmobile` = 0），
  即这是第三方应用自身的健壮性问题，不是壳侧缺陷。影响：`verify-screen-scope-matrix.mjs` 用该包做
  「虚拟屏落点」样本时，任务期间它可能自行退出 → P2 会得 INCONCLUSIVE（回读找不到 ActivityRecord），
  这是**如实的证据不足**而非假绿。换一个更稳的第三方样本（或有 launcher 入口的系统应用）可缓解。
- **自然提示（不写工具名、不写解锁）那一轮的观察**：模型**自己**发现要先解锁——实测它调用了
  `android_capabilities · all`（见证据目录 `p2-conversation.txt`），随后仍在推理中被本轮取证打断，
  未取到完成态。故「解锁链路是否被模型自主走通」目前只有**一次未完成的观察**，
  尚不足以判定（既不能算通过，也不能算断链）。

## 原 root PR 作者 head 的未闭合记录（2026-09-30）

以下属于原 #302、重提 #308 作者 head 的历史记录，不作为0.14.3维护者修订证据。当前实现、限制与外部验收状态见 [ROOT-MAINTENANCE.md](ROOT-MAINTENANCE.md)。

- **Shizuku 通道自身在本机不可用（授权断链）**：`Shizuku.checkSelfPermission()` 恒返回 denied
  （服务端 v13.6 判据里没有公开 `checkPermission`；客户端 AAR 为 13.1.5，**版本差**是首要嫌疑），
  且管理器「应用管理」列表里看不到本应用——授权请求此前只在 `ensureBound` 的后台路径自动发起，
  而 `requestPermission` 需要前台 Activity ⇒ 静默失败。**已补**：`requestShizukuPermission()`
  桥方法 + 设置页「请求 Shizuku 授权」按钮（UI 线程发起，对话框落得到用户眼前）。
  **未验证**：授权框弹出后能否真的授予（需人点一次「允许」）。**影响**：不影响 root 能力——
  root 走 su 直连（`RootAccess`）；Shizuku 仅作可选通道。
- **`argv` 形态未改（issue #262 的引号逃逸约束）**：本方案（A）不做降权包装 ⇒ 该逃逸向量不成立，
  故 `runShell` 仍为 `sh -c <command>` 形态；约束已写进 `ShizukuTransport.runShell` 的注释
  （将来任何降权/包装必须走 argv 单元素）。**未做**：主动 argv 化（无收益，且改动面大）。
- **模拟器层验收未做**：本机 MuMu 播放器未运行（只有后台服务进程），三层验收里的
  「MuMu x86_64」这一层以**真机 arm64** 代替（更强目标，但不是仓库协议的默认首验层）。
  另：仓库协议的「真实任务由模型自行编排」一轮尚未跑（本轮验收为 CDP 状态机 + adb 设备事实）。
- **`repairOwnership` 的 su 路径未做单元测试**：chown/`su` 依赖 root 环境，JVM 侧无法真跑，
  仅有源码契约测试（路径必须在应用数据目录内、未授权时拒绝、`find -not -user` 形态）；
  行为证据来自真机实测（healed=4 且应用侧写入恢复）。
