# 多问叠加时通知动作数溢出（2026-11-03，issue #1409）

## 现象

一条提问带 3 个问题、每问 2 个选项时，通知栏里「1 个回复 + 6 个选项 = 7 个动作」，折叠态只画得下
3 个；而 `questionNeedsAppEntry` 只看**单个问题**的选项数（`> 2`），此时返回 false，于是连
「打开应用作答」的入口都不加——第 2 个问题起用户既点不到，也没有任何引导。

## 真因

判据的计量单位错了：系统约束的是**动作总数**（折叠态能画几个按钮），而判据量的是**单个问题的
选项数**。单问 3 选项会被 `any { size > 2 }` 兜住，多问叠加却不会——两者的失效面不重叠，
于是多问这条路径从来没有判据。

## 修法

```kotlin
val optionActions = entry.questions.filter { it.options.size in 1..2 }.sumOf { it.options.size }
return 1 + optionActions > MAX_COLLAPSED_ACTIONS || entry.questions.any { it.options.size > 2 }
```

- `MAX_COLLAPSED_ACTIONS = 3` 是有名字的常量（不写裸 3）；
- 「1」= 直接回复那个动作，与 `addQuestionActions` 的实际加法一一对应；
- 单问 3 选项那条既有语义保留在 `||` 右半边（这种问题一个按钮都加不出来）。

顺带删掉一段**悬空的旧 KDoc**：`questionNeedsAppEntry` 的说明在插入 `resolveNotifyTarget` 时
被留在了另一个函数上方，且写的是旧口径（「选项多于两个」）。说明已随函数走。

## 复验

- `NotifyQuestionActionBudgetTest`：6 组输入覆盖「刚好占满 / 溢出 / 单问多选项」，外加两条源码契约
  （必须统计总动作数、上限必须是有名字的常量）。
- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机给出「判据模型对照」：
  同一份输入下旧判据对 `[2,1]` / `[2,2]` / `[2,2,2]` 全返回 false，新判据全返回 true——
  与 issue 的复现用例一致。源码契约部分改前 2 条红、改后 2 条绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器、装不了包。真机判读见 PR 验收卡。
