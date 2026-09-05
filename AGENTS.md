# AGENTS.md — dsh-mobile-apk 开发地图

> **AI 主动更新条款（必须最先执行）**：本文件面向人类与 AI 开发助手，是唯一权威的仓库开发地图。**任何代码变更导致本文件描述失真（文件作用、函数签名、桥协议、构建命令、关键实现落点）时，AI 必须在本轮同步更新本文件，并在文末「更新记录表」登记（时间 + 版本号）。** 变更未触及本文件描述范围时无需更新（避免无意义改写）。若发现本文件与源码不一致，以源码为准并当场修正本文件——不要忽略。
>
> **过期风险声明**：代码演进可能快于文档更新，本文件内容可能过时；一切以源码为准。

---

## 1. 仓库概览与技术栈

- **角色**：DeepSeek Harness 安卓壳应用（包名 `com.dsharnessmobile.shell`）。
- **职责边界**：只保留安卓平台权能与桥——前台服务、看门狗、WebView、SAF 桥、快照解压与更新、崩溃回退闸门（UndoGate）、ADB 授权原生写面（AdbState）、审计、内置控制台、日志。**AI 可见能力全部来自插件**。
- **运行时形态**：壳内嵌 Termux 运行时快照（`assets/snapshot.tar.xz` → `files/usr` + `files/home`）；引擎（Node.js `@deepseek-ai/dsh`，基线 0.1.1-rc.2）监听 `127.0.0.1:3080`；WebView 加载引擎 Web UI。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **依赖**：androidx.activity-ktx / core-ktx、commons-compress、xz；Shizuku 零依赖反射（ShizukuSupport.kt，仅探活示例）。
- **兄弟仓库**（协调仓库下的子目录）：`dsh-shell-termux`（Termux 执行器）、`dsh-client-ui-responsive`（移动 UI 注入层 + F5 消费端）、`dsh-host-web-compat`（页面注入/兼容）、`plugins/`（dsh-android-bridge / -manage / -linux-env / -file-open，协调仓库内）、`vendor/`（dshmarketplace-plugin、dsh-undo-savepoint 固化副本 + PATCHES.md）。
- **上游** `deepseek-ai/deepseek-harness`（本地 checkout `dsh/`）：只读参考，**零改动**；一切适配以补丁层/插件/壳侧实现。
- **版本状态**：**0.13.1 已发布**（Release v0.13.1，versionCode 27，PR #113 合并；详见更新记录表与协调仓 AGENTS.md §1）。**0.13.2-preview 已发布**（versionCode 28，prerelease）。**0.13.2-fix 修复批实施中**（#118 引擎启动/探活/UndoGate 五项 + 悬浮球 v2 重设计 + v2.1 三窗口/待答卡片/状态模板批 + 设置页全屏（ui-responsive 0.1.12）+ #120 工作区，详见更新记录表）。当前开放跟踪：#115（市场 Phase2，目标 0.13.2）、#120（添加工作区按键不可用——修复批已实施，待发版验证）、#108（数据备份 feature）。
- **环境无关声明**：本文档适用于任意环境（Windows/WSL/Linux/macOS、有/无真机）开发维护者；环境差异点（WSL、ADB 真机、run-as）已在对应章节标注。

## 2. 构建与验证命令

```powershell
# 一键双 ABI（协调仓库根；快照→注入→门禁→gradle→out/）：
pwsh -File scripts\build-apk-013.ps1 -Suffix ""          # 产物 out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk
# 快照（Termux 源 + TARGETS 预装 + licenses + pnpm 装配 + 瘦身 + 归档）：
node scripts\build-snapshot-013.mjs <arm64|x86_64>
# 插件单测/冒烟：
node scripts\smoke-bridge.mjs                             # bridge 18 断言
cd ..\dsh-client-ui-responsive && npm test && npm run build
cd ..\plugins\dsh-android-<pkg> && npm run build
```

**门禁（build-apk-013.ps1 内）**：marketplace 修复校验（patch-marketplace.mjs）→ undo 移动端裁剪校验（patch-undo-mobile.mjs）→ 快照注入（inject-snapshot.py/inject-external-plugins.py）→ 权威 patch 覆盖（update-snapshot-patch.py）→ 挂载集⊇注入集（check-patch-mounts.mjs）→ 机密（check-snapshot-secrets.mjs，跨平台替代 .ps1）→ **第三方合规（check-third-party.mjs，GPL 义务）** → elf-check（校验快照 node ELF 架构，防坑 18）→ 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

**云端构建（0.13.0 起，宿主=本仓库，自包含）**：`.github/workflows/build-apk.yml`（`workflow_dispatch` 手动，matrix arm64/x86_64）托管整套构建链并只操作本仓库——快照从源重建（`base/` 底座归档为输入，Git LFS）、6 个缺 lib/ 的插件 npm 构建、注入/门禁/gradle 全部云端完成，仅 `upload-artifact` 供本地下载 debug，不出 Release；**不依赖协调库**（私库，GITHUB_TOKEN 无法签出）。`build-apk.mjs` 以 `DSH_APK_DIR=$GITHUB_WORKSPACE` 指向本仓库（gradle 在此）。本地仍在协调库根跑 `pwsh scripts\build-apk-013.ps1`（`scripts/` 前缀）。

**设备验证链路**（真机 arm64 vivo V2425A `10AF2B0GN0001F2`；模拟器 MuMu x86_64 `127.0.0.1:16416/7555`）：
- 安装：`adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore；**指纹变更触发 refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器实测 ~8 分钟，勿在解压中杀进程——中途杀进程看门狗会拿半解压运行时拉引擎，见坑 37）**）。
- 引擎探活：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`。
- WebView 调试：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `forward tcp:29225 localabstract:webview_devtools_remote_<pid>`（**每次重启 pid 变**）→ CDP ws 连接后 Runtime.evaluate 驱动（例子脚本见 `.deploy-tmp/cdp-*.mjs`；断言注意 input placeholder 不在 innerText 里）。
- 远程 RPC（测试面）：POST `/api/<method>`，body 必须全信封 `{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}`；`session.prompt` 拒绝 live 会话（被 UI 打开的）——直接 API 测代理需先用 session.create 建全新会话。
- **构建前核对 ABI（见坑 18）**：无真机环境用模拟器（MuMu x86_64 `127.0.0.1:16416/7555`），有真机则安装 ABI 匹配的 APK——debug 包默认带 x86_64 快照，覆盖装到 arm64 真机会引擎崩溃。

## 3. 环境无关的开发/维护流程（新人先读此节再动手）

> 本节与协调仓库根 `AGENTS.md` §2-4 对齐，但以壳子仓库为落点；**下列命令均在协调仓库根执行（除非注明「壳内」）**，shell 引用路径用 `scripts/` 前缀。

### 3.1 环境矩阵（先对号入座）

| 组合 | 快照构建（node scripts\build-snapshot-013.mjs） | 打包/门禁（pwsh scripts\build-apk-013.ps1） | 设备验证 |
|---|---|---|---|
| Windows + WSL | **必须在 WSL 跑**（Termux 源/依赖闭包需 Linux；见 3.4） | PowerShell 直跑 | ADB 真机 或 MuMu |
| Windows 无 WSL | **不可本地构建快照**（跳过 3.2 步 2，用已发布快照/CI 产物） | 可 | MuMu（debug 包默认 x86_64 快照可用） |
| Linux / macOS | 直接跑（无 WSL 层，路径用 `/`） | 直接跑 | ADB 真机（arm64 需匹配快照） |
| 无真机 | — | — | MuMu x86_64 `127.0.0.1:16416/7555`（装 x86_64 包） |
| 有真机 arm64 | — | — | vivo V2425A `10AF2B0GN0001F2`（**必须装 arm64 快照包**，坑 18） |

### 3.2 新环境起步流程（克隆 → 首包 → 装机验证）

1. **取代码**：clone 协调仓库（主分支 `main`）；壳子仓库 `dsh-mobile-apk/` 是**独立 git**（主分支亦 `main`），按需 clone/关联；上游 `dsh/` 只读。
2. **构建快照**（仅 Windows 需 WSL）：`node scripts\build-snapshot-013.mjs <arm64|x86_64>`——Termux 源装配 + TARGETS 预装 + pnpm + 权威 cordis patch 覆盖 + 瘦身 + 归档（产物 snapshot.tar.xz + snapshot.sha256）。
3. **一键打包**：`pwsh -File scripts\build-apk-013.ps1 -Suffix ""` → `out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk`；门禁失败会中断并提示（清单见第 2 节）。
4. **ABI 核对（坑 18）**：`aapt dump badging <apk>` 看 native-code，或解快照 tar 读 `usr/bin/node` 的 ELF e_machine（**62=x86_64，183=arm64**）——与目标设备一致再装。
5. **装机**：真机 `adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore，坑 10）；模拟器 `adb -s 127.0.0.1:16416 install -r -t ...-x86_64.apk`。**首装/指纹变 → refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器 ~8 分钟），勿杀进程（坑 37）**。
6. **验证**：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`；WebView CDP 与 RPC 信封写法见第 2 节。

