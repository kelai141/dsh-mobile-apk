# known-gaps.md — 0.14.5 当前缺口与验收入口

> 更新：2026-10-07。目标 0.14.5；0.14.4 是旧包与反馈基线。源码有改动不等于新包已验收。
> 当前自主开发与模拟器验收已获用户授权；远程推送、PR、合并和发版仍需最终授权。历史版本的“外测由别人做”不适用于本轮。

## 当前入口

- 协调仓 `docs/REFACTOR-2026-10-05.md` 是本轮唯一活动计划、Issue Ledger 与事实账；子仓地图从 [AGENTS.md](../../AGENTS.md) 进入。
- 恢复与用户数据：[PERSISTENT-DATA.md](PERSISTENT-DATA.md)；协调仓 `docs/RECOVERY-ARCH-0.14.5.md`。当前实现以源码和冻结后的证据为准。
- 三层验收：[emulator-test-protocol.md](emulator-test-protocol.md)。旧包、热推或仅静态审计不能代替最终双 ABI 包的代码/CDP/ADB 用户层验收。

## 本轮仍需收口

| 项 | 当前事实 | 必须取得的结论 |
|---|---|---|
| Hard / Soft 插件状态 | 可信 factory identity、四态与真实冷启动健康正在实施；live 用户 patch 不能成为 Hard 来源 | 冻结后统一测试；Disabled 官方条目不能阻止健康；隔离不丢源码/config；退出 Safe Mode 恢复用户配置 |
| ONLINE 事务与健康 | 完整 tar 和 usr-only 兼容、只交换 usr、Hard sidecar 与 probation/commit/rollback、真实完成态正在修订 | 最终新包验证不改用户 HOME；仅 HTTP 活着不得提前提交；失败后可恢复 |
| 回撤节流纪元 | `.undo-auto-done` schema 2 仅抑制相同安装指纹 + 回滚前失败 patch digest，成功回滚后原子写入；身份变化重开观察窗，旧数字时间戳在有效期内保守抑制并记诊断；显式用户重启在确认本壳子进程停止后清 marker，自动重试不清。纯逻辑与源码接线测试已补，仍待本批 Gradle fresh 验证 | 同一失败配置防循环，新安装/新配置不继承旧事件；marker 写入只发生在成功整份恢复后 |
| 许可证 | Shizuku api/provider/aidl/shared 13.1.5 官方 POM 均为 MIT；已补固定许可文本、矩阵、notices 生成及版本/文本反例 | 最终 APK assets/licenses 内含 MIT 全文与 SDK notices；当前源码门禁通过不等于实包已确认 |
| MiMo 与配置保留 | 旧基线真实 wire on/off 成功；虚拟屏目标达成但旧任务 13 次工具调用超出事先 10 次限制，整例未通过 | 新正式包自主任务预先约定可行预算并按真实事件计数；保留既有配置/会话/凭据 |
| UI / 范围 / 通知 / 浏览器 | 有旧版和阶段证据；最终当前树尚未完成三层回归 | 两个模拟器横竖屏、透明度、拒绝面、文件选择、后台任务和旧会话均按同一产物复验 |
| 真机 | MuMu x86_64 是开发首验；arm64 真机是发布前补充 | 华为 WebView identity/安装反馈不能以模拟器替代真机证据 |
| CI 面两个已死 workflow 条目 | `Snapshot Build`（本地已 `git rm`，未推送）与 `ADB runtime patch`（其分支 `contrib/adb-runtime-patch` 已不存在）仍出现在 Actions 列表，均已 `gh workflow disable`；REST 无删除 workflow 的接口 | push 后 `Snapshot Build` 自动消失；`ADB runtime patch` 需在默认分支上不存在该文件，当前仅能保持 disabled |
| APK 更新兜底的例外：`runUpdate` 无超时兜底 | 0.14.6 新增的 APK 更新路径（`ApkUpdateController`）有完整兜底（`armWatchdog`/`disarmWatchdog`/`onTimeout`/`timeoutReason`/`release`）；**但快照联调路径 `runUpdate`（`EngineStartFlow.kt:1143`）没有任何定时器**，回执守卫在 `:1150`，代次作废即静默丢弃回执、不落终态 | 已裁定**本轮不修**（三条理由：① 入口是 `MainActivity.kt:475-476` 的 `ACTION_UPDATE`（`:197`，manifest 未声明），属 **adb-only 联调路径、普通用户不可达**；② 默认配置 `DEFAULT_MANIFEST_URL` 为空 ⇒ `UpdateManager` 立刻回 `NotConfigured` ⇒ 实际快速收敛、暴露不到；③ 本轮已为「下载 APK 更新」重新出包，再动 liveness 路径的回归风险不抵收益）。**如实登记的结论**：与用户报的「更新转圈不收敛」**同机制**，但**非用户可达**；若将来有人用 `overrideManifestUrl` 打开联调且下载卡住，才会以同形暴露 |
| `check-code-map.mjs` 锚点只验行号存在性、不验语义 | 锚点判定只校验「行号 ∈ [1, 文件行数]」（`scripts/check-code-map.mjs:235-242`），**不校验该行内容是否仍是文档声称的符号**。源码前移后地图会**静默漂移**而门禁仍 `exit 0`。实测（2026-10-11，只读探针）：1633 个锚点中带可提取预期符号者 **667 个（40.8%）**，可判读的 495 个里约 **53%（263 个）已漂移**；手工抽查 4 例 **4/4 真漂移** —— `AndroidBridge.kt` 的 `jsString` 文档写 `:423`（现 `:675`）、`BrowserHost.kt` 的 `onMain` 写 `:187`（现 `:386`）、`UpdateManager.kt:69` 写 `renameTo`（该行现为 `IllegalStateException`）、`SnapshotFs.kt:83` 写 `move`（现 `:74`） | 已裁定**本轮不改门禁**（两条理由：① 它是发布链门禁，改它需自证，而本轮已多次代码改动 + 第三次出包，风险叠加；② **未调参就启用比不加更坏** —— 会训练人忽略门禁）。**建议实现方向**：① 文档侧先给锚点补预期符号（纯文档、零门禁风险），把可校验覆盖率从 40.8% 往上提；② 门禁侧再加「`line ± WINDOW` 内出现预期符号」的校验 + **反例自检**（「符号移走能被发现」与「符号在窗口内不得判红」），WINDOW 按基线调参至误报为 0 再启用。**注意**：朴素窗口校验误报率高（59.2% 的锚点提取不到预期符号；裸文件名锚点如 `MainActivity.kt:815` 按仓内约定相对 `app/src/main/java/com/dsharnessmobile/shell/`），**不要在未调参时直接启用** |

