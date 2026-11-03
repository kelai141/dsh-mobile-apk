# Linux 插件宿主缓存与卸载失败恢复

## 现象、真因与修法

runtime 的 Cordis fiber 被外部 dispose 后，目录和入口仍在磁盘，但宿主把缓存对象存在误报成 active，同目录 install 还会返回旧 manager。卸载或 rollback 的 dispose 抛错时，旧实现跳过三项缓存清理，后续操作继续命中失效对象。

`createLinuxPluginHost()` 的缓存复用与两条 `isInjected()` 分支现在共用活动判据：scope 必须存在，提供 state 时必须为 `FiberState.ACTIVE`；省略 state 的既有适配器保持兼容。非 ACTIVE 缓存重新走导入、释放与激活路径。`release()` 在 finally 清空 scope、manager、activeDirectory，保留原始 disposal 错误；既有串行链吞掉的只是链尾拒绝，不吞调用方错误，因此下一次 install 可恢复。激活失败 catch、接口、注册及调用方均未修改。

## 变更摘要

修复 Linux 内部插件失效 scope 的缓存复用和活动状态误报，并保证卸载/rollback 的 dispose 失败后宿主可以重新安装。

## 提交前自审

- [x] 完整检查 scoped diff；无调试残留或凭据，未修改生成的 lib、锁文件或公共接口。
- [x] 界面中英文检查不适用：未修改界面或文案。
- [x] 下列命令与结果来自本轮实际执行；本轮不提交、不推送、不开 PR，标签由交付者选择。

## 验证证据

环境：2026-11-03，Darwin arm64，Node v26.5.0，npm 12.2.1。基线 HEAD 为 `b6478c1cd8486c6befbb81dfd4033b9f21c22ff0`，验证对象是该 HEAD 加本轮未提交 diff，并非该 SHA 的原始树。

本机默认临时目录经 `/var` 符号链接访问，而宿主返回 realpath；现有测试直接比较目录字符串，所以验证统一使用 `TMPDIR=/private/tmp`。Cordis 4.0.5 的 `FiberState` 是导出的 TypeScript const enum，运行时 JS 中已擦除；测试用既有 TypeScript 依赖编译其源声明，未硬编码枚举数值、未增加生产测试钩子或依赖。

依赖与构建按 shell-termux → bridge → linux-env 顺序执行；npm 12 默认拒绝锁文件中的远程 tarball URL，安装时显式允许，锁文件未修改：

```sh
npm --prefix dsh-shell-termux ci --allow-remote=all --no-audit --no-fund
npm --prefix dsh-shell-termux run build
npm --prefix plugins/dsh-android-bridge ci --allow-remote=all --no-audit --no-fund
npm --prefix plugins/dsh-android-bridge run build
npm --prefix plugins/dsh-android-linux-env ci --allow-remote=all --no-audit --no-fund
export TMPDIR=/private/tmp
npm --prefix plugins/dsh-android-linux-env run build && node --test plugins/dsh-android-linux-env/test/linux-environment.test.mjs
npm --prefix plugins/dsh-android-linux-env test
node scripts/check-code-map.mjs
node scripts/check-state-registry.mjs
git diff --check
```

结果：三个包构建成功；指定测试文件 **19/19 PASS**；完整 linux-env 套件 **65/65 PASS，0 skipped**；`CHECK-CODE-MAP PASSED`；`CHECK-STATE-REGISTRY PASSED`；diff 空白检查通过。

受控负控在生产修复前运行（新增测试已写入，构建仍使用原始 cache/release 逻辑）：

```sh
TMPDIR=/private/tmp node --test --test-name-pattern='pluginHost (reports external|only reuses|forgets failed)' plugins/dsh-android-linux-env/test/linux-environment.test.mjs
```

结果 **0/3 PASS，exit 1**，三个失败均为预期 inactive 实际 active。应用修复后，这三个测试随上述 19 项和 65 项测试全部通过。覆盖真实 Cordis 外部 disposal、两个查询分支、重新激活与 manager 身份、所有非 ACTIVE 枚举状态及激活拒绝、无 state 兼容、ACTIVE 幂等、卸载和 rollback 的同步/异步 EBUSY、原错误身份、失败 disposer 不再重试、空查询忘记目录及恢复安装。既有激活失败、缺 manager、异步初始化、手工删除、查询/路径限制与路由鉴权测试保持通过。

