# @ 菜单「添加 N 项」补 in-flight 守卫（2026-11-04，issue #1404）

## 现象

勾选若干项后快速双击「添加 N 项」，同一文件/会话会被插进输入框两次，底部计数在两次循环之间来回跳。

## 真因

插入是异步的（每项最长 1500+600ms 的 settle-pick），而按钮在这整段期间保持可点。第二次点按
立刻进入第二个 `addSelected()`，两个循环各自对同一批 key 调 `pickByKey`。

## 修法

- 新增 `busy` 字段；`onMenuClick` 在起循环**之前**挡住第二次点按；
- `addSelected()` 拆成「守卫 + 在途置位 + `try/finally` + 插入主体 `insertChecked()`」；
- 新增 `syncBusy()`：在途时把按钮置 `disabled` + `aria-busy="true"`，结束复位。

## 复验

`tests/reference-menu-inflight.spec.ts` 两条：点击处理必须有守卫且守卫在调用之前；插入必须包在
`try/finally` 里并同步按钮态（读源码文本，不驱动完整 settle-pick 流程）。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 5 条全红，改后 5 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（`reference-menu.ts` 锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。真机复验见 PR 验收卡。