## 0.14.7 已知限制（本轮如实登记，非缺陷隐瞒）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| R2 长按拖动：拖到列表边缘不自动滚动 | `sidebar-reorder.ts` 在拖动期间 `preventDefault` 拦原生滚动（否则手指下列表滚动会让命中行漂移、插入位置乱跳）。Spec §2.2 有「拖到列表边缘自动滚动」一句，本轮**未实现**。 | 已裁定本轮不做（需滚动容器 + rAF 边缘推进，属独立增量）。**用户可见影响：长列表远端目标需分两次拖动**。建议 0.14.8 独立项。 |
| R2 驱动上游 DnD 依赖合成事件 | 触摸屏无原生 drag 触发路径，故用合成 `dragstart/dragover/drop/dragend` 驱动上游 `Rows.tsx` / `WorkspaceBrowser.tsx` 的既有 handler。合成事件 `isTrusted=false`。 | 已核实上游当前**不校验** `isTrusted`。**若上游将来加该校验，本方案会静默失效** —— 届时需改为上游原生触摸拖放或请求上游提供触摸入口。 |
| #348 键盘遮挡：本机无法给出真机键盘证据 | 成因已修（弹层高度钳制纳入 `visualViewport` 底边，见 `composer-popup-guard.ts`）；本机可复现缺口（合成视口关系下溢出 196/96px 归零）。但本机仅有搜狗输入法、`mInputShown` 恒 false，真实键盘弹出态不可得。 | 记「**成因已修 + 待真机键盘复验**」，**不记 PASS**。票据所述澎湃 OS / Android 17 触发条件本机不可覆盖。 |
| Android 16/17 与澎湃 OS 专有行为 | 本机为 Android 15（MuMu x86_64）。`keyboard-boundary.ts` 注释记录的「Android 16 edge-to-edge 上 adjustResize 不缩布局视口」无法在本机复现验证。 | 本机**不可覆盖**，未计入通过项，需真机补充。 |
| R2 跨 account 重排未覆盖 | 上游 `sessionDragOrder` 按 `activeDrag.accountKey` 分组；本机仅有 1 个工作区行、无两个 account 各自的会话。 | 本机数据不具备，标**未覆盖**（不是通过）。已验证的是「跨组落点不改变顺序」（R2-5b）。 |
| 键盘判据在本机语义不稳定 | `mInputShown` 在 CDP 复验读到 false、ADB 探针读到 true；且新建会话后上游聚焦新 composer 本身会弹键盘，属标准 UX。 | 测试侧**只记录键盘数值、不作 FAIL 依据**（避免把正常 UX 写成缺陷）。#349 的「不弹键盘」半条同样待真机复验。 |
| `visualViewport` 判空曾漏 undefined（本轮已修） | `keyboard-boundary.ts` 原按 `vv === null` 判空，漏掉 `visualViewport` 求值为 `undefined` 的宿主，读 `.height` 抛 TypeError 并打断视口复算链。 | 已修为 `window.visualViewport ?? null` 并补 2 条回归用例（含反证）。记入 gotchas 284。 |

