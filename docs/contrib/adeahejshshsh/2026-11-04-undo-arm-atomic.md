# 自动回滚的 arm 文件改原子写，并把「存在但解析不出」判成损坏（2026-11-04，issue #1369）

## 现象

自动回滚的观察窗 arm 文件用 `writeText` 写（先截断后写），读取侧却把「文件存在」当「值有效」。
进程在窗口内被硬杀或磁盘满会留下 0 字节 arm 文件，`armedAt` 恒为 null ⇒ 每拍都判 ARM 并重写
⇒ 观察窗永不结束，自动回滚静默失效（用户侧表现为「感觉自动 undo 没生效」）。

## 真因

两处口径不一致：写侧用非原子写，读侧用「存在即有效」。中间态（0 字节）既不是「没有」也不是
「有效」，但读侧把它折叠成了「没有」，于是状态机每拍都重新开始。

## 修法

- 抽出 `writeAtomicText(target, text)`：同目录临时文件 → `fsync` → `ATOMIC_MOVE`（与同文件
  `writeRetryMarker` 的范式一致）；ARM 分支改用它。
- 抽出纯函数 `armState(exists, raw)` → `MISSING / VALID / CORRUPT`；`armedAt` 按三态处理：
  损坏则删文件并记一行（`arm file corrupt … observation window restarts`），下一拍重新起窗。

## 复验

`UndoArmFileTest` 五条：缺失/有效/损坏的矩阵（含 0 字节、空白、半截数字、非数字、null）、
arm 写入必须走 `writeAtomicText`（且不得回到裸 `writeText`）、`ATOMIC_MOVE` + `fsync` 在场、
`armedAt` 必须经 `armState` 分类且损坏分支删文件并留记录。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：改前 5 条红，
  改后 6 条全绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED
  （`UndoGate.kt` 锚点按内容重钉）。
- **未做设备验证**：本机无模拟器。硬杀/磁盘满的真机复验见 PR 验收卡。
