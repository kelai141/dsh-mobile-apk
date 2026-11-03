# vendor/dsh-undo-savepoint — 移动端适配固化副本

> 上游：[lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint) `0.4.9`
> 移动端差异包括 `lib/client.js` 的移动端裁剪、`lib/core.mjs` 的 safe 语义对齐，以及 `lib/index.js` 的 U1 路由鉴权补丁（由 `scripts/patches/apply-patches.mjs` 管理，见本文档差异表）。
> 本副本是快照注入链的固定来源（`scripts/build-apk-013.ps1` 注入源 = `vendor/dsh-undo-savepoint`），
> 构建前由统一补丁 runner 与 #222 路由门禁共同校验，非目标版本或缺少安全补丁拒绝打包。

## 追版历史

- **0.3.8 → 0.4.9（2026-09-26，fx-2 缺陷 E）**。两条安全级动因：
  1. **0.4.9 把 `settings.yaml` 纳入脱敏**。我方 0.3.8 的 `SENSITIVE_DESTS` 只含
     `home-.env` / `profile-.env` / `home-.credentials.yaml`，**不含 settings.yaml**，
     而快照范围（`lib/spec.json` 的 `configFiles`）**含** `{root:"home", rel:"settings.yaml"}`
     ⇒ 追版前会把 settings.yaml **明文**写进快照与导出包。0.4.9 的集合为
     `'home-.env','profile-.env','home-.credentials.yaml','home-settings.yaml'`。
  2. **0.4.4 起**：导入 ZIP 条目名校验 + 解压大小上限；局内/局外 REST API 跨源校验（跨源 403）；
     脱敏覆盖 YAML 列表项/块标量/env 跨行值。

## 为什么 vendor（而非直接注入上游 clone）

1. 上游 `lib/client.js` 是编译产物（无 src 仓库面），移动端裁剪只能改成品文件；
   为「可重现 + 可门禁」，将裁剪版成品固化进 vendor（与 `vendor/dshmarketplace-plugin` 同模式）。
2. `.deploy-tmp/dsh-undo-savepoint`（上游 git clone）不入库、易变；vendor 是唯一可追溯来源。

## 与上游 0.4.9 的差异（由 `scripts/patches/apply-patches.mjs` 幂等施加）