## Linux 内部插件的待接入边界（2026-10-16）

本仓交付实验性、默认不启用的宿主服务/API 与条件设置入口。bootstrap 与 runtime 是**我们自己的实验性内部插件**：按用户口径应随应用放入**内置（hard）插件目录**，但**默认不启用（存在不等于启用）**；应用更新或插件新版本发布都不得启用插件，也不得重新启用用户停用的插件。

现状与缺口（如实登记）：**bootstrap 源码已 vendored 进本仓** `plugins/dsh-linux-bootstrap/`（`@dsh-android/linux-bootstrap` 0.5.0，源 `kelai141/dsh-bionilux@3f86a85` `packages/linux-bootstrap`；只源码，无二进制/构建产物/LFS）。它**刻意不在注入集**：`scripts/plugin-dirs.json`、`scripts/contract.json` 的 `inserted`、`scripts/profile-web.cordis.patch.yml` 都不登记它，因为 bootstrap 的 `apply()` 需要**函数型 config**（`linuxAssetIO.downloadAsset`/`extractArchive`、`appVersionProvider`），profile 的 YAML 装配表达不了——把它挂进 profile 只会在装配期抛 `TypeError`。不入注入集同时让 `check-patch-mounts.mjs`（双向）与 `check-contract.mjs`（幽灵登记）保持真绿：它们守的是注入集与挂载集的双向一致，而本包不在任一集合内。代价是「写进 hard 目录」在**装配面**没有登记位，这一层的如实形态是：包字节随本仓（因而随 APK 源码分发）在场，但启用只发生在用户显式动作时，由宿主动态加载，不由 profile 决定。

