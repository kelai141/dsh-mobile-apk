# 悬浮交互系统重构 Phase 2 交接文档（施工中止快照）

> 生成时间：2026-11-11 22:20（Asia/Shanghai）。
> 结论状态：**P0 大部分 + P1-P5 代码已落地并编译通过、JVM 单测基本通过；设备层（ADB 用户层）零验证；P6/P7 未开始。**
> 本文只记录事实与操作方式，不宣称任何未经真实设备验证的功能「可用」。

---

## 1. 一句话现状

- v2 悬浮系统（入口/卡片/药丸/输入区/命令抽屉）的壳侧代码已全部写完并编译通过，新增 JVM 单测 126 例通过；旧三窗实现仍完整保留，由偏好开关 `overlay_display/entry_ui_v2` 二选一（默认 false = 回滚路径）。
- 插件侧（`.live.ndjson` 的 `k=think`、`tool_call.callId`）与页面侧（`window.__dshOverlayHost`）由子代理完成：插件 219 例单测通过、构建通过；页面 tsc 与定向 79 例通过，但页面**全量**单测在 `custom-provider-form-960.spec.tsx` 有 6 例失败（与本重构无关，尚未证实是否基线既有）。
- 已产出可安装的 debug APK 并装进模拟器，但**还没有启动应用、没有打开 v2 开关、没有一张设备截图**。所有「交互是否真的工作」的判断都还欠着。
- 快照资产是从 `out/release-v0.14.11` 的正式 APK 里解出来的（详见 §6），**不含**本轮插件/页面改动；最终候选必须重建快照。

---

## 2. 分支与未提交状态（接手第一件事）

| 项 | 值 |
|---|---|
| 工作树 | `D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\ovl-phase1` |
| 分支 | `docs/overlay-refactor-phase1` |
| HEAD（Phase 1 文档提交） | `b191a6a0 docs: 悬浮交互系统重构 Phase 1 调查与规划` |
| 代码基线 | `5f533907`（= 主检出 `local-main` 当时的 HEAD，= origin/main） |
| 主检出 | `D:\coding\dsh-mobile\dsh-mobile-apk`，分支 `local-main`，跟踪 `origin/main` |

Phase 2 的改动**全部未推送**。为了不让工作树丢失，中止时已打一个本地 WIP 提交（见 §2.1），它只是状态快照，**不要直接当 PR 推**——仓库铁律 3 要求原子 PR，而这份快照把「缺陷修复（P0-1/P0-2）」与「新功能（P1-P5）」混在一起，后续必须拆成：

1. `fix(overlay): agentId 与 sessionId 域切分 + addView 失败回执`（对应 P0-1、P0-2；独立可回滚，无 UI 变化）
2. `feat(overlay): 悬浮 v2 窗口框架与几何纯函数`（`OverlayWindowFrames.kt`、`OverlayWindows.kt` + 测试）
3. `feat(overlay): 顶部事件卡片 / 状态药丸 / 入口双形态`
4. `feat(overlay): 底部输入区 + 附件代理 + 命令抽屉`
5. `feat(plugin): live k=think 与 tool_call.callId`（插件仓镜像规则见 AGENTS 铁律 5）
6. `feat(client-ui): window.__dshOverlayHost 宿主 API`
7. `docs: Phase 2 设计调整与验收记录`

### 2.1 未提交清单（相对 `b191a6a0`）

修改（7 个壳侧文件 + 4 个插件/页面文件）：

```
app/src/main/AndroidManifest.xml                              (+12)   附件代理 Activity 注册
app/src/main/java/.../MainActivity.kt                         (+21)   页面宿主求值器注册/注销 + 本体前后台上报
app/src/main/java/.../OverlayLiveFeed.kt                      (+24)   live 事件统一映射 + v2 转发口
app/src/main/java/.../OverlayPanel.kt                         (+20)   P0-1 待答匹配域修正 + v2 审批入口
app/src/main/java/.../OverlayService.kt                       (+186)  v2 分支、身份域切分、发送下沉、作答面板入口
app/src/test/java/.../OverlaySendBackfillTest.kt              (+23-…) 源码级判据跟随 requestSend 下沉
dsh-client-ui-responsive/src/client/index.ts                  (+24)   宿主 API 注册
dsh-client-ui-responsive/src/client/mobile/composer-sheet.ts  (-287)   命令读取抽公共函数
plugins/dsh-android-bridge/{package.json,package-lock.json}   版本 0.2.4 -> 0.2.5
plugins/dsh-android-bridge/src/index.ts                       (+62)   k=think、callId
plugins/dsh-android-bridge/src/notify-projection.ts           (+42)   reasoning 摘要投影
```