### 3.3 改动流程规范（改哪个仓库、改完必做三件事）

| 改动面 | 落点 | 约束 |
|---|---|---|
| 壳层（桥/服务/看门狗/快照/权限） | 壳内 `app/src/main/java/com/dshmobile/shell/` | 提交在壳子仓库独立 git |
| 快照内容 / assets | 壳内 `app/src/main/assets/` | `snapshot.tar.xz` + `snapshot.sha256` **必须成对换**（坑 18） |
| 构建链 / 门禁 | 协调根 `scripts/` | 改后跑完整门禁；命令变更须同步本文档 |
| 安卓能力插件 | 协调根 `plugins/dsh-android-*` | `npm run build` 通过；重装配须「权威 patch 覆盖 + 冷启动」（坑 19） |
| UI 注入层 | 协调根 `dsh-client-ui-responsive/` | `npm test && npm run build` |
| 执行器 / 页面兼容 | `dsh-shell-termux/`、`dsh-host-web-compat/` | 装配进快照 |
| 上游引擎 | 协调根 `dsh/` | **禁改**（只读参考）；一律以补丁/插件/壳侧适配（vendor/ + PATCHES.md） |

**每次改动关闭前必做三件事**：
1. **文档同步**：本文件描述失真处当场更新 + 文末「更新记录表」登记（时间/版本/内容/更新者）。
2. **GPL 合规**：新增依赖登记 `scripts/third-party-licenses.json` + `THIRD_PARTY_NOTICES.md`（80 组件矩阵）；copyleft 全文三形态在场（快照 `usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`）；`check-third-party.mjs` 不过即拒打包（第 7 节）。
3. **PR 规范**（pr-guidelines）：标题 `<type>: <描述>`（`fix:`/`feat:`/`docs:`/`chore:` 等，type 与主标签一致）；每个 PR 1-3 个标签；破坏性变更 type 后加 `!`。
- **禁用 emoji**：提交信息、PR 标题/描述、文档一律不使用 emoji（以文字描述代替，如「机密」而非锁形 Emoji）。存量文档中的 emoji 随触碰逐步清除。

### 3.4 环境差异点速查（踩坑对照）

| 差异点 | 现象 / 规则 | 出处 |
|---|---|---|
| WSL（Windows 特有） | 快照构建必须在 WSL（tar 解压/符号链接/relocate 需 Linux 语义）；Windows 直读 WSL 9p 文件 = EACCES，校验走 `wsl tar -tvf` 视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤 | 坑 6 |
| ADB 真机特有步骤 | 同签名 debug.keystore 才能覆盖安装；配对走真实 `adb pair`、码值只进 argv（第 4 节 AdbState.kt）；CDP 每次重启 pid 变 | 坑 10/14、第 2/4 节 |
| run-as 限制 | run-as 裸环境无 termux-exec 钩子 → `not executable: 64-bit ELF` / `CANNOT LINK` 是**假错误**；验证快照内二进制须带全套引擎 env（`LD_PRELOAD` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`） | 坑 22 |
| PowerShell 转义 | 双引号内 `$var` 本地展开（引号地狱）；二进制经 `adb exec-out`/push 传输 | 坑 8 |
| ABI 匹配 | debug 包默认 x86_64 快照，装 arm64 真机必崩；构建/安装前核对（3.2 步 4） | 坑 18 |

## 4. 目录与源文件作用（关键函数带代码位置；文件行数随版本变化，以函数名为准）

`app/src/main/java/com/dshmobile/shell/`：

| 文件 | 作用 | 关键点（0.13.0 定稿） |
|---|---|---|
| **AdbState.kt** | ADB 授权单一事实来源 + **真实通道**（内嵌 termux android-tools adb 36） | `pairWithCode(code,pairPort,connectPort)`：真执行 `adb pair 127.0.0.1:<port> <code>`（**码值只进 argv**，审计只记 codeLength；配对成功才写 paired+端口）；`revokePair`：disconnect+删 adbkey+清 paired（系统侧授权需无线调试重开才彻底清除——设置页文案说明）；`adbShellExecute` 真实 shell（uid=2000，失败关闭+幂等重连）；prefs 键 allowSwitch/paired/pairPort/connectPort/connected/**fullAccess（门1 live 键，0.13.0 Q8 判定一致化）**；`discoverPorts`：系统属性直读 → **NSD/mDNS（`_adb-tls-pairing._tcp`/`_adb-tls-connect._tcp`，5s 超时）** → 手动硬回退（盲扫已剔）；`runAdb` 用 engine.shellEnv()+OPENSSL_CONF 覆盖（同 UndoGate 修复） |
| **FileIncoming.kt** | F5 文件直达：校验/净化/拷贝/元数据/清理 | `copyIn` **200MB 有界拷贝**（R17）；`sanitizeName/uniqueName/validate`；`tmpWorkspace=files/home/.dsh/workspaces/incoming`；`cleanupTmp` 生命周期礼仪 |
| **UndoGate.kt** | 崩溃自动回退（F3）：看门狗连续失败→急救 CLI restore-last-good | `runCli` **必须注入 `OPENSSL_CONF=<usr>/etc/tls/openssl.cnf`**（快照 node 编译期 cnf 路径不可读→无输出→误判无快照）；幂等标记 `.undo-auto-done` |
| **EngineManager.kt** | 引擎总管：解压/指纹/环境/进程/补丁 | `shellEnv()`：PATH/LD_LIBRARY_PATH/HOME/DSH_HOME/TMPDIR/LD_PRELOAD(+termux-exec force)/TERMUX__PREFIX/SSL_CERT_FILE/DSH_ADB_*/DSH_ADB_FULLACCESS（=壳侧 fullAccess() 同源）/密钥注入；`refreshSnapshot` 指纹差异→备份→重解压→还原用户数据（白名单：sessions/storages/attachments/credentials/settings 等，**profiles 不回灌、跟随快照**）；**`snapshotRefreshing` companion 级闸门（0.13.2-fix 三批）**：刷新期 startEngine 直接跳过——看门狗自愈路径无此闸门时会拿「解压到一半的运行时」拉引擎（实例分属 MainActivity/EngineService，标志必须挂 companion，同 STARTING CAS 道理）；`killExistingEngine`（destroyForcibly+pkill bin.js）；90s 冷却窗探活绕过 |
| **EngineService.kt** | 前台服务 + 看门狗 | watchdog 5s 探活 + UndoGate 触发 + 唤醒锁续期/释放 + onTaskRemoved 清理（F5 生命礼仪） |
| **MainActivity.kt** | 主界面/桥接线/意图处理 | `maybeProcessIncoming`（VIEW/SEND→FileIncoming→POST /api/android/file-incoming）；AndroidBridge 接线含 `onSetAdbPair={code,pairPort,connectPort->AdbState.pairWithCode}`；`onRevokeAdbPair`、`onAdbShell` |
| **AndroidBridge.kt** | `window.androidBridge` 协议 v1 | `setAdbPair(code,pairPort,connectPort):Boolean`（**3 参**）、`getAdbState()`、`adbShell(cmd)`、`requestAllFilesAccess/hasAllFilesAccess`、`pickToken` 鉴权、`openNativePath`（FileProvider 白名单） |
| **SnapshotExtractor.kt** | tar 解压（x-zip→filesDir、symlink、exec 属性戳印）+ **zip-slip 防护**（resolveEntry 拒绝 .. / 绝对路径 / 越界 symlink） | `extract()` |
| **UpdateManager.kt** | 在线快照更新（第一版） | usr→usr-old 两步切换 + 指纹写 |
| **WatchdogV2.kt** | 引擎看门狗（v2） | 连续失败熔断；boot 恢复用户同意状态 |
| **ShizukuSupport.kt** | Shizuku 反射探活（仅示例；真实通道走 adb 二进制路线，Shizuku 源码作参考存主仓库 .deploy-tmp/shizuku-adb/） | — |
| **ConsoleActivity/ConsoleSession** | 内置终端 | 环境与引擎一致 |
| **LogCollector.kt** | 调试日志收集 | 日文件轮转；审计另见 AdbAudit（files/audit/audit.ndjson） |
| **EngineProbe.kt** | 本地引擎探活（0.13.2-fix 重构）：应用级状态唯一判定源 | `check()` **全链 Proxy.NO_PROXY 直连**（#118：系统代理劫持本地探针实锤——WebView/curl 豁免代理而 HttpURLConnection 走 ProxySelector → 请求发往代理网关恒 timeout）；`portReachable()` TCP 端口级判定（HTTP 未就绪 ≠ 引擎死亡）；error 区分 **timeout（代理吞请求/慢启）vs refused（端口未开=真死）** |
| **OverlayService.kt** / **OverlayController.kt** | 悬浮球 v2.1（0.13.2-fix 二批；v2 交互在其上重构为**三窗口架构**）：**球窗 34dp**（NOT_FOCUSABLE+NOT_TOUCH_MODAL+ADJUST_NOTHING，尺寸/标志全程不变——互吞与错位根治）；**光环窗 50dp**（NOT_FOCUSABLE+NOT_TOUCHABLE 纯视觉，radial 辉光半径 24dp≤半窗 25dp；**50dp=2×(贴边 margin 8dp+球半径 17dp)——贴边时窗口恰内切屏幕不被 WMS clamp**；旧 64dp 贴边越界 7dp 被 WMS 整窗平移回屏（dumpsys 实锤请求 x=-14→frame x=0）=「吸边后球/光环中心错位 14px」，2026-09-05 三批修）；四态 IDLE 白/WORKING 蓝/PENDING 琥珀/ERROR 红；**面板窗**（独立 focusable TYPE_APPLICATION_OVERLAY+NOT_TOUCH_MODAL，宽 min(屏宽-球-64dp,400dp)，**SOFT_INPUT_ADJUST_PAN**——键盘弹出系统原生上推面板、球不动；非相交 overlay 窗收不到 IME insets 已实测，勿再做自管 insets）；收起=纯黑白球+光环、展开=圆角矩形面板（会话选择器/状态行/输入行同 v2） | 双维状态解耦保留（EngineProbe 探活 + live 流 turn_start/tool_call/turn_end busy 会话感知）；**光环状态派生唯一权威 deriveHalo()**（探活 tick 与事件渲染共用——探活自带判定不带 PENDING 项会每 10s 把待答琥珀盖回白=「必须展开才见黄」，2026-09-05 三批修）；**乐观置忙 markBusyOptimistic**（发送成功/应答提交即亮工作态补 live 空窗——live 流原本无起轮事件，发送到首 tool_call 间壳侧失聪显「空闲」；45s 无 live 事件由探活兜底回退）；**PENDING 审批/提问走 MuxClient WS 下行**（见下行），卡片官方风格：问题卡=题头+加粗题干+编号选项行+✎ 自定义输入+‹n/n› 翻页+跳过/下一题/提交，审批卡=工具+理由+批准一次/拒绝；应答 POST /api/respond 全信封（approval value={sessionId,approvalId,outcome}；question value={sessionId,answer:{answers:[{id,selected[,custom]}]}}——**selected 用选项 label 非 id**、顺序匹配 questions；question 取消发 ok:false error cancelled，approval 无取消通道）；状态文案模板 prefs 化（overlay_display：template_thinking "Deep diving..." / template_tool "{tool} · {summary}"，摘要取 args 命令/路径等键值折叠空白前 24 字符）；拖动 clamp/弹簧用窗口实际宽高（「展开拖动只有光环动」根因=按球径 clamp 致 WMS 重新贴边）；positionPanel 随球同步（右溢出翻左侧）；debug 待答注入：`echo question\|approval\|clear > files/home/.dsh/.overlay-test-pending`（FileObserver 消费，debuggable 门控）；关闭钮独立 ✕ 图标（dsh_ic_close.xml）；引擎页避让帧保留 |
| **MuxClient.kt** | 引擎事件 mux WS 常驻客户端（0.13.2-fix 二批新增） | 手写 WS（Socket 握手 + **SHA-1 Sec-WebSocket-Accept 校验（首版 substring 前缀比较永不匹配致静默失败，实锤）** + 服务器帧解析 + 掩码控制帧 pong/close + 分片续帧缓冲）；连 `ws://127.0.0.1:3080/api/events.mux`（loopback 免 token；**下行专用**——客户端发消息被 1008 拒；重连后仍 PENDING 的帧同 rpcId 重放）；指数退避 1s→10s 重连、逐次 Log.w（tag dsh-overlay-mux）；帧回调 OverlayService.handleMuxFrame 增删 pendingApprovals/pendingQuestions 映射（approval/requested|resolved、question/requested|resolved） |
| **ShimmerTextView.kt** | 官方「Deep diving...」品牌蓝渐变扫光文字（0.13.2-fix 新增） | 复刻官方 ChatView.module.css .turnStatus：LinearGradient shader（D500 #4176E6 / D200 #D3E2FF，宽 2.5W，translate −1.5W→0，1.8s linear infinite）+ ValueAnimator；reduced-motion 三 scale==0 时静态渐变 |
| **AdbKeyboardService.kt** / **AdbKeyboardReceiver.kt** | 内嵌 ADBKeyboard 协议 IME（0.13.2 W6） | ADB_INPUT_TEXT/CLEAR 广播 → commitText；实例活跃才提交（canCommit） |

