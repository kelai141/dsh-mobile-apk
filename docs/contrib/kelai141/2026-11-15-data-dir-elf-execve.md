# Android 上 app 数据目录的 ELF 无法 execve：一次把它误判成 loader 问题的完整经历

日期：2026-11-15
涉及：`plugins/dsh-linux-bootstrap`、`@dsh-android/linux-runtime`（dsh-bionilux）、
issue #1790、PR #1796、dsh-bionilux #17 / #18

## 现象

arm64 真机（vivo V2425A / Android 15 / targetSdk 34）安装 Debian 环境恒定失败。
包不可调试时设置页只有一句兜底文案：

```
Linux 环境操作失败，请检查环境状态与日志后重试。
```

补上 detail 回传后拿到真因：

```
prepare-rootfs.sh[63]: /data/user/0/<pkg>/files/usr/bin/find: Permission denied
```

## 真因

**targetSdk >= 29 的应用只能 `execve` APK 的 `nativeLibraryDir`；应用数据目录里的
ELF 会被内核直接拒绝。** Termux 之所以能执行 `$PREFIX/bin/*`，是因为它声明
targetSdk 28——这不是本应用能照抄的。

本仓早有两处记载，我当时都没去读：

- `app/build.gradle.kts`：`targetSdk >= 29 may only execve apk_data_file`
- `ConsoleSession.kt`：`glibc loader 从 nativeLibraryDir 解析（app 数据目录里的 ELF 无法 execve）`

## 为什么这段坑特别深

bionic 把这次的 `EACCES` 报成 **"Permission denied"**，与动态链接失败是同一句文案：

```
$ files/usr/bin/find --version
CANNOT LINK EXECUTABLE "find": library "libandroid-support.so" not found
```

两者都通向同一个错误串，于是排查自然分成两条都错的岔路：

1. 以为是 loader 路径缺失 → 补 `LD_LIBRARY_PATH`（**没用**）
2. 以为是路径深度算错 → 改 `dataDir` 上溯层数（**没用**）

两版修复都「看起来指向正确」，因为变量值确实是对的——只是内核根本没走到那一步。

## 决定性判据

同设备、同脚本、同 env，只换 PATH：

```
# 数据目录里的 Termux 工具
$ env -i PATH=<files>/usr/bin:/system/bin ... find
CANNOT LINK EXECUTABLE "find" ...

# 系统 toybox 工具
$ env -i PATH=/system/bin /system/bin/sh prepare-rootfs.sh --rootfs ... --relative-links
== absolute symlinks under ...
rewrote 1 link(s); pending links now: 0
done                                     exit 0
```

**脚本只需要系统 PATH 里的 toybox，完全不需要 Termux 那套。**

## 同一个根因的三个受害者

修一层推进一层，每层换一个受害者：

| 层 | 受害者 | 修法 |
|---|---|---|
| 1 | `prepare-rootfs.sh` 里的 `find`/`sed` | PATH 剔除 Termux bin，用系统 toybox（bionilux#17） |
| 2 | `prepare-android-rootfs.sh` 调 `ldconfig` | `ldconfig-android.sh` 是 shell 脚本，不受影响 |
| 3 | 该脚本要执行的 `backend/bin/bionilux` | `/system/bin/linker64 <elf>` 包装（bionilux#18） |

第 3 层的正确做法 `manager.js` 里早就有（`launchArgv()` 在 Android 上自动包 linker），
只是 `_prepareAndroidRootfs` 传的是裸路径给 shell 脚本，绕过了它。

**排查口诀：只要失败信息里出现 `files/<...>/bin/<name>: Permission denied`，先怀疑
execve 限制，再怀疑 loader。**

## 我在这次排查里自己犯的错（比 bug 更值得记）

1. **把测试改成迎合假设**。第一版修复时我把用例改成断言「loader 路径由 dataDir 推导」，
   于是测试绿了——它绿在我编的值上，不是设备事实上。**改测试让假设通过，等于把错误
   固化进用例。**
2. **反复污染设备状态**。为绕过 staging 的 size/sha256 校验，我反复推改过的解包树，
   导致后续每次验证都在测污染过的文件，一度得出「代码对但没生效」的错误结论。
   **校验拒绝修改解包树是安全设计，不该靠改字节数对抗。**
3. **两次方向错误都源于没先读既有文档**。`build.gradle.kts` 和 `ConsoleSession.kt`
   里写着确切答案，我猜了两轮才去看。

## 复验方式

```bash
# 1. 确认失败来自 execve 而非 loader
env -i PATH=/system/bin /system/bin/sh <script> --rootfs <dir> --relative-links

# 2. 确认 launcher 需要 linker 包装
/system/bin/linker64 <backend>/bin/bionilux --version

# 3. 全量单测
cd packages/linux-runtime && node --test test/*.test.mjs
```

## 相关

- bionilux#17：PATH 剔除 Termux bin（0.10.2）
- bionilux#18：launcher 走系统 linker（0.10.3）
- 本仓 PR #1796：失败真因回传 + `lastError` 落盘 + 离线 manifest 回退（issue #1790）