新增壳侧（13 个主源码 + 7 个测试类，行数）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `OverlayV2.kt` | 1187 | v2 窗口编排与状态机（入口/卡片/药丸/输入区/抽屉/数据接入） |
| `OverlayViewTypes.kt` | 267 | 视图层唯一数据契约 + 3 个纯函数 |
| `OverlayCardView.kt` | 513 | 顶部事件卡片（状态行/单行思考/50 行增量列表/待答区/白条把手） |
| `OverlayComposer.kt` | 421 | 底部输入区（药丸行/附件条/输入行/抽屉） |
| `OverlayWindowFrames.kt` | 276 | 窗口几何纯函数（可用高、32%/40%、量化、钳制、消散三条件） |
| `OverlayPillView.kt` | 243 | 状态药丸 |
| `OverlayAttachProxyActivity.kt` | 231 | 附件取件代理 Activity（相机/相册/文件） |
| `OverlayPageHost.kt` | 220 | Kotlin -> `window.__dshOverlayHost` 单次求值桥 + 回包解析 |
| `OverlayCommandDrawer.kt` | 180 | 命令抽屉（上附件瓦片下列表） |
| `OverlayGestureRouter.kt` | 176 | 入口手势裁决纯逻辑 |
| `OverlayWindows.kt` | 135 | 窗口持有者（单槽唯一/addView 回执/z 序断言） |
| `OverlayEntryView.kt` | 118 | 球 / 侧边细条两种入口形态 |
| `WorkspaceListParse.kt` | 75 | `workspace.json` 容错解析（页面不可用时的降级） |

新增测试（合计 126 例）：

| 测试类 | 用例数 |
|---|---|
| `OverlayWindowFramesTest` | 34 |
| `OverlayUiModelTest` | 30 |
| `OverlayGestureRouterTest` | 16 |
| `OverlayPageHostTest` | 16 |
| `WorkspaceListParseTest` | 11 |
| `OverlayViewTypesTest` | 10 |
| `OverlayWindowsTest` | 9 |

新增页面侧 / 插件侧：

```
dsh-client-ui-responsive/src/client/mobile/overlay-host.ts        window.__dshOverlayHost
dsh-client-ui-responsive/src/client/mobile/composer-commands.ts   命令菜单读取公共函数
dsh-client-ui-responsive/tests/overlay-host.spec.ts
dsh-client-ui-responsive/tests/composer-commands.spec.ts
plugins/dsh-android-bridge/test/live-think-callid.test.mjs
```

---

## 3. 代码落点（改哪里、为什么）

### 3.1 服务层（`OverlayService.kt`，现 1225 行）

| 位置 | 内容 |
|---|---|
| `:108` `internal var currentAgentId` | P0-1 身份域切分：新增 `currentAgentId` / `currentSessionId` / `v2` / `targetWorkspaceIdOverride` / `liveSink` |
| `:213` `v2 = OverlayV2(this).also { it.start() }` | 二选一入口：`OverlayV2.enabled(this)` 为真走 v2，否则 `buildRoot()` 走旧三窗 |
| `:484` `hideBall` / `:510` `recallBall` | v2 下委托给 `v2.hideEntry()` / `v2.restoreEntry()`（保证隐藏/召回语义不变、服务不停） |
| `:653` `applyAgentStatus` | P0-1：agentId 只写 `currentAgentId`，不再污染 `activeSessionId`；同时转发 v2 |
| `:819` `sendTextFromOverlay(text)` | 发送实现下沉（旧面板 `requestSend()` 现只剩一行委托，见 `:815` 附近） |
| `:1030` `addOverlayWindow` | P0-2 统一 addView 包装：失败记日志 + 返回 false |
| `:1042` `onHostForegroundChanged` | 本体前台态 -> v2 入口隐藏/恢复 |
| `:1047` `adoptPageSession` / `setTargetSession` | 会话域写入的两个来源（页面权威 / 用户显式选择） |
| `:1079` `showPendingPanelFromOverlay` | 提问作答复用旧面板（居中摆放，v2 下没有球可依附） |

