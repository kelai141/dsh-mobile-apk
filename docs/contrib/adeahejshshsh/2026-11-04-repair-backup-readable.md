# 修复助手的备份改为「可读不可写」（2026-11-04，issue #1367）

## 现象

修复助手的 `write` 会为被覆盖的文件留备份并回传 backup id，系统提示词也承诺「write 会备份」，
但 `ensureAllowed` 对所有 `/repair-backups/` 路径一律拒绝：`read` / `list` 既不能枚举也不能读取。
bash 不可用时（正是该 Activity 的存在场景）模型没有任何回滚路径。

## 真因

那条闸门只表达了「备份是保留面」，没有区分**读**与**写**——一个 `contains("/repair-backups/")`
把两个方向一起拒了。于是「承诺会备份」与「备份取不回来」同时成立。

## 修法

抽出纯判据 `backupWriteDenied(path, write)`：**写拒绝、读放行**。

- 写仍然拒绝：备份是「最后一份好内容」，不该被模型改写；
- 只认 `/repair-backups/` 这个**路径段**或以其结尾——`my-repair-backups-notes.txt` 这类名字不误伤；
- 拒绝文案改成「只允许读取」，让模型知道该走哪条路。

## 复验

`RepairBackupAccessTest` 五条：备份文件/目录读放行、写拒绝、普通路径两向不受影响、
名字含 repair-backups 但不成路径段的不拦、以及 `ensureAllowed` 必须走这条判据（且不得回到旧形态）。

- **Kotlin 单测未在本机跑**（无 Android SDK/Gradle，由 CI 执行）。本机同判据脚本：判据模型对照通过，
  源码契约改前 3 条红、改后 3 条绿。
- `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-code-map.mjs` → PASSED。
- **未做设备验证**：本机无模拟器。修复助手里的「写坏 → 读回备份」真机复验见 PR 验收卡。
