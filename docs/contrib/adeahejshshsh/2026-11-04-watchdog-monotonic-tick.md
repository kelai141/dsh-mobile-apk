# 看门狗拍长记账改用单调时钟（2026-11-04，issue #1357）

## 现象

看门狗用墙钟计算「本拍实际经过了多久」，而唤醒锁用的是 `elapsedRealtime`。系统时间前跳时
`tickMs` 会变得极大，`tickUnits` 封顶 6 个标准拍——两次观测即可把 `DEGRADED_HTTP` 推满 12 拍熔断。

## 真因

两个时钟域混用：拍长记账用 `System.currentTimeMillis()`（可被用户改时间、NTP 跳变影响），
唤醒锁续期用 `SystemClock.elapsedRealtime()`（单调）。同一拍里两种时间基准并存，前跳一次就
等于「隔了很久」，直接把阶梯拍数推满。

## 修法

拍长记账改用单调时钟，墙钟仍只用于「绝对时刻」类判断（重启窗口、死亡镜像节流）：

```kotlin
val mono = android.os.SystemClock.elapsedRealtime()
val tickMs = if (epoch.lastWatchdogTickAt <= 0L) 0L else mono - epoch.lastWatchdogTickAt
epoch.lastWatchdogTickAt = mono
```

`lastWatchdogTickAt` 的语义随之变为「单调毫秒」，与唤醒锁同域。

## 复验

`WatchdogMonotonicClockTest` 两条：`watchdogTick` 体内必须取 `elapsedRealtime`、`tickMs` 必须用它
计算、记账点必须写 `mono`；并反证「不得再用墙钟算拍长」。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 4 红、改后 4 绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`assessProbe` 锚点按内容重钉到新行）。
- **未做设备验证**：本机无模拟器。改系统时间的真机复验见 PR 验收卡。
