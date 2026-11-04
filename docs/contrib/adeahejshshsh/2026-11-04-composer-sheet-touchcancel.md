# sheet 手势被系统取消时不再关面板（2026-11-04，issue #1378）

## 现象

来电、通知下拉、浏览器接管滚动导致的手势取消，会被按「用户松手」处理：只要回弹量超过阈值就直接
`close()`——用户什么都没做，输入行 sheet 却被关掉。

## 真因

`touchcancel` 与 `touchend` 绑到**同一个处理器**，而处理器不接收 event、无法区分「用户松手」与
「系统取消」。取消路径于是复用了提交路径的「超过阈值就关」判据。

## 修法

- `touchcancel` 改绑独立的 `onSheetTouchCancel`；
- 该处理器只做「吸附回原位」：保留与松手相同的落点判定（peek / expanded），**去掉关闭分支**，
  也不读速度（取消不是一次有意的甩动）。

## 复验

`tests/composer-sheet-touchcancel.spec.ts` 两条：两个事件必须绑到不同处理器（含 `removeEventListener`
对称）；取消处理器必须只 `settleTo(` 且**不得**出现 `this.close()`。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 4 条红，改后 5 条全绿。
- `node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。真机复验见 PR 验收卡。
