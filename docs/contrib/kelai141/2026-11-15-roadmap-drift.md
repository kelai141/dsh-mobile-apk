# 2026-11-15：roadmap 与状态文档的漂移收口

本轮修完所有 open issue 后，按用户要求核对「roadmap 漂移」。核对口径是**文档声称 vs 仓库/GitHub 事实**，
不是文档自己的一致性。查出两类，其中只有一类该改。

## 一类：状态文档把「当时卡住」写成了「现在仍卡住」（已修）

`docs/RUST-NATIVE-DELIVERY-STATUS-2026-11-11.md` 三处断言五个 PR「均卡在 `REVIEW_REQUIRED`，未合入」：

- 第 15 行：「全部 `MERGEABLE`，均卡在 `REVIEW_REQUIRED`」
- 第 80-92 节：「当前阻塞 / 五个 PR 全部 MERGEABLE、CI 全绿，但均卡在 REVIEW_REQUIRED」
- 第 119 行：「五个 PR 卡在人工 review，未合入」

实测：

```
$ gh pr view 1707 --json state --jq .state   -> MERGED
$ gh pr view 1713 ...                          -> MERGED
$ gh pr view 1715 ...                          -> MERGED
$ gh pr view 1716 ...                          -> MERGED
$ gh pr view 1717 ...                          -> MERGED
```

五个全部已合并。这份文档是「当时为什么停手」的追溯记录，**不是现状**；但以现状口吻写，
下一个读它的人会以为改动还没进 main。

修法与理由：
- 第 15 行改成「已合并」并**明确保留**「合并不等于验收完成」——验收状态列（arm64 缺真机、
  崩溃率未统计等）是当时的事实，未因合并改变。
- 「当前阻塞」节改名为「当时的阻塞（已解除）」，加引用块说明本文写于 2026-11-11、该节仅作追溯；
  表格加「现状」列逐行标「已合并」。
- 第 119 行加删除线 + 实测结论，保留可追溯性，不直接删（删掉就丢失「当时为什么停」这条信息）。

**没有动**的是那些验收缺口（arm64 缺真机、崩溃率未统计、插件矩阵只有 3 个样本）。
它们是真缺口，不因 PR 合并而消失。

## 二类：`check-code-map.mjs` 的 247 项锚点失败（未修，登记理由）

`node scripts/check-code-map.mjs` 在 `origin/main` 上是 **exit 1 / 247 项**：

```
ambiguous-anchor      15
anchor-content-drift  10
bad-anchor             7
bad-anchor-content     7
uncovered              1
（其余 207 项见日志）
```

**为什么本轮不修**：试了脚本自带的两条自动路径，都不成立。

### 试过 1：`--derive-anchors --write`

```
$ node scripts/check-code-map.mjs --derive-anchors --write
已落盘：改写 848 处引用
$ node scripts/check-code-map.mjs
CHECK-CODE-MAP FAILED（857 项）      <- 247 变成 857，更糟
```

原因：`--derive-anchors` 是**锚点形态迁移**（把 legacy 行号锚改成符号锚），不是修漂移。
它把所有 legacy 锚都重写成符号形态，其中大量符号在当前源码里已不存在或不再唯一 ⇒ 失败数翻倍。

### 试过 2：再补 `--refresh-anchor-baseline`

```
$ node scripts/check-code-map.mjs --derive-anchors --write && node scripts/check-code-map.mjs --refresh-anchor-baseline
These are real content changes. Review them, then re-run with --force-drift to record them.
$ node scripts/check-code-map.mjs
CHECK-CODE-MAP FAILED（857 项）
```

它要求 `--force-drift` 才能吸收。而 `--force-drift` 的语义是「把当前源码内容**当成**锚点期望值」——
那等于把「锚点指错了地方」这件事本身吃掉。这正是本仓反复在治的假绿形态
（判据被改成永远为真）。**拒绝执行。**

### 结论与后续

- 这 247 项是**既有基线漂移**，不是本轮引入：多个 teammate 独立复核过「修前修后同一数字」
  （fix-manage 实测 40 项一致、fix-plugins 实测 193 项、fix-gates 实测 40 项，数字差异来自各自
  worktree 的检出范围）。
- 修它需要**逐条人工判断**「锚点该指向哪个符号/行」，247 条是 247 次语义判断，不是机械替换。
  这类工作必须由熟悉对应模块的人做，且应作为独立 PR 分批推进，不该塞进「修 issue」的批次里。
- 已登记进 `docs/AGENTS/known-gaps.md`（见该文件对应用户行的更新），让缺口可见而不是静默。
- **不把它当成本轮任何 PR 的判据**：各 teammate 都如实声明「与本 PR 改动面无关且修前同样红」。

## 顺带核实：两处已消失的过期描述

`docs/AGENTS/known-gaps.md` 的「CI 面两个已死 workflow 条目」行声称 `Snapshot Build` 仍出现在
Actions 列表。实测已消失：

```
$ gh workflow list --all | grep -i snapshot   -> 无输出
$ Test-Path .github/workflows/snapshot-build.yml -> False
```

`ADB runtime patch` 仍在，状态 `disabled_manually`（GitHub 无删除 workflow 的 REST 接口）。
该行已按实测改写，并把「这不是缺陷，属 GitHub 侧限制」写明，避免下一个人再来查一遍。
