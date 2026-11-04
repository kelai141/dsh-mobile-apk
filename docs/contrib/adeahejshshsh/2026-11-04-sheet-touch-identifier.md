# 底部 sheet 手势跟踪 touch identifier（2026-11-04，issue #1379）

## 现象

两指先后落在 sheet 上拖动，抬起其中一根，再继续拖另一根：卡片高度跳变或停止跟手。

## 真因

手势不跟踪 touch identifier：start / move 都取 `touches[0]`，end 也不判「起手那根是否还在按着」。

- 抬起**别的手指**时，`touchend` 照样触发结算并把 `drag` 清空 ⇒ 残留手指后续 move 全部失效；
- move 中 `touches[0]` 换指 ⇒ `clientY` 跳变。

## 修法

- 新增 `dragTouchId`（起手时记下 `touch.identifier`）；
- 新增 `trackedTouch(event)`：按 identifier 取指，没有记录时退回 `touches[0]`（单指与旧行为一致）；
- move 改用 `trackedTouch`；end 先判「起手那根是否还在 `event.touches` 里」，在就**不结算**；
- 结算后清 `dragTouchId`。

## 复验

`tests/composer-sheet-touch-id.spec.ts` 三条：起手记 identifier、move 按 identifier 取指（且不得再用
`event.touches[0]`）、抬起别的手指不结算且结算后清记录。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 5 条全红，改后 5 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（`onSheetTouchMove/End` 锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。多指复验见 PR 验收卡。