### 3.2 v2 编排层（`OverlayV2.kt`）

| 位置 | 内容 |
|---|---|
| `:33` 类声明 / `:106` `start` | 窗口持有者 + 附件总线注册 + 首次拉页面状态 |
| `:130` `screen()` | 可用高真源：API 30+ 用 `WindowMetrics.windowInsets` 的 systemBars；26-29 回落资源高度 |
| `:166` `buildEntry` | 球 34dp / 细条 8x88dp 窗口（可视 8x64dp）；addView 失败 -> Toast + 回滚 |
| `:332` `hideEntry` / `:345` `restoreEntry` | 用户隐藏入口 -> 召回条；服务与后台 Agent 不停 |
| `:354` `onHostForeground` | 本体前台时只移除入口窗（不是 alpha/GONE） |
| `:372` `showCard` | 卡片窗口、`FLAG_WATCH_OUTSIDE_TOUCH`、入场动画、高度 `cardHeightPx` |
| `:631` `showComposer` | 输入窗 focusable + `SOFT_INPUT_ADJUST_PAN` + 底部贴边 + `navBarPx` 偏移 |
| `:705` `sendText` | 有附件 -> 走页面 `send(text)`；无附件 -> 走 `session/prompt` |
| `:861` `onLiveEvent` | live 事件 -> `OverlayUiModel` 聚合（100ms 合并渲染） |
| `:1026` `renderComposer` | 工作区/会话药丸、附件条、抽屉列表（命令/会话/工作区三种数据源共用同一列表 UI） |
| `:1074` `refreshPageState` | 页面不可用时回退 `workspace.json`（经 `WorkspaceListParse`） |

### 3.3 数据与宿主桥

- `OverlayLiveFeed.kt:101`：每条 live 行先 `svc.liveSink?.invoke(liveEventOf(j))`，再走旧消费逻辑；`:195` `liveEventOf` 是线格式的唯一映射点（`tool_call/tool_result/text/think/turn_end`，`t` 为毫秒时间戳）。
- `OverlayPageHost.kt:26`：`evaluator` 由 `MainActivity.kt:970` 注册（`webView.evaluateJavascript`），`:1168` 注销。方法：`state/sessions/commands/execute/send/removeAttachment/openSession`，**全部返回 JSON 字符串**，`:142` `parseHostReply` 兼容「字符串字面量 / 裸对象 / null」三种回包形态。
- `MainActivity.kt:984` / `:1085`：`onResume` 报前台、`onPause` 报后台（只跟踪 MainActivity，未覆盖 ConsoleActivity/RepairActivity —— 已知限制）。
- `OverlayAttachProxyActivity.kt:69` `start`：Service 用 `FLAG_ACTIVITY_NEW_TASK` 拉起无界面代理；`:131` 相机、`:189` `handOff`（先拷进来件工作区，再 `FileIncoming.processIncomingPath(..., ORIGIN_CAMERA)`）。选 `ORIGIN_CAMERA` 是因为该 origin 在页面侧表示「壳侧自产、并入**当前会话**草稿」（`dsh-client-ui-responsive/src/client/mobile/incoming-draft.ts:311`），`external` 会强制新开会话。
- `OverlayPanel.kt:197` `currentPending`：P0-1 后必须同时比 `activeSessionId` 与 `currentAgentId`，否则待答卡会在会话确定那一刻整体消失（旧代码靠错误映射「碰巧」成立）。
- `OverlayPanel.kt:1099` `respondApprovalFromUi`：v2 卡片审批按钮复用既有 `respondApproval`（受理不等于已处理、15s 兜底、乐观忙态都在原处）。

---

## 4. 验证结果（只写真跑过的）

### 4.1 壳侧编译 / 单测

```
# 编译（串行锁保护，理由见 §6.3）
gradlew.bat :app:compileDebugKotlin --console=plain   -> BUILD SUCCESSFUL, EXIT=0
# 全量单测（第 2 次运行）
gradlew.bat :app:testDebugUnitTest --console=plain
  -> 2783 tests completed, 1 failed, 2 skipped
     失败：ProcIoTest > drainTimeoutIsNotTheSameShapeAsVacuousOutput（计时类用例）
```

