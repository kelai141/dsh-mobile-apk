# 锁条目越出包目录：一个包都装不上，而门禁全绿

日期：2026-11-15
范围：`dsh-shell-termux/package-lock.json`、`scripts/source-build/check-package-lock-roots.mjs`（+ 单测）

## 现象

云端 `build-apk.yml` / 新加的调试包链在「准备并构建插件」步失败：

```
Error: npm install --package-lock-only 就地重写了 package-lock.json（b35c2d91c11e4d04 -> d398be545f980812）。
提交进仓的 lock 不完整（缺 resolved/integrity 或已过期），CI 不得静默从 registry 补齐后照单安装。
Lock graph diff (committed -> resolved):
  added by CI (55): node_modules/`deepseek-ai/cordis, ...
  changed (55): ../../apk/dsh-shell-termux/node_modules/`deepseek-ai/cordis, ...
```

报的是「lock 不完整」，`Fix` 行让去重跑 `npm install --package-lock-only` 并提交。**照做没有用**。

## 真因

`15ac3f86`（把手机控制切到原生链路）之后，`dsh-shell-termux/package-lock.json` 被整份重写成了**另一个目录布局**的形态：

```
`version`: `file:../../apk/dsh-shell-termux`,        <- 顶层版本不是 0.2.0
`../../apk/dsh-shell-termux/node_modules/...`: {...}  <- 55 条键全部越出包目录
```

这份 lock 是在**协调仓**里跑的 npm：那边 `apk/dsh-shell-termux` 是指向本仓的符号链接，npm 于是按协调仓根算相对路径。在本包目录里它等于空锁：

```
$ npm ci                       # 在 dsh-shell-termux/ 里
npm error code EUSAGE
npm error npm ci can only install packages when your package.json and package-lock.json ... are in sync.
npm error Missing: `deepseek-ai/cordis`4.1.0 from lock file
```

## 为什么没被挡住

`check-package-lock-roots.mjs` 当时只比 `packages[""]` 的 name/version/四类依赖 —— 而那一层**是好的**（`version: "0.2.0"`，依赖声明一字不差）。坏的只有顶层 `version` 和全部非根键。门禁照印「根声明一致: 9 个目录」退 0。

云端暴露点则绕了一圈：`install-project-dependencies.mjs` 先跑 `npm install --package-lock-only`，npm 把 lock 就地改回正常形态（键数 56 -> 111），于是触发 issue #1615 的「就地重写」判据。判据本身没错，但它的文案指向「缺 resolved/integrity」，与真因（目录布局错）相距很远。

## 修法

1. **lock 恢复**：本包 manifest 自 v0.14.11 起一字未改（`git diff v0.14.11 origin/main -- dsh-shell-termux/package.json` 为空），故 v0.14.11 那份 lock 的**图**就是正确图；把键名去掉 `../../apk/dsh-shell-termux/` 前缀后与现状逐条比对：键集合相同、每个条目的内容零差异。据此恢复该文件（复验：`npm install --package-lock-only` 就地跑不重写、`npm ci` 退出 0、装 47 个包）。
2. **判据补两条**（`check-package-lock-roots.mjs`）：
   - 顶层 `name`/`version` 必须与 `package.json` 一致（根声明检查看不到这一层）；
   - `packages` 里以 `../` 开头的键，其包名必须在 manifest 中以 `file:`/`link:` 声明 —— 越界条目只有这一种合法来源（`plugins/dsh-android-linux-env` 的 `../dsh-android-bridge` 等三个就是这样）。
   报错文案里直接带修法（「在本包目录重跑 `npm install --package-lock-only --ignore-scripts`」），不再让人照着「缺 resolved/integrity」白跑一遍。

## 证据

- `node scripts/source-build/check-package-lock-roots.mjs .` -> 正控 `package-lock 根声明一致: 9 个目录` 退 0；把 origin/main 那份放回去 -> 退 1，并点名 `55 条锁条目越出包目录` 与顶层 version 不一致。
- `node --test scripts/source-build/check-package-lock-roots.test.mjs` -> pass 4 / fail 0（新增 2 例：合法 `file:` 越界条目判绿；符号链接布局产出的 lock 判红并断言报错带修法）。
- `node --test scripts/source-build/lock-rewrite-guard.test.mjs scripts/source-build/install-project-dependencies.test.mjs` -> pass 16 / fail 0（未回归）。
- 未做设备验证：本改动只碰锁文件与构建链门禁，无壳侧/桥/权限面。
