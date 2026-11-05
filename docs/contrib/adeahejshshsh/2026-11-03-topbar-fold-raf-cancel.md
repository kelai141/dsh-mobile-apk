# 顶栏折叠：detach 取消已排队的 rAF（2026-11-03，issue #1411）

## 现象

顶栏折叠模块卸载（切会话 / HMR）时，若折叠动画刚好排了一帧，那一帧仍会执行 `sync()`；此时
观察者与监听器都已断开，没人再 `restore()`，折叠箭头与 `data-dsh-topbar-fold`、定位内联样式
就永久留在节点上，后续渲染错位。

## 真因

`schedule()` 只存布尔 `scheduled`，不存 `requestAnimationFrame` 返回的 id，于是 `detach()`
没有可取消的对象（全文件 `cancelAnimationFrame` 零命中）。布尔只能防重复排队，不能撤回已排的队。

## 修法

- 新增 `frameId: number | null`：`schedule()` 把 id 存下来，回调里先置 `null` 再 `sync()`；
- `detach()` 先 `cancelAnimationFrame(this.frameId)` 并复位 `scheduled`，再拆监听；
- 新增 `attached` 标志，`sync()` 首行 `if (!this.attached) return`——双保险：即便某一帧已经被
  浏览器派发、取消来不及，回调也不会再写 DOM。

## 复验

`top-bar-fold.spec.ts` 新增一例：桩掉 `requestAnimationFrame`/`cancelAnimationFrame`，attach 后
立刻 detach，断言 ① 排队中的 id 被 cancel；② 即便手动执行那帧回调，页面上也没有箭头与折叠属性。

- **vitest 用例未在本机跑**（本机没有 `dsh-client-ui-responsive/node_modules`，`vitest` 起不来），
  由 CI 执行。本机用同判据脚本：改前 4 条红，改后 5 条全绿。
- `node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。HMR/切会话的真机复验见 PR 验收卡。
