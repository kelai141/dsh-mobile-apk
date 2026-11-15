# Shizuku 虚拟屏输入/树/截图（可编译检查点）

日期：2026-11-14　工作树：`D:/coding/_dsh-wt/native-control-20261111/apk`

本文件记录本轮壳侧改动的契约、判据与未验证项。未跑 Gradle、未装设备、未热推。

## AIDL 事务（既有 1-17 编号与语义不变，协议版本 5 → 6）

| 编号 | 方法 | 说明 |
|---|---|---|
| 13 | `nativeSetTextReal(text, clear, deadlineMs)` | 保留：真实屏 display 0 |
| 14 | `nativeSnapshotReal(displayId, deadlineMs)` | 保留；现在接受调用方已校验的非 0 displayId |
| 15 | `nativeCaptureReal(deadlineMs)` | 保留：真实屏 |
| 17 | `nativeNodeReal(windowId, ...)` | 保留：真实屏 |
| 18 | `nativeDisplayCapabilities(displayId, alias)` | 新增：按屏实测位图 |
| 19 | `nativeSetTextDisplay(displayId, text, clear, deadlineMs)` | 新增：按屏焦点文本 |
| 20 | `nativeCaptureDisplay(displayId, alias, deadlineMs)` | 新增：按屏原始帧 |
| 21 | `nativeNodeDisplay(displayId, windowId, path, op, args, expected, deadlineMs)` | 新增：按屏节点 |
| 22 | `nativeMotionDisplay(displayId, op, argsJson, deadlineMs)` | 新增：按屏坐标手势 |

## per-display 能力位（方法 18）

- bit 0 焦点编辑器文本：该屏当下真的存在可写编辑器
- bit 1 原始树：该屏能枚举到窗口
- bit 2 节点读数/动作：该屏应用窗口能取到 root
- bit 3 原始帧：当场能解析出该 alias 的 SurfaceFlinger token
- bit 4 坐标手势：shell 的 `input` 可执行且该屏可枚举

display 0 仍走整条连接握手（bit0 点按、bit1 文本、bit2 树、bit3 帧、bit4 动效、bit5 节点）。

## 事实面

`NativeShizukuFacts` 存 `displayId -> (alias, bits)`，整表随连接代次/失效计数/TTL 一起作废；
对外输出 `displayOperations`（存在即 per-display 真源）+ `supportedOps`（各屏并集）。
一块屏都没测过时 `displayOperations` 整键缺席，`displaySupported`/`supportedOps` 回到 unknown。

`NativePlatformFacts` 只保留「真实屏 0 + 当前仍注册的虚拟屏」；已销毁屏的条目、其 op 并集一并收回。

## 截图 token

每次截图现跑 `/system/bin/dumpsys SurfaceFlinger`（不经 shell 管道），按行把
`name="DSH <alias>"` 配回其前面的 `Virtual Display <token>`。token 不缓存。
取不到 / 同一别名两个不同 token / 输出为空 一律返回 null，绝不退回无参 `screencap`。
查 token 只占调用方 deadline 的一半，给真正的 screencap 留余量。

## 目标纪律

- 虚拟目标必须 `VdisplayController.displayIdForAlias(alias) == plan.displayId`；
  否则 `implements()` 直接为 false，不会退回 A11y，也不会补「当前选中屏」。
- 编辑器只在该 displayId 的窗口里选；全局焦点落在别的屏时丢弃该节点。
- 节点动作按 `windowsOnAllDisplays[displayId]` 取窗口，只按 windowId 在其中匹配。
- 树只从该 displayId 的窗口列表选窗口。
- 坐标手势 argv 固定，displayId 是唯一可变目标 token；global/launchApp 仍限 display 0。

## 判据

- `app/src/test/.../NativeShizukuDisplayTest.kt`（新增）：per-display 精确性、别名匹配、
  断连/过期/整表覆盖、token 解析 fail-closed、坐标 argv、适配器准入。
- `app/src/test/.../NativeShizukuTreeTest.kt`（改）：删掉「只允许 display 0」的旧断言，
  改为「只读目标屏自己的窗口」。
- `app/src/androidTest/.../NativeShizukuVirtualDisplayDeviceTest.kt`（新增）：A11y 离线前提下
  树/点击/滑动/截图，以及虚拟屏可编辑夹具的中文替换、追加、清空 + 真实屏哨兵不变 + IME 不变。

