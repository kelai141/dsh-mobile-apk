# SafeMode phase=writing 重入覆盖首轮备份（#982）

#683/#952 把安全模式拆成两阶段：`writing` = 状态已落盘但 patch 未必写完，`active` = 全部完成。
两阶段的**目的**是让中途失败可收敛（不许早退报成功）；它顺带让 `phase=writing` 可以重入。
本条修的是那次重入带来的数据丢失，与两阶段的方向本身无关。

## 现象

首轮进入在 ⑤ 写完 patch 之后、抬 `active` 之前失败（用户强杀 / OOM / home 级或
`package.json` 段写失败），状态停在 `phase=writing`，live patch 磁盘上**已经是过滤后的
最小化清单**。用户看到「进入失败」会再点一次「安全模式启动」；每次点击都传新 id
（`GuidePageRenderer.kt` 的 `SafeMode.newId()`）。然后点「退出安全模式」，第三方插件条目
**永久消失**。

## 真因

旧 `enter` 的早退只认 `active == true`，`phase=writing` 继续往下走，接着照旧：

- `SafeMode.kt:251`（修前）用**新 id** 造备份名 `safe-mode-backup-<id>.yml`；
- `:271` `original = patch.readBytes()` —— 此刻读到的是上一轮 ⑤ 写进去的过滤结果；
- `:297-315` 状态里的 `backup` / `backupSha256` 换成这份新备份；
- `exit()` 的 `loadBackup(backup, …, backupSha)` 主备份哈希**匹配**，于是整份还原「过滤后内容」。

首轮原字节仍在 `undo-snapshots/auto/safe-mode-recovery/`（内容寻址副本），但状态文件不再指向它，
UI 没有任何可达路径。

## 修法

重入（状态存在、`phase == writing`）且**原备份仍然有效**时复用原备份：文件在场、名符合
`safe-mode-backup-<原 snapshotId>.yml` 约定、哈希与状态里的 `backupSha256` 相等（读一次、
核一次、用这一次读到的字节，与 `loadBackup` 同款 read-once 纪律）。

复用分支做四件事：① `original` 取复用到的字节而不是 live patch；② 不重写备份文件；
③ 不重做 home / `package.json` 备份（它们的 live 内容此刻同样可能已被最小化）；
④ 状态是**首轮状态在 phase 维度的延续**（`JSONObject(existing)` 起底，只改 `active`/`phase`），
备份指针与 `snapshotId` 保持首轮值。第四点不是可选项：`backupFor` 用 `snapshotId` 校验
备份**文件名**后缀，若状态换成新 id 而文件仍叫首轮 id，`exit` 会判「备份路径不符合状态文件
约定」而拒绝退出——用户从「插件丢了」变成「退出不了」。

兜底保持不变：原备份缺失或哈希不匹配时照旧另造新备份。⑤ 照常重写，抬 `active` 的逻辑不变。

另加一道边界：首轮 live patch 不是普通文件时代入的是合成空清单（`EMPTY_PATCH_BYTES`），
那不是用户原文，**不参与复用**——否则退出会写回一份凭空的 `[]`。

## 证据

- 负控 `SafeModePartialPhaseTest.writing 阶段重入不得把已过滤的 patch 当原文备份`：
  修前红，差异 `expected:<- insert:
> but was:<>`（退出后 patch 变成空串，第三方条目全丢）；
  修后绿。
- 变异验证：把复用分支改成恒不命中（`usable && false`），该用例重新判红——说明它打的正是这条路径。
- 同族 5 个测试类全绿：`SafeModeTest` 35、`IndependentSafeModeRestartTest` 9、
  `SafeModeRestartDecisionTest` 9、`SafeModeInsertBoundaryTest` 7、`SafeModePartialPhaseTest` 5。
- `check-kotlin-comments` PASSED。

issue 原文的复现脚本里 `home.delete(); home.mkdirs()` **不会**让 ⑤ 失败：`enter` 在
`:268` 用 `homeExisted = homePatch.isFile` 取快照，目录不算文件，于是 home 段整段跳过。
真正打中 ⑤ 的注入点是「patch 写入成功后立刻抛」（`atomicWrite` 回调），本轮用例即如此构造。

## 未做设备验证

改动在纯逻辑面（`SafeMode` 的进入状态机，JVM 可测），风险档 L1。已交单测 + 受控负控，
未做设备验证。
