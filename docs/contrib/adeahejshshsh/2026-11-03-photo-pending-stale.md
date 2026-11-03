# 恢复的在途拍照会过期（2026-11-03，issue #1389）

## 现象

拍照过程中进程被杀，重启后 `restoreNow()` 把在途记录接回来。若相机结果始终不回（相机进程
同死、ROM 丢结果），`pending` 永不为 null——此后每次拍照都回 `CODE_BUSY`，进程存活期内拍照
功能永久不可用，只能重启应用。

## 真因

15 分钟窗口（`PENDING_STALE_MS`）只在 `classifyPending` 里算**一次**，而那是恢复那一刻的
判断；之后没有任何定时器或入口复核。`capture()` 的守卫是裸 `if (pending != null) BUSY`——
它不知道这条记录已经放了多久。

## 修法

- `Pending` 增加 `startedAt`；`PendingRecovery.Resume` 增加 `startedAt`，由
  `classifyPending` 透传 `record.startedAt`（恢复后的记录拿得到真实年龄）。
- 抽出纯函数 `PhotoCapture.isPendingStale(startedAt, now, staleAfterMs = PENDING_STALE_MS)`。
- `capture()` 入口每次重算：未过期 → 照旧 `BUSY`；已过期 → 清 `pending`、清在途状态文件、
  删原图、给旧的那次调用回一条结构化 `camera-failed("pending-stale")`，**然后照常发起这一次
  拍照**（用户不必再点一次）。

## 复验

- `PhotoCaptureTest.在途记录超过窗口即判过期`：边界（刚好 15 分钟不算过期、多 1ms 即过期）。
- `PhotoCaptureTest.恢复的条目必须带出落盘时刻`：`Resume` 携带 `startedAt`、`classifyPending` 透传。
- `PhotoCaptureTest.拍照入口把过期的在途记录清掉并如实回失败`：入口重算、删原图、回
  `pending-stale`（源码契约）。
- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本（契约部分）：
  改前 5 条全红，改后 5 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。强杀进程 + 相机不回的真机复验见 PR 验收卡。