`app/src/main/assets/`：`snapshot.tar.xz`、`snapshot.sha256`、`undo-emergency.mjs`（急救 CLI，UndoGate 用）、`licenses/`（LICENSES 标准文本 + THIRD_PARTY_NOTICES.md，GPL 合规 A2）、`console.html`。

## 5. 桥与通道说明

| 层 | 通道 | 语义 |
|---|---|---|
| 页面 → 壳 | `window.androidBridge` | ADB 授权变更**唯一**入口（setAdbAllow/setAdbPair/revokeAdbPair——被提权方不得自改授权，Shizuku 对照）；目录/图片 pick（token）；全文件访问；重启/控制台 |
| 壳 → 引擎 | HTTP 127.0.0.1:3080 | 文件直达 POST；pick 端点；**只读**状态端点（/api/android/privilege/status） |
| 引擎 → 插件 | cordis 服务面 | androidPrivilege（状态机/execAdbShell/execAdbLine/gateFor 会话级 danger）；dsh-shell-termux 执行器 |
| 插件 → 页面 | dsh.client 模块 + slots | ui-responsive（AppFrame/DevSection/settings.dev.item/F5 消费端轮询）；bridge client（AdbAuthSection 双端口配对 UI）；undo/marketplace 注册 |

**授权模型（定稿）**：引擎级 = 门1 All Files Access（**live prefs 键 `fullAccess`，壳 syncFullAccess 写入；env DSH_ADB_FULLACCESS 仅兜底**——0.13.0 Q8 不再重启生效）+ 门2 允许开关（live prefs）+ 门3 真实配对（adb pair 握手）；会话级 = `gateFor(exec.agent.session)` 实时 resolve，**ADB 能力（含观察类）仅 danger-full-access**，自动审批不参与；写面唯一在壳侧原生 AdbState（桥/引擎只读 live `dsh-adb.xml`）。

## 6. 关键实现细节与坑（每次踩坑必须登记）

