# Android 原生会话写锁探针

DSH 的 JSONL 会话后端通过 `@deepseek-ai/node-addon-system/flock` 获取非阻塞独占锁。上游预编译包未覆盖 Android；APK 的 `flock-android-F3` 兼容层按单引擎假设立即返回成功。当两个进程共享会话目录时，这条兼容路径不提供系统级互斥。

这里提供独立 Rust Node-API 模块，保留上游绑定的 `tryLock(fd, callback)` 形状。在异步工作线程调用 Bionic 的 `flock(fd, LOCK_EX | LOCK_NB)`，以正 errno 返回错误。文件描述符仍由调用方管理；绑定不会打开、复制或关闭它，也不启动子进程。

2026-11-09，在隔离 Android Studio AVD（API 35、主 ABI x86_64）中用已安装调试 APK 的 Node 24.18.0 实测。同一临时文件上，原版 Android 兼容层让持锁进程和竞争进程都返回成功。Rust 绑定让竞争进程收到 `EAGAIN`，持有者关闭描述符后可重新获取；无效描述符返回 `EBADF`。原始数据见 [x86_64 报告](evidence/avd-api35-x86_64.json)。探针在 Android 两种 ABI 上编译并核对了 16 KiB ELF 对齐；没有 arm64 设备或产品会话端到端结果。

复测时，把编译产物复制为隔离调试 APK 缓存内的 `.node` 文件。在应用数据根以应用 UID 和随包 Node 运行 `check-device.mjs <node路径> <模块路径> <stub|native>`。先对已安装的 `node-addon-system/lib/flock.js` 跑 `stub`，再对编译产物跑 `native`；脚本用两个进程竞争测试专用锁文件。

生产路径未改变。接入前须用真实会话服务验证双进程写入、超时、取消、崩溃后恢复，以及两种 ABI 的 APK 启动和回退。会话格式、npm 包名与 JS 错误映射保持原契约。
