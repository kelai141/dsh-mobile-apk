# `decodeV2` 只对 `o` 列做值域校验，`d` / `p` 越界会静默产出错深度与不存在的 ref

## 现象

`plugins/dsh-android-manage/src/protocol-v2.ts` 的 `decodeV2` 对载荷的每一列都有「整数数组 + 长度 1 或 n」
校验，而对 `o`（载荷行下标 → 原始行号）额外做了值域与严格递增校验（FX-206.1 的产物）。
同样被当**行号/深度**用的另外两列没有值域校验：

| 列 | 语义 | 越界时的后果 |
|---|---|---|
| `d` | 深度 | 预序单调栈按 depth 比较 ⇒ `subtreeEnd` / `parentId` / 渲染里的 `^nX` 父链一起偏，**静默** |
| `p` | 可操作祖先行下标 | `cacheFromV2` 之后 `index.ts` 把它拼成 `"n" + 该值` 当 ref 发出去 ⇒ 模型按它点得到「未找到目标元素」，归因落在「节点消失」而不是「载荷坏了」 |

## 证据（真机探针夹具 `ui-probe.xml`，393 原始行 → 86 载荷行）

用 `encodeV2FromRaw` 造一份合法载荷，再把某一列的**整列**换成同一个越界值（长度合法，只让值域越界）：

| 改动 | 修前 | 修后 |
|---|---|---|
| `o` 尾项 = 999999 | `ok:false`（`o[85]=999999 越界：…[0, rawCount=393)`） | 同（本来就有） |
| `p` 尾项 = 999999 | **`ok:true`**，`actionableAncestor[85]=999999` | `ok:false`（`p[85]=999999 越界：可操作祖先必须是 -1 或 [0, n=86) 内的行下标`） |
| `d` 尾项 = -5 | **`ok:true`**，`rows[85].depth=-5` | `ok:false`（`d[85]=-5 非法：深度必须是非负整数`） |
| `f` 尾项 = 2^31 | `ok:true` | `ok:true`（位域任意位合法，不在本条范围） |

## 修法

```ts
const depth = pick(cols.d, i, n)
if (!Number.isInteger(depth) || depth < 0) return { ok: false, error: `d[${i}]=… 非法：深度必须是非负整数` }
const anc = pick(cols.p, i, n)
if (!Number.isInteger(anc) || anc < -1 || anc >= n) return { ok: false, error: `p[${i}]=… 越界：可操作祖先必须是 -1 或 [0, n=…) 内的行下标` }
```

`-1` 是「无祖先」的合法哨兵，必须放行。广播列（长度 1）走同一条 `pick`，因此也被覆盖。

## 复验

- `node --test test/protocol-v2.test.mjs`：16 项全过（新增用例覆盖 `p` 越界 / `p < -1` / `d` 负值 / `p = -1` 放行 / `d` 广播列负值）
- 判据级变异：把两个守卫换成 `if (false)` 后**只红新增那一条**，其余 15 项不动；恢复后 16/16
- `check-code-map` / `check-kotlin-comments` / `check-bridge-symmetry` / `check-op-registry-parity` / `check-tool-output-schema` / `check-protocol-v2` / `check-plugin-tests` 全 PASSED

## 未覆盖面

- 本改动在**引擎侧**（TS）单语言，Kotlin 只有 `ControlProtocolV2.kt` 的编码器，没有对应解码器，无需同步。
- `f`（flag 位域）不做值域校验：任意位组合都是合法语义（下游只按已知位取）。
- 壳侧编码器理论上不会产出越界值；本条防的是「编码器回退/载荷被改/跨版本混用」这类情况下的**误诊**，
  与 FX-206.1 同一动机（宁可不给清单，也不给会点错的句柄）。
