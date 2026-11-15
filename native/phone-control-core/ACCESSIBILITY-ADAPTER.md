# 无障碍平台适配层（Kotlin 侧）测试计划

本文描述 `NativeAccessibilityPlatform` 的设备测试计划。它是 androidTest 的计划文档，
记录要断言的平台事实、判据与失败形态；本轮未新增或运行设备测试。

实现位置：`app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeAccessibilityPlatform.kt`。
服务入口：`DeviceControlService.Companion.nativePlatformService()`，只回既有绑定实例。

## 1. 职责边界

Rust `phone-control-core` 决定 backend、目标屏幕、范围与授权；本层只读 Android 事实、
采集原始树与原始帧、执行上层获准的调用。

| 本层做 | 本层不做 |
|---|---|
| 按给定 displayId 选窗口、采集原始树 | 选 backend、选目标屏、改 scope |
| 按 path 逐级真实 `getChild` 重定位 | 分配模型 ref、裁剪/格式化树、按 text 匹配 |
| 收集逻辑 bounds 与原始节点属性 | 复用旧 `ControlCarrier` / Node 队列 / `handle` |
| 发手势、全局动作、原始帧 | 压缩、缩放、裁剪、OCR、标尺 |
| 在真实调用前执行 `finalAuthorize` | 持有第二套权限、授权缓存或业务路由 |

树与帧的 shape 由 Kotlin 定义（`RawTarget` / `RawNode` / `RawFrame`），序列化与
JNI 字段映射留给 IPC 集成；本层不定义 wire 格式。

## 1.1 调用示例

服务在 Kotlin 侧取得实例（未连接时为 null）：

```kotlin
val service = DeviceControlService.nativePlatformService()
  ?: return reject("a11y-offline")
val platform = NativeAccessibilityPlatform(service)
val target = NativeAccessibilityPlatform.RawTarget(
  displayId = 41,
  screenId = "virtual-1",
  logicalWidth = 1080,
  logicalHeight = 1920,
  epoch = "1865592545886209",
  generation = "3",
)
```

采集原始树（`finalAuthorize` 只读、快返回；失败即 `executed=no`）：

```kotlin
platform.snapshot(target, finalAuthorize = { rust.validateDispatch(callId).valid })
  .thenAccept { outcome ->
    when (outcome) {
      is NativeAccessibilityPlatform.TreeOutcome.Ok ->
        rust.publishTree(outcome.tree.windowId, outcome.tree.nodes, outcome.tree.complete)
      is NativeAccessibilityPlatform.TreeOutcome.Rejected -> rust.reject(outcome.code)
    }
  }
```

节点动作显式携带 Rust 保存的 `windowId`，并带 Rust 侧校验（窗口或节点不符即拒绝，
不换控件）：

```kotlin
platform.clickNode(
  target = target,
  nodeTarget = NativeAccessibilityPlatform.RawNodeTarget(
    windowId = snapshotWindowId,       // 来自上一次 TreeOutcome.Ok.tree.windowId
    path = listOf(0, 2, 1),            // 与树里该节点的 path 完全一致
  ),
  verifyNode = { raw -> rust.isExpectedNode(target, raw) },
  finalAuthorize = { rust.validateDispatch(callId).valid },
)
```

平台层不保存窗口选择：`windowId` 由 Rust 在快照后记住，每次节点读取或动作再显式传入。

坐标点击、原始帧与全局动作：

```kotlin
platform.clickAt(target, 540, 960) { rust.validateDispatch(callId).valid }
platform.captureRawFrame(target) { rust.validateDispatch(callId).valid }
platform.globalAction(target.copy(displayId = 0, screenId = "real"), "back") { true }
```

能力表由实际 handler 派生，不另抄白名单：

```kotlin
val caps = platform.capabilities(displayId = 41)
// caps.ops: ["snapshot.tree", "click.point", ...]
// caps.unsupported: mapOf("screenshot.frame" to "target-unsupported:api-below-30")
```

## 2. 已实现 handler

`capabilities(displayId)` 返回的 `ops` 由 `handlerGuards` 现场派生，每个 op 执行与
实际派发相同的 guard，不另存白名单。当前注册项：

