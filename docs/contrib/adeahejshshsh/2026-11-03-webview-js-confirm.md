# WebView 补上 onJsConfirm（2026-11-03，issue #1383）

## 现象

快照面板的三个破坏性动作——「恢复该版本」「删除快照」「切换安全模式」——点下去没有任何反应：
没有对话框、没有 toast、也不发请求。同页的 `alert()` 提示却正常显示。

## 真因

三个动作都靠 `window.confirm()` 二次确认（`vendor/dsh-undo-savepoint/lib/client.js:581/592/596`），
而壳侧只实现了 `onJsAlert`，没有实现 `onJsConfirm`。Android 的 `WebChromeClient` 默认实现直接
`result.cancel()`，于是 `confirm()` **恒为 false**，页面在 `if (!window.confirm(...)) return;`
那一行静默返回。

「alert 有实现、confirm 没有」正是它长期没被发现的原因：同一面板里别的提示都正常，看起来不像是
WebView 的问题。隔离浏览器（`BrowserHost`）的 `WebChromeClient` 连 `onJsAlert` 都没有，同一缺口。

## 修法

两处宿主各补一个 `onJsConfirm`：弹平台 `AlertDialog`（与仓里既有对话框同款 `android.app.AlertDialog.Builder`），
按钮文案用系统资源 `android.R.string.ok/cancel`（跟随系统语言，不引入新字符串，也就没有双语缺口）。

关键细节是**恰好回一次**：按钮、返回键、对话框被系统关掉都算终态，`settle()` 用局部 `settled` 闸门
去重。漏回会让页面的 JS 永久挂在该 `confirm` 上（移动 WebView 没有用户可关的原生 UI 兜底）。
另外两处都先判 `isFinishing`/`isDestroyed`（隔离浏览器还要判 `tab.view !== view`），
宿主已死时直接 `cancel()`，不弹一个挂不住的对话框。

## 复验

- 契约用例 `W3ShellContractTest.jsConfirmAnsweredInBothHosts`：两处宿主都必须有 `onJsConfirm`，
  且函数体内既有 `result.confirm()` 也有 `result.cancel()`（撤掉任一宿主即红）。
- **Kotlin 单测未在本机跑**：本机没有 Android SDK/Gradle，由 CI 执行。本机用同判据脚本对源码求值：
  改前 6 条全红，改后 6 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`MainActivity.kt` 的桥安装点锚点 1564 → 1593 手钉）。
- **未做设备验证**：本机无模拟器、装不了包。真人判读（点三个按钮各弹一次对话框）见 PR 验收卡。
