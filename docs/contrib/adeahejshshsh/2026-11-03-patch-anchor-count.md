# 补丁锚点必须「恰好一处」（2026-11-03，issue #1384）

## 现象

补丁用 `String.prototype.replace(锚点, 新文本)` 施加：它只换**第一处**且不校验出现次数。上游
bundle 里同一锚点出现两份时（chunk 合并、同函数两份拷贝），补丁只改一份，而 marker 已插入
→ `check()` 恒真 → 之后每轮 `[skip] 已应用`，第二处的旧行为永远暴露不出来。

## 真因

判据缺失，而不是写法问题：`replace` 的语义是「替换第一个匹配」，而补丁需要的是「锚点唯一，
否则这条补丁的前提不成立」。两者在锚点唯一时结果相同，于是这个差别只有在上游漂移后才显形——
显形的方式还是「看起来成功了」。

`scripts/patches/data/registry-scan-c4.mjs` 里早有一份正确的 `replaceOnce`（`split().length !== 2`
即抛），但它只服务那一个补丁。

## 修法

- 提取 `scripts/patches/lib/replace-once.mjs`：`replaceOnce(source, before, after, label?)`，
  判据是**出现次数必须恰好 1**（0 次 = 锚点已变；≥2 次 = 半补丁），空锚点与非字符串锚点直接抛。
- `apply-patches.mjs` 里所有「字符串锚点」的 `replace` 改为 `replaceOnce`（约 60 处，机械替换）；
  正则锚点（`replace(/re/, …)`）保持原样——那是模式匹配，不是锚点。
- `registry-scan-c4.mjs` 的私有实现改为 import 同一份（同一判据只写一处）。

## 复验

- `scripts/patches/tests/replace-once-1384.test.mjs`（7 例）：0/1/2 次、空锚点、正则锚点、
  标签进错误信息，外加源码契约「`apply-patches.mjs` 里不得再留字符串字面量锚点的裸 `replace`」。
- 端到端：用 `dshmarketplace-plugin-0.1.7` 夹具跑**全部 vendor-scope 补丁**
  （`apply-patches.mjs <tmp> --apply --only market-*`）→ `11/11 ALL OK`，与 main 上逐条一致；
  `apply-patches.mjs vendor --check` → `22/22 ALL OK`；`patch-apply-rollback-1385.test.mjs` 全绿。
- 改前形态：main 上该源码契约红（4 处裸 `replace`）；同一份「锚点出现两次」的输入下旧写法只换
  第一处（`aXbXc` → `aYbXc`），第二处原样留下。
- `node scripts/check-code-map.mjs` → PASSED（`apply-patches.mjs` 锚点按内容重映射后手钉；
  新模块登记进覆盖账本与 B01 查点说明）。
- `node scripts/check-patch-mirror.mjs` → PASSED（SKIP=1：对端树不在场）。
- **未做设备验证**：纯构建链脚本（L1）。

## 已知边界

- 本次只把「字符串锚点」的替换收口；正则锚点（`replace(/re/, …)`）不在判据内——它们本来就是
  模式匹配，`replaceOnce` 不适用。
- `apply-patches.mjs` 是双仓逐字节镜像面：本 PR 是本仓镜像 PR，协调仓权威源由维护者按铁律 6 跟进。
