# PR — `sweepExpired` 移出 onCreate 主线程（性能审计 #5）

## 改了什么

`MainActivity.onCreate` 里的 `FileIncoming.sweepExpired(this)` 从**主线程同步调用**改为 daemon 线程执行。

```kotlin
// 改动前
try { FileIncoming.sweepExpired(this) } catch (_: Throwable) {}

// 改动后
Thread({
  try { FileIncoming.sweepExpired(this) } catch (_: Throwable) {}
}, "dsh-incoming-ttl-sweep").apply { isDaemon = true }.start()
```

## 为什么这是主线程成本

`sweepExpired` → `sweepWorkspace` 会：
1. `listFiles()` 整个来件临时工作区（含子目录）；
2. 对 `.sessions` 下**每个 json 各做一次 `readText` + `JSONObject` 解析**（`queuedSessionPaths`）；
3. 逐条 `stat` 比对 TTL。

TTL 是 7 天，**上界无硬限**——重度用户可以让 `.sessions` 累积数百条，这段成本随之线性增长。
这是本 Activity 唯一一处「随用户来件量增长」的主线程冷启成本。

## 为什么挪走是零行为变化

1. **语义**：只删「7 天前的过期临时文件」。早两秒晚两秒对用户没有任何可观测差异。
2. **与来件处理的顺序不构成正确性问题**：新来件 `age = 0`，永远不在 TTL 删除集里（`sweepWorkspace` 只删 `lastModified < now - TTL_MS` 的项）。
3. **异常语义不变**：仍原样吞掉（清扫失败不得影响启动）。
4. **`FileIncoming` 内部另外两处 `sweepExpired` 调用未动**——它们在投递前同步执行（`withIncomingDeliveryAfterSweep`），那里需要同步语义，本 PR 不碰。

## 前后数值

| 指标 | 改动前 | 改动后 |
|---|---|---|
| `onCreate` 主线程上的目录遍历 | 1 次（随 `.sessions` 条数线性） | **0 次** |
| 主线程上的 JSON 解析次数 | N（N = `.sessions` 条目数） | **0** |
| 主线程上的 `stat` 次数 | M（M = 工作区文件数） | **0** |
| 后台线程 | — | +1 个 daemon（不阻塞进程退出） |

**收益量级未量化**：需要设备 + 真实来件量样本才能给秒数（已在审计报告 §7「不可测清单」中列明）。
本条的价值是**消除一条随使用量增长的主线程路径**，而不是省下某个确定的毫秒数。

## 测试与门禁

| 项 | 结果 |
|---|---|
| `:app:compileDebugKotlin` | BUILD SUCCESSFUL |
| `:app:testDebugUnitTest`（全量） | BUILD SUCCESSFUL |
| `check-kotlin-comments.mjs` | PASSED |
| `check-code-map.mjs` | PASSED（锚点 1102 不变，见下） |

## 执行地图锚点

插入 4 行使 `MainActivity.kt` 后续锚点漂移，按上一 PR 已确立的正途处理：
`--refresh-anchor-baseline --force-drift` 重钉 + 逐条核对。
本次 diff 规模显著小于上一 PR：**基线 JSON 45 增 / 43 删**（上一 PR 为 126/439），
因为只有 `MainActivity.kt` 一个文件位移。锚点数 **1102 → 1102 不变**。
另修 1 条 `#expect` 行号（`webView.addJavascriptInterface(` 从 1539 → 1553）。

## 风险与验证档位（**未做设备验证**）

- 风险：**低**。异常语义、TTL 语义、与来件处理的顺序全部不变。
- 档位：L3（壳侧行为改动）⇒ 按铁律 2 需即时三层验收。
- **本轮设备全部关闭，未执行设备验证。** 进入发版候选前必须补：
  - ADB 用户层：造一个 8 天前的临时来件 → 冷启动 → 确认被清掉（证明后台清扫确实执行）；
  - ADB 用户层：冷启动后立刻发来件 → 确认新来件不被误删（证明 age=0 豁免成立）。
