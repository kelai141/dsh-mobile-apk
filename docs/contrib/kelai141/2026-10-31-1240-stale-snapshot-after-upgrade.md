# issue #1240：覆盖安装后引擎仍在跑，快照刷新被静默跳过

## 现象

设备上已装过本 App 且引擎在运行，覆盖安装一个内嵌快照不同的 APK，系统拉起应用后：

| 项 | 覆盖装后（引擎在跑） | force-stop 冷启动后 |
|---|---|---|
| `.snapshot-transaction` | 从未出现 | 出现后消失 |
| `.snapshot-fingerprint` | 旧值不动 | 翻转到新值 |
| runtime `client.js` | 旧字节数 | 新字节数 |
| boot-fail 记录 | `engine-start-deferred-no-transaction` | 无（正常） |

用户视角是「这版没修那个问题」，实际是跑着上一版的 runtime；排查视角是 boot-fail.log
里**没有任何一条**指向快照的痕迹。不报错、不提示、不降级。

## 真因

`EngineStartFlow.start()` 的探活分支：

```kotlin
val engineAlreadyRunning = startupRecoverThenProbe(...)   // 探活
if (engineAlreadyRunning) { ...; return@Thread }          // 早退
if (!activity.engineManager.snapshotFresh()) { ... }      // 刷新（永远轮不到）
```

判据 `snapshotFresh()` 本身是对的（`SnapshotFingerprintPolicy.fresh` = `nodeExists && bundled.fingerprint != null && committed == bundled.fingerprint`），
缺陷只是**它排在早退之后**，因此「引擎已在跑」覆盖安装后永不执行刷新。
issue 报告的行号（649/689/704）在当前 main 上已漂移到 635/675/690（语义一致）。

## 修法（选 A 不选 B）

探活结果**不再是早退的充分条件**，而是「要不要先停旧引擎」的一个输入：

- 快照就绪 ⇒ 维持既有早退（`EARLY_EXIT_FRESH`）；
- 快照陈旧 ⇒ 先 `stopOwnedEngine()`（只停本壳持有句柄的子进程，绝不按名字杀未归属监听器），
  再落到同一条刷新 → 重启链（`STOP_THEN_REFRESH`）；
- 停失败 ⇒ 写独立 boot-fail stage `snapshot-refresh-blocked-engine-running` + 可读错误页，
  **不**带着活动引擎进 `refreshSnapshot`（刷新要 swap `usr/` 树，带活动引擎解压会写坏正在使用的路径）。

判据抽成纯函数 `alreadyRunningSnapshotDecision(snapshotFresh)`，两条方向都能单独反证。

**为什么不做方案 B**：B 只是把静默劣化变成可见提示，用户升级后仍跑旧代码，缺陷本体（该刷不刷）没解决。
A 里已经吸收了 B 里唯一有价值的部分——失败路径**不再静默**：独立 code、如实文案、可读错误页。

## 两条负控（各自真红，见 PR）

1. 正控 A：`alreadyRunningSnapshotDecision` 改回无条件 `EARLY_EXIT_FRESH`（= 旧行为）⇒
   `staleSnapshotWithARunningEngineMustNotEarlyExit` 红。
2. 负控 B：改成无条件 `STOP_THEN_REFRESH`（= 保险起见每次都刷）⇒
   `freshSnapshotWithARunningEngineMustStillEarlyExit` 红。

只做 A 不做 B 的「修法」等于每次启动都白付一次 8-12 分钟重抽取，比不修更坏。

## 复验

```
.\gradlew.bat :app:testDebugUnitTest        # 全量
node scripts/check-code-map.mjs             # 锚点随插入行位移同步刷新
node scripts/check-kotlin-comments.mjs
node scripts/check-kotlin-test-count.mjs
```

设备验收 **DEFERRED**：需要「先装旧包（引擎跑起来）→ 覆盖装新包 → 观察 TX 出现/消失与指纹翻转」
的序列，本轮拿不到该设备序列，不假装验过。补验步骤见 issue 正文 §复现。