漂移由 `scripts/check-vendored-linux-bootstrap.mjs` 守（`--self-test` 含 1 正控 + 3 负控）：断言 vendored 文件集 == 上游包去掉 `test/` 加本仓两个文件、9 个上游一致文件的 EOL 归一秒摘要、以及三条刻意偏差（`exports` 指 `./lib`、保留 `build` 脚本、去掉 `test` 脚本、`private:true`）。它**不进** `check-release-gates.mjs` 的 `GATES`（进册即要求本地链与云端链同时接线，而那是镜像面文件），故以文档化命令 + 自检形式提供。

`kelai141/dsh-bionilux` 的内部 bootstrap 需被启用后提供 `linuxBootstrap` 服务、调用 `linuxPluginHost`（含 `isInjected` 在场查询）后再激活；构造/下载/解包由 bootstrap 拥有，运行时 manager 装配由宿主从激活作用域读出并交回（`install` 返回 `{manager, rollback?}`）。**未覆盖**：runtime 插件本体仍未 vendored（按设计只来自 Release），因此 `linuxPluginHost.install` 与 manager 交接只由单测（真实 Cordis + 受控 manager）覆盖，**没有**跑过真实 Release 产物。

设备验收仅覆盖未注入状态：不显示 Linux 设置入口、API 503、无运行目录或 Linux 工具自动创建；没有执行真实 Linux 安装、更新、重装、卸载，也没有打包最终 APK 或完成真机验收。这些不登记为通过。这两个插件是我们自己的实验性内部插件（默认不启用），发布不得自动修改注入目录或启用它们；实际启用与完整安装验收须基于用户显式启用后的成品另行完成。

### 0.15.0 追加：宿主侧「准备」已就位，端到端仍差三段（如实登记）

已落地并有反证：`LinuxAssetIO`（来源面/落点面/摘要+体量/解包面判据，复用 `SnapshotExtractor` 与 `SnapshotBundledAsset`）与 `LinuxAssetPrepare`（客户端触发入口，`@JavascriptInterface` `linuxAssetPrepare`/`linuxAssetPrepareStatus`）。五条负控（穿越、符号链接逃逸、炸弹、摘要不符、字节数不符）在 Kotlin 侧各有真实用例，且失败一律不发布产物。

**仍未打通的三段（均不记通过）**：① ~~引擎侧 bootstrap 的 `linuxAssetIO` 透传/占位接线**未做**~~ —— **0.15.0 已接**：`plugins/dsh-android-linux-env/src/linux-host-asset-io.ts` 造出透传 + 失败关闭的 `downloadAsset`/`extractArchive`，负控见 `test/linux-host-asset-io.test.mjs`（无暂存 → 拒；摘要不符 → 拒；包名不符 → 拒；`unpackedSize` 不符 → 拒；恶意摘要 → 拒且环境根外哨兵不动；另有 1 正控证明真实暂存包可激活）。**配套的上游复用分支缺口亦已闭合**：bootstrap 在 `dsh-bionilux@3f86a85` 起，激活前会复验宿主暂存的包（自算归档 SHA-256 与体量、重算 `unpackedSize`、校验包名与入口），命中自己写下的标记也不再免检——被篡改的槽位**不会被复用**，而是从已复验的宿主暂存**重建**；需要重建而重建源又不可信时**失败关闭**。两条都有内容级用例钉住（`re-verifies on reuse: a tampered published slot is rebuilt, not trusted`、`refuses when a rebuild is needed and the retained archive no longer matches the manifest`），且已用**撤掉上游修复**的变异验证证明它们确实会变红。② **页面侧没有调用者**：`linuxAssetPrepare` 在 `android-bridge.ts` 里只是声明位，实际调用点应由 Linux 设置页（vendored bootstrap 客户端，上游所有）在用户点安装前发起，属于上游改动；③ bootstrap 包**仍未进注入集**，不随应用分发；④ 因此**没有任何端到端安装验收**，也没跑过真实 Release 产物。

## 历史事项不自动关闭

