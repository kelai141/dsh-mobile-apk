# 批次 A：浏览器与 Shizuku 通道的语义一致性（#1571 #1574 #1575 #1611 #1619 #1620）

分支 `fix/batch-a-browser-shizuku`。六条静态审查缺陷里，五条与源码一致并已修；一条（#1619）
按源码核实后收窄了适用范围，理由写在下面第 5 节。

## 1. #1571 选择器允许面并上了整个外部存储根

**现象**：模型生成的一段 artifact HTML 调 `shareFile("/storage/emulated/0/Android/data/<别的应用>/files/token.db")`
会弹系统分享面板（第一项通常是聊天工具）；`openFileExternal` 更直接把文件交给外部阅读器并授予读权限。

**真因**：两个事实叠在一起。
- 允许面：`PathOpen.isChooserAllowedFor` = 「四条窄根 **并上** `Environment.getExternalStorageDirectory()`」；
- 桥门禁：三个 `@JavascriptInterface` 只要求顶层帧是引擎 origin，而 `BridgeOriginGuard` 明确为
  「同源 HTML artifact 预览帧」放行桥（`isTop || listed`）。

于是「同源帧」= 「引擎页面」，但同源帧里可以跑模型生成的任意 HTML。两件事各自都合理，
叠起来就是「模型写的网页能读整台设备并交给别的应用」。

**修法**：去掉外部存储根这一支。允许面改为「四条窄根 ∪ 用户经系统目录选择器亲手授予的目录」
（`persistedUriPermissions`，外部工作区走的就是这条）。`file_paths.xml` 里对应的
`<external-path name="external_shared" path="." />` 一并删除——只删运行时判据而留着 FileProvider
映射，等于「判据说不许、映射说可以」，下一个调用点会照着映射写。

**复验**：`PathOpenAllowlistTest`（6 例，驱动 `FileIncoming.readerRoots` + `readerAllowedBy` +
`ChooserAllowlist` 的真实实现）。负控：让 `readerAllowedBy` 额外接受任意非空路径（等价于把外部
存储根加回来）⇒ `anotherAppsPrivateDirectoryUnderSharedStorageIsRefused` 与
`siblingDirectoryWithSharedPrefixIsRefused` 两条变红。

**边界**：用户授予的目录仍然可以整目录分享（那本来就是用户亲手选的）。要在应用内浏览全盘，
正确的通路是 `ACTION_OPEN_DOCUMENT`（用户当场授权），不是放宽这张表。

## 2. #1574 tier-2 投影每秒拆建两次，旧包不释放

**现象**：兼容档（WebView<114）设备上打开侧栏浏览器，画面每秒拆建两次、首帧空白；Surface 资源
随在线时长线性增长（1 小时约 7200 个包）。

**真因**：前端续租是强制发送的（可见时每秒一次 `setStageBounds`），壳侧里 `switchTo` 与
`applyStageBounds` 各调一次 ⇒ 每秒 2 次；tier-2 分支**没有几何去重**，无条件 `relayout`。而远端
`relayout` = `destroyProjection()` → `new SurfaceControlViewHost` → `setView` → `onSurfacePackage`，
宿主侧 `surfacePackages[tabId] = pkg` 直接覆盖，**同 tabId 的旧包没有任何 release()**。

**修法**：抽 `RemoteProjectionPolicy`（纯对象）承载两条判据——四元组去重与「替换时释放旧包」。
`applyStageBounds` / `layoutDetached` 按「上一次**已下推**的几何」去重；`onSurfacePackage` 走
`replacePackage`，同一对象重报不释放（否则会把正在显示的画面拆掉）。

**去重基线必须在投影重建/销毁时作废**：新建的 SCVH 是一块全新 surface，几何恰好等于上一次时
若沿用旧基线会跳过唯一一次必要的 relayout，新投影停在 1x1。`ensureViewFor` / `renderGone` /
`dropWorkspace` / `closeTabOp` / `recycleView` 五处都 `pushedGeometry.remove(...)`。

**复验**：`RemoteProjectionPolicyTest`（6 例）。负控两条：`changed` 改恒 true ⇒
`unchangedGeometrySkipsTheRemoteRelayout` + `thirtySecondsOfLeasesCauseAtMostTwoRelayouts` 变红；
`replacePackage` 去掉 release ⇒ `replacedPackageIsReleasedExactlyOnce` 变红。

**边界**：API 33 以下没有 `SurfacePackage.release()`，那里保持旧行为（不假装释放过）。本改动
不改变投影怎么建，只改变「什么时候重建」。

## 3. #1575 tier-2 把共享档案报成 isolated

**现象**：WebView<114 或 OEM 不暴露 MULTI_PROFILE + API≥29 时，会话 A 在某站登录后，会话 B 的
`browser_open` 直接带着 A 的 cookie/登录态，而 `browser_state` 对 B 回 `isolated`。

**真因**：tier-2 下 `remote != null` 恒成立 ⇒ `profileEstablished = true` ⇒ 旧实现输出
`profileIsolation: "isolated"`。而 `BrowserIsolationTier.PROCESS_SUFFIX` 的 KDoc 自己写着
「独立 :browser 进程 + setDataDirectorySuffix，**全 app 共享一个浏览器档案**」——它隔离的是
「浏览器 vs 引擎」，不是「会话 vs 会话」。

