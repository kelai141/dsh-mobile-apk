# Android 原生控制台中继

Android 调试包可以用这个 Rust 中继代替额外启动的 Node 和 node-pty。
它使用 bionic PTY，仍启动快照里的交互 bash。控制台的 JSON 帧、WebView 桥和
TERM/TERMINFO/VIMRUNTIME 保持原样。原生中继未打包、无法执行，或三秒内未确认
shell 已执行时，控制台使用现有 Node 路径；只有 Node 组件也缺失才退回非 PTY bash。

从 `Android 原生 PTY 探针` 工作流获取两个 ABI 的 `console-relay-*` artifact，
或用 NDK r27 的 API 26 clang 构建 `Cargo.toml`，链接时启用 16 KB 页面：

```sh
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$NDK_BIN/x86_64-linux-android26-clang"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_BIN/aarch64-linux-android26-clang"
export RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384'
cargo build --locked --release --target x86_64-linux-android --target aarch64-linux-android
```

将每个可执行文件放到独立目录的 `<ABI>/libdsh_console_relay.so`。ABI 目录名分别为
`arm64-v8a` 和 `x86_64`。在已准备匹配 ABI 快照资产的 APK 仓根执行
`./gradlew :app:assembleDebug -PnativeConsoleRelayDir=/absolute/path/to/that/directory`。
Windows 也可设置 `ORG_GRADLE_PROJECT_nativeConsoleRelayDir`。这个属性只为调试包
提供原生文件；未配置时不选用该路径。正式构建不启用。

应用 UID 下的直接对照使用 `test-device.cjs`：把脚本与对应架构中继临时复制到独立
调试应用的 `files/`，设置中继执行权限，以快照 Node 运行脚本并传入中继文件路径。
脚本断言真实 TTY、作业控制、窗口变化、UTF-8、Ctrl-C、退出码及清理。负控使用
不存在的 shell，必须先返回 error，不能宣告 ready。装包后还须走仓内三层验收。
