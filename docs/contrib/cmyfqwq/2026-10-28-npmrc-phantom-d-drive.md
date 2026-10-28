# 仓库内 `.npmrc` 写死 Windows 缓存路径，每次 npm 调用都在仓库里造幻影目录（2026-10-28）

## 现象

跑任意 `npm` 命令（门禁里的 `npm test` 也算）之后，仓库里冒出未跟踪目录：

```
?? dsh-client-ui-responsive/D:/
```

展开是 `D:/coding/dsh-mobile/.npm-cache/_logs/2026-10-28T10_45_11_919Z-debug-0.log` 之类的 npm 日志。
一次门禁跑下来生成 6 个文件，且**每次跑都重新生成**（删了还会再来）。

## 真因

仓库里有两份**被 git 跟踪**的 `.npmrc`，各自只有一行：

```
cache=D:/coding/dsh-mobile/.npm-cache
```

（`dsh-client-ui-responsive/.npmrc`、`dsh-shell-termux/.npmrc`，作者 kelai141 于 2026-08-27 的
`cf05fe66` 加入——那是 Windows 开发机上"把 npm 缓存从 C 盘挪到 D 盘"的偏好。）

npm 把 `cache` 当路径处理；在非 Windows 主机上 `D:/coding/...` 不是绝对路径，而是**相对当前目录**，
于是在仓库里按字面量逐级新建 `D:/` → `coding/` → `dsh-mobile/` → `.npm-cache/`。

这不是"环境没配好"，而是**机器特定配置进了版本控制**：任何 Linux/macOS 检出（包括 CI）都会照做。

## 已发生的真实损失

同一形态在 2026-10-25 造成过事故：一次 PR 里混进 **702 个 `D:/` 垃圾文件**（`changed_files` 直接失真）。
当时修的是"把垃圾删掉"，**没有修生成源**，所以今天照样复现。

## 同族先例（就在同一个文件里）

`.gitignore:39-41` 已经有一条：

```
# Windows 环境变量展开失败产生的幻影目录（字面量 %SystemDrive% 被当成目录名，
# 内含 ProgramData\Microsoft\Windows\Caches\*.db）。它不是仓库内容，任何提交都不该带上。
%SystemDrive%/
```

即"Windows 路径被当字面目录名"这件事**已经被承认过**，只是 `D:/` 这个来源当时没被追到。
所以这次不是新增一条政策，而是把同一政策补完（并顺手把源头关掉，比只 ignore 更进一步）。

## 修法

1. **关闭生成源**：删掉这两份 `.npmrc`。缓存位置属于机器/用户级偏好，不该进仓库；
   需要自定义的人放到用户级 `.npmrc`（`%USERPROFILE%\.npmrc`）即可，不入库。
2. **补忽略项兜底**：`.gitignore` 增加 `D:/`，兜住本地遗留目录与旧检出（那条忽略项同时写了来历，
   免得下一个人以为是新垃圾又误提交）。
3. **不引入新的机制**：缓存位置本来就有两处**正确的**做法——`scripts/build-release.ps1` 用
   `$env:npm_config_cache = Join-Path $root ".npm-cache"`，`check-plugin-tests.mjs` 的 WSL 分支用
   `npm_config_cache=/tmp/dsh-mobile-npm-cache`。都是"脚本里给环境变量"，随构建退出即失效，
   不需要仓库里留配置。

## 复验证据

- 删除后 `npm config get cache` 回到用户级默认（不再是仓库内相对路径）。
- 跑一次完整 `node scripts/check-plugin-tests.mjs`（内部两次 `npm` 调用，正是原先每次都会造垃圾的路径）
  ⇒ 仓库内 `find . -maxdepth 3 -name 'D:'` **0 个**。
- 忽略规则生效：手工 `mkdir -p 'dsh-client-ui-responsive/D:/coding/x'` 后 `git status --porcelain`
  看不到它。
- 未做设备验证：改动是仓库配置与忽略规则（L0/L1），不涉及 APK 行为。
