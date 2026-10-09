# DEPENDENCIES.md — 引用库权威登记

> 依赖以 [APK Gradle 声明](../../app/build.gradle.kts) 和 [引擎 overlay](../../scripts/snapshot-config/engine-overlay.json) 为准。生成区由 `node scripts/check-maintenance-docs.mjs --write` 更新，`node scripts/check-maintenance-docs.mjs` 检查；源码声明不证明产物版本、ABI、hash 或测试通过。

## 1. 工具链与构建声明

| 项 | 源码值 / 约束 |
|---|---|
| 工具链 | 声明见下方生成区；发布与开发使用项目 wrapper，不用系统 Gradle 替代。 |
| Android API / 应用版本 / 依赖声明 | 见下方 Gradle 生成区；任何新增 API 保持 minSdk 守卫。 |
| Termux基线 | 见下方生成区的 BuildConfig.TERMUX_VERSION 源声明。 |
| 签名 | repoDebug固定keystore，来源链与正常链使用同一证书；终包签名指纹由真实构建后补，不虚构。 |
| lint | checkReleaseBuilds=false / abortOnError=false，不等于功能或安全门禁通过。 |

## 2. Gradle依赖

<!-- generated:gradle-declarations:start -->
当前源码声明：versionName `0.14.5-fx-2` / versionCode `49`；suffix 来自 Gradle 属性。此处不证明 APK 产物或验收状态。

| 配置 | 声明 |
|---|---|
| AGP | 8.8.2 |
| Kotlin | 2.0.21 |
| Gradle wrapper | 8.11.1 |
| Java target | 17 |
| Termux | 0.118.3 |
| compileSdk | 36 |
| targetSdk | 34 |
| minSdk | 26 |

| Gradle 范围 | 依赖声明 |
|---|---|
| implementation | `dev.rikka.shizuku:api:13.1.5` |
| implementation | `dev.rikka.shizuku:provider:13.1.5` |
| implementation | `androidx.activity:activity-ktx:1.10.1` |
| implementation | `androidx.webkit:webkit:1.12.1` |
| implementation | `androidx.core:core-ktx:1.15.0` |
| implementation | `androidx.dynamicanimation:dynamicanimation:1.1.0` |
| implementation | `org.apache.commons:commons-compress:1.28.0` |
| implementation | `org.tukaani:xz:1.10` |
| testImplementation | `junit:junit:4.13.2` |
| androidTestImplementation | `androidx.test.ext:junit:1.2.1` |
| androidTestImplementation | `androidx.test:runner:1.6.2` |
| testImplementation | `org.json:json:20240303` |
<!-- generated:gradle-declarations:end -->

| 依赖 | 当前用途 / 升级联动 |
|---|---|
| dev.rikka.shizuku:api/provider | 强类型UserService/API与bootstrap；ShizukuTransport/ShizukuUserService/VdisplayController。源码POM登记口径为MIT，不沿用旧文的Apache-2.0误记；aar notices仍须按实际分发核实。 |
| androidx.activity:activity-ktx | ComponentActivity、ActivityResult；同文件legacy ConfigTransfer未挂载，但DirectoryPickerController的SAF注册仍被MainActivity使用。 |
| androidx.webkit:webkit | BrowserHost document-start/UA-CH；0.14.3 BrowserHostProfile需要MULTI_PROFILE、set/getProfile、profile cookie/webStorage/geolocation/serviceWorker API。必须运行时feature gate并在load/settings前验证nonDefault，不能fallback Default。 |
| androidx.core:core-ktx | FileProvider、NotificationCompat、insets与WindowCompat等。 |
| androidx.dynamicanimation:dynamicanimation | 声明保留；贴边spring已退役，不能当现行悬浮球行为。 |
| org.apache.commons:commons-compress | 快照tar/xz流式解压、symlink/权限/xattr路径；noCompress xz保留原字节流。 |
| org.tukaani:xz | commons-compress的XZ算法后端。 |
| junit:junit | JVM策略/core/源码接线及process/capture settlement fixtures。 |
| org.json:json | JVM真实JSONObject/JSONArray，Android平台运行用系统实现。 |
| androidx.test.ext:junit / runner | VirtualDisplay instrumentation探针，不进产品工具面。 |

新core/lease/issue政策类未添加Gradle生产依赖；同文件ShizukuCaptureIo与EpochResourceOwner也复用java/Android基础能力。Profile.dispose只停自己的worker并flush自己的cookie；limited clear不承诺清空IndexedDB/CacheStorage/worker registration，不能调用全局singleton实现隔离。

## 3. 平台内置与探活

org.json、ProcessBuilder、HttpURLConnection、java.nio.file、java.util.concurrent是平台/标准库；Root维护使用android.system.Os的held-FD/no-follow操作，不引重复JNI依赖。ProcIo独立cleanup workers不阻塞waiter，返回不可变partial；耐久lease用Context私有SharedPreferences commit与boot-id/BOOT_COUNT，未知epoch拒绝。手写MuxClient WebSocket握手/帧协议依赖Socket、SHA-1、Base64，不因浏览器迁移另引网络库。

ShizukuSupport/ShizukuProbe仍反射探活，授权只能由用户在Shizuku中授予；原生应用su授权与AI root consent是独立门。多用户采用完整UID。UserService协议v4与应用版本绑定，升级/存活服务需要确认configuration，旧服务不能冒充已配置。

## 4. 引擎、npm与许可的第二依赖面

当前源码适配目标为官方 dsh-v0.2.0-rc.2 / commit 639ed015397290b3745d163aafe02ffee4aa3f84（预发布，不称stable）。overlay root/第一方包0.2.0-rc.2、pi-ai0.87.1、Cordis4.0.4及官方Lexical0.49.0家族是源码输入；APK内实际版本待终包核实。自包含来源链和协调仓共同管理快照npm/Termux闭包，不是“APK仓不管理”。旧Cordis回退源码逻辑不能继续套在新目标上。

raw npm overlay不会自动保留官方pnpm patch。六provider pi-upstream-streaming-020需固定官方patch SHA并精确上下文；Android PTC A1需host/child双目标和副本同步。具体补丁、目标与构建钩子状态见 [运行时补丁台账](RUNTIME-PATCHES.md)。

官方浏览器UI仅私有MIT复用BrowserBody/Title/controller契约，保留SOURCE清单/LICENSE，不导入官方feature插件运行时公开API或Electron/Iframe实现；Sidebar指南与tab框架通过注册消费。组件源码/manifest的目标依赖不等于lib已重建或镜像已完成。GPL/第三方notice按快照dpkg与aar/npm各自范围核实，dpkg门禁不覆盖aar；合规状态必须核对当前候选的最终 license artifact。

## 5. 升级回归与证据

版本变更需同步来源pin、lock根声明、同源补丁/资产、双仓副本及许可来源。运行时资产从目标版本原始产物完整重建，不叠旧资产；逐字节一致与全部补丁marker/精确verifier都要成立。webKit升级重点验证profile首次赋值、worker/cookie/storage隔离、不支持provider失败、UA-CH与Activity重建holder；Shizuku重点验证旧AIDL服务、工作资料UID、chunk撤consent与耐久UNKNOWN。快照/SAF/Files/通知/控制台/引擎流式任务按 [外部测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>) 执行。

当前候选的自检、构建与三层验收状态见对应版本的阶段交接记录；本文件只登记依赖与升级联动，不独立宣称发布批准。0.14.3 外部测试需求属于历史版本证据，不能代替当前候选验收。
