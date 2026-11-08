# 附件 JPEG 的 Android 原生探针

上游 `attachment-local` 首次处理图像时加载 Sharp，Android 快照使用 WASM 后端。
这组只读探针对比同一张 JPEG 的三段工作：准入全解码、按 EXIF 转向并缩放编码、
验证输出并全解码。两边均检查尺寸、去掉 EXIF，并拒绝截断夹具。

`python make-fixture.py oriented.jpg` 使用 Pillow 12.2.0 生成 4000×3000 的夹具。
测量输入为 1,132,954 字节，SHA-256
`722cb8e75b49863bd01769cb593a75189adde277307129b4c1b4d3b6c1eaaa5d`。
用 Android NDK r27 / API 26 交叉编译 `Cargo.toml`，链接参数参见
[原生 XZ 探针工作流](../../../.github/workflows/android-native-xz-probe.yml)。

在已初始化的调试 APK 上，把夹具、`sharp-device.cjs` 和对应 ABI 的探针临时复制到
`files/`。在 `run-as` 默认工作目录，用快照 Node 执行 JS，或用 Android 链接器
执行原生探针；两边传同一文件路径。此处用链接器是为了在调试应用数据目录运行
临时 ELF；生产路径不靠这个目录装载程序。

```sh
APP=com.dsharnessmobile.shell
ROOT=/data/user/0/$APP/files
adb shell "run-as $APP env LD_LIBRARY_PATH=$ROOT/usr/lib /system/bin/linker64 \
  $ROOT/usr/bin/node files/sharp-device.cjs files/oriented.jpg"
adb shell "run-as $APP /system/bin/linker64 $ROOT/dsh-attachment-image-probe files/oriented.jpg"
```

Android 35 x86_64，同一独立模拟器和应用 UID。Sharp 0.35.3 / Node 24.18.0。
每侧一次预热、五次取中位数，两个进程分别运行，未交错：

| 指标 | Sharp WASM | Rust |
| --- | ---: | ---: |
| 准入全解码 | 1,161 ms | 131 ms |
| 旋转、缩放、编码 | 1,629 ms | 2,016 ms |
| 结果验证和全解码 | 181 ms | 45 ms |
| 探针进程峰值 RSS | 430 MiB | 118 MiB |
| 质量参数均为 85 时的 JPEG 体积 | 317,323 B | 569,396 B |

Sharp 首次加载为 2,340 ms。峰值 RSS 包含各自进程和运行时，不能直接当作引擎
内存节省。两边输出均为 1200×1600 的 JPEG，编码字节不同，质量参数相同并不证明
视觉质量等价。Rust 当前编码路径更慢，文件也更大；不宜直接替换整个附件管线。
可单独评估准入解码，但须覆盖 ICC、CMYK、透明图、动画、错误语义和真实调用开销。
未做 arm64 设备、Cordis 端到端调用或整机功耗验证。
