# AGENTS.md — dsh-mobile-apk 开发地图（索引主文件）

> **AI 主动更新条款（必须最先执行）**：本文件是唯一权威入口，采用「主文件索引 + docs/AGENTS/ 详档」结构。**任何代码变更导致描述失真时：① 主文件对应行当轮更新；② 细节写入 docs/AGENTS/ 对应详档（坑→gotchas.md 追加递增编号；版本历史→更新记录表登记，3 条之前的行滚入 changelog-archive.md）。** 若发现文档与源码不一致，以源码为准并当场修正。**查询规范：优先用 grep 在 docs/AGENTS/ 详档内定位（见下方路由表），不要凭记忆猜细节。**
>
> **过期风险声明**：代码演进可能快于文档更新；一切以源码为准。

---

## 1. 仓库概览

- **角色**：DeepSeek Harness 安卓壳应用（`com.dsharnessmobile.shell`）。职责边界 = 只保留安卓平台权能与桥（前台服务/看门狗/WebView/SAF 桥/快照解压/UndoGate/ADB 授权/审计/控制台/日志）；**AI 可见能力全部来自插件**。
- **运行时形态**：内嵌 Termux 快照（`assets/snapshot.tar.xz` → files/usr + files/home）；引擎 `@deepseek-ai/dsh` **0.1.5-rc.1**（0.13.3 起构建期 overlay；0.13.7 追上游升版，快照本轮重建）；/api 全前缀浏览器鉴权——壳侧 EngineAuth 带 Cookie）监听 127.0.0.1:3080；WebView 加载引擎 Web UI。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **版本状态**：**0.13.7fx-1（本轮发版，vc35）**：本版=**@ 文件回到上游原生**（退役注入的「引用本机文件」菜单项与整条 SAF 路径桥；`@` 只列会话工作区文件，官方语义）＋ **引擎启动目录改应用工作区根**（未分组会话不再把 `/` 当工作区，issue #150/#144）＋ **修复 0.1.5 起失效的移动端 Enter 换行守卫**＋ 退役空转的 `web-frontend-index.html` 运行时补丁 + 合入贡献者 PR #157（抽屉底部安全区）。**0.13.7 已发布（vc34，Release v0.13.7，15 资产，2026-09-10）**：本版=**追上游 dsh 0.1.5-rc.1**（上游 ui-layout 基线 + 移动适配层 0.2.0 + 原生「打开方式」PathOpen/openPathChooser + 引擎树补丁 F3/F4 + polyfill 装配与 Iterator 垫片修复 + UI 冗余清理）；认证台账 `docs/AGENTS/0.13.7-CERTIFICATION.md`（版本口径统一表在 §3）。0.13.6 已发布（vc33，Release v0.13.6，15 资产，2026-09-10）：本版=**附件持久化 Android 守卫（图片输入/read_image 全链修复，构建期+运行时补丁双写）** + 自有 WebView DOM 快速通道（`android_web_dump` + `ref=wN/css:/text:/role:`）+ `android_ui_global`（返回/主页/最近任务/通知栏）+ `android_env_prepare`/`android_app_launch`/前台真值/输入回读断言 + `phone-control` 预设 + 顶部系统 inset 通道 + 弹出面板几何守卫 + 悬浮球光环提亮；认证台账 `docs/AGENTS/0.13.6-CERTIFICATION.md`。0.13.5 已发布（vc32，Release v0.13.5，15 资产，2026-09-10 收官）：无障碍控制通道 v1（`DeviceControlService` + 控制队列 + 双通道门禁等价且无障碍优先 + 无障碍截屏 API 30+ + 完整语义树/同名消歧）+ 悬浮球跟随工作会话/新会话落临时工作区 + 授权面重构 + #126/#124 引擎补丁 + #125 能力自动补全 + 构建提速（WSL 内原生执行，172s vs ~29min）。0.13.3 已发布（vc30，Release v0.13.3 正式版，14 资产）。0.13.2 已发布（vc29，悬浮球 v2.1 全套）。0.13.6 已把 0.13.5 的残余项（#127/#128/#129/#130 主体/#133/#134/#135）全部落地；开放跟踪：#130 剩余（Android 13+ 无障碍输入法替代内嵌 IME 的自动就绪）、#115（市场 Phase2）、#108（数据备份）。arm64 真机（V2425A）链路验证已通过。
- **兄弟仓库**（协调仓子目录，本仓内含自包含副本——**坑 36 同步铁律**：协调仓改子仓源码/bump 版本后必须 robocopy 镜像到本仓，lib/ 产物一并拷）：`dsh-shell-termux`、`dsh-client-ui-responsive`（0.2.1，移动适配层）、`dsh-host-web-compat`（0.1.13，polyfill/桥）、`plugins/`（bridge 0.2.2 / manage 0.2.3 / model-capability 0.2.1 / linux-env / file-open）、`vendor/`（marketplace、undo-savepoint、dsh-model-sync + PATCHES.md）。
- **上游** deepseek-ai/deepseek-harness（协调仓 `dsh/` 只读 checkout）：**零改动**；一切适配走补丁/插件/壳侧。
- **模拟器优先于 PR 与真机请求（2026-09-10 用户定例）**：改动落地顺序 = 本地构建 → **MuMu x86_64 模拟器实测** → 再谈 PR；**不得以「等真机验证」为由推迟模拟器实测、或把模拟器实测挂在 PR 之后**。真机（arm64）验证是**发布前**的补充门禁，不是开发循环的前置条件；模拟器上验不过的改动不允许开 PR，模拟器上验过的改动也不因缺真机而搁置（release notes 标注真机待验即可）。
- **PR 流程铁律（2026-09-10 用户定例）**：**任何代码/文档改动一律走 PR，禁止直接 push 到 `main`**（人类与 AI 开发助手同等适用）。流程：建分支（`<type>/<简短描述>`）→ 提交（`<type>: <描述>`，见 pr-guidelines）→ 推送分支 → 开 PR（标题/描述按模板，标签 1-3 个）→ CI Gate 绿 → 合并 → 删分支。**例外（不改仓库内容的外部动作，可直连 API）**：Release 资产上传/发布、issue 评论与开关、标签操作。协调仓 `dsh-mobile` 同规（见其 AGENTS.md §4）。

