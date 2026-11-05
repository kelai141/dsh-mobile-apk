# `android_ui_click` 传非法 CSS 选择器时与「没匹配到」共用一句「未找到目标元素」

## 现象

`android_web_dump` 那一侧（#805）修掉「非法 root 选择器被报成页面在跳」之后，同一文件里的
`WEB_ACTION_JS`（`webAction` 的 `sel` 通道）还有同类问题：它**已经**用 try/catch 接住了
`document.querySelector` 抛的 DOMException，但把异常吞掉、`el` 置 null，最后落到与「选择器语法对
但没匹配到」完全相同的一句：

```
未找到目标元素（ref/sel/text/role 均无匹配）
```

两种失败需要的下一步相反：

- 选择器**语法错** ⇒ 模型该改选择器（`[[[` 永远匹配不到任何东西）；
- 选择器语法对但**页面还没渲染**（或元素确实不存在）⇒ 该等一会儿、或改用 text/role。

共用一句话时，模型会按后者的策略反复重试同一条错误选择器 —— 与 #777（`id` 形态用错误报成
「页面已变化」）、#805（`root` 语法错报成「页面在跳」）是同一类死循环引导。

## 证据（离线 stub DOM 双向对照，2026-10-29）

`git show HEAD:` 取修改前的 `DeviceControlService.kt`，与工作树版本各抽一次 `WEB_ACTION_JS`，
用最小 `document`（`querySelector` 对三个左方括号抛 SyntaxError、`#ok` 返回元素、`#nope` 返回 null）、
`window.__dshWebRefs`、`getComputedStyle` 桩在 Node 执行：

| `args` | 修前 | 修后 |
|---|---|---|
| `{op:click, sel:"[[["}` | `未找到目标元素（ref/sel/text/role 均无匹配）` | `选择器语法错误（[[[：… is not a valid selector）；ref/text/role 也无匹配` |
| `{op:click, sel:"#nope"}` | `未找到目标元素（…）` | 同（不变） |
| `{op:click, sel:"#ok"}` | `{"ok":true,"via":"selector"}` | 同（不变） |
| `{op:click}`（无 sel） | `未找到目标元素（…）` | 同（不变） |

四条里只有「语法非法」那条改变，另三条逐字节相同 ⇒ 判据分离干净。兜底语义保持不变：
选择器语法错时仍会继续尝试 text / role，只有最终都没命中才报错。

## 修法

```js
var selErr = null;
if (!el && a.sel) {
  try { el = document.querySelector(a.sel); }
  catch (e) { selErr = (e && e.message) ? String(e.message) : "invalid selector"; el = null; }
}
if (!el) return JSON.stringify({ok:false, error: selErr
  ? "选择器语法错误（" + String(a.sel) + "：" + selErr + "）；ref/text/role 也无匹配"
  : "未找到目标元素（ref/sel/text/role 均无匹配）"});
```

## 未覆盖面

- **未做设备验证**：`assets/snapshot.tar.xz` 是 x86_64、真机 aarch64，`build-apk-dev-fast.mjs` 的 ABI guard 直接拒；
  替代证据＝上面的 stub DOM 双向对照 + `:app:compileDebugKotlin` BUILD SUCCESSFUL。
- `android_ui_click` / `android_ui_input` 的其它通道（`ref` / `text` / `role`）没有同类问题：它们不走
  `querySelector`，失败原因只有「没找到」一种。
