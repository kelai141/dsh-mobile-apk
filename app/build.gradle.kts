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
    // 0.13.8：versionCode 37（覆盖安装 0.13.7fx-1(36)）。本版主题：
    // ① 控制协议 V2（列式载荷 428 B/节点 → 54.7 B/行，413 自动降级 view=target，行句柄动作回指）；
    // ② E6 能力补齐（全局动作面 getSystemActions 驱动、无障碍截屏回落 ADB）；
    // ③ P2 收口（android_ui_detail 两级披露 + DetailStore、android_privilege_status 结构化 route +
    //    协议协商）；④ 启动页 APK 自更新（仅手动 + 同按钮二次确认 + 安装授权）；
    // ⑤ 悬浮球动效 M4-M8；⑥ @ 菜单勾选框（状态由行属性派生 + 原生风格自绘）；
    // ⑦ 键盘空白带根治（IME inset 施加到 WebView 布局尺寸，apk #197）；
    // ⑧ 构建门禁链自身缺陷修复（Join-Path 拼写、镜像比对面、协议 V2 门禁）。
    versionCode = 37
    // Snapshot builds append a suffix (e.g. -SN-1-RC13) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    // 版本号单一来源：UI（GuidePageRenderer）、桥（androidBridge.version）、诊断日志、引擎环境变量
    // （DSH_APP_VERSION，见 EngineManager.engineEnv）全部读这里，禁止任何地方再硬编码版本字面量。
    versionName = "0.13.8" + snapshotSuffix
    buildConfigField("String", "TERMUX_VERSION", "\"0.118.3\"")
  }

  buildFeatures {
    buildConfig = true
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
  implementation("androidx.activity:activity-ktx:1.10.1")
  // androidx.core: FileProvider (external-reader open, issue #52); ViewCompat/
  // WindowInsetsCompat were previously satisfied transitively via activity-ktx.
  implementation("androidx.core:core-ktx:1.15.0")
  // 悬浮球 v2 动效（PRD-overlay-v2 §3.5）：Material 3 Expressive spring 物理（Android 16 原生适配）
  implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
  implementation("org.apache.commons:commons-compress:1.28.0")
  implementation("org.tukaani:xz:1.10")
  testImplementation("junit:junit:4.13.2")
  // 本地单测用真实 org.json（android.jar 桩在 JVM 里抛 Stub!）——快照 profiles 合并（#167）测试需要
  testImplementation("org.json:json:20240303")
}
