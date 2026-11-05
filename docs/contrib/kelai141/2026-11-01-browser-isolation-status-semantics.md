# 浏览器可用但报「身份档不可用」：状态语义把两个事实混成一个

日期：2026-11-01
范围：BrowserHost 状态/回执语义与侧栏浏览器提示（不改隔离实现、不改 Profile 分配）

## 现象

Android 16 真机反馈：浏览器能打开网站、能转屏，侧栏却显示 `browser profile not ready` /
「浏览器身份档不可用」。用户看到的是「浏览器坏了」，实际页面仍在工作。

## 真因

壳侧把「浏览器能不能用」和「身份隔离在不在」压成了同一个 `available`/isolationAvailable：

- `BrowserHost.status()` 的 `ok/available` 直接取 `isolationAvailable`；
- `nativeReply()` 同样用 `tierOk && profileError.isEmpty()` 作为 `available`；
- 客户端 `BrowserTab` 在 `available === true && profileAvailable === false` 时显示
  `native.profile.unavailable`（「浏览器身份档不可用」）；
- `NativeBrowserFrame` 又把 `profileAvailable === false` 写成 frame error，并让 presentation
  的 `ready` 依赖 `profileAvailable`。

因此 `browser-profile-not-ready`（只是没拿到隔离 profile，走单一身份档回退）被当成了
浏览器故障：状态是 error、面板文案是「不可用」、原生页甚至不进入 ready。

## 修法

1. 纯函数 `BrowserStatusSemantics.derive` 分开产出：
   - `browserAvailable`：浏览器本体是否可用；
   - `isolationAvailable`：隔离档位是否存在且无 profile 错误；
   - `profileEstablished`：隔离 profile/renderer 是否真的已 attach；
   - `profileReason`：保留原始原因码（诊断用）；
   - `reason`：只有浏览器本体故障才非空；
   - `level`：`ok` / `notice` / `error`。
2. `status()`、`caps()`、`nativeReply()`、`tabSummaries()` 共用这一份派生，不再各算一套；
   `available`/`ok` 改为 `browserAvailable`，新字段 `browserAvailable`、
   `isolationAvailable`、`statusLevel` 上报。
3. 只有 `webview-provider-unavailable`、`browser-renderer-unavailable`，或
   `browser-profile-unsupported` 且既无 view 也无任何可建表面时，才保持 ERROR。
4. 客户端按 `isolationAvailable === false` 显示提示，不再按 `profileAvailable` 报错；
   文案改为可读形态（中英各一条，不拼接原因码）。frame error 与 presentation ready 不再
   依赖隔离 profile。

## 复验

- Kotlin 纯函数用例：隔离不可用 + 可建/已建 view => `NOTICE`、`browserAvailable=true`、
  `reason=""`；隔离可用但 profile 尚未建立 => `OK` 不显示提示；无降级 + unsupported =>
  `ERROR`。
- 客户端用例：`isolationAvailable=false` + `available=true` 显示提示且不显示错误；
  `isolationAvailable=true` 时不显示提示；`available=false` 才显示错误。
- 负控 1：把 `browserAvailable` 改回 `!isolationAvailable ? false : ...` => 提示态用例红。
- 负控 2：把 `level` 改成隔离可用时也 `NOTICE` => 「隔离可用不提示」用例红。

隔离实现与 Profile 分配未改；本 PR 只改语义层与文案。