| op | 落点 | 前置 guard |
|---|---|---|
| `snapshot.tree` | `snapshot()` | `CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT`；API<30 仅真实屏 |
| `nodeText.node` | `nodeText()` | 同上 |
| `click.node` | `clickNode()` | 同上 |
| `setText.node` | `setTextNode()` | 同上 |
| `scroll.node` | `scrollNode()` | 同上 |
| `click.point` | `clickAt()` | `CAPABILITY_CAN_PERFORM_GESTURES`；API<30 仅真实屏 |
| `longClick.point` | `longClickAt()` | 同上 |
| `scroll.point` | `scrollAt()` | 同上 |
| `global.real` | `globalAction()` | display 0；`getSystemActions()` + `GlobalActionCatalog` |
| `screenshot.frame` | `captureRawFrame()` | API 30+；`CAPABILITY_CAN_TAKE_SCREENSHOT` |
| `readRegion.frame` | `captureRawFrame()` | 同上；区域裁剪由 Rust 完成 |

`RawCapabilities.unsupported` 为未通过 guard 的 op 与原因码。API<30 时
`screenshot.frame` / `readRegion.frame` 一律 `target-unsupported:api-below-30`；
虚拟屏的读树与手势同样拒绝，不会退回 display 0。

## 3. 树的契约

`RawNode.path` 是从窗口根出发的真实 child 下标序列，根为 `[]`。字段：

`className`、`packageName`、`viewId`、`text`、`contentDescription`、
`bounds: left/top/right/bottom`（`getBoundsInScreen`，逻辑空间）、
`clickable`、`scrollable`、`editable`、`checkable`、`checked`、`enabled`、
`focused`、`visible`、`selected`、`windowId`。

预算：最多 4000 节点、3 秒、单字段 65536 字符、单次合计 100 万字符、最深 40 层。
超限返回已采集部分，`complete=false` 且带 `stopReason`（`node-limit` /
`time-budget` / `char-budget` / `depth-limit` / `cancelled` / `tree-read-failed`）。
取消令牌在节点边界检查；取消同样返回部分树，不重试。

读树只选当前窗口：API 30+ 用 `getWindowsOnAllDisplays()[displayId]` 中 `displayId` 精确
相等、且 `isActive || isFocused`、`root != null` 的窗口；顺序为 active > focused > 第一个
可用窗口。API<30 只允许 display 0 的 `rootInActiveWindow`。

节点读取与节点动作（`nodeText` / `clickNode` / `setTextNode` / `scrollNode`）不参与上述
选择：它们只接受 `RawNodeTarget.windowId` 指向的窗口，即使该窗口已不再 active/focused 也
不换树，找不到返回 `window-mismatch`；`RawTarget` 的 displayId 仍必须精确匹配。路径越界
返回 `path-not-found`，不做文本/描述匹配，也不沿父链换控件。

平台层不保存 `windowId`、epoch 或 generation 的任何副本；这些状态由 Rust 持有并在每次请求
显式传入，因此不会出现第二份节点选择状态。

## 4. 动作与授权

节点动作接受上层 `verifyNode(rawNode)`：拿本次解析出的原始节点交给 Rust 校验，失败即
`executed=no / verify-failed`；回调抛错同样按校验失败处理。`finalAuthorize()` 在每个
真实 SDK 调用前执行一次，抛错按拒绝处理。手势的授权点紧贴在 `dispatchGesture` 之前：
gesture 与 callback 全部构建完成后才读最后一次授权，构建期间撤权也会得到
`executed=no / authorize-denied`，SDK 不被触碰。

| 结果 | 语义 |
|---|---|
| `executed=yes` | 平台已接受并报告完成（手势 `onCompleted`、节点动作返回 true、全局动作返回 true） |
| `executed=no` | 未触碰 SDK，或 SDK 明确立即拒绝（`dispatchGesture` 返回 false、`performAction` 返回 false、`performGlobalAction` 返回 false） |
| `executed=unknown` | 已发起后取消、异常或超时（`gesture-cancelled` / `gesture-timeout` / `dispatch-exception` / `node-action-exception`） |

`unknown` 不自动重试、不 fallback、不换控件。

坐标使用 `RawTarget` 的逻辑尺寸校验与解释；不读全局 WindowManager 整屏指标。
`GestureDescription.Builder.setDisplayId` 仅在 API 30+ 设置；API<30 的非 0 display 在
派发前被 `target-unsupported` 拒绝。`performGlobalAction` 只接受真实屏，虚拟屏返回
`target-unsupported`。

## 5. 原始帧

`captureRawFrame` 在 API 30+ 调用 `takeScreenshot(displayId, executor, callback)`，
把硬件缓冲转为 1:1 `ARGB_8888`，显式转到 sRGB；输出直通 RGBA
（`rowStride = width * 4`、`premultipliedAlpha = false`）。

