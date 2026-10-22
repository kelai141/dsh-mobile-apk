# 右栏顶栏：手势不跟手与全屏按钮空转（2026-10-22）

来源：用户实机反馈「手势滑动右侧边栏时顶栏不跟内容区实时移动，等内容区开始收起之后才瞬移过去关闭」；点测分栏时又发现顶栏「全屏」按钮无反应。全部在模拟器 127.0.0.1:16544（1080x2400 @420dpi，CSS 412x915）用 CDP 帧级采样 + ADB 真手势复验。

## 1. 拖动时顶栏不跟手，松手后瞬移消失

现象：右滑关闭右栏，内容区逐帧跟随手指，顶栏（`.dsh-bubble-header`）钉在原地；松手提交后内容滑出，顶栏瞬间消失。

真因：

- 跟手预览（`sidebar-drag-preview.ts` 的 `RIGHT_SLIDE_SELECTOR`）只覆盖 dockkit 子元素 `[data-dockkit-host='dock' / empty / divider]`；气泡头是 `sidebar-bubbles.ts` 直接 append 到面板根节点的，不在名单里。
- 气泡层只在面板「打开」时挂载，且收起态规则是 `display: none`：提交关闭的同一帧节点即被移除，CSS 过渡无从播放。
- 位移用百分比 `translateX(x%)`，参照各元素自身宽度：split 下窗格只有面板一半宽，顶栏又与窗格不同宽，同一帧里各元素位移会不一致。

修法：

- 气泡头与弹层/遮罩（面板直属的 `[data-dsh-bubble-nav]`）纳入跟手落点；右栏位移按面板宽度换算像素，所有落点同一 transform。
- 收起态从 `display: none` 改为与 dock 子元素同源的 `translateX(var(--dsh-sidebar-width))` + visibility 延迟隐藏；拖动态过渡由 `data-dsh-drawer-dragging` 规则关掉（选择器与落点逐字对齐）。
- 气泡层挂载生命周期改跟随面板节点（收起不卸载），交互入口仍由 `data-sidebar-right-open` 把关。

## 2. 顶栏「全屏 / 退出全屏」点击无反应

现象：横屏停靠列（300px）点「全屏」没有任何变化；分栏因此一直报「可用空间不足」。

真因：上游 `toggleFullscreen` 用 `document.activeElement` 解析命令目标；气泡层代理按钮挂在面板内（`[data-sidebar-right-session]` 之下），上游把「面板内但不在窗格里」的元素判成过期侧栏标记，命令目标返回 `undefined`，代理的 `original.click()` 永远空转。

修法：代理按钮直调 `sidebarRight.toggleFullscreen(sidebarRight.commandTarget(null))`（`null` 让上游取挂载会话的活动停靠窗格）；未提供直调通道时保留 `original.click()` 回退。

## 3. 右栏标签栏无法直接新建标签（2026-10-22 追加）

现象：移动端弹层里只有标签列表与分栏/小窗，没有新建入口；只能回到开始页再点卡片开标签。

真因：`SidebarBubbles.syncControls` 在带工作区（`workspaces`）时只代理 `[data-sidebar-right-mode]` 与 `[data-sidebar-right-toggle]` 两个窗格按钮；上游的「新建标签」按钮（`[data-dockkit-add-tab]`）在原生条带里，而条带被气泡层隐藏（`visibility:hidden`），于是整个移动端没有入口。

修法：代理名单加入 `[data-dockkit-add-tab]`，弹层动作行出现「新标签页」，点击走原按钮的 `intents.addTab(paneId)`（不依赖 activeElement），在当前窗格打开开始页。

## 4. 分屏中轴线不可见（2026-10-22 追加）

现象：中轴线可拖动调整上下高度，但屏幕上是一条透明的线。

真因：样式里有 `::before` 标线，但只有 2px、颜色用 `--dsw-alias-border-l2`（深色主题下近乎背景色）；更关键的是**上游对这条伪元素另有显式宽度规则**，我们只写 `left/right` 想拉长，实测 computed width 只有 0.5px，线等于不存在。

修法：显式写 `width/height`（竖屏 48x4px、横屏 4x48px），颜色改 `--dsw-alias-label-tertiary`，拖动/聚焦时高亮为 `--dsw-alias-label-primary`。

## 5. 拖动白条换位没有动画演示（2026-10-22 追加）

现象：拖动窗格左上角小白条到另一窗格可以交换两个窗格，但拖动过程无反馈、松手瞬间对调。

真因：换位只切换本地 `swapped` 集合并重排 grid，既没有拖动中的视觉反馈，也没有过渡；松手判定的目标还用 `elementFromPoint`，白条一旦跟手会盖住指针，命中会退化。

修法：
- 拖动中白条随手指 `translate`，指针所在窗格加 `data-dsh-workspace-swap-target`（蓝色虚线）；目标判定改为按窗格矩形包含关系（`paneAt`），不再依赖命中测试。
- 松手后 FLIP：先量两窗格旧位置，刷新到新排布后用 Web Animations 从旧偏移量滑回零（220ms，`prefers-reduced-motion` 下跳过）。

## 复验证据

- 代码层：typecheck 通过；插件全量单测通过（新增：气泡头挂载生命周期、全屏代理直调/回退、跟手落点行为、落点契约含气泡头、工作区下「新标签页」代理、中轴线样式断言、白条拖动高亮与槽位对调）。
- CDP 层：拖动三次采样顶栏与内容区 `translateX` 逐帧相同（60.03 / 120.06 / 180.08px）；提交关闭顶栏从 270px 滑到 412px 才隐藏（节点保持挂载）；重新打开从 186px 滑回 0；分栏态拖动两窗格与顶栏同值。中轴线 `::before` 实测 48x4px；白条拖动中 `translate(184px,580px)` 且目标窗格带 `data-dsh-workspace-swap-target`，松手后槽位 `pane43 0→1 / pane40 1→0`。
- ADB 层：弹层「分栏」在文件标签生效（竖屏上下各 424px；横屏全屏左右各 448px）；「小窗」浮窗上拖钳在顶栏下 y=56、右下角缩放到 285x351、横屏后重新钳入面板；横屏点全屏后进入 fullscreen，分栏恢复可用；点「新标签页」在当前窗格打开开始页。
- 证据截图目录：`.deploy-tmp/sidebar-gesture-verify/`。
