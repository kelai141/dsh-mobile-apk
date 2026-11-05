# 分段日志写入串行化（2026-11-04，issue #1366）

## 现象

`files/boot-segments.log` 由两个线程无锁并发追加：`markFirstHttp()` 走调用线程直接写，probe 尾线程经
`maybeEmitComposeTotal → emitBootSegments` 写同一个文件。`#174` 只把 `log()` 挪进单线程执行器，
没覆盖 segments 这条。

## 真因

「查长度 → 可能轮转 → `appendText`」这串操作不是原子的。两个线程交错时，轮转瞬间的 rename 与
append 可能落到两个不同代的文件上——表现为分段行丢失或半行。原注释只论证了「没有**别的进程**写」，
漏掉了「同一进程内两个线程」。

## 修法

`appendToSegmentsFile` 整段 `synchronized(segmentsLock)`（`= synchronized(...) { ... }` 表达式体，
改动面最小）；注释同步纠正为「唯一进程写者，但进程内两线程」。

## 复验

`SegmentsLogLockTest` 两条：必须有 `segmentsLock` 且 `appendToSegmentsFile` 整段加锁；两个入口都必须
走该函数，且不得绕过锁直接对 `boot-segments.log` 调 `appendText`。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 2 红、改后 4 绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`LogCollector.kt` 锚点按「分段偏移」重钉，另修了两条指向 `}` 与空行的旧锚点）。
- **未做设备验证**：本机无模拟器。
