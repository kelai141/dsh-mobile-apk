# bridge-api.md — 桥与通道说明

> 逐方法行号锚点的权威详档：docs/AGENTS/BRIDGE-API.md（Phase 4 起）。
> grep 用法：`grep -n "<方法名>" docs/AGENTS/BRIDGE-API.md`。

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
- **版本状态**：**0.13.3 开发中（vc30；引擎 0.1.2-rc.1 overlay + /api 浏览器鉴权 EngineAuth（P0 token 交换/P1 自 mint cookie）+ MuxClient /api/remote.mux $events 流重做 + pi-drift-F1 降级补丁 + withResolvers polyfill（host-web-compat 0.1.9）+ 字体滑杆退役（ui-responsive 0.1.13）+ vendor/dsh-model-sync；W1-W8 代码面全绿，回归与 push/PR 待用户口令）**。0.13.2 已发布**（Release v0.13.2 正式版，versionCode 29，2026-09-05，tag 落 main，15 资产，prerelease=false；详见更新记录表与协调仓 AGENTS.md §1）。0.13.2-preview（28）与 0.13.1（27）被其取代。**0.13.2 含悬浮球 v2.1 全套 + 用户实测三连修（deriveHalo/乐观置忙+bridge 0.1.2 turn_start/吸边同心）+ 快照刷新看门狗闸门（坑 37）**（#118 引擎启动/探活/UndoGate 五项 + 悬浮球 v2 重设计 + v2.1 三窗口/待答卡片/状态模板批 + 设置页全屏（ui-responsive 0.1.12）+ #120 工作区，详见更新记录表）。当前开放跟踪：#115（市场 Phase2，目标 0.13.2）、#120（添加工作区按键不可用——修复批已实施，待发版验证）、#108（数据备份 feature）。
- **环境无关声明**：本文档适用于任意环境（Windows/WSL/Linux/macOS、有/无真机）开发维护者；环境差异点（WSL、ADB 真机、run-as）已在对应章节标注。

## 2. 构建与验证命令

```powershell
# 一键双 ABI（协调仓库根；快照→注入→门禁→gradle→out/）：
pwsh -File scripts\build-apk-013.ps1 -Suffix ""          # 产物 out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk
# dev 快速档（单 ABI 缺省 x86_64 + 注入 preset 1；产物仅 dev 装机，禁发布资产）：
pwsh -File scripts\build-apk-013.ps1 -Fast
# 快照（Termux 源 + TARGETS 预装（scripts/snapshot-config/preinstall.json）+ licenses + pnpm 装配 + 瘦身 + xz -T0 归档）：
node scripts\build-snapshot-013.mjs <arm64|x86_64>
# 插件单测/冒烟：
node scripts\smoke-bridge.mjs                             # bridge 18 断言
cd ..\dsh-client-ui-responsive && npm test && npm run build
cd ..\plugins\dsh-android-<pkg> && npm run build
```

**门禁（build-apk-013.ps1 内）**：vendor 统一补丁（scripts/patches/apply-patches.mjs：marketplace A-D + undo E1-E7，registry.json 驱动，勿加 Select-First）→ 快照单 pass 注入（inject-all.py：@dsh-android + 根级插件 + 权威 patch 覆盖一次 tar 流完成，压缩 ×4→×1；DSH_INJECT_PRESET 默认 9 / -Fast 传 1）→ 挂载集⊇注入集（check-patch-mounts.mjs）→ 机密（check-snapshot-secrets.mjs，跨平台替代 .ps1）→ **第三方合规（check-third-party.mjs，GPL 义务）** → elf-check（双模式：快照 node ELF 架构门禁防坑 18 / 单 ELF 遗留）→ 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

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
| 壳层（桥/服务/看门狗/快照/权限） | 壳内 `app/src/main/java/com/dsharnessmobile/shell/` | 提交在壳子仓库独立 git |
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

