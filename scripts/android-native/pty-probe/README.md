# Android 原生 PTY 探针

控制台目前用快照中的 Node 和 node-pty 转发 PTY 流量。这个独立探针用 Android
bionic 的 `forkpty` 启动 `/system/bin/sh`，验证终端输入、中文回读、窗口缩放和退出码。
探针不需要 Termux、Node、APK 或引擎，产物不进入 APK。

`Android 原生 PTY 探针` 工作流用 NDK r27、API 26 分别构建 x86_64 和 arm64，
校验 ELF 架构与加载段的 16 KB 对齐。下载与设备主 ABI 匹配的产物后运行：

```sh
adb -s SERIAL push dsh-native-pty-probe /data/local/tmp/dsh-native-pty-probe
adb -s SERIAL shell chmod 700 /data/local/tmp/dsh-native-pty-probe
adb -s SERIAL shell /data/local/tmp/dsh-native-pty-probe
adb -s SERIAL shell rm -f /data/local/tmp/dsh-native-pty-probe
```

成功输出包含 `android_native_pty_ok`、架构和耗时。主子进程必须观察到实际终端输入、
尺寸 `31 103` 和退出码 `17`；单纯打印输入或拉起 shell 不算通过。超时或验证失败返回非零。

2026-11-08 在隔离的 Android 35 x86_64 AVD 与 MuMu x86_64 上各运行五次，均通过。
arm64 本轮只核验了交叉编译和 ELF。

另在同一隔离 AVD 的应用 UID 下，使用已初始化的调试 APK（Node 24.18.0），
交错执行 Node、Rust、Rust、Node 五轮。两边都拉起同一个 `/system/bin/sh`，
并执行相同的终端输入、缩放和退出判据。以下是 `toybox time -v` 的中位数：

| 路径 | 进程启动到退出 | CPU（user + sys） | 最大 RSS |
| --- | ---: | ---: | ---: |
| Node + node-pty | 0.953 秒 | 0.848 秒 | 47,000 KiB |
| Rust + bionic | 0.153 秒 | 0.117 秒 | 4,898 KiB |

复测时，在专用 AVD 中完成调试 APK 的快照初始化，把 `compare-node.cjs` 和探针
暂存到应用私有的 `files/`，以 `run-as com.dsharnessmobile.shell` 运行以下两条命令，
交错轮换顺序；测完删除暂存的两个文件。

```sh
LD_LIBRARY_PATH="$PWD/files/usr/lib" /system/bin/toybox time -v files/usr/bin/node files/compare-node.cjs
/system/bin/toybox time -v files/dsh-native-pty-probe
```

这是短进程微基准，覆盖 Node 与 node-pty 初始化开销；没有覆盖产品控制台的 JSON 转发、
Termux bash、交互程序、信号、并发关闭和异常恢复。功耗和唤醒也未测。
