# issue 批次 4：缓存归属、键条根绑定、安全模式半成品、更新包字节绑定（2026-10-28）

四条各自独立，共同点是**「状态活在内存/文件里，但缺少归属或收敛判据」**。每条都附了会在旧实现上判红的反证。

## #688 manage 控件清单：单槽 → 按「会话 + 目标屏」绑定

**现象**：多屏或两个会话并发时，先 dump 虚拟屏、再 dump 真实屏（TTL 10 分钟内），拿虚拟屏的 `n3`
去点真实屏，壳侧只校验 `gen` 与 ref 在集合内 ⇒ 回 `ok:true` 与一组坐标，实际点在另一块屏的同名节点上。
用户侧就是"点击位置与预期不符"，没有任何可判读信号。

**真因**：`uiCache` 是模块级单槽且不带屏幕/会话归属。工具调用可以并发，`await` 会让出执行权，
于是另一个会话的 dump 直接覆盖模块变量——`resolveRef` 用的是"上一次 dump"，`screenArgs(args)` 用的是"本次的屏"。

**修法**：条目带 `session`/`screenId` 归属标记；工具执行统一跑在 `AsyncLocalStorage` 作用域里
（`tools()` 返回处 `.map(withUiCacheScope)`），复用前 `usableUiCache()` 三重校验（TTL + 会话 + 目标屏），
不匹配一律当「没有清单」。两处 dump（无障碍 / uiautomator）都打标记——只改一处等于留一半后门。

**反证**：`plugins/dsh-android-manage/test/ui-cache-scope.test.mjs`（5 条源码契约：字段存在、
判据三要素齐全、包装器接线、**不得**再出现模块级单槽、两处 dump 都打标记）。
把任一处改回"只看 TTL"或摘掉 `.map(withUiCacheScope)` 即红。

## #690 九键条：reconcile 抢「全页最后一个终端根」

**现象**：分栏或多终端根时，两条键条叠在同一个根下、另一个根完全没有；而按键仍按各自的
`host.root` 发出 ⇒ 界面显示在 B、输入进的是 A，Ctrl 闩锁提示互相覆盖。

**真因**：单实例 `reconcile()` 用 `doc.querySelectorAll(TERMINAL_ROOT_SELECTOR)` 取**全页最后一根**
（`roots[roots.length - 1]`），无视 `host.root`。按根挂载那一层是每根一实例，两层口径不一致。

**修法**：`reconcile` 只认自己的 `host.root`；根已离开文档（React 卸载 / 历史 tab 被摘）就收摊，
等按根挂载那一轮重建。

**反证**：`test/keybar-root-binding.test.mjs`（4 条，纯源码文本，**不依赖 jsdom**——因为
`keybar-mount.test.mjs` 里的多根 DOM 用例在没有 jsdom 的机器上会整体 skip，那样"改回去"会静默通过）；
另在 `keybar-mount.test.mjs` 补了 3 条多根 DOM 用例（分栏两条 + keep-mounted 一条），有 jsdom 时执行。

## #683 安全模式：失败不回滚状态 ⇒ 半成品不可收敛

**现象**：进入安全模式失败后，状态已是 `active=true`。用户再点「安全模式启动」命中早退，
**返回成功**并去重启引擎，而被摘除的第三方 insert 条目永远不会补写 —— 页面继续报同样的插件失败，
却被告知"安全模式已生效"。唯一出路是"先退出再进一次"，没有任何提示。

**真因**：进入流程是「先落状态、后改 patch」，`catch` 只回失败回执、不回滚 `stateFile`；
早退判据只看 `existing.optBoolean("active")`。

**修法**（两处，缺一不可）：
1. `catch` 里把状态文件回滚到进入前——**但有一条例外**：如果 live patch 已被**部分改写**
   （写一半就失败/被杀），状态必须留着，否则 `off` 是唯一能把 live 还原回去的路，删状态等于把用户
   锁在半坏配置上。判据 = 与进入前的字节比对（生产 `atomicWrite` 是先写 `.tmp` 再 rename，失败时
   live 不变；内容比对是为了让注入式非原子写入的中断现场也能正确区分）。
2. 早退前加**形态判据** `livePatchLooksSafe()`：把当前 patch 再过滤一次，结果与原文逐字相同才认为
   live 已是安全形态，否则继续往下执行补写。

**反证**：`SafeModeTest` 新增两条——「patch 写失败时状态文件必须回滚，第二次进入会真的重写」与
「状态 active 但 live 未改时不得早退，必须补写」。既有用例 `写入中断后 marker 仍可驱动完整还原`
（半写场景）继续绿，正是上面那条例外的守门。

## #676 更新包：只判 exists + 目录只增不减

**现象**：`install()` 只判 `dest.exists()`；「安装未知应用」授权页可以停留任意久，期间另一个持
All Files Access 的应用能把同名 APK 换成别的字节 ⇒ 装进安装器的是 T0 的校验结论、T1 的字节。
另外 `updatesDir`（公共外部存储 `Documents/dshdata/updates`）全仓只有"写"没有"删"，
每换一版多一个 169MB 的包，进程被杀还会留下 `.tmp`。

**修法**：
1. 记下"已校验、允许安装"的产物与**它的依据**（`VerifiedArtifact`：大小 + sha256），
   拉起安装器**之前**按依据重跑 `verifyApkArtifact`；不通过就清掉续继载荷
   （`readyToInstall`/`currentResult`）并如实报错，避免下次「继续安装」把同一个坏包装进去。
2. 新增 `UpdateChecker.pruneUpdatesDir(dir, keepName)`：只保留本次目标包，删更早的 `*.apk` 与
   中断留下的 `*.tmp`；只删普通文件，不碰目录、不跟符号链接。下载开始前调用。

**反证**：`UpdateArtifactRecheckTest`（5 条）：清扫删旧包 + 删 tmp + 保留目标、不碰目录与无关文件、
目录不存在不抛；源码契约断言 `install()` 必须重跑 `verifyApkArtifact` 且复验失败要清续继载荷、
下载收尾必须把依据绑到产物上。

**未做设备验证**：本机无 ADB 设备，四条都只到代码层（JVM 单测 / node 测试 / 门禁）。
其中 #676 属更新链（L2），进发版候选前必须补 §2.1 三层，尤其要在真机上验一次"替换字节后安装被拒"。
