# dsh-session-delete

给会话行「…」菜单加一个 **删除对话**。引擎目前只有归档（issue #493），没有真正的删除；本插件补上。

## 组成

- **src/client.js**：两处注册
  - `sidebar.workspaces.session.menu.item`：「删除对话」（danger，order 500）。菜单项只记录目标——
    选中会关闭菜单并卸载菜单项，确认框若挂在这里根本不会出现；
  - `shell.overlay`：确认框本体（自绘 Modal，不用 `window.confirm`——壳侧会自动批准 JS 弹窗）。
    确认后 `POST /api/session-delete`，成功关闭弹窗并把该行隐藏。
  - **幂等**：只有带 `error: 'not-found'` 的 404 才算「已删」；宿主插件没加载时的 404 会正常报错。
  - **不做导航**：不碰 `clearMain` 这类 private 接口，也不点 DOM。
- **src/index.js**（host）：注册三个路由（日志走 stdout 的 `[dsh-session-delete]` 前缀——
  `ctx.logger.info` 在 Android 壳里不落 `engine.log`，实测不可见）
  - `POST /api/session-delete`：`connection.requestRejection(req)` 同源鉴权；只接受 `session-<uuid>`；
    请求体上限 4 KB；
  - 只有两条拒绝（409）：
    - `workspace/session-activity` 瀑布报告有活动 → `session-active`；
    - **探测状态未知**（provider 抛错 / 返回非数组 / 老引擎没有瀑布）→ `activity-unknown`，
      绝不把「不知道」当「空闲」；
  - **加载中的会话照常可删**：顺序是「定位目录与隔离副本 → 改名 → 卸载内存会话 → 清归档/置顶 → 删目录」。
    卸载放在目录移出扫描路径之后：目录不存在 / 不唯一 / 移动失败都发生在卸载之前，避免
    「报错但会话已经从内存消失、文件还在」。
    卸载走引擎自己的 teardown 边 `entry.detach()`（**维护者在 PR #496 里接受了插件内驱动这条边，
    不额外加引擎补丁**；上游若改名或改语义，插件会以 `unload-failed` 明确失败、文件不动）：移除 store 条目并派发 `session/disposed`，
    agent loop 据此释放 Agent、jsonl 持久化清理写入状态、api-session controller 广播
    `api-session/removed`——侧栏/搜索/历史因此自然消失，不需要 CSS 隐藏、也不需要重启应用；
  - **卸载失败 = 请求失败**（`unload-failed` → 409），磁盘文件保持原状（可恢复），
    不会再出现「目录删了、内存里还在」却报成功的情况；
  - 删除前 best-effort 调用 `workspaceRegistry.unarchiveSession/unpinSession`（失败只记日志）。
  - `POST /api/session-delete-trace`：客户端决策回传（写 engine.log，便于现场取证）。
  - `GET /api/session-delete-version`：构建戳，供页面自更新。
- **src/session-delete.js**：可单测的删除核心——定位 `<DSH_HOME>/sessions/<cwd-key>/<id>/`，
  存储目录命中 2 个报 `ambiguous`（一个都不删）。永久删除同时清除该 id 的所有 `.corrupt/<id>.<时间戳>`
  隔离副本；只有存储与隔离都不存在才报 `not-found`。枚举失败如实报错，不能成为客户端视为成功的 404。
  每个目录先 `rename` 成 `.deleting-<t>` 再递归删除；失败报告残留，重试可继续清理。
  启动 sweep 同时清理隔离区内明确删除产生的 graveyard，不自动过期清理可恢复的隔离件。

## 构建与安装

源码在 `src/`，`node build.mjs` 把 `src/**` 复制成 `lib/**`——快照注入只带 `lib/**` + `package.json`
（见 `scripts/inject-all.py` 的 `build_dsh_replacements`），所以 `lib/client.js` 必须存在。
`lib/` 是构建产物，不进 git。

启用：`scripts/profile-web.cordis.patch.yml` 里 `- id: session-delete` 的 insert（插件本身不带
`dsh.bundle.patch`，与仓库其它 `@dsh-android/*` 插件同一形态）。

## 验证

- `node plugins/dsh-session-delete/test/session-delete.test.mjs`：**21 项全过**（核心 + host 编排）
- `node plugins/dsh-session-delete/test/host-routes.test.mjs`：**11 项全过**（假 webServer 直驱三条路由：
  401/403/405/400 invalid-id/400 invalid-body/409 activity-unknown/404 not-found，
  以及成功路径——200 + 会话被卸载 + 目录被删；trace 路由的 POST/405；版本路由返回 stamp）
- `node plugins/dsh-session-delete/test/client-wiring.test.mjs`：**5 项全过**（无头 vm + 最小 React：
  点菜单 → 弹窗 → 确认 → 发请求；删当前会话 → 重载；超时重试到失败并记录错误码；404 幂等；
  待办续做——重载后自动发请求并清掉待办）
  （非法 id / 不存在 / 运行中拒绝 / live 先卸载再删 / detach 抛错报 unload-failed 且文件不动 /
  无卸载能力同样报错且文件不动 / 目录不存在时报 not-found 且会话仍在 live / 正常删除 + 记账顺序 / 重复命中不删 / 目录定位 /
  host 编排拒绝 / 归档置顶清理顺序 / 每步日志 / 探测抛错与非数组拒绝 / 无瀑布拒绝 /
  目录中途消失→not-found / post-rename 钩子失败不残留 / 接口契约：不调用 `flush(`、
  `clearMain`、`shortcuts.find`）。
- `node scripts/check-api-route-auth.mjs`：三道路由均登记为 protected。
- `node scripts/check-code-map.mjs`：新增文件已进覆盖账本。

## 边界

- 删除不可恢复；只删磁盘上的会话目录，不碰工作区本身。
- 会话正在运行（`session-active`）或活动状态无法确认（`activity-unknown`）时不能删。
- 归档/置顶集合的清理是 best-effort：失败只记日志，不阻断删除。
