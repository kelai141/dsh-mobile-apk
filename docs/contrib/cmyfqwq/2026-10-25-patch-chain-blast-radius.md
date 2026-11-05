# 补丁链爆炸半径审计：48 补丁的锚定面与快照 bump 风险（2026-10-25）

## 现象

#505 合并曾使补丁链断裂（vendored 市场客户端升级 → F/G 三锚失配 → apply-patches 退出 1，
由 a07edcb 校准修复）。该事故只波及 3 个锚——本文量化整条链的**结构性爆炸半径**，
评估下一次更大规模的锚暴露（快照 bump / 引擎升级）会同时考验多少补丁。

## 真因（结构性，非实现缺陷）

补丁锚是**精确字符串匹配**（`source.includes(ANCHOR)` + 唯一性断言 `split().length === 2`，
抽查 managed-port-bind-EP1 等实现），锚定对象分两个脆弱面：

1. **engine scope：28/48 个补丁打在快照内引擎文件**（`usr/lib/node_modules/...`）。
   快照 tar.xz 是整包替换——引擎 0.2.1-rc.2 → 下一版时，**28 个锚同批暴露**，
   其中 17 个挤在 `*/lib/index.js`、5 个在 `*/client.js`（同文件被上游打包器重排即连锁断）。
2. **vendor scope：20 个补丁**（dshmarketplace-plugin / dsh-undo-savepoint）——
   #505 事故已实证此面的断裂方式（vendor bump 忘同步锚校准）。

现有防线与缺口：
- `apply-patches --check` 是**事后门禁**（CI 每跑）——它保证「断在合并前被拒」，
  但不减少「断的频率与修复成本」：每次 bump 都要人工逐锚重校准（#505 → a07edcb 的形态）。
- `check-patch-fixtures.mjs` 锁 fixtures（旧版快照形态），不锁「下一版」。
- **没有一份按目标文件聚合的爆炸半径账本**——bump 前无法预估要重校准多少锚。

## 建议（按投入排序）

1. **爆炸半径账本进 README**：按 target 聚合的锚计数表（本文的聚合即可作为初版），
   快照 bump PR 模板加一行「本次 bump 影响锚 N 个（对照账本）」，让校准工作量显式化。
2. **锚点分诊**：为 28 个 engine 锚标注「结构性锚」（匹配稳定 API 形态，跨版本存续概率高）
   与「快照形态锚」（匹配打包产物布局，bump 必断）——后者是 bump 时的重点清单。
   可机器化：锚串里含变量名压缩痕迹（如 `runner-launch-B2zsQ1Dz.js` 这类 chunk 名）即判快照形态锚。
3. **bump 流程固化**：快照 bump PR 的 checklist 加「本地实跑 `apply-patches <vendorRoot> --check`
   + `--apply` 自验」（#505 断链进 main 的直接原因是该步只在 CI 事后跑，PR 作者本地没跑）。

## 复验证据

- `node scripts/patches/apply-patches.mjs vendor --check` 于 main@81322e7：退出 0（a07edcb 校准后全绿）
- 聚合统计：`python` 解析 registry.json（48 patches / 3 retired；engine 28 / vendor 20；
  17 锚 @ `*/lib/index.js`、5 锚 @ `*/client.js`）
- 锚风格抽查：`managed-port-bind-EP1.mjs`（includes + split 唯一性断言 + partial marker 拒漂移）
