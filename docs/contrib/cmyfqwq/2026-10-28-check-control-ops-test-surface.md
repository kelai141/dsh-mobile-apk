# `check-control-ops` 此前零测试面：把断言写坏也不会有人知道

## 现象

`scripts/check-control-ops.mjs`（333 行）守的是「控制 op 六处登记链一致」——新增一个 op 漏登记任何一面，
轻则工具在 a11y 通道下静默不可达，重则模型收到「需要无障碍服务支持」这种**误导性错误**（`browserTabs`
漏登记时的实锤）。

但它自己**既没有 `--self-test`，也没有同名 `.test.mjs`**：

```
scripts/check-*.mjs 共 54 个
  有 --self-test            33
  有同名 .test.mjs           6
  >200 行且两者都没有        check-tool-output-schema(590) / check-patch-mirror(499) /
                             check-control-ops(333) / check-runtime-assets(273) / check-tool-surface-budget(240)
```

也就是说：把它的任意一条断言写坏、或整段删掉，CI 不会有任何反应。门禁本身没有任何东西守着。

## 做法

脚本本来就支持 `--shell-root` / `--plugin-root` / `--gaps`，只差台账路径是写死的
（`join(ROOT, 'scripts', 'control-ops-pending.json')`）。给它加一个**只给测试用**的 `--ledger <file>`
（默认值不变，正常门禁仍读仓库台账），就能把「六个面 + 台账 + 豁免面」全部换成一棵临时树跑。

于是用例可以逐条做负控，而且**不碰仓库真实文件**（构造临时树而不是改真实文件，避免"测扫描源码的门禁时
自测样本被自己扫到"的自指陷阱）：

| # | 用例 | 断言 |
|---|---|---|
| 1 | 六处一致的树 | `CHECK-CONTROL-OPS PASSED`，rc 0 |
| 2 | handle 少一个 when 分支 | rc 1 + `FAIL  handle 分支 == SUPPORTED_OPS` + `SUPPORTED_OPS 独有=[scroll]` |
| 3 | 引擎 `ControlOp` 少一个 | rc 1 + `FAIL  ControlOp == SUPPORTED_OPS` + `SUPPORTED_OPS 独有=[scroll]` |
| 4 | `A11Y_OPS` 多一个 | rc 1 + `A11Y_OPS 独有=[longClick]` |
| 5 | manage 工具面用未登记 op | rc 1 + `manage 独有=[bogus]` |
| 6 | `ROUTE_OPS` 越界 | rc 1 + `越界=[bogus]` |
| 7 | known-gaps 声明过的缺口 | rc 0 + `WARN  ControlOp 豁免 scroll`（降级不判红） |
| 8 | 源文件形态变了 | rc 1 + `解析不到 DeviceControlService.handle`（不得静默放行） |

用例 2/3 的一处实现细节值得记：建临时树时 `ControlOp` 的类型联合块必须写成
`export type ControlOp = 'click' | 'scroll'` 这种**行尾以引号或 `|` 结尾**的形态——`unionBlock()`
是靠"逐行累积直到某行不再以 `'` 或 `|` 结尾"来切块的，写成 `export type ControlOp =` 换行再列成员会被
立刻切断，解析出空集合，反而让断言"因为两边都空"而假过。这条是先撞到再照真实文件形态对齐的。

## 复验证据

- `node --test scripts/check-control-ops.test.mjs` → **8 pass / 0 fail**
- 真实门禁未变：`node scripts/check-control-ops.mjs` → `CHECK-CONTROL-OPS PASSED`
  （3 族 / 25 op；`--ledger` 默认值仍是仓库台账）
- **变异反证**（三次，各自只红一条，回滚后 8 pass）：
  1. 删掉 `setEq('handle 分支 == SUPPORTED_OPS', …)` 调用 ⇒ **7 pass / 1 fail**
  2. `exempt()` 改成恒 `false`（豁免失效）⇒ **7 pass / 1 fail**
  3. 解析失败文案从「解析不到」改成英文 ⇒ **7 pass / 1 fail**（证明用例守的是**具体文案**，不只是退出码）

## 已知边界

1. 本轮只覆盖「六面相等 + 豁免 + 解析失败」这几条主干断言。台账驱动的那一大段（`pending 族` 的
   `faces` / `neverFaces` / `pending` 声明与 stale 判定，约 80 行）没有用例——它需要构造族契约文件 +
   台账条目，成本比主干高；本轮先把"最容易被人手改坏"的部分锁住。
2. 测试是**脚本级**（`spawnSync` 跑子进程 + 断言 stdout 文案），不是纯函数单测。这是有意的：
   纯函数单测测不到"断言被删掉"这类改动（函数没了测试还在），而脚本级跑的是真实入口。
3. `check-tool-output-schema`(590) / `check-patch-mirror`(499) / `check-runtime-assets`(273) /
   `check-tool-surface-budget`(240) 仍是零测试面，同样的问题还在。
