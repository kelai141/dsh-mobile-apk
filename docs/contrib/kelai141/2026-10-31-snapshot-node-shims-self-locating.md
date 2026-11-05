# 快照内 node 工具链 shim 自定位（多用户 user 10 前缀）+ 新增 usr/bin/npm（2026-10-31）

## 现象（真机上报，小米 12 / HyperOS 2 / Android 14，实例跑在 Android 多用户 **user 10**）

```
/data/user/10/com.dsharnessmobile.shell/files/usr/bin/pnpm[3]:
  /data/user/0/com.dsharnessmobile.shell/files/usr/bin/node: inaccessible or not found
=> exit 127
```

后果：所有走 pnpm 的安装（插件市场 / 普通插件 / subagent）全失败；DSH 插件页「添加插件」在
`pnpm view <spec> --json` 取元数据这一步就死（`spawnSync npm ENOENT`）。

## 真因（两条，同一个根：构建期把「当前用户」烧进了产物）

1. **pnpm shim 烧死前缀**。`scripts/build-snapshot-013.mjs` 第 7e 段用
   `NEW_PREFIX`（`/data/user/0/com.dsharnessmobile.shell/files/usr`，第 77 行常量）拼 exec 行：

   ```sh
   exec "/data/user/0/<pkg>/files/usr/bin/node" ".../pnpm/bin/pnpm.cjs" "$@"
   ```

   `/data/user/0` 只对 **user 0** 成立。多用户设备上应用数据在 `/data/user/<userId>/`，
   user 10 实例里 `/data/user/0/...` 不可达 ⇒ exec 报 inaccessible or not found ⇒ 127。

2. **usr/bin/npm 不是可用可执行体**。快照里它确实在场，但形态是**软链**
   `usr/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js`，而该 target 的 shebang 被构建期
   `scripts/fix-shebang.py` 的 B 类重写钉成 `#!/data/user/0/<pkg>/files/usr/bin/env node`。
   于是 pnpm 的 `passThruToNpm` → `spawnSync('npm', …)` 拿到的执行体其解释器路径在 user 10 上
   不存在 ⇒ 内核返回 ENOENT（不是「文件没找到」，是**解释器**没找到，报错文本形如 spawnSync ENOENT）⇒
   插件信息获取路径在前置就死。

   实测两种形态（emulator，快照树解到 `/data/local/tmp/u10` 模拟非 user 0 前缀，uid 2000 非 root）：
   ```
   $ /data/local/tmp/u10/usr/bin/npm --version
   timeout: exec /data/local/tmp/u10/usr/bin/npm: Permission denied   (exit=126)
   $ head -1 usr/lib/node_modules/npm/bin/npm-cli.js
   #!/data/user/0/com.dsharnessmobile.shell/files/usr/bin/env node
   ```

## 修法

* 两个 shim 一律**自定位**：前缀在设备上由 `$0` 反推（`command -v` 归一裸命令名 →
  `readlink -f` 解析软链 → `dirname/..` = `usr`），构建期**一个字面量都不烧**；
  `LD_LIBRARY_PATH` 在 shim 内 export（node 的 DT_NEEDED 靠它，PTC 过滤 env 那条路径同样受益）。
* 新增 `usr/bin/npm` **普通文件** shim（与 pnpm 同一段、同一模板），exec 到
  `lib/node_modules/npm/bin/npm-cli.js`；**写前必须 rmSync 掉旧软链**——`writeFileSync` 默认跟随
  软链，直接写会把 `npm-cli.js` 本体写坏（WSL 真 ext4 上实测过该写穿）。
* 构建期自检（同段内）：shim 文本不得命中 `/data/(user/<n>|data/com.termux)/`，且自定位行必须在场；
  不满足即 `console.error + exit 1`。
