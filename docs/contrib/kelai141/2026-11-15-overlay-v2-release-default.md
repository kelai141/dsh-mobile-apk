# 2026-11-15：悬浮 v2 进 release（默认开启），并补上盯默认值的判据

## 现象

用户装了正式包反馈「新悬浮样式根本没应用，好像还是旧基线」。查下来不是基线问题：

- `#1759` 的 22 个新 Overlay 文件**确实在包里**（在 APK 的 `classes.dex` 里能搜到 `OverlayV2` / `OverlayCommandDrawer` / `OverlayCardMorphVisual` / `OverlayPillView` / `OverlayEntryView`）；
- 但 `OverlayV2.enabled()` 读的 `overlay_display/entry_ui_v2` 缺省值是 **false**，所以 `OverlayService` 走的是旧三窗实现。

也就是说：**代码在包里，开关关着，而开开关的那把钥匙只在 debug 包里。**

## 真因：两个各自合理的设计叠成了「release 永远用不到」

1. `OverlayV2.kt:58` 缺省值 `false`，注释写「P7 验收通过后单独 PR 改为 true」；
2. 唯一能把该键写成 true 的运行期通道是 `OverlayLiveFeed.kt:40` 的 `.overlay-test-pending` 文件分支，
   而那条分支要求 `ApplicationInfo.FLAG_DEBUGGABLE`（`design.md:344` 明文「release 不进入该分支」）。

两条单独看都站得住，叠起来就是：**正式包没有任何办法打开 v2**。用户看到的永远是旧三窗。

而 `docs/overlay-refactor-2026-11/handoff-phase2.md:6` 其实早就写清了状态：
「P0 大部分 + P1-P5 代码已落地并编译通过、JVM 单测基本通过；**设备层（ADB 用户层）零验证；P6/P7 未开始**」，
`handoff-phase2.md:195` 更直接：「启动/截图：**未执行**：应用没启动、`entry_ui_v2` 没打开、无任何截图」。

## 修法

1. 抽出 `ENTRY_UI_V2_DEFAULT = true` 常量，`enabled()` 读它而不是写死字面量 ——
   让「默认开/关」有一个可被单测断言、可被文档引用的**单一事实位**。
2. `catch` 分支也回落到 `ENTRY_UI_V2_DEFAULT`。原来写死 `false`，一次 prefs 读失败就会静默退回旧实现，
   在用户侧表现为「新样式偶尔不见了」——比稳定不可用更难排查。
3. `PERSISTENT-DATA.md` 同步该键的默认值与理由。

保留回滚能力：显式写 `entry_ui_v2=false` 即回到旧三窗；`OverlayService` 有 prefs 监听，主线程切换，不需要重启服务。

## 判据（这是本次最关键的部分）

现有 36 个 `Overlay*Test.kt` 里**没有一个断言这个开关的默认值**——所以它能一路停在 `false` 而所有测试全绿。
新增 `OverlayV2ReleaseDefaultTest`（3 条，源码级反证）：

| 判据 | 守什么 |
|---|---|
| `defaultIsOnSoReleaseGetsV2WithoutDebugChannel` | `ENTRY_UI_V2_DEFAULT` 必须为 `true` |
| `enabledReadsTheConstantNotALiteral` | `enabled()` 必须读常量，且不得再出现写死的 `getBoolean(KEY_ENTRY_UI_V2, false)` |
| `prefReadFailureFallsBackToDefaultNotToOff` | `catch` 分支不得写死 `false` |

后两条是必要的：只断言常量的话，有人把 `getBoolean(..., false)` 写回去就能绕过常量静默变 off，而第一条仍然绿。

**实测**：
- 正跑：`BUILD SUCCESSFUL in 5m 7s`，3 项全过。
- 负控：把常量改回 `false`（其余不动）→
  ```
  OverlayV2ReleaseDefaultTest > defaultIsOnSoReleaseGetsV2WithoutDebugChannel FAILED
  java.lang.AssertionError at OverlayV2ReleaseDefaultTest.kt:35
  3 tests completed, 1 failed
  BUILD FAILED in 18s
  ```
  只红该红的那一条，另两条不动 —— 说明三条判据各守一面，不是互相顶替。恢复后 `git diff` 只剩预期改动。

## 未做设备验证

Kotlin 壳侧行为改动（L3）。已做代码层（编译 + 3 项单测 + 负控），**未做 CDP 层与 ADB 用户层**：
本轮要装机还需先构建 x86_64 快照包（模拟器是 x86_64，arm64 快照的包在模拟器上会 `EM_AARCH64 vs EM_X86_64` 启动失败）。
设备三层验收在包就绪后另行执行，未补验前不得当作 v2 已验收。