## 2. 构建命令速查（在协调仓根执行）

```powershell
pwsh -File scripts\build-apk-013.ps1 -Suffix ""   # 一键双 ABI（门禁失败即拒打包）
pwsh -File scripts\build-apk-013.ps1 -Fast        # dev 快速档（单 ABI x86_64 + preset 1；产物禁发布）
node scripts\build-snapshot-013.mjs <arm64|x86_64> # 快照构建（Windows 需 WSL）
node scripts\smoke-bridge.mjs                      # bridge 冒烟
adb -s <serial> install -r -t out\v<版本>\...apk    # 装机（同签名 debug keystore）
```

门禁链：统一补丁 → 引擎 overlay 抽验（check-engine-overlay）→ 单 pass 注入 → 挂载集 → 机密 → third-party → elf-check → gradle。云端自包含构建：`.github/workflows/build-apk.yml`。

## 3. 高频雷点 TOP（一行一条；全量 45 坑 grep docs/AGENTS/gotchas.md）

- **坑 37**：快照重解压中（~8-12 分钟）**禁 force-stop/杀进程**——唯一完成标志 = `.snapshot-fingerprint` 翻转 + `.snapshot-transaction` 消失（0.13.3 事务化后不再用 `.dsh-backup`）；中途杀 → 事务恢复会自动回滚，但仍建议等完成。
- **坑 18/30**：debug 包默认 x86_64 快照装 arm64 必崩；真机安装只用 ps1 对应 ABI 命名产物。
- **坑 19**：真机改 cordis.patch.yml 后必须冷启动 app（force-stop + start）才重装配。
- **坑 33**：壳侧所有本地引擎调用一律 `Proxy.NO_PROXY`（系统代理劫持探针）。
- **坑 38**：运行时补丁升级引擎时必须逐个核对（rc.2 锁定 asset 会抹掉新引擎代码——0.13.3 prompt 阻断实锤）。
- **坑 44**：WSL 9p 挂载 chmod 无效——归档权限归一化只在 `inject-all.py` 重打包层做（门禁校验注入后快照）。
- **坑 45**：快照含 9 个指向 `files/usr/...` 的绝对符号链接（vi/vim/nc/editor/pager 等 applet）——暂存解压必须传 `runtimeRoot=filesDir` 放行，否则静默丢链。

