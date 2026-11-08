# Android 原生缓存盘点探针

`dsh-android-linux-env/src/runtime-cache.ts` 的盘点函数递归统计目录内的文件和逻辑字节。
本探针只比较这一只读步骤。它不选择清理目标、不删除用户数据，也不进入产品 APK。
符号链接计一项、零字节，不跟随；测试树包含指向外部目录的链接和悬空链接。

使用 NDK r27 的 API 26 clang 分别链接 `x86_64-linux-android` 与
`aarch64-linux-android`，并设置 `-z max-page-size=16384` 和 `-z common-page-size=16384`：

```sh
rustup target add x86_64-linux-android aarch64-linux-android
rustc --edition=2021 -O --target "$TARGET" -C linker="$NDK_BIN/${TARGET}26-clang" \
  -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384 \
  scan.rs -o dsh-cache-inventory
```

在独立的调试 APK 环境中完成快照初始化，分别将探针和 `compare-node.cjs`
复制到应用的 `files/dsh-cache-inventory` 与 `files/dsh-cache-inventory.cjs`，
给探针设置执行权限。用 `run-as com.dsharnessmobile.shell sh /data/local/tmp/dsh-cache-bench.sh`
执行经 ADB 推送的 `bench-android.sh`，之后删除暂存的脚本和探针。基准只清理自身创建的测试目录。

2026-11-08，Android 35 x86_64 独立 AVD，在应用 UID 下用相同测试树交错各跑 10 次。
全部返回 `bytes=64000 files=4002`；不存在的根目录返回非零。各指标为中位数：

| 路径 | 进程启动至退出 | CPU（user + sys） | 最大 RSS |
| --- | ---: | ---: | ---: |
| 快照 Node | 1.047 秒 | 1.067 秒 | 49,826 KiB |
| Android Rust | 0.073 秒 | 0.061 秒 | 4,964 KiB |

该对照包含 Node 启动。现有插件通常在已运行的引擎内调用此函数，因此这些数据只支持
「不为离线盘点启动 Node」的场景。是否从常驻引擎迁出，仍需测热调用、跨进程开销、
调度及真实缓存树。本轮 arm64 只有交叉编译证据，没有原生 arm64 设备结果。