* 新门禁 `scripts/check-snapshot-node-shims.mjs`：产物面断言 node/pnpm/npm 三者存在且可执行、
  npm 必须是普通文件（不许再退回软链）、两个 shim 无构建期前缀字面量、自定位行在场、exec 目标在快照内存在；
  `--self-test` 用合成样本双向自证（正样本过、硬编码前缀/缺 npm/npm 是软链/无执行位四种负控必红）。

## 复验证据（原始输出）

设备：`emulator-5568`（x86_64，Android 15；快照资产为 x86_64，ABI 匹配）。前缀模拟：
把快照内 `usr` 子集解到 `/data/local/tmp/u10/usr`——**非 user 0 路径**，正是本 bug 的原形态。
以 uid 2000（shell）运行，`/data/user/0/...` 对它不可达，等价于多用户设备上的跨用户访问。

### 修复前（现行快照产物，逐字节取自 `app/src/main/assets/snapshot.tar.xz`）

```
$ /data/local/tmp/u10/usr/bin/pnpm --version
/data/local/tmp/u10/usr/bin/pnpm[3]: /data/user/0/com.dsharnessmobile.shell/files/usr/bin/node: inaccessible or not found
exit=127

$ /data/local/tmp/u10/usr/bin/npm --version
timeout: exec /data/local/tmp/u10/usr/bin/npm: Permission denied
exit=126
```

### 修复后（新 shim，同一棵树、同一 uid、同一前缀）

```
$ /data/local/tmp/u10/usr/bin/pnpm --version
10.12.1
exit=0

$ /data/local/tmp/u10/usr/bin/npm --version
11.19.0
exit=0

$ npm view pnpm version --json         # 插件信息获取路径
"12.16.1"
exit=0
```

严格 PATH（`env -i PATH=/system/bin`）下三种调用形态都成立：绝对路径、`./pnpm` 相对路径、
PATH 裸命令名；软链指向 shim 时亦成立（`readlink -f` 生效）。

### 负控

1. **删掉 npm shim → 插件信息获取路径立刻变红**（复现上报的报错原文）：
   ```
   code: 'ENOENT', syscall: 'spawnSync npm', path: 'npm',
   spawnargs: [ 'view', 'pnpm', 'version', '--json' ]
   exit=1
   ```
2. **旧形态 shim（硬编码 /data/user/0）在同一前缀下必红**：
   ```
   /data/local/tmp/u10/usr/bin/pnpm-old[2]: /data/user/0/com.dsharnessmobile.shell/files/usr/bin/node: inaccessible or not found
   exit=127
   ```
3. 门禁自身的负控见 `check-snapshot-node-shims.mjs --self-test`（四种病态样本逐条判红）。

## 为什么不是「只改 pnpm 就够」

pnpm 与 npm 是**同一条链上的两个必需件**：pnpm 负责安装，`pnpm view` 负责取元数据且它透传给
`npm`。只修 pnpm 的前缀，插件页仍在取元数据那一步死（本次负控 1 即该形态）。故两者同一段、
同一模板、同一门禁面。

## 边界（如实登记，未在本轮修）

* 第 6 步 `fix-shebang.py` 的 A/B 类重写仍会把 usr/bin、usr/libexec、usr/lib 下的**其它**文本脚本
  shebang 钉到构建期前缀；多用户设备上这些脚本同样会失败。本轮只修 node 工具链的两个 shim，
  其余是另一条独立缺陷（范围更大：涉及上游包自带脚本的 shebang 形态）。
* `usr/libexec/dsh-node`（PTC 启动器）与其在 `profile-web.cordis.patch.yml` 里的绝对路径同样
  以 user 0 为基准；未在本轮改动。
* 构建环境无 `base-usr.tar.xz`（LFS 底座），本轮**未能**重跑 `build-snapshot-013.mjs` 产出新 tar；
  证据由「从现行快照取真实 shim + 真机真跑」与门禁 `--self-test` 双向自证共同构成。
  下一次快照重建即产出新形态 shim，门禁在两条构建链上强制它。
