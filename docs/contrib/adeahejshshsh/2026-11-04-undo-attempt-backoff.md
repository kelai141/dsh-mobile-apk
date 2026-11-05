# EXECUTE 增加尝试退避记忆（2026-11-04，issue #1368）

## 现象

引擎死透且急救 CLI 起不来时，`boot-diag.log` 里的 `auto-undo` 触发记录每 5 秒出现一次、永不收敛：
后台唤醒与 IO 被持续占用，日志也在膨胀。

## 真因

闸门的「防循环」只认**成功**：`.undo-auto-done` 只在回滚成功后写，失败路径没有任何记忆。
于是 `decide()` 每拍看到 `lastUndoAtMs == null`、观察窗也已走完 ⇒ 每拍都返回 EXECUTE。

## 修法

- 新增 `.undo-auto-attempt`（上次**尝试**时刻，成败都写）与 `attemptAt(context)` 读取；
- `decide()` 增加 `lastAttemptAtMs` 参数与一条判据：距上次尝试 < `ATTEMPT_BACKOFF_MS`（5 分钟）→ SUPPRESS；
- EXECUTE 分支先记账再返回 true；
- 两个调用点（`onProbeFailure` / `onClientPluginTreeFailure`）都把 `attemptAt(context)` 传进去。

为什么是 5 分钟：相对 5 秒拍是 60 拍一次，既不堵死「第一次失败后引擎刚好自愈」的窗口，
也不让不可恢复的现场把 IO 打满。

## 复验

`UndoGateAttemptBackoffTest` 六条：无尝试记录放行、窗口内抑制（含边界前一毫秒）、窗口后放行、
成功退避优先、未达阈值不动作、EXECUTE 分支与两处调用点的源码契约。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 4 条红，
  改后 4 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`UndoGate.kt` 锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。不可恢复现场的真机复验见 PR 验收卡。
