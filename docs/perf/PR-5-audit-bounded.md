# PR — `audit.ndjson` 有界写（性能审计 #2）

## 改了什么

`ControlAudit.appendTo` 从「每条 open+write+close，无上限」改为「复用句柄追加 + 超 2MB 保留尾部 500 行」。

```kotlin
// 改动前
fun appendTo(auditDir: File, record: JSONObject) {
  auditDir.mkdirs()
  File(auditDir, "audit.ndjson").appendText(record.toString() + "\n")
}
```

改动后：`FileOutputStream(file, true).use { ... }` 追加，`finally` 里做 `rollIfOversized`。

## 两个独立问题，一次修掉

### 问题 1：每条记录 open/close 一次（11.2x 负控确证）

宿主 A/B 负控（同机、同数据、交替 2000 次）：

| 形态 | 每条耗时 |
|---|---:|
| 改动前（open+append+close） | **274.2 us** |
| 改动后（复用句柄） | **24.5 us** |
| 加 fsync（**未采用**） | 25.7 us |

**11.2x**。关键发现：加 fsync 只贵 5%——也就是说旧形态为每次 open/close 白付了 11 倍代价，**却没换来任何耐久性**（它本来就不 fsync）。

### 问题 2：全仓唯一没有上限的运行时状态文件

插件侧同一个写者（`plugins/dsh-android-bridge/src/index.ts:154-160`）早就做了 >2MB 保留尾部 500 行的滚动；
**壳侧没有**——于是 `audit.ndjson` 只增不减，按 1000 条/天推导年增 ~106 MB。

## 口径对齐（关键）

两侧写**同一个文件** `files/audit/audit.ndjson`，滚动口径必须一致，否则取证面分叉：

| 参数 | 插件侧 | 壳侧（本 PR） |
|---|---|---|
| 阈值 | 2 MiB | `MAX_AUDIT_BYTES = 2L * 1024 * 1024` |
| 保留 | 尾部 500 行 | `KEEP_TAIL_LINES = 500` |

单测 `constantsMatchPluginSide` 钉住这两个常量——**口径一旦分叉立刻判红**。

## 为什么不 fsync

审计不是事务日志：崩溃丢最后几条可接受，而 fsync 在每条记录上会拖慢授权路径。
负控已证明当前形态的 11x 代价**不是**为耐久性付的（加 fsync 仅 +5%），所以「复用句柄 + 不 fsync」是这两者里更优的一侧。

## 前后数值

| 指标 | 改动前 | 改动后 |
|---|---:|---:|
| 单条记录写入 | 274.2 us | **24.5 us（-91%）** |
| 文件大小上限 | **无** | 2 MiB |
| 超限行为 | 无限增长 | 保留尾部 500 行 |
| 与插件侧口径 | 分叉 | 一致（单测钉住） |

## 测试

`ControlAuditBoundedTest` 4 例（JVM，TemporaryFolder 直驱，无 Mockito）：

| 用例 | 守什么 |
|---|---|
| `appendsOneLinePerRecord` | 追加语义不变：一行一条、每行可 `JSONObject` 解析 |
| `constantsMatchPluginSide` | 2MB / 500 行与插件侧一致（**口径分叉即红**） |
| `rollsWhenOversizedAndKeepsTail` | 超限后回到上限内、保留 500 行、**最后一行是刚追加的那条**（不被滚动吃掉） |
| `underLimitDoesNotRoll` | 未超限不滚动 |

**一次真实失败记录**：`rollsWhenOversizedAndKeepsTail` 初版判红，原因是我把前置数据估小了——
12000 行 × ~115 B ≈ 1.4 MB，没超过 2 MB 门槛。**是测试自身的前置断言抓到的，不是实现缺陷**；
改成 24000 行（≈2.8 MB）后通过，并在注释里写明了这个估算坑。

## 门禁

| 项 | 结果 |
|---|---|
| `:app:testDebugUnitTest`（全量） | BUILD SUCCESSFUL |
| `check-code-map.mjs` | PASSED（锚点 1102 不变） |
| `check-kotlin-comments.mjs` | PASSED |
| `check-perf-instrumentation.mjs` | PASSED |

## 风险与验证档位（**未做设备验证**）

- 风险：**低-中**。追加语义、异常吞没语义不变；新增滚动路径有单测覆盖。
- 档位：L2/L3（审计属安全敏感取证面）⇒ 按铁律 2 需即时三层。
- **本轮设备全部关闭，未执行设备验证。** 进入发版候选前必须补：
  - ADB 用户层：造 >2MB 的 audit.ndjson → 触发一条审计 → 确认文件回落到 ~500 行且最后一行是新记录；
  - 取证一致性：确认插件侧与壳侧滚动后格式仍可被同一解析器读取。
