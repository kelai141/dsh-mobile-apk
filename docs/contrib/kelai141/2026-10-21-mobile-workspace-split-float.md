# 移动端分栏与小窗：五个现场缺陷的真因与修法（2026-10-21）

来源：用户真机录屏 + 0.14.9 测试清单第五组。全部在 MuMu 1080x2400（竖屏）与 1600x900（横屏）上用 CDP 断言 + ADB 真操作复验。

## 1. 文件、文本等标签不能分栏/小窗

现象：对话与终端可用，文件管理器里选中的文件标签点「分栏」「小窗」无效。

真因：`TAB_CAPABILITIES` 能力表只登记了 conversation / terminal / browser 等少数标签，`files`、`text`、`plan`、`changes-review` 等一律按 `NONE` 处理，选择器里对应条目被禁用。

修法：能力表补齐实际可用的标签（files/text/plan/changes-review/scheduleTask/open-with/subagentchat/android-browser），只在 `android-vdisplay` 保留 `NONE`。

## 2. 竖屏仍是左右分栏

现象：竖屏 1080x2400 下分栏左右排，每栏都窄到不可用。

真因：方向判定读的是 `window.innerWidth > window.innerHeight` 之外的自定义阈值/侧栏状态，没有按视口实际宽高判断。

修法：`portraitWorkspace()` 改为比较 `document.documentElement.clientWidth` 与 `clientHeight`，竖屏走 `vertical`（上下）轨道，横屏走 `horizontal`（左右）轨道。

## 3. 浮窗越过顶栏、跟页面滚动、拖标题栏带着右栏一起动

现象：

- 浮窗初始位置与拖动都能跑到顶栏下面，顶部被遮住后无法再摸到；
- 页面滚动时浮窗跟着动；
- 按住浮窗标题栏上下拖，右侧栏抽屉跟着关/开。

真因：

- 没有边界概念：`floatTab/moveFloat/resizeFloat` 直接使用任意坐标；右栏面板的上边界（面板标题栏下沿）从未参与计算。
- 移动端形态给所有容器预置了 `touch-action: pan-y pinch-zoom`，纵向拖动首先被 Blink 当成滚动，pointer 序列被取消，于是拖动要么无效、要么落到滚动容器上。
- 侧栏手势的 `INTERACTIVE` 选择器没有包含 `[data-dockkit-float]`，浮窗上的横向/纵向拖动被当成抽屉手势。

修法：

- 新增 `FloatBounds` + `clampFloatRect`（最小尺寸、间距 8px），并就地包装 `store.actions.floatTab/moveFloat/resizeFloat`；上边界取面板 rect 与 `.dsh-bubble-header` 下沿的较大者（fallback 52px），同步写 `--dsh-dockkit-float-top`。
- 浮窗 grip 与 resize 手柄加 `touch-action: none !important`。
- `INTERACTIVE` 选择器加入 `[data-dockkit-float]`。

## 4. 右下角缩放柄摸不到

现象：能看到角落手柄，但触摸命中对话输入区。

真因：resize 手柄 20x20 且 z-index 默认，DOM 顺序靠后的 composer 盖在上层；`elementFromPoint` 实测命中 composer。

修法：手柄 44x44、`z-index: 5 !important`；grip 及相关按钮最小 44px。CDP 复验 `elementFromPoint` 命中 resize 并成功缩放到 220x140。

## 5. 从分栏退回单屏后内容半高、两个标签上下叠

现象：关闭一个标签或退出分栏后，剩余内容只占半屏，另一个标签的正文叠在下面；切回其它标签也不恢复。

真因：分栏时把 `grid-template-columns/rows` 和 cell 的 `gridRow/gridColumn` 写成了**内联 style**。退出分栏后 React 收起分栏结构，但内联网格轨道仍留在 DOM 上，单 pane 被排进第 3 行，于是半高并出现两个 body 重叠。

修法：内联网格改为写 CSS 自定义属性（`--dsh-workspace-columns/rows`），单元格只写 `data-dsh-workspace-slot`；CSS 用属性选择器给轨道与 slot 定位。退出分栏时清除 slot 属性与自定义属性，轨道回落到默认 `minmax(0, 1fr)`。

## 复验证据

- 代码层：`mobile-workspaces.spec.ts` 25 例（含新增「文件标签可分栏再浮窗」「退出分栏清 slot」）；typecheck 通过。
- CDP 层：竖/横屏各切换一次，断言 pane 全高 0..915、slot 属性清空、浮窗 rect 位于面板内且标题栏下沿之上。
- ADB 层：真实 tap 分栏/小窗/拖动/缩放，`input swipe` 拖标题栏不触发右栏关闭，左抽屉打开时浮窗不可见。
