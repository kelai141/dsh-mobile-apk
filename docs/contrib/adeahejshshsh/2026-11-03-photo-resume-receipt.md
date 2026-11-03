# 恢复路径的拍照回执等页面就绪再投（2026-11-03，issue #1390）

## 现象

进程死亡后重启，`restoreNow()` 把在途拍照接回来。若相机结果很快返回（冷启后页面还没注入
`window.__dshBridge`），回执经 `evaluateJavascript` 打过去会落空，页面永远停在等待态，
拍照按钮不再可用。

## 真因

回执有两条投递路径，只有一条会等页面就绪：

- `Lost` 分支（原图没了/超时/越界）走 `queueReceipt` → 等 `onPageFinished` 再 flush；
- `Resume` 分支的 reply 是裸 `pushToPage`，它只判 `isFinishing`/`isDestroyed`，**不判**
  `webViewReady`。

冷启时序恰好把两条路径的差别放大：恢复发生在 `onCreate`，相机结果可能早于页面注入。

## 修法

`Resume` 的 reply 改成 `queueReceipt`，与 `Lost` 分支对齐——回执进 `deferredReceipt`，
`flushDeferredReceipt()` 在页面就绪（`MainActivity.onPageFinished`）时送出。

## 复验

`PhotoCaptureTest.恢复的在途拍照回执走延迟队列而不是裸投`：Resume 分支必须调用 `queueReceipt`、
不得再出现裸 `pushToPage(payload)`，并以 Lost 分支作对照。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 2 条红
  （第三条对照本来就绿），改后 3 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。冷启时序的真机复验见 PR 验收卡。