第 1 次全量运行（修测试前）：`2782 tests, 4 failed`，其中 3 个是 `OverlaySendBackfillTest` 的**源码级判据**（发送实现下沉后签名变了，已把断言指向 `sendTextFromOverlay` 并新增「requestSend 只许委托」的判据），另 1 个是 `ShizukuCaptureSettlementFixtureTest`（计时类，与悬浮无关，第 2 次运行通过）。
=> 两次运行各自失败的用例不同、且都属于「等待/超时」类，判断为**本机计时不稳定**；尚未在基线 commit 上复跑取证（TODO，见 §8.2）。这两个测试类与 `ShizukuCaptureIo.kt` 本轮未改动。

新增 126 例中，子代理已分别真跑通过（Frames 34 / UiModel 30 / Gesture 16 / Workspace 11 / ViewTypes 10），Lead 补的 `OverlayPageHostTest`(16) 与 `OverlayWindowsTest`(9) 在全量运行中被执行（总数从 2657 涨到 2783 即包含它们）。

### 4.2 插件侧（`plugins/dsh-android-bridge`）

```
npm run build  -> BUILD_EXIT=0（lib/client.js 已重写；lib/ 是 gitignore）
node --test test/*.test.mjs -> tests 219 / pass 219 / fail 0
```
版本 0.2.4 -> 0.2.5。`.live.ndjson` 新行：`{"t":ms,"s":sid,"k":"think","sum":"首行<=120字符"}`；`tool_call` 追加 `callId`。

### 4.3 页面侧（`dsh-client-ui-responsive`）

```
npx tsc -p tsconfig.json --noEmit   -> TSC_EXIT=0
npm run build                       -> BUILD_EXIT=0（lib/client.js 1.05 MB）
vitest run（定向 composer-sheet 等 3 个文件） -> 79 passed
vitest run（全量）                  -> 1245 passed / 6 failed（1 个文件）
```
6 个失败全在 `tests/custom-provider-form-960.spec.tsx`（issue #960 自定义 provider 表单，与本重构无交集），**未证实是否基线既有**，接手时先按 §8.2 复核。

### 4.4 构建产物

| 项 | 值 |
|---|---|
| APK | `app/build/outputs/apk/debug/app-debug.apk`，164,669,180 字节，2026-11-11 22:13 |
| SHA-256 | `f9b72b7c7d15c6fd91d1c1cfc435dc042cbffbb5b9594df7c9eddae388834707` |
| 构建命令 | `gradlew.bat :app:assembleDebug`（debug 变体，**未过发布门禁，禁止发布**） |
| 手工前置 | `build-hard-manifest.mjs`（205 条 exact identity）+ 写 `snapshot.sha256`（见 §6.2） |

### 4.5 设备

| 项 | 值 |
|---|---|
| 设备 | `127.0.0.1:16448`（MuMu 模拟器，900x1600，API 35，x86_64） |
| 安装 | `adb install -r -t` 成功（全量 164 MB） |
| 悬浮窗权限 | `appops get ... SYSTEM_ALERT_WINDOW` -> `allow` |
| 启动/截图 | **未执行**：应用没启动、`entry_ui_v2` 没打开、无任何截图 |

---

## 5. 相对 Phase 1 设计的施工期调整（必须写回 design.md）