**修法**：新增 wire 值 `process-shared`，判据收在 `BrowserStatusSemantics.isolationWire`，
`browser_state` 与 `browser_caps` 共用同一份。**不动 `profileEstablished`**（它进
`browserAvailable` 派生链，改它会把「浏览器可用」判歪）。

**复验**：`BrowserIsolationTierTest` 新增 3 例。负控：把 `isolationWire` 的 tier-2 分支删掉
（退回只按 `profileEstablished` 判）⇒ `processSuffixReportsProcessSharedNotIsolated` 变红。

**边界**：这是**声明**的修正，不是隔离能力的修正。tier-2 上会话之间仍然共享 cookie——要真正
分开，得等 WebView 提供 MULTI_PROFILE（tier-1）。工具层据此可以在 tier-2 上给出更准确的提示。

## 4. #1611 browserJs 不校验世代

**现象**：`browser_js` 的表达式自身触发导航，或页面 meta-refresh / 定时跳转落在 8 秒窗口内时，
旧文档的返回值以**新文档**的身份交付——回执里 `pageGeneration` 是 N+1 而 `value` 是第 N 代的产物。

**真因**：`snapshotOp` / `textOp` / `measurePage` / `resolveRef` 都比对 `tab.generation`，只有
`browserJsOp` 拿到 `raw` 后只查 `targetProblem`。而 `pageReply` 现读
`url/loadState/pageGeneration`，所以回执天然「看起来属于新页」。

**修法**：抽 `BrowserJsReplyGuard.settle`——它**拥有整份回执**（不是只给一个布尔），
`browserJsOp` 记 `startedGeneration` 后交给它结算，与 `:1972` 的 snapshotOp 同形。

**复验**：`BrowserJsReplyGuardTest`（4 例，驱动的是模型真正收到的那份 JSON）。负控：把
`startedGeneration != currentGeneration` 那一行改成恒 false ⇒ `generationBumpRejectsTheReply`
变红，且失败信息就是「旧值被贴上了新的 pageGeneration」。

**边界**：tier-2 本来就安全（`PendingJsDispatch` 按世代丢弃），本改动只补 tier-1 这条路。

## 5. #1619 ui_scroll 在虚拟屏上滑真实屏

**issue 描述与源码的差异**：issue 说「ADB 分支读的是真实屏 `wm size` 且 `input swipe` 没有 `-d`」
——这部分属实。但 issue 没说的是：`ui_scroll` 的 ADB 分支**前面**还有一道
`controlDecision('scroll', ...).backend === 'a11y'` 判断，而 a11y 分支本来就带 `screenId`
（`screenArgs(args)`）。所以缺陷只在「纯 Shizuku / 无无障碍」这条通道上成立。

**修法**：在该通道上见到非 `real` 的 `screenId` 直接拒绝，并把模型指向
`android_vdisplay_input`（它走壳侧 `vdInput`，坐标基于该屏自身像素）。与 `ui_click` 对 nx/ny
在虚拟屏上的拒绝同一口径。

**复验**：`ui-scroll-screen.test.mjs`（3 例，夹具记录**真正发给设备的 adb 命令行**）。负控：
把拒绝分支删掉 ⇒ 第一条变红，报出「非 real 屏上发出了 input swipe」。

**边界**：a11y 通道上的虚拟屏滚动本来就对，本改动不碰它（有用例守着不被误伤）。

## 6. #1620 browser_scroll 的 direction 不校验

**现象**：模型传 `direction: "upward"` → 收到成功、页面没动 → 反复重试或据此下错误结论。

**真因**：`dx/dy` 只认四个字面量，其余一律 0 ⇒ `window.scrollBy(0,0)` ⇒ `ok:true` + 原 scrollY。
表达式由工具层自己拼，壳侧不会再校验方向，所以**没有任何一层会报错**。

**修法**：先校验 `direction ∈ {up,down,left,right}`，否则回 `unknown-direction` + 可用取值
（与 open/set_viewport 的错误形状一致），且**不向壳侧发任何 JS**。

**复验**：`scroll-direction.test.mjs`（3 例）。负控：把校验分支改成恒 false ⇒ 第一条变红
（拿到 ok:true 且 calls 非空）。

**边界**：`amount` 的钳制（1..4000）与「不改变页面代次」两条既有语义不变。

## 门禁

- `node scripts/check-code-map.mjs`：PASSED（覆盖完整、锚点有效、编号一致）
- `node scripts/check-release-gates.mjs`：PASSED（声明门禁集 42 项；SKIP=1 = 本布局无协调仓侧 workflow）
- `node scripts/check-kotlin-comments.mjs`：PASSED（449 个 .kt，无嵌套块注释）
- `plugins/dsh-android-browser` 与 `plugins/dsh-android-manage` 的 `npm test`：全绿
- `./gradlew :app:testDebugUnitTest`：全量 Kotlin 单测通过
- 合并结果验证：在 `origin/main` 的临时 worktree 上 `git merge` 本分支后重跑 `check-code-map`：PASSED

## 未做设备验证

tier-2 的两条（#1574 投影拆建、#1575 声明）只有在 WebView<114 的兼容档设备上才会显现，本机
模拟器内核是新版，复现不了。**未做设备验证**，进发版候选前需要在兼容档设备上补一次。
