# `text:` / `desc:` / `rid:` 的空值会静默命中空字段节点

## 现象

`resolveRef`（`plugins/dsh-android-manage/src/ui-tree.ts`）里三条复合前缀是**线性字段比对**：

```ts
const cands = pool.filter((n) => (kind === 'text' ? n.text === t : kind === 'desc' ? n.desc === t : n.rid === t))
```

目录里只要恰好只剩**一个**「该字段为空」的节点（很常见：说明性 TextView、占位 View），`text:`
就会单匹配命中它并返回 `ok`——模型漏写值的手误于是变成一次**看似成功的点击**，落到完全无关的节点上。

探针（桩：根容器 `text="容器"`，子树里恰好一个 `text=""` 的 TextView）：

```
节点: n0("容器") n1("确定") n2("")
text:   -> ok -> n2      <- 空值被静默接受
desc:   -> FAIL（匹配多个）
rid:    -> FAIL（匹配多个）
id:     -> FAIL（byId 无 "" 键）
```

`id:` 因为 `byId` 没有 `""` 键天然被拒，另外三条在「单匹配」时行为不一致。空值属畸形输入，
应统一 fail-closed。

## 修法

剥掉消歧后缀（`#N` / `@nX`）之后、进匹配之前，若 `t === ''` 直接拒，并给出正确写法引导：

```
ref "text:" 的值不能为空——请写成 text:<具体值>（例如 text:确定）
ref "rid:"  的值不能为空——请写成 rid:<具体值>（例如 rid:com.app:id/btn）
```

守卫放在后缀剥离**之后**，所以 `text:@n0`（空值 + 作用域）也会被拒。

## 复验证据

新增 `plugins/dsh-android-manage/test/ui-tree-ref-empty-value.test.mjs`（4 例）：

| 用例 | 断言 |
|---|---|
| `text:` 空值被拒 | 先断言「确实只有一个空文本节点」（保证测到单匹配陷阱），再断言文案含 `值不能为空` |
| `desc:` / `rid:` 同拒 | 四条前缀行为一致 |
| 带作用域后缀的空值也拒 | `text:@n0` 同样被拒 |
| 回归护栏 | `text:确定` 仍命中；`text:容器#1` 仍命中；全空 ref 仍走更早的 `ref 为空` 文案 |

- 修后 **4 pass / 0 fail**
- **变异反证**：删掉空值守卫（`if (t === '')` → `if (false)`）⇒ **1 pass / 3 fail**，回滚 4/0
- 插件全量 `test/*.test.mjs` → **117 pass / 0 fail**
- 门禁：`check-plugin-tests` / `check-protocol-v2` / `check-tool-output-schema` /
  `check-kotlin-comments` 全 PASSED

## 已知边界

1. `id:` / `num:` 空值走的是既有分支（`id "" 不在最近一次取树结果中…`），文案不同但同样拒绝——
   本轮只统一了**会静默接受**的那三条。
2. `check-code-map` 在 `origin/main`（`f9c3dd28`）上**本来就 FAILED（145 项）**（`#718` 合入更严格的
   锚点内容判据后暴露的存量漂移：37 项 `anchor-content-drift` + 3 项 `missing-anchor-expectation` 等）。
   本 PR 改的 `ui-tree.ts` 不在失败清单里（`grep -c ui-tree` = 0），未引入新增项。
3. 只加守卫，命中语义一字未动（`text:nN` / `desc:` / `rid:` / `#N` / `@nX` 正常路径行为不变）。