1. **旧面板不作废，降级为「作答面 + 回滚面」**。v2 下 `svc.expanded` 恒为 false（`buildRoot` 不执行），`flashStatus` 改走 Toast。提问作答（选项/多选/custom 文本/多问分页/跳过）由 `OverlayService.showPendingPanelFromOverlay()` 打开旧面板完成——因为 `OverlayPanel` 里那套语义已有 `OverlayPendingCardTest` 钉住，重写等于造第二份真源。**待办：在 design.md §11.1 与 known-gaps 登记。**
2. **v2 不画状态光环（W2）**。球形态只有白底鲸鱼；状态语义由药丸/卡片承担。design.md §3.1 的 W2 需要么补实现、要么显式登记为「v2 不实现，状态由卡片/药丸表达」。
3. **工作区/会话选择复用命令抽屉列表**（`OverlayV2.renderComposer` 里 `DrawerMode`），没有新增第 7 类窗口。会话列表优先页面 `sessions()`，不可用时回退 `session/list` RPC；工作区只表达「新会话落在该工作区」（`targetWorkspaceIdOverride`），不做会话过滤。
4. **附件闭环走页面草稿**，不是 `session/prompt` 字段。原因：`session/prompt` 没有附件字段（investigation.md §2 已登记）；`file-incoming` 队列 + 页面 `IncomingDraftConsumer` 才是唯一投递链。因此「带附件的消息」由页面 `send(text)` 提交，「纯文本」走原生 `session/prompt`。
5. **点外部收起**：卡片窗 `FLAG_WATCH_OUTSIDE_TOUCH` + 根视图 `OnTouchListener` 捕 `ACTION_OUTSIDE`（`OverlayV2.kt` `showCard` 内）。**未在设备验证**（Phase 1 的 Spike S1 没做），失效时的保底是「再点入口」与返回键（返回键在 v2 下目前只对旧面板生效，卡片无返回键路径——**这是缺口，见 §9**）。
6. **入口形态**：球 34dp / 细条 8x88dp 窗口（可视 8x64dp），形态由 `overlay_display/entry_style` 决定（默认 `ball`）；切换形态需要重建窗口。
7. **本体前台隐藏**用 MainActivity 的 `onResume/onPause` 上报，不是 `ActivityLifecycleCallbacks`（本仓没有自定义 Application）。ConsoleActivity / RepairActivity 在前台时不会隐藏入口。

---

## 6. 构建环境备忘（踩过的坑，按顺序复现）

### 6.1 工作树没有 168 MB 快照资产

`app/src/main/assets/snapshot.tar.xz` 被 gitignore，新建 worktree 不含它。最初用硬链接指向主检出的**旧**资产（2026-10-22，168,528,588 字节），`check-snapshot-packages.mjs` 判 FAILED（overlay 登记的 378 个引擎包 + 11 个插件在旧快照里大量缺失），dev-fast 构建被硬阻断。

### 6.2 用正式 release APK 里的快照救急（当前工作树就是这个状态）

```powershell
# 1) 从已发布的 x86_64 APK 里解出快照
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("D:\coding\dsh-mobile\out\release-v0.14.11\dsh-mobile-apk-v0.14.11-x86_64.apk")
$e = $zip.Entries | Where-Object { $_.FullName -eq "assets/snapshot.tar.xz" }
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, "<wt>\app\src\main\assets\snapshot.tar.xz", $true)
$zip.Dispose()

# 2) 校验（378 引擎包 / 11 插件齐全 -> PASSED）
node scripts\check-snapshot-packages.mjs --snapshot app\src\main\assets\snapshot.tar.xz

# 3) 补 APK 构建必需的两个派生资产
node scripts\build-hard-manifest.mjs --snapshot app\src\main\assets\snapshot.tar.xz --out app\src\main\assets\plugin-hard-manifest.json
# snapshot.sha256 = 该归档的 SHA-256（本次 = 375808b597dc7203623213d1aa459eb22bb1c22b9ab50407298356984e53bafa）
```

结果：快照 158,790,724 字节，sha256 `375808b5…53bafa`，`plugin-hard-manifest.json` 22,945 字节 / 205 条 identity。

注意：**这份快照不含本轮插件与页面改动**（`k=think`、`callId`、`__dshOverlayHost`）。开发期可用 `node scripts/hot-push.mjs --serial <s> --plugin <dir>` 推 JS 到设备快照树验证；最终候选必须用 `pwsh -File scripts\build-apk-013.ps1 -Fast`（协调仓根 `D:\coding\dsh-mobile`）重建快照与 APK。dev-fast 脚本 `scripts/build-apk-dev-fast.mjs` 的 `check-snapshot-packages` 每跑一次要经 WSL `tar -tJf /mnt/d/...` 读 158 MB，实测 10 分钟以上，开发循环里能跳过就跳过（本次直接 `assembleDebug` + 手工派生资产）。

### 6.3 多人共用同一 gradle 工程的串行约定（上一轮 3 个子代理同时编译踩出来的）

