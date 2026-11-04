# 冻结自愈可以重新武装（2026-11-04，issue #1355）

## 现象

同一进程内第二次渲染进程冻结时，看门狗只落一行「检测到冻结」的日志、不 reload，界面永久停在
"Loading plugins…"，除杀进程没有出口。

## 真因

`freezeReloaded` 是「本次页面生命周期内只自愈一次」的闸门，但**没有任何复位点**：置位之后
永远是 true。第一次冻结消耗掉它，第二次就没有动作了。

## 修法

把复位点放在 **JS 应答回调**里（`evaluateJavascript("1")` 的回调中 `jsAckAt = now` 之后）：

```kotlin
jsAckAt = System.currentTimeMillis()
pingOutstanding = false
freezeReloaded = false   // issue #1355
```

为什么不放在 issue 建议的 `startFreezeWatchdog()`（`onPageFinished` 调用）：那里只代表**文档加载完**，
JS 可能仍然死着——reload → onPageFinished → 复位 → 再判冻结 → 再 reload，就是一个 65 秒一圈的
reload 循环。应答回来才是「页面确实在跑」的证据，以它为复位点既恢复自愈能力，又不会打转。

## 复验

`FreezeRecoveryReArmTest` 三条：① 应答回调里必须复位；② 不得在 `startFreezeWatchdog` 里复位
（防以后改回去造成循环）；③ 置位/复位必须成对存在（`= false` 恰好两处、`= true` 恰好一处）。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 2 条红，
  改后 4 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。两次冻结的真机复验见 PR 验收卡。
