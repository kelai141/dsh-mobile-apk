# Linux 环境在 arm64 真机上装不上：交接（2026-11-16）

> 状态：**根因已定，修复在途**。`Bad system call` 是 Android 应用域 seccomp 拦掉了
> glibc 在 libc 初始化阶段必发的 `set_robust_list` / `rseq`；修复在 dsh-bionilux#22，
> 推导与证据见 `2026-11-16-linux-env-seccomp-sigsys.md`。真机整条安装链还需要一份带
> 新 loader 的 APK 才能复验（loader 在 `nativeLibraryDir`，只能在打包时替换）。

## 1. 目标

让 dsh-mobile-apk 的 Linux 环境（Debian rootfs + bionilux 运行时）在 arm64 真机
（vivo V2425A / Android 15 / targetSdk 34）上**完整安装并可用**。

用户点「一键下载并安装」应能走完：下载资产 → 校验 → 准备 rootfs → 激活 → 可用终端。

## 2. 现状：安装推进到哪一步

界面错误文本（真实设备截图 r-06）：

```
Linux 环境操作失败，请检查环境状态与日志后重试。
Android rootfs preparation failed (2): Bad system call
prepare-android-rootfs: dpkg-divert failed; is dpkg installed in the rootfs?
[launcher] domain=u:r:untrusted_app_34:s0:c231,c257,c512,c768 uid=10487
           mode=700 uid=10487 gid=10487 isFile=true isLink=false size=1731328
           dir:debian-minimal-mwj7n2a6-...=700 dir:bin=700
           content="ELF\u0002\u0001\u0001..."
```

**关键：`EACCES` 已经消失，取而代之的是 `Bad system call`。**

这是本轮最重要的进展——它证明 loader 现在**能被执行**了。上一版的错误是：

```
[ERROR] execve failed: EACCES: Permission denied (.../rootfs/lib/ld-linux-aarch64.so.1):
the kernel refused this exec. An Android app may execute only apk_data_file (nativeLibraryDir);
app data and memfd are readable and mappable but not executable.
```

## 3. 根因链（已逐层验证）

真机环境下，应用进程处于 `u:r:untrusted_app_34`，**只能 execve apk_data_file
（即 nativeLibraryDir），app 数据目录里的 ELF 一律不可执行**（targetSdk >= 29）。
bionic 把这个拒绝报成 `Permission denied`，与动态链接失败同句，因此极易误判。

同一个根因打穿了四处，前三次修复都在这个方向上：

| # | 受害者 | 表现 | 修复 | 状态 |
|---|---|---|---|---|
| 1 | `prepare-rootfs.sh` 里的 `find` | `files/usr/bin/find: Permission denied` | PATH 剔除 Termux bin，改用系统 toybox | 通过 |
| 2 | prepare 脚本启动 launcher | `launcher: Permission denied` | 脚本加 `--linker`，经 `/system/bin/linker64` 启动 | 通过 |
| 3 | guest 程序的 glibc loader | `execve failed: EACCES .../rootfs/lib/ld-linux-aarch64.so.1` | 传 `BIONILUX_NATIVE_LIB_DIR`，改用 nativeLibraryDir 里的副本 | **通过（本轮）** |
| 4 | glibc loader 在 bionic linker 下运行 | `Bad system call` | **未知，未修** | **阻塞** |

## 4. 当前阻塞（已定位）：`Bad system call` = Android seccomp 的默认 TRAP

应用进程（targetSdk >= 29）继承的是 `untrusted_app` 的 seccomp **白名单**，默认动作是
`SECCOMP_RET_TRAP`。bionic 从不调用 `set_robust_list`(99) 与 `rseq`(293)，两者因此不在
白名单里；而 glibc 的 loader 在为第一个线程做 TLS 初始化时（`init_tls` → `__tls_init_tp`）
就发出它们 —— 早于任何重定位，也早于任何 `LD_PRELOAD` 代码；libc 之后在 `start_thread`
里为每个新线程再发一次 `set_robust_list`，而那一刻全部信号被 block。

