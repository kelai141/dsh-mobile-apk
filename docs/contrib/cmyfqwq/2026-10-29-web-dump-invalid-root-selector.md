# `android_web_dump` 传非法 root 选择器时误报「结果解析失败（页面可能正在跳转）」

## 现象

`android_web_dump` 的 `root` 参数是 CSS 选择器（插件侧 `a11yExec("webSnapshot", { root })` → 壳侧
`handleWebSnapshot` 把它拼进 `WEB_SNAPSHOT_JS` 的 `__ROOT__`）。壳侧脚本原来只有「无匹配」分支：

```js
var root = rootSel ? document.querySelector(rootSel) : document.body;
if (!root) return JSON.stringify({ok:false,error:"根选择器无匹配：" + rootSel});
```

`document.querySelector` 对**语法非法**的选择器（如三个左方括号）抛 `DOMException`（W3C 规定 SyntaxError），
整个 IIFE 抛错 ⇒ `evaluateJavascript` 回调拿到的 `value` 是字符串 `"null"` ⇒ `evalWebScript` 里
`json = "null"`（非空）⇒ `JSONObject("null")` 抛 ⇒ 落到 `error("WebView DOM 结果解析失败：" + message)`。

用户与模型看到的是「结果解析失败（页面可能正在跳转）」——**把「选择器语法错」误报成「页面在跳」**，
下一步会去等页面稳定后重试，而不是改选择器。这与 #777（`id` 形态用错误报成「页面已变化」）是同一类死循环引导。

## 证据（离线 stub DOM 双向对照，2026-10-29）

从 `DeviceControlService.kt` 抽出 `WEB_SNAPSHOT_JS`，用最小的 `document`（`querySelector` 对那三个方括号抛 SyntaxError）、
`window`、`location`、`innerWidth/innerHeight`、`getComputedStyle` 桩在 Node 里执行：

| `root` | 修前 | 修后 |
|---|---|---|
| `null`（整页） | `{"ok":true,…,"count":0,"nodes":[]}` | 同（不变） |
| 三个左方括号（语法非法） | **抛 SyntaxError（is not a valid selector）** ⇒ 壳侧报「结果解析失败」 | `{"ok":false,"error":"根选择器语法错误：…"}` |
| `#nope`（无匹配） | `{"ok":false,"error":"根选择器无匹配：#nope"}` | 同（不变） |

三条用例里只有「语法非法」那条行为改变，另两条逐字节相同 ⇒ 判据分离干净。

## 修法

把 `querySelector` 包进 `try/catch`，错误明确指回选择器本身：

```js
try {
  root = rootSel ? document.querySelector(rootSel) : document.body;
} catch (e) {
  return JSON.stringify({ok:false,error:"根选择器语法错误：" + rootSel + "（" + (e && e.message ? e.message : "invalid selector") + "）"});
}
```

## 未覆盖面

- **未做设备验证**：`assets/snapshot.tar.xz` 是 x86_64、真机 aarch64，`build-apk-dev-fast.mjs` 的 ABI guard 直接拒。
  替代证据＝上面的 stub DOM 双向对照 + `:app:compileDebugKotlin` BUILD SUCCESSFUL + 错误路径可指行号
  （`evalWebScript` 的 `JSONObject(json)` 失败分支）。
- 插件侧 `android_web_dump` 的 schema 仍只写 `{ type: "string" }`：Kotlin 没有 CSS 解析器，真正的语法校验只能在页面里做，也就是本次这个 catch。
- `WEB_ACTION_JS`（`webAction` 的 `sel`）里 `querySelector` 的异常处理要在下一轮单独核对，本 PR 未动。
