# check-snapshot-secrets 的判别力自证（此前是零测试面）

## 为什么这条最该补

扫 `scripts/` 下 67 个脚本，7 条门禁既无 `.test.mjs` 也无 `--self-test`。其中 `check-snapshot-secrets`
（127 行）守的是**发行快照里不得出现凭据**：`home/.dsh/.credentials` / `sessions/` / `storages/` /
`.anonymous-user-id` / `home/.npmrc` / `settings.yaml` 里的实际密钥 / `@dsh-android` 的 `.js.map`。

它此前的历史已经证明「零判别力」会出真事：review C3（2026-09-14）里旧实现对 `tar -tJf` 失败
catch 后静默继续，在空成员列表上跑匹配必然全 PASS，**垃圾文件也 PASS exit 0**。那次是靠人读代码
发现的，不是靠测试发现的 —— 这正是要补自证的理由。

## 补法（与 #770 / #780 / #815 同路线）

加 `--self-test`：现场造五个极小归档并调用自己，覆盖该绿 1 条 + 路径级/内容级各 1 条 +
两个「不是发行快照」的硬失败前提。

```
PASS  合规快照（usr/ + 引擎包 + 干净 settings.yaml）→ PASSED 且 exit 0
PASS  含 home/.dsh/.credentials → FAILED 且 exit 1
PASS  settings.yaml 含 sk- 实际值 → FAILED（内容级）
PASS  缺 @deepseek-ai/dsh 引擎包 → 硬失败（不是发行快照）
PASS  缺 usr/ 前缀 → 硬失败
SNAPSHOT_SECRET_SELF_TEST_PASSED（5 项）
```

## 一个实现坑（值得写下来）

打包必须用**显式列举顶层目录**（`tar -cJf out -C dir usr home node_modules`），不能用 `-C dir .`：
后者成员名带 `./` 前缀，而 `settings.yaml` 那条判据是**精确相等**比较
（`path === "home/.dsh/settings.yaml"`），前缀差异会让内容级检查整个被跳过 —— 自证会假绿。

## 判据级变异（两个方向分离）

| 变异 | 结果 |
|---|---|
| 撤路径级判据（`.credentials` 那条改成 `if (false && …)`） | **只红第 ②**，`SELF_TEST_FAILED（1 项）` |
| 把 `leakRe` 换成永不匹配的正则（等价撤内容级判据） | **只红第 ③**，其余 4 条不动 |
| 恢复 | 5/5 全过 |

两个变异各自只打掉自己那一层判据 ⇒ 「路径级」与「内容级」在自证里是可分辨的，不是一条大网。

变异脚本带前置闸门（`git status` 有非 `.tmp` 改动就 `exit 1`）。

## 影响面

- 只新增 `--self-test` 分支，在 `const args = process.argv.slice(2)` 之前拦截；
  正常调用 `node scripts/check-snapshot-secrets.mjs <archive> [--require]` 一字未动。
- `check-gate-skips` 仍 PASSED。

## 剩余零测试面

`check-snapshot-fingerprint`、`check-maintenance-docs`、`check-bounded-io`、`check-state-registry`、
`check-mcp-client-deps`（已补：snapshot-file-modes #815、snapshot-secrets 本条）。

