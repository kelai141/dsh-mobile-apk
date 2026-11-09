# Android 原生会话写锁探针

DSH 的 JSONL 会话后端通过 `@deepseek-ai/node-addon-system/flock` 获取非阻塞独占锁。上游预编译包未覆盖 Android；APK 的 `flock-android-F3` 兼容层按单引擎假设立即返回成功。当两个进程共享会话目录时，这条兼容路径不提供系统级互斥。

这里提供独立 Rust Node-API 模块，保留上游绑定的 `tryLock(fd, callback)` 形状。在异步工作线程调用 Bionic 的 `flock(fd, LOCK_EX | LOCK_NB)`，以正 errno 返回错误。文件描述符仍由调用方管理；绑定不会打开、复制或关闭它，也不启动子进程。

2026-11-09，在隔离 Android Studio AVD（API 35、主 ABI x86_64）中用已安装调试 APK 的 Node 24.18.0 实测。同一临时文件上，原版 Android 兼容层让持锁进程和竞争进程都返回成功。Rust 绑定让竞争进程收到 `EAGAIN`，持有者关闭描述符后可重新获取；无效描述符返回 `EBADF`。原始数据见 [系统锁对照](evidence/avd-api35-x86_64.json)。探针在 Android 两种 ABI 上编译并核对了 16 KiB ELF 对齐；没有 arm64 设备结果。

另在 API 29 x86_64 上挂载 APK 实际安装的会话后端（模块 SHA-256：`b9ac5744c96a35c881ccc0d1b70850b012245dc54f07f2e543ad3632784a0981`）。持有者写入一条事件后不关句柄，第二个进程请求写入权限。原兼容层放行，测试替换后的后端返回 `SessionAlreadyOwnedError`；持有者关闭句柄后，两个变体都能重新打开。该测试只在隔离进程中用 Node 导入钩子替换 flock，原 APK 和会话目录都未修改。见 [会话后端对照](evidence/session-api29-x86_64.json)。

复测时，把编译产物复制为隔离调试 APK 缓存内的 `.node` 文件。在应用数据根以应用 UID 和随包 Node 运行 `check-device.mjs <node路径> <模块路径> <stub|native>`。先对已安装的 `node-addon-system/lib/flock.js` 跑 `stub`，再对编译产物跑 `native`；脚本用两个进程竞争测试专用锁文件。

会话后端复测命令是 `check-session-device.mjs <node路径> <已安装的@deepseek-ai目录> <stub|native> <.node路径>`。生产路径未改变。接入前须覆盖取消、崩溃后恢复，以及两种 ABI 的 APK 启动和回退。会话格式、npm 包名与 JS 错误映射保持原契约。