```powershell
$lock = "<wt>\.deploy-tmp\gradle.lock"
$deadline = (Get-Date).AddMinutes(25)
while ((Test-Path $lock) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 15 }
New-Item -ItemType Directory -Path $lock | Out-Null
try {
  $env:ANDROID_HOME = "D:\Android\Sdk"
  $env:GRADLE_USER_HOME = "D:\Android\gradle-home"
  & cmd.exe /c "gradlew.bat :app:compileDebugKotlin --console=plain"
} finally { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue }
```

另外两个坑：

- `--tests` 过滤在本工程**不生效**（`No tests found for given includes`，全量跑正常）。要么全量跑（约 3.5 分钟），要么按测试类名去 `app/build/test-results/testDebugUnitTest/TEST-*.xml` 里筛结果；子代理报的 `--tests=...` 成功记录要按这个口径复核。
- `run_code` 调 `pwsh` 时，外层程序默认 120 秒截止；长命令必须同时传 `run_code.timeoutMs`（否则表现为「超时但其实后台还在跑」，本次就出现过一次 WSL tar 被误杀重跑）。

### 6.4 设备与工具

| 用途 | 设备 | 备注 |
|---|---|---|
| 竖屏开发主用 | `127.0.0.1:16448`（900x1600，API 35，x86_64） | 已装本轮 debug APK、appops allow |
| 横屏 | `127.0.0.1:16384` 当前**不在线**；可用 16448 旋转，或起新模拟器 | 几何/键盘类改动两向必跑 |
| API 26-29 兼容 | `emulator-5574`（1080x2280，API 29，x86_64） | 可用 |
| 真机（发布前） | `10AF2B0GN0001F2`（V2425A，arm64，1260x2800，API 37） | 必须 arm64 产物 |

---

## 7. 接手后建议的第一步（30 分钟检查单）

1. 读 §2/§3，`git log -1 --stat` 确认 WIP 提交内容；`git status` 应为干净。
2. 复跑编译与全量单测（§6.3 命令），确认 `2783 tests`、唯一失败仍是计时类；若失败集合变化，先按 §8.2 定基线。
3. 打开 v2 开关（应用数据是全新安装，`shared_prefs` 是空的）：

```bash
S=127.0.0.1:16448
adb -s $S shell am force-stop com.dsharnessmobile.shell
# dsh-overlay/enabled=true  => OverlayController 才会起 OverlayService
adb -s $S shell "run-as com.dsharnessmobile.shell sh -c 'mkdir -p shared_prefs; cat > shared_prefs/dsh-overlay.xml <<\EOF
<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map><boolean name="enabled" value="true" /><boolean name="pendingEnable" value="false" /></map>
EOF'"
# overlay_display/entry_ui_v2=true（v2 开关）+ entry_style=ball
adb -s $S shell "run-as com.dsharnessmobile.shell sh -c 'cat > shared_prefs/overlay_display.xml <<\EOF
<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map><boolean name="entry_ui_v2" value="true" /><string name="entry_style">ball</string><boolean name="auto_collapse_on_done" value="true" /></map>
EOF'"
adb -s $S shell monkey -p com.dsharnessmobile.shell -c android.intent.category.LAUNCHER 1
```

   然后按 AGENTS §2.1 走三层：代码层（已绿）/ CDP 层（`verify-state-sync.mjs` 等）/ ADB 用户层（`input tap/swipe` + `exec-out screencap -p`）。**先看 `adb logcat -s dsh-overlay`**：v2 任何窗口失败都会写 `addWindow failed slot=...`。
4. 按 §8 逐项补验证，再决定是否继续 P6/P7。

---

## 8. 未完成清单（按优先级）

### 8.1 硬缺口（不补就等于没做完）

1. **设备层零验证**：入口手势（单击/双击/长按/拖动）、卡片展开收起、32%/40%、点外部收起、药丸拖动到 y=0 与上推消散、输入区键盘适配、附件三类取件、命令抽屉执行、本体前台隐藏，全部未在真机/模拟器上跑过。
2. **三处已知交互缺口**：
   - v2 卡片**没有返回键收起路径**（旧 `BackKeyPanelLayout` 只挂在旧面板上）。`FLAG_WATCH_OUTSIDE_TOUCH` 若在真机上不投递 `ACTION_OUTSIDE`，卡片就只剩「再点入口」一条路。
   - 提问作答跳旧面板时，旧面板窗口的 z 序在 v2 窗口之后添加（能盖住），但**未验证**在卡片/输入区同屏时是否被挡住。
   - 入口单击要等双击窗口（`ViewConfiguration.getDoubleTapTimeout()`，约 300ms）才触发，手感未调。
