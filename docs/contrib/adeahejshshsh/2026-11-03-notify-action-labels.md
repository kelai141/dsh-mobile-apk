# 通知动作按钮标题跟语言走（2026-11-03，issue #1408）

## 现象

提问/审批通知的四个动作标题硬编码中文——「打开应用作答」「批准一次」「拒绝」「重试」。
英文系统下它们仍是中文，而同一条通知的 `RemoteInput` 回复标签（#1011 ②）已经双语，于是
一条通知里中英混排。

## 真因

`NotificationCompat.Action.Builder` 的标题参数是普通 `String`，写死中文不会有任何编译期或
运行期提示；#1011 那次只把 `RemoteInput` 的 label 接进了 `UiText`，四个 Action 标题漏了。
`UiText` 的用法是**同一处写两份**（`UiText.t(app, zh, en)`），没有「漏翻」的强制点。

## 修法

四处改成 `UiText.t(app, "中文", "English")`，英文取仓里既有口径以保持一致：

| 中文 | 英文 | 依据 |
|---|---|---|
| 打开应用作答 | Open app to answer | 新文案（仓里无既有对应） |
| 批准一次 | Allow once | `OverlayPanel` 的审批芯片同口径 |
| 拒绝 | Reject | `OverlayPanel` 的拒绝芯片同口径 |
| 重试 | Retry | 新文案（仓里无既有对应） |

## 复验

`NotifyActionLabelsTest` 两条用例：① 四个标题必须是以 `UiText.t(app, 中文, English)` 形式出现的调用；
② 不得留下裸中文标题（旧形态逐条钉住）。判据选「是不是双语调用」而不是「有没有英文」——
后者在文案改写时容易误判。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 8 条全红，
  改后 8 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器、装不了包。英文系统下的肉眼判读见 PR 验收卡。
