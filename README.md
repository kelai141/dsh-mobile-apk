[![QQ群](https://img.shields.io/badge/QQ群-dsh--mobile用户群-12B7F5?logo=tencentqq)](https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info)

# dsh-mobile-apk — DeepSeek Harness 安卓壳 APK

[🌐 English README](README.en.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)


> **dsh-mobile 生态** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

> **0.13.0 正式版**：ADB 真实通道（配对 / 端口发现 / shell 执行 / 授权门禁 / 审计）全链实现并真机验证。
> - 插件市场适配提示：内置市场牵涉大量第三方插件，绝大多数在手机端不一定可用，以可用性验证与反馈为主。
> - **插件市场适配警示**：内置市场牵涉大量第三方插件，**绝大多数插件在手机端不一定可用、大概率有 bug**（移动端与桌面端在 WebView 内核/文件系统/权限模型/运行环境差异大）；移动端适配是长期工程，beta 阶段以「可用性验证与反馈」为主，暂不建议当作生产依赖。插件报错请到 [issues](https://github.com/kelai141/dsh-mobile-apk/issues) 反馈（附机型/版本/复现步骤）。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓壳：WebView UI 覆盖
**内嵌 Termux 运行时快照**（解压即跑，无需 Termux app）、SAF 目录桥、保活前台服务、引擎看门狗、
运行时在线更新。一个 APK 装完即用：完整的 dsh web agent，且能真实执行 bash。应用名 `DeepCode`
（图标文字 DeepSearch）、包名 `com.dsharnessmobile.shell`、版本 `0.13.0-fx-1`（versionCode 26）。

## 功能

- **内嵌运行时**：xz 快照（arm64 151.6MB / x86_64 158.9MB）内置 node + git + bash + coreutils +
  dsh + 插件 + pnpm + python/perl/ruby；首启解压 2-4 分钟（`refreshSnapshot`），引擎监听
  `127.0.0.1:3080`；完全离线；
- **文件直达会话（F5）**：「使用其他应用打开 / 分享」→ 自动跳转本应用 → 强制新建临时工作区会话
  处理文件；临时工作区 7 天 TTL 自动清理 + 工作区面板可见（issue #60）；
- **搜索（grep/glob）**：移动端 ripgrep 平台包（android-arm64，pcre2/NEON 全特性）；
- **通知提醒**：任务完成自动通知（引擎事件桥 + 看门狗消费）；授权请求等系统通知链；
- **移动 UI**：响应式插件（手机端抽屉/sheet）；可调字体、沉浸式状态栏、深色主题；
- **内置控制台**：独立 bash 交互终端（`assets/console.html` + 内嵌 Termux），引擎未运行也可排查；
- **保活**：前台服务 + 5 秒看门狗（自动重拉挂死引擎）+ 3 秒 UI 轮询 + 崩溃自动回退闸门（UndoGate）；
- **在线运行时更新**：manifest 驱动的快照替换（下载 → sha256 → 原子切换 → 自动重启），
  运行时可自更新而无需更新 APK；
- **APK 自更新（0.13.8）**：启动页「检查更新」按钮手动触发（**不自动检查**）——查 GitHub
  latest release、按设备 ABI 匹配资产、镜像链逐级回退下载；发现新版时**同一按钮**变为
  「下载并安装 vX.Y.Z」二次确认，确认后下载 → 首次自动拉起系统「安装未知应用」授权页 →
  系统安装器（签名不匹配由系统拒绝；应用不静默安装任何东西）；
- **SAF 桥**：`pickDirectory` 把所选目录映射为真实路径（`/storage/emulated/0/…`）；
- **设备访问**：所有文件访问；Shizuku 探活示例；
- **ADB 真实通道（0.13.0）**：真实 `adb pair` SPAKE2 握手 + NSD/mDNS 端口发现，经 adbd（shell uid=2000）执行系统命令（危险命令黑名单）；三道门授权（完全访问档位 / 应用内开关 / 配对码）+ 会话档位实时门控 + 原生审计（`files/audit/audit.ndjson`）；连接端口轮换自愈（5555 回退）。

## 下载 / 安装

Release `v0.13.0-fx-1` 提供双 ABI 包（另含快照归档、插件包、MANIFEST 校验清单与发布说明）：

| APK | 适用 |
|---|---|
| `dsh-mobile-apk-v0.13.0-fx-1-arm64.apk` | arm64 设备（真机） |
| `dsh-mobile-apk-v0.13.0-fx-1-x86_64.apk` | x86_64 模拟器 / 设备 |

```sh
adb install -r -t <apk>    # 同签名覆盖安装
```

**ABI 必须与设备匹配。** ABI 不匹配会导致引擎启动即崩——node ELF `EM_X86_64` vs `EM_AARCH64`。
真机选 arm64 包，模拟器选 x86_64 包。

## 构建

快照构建与打包在**协调仓库**（[dsh-mobile](https://github.com/kelai141/dsh-mobile)）完成，
本仓库是壳子仓库。要求：JDK 17+、Android SDK（compileSdk 36）；Gradle 8.11.1 由 wrapper 提供。

```powershell
# 快照构建（Termux 源 + 依赖闭包 + pnpm + cordis 权威覆盖 + 瘦身）：
node scripts\build-snapshot-013.mjs <arm64|x86_64>

# 一键打包（快照 → 注入 → 门禁 → gradle）：
pwsh scripts\build-apk-013.ps1 -Suffix "-preview"
# 产物: out\v0.13.0\dsh-mobile-apk-v<ver>-<abi>.apk
```

门禁（`build-apk-013.ps1` 内）：第三方合规（`check-third-party.mjs`，GPL 义务）/ 🔒机密 /
ELF / cordis 挂载集⊇注入集 / LICENSES 自检（Python 流式）——任一不过即拒打包。

## 桥协议 v1（`window.androidBridge`）

应用名 `DeepCode`（图标文字 DeepSearch）、包名 `com.dsharnessmobile.shell`。
`androidBridge.version` 返回应用版本号（当前 `0.13.0-fx-1`，versionCode 26），
页面按它做 feature-detect。下列 ADB 方法为预览授权面——真实通道在 0.13.0 正式版完成。

**同步返回**

| 方法 | 签名 | 说明 |
|---|---|---|
| `version` | () → string | 应用版本号（`0.13.0-fx-1`），feature-detect 用 |
| `getSystemDark` | () → boolean | 系统深色模式（绕过部分厂商 WebView `matchMedia` 失效，首帧主题用） |
| `checkEngine` | () → string | 探测 127.0.0.1:3080；JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | () → boolean | 是否已授予「所有文件访问」权限（外部工作区要求） |
| `getPickToken` | () → string | 目录选择桥的一次性会话 token（引擎侧 pick 端点校验） |
| `copyText` | (text) → boolean | 写入系统剪贴板（WebView `clipboard.writeText` 被拒时的回退） |
| `getDevLogEnabled` | () → boolean | dev 日志开关状态 |
| `getAdbState` | () → string | ADB 授权状态视图（三道门状态机）：JSON `{fullAccess, allowSwitch, paired, wirelessDebugOn, message}`（预览） |
| `discoverAdbPorts` | () → string | 无线调试端口自动扫描（原生 TCP 盲扫）：配对端口候选 JSONArray；无线调试未开时返回 `[]`（预览） |
| `setAdbPair` | (code, pairPort, connectPort) → boolean | 门3 配对：真执行 `adb pair` 握手；码值只进 argv，不入审计（预览） |
| `adbShell` | (cmd) → string | ADB shell 执行原语：JSON `{ok, stdout?, stderr?, guidance?}`；未授权 fail-closed（预览） |

**命令**

| 方法 | 签名 | 说明 |
|---|---|---|
| `keepScreenOn` | (enable) | 屏幕常亮开关 |
| `showNotification` | (title, text) | 通知测试通道（POST_NOTIFICATIONS） |
| `pickDirectory` | (callbackId) | SAF 目录选择；结果经 `window.__dshBridge.onDirectoryPicked(callbackId, path)` 异步回传 |
| `pickImage` | (callbackId) | SAF 图片选择；结果同上异步回传 |
| `setTextZoom` | (percent) | WebView 字体缩放（50–200，设置页滑杆） |
| `setImmersiveMode` | (enable) | 沉浸式状态栏开关（true = 状态栏常隐） |
| `downloadDebugLogs` | () | 导出引擎日志 + 环境信息（压缩包，走系统分享/下载） |
| `requestAllFilesAccess` | () | 打开系统「所有文件访问」授权页（特殊权限） |
| `restartEngine` | () | 重启引擎进程（EngineService 看门狗拉起） |
| `shutdownToGuide` | () | 停引擎并回退到测试界面（不自动重启） |
| `reloadWebUI` | () | 重新加载 Web UI |
| `openConsole` | () | 打开内置控制台 |
| `setDevLogEnabled` | (enabled) | 设置 dev 日志开关（开启后日志写入 `dshdata/log/`） |
| `setAdbAllow` | (enable) | 门2「允许访问」开关（默认关；关闭即通道失败关闭）（预览） |
| `revokeAdbPair` | () | 回收配对（disconnect + 删 adbkey + 清状态；配套审计）（预览） |

桥协议让 APK 与 dsh 版本解耦：页面按 `androidBridge.version` 做特性检测。

## 在线更新协议

1. App 拉取 `manifest.json`：`{url, sha256, size}`（默认 `http://10.0.2.2:8899/manifest.json`
   供模拟器测试；生产指向发布服务器）；
2. 下载快照 → 校验 SHA-256 → 解压到 staging（不碰线上目录）→ 原子切换 `usr` → 杀掉旧引擎 →
   看门狗用新运行时重启。

测试触发：`adb shell am start -n com.dsharnessmobile.shell/.MainActivity -a com.dsharnessmobile.shell.action.UPDATE`；
状态写入 `files/update-status.txt`。测试服务器：本地起 HTTP 服务提供 `manifest.json` 与快照文件
（默认指向 `http://10.0.2.2:8899/manifest.json`，模拟器映射宿主机）。

## APK 自更新协议（0.13.8）

与上面的运行时快照更新**完全分离**（`UpdateChecker` vs `UpdateManager`），只管 APK 本体：

1. **仅手动**：启动页「检查更新」按钮触发，**不自动检查**（169MB 资产不做任何后台/自动行为）；
2. **元数据**：`api.github.com/repos/kelai141/dsh-mobile-apk/releases/latest` 直连（10/15s 超时）；
   失败如实报原因（HTTP 码/异常），且**不阻断**既有的引擎快照更新检查（同一按钮接着跑快照检查）；
3. **资产匹配**：`dsh-mobile-apk-v<版本>-<abi>.apk`，ABI 取 `SUPPORTED_ABIS[0]`（设备原生 ABI——
   带 ARM 翻译的 x86 设备 abilist 形如 `x86_64,arm64-v8a,x86`，按「含 arm64 即 arm64」会下错包）；
4. **版本比较**：tag 与 `BuildConfig.VERSION_NAME`（去 `-SN-*` 快照后缀）逐数字组比大小——
   覆盖语义化版本与 `0.13.7fx-N` 修订号两种命名；
5. **镜像链下载**：`github.com` 直连 → `gh-proxy.com` → `ghfast.top` 逐级回退，落
   `Documents/dshdata/updates/`（FileProvider 既有映射内），`.tmp` → rename 原子；有 `.sha256`
   资产则校验，校验失败即删文件并报错；已下好且校验通过的包不重复下载（授权中断后可直接续继）；
6. **安装**：未持有「安装未知应用」权限 → 先拉起系统授权页（返回后 `onResume` 自动续继）→
   FileProvider URI + `ACTION_VIEW` 唤起系统安装器；签名不匹配由系统拒绝。应用**不静默安装**。

这是壳侧唯一的外部 HTTP 出口（其余壳侧 HTTP 全部收敛到本地引擎同源 `127.0.0.1:3080`），
仅在用户点击按钮时发起。

## 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | WebView + 引擎探测 + APK 自更新（仅手动触发） |
| `POST_NOTIFICATIONS` | 通知通道（API 33+ 运行时请求） |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | 保活前台服务 |
| `MANAGE_EXTERNAL_STORAGE` | 「所有文件访问」（外部工作区要求；特殊权限，用户手动授予） |
| `REQUEST_INSTALL_PACKAGES` | 唤起系统安装器安装下载的更新包（0.13.8；须用户在系统页显式授权，「安装未知应用」） |

SAF 目录/图片选择无需权限。

## ABI 与页大小

arm64 与 x86_64 均已端到端验证；APK 按 ABI 分发（快照内嵌架构相关）。16KB 页构建需在
16KB 设备上产出（见 docs/design.md §ABI）。

## License

MIT。第三方组件按各自许可（见依赖声明）。GPL 合规：copyleft 全文三形态在场——快照
`usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`。设计文档：`docs/design.md`。

## 致谢与邀请

**感谢全体社区成员的反馈与贡献！** 特别致谢：cdwlll（环境问题反馈）、haitunlang（MIUI12 兼容）、
TACONailoong（老 WebView 兼容方案）、X-SCI-TECH（PR 贡献）、Yangerwei（文件竞态反馈）、
gr12-cmd（armv7l 需求）、cmyfqwq（覆盖安装兼容反馈）。

**诚邀各位开发者参与**：欢迎提交 issue、PR、建议与改进。我们特别需要：Android 兼容性测试
（华为/荣耀/小米等定制 WebView）、armv7l 等更多机型支持、ADB 通道完善、插件生态扩展。
开发维护规范见各仓库 `AGENTS.md`（开发地图）。