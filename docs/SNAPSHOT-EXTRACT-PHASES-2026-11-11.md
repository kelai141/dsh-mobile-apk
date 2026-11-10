# 快照解包耗时构成（2026-11-11 实测）

设备 `emulator-5574`（API 29、x86_64、512 MiB 堆），APK 含 #1715 的 `LOOKAHEAD_BLOCKS` 限流。
快照解压后 783 799 833 字节，58 327 个 tar 条目。

```
I/dsh-snap: snapshot extract phases entries=58327 nextEntryMs=449023 totalDone=783799833
I/dsh-snap: snapshot extract used parallel xz decode threads=4 durMs=1668593
```

## 构成

| 分段 | 耗时 | 占比 |
| --- | ---: | ---: |
| tar 解析（`tar.nextEntry`，含跨块读取） | 449 s | 27% |
| 读 / 写 / 权限 / mkdir | ~643 s | 39% |
| 解码等待（限流后 worker 等消费者） | 其余 | 34% |
| **合计** | **1 669 s** | |

读/写/权限/mkdir 四段的逐项数据见 `SNAPSHOT-EXTRACT-PHASES-2026-11-10.md`：
`permMs` 每条约 2.77 ms、`mkdirMs` 每条约 1.73 ms。

## 这回答了「1364 秒空档」是什么

此前只插桩了读/写/权限/mkdir 四段，合计 643 秒，而总时长 2007 秒，剩下 1364 秒没有归属。
本轮把 `tar.nextEntry` 也计上，得到 449 秒——**空档里约三分之一是 tar 解析本身**，
其余主要是限流后 worker 等待消费者的时间（消费者慢，worker 就只能停在窗口边上）。

## 结论：主项是逐条目的系统调用

58 327 个条目，每条的权限设置与 `mkdirs` 各要几次系统调用，在慢文件系统上每次几毫秒。
这与前缀重写步是同一个病根（见 `NATIVE-PREFIX-REWRITE-COST-2026-11-11.md`）。

**换语言解决不了**：开销在 syscall 本身，不在解释器。可行的方向是减少调用次数：

- 权限：按构建期清单批量设置，而不是每条目四次 `setReadable`/`setWritable`/`setExecutable`；
- 目录：同一父目录的条目只 `mkdirs` 一次（当前每条目都调）；
- tar 解析：449 秒是 `TarArchiveInputStream` 的固有成本，改语言能省一部分，但要先量出
  其中多少是解码等待、多少是解析本身。

## 测量方法

在 `extractEntries` 里对 `tar.nextEntry` 前后取 `System.nanoTime()` 累计，解包结束时打一行日志。
该插桩只在调试构建里存在，未进主干。

## 一处必须记住的教训

本轮之前有一次测量得出「解包直接崩溃」的结论，那是**错的**：当时构建用的分支不含 #1715 的限流修复，
测到的是旧行为。**测之前必须核对被测二进制包含哪些提交**，否则会把「没测到」读成「修复无效」。
同类错误在脚本清单那次也犯过一次（装了不带清单代码的旧 APK）。