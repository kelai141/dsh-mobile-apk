# 不可推导锚点分类清单

总锚点 1600 条：
- 可推导 **1280** 条
- 推导不出 **320** 条（下面五类）

## A. 文件定位不到（裸名多候选 / 路径未登记 / 行号越界）：**57** 条

| path:line | 该行内容（前 46 字） | 细分原因 |
|---|---|---|
| `index.js:2198` | （空） | 文件不存在 |
| `index.ts:991` | （空） | 文件不存在 |
| `index.ts:394` | （空） | 文件不存在 |
| `index.ts:1052` | （空） | 文件不存在 |
| `index.ts:1063` | （空） | 文件不存在 |
| `index.ts:368` | （空） | 文件不存在 |
| `index.ts:949` | （空） | 文件不存在 |
| `index.ts:949` | （空） | 文件不存在 |
| `index.ts:1038` | （空） | 文件不存在 |
| `index.ts:1074` | （空） | 文件不存在 |
| `index.ts:393` | （空） | 文件不存在 |
| `index.ts:1255` | （空） | 文件不存在 |
| `index.ts:584` | （空） | 文件不存在 |
| `index.ts:1899` | （空） | 文件不存在 |
| `index.ts:313` | （空） | 文件不存在 |
| `index.ts:42` | （空） | 文件不存在 |
| `index.ts:991` | （空） | 文件不存在 |
| `index.ts:394` | （空） | 文件不存在 |
| `index.ts:1438` | （空） | 文件不存在 |
| `index.ts:1669` | （空） | 文件不存在 |
| `index.ts:1558` | （空） | 文件不存在 |
| `index.ts:1416` | （空） | 文件不存在 |
| `index.ts:909` | （空） | 文件不存在 |
| `index.ts:1612` | （空） | 文件不存在 |
| `index.ts:1444` | （空） | 文件不存在 |
| `index.ts:477` | （空） | 文件不存在 |
| `index.ts:1438` | （空） | 文件不存在 |
| `index.ts:112` | （空） | 文件不存在 |
| `index.ts:1664` | （空） | 文件不存在 |
| `index.ts:263` | （空） | 文件不存在 |
| `index.ts:165` | （空） | 文件不存在 |
| `index.ts:1463` | （空） | 文件不存在 |
| `index.ts:428` | （空） | 文件不存在 |
| `index.ts:453` | （空） | 文件不存在 |
| `index.ts:584` | （空） | 文件不存在 |
| `index.ts:251` | （空） | 文件不存在 |
| `index.ts:472` | （空） | 文件不存在 |
| `index.ts:909` | （空） | 文件不存在 |
| `index.ts:991` | （空） | 文件不存在 |
| `index.ts:949` | （空） | 文件不存在 |
| `index.ts:1038` | （空） | 文件不存在 |
| `index.ts:1074` | （空） | 文件不存在 |
| `index.ts:393` | （空） | 文件不存在 |
| `index.ts:1255` | （空） | 文件不存在 |
| `index.ts:584` | （空） | 文件不存在 |
| `index.ts:295` | （空） | 文件不存在 |
| `index.ts:298` | （空） | 文件不存在 |
| `index.ts:428` | （空） | 文件不存在 |
| `index.ts:69` | （空） | 文件不存在 |
| `index.ts:31` | （空） | 文件不存在 |
| `index.ts:125` | （空） | 文件不存在 |
| `index.ts:444` | （空） | 文件不存在 |
| `index.ts:142` | （空） | 文件不存在 |
| `index.ts:281` | （空） | 文件不存在 |
| `index.ts:517` | （空） | 文件不存在 |
| `index.ts:380` | （空） | 文件不存在 |
| `index.ts:432` | （空） | 文件不存在 |

## B. 同名多定义（2~5 处）且推不出宿主类：**70** 条

