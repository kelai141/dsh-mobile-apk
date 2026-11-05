# check-mcp-client-deps 的判别力自证（此前是零测试面）

## 这条门禁的由来

一条真实用户诊断包：引擎 boot 阶段硬崩 ——

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to import loader entry mcp-lark (@deepseek-ai/dsh-mcp-client):
  Cannot find package "@modelcontextprotocol/client"
```

而 `check-engine-overlay` 的正向闭包**拦不住它**：该宿主**不在我们装配的行面上**（是用户自己在
profile 里挂的 entry），缺口落在那条判据的定义域之外 —— 本地门禁结构性全绿，设备上必崩。

## 判据

「快照内 `@deepseek-ai/dsh-mcp-client` 的运行期依赖**闭包**必须可解析」。必须是闭包而非一层：
上游给 client 加一个带传递依赖的包时，只查一层同样会漏。

## 自证覆盖（造极小快照，`--snapshot` 指向）

```
PASS  合规快照（宿主只依赖在场的 dep-a）→ PASSED 且 exit 0
PASS  一层依赖缺 → FAILED 且点名 MISS 与设备后果（ERR_MODULE_NOT_FOUND）
PASS  传递闭包缺（dep-a 依赖 dep-deep-missing）→ FAILED（证明查的是闭包不是一层）
PASS  快照缺席（非 --require）→ SKIP(#1) 且 exit 0
PASS  快照缺席 + --require → 硬失败 exit 1
PASS  宿主包不在快照 → SKIP(#2)（上游裁包/改名，本门禁不适用）
MCP_CLIENT_DEPS_SELF_TEST_PASSED（6 项）
```

第 3 条是重点：它只对「闭包」成立，对「只查一层」不成立。

## 判据级变异（两个方向分离）

| 变异 | 结果 |
|---|---|
| 闭包遍历退化成只查宿主一层（`&& visited === 0`） | **只红第 ③**，输出「闭包遍历 1 个包」 |
| 撤掉 `host === null` 的 `SKIP(#2)` 分支 | **只红第 ⑥**（后续 `host.version` 直接 TypeError） |
| 恢复 | 6/6 全过 |

## 影响面

- 只新增 `--self-test` 分支，在 `const args = process.argv.slice(2)` 之前拦截；
  正常调用 `node scripts/check-mcp-client-deps.mjs [abi] [--snapshot <tar>] [--require]` 一字未动。
- 7 个门禁全 PASSED（含 `check-gate-skips`）。

## 这条路线到此收尾

`scripts/` 下 67 个脚本里原本有 7 条既无 `.test.mjs` 也无 `--self-test`，现已补六条：
file-modes(#815)、secrets(#816)、fingerprint(#817)、bounded-io(#818)、state-registry(#820)、
mcp-client-deps(本条)。剩 `check-maintenance-docs`（68 行，CI 里是提示 job、不阻断）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

