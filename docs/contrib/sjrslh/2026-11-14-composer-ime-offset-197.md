# composer 被键盘盖住（issue #197 机制① 的真机残留）

- 提交者：sjrslh（PR #1745）
- 记录时间：2026-11-14
- 面：L3 壳侧行为 / WebView 注入

## 现象

真机上键盘弹起后，composer 卡片停在页面底部、被键盘整个盖住。虚拟屏键条正常，主界面不正常。

## 真因（三条候选信号全部实测不可靠）

PR 在 Redmi Note 12 Turbo / Android 13 / WebView 108 上逐条量过，这是本记录最值得保留的部分：

| 信号 | 期望 | 实测 | 结论 |
|---|---|---|---|
| `window.innerHeight` | IME 弹起时变小 | 恒 873 | 无信号 |
| `visualViewport.height` | 同上 | 恒 873 | 无信号 |
| `navigator.virtualKeyboard.boundingRect.height` | 等于键盘高度 | 恒 0 | 无信号 |
| `webView.setPadding(0,0,0,ime)` | 压缩布局视口 | 不改 WebView 的 CSS 布局视口 | 无信号 |
| `--dsh-android-ime-bottom` 变量 | 页面消费 | 全仓只有 `plugins/dsh-android-vdisplay` 的键条读它 | 主界面无消费者 |

注意第四条与仓里既有注释冲突：`MainActivity` 早先的注释称 `setPadding` 会让布局视口变短，而本次实测 `innerHeight` 恒定。两者只能有一个对，本记录按实测（innerHeight 恒定），但该矛盾尚未由独立复现定案——见「已知边界」第 3 条。

## 修法

壳侧已经知道 IME 高度（`webImeBottomInset`），直接注入到 composer 卡片上，不指望页面自证。

两个方向**故意不对称**，由真机时序决定：

- **弹出**：抬多少必须由键盘高度决定，没有别的来源。所以新增 `WindowInsetsAnimationCompat.Callback`：`onStart` 拿 `bounds.upperBound.bottom` 先按**终点**推一次（否则卡片要白等一整个键盘动画），`onEnd` 补推落定终值。
- **收起**：IME inset 在收起动画期间保持旧值、动画走完才一次性归零（实测收起全程只推一条 `ime=0`），等它会让卡片慢半拍滑落。改由 `focusout` 与 `pointerdown`（点在卡片外）立即触发回落。

位移用 rect 对齐而非固定像素：`d = r.bottom - (innerHeight - v)`，`d<=0` 不动。卡片自带的下边距与它下面那条状态栏的高度都要算进去，固定位移会留出悬空缝隙。

注入脚本是**常驻**的：第一次执行安装监听器并把 API 挂到 `window.__dshComposerIme`，之后只调 `set(kb)`，焦点监听不会被重复注册，页面重载后也能自动重建。

## 复验证据

- 代码层：`ComposerImeOffsetTest.kt`。注意：现有 12 条断言里大半是脚本字符串存在性检查，对脚本恒真、判别力弱；真正的判别力来自 `MainActivity` 的三处接线（`pushWebInsets` 合成一次 IPC、`pushComposerImePx` 逐帧去重推送、`onStart`/`onEnd` 两端推送）。
- CDP 层：未做。
- ADB 用户层：单机竖屏一次；**横屏 16384 未做**，而 1600x900 横屏 + 键盘占掉大半高度是最容易顶到 `d<=0` 的形态。
- 证据落盘：PR 内为叙述，没有 `.deploy-tmp/<round>/ui-NN-*.png`。

## 已知边界（下一个排查者先读这里）

1. **元素重建丢 transform**：切换会话/切换模式导致 unmount+remount 时 inline style 丢失；若键盘仍弹起，卡片会落回原位，需要收起-弹起自愈。这是已知缺口，不是新缺陷。
2. **抑制窗口的代价**：`collapse()` 置 `suppressed=true` 后，要等一次 `v<=0` 的推送才复位。若系统取消动画而 `onEnd` 不触发，理论上可能长时间抑制——现由 `pushWebInsets` 每次照推（同值去重）兜住，但没有取消动画的实测。
3. **`setPadding` 是否改布局视口**：仓里既有注释与本次实测矛盾（见上表第 4 行），未定案。
4. **`DOCK_SELECTOR`（`[data-composer-dock]`）**：源码注释叫它「退化选择器」，但没有证据说明主界面里它是否存在。若不存在是死代码；若存在需确认「卡片恒在 dock 之下」，否则 `d>0` 会按容器算而不是按卡片算。
