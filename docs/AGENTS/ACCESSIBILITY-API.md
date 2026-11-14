# ACCESSIBILITY-API.md — 无障碍控制通道 API 与权限面全量参考

> **权威数据来源**：本机 Android SDK `platforms/android-36/data/api-versions.xml`（API 级别）
> + AOSP `core/java/android/accessibilityservice/AccessibilityService.java` 源码
> （2026-09-10 抽取；SDK 升级后重跑 `node .deploy-tmp/0135/api-surface.mjs <api-versions.xml> <class>` 复核）。
>
> 本文件是**能力面与权限面**的唯一依据；实现与本文不一致时以源码为准并当场修正。
> 通道设计（队列协议/门禁矩阵/协作结论）见协调仓 `docs/A11Y-CONTROL-DESIGN.md`。

## 0. 一句话

无障碍通道**不是 ADB 的降级替代**：Android 11（API 30）起自带 `takeScreenshot()`（截屏不再需要 ADB）。
Android 13 起允许无障碍服务使用输入连接。2026-11-14 用 `javap` 复核 android-36 SDK：
标志定义在 `AccessibilityServiceInfo`，输入方法入口在 `AccessibilityService`，而非 `AccessibilityNodeInfo`。
当前产品文本输入由 `setText` 落 `ACTION_SET_TEXT`：真实屏的聚焦编辑器经 Shizuku shell 侧
`UiAutomation` 写入，节点目标由无障碍服务写入；应用**不注册输入法**，也不切换用户键盘。
无障碍输入连接（API 33+）尚未接入，也未验证设备兼容性。
真正只能靠系统面/ADB 的：**shell 执行、pm/dumpsys/appops 等系统面、以及 API <30 的字节级截图**。

## 1. 服务级能力（`AccessibilityServiceInfo.CAPABILITY_*` ↔ XML 属性）

| 能力常量 | API | XML 属性 | 本通道用法 |
|---|---|---|---|
| `CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT` | 18 | `canRetrieveWindowContent="true"` | 读节点树（已用） |
| `CAPABILITY_CAN_PERFORM_GESTURES` | 24 | `canPerformGestures="true"` | `dispatchGesture` 坐标兜底（已用） |
| `CAPABILITY_CAN_TAKE_SCREENSHOT` | **30** | **`canTakeScreenshot="true"`** | **`takeScreenshot()` 截屏（0.13.5 新增）** |
| `CAPABILITY_CAN_CONTROL_MAGNIFICATION` | 24 | `canControlMagnification` | 未用 |
| `CAPABILITY_CAN_REQUEST_TOUCH_EXPLORATION` | 18 | `canRequestTouchExplorationMode` | 不用（会改变用户触摸语义） |
| `CAPABILITY_CAN_REQUEST_FILTER_KEY_EVENTS` | 18 | `canRequestFilterKeyEvents` | 不用 |
| `CAPABILITY_CAN_REQUEST_ENHANCED_WEB_ACCESSIBILITY` | 18 | `canRequestEnhancedWebAccessibility` | 不用（已废弃方向） |
| `CAPABILITY_CAN_REQUEST_FINGERPRINT_GESTURES` | 26 | `canRequestFingerprintGestures` | 不用 |
| `FLAG_INPUT_METHOD_EDITOR` | 33 | （flag） | 公共 SDK 可用；本项目尚未接入与实测（文本输入已由 `ACTION_SET_TEXT` 承担，不需要输入连接） |

## 2. 服务 API（含 API 级别）

### 2.1 树与窗口

| API | 级别 | 备注 |
|---|---|---|
| `getRootInActiveWindow()` | 16 | 当前活动窗口根节点 |
| `getRootInActiveWindow(displayId)` | 33 | 指定屏 |
| `getWindows()` | 21 | 需 `flagRetrieveInteractiveWindows` |
| `getWindowsOnAllDisplays()` | 30 | 跨屏 |
| `getServiceInfo()` / `setServiceInfo()` | 16 | 动态只能改 eventTypes/feedbackType/flags/notificationTimeout/packageNames |

### 2.2 动作

| API | 级别 | 备注 |
|---|---|---|
| `performGlobalAction(action)` | 16 | 见 §3 |
| `getSystemActions()` | 30 | **设备实际支持的动作集合，必须以此为准** |
| `dispatchGesture(gesture, callback, handler)` | 24 | 点击/滑动/长按/多指；回调在指定 handler |
| `disableSelf()` | 24 | 自我停用 |

