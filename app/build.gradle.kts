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
    versionCode = 21
    // Snapshot builds append a suffix (e.g. -SN-1-RC8) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    versionName = "0.12.4" + snapshotSuffix
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
  implementation("org.apache.commons:commons-compress:1.28.0")
  implementation("org.tukaani:xz:1.10")
  implementation("dev.rikka.shizuku:api:13.1.5")
  implementation("dev.rikka.shizuku:provider:13.1.5")
}
