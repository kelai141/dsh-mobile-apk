# 壳 APK 设计（dsh-mobile-apk）

> 版本 v2.0 ｜ 2026-08-20 ｜ 由 M1 纯壳演进为内嵌快照运行时（M2 保活/自更新/控制台已落地）

---

## 1. 形态与边界

- **内嵌运行时**：随包 `assets/snapshot.tar.xz`（~154MB，解压后 ~740MB；node + bash + coreutils + dsh + 插件），
  首启解压到应用自身目录并启动引擎；完全离线，无需 Termux app；
- **WebView 消费** `http://127.0.0.1:3080`（快照内 dsh web 服务）；APK 与引擎版本解耦
  （桥协议版本化 `androidBridge.version`）；
- **引擎不可达时**：原生启动/测试界面（guide view）——状态、解压/更新进度、崩溃横幅、engine.log 摘要、
  重试/打开控制台/检查更新；引擎崩溃由看门狗自动恢复；
- **内置控制台**：`assets/console.html` + 快照内嵌 Termux bash 交互终端（`ConsoleActivity`），
  引擎未运行也可排查；
- **零 fork、零侵入**：页面侧不做任何改动；桥能力全部经 `@JavascriptInterface` 注入。

## 2. 桥协议 v1（window.androidBridge）

`version` 返回应用版本号（`BuildConfig.VERSION_NAME`，当前 `0.12.4`）；页面按它做 feature-detect。
实现见 `AndroidBridge.kt`。

**同步返回**

| 方法 | 签名 | 说明 |
|---|---|---|
| version | () → String | 应用版本号 |
| getSystemDark | () → Boolean | 系统深色模式（绕过厂商 WebView matchMedia 失效，首帧主题用） |
| checkEngine | () → String | 探测 127.0.0.1:3080，返回 `{running, latencyMs, error?}` JSON |
| hasAllFilesAccess | () → Boolean | 是否已授予「所有文件访问」 |
| getPickToken | () → String | 目录选择桥一次性会话 token（引擎侧 pick 端点校验；null = 禁用） |
| copyText | (text) → Boolean | 写入系统剪贴板（WebView clipboard 被拒的回退） |
| getDevLogEnabled | () → Boolean | dev 日志开关**事实** = 偏好 && 采集器在跑（ST-11：EngineService.onDestroy 停采集器后不再乐观显示「开」） |
| getImmersiveMode | () → Boolean | 沉浸式状态栏开关的壳侧权威值（ST-10：真源 = `dsh_settings/immersive_mode`；页面以它为唯一初值） |

**命令**

| 方法 | 签名 | 说明 |
|---|---|---|
| keepScreenOn | (enable) | 屏幕常亮开关 |
| showNotification | (title, text) | 通知测试通道（POST_NOTIFICATIONS 运行时请求） |
| pickDirectory | (callbackId) | SAF 目录选择（ACTION_OPEN_DOCUMENT_TREE）；结果异步经 `onDirectoryPicked(callbackId, path)` 回 JS |
| pickImage | (callbackId) | SAF 图片选择；结果同上异步回传 |
| setTextZoom | (percent) | WebView 字体缩放 50–200 |
| setImmersiveMode | (enable) | 沉浸式状态栏开关（true = 状态栏常隐） |
| downloadDebugLogs | () | 导出引擎日志 + 环境信息（压缩包） |
| requestAllFilesAccess | () | 打开系统「所有文件访问」授权页 |
| restartEngine | () | 重启引擎进程（看门狗拉起） |
| shutdownToGuide | () | 停引擎并回退测试界面（不自动重启） |
| reloadWebUI | () | 重新加载 Web UI |
| openConsole | () | 打开内置控制台 |
| setDevLogEnabled | (enabled) | 设置 dev 日志开关（开启后写入 `dshdata/log/`） |

**路径映射**（`pickDirectory` 回传）：`content://` tree URI → Termux 可见真实路径：
`primary:rel/path` → `/storage/emulated/0/rel/path`；非 primary 卷退回原样 `content://`。
路径做 `..` / 绝对路径净化（防逃逸）。

## 3. 权限集

| 权限 | 用途 | 时机 |
|---|---|---|
| INTERNET | WebView + checkEngine | 声明 |
| POST_NOTIFICATIONS | 通知测试通道 | API 33+ 运行时请求 |
| FOREGROUND_SERVICE + FOREGROUND_SERVICE_DATA_SYNC | 保活前台服务 | 声明 |
| MANAGE_EXTERNAL_STORAGE | 所有文件访问（外部工作区） | 特殊权限，用户手动授予 |

