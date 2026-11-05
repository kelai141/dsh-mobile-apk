# 截图管道读线程回收（issue #607）

## 缺陷

`RemoteRendererHost.capturePng` 的读端要等 `api.capture` 的 binder 回执返回后才开始读。
远端 `BrowserProcessService.RemoteTab.capture` 在 binder 调用内**同步** `bitmap.compress` 写管道，
而 Linux 管道缓冲只有 64KiB。PNG 超过缓冲时，远端写阻塞在半途、宿主等回执永不读，两端互等；
宿主 `shotOp` 在主线程上等，10s 即 ANR。

#582 修了并发排空，但三个出口仍然直接 `return null`：回执失败、binder 异常、`join` 超时。
远端在回执失败或超时放弃之后仍可能继续持有写端，读线程就一直阻塞在管道上；每失败一次积
一个线程加两个文件描述符。

## 修法

把生命周期收进 `CapturePipeDrain`（不依赖 Android，可 JVM 直测）：

- 读线程先启动，再发起 `capture`；
- 正常收尾上限 15s，取消收尾上限 500ms；
- **每个出口**都置取消标记、关读端、有界 join；
- 读实现用 100ms `poll` 轮询让取消有界——对端还持有写端时，关本端文件描述打不断另一个
  线程里已阻塞的 `read()`；
- binder 异常原样上抛，外层 `capturePng` 的 `runCatching` 把它折成 null。

空载荷判据**未改动**（仍然是 `takeIf { it.isNotEmpty() }`）。#614 把「必须非空」与线程回收
混进同一个 PR，但它是 #582 就有的既有语义，不是这次要改的东西，故本 PR 原样保留并在
`CapturePipeDrainTest` 里锁住口径。

## 证据

- `CapturePipeDrainTest` 10 例全绿（JVM，真实线程审计）；
- 负控：把 `drain` 的 finally 还原成 #607 指认的旧形态（直接返回、不取消、不关读端、不等收尾），
  10 例里 7 例判红，逐条点名留下读线程 / 没置取消标记；
- 全量 `:app:testDebugUnitTest` 1840 例 0 失败（2 例既有跳过）；
- `check-code-map` / `check-kotlin-comments` / `check-kotlin-test-count` / `check-state-registry` /
  `check-bridge-symmetry` / `check-gate-skips` / `check-i18n-parity` / `check-release-gates` /
  `check-build-chain-abort` / `check-bounded-io` / `check-engine-heap-floor` 全过。

## 设备层验证（MuMu x86_64 127.0.0.1:16576，SDK 35）

新增 `RendererCapturePipeTest`（androidTest），用真实 `ParcelFileDescriptor` 管道驱动生产
`capturePng`，远端回执由 `IBrowserRenderer` 动态代理伪造。5 例在设备上全绿：

1. 回执 false 且远端保留写端：返回 null 后 `dsh-shot-pipe-reader` 已不存在；
2. 回执 true 但远端不结束写入：预算内返回 null，读线程已回收；
3. 256KiB 大载荷在远端仍在写时被并发排空，字节完整；
4. 连续 10 次失败后宿主 fd 不增长；
5. 失败回执立即返回（不等满 10s 主线程超时）。

**设备层抓到一个单测没覆盖的真缺陷**：初版 `drain` 把宿主自己的 `pipe[1]` 留到 finally 才关，
读端因此永远等不到 EOF——256KiB 的正常载荷被 join 超时误判成 null。JVM 单测用假读实现，
读实现自己返回 EOF，所以掩盖了这条。修法是在 `startCapture` 返回后**立刻**关本端写端
（`closeWriter`），并补一条只在「写端已关」时才返回 EOF 的 JVM 回归用例。
设备层从 5 例 2 红变为 5 例全绿。