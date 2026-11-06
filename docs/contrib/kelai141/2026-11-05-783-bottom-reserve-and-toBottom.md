# issue #783 复查：底部预留的两条通道 + 「回到底部」浮层的真因

对应改动：`fix(ui): 底部预留拆两条通道并挪到 RO 观察盒内侧（issue #783）`。

## 一、缺陷与真因

| 缺陷 | 用户可见形态 | 真因 | 判据 |
|---|---|---|---|
| A | 左侧抽屉底部、输入卡下方各一条 46 CSS px 纯黑带 | 壳侧只发布一条 `--dsh-android-system-bottom = max(navigationBars, mandatorySystemGestures)`，后者是**手势热区**不是遮挡物 | `BottomInsetPolicyTest`（JVM 纯函数）+ `mobile-drawer-bottom-inset.spec.ts` |
| B | 向上滑动时「回到底部」浮层压住最后一行正文，位置偏下 | 底部预留写在 `[data-composer-seat]` **自己**身上；Android WebView 114 上只改被观察元素自身 padding 时 ResizeObserver 不投递 ⇒ `--dsh-composer-height` 停在旧值 | `composer-insets-seat-height.spec.ts` + 真机 CDP 的 `clearance` 几何判据 |

两条缺陷共享同一个数值（46 = 138 物理 px / 3.0），但**不是同一个原因**：A 是「取值来源错」，B 是「落点选错导致上游变量不更新」。
#783 原 PR #1635 的归因（IME 双计）解释不了默认（无键盘）状态下的这条带子，因此本 PR 是补齐，不是回退。

## 二、修法

1. 壳侧拆两条通道（`BottomInsetPolicy.channels`）：`system` 保守值给贴底表面（sheet peek / 气泡上限 / 市场滚动），`navBar` 只算 navigationBars 给交互面（输入卡、抽屉）。
2. 页面侧两个消费者改用 `var(--dsh-android-navbar-bottom, var(--dsh-android-system-bottom, 0px))`：新壳用精确值，旧壳/桌面自动回落。
3. 输入卡的预留从 `[data-composer-seat]` 移到 `[data-composer-seat] [class*='composerStack']`；`keyboard-boundary.ts` 的归零对象同步改成「stack 优先、seat 兜底」。

## 三、为什么不是「删掉预留」

真正会遮挡的系统栏（三键导航、带 safe-area 的设备、打开着的底部 sheet）必须继续让开——PR #157 的原始诉求（设置入口被系统栏拦住）在那类设备上依然成立。
本 PR 只改**取值来源**与**落点**，不改「要不要让」。

## 四、设备实测（荣耀 CRT-AN00 / Android 14 / WebView 114 / density 3.0）

- `env(safe-area-inset-bottom)` = 0px，`--dsh-android-system-bottom` = 46px，`navigationBars.bottom` = 0，`mandatorySystemGestures.bottom` = 138 物理 px。
- 缺陷 B 的 A/B/A/B（每次整页重载）：缺陷态 `seatH 174 / published 128px / clearance -30`，修复态 `seatH 174 / published 174px / clearance +16`。
  `cardTop 893.3`、`cardBottom 991.3`、`bandUnderCard 75.7` 两侧完全一致 ⇒ 视觉零位移。
- 缺陷 A 的 A/B/A/B（抽屉打开态）：缺陷态 `padBottom 46px / bandUnderLowest 46`，修复态 `padBottom 0px / bandUnderLowest 0`。

## 五、边界（如实记录）

- 模拟器（127.0.0.1:16448）的 `dumpsys window displays` 在两种导航模式下都**没有底部 InsetsSource**，46px 带子无法在模拟器原生复现；该环境只能验几何与变量一致性，不能替代真机。
- 本 PR **未做设备验证**（AGENTS.md §4.2 铁律 ②）：几何证据来自真机 CDP 的注入式 A/B 对照，不是打包后的三层验收。
