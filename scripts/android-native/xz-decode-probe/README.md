# Android 原生 XZ 解码探针

使用 Android bionic 上运行的 Rust 解码器，对 APK 的构建快照做只读对照。逐块读取
解码输出并计算 SHA-256；不落 tar，不写应用数据。仅供构建快照测量，不能用于
任意第三方压缩包：顺序路径限制字典内存，并行路径会缓冲完整的块。

工作流提供 API 26、16 KB ELF 对齐的 x86_64 和 arm64-v8a 二进制。选择和设备主 ABI
匹配的探针，以及一份有 JVM 侧解码字节数与 SHA-256 基线的构建快照：

```sh
adb -s "$SERIAL" shell mkdir /data/local/tmp/dsh-xz-probe
adb -s "$SERIAL" push dsh-xz-decode-probe /data/local/tmp/dsh-xz-probe/probe
adb -s "$SERIAL" push snapshot.tar.xz /data/local/tmp/dsh-xz-probe/snapshot.tar.xz
adb -s "$SERIAL" shell chmod 755 /data/local/tmp/dsh-xz-probe/probe
adb -s "$SERIAL" shell sha256sum /data/local/tmp/dsh-xz-probe/snapshot.tar.xz
adb -s "$SERIAL" shell /data/local/tmp/dsh-xz-probe/probe \
  /data/local/tmp/dsh-xz-probe/snapshot.tar.xz 2 "$EXPECTED_TAR_BYTES" "$EXPECTED_TAR_SHA256"
```

支持 1、2、4 个解码线程。探针的 JSON 只在字节数和摘要都匹配后输出。
耗时包含解码和摘要，CPU 为该进程所有线程用户态与系统态之和，RSS 为进程峰值。

## 实测

Android 35 x86_64 MuMu（4 核），APK 的 arm64 快照资产：压缩 168,528,588 字节，
SHA-256 `aae92e3a17796a10ce5ae3a44c81691136ce83ac40076a2c5352d4182856d73c`。
解码 823,808,000 字节，SHA-256
`0090148cdec653c2b21418238275eb3ed91acbed531e90db96ade9391d8051aa`，
三个配置都和同一模拟器的 JVM 探针（#1688）一致。

| 解码线程 | Rust 耗时 | Rust CPU | Rust 峰值 RSS | JVM 耗时（前一轮） |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 58.24 s | 56.94 s | 19.7 MiB | 112.84 s |
| 2 | 24.74 s | 56.00 s | 173.9 MiB | 89.92 s |
| 4 | 21.52 s | 61.11 s | 268.2 MiB | 105.08 s |

截断到 4,096 字节后，顺序和双线程都以退出码 1 拒绝，未输出成功记录。
两次测量分别启动，没有交错，也没有可比的 JVM CPU/RSS 数据；目前不能推断
APK 完整首启、并行内存预算、arm64 设备表现或功耗。单线程的资源曲线优先用来
评估后续接入，现有快照解压不受此探针影响。
