# check-snapshot-fingerprint 的判别力自证（此前是零测试面）

## 为什么这条重要

它守的是 `assets/snapshot.tar.xz` 的实际 sha256 与 `snapshot.sha256` 声明值逐字节相等 ——
**手工替换 tar 的唯一机器校验**。壳侧 `EngineManager.snapshotFresh()` 只做字符串比较，
陈旧就跳过重解压，运行期也发现不了。三个构建脚本会重写声明值，走完整链是安全的；
但「手工替换 tar」这一动作此前没有任何测试证明这条门禁真的会红。

## 补法

它本身支持 `--root`，所以自证可以造五棵临时树，把**六个判据分支**全打一遍：

```
PASS  tar 与声明一致 → PASSED 且 exit 0
PASS  声明与 tar 不一致 → FAILED 且指出「手工替换」
PASS  声明缺席 → FAILED（无法对账）
PASS  声明格式非法 → FAILED（不是 64 位小写十六进制）
PASS  tar 缺席（非 --require）→ SKIP 且 exit 0、带 SKIP=1
PASS  tar 缺席 + --require → 硬失败 exit 1
SNAPSHOT_FP_SELF_TEST_PASSED（6 项）
```

## 判据级变异（两个方向分离）

| 变异 | 结果 |
|---|---|
| 撤掉 `actual !== declared` 那条 | **只红第 ②**，`SELF_TEST_FAILED（1 项）` |
| 撤掉 64 位十六进制格式校验 | **只红第 ④**，其余 5 条不动 |
| 恢复 | 6/6 全过 |

⇒「值不一致」与「声明本身非法」在自证里可分辨，不是一条大网。变异脚本带前置闸门。

## 影响面

- 只新增 `--self-test` 分支，在 `const argv = process.argv.slice(2)` 之前拦截；
  正常调用 `node scripts/check-snapshot-fingerprint.mjs [--require] [--root <树>]` 一字未动。
- 7 个门禁全 PASSED（含 `check-gate-skips`）。

## 剩余零测试面

`check-maintenance-docs`、`check-bounded-io`、`check-state-registry`、`check-mcp-client-deps`
（已补：snapshot-file-modes #815、snapshot-secrets #816、snapshot-fingerprint 本条）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

