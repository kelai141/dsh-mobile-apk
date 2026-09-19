# DEPENDENCIES.md — 引用库权威登记

> 职责：APK 构建期依赖（gradle 7 项）、平台内置库、探活反射项与内嵌引擎边界的登记与升级策略。版本号 2026-09-14 抄自 `app/build.gradle.kts`（依赖声明 :111-120）与根 `build.gradle.kts`；工具链实测：AGP 8.8.2 / Kotlin 2.0.21 / Gradle 8.11.1 / Java 17（compileOptions/target 17）。

## 1. 工具链（根 build.gradle.kts + gradle-wrapper.properties）

| 项 | 值 | 备注 |
|---|---|---|
| Android Gradle Plugin | 8.8.2 | 根 build.gradle.kts |
| Kotlin Android 插件 | 2.0.21 | 根 build.gradle.kts（jvmTarget 17） |
| Gradle | 8.11.1 | gradle-wrapper.properties distributionUrl（发布链必须用本仓 wrapper，勿用系统 gradle） |
| compileSdk / targetSdk / minSdk | 36 / 34 / 26 | 理由见 docs/AGENTS/ANDROID-API-USAGE.md §5 |
| versionCode / versionName | 38 / 0.14.0-preview | app/build.gradle.kts:25-30（快照构建可加 -PversionNameSuffix） |
| 签名 | repoDebug（keystore/debug.keystore，CI 与本地字节兼容） | build.gradle.kts 签名块注释：跨机同签名是覆盖安装前提 |
| lint | checkReleaseBuilds=false / abortOnError=false | 离线环境无 lint 缓存，不在发布关键路径 |

## 2. gradle 依赖（app/build.gradle.kts:111-120，共 7 项，全部 implementation）

| 依赖 | 版本 | 用途（代码锚点） | 换掉的成本 |
|---|---|---|---|
| dev.rikka.shizuku:api | 13.1.5 | Shizuku 特权 transport：`ShizukuTransport` 直连 API（权限状态/UserService bind/绑定回调） | 回退反射会失去 UserService 强类型通道；Shizuku 是 0.14 U-4 拍板的正式特权 transport |
| dev.rikka.shizuku:provider | 13.1.5 | manifest `rikka.shizuku.ShizukuProvider`（binder bootstrap，`INTERACT_ACROSS_USERS_FULL` 保护，门禁白名单放行） | 自写 provider 需对齐 Shizuku binder 协议；随 api 同步升级 |
| androidx.activity:activity-ktx | 1.10.1 | ComponentActivity 基类（MainActivity/ConsoleActivity）；ActivityResultContracts 目录/权限等契约（ConfigTransfer、MainActivity） | 自写 ActivityResult 分发与回调生命周期；选择器「字段初始化即注册」时序约束要重推 |
| androidx.core:core-ktx | 1.15.0 | FileProvider（PathOpen 外部打开）；ViewCompat/WindowInsetsCompat/WindowCompat（insets 三件套、ShellState 沉浸式） | FileProvider 可自实现 ContentProvider 但需自管 URI 授权与安全边界；insets 兼容层要回退平台 API 并全档自测 |
| androidx.dynamicanimation:dynamicanimation | 1.1.0 | **壳侧已无使用方**（0.14.1 块I 删除 OverlayService 的 springSnapToEdge/cancelSpring/springAnim 与贴边吸附，详见坑 147 邻域与 docs/0.14.1-preview-HALO-FREE-MOVE-AND-RING.md §4.1）——依赖声明**按详档判定保留**，供将来动效复用 | 手写 spring 微分方程或降级 ValueAnimator；保留声明的原因：删依赖会牵动 gradle/lock 面与用途表，收益为零 |
| org.apache.commons:commons-compress | 1.28.0 | 快照 xz tar 流式解压（TarArchiveInputStream/XZCompressorInputStream，SnapshotExtractor）——快照逐文件解压 + owner-only 权限 + exec xattr 全走它 | 自实现 xz+tar 成本极高；换库需重验数万文件流式解压与 symlink 保留 |
| org.tukaani:xz | 1.10 | xz 解码算法后端（commons-compress 依赖它做 XZ） | 与 commons-compress 绑定，单独换无意义 |

### 2.1 使用面实测（grep import 计数，2026-09-14）

| 依赖 | 使用文件数 | 明细 |
|---|---|---|
| activity-ktx | 4 | MainActivity、ConsoleActivity、GuideChrome（ComponentActivity 引用）、ConfigTransfer（契约） |
| core-ktx | 7 | MainActivity、ConsoleActivity、WebUiChrome、EngineService、NotifyCenter（NotificationCompat）、FileIncoming、ShellState |
| dynamicanimation | 0 | 0.14.1 块I 起壳侧零使用方（原 OverlayService 的贴边吸附已删；声明保留，用途变化已登记） |
| commons-compress | 2 | SnapshotExtractor（解压主路径）、EngineManager（快照刷新复用同一套 tar/xz 流） |
| xz | 0（间接） | 经 commons-compress 的 XZCompressorInputStream 间接使用 |
| shizuku api/provider | 2 | ShizukuTransport（api 直连）、ShizukuUserService（AIDL/Stub 基类） |

### 2.2 相关构建配置（build.gradle.kts 实测）