| # | 面 | 状态 | 变更 | 原因 |
|---|----|------|------|------|
| E1 | `lib/client.js` | 重锚（原位命中） | 移除会话头部「撤销/恢复/快照」三按钮 | 产品决策（2026-08-23）：手机头部只留「快照」徽章；撤销/恢复在设置页快照分区与快照面板内。0.4.9 的 `UndoHeader` 与 0.3.8 同形，锚点原样命中 |
| E2 | `lib/client.js` | 重锚（原位命中） | 移除 `KeyBindRow` 函数区域 | 快捷键配置组件在手机上无用武之地 |
| E3 | `lib/client.js` | 重锚（原位命中） | 移除 `settings.general.item` 注册块（id `undo-keys`） | 手机无键盘；旧版把 Ctrl+Alt+Z/Y 行渲染进通用设置 |
| E4 | `lib/client.js` | 重锚（原位命中） | 移除全局 `keydown` 监听 | 快捷键配置被移除后成为死监听 |
| E5 | `lib/client.js` | 重锚（原位命中） | 移除 `exports.KeyBindRow` | 清理导出 |
| E6 | `lib/client.js` | 重锚（原位命中） | 徽章去掉相对时间（只留「已存 N 份快照」） | 真机实测：长文本与「Session log」按钮重叠 |
| E7 | `lib/client.js` | 重锚（原位命中） | `.u_badge` 封顶 `max-width:30vw` + 省略号 | 双保险：极端宽度下截断而非重叠 |
| E8 | `lib/client.js` | 重锚（原位命中） | 快照徽章折叠成小绿点，数量挪进 title/aria-label | 2026-09-10 用户定例：360dp 竖屏头部被模式徽章/打开方式/…/右栏键占满 |
| S1 | `lib/core.mjs` | **新增（本版分叉）** | safe 生成对齐壳侧 `SafeMode.kt`：只摘第三方 insert 子条目，保留 `@deepseek-ai/*`、`@dsh-android/*` 与两个具名插件，且保留全部顶层 `disabled: true` | 用户口径「undo 要确保保留我们自己的插件」。上游 `safeModeSet` 原把 `cordis.patch.yml` **整份覆写**成只含一条 insert 的最小文件，实测会摘掉 12 个 `@dsh-android/*` 引用与 7 条 disabled（含**安全关键的 `client-hmr`** ⇒ 会重开无鉴权的 `/plugins/events` SSE） |
| U1 | `lib/index.js` | 重锚 | `/api/undo` prefix 在 handler 首行执行 Host/Origin、浏览器会话或壳侧实时 controlToken 鉴权；403 不可由 token 绕过，拒绝与成功 JSON 均 `no-store`，且拒绝先于 body 读取、快照枚举和任何写操作 | apk #222：更长 prefix 绕过 `/api` 信任栅栏；所有读写必须 fail-closed。**上游 0.4.9 新增的 M2（跨站 CSRF：Origin/Host 不符即拒）不替代本条**——M2 不做壳侧 controlToken、不做 `connection.requestRejection` 会话栅栏、也不保证「读 body 前失败关闭」 |
| M1 | `lib/core.mjs` | **新增（本版分叉，issue #1400）** | `readMessageOps` / `appendMessageOp` / `pruneMessageOps` 一律先过批次 id 白名单 `/^[A-Za-z0-9_-]{1,64}$/`；非法 id 在读取侧按「没有这个批次」fail-closed（不回显落盘路径），写入侧抛错，prune 侧跳过 | 缺陷形态：id 被直接拼进 `join(messageOpsDir(cfg), `<id>.json`)`，既不过滤 `..` 也不过滤分隔符。`POST /api/undo/message` 的 `body.id` 与工具参数 `message_id` 都直达该拼接点，传 `../../<相对路径>` 即可**读取并应用快照目录之外的任意 `.json`**，再按其中记录的路径执行还原/删除——越界读写且无需任何凭据。prune 侧另有一条：`b.id` 来自**文件内容**，一个被构造过的批次文件同样能把删除带出目录 |
| M2 | `lib/core.mjs`、`lib/index.js` | **新增（本版分叉，issue #1398 #1399）** | ① `createSnapshot` 的快照 id 占位改为「`mkdir(dir)` 不带 recursive + EEXIST 换 id 重试」（8 次上限，失败即抛），不再用 `pathExists` 预检；② `restore` 增加进程内单飞标志 `cfg.undoBusy`（检查与置位之间无 `await`），原函数体原样改名 `restoreOnce`，`finally` 复位；`index.js` 的 `cfg` 显式声明 `undoBusy: false` | ① 缺陷形态：预检与 `mkdir(recursive:true)` 之间是 TOCTOU 窗口，且 recursive 吞掉 EEXIST —— 同一秒内并发两次 `createSnapshot`（并发撤销各自建 pre-restore 就会这样）落进同一目录互相覆盖。修法要点：占位失败后**绝不**退回使用该目录，必须换 id 重试，否则只是把竞态换成覆盖。② 缺陷形态：`restore` 唯一前置 `if (hasOpenTurn())` 只读不置位，两次并发撤销都能通过，各自建 pre-restore 并交错 `applySnapshot` —— 文件集覆盖成混合态，还多出两个 pre-restore 快照 |
| M3 | `lib/client.js`、`lib/index.js` | **新增（本版分叉，issue #1392）** | ① 面板的「撤销」按钮从前置确认改为 `undoNow()`：先向 `/api/undo/diff?id=undo` 取预览（目标由服务端按 `undoCandidates` + `sameState` 算，与真正撤销**同一份判据**），确认框里列出会改的文件与增删行数；取消即 `return`，**一个破坏性请求都不发**；`noTarget` 时也不发。② 成功后不再 `location.reload()`，改派发 `dsh-undo-config-changed` 事件（detail 带 label 与 targetId） | 缺陷形态：撤销是唯一没有二次确认的破坏性动作（恢复 / 删除 / 安全模式都有 `confirm`），也没有 diff 预览；且成功后 350ms **整页 reload**，会把正在进行的一轮回复直接掐断（页面被整页重建）。reload 存在的唯一理由是「让页面重新读配置文件」——宿主监听该事件做局部刷新即可；没有监听方时最多配置展示滞后，比静默打断会话安全 |

