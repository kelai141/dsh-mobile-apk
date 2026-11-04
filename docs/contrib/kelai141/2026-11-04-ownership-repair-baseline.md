# 属主维护红字：基线取自渲染态、清除判据与渲染同源（#1376 / #1518 / #1519）

## 现象

「文件属主维护」点失败后出现红字「启动文件属主维护失败」，随后被 2 秒轮询静默清掉——用户以为修好了，实际本次没有跑过任何维护。

## 真因

`#1376` 的自愈判据（`phone-control.tsx:824-835`）有两个独立缺陷，来自同一处「基线/判据取哪份状态」：

1. **基线取自不可读快照（#1518）**：点击时记 `{startedAt: polledRepair.startedAt, completedAt: polledRepair.completedAt}`。ownership 不可读时 `polledRepair` 退化成 `OWNERSHIP_UNREADABLE = {startedAt: 0, completedAt: 0}`，仍被记为基线。下一 tick 读到任意一条**历史** `completed`（`startedAt=10`），`10 > 0` 成立 ⇒ 清红字。本次并没有新 run。
2. **判据只读 `polledRepair`（#1519）**：`if (!polledRepair.readable) return`，而界面渲染的是 `repairState`（含点击回执 `repairReply`）。两侧不同源。

## 修法（一个逻辑改动，覆盖两条 issue）

判据与渲染同源：

- 基线改取 `repairState`（`repairState.readable ? {…} : null`）——不可读时记 `null`，不记 `{0,0}`。
- 比较对象由 `polledRepair` 改为 `repairState`，去掉 `!polledRepair.readable` 的早退。
- 无基线（点击时不可读）时只认**活证据**：`repairState.readable && repairState.running`。历史 `completed` 记录的 `startedAt` 恒 `> 0`，若拿它判自愈就等于用「任意一次旧成功」清掉本次失败。

## 判据为什么是这样

「不可读就不记基线」如果实现成「没有基线就永不清除」，等于用**关掉自愈**来修 #1518——#1376 打回原形（红字永不消失）。所以两条用例必须成对存在，且互为反方向：

- `ownership 不可读时点失败，历史成功记录不得清掉红字（issue #1518）`——负控：把基线改回「永远记」⇒ 该用例 FAILED。
- `不可读基线下仍要能自愈：轮询读到活的 running 必须清红字`——负控：把无基线分支改成 `return` ⇒ 该用例 FAILED。

## 复验证据

- `npx vitest run tests/phone-control.spec.tsx`：116 passed（基线 114 + 新增 2）。
- `npm test`（dsh-client-ui-responsive 全量）：75 files / 1146 tests passed。
- `npm run build`：exit 0。
- `.\gradlew.bat testDebugUnitTest`：BUILD SUCCESSFUL。
- `check-code-map` / `check-kotlin-test-count` / `check-release-gates` / `check-kotlin-comments`：全部 PASSED。

## 如实记录：一条没有保留的判据

最初按 #1519 字面写了一条「轮询持续不可读 + 第二次点击回 running ⇒ 红字消失」的用例。负控显示它**在原码上也通过**——因为有效回执分支（`:810-814`）当场就 `setRepairFailure(undefined)`，轮询是否可读与此无关。那是假判据，已删除，换成上面那条能真打红的反向守卫。

结论：#1519 的**字面症状**（点击成功却仍显示失败）在原码上不可复现；真实存在的是「判据与渲染不同源」这一处结构缺陷，随本次一并修掉。

## 未做设备验证

纯 JS 客户端逻辑，无壳侧/桥协议改动。按 AGENTS.md §4.2 属 L3 类，但本改动仅影响一处文案的清除时机，未做模拟器三层验收，**在此显式标注**。