## 未验证

未编译、未跑单测、未跑 instrumentation、未上设备。结构化括号检查仅证明文件未截断。

## 门控接线（主线程所有，本范围内只做核对）

- `NativeVdisplayExecution` 的 `executeAuthorized` lambda 已是 5 参，第 5 参 `authorize`；
  默认实现直接传 `VdisplayController.executeAuthorized(..., authorize = authorize)`。
- `VdisplayController.executeAuthorized/create/destroy/launchSettingsProbe/launchApp` 均接受可选
  `authorize`，只在 `createVirtualDisplay`、`release` 与实际 `am start` 紧邻处消费；
  耗时 `ensureBound` 之前不调用。
- `ShizukuTransport.runController` 的 `authorize` 在 `remote.exec` 紧前调用。
- 本轮未修改上述非 native 段；`NativeVdisplayExecutionTest` 的默认构造不受影响。

## Freeze checkpoint（编译修复后冻结，等待集成设备结果）

`NativeShizukuEditor.focusedEditor` 的 Elvis 链原先把 `AccessibilityWindowInfo` 推成可空
（`?: if (displayId == 0) null else appWindows.firstOrNull()`），导致 `window.root` /
`window.id` 编译报「未安全调用」。现改为先算 `fallback: AccessibilityWindowInfo?`，
再声明 `targetWindow: AccessibilityWindowInfo` 并 `?: return null` 收口；语义不变：
真实屏仍只认 focused/active，虚拟屏才允许退到该屏第一个应用窗口。

此后生产 Kotlin 不再改动，SHA-256 如下（`Get-FileHash -Algorithm SHA256`）：

| 文件 | SHA-256 |
|---|---|
| ShizukuUserService.aidl | 334D7D240FFDAAA0D483A64E3AF92CC06DDB575160E0EC2DC854CC1E97166DBF |
| NativeShizukuEditor.kt | 5FED2B1F78768FD4EDF6E1B4F99418717121FBE4437102C63C80C31C6F1FEE30 |
| NativeShizukuNode.kt | AB943E4430A9166CB441676CBDF609BACC40F4F158C437D071089CA3CA74B1DF |
| NativeShizukuTree.kt | C8F53B22B807D73E3283DEFDBD44EA8B9F65B55CFFB142316596FCB609AA88DC |
| NativeShizukuCapture.kt | 08B46D46C17E241C46E078CF603A2A3686FAF0B371F1D92F83257059E1BF4EC4 |
| ShizukuUserService.kt | A4AB1FABBE1C4FF866347575917A4E91D6B6E588B2BEE03306C87630FCD9C6BD |
| ShizukuTransport.kt | AE1E94719CF2EDEE88B6CC90A9367B9F45370059D60A9748A81B0E67525C825F |
| NativeShizukuExecution.kt | FD74AB631E0022F9B87D6BC39AB137195D36510863FBFF58D890D672DFDD9041 |
| NativeShizukuFacts.kt | A41BE4D58412541D4EA0BE38B643144DCB23104D7EA7FF2E6D590929E9696069 |
| NativePlatformFacts.kt | B74C360BABEE48DED9FD0072820B3C5E7C0085767F5C88C9FE34383BC85CECD4 |
| NativeShizukuMotion.kt | 8A01C747794D4D6E9D10CE02E1976221EDE0D75F6E8ED8A026FF7AB62B5C3BB2 |
| NativeShizukuDisplayTest.kt | 776DFD5B36571F8B25E00D3120CBF42CA50AF27D437BC9CA2A9423780CE76D63 |
| NativeShizukuVirtualDisplayDeviceTest.kt | 5F6C3048D86D30802F5A5258BF5E4FBD2D5F36F8FE48C0F7C30754A6CE1768CA |
| NativeControlClickFixtureActivity.kt | D669683C3A3AACED8D23A177195983C111A397AB738FC56F7E678D801D727275 |

## 全动作补齐（2026-11-14 第三轮 freeze）

用户明确「不只是输入，点击滑动等各种操作都要」，因此补齐下列能力，均为既有语义下的功能补全：

