# 深睡不再冒充「连续失败」+ 冻结自愈判据落到状态机上（2026-11-04，issue #1505 / #1513）

## 现场

两条都是「判据/记账的单位与真实世界对不上」，且都在**同一条时间轴**上：

- #1505：#1357 把看门狗拍长记账从墙钟换成 `elapsedRealtime()`（对——系统时间前跳会让 `tickMs` 爆掉）。
  但那个时钟**包含深睡**，而 `Handler.postDelayed` 在 doze 期间不执行 ⇒ 唤醒后的第一拍 `tickMs`
  就是睡眠时长。`tickUnits` 对任意大间隔封顶 6 个标准拍，`recordProbe` 又是 `consecutiveFailures += units`
  ⇒ **两拍**就是 12，直接撞 `MAX_CONSEC_FAILURES`。深睡唤醒被当成「引擎连续失败 60 秒」，自动恢复被抑制。
- #1513：#1355 的负控用例切错了作用域：它切的是 `startFreezeWatchdog()`（EngineStartFlow.kt:424）到
  `startUpdateCheck()`（:439），只含 424-439 的 post 语句；而**置位点**与**唯一复位点**都在
  `freezeRunnable`（:130-169）里。于是把 `freezeReloaded = false` 挪进冻结分支（每 10 秒 tick 都复位
  = reload 循环）时，那条用例仍然绿。

## 真因

- #1505：把「本拍隔了多久」直接当成「失败持续了多久」。深睡 gap 属于**观测缺口**，不是失败观测；
  封顶（6 拍）本意是防跳步，却正好让「两拍 = 一次睡眠」够到熔断。
- #1513：判据盯着**相邻函数**而不是**状态机**。文本切片对「同样的文本出现在别的分支里」没有分辨力。

## 修法

- #1505（纯函数 + 一行接线）：
  - `WatchdogV2.tickAccounting(elapsedMs)` 返回 `(units, gap, log)`；`elapsedMs > GAP_TICK_MS` 时只记
    **一个**标准拍并给 `watchdog-gap` 日志行。阈值取 `HEALTHY_TICK_MS + STANDARD_TICK_MS`（25s），
    不是「2 个标准拍」——健康态 20 秒拍本身就是合法的 4 个标准拍，按 10s 设阈值会把它误判成缺口
    （DEAD 引擎从健康拍降下来那一拍也要折 4 拍，压成 1 拍会把 60 秒熔断拉成 240 秒）。
  - `EngineService.watchdogTick` 用 `val accounting = WatchdogV2.tickAccounting(tickMs)`，缺口时落一行。
    零位移：13 行换 13 行。
- #1513（状态机 + 行为判据）：新增 `FreezeRecoveryGate`（页面观察窗 45s、应答宽限 20s，与旧实现同值）：
  - `tick(now)` 返回 `RELOAD` / `PING` / `NONE`；冻结分支**只在未 reload 过时**返回 RELOAD，已 reload 过
    返回 NONE（绝不在同一分支里复位）；
  - `onAck` 是唯一复位点（页面真活，重开预算）；
  - `onPageLoaded` 只重置计时，**不复位**闸门（onPageFinished 只代表文档加载完，此时 JS 可能仍然死着）。
  - `EngineStartFlow` 的 `freezeRunnable` 退化成「读动作 -> 做动作」（reload / evaluateJavascript），
    零位移：26 行换 26 行。

## 负控（都真打红过，随后已还原）

| 把实现改坏 | 红在哪 |
|---|---|
| 把 `freezeReloaded = false` 挪进冻结分支（#1513 的原始缺陷） | `同一轮冻结只reload一次_不得每拍都reload` + `页面加载事件不得复位冻结闸门`（2 例） |
| `onPageLoaded` 里复位闸门（onPageFinished 即复位） | `页面加载事件不得复位冻结闸门`（1 例） |
| `tickAccounting` 去掉缺口分支（等价于旧的 tickUnits 封顶） | `缺口拍按一个标准拍记账_合法节奏不受影响` + `深睡唤醒两拍不得打满熔断`（2 例） |

其中 `深睡唤醒两拍不得打满熔断` 自带判别力反证：同一用例里用**旧口径**（`tickUnits` 的封顶值）喂两拍，
断言 `tripped()` 为真——证明这条用例不是恒绿。

## 证据与边界

- `FreezeRecoveryReArmTest` 7 例、`WatchdogCadenceTest` 11 例（新增 2 例）全绿；`testDebugUnitTest` 全量绿；
  `check-code-map` / `check-kotlin-test-count` / `check-release-gates` / `check-kotlin-comments` 全绿。
- 改动零位移：`EngineService.kt` 9/9、`EngineStartFlow.kt` 26/26，`WatchdogV2.kt` 为纯追加（文件末尾）；
  新逻辑（状态机）在新文件 `FreezeRecoveryGate.kt`，执行地图已登记覆盖与锚点。
- `WatchdogCadenceTest` 里原有的两条源码契约断言只改了一处接线字符串（`tickUnits(tickMs)` ->
  `tickAccounting(tickMs)`）；缺口记账的**行为**由新增两条用例守，不再靠文本。
- **未做设备验证**：深睡/doze 唤醒时序无法在模拟器上真实制造（需要真实息屏久置），进发版候选前须补真机三层验收。