3. **P0-3 测试基线未更新**：`node scripts/check-kotlin-test-count.mjs --update-baseline` 未跑（要求先有一次干净的全量绿；当前有 1 个计时类 flaky）。
4. **P6 性能一项没测**：`dumpsys gfxinfo`、`top`、`meminfo`、`scripts/verify-frame-timing.mjs` 全部未跑，无任何实测数字。design.md §7.7 的表格仍是空的（这是对的，不许填假数）。
5. **P7 发布收口**：快照重建、双 ABI 全链、真机、门禁、文档同步、PR 全部未做。

### 8.2 证据类待办（决定「是不是我们引入的」）

- 在基线 commit `5f533907` 上单跑 `ProcIoTest` 与 `ShizukuCaptureSettlementFixtureTest`，证明它们的偶发失败是否既有（建议做法：另建 detached worktree，`gradlew :app:testDebugUnitTest` 全量跑一次，对照失败集合）。
- 在基线 commit 上跑页面全量 `vitest`，确认 `custom-provider-form-960.spec.tsx` 那 6 例是否既有失败。
- 用 `check-kotlin-test-count.mjs` 记录「新增 126 例、总数 2657 -> 2783」的前后对照。

### 8.3 文档待办（AGENTS.md §5.1 强制）

| 文档 | 要补什么 |
|---|---|
| `docs/AGENTS/modules.md` | 13 个新 .kt 的职责行（`OverlayV2` / `OverlayWindows` / `OverlayPageHost` / `OverlayAttachProxyActivity` 等） |
| `docs/AGENTS/ARCHITECTURE.md` | v2 多窗口集合、窗口数、页面宿主 API 这条新边界 |
| `docs/AGENTS/EXECUTION-MAP.md` | 事件链（live -> liveEventOf -> OverlayV2 -> 视图）、发送链分叉、附件链、前台隐藏链；改完跑 `node scripts/check-code-map.mjs` |
| `docs/AGENTS/PERSISTENT-DATA.md` | 新 prefs 键 `overlay_display/entry_ui_v2`、`entry_style` |
| `docs/AGENTS/known-gaps.md` | v2 不画光环、v2 卡片无返回键、提问复用旧面板、工作区切换只影响新会话、只看 MainActivity 前后台 |
| `docs/AGENTS/BRIDGE-API.md` + `check-bridge-symmetry.mjs` | 本轮**没有**新增 `@JavascriptInterface`（走页面求值），但需确认门禁仍绿 |
| `docs/overlay-refactor-2026-11/design.md` | 把 §5 的施工期调整写回去（光环、面板降级、附件闭环、选择器复用、返回键缺口） |
| `docs/overlay-refactor-2026-11/implementation-plan.md` | P0-4 spike 状态、P6 方法学、P7 未开始 |
| `docs/overlay-refactor-2026-11/test-plan.md` | 本轮实际跑过的用例与结果回填（只填真跑的） |
| `release/v<ver>/notes.md` | 发布时再写；当前无版本号 |

---

## 9. 已知风险（按严重度）

| 风险 | 触发信号 | 应对 |
|---|---|---|
| v2 从未在设备跑过 | 装机后入口不出现 / 卡片点不开 | 先看 `adb logcat -s dsh-overlay`；`addWindow failed` 即窗口失败；把 `entry_ui_v2` 置 false 立刻回旧 UI（服务不用停） |
| outside-touch 不生效 | 点卡片外无反应且无日志 | 补返回键路径与「再点入口」；或退化为自动收起（计时器，不进 UI 线程忙等） |
| 输入区焦点/键盘行为 | 键盘不顶起、窗口被顶出屏、点输入区外键盘不落 | 沿用旧面板已验证的 `focusable + ADJUST_PAN`；在 16448/16448-旋转 两向各测一次 |
| 附件链在真机断 | 拍照后页面草稿没出现附件 | 页面侧 `IncomingDraftConsumer` 4s 轮询，需要 4.2s 后再看；失败看 `dsh-file-open` 日志与 `/api/android/file-incoming` 队列 |
| 事件风暴掉帧 | 卡片内部列表滚动卡顿 | 已有 100ms 合并 + 4dp 量化 + 50 行上限；再不行降合并频率/列表上限 |
| 旧面板与 v2 同屏残窗 | `dumpsys window` 里 type=2038 窗口数 > 预期 | `OverlayWindows` 单槽 + `v2.destroy()` 逐槽收口；契约测试在 `OverlayWindowsTest` |
| 测试基线漂移 | `check-kotlin-test-count` 红 | 先全量真跑，再 `--update-baseline`（只升） |
| 快照与代码脱节 | 装了新 APK 但 `__dshOverlayHost` 不存在（页面宿主 API 全降级） | 这是本轮快照复用 release 资产的必然结果；先热推 JS，最终重建快照 |