| path:line | 该行内容（前 46 字） | 细分原因 |
|---|---|---|
| `ControlPoller.kt:158` | `}` | 同名符号 5 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt:1581` | `val newTab = (wantsNewTab && requestedTabId ==` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt:1589` | `var candidate: String` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:420` | `if (inner === '$' && text[j + 1] === '(') {` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `EngineService.kt:129` | `* Start the engine if not running, then arm th` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:2120` | `private fun shotDir(): File {` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:106` | `/** 完成位（会话维、带消费标记）。**必须放在服务级字段**：面板收起态要能存活` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `app/src/test/java/com/dsharnessmobile/shell/OverlayHaloInvariantTest.kt:92` | `*/` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/test/java/com/dsharnessmobile/shell/ApiLevelGuardTest.kt:209` | `// ── java.util 工厂方法 ──` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/test/java/com/dsharnessmobile/shell/OverlayHaloInvariantTest.kt:92` | `*/` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/test/java/com/dsharnessmobile/shell/OverlayHaloInvariantTest.kt:192` | `* **关于「恒等式本身恒真」的诚实说明**（task-14 自查发现，必须写清）：` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:293` | `let rest = text` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:753` | `.put("guidance", "已请求把 " + pkg + " 拉起到 " + rec` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1035` | `tab.loadState = "error"` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/ControlPoller.kt:158` | `}` | 同名符号 5 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1034` | `const gate = internal === 'animation-scales'` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1045` | `}` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-client-ui-responsive/src/client/mobile/native-browser-presentation.ts:61` | `readonly clipsX: boolean` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/OverlayService.kt:574` | `* 临时工作区 workspaceId（0.13.5）：读 `home/.dsh/stora` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:645` | `* 为什么需要：caps 只随**执行过的控制 op** 的回执信封抵达（`ControlQ` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:949` | `/** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-client-ui-responsive/src/client/mobile/native-browser-presentation.ts:61` | `readonly clipsX: boolean` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:302` | `r.declaredInjectEntries=decl;   // [] = 图里确实没有` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `UpdateCheckerTest.kt:393` | `assertTrue("非 apk 资产的摘要同样要收下（下载前校验快照/插件不是本函数的事` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `UpdateCheckerTest.kt:426` | `(x as UpdateChecker.CheckResult.Available).sha` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `EngineService.kt:134` | `*/` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:135` | `/** 已配对（第三道人门；0.14 起 = 真实 adb pair 握手成功） */` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `DeviceControlService.kt:964` | `*/` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:949` | `/** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `ScreenScope.kt:31` | `}` | 同名符号 5 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:436` | `*` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:547` | （空） | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:427` | `/**` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:85` | `// ── 引擎维/会话维状态（协作类经 internal 共享） ────────────` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:574` | `* 临时工作区 workspaceId（0.13.5）：读 `home/.dsh/stora` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:216` | `* 划掉任务 = 主动关闭：自停，由 onDestroy 统一撤窗（三条路径都走同一个收口）` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:106` | `/** 完成位（会话维、带消费标记）。**必须放在服务级字段**：面板收起态要能存活` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1224` | `const decision = this.#authorizePrivileged(aut` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:949` | `/** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:909` | `a11yFacts(): A11yAvailabilityFacts {` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1034` | `const gate = internal === 'animation-scales'` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:755` | `* 故范围判定必须能核对 token 归属，否则「放行的值取不到图、能取到图的值被拒」。` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:293` | `let rest = text` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:829` | `/**` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:991` | `}` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1034` | `const gate = internal === 'animation-scales'` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-client-ui-responsive/src/client/mobile/native-browser-presentation.ts:61` | `readonly clipsX: boolean` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/ControlPoller.kt:158` | `}` | 同名符号 5 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:949` | `/** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-vdisplay/src/status.ts:131` | `viewers: VdViewer[]` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1432` | `val rid = remoteTabId(tab.owner, tab)` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1336` | `for (tab in workspace.tabs.values) {` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:389` | `}` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:411` | `// 只写 id 的那一条取到最后一项也无害（仍是可以照着排查的原文）。折叠与 200 字符` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:416` | `var items=root.querySelectorAll('[class*=faile` | 同名符号 5 处且推导不出宿主类名，需人工消歧 |
| `GeneralSettings.tsx:43` | `export type GeneralSettingsProps = PropsRuntim` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `browser-auto-place.ts:45` | `export interface BrowserHostStatusLike {` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `native-browser-presentation.ts:61` | `readonly clipsX: boolean` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:409` | `// 失败原文（契约 §1 第 4 条 detail.reason 的取值面）。上游 Boo` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:302` | `r.declaredInjectEntries=decl;   // [] = 图里确实没有` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `dsh-client-ui-responsive/src/client/mobile/native-browser-presentation.ts:61` | `readonly clipsX: boolean` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:286` | `try{` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:307` | `var out=[];` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1371` | `* 为什么必须是个"主动"的定时器：`applyVisibility()` 只在有事件时被调` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:753` | `.put("guidance", "已请求把 " + pkg + " 拉起到 " + rec` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1035` | `tab.loadState = "error"` | 同名符号 4 处且推导不出宿主类名，需人工消歧 |
| `OverlayService.kt:106` | `/** 完成位（会话维、带消费标记）。**必须放在服务级字段**：面板收起态要能存活` | 同名符号 3 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:829` | `/**` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:991` | `}` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/index.ts:1034` | `const gate = internal === 'animation-scales'` | 同名符号 2 处且推导不出宿主类名，需人工消歧 |

## C. 同名多定义（6 处以上）且推不出宿主类：**43** 条

| path:line | 该行内容（前 46 字） | 细分原因 |
|---|---|---|
| `app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt:1661` | `if (width !in 240..3840 \|\| height !in 240..3` | 同名符号 18 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/BrowserHost.kt:1565` | `if (config.has("ua") && (config.opt("ua") !is ` | 同名符号 14 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt:196` | `return false // No staging, transaction write ` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:200` | `const ch = text[i]` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt:196` | `return false // No staging, transaction write ` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:810` | `} ?: return controlTimeout()` | 同名符号 37 处且推导不出宿主类名，需人工消歧 |
| `app/src/test/java/com/dsharnessmobile/shell/NotifySuppressQueueTest.kt:24` | `assertFalse(NotifySuppressQueue.commitJournal(` | 同名符号 7 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:200` | `const ch = text[i]` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:203` | `const quote = ch` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:405` | `if (ch === '"') {` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1412` | `// 尺寸优先级（越靠前越贴合「用户/AI 预期的那块画布」）：` | 同名符号 24 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:483` | `} else {` | 同名符号 19 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt:99` | （空） | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt:193` | `lastRefreshFailureCode = problem.failureCode` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:405` | `if (ch === '"') {` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:895` | `}` | 同名符号 11 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1661` | `if (width !in 240..3840 \|\| height !in 240..3` | 同名符号 18 处且推导不出宿主类名，需人工消歧 |
| `UpdateCheckerTest.kt:364` | `"000000000000000000000000000000000000000000000` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:133` | `private val Record.displayId: Int get() = this` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:306` | `}` | 同名符号 8 处且推导不出宿主类名，需人工消歧 |
| `app/src/main/java/com/dsharnessmobile/shell/VdisplayController.kt:306` | `}` | 同名符号 8 处且推导不出宿主类名，需人工消歧 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:405` | `if (ch === '"') {` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:200` | `const ch = text[i]` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:203` | `const quote = ch` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `screen-scope.ts:405` | `if (ch === '"') {` | 同名符号 9 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1085` | `val reason = sessionProfile.blockedRequestReas` | 同名符号 10 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:908` | `stageVisible = workspace.stageVisible,` | 同名符号 34 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:233` | `.put("displayId", id)` | 同名符号 8 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:128` | `candidate` | 同名符号 7 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1412` | `// 尺寸优先级（越靠前越贴合「用户/AI 预期的那块画布」）：` | 同名符号 24 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:381` | `if(!page\|\|typeof page.querySelectorAll!=='fu` | 同名符号 7 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:360` | `// 只认「boot 页 + failedItem」这一对 DOM 事实，不认任何文案（文案` | 同名符号 7 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:895` | `}` | 同名符号 11 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1661` | `if (width !in 240..3840 \|\| height !in 240..3` | 同名符号 18 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:1661` | `if (width !in 240..3840 \|\| height !in 240..3` | 同名符号 18 处且推导不出宿主类名，需人工消歧 |
| `VdisplayController.kt:483` | `} else {` | 同名符号 19 处且推导不出宿主类名，需人工消歧 |
| `BrowserHost.kt:810` | `} ?: return controlTimeout()` | 同名符号 37 处且推导不出宿主类名，需人工消歧 |
| `dsh-host-web-compat/lib/index.js:783` | `var path=el.getAttribute&&el.getAttribute('tit` | 同名符号 6 处且推导不出宿主类名，需人工消歧 |

## D. 锚在空行上（无内容可判）：**51** 条

| path:line | 该行内容（前 46 字） | 细分原因 |
|---|---|---|
| `plugins/dsh-android-file-open/src/index.ts:43` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:166` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:12` | （空） | 该行为空行，无法推导 |
| `protocol-v2.ts:235` | （空） | 该行为空行，无法推导 |
| `plugins/dsh-android-bridge/test/screen-scope.test.mjs:336` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:68` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:29` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:145` | （空） | 该行为空行，无法推导 |
| `app/src/test/java/com/dsharnessmobile/shell/NotifySuppressQueueTest.kt:71` | （空） | 该行为空行，无法推导 |
| `back-stack.spec.ts:259` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:166` | （空） | 该行为空行，无法推导 |
| `AGENTS.md:30` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/RUNTIME-PATCHES.md:56` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/emulator-test-protocol.md:61` | （空） | 该行为空行，无法推导 |
| `plugins/dsh-android-bridge/src/index.ts:251` | （空） | 该行为空行，无法推导 |
| `plugins/dsh-android-file-open/src/index.ts:302` | （空） | 该行为空行，无法推导 |
| `scripts/source-build/reconcile-engine-patch-copies.mjs:58` | （空） | 该行为空行，无法推导 |
| `scripts/verify-webview-015.mjs:43` | （空） | 该行为空行，无法推导 |
| `VdisplayController.kt:326` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/gotchas.md:74` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/emulator-test-protocol.md:57` | （空） | 该行为空行，无法推导 |
| `protocol-v2.ts:235` | （空） | 该行为空行，无法推导 |
| `plugins/dsh-android-bridge/test/screen-scope.test.mjs:336` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:68` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:29` | （空） | 该行为空行，无法推导 |
| `control-queue.ts:230` | （空） | 该行为空行，无法推导 |
| `control-queue.ts:227` | （空） | 该行为空行，无法推导 |
| `app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt:333` | （空） | 该行为空行，无法推导 |
| `plugins/dsh-android-bridge/src/index.ts:251` | （空） | 该行为空行，无法推导 |
| `scripts/patches/apply-patches.mjs:865` | （空） | 该行为空行，无法推导 |
| `settings-document.ts:65` | （空） | 该行为空行，无法推导 |
| `dsh-client-ui-responsive/tests/back-stack.spec.ts:259` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/gotchas.md:103` | （空） | 该行为空行，无法推导 |
| `AGENTS.md:30` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:283` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:166` | （空） | 该行为空行，无法推导 |
| `AGENTS.md:30` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/RUNTIME-PATCHES.md:56` | （空） | 该行为空行，无法推导 |
| `scripts/check-plugin-tests.mjs:54` | （空） | 该行为空行，无法推导 |
| `scripts/build-apk-013.ps1:145` | （空） | 该行为空行，无法推导 |
| `verify-webview-015.mjs:97` | （空） | 该行为空行，无法推导 |
| `VdisplayController.kt:326` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/gotchas.md:74` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/emulator-test-protocol.md:57` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/emulator-test-protocol.md:61` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:12` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:68` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/ARCHITECTURE.md:29` | （空） | 该行为空行，无法推导 |
| `app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt:333` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/gotchas.md:103` | （空） | 该行为空行，无法推导 |
| `docs/AGENTS/RUNTIME-PATCHES.md:56` | （空） | 该行为空行，无法推导 |

## E. 无包围符号且该行内容在全文不唯一：**99** 条

| path:line | 该行内容（前 46 字） | 细分原因 |
|---|---|---|
| `ControlPoller.kt:96` | `}` | 内容在全文出现 31 次，不唯一 |
| `app/src/main/java/com/dsharnessmobile/shell/VdisplayController.kt:84` | `*` | 内容在全文出现 21 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:728` | `if (!uiCache \|\| Date.now() - uiCache.ts > UI` | 内容在全文出现 4 次，不唯一 |
| `ARCHITECTURE.md:15` | `\| 文件 \| 职责一句话 \| 被引用 \|` | 内容在全文出现 5 次，不唯一 |
| `docs/AGENTS/ARCHITECTURE.md:15` | `\| 文件 \| 职责一句话 \| 被引用 \|` | 内容在全文出现 5 次，不唯一 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:70` | `*/` | 内容在全文出现 24 次，不唯一 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:242` | `*` | 内容在全文出现 24 次，不唯一 |
| `ControlPoller.kt:96` | `}` | 内容在全文出现 31 次，不唯一 |
| `app/src/main/AndroidManifest.xml:158` | `android:windowSoftInputMode="adjustResize" />` | 内容在全文出现 2 次，不唯一 |
| `VdisplayController.kt:84` | `*` | 内容在全文出现 21 次，不唯一 |
| `docs/AGENTS/ARCHITECTURE.md:70` | `\|---\|---\|---\|` | 内容在全文出现 6 次，不唯一 |
| `.github/workflows/pr-gate.yml:91` | `if: always()` | 内容在全文出现 27 次，不唯一 |
| `scripts/check-kotlin-test-count.mjs:143` | `*/` | 内容在全文出现 6 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/WatchdogMarkerConsumeTest.kt:159` | `@Test` | 内容在全文出现 10 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/CallSiteContractTest.kt:54` | `@Test` | 内容在全文出现 52 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/NotifyProtocolTest.kt:18` | `@Test` | 内容在全文出现 9 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/NotifyProtocolTest.kt:131` | `@Test` | 内容在全文出现 9 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/UpdateCheckerTest.kt:60` | `@Test` | 内容在全文出现 51 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/W3ShellContractTest.kt:52` | `@Test` | 内容在全文出现 22 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/WatchdogMarkerConsumeTest.kt:69` | `@Test` | 内容在全文出现 10 次，不唯一 |
| `app/src/test/java/com/dsharnessmobile/shell/WatchdogMarkerConsumeTest.kt:159` | `@Test` | 内容在全文出现 10 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:728` | `if (!uiCache \|\| Date.now() - uiCache.ts > UI` | 内容在全文出现 4 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:901` | `}` | 内容在全文出现 200 次，不唯一 |
| `plugins/dsh-android-bridge/src/lossless-json.ts:1` | `/**` | 内容在全文出现 2 次，不唯一 |
| `status.ts:135` | `/**` | 内容在全文出现 10 次，不唯一 |
| `tools.ts:73` | `/**` | 内容在全文出现 9 次，不唯一 |
| `AndroidBridge.kt:325` | `@JavascriptInterface` | 内容在全文出现 77 次，不唯一 |
| `plugins/dsh-android-file-open/src/index.ts:525` | `return undefined` | 内容在全文出现 4 次，不唯一 |
| `back-stack.ts:94` | `*/` | 内容在全文出现 20 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `app/src/main/java/com/dsharnessmobile/shell/ApkUpdateAction.kt:245` | `/**` | 内容在全文出现 33 次，不唯一 |
| `plugins/dsh-android-bridge/src/control-queue.ts:347` | `webServer.register({` | 内容在全文出现 2 次，不唯一 |
| `plugins/dsh-android-bridge/src/control-queue.ts:347` | `webServer.register({` | 内容在全文出现 2 次，不唯一 |
| `plugins/dsh-android-bridge/src/index.ts:1612` | `}` | 内容在全文出现 167 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:152` | `}` | 内容在全文出现 200 次，不唯一 |
| `plugins/dsh-android-file-open/src/route-auth.ts:47` | `*/` | 内容在全文出现 2 次，不唯一 |
| `scripts/profile-web.cordis.patch.yml:7` | `disabled: true` | 内容在全文出现 8 次，不唯一 |
| `scripts/patches/registry.json:211` | `],` | 内容在全文出现 8 次，不唯一 |
| `scripts/check-browser-syntax-floor.mjs:536` | `} else {` | 内容在全文出现 2 次，不唯一 |
| `inject-all.py:336` | `push(data, base + "/" + rel, now)` | 内容在全文出现 2 次，不唯一 |
| `build-snapshot-013.mjs:315` | `//` | 内容在全文出现 13 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `ControlPoller.kt:96` | `}` | 内容在全文出现 31 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:1999` | `return {` | 内容在全文出现 33 次，不唯一 |
| `plugins/dsh-android-bridge/src/screen-scope.ts:70` | `*/` | 内容在全文出现 24 次，不唯一 |
| `AndroidBridge.kt:319` | `/**` | 内容在全文出现 42 次，不唯一 |
| `app/src/main/java/com/dsharnessmobile/shell/VdisplayController.kt:84` | `*` | 内容在全文出现 21 次，不唯一 |
| `VdisplayController.kt:84` | `*` | 内容在全文出现 21 次，不唯一 |
| `app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt:319` | `/**` | 内容在全文出现 42 次，不唯一 |
| `plugins/dsh-android-bridge/src/index.ts:1593` | `schema: {` | 内容在全文出现 2 次，不唯一 |
| `docs/AGENTS/ARCHITECTURE.md:70` | `\|---\|---\|---\|` | 内容在全文出现 6 次，不唯一 |
| `control-queue.ts:347` | `webServer.register({` | 内容在全文出现 2 次，不唯一 |
| `screen-scope.ts:70` | `*/` | 内容在全文出现 24 次，不唯一 |
| `plugins/dsh-android-vdisplay/src/status.ts:190` | `/**` | 内容在全文出现 10 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:1300` | `ok: false,` | 内容在全文出现 3 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:728` | `if (!uiCache \|\| Date.now() - uiCache.ts > UI` | 内容在全文出现 4 次，不唯一 |
| `plugins/dsh-android-manage/src/index.ts:901` | `}` | 内容在全文出现 200 次，不唯一 |
| `plugins/dsh-android-bridge/src/lossless-json.ts:1` | `/**` | 内容在全文出现 2 次，不唯一 |
| `plugins/dsh-android-vdisplay/src/client/index.ts:171` | `*` | 内容在全文出现 9 次，不唯一 |
| `AndroidBridge.kt:319` | `/**` | 内容在全文出现 42 次，不唯一 |
| `status.ts:135` | `/**` | 内容在全文出现 10 次，不唯一 |
| `tools.ts:73` | `/**` | 内容在全文出现 9 次，不唯一 |
| `AndroidBridge.kt:325` | `@JavascriptInterface` | 内容在全文出现 77 次，不唯一 |
| `plugins/dsh-android-file-open/src/route-auth.ts:47` | `*/` | 内容在全文出现 2 次，不唯一 |
| `plugins/dsh-android-file-open/src/index.ts:36` | `/**` | 内容在全文出现 12 次，不唯一 |
| `plugins/dsh-android-file-open/src/index.ts:525` | `return undefined` | 内容在全文出现 4 次，不唯一 |
| `plugins/dsh-android-file-open/src/index.ts:216` | `/**` | 内容在全文出现 12 次，不唯一 |
| `plugins/dsh-android-linux-env/src/index.ts:353` | `})` | 内容在全文出现 10 次，不唯一 |
| `plugins/dsh-android-linux-env/src/runtime-cache.ts:469` | `*` | 内容在全文出现 13 次，不唯一 |
| `plugins/dsh-android-file-open/src/index.ts:525` | `return undefined` | 内容在全文出现 4 次，不唯一 |
| `MobileChrome.tsx:85` | `}` | 内容在全文出现 6 次，不唯一 |
| `plugins/dsh-android-linux-env/src/index.ts:388` | `kind: 'exact',` | 内容在全文出现 3 次，不唯一 |
| `DevSection.tsx:72` | `*/` | 内容在全文出现 3 次，不唯一 |
| `DevSection.tsx:220` | `} catch {` | 内容在全文出现 13 次，不唯一 |
| `notify-settings.tsx:66` | `*` | 内容在全文出现 9 次，不唯一 |
| `dsh-client-ui-responsive/src/client/dev-section/notify-settings.tsx:66` | `*` | 内容在全文出现 9 次，不唯一 |
| `build-snapshot-013.mjs:40` | `try {` | 内容在全文出现 16 次，不唯一 |
| `build-snapshot-013.mjs:300` | `}` | 内容在全文出现 113 次，不唯一 |
| `apply-patches.mjs:1596` | `}` | 内容在全文出现 83 次，不唯一 |
| `inject-all.py:304` | `continue` | 内容在全文出现 10 次，不唯一 |
| `inject-all.py:273` | `else:` | 内容在全文出现 3 次，不唯一 |
| `inject-all.py:336` | `push(data, base + "/" + rel, now)` | 内容在全文出现 2 次，不唯一 |
| `build-snapshot-013.mjs:315` | `//` | 内容在全文出现 13 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `scripts/check-release-gates.mjs:246` | `}` | 内容在全文出现 54 次，不唯一 |
| `verify-webview-015.mjs:6` | `//` | 内容在全文出现 3 次，不唯一 |
| `verify-webview-015.mjs:60` | `/**` | 内容在全文出现 6 次，不唯一 |
| `verify-state-sync.mjs:106` | `*/` | 内容在全文出现 2 次，不唯一 |
| `scripts/verify-webview-015.mjs:6` | `//` | 内容在全文出现 3 次，不唯一 |
| `scripts/verify-state-sync.mjs:244` | `}` | 内容在全文出现 31 次，不唯一 |
| `scripts/verify-state-sync.mjs:247` | `console.log('')` | 内容在全文出现 2 次，不唯一 |
| `verify-state-sync.mjs:161` | `},` | 内容在全文出现 7 次，不唯一 |
| `docs/AGENTS/ARCHITECTURE.md:15` | `\| 文件 \| 职责一句话 \| 被引用 \|` | 内容在全文出现 5 次，不唯一 |
| `app/src/main/java/com/dsharnessmobile/shell/AndroidBridge.kt:319` | `/**` | 内容在全文出现 42 次，不唯一 |
| `docs/AGENTS/ARCHITECTURE.md:70` | `\|---\|---\|---\|` | 内容在全文出现 6 次，不唯一 |
| `plugins/dsh-android-bridge/src/lossless-json.ts:1` | `/**` | 内容在全文出现 2 次，不唯一 |
| `dsh-client-ui-responsive/src/client/dev-section/notify-settings.tsx:66` | `*` | 内容在全文出现 9 次，不唯一 |