SAF 目录/图片选择无需权限（用户经系统文件管理器授权 tree URI）。

## 4. 页面结构

```text
MainActivity
 ├─ onCreate: 解压快照（首次）→ 引擎探测后台线程
 │   ├─ 可达 → WebView 加载 http://127.0.0.1:3080
 │   └─ 不可达 → guideView（品牌区/状态卡/操作区，入场 stagger 动画）
 ├─ WebView 配置: JS 启用 / DOM storage / file chooser / 系统栏避让（CSS 变量注入）
 ├─ AndroidBridge 注入: 20 个 @JavascriptInterface 方法（见 §2）
 ├─ 引擎监控: 3s 轮询（down → 测试界面，up → 恢复 WebUI）
 ├─ 看门狗: EngineService 5s 调度（引擎崩溃自动拉起）
 ├─ 返回键: 先 WebView.canGoBack，否则 finish
 └─ 更新入口: ACTION_UPDATE intent → runUpdate（manifest → 下载 → 校验 → 原子切换）

ConsoleActivity: assets/console.html（快照内嵌 bash 交互终端，输出裁剪 2000 行）

EngineService: 前台服务（keep-alive）+ 看门狗；Shizuku 保活增强（可选）
```

## 5. 工程骨架

```text
dsh-mobile-apk/                 ← 独立 git 仓库
├── settings.gradle.kts / build.gradle.kts / gradle.properties
├── gradle/wrapper/             ← Gradle 8.11.1 wrapper（随仓入库）
├── keystore/debug.keystore     ← 固定 debug 签名（CI/本地一致，可覆盖安装）
├── docs/design.md              ← 本文档
└── app/
    ├── build.gradle.kts        ← AGP 8.9.x, Kotlin 2.0.x, minSdk 26, targetSdk 34, compileSdk 36
    │                            applicationId com.dsharnessmobile.shell, versionCode 18, versionName 0.12.4
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/
        │   ├── console.html    ← 内置控制台
        │   ├── patched/        ← 上游 dsh 前端补丁 bundle（linguist-vendored）
        │   └── snapshot.tar.xz ← 运行时快照（Release 分发，不入库；缺失时构建失败并提示）
        ├── java/com/dsharnessmobile/shell/
        │   ├── MainActivity.kt / AndroidBridge.kt / ConsoleActivity.kt / ConsoleSession.kt
        │   ├── EngineManager.kt / EngineProbe.kt / EngineService.kt
        │   ├── SnapshotExtractor.kt / UpdateManager.kt / LogCollector.kt / ShizukuSupport.kt
        └── res/                ← 设计 token（colors/dimens/themes 双态）+ 启动图标
```

## 6. 验证矩阵（设备）

| # | 步骤 | 预期 |
|---|---|---|
| V1 | 干净安装（CI 签名 APK） | 安装成功、首启解压、启动无崩溃 |
| V2 | 引擎在跑时打开 | WebView 显示 dsh 移动 UI（厂商 WebView 已验证） |
| V3 | 引擎被杀/未启动时打开 | 测试界面显示状态；看门狗 5s 内自动拉起并恢复 WebUI |
| V4 | SAF pickDirectory / pickImage | 回调收到映射路径 / 图片 URI |
| V5 | 通知测试 / 控制台 | 通知出现；控制台可执行 bash 命令 |
| V6 | 深/浅色模式 | 原生界面与控制台均正常（显式文本色，无黑字黑底） |
| V7 | 返回键 | 先回退页面历史，不误退 |
| V8 | 快照更新（adb UPDATE action） | 下载→校验→原子切换→新运行时重启，状态写 `files/update-status.txt` |

## 7. 已知限制

- 应用数据内 ELF 执行限制：targetSdk 34（Android 15+ 禁止 targetSdk 35+ 执行应用数据 ELF，
  34 保持原生 exec 可用）；
- Shizuku 保活为 best-effort（能拿到 binder 才生效），无 Shizuku 时退化为前台服务 + 看门狗；
- 16KB 页构建需在 16KB 设备上产出；APK 按 ABI 分发（内含快照与架构绑定）；
- `pickImage` 回传的是 SAF URI 字符串，页面侧按 content URI 处理。