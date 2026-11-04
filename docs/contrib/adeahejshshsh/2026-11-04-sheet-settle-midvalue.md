# 起手基准高度改用内联值（2026-11-04，issue #1381）

## 现象

快速连点两次把手（第一次触发展开/收起吸附），在吸附动画进行中立刻按下并拖动：起始高度与当前
视觉高度不一致，peek / expanded 判定可能反掉。

## 真因

`onSheetTouchStart` 用 `currentHeight()` 当拖拽起点，而它**优先读 `getBoundingClientRect()`**——
吸附过渡期间 rect 还在动，读到的是动画中间值。同一文件里的 `publishGeometry` 早已用「内联值优先」
规避了这个问题，起手处没有跟进。

## 修法

新增 `settledHeight()`：优先 `panel.style.height`（我们写下去的值），没有才退回 `currentHeight()`；
`onSheetTouchStart` 改用它。取数口径与 `publishGeometry` 一致。

## 复验

`tests/composer-sheet-settle-midvalue.spec.ts` 两条：`settledHeight` 必须存在且内联值判定先于
`currentHeight()`；touchstart 必须用它且不得再出现 `this.currentHeight()`。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 4 条全红，改后 4 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。连点复验见 PR 验收卡。
