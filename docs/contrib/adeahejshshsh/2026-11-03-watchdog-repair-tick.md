# 看门狗 tick 链在修复态断死（2026-11-03，issue #1354）

## 现象

引擎启动失败进入修复态（`RepairState.required/active/retryPending` 任一为真）之后，看门狗不再探活、
不再自动重启、通知 drain 也不再执行，直到 `EngineService` 重建（通常是用户重新打开应用）。
用户侧表现为「重启后灰页不自愈」，与 open issue #1345 列的现象吻合。

## 真因

`watchdogTick()` 的调度是**单次延迟重排**（`scheduleWatchdogTick`），全仓只有两个调用点：首拍
（`:292`）与每拍尾部（重排处）。而修复态分支在函数中间直接 `return`，跳过了尾部重排——
注释写的是「保持非健康节奏（5 秒）复看」，实现却是「这一拍之后没有下一拍」。

`RepairState.retryPending` 在**每次自动重试的退避窗口内都为真**，所以任意一次启动失败就能把链断掉，
不需要罕见时序。

## 修法

把重排从「try 之后的裸语句」挪进 `finally`：本拍**任何**早退（修复态、epoch 换代、异常）都会把下一拍
挂回去，停机与换代仍由 `isEpochCurrent(epoch) && epoch.watchdog.get() === exec` 两个判据兜住，
不会多出第二条链。修复态分支显式写 `nextDelayMs = WatchdogV2.ACTIVE_TICK_MS`（注释原本承诺的 5 秒复看），
保留「后台不得重启/回撤正在被修复的运行时」这一语义——它仍然在本拍提前收尾，只是不再把链断掉。

没有新增定时器、没有第二个重排点：判据仍收口在 `nextDelayMs` 一处。

## 复验

- 契约用例 `WatchdogCadenceTest.修复态分支必须把下一拍挂回去`：断言重排在 `finally` 里、修复态分支
  自己写了 5 秒节奏。**边界用分支的收尾花括号而不是注释行**——`codeOnly` 会整行删注释，
  拿注释当分隔符会 `substringBefore` 不到而退化成整条 tick 上找（本地负控第一版就踩了这个）。
- **Kotlin 单测未在本机跑**：本机没有 Android SDK/Gradle，由 CI 执行。本机用同判据脚本对源码求值：
  改前 3 条红（分支缺 5 秒节奏、重排不在 finally、finally 里没有重排），改后 4 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED。
- `node scripts/check-code-map.mjs` → PASSED（K03 行锚点从 `:348` 改钉到 `assessProbe` 调用行 `:349#expect=…`）。
- **未做设备验证**：本机无模拟器、装不了包。端到端表现（制造一次启动失败后心跳是否续上）见 PR 的验收卡。