验证输入 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `plugins/dsh-android-linux-env/src/linux-environment.ts` | `c0c1ffadeb4ba2036653e6944729575b5b6292472d98d295524cabd71a0793c6` |
| `plugins/dsh-android-linux-env/test/linux-environment.test.mjs` | `782a19c3b37705bdd9ced0eaa607cafbcc14807b183532290ad0945c73a37a3d` |

证据风险范围：纯 runtime 宿主生命周期修复；不涉及 L2 桥协议、签名、快照事务或门禁判据，也不涉及 L3 界面与壳侧行为。设备验收采用状态 B；单测不代表 APK 或设备通过。

## 设备验收

**未做设备验证。请求维护者验收（状态 B）。**

- 设备前提：Android API 26+，从最终提交 SHA 构建并安装对应 ABI 的 APK，记录 versionName、SHA、serial 与权限状态；等待快照刷新完成。启用内部 Linux bootstrap，并显式注入有效测试 runtime。测试 runtime 提供可用 manager，记录激活次数、manager 身份并保留其真实 Cordis fiber；支持一次性 disposer EBUSY（同步抛出与 Promise 拒绝分别验）。这是维护者设备测试前提，本轮未构建该测试 runtime 或 APK。
- 前向任务：让模型自行编排安装、使用 manager、外部 disposal、显式及空查询、同目录重装并再次使用 manager 的完整任务；另跑卸载 disposer 报错后重复卸载及安装重试的任务，并用 rollback 触发相同失败恢复。保留工具调用、错误重试、最终汇报与设备截图，不向模型逐条喂操作步骤。
- 期望可观测：外部 disposal 后两个查询均 injected=true、active=false；重装产生第二次激活与不同且可用的 manager。dispose EBUSY 原样返回；显式查询仍 injected=true、active=false，空查询 injected=false、active=false；再次卸载不再调用失败 disposer，后续安装成功。正常卸载与 rollback 重复执行无副作用。
- 失败反例：目录在场且 scope 已 DISPOSED 却显示 active；重装复用旧 manager；EBUSY 被吞掉、反复调用失败 disposer、空查询残留旧目录或重试无法得到可用新 manager，任一出现即 FAIL。进入发版候选前须补代码/CDP/ADB 三层设备证据，包含竖横屏，发布前补 arm64 真机。

## 状态登记

- 持有者：`createLinuxPluginHost()` 独占进程内 scope、manager、activeDirectory 的缓存写权；Cordis fiber 拥有真实生命周期状态。
- 写路径：`plugins/dsh-android-linux-env/src/linux-environment.ts:createLinuxPluginHost` 的成功 install 同时写入三项；`release()` 的 finally 同时清空。uninstall 与返回的 rollback 调用同一 release；未新增跨层持久化状态。
- 外部真源：`cordisScope()` 的 live state getter 直接读 Cordis fiber.state，以 `FiberState.ACTIVE` 为已提供 state 的活动真源；磁盘 realpath、入口文件与包含关系是 injected 的真源。manager 缓存不是活动状态的真源。
- 同步路径：`src/index.ts` 的 activate 已使用 `cordisScope(ctx.plugin(...))`；install 缓存命中与两个查询分支每次读取 live state，release 的 finally 消除失败清理后的残留。可执行证据如下，分别命中 getter、活动判据、三项缓存写入/清空、现有装配适配器；回归测试与上述门禁已通过。

```sh
rg -n 'get state|const isActive|scope =|manager =|activeDirectory =|activate:.*cordisScope' plugins/dsh-android-linux-env/src/linux-environment.ts plugins/dsh-android-linux-env/src/index.ts
```

## 验证

- [x] `node scripts/check-state-registry.mjs`
- [x] 相关行为回归与 `node scripts/check-code-map.mjs` 全绿；未运行完整发布聚合门禁。
- [x] 修复前新增生命周期测试确实变红，修复后通过。

## 影响面

仅 runtime 宿主、已有测试文件、P04 执行地图和本记录。`lib/` 由 TypeScript 构建重新生成且被 Git 忽略；未手改或强制加入。维护者负责私有协调仓同步及发布候选快照重建与设备验收。此记录保留 PR 模板字段供交付者使用，本轮未创建 PR。
