# dsh-mobile-apk — DeepSeek Harness 安卓壳 APK

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)


> **dsh-mobile 生态** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

> ⚠️ **这是预览版（0.13.0-preview）**：不稳定，用于社区验证与反馈，不建议当作生产依赖。
> - **ADB 未完成**：配对 / 端口自动扫描 / 执行为预览界面——真实 ADB 通道开发中，0.13.0 正式版完成。
> - **插件市场适配警示**：内置市场牵涉大量第三方插件，**绝大多数插件在手机端不一定可用、大概率有 bug**（移动端与桌面端在 WebView 内核/文件系统/权限模型/运行环境差异大）；移动端适配是长期工程，beta 阶段以「可用性验证与反馈」为主，暂不建议当作生产依赖。插件报错请到 [issues](https://github.com/kelai141/dsh-mobile-apk/issues) 反馈（附机型/版本/复现步骤）。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安卓壳：WebView UI 覆盖
**内嵌 Termux 运行时快照**（解压即跑，无需 Termux app）、SAF 目录桥、保活前台服务、引擎看门狗、
运行时在线更新。一个 APK 装完即用：完整的 dsh web agent，且能真实执行 bash。应用名 `DeepCode`
（图标文字 DeepSearch）、包名 `com.dsharnessmobile.shell`、版本 `0.13.0-preview`（versionCode 24）。

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
- **SAF 桥**：`pickDirectory` 把所选目录映射为真实路径（`/storage/emulated/0/…`）；
- **设备访问**：所有文件访问；Shizuku 探活示例；
- **ADB 授权界面（预览）**：三道门授权状态机 + 配对端口自动扫描（真实 ADB 通道开发中，
  0.13.0 正式版完成）。

## 下载 / 安装

Release `v0.13.0-preview` 提供双 ABI 包：

| APK | 适用 |
|---|---|
| `dsh-mobile-apk-v0.13.0-preview-arm64.apk` | arm64 设备（真机） |
| `dsh-mobile-apk-v0.13.0-preview-x86_64.apk` | x86_64 模拟器 / 设备 |

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
`androidBridge.version` 返回应用版本号（当前 `0.13.0-preview`，versionCode 24），
页面按它做 feature-detect。下列 ADB 方法为预览授权面——真实通道在 0.13.0 正式版完成。

**同步返回**

| 方法 | 签名 | 说明 |
|---|---|---|
| `version` | () → string | 应用版本号（`0.13.0-preview`），feature-detect 用 |
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

## 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | WebView + 引擎探测 |
| `POST_NOTIFICATIONS` | 通知通道（API 33+ 运行时请求） |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | 保活前台服务 |
| `MANAGE_EXTERNAL_STORAGE` | 「所有文件访问」（外部工作区要求；特殊权限，用户手动授予） |

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
gr12-cmd（armv7l 需求）。

**诚邀各位开发者参与**：欢迎提交 issue、PR、建议与改进。我们特别需要：Android 兼容性测试
（华为/荣耀/小米等定制 WebView）、armv7l 等更多机型支持、ADB 通道完善、插件生态扩展。
开发维护规范见各仓库 `AGENTS.md`（开发地图）。