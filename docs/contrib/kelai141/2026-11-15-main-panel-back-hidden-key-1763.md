# 插件主列表页系统返回无效：关闭路径点的是一个被画成 display:none 的注入键

## 现象

手机形态下用侧边栏「插件」进入插件管理页后，按系统返回键页面不动，页面上也没有可见的返回入口（#1763）。

## 真因（issue 给的根因不成立）

issue 写的是「`ctx.layout.panelInfo.activePanelId` 为 null ⇒ `detectMainPanel()` 返回 null ⇒ back-stack 认不到层」。设备实测推翻：

- `window.__dshBackKinds === ['drawer','dialog','main-panel']`：main-panel 层**在**；
- `dshBackBridge.getBackAvailable() === true`，`logcat -s dsh-back` 记到 `DISPATCH_PAGE_STACK`：信号与派发都正常；
- 但 `window.__dshBack()` 返回 `true` 之后页面**照样停在原地**，`kinds` 仍是 `['main-panel']`。

真因在 `closeMainPanel()` 的列表根分支：它先点本插件注入的 `[data-dsh-main-panel-back]`，点不到才 fall-through 到 `leave()`。而这个键**永远点不动**，于是它总是 `return true`、界面毫无变化：

1. 2026-11-14「只留标题」那一轮把它的样式定成 `display: none !important`（`main-panel-back.css.ts`），没有布局盒 —— 实测 `rect 0x0`；
2. 本包的 `ActivationGuard`（#1317 的既有纪律：未呈现控件的激活必须吞掉）因此拦下对它的点击 —— 实测 `dispatchEvent(new MouseEvent('click')) === false`、**document 捕获监听一次都没触发**、节点带 `data-dsh-activation-inert`。

两层都是**各自正确**的既有改动，叠在一起才成了死路：样式表为了视觉去掉它的脸，守卫为了纪律挡掉它的激活，而 back-stack 还把它当唯一关闭路径。

## 修法

`dsh-client-ui-responsive/src/client/mobile/back-stack.ts`：列表根直接走它自己的语义动作 `leave()`（= `ctx.layout.selectPanel(null)`），与详情层走页面自己的 crumb 对齐；注入键保留挂载（后续轮次若重新画出它，其 click 处理仍可用，C 组用例仍覆盖），但不再是 closure 路径。

## 判据为什么必须带 ActivationGuard

第一版判据写成「把注入键设成 `display:none`，点它，assert `leave` 被调用」——**它恒绿**（29 passed，设备上毫无反应）。原因：jsdom 不做布局，`display: none` 在它里面不拦合成 click，按钮照常收事件。

正确写法是把设备上真正的拦截者 `ActivationGuard` 挂进链路（注入一个只认内联 `display` 的 `styleOf`），并**先断言这条路径真的点不动**（`dispatchEvent` 返回 false、节点带 `INERT_ATTR`），再断言 `leave` 被调用。这样「点不动」在单测里成立，判据才是设备事实的代理。

**可复用的教训**：凡判据涉及「按了没反应」，先确认 jsdom 里那个「没反应」的机制是否真的在跑；布局类拦截（display/visibility/opacity/pointer-events）在 jsdom 全部失效，必须把产生拦截的那个模块也挂上，否则得到的是恒绿。

## 复验证据

- **代码层**：`npx vitest run tests/main-panel-back.spec.ts` 修前 `3 failed | 28 passed`，修后 `31 passed`。三条修前红分别是：注入键被吞时 `leave` 未被调用、一次返回只写一次面板选择、以及「`closeMainPanel` 不得再引用 `PANEL_BACK_SELECTOR`」的判据面断言。全量 `npx vitest run` 为 `95 passed | 1 failed`，失败项 `custom-provider-form-960.spec.tsx`（6 条）经负控确认是既有失败：把本改动两个文件还原成 HEAD 后单跑该 spec 同样 `6 failed`。
- **CDP 层**：`scripts/verify-*.mjs` 无覆盖主面板 back 层的现成脚本；用 CDP 探针读 `__dshBackKinds` / `__dshBackDepth` / `getBackAvailable()` 取证。
- **ADB 用户层**（真 tap）：竖屏 16480（900x1600）与横屏 16416（1600x900）各走一遍「开抽屉 -> 点插件 -> `input keyevent 4` -> `screencap -p`」，修后两个方向都回到会话，`kinds` 由 `['main-panel']` 变 `[]`。
- **证据口径**：设备装的是 0.14.11 旧 APK，承载不了新代码，故用 `hot-push.mjs` 推进快照树后验收（`HOT-PUSH OK（231 文件 × 2 profile）`）。**这是热推证据，最终 APK 需补验。**