| 动作 | 真实屏 argv | 虚拟屏 argv | 说明 |
|---|---|---|---|
| click | `input tap x y` | `input -d N tap x y` | 与 nativeTapReal 并存（bit0） |
| longClick | `input -d D swipe x y x y 600` | 同（D=N） | 真实屏也显式带 `-d 0` |
| scroll | `input -d D swipe ...` | 同 | 方向 + 轴长比例换算线段 |
| swipe | `input swipe x1 y1 x2 y2 ms` | `input -d N swipe ...` | 任意起终点，反向/斜向合法；ms 50..2000，缺省 300 |
| keyEvent | `input keyevent CODE` | `input -d N keyevent CODE` | 只认 11 个固定名字 |
| global back | `input -d 0 keyevent 4` | `input -d N keyevent 4` | 带目标 display |
| global home/recents/menu/mediaPlayPause | `input -d 0 keyevent 3/187/82/85` | 拒绝 `target-unsupported` | 无 display argv，不得伪装真实屏 |
| global notifications/quickSettings/dismissNotificationShade | `cmd statusbar expand-notifications/expand-settings/collapse` | 拒绝 `target-unsupported` | 同上 |
| launchApp | `am start --display 0` | 拒绝 `invalid-display` | 跨屏启动始终真实屏语义 |

global 的真实屏动作共 8 条：back、home、recents、menu、mediaPlayPause、
notifications、quickSettings、dismissNotificationShade。binary 判断改为 `command.first()`：
recents 走的是 `input keyevent`，早前按动作名检查 CMD 会让它在只有 input 的机器上被误拒。

未实现且不应发布的能力：powerDialog、lockScreen、toggleSplitScreen、accessibilityShortcut
（无设备实测证据）。真实屏与虚拟屏都返回 `invalid-global-action`，不起进程。

对应判据（JVM，未跑设备）：

- `realScreenKeepsEveryVerifiedGlobalAction`：8 条动作逐条锁死 argv 与 `/system/bin/input` /
  `/system/bin/cmd` 的配对，防止 binary 判断再次退回按动作名猜。
- `virtualBackTargetsItsOwnDisplayAndOtherGlobalsAreRefused`：虚拟屏只放行 back，
  其余 7 条均为 `target-unsupported` 且不起进程。
- `unimplementedGlobalActionsAreRefusedOnEveryDisplay`：4 个未实现动作在 display 0 与虚拟屏
  都是 `invalid-global-action`。

keyEvent 固定映射：enter=66、tab=61、escape=111、backspace=67、delete=112、space=62、
up=19、down=20、left=21、right=22、back=4。Android 语义里 DEL(67) 是退格，
FORWARD_DEL(112) 才是删除，两者不能互换。

事实面：位 16 现在发布 `click / longClick / scroll / swipe / keyEvent / global`。
global 的 home/recents/notifications 由执行侧按动作拒绝，不靠能力位隐藏。

执行路由：`NativeShizukuExecution` 的真实屏集合加入 swipe/keyEvent/global；
虚拟屏坐标集合同；两者都要求目标别名在注册表里且 displayId 一致，缺 displayId 不补选中屏。

## 编辑器选点收紧（2026-11-14 第二轮 freeze）

你那条 nullable 主 patch 没有落到工作树；工作树里是我此前写的等价修正。此后又按评审收紧
`NativeShizukuEditor`，规则如下：

- 只认目标 display 应用窗口里的 `FOCUS_INPUT`。真实屏还要求该窗口本身 focused；
  虚拟屏只要焦点节点属于本屏应用窗口即可（不要求窗口 focused）。
- 全局焦点落在别的屏时直接丢弃该节点，不跨屏写入。
- 真实屏没有本屏焦点即 `focused-editor-unavailable`，没有兜底。
- 虚拟屏兼容兜底：只在该屏唯一应用窗口内遍历，且只接受窗口内**唯一**可写编辑器。
  出现第二个即 `focused-editor-ambiguous` 并拒绝，不再任取第一个；遍历触到节点预算也算歧义。
- 遍历双上限：`MAX_EDITOR_DEPTH = 40`、`MAX_EDITOR_NODES = 2000`。
- 节点归还：`Lookup.Found.release()` 一次归还候选与其祖先；探针路径（keepNode=false）
  返回前即归还，不含候选的子树根在递归返回后立即归还。

对应新增判据 `editorFallbackNeedsASingleWritableEditorAndStaysBounded`，并同步改写了
`editorOnlyPicksWindowsOfTheRequestedDisplay` 中对旧实现的源码断言。
