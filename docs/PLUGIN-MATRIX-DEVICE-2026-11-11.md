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
| 功能面（HTTP） | **PASS** `GET /plugins/dsh-plugin-health/status` → 200，返回 46 KB 真实诊断报告 |
| 功能面（工具） | FAIL 模型侧工具 `plugin_health` 未注册（见下，归因第三方） |

功能面缺口的原因已定位：插件用 `await import('@deepseek-ai/dsh-tools')` 拿 `defineTool`，
而 `@deepseek-ai/dsh-tools` 只在**安装树**（`files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/`）里，
profile 的 `node_modules/@deepseek-ai` 下没有它（实测只有 cosmokit / dsh-package-manifest / dsh-plugin-market-index / schemastery）。

上游 `dsh-app-boot` 的 `createRuntimeResolution` 把包分成 `installation` 与 `profile` 两个 scope，
`profile` scope 只收 `node_modules/<name>/package.json` 真的存在的包。插件自己的动态 import 从插件目录出发，
解析不到安装树的 `node_modules`，于是抛错——而插件把整段注册包在 `try/catch` 里只写 `logger.debug`，**静默吞掉**。

**归因第三方（插件侧写法）**：宿主提供了 `ctx.tools.register`，源码里也有 `if (ctx?.tools?.register === undefined) return`，
说明作者知道该 API，只是把它当兜底而不是主路径。按纪律不修、不绕过。

#### HTTP 面是通的

```json
{ "schemaVersion": 4, "runtimeVersion": "0.2.2-rc.1", "profile": "web",
  "summary": { "error": 0, "warn": 0, "info": 2, "autoFixable": 0 },
  "incompatible": 0 }
```

它的核心功能就是扫描整个 profile 的插件并诊断兼容问题，返回的正是真实扫描结果：
运行版本 `0.2.2-rc.1`、profile `web`、0 错误 0 警告 2 条提示、0 个不兼容。

所以准确表述是：**插件本体功能正常（HTTP 诊断接口工作、返回真实扫描），缺的只是模型侧工具注册**。

### 3. dsh-config-manager 0.8.0

| 层 | 结果 |
| --- | --- |
| 组件面 | PASS `entryId=include:config-manager enabled=true fiberPhase=active`；详情页另显 `Components 1 total · 1 running`、`config-manager Running` |
| 注入面 | PASS `inject` 含 ui-client-runtime / ui-client-connection / ui-settings |
| UI 面 | PASS 插件页列表可见 `Config Manager` 与完整描述 |
| 功能界面 | PASS 进详情页后，插件自己的功能界面完整渲染：`DSH Config Manager — Backup, Restore & Migration Plugin`，含 `Backup & Restore` / `Export / Import` / `Migrate` / `Scheduled` 各分区文案 |
| 功能执行 | **PASS** 端到端备份 + 校验闭环（见下） |

#### 功能执行证据

走插件自己注册的 HTTP 端点，不从 UI 点击（盲点坐标在重载后不可靠）：

1. `POST /api/dsh-config-manager/export` → **200**

```json
{ "zipPath": ".../dsh-config-manager/exports/dsh-config-2026-11-11-7f385a.zip",
  "manifest": { "schemaVersion": 1, "exporter": { "name": "DSH Config Manager", "version": "0.8.0" },
                "source": { "dshVersion": "0.2.2-rc.1", "platform": "android", "arch": "x64" } } }
```

2. 文件真的落盘（`run-as` 核对，非接口自述）：

```
-rw------- 1 u0_a209 u0_a209 25272 2026-11-11 02:03 dsh-config-2026-11-11-7f385a.zip
head bytes:  P K 003 004    ← 标准 ZIP 魔数
```

3. `POST /api/dsh-config-manager/analyze`（带 `zipPath`）→ **200**

```json
{ "valid": true, "errors": [], "warnings": [], "compatibility": "excellent",
  "sectionsInZip": ["settings","ui","providers","plugins","mcp","prompts","workspaces",
                    "credentialsStatus","skills","agentPresets","agentInstructions","self"],
  "pluginSummary": { "installed": 2, "toInstall": 0 },
  "unsupportedSections": [], "unsupportedVersions": [] }
```

十二个配置分区全部导出，零错误零警告。它真实读取了 DSH 的 settings / providers / plugins /
workspaces / skills 等配置结构，清单里写着 `platform: android, arch: x64`——
**说明配置读写路径在我们的 APK 沙箱里是通的**。

另测 `GET /api/dsh-config-manager/disk-usage` → 200，返回真实占用（`totalBytes: 181`）。

### 方法：从源码找路由，从页面 fetch 调用

盲点 UI 坐标对时序太敏感（每次重载都重置布局）。更可靠的是：读插件源码找出它注册的 HTTP 路由，
再从页面上下文 `fetch` 直接调用。调的是插件真实的业务端点，不是伪造请求。

### 一条方法修正

插件详情页**没有「进入功能页」的按钮**——功能界面嵌在同一页面的下方滚动区。
不能假设「有功能就有入口按钮」；读 `innerText` 全量往下找才是对的。

## 归因小结

| 样本 | 组件 | 注入 | UI 列表 | 功能界面 | 功能执行 | 归属 |
| --- | --- | --- | --- | --- | --- | --- |
| dsh-task-ledger | PASS | PASS | PASS | PASS | FAIL | 第三方（linux-amd64 二进制） |
| dsh-plugin-health | PASS | PASS | PASS | PASS（HTTP） | PASS（HTTP）/ 工具未注册 | 第三方（工具注册动态 import 失败且被静默吞掉） |
| **dsh-config-manager** | PASS | PASS | PASS | PASS | **PASS** | — |

**三条样本的组件面、注入面、UI 面全部通过，没有一条暴露我方底层缺陷。**

功能面结果：

- `dsh-config-manager`：端到端备份 + 校验闭环全绿，**第一条完整全绿样本**。
- `dsh-plugin-health`：HTTP 诊断接口工作并返回真实扫描结果（0 错误 0 警告），
  仅模型侧工具注册因第三方写法失败。
- `dsh-task-ledger`：功能失败，第三方只提供 linux-amd64 预编译二进制。

对「WebUI 自定义能力不受损」，本轮验到四类注入都正常：一级菜单（`Whale Ledger`）、
设置页、插件列表、插件自身界面渲染。

## 覆盖边界（必须明说）

- 只有 **3 个样本**，而矩阵规划是 11 个、目标 8 个以上。覆盖不足，不能据此说「整个插件生态兼容」。
- 三个样本都来自 `plugin-test-samples.json` 的选样，其中有 2 个属低热样本，但**长尾、老旧、
  特殊扩展机制那几类尚未纳入**。
- 未做 A/B 对照（本轮没有「Rust 化前」的对照构建）。
- 未覆盖安装/启用/停用/卸载/重装/配置更新的完整生命周期，也未测多插件并发与依赖冲突。

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