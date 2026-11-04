# 属主维护失败的红字可自愈（2026-11-04，issue #1376）

## 现象

点「修复文件属主」失败一次后，红字不会消失：后续 2s 轮询即使把 ownership 刷成 running / completed，
界面仍显示「启动文件属主维护失败」。

## 真因

`repairFailure` 只在**成功分支**被清（`setRepairFailure(undefined)`），轮询路径没有任何清除点；
而渲染是「有失败态就只显示失败文案」，于是 `describeOwnershipRepair` 再也拿不回控制权。

## 修法

加一个效果：轮询看到推进（`running` 或 `completedAt > 0 && result !== undefined`）时清掉失败态，
让 `describeOwnershipRepair` 重新接管文案（进行中 / 完成 / 结果不可读各自有话说）。

```tsx
useEffect(() => {
  if (repairFailure === undefined) return
  if (!polledRepair.readable) return
  if (polledRepair.running || (polledRepair.completedAt > 0 && polledRepair.result !== undefined)) {
    setRepairFailure(undefined)
  }
}, [polledRepair, repairFailure])
```

## 复验

`tests/phone-control.spec.tsx` 新增一例：点击被拒 → 红字；轮询刷成 running → 红字消失且按钮进入
「属主维护进行中」；再刷成 completed → 仍无失败文案、出现「文件属主维护完成」。

- **vitest 未在本机跑**（无 `node_modules`），由 CI 执行。
- 本机同判据脚本：改前 4 条红，改后 4 条全绿。
- `node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。真机复验见 PR 验收卡。
