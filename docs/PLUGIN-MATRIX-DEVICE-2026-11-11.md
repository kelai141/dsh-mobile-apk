# 插件矩阵设备验证（2026-11-11）

设备 `emulator-5586`（API 35、x86_64），APK `0.14.11-FLOCK-DEV`，快照指纹 `87d09bec…`。

## 方法：三层判据

| 层 | 怎么取 | 什么算过 |
| --- | --- | --- |
| 组件面 | `pluginManager/listPlugins` 的行 | 有该 `moduleName`，`enabled=true`，`fiberPhase=active` |
| 注入面 | `window.__DSH_BOOT__.entries` | 有该 `id`，`url` 带 `rev`，`inject` 点可解析 |
| UI 面 | 真实触屏进入插件页，读 `body.innerText` | 插件名与描述出现在「Installed plugins」区 |

三层缺一不可。**「装上了」「清单里有」都不等于功能可用。**

## 样本结果

### 1. dsh-task-ledger 0.1.12

| 层 | 结果 |
| --- | --- |
| 组件面 | PASS `entryId=include:dsh-task-ledger enabled=true fiberPhase=active` |
| 注入面 | PASS 导航一级菜单出现 `Whale Ledger`，坐标 `(136,208)` |
| UI 面 | PASS 插件页列表可见 `Whale Ledger (dsh-task-ledger)` 与完整描述 |
| 功能面 | **FAIL** 端点返回 500 `LEDGER_SCRIPT_FAILED` |

功能面原始响应：`{"error":"读台账目录清单失败：error: \".../ledger-linux-amd64\" has unexpected e_type: 2"}`。

`e_type: 2` 是 ET_DYN（共享对象），且是 x86_64 **Linux/glibc** 产物。Android 是 bionic，加载不了；
沙箱里也没有执行权限。**第三方缺陷**：插件只提供 `linux-amd64` 预编译二进制。

### 2. dsh-plugin-health 3.1.0

| 层 | 结果 |
| --- | --- |
| 组件面 | PASS `entryId=include:plugin-health enabled=true fiberPhase=active` |
| 注入面 | PASS `inject` 含 ui-settings / ui-sidebar / ui-layout，`rev` 可拉取 |
| UI 面 | PASS 插件页「Installed plugins」区可见 `dsh-plugin-health` 与其完整描述 |
| 功能面 | **未验** 工具 `plugin_health` 未出现在工具清单 |

功能面缺口的原因已定位：插件用 `await import('@deepseek-ai/dsh-tools')` 拿 `defineTool`，
而 `@deepseek-ai/dsh-tools` 只在**安装树**（`files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/`）里，
profile 的 `node_modules/@deepseek-ai` 下没有它（实测只有 cosmokit / dsh-package-manifest / dsh-plugin-market-index / schemastery）。

上游 `dsh-app-boot` 的 `createRuntimeResolution` 把包分成 `installation` 与 `profile` 两个 scope，
`profile` scope 只收 `node_modules/<name>/package.json` 真的存在的包。插件自己的动态 import 从插件目录出发，
解析不到安装树的 `node_modules`，于是抛错——而插件把整段注册包在 `try/catch` 里只写 `logger.debug`，**静默吞掉**。

**归因第三方（插件侧写法）**：宿主提供了 `ctx.tools.register`，源码里也有 `if (ctx?.tools?.register === undefined) return`，
说明作者知道该 API，只是把它当兜底而不是主路径。按纪律不修、不绕过。

### 3. dsh-config-manager 0.8.0

| 层 | 结果 |
| --- | --- |
| 组件面 | PASS `entryId=include:config-manager enabled=true fiberPhase=active`；详情页另显 `Components 1 total · 1 running`、`config-manager Running` |
| 注入面 | PASS `inject` 含 ui-client-runtime / ui-client-connection / ui-settings |
| UI 面 | PASS 插件页列表可见 `Config Manager` 与完整描述 |
| 功能界面 | PASS 进详情页后，插件自己的功能界面完整渲染：`DSH Config Manager — Backup, Restore & Migration Plugin`，含 `Backup & Restore` / `Export / Import` / `Migrate` / `Scheduled` 各分区文案 |
| 功能执行 | **未验**（未实际执行一次备份或导出） |

「功能界面渲染」与「功能执行」是两层，不能混为一谈：前者证明注入链路与组件挂载正确，
后者才证明功能真的可用。本轮只做到前者。

### 一条方法修正

插件详情页**没有「进入功能页」的按钮**——功能界面嵌在同一页面的下方滚动区。
不能假设「有功能就有入口按钮」；读 `innerText` 全量往下找才是对的。

## 归因小结

| 样本 | 组件 | 注入 | UI 列表 | 功能界面 | 功能执行 | 归属 |
| --- | --- | --- | --- | --- | --- | --- |
| dsh-task-ledger | PASS | PASS | PASS | PASS | FAIL | 第三方（linux-amd64 二进制） |
| dsh-plugin-health | PASS | PASS | PASS | 未验 | 未验 | 第三方（动态 import 宿主包失败且被静默吞掉） |
| dsh-config-manager | PASS | PASS | PASS | PASS | 未验 | — |

**三条样本的组件面、注入面、UI 面全部通过，没有一条暴露我方底层缺陷。**

这对「WebUI 自定义能力不受损」是一个正向信号：第三方插件的一级菜单注入、设置页注入、
插件列表渲染在我们的 APK 上都正常工作。

## 探测方法上的三个坑（都踩过并已修正）

1. **`textContent` 会算进 `<script>` 源码**，用它判「页面已渲染」会得到假的非零长度。必须用 `innerText`。
2. **图标按钮没有文本**，只有 `aria-label`（如 `Open navigation`）。只按文本匹配会找不到。
3. **点击必须命中 `<button>` 本身**。用「文本包含」会匹配到外层容器，坐标落在相邻项上（曾把 `Plugins` 点成 `Automation tasks`）。

另：插件页列表是**异步加载**的，进页后约 25 秒才渲染出「Installed plugins」区。早读会得到 57 字符的标题栏。

## 复测

```sh
# 组件面 + 功能面
node scripts/verify-plugin-sample-device.mjs --serial emulator-5586 --timeout 90
# UI 面：进导航 → Plugins → 等列表渲染 → 读 innerText
```

前提：App 在前台且 WebView 页面已加载。若停在「The engine still will not start」失败页，
点一次「Retry startup」即可恢复。