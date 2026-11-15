# 左抽屉：点会话行三个点误收起、侧滑收不起来（2026-11-15）

来源：用户实机反馈两条缺陷 ——
（A）点会话行右侧「三个点」想开会话菜单，左抽屉却被收起；
（B）左抽屉展开后向左滑收不起来（右键滑开、右栏开合都正常，只有"收起左抽屉"这一条路径坏）。

全部在模拟器 127.0.0.1:16480（900x1600 @240dpi，页面 CSS 600x1067，手机形态）上用 CDP 读状态语义 + ADB `input tap/swipe` 真操作 + `exec-out screencap -p` 截图复验。

## 1. 点会话行三个点会收起抽屉

现象：抽屉展开、点某条会话行的「⋯」，抽屉收起，菜单也没弹出来。

真因：
- `PanelNavDrawer.attachNavDismiss` 的点击判据只排除 `[aria-expanded]`（把"展开器"当非导航），把它当导航项处理。
- 上游会话行的「三个点」实际只有 `data-context-menu-trigger`：真机实测片段
  `<button type="button" data-context-menu-trigger="" aria-label="会话"…"的操作">` ——
  **既没有 aria-haspopup，也没有 aria-expanded**。工作区行的「…」才有 `aria-haspopup=menu`。
- 于是「打开弹出层」被当成「切换到某个面板」。`dismiss()` 在 260ms 后（等抽屉过渡跑完）在
  `[data-sidebar-mask]` 上合成 `mousedown`/`click`，遮罩的 `onClick` 调 `toggleSidebar()` ⇒ 收起。
  用 CDP 抓到的合成事件栈正好落在 `div[data-sidebar-mask]` 上。

修法：判据补上"弹出层入口"这一族属性 —— `POPUP_TRIGGER_SELECTOR = '[aria-haspopup], [data-context-menu-trigger], [data-trigger-menu]'`，
命中即 return。**没有**用 `stopPropagation` 挡事件：那只会挡住我们自己的监听，而真正收起抽屉的是
我们合成的遮罩点击，绕不过去；正确做法是根本不要把它判成导航。

## 2. 展开状态下侧滑收不起左抽屉

现象：抽屉收起时从屏左边缘右滑能开；展开后从抽屉内左滑没有任何反应。右栏开合两个方向都正常。

真因：**上游左抽屉自己就是模态根节点**。展开态实测
`document.querySelectorAll('[role="dialog"][aria-modal="true"]')` 恰好返回它一个：
`hHd-Xa_root hHd-Xa_quietBars`、`data-shortcut-modal="sidebar"`、rect (0,24,280,1043)，收起后消失。

旧守卫写的是 `[role="dialog"][aria-modal="true"]:not([data-dsh-settings-dialog])`，
于是**抽屉开着的时候守卫恒命中**，`touchstart` 直接 return，手势永远认领不到。

这条真因把全部对照事实一次解释完：开方向正常是因为那一刻抽屉是收起的（页面上没有这个对话框）；
右栏正常是因为右栏根节点不是 dialog，且左抽屉收着。

修法：判据改成"属于侧栏自己的对话框不算挡住页面的模态面" ——
`PANEL_ROOT_SELECTOR = '.sidebarCol, [class*="sidebarCol"], [data-sidebar-right-panel]'`，
dialog 自身落在该子树内、或**包含**该子树的，一律跳过。没有按 `data-shortcut-modal` 单点排除：
上游随时可能改这个属性名，而"是不是侧栏自己的子树"是结构事实，稳定得多。

## 3. 顺带修的验收探针坑（不是产品缺陷，但会让判据假红/假绿）

- **合成点击落点**：抽屉有 200ms 收合过渡，动画中途量出来的按钮矩形会让 `input tap` 落到遮罩上，
  遮罩点击本来就收起抽屉 ⇒ A 判据假红。验收脚本改为"取点后用 `elementFromPoint` 验证命中的是这颗按钮"
  再点，最多重试 6 次。
- **极矮视口无法起手**：横屏高密度下页面 CSS 只有 610x343，抽屉里几乎整列都是行内操作按钮，
  而手势源按设计不认领落在控件上的 `touchstart`。脚本改为逐候选实测，落点干净却仍不生效才判红；
  连干净落点都找不到时判 `INCONCLUSIVE`（exit 2），**不当通过**。
- **页面未就绪**：应用刚重启时 `[data-dsh-frame]` 还没挂出，读属性会抛 null 引用。
  脚本先等 frame 出现（最多 60s），等不到判前置缺失（exit 2），不混进判据失败。

## 复验证据

代码层（`dsh-client-ui-responsive`，vitest）：

- 修前红 A：`× 上游「三个点」只带 data-context-menu-trigger：不得收起抽屉（缺陷形态）` ——
  `expected "spy" to not be called at all, but actually been called 1 times`；同组反证用例同红。
  `Tests 2 failed | 10 passed (12)`
- 修前红 B：`× 抽屉根自身就是 aria-modal 对话框：侧滑仍必须能收起它（缺陷形态）` ——
  `expected "spy" to be called once, but got 0 times`。`Tests 2 failed | 71 passed (73)`
- 修后绿：两个 spec 分别 `12 passed` / `73 passed`；包内全量 `1407 passed | 6 failed (1413)`，
  那 6 条是 `tests/custom-provider-form-960.spec.tsx` 的存量红（origin/main 同样红，与本次无关）。

CDP + ADB 层（`node scripts/verify-sidebar-drawer.mjs --serial 127.0.0.1:16480`）：

- 竖屏修后绿：
  - `PASS 点会话行三个点不收起抽屉 :: collapsed false→false，menus 0→1，at (254,316)`
  - `PASS 侧滑收起左抽屉 :: collapsed false→true，from 240 to 60，y=376`
  - `结果：2 项，PASS 2，FAIL 0，INCONCLUSIVE 0`，exit 0
- 受控负控（把两个实现退回缺陷形态、重构建 + 热推后同一脚本）：
  - `FAIL 点会话行三个点不收起抽屉 … true !== false`
  - `FAIL 侧滑收起左抽屉 :: 起手位置干净（DIV.bhn1Oq_list，y=376）且 touchstart 已到页面，但抽屉没有收起`
  - exit 1 —— 证明脚本确实能判红，不是恒绿。
- 截图：`.deploy-tmp/sidebar-drawer-127-0-0-1-16480/ui-01-10-ellipsis-menu.png`（抽屉张开 + 会话菜单弹出）、
  `ui-02-20-swipe-closed.png`（侧滑后收起）。

横屏覆盖：本机 16480 用 `wm size 1600x900` + `wm density 420` 造出手机形态横屏
（CSS 610x343）。此时 A 判据仍 PASS；B 判据因"抽屉内找不到一条起手点不压控件的走廊"判
`INCONCLUSIVE`（exit 2）—— 该视口下验不到收起方向本身，不当通过。真 1600x900 横屏设备
（16384）上页面按 767 阈值正确切到桌面形态，手机形态抽屉契约不适用。
