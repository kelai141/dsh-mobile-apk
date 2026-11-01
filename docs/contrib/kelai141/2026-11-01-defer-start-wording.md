# boot-fail 文案在刷新期误导：「无快照事务在场」与事实相反

## 现象（设备实证）

设备 `127.0.0.1:16448`，覆盖安装 v0.14.9 双 ABI 产物后冷启，boot-fail.log 原文：

```
stage=engine-start-deferred-no-transaction
detail=启动请求未获世代所有权（另一次启动流仍在占用），且无快照事务在场：
       本次请求未被受理，未拉起引擎...
```

```
stage=engine-start-deferred-no-transaction-timeout
detail=启动请求在 3000ms 重试预算内仍未取得世代所有权
       （另一次启动流仍在占用，且始终无快照事务在场）...
```

而当时真实情况是**快照正在解压**：引导页显示「正在解压运行时，需数分钟，请勿关闭」，
解压完成后引擎自行起来了（node pid 65166，端口 4145 LISTEN）。

「无快照事务在场」把排障者指向「什么都没发生」，与事实相反。

## 真因：journal 写入时机在解压之后

STAGED marker 由 `EngineManager.refreshSnapshot` 写到：

```kotlin
// EngineManager.kt:351
SnapshotTransaction.writeMarker(
  filesDir,
  SnapshotTransaction.Marker(SnapshotTransaction.Phase.STAGED, fingerprint, startedAt),
)
```

这一行排在**解压完成、swap 之前**。而解压本身要 8-12 分钟，所以整段解压期间
`SnapshotTransaction.readMarker(...) == null`。

设备证据正好落在这段：

```
boot-fail.log: transaction=absent, engineLog=empty, t_boot_start=1793514095440
```

`t_boot_start` 有值 + `engineLog=empty` ⇒ 启动流确实在跑，只是还没到写 journal 那一步。

这不是 journal 判据的 bug，是**文案把「暂时还没写 journal」说成了「没有事务」**。

## 修法：按事实源分档

判据用 `RepairState.startupInProgress`（= 本进程主启动流在跑）：

- `start()` 抢到所有权后立刻置 `true`（EngineStartFlow.kt:595）
- `finally` 里置 `false`（EngineStartFlow.kt:1125）

这与「谁在占所有权」是同一个事实源，而不是靠时间或日志猜。

两个分支各写各的：

| 状态 | 文案要点 |
|---|---|
| 刷新中（`startupInProgress = true`） | 点明「主启动流持有世代所有权，尚未走到写 journal 那一步，**这不代表没有事务在跑**」；timeout 档补「解压典型耗时 8-12 分钟，此时**不要**关闭应用或强杀进程」 |
| 确实无事务（`false`） | 明写「主启动流未在运行、journal 也为 absent」，保留原有的「下一次入口会重试」 |

刻意**不**把两者合并成一句「可能正在刷新」——那等于把判据降级成猜测，
排障者仍然读不出到底是哪一档。

## 回归用例

`NoTransactionStartRetryTest.theDeferredWordingDistinguishesRefreshFromGenuinelyNoTransaction`：

- 刷新档必须含「这不代表没有事务在跑」「主启动流持有世代所有权」
- 无事务档必须含「主启动流未在运行」
- 两条必须由 `RepairState.startupInProgress` 分流（不得只看 journal）
- timeout 档必须含「运行时刷新仍在进行」+ 可照做的处置（「不要」强杀）
- timeout 档**不得**再出现「且始终无快照事务在场」

## 顺带修掉的行号漂移

改动使 `EngineStartFlow.kt` 行数增加，`EXECUTION-MAP.md` 三个锚点失效
（`check-code-map` 判 `bad-anchor-content` 3 项）。按实际行号刷新：

| 锚点 | 旧 | 新 |
|---|---|---|
| `startupRecoverThenProbe` | 1728 | 1756 |
| `续跑一次，又撞回 L700` | 1197 | 1217 |
| 回执守卫 `override fun run()` | 1204 | 1224 |

## 复验

- `NoTransactionStartRetryTest` + `DeferredEngineStartTest` 通过
- 全量 `testDebugUnitTest` 通过
- `check-code-map` PASSED、`check-kotlin-comments` PASSED、`check-release-gates` PASSED