## 4. 详档路由表（grep 形式查询）

| 要查什么 | grep 建议 | 文档 |
|---|---|---|
| 坑 N 详情/新坑登记 | `grep -n "^38\.\|^39\." docs/AGENTS/gotchas.md` 或按关键词（`borrowSession`/`store-rehome`/`MANAGE_EXTERNAL_STORAGE`/`run-as`/`overlay`） | docs/AGENTS/gotchas.md |
| 某 .kt 文件职责/函数位置 | `grep -n "<文件名>.kt" docs/AGENTS/modules.md` | docs/AGENTS/modules.md |
| 桥方法签名/通道语义 | `grep -n "<方法名>" docs/AGENTS/BRIDGE-API.md`；0.13.3 增量 grep `pickFilePath\|remote.mux\|EngineAuth` docs/AGENTS/bridge-api.md | docs/AGENTS/bridge-api.md |
| 构建失败/门禁/环境差异 | `grep -n "门禁\|WSL\|abi" docs/AGENTS/build-and-env.md` | docs/AGENTS/build-and-env.md |
| 运行时补丁（assets/patched） | `grep -n "patched\|applyAssetPatch" docs/AGENTS/RUNTIME-PATCHES.md` | docs/AGENTS/RUNTIME-PATCHES.md |
| 35 模块地图/依赖方向 | `grep -n "模块\|依赖" docs/AGENTS/ARCHITECTURE.md` | docs/AGENTS/ARCHITECTURE.md |
| android.* API 清单/守卫点 | `grep -n "API 等级\|android\." docs/AGENTS/ANDROID-API-USAGE.md` | docs/AGENTS/ANDROID-API-USAGE.md |
| **无障碍 API/权限面全量参考** | `grep -n "CAPABILITY_\|takeScreenshot\|ACTION_SET_TEXT\|GLOBAL_ACTION" docs/AGENTS/ACCESSIBILITY-API.md` | docs/AGENTS/ACCESSIBILITY-API.md |
| gradle 依赖与升级策略 | `grep -n "依赖\|升级" docs/AGENTS/DEPENDENCIES.md` | docs/AGENTS/DEPENDENCIES.md |
| GPL 合规三形态 | `grep -n "copyright\|LICENSES" docs/AGENTS/gpl-compliance.md` | docs/AGENTS/gpl-compliance.md |
| 待办与已知缺口 | `grep -n "F[0-9]\|未实现" docs/AGENTS/known-gaps.md` | docs/AGENTS/known-gaps.md |
| 版本历史 | `grep -n "0.13.2" docs/AGENTS/changelog-archive.md` | docs/AGENTS/changelog-archive.md |

## 5. 更新记录表（最近 3 条；完整历史 docs/AGENTS/changelog-archive.md）

