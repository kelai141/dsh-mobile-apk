# 按天日志的写者互斥 + 快照构建的比较口径（2026-11-04，issue #1509 / #1511）

## 现象

- #1509：`dsh-<date>.log` 偶发缺行，缺失的行出现在同一天 `.1.log` 里；且 `.1.log` 有时只剩一两行，
  上一代被冲掉。典型发生在开机分段插桩阶段（`emitBootSegments` 的调用线程与 probe 尾线程同时落盘）。
- #1511：装 `-SN-*` 快照包的测试者**永远收不到后续快照**，检查更新恒回「已是最新」；
  而正式版用户正常。

## 真因

两处都是「同一个事实在两个地方各有读数」，但表现面不同。

- #1509：`appendToDayFile` 是**无锁**的「`exists()`/`length()` → 可能轮转 → `appendText`」三连，
  而这串操作**不是原子的**。该文件有多个写者（`log()` 的调用线程、`tick()` 的调度线程、
  `emitBootSegments()` 的调用线程与 probe 尾线程）。两个写者交错时：① 一方刚把主文件 rename 走、
  另一方仍握着旧句柄追加 ⇒ 那几行落进 `.1.log`，主文件缺行；② 双方同时判定超限 ⇒ 各自轮转一次，
  前一代 `.1.log` 被后来的 rename 撞掉。同一类缺陷 #1366 已在**分段日志**上修过（`segmentsLock`），
  但按天日志这一份没跟上——锁是**按文件**加的，不是按「日志」这个概念加的。
- #1511：`currentVersion()` 在**取值处**就把 `-SN-.*` 剥掉了。于是 `isNewer(tag, current)` 里
  `prereleaseOf(current)` 恒为 `null`，落到 `preB == null -> false` 分支——
  「当前是预发布版」这个事实在比较开始之前就被抹掉了。#1365 补的预发布段比较（`prereleaseOf` /
  `comparePrerelease`）因此**对快照构建完全不可达**：判据在，喂给它的数据已经残缺。

## 修法

- #1509：`appendToDayFile` 只留「算日期 + 脱敏」两件事，落盘收口到新的 `appendDayFile(dir, day, text, shouldRotate, rotate)`，
  整段 `synchronized(dayFileLock)`。轮转判据与动作**做成参数**——这不是为了可测性而拆，而是因为
  互斥本身只有在「能卡住临界区」时才可观察：注入一个会等待的 `rotate`，另一个写者是否被挡在外面就成了设备无关的事实。
- #1511：把剥离从取值处挪到展示处。`currentVersion()` 返回 `VERSION_NAME` 原值（比较用），
  新增 `displayVersion()` 剥 `-SN-*`（上屏 / 读屏 / 引导页）。两个 accessor 都留了 `raw` 参数并默认
  `BuildConfig.VERSION_NAME`，生产调用点零改动；参数只为让 JVM 单测能喂 SN 形态（见下）。

## 判据（都能真打红）

`DayFileLockTest`（4 例）：① 轮转被卡住时发起的第二个写者，其内容**不得**出现在被 rename 走的 `.1.log` 里，
且新一代主文件必须按序拿到两条；② 三个写者并发时，临界区内同时在场的线程数峰值必须是 1；
③ 未超限不轮转但照常落盘；④ 超限时默认动作把旧代整段搬进 `.1.log`。

`UpdateCheckerSnapshotBuildTest`（6 例）：① `currentVersion()` 不得剥后缀（判据打在**生产取值函数**上）；
② 同核心后续快照（`SN-1-14 > SN-1-13`）必须判更新，反向与等值必须 false，序号按数字比（`SN-1-100 > SN-1-99`）；
③ 核心抬升（`0.14.7`）对快照用户成立；④ **反向保护**：正式版用户不得被同核心快照提示更新；
⑤ `fx` 修订链与 SN 叠加时方向不变；⑥ `displayVersion` 剥 SN，并显式断言**拿它去比较会丢序号**（缺陷本形）。

负控（真打红，已复验）：

- #1509：把 `appendDayFile` 的 `synchronized(dayFileLock)` 去掉 → `DayFileLockTest` 4 例中 **2 例 FAILED**
  （① 迟到行落进 `.1.log`、② 临界区峰值 3）。恢复后 4/4 绿。
- #1511：把 `currentVersion()` 改回 `raw.replace(Regex("-SN-.*$"), "")` → `UpdateCheckerSnapshotBuildTest`
  6 例中 **2 例 FAILED**（① 取值处不得剥后缀、② 同核心后续快照必须判更新）。恢复后 6/6 绿。

## 复验

- `.gradlew.bat testDebugUnitTest` → BUILD SUCCESSFUL，2447 例 0 失败 2 跳过。
- `node scripts/check-code-map.mjs` → PASSED；`node scripts/check-kotlin-test-count.mjs` → PASSED；
  `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-release-gates.mjs` → 见 PR。
- **未做设备验证**：本机无可用设备。两处修法都不引入新的设备面（#1509 是进程内互斥，
  #1511 是纯字符串比较口径），但真机装机验证仍须在发版候选前补。
