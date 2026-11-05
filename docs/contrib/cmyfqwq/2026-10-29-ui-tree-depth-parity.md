# pruneNodes 的 depth 漏了 -1：V1 路径比 V2 编码侧整体多一级（期望表还是死字段）

## 现象

同一份 XML，两条路径算出的深度不一致：

| 路径 | 代码 | 三层嵌套（原始 id 0 / 0.0 / 0.0.0） |
|---|---|---|
| V1 剪枝（ADB 回退） | `ui-tree.ts` 的 `pruneNodes`：`depth = id.split(".").length` | **1 / 2 / 3** |
| V2 编码 | `protocol-v2.ts` 的 `rowsFromRaw`：`depth = id.split(".").length - 1` | 0 / 1 / 2 |

`index.ts` 用 `n.depth` 做渲染缩进 ⇒ ADB 回退路径的清单比 V2 路径**整体多缩进一级**，同一个页面在两种通道下看到的层级不同。

## 为什么一直没被发现

`plugins/dsh-android-manage/test/ui-tree.test.mjs` 的 `expected` 表里明明写了 `depth: 0 / 1 / 2`，但下面的循环**只断言了 `parentId`**：

```js
for (const r of raw) {
  const e = expected[r.id]
  assert.ok(e)
  assert.equal(r.parentId, e.parent)   // depth 从来没被比过
}
```

⇒ `depth` 是**死字段**，实现算成 1 起始也一直绿。

同一处还有一个测试数据笔误：第 5 个节点 `bounds` 写成 `[540,0][100,100]`（右边界小于左边界）⇒ `parseBounds` 判 `w < 0` 直接丢节点 ⇒ 这份「5 节点」夹具实际只有 **4 个幸存者**，`expected` 里的 `0.1` 那一行从来没被验证过。

## 修法

1. `pruneNodes` 的 `depth` 补 `-1`（0 起始，根 = 0），与 `rowsFromRaw` 同源；
2. 测试把 `depth` **真断言上**（按 DFS 顺序比对整条序列）；
3. 修掉 `0.1` 的 `bounds` 笔误（改为 `[540,0][640,100]`），让第 5 个节点真的进入被断言集合。

## 证据

```
修前：pruneNodes depth: n0=1 n1=2 n2=3     rowsFromRaw depth: 0=0 0.0=1 0.0.0=2
修后：pruneNodes depth: n0=0 n1=1 n2=2     rowsFromRaw depth: 0=0 0.0=1 0.0.0=2   <- 一致
```

## 判据级变异

把 `pruneNodes` 的 `-1` 撤掉 ⇒ **只红新增那条 depth 断言**（pass 10 / fail 1），恢复 11/11。

变异脚本这次带**前置闸门**（`git status --porcelain` 有非 `.tmp` 改动就 `exit 1`）。上一轮我又一次把未提交的修复用 `git checkout --` 抹掉了 —— 纪律落进脚本才不会再犯。

## 复验

- manage 全量单测 **113 项全过**（ui-tree 11 项 + 其余）
- `check-code-map` / `check-kotlin-comments` / `check-bridge-symmetry` / `check-op-registry-parity` / `check-tool-output-schema` / `check-protocol-v2` / `check-plugin-tests` 全 PASSED

