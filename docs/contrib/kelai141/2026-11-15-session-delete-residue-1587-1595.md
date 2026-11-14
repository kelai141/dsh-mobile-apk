# 会话删除的两条残留面 + 路由热重载（#1587 #1595）

## 现象

- **#1587**：用户点了「永久删除」，接口回 404 `not-found`，客户端按「已删除」收尾（清待办、移除行），
  而整份会话数据仍在磁盘上，之后**没有任何入口能再删它**。
- **#1595**：HMR 重载或设置页「禁用→启用」插件之后，插件整体装载失败。

## 真因

### #1587 有两条残留面，不是一条

前一半（#1587 原报）是隔离区：会话被隔离到 `<工作区>/.corrupt/<id>.<ts>` 之后，
`findSessionDir` 只报 not-found，而 `removeSession` 从不查隔离区 —— 已在 PR #1587 修掉
（`deleteStoredSession` 现在把 `findQuarantinedDirs()` 的命中一起删）。

后一半（本轮）是**删除自身留下的墓地目录**：`deleteResolvedSessionDir` 先把目录 rename 成
`<id>.deleting-<slug>` 再 `rm`；`rm` 失败（EACCES / ENOSPC）或进程被杀时，目录就停在那里。
此时 `findSessionDir` 找不到（名字已不是 id）、`findQuarantinedDirs` 也找不到（不在 .corrupt/）
⇒ 路由 404 ⇒ 客户端成功收尾，而数据仍在，**重试也永远删不掉**（只能等下次启动 sweep）。

实测（本机，修前）：

```
# 只留 <id>.deleting-abc，其余全无
deleteStoredSession -> throws not-found    (期望：删掉它)
graveyard still exists -> true
```

### #1595

`webServer.register()` 运行期返回 disposer，同名 `(kind,path)` 重复注册会 throw，而 WebServer
本身不按 fiber 回收路由。三处裸调 + 丢 disposer ⇒ 新 fiber apply 时旧 handler 还在表里。

## 修法

- `findGraveyardDirs(root, sessionId)` 枚举 `<工作区>/<id>.deleting-*`（链接一律跳过：
  rename 只会搬真目录，顺着链接删就是删树外），`deleteStoredSession` 把命中并入删除目标。
- 隔离入口在「存储与隔离都没有、只剩墓地目录」时报 `deletion-incomplete`（409，带 paths），
  不再报 not-found（会被当已删除）也不报 already-quarantined（不保证可恢复）。
- 客户端把 `deletion-incomplete` 翻成「上一次删除没清完文件，数据仍在磁盘上。再点一次「删除」即可收尾。」
  错误映射（`errorText`）与续做 toast（`resumeText`）各补一条 —— 两处是同一份词典的两个读点，
  漏一处就是「确认框里说人话、自动续做时摊英文原句」。
- 隔离件**不做过期**（可恢复承诺，删了就是替用户删历史），但 `inspectQuarantine()` 在启动时把
  条数与字节数写进 `engine.log`：这是 #1587「磁盘单调增长」那一半能做到的最小实事 ——
  让增长可见，而不是替用户删数据。
- 三条 host 路由改成 `ctx.effect(() => ctx.webServer.register({...}))`。

## 复验

`cd plugins/dsh-session-delete && npm test` -> `tests 88 / pass 88 / fail 0`。

负控（每次都用 `git diff --stat` 确认正式改动仍在；不用 `git stash`——它整仓共享）：

| 退化形态 | 结果 |
|---|---|
| 三条路由退回裸调（不挂 effect） | `#1595` 一条红：`fiber 卸载后路由必须撤掉`，actual 仍是三条路由 |
| `deleteStoredSession` 不并墓地目录 | `#1587` 两条红：只剩墓地目录时报 not-found / 与存储+隔离一起命中时未清 |
| `deletion-incomplete` 退回 `not-found` | `#1587` 一条红：隔离入口把「文件还在」报成不存在 |
| 客户端去掉 `deletion-incomplete` 文案映射 | `#1587` 两条红：确认框与续做 toast 都落回兜底英文原句 |

## 验证边界

未做设备验证（无快照重建预算、本轮不跑 APK 全链）：改动全在快照内 runtime JS
（`plugins/dsh-session-delete/{src,lib}`），生效链是「`npm run build` → 快照树 → 引擎重读」。
进发布候选前需按 AGENTS.md §2.1 补：热推该插件到设备 → 造一个「只剩 `<id>.deleting-*`」的
`.dsh/sessions` 现场 → 点永久删除 → 断言 `adb shell ls` 里该目录消失且未报 404；
再禁用→启用一次插件，断言 `engine.log` 无 `duplicate exact route`。