> **维护者文档（2026-09-05 Phase 4 起，权威登记处）**：`docs/ARCHITECTURE.md`（35 模块地图+依赖方向+assets 结构）/ `docs/BRIDGE-API.md`（桥协议：androidBridge 31 方法+consoleBridge 6+回调通道 8+MuxClient 协议）/ `docs/ANDROID-API-USAGE.md`（android.* 85 类按域分组+API 等级守卫点）/ `docs/DEPENDENCIES.md`（gradle 依赖+升级策略）/ `docs/RUNTIME-PATCHES.md`（assets/patched 六文件登记）。本节保留速查职能，与五文档冲突时以文档（源码 grep 实证）为准。

`app/src/main/java/com/dsharnessmobile/shell/`：

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
| **EngineAuth.kt** | 引擎 /api 浏览器鉴权载体（0.13.3 W2 新增）：P0=engine.log（三代取最新）解析 `dsh web: .../?token=` 行 → GET / 捕 303 Set-Cookie 存 SharedPreferences；P1=读 files/home/.dsh/.credentials.yaml records[client-connection/browser-session] 自 mint cookie（HMAC-SHA256/sha256/base64url 标准件，cookie 名 dsh-auth-+b64url(sha256(authority))，authority=127.0.0.1:3080）；**token/cookie/secret 禁落日志**；handleUnauthorized=invalidate+refresh（401 自愈）；attachMux 供 WS 握手；cookie 跨引擎重启有效（签名密钥持久） |
| **EngineProbe.kt** | 本地引擎探活（0.13.2-fix 重构；0.13.3 W2 起 401/303 视作 running=alive 防 watchdog 误杀，auth 字段区分 ok/missing）：应用级状态唯一判定源 | `check()` **全链 Proxy.NO_PROXY 直连**（#118：系统代理劫持本地探针实锤——WebView/curl 豁免代理而 HttpURLConnection 走 ProxySelector → 请求发往代理网关恒 timeout）；`portReachable()` TCP 端口级判定（HTTP 未就绪 ≠ 引擎死亡）；error 区分 **timeout（代理吞请求/慢启）vs refused（端口未开=真死）** |
| **OverlayService.kt** / **OverlayController.kt** | 悬浮球 v2.1（0.13.2-fix 二批；v2 交互在其上重构为**三窗口架构**）：**球窗 34dp**（NOT_FOCUSABLE+NOT_TOUCH_MODAL+ADJUST_NOTHING，尺寸/标志全程不变——互吞与错位根治）；**光环窗 50dp**（NOT_FOCUSABLE+NOT_TOUCHABLE 纯视觉，radial 辉光半径 24dp≤半窗 25dp；**50dp=2×(贴边 margin 8dp+球半径 17dp)——贴边时窗口恰内切屏幕不被 WMS clamp**；旧 64dp 贴边越界 7dp 被 WMS 整窗平移回屏（dumpsys 实锤请求 x=-14→frame x=0）=「吸边后球/光环中心错位 14px」，2026-09-05 三批修）；四态 IDLE 白/WORKING 蓝/PENDING 琥珀/ERROR 红；**面板窗**（独立 focusable TYPE_APPLICATION_OVERLAY+NOT_TOUCH_MODAL，宽 min(屏宽-球-64dp,400dp)，**SOFT_INPUT_ADJUST_PAN**——键盘弹出系统原生上推面板、球不动；非相交 overlay 窗收不到 IME insets 已实测，勿再做自管 insets）；收起=纯黑白球+光环、展开=圆角矩形面板（会话选择器/状态行/输入行同 v2） | 双维状态解耦保留（EngineProbe 探活 + live 流 turn_start/tool_call/turn_end busy 会话感知）；**光环状态派生唯一权威 deriveHalo()**（探活 tick 与事件渲染共用——探活自带判定不带 PENDING 项会每 10s 把待答琥珀盖回白=「必须展开才见黄」，2026-09-05 三批修）；**乐观置忙 markBusyOptimistic**（发送成功/应答提交即亮工作态补 live 空窗——live 流原本无起轮事件，发送到首 tool_call 间壳侧失聪显「空闲」；45s 无 live 事件由探活兜底回退）；**PENDING 审批/提问走 MuxClient WS 下行**（见下行），卡片官方风格：问题卡=题头+加粗题干+编号选项行+✎ 自定义输入+‹n/n› 翻页+跳过/下一题/提交，审批卡=工具+理由+批准一次/拒绝；应答 POST /api/respond 全信封（approval value={sessionId,approvalId,outcome}；question value={sessionId,answer:{answers:[{id,selected[,custom]}]}}——**selected 用选项 label 非 id**、顺序匹配 questions；question 取消发 ok:false error cancelled，approval 无取消通道）；状态文案模板 prefs 化（overlay_display：template_thinking "Deep diving..." / template_tool "{tool} · {summary}"，摘要取 args 命令/路径等键值折叠空白前 24 字符）；拖动 clamp/弹簧用窗口实际宽高（「展开拖动只有光环动」根因=按球径 clamp 致 WMS 重新贴边）；positionPanel 随球同步（右溢出翻左侧）；debug 待答注入：`echo question\|approval\|clear > files/home/.dsh/.overlay-test-pending`（FileObserver 消费，debuggable 门控）；关闭钮独立 ✕ 图标（dsh_ic_close.xml）；引擎页避让帧保留；**文件拆分（2026-09-05 Phase 3c，纯搬移零行为变更，1564→611 行）**：光环维=**OverlayHalo.kt**（Halo 枚举顶层 + drawable/setHalo/syncHalo/deriveHalo）、面板维=**OverlayPanel.kt**（buildUnit 构建/updateBallOnly 渲染/状态模板/待答卡/POST /api/respond 应答；PendingApproval/PendingQuestion 顶层类）、live 流=**OverlayLiveFeed.kt**（FileObserver drainLive 事件分发 + F7 android_* 避让 + .overlay-test-pending debug 注入 + toolSummary）、主题=**OverlayTheme.kt**（色板/明暗）；协作类同包顶层、构造注入服务引用（internal 成员共享状态，无静态单例），**F7/F8/F9 三修行为与关键注释（F8 z 序约定）原样保留** |
| **MuxClient.kt** | 引擎事件 mux WS 常驻客户端（0.13.2-fix 二批新增） | 手写 WS（Socket 握手 + **SHA-1 Sec-WebSocket-Accept 校验（首版 substring 前缀比较永不匹配致静默失败，实锤）** + 服务器帧解析 + 掩码控制帧 pong/close + 分片续帧缓冲）；0.13.3 W3 重做：连 `ws://127.0.0.1:3080/api/remote.mux`（**握手带 Cookie**=EngineAuth.attachMux；不带 Origin/sec-fetch-site——雷区 5）+ 连上即发 `{type:"open",streamId,endpoint:"$events",payload:{args:{}}}`；服务端 item value = ready（clientId）/ waterfall（approval/request、user-questions/request，eventId+agentId）/ emit（api-session/status args=[agentId,running]）；应答 POST /api/$events/result {clientId,eventId,outcome}（审批=词汇原字符串、提问 selected 数组、跳过=rejected）；指数退避 1s→10s 重连、逐次 Log.w（tag dsh-overlay-mux）；帧回调 OverlayPanel.handleMuxFrame（0.13.2-fix Phase 3c 拆分后落 OverlayPanel.kt，原 OverlayService.handleMuxFrame）增删 pendingApprovals/pendingQuestions 映射（approval/requested|resolved、question/requested|resolved） |
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