1. **realpath 前缀混用（B7 运行时表现，已修）**：Android 上 `/data/user/0` 可能是 `/data/data` 的软链——只把「文件侧」realpath 后再与未 realpath 的 ws 比较必拒。修复：`safeResolveInside` **两侧都 realpath**（ws 侧失败按原样参与），symlink 目标按 `dirname(rel)` 解析（`../../LICENSES` 从 `doc/<pkg>/` 出发 = `share/LICENSES`）。**新路径校验代码一律双侧规范化。**
2. **会话 header meta 白名单**：`Session.create(meta)` 的 `origin` 只允许 `"subagent"`——自定义值报 `session header origin must be "subagent"`；只写白名单键（如 `cwd`）。
3. **surface 事件必须带 surfaceOp**：`user/message` 等 surface-eligible 事件 append 需第 3 参 `{surfaceOp:'append'}`，否则 `requires a surfaceOp marker`。
4. **pnpm 是市场安装的硬依赖（已固化进快照构建）**：`dsh plugin add` spawns `pnpm`（apps/cli plugin.ts）；快照缺 pnpm → `pnpm not found on PATH`；且**陈旧 pnpm 状态记录**（base-dsh 里的 `.modules.yaml`/`.pnpm-workspace-state`/`pnpm-lock`）指向旧 store → `ERR_PNPM_UNEXPECTED_STORE`——build-snapshot-013.mjs 已装配 pnpm 10.12.1 standalone（npm tgz + `usr/bin/pnpm` shim）并清理这三种记录。**市场目录里的部分插件（如 humanizer-ru）不在 npm，安装 404 属上游目录数据，不是本链路缺陷。**
5. **快照 node 需要 OPENSSL_CONF**：运行快照内 node 时务必与 UndoGate 同样注入（否则 OpenSSL config error 静默吞 CLI 输出）。
6. **Windows 侧读 WSL 9p 文件 = EACCES**：stage 文件不可直 stat/read；校验类代码走 `--tar`（wsl tar -tvf 带大小）视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤。
7. **npm registry 元数据可能缺 dist.sha512**：pnpm tgz 完整性校验「在场则严格，缺席降级警告」。
8. **run-as 引号地狱 / adb 二进制传输**：PowerShell 双引号内 `$var` 本地展开；二进制经 `adb exec-out`/push 传输。
9. **template 字符串反斜杠**（页面注入）：`\n` 双写。
10. **签名一致性**：debug.keystore 固定，否则覆盖安装失败。
11. **CDP 断言注意**：input placeholder 不在 innerText（查 `[placeholder]`）；「live 会话禁止 API prompt」；`session.list` 的 stats 字段（turns/llmMs）判断代理是否真跑。
12. **引擎级 OPENSSL_CONF 曾有缺口（2026-08-24 真机实锤，已修）**：快照 node 编译期硬编码 OpenSSL 配置路径 `/data/data/com.termux/files/usr/etc/tls/openssl.cnf`（app 域不可读）——`shellEnv()` 未注入 OPENSSL_CONF 时，**任何 node/npm 子进程（agent 工具调用）启动即 OpenSSL configuration error 退出**；引擎本体侥幸存活（不触发该初始化的路径）。修复 = `shellEnv()` 加 `OPENSSL_CONF=<usr>/etc/tls/openssl.cnf`（与 UndoGate/AdbState 统一；坑 #5 是本坑在 CLI 面的显式版）。
13. **apt/dpkg 编译期路径（issue #80，2026-08-24 重写）**：apt/apt-get/dpkg 二进制内置 `/data/data/com.termux/files/usr` 编译期路径。`-o Dir::Etc=...` 参数覆盖不了 apt.conf.d 早期扫描（仍报 Permission denied）；**有效方案 = APT_CONFIG 主文件**（build-snapshot-013.mjs 7d 段生成 `usr/etc/apt/apt.conf`，wrapper 统一 `export APT_CONFIG`）——注意 `K='...$B...'` 单引号不展开曾令 wrapper 失效。**dpkg 的 SYSCONFDIR（dpkg.cfg.d 配置目录）无 env 可覆盖**（strings 证实无 DPKG_CONFIG_DIR 变量；`--admindir/--instdir` 不覆盖）→ apt 在线安装 dpkg 阶段受限；`scripts/check-prefix-residue.sh` 设备端自检验证。
14. **配对伪成功防御（2026-08-24 真机实锤）**：`nativeBridge()?.setAdbPair?.()` 可选链在桥缺失/方法缺失时返回 undefined → `ok === false` 恒 false → 前端误报「配对完成」——**显式检查 `typeof b.setAdbPair === 'function'` 且无函数即 throw**。设置页两端口输入框是必经项，用户嫌手动抄录——0.13.0 起端口发现用 **NSD/mDNS**（AdbState.discoverPorts：系统属性直读优先 → `_adb-tls-pairing._tcp`/`_adb-tls-connect._tcp` NSD 发现（5s 超时）→ 手动输入硬回退；盲扫 37000-45999 已剔除，Q17）。
15. **临时工作区面板不可见（issue #60，2026-08-24 已修）**：workspace registry 只从**既有会话 cwd** bootstrap——无会话时「临时工作区」不出现在工作区面板。修复：dsh-android-file-open apply 时 `workspaceRegistry.create(tmpWorkspace(), '临时工作区')`（幂等复用）。TTL 清理（7 天）壳侧 FileIncoming.sweepExpired（启动 + 每次入队前）。
16. **老内核 ES2022 polyfill（issue apk#81/#79）**：华为/荣耀/小米定制 WebView（Chromium<92）缺 `Object.hasOwn`/`Array.at`/`String.at` → 前端加载插件报 "Failed to load plugins"。polyfill 注入点 = `assets/patched/web-frontend-index.html` `<head>` 首个 script 之前（引擎 applyAssetPatch 用它替换内核 index.html）；**升级 dsh 后其模块脚本哈希（index-ClqxG24t.js）须同步更新**。
17. **错位目录（issue #80 P5）**：relocate-snapshot 曾把包内绝对路径 `/data/data/com.termux` 当相对路径搬进 usr 树（`usr/data/data/...`）——纯冗余；构建链 7e 无条件删除 `usr/data`。
18. **debug APK 默认 x86_64 快照（2026-08-24 本日重大事故）**：`app/build.gradle.kts` mergeDebugAssets 注释写死「从 GitHub Releases 下载 snapshot-x86_64.tar.xz 放 assets」→ `app-debug.apk` 内快照是 x86_64；**装到 arm64 真机覆盖终版后引擎崩**：`error: "/data/data/.../usr/bin/node" is for EM_X86_64 (62) instead of EM_AARCH64 (183)`。核对方法：解快照 tar 读 `usr/bin/node` 的 ELF e_machine（62=x86_64，183=arm64），或 `aapt dump badging <apk>` 看 native-code。修复/预防：构建/安装前核对设备 ABI 与快照 ABI；换 arm64 快照须**同时替换** `assets/snapshot.tar.xz` + `snapshot.sha256`（指纹变→refreshSnapshot 全量重解压 2-4 分钟，勿中断）。
19. **cordis.patch.yml 装配缺陷**：基座 cordis.patch.yml 只含 shell-termux/host-web-compat/ui-responsive——0.13.0 新增的 android-bridge/android-manage/android-linux-env/android-file-open/undo-savepoint/marketplace **从不进入快照装配** → 引擎不加载这些插件（`/api/android/file-incoming` 404、ADB 设置项缺失、通知事件桥无宿主）。修复：build-snapshot-013.mjs 7b2 用 `scripts/profile-web.cordis.patch.yml` **权威覆盖**快照内同名文件（缺失即 `process.exit` 拒发）。**注意**：真机热改 cordis.patch.yml 后必须**冷启动 app**（`am force-stop` + start）才重装配——watchdog 热重启引擎不重读 profile（只重跑 node）。
20. **EngineService 挂载缺失**：startEngineService 只在 startEngineFlow 首次轮询成功时调用——**引擎先跑、app 后启动（热启动/恢复）时服务从未启动 → watchdog 缺失 → 通知消费（task-done 标记）/自动回退/唤醒锁全链路失效**。修复：MainActivity `onResume` 幂等 `startEngineService()`。
21. **通知链路三缺（2026-08-24 用户实测「任务完成没通知」根因）**：① 引擎事件桥缺失（前端 showNotification 桥无调用方，F0.3 部分实现=以前未做）——补：dsh-android-bridge 监听 `ctx.on('session/event')` 捕获 `assistant/message` → 写 `files/home/.dsh/.task-done.ndjson` 标记；② WatchdogV2.consumeTaskDoneMarkers 消费标记 → `NotifyCenter.notify`（deepProbe 成功路径顺带；JSON 解析失败会丢通知——务必确保标记是 `JSON.stringify` 合法 JSON）；③ EngineService 必须挂载（见坑 20）。验证：`files/notify-debug.log` 落盘每步（诊断时开）；通知 id=`("dsh-"+category).hashCode() and 0x7fffffff` 稳定正数。
22. **免 hooks 环境 ELF 不可执行**：`adb shell run-as ... /usr/bin/<bin> | head` 会报 `not executable: 64-bit ELF file` / `CANNOT LINK ... library libandroid-support.so not found`——因为 run-as 裸环境无 termux-exec LD_PRELOAD 钩子与 LD_LIBRARY_PATH。**验证快照内二进制必须带全套引擎 env**（`LD_PRELOAD=libtermux-exec-ld-preload.so` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`）。这是「run-as 测出假错误」的常见来源（如 node/npm/adb）。
23. **通知 debug 落盘**：WatchdogV2.consumeTaskDoneMarkers 写了 `files/notify-debug.log`（诊断用，**保留**——是排查通知链路的关键工具）。
24. **adb client 冷启动 server 必败（2026-08-27 真机实锤，已修）**：termux-exec/Linker64 重路由环境下，`adb pair` 首次调用自动起 server（fork-server）时握手坏——client 打印 "* daemon started successfully" 后读不到应答，报 `error: protocol fault (couldn't read status message)`，**配对必失败（用户侧观感"光速报错"）**。对照实验证明：client 直连**已存在**的 server（`adb server nodaemon` 常驻）时 pair/connect 全部正常（同码同端口复刻 2/2 成功）。修复 = AdbState 壳内自管常驻 server（runAdb 前 `ensureAdbServer`：spawn `server nodaemon` + 5037 探测 + 日志落 `files/home/adb-server.log`）+ `retryRunAdb`（protocol fault 时毁 server 重建重试一次）；pair 失败首行错误文本入审计（不含码）。另：discoverPorts 同步 NSD 等待 5s 会卡配对页 UI（bridge 同步调用链）——超时压到 2s + 启动后台预取 + 15s TTL 缓存（`cachedPorts`），bridge 缓存优先。**补锤**：app 域直接 exec app-data ELF 恒 EACCES（error=13，server/client 双双中招，审计 error 字段实锤），spawn 一律走 `spawnAdb`（捕获 Permission denied 降级 `/system/bin/linker64` 加载——EngineManager.startWithArgs 同机制）。
25. **配对码窗口被自家冷启动链耗光（2026-08-27 复盘实锤，三探针 logcat/audit/adb-server 时间线定案，已修 F1+F2+F3+F4）**：系统「使用配对码配对」弹窗的端口仅在弹窗存活期监听；用户点「配对」后壳侧才冷启动（linker64 加载 ~3s + 回收配对后密钥删除触发全新 RSA keygen + 首轮 client 握手竞态必吃 protocol fault 再自愈重建），合计 7 秒以上，拨号时窗口已关 → 恒 `Connection refused`（pairing_client.cpp），用户在系统弹窗上点什么都不救得回来。修复四件套 = **F1 常驻预热**（`AdbState.prewarm`：getAdbState 轮询钩子/onResume 后台线程拉起，60s 节流；**密钥生成移出关键路径**——回收配对会删 `$HOME/.android/adbkey*`，下次任何连接都会重新生成）+ **F2 真实就绪判定**（5037 bind ≠ 可服务：`ensureAdbServer` 放行条件收紧为一次真实 `devices` 客户端往返通过，`serverReady` 标志贯穿 spawn/复用孤儿/self-heal 三路径）+ **F3 结构化配对结果**（`setAdbPair` 返回 JSON `{ok, reason, message}` 替代 Boolean，壳侧 `classifyFailure` 归因 window-closed/protocol-fault/server-not-ready/handshake-timeout 等）+ **F4 前端分流**（AdbAuthSection 轮询不再抹操作报错——双通道 pollError/actionError 且后者留存 15s；失败不清空输入框；文案按 reason 分流，refused 明示「窗口已关闭请重开弹窗」而非误导性「核对 6 位码」）。
26. **vivo SELinux 拒读无线调试属性（2026-08-27 logcat 实锤）**：untrusted_app 读 `service.adb.tls.pairing_port` / `service.adb.tls.port` 触发 `avc denied { read } adbd_prop`——AdbState.discoverPorts 的「系统属性直读」优先路径在 vivo OriginOS 上恒失效（异常路径静默吞掉无感知），实际全靠 NSD/mDNS 兜底。勿据此属性在 vivo 上做正确性假设；后续若在此设备上看到直读成功属 ROM 变更，需回归。
27. **引擎侧页面误调 openNativePath（2026-08-27 记录在案）**：logcat 出现 `dsh-image: openNativePath: not exists: 自动扫描系统无线调试的配对/连接端口…`——引擎 UI 包把按钮 title 文案当路径传给了桥调用。壳侧安全拒绝 no-op 无实害；根因在上游引擎页面包（非本仓库管辖），升级引擎时留意。
28. **dsh-shell run() 返回 CollectedOutput 结构体（2026-08-27 活体插桩实锤，已修）**：`shellFace.run()` 契约返回 `{stdout:{text,truncated,spillPath?}, stderr:{…}, exitCode,…}` 而非字符串（引擎内置 bash 工具经 `streamText(output).text` 同款读取）。插件历史代码 `String(r.stdout)` 直取 → 恒 `"​[object Object]"`：**进程真实执行（审计恒 ok）、模型转录全毁**，并连带 device_info 满屏 `?` 占位（拿乱码 grep MODEL= 零匹配）与 lossless 拒收（可选字段 undefined 成员被引擎整值拒绝）。修复 = `collectText()` 解包 + `pickText()` 类型闸 render（非 string 一律 JSON 转写，杜绝 [object Object] 再入转录）+ 可选成员空串兜底。**伴生雷**：NSD 抓的连接端口随无线调试重启轮换（37575 失联实锤）→ `resolveLivePort()` 配置端口失效即回退 5555。**排障方法论沉淀**：①疑似「改码不改行为」先杀引擎进程再验——`force-stop` 后可能有孤儿 `node -`（linker64 链）幸存占 5037/3080 继续用旧模块（/proc 扫 cmdline 对照注入 mtime）；②设备端插件注入用 base64 分块 `printf %s >> ` 通道（MSYS /tmp 不跨执行块存活，stdin 管道会截断）；③插桩指纹（状态消息缀 ⟪标记⟫）一次往返即可判定加载版本。
29. **引擎会话档位为事件溯源、按会话隔离（2026-08-27 澄清，非缺陷）**：UI 档位选择器写入会话日志 `sandbox/mode` 事件（`effectiveSandboxMode` fold，最后一条生效），重启经重放恢复、两会话互不可见；`session.list` projections.permissions.currentValue 为真值。状态端点显示的 `writeMode=workspace-write` 仅部署默认（装配 yml shell-termux config），工具实际放行以会话档位为准（gateFor→sandboxPolicy.resolve）。勿把部署默认当死锁。
30. **ps1 双 ABI 循环后 assets 停留 x86_64（2026-08-29 实锤，坑 18 现代版）**：build-apk-013.ps1 循环内按 ABI 覆盖 `assets/snapshot.tar.xz`，循环结束留在 x86_64——此后直接 `gradlew assembleDebug` 的 debug 包即 x86 树，装 arm64 真机报 EM_X86_64（本轮已踩）。铁律：真机安装只用 ps1 对应 ABI 命名产物；存疑时 `od -A d -j 18 -N 2 -t u1` 读 node ELF 机器码（183=arm64/62=x86_64）。
31. **force-stop 杀不死 linker64 回退子进程（2026-08-29 vivo 实锤，0.14 修复）**：升级后旧引擎孤儿存活 → 双引擎抢 3080（探活打到旧引擎、新引擎 bind 失败循环；两代 engine.log 交错误导排障）。真机找引擎 `ps -A | grep linker64`（进程名非 node，pidof node 必空）；处置：run-as kill 全部 linker64 → 看门狗 ~7s 自愈。`pkill -f bin.js` 在 vivo 疑似不生效（坑 28 排障方法论①的 /proc cmdline 扫描为可靠手段）。
32. **adb forward 静默失效（2026-08-29 实锤）**：APK 重装/USB 重枚举后宿主 forward 清空 → 宿主探活 000，但设备内正常（用户 WebView 秒起）——「引擎挂了」的判断必须先 `adb forward --list` 再重 forward，否则误诊。
33. **系统 HTTP 代理劫持壳侧本地探针（#118 根因1，2026-09-02 实锤）**：WiFi 配置系统代理时，`HttpURLConnection.openConnection()` 默认走 `ProxySelector` 下发的系统代理 → 把 `127.0.0.1:3080` 的本地请求发给代理网关（回不来本机）→ 探针恒 timeout；而 WebView（Chromium 对 loopback 豁免代理）与 curl（不读系统代理）直连正常 → 「网页能开、app 却判引擎没起来」的矛盾现场。修复 = **壳侧所有本地引擎端口调用一律 `openConnection(Proxy.NO_PROXY)`**（EngineProbe / file-incoming / session.export / session.cancel；UpdateManager 的远程下载**不走** NO_PROXY），且诊断包 probe 字段区分 timeout/refused。
34. **UndoGate.runCli 直接 exec app-data ELF 无 linker64 fallback（#118 根因2，2026-09-02 修）**：`runCli` 直接 `ProcessBuilder` exec `usr/bin/node`（对比 `EngineManager.startWithArgs` 有 `/system/bin/linker64` fallback）——Android 15+ 拒绝直接 exec app-data ELF → error=13 → auto-undo 从未真正执行。修复 = 与 startWithArgs 同款：捕获「Permission denied」降级 `linker64` 加载（`build` 复用 shellEnv/OPENSSL_CONF/redirectErrorStream）。
35. **requestLegacyExternalStorage 对 targetSdk≥30 应用无效（#120/MT 调研，2026-09-02 实锤）**：该 flag 仅对「targetSdk≤29 + 运行在 Android 10」生效；targetSdk≥30（含 34）应用即使运行在 Android 10 设备上 flag 也被忽略（SO 63365334 / cgeo #10386 / 小米适配指南多源实锤）→ Android 10 上 SAF 树授权不解锁 FUSE 原始路径、bash 走不了 ContentResolver → 非 root 下「读用户任意目录作工作区」不可达成。落地：SDK 26-28（无分区存储）运行时 READ/WRITE 权限放行；SDK 29 保留拒绝但显式 reason（`__dsh_pick_refused__:android-10`）而非伪装取消；SDK 30+ 维持 All Files Access。
36. **自包含内置子仓副本必须与协调仓同版（2026-09-02 实锤）**：本仓库是**云端自包含构建宿主**（`.github/workflows/build-apk.yml` 依赖 `$GITHUB_WORKSPACE`=本仓库，不签协调私库），仓库内自带整套子仓副本（`dsh-shell-termux`、`dsh-client-ui-responsive`、`dsh-host-web-compat`、`plugins/dsh-android-*`）。**协调仓改动这些子仓的源码或 bump 版本后，必须把产物同步进本仓库对应子目录（src + package.json + lib/），否则自包含链（云端构建 + `gradlew assembleDebug` 直打）注入的是旧副本**——设备上表现「悬浮球开关消失 / ADB 面板缺失 / #120 拒绝信号缺席 / 配置导入导出按钮消失」这类**功能性缺失但编译通过**的幽灵缺陷。0.13.2 实测：协调仓 ui-responsive 0.1.11 含悬浮球开关、apk 仓副本 0.1.9 无它（DevSection 少了 W7 悬浮球开关行 + 配置导入导出块）；host-web-compat 0.1.8 vs 0.1.6（#120 拒绝信号缺席）。**教训：凡协调仓动了这三个独立子仓/bridge/manage，发布前必须比对两个仓库的 package.json version + 抽验 apk 仓副本 lib/client.js 关键字符串（如「悬浮球」），不一致即用 robocopy 从协调仓同步**（`robocopy "<协调仓子仓>" "<本仓\<同名子目录>" /E /XD .git node_modules /XF *.tgz`，lib/ 必须一并拷入——自包含链不对这些子仓执行 npm build）。
37. **快照刷新中途杀进程 → 看门狗拿半解压运行时拉引擎 → 用户 settings 被剪（2026-09-05 三重实锤）**：① refreshSnapshot 全量解压在模拟器实测 **~8 分钟**（44805 文件；流式逐文件覆盖——「bridge mtime 已新」≠ 完成，**唯一完成标志 = `.snapshot-fingerprint` 翻转新值 + `.dsh-backup` 消失**，中途抽验必误判）；② 解压中 force-stop → 无闸门的看门狗 5s 一拍用「半新半旧运行时」spawn 引擎（12:45:26 补丁日志实证）→ 混合态引擎的 settings 归一化把 `llm-pi-ai.providers`（**用户自定义供应商 Hy3/opencode-go 挂此**）剪成出厂空模板，且后续刷新备份忠实保留损坏结果；③ 恢复通道 = `undo-snapshots/auto/<最后好版本>/home-settings.yaml` 拷回 `.dsh/settings.yaml` + 重启（.credentials.yaml 的 apiKeyEnv 引用未受损）。**修复**：`EngineManager.snapshotRefreshing` companion 级 @Volatile 闸门（MainActivity/EngineService 各持实例字段互不可见，同 STARTING CAS 道理），刷新期 startEngine 直接跳过、finally 清标志。**升级/排障铁律：装新包触发重解压期间，禁 force-stop、禁拔 USB、禁 adb reboot（协调仓雷点 1 同源）。**

## 7. GPL 合规（2026-08-23 定稿）

- 快照包：`usr/share/doc/<pkg>/copyright`（多数为软链 → `usr/share/LICENSES/<fam>.txt`）或 COPYING* 实体文件；`licenses` 包在 TARGETS 显式锁定（x86_64 曾漏带）。
- 仓库：`LICENSES/`（GPL-2.0/3.0、LGPL-2.1/3.0 全文）+ `THIRD_PARTY_NOTICES.md`（80 组件矩阵，含源码要约与再加工工具清单）+ `scripts/third-party-licenses.json` + `scripts/check-third-party.mjs`（矩阵覆盖 + copyleft 全文在场，三形态判定）；门禁接入 build-apk-013.ps1，缺失即拒打包。
- APK：`assets/licenses/`（LICENSES + notices，随包分发）。
- 声明文：`docs/RELEASE.md §7`（D 章合规声明 + 源码要约 + 修改工具）。

## 8. 待办与已知缺口（非本轮范围，记录防止再探）

- F2「T1 授权豁免自动升级」未落地（电池白名单仅引导 Intent；指数退避仅日志不改调度）——涉及系统策略写面，不自动执行。
- F1.10 引擎更新通道未实现；F0.3 引擎事件桥未实现。
- 子代理 PRD 评审完整清单见协调仓库 `docs/review-0.13.0-20260823.md §九` 与 `.deploy-tmp/prd-gap-review.md`（U4/U5、A4/A6/A8、B4/B5/B7、F4、P4 未修项）。
- **~~扫描/图片版 PDF → 页图渲染受限~~（0.13.1 已修，0.13.0 记录作废）**：原记录「`@napi-rs/canvas` 仅 glibc 预编译装不上」系**误判**——npm 有 `@napi-rs/canvas-android-arm64`（N-API/Bionic 预编译，os=android cpu=arm64，真机 createCanvas 实测可用）。0.13.1 起随出厂快照装配（profiles/web package.json 登记 + tarball 解入，仅 arm64；npm 无 android-x86_64 triple，x86_64 模拟器维持守卫降级）。构建脚本 7c2 段。
- **marketplace 惰性加载决策（0.13.0 D4）**：cordis 装配层无惰性概念；拆装配违反 F4「内置市场」。启动速度优化由 D2（快照瘦身）+ D3（NODE_COMPILE_CACHE）承担，marketplace 保持启动装配。
- **provider 命名混淆（0.13.0 C3 实锤）**：默认 pin 曾为 `opencode-go`（OpenCode Zen Go 网关，`opencode.ai/zen/go/v1`，实测 404）——用户误以为配了 OpenRouter。0.13.0 默认 pin 改 `deepseek-official`（壳注 DEEPSEEK_API_KEY），opencode-go/OpenRouter 需在「添加自定义供应商」显式配置；设置页文案与文档需持续提醒区分。

---

## 更新记录表

| 时间 | 版本 | 更新内容 | 更新者 |
|---|---|---|---|
| 2026-09-05 | 0.13.2-fix | **悬浮球三连修 + 快照刷新闸门（用户实测回归三问题全修 + 升级排障实锤坑 37；坑 36 编号不变）**：#1 收起态球不变黄（必须展开才见琥珀）→ probeEngine 每 10s 自带判定直接 setHalo 把 PENDING 琥珀盖回白——抽 deriveHalo() 唯一权威（ERROR>PENDING>WORKING>IDLE）探活与 updateBallOnly 共用（截帧实证：t+2s 琥珀 t+16s 被打白→修后 t+26s 持久）；#2 发送后模型起轮前面板显「空闲」→ live 流无起轮事件壳侧失聪——markBusyOptimistic 乐观置忙（发送成功/应答提交即亮工作态，45s 无 live 事件探活兜底回退）+ **bridge 插件 0.1.2**（npm version bump + build + robocopy 已同步 apk 仓副本）新增 turn_start 行（上游 turn/start 事件在产），drainLive 消费——WebView 侧发送/提问续跑/无工具轮全覆盖（实测：面板收起纯 WebView 发送 t+1s 球即蓝、纯文本轮排除 tool_call 驱动）；#3 吸边后球/光环中心错位 14px → 光环窗 64dp 贴边越界 7dp 被 WMS 整窗平移（dumpsys 实锤请求 x=-14→frame x=0）→ 光环窗缩 50dp（=2×(margin 8dp+球半径 17dp)）贴边恰内切屏（修后 dumpsys 两窗中心同为 50,567）；#4 快照刷新期看门狗拉引擎（坑 37：模拟器解压实测 ~8 分钟，中途 force-stop → 半解压运行时引擎剪掉用户 llm-pi-ai.providers/Hy3 配置，已从 undo savepoint 124343 恢复）→ EngineManager.snapshotRefreshing companion 级 @Volatile 闸门刷新期 startEngine 跳过；回归四项全 PASS（pending 持久/发送即忙/turn_start/吸边同心，详见协调仓 docs/HANDOVER-overlay-v21-20260904.md §九）；§4 OverlayService/EngineManager 行与坑 37 同步 | AI 开发助手 |
| 2026-09-04 | 0.13.2-fix | **悬浮球 v2.1 交互批 + 设置页全屏修复（未发版；竖屏 16416 + 横屏 16384 模拟器实测全过）**：**三窗口架构**（球窗 34dp 全程不变尺寸/标志 + 光环窗 64dp 纯视觉四态辉光（半径 24dp≤球心距边 25dp 贴边不截断）+ 面板独立 focusable 窗 SOFT_INPUT_ADJUST_PAN——键盘系统原生上推面板，非相交 overlay 窗收不到 IME insets 实锤，自管 insets 方案作废）——互吞复发与「展开拖动只有光环动」（clamp 按球径致 WMS 重新贴边）双根治；**MuxClient.kt 新增**：手写 WS 连 `/api/events.mux` 下行收 PENDING 审批/提问（accept 校验 substring 前缀比较永不匹配致静默失败已修 + 逐次重试日志；HTTP 无轮询通道、GET 426），应答 POST /api/respond 全信封（question selected 用选项 label、顺序匹配，可 cancelled 取消）；**官方风格待答卡片**（问题卡：题头+加粗题干+编号选项行+✎ 自定义输入+‹n/n› 翻页+跳过/下一题/提交；审批卡：工具+理由+批准一次/拒绝）；状态文案模板 prefs 化（overlay_display：template_thinking/template_tool，{tool}/{summary} 替换）；关闭钮独立 ✕ 图标（dsh_ic_close.xml）；**设置页全屏（ui-responsive 0.1.12 同步副本）**：抽屉 transform→margin-left（transform 生成的 containing block 劫持 fixed 子树 = 0.13.1 设置窄条 300px 根因）+ 设置弹层选择器去 :has（老内核 Chromium 83 整条丢弃）+ 面板 100vw×100vh，实测竖屏全屏横向 tab、横屏桌面分支正常大弹窗、抽屉滑入不受影响；调试注入 `.overlay-test-pending` 文件钩子（FileObserver，debuggable 门控）；待真机项：IME 顶起实机观感、Deep diving/工具模板真实 agent 轮、MuxClient 长连稳定性 | AI 开发助手 |
| 2026-09-02 | 0.13.2-fix | **子仓副本同步协调仓（坑 36 登记，幽灵缺陷根因）**：协调仓 ui-responsive 0.1.11（含 W7 悬浮球开关 + 配置导入导出块）/ host-web-compat 0.1.8（含 #120 拒绝信号）→ robocopy 同步到 apk 仓副本（`dsh-client-ui-responsive` 0.1.9→0.1.11、`dsh-host-web-compat` 0.1.6→0.1.8、`dsh-shell-termux` 补 lib/ 产物）；实测设备快照此前为 0.1.9/0.1.6（自包含链注入旧副本 → DevSection 无悬浮球开关、#120 缺席） | AI 开发助手 |
| 2026-09-02 | 0.13.2-fix | **悬浮球 v2 发布前回归修复（模拟器实测 4 问题）**：#1 展开弹输入法系统 pan 抬高整个 overlay 窗口（球+面板上跳）→ 窗口与 showPanel 设 `SOFT_INPUT_ADJUST_NOTHING`；#2 Deep diving 卡死→ busy 会话感知（仅当前目标会话 tool_call/turn_end 驱动，其它会话/陈旧 live 行不置忙）+ 修复 live 文件污染（残留 `session-light-test` 无 turn_end 工具行）清理；#3 展开面板无法选发送对话→ 新增目标会话下拉选择器（session.list 投影，第一项「新会话」，标题取 `projections.values.title`——顶层无 title 字段且 optString 对 NULL 返 "null" 字面量须判空）；#4 手动输入发送不成功→ send 目标稳定（来自选择器）、session.create 回包去 `.take(200)` 截断、extractSessionId 正规解析两形态。模拟器复验：send 经 overlay 实测送达会话 history（`hello_final` 落 `session-9078…` user/message）；§4 OverlayService 行语义同步 | AI 开发助手 |
| 2026-09-02 | 0.13.2-fix | **修复批（未发版，实施中）**：**坑 33-35 登记**（系统代理劫持本地探针 → 全链 Proxy.NO_PROXY / UndoGate 无 linker64 fallback → 补 linkers / requestLegacyExternalStorage 对 targetSdk≥30 无效——MT 管理器调研实锤）；#118 五项修复（EngineProbe 直连+portReachable+refused/timeout 区分、壳侧全部本地 HTTP 直连、UndoGate linker64、冷却窗/存活兜底端口级、启动失败自动重试 2×5s/10s）；**悬浮球 v2 从零重写**（OverlayService v2：纯黑白球 bbox 裁剪居中 + 低饱和光环 + 上下合体圆角矩形 + ShimmerTextView deep diving + 工具×N + 插话/自动建会话 + spring 动效；飞行 v1 面板/12 条流/收起按钮——P5 未绑 onClick）；**#120 壳侧落地**（SDK 26-28 运行时权限放行 + SDK 29 显式拒绝 reason 哨兵 `__dsh_pick_refused__:`，manifest 加 READ maxSdk32/WRITE maxSdk28）；双形态设备验证全 PASS；§4 文件表补 ShimmerTextView/EngineProbe 语义 | AI 开发助手 |
| 2026-08-21 | 0.13.0 | 首版创建：AGENT.md 规范落地（PRD F6）；逐文件职责与代码位置截至 dsh-mobile-apk main@5679e59（0.12.5-fx-1） | AI 开发助手 |
| 2026-08-23 | 0.13.0 | **重构为便利开发维护版**：真实 ADB 通道（AdbState 配对/端口/密钥/审计 + OPENSSL_CONF 坑）、F5 消费端（FileIncoming 200MB 上限）、构建链全景（快照 TARGETS/licenses/pnpm + 全门禁清单 + APK 产物路径）、合规 D 章、11 条坑记录（realpath/pnpm/header 白名单/surfaceOp/9p 权限/信封式 RPC 等） | AI 开发助手 |
| 2026-08-24 | 0.13.0 | **真机回归发现全量固化**：引擎 OPENSSL_CONF 缺口（node 子进程全挂→shellEnv 统一注入）、apt/dpkg 编译期路径（APT_CONFIG 主文件方案重写 7d；dpkg SYSCONFDIR 已知限制）、git 预装 TARGETS、临时工作区（registry 强制登记 + TTL 7 天清扫）、通知首启权限注册、配对伪成功防御 + 端口自动扫描（discoverPorts）、老内核 ES2022 polyfill、错位目录剔除 + check-prefix-residue.sh 自检（坑 12-17） | AI 开发助手 |
| 2026-08-24 | 0.13.0 | **真机回归雷点补全（坑 18-23）**：debug 快照 ABI 事故、cordis.patch.yml 装配缺陷、EngineService 挂载缺失、通知链路三缺（事件桥/task-done 标记消费/服务挂载）、run-as 假错误、通知 debug 落盘 + 通用化增强（环境无关声明、构建前 ABI 核对提醒） | AI 开发助手 |
| 2026-08-24 | 0.13.0 | 新增第 3 节「环境无关的开发/维护流程」（环境矩阵 5 组合 / 起步流程 6 步 / 改动流程规范与三必做 / 环境差异点速查 5 项），原第 3-7 节顺延为 4-8 | AI 开发助手 |
| 2026-08-25 | 0.13.0 | 声明主分支为 `main`（修正「分支 docs/0.13.0-prd / feat/0.13.0」旧引用）+ 新增「禁用 emoji」约定（提交/PR/文档）并清除本文件存量 emoji | AI 开发助手 |
| 2026-08-25 | 0.13.0 | **0.13.0 正式版收口（PLAN-0.13.0-FINAL）**：端口发现改造—discoverPorts 系统属性直读+NSD 替代盲扫（坑 14 同步）；门1 live 判定一致化（syncFullAccess prefs 键，壳唯一真值，引擎 live 读；授权模型 §5 同步）；启动超时进程存活判定（engineProcessAlive + 90s 预算，D1）；NODE_COMPILE_CACHE 注入（D3）；已知缺口补 canvas/marketplace 惰性决策/provider 命名混淆（§8） | AI 开发助手 |
| 2026-08-26 | 0.13.0 | **新增云端构建与门禁平台化**：`.github/workflows/build-apk.yml`（宿主=本仓库，workflow_dispatch 双 ABI，仅 upload-artifact 供本地下载 debug，不出 Release；快照/插件/vendor/底座来自协调库经 coord/ 签出，build-apk.mjs 以 DSH_APK_DIR=GITHUB_WORKSPACE 指向本仓库）；构建链门禁改跨平台——check-snapshot-secrets.mjs 替代仅 Windows 的 .ps1、elf-check 校验快照 node ELF 架构（防坑 18 ABI 错配）；协调库 base/（Git LFS）入库；§2 门禁清单与云端构建说明同步 | AI 开发助手 |
| 2026-08-26 | 0.13.0 | **云端构建改自包含（从源重建，去协调库依赖）**：#93 起整链迁入本仓库——快照从源重建（base/ 底座 LFS 为输入）、6 个缺 lib/ 插件云端 npm 构建、注入/门禁/gradle 全链在云，仅 upload-artifact；不再签出协调库（私库 GITHUB_TOKEN 不可达）；§2 云端构建说明与更新记录同步 | AI 开发助手 |
| 2026-08-27 | 0.13.0 | **ADB 配对失效真机实锤修复（坑 24 登记）**：termux-exec 下 adb client fork-server 冷启动握手必败（protocol fault）→ 配对必失败；修复 = AdbState 常驻 `server nodaemon`（ensureAdbServer/5037 探测/日志）+ retryRunAdb 自愈重试 + pair 失败首行入审计；discoverPorts 卡 UI 修复（NSD 超时 5s→2s + 后台预取 + 15s TTL 缓存，bridge 缓存优先）；配对页双端口输入提示。附：诊断方法论（run-as 同 env 复刻 vs 壳内调用的对照实验定案） | AI 开发助手 |
| 2026-08-27 | 0.13.0 | **配对窗口竞态四连修（坑 25-27 登记；三探针 logcat/audit/adb-server.log 时间线定案根因）**：F1 AdbState.prewarm 常驻预热（getAdbState 轮询钩子 + onResume 后台线程，60s 节流，密钥生成移出关键路径）；F2 ensureAdbServer 真实 devices 往返就绪判定（5037 bind 不等于可服务，首轮 protocol fault 必败消灭）；F3 setAdbPair 桥返回结构化 JSON {ok,reason,message}（壳侧 classifyFailure 归因）；F4 AdbAuthSection 双错误通道（pollError/actionError 后者留存 15s）+ 失败不清空输入 + 文案按 reason 分流。新坑：vivo SELinux 拒读 service.adb.tls.* 属性（坑 26）、引擎页面误调 openNativePath 记录在案（坑 27） | AI 开发助手 |
| 2026-08-27 | 0.13.0 | **序列化层根因修复 + ADB 全链真机贯通（坑 28-29 登记）**：活体插桩定案 `[object Object]` 根因 = dsh-shell run() 返回 CollectedOutput 结构体被当字符串 String()（坑 28）→ collectText 解包 + pickText 类型闸 render + device_info undefined 成员归零（lossless 拒收修复）；resolveLivePort() 配置端口失效回退 5555（NSD 端口轮换）；fork 会话受控探针验证 `getprop` 真实输出直达模型（V2425A）。坑 29 澄清会话档位事件溯源按会话隔离（部署默认非死锁）；排障方法论：孤儿 node 进程排查 / MSYS /tmp 不跨块 / 设备端 base64 分块注入通道 | AI 开发助手 |
| 2026-08-28 | 0.13.0 | **0.13.0 正式版发布**：versionCode 25（覆盖安装 preview 24）；workflow suffix 双修（PR #97 步骤 fallback + PR #98 输入默认值，GitHub 空串输入被默认值顶替行为实锤）；纯净版双 ABI 构建（versionName 0.13.0，aapt 验证）；Release v0.13.0 全套 13 资产（双 APK/双快照/7 插件包/MANIFEST/notes，旧版发布规则沿用）；main 分支保护定案（直推被拦，改动走 PR 合并通道） | AI 开发助手 |
| 2026-08-28 | 0.13.0-fx-1 | **fx-1 补丁版发布**：出厂 seed `llm-deepseek:` 裸键 null 实锤（settings-file section() TypeError → llm-deepseek apply 中途死亡 → 模型页全灭，模拟器首启实验逐环验证）；PR #101 seed 改空对象 + #104 注释符修补（# 误入 JS 数组字面量致 SyntaxError——教训：改构建脚本必须本地 node --check）+ #102 versionCode 26；fx-1 全新安装复验通过（seed 含空对象、12 命名空间、模型目录含 vision-exp）；Release v0.13.0-fx-1 全套 13 资产 | AI 开发助手 |
| 2026-08-28 | 0.13.1 | **0.13.1 修复批（已发布：PR #113 合并 e47c400，Release v0.13.1 全套 15 资产，versionCode 27）**：W1 市场安装 execPath 安全化——真机 linker64 回退启动污染 process.execPath，市场装插件 execFile(linker64,[bin.js]) 报 bad ELF magic:23212f75（#83/#89/#96 根因实锤）；patch-marketplace 补丁 B（TERMUX__PREFIX/bin/node，双仓同步+三形态测试）。W2 canvas 出厂依赖——@napi-rs/canvas-android-arm64 实为 Bionic 预编译（本文件旧记录误判已改）；构建脚本 7c2 手工装配（仅 arm64）。W5 模型页提供方空白/添加按钮死根因=0.13.0 存量坏 seed 持久化（fx-1 只修出厂模板，升级设备不生效；模拟器双向复现）→ EngineManager 启动前坏键迁移（前瞻缩进防 DUPLICATE_KEY——首版无前瞻在 fx-1 正常文件上翻车，坑已录）。W3 engine.log 世代轮转（3 代，治看门狗截断毁现场）+ 失败诊断镜像（diagnostics/<ts>-<原因>/ 全触发点覆盖，undo-gate 实测）+ dshdata README.txt 每次启动生成。W4 配置导入导出桥（AndroidBridge.exportConfig/importConfig + DevSection 按钮 + settings.yaml.import-backup 防误导）。W6 apt 链三修复（trusted.gpg.d 悬空链接落实体/Dir::Log/install-clang.sh 解包式安装器端到端实测 clang 21.1.8；dpkg cfg.d app 域致命=apt install 不可用，M3 openjdk 系 root adbd 假象）+ LD_LIBRARY_PATH 先于外部命令坑。构建链脚本改动与协调仓双写同步 | AI 开发助手 |
| 2026-08-30 | 0.13.1 | **文档结构化增补**：坑 30-32 登记（assets ABI 残留/linker64 孤儿 force-stop 杀不死/forward 静默失效——与协调仓雷点 14-16 同源）；标题 AGENT.md→AGENTS.md 对齐文件名；产物路径硬编码 v0.13.0 → v<版本> 占位（产物命名已由 ps1 从 gradle 单一来源读取）；§1 补版本状态与开放跟踪行 | AI 开发助手 |
| 2026-08-31 | 0.13.2 | **插件构建产物收口（chore, 348011c）**：.gitignore 补 `plugins/*/lib/`、`plugins/*/node_modules/`、`plugins/*/cbin_*`（本地/云端 npm 构建产物不入库）并清理存量 untracked 产物；ci/pr61-fix 孤儿分支（无 PR）与已合并 PR 的旧分支保留未动 | AI 开发助手 |
| 2026-08-31 | 0.13.2-preview | **0.13.2-preview 功能批（versionCode 28 + versionName 0.13.2-preview；未发布，待用户指示）**：W6 内嵌 ADBKeyboard 协议 IME（AdbKeyboardService/Receiver，dcfd573）+ manage 语义工具双写（1bb0cc7）+ 门禁 settings.yaml 内容级修正（5d9988b）+ W7 悬浮球全套（OverlayService/OverlayController + live 流 + 开关，d76dc41/56c96b7）+ **preview 修正批（ae8a78d）**——面板跟随球（repositionPanel）、引擎页避让帧（emitFrame/replayFrame + frameConsumer 先于 ensureStarted 注册 + onPageFinished 补放 + instance/onDestroy 注销）、贴边容差 20dp；设备实测：避让 124px 注入/拖动清零/面板跟随；§4 文件表补 OverlayService/AdbKeyboardService 两行；preview 发布/PR 模板三要点见协调仓 AGENTS.md §4 | AI 开发助手 |