真机上用应用控制台 + `ptrace` 抓到的顺序：`... set_tid_address -> set_robust_list`（被杀）；
把 99 改成 `-ENOSYS` 后下一条被拦的是 `rseq`；两条都改成 `-ENOSYS` 后
`/usr/bin/true`、`dpkg-divert --listpackage` 均退出 0。应用域 0..469 逐号实测：
99/293 返回 SIGSYS（共 243 个号被拦）。

原「三个未验证的假设」全部证伪，逐条反证见 `2026-11-16-linux-env-seccomp-sigsys.md` §3：
预载库构造函数、`LD_PRELOAD` 的 `ifunc` resolver、`LD_AUDIT` 的 `la_version`、
`GLIBC_PRIVATE` 版本节覆盖、`SIG_IGN` 继承、叠加 `ERRNO`/`USER_NOTIF`/`TRACE` 过滤器 ——
六条都救不下来；业界先例（cortex / DroidDeck / termux-pacman）也都是改指令或改源码，
没有人做到「早装处理器」。详见同目录 `2026-11-16-linux-env-seccomp-sigsys.md` §6。

修复：`svc #0` 改成 `movn x0, #37`（`-ENOSYS`），loader 在构建期打、guest 的 libc 在
安装阶段打（dsh-bionilux#22）。

## 5. 已合并的改动

| 仓 | PR | 内容 | 状态 |
|---|---|---|---|
| dsh-mobile-apk | #1796 | 安装失败回传真因（`detail`/`reason`）、`lastError` 落盘、manifest 双源同步、issue 1790 离线安装 | 已合并 `9a0d929c` |
| dsh-bionilux | #17 | PATH 剔除不可执行的 Termux bin | 已合并，v0.10.2 |
| dsh-bionilux | #18 | prepare 脚本支持 `--linker` | 已合并，v0.10.5 |
| dsh-bionilux | #19 | 失败路径收集 `[launcher]` 现场 | 已合并，v0.10.4（含在 0.10.5） |
| dsh-bionilux | #21 | `_hostToolEnvironment()` 注入 `BIONILUX_NATIVE_LIB_DIR` | 已合并，**v0.10.6 已发布为 Latest** |

## 6. 待处理

### 6.0 修复落地顺序（本任务续做）

1. dsh-bionilux#22 → 0.10.7：CI 在构建期给 `bionilux-loader-*.so` 打补丁；运行时在安装
   阶段给 guest 的 `libc.so.6` 打补丁。**已完成**：PR 全绿，draft release `v0.10.7`
   已产出且复核了 loader 里两处补丁（**未发布**，等 APK 一起走）。
2. 用新 loader 重出 arm64 APK：`build-apk-013.ps1 -NativeLinuxLoaderDir <0.10.7 的 loader 目录>`。
3. 真机复验整链（下载 / 校验 / 准备 / 激活）+ 三层验收（代码层 / CDP 层 / ADB 用户层）。
   本轮设备在收尾前断开，第 2、3 步未做。

### 6.1 构建链缺陷：`useLegacyPackaging` 无效（独立问题）

`scripts/check-native-linux-loader.mjs` 要求 `libbionilux-loader.so` 在 APK 内必须是
**stored（method 0）**，否则判红，理由写的是「安装后不会是普通文件」。

实测这个判据在当前 AGP 8.8.2 下是**假阳性**：

- 三种写法（现有 `providers.gradleProperty(...).let { android { ... } }`、`android {}` 顶层显式
  `packaging { jniLibs { useLegacyPackaging = true } }`、加 `--no-build-cache` 清中间产物）
  产出的 loader **全部是 method 8（压缩）**。
- 但装上设备后，`nativeLibraryDir` 里实际是**普通可执行文件**：

  ```
  -rwxr-xr-x 1 system system 201344 1981-01-01 01:01 libbionilux-loader.so
  ```

  因为 manifest 里 `extractNativeLibs=true`，PackageManager 会解压落盘。