---

## 0.13.3 W2/W3/W10 桥协议增量

- MuxClient：`/api/remote.mux` + `$events` 流（waterfall/emit/ready 帧）——grep `remote.mux`
- EngineAuth：`/api` 全前缀浏览器 Cookie（P0 token 交换 / P1 自 mint）——grep `EngineAuth`

## 0.13.5 W4 桥协议增量（设备控制授权面）

- `a11yStatus()`：无障碍控制通道状态 JSON `{enabled,label,sdk,restrictedSettingsApplies,hint,tokenConfigured}`（壳侧 `DeviceControlService.statusJson`）。
- `openA11ySettings()`：官方 Intent `Settings.ACTION_ACCESSIBILITY_SETTINGS` 跳系统无障碍页（失败回退 `ACTION_SETTINGS` + Toast 引导）。
- `unlockRestrictedSettings()`：Android 13+ 一键解锁受限设置（`appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow`，走壳侧 ADB 通道；未授权/未配对失败关闭，返回 `{ok,message}`）。
- 引擎侧只读状态端点 `/api/android/privilege/status` 新增 `control:{a11yEnabled,queue,tokenConfigured}` 与工具 `android_privilege_status` 的 `gates`/`control` 字段。

## 0.13.7 增量（追上游 dsh 0.1.5，2026-09-10）

