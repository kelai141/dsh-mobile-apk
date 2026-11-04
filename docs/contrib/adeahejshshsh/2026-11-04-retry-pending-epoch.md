# 陈旧重试先判世代再清闩（2026-11-04，issue #1356）

## 现象

陈旧的重试 runnable 跨世代执行时，会把**新一代**的 `RepairState.retryPending` 清掉。

## 真因

`postDelayed` 回调里的顺序是「先清闩、后判世代」：

```kotlin
engineMonitorHandler.postDelayed({
  RepairState.retryPending = false
  if (isCurrentEngineFlow(generation) && !RepairState.required(activity)) { ... }
}, delayMs)
```

新一代正在等自己的重试窗口，闩被旧回调误清 ⇒ 这段窗口里看门狗会去重启引擎。

## 修法

把世代判定提到清闩之前，并让后续分支不再重复判定：

```kotlin
if (!isCurrentEngineFlow(generation)) return@postDelayed
RepairState.retryPending = false
if (!RepairState.required(activity)) { ... }
```

## 复验

`RetryPendingEpochTest.先判世代再清闩`：在回调体内断言世代守卫的偏移量**小于**清闩点。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`EngineStartFlow.kt` 锚点按 +3 统一偏移后逐条补 `#expect`）。
- **未做设备验证**：本机无模拟器。
