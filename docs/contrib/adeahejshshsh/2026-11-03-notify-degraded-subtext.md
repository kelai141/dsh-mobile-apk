# 降级告示不再覆盖「仅本次生效」（2026-11-03，issue #1407）

## 现象

审批通知先写 `setSubText("仅本次生效")`，紧接着的降级告示分支又无条件
`setSubText(degradedNotice)` 把它顶掉。用户看到的是渠道降级说明，「仅本次生效」消失——
一次性授权被当成长期授权。代码上方注释写的正是「**不覆盖更具体的 subText**」，实现与注释相反。

## 真因

`NotificationCompat.Builder` 没有 `getSubText()`，于是「当前是否已有 subText」这件事在
`build()` 里无处可查；降级告示那段只能按「传了就写」处理，注释里的约束没有落到代码上。

## 修法

把「哪些 face 自带 subText」显式成一张纯函数表 `hasSpecificSubText(face, count)`：

| face | 是否自带 subText | 来源 |
|---|---|---|
| SILENT | 仅 `count > 1` | 「共 N 条」 |
| TODO | 是 | 「步骤 d/t」 |
| REPORT | 是 | `UserCopy.reportMetaLine` |
| APPROVAL | 是 | 「仅本次生效」 |
| QUESTION | 否 | 信息在 contentText / BigText |

降级告示改为 `if (degradedNotice != null && !hasSpecificSubText(face, entry.count))`。
表是纯函数，JVM 单测直接钉住；新增分支忘同步会红。

## 复验

- `NotifyDegradedSubTextTest`：① 纯函数矩阵（审批/进度/汇报占用，单条静默不占用，多条静默占用，
  提问不占用）；② 源码契约——降级告示必须经过这张表，且不得回到无条件覆盖的写法。
- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机用同判据脚本对源码求值：
  改前 2 条全红，改后 2 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器、装不了包。降级路径的真机复验见 PR 验收卡。