> 本节为本轮桥面变更的权威增量；上行各表仍是 0.13.3-0.13.6 的行号锚点，未逐行重排。

| 方向 | 方法 | 位置 | 说明 |
|---|---|---|---|
| 页面 → 壳 | `openPathChooser(path, mode)` | AndroidBridge.kt（新增）→ MainActivity `onOpenPathChooser` → PathOpen.kt `openChooser` | 系统「打开方式」选择器；返回 JSON `{ok, reason?}`（not-exists / not-allowed / no-handler / uri-failed / 异常摘要）。mode=`folder` 视为目录 |
| 同上（允许面） | — | PathOpen.`isChooserAllowed`（0.13.7 追加） | 允许面 = FileIncoming 的 canonical 白名单（`files/home/.dsh/workspaces`、`files/home/tmp`、`files/usr/bin`、外部存储 `Documents/dshdata/`）**加外部存储根**——上游右栏 Files 标签能浏览整台设备，用户在那里点开的文件/目录必须能交给 MT 管理器或系统文件管理。`file_paths.xml` 相应新增 `<external-path name="external_shared" path="." />`。**引擎/插件驱动**的「文件提及 → 外部阅读器」（`openNativePath` → `FileIncoming.openWithExternalReader`）仍只走严格白名单，不因这条放宽；应用私有区其余部分（含 `.credentials.yaml`）永不进选择器 |
| 页面 → 壳 | ~~`downloadDebugLogs()`~~ | 已删除（AndroidBridge/MainActivity/DebugLogExporter.kt） | 「导出调试日志」整链退役；日志仍按天落盘（设置页开关不变） |
| 页面 → 壳 | ~~`pickImage(callbackId)`~~ | 已删除（AndroidBridge/MainActivity/ConfigTransfer 图片桥） | 上游 0.1.5 自带附件入口（回形针 → 系统文件选择器 → 官方上传接口）替代 |
| 页面 → 壳 | ~~`pickFilePath(callbackId)`~~ | 已删除（AndroidBridge / MainActivity / ConfigTransfer 的 SAF 文档选择链 + 页面 `onFilePicked`） | 0.13.7fx-1 退役：`@` 文件引用回到上游原生菜单（`ui-input-trigger` + `ui-reference`，候选限定在会话工作区内），自建 `@路径` 桥不再需要 |
| 壳 → 页面 | ~~`window.__dshBridge.onImagePicked`~~ | 已删除（dsh-host-web-compat lib/index.js） | 同上 |
| 页面 → 壳 | `settingsPath()` | AndroidBridge.kt（新增）→ EngineManager.settingsDocumentPath() | Host 设置文档绝对路径（`$DSH_HOME/settings.yaml`），空串 = 文件不存在。移动适配层用它把上游「打开配置文件」（本来走 mac/win/linux 原生编辑器，Android 必然失败，apk #152）改走系统选择器 |
| 页面（兼容插件） | `window.__dshOpenPath(path, mode)` | dsh-host-web-compat lib/index.js（新增） | 优先 `openPathChooser`，回退旧 `openNativePath`；聊天 mention 与工具行路径点击统一走它 |

JS 接口计数：**33**（0.13.6 为 34：+openPathChooser、−downloadDebugLogs、−pickImage；0.13.7fx-1 −pickFilePath、+settingsPath）。
`<input type=file>` 的 `onShowFileChooser` 通道保留（上游附件按钮依赖）。

