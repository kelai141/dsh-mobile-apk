# registry 每条补丁显式声明回归测试（2026-11-04，issue #1213）

## 现象

`check-patch-test-manifest.mjs` 的「每个补丁都有回归测试」这条承诺此前**没有被真正验证**：
清单来自 `scripts/patches/tests/`（它自己检查的那个目录），`registry.json` 的 `test` 字段声明数为 0，
于是 `declaredOnly` 恒为空、`missingDeclared` 恒为空——判据已接线但无数据可判，恒绿。

`#1190` 修的是同源的另一半（空 TAP 判绿、两侧集合非空断言）并**预留了本通路**；
本条补的是数据面。

## 为什么不能靠文件名猜

`#1190` 的原报告说「15 个补丁没测试」，而按「id 是否出现在文件名里」实测得到过 **36 / 30 / 25** 三个不同的数
——三组数字本身就是证据：这个「缺测试数」完全取决于匹配假设，而假设没有唯一正确答案。
registry id 与测试文件名不是一对一：`market-B` 与 `market-D-client` 共用 `market-mobile-filter-507.test.mjs`，
`undo-safe-align-S1` 与 `undo-safe-transaction-S2` 共用 `safe-mode-policy.test.mjs`，
而 `client-registry-scan-c4.test.mjs` 根本不带某一条补丁的全名。

所以本条的映射**逐条读测试内容确认**，判据只用三种可复核的证据：

1. 测试里出现 `--only <id>`（runner 真施加该补丁）；
2. 测试 import 并调用该补丁的规划函数（`planReasoning` / `planClientRegistryScan` 等）；
3. 测试断言该补丁的 `marker` 串。

三条都不成立的，一律写 `"test": null` + `reason` + `since`——**宁可多写 null，也不编一个错的路径**。

## 数据

57 条活动补丁：**37 条**指向真实测试文件，**20 条** `test: null` 并带理由。
3 条 `retired` 按 issue 要求不加字段。

20 条 null 的理由可归为四类（每条在 registry 里各自写全）：

| 类别 | 例子 | 为什么现在补不了 |
|---|---|---|
| 判据在渲染后的 DOM / CSS，无 client 渲染基线 | `undo-E1`..`undo-E8`、`market-E-collapse`、`market-F-client`、`market-G-state`、`market-J-fullpage`、`settings-account-feedback-entry` | 现有 client 测试只做「从 bundle 里抽取数函数 K」，不渲染组件；只断言「文本在场」与本仓「判据要行为化」冲突 |
| 需要扩夹具才有样本 | `market-F-pages` | 分页依赖上游目录接口的 `total`，当前夹具无分页响应 |
| 无可断言的运行期行为 | `flock-android-F3` | 只是把上游缺失依赖登记进注入面（packaging 面） |
| 需真机 / 真实网关响应序列 | `terminal-inspector-android-D1`、`pi-toolcall-G2`、`attach-durable-F2`、`reference-drill-F6`、`market-L-mobile-count` | 脚本层只能断言字节，不构成回归 |

`attach-durable-F2` 与 `flock-android-F3` 特别说明：它们**只**出现在别的测试的散文注释里
（`fs-local-link-f8.test.mjs` 的「同一 sepolicy 限制的第 4 个站点」、`publish-exclusive-reclaim.test.mjs` 的
「独占前提注释写明 flock-android-F3 stub 的后果」），没有任何断言真的施加或校验这两条补丁。
把它们登记成有测试 = 制造假绿，故如实写 null。

`pi-upstream-streaming-020` 指向 `reasoning-envelope-1304.integration.mjs`（不是 `.test.mjs`）：
该文件 `import { planPiStreaming }` 并逐条 `writeFileSync(join(root, item.file), item.after)`，
由 `.github/workflows/pr-gate.yml:359` 单独执行；`listTestFiles()` 只收 `.test.mjs`，
故它不在「46 个回归文件」里，但它确实是这条补丁的回归。

## 副作用：夹具台账的 registrySha256 必须跟着重钉

`scripts/patches/tests/fixtures/manifest.json` 的 `capture.registrySha256` 钉住 registry 的字节
（`check-patch-fixtures.mjs:194-197` + `check-upstream-patch-bytes.test.mjs:60-68`）。
registry 一旦改动，`check-patch-fixtures` 立刻判红：「夹具捕获登记身份/补丁集与当前合同不符」。

本条的改动**只增加 `test`/`reason`/`since` 三个字段，不动任何 target / marker / scope**，
夹具的字节内容与捕获来源（`engine 0.2.1-rc.3` / `sourceCommit 1f81c047`）都不变，
所以只重钉 `registrySha256` 一个值，不重捕夹具。历史先例同形：`7f1a2fd7` 补两条 `scope` 时也只动了台账身份。

> 注意：`probe-engine-anchors.mjs --fixtures` 在本机跑不起来（`.deploy-tmp/engine-overlay` 无 tgz 缓存），
> 全量重捕需要真实构建产物。本条不触发重捕，故不受影响。

## 门禁与负控

- `check-patch-test-manifest.mjs`：PASSED（46 个文件，TAP 160 用例 / 157 pass / 2 条 Windows symlink 已知失败）。
  自检里「registry 里显式声明 test 的条目都指向真实文件（当前声明 37 条）」由 0 变成 37，判据真正开始工作。
- 负控①（真打红）：把 `ptc-argv-L1` 的 `test` 指向 `does-not-exist-9999.test.mjs` →
  `CHECK-PATCH-TEST-MANIFEST FAILED：registry 声明的测试文件不存在（1 条）`，exit 1；改回后 PASSED。
- 负控②（如实记录）：删掉某条的 `test` 字段 → 门禁**仍绿**。这是当前判据的已知边界：
  `declaredOnly = declared.filter((d) => d.test)`，没有字段等于没有声明，门禁不据此判红。
  issue #1213 建议的「未退役补丁必须有 test 字段（null 也算有）」属于**收紧判据**，
  与本条的数据改动分开，留给维护者决定（别在本条 PR 里改宽判据）。
- `check-patch-fixtures.mjs`：PASSED（夹具代 0.2.1-rc.3）。
- `check-code-map.mjs`：PASSED。`registry.json` 每条加 1~3 行，`ptc-android-native-A1` 的 `id` 行
  从 428 移到 512（前 48 条里 30 条 +1 行、18 条 +3 行 = +84），执行地图的锚点按内容重钉一次。
