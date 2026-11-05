# check-state-registry 的判别力自证，以及它顺手抓到的一条真缺陷

## 自证覆盖（此前零判别力面）

加 `--root`（与同类门禁对齐）与 `--self-test`，造七棵合成树把判据分支全打一遍：

```
PASS  合规合成树 → PASSED 且 exit 0
PASS  PR 模板缺一栏（外部真源）→ FAILED
PASS  登记表 states 为空 → FAILED（跨层状态矩阵起点不得为空）
PASS  id 重复 → FAILED
PASS  writePath 指向已删除文件 → FAILED（最典型的 stale）
PASS  evidence(file) 路径不在场 → FAILED
PASS  evidence kind 非法 → FAILED（只认 file|grep|gate）
STATE_REGISTRY_SELF_TEST_PASSED（7 项）
```

## 自证第一次跑就抓到真缺陷

合成树的 PR 模板是三栏（缺「外部真源」），判据却打印 **PASS**。原因：

`resolveRepoPath` 返回的是**相对路径**（`cands.find(...)` 返回 `c` 而非 `join(ROOT, c)`），
而调用方用 `readFileSync(p)` 读模板与 evidence 目标 —— 相对路径被按 **cwd** 解析。

原来 `ROOT` 恒等于仓库根、cwd 也恰好在仓库根，这个错被完全掩盖：从仓库根跑永远读对，
从别处跑会去读 cwd 下的同名文件甚至 ENOENT。加 `--root` 指向合成树后它立刻现形 ——
判据读到了仓库里那份四栏齐全的模板，于是「缺栏模板」被判 PASS（**假绿**）。

修法：`resolveRepoPath` 返回绝对路径 `cands.map((c) => join(ROOT, c)).find(existsSync)`。

复验：修后 7/7 全过；真实登记表 13 条仍 PASSED；**从 `/tmp` 调用同样 PASSED**（修复前会 ENOENT）。

## 判据级变异（两个方向分离）

| 变异 | 结果 |
|---|---|
| 把 `resolveRepoPath` 改回返回相对路径 | **只红第 ②**（假绿复现） |
| 撤掉「写路径在场」判据 | **只红第 ⑤** |
| 恢复 | 7/7 全过 |

## 影响面

- 新增 `--root` 与 `--self-test` 两个入口；正常调用 `node scripts/check-state-registry.mjs [--list]` 行为不变。
- `resolveRepoPath` 返回值改为绝对路径：所有调用方（模板读取、`evidence(file)` 存在性、`evidence(grep)` 内容、`writePath` 存在性）语义不变，只是不再依赖 cwd。
- 7 个门禁全 PASSED（含 `check-gate-skips`）。

## 剩余零测试面

`check-maintenance-docs`（CI 提示 job）、`check-mcp-client-deps`。
（已补：snapshot-file-modes #815、snapshot-secrets #816、snapshot-fingerprint #817、bounded-io #818、state-registry 本条。）

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

