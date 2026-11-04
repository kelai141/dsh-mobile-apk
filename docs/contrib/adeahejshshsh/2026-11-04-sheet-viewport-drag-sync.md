# 拖拽中视口变化同步拖拽基准（2026-11-04，issue #1380）

## 现象

按住底部 sheet 拖动的同时让软键盘弹出/收起（或转屏），卡片高度瞬跳。

## 真因

`relayoutSheet()` 按新的 peek / max 重写 `style.height`，但 `drag.height` 与 `drag.appliedY` 没有
跟着对齐。下一次 move 的 delta 会叠加到旧基准上：

```ts
const delta = touch.clientY - drag.appliedY   // appliedY 还是旧视口的
const grown = drag.height + (-delta) * feel.upDamping
```

## 修法

在 `relayoutSheet()` 写完高度之后、`publishGeometry()` 之前，若正在拖拽就把基准对齐：
`drag.height` 取**内联值**（刚写下去的那个，不读还在动的 rect），`drag.appliedY` 对齐 `drag.lastY`。

刻意不复用别的 PR 里新增的辅助函数——本 PR 独立成立，不引入跨 PR 依赖。

## 复验

`tests/composer-sheet-viewport-drag-sync.spec.ts` 两条：`relayoutSheet` 必须在拖拽中重写基准
（内联值优先），且同步必须早于 `publishGeometry()`。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 4 条全红，改后 4 条全绿。
- `node scripts/check-code-map.mjs` → PASSED（锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。键盘弹收的复验见 PR 验收卡。