- `buildConfigField TERMUX_VERSION = "0.118.3"`（:31）：快照内 Termux 基线版本号，用于运行时一致性展示/诊断。
- `androidResources.noCompress += "xz"`（:46，注释：snapshot.tar.xz 已 xz 压缩，AAPT 二次压缩破坏流式读取）——commons-compress 依赖拿到原始字节流的前提。
- mergeDebugAssets/mergeReleaseAssets doFirst 校验：assets/snapshot.tar.xz 缺失即抛 GradleException 并给出下载指引（快照大文件不入库）。

## 3. 平台内置（无 gradle 依赖，勿加重复坐标）

- **org.json**（JSONObject/JSONArray/NULL 语义）：Android 平台内置，多文件使用——AndroidBridge、AdbState、EngineProbe、FileIncoming、OverlayLiveFeed、OverlayPanel、UpdateManager、OverlayService、WatchdogV2、BrowserHost、Notify*、Vdisplay* 等。注意桥返回 JSON 以真机内置实现为准（NULL 处理曾有 `optString` 对 NULL 返 "null" 字面量的坑，悬浮球会话标题已判空）。
- **手写 WebSocket**（MuxClient.kt）：java.net.Socket + Base64 + MessageDigest(SHA-1) + SecureRandom 完成 RFC6455 握手/帧解析/掩码——不引 OkHttp 等网络库（换掉的成本 = 新增 3-4MB 依赖面 + 回环信任围栏行为重验，且 downlink-only 语义要重验）。
- **其他 java.* 面**：HttpURLConnection（DownloadSaver/EngineProbe/OverlayService.postRpc/OverlayPanel.postRespond/UpdateManager/ControlPoller）、ProcessBuilder（EngineManager/ConsoleSession/AdbState/ShizukuUserService spawn）、java.nio.file.Files（EngineManager）——均标准库，零依赖。

## 4. Shizuku 依赖面（0.14.0 由反射转正式依赖，历史决策见 git）

- **直连（新）**：`ShizukuTransport`/`ShizukuUserService`/`VdisplayController` 使用 `dev.rikka.shizuku:api/provider 13.1.5` 的类型（`Shizuku.UserServiceArgs`、`Stub.asInterface` 等），承载虚拟屏特权 transport。
- **反射（保留）**：`ShizukuSupport`（引导页状态行）与 `ShizukuProbe`（五态探针，fail-closed）仍走 `Class.forName` 反射——探针在 aar 未接入/类被 shrink 时也能安全降级。
- **授权纪律**：Shizuku 授权只能由用户在 Shizuku App 内授予；壳侧只做标准请求与状态读，不把授权请求当作授予（`ShizukuTransport` 文件头注释）。
- **合规现状（缺口）**：Shizuku 为 Apache-2.0 的 gradle aar 依赖；`check-third-party.mjs` 只覆盖快照 dpkg 矩阵，**不覆盖 gradle aar**，`assets/licenses/THIRD_PARTY_NOTICES.md` 也未含 Shizuku 条目——补登记事项见 `known-gaps.md`（0.14.0 收尾）。

## 5. 内嵌引擎与快照依赖（不进 gradle 的第二依赖面）

- 引擎：`@deepseek-ai/dsh` 0.1.5-rc.1，快照内 `usr/lib/node_modules/@deepseek-ai/dsh`（EngineManager dshBin），web 模式监听 127.0.0.1:3080（--no-open）；APK 版本与引擎版本解耦，桥协议版本化（androidBridge.version）。
- 快照内 npm 依赖树（@deepseek-ai/* 包、react/shiki 等 cordis 装配）与 Termux 包（node/git/android-tools 等）由协调仓 `scripts/build-snapshot-013.mjs` 构建注入，**不在本仓库管理**。
- 许可合规边界：全部第三方清单与许可证全文随包分发在 `assets/licenses/`（THIRD_PARTY_NOTICES.md + GPL-2.0/GPL-3.0/LGPL-2.1/LGPL-3.0 四全文）；清单由协调仓 `scripts/check-third-party.mjs` 从快照 dpkg 清单生成（GPL 义务硬门禁）。本文件只登记构建期依赖；快照内依赖以该文件为权威。

## 6. 升级策略建议

1. **低频原则**：依赖面服务于「稳定壳 + 云端自包含构建」，无功能需求不主动升级；AGP/Kotlin 升级必须连带验证 `.github/workflows/build-apk.yml` 与本地 `gradlew assembleDebug` 双链一致。
2. **必测真机回归项**（任何依赖变更后）：快照全量解压（指纹翻转 + `.snapshot-fingerprint` 更新，勿中途杀进程）；引擎冷启动探活与市场安装（linker64 回退 + termux-exec preload 链）；悬浮球三窗口显示/无吸附拖动手感（dynamicanimation 已无使用方，见用途表）；SAF 目录选择与 All Files Access 分代（activity-ktx 契约敏感，26-29/30+/33+ 三档）；FileProvider 外部打开白名单（core-ktx）；Shizuku transport（api/provider 版本与 Shizuku App 侧协议兼容——升级前先在模拟器装对应 Shizuku 版本实测 bind）。
3. **commons-compress/xz 锁定**：与快照 tar 产物格式强耦合，仅在快照构建链同步验证后升级；解压失败 = 用户首启白屏级事故。
4. **新增依赖**：先过 GPL/许可合规（登记 scripts/third-party-licenses.json + THIRD_PARTY_NOTICES.md），再评估体积与 ABI 面——当前零 JNI/.so 依赖，保持该状态。