原始尺寸与 `RawTarget` 逻辑尺寸完全相等时 `transform=identity`。Android 截屏不提供
权威 raw rotation 元数据，因此宽高互换或任何其它不一致一律返回
`frame-geometry-mismatch`；平台不猜 cw90/cw180/cw270，四旋转数学只在 Rust codec 单测
里验证。`FLAG_SECURE` 映射为
`secure-window`；限频映射为 `capture-throttled`。硬件缓冲、包装位图与中间位图在
finally 中关闭/回收。单帧原始字节上限 32 MiB。

区域阅读复用同一帧；平台不裁剪、不缩放、不编码。

## 6. 设备测试计划（待接入后执行）

前置：调试包已安装且无障碍服务已开启；测试通过
`DeviceControlService.nativePlatformService()` 取得实例，未连接时跳过并记
`service-offline`。以下用例在 API 30+ 设备与 API 26-29 设备各跑一次可跑项。

用例以「可观测的平台事实」为判据，不依赖模型文案：

| 编号 | 场景 | 判据 |
|---|---|---|
| T1 | `capabilities(0)` | `ops` 与 `unsupported` 互斥且并集等于注册表；API<30 不含截图两项 |
| T2 | 真实屏 `snapshot` | 根节点 path=`[]`；子节点 path 为真实下标；`complete` 与 `stopReason` 一致 |
| T3 | 授权拒绝 | `finalAuthorize` 返回 false 时 `executed=no / authorize-denied`，且无手势/截屏回调发生 |
| T4 | 坐标越界 | `clickAt` 越界返回 `invalid-coordinate`，SDK 未收到派发 |
| T5 | 手势完成与取消 | 正常点击 `gesture-completed`；中途 `disableSelf`/`onInterrupt` 造成取消时 `executed=unknown` |
| T6 | 节点 path 失效 | 采集后改变界面再点旧 path，返回 `path-not-found`，不得点到同位置其它控件 |
| T7 | verifyNode 拒绝 | 回调返回 false 或抛错时 `verify-failed`，目标控件状态不变 |
| T8 | 虚拟屏（API 30+） | 树/手势/截图只作用于该 displayId；无窗口时 `no-window-on-display`，不出现 display 0 的节点 |
| T9 | 虚拟屏全局动作 | `globalAction` 返回 `target-unsupported` |
| T10 | API<30 虚拟屏 | 树与手势返回 `target-unsupported:api-below-30` |
| T11 | 原始帧 | 尺寸等于逻辑尺寸，`rowStride=width*4`，`transform=identity`；像素与屏幕取样一致 |
| T12 | FLAG_SECURE | 返回 `executed=no / secure-window` |
| T13 | 截屏超时 | 人为阻塞回调超过 10 秒时返回 `executed=unknown / capture-timeout`，不重试 |
| T14 | 空树（游戏/自绘） | 根存在、`nodes` 只有根节点、`complete=true`，不是错误 |
| T15 | 取消 | 取消令牌置位后 `stopReason=cancelled`，节点数不超过取消时的已采数量 |
| T16 | 显式窗口 | 传入已消失或不属于该 display 的 windowId 时，四个节点入口均返回 `window-mismatch`，不动屏幕上同位置的其它窗口 |
| T17 | 构建期撤权 | 手势构建完成前撤权，最终为 `executed=no / authorize-denied`，无 `dispatchGesture` 调用与回调 |
| T18 | 帧几何不符 | 原始帧与逻辑尺寸不等（含宽高互换）时返回 `frame-geometry-mismatch`，不做旋转换算 |

每组用例记录：设备型号、API、displayId、`windowId`、`stopReason`、`executed`、
`code`、耗时与失败截图。任一项不符即失败，不使用「近似可用」判通过。

## 7. 未接线与未验证

- 本层默认不挂载：`NativeControlSocketServer`、JNI `validateDispatch` 与
  `settle` 尚未调用它；生产路径仍是旧系统分派。
- 树/帧的 JSON 或二进制编码未定义；IPC 集成需要另行约定字段映射。
- 未做设备验证：本文计划未在本轮执行，代码只做了单文件编译检查。
- 真机 API 26-29 的窗口与截图分支没有实测证据；届时以 T8/T10 补验。
- 游戏类自绘界面可能只有根节点或没有可交互节点（T14），本层如实返回，不推断控件。
