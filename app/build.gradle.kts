// issue #1131：内嵌资产一致性检查要在脚本里算 sha256。必须走顶层 import ——
// 在 Kotlin DSL 里写全限定名 `java.security.MessageDigest` 会先解析到 Gradle 的 `java` 扩展，
// 报 "Unresolved reference: security"（实测踩到）。
import java.security.MessageDigest

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
    // 0.14.11：versionCode 70，确保可覆盖此前的测试版。所有交付 APK 强制包含 v1/v2/v3 签名。
    // 为什么必须升：UpdateChecker 的判据是 isNewer(tag, currentVersion())。若 versionName 仍等于上一个
    // 已发布 tag（0.14.8），应用内更新对任何设备恒判 UpToDate —— 修好更新检测却送不出去。
	// 本地调试可用 -PversionCode=<n> 覆盖（真机上被更高 versionCode 的测试包覆盖安装过时才需要）；
	// 不传时仍是发布口径的固定值。
	versionCode = providers.gradleProperty("versionCode").getOrElse("70").toInt()
    // Snapshot builds append a suffix (e.g. -SN-1-RC13) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    // 版本号单一来源：UI（GuidePageRenderer）、桥（androidBridge.version）、诊断日志、引擎环境变量
    // （DSH_APP_VERSION，见 EngineManager.engineEnv）全部读这里，禁止任何地方再硬编码版本字面量。
    versionName = "0.14.11" + snapshotSuffix
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
      // Keep the project signing policy explicit; the final-artifact gate verifies these schemes in every APK.
      enableV1Signing = true
      enableV2Signing = true
      enableV3Signing = true
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("repoDebug")
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
      // issue #1131：只判「存在」不够 —— 三份内嵌资产必须**同代**。
      // 它们都被 .gitignore（git status 看不见、没有 review 会审到），走完整构建链会被自愈，
      // 直接用 gradle 则不会：会**成功出包**，装到设备上才发现「界面正常、引擎拒启」
      // （运行期 EngineManager 以 hard-bundle-selection-unverified 拒绝启动）。
      // 失败形态与操作者直觉相反，所以在这里当场判死，不把坏包交给装机环节。
      val actualHex = MessageDigest.getInstance("SHA-256").let { md ->
        snap.inputStream().use { input ->
          val buf = ByteArray(1 shl 16)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
          }
        }
        md.digest().joinToString("") { b: Byte -> String.format("%02x", b) }
      }
      val howToFix =
        "修复：先跑 scripts/build-apk-013.ps1 重建（拷贝 tar 后会一并重写 snapshot.sha256 与 " +
          "plugin-hard-manifest.json），或删掉 app/src/main/assets/ 下这三份陈旧产物后重跑构建链。"
      val shaFile = file("src/main/assets/snapshot.sha256")
      if (shaFile.exists()) {
        val declaredHex = shaFile.readText().trim().lowercase()
        if (declaredHex != actualHex) {
          throw GradleException(
            "内嵌快照资产不同代：assets/snapshot.sha256 声明 " + declaredHex +
              "，但 snapshot.tar.xz 实际是 " + actualHex + "。\n" +
              "这三份（snapshot.tar.xz / snapshot.sha256 / plugin-hard-manifest.json）都被 .gitignore，" +
              "直接跑 gradle 会打出一个「界面正常、引擎拒启」的包。\n" + howToFix,
          )
        }
      }
      val hardFile = file("src/main/assets/plugin-hard-manifest.json")
      if (hardFile.exists()) {
        // fingerprint 的绑定关系已坐实：build-hard-manifest.mjs 把 sha256(tar 字节) 直接写进该字段。
        val fingerprint = Regex("\"fingerprint\"\\s*:\\s*\"([0-9a-fA-F]{64})\"")
          .find(hardFile.readText())?.groupValues?.get(1)?.lowercase()
        if (fingerprint != null && fingerprint != actualHex) {
          throw GradleException(
            "内嵌 Hard 插件清单与快照不同代：plugin-hard-manifest.json 的 fingerprint=" + fingerprint +
              "，但 snapshot.tar.xz 实际是 " + actualHex + "。\n" +
              "这是「陈旧残留」的典型形态：清单是上一次构建的，tar 是新的。\n" + howToFix,
          )
        }
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
  implementation("org.tukaani:xz:1.10")
  testImplementation("junit:junit:4.13.2")
  // 仪器测试（虚拟屏建屏矩阵）：只用于 P0 探针，不进产品面。
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  // 本地单测用真实 org.json（android.jar 桩在 JVM 里抛 Stub!）——快照 profiles 合并（#167）测试需要
  testImplementation("org.json:json:20240303")
}

// 这些单测在运行期**直接读仓内文件**（Kotlin 源、res、scripts 脚本、plugins 源码），而 Gradle 默认
// 只把编译产物算作 Test 任务的输入 —— 被读的源文件不算。于是改了被读文件，Test 任务的 cache key
// 不变，:app:testDebugUnitTest 会 FROM-CACHE 拿旧结果。
//
// 实锤：#1244 把 scripts/profile-web.cordis.patch.yml 的顶层条目从 21 加到 22，
// FactoryProfilePatchTest 的断言（22 块）因此失效；但 CI 日志是
//   > Task :app:testDebugUnitTest FROM-CACHE
//   BUILD SUCCESSFUL in 19s
// 任务根本没重跑 → 假绿。红的那条被缓存掩盖，直到本地全链才暴露。
// 因此把「测试运行期真正读取的仓内目录」显式声明为输入（目录级，覆盖同类文件）。
val repoRootDir: File = rootProject.projectDir
tasks.withType<Test>().configureEach {
    inputs.dir(File(repoRootDir, "scripts"))
        .withPropertyName("repoScripts")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(File(repoRootDir, "plugins"))
        .withPropertyName("repoPlugins")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(File(repoRootDir, "dsh-host-web-compat"))
        .withPropertyName("repoHostWebCompat")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(File(repoRootDir, ".github/workflows"))
        .withPropertyName("repoWorkflows")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(File(projectDir, "src/main"))
        .withPropertyName("appMainSources")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.file(File(projectDir, "build.gradle.kts"))
        .withPropertyName("appBuildScript")
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
}

// The optional console relay is an executable PIE stored under lib/<abi>.
// Only debug builds receive it; installed nativeLibraryDir must expose a real file.
providers.gradleProperty("nativeConsoleRelayDir").orNull?.let { relayDir ->
  android {
    sourceSets.getByName("debug").jniLibs.srcDir(file(relayDir))
    packaging.jniLibs.useLegacyPackaging = true
  }
}

// The Linux runtime needs an executable glibc loader, and an app process on
// targetSdk >= 29 may only execve apk_data_file. The loader therefore ships as
// lib/<abi>/libbionilux-loader.so and is installed into nativeLibraryDir, which
// is the only directory SELinux lets us execute. Every build type receives it:
// without it the Linux environment cannot start on those devices at all.
providers.gradleProperty("nativeLinuxLoaderDir").orNull?.let { loaderDir ->
  android {
    sourceSets.getByName("main").jniLibs.srcDir(file(loaderDir))
    packaging.jniLibs.useLegacyPackaging = true
  }
}
