# PR1 — check-gate-skips 缩小探针面（性能审计 Top#3）

## 改了什么

`scripts/check-gate-skips.mjs`：把「scripts/ 下所有 `check-*.mjs`」按三类显式分派，只有 `probe` 类做运行期子进程探针。

| 类 | 数量 | 是否做运行期探针 |
|---|---:|---|
| probe（真门禁） | 55 | 是 |
| unitTest（`*.test.mjs`） | 23 | 否（静态层照跑） |
| aggregator（`check-release-gates.mjs`） | 1 | 否（静态层照跑） |

## 为什么这不是「改判据借绿」

1. **分类是穷尽断言，不是白名单**：`discovered` 必须等于三类并集，任何新文件落不进任何一类即判红（负控 NC1 实测）。
2. **排除集必须非空**：新增反向对照，若分类器把全部文件都归为 probe（等于没排除），判红（负控 NC2 实测）。
3. **被排除项全部可见**：`--list` 新增「探针面分类」段，逐个列出 23 个单测与 1 个聚合器；PASSED 摘要行打印 `探针面 55/79（排除 24）`。
4. **静态层不缩**：声明集合断言、接线断言、计数口径断言、严格档传播断言对全部文件照旧执行。
5. **FAIL 集合逐条相同**：改动前后都只有 `审计基线销账: check-snapshot-fingerprint.mjs` 这一条既有环境性失败（净检出无快照），没有把任何红改成绿。

## 前后数值

| 指标 | 改动前 | 改动后 | 变化 |
|---|---:|---:|---:|
| 探针池 spawn 数（A 级，不受 CPU 抖动） | 79 | 55 | **-24（-30.4%）** |
| `--list` 墙钟（n=1，宿主并发负载） | 210.7 s | 162.5 s | **-48.2 s（-22.9%）** |
| 全量门禁合计（D 块基线，含本条） | 216.5 s | — | 本条占 80.7% |

说明：墙钟降幅（22.9%）小于 D 块预估的 140-190 s，原因已定位——`check-script-tests.mjs`（单条 222.6 s）**是 runner 不是 `*.test.mjs`**，仍留在探针池内。要再降需单独处理它（另一 PR，不在本条范围）。

## 负控（受控缺陷注入，均已还原）

| # | 注入的缺陷 | 期望 | 实测 |
|---|---|---|---|
| NC1 | 分类器对某文件返回未知 kind | 穷尽断言判红 | 红：`未归类: check-snapshot-decode.mjs` |
| NC2 | 分类器把聚合器与单测都归为 probe（排除 0 条） | 反向对照判红 | 红：`排除 0 条 = 分类器没生效` |

两次注入后 `NEGATIVE-CONTROL` 标记残留数均为 0，改动已完全还原。

## 门禁

| 门禁 | 结果 |
|---|---|
| `check-gate-skips.mjs --self-test` | PASSED（46 项判别力断言） |
| `check-gate-skips.mjs --list` | 运行完成；FAIL 集合与改动前逐条相同 |
| `check-release-gates.mjs` | PASSED（声明 42 项，SKIP=1） |
| `check-code-map.mjs` | PASSED（本条只动一个脚本，无锚点副作用） |

## 风险与验证档位

- 风险：低。只影响门禁自身探针面，不触产品面、不触快照、不触签名。
- 档位：L1（门禁内部逻辑）⇒ 按铁律 3 需 `--self-test` + 一条受控负控，本 PR 给了两条。
- **未做设备验证**（L1 不要求）。

## 复现

```
node scripts/check-gate-skips.mjs --list          # 看探针面分类全貌
node scripts/check-gate-skips.mjs --self-test     # 46 项判别力断言
node scripts/perf-audit-lead/count-probe-spawns.mjs   # A 级计数证据：79 -> 55
```
