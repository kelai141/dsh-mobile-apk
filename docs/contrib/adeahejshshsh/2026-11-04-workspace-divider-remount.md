# 右栏重建前先落盘分隔条比例（2026-11-04，issue #1382）

## 现象

拖分隔条途中上游重渲染右栏：手势被打断、比例不落盘、也没有提示。

## 真因

`sync()` 发现 `panel` 变了就调 `unmount()`，而 `unmount()` 首行是 `this.onCancel()`——手势被直接
取消。旧实现只有「松手」（`onUp`）这一个出口会写 `resizeSplit`，重建这条路没有任何落盘点。

## 修法

- 把松手时的落盘逻辑抽成 `commitDivider()`（只在 `kind === 'divider' && moved` 时动作）；
- `onUp` 改为调用它（行为不变）；
- `sync()` 在 `unmount()` **之前**先 `commitDivider()`——此刻 `store` / `panel` 仍是旧的，取到的
  正是拖动中的那份比例。

## 复验

`tests/workspace-divider-remount.spec.ts` 三条：`commitDivider` 存在且只在 divider+moved 时落盘；
`sync` 的落盘点必须早于 `unmount()`；松手出口复用同一逻辑（不得再内联 `resizeSplit`）。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 4 条全红，改后 4 条全绿；括号平衡检查 BALANCED。
- `node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。重建打断的复验见 PR 验收卡。
