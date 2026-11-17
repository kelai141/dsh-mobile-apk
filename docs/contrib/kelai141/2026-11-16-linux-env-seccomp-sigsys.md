# Linux 环境 arm64：`Bad system call` 的根因与修复（2026-11-16）

> 交接文档里那三个「未验证的假设」全部证伪，后来又补证了三条（§3）。真因是 Android
> 应用域 seccomp 的默认动作拦掉了 glibc 在初始化阶段必发的两个系统调用（loader 的 TLS
> 初始化 + 每创建一个线程）；修复落在指令层（回 `-ENOSYS`），代码在 dsh-bionilux#22。

## 1. 结论一句话

应用进程（targetSdk >= 29）继承的是 `untrusted_app` 的 seccomp **白名单**，默认动作是
`SECCOMP_RET_TRAP`。bionic 从不调用 `set_robust_list`(99) 与 `rseq`(293)，两者因此不在
白名单里；而 glibc 的 loader 在为第一个线程做 TLS 初始化时（`init_tls` →
`__tls_init_tp`，`sysdeps/nptl/dl-tls_init_tp.c`）就会发出它们 —— 早于任何重定位，
也早于任何 `LD_PRELOAD` 代码，所以进程被杀时预载库还一行代码都没跑。libc 之后在
`start_thread`（`nptl/pthread_create.c`）里为每个新线程再发一次 `set_robust_list`，
而那一刻全部信号被 block —— 这条路径连「装个处理器」的机会都没有。

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

本地 glibc 2.39 与 Debian trixie 的 2.41 都复现同一个顺序：**依赖代码运行之前**
就发出了这两个调用 —— 位置是 loader 的 TLS 初始化（`elf/rtld.c` 的 `init_tls`，
在任何重定位之前）。所以：

- `LD_PRELOAD` 里的 `__attribute__((constructor))` 装 SIGSYS 处理器 —— 来不及；
- `LD_PRELOAD` 里的 **`ifunc` resolver** —— 也来不及：resolver 在所有对象的重定位阶段
  才跑，而这两个调用在更早的 TLS 初始化里（x86_64、aarch64 双架构实测）；
- `LD_AUDIT` 的 `la_version` 里装 —— 也来不及（实测同样死在 la_version 之前）；
- 覆盖 `__libc_early_init`（带 `GLIBC_PRIVATE` 版本节）—— 它既不是调用点，ld.so 又是
  内部引用，不经过全局符号查找；
- SIG_IGN 后 exec 继承 —— 同步信号不吃 SIG_IGN（实测照样被杀）；
- 再叠一层 `ERRNO`/`USER_NOTIF`/`TRACE` 过滤器 —— 动作优先级 KILL > TRAP > ERRNO >
  USER_NOTIF > TRACE > LOG > ALLOW，继承下来的 TRAP 仍然赢（实测照样被杀）。

能覆盖这段的只有「指令层」或「进程外」（ptrace 监督者）。后者每次被拦都要两次上下文
切换，而这一层要跑 node / git / 整条编译链，逐调用计费不可接受。

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
不依赖固定偏移。这条路线与跑 glibc rootfs 的几个安卓项目同构，对照见 §6。

## 5. 复验状态

- 已有：真机 ptrace 现场改写 → 两个 guest 程序正常退出；补丁后 `qemu-aarch64 -strace`
  显示 guest 不再发出这两个调用。
- **缺**：真机整条安装链（下载 / 校验 / 准备 / 激活）尚未复验。本轮设备在收尾前断开，
  且复验需要**一份带新 loader 的 APK**（loader 在 `nativeLibraryDir`，只能在打包时替换）：
  先发 dsh-bionilux 0.10.7，再用 `-NativeLinuxLoaderDir` 指向新 loader 重出 arm64 APK。

## 5.1 已完成的构建链验证（2026-11-16）

- dsh-bionilux#22 的全绿 CI：6 项 pass（含 `node --test packages/linux-runtime/test/*.test.mjs`
  148 项：131 pass / 17 skip / 0 fail）。