### 2.3 截屏

| API | 级别 | 说明 |
|---|---|---|
| **`takeScreenshot(displayId, Executor, TakeScreenshotCallback)`** | **30** | 回调给 `ScreenshotResult{hardwareBuffer, colorSpace, timestamp}`；`Bitmap.wrapHardwareBuffer(...)` 转位图；**限频约 333ms**（`ACCESSIBILITY_TAKE_SCREENSHOT_REQUEST_INTERVAL_TIMES_MS`） |
| `takeScreenshotOfWindow(windowId, …)` | 34 | 单窗口 |
| `GLOBAL_ACTION_TAKE_SCREENSHOT` | 28 | 走系统截屏（**存相册，不回传数据**）——API<30 的降级 |

失败错误码（`onFailure(errorCode)`）：

| 常量 | 含义 |
|---|---|
| `ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS` | 无障碍访问未就绪 |
| `ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT` | 调用过频（~333ms 间隔） |
| `ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY` | 无效 display id |
| `ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR` | 内部错误 |
| `ERROR_TAKE_SCREENSHOT_SECURE_WINDOW` | 窗口含 `FLAG_SECURE`（如银行/密码页） |

### 2.4 输入法与键盘

| API | 级别 | 说明 |
|---|---|---|
| `getSoftKeyboardController().switchToInputMethod(imeId)` | 24 | 切换输入法；本项目的文本输入不使用它 |
| `getSoftKeyboardController().setInputMethodEnabled(imeId, enabled)` | 33 | 启用/停用 IME（限同包） |
| `onCreateInputMethod()` / `getInputMethod()` | 33 | 配合 `FLAG_INPUT_METHOD_EDITOR` 获取无障碍服务的输入连接；本项目尚未接入，也没有应用内 IME |
| `getSoftKeyboardController().setShowMode(...)` | 24 | 软键盘显示策略 |

### 2.5 其他

| API | 级别 | 说明 |
|---|---|---|
| `getMagnificationController()` | 24 | 缩放 |
| `attachAccessibilityOverlayToWindow/Display` | 34 | 无障碍悬浮层（`TYPE_ACCESSIBILITY_OVERLAY`，免 `SYSTEM_ALERT_WINDOW`） |

## 3. 全局动作（`GLOBAL_ACTION_*`）

| 动作 | API |
|---|---|
| `BACK` / `HOME` / `RECENTS` / `NOTIFICATIONS` | 16 |
| `QUICK_SETTINGS` | 17 |
| `POWER_DIALOG` | 21 |
| `TOGGLE_SPLIT_SCREEN` | 24 |
| `LOCK_SCREEN` | 28 |
| `TAKE_SCREENSHOT` | 28 |
| `KEYCODE_HEADSETHOOK` / `ACCESSIBILITY_BUTTON` / `ACCESSIBILITY_BUTTON_CHOOSER` / `ACCESSIBILITY_SHORTCUT` / `ACCESSIBILITY_ALL_APPS` / `DISMISS_NOTIFICATION_SHADE` | 31 |
| `DPAD_UP` / `DPAD_DOWN` / `DPAD_LEFT` / `DPAD_RIGHT` / `DPAD_CENTER` | 33 |
| `MEDIA_PLAY_PAUSE` / `MENU` | 36 |

## 4. 节点动作（`AccessibilityNodeInfo.AccessibilityAction`）

| 动作 | API | 用途 |
|---|---|---|
| `ACTION_CLICK` / `ACTION_LONG_CLICK` | 21 | 点击 / 长按 |
| `ACTION_FOCUS` / `ACTION_CLEAR_FOCUS` | 21 | 焦点 |
| `ACTION_SET_TEXT` | 21 | **原子写入文本**（中文/空格/长文本可靠，绕开 IME） |
| `ACTION_SCROLL_FORWARD` / `ACTION_SCROLL_BACKWARD` | 21 | 上下滚动 |
| `ACTION_SCROLL_UP/DOWN/LEFT/RIGHT` | 23 | 方向滚动 |
| `ACTION_SCROLL_TO_POSITION` | 23 | 滚到指定位置 |
| `ACTION_SELECT` / `ACTION_CLEAR_SELECTION` / `ACTION_SET_SELECTION` | 21 | 选择 |
| `ACTION_COPY` / `ACTION_CUT` / `ACTION_PASTE` | 21 | 剪贴板 |
| `ACTION_EXPAND` / `ACTION_COLLAPSE` | 21 | 展开/折叠 |
| `ACTION_DISMISS` | 21 | 关闭 |
| `ACTION_SHOW_ON_SCREEN` | 23 | 滚到可见 |
| `ACTION_CONTEXT_CLICK` | 23 | 上下文菜单 |
| `ACTION_PAGE_UP/DOWN/LEFT/RIGHT` | 29 | 翻页 |
| `ACTION_PRESS_AND_HOLD` | 30 | 长按（新版） |
| `ACTION_IME_ENTER` | 30 | 触发输入法回车 |
| `ACTION_DRAG_START/DROP/CANCEL` | 32 | 拖放 |
| `ACTION_SHOW_TEXT_SUGGESTIONS` | 33 | 文本建议 |
| `ACTION_SCROLL_IN_DIRECTION` | 34 | 带方向的滚动 |

节点读取面（节选，级别见 SDK）：`getText` / `getContentDescription` / `getViewIdResourceName`(18) /
`getBoundsInScreen`(14) / `getBoundsInWindow`(34) / `isClickable` / `isEditable`(18) / `isScrollable` /
`isChecked` / `isVisibleToUser`(16) / `getHintText`(26) / `getTooltipText`(28) / `getPaneTitle`(28) /
`getCollectionInfo`(19) / `getActionList`(21) / `getExtras`(19) / `findAccessibilityNodeInfosByText`(14) /
`findAccessibilityNodeInfosByViewId`(18) / `refresh`(18)。

## 5. 权限面

| 层 | 要求 | 备注 |
|---|---|---|
| 清单 | `android.permission.BIND_ACCESSIBILITY_SERVICE` + `<intent-filter action="android.accessibilityservice.AccessibilityService">` | 只有系统可绑定；缺一即被系统忽略 |
| 服务声明 | `android:exported="true"` + `<meta-data android:name="android.accessibilityservice" android:resource="@xml/accessibility_service_config"/>` | 能力只能走 XML |
| 用户开关 | 系统设置 → 无障碍 → 已下载的服务 → 「DSH 设备控制」 | 一次性；`disableSelf()` 可自关 |
| Android 13+ | 侧载应用可能被「受限设置」挡住开关 | `appops set <pkg> ACCESS_RESTRICTED_SETTINGS allow`（本仓 `AdbState.unlockRestrictedSettings`，走 ADB 通道） |
| 截屏 | `canTakeScreenshot="true"`（API 30+） | 无额外运行时权限；`FLAG_SECURE` 窗口拒绝；~333ms 限频 |
| 手势 | `canPerformGestures="true"`（API 24+） | |
| 读树 | `canRetrieveWindowContent="true"` | |
| 多窗口 | `flagRetrieveInteractiveWindows` | |

**无障碍服务本身不需要额外危险权限**：不需要 `SYSTEM_ALERT_WINDOW`（无障碍层用 `TYPE_ACCESSIBILITY_OVERLAY`）、
不需要 root、不需要 Shizuku。这里说的是服务自身的绑定与能力声明；当前真实屏文本输入、原始帧与虚拟屏执行走 Shizuku 通道，需要用户另行授权 Shizuku，与本节的权限面是两回事。

## 6. 本仓实现映射

| 能力 | 落点 |
|---|---|
| 服务与能力声明 | `app/src/main/AndroidManifest.xml`（`DeviceControlService`）+ `res/xml/accessibility_service_config.xml`；权限面见 §5 |
| 树快照（路径 id + attrs 同构 uiautomator XML） | `NativeAccessibilityPlatform.snapshot`；`DeviceControlService` 只提供绑定实例 |
| 动作（click/longClick/setText/scroll/swipe/global/screenshot/nodeText/readRegion） | `NativeA11yExecution.execute` → `NativeAccessibilityPlatform`；`swipe` 接受任意两个不同端点，节点 `setText` 走 `setTextNode` |
| 真实屏聚焦编辑器 `setText`（Shizuku） | `NativeShizukuExecution` → `ShizukuTransport.nativeSetTextReal` → `NativeShizukuEditor.setText`；`ACTION_SET_TEXT` 后回读，不切换输入法 |
| 按键与虚拟屏全局动作 | `keyEvent` 只走 Shizuku 固定键码（`enter/tab/escape/backspace/delete/space/up/down/left/right/back`）；虚拟屏 `global` 只允许 `back` 且经 Shizuku，A11y 全局 API 不作用于虚拟屏（`NativeShizukuExecution.implements` + `guardGlobal`） |
| 控制客户端（私有 Unix socket + 原生计划） | phone-control 的 `native-client.ts` / `native-bridge.ts` → `NativeControlRuntime`；没有 HTTP 长轮询或心跳 |
| 状态与令牌 | `DeviceControlService.statusJson()` / `token()`；prefs `dsh-adb.xml` 的 `a11yEnabled` / `controlToken`。`prepareEnvironment` 由 `NativeEnvironmentExecution` 只关/恢复三项动画倍率，无输入法逻辑 |
| 桥方法 | `AndroidBridge.a11yStatus()/openA11ySettings()/unlockRestrictedSettings()`（MainActivity 接线）；绑定状态由 `DeviceControlService.statusJson` 提供 |
| 引擎侧门禁与路由 | 手机工具在 `plugins/dsh-android-phone-control`；能力、屏幕范围与通道由 Rust 计划决定；共享浏览器 op 才走 `plugins/dsh-android-bridge` |

## 7. 状态与待办（2026-11-14 文档对账；未执行设备验收）

代码面现状：`DeviceControlService` 只保留系统绑定、`nativePlatformService`、共享文件令牌与兼容 `WindowPick`；
语义树、动作与截屏在 `nativecontrol/NativeAccessibilityPlatform` 与 `NativeA11yExecution`；真实屏聚焦编辑器由
`NativeShizukuExecution` → `ShizukuTransport.nativeSetTextReal` → `NativeShizukuEditor` 写入并回读；手机工具经
phone-control 的私有 Unix socket 到 `NativeControlRuntime`，没有 HTTP 长轮询、没有心跳，也没有回填队列。
应用不注册输入法，`adb shell ime list -s | grep dsharnessmobile` 应为空。

待设备验证：原生宿主起停与 socket 存活；a11y 的快照、点击、输入、滚动与截屏；`virtual-only` 下仅靠 Shizuku
完成真实屏文本输入的执行与回读；虚拟屏的创建、输入、拉起与回收。以上均无本轮设备证据，JVM 用例通过只证明接线。

特权面现状：phone-control 已注册 `shExec`（只读查询，Rust `shell_policy.rs` 准入）、`rootExec`（独立 Root 授权）与 `termuxExec`（应用 UID）；`shPull/shPush/shRemove` 未注册。`ShellOps` 已物理删除，Root lease/fence 与 Shizuku 低层执行仍在。
但手机工具面当前不注册 `shExec/shPull/shPush/shRemove`。

已落地的代码面：服务与能力声明、树快照、click/longClick/setText/scroll/swipe/global、`takeScreenshot`、`nodeText` 与 `readRegion`，全局动作面由 `getSystemActions()` 驱动（`GlobalActionCatalog`），以及按 `ScreenScopePrefs` 在原生计划里复查屏幕范围。`swipe`、`keyEvent`、虚拟屏 `global back` 与 `prepareEnvironment` 只有 JVM/Rust 单测，尚无设备回执。
`getSystemActions()` 驱动（0.13.8 E6，`GlobalActionCatalog`），以及按 `ScreenScopePrefs` 在原生计划里复查屏幕范围。
旧「无障碍截屏失败回落 ADB」与 `DeviceControlService.realScreenScopeError` 已随旧控制链删除，不再作为现状描述。

待办：① 无障碍服务输入连接（API 33+）按需再评估，当前聚焦编辑器输入由 Shizuku `ACTION_SET_TEXT` 承担；
② 长按已接，展开/折叠/复制/翻页/拖拽等节点动作仍未暴露给模型；③ `takeScreenshotOfWindow`(34) 单窗口观察未接；
④ 多窗口：`getWindowsOnAllDisplays()` 与兼容 `WindowPick` 已在代码里，真正的原生窗口选择仍需设备验证；
⑤ API<30 只支持真实屏 display 0，虚拟屏直接回 `target-unsupported`（`NativeAccessibilityPlatform` 的 API 30 分支），
低版本真机行为未验。
完整缺口清单维护在 `known-gaps.md`（本文件只登记 API 参考与实现映射）。
