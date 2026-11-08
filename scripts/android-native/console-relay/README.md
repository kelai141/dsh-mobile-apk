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

同一调试包里的两个实际中继可用 `bench-device.cjs` 做对照。先打开 Node 控制台
一次，让 APK 解包 `files/console-pty.mjs`。将脚本临时复制到同一已初始化应用的
`files/`，从 `run-as` 默认工作目录用快照 Node 运行它，传入已安装的原生中继
（`adb shell pm path <包名>` 对应的 `lib/<ABI>/libdsh_console_relay.so`）。
若外层 Node 不能直接执行，按应用的方式用 `/system/bin/linker64` 启动外层 Node。

脚本交错执行 5 轮 Node / Rust / Rust / Node，每次新建中继和 Bash；在两条路径
各预热一次后计时。提示符和 UTF-8 结果不在命令回显中，必须由 Bash 实际输出，
每次都检查退出码 17。脚本输出每次读数和中继的制品摘要。

Android 35 x86_64 独立模拟器，调试包 `0.14.11-NATIVE-PTY-TEST`，
快照 Node 24.18.0，APK 源码 `449de87d`（#1686），每条路径 10 次中位数：

| 指标 | Node + node-pty | Rust + bionic |
| --- | ---: | ---: |
| 启动至收到 ready 帧 | 872 ms | 59 ms |
| 启动至验证交互提示符 | 935 ms | 93 ms |
| 发送命令至收到 UTF-8 结果 | 9.6 ms | 7.9 ms |
| 等待 500 ms 后中继 RSS | 47,076 KiB | 3,200 KiB |
| 到提示符时中继累计 CPU 时钟 tick | 93 | 2.5 |
| 等待 500 ms 期间中继 CPU 时钟 tick | 0 | 0 |

该数据只覆盖中继协议和真实 Bash。RSS/CPU 只记中继进程；不含 Bash、WebView、
引擎或基准进程。没有测量整机功耗，未在 arm64 设备重复此对照。
