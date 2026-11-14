# 壳侧四连：残留临时文件 / 事后体积判据 / 裸写 / 墙钟量冻结区间（2026-11-15）

对应 issue：#1583 #1622 #1609 #1577（#1576 复核确认已接线，#1608 在本仓工作树里不存在）。

## 共同形态

四条都不是「逻辑写错」，而是**判据落在了错误的位置上**：

1. #1583 —— 清理写在 `catch` 里，而不是 `finally` 里。五条早退全是 `return`，一处都不经过 catch。
2. #1622 —— 体积判据写在 `copyTo` **之后**。写满分区那一刻判据才第一次成立，此前所有字节已经落盘。
3. #1609 —— 写入走 `File.writeText`（截断后直写），而仓内同类文件早已全部收敛到 `AtomicFileReplace`。
4. #1577 —— 墙钟被当成区间量具。同一文件里 boot-stall 早已为此整段换成单调时钟，冻结闸门没跟上。

## 真因与修法

- **#1583**：`try` 里五条早退（unreadable / too-large / empty / decode-failed / io-failed）都直接
  `return`，只有 `catch (Throwable)` 删 temp。而 `purgeOtherStoredVideos` 只认 `splash_video*` 前缀
  ⇒ `.splash-*.tmp` 永不回收。修法：加 `finally { if (temp.exists()) temp.delete() }`。发布成功后
  temp 已被 `AtomicFileReplace.publishWritten` 的 move 消费，`exists()` 为假 ⇒ 对 Saved 分支是空操作，
  **返回语义不变**（这一点被单独一条用例钉住，防止以后有人把清理写成「temp 不存在就判失败」）。
  为了让这条判据在 JVM 上可达，加了 `importFrom(context, name, bytes, mime, openStream)`：
  流源是唯一被注入的东西，落盘 / 校验 / 发布与生产同一条代码。
- **#1622**：`copyTo` 换成带计数的循环（`downloadArchive`），上限收敛成纯函数
  `archiveCapFor(declaredSize)`：有声明 = 声明 + 16 MiB（与旧的事后判据同值），无声明（或非法负值）
  = 硬上限 2 GiB。判据**先于写入**：越过上限的那一段不落盘，半包由调用方 `finally` 清掉。
  同时改掉 75-76 行那条与实测不符的注释（旧注释写「下载按声明大小限流」，实际是事后判）。
- **#1609**：四处裸写全部改 `AtomicFileReplace.writeText`：`repairSettingsSeed` 的 settings.yaml、
  `seedPhoneControlPreset` 的 SKILL.md / 注入后的 `agent.cordis.yml` / 播种的 `agent.cordis.yml` 与
  `preset.yml`。失败语义不变：原子写发布失败抛 `IOException`，与旧 `writeText` 落进同一个
  `catch (Throwable)`。`preset.yml` 那条尤其重要——幂等早退判据就是「preset.yml 存在」，
  半份文件会让判据成立且**永不重试**。
- **#1577**：`freezeRunnable` 的 tick 读数、`onAck` 的应答读数、`startFreezeWatchdog` 的
  `onPageLoaded` 读数三处统一取 `bootStallNow()`（`SystemClock.elapsedRealtime()`）。
  三处必须同源：只改一处会让区间比较跨两个基准，行为比全墙钟更糟。
- **#1576**：复核确认已接线——`EngineService` 的 `portOwnedByApp` 传的是
  `engineManager.trackedChildAlive()`，同一处 planTick 的 `engineProcessAlive` 参数保持原样
  （两个参数问的是两个不同问题）。本轮只补判据把它钉住，不改实现。

## 判据（每条都能真打红）

| 用例类 | 修前红 | 负控（把实现改回去） |
|---|---|---|
| `SplashTempCleanupTest`（5 例） | 去掉 finally 后 5/5 FAILED | remove finally ⇒ 5 例红 |
| `UpdateDownloadCapTest`（6 例） | 退回 copyTo + 事后判 ⇒ FAILED | copyTo 复原 ⇒ `downloadUsesTheCountedLoopAndNotCopyTo` 红 |
| `AtomicSeedWriteTest`（3 例） | 四处裸写复原 ⇒ 2 例红 | 裸写复原 ⇒ settings / seeding 两例红 |
| `FreezeGateClockTest`（4 例） | 三处墙钟复原 ⇒ 接线例红 | 墙钟复原 ⇒ `everyFreezeGateClockReadComesFromTheMonotonicSource` 红 |
| `WatchdogPortOwnershipWiringTest`（2 例） | 接线退回 engineProcessAlive ⇒ 1 例红 | 同上 |

## 复验

- `gradlew.bat :app:testDebugUnitTest` 全量：见 PR 描述里的日志片段。
- 未做设备验证：本轮四条都是壳侧 Kotlin（L2/L3），无打包预算，PR 里显式标注并写明补验点。