- 用分支 ref 触发的 draft release（`v0.10.7`，**未发布**）已经产出：下载产物
  `bionilux-loader-aarch64.so` 复核，`67380` 与 `67544` 两处都已是 `0x928004a0`
  （`movn x0, #37`），即构建期的打补丁步骤真的生效了；x86_64 产物按设计跳过。
- 该 draft 保持 draft 状态：先发布 0.10.7 再出带新 loader 的 APK 才有意义
  （当前 APK 的 loader 仍是未打补丁的那份，安装仍会在启动阶段被 SIGSYS 杀掉）。

## 6. 业界先例与备选方案（2026-11-17 检索）

同一堵墙别的项目也撞过，做法收敛成两条：改指令/改源码把调用消掉，或者进程外逐调用接管。

| 项目 | 机制 | 与本轮的关系 |
|---|---|---|
| [ssfuisu/cortex](https://github.com/ssfuisu/cortex) | 构建期把 rootfs 里 loader/libc 的 `svc` 就地改写成 `nop` / `mov x0,#-38`（`scripts/patch-bootstrap-ld.py`，找不到即构建失败；`libc6` 用 dpkg hold 钉住）；另配 `constructor(101)` 装的 SIGSYS 处理器兜运行期 | 与本轮修复同构；它**没有**「早装处理器」这一步 |
| [Droid-Deck/DroidDeck](https://github.com/droid-deck/droiddeck) | `libddnatv-hook.so` 派生自 cortex 的预载库；默认路径退回打过 28+ 补丁的 proot（ptrace） | 同上 |
| [termux-pacman/glibc-packages](https://github.com/termux-pacman/glibc-packages) | 源码级 `set-nptl-syscalls.patch` 删掉 `dl-tls_init_tp.c`/`pthread_create.c`/`_Fork.c` 三处调用，`fakesyscall.json` 把 20+ 个被拦调用映射成 ENOSYS | 等价做法（源码级）；旁证「回 -ENOSYS 足够」 |
| [termux/proot](https://github.com/termux/proot)、Winlator/Mobox、box64 | tracer 逐调用改寄存器 / 模拟器层派发 | 逐调用计费，node 与编译链不可接受 |

另外两条事实：

- AOSP 侧**没有**放宽通道：app 策略由 `bionic/libc/SECCOMP_*.TXT` 生成，`Disallow()` 的
  唯一实现就是 `SECCOMP_RET_TRAP`，没有 debuggable/userdebug/属性分支；`set_robust_list`
  与 `rseq` 从来不在 `SYSCALLS.TXT` 里（不是「某版本开始变严」）。`prctl(PR_SET_SECCOMP)`
  只能加过滤器，不能减。
- `GLIBC_TUNABLES=glibc.pthread.rseq=0` 能关掉 `rseq`（实测 guest 的 293 计数 1→0，
  含 loader 自己那次），但 `set_robust_list` **没有** tunable，且环境变量会丢
  （`env -i`、程序自己复位环境）—— 只适合当叠加保险，不能替代补丁。

结论：就这堵墙而言，现有实现都不比「指令层消除 + 构造函数里装处理器兜运行期」更好；
指令层负责「启动/建线程必发、且发生时信号可能被 block」的那几个点，处理器只能覆盖它们
之后的调用。要覆盖**任意**被拦调用（`unshare`/`keyctl`/`setgroups` 等）且不逐调用计费，
唯一的增量是把 SIGSYS 处理器装到比 loader 第一行代码更早的位置（改 `e_entry` 注入约
140 B 的 stub，让 `rt_sigaction` 成为进程的第一条系统调用）。本轮只做到可行性原型
（离线结构与时序验证通过，真机端到端未验），**未进 0.10.7**。

## 7. 其他

- `check-native-linux-loader.mjs` 要求 loader 在 APK 内是 stored（method 0）这一条，
  与实测（AGP 8.8.2 下恒 method 8、但 `extractNativeLibs=true` 装后仍是普通可执行文件）
  仍然脱节，本轮未动，属独立问题。
- 应用域内 ptrace 可用、`seccomp` 调用可用、`setgroups`/`setuid` 等在 blocklist 里；
  这些都记在证据链里，后续做 guest 兼容层时可以直接用。