**回滚阶梯**（与 implementation-plan §12 一致，均已接好）：

1. `overlay_display/entry_ui_v2=false` -> 立即回旧三窗（服务不停、代码保留）。
2. `entry_style=ball|strip` -> 只回入口形态。
3. 单 PR revert（按 §2 的拆分粒度）。
4. 插件回退 0.2.4（旧壳忽略未知 `k` 仍工作）。
5. 版本回退上一 APK。

---

## 10. 关键文件索引（找东西用）

```
docs/overlay-refactor-2026-11/investigation.md       Phase 1 调查（1557 行，R1-R14 与证据附录）
docs/overlay-refactor-2026-11/design.md              Phase 1 设计（590 行，窗口/flags/状态机/视觉/性能方法学）
docs/overlay-refactor-2026-11/implementation-plan.md Phase 1 施工计划（P0-P7、回滚阶梯）
docs/overlay-refactor-2026-11/test-plan.md           Phase 1 验收矩阵（F/G/C/P/R 系列）
docs/overlay-refactor-2026-11/handoff-phase2.md      本文

app/src/main/java/com/dsharnessmobile/shell/
  OverlayV2.kt                 v2 编排（1187 行，窗口/状态机/数据接入）
  OverlayService.kt            服务层（1225 行，v2 分支 + P0-1/P0-2）
  OverlayPanel.kt              旧面板（1691 行，v2 下只剩作答/回滚用途）
  OverlayLiveFeed.kt           live 流（243 行，事件的唯一映射点）
  OverlayPageHost.kt           页面宿主求值桥（220 行）
  OverlayWindows.kt            窗口持有者（135 行）
  OverlayWindowFrames.kt       几何纯函数（276 行）
  OverlayUiModel.kt            聚合纯函数（390 行）
  OverlayGestureRouter.kt      手势裁决纯逻辑（176 行）
  OverlayCardView.kt           卡片视图（513 行）
  OverlayComposer.kt           输入区（421 行）
  OverlayPillView.kt           药丸（243 行）
  OverlayEntryView.kt          入口两形态（118 行）
  OverlayCommandDrawer.kt      抽屉（180 行）
  OverlayAttachProxyActivity.kt 附件取件代理（231 行）
  WorkspaceListParse.kt        workspace.json 解析（75 行）
  OverlayViewTypes.kt          视图数据契约（267 行）

app/src/test/java/com/dsharnessmobile/shell/   新增 7 个测试类（126 例）
plugins/dsh-android-bridge/{src/index.ts,src/notify-projection.ts,test/live-think-callid.test.mjs}
dsh-client-ui-responsive/{src/client/index.ts,src/client/mobile/overlay-host.ts,
                          src/client/mobile/composer-commands.ts,src/client/mobile/composer-sheet.ts,
                          tests/overlay-host.spec.ts,tests/composer-commands.spec.ts}

.deploy-tmp/assemble-debug.log      本轮 assembleDebug 日志
.deploy-tmp/compile-*.log           编译日志
.deploy-tmp/plugin-*.log            插件构建/测试日志
.deploy-tmp/page-*.log              页面 tsc/build/vitest 日志
```

---

## 11. 交接时的事实声明

- 本轮**没有任何功能经过设备验证**；除 §4 列出的命令输出外，本文不含其它「已验证」结论。
- 文档 §5 的施工期调整是**实现与 Phase 1 设计的差异**，尚未写回 design.md；接手人先改文档再改代码，不要反过来。
- 没有推送、没有 PR、没有合并；WIP 提交只在本机 worktree 分支上。
