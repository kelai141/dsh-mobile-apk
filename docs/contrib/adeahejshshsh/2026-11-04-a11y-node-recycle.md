# 无障碍快照回收节点句柄（2026-11-04，issue #1361）

## 现象

API 26–32 的设备上连续几十轮 `android_ui_dump` + 点击后，动作层开始出现「行 N 已不存在（页面已变化）」
这类失败，而界面其实没变。

## 真因

无障碍快照全链不回收 `AccessibilityNodeInfo`：每次重建快照都新建最多 MAX_NODES 个节点并覆盖旧
`Snapshot`，旧树（`nodes` / `rowNodes`）直接丢弃。minSdk 26——API<33 上不 `recycle()` 会让节点池
逐步耗尽，`getChild` 开始返回 null，动作层把「拿不到节点」误报成「页面已变化」。

## 修法

- 新增 `GenerationalNodeRecycler`：**延迟一代**回收。`retired` 只保留一代，新一代到来时才把上一代
  真正回收 ⇒ 节点最多跨一次重建存活，动作即使跨锁 `performAction` 也有一代的时间窗（方案 B，
  维护者裁定）。按 **identity 去重**（`nodes` 与 `rowNodes` 共享同一批实例）。
- 换树前先换代（`nodeRecycler.retire(nodes.values, rowNodes); snapshot = fresh`）；
- 两处「清空快照」也改为先换代再置空。

## 后续补齐（同 PR，#1521 / #1522）

`#1361` 只治了主路径，另外两处由同文件的后续 issue 补齐——都是同一条生命周期逻辑，一次改对：

### #1521 兜底重定位的节点从不回收

`resolveTarget` 的兜底路径（`nodeAtChildPath` / `nodeByFingerprint`）每次 `obtain` 新节点，
**不进 `rowNodes`**，因此不受换代覆盖，API<33 上仍然泄漏。

修法：给回收器加 `adopt(vararg nodes)`，把兜底节点**收编进当前一代**，随下一次换代或 `drain`
真正回收。**不是就地回收**——动作还带着它出锁 `performAction`，就地回收就是 `#1510` 的
use-after-recycle。收编与 `rowNodes` 共享同一个安全窗。

线程安全：`retire` 在服务锁内调用、`adopt` 在动作路径锁外调用，两者不同源。三个换代方法各自
`@Synchronized`（独立监视器），内部不回头取服务锁，避免锁序反转。

### #1522 回收点没有 SDK_INT<33 守卫

旧实现无条件 `runCatching { node.recycle() }`：API≥33 上调了也看不出来（平台已是 no-op），
回收失败也被吞掉，无法从日志判断到底回收了没有。

修法：判定**注入**到构造参数 `sdkInt: Int = Build.VERSION.SDK_INT`，`shouldRecycle = sdkInt < 33`；
失败改为落一行日志（`LogCollector.log("dsh-a11y", ...)`）而不是静默吞掉。

为什么注入而不是直读：直读静态字段只能在跑测试的那一档上验证（JVM 单测里 `SDK_INT` 恒 0），
另一档永远测不到。注入后两个方向都能断言。`sdkInt` 放在末位参数之前且带默认值，
生产调用点 `GenerationalNodeRecycler<AccessibilityNodeInfo> { node -> node.recycle() }` **一字未改**。

## 复验

行为判据（假节点 + 可注入 recycle 计数），不是源码文本：

- `sharedInstanceIsRecycledOnlyOnce` / `nodeOnlyInNodesIsStillRecycled` / `retiredGenerationSurvivesOneRound` / `secondGenerationRecyclesExactlyTheFirst` / `drainRecyclesTheRetainedGeneration`（#1361 原判据）
- `apiBelow33MustRecycle` —— 注入 32，换代必须真的调 recycle
- `api33AndAboveMustNotRecycleAndMustNotThrow` —— 注入 33，一次 recycle 都不许发生且不抛
- `recycleFailureIsNotSwallowedSilently` —— 失败仍记账一次尝试
- `adoptedFallbackNodeIsRecycledOnNextGenerationNotImmediately` —— 收编不就地回收，下一次换代才回收
- `adoptedNodeStillHeldBySnapshotIsNotDoubleRecycled` —— 同一实例不得回收两次
- `drainRecyclesAdoptedFallbackNodes` —— 服务销毁把收编节点也收干净

源码契约两条（接线补充，不替代行为判据）：`serviceWiresTheDeferredRecycler`、
`teardownDefersRecycleInsteadOfRecyclingInPlace`。

### 负控（都真打过）

| 把实现改坏成 | 变红的用例 |
|---|---|
| 去掉 `shouldRecycle` 守卫（回到无条件 recycle） | `api33AndAboveMustNotRecycleAndMustNotThrow` |
| `adopt()` 改成就地 `recycle` | `adoptedFallbackNodeIsRecycledOnNextGenerationNotImmediately` + `adoptedNodeStillHeldBySnapshotIsNotDoubleRecycled` + `drainRecyclesAdoptedFallbackNodes` |
| 去掉 `DeviceControlService` 的 `nodeRecycler.adopt(` 接线 | `serviceWiresTheDeferredRecycler` |

## 零位移

生产侧只动 `DeviceControlService.kt` 的两处：`resolveTarget` 兜底分支（+5 行，替换原有 2 行）
与 `SnapshotNodeRecycler.kt` 本身。构造器参数顺序调整后，生产调用点保持原样。

## 未做设备验证

本机无模拟器。**显式标注：未做设备三层验收**；`#1521`/`#1522` 的复现条件（API<33 设备长会话）
需要真机或 API<33 模拟器，见 issue 的「复现」段。