旧登记的浏览器自动落位、看门狗恢复入口、API<30 截图回落、多 ROM 限制、动效、滚动条、低置信度依赖判据等，保留当时证据。应按当前源码逐项分类为已改、仍存在或仅特定设备待验；不得把旧“未修”直接当当前事实，也不得把归档当完成。

完整原文在 [历史缺口登记](../archive/known-gaps-pre-0.14.5-2026-10-07.md)。当时版本结论、授权和停止点均不覆盖当前本轮要求。

## 悬浮球隐藏态（0.14.9-preview 块J，2026-10-18）

隐藏态（球与光环 removeView、屏缘留召回条）本轮交付两条**未收口**的缺口，如实登记，不记通过：

- **隐藏期间没有专属提示通道**：球不在屏上时，AI 提问与权限审批只走通知面（`NotifyCenter`），
  隐藏态不新增常驻提示。这是「用户主动要求静默」的必然结果，属产品取舍，非缺陷。
- **召回条宽 8dp 的命中区未经真人验证**：条是隐藏态**唯一**的召回入口，命中区 = 窗口 = 8×44dp
  （含贴屏缘 x=0，可能与系统边缘返回手势热区局部重叠）。仓内先例（S2-18 的 20×20dp 判「按不准」、
  `VdisplayFloat` 贴边把手 22×64dp）提示偏窄；用户 2026-10-18 拍板保持 8dp 原样交付。
  必须在**真机（arm64）补验**点按手感与边缘手势干涉，结论不确定即回到加宽方案。

## 会话删除的活动探测 TOCTOU 窗口（2026-10-24，issue #510 遗留登记）

`dsh-session-delete` 的删除流程是「activity 探测（waterfall）→ 卸载 → rename → rm」，
探测通过到 rename 之间会话可被重新拉起，无引擎级锁可拿——窗口毫秒级、单用户本地场景。
**裁定不修**（引入跨进程锁的复杂度不抵收益），此处登记防将来被当新缺陷重报：
- 两个工程半边已修并合入（PR #519 graveyard 清扫、#527 续做失败可见反馈）；
- 剩余形态仅为「删除瞬间恰逢会话开始运行」的毫秒窗竞态，后果是该次删除对运行中文件的操作
  与新会话写入交错（jsonl 追加方为引擎，rename 后旧句柄继续写向墓地目录，不损坏新会话）。

## 上游槽位 entry 的 undefined 组件崩溃（2026-10-25，小米 14 实锤，守卫已上）

页面 bootstrap 期 `slot entry crashed in 'conversation.input.left'` + React #130（元素类型
undefined）→ 整树卸载、`pageSideRuntime=unavailable`、启动流两次重试耗尽落修复门。**四组对照
均复现**：壳 0.14.7 与 main（0.14.9-DEV-FAST）、快照 rc.2 与 rc.3、第三方插件全摘、装载列表
57 项全 @deepseek-ai 官方——崩点在上游槽位系统消费一个解析为 undefined 的 entry，且 slot
outlet 无 per-entry 错误边界，单 entry 崩即整页死。触发环境：小米 14（HyperOS）/ Google
WebView 155 真机；MuMu 历来全绿（环境差异）。同场连环的另两层（KernelSU su 属主维护租约因
进程被杀不结算 → 整机隔离；修复门循环）已在设备上逐层解锁，见 dsh-host-web-compat
slot-guard 注释与本日审计报告。

**处置**：壳侧 fail-soft 守卫已上（dsh-host-web-compat slot-guard，拦截 `__ModuleLoader__`
赋值包装 react/jsx-runtime，undefined 元素渲染 null + console.warn 一次）；**上游根因未修**
（待上游给 slot outlet 加 per-entry 错误边界或修复该 entry 的解析）——上游修复前真机每次
启动都有一个槽位 entry 静默缺席（输入框左侧挂件位），属已知代价，如实登记不记通过。

## 原生管理中心（2026-10-16）

