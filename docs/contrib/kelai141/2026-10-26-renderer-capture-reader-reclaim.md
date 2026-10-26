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

## 未做设备验证

管道生命周期是 L2 面，本轮没有设备。设备层需补验的判据见 PR 描述。
