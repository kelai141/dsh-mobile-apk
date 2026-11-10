# glibc loader 必须按 ABI 分档、以 stored 条目进包（#1705）

## 现象

MIUI 等加固 ROM 上 Linux 环境启用后必定 `EACCES`：`linux_bash` 一条命令都跑不起来，而 logcat 里
**没有 AVC 拒绝**。前序链路（dsh-bionilux#13 / dsh-mobile#178 / dsh-mobile-apk#1704）已把
「运行时优先从 `nativeLibraryDir` 解析 loader」接通，构建侧却从没把 loader 放进 APK，
于是运行时永远落回 rootfs 里那份不可执行的拷贝。

## 真因

三层，每层单独看都像「没问题」，叠起来才是「构建全绿、设备必死」：

1. **SELinux 的执行面只有 apk_data_file**。targetSdk >= 29 的 app 进程在 `u:r:untrusted_app`，
   只有 `apk_data_file` 有 `execute_no_trans`；app 数据目录（`app_data_file`）与 memfd
   （`appdomain_tmpfs`）只有 `execute`。所以 rootfs 里的 glibc loader 无法 execve，
   而该拒绝被 **dontaudit**——日志里看不到，只能靠现象反推。唯一可执行位置是 APK 的 `lib/<abi>/`
   （安装后 = `nativeLibraryDir`），只有 jniLibs 能到那里。
2. **"传目录" 不是 "分档"**。本仓 `app/build.gradle.kts` **没有** `abiFilters` 也没有 `splits`：
   两次构建共用同一个 `main` 源集。把含 `arm64-v8a/` 与 `x86_64/` 的 loader 目录直接交给
   `-PnativeLinuxLoaderDir`，两个 APK 都会带上**两种 ABI** 的 loader。多出来的那一份是架构不匹配的
   ELF——它不会让构建失败，只会让另一台设备上的 exec 失败。
3. **"在包里" 不等于 "是普通文件"**。`useLegacyPackaging = true` 是 loader 以普通文件落进
   `nativeLibraryDir` 的前提；它一旦失效，loader 会以 deflate 条目进包，#1704 承诺的
   「`applicationInfo.nativeLibraryDir` 里能看到它、且是普通文件」当场不成立。

## 修法

三处，分别守一层：

- `check-native-linux-loader.mjs`：唯一实现 ABI 表（`arm64`/`arm64-v8a`/`aarch64` ⇄
  `arm64-v8a`/`x86_64` ⇄ `e_machine`）的地方。`--source --abi --stage` 校验输入并按**单 ABI**
  产出 stage 目录；`--apk` 在产物上判四条：在场 / **stored** / ELF 架构与本包 ABI 一致 /
  本包 `lib/` 下无另一 ABI 的 loader。自带 `--self-test`（19 项：2 正 5 负 ELF、2 正 2 负命名、
  1 正 4 负产物、1 正 2 负 zip 解析），全在纯字节面上，不需要 APK 与 SDK。
- `build-apk-engine.mjs` 的 `stageNativeLinuxLoader`：三条链共用的那块，**不**把调用方目录交给
  Gradle，而是先分档到 `app/build/native-linux-loader/<abi>/` 再交给 `-PnativeLinuxLoaderDir`；
  产物断言排在**验签之后的同一「最终产物」关口**（#1077 的同一理由：中间态产物会被上游当成交付物）。
- 三条链各加一个入口：`build-apk-013.ps1 -NativeLinuxLoaderDir`、`build-release.ps1` 同名参数、
  云端读 `DSH_NATIVE_LINUX_LOADER_DIR`。不配置时构建参数与产物与改动前**完全一致**
  （`build-apk-engine.test.mjs` 的 absent-loader 用例钉住）。

## 复验要点（别只验一边）

- 门禁自测：`node scripts/check-native-linux-loader.mjs --self-test`（19 项全绿）。
- **受控负控**（同一个入口、同一个 stage 目录，只换输入字节）：
  - 把 `bionilux-loader-x86_64.so` 改名成 `bionilux-loader-aarch64.so` 交给 `--abi arm64` ⇒
    `ELF 架构不符：实际 x86-64（0x3e）≠ arm64 要求的 aarch64（0xb7）`，exit 1。
  - 源目录整条缺席 ⇒ `loader 源目录不在场`，exit 1。
  - 无参数 + `--require` ⇒ `SKIP(#1)` 后立刻判红，exit 1（严格档不得以 SKIP 结案）。
- 设备侧仍是阻断项：两个 ABI 的 loader 是不同文件，只验 arm64 证明不了 x86_64，反之亦然。

## 一个容易再犯的点

bionilux Release 的资产名与 APK 的 jniLibs 目录名**不是同一套拼写**：
资产用 `aarch64`/`x86_64`，jniLibs 用 `arm64-v8a`/`x86_64`。`bionilux-loader-aarch64.so`
必须改名进 `arm64-v8a/`，不是进 `aarch64/`。ABI 表把这四列（本仓拼写 / jni 目录 / e_machine /
资产后缀）放在同一行，就是为了让任一处写错都落空而不是靠人记得。
