# build-and-env.md — 构建与验证命令 + 环境流程

> grep 用法：`grep -n "门禁\|Fast\|abi" docs/AGENTS/build-and-env.md`。

# AGENTS.md — dsh-mobile-apk 开发地图

> **AI 主动更新条款（必须最先执行）**：本文件面向人类与 AI 开发助手，是唯一权威的仓库开发地图。**任何代码变更导致本文件描述失真（文件作用、函数签名、桥协议、构建命令、关键实现落点）时，AI 必须在本轮同步更新本文件，并在文末「更新记录表」登记（时间 + 版本号）。** 变更未触及本文件描述范围时无需更新（避免无意义改写）。若发现本文件与源码不一致，以源码为准并当场修正本文件——不要忽略。
>
> **过期风险声明**：代码演进可能快于文档更新，本文件内容可能过时；一切以源码为准。

---

## 1. 仓库概览与技术栈

- **角色**：DeepSeek Harness 安卓壳应用（包名 `com.dsharnessmobile.shell`）。
- **职责边界**：只保留安卓平台权能与桥——前台服务、看门狗、WebView（主 + 隔离 BrowserHost）、SAF 桥、快照解压与更新、崩溃回退闸门（UndoGate）、Shizuku 特权 transport 与虚拟屏、无障碍/ADB 授权原生写面、通知中心与通知内应答、返回网关、审计、内置控制台、日志。**AI 可见能力全部来自插件**。
- **运行时形态**：壳内嵌 Termux 运行时快照（`assets/snapshot.tar.xz` → `files/usr` + `files/home`）；引擎（Node.js `@deepseek-ai/dsh`，基线 0.1.5-rc.1）监听 `127.0.0.1:3080`；WebView 加载引擎 Web UI。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **依赖**：androidx.activity-ktx / core-ktx、dynamicanimation、commons-compress、xz；Shizuku `dev.rikka.shizuku:api/provider 13.1.5`（直连 transport）。
- **兄弟仓库**（协调仓库下的子目录）：`dsh-shell-termux`（0.2.0，Termux 执行器 + 工具链单一表）、`dsh-client-ui-responsive`（0.3.3，移动 UI 注入层 + 来件消费端）、`dsh-host-web-compat`（0.1.13，页面注入/兼容）、`plugins/`（bridge 0.2.4 / manage 0.3.0 / model-capability 0.2.1 / file-open 0.1.0 / browser 0.1.0 / linux-env 0.1.2 / vdisplay 0.1.0，协调仓库内）、`vendor/`（dshmarketplace-plugin、dsh-undo-savepoint 固化副本 + PATCHES.md）。
- **上游** `deepseek-ai/deepseek-harness`（本地 checkout `dsh/`）：只读参考，**零改动**；一切适配以补丁层/插件/壳侧实现。
- **版本状态**：**0.14.0-preview 已发布（vc38，2026-09-13，9 资产）**：缺陷收口 + 门禁闭环（17 项聚合、SKIP=0）+ 返回手势/通知分级与通知内应答/外部文件草稿；浏览器与虚拟屏为实验特性不接产品路径。**0.13.8 已发布（vc37，2026-09-12，16 资产）**：控制协议 V2 + E6 能力补齐 + P2 收口 + 移动端体验修复。**工作区在 0.14.0-preview 上继续施工 Shizuku 特权 transport / 虚拟屏 viewer / 隔离 BrowserHost / 开放屏幕范围（未提交、未验收）**。详见 apk 仓 `release/`、`AGENTS.md §1` 与协调仓 `docs/0.14.0-preview-*.md`。
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
node scripts\smoke-bridge.mjs                             # bridge 冒烟（现 22 断言，grep -c assert 现数）
cd ..\dsh-client-ui-responsive && npm test && npm run build
cd ..\plugins\dsh-android-<pkg> && npm run build
```

> **多线程/并行优先铁律（2026-09-08 用户定例，改任何构建脚本都适用）**：编译、构建、打包、归档、解压**一律使用多线程脚本**，不得用单线程等价命令替代——目的就是省掉一切可以省掉的构建时间。现行落点：
> - 快照归档 `tar -c ... | xz -T0 -6`（多线程压缩；裸 `tar -cJf` 单线程 ≈380s vs `xz -T0` ≈48s，2c 实测）；
> - 快照/基座解压 `xz -dT0 | tar -x`（多线程解压，替代 `tar -xJf` 的单线程解码）；
> - 注入链单 pass（`inject-all.py`，压缩次数 ×4→×1）+ dev 循环 `-Fast`（单 ABI + `DSH_INJECT_PRESET=1`）；
> - gradle `org.gradle.parallel=true` / `caching` / `configuration-cache`（`gradle.properties`）；
> - 门禁脚本能用流式并行就用（Python 侧 `tarfile` 单遍流式，勿反复解压同一归档）。
> 新增构建步骤若只能单线程，必须在脚本注释里写明原因（例：9p 写带宽是瓶颈，并行无收益）。

**门禁（build-apk-013.ps1 内）**：聚合入口 `scripts/check-release-gates.mjs`（`--list` 现数，当前 27 项；**不要写死数字**；接进本地链 / 云端 `build-apk.mjs` / 两仓 CI / 发布链 `build-release.ps1`，发布链 `--run --require` 要求 SKIP=0）。内容 = vendor 统一补丁（`scripts/patches/apply-patches.mjs`：marketplace A-D/U2 + undo E1-E8/U1，registry.json 驱动，勿加 Select-First）→ 快照单 pass 注入（`inject-all.py`，补齐 + 修剪双向对齐）→ 注入产物完整性（`check-inject-completeness.mjs`）→ 挂载集（`check-patch-mounts.mjs`）→ 机密（`check-snapshot-secrets.mjs`）→ 第三方合规（`check-third-party.mjs`）→ 路由鉴权（`check-api-route-auth.mjs`）→ 工具 schema / 控制 op / 状态登记 / 桥对称 / 门禁 SKIP / 性能插桩 / Kotlin 注释 / 构建链中止 / strip no-op → 运行时资产（`check-runtime-assets.mjs`）→ 快照指纹（`check-snapshot-fingerprint.mjs`）→ elf-check → 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

**云端构建（0.13.0 起，宿主=本仓库，自包含）**：`.github/workflows/build-apk.yml`（`workflow_dispatch` 手动，matrix arm64/x86_64）托管整套构建链并只操作本仓库——快照从源重建（`base/` 底座归档为输入，Git LFS）、6 个缺 lib/ 的插件 npm 构建、注入/门禁/gradle 全部云端完成，仅 `upload-artifact` 供本地下载 debug，不出 Release；**不依赖协调库**（私库，GITHUB_TOKEN 无法签出）。`build-apk.mjs` 以 `DSH_APK_DIR=$GITHUB_WORKSPACE` 指向本仓库（gradle 在此）。本地仍在协调库根跑 `pwsh scripts\build-apk-013.ps1`（`scripts/` 前缀）。

**设备验证链路**（真机 arm64 vivo V2425A；模拟器 MuMu x86_64 竖屏 `127.0.0.1:16416`、横屏 `127.0.0.1:16384`——横屏实例勿改回竖屏）：
- 安装：`adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore；**指纹变更触发 refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器实测 ~8 分钟，勿在解压中杀进程——中途杀进程看门狗会拿半解压运行时拉引擎，见坑 37）**）。
- 引擎探活：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`。
- WebView 调试：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `forward tcp:29225 localabstract:webview_devtools_remote_<pid>`（**每次重启 pid 变**）→ CDP ws 连接后 Runtime.evaluate 驱动（例子脚本见 `.deploy-tmp/cdp-*.mjs`；断言注意 input placeholder 不在 innerText 里）。
- 远程 RPC（测试面）：POST `/api/<method>`，body 必须全信封 `{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}`；`session.prompt` 拒绝 live 会话（被 UI 打开的）——直接 API 测代理需先用 session.create 建全新会话。
- **构建前核对 ABI（见坑 18）**：无真机环境用模拟器（MuMu x86_64 竖屏 `127.0.0.1:16416` / 横屏 `127.0.0.1:16384`），有真机则安装 ABI 匹配的 APK——debug 包默认带 x86_64 快照，覆盖装到 arm64 真机会引擎崩溃。

## 3. 环境无关的开发/维护流程（新人先读此节再动手）

> 本节与协调仓库根 `AGENTS.md` §2-4 对齐，但以壳子仓库为落点；**下列命令均在协调仓库根执行（除非注明「壳内」）**，shell 引用路径用 `scripts/` 前缀。

### 3.1 环境矩阵（先对号入座）

| 组合 | 快照构建（node scripts\build-snapshot-013.mjs） | 打包/门禁（pwsh scripts\build-apk-013.ps1） | 设备验证 |
|---|---|---|---|
| Windows + WSL | **必须在 WSL 跑**（Termux 源/依赖闭包需 Linux；见 3.4） | PowerShell 直跑 | ADB 真机 或 MuMu |
| Windows 无 WSL | **不可本地构建快照**（跳过 3.2 步 2，用已发布快照/CI 产物） | 可 | MuMu（debug 包默认 x86_64 快照可用） |
| Linux / macOS | 直接跑（无 WSL 层，路径用 `/`） | 直接跑 | ADB 真机（arm64 需匹配快照） |
| 无真机 | — | — | MuMu x86_64 竖屏 `127.0.0.1:16416` / 横屏 `127.0.0.1:16384`（装 x86_64 包） |
| 有真机 arm64 | — | — | vivo V2425A（**必须装 arm64 快照包**，坑 18） |

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
