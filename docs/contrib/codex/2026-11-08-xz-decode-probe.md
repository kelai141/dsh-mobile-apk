# 只读 XZ 解码性能探针（设备侧）

- 日期：2026-11-08
- 分支：`codex/xz-decode-probe-20261108`（基线 `origin/main` = `9d8c47a2`）
- 新增：`app/src/androidTest/java/com/dsharnessmobile/shell/XzDecodeProbeTest.kt`
- 范围：只读探针，不改产品代码，不改协调仓，不推送。

## 1. 探针做什么

| 用例 | 判据 |
|---|---|
| `bundledSnapshotDecodesReadOnlyAndRejectsIncompleteInput` | APK 内嵌 `snapshot.tar.xz` 的 SHA-256 必须等于 `snapshot.sha256`；`openFd` 长度等于实际字节；顺序解码、生产计划并行解码、4 线程解码的字节数与 SHA-256 全部相同；tar 条目数与常规文件字节数 > 0；截断与字节翻转都必须失败或不完整 |
| `productionExtractRejectsTruncatedAndCorruptFixtures` | 小夹具上正常输入走 `extractParallel` 的 `parallel` 模式；截断与字节翻转必须抛异常 |

探针只写 `cache/xz-decode-probe.json`（证据文件），不解压到产品目录，不修改任何产品状态。

## 2. 构建与运行

在独立 worktree 根执行：

```powershell
.\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --console=plain "-PversionNameSuffix=-XZPROBE"
adb -s <serial> install -r -t app\build\outputs\apk\debug\app-debug.apk
adb -s <serial> install -r -t app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
adb -s <serial> shell am instrument -w -r -e class com.dsharnessmobile.shell.XzDecodeProbeTest com.dsharnessmobile.shell.test/androidx.test.runner.AndroidJUnitRunner
adb -s <serial> shell run-as com.dsharnessmobile.shell cat cache/xz-decode-probe.json
```

三份快照资产（`snapshot.tar.xz` / `snapshot.sha256` / `plugin-hard-manifest.json`）都被 gitignore，需先在 worktree 内准备。清单必须由同一份 tar 重新生成：

```powershell
node scripts\build-hard-manifest.mjs --snapshot app\src\main\assets\snapshot.tar.xz --out app\src\main\assets\plugin-hard-manifest.json
```

## 3. 设备结果（实测）

运行设备：`127.0.0.1:16384`（SM-A5360 机型模拟器，SDK 35，4 核，`maxHeapBytes=201,326,592`）。
未使用 `emulator-5582`。

| 资产 | 压缩字节 | 块数 | 摘要耗时 | 顺序解码 | 2 线程 | 4 线程 | 加速比（2 线程） | 吞吐（2 线程） |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| x86_64 快照 | 165,892,084 | 32 | 3,312 ms | 87,681 ms | 72,307 ms | 72,982 ms | 1.21x | 10.52 MiB/s |
| arm64 快照 | 168,528,588 | 33 | 2,183 ms | 112,835 ms | 89,923 ms | 105,075 ms | 1.25x | 8.74 MiB/s |

两份资产的判据全部通过：

- `declaredSha256 == actualSha256`（x86_64：`faffd4af…`；arm64：`aae92e3a…`）；
- 顺序、2 线程、4 线程解出的字节数与 SHA-256 完全一致（arm64：`823,808,000` B / `0090148c…`）；
- `tarEntries` x86_64 = 52,601，arm64 = 51,545，`tarFileBytes` 分别 744,340,662 / 772,871,854；
- 截断：顺序抛 `EOFException`，并行在 1 ms 内抛 `CorruptedInputException: XZ Stream Footer is corrupt`；
- 字节翻转：顺序抛 `CorruptedInputException: Compressed data is corrupt`；并行未抛，但输出 `789,422,080` / `811,225,088` 字节，**少于正常输出**，被判为不完整。

同一份 x86_64 资产在 `127.0.0.1:5559` 复跑通过（顺序 87,681 ms，2 线程 72,307 ms，1.21x），说明结论不依赖单台设备。

## 4. 发现：并行解码遇到坏块会静默少输出

真实快照上，字节翻转落在某个块内时：

- 顺序路径抛异常，`CorruptedInputException`；
- 并行路径 `ParallelXzInputStream` 读完**已解出的块**后结束，不抛异常，也不报告少了哪一块。

这是**探针侧观察到的实现行为**，不是本 PR 的修复目标。生产入口 `extractParallel` 在小夹具上的反证用例证明：损坏夹具仍会失败（`productionExtractRejectsTruncatedAndCorruptFixtures`），因为夹具的损坏命中 tar 结构。真实快照上的静默少输出可能被 tar 结构兜住，也可能在下一次解析中表现为 `Truncated TAR archive`；本次只记录判据，不声称已定位产品级后果。

## 5. 边界与限制

- **没有 arm64 主 ABI 设备**：当前在线设备全部报告 `x86_64` 主 ABI。arm64 快照资产在 x86_64 设备上跑通，证明解码器与探针与资产内容无关；**未做 arm64 设备运行**。
- **未使用 `emulator-5582`**：按要求排除；主线程占用该设备。
- **测试进程堆只有 16 MiB 的模拟器（emulator-5574）会 OOM**：4 线程解码在该设备上因 8 MiB xz 字典分配失败。生产计划在该设备上推出 1 线程，探针如实记录；这不是产品缺陷，是测试设备限制。
- **未进入发版候选链**：这是只读探针 PR，不改产品代码，也未进入 `release/v*` 候选链。
