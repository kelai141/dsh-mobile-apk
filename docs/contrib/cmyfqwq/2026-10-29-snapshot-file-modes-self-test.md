# check-snapshot-file-modes 的判别力自证（此前是零测试面）

## 问题

扫 `scripts/` 下 67 个脚本，有 7 条门禁**既没有 `.test.mjs` 也没有 `--self-test`**：

| 门禁 | 行数 |
|---|---|
| check-snapshot-file-modes | 58 |
| check-snapshot-fingerprint | 75 |
| check-maintenance-docs | 68 |
| check-bounded-io | 90 |
| check-state-registry | 97 |
| check-snapshot-secrets | 127 |
| check-mcp-client-deps | 171 |

「零测试面」的具体后果：只能看它对**真快照**说 PASS，看不出它在本该红的时候会不会红。
`check-snapshot-file-modes` 是其中最小的一条，而它的判据藏在**内嵌的 Python 字符串**里
（`python3 -c <checker> <archive>`）—— 不造真实 `tar.xz` 就完全跑不起来。

## 补法（与 #770 / #780 同路线）

加 `--self-test`：现场造两个**极小**归档，再调用自己，覆盖「该绿 / 该红 / 用法错」三个方向。

```js
const okArchive  = buildArchive("ok",  0o600)   // 目录 700 + 文件 600
const badArchive = buildArchive("bad", 0o644)   // 文件模式不对
const r1 = runGate(okArchive)     // 期望 SNAPSHOT_MODE_CHECK_PASSED + exit 0
const r2 = runGate(badArchive)    // 期望 SNAPSHOT_MODE_CHECK_FAILED + exit 1
const r3 = runGate(missing)       // 期望用法错 exit 2
```

走的是**真实 tar + xz + python3 全链路**，不是 mock。

## 实测

```
PASS  合规归档（文件 600 / 目录 700）→ PASSED 且 exit 0
PASS  不合规归档（文件 644）→ FAILED 且 exit 1
PASS  归档不存在 → 用法错 exit 2
SNAPSHOT_MODE_SELF_TEST_PASSED（3 项）
```

## 判据级变异

把内嵌 Python 的 `if mode != expected:` 改成 `if False:`（等价撤掉模式判据）：

```
PASS  合规归档 → PASSED 且 exit 0
FAIL  不合规归档（文件 644）→ FAILED 且 exit 1     <- 只有这条红
PASS  归档不存在 → 用法错 exit 2
SNAPSHOT_MODE_SELF_TEST_FAILED（1 项）   mutant exit=1
```

恢复后 3/3 全过、exit=0。变异脚本带前置闸门（`git status` 有非 `.tmp` 改动就 `exit 1`）。

## 影响面

- 只新增 `--self-test` 分支，**在解析 `<snapshot.tar.xz>` 参数之前拦截**；
  正常调用 `node scripts/check-snapshot-file-modes.mjs <archive>` 一字未动。
- `check-gate-skips` 仍 PASSED（声明 38 项门禁；SKIP 审计 67 个脚本；发布链 `--require` 在场）。

## 剩余零测试面（后续可同法补）

`check-snapshot-secrets`（127 行，安全判据最该有判别力自证）、`check-state-registry`、
`check-snapshot-fingerprint`、`check-bounded-io`、`check-mcp-client-deps`、`check-maintenance-docs`。

