# `check-tool-surface-budget` 此前零测试面：把阈值判断删掉也不会有人知道

## 现象

`scripts/check-tool-surface-budget.mjs`（240 行）守「模型面工具 wire 预算」，判定链有五段：

1. 注册集字节 vs 基线 **+2%** 阈值；
2. 初始可见集（渐进披露后模型第一眼）字节 vs 基线 +2%；
3. **名字级**：初始可见集与基线 `visibleTools` 名单必须逐名一致（新增可见工具必须过一次评审 ——
   只守字节会漏「塞进一个很小的新工具」）；
4. 掩蔽清单（`DEVICE_TOOL_GROUPS`）里的名字必须真注册（组名单与实现漂移即红）；
5. 常驻 facade 必须在初始可见集里（否则模型没有任何入口解锁能力组）。

但它自己既没有 `--self-test`，也没有同名 `.test.mjs`：把第 1 段的阈值判断改成恒真、或把第 3 段整段删掉，
CI 不会有任何反应。

## 做法

这个脚本不是静态扫源码，而是 `await import()` 各插件的 `lib/index.js` 并**真跑 `apply()`** 捕获
`ctx.tools.register(def)`。所以测试只需要一棵**假插件树**：

- 加一个只给测试用的 `--root <dir>`（默认 `dirname(HERE)`，行为不变）；
- `BASELINE_FILE` 从 `join(HERE, 'tool-surface-budget.json')` 改成
  `join(ROOT, 'scripts', 'tool-surface-budget.json')` —— 真实运行时指向同一个文件，测试时落在临时树里。

假插件（6 个，各 `lib/index.js` + `package.json {"type":"module"}`）里，bridge 额外导出
`DEVICE_TOOL_GROUPS = { screen: ['android_screen_list'] }` 与 `CAPABILITY_TOOL_NAME`，
并注册 facade 与一个被掩蔽的工具。

## 复验证据

`node --test scripts/check-tool-surface-budget.test.mjs` → **8 pass / 0 fail，约 1 秒**

| # | 用例 | 断言 |
|---|---|---|
| 1 | 与基线一致 | rc 0 + 打印注册集/初始可见集两个口径 + `可见集名单 == 登记` |
| 2 | description 变长 | rc 1 + `超预算（注册集）` |
| 3 | **字节有余量**时新增可见工具 | rc 1 + `模型第一眼新增工具（未经判定）：android_n`，且 `assert.doesNotMatch(/超预算/)` 保证测的是名字级判定 |
| 4 | 掩蔽清单出现未注册名 | rc 1 + `掩蔽清单里有未注册的工具名` + 点名 `android_ghost` |
| 5 | facade 被掩蔽 | rc 1 + `常驻 facade 不在初始可见集` |
| 6 | 两个插件同名工具 | rc 1 + `模型面工具名重复` |
| 7 | 缺基线文件 | rc 1 + `缺少基线文件 …tool-surface-budget.json` |
| 8 | `--update` 写回基线 | 先 rc 1（缺基线）→ `--update` rc 0 → 再跑 rc 0，并校验基线里有 `baseline` 与 `visibleTools` |

**变异反证**（三次，各自只红一条，回滚后 8 pass）：

1. `if (total > limit)` → `if (false)`（删掉注册集阈值）⇒ **7 pass / 1 fail**（用例 2）
2. `if (newlyVisible.length > 0)` → `if (false)`（删掉名字级判定）⇒ **7 pass / 1 fail**（用例 3）
3. `if (unknownMasked.length > 0)` → `if (false)`（删掉掩蔽漂移判定）⇒ **7 pass / 1 fail**（用例 4）

真实门禁未变：`node scripts/check-tool-surface-budget.mjs` → `CHECK-TOOL-SURFACE-BUDGET PASSED`
（注册集 16443 B / 基线 18528 B；初始可见集 824 B / 基线 2951 B）。

## 用例 3 为什么要先把基线放大 1.5 倍

这是本轮唯一一个"测试本身会假过"的坑：新增一个小工具时，**注册集字节也会涨**，而夹具的基线只有
458 B（+2% 阈值 = 467 B），加一个工具直接 +54 B ⇒ 先撞「超预算（注册集）」，名字级判定根本跑不到。

所以用例 3 先用 `inflateBaseline(dir, 1.5)` 把 `baseline` 与 `initialVisible` 都放大，让字节层面留出
余量，再用 `assert.doesNotMatch(out, /超预算/)` 明确断言"本条测的不是字节阈值"——否则这条用例在阈值
判定被删掉时仍会红，看起来有判别力，其实测的是另一段。

## 已知边界

1. 只覆盖主干五段，没有覆盖 `printReport()` 的输出格式（那是展示层）。
2. `--root` 是给测试用的口子；门禁的正常入口参数（`--report` / `--update`）行为未变，且真实运行仍
   读仓库自己的 `scripts/tool-surface-budget.json`。
3. 零测试面里还剩 `check-tool-output-schema`(590) / `check-runtime-assets`(273)：前者要真跑插件 +
   校验 schema，后者要核对补丁与资产两条落地路径，桩成本都明显更高。
