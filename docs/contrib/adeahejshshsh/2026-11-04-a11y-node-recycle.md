# 无障碍快照回收节点句柄（2026-11-04，issue #1361）

## 现象

API 26–32 的设备上连续几十轮 `android_ui_dump` + 点击后，动作层开始出现「行 N 已不存在（页面已变化）」
这类失败，而界面其实没变。

## 真因

无障碍快照全链不回收 `AccessibilityNodeInfo`：每次重建快照都新建最多 MAX_NODES 个节点并覆盖旧
`Snapshot`，旧树（`nodes` / `rowNodes`）直接丢弃。minSdk 26——API<33 上不 `recycle()` 会让节点池
逐步耗尽，`getChild` 开始返回 null，动作层把「拿不到节点」误报成「页面已变化」。

## 修法

- 新增 `recycleSnapshot(target)`：遍历 `rowNodes` 回收，按 **identity 去重**（`nodes` 与 `rowNodes`
  共享同一批实例，避免同一节点被 recycle 两次）；
- 换树前先回收旧树（`recycleSnapshot(snapshot); snapshot = fresh`）；
- 两处「清空快照」也改为先回收再置空。

API 33+ 起 `recycle()` 是 no-op（已废弃），调用无害。

## 复验

`A11yNodeRecycleTest` 两条：必须有 `recycleSnapshot` 且按 identity 去重、真的调用 `recycle()`；
换树与清空两条路径都必须先回收。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 5 红、改后 5 绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`DeviceControlService.kt` 锚点按分段偏移重钉，并修了几条指向 `}` / `)` 的旧锚点）。
- **未做设备验证**：本机无模拟器。长会话复验见 PR 验收卡。