| 时间 | 版本 | 更新内容 | 更新者 |
|---|---|---|---|
| 2026-09-11 | **0.13.7fx-1（vc35）** | **@ 文件回上游原生 + 移动端输入/几何修正批**：① 退役注入的 composer 菜单项「引用本机文件」（`data-dsh-file-pick`）与整条 `pickFilePath`/`onFilePicked` 桥（dsh-host-web-compat **0.1.13**：lib 删注入 IIFE 与 `insertFileMention`；壳删 AndroidBridge 接口 + ConfigTransfer SAF 文档链，JS 接口 33→32）——上游 0.1.5 自带 `@` 引用菜单（ui-input-trigger + ui-reference），实测只列会话工作区内的文件（矩阵见坑 65）；② **引擎启动目录改 `files/home/.dsh/workspaces`**（`EngineManager.workspaceRootDir`）——Android 应用进程 cwd 是 `/`，未分组会话因此把设备根目录当工作区，`@` 列出 acct/apex/cache…（apk #150/#144 的复现根因）；③ **修复 0.1.5 起失效的 Enter 守卫**（dsh-client-ui-responsive **0.2.1**）：`[data-composer-card] textarea` 在 Lexical contenteditable 上恒不命中，手机换行键变回发送；改为识别两种编辑宿主，contenteditable 走改发 Shift+Enter（上游 keymap 的原生换行路径）；④ 退役空转的 `web-frontend-index.html` 运行时补丁（实测与引擎自带 `dist/index.html` 逐字相同，且其 hashAdaptive 追不上新 hash 形态，坑 64；删 asset + 注册行 + `adaptIndexHashes`）；⑤ 合入贡献者 PR #157（xuanxuan9929）：抽屉底部安全区 `padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dsh-android-system-bottom, 0px))`（apk #153），并回写权威源 + 重建 lib 产物；⑥ 文档：RUNTIME-PATCHES §8、BRIDGE-API、坑 64/65 | AI 开发助手 |
| 2026-09-10 | **0.13.7（已发布，vc34，Release 15 资产）** | **追上游 dsh 0.1.5-rc.1（UI 基线 + 移动适配层）**：ui-responsive 0.2.0 去 fork（不再注册 root 槽；新增 phone form / 顶栏抽屉开关 / 原生「打开方式」入口与 open-with 标签类型）；host-web-compat **0.1.12**（退役「上传图片」「导出调试日志」与自己遮蔽上游附件按钮的 CSS，新增 __dshOpenPath；**修 polyfill 装配语法缺陷**——POLYFILLS 用 join('') 拼接，Set 片段 `})()` 撞下一段 `if (` 让整个 script 被解析器拒绝、polyfill 全灭（表现为上游包 `Iterator is not defined` → Failed to load plugins），HTML 里文本仍在所以 grep 全绿；防线 = 装配补分号 + apply() 装载期 new Function 断言 + `scripts/smoke-injections.mjs` 门禁，坑 61）；壳侧新增 PathOpen.kt（系统选择器：MT 管理器 / 系统文件管理）+ 桥 openPathChooser（删 downloadDebugLogs/pickImage，JS 接口 34→33）+ 删 DebugLogExporter.kt；engine-overlay 升 0.1.5-rc.1（265 包，新增 UI 底座与会话格式/LSP/E2B 包 + node-addon-system）；profile patch 不再禁用 ui-layout（坑 58）并关掉 open-in-app/ui-open-in-app；**引擎树补丁**：退役 pi-drift-F1（上游 0.1.5 原生 strict/deferred 校验）、新增 flock-android-F3（node-addon-system 无 Android 预编译 → 按上游 browser-worker 先例 stub 立即成功）、新增 atomic-stale-lock-F4（孤儿写锁回收：pid 已消失 + 二次核验才删，坑 62；行为回归 `scripts/patches/tests/atomic-stale-lock.test.mjs`）；设备侧 WebView 断言脚本 `scripts/verify-webview-015.mjs`（含 polyfill 活性与内联脚本可解析）；**模拟器验收已通过**（MuMu x86_64：全门禁绿 + 快照指纹 12329ed4→81654b6a 事务化刷新；`scripts/verify-webview-015.mjs` 26/26 ALL PASS；`verify-engine-tree` 13/13；打开方式桥对工作区与外部存储均 `{ok:true}` 且拉起选择器，应用私有区仍 `not-allowed`）；**追加 UI 清理（用户当场指出）**：退役 dsh-attachment-formats（重复的「添加附件」）、vendor 补丁 undo-E8 把快照徽章折叠成小绿点；360x780 度量覆盖下无横向溢出、模型选择器由上游自动折叠；verify-webview-015 仍 26/26。清单与未决项见协调仓 docs/UPSTREAM-0.1.5-ADAPT-2026-09-10.md §3.2.1/§4.3 | AI 开发助手 |
| 2026-09-10 | 0.13.6 | **v0.13.6 发布收官（vc33，Release 15 资产）**：全量认证通过（全门禁 + 双 ABI 纯净构建 + 快照资产一致性双 PASS arm64 `e85e8980`/x86_64 `4fe3a85e` + 单测 85/30/5 + smoke PASS）；x86 双形态设备回归（竖屏 16416：`android_web_dump` 106 节点 / `android_screenshot` 内联回图 / `android_env_prepare`；横屏 16384：布局+门禁行为）；真机 V2425A 链路验证通过后发版；新增坑 55-57 与认证台账 | AI 开发助手 |
| 2026-09-10 | 0.13.5+ | **UI 畸变与无障碍体验修复批（未发版）**：#135 壳侧补 top inset 通道（`webSystemTopInset` → `--dsh-android-system-top`；实测状态栏 48px/24CSS、topbar 61→85、设置页 nav y=12→24）+ 注入层弹出面板几何守卫（卡片/滚动容器同宽、水平钳制、高度上限；360px 视口 shift=14px 标签完整）；#127 无障碍截屏改写 `files/home/tmp/dsh-tmp`（引擎 TMPDIR 同源）+ LRU 兜底，工具层一次性内联回图并删文件；#129 新增 `state` op（代次+失效标记，不建树）供点击生效校验 + 回填真实坐标；#133 完成事件丢弃该会话 pending + 自动收起（`auto_collapse_on_done`，有草稿不收）；#134 能力插件方言门（跨厂商 thinkingFormat 非统一即跳过 reasoningEfforts）；#130 dump/tree 描述改「首选/兜底」；镜像 ui-responsive 0.1.14 + manage/bridge/model-capability 0.2.1；坑 49-54 登记；详见协调仓 `docs/UI-A11Y-FIX-2026-09-10.md` | AI 开发助手 |
| 2026-09-10 | 0.13.5 | **v0.13.5 发布收官（vc32，Release 15 资产）**：双 ABI 纯净构建（arm64 158.23MB / x86_64 155.55MB）+ 快照资产一致性门禁双 PASS + 全门禁绿（overlay 271 断言 / 挂载集 / 权限模式 51822 文件 / 第三方 / elf / 机密）+ gradle 双 BUILD SUCCESSFUL；release 15 资产（双 APK + 双快照 xz+sha256 + 8 插件 tgz 含新增 dsh-model-capability + MANIFEST.txt；notes 只做 release body）；**设备验收（模拟器 16416）**：无障碍 dump 字段完整（类型/resource-id/完整 bounds/父子层级/可见性/包名窗口号，未截断）→ click 成功 → 无障碍截屏成功；G1 实证（假插件 pending 时引擎照常启动，日志 `boot continues (dsh-mobile boot tolerance (G1))`）；**残余问题开 issue：#127 截屏落私有目录引擎读不到 / #128 WebView 无障碍树过浅 / #129 点击无生效校验**；issue 对账：关 #124/#125/#126（各附根因与复验指引）；**arm64 真机复验未完成**（升级安装 Success，刷新途中 USB 掉线；事务化刷新理论安全，复验步骤见 release notes） | AI 开发助手 |
| 2026-09-10 | 0.13.5 | **无障碍控制通道 v1 + 双通道授权面重构（用户当场指出的设计缺口）**：① `DeviceControlService.kt`（新，无障碍服务：树快照路径 id/attrs 与 uiautomator XML 同构、click/setText/scroll/global/**screenshot**、令牌与状态）+ `ControlPoller.kt`（新，引擎队列长轮询：空闲 5s/有活即时，轮询即心跳）+ `res/xml/accessibility_service_config.xml`（`canRetrieveWindowContent`/`canPerformGestures`/**`canTakeScreenshot`**）+ manifest 声明；② **门禁重构**：`gateFor` 改为「无障碍在线 **或** ADB 三道人门」等价、无障碍优先（此前 ADB 门先行导致 a11y 通道永远不可达——坑 47），后端由 `ControlPolicy.decideControl` 选择；③ **授权面重构**：设置页「设备控制授权」无障碍为主入口（官方 Intent 跳系统设置 + Android 13 受限设置一键解锁 `appops ACCESS_RESTRICTED_SETTINGS`），ADB 折叠为高级/脚本面；桥新增 `a11yStatus/openA11ySettings/unlockRestrictedSettings`；④ **僵尸 a11yEnabled 修复**：引擎侧判定叠加队列轮询心跳（坑 46）；⑤ 无障碍截屏（API 30+ `takeScreenshot`）落地——截图不再依赖 ADB；⑥ `docs/AGENTS/ACCESSIBILITY-API.md`（新）无障碍 API/权限面全量参考（SDK api-versions.xml 抽取）；⑦ #126 P1 兜底：`EngineManager.snapshotSettingsBackup()` 换树前 settings 三世代备份；⑧ 引擎侧配套（协调仓）：`boot-pending-G1`/`pi-toolcall-G2` 补丁、`dsh-model-capability` 0.2.0（UI 全流程回归 PASS）、构建提速（WSL 内原生执行 172s vs ~29min） | AI 开发助手 |
| 2026-09-08 | 0.13.3 | **v0.13.3 正式发布收官**：双 ABI 纯净构建（`-Suffix "" -ExportSnapshots`，arm64 158.17MB / x86_64 155.27MB）+ 快照资产一致性门禁双 PASS（arm64 cb27e9c1 / x86_64 773eb631，与 APK 内嵌同源）+ 全门禁绿（overlay 269 断言 / 挂载集 10/10 / 权限模式 51805+51687 文件 / 第三方 / elf / 机密）+ gradle 双 BUILD SUCCESSFUL；release 14 资产（双 APK + 双快照 xz+sha256 + 7 插件 tgz + MANIFEST.txt；**notes.md 只做 release body，不再作为资产上传**）；draft 转正式（tag v0.13.3 落 main，prerelease=false）；设备复验 release x86_64 包 PASS（指纹翻转 773eb631、暂存→交换→提交全链、零残留、settings md5 与 sessions 不变、绝对 applet 链接在场、引擎 `dsh web:` 起来）；issue 对账：关 #122/#123（各附根因与改动清单 + 复验指引），开 #125（自定义提供商能力发现跟踪），#124 回复保持开放（上游流式累加器，待复现数据） | AI 开发助手 |
| 2026-09-08 | 0.13.3 | **运行时替换事务化 + 解压面两处实锤修复（接续 HANDOVER-0.13.3-ISSUES-PERF）**：① `SnapshotTransaction.kt`（新）——`refreshSnapshot` 改为「暂存解压 → 原子交换 → 指纹提交」，标记 `.snapshot-transaction`（STAGED/SWAPPING/SWAPPED + moved 记账）；**用户数据从不移动/复制/删除**（旧 backup/restore 语义退役，`.dsh-backup` 仅作 ≤0.13.2 遗留一次性补写）；`recoverInterruptedRefresh()` 每次启动解析中断事务（前滚/回滚/丢弃）；② `SnapshotFs.kt`（新）NOFOLLOW 原语；③ `SnapshotExtractor` 新增 `runtimeRoot` 参数——放行指向 `files/usr/...` 的绝对符号链接（坑 45，否则暂存解压静默丢 9 条 applet 链），Termux 残留/`../` 逃逸仍拒；④ 权限归一化改在 `inject-all.py` 重打包层（坑 44：WSL 9p chmod 无效）；⑤ 看门狗 ProbeState/UndoGate 单飞/onDestroy 不杀引擎/engine.log 尾部读取（前轮未提交改动）；⑥ 单测 16 项（事务 9 + 解压策略 1 + 用户数据 5 + 文件模式 1）；manage 0.1.3（ui-tree 祖先回退修公开 id/原路径混用，3 项回归） | AI 开发助手 |
| 2026-09-06 | 0.13.3 | **0.13.3 开发批落地（W1-W10）**：壳侧 EngineAuth（P0/P1）/MuxClient remote.mux/setTextZoom 退役/vc30；构建链 overlay+抽验门禁+pi-drift-F1+model-sync；ui-responsive 0.1.13（store-rehome 适配：client-store 内联 + slots-augment + RUNTIME_STORE_EXEMPTION 退役——rc.1 loader module table 不再应答 client-runtime require 的 boot 硬阻断修复）；host-web-compat 0.1.9（withResolvers + 引用文件按钮）；运行时补丁重出（SPJ/ATT rename 回退）与退役（fs-local/primitives）；AI 实测 read 工作目录外文件 PASS | AI 开发助手 |
