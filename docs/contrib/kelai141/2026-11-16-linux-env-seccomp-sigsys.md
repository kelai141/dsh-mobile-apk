# Linux 环境 arm64：`Bad system call` 的根因与修复（2026-11-16）

> 交接文档里那三个「未验证的假设」全部证伪。真因是 Android 应用域 seccomp 的默认动作
> 拦掉了 glibc 在 libc 初始化阶段必发的两个系统调用；修复落在指令层（回 `-ENOSYS`），
> 代码在 dsh-bionilux#22。

## 1. 结论一句话

应用进程（targetSdk >= 29）继承的是 `untrusted_app` 的 seccomp **白名单**，默认动作是
`SECCOMP_RET_TRAP`。bionic 从不调用 `set_robust_list`(99) 与 `rseq`(293)，两者因此不在
白名单里；而 glibc 在 `__libc_early_init` 里就会发出它们 —— 这一步早于任何
`LD_PRELOAD` 构造函数，所以进程被杀时预载库还一行代码都没跑。

## 2. 证据链（真机 vivo V2425A / Android 17 / targetSdk 34）

1. **loader 本身能跑**：在应用控制台里直接 exec APK 的 `nativeLibraryDir/libbionilux-loader.so`，
   `--version` 正常输出 `Debian GLIBC 2.41-12+deb13u4`。说明 exec 权限这一层早已过掉。
2. **任何 glibc 程序都死在初始化**：同一控制台里跑 guest 的 `/usr/bin/true`、
   `dpkg-divert`，都是 `Unknown signal 31`（= SIGSYS，mksh 报成 `Bad system call`）。
3. **抓到具体系统调用**：用 python 的 `ptrace`（应用域里 ptrace 可用）跟踪
   `ld.so --library-path <rootfs> <prog>`，最后一条系统调用是 `set_robust_list`(99)；
   把它现场改成 `-ENOSYS` 后，下一条被拦的是 `rseq`(293)。
4. **证明这两个就是全部**：把 99/293 都改成 `-ENOSYS` 后，`/usr/bin/true` 与
   `dpkg-divert --listpackage` 均正常退出 0。
5. **白名单实测**：在应用控制台里对 0..469 逐号做「fork + `syscall(n)`」，99 与 293 均以
   SIGSYS 结束（共 243 个调用号被拦，与 AOSP 的 allowlist 默认 TRAP 一致）。

## 3. 为什么预载库里的 SIGSYS 处理器不行

本地 glibc 2.39 与 Debian trixie 的 2.41 都复现同一个顺序：**依赖构造函数运行之前**
就发出了这两个调用。所以：

- `LD_PRELOAD` 里的 `__attribute__((constructor))` 装 SIGSYS 处理器 —— 来不及；
- `LD_AUDIT` 的 `la_version` 里装 —— 也来不及（实测同样死在 la_version 之前）；
- 用带 `GLIBC_PRIVATE` 版本节的 `__libc_early_init` 覆盖 —— ld.so 内部调用，不经过全局符号查找；
- SIG_IGN 后 exec 继承 —— 同步信号不吃 SIG_IGN（实测照样被杀）。

能覆盖这段的只有「指令层」或「进程外」（ptrace 监督者）。

## 4. 修复

`svc #0` 是内联在 loader 与 libc 里的，唯一能改答案的地方就是指令本身：

```
svc #0        (0xd4000001)   ->   movn x0, #37   (0x928004a0)   == -ENOSYS
```

- **loader**（APK 里承担链接器角色的那份）：构建期打补丁（dsh-bionilux CI 的
  `scripts/patch-android-glibc.mjs`）。真机启动阶段只经过它的两处（`set_robust_list`、`rseq`）。
- **guest 的 `libc.so.6`**：rootfs 里的 libc 来自 Debian 包、构建期碰不到，且新线程创建
  也会调用这两处；改由安装（prepare）阶段按同一规则打补丁（`packages/linux-runtime/modules/
  libc-seccomp-patch.js`，按摘要记账、幂等、`apt upgrade` 换包后重打，匹配不到即报错）。

补丁依据：Debian trixie glibc 2.41 aarch64 里 `set_robust_list` 有 2 处、`rseq` 有 1 处
（loader 里各 1 处），全部由「`svc` 前面 12 条指令内出现 `movz x8, #99/#293`」的模式定位，
不依赖固定偏移。

## 5. 复验状态

- 已有：真机 ptrace 现场改写 → 两个 guest 程序正常退出；补丁后 `qemu-aarch64 -strace`
  显示 guest 不再发出这两个调用。
- **缺**：真机整条安装链（下载 / 校验 / 准备 / 激活）尚未复验。本轮设备在收尾前断开，
  且复验需要**一份带新 loader 的 APK**（loader 在 `nativeLibraryDir`，只能在打包时替换）：
  先发 dsh-bionilux 0.10.7，再用 `-NativeLinuxLoaderDir` 指向新 loader 重出 arm64 APK。

## 6. 其他

- `check-native-linux-loader.mjs` 要求 loader 在 APK 内是 stored（method 0）这一条，
  与实测（AGP 8.8.2 下恒 method 8、但 `extractNativeLibs=true` 装后仍是普通可执行文件）
  仍然脱节，本轮未动，属独立问题。
- 应用域内 ptrace 可用、`seccomp` 调用可用、`setgroups`/`setuid` 等在 blocklist 里；
  这些都记在证据链里，后续做 guest 兼容层时可以直接用。