当前上游插件管理 API 不提供静态依赖图。壳侧在停用前确认操作，比较操作前后完整运行清单并尝试恢复造成失活的变更；这是运行状态检查，不等同于静态依赖分析。只读/不可寻址条目保留展示并禁用开关。插件详情复用运行时暴露的配置 Schema；未激活或未提供可编辑 Schema 的插件明确说明原因。高级配置为合并保存，删除 JSON 字段不代表重置。

## 原生修复助手（2026-10-18）

引擎启动失败后不再依赖快照内 UndoGate 作为唯一的用户修复路径。壳侧原生助手读取真实启动诊断与 DSH 现有模型配置，可以使用界定的 `read`、`write`、`list`、`bash`、`engine_status`、`restart_engine`、`refresh_runtime` 工具，并在修复后重新启动与验证。助手自身被打进 APK，启动时不受插件或 WebView 失败影响。

当前验证范围是单个开发模拟器上的真实新会话、连续工具批次、停止与重新打开；本次仅是快速验证，不作完整三层验收，也不进入发版候选。尚未在 arm64 真机验证。对话栏横向布局、浅深色对比度、模型与推理强度切换、历史会话与新会话仍需在当前安装包上做人工回归；发布前必须补齐这些项目并完成正式包验收。

## screen-scope 五个修复（#803 #802 #799 #790 #786）的验收缺口（2026-10-29）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| CDP（模型 transport）层未验 | 已验档位：代码层（judge 41/41、Kotlin \`ScreenScopeTest\` 5 例）+ handler 接线层（A 组 25/25 拦下、B 组 16/16 放行）+ 设备副作用层（B 组 16 条实机执行，前后截图 sha256 与 \`dumpsys SurfaceFlinger\` token 集合均一致）。**CDP 层未验**：需要模型 transport 把 A/B 组经 \`android_shell_exec\` 真正下发，当前会话无 bridge 工具面。验收任务由外部模型经 adb 编排，非设备内模型（设备未配 LLM）。 | 跟进 issue #834 钉住 A/B 组 41 条断言清单；bridge transport 就绪后跑 \`node scripts/verify-screen-scope-01410.mjs --layer=bridge --receipts=<json>\` 收口 |
| \`S-22d\` / \`S-20i\` 仅由 judge 层覆盖，真机未确认 | 这两条（\`input touchpad -d 7 tap 1 2\`、\`wm reset -d 7\`）依赖「目标确为已注册虚拟屏则放行」。handler 层构造 service 时不注入 controlQueue（为保证零设备 I/O），拿不到虚拟屏注册表，故这两条在该层被跳过，仅由纯函数层（judge）覆盖。设备层跑的是 B 组其余 14 条。 | 真机确认方式见 #834：先建虚拟屏拿到已注册 displayId，再下发这两条断言放行 |

## 文案面剩余缺口（2026-10-29）

| 项 | 当前事实 | 结论 / 后续 |
|---|---|---|
| 测试通知的标题/正文只有中文 | `NotifyCenter.sendTestAll` 的五条测试通知用了写死的中文字面量（「测试提问」「测试会话」「已完成 · 这是一条工作汇报测试」等）。把 UI 语言切成英文后，系统通知栏里这五条仍显示中文（真机截图已确认），而开关点击后的落点提示已正确显示英文。 | 面只出现在「发送测试通知」自证按钮，不影响真实事件通知（真实通知的标题/正文由引擎帧提供）。修法：把 `sendTest` 里的字面量改成 `UiText.t(app, zh, en)`，并在 `AppLanguageTest` 补一条形态断言。 |
| 原生离线插件面板无双语 helper | `PluginOfflinePanel.kt` 全文没有 `UiText.t`/`t(zh,en)`，其「已启用/已停用，重启引擎后生效」「修改失败」等提示只有中文。 | 与本次修的两处同一类问题，但该面板整体缺英文（不是漏一处），单独收口更合适。 |
