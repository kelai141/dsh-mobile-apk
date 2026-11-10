# Android 原生会话写锁探针

DSH 的 JSONL 会话后端通过 `@deepseek-ai/node-addon-system/flock` 获取非阻塞独占锁。上游预编译包未覆盖 Android；APK 的 `flock-android-F3` 兼容层按单引擎假设立即返回成功。当两个进程共享会话目录时，这条兼容路径不提供系统级互斥。

这里提供独立 Rust Node-API 模块，保留上游绑定的 `tryLock(fd, callback)` 形状。在异步工作线程调用 Bionic 的 `flock(fd, LOCK_EX | LOCK_NB)`，以正 errno 返回错误。文件描述符仍由调用方管理；绑定不会打开、复制或关闭它，也不启动子进程。

2026-11-09，在隔离 Android Studio AVD（API 35、主 ABI x86_64）中用已安装调试 APK 的 Node 24.18.0 实测。同一临时文件上，原版 Android 兼容层让持锁进程和竞争进程都返回成功。Rust 绑定让竞争进程收到 `EAGAIN`，持有者关闭描述符后可重新获取；无效描述符返回 `EBADF`。原始数据见 [系统锁对照](evidence/avd-api35-x86_64.json)。探针在 Android 两种 ABI 上编译并核对了 16 KiB ELF 对齐；没有 arm64 设备结果。

另在 API 29 x86_64 上挂载 APK 实际安装的会话后端（模块 SHA-256：`b9ac5744c96a35c881ccc0d1b70850b012245dc54f07f2e543ad3632784a0981`）。持有者写入一条事件后不关句柄，第二个进程请求写入权限。原兼容层放行，测试替换后的后端返回 `SessionAlreadyOwnedError`；持有者关闭句柄后，两个变体都能重新打开。该测试只在隔离进程中用 Node 导入钩子替换 flock，原 APK 和会话目录都未修改。见 [会话后端对照](evidence/session-api29-x86_64.json)。

复测时，把编译产物复制为隔离调试 APK 缓存内的 `.node` 文件。在应用数据根以应用 UID 和随包 Node 运行 `check-device.mjs <node路径> <模块路径> <stub|native>`。先对已安装的 `node-addon-system/lib/flock.js` 跑 `stub`，再对编译产物跑 `native`；脚本用两个进程竞争测试专用锁文件。

会话后端复测命令是 `check-session-device.mjs <node路径> <已安装的@deepseek-ai目录> <stub|native> <.node路径>`。生产路径未改变。接入前须覆盖取消、崩溃后恢复，以及两种 ABI 的 APK 启动和回退。会话格式、npm 包名与 JS 错误映射保持原契约。

调试 APK 的候选接线：

1. 在快照构建时设置 `DSH_ANDROID_SESSION_FLOCK=1`。标准 F3 补丁通过后，构建器从实际会话后端解析 `node-addon-system/flock`，再写入加载器。包清单、导出和 errno 映射不变。源码形状不匹配时拒绝生成候选。
2. 将两个 ABI 的编译产物放入同一目录的 `arm64-v8a/libdsh_session_flock.so` 和 `x86_64/libdsh_session_flock.so`，设置 Gradle 属性 `nativeSessionFlockDir`（也可用 `ORG_GRADLE_PROJECT_nativeSessionFlockDir`），用该快照构建调试 APK。正式发版路径尚未启用。
3. 加载器按需从 `DSH_NATIVE_LIB_DIR` 找库。库缺席时保留原单引擎路径；库已部署但无法加载时向调用方传播错误。

API 35 x86_64 上，用实装模块的副本验证了这条加载器路径：[设备报告](evidence/loader-api35-x86_64.json)。正确的 `.so` 令第二进程收到 `EAGAIN`，关闭描述符后可重试；文件缺席时按旧契约运行，坏库返回 `ERR_DLOPEN_FAILED`。

2026-11-10 补上打包后整包验收：APK `0.14.11-FLOCK-DEV` 覆盖安装在 `dsh-flock-e2e-api35`（API 35、x86_64），快照指纹落到候选值。`check-session-device.mjs … packaged` 不替换任何模块导入，直接用 APK 实装的加载器：竞争写者收到 `SessionAlreadyOwnedError`，持有者正常关闭后可重开，持有者被 `SIGKILL` 后同样可重开。同一会话上，`stub` 变体让竞争写者直接成功，可作负控。

另在引擎运行中从外部进程抢同一会话：带 `DSH_NATIVE_LIB_DIR` 时被拒，去掉该变量即回落旧兼容层放行；实装引擎进程的 `/proc/<pid>/maps` 里确有 `libdsh_session_flock.so`，说明走的是 APK 注入路径而不是测试脚手架。数据见 [打包模式对照](evidence/session-packaged-api35-x86_64.json)。

打包模式的子进程用 `/system/bin/linker64` 启动，需要在应用数据根设置 `LD_LIBRARY_PATH` 指向随包 `usr/lib`，并让父进程不带 `childRoot` 参数（该参数只给子进程用）。arm64-v8a 仍只有编译与 APK 内容检查。
