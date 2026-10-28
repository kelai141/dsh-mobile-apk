# check-bounded-io 的判别力自证（此前是零测试面）

## 这条门禁守什么

「子进程/连接流输出一律走 `ProcIo.readBounded`」。无界读有三重后果：先 readText 后 waitFor 使超时失效；
`redirectErrorStream` 下先 waitFor 后读会死锁；锁内挂起升级为全局冻结。

## 它的两处历史缺陷（都值得钉住）

1. **正则漏形态**：旧实现只覆盖 `proc.inputStream.bufferedReader().use { it.readText() }` 一种写法，
   漏掉无 `.use` 的裸读（`LogCollector.kt:123` 的实测形态）—— 46 个 Kotlin 文件零命中 `exit 0`，**假绿**。
2. **ROOT 固定**：`ROOT` 取「脚本上两级」，在协调仓根跑时指向无 Kotlin 源的目录 → `SKIP exit 0`，
   即「本地默认入口空转」。现在改为探测含 `app/src/main/java` 的树，找不到即失败。

这两条都不是靠测试发现的，是靠人读代码发现的 —— 正是要补自证的理由。

## 自证覆盖（造合成树，`--root` 指向）

```
PASS  合规树（无裸读）→ PASSED 且 exit 0
PASS  裸 readText（无 .use，历史缺陷形态 1）→ FAILED
PASS  proc.inputStream.bufferedReader().use { it.readText() } → FAILED
PASS  命中行带 bounded-io-exempt 注释 → PASSED（豁免通道有效）
PASS  ProcIo.kt 本体豁免（并发排水是它的职责）→ PASSED
PASS  无 app/src/main/java 的树 → 树定位失败 exit 1
BOUNDED_IO_SELF_TEST_PASSED（6 项）
```

## 判据级变异（两个方向分离）

| 变异 | 结果 |
|---|---|
| 删掉第一条 pattern（裸 readText 无 `.use`） | **只红第 ②**（历史缺陷 1 会复发） |
| 把 `EXEMPT_MARKER` 换成永不匹配 | **只红第 ④**（豁免通道失效，其余不动） |
| 恢复 | 6/6 全过 |

⇒「漏形态」与「豁免通道」在自证里可分辨。变异脚本带前置闸门。

## 影响面

- 只新增 `--self-test` 分支，在 `const argv = process.argv.slice(2)` 之前拦截；
  正常调用 `node scripts/check-bounded-io.mjs [--root <树>]` 一字未动。
- 8 个门禁全 PASSED（含 `check-gate-skips` 与 `check-bounded-io` 本身）。

## 剩余零测试面

`check-maintenance-docs`、`check-state-registry`、`check-mcp-client-deps`
（已补：snapshot-file-modes #815、snapshot-secrets #816、snapshot-fingerprint #817、bounded-io 本条）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

