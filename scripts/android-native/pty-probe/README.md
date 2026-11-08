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
这证明系统 PTY 可用。探针在 ADB shell UID 下运行；产品还需在应用 UID 下验证
Termux bash、交互程序、信号、并发关闭和异常恢复。两条路径须用相同 shell、命令和
设备交错对比，测量响应时间、应用与子进程总 CPU/RSS、唤醒和功耗后，才可决定是否接入。
arm64 本轮只核验了交叉编译和 ELF。
