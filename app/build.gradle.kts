plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.dsharnessmobile.shell"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.dsharnessmobile.shell"
    minSdk = 26
    // targetSdk 34: Android 15+ forbids exec of app-data ELF for targetSdk 35+
    // (the embedded engine, bash, and every child command would need linker64
    // wrappers); 34 keeps native exec working on Android 15/16 devices.
    targetSdk = 34
    // 0.14.2-fx-1：versionCode 42（覆盖安装 0.14.2(41)）。
    // fx-1 是 0.14.2 的修订版，**必须**抬 vc：同 code 装不上（无法覆盖安装），
    // 且 vc41 与已发布的 0.14.2 相同会让系统/用户无法区分两者。
    // 本版主题 = 用户报障四缺陷（启动页文案闪烁 / 九键条多抬一个键盘 /
    // 插件面板无返回键 / 插件市场未适配 0.1.7）。
    // 注意 vc 必须轮换：上一版已用 40 发布过，同 code 装不上（无法覆盖安装）。
    // 本版主题 = 追上游 0.1.7-rc.1 + 四条 boot 阻断清零 + 远端 issue/PR 收口：
    //  ① 引擎 overlay 追版 rc.1（vendorTop 闭包 +19 包、cosmokit 1.8.3→1.8.5）；
    //  ② narb-android-N1 补丁：无 native binding 时回落 require()（否则 rc.1 在本平台 boot 硬崩）；
    //  ③ office-to-pdf 行显式禁用（libreoffice-kit 在 Android 无条件抛，禁行 = 用上游自身降级面）；
    //  ④ #249 迁移删剩空壳 - insert:（升级后 boot TypeError）；
    //  ⑤ #258 多窗口/自由窗口下 nx/ny 归一化基准取错（CoordBasisPolicy，四路统一）；
    //  ⑥ #250 在 0.14.1 存量用户侧的终态由本版根除（combo 并行分片下标缺陷）。
    // 演进：0.13.8(37) → 0.14.0-preview(38) → 0.14.0(39) → 0.14.1(40) → 0.14.2(41) → 0.14.2-fx-1(42)。
    // 下列 0.14.0-preview 主题（迭代计划
    // docs/NEXT-ITERATION-PLAN-2026-09-12.md 的切片 1 = B0+B1+B2）：
    // ① B0 发布阻断项清零：android_ui_dump schema 族与返回面脱钩（#204）、控制协议 V2 行句柄
    //    口径（#206.1，载荷行下标 → 原始行号）、file-incoming 三条 exact 路由无鉴权（#205）；
    // ② B1 数据与自愈：#210 半死状态机四缺口、#211 壳侧 IO 三处、状态陈旧 P0（真源 + 同步路径）、
    //    临时工作区 R1-R3；
    // ③ B2 门禁与发布链：新增门禁接进唯一接线面（本地构建链 / 两仓 CI / 发布组装链三处），
    //    快照指纹对账、工具返回值 schema 自检、控制 op 六处登记链、SKIP 计数。
    // 0.14.4：versionCode 46（覆盖安装 0.14.3(45)）。本版主题 = 客户端插件装配失败纳入引擎故障自愈链：
    //  页面侧发布 [dsh-boot-failed] 契约行（失败判据 = 启动页仍在场且有失败投影，幂等）、publishReady
    //  收紧为 rendered() && !bootPagePresent()；壳侧落 boot-fail 终态 + 独立 latch + 一次性回滚编排；
    //  回滚侧唯一点名外科拔除、点不出名且清单未变才 known-good 整份，都不成立则如实停在错误页。
    versionCode = 46
    // Snapshot builds append a suffix (e.g. -SN-1-RC13) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    // 版本号单一来源：UI（GuidePageRenderer）、桥（androidBridge.version）、诊断日志、引擎环境变量
    // （DSH_APP_VERSION，见 EngineManager.engineEnv）全部读这里，禁止任何地方再硬编码版本字面量。
    // 0.14.2-fx-3：versionCode 44（覆盖安装 fx-2(43)）。本版主题 = #295 启动归属与认证归因收口：
    //  ① 端口归属必须由受管子进程或本代 active engine.log 证据证明，HTTP 状态本身不构成所有权；
    //  ② 旧代 token、轮转日志、未知 generation 与 TOCTOU 端口竞争均 fail closed，禁止误杀外部进程；
    //  ③ 仅受管精确 origin 的主框架 401 进入有界自动恢复，403/子资源/外部监听只作诊断；
    //  ④ 移除误导性的手动「重新认证」入口；#288 无实时覆盖层证据则安全停步，不伪造 CSS 修复。
    // 演进：… → 0.14.2(41) → 0.14.2-fx-1(42) → 0.14.2-fx-2(43) → 0.14.2-fx-3(44) → 0.14.3(45) → 0.14.4(46)。
    versionName = "0.14.4" + snapshotSuffix
    buildConfigField("String", "TERMUX_VERSION", "\"0.118.3\"")
    // 0.14.0-preview：虚拟屏 P0 建屏矩阵走仪器测试入口（app UID 下运行 = P0-6 要测的调用者身份），
    // 不新增任何产品面（Activity/Bridge/Manifest 均不动）。见 .deploy-tmp/iter-0140/vdisplay-p0.md §8.8。
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildFeatures {
    buildConfig = true
    // 0.14.0-preview：ShizukuUserService.aidl 生成 Stub（虚拟屏线 S5 的 bindUserService 需要）。
    // 惰性：当前无 Kotlin 引用该 aidl 时也不会产生额外产物。
    aidl = true
  }

  androidResources {
    // snapshot.tar.xz is already xz-compressed; double-compressing it breaks openFd.
    noCompress += "xz"
  }

  signingConfigs {
    // Fixed debug signing from the repo keystore: CI and local builds must produce
    // byte-compatible signatures, otherwise users cannot install over previous
    // releases (INSTALL_FAILED_UPDATE_INCOMPATIBLE). AGP's default debug keystore
    // lookup (~/.android/debug.keystore) is unreliable on CI runners, so pin it.
    create("repoDebug") {
      storeFile = rootProject.file("keystore/debug.keystore")
      storePassword = "android"
      keyAlias = "androiddebugkey"
      keyPassword = "android"
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
    debug {
      signingConfig = signingConfigs.getByName("repoDebug")
    }
  }

  lint {
    // Offline environments lack the lint-gradle dependency cache (CN networks); lint is not on the release-critical path.
    checkReleaseBuilds = false
    abortOnError = false
  }

  testOptions {
    // Snapshot extraction/tests touch android.util.Log; default stubs keep the JVM
    // unit tests runnable without Robolectric.
    unitTests.isReturnDefaultValues = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

// The runtime snapshot comes from GitHub Releases (large files are not committed); the build fails with fetch guidance when it is missing.
tasks.whenTaskAdded {
  if (name == "mergeDebugAssets" || name == "mergeReleaseAssets") {
    doFirst {
      val snap = file("src/main/assets/snapshot.tar.xz")
      if (!snap.exists()) {
        throw GradleException(
          "缺少运行时快照 assets/snapshot.tar.xz —— " +
            "从 GitHub Releases 下载 snapshot-x86_64.tar.xz 后放到 app/src/main/assets/snapshot.tar.xz（见 README.md）",
        )
      }
    }
  }
}

dependencies {
  // Shizuku 特权通道（0.14.0-preview 虚拟屏线 P0-0）：Maven Central 13.1.5（2023-09-21；上游
  // App 仍更新但库停更，只按 13.1.5 API 面写代码）。许可 MIT（aar POM <licenses> 实测），
  // minSdk 26 >= aar 的 24/23，无需 desugaring；settings.gradle.kts 已有 mavenCentral()。
  implementation("dev.rikka.shizuku:api:13.1.5")
  implementation("dev.rikka.shizuku:provider:13.1.5")
  implementation("androidx.activity:activity-ktx:1.10.1")
  // 隔离浏览器身份面（0.14.0 正式轮）：document-start 脚本注入（platform/触摸/屏幕，无竞态）
  // 与 UA-CH（WebView >= 116 能力门）。无该库时只能用 onPageStarted 注入（有竞态）。
  implementation("androidx.webkit:webkit:1.12.1")
  // androidx.core: FileProvider (external-reader open, issue #52); ViewCompat/
  // WindowInsetsCompat were previously satisfied transitively via activity-ktx.
  implementation("androidx.core:core-ktx:1.15.0")
  // 悬浮球 v2 动效（PRD-overlay-v2 §3.5）：Material 3 Expressive spring 物理（Android 16 原生适配）
  implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
  implementation("org.apache.commons:commons-compress:1.28.0")
  // Strict safe parsing before profile-patch transaction writes; rejects duplicate mapping keys.
  implementation("org.yaml:snakeyaml:2.4")
  implementation("org.tukaani:xz:1.10")
  testImplementation("junit:junit:4.13.2")
  // 仪器测试（虚拟屏建屏矩阵）：只用于 P0 探针，不进产品面。
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  // 本地单测用真实 org.json（android.jar 桩在 JVM 里抛 Stub!）——快照 profiles 合并（#167）测试需要
  testImplementation("org.json:json:20240303")
}