保留：头部徽章（`u_badge`，点击打开快照管理面板）、`SnapshotPanel`（快照列表/回滚/删除/手动存档）、
设置页「快照」分区（自动兜底开关、watch 防抖、保留数、自动清理、脱敏模式、目录）。

## 0.4.9 的结构变化（追版时要注意）

`lib/` 由 0.3.8 的 3 个文件拆为 **8 个**：`index.js`（68706 B，仍是入口）、`client.js`（62129 B）、
**`core.mjs`（139650 B，主体实现在此）**、`zip.mjs`、`i18n.mjs`、`i18n/{en,zh}.json`、`spec.json`。

因此 `scripts/patches/tests/undo-route-auth.test.mjs` 的临时副本**必须整目录拷 `lib/`**
（只拷 `index.js` 会 `ERR_MODULE_NOT_FOUND: .../lib/core.mjs`），且文本文件要归一为 LF。

## 重新 vendor 流程

```bash
# 1) 拉上游 0.4.9（npm pack 或 git clone）
npm pack dsh-undo-savepoint@0.4.9 && tar -xzf dsh-undo-savepoint-0.4.9.tgz
# 2) 覆盖本目录（保留 PATCHES.md；lib/ 整目录替换）
# 3) 施加全部补丁
node scripts/patches/apply-patches.mjs vendor --apply \
  --only undo-E1,undo-E2,undo-E3,undo-E4,undo-E5,undo-E6,undo-E7,undo-E8,undo-safe-align-S1,undo-safe-transaction-S2,undo-api-auth-U1
# 4) 门禁自验
node scripts/patches/apply-patches.mjs vendor --check   # 退出 0
```

## 第二份 safe 实现（离线急救 CLI）

`scripts/dsh-undo-emergency.mjs`（== `dsh-mobile-apk/app/src/main/assets/undo-emergency.mjs`，逐字节镜像）
的 `safe-mode on` 已同步到同一口径（只摘第三方、保留自有插件与 disable 行），
与插件核心 S1、壳侧 `SafeMode.kt` **三处同语义**。约束：`safe on` → `safe off` 后
`cordis.patch.yml` 逐字节等于进入前（`off` 仍走整份备份还原，未改）。

## safe 语义路线选择（为什么选「对齐」而不是「退役」）

两条路都评估过：

- **路线 1（已采纳）**：把 vendor 的 safe 生成逻辑对齐壳侧 `SafeMode.kt` 口径（本条 S1）。
- 路线 2：让 `undo_safe_mode` 工具退役、safe 一律走壳侧。

**选路线 1 的理由**：`undo_safe_mode` 是**模型工具面**的入口，而壳侧 `SafeMode.kt` 是 **UI 按钮**的入口。
设备起不来时用户常常只能靠对话/工具面求助；让工具面退役等于在「最需要 safe 的场景」里把那条路堵死，
或必须额外做一层「转发 + 明确拒绝」的语义（正是路线 2 的待确认项）。
代价是这是 **vendored 分叉**，每次追上游都要重做——已在本文件与 `registry.json` 登记，且
`apply-patches.mjs --check` 会在分叉丢失时判红（marker `dsh-mobile safe keeps shipped plugins (S1)`）。

三处实现（vendor `core.mjs` S1 / 离线 CLI `dsh-undo-emergency.mjs` / 壳侧 `SafeMode.kt`）
**同语义**：只摘第三方 insert 子条目，保留 `@deepseek-ai/*`、`@dsh-android/*` 与两个具名插件，
并保留全部顶层 `disabled: true`。