**所以门禁判据与实际行为脱节，挡住了本来可用的包。** 需要决定是修 AGP 配置还是修判据。
未做，因为它与 Linux 环境 bug 是两个问题。

### 6.2 其他

- `dsh-mobile-apk#1807`（执行地图补登记 linux-bootstrap 测试 glob）：CI 全绿、`MERGEABLE`，
  只差 review 与标签；它修掉的正是 main 上唯一一项 code-map 红。
- `dsh-mobile-apk#1798`（追版 Harness 0.2.2-rc.3）：唯一红是
  `harness-adoption.yml`「核对上游提交与双 ABI 插件实测证据」——门禁没有缺陷、pin 也对，
  缺的是 4 份真机证据（两套 APK × 双 ABI × 196 条用例），要设备验证才能补。它与本任务无关。
- release 包**不可调试**（`run-as` 不可用），设备侧取证只能靠界面错误文本与 logcat。

## 7. 复现与验证环境

```
真机： 10AF2B0GN0001F2  vivo V2425A  arm64-v8a  1260x2800  Android 15  targetSdk 34
模拟器：127.0.0.1:16416 (MuMu x86_64) —— 复现不了本问题
```

### 构建（必须重建快照，否则插件改动进不了包）

```powershell
# 1. 基座就位（仓库 base/ 目录里已有）
Copy-Item base/base-usr-arm64.tar.xz .deploy-tmp/arm64-base/base-usr.tar.xz
Copy-Item base/base-dsh.tar.xz    .deploy-tmp/arm64-base/base-dsh.tar.xz

# 2. 重建快照（8-12 分钟，WSL 内跑）
node scripts/build-snapshot-013.mjs arm64

# 3. loader 分档（门禁脚本自己会分档）
node scripts/check-native-linux-loader.mjs --source <.deploy-tmp/native-loader> --abi arm64 --stage .deploy-tmp/loader-stage
#    .deploy-tmp/native-loader/bionilux-loader-aarch64.so 来自 bionilux release

# 4. 出包
pwsh -File scripts/build-apk-013.ps1 -Suffix "" -OnlyAbi arm64 -VersionCode 82 \
     -NativeLinuxLoaderDir <abs path>/.deploy-tmp/loader-stage
```

### 构建链的三个环境前置（本次踩过）

1. 缺 `.deploy-tmp/{arm64-base}/base-usr.tar.xz` 与 `base-dsh.tar.xz` → 从仓库 `base/` 复制。
2. `plugins/dsh-android-phone-control` 缺 `tsc` → 在该目录 `npm i --no-save typescript@5`。
3. `check-dead-tokens` 需要上游树 → clone `dsh-v0.2.2-rc.1` 到
   `.deploy-tmp/survey-022rc1/upstream-022`（路径见 `scripts/contract.json`）。

### 已知产物

- 快照：`.deploy-tmp/snapshot-013/arm64/snapshot.tar.xz`（171 MB）
- APK：`app/build/outputs/apk/release/app-release.apk`（167.9 MB，versionCode 80）

## 8. 给接手者的三条提醒

1. **别再用 dev-fast 档验证这类改动。** 它按设计**不重建快照**，复用仓库里的旧
   `snapshot.tar.xz`，插件修复永远进不了包。本次曾有整轮验证因为这一点而无效。

2. **`Permission denied` 在这条链上不代表权限问题。** 它可能是 exec 策略、缺库、
   或 SElinux。先用 `[launcher]` 现场（domain / mode / 三种启动方式的各自结果）判断，
   不要凭文案猜。

3. **不要为了过门禁而放宽判据。** 本次 `useLegacyPackaging` 判据确实阻挡了可用产物，
   但结论要靠设备实测（`nativeLibraryDir` 里是不是普通可执行文件）支撑，而不是
   「门禁太严」这个判断。