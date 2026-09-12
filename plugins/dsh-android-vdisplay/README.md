# @dsh-android/dsh-android-vdisplay

虚拟屏（Shizuku 特权通道）插件。0.14.0 迭代「虚拟屏」线（用户拍板：源文档 §7.3 的延后判定已作废）。

## 职责与边界

- **载体与宿主**：宿主半提供 fail-closed 的能力/状态查询工具 `android_vdisplay_status`；
  浏览器半把「虚拟屏」注册为**右侧栏的同级 tab 类型**（与上游「工作区文件」同级，用户约束 U-1）。
- **本插件不承载像素**。画面的唯一路径是壳侧原生 `SurfaceView` 的 Surface 直接作虚拟屏输出
  （源文档 §9.2 明确反对「像素经引擎编码→传输→WebView 解码」）；本 Tab 只承载开关/状态/控制。
- **默认关闭、不接默认路径**：插件未进任何 profile/注入清单，当前对产品行为零影响；
  `vd*` op 只在表里声明，**未进六处登记链**，因此控制队列无法调用它们。

## `vd*` 与六处登记链（下一批，独立 PR）

新增 op 必须一次改齐六处并通过 `scripts/check-control-ops.mjs`（集合差集 = 0）：
壳侧 `DeviceControlService.handle` / `ControlProtocolV2.SUPPORTED_OPS` / 引擎 `ControlOp` /
`A11Y_OPS` / `ROUTE_OPS` / manage 工具面。两条硬约束：

1. `vd*` 是特权面操作，**不得**进 `A11Y_OPS`（无障碍承载不了建屏与跨屏拉应用；与源文档 §8.2
   「`browser*` 不进 `A11Y_OPS`」同一条推理）。
2. 登记同批必须跑门禁；漏一处即该 op 在链路上不可达（坑 52）。

## inject 纪律（坑 82 同形态，2026-09-12 设备实测踩过）

cordis 对**未声明 inject 的服务属性访问**直接抛错：

```
Error: failed to apply loader entry android-vdisplay (@dsh-android/dsh-android-vdisplay):
cannot get property "tools" without inject
```

整条 loader entry 失败 → 引擎 exit=1、3080 refused（设备实测）。本插件现在的口径：

- **必需服务走属性访问** → 必须写进 `inject`（host：`['tools']`；client：`['slots']`）。
- **可选服务一律 `ctx.get('x')`**（`webServer` / `androidPrivilege` / `sidebarRightTabs`）：
  属性访问即使写成 `(ctx as ...).webServer` 也照样抛错（类型断言不改变运行时语义）——本插件就踩过第二处。
- `ctx.logger` / `ctx.effect` / `ctx.get` 是 Context 核心成员，不需要 inject；logger 用法跟本仓既有插件
  对齐为可调用形式 `ctx.logger(name).warn(...)`。
- 自检脚本 C 段会剥注释后扫描 `ctx.<name>`，出现未声明且非白名单的属性访问即判红。

## 现状（S1 已落地 / 未落地）

| 项 | 状态 |
|---|---|
| 宿主半（状态工具 + `vd*` 表 + fail-closed 状态机） | 已落地，`npm run build` 通过，6/6 状态用例自检通过 |
| 浏览器半（右侧栏同级 tab 类型 + 状态面板 + chip 标题） | 已落地，`tsc -p tsconfig.client.json --noEmit` 通过，`lib/client.js` 已产出 |
| 状态数据源 | **已接通**：宿主注册只读 exact 端点 `GET /api/android/vdisplay/status`（载荷无机密：状态/错误码/引导/op 表/虚屏 id）；壳侧桥面未落地 → 返回 `blocked` + `vdisplay-shell-not-wired`（fail-closed，不假装可用） |
| 面板四态 | `disabled` / `blocked` / `ready` / `active`，10s 轮询 + 手动「刷新状态」；未知 state、HTTP 非 2xx、网络异常、非法 JSON 一律 `blocked` + `vdisplay-status-unavailable` |
| `vd*` 六处登记链 | **未做**（独立批次，需壳侧 Kotlin + 装机实测） |
| 建屏/拉应用/输入/读树/画面直挂实测 | **未做**：见 `.deploy-tmp/iter-0140/vdisplay-p0.md` 的 `需实测` 清单 |

## 构建与自检

```powershell
cd plugins/dsh-android-vdisplay
npm install --no-audit --no-fund --legacy-peer-deps   # 本仓既有插件同口径（cordis 4.0.1 与 cordis-plugin-include 的 peer 冲突）
npm run build                                          # tsc（宿主半）+ tsc --noEmit（浏览器半）+ esbuild（lib/client.js）
```

自检（两个脚本都必须绿）：

```powershell
# 24 项：宿主工具六态 + 面板四态映射 + 状态读取 fail-closed + 端点语义（含引擎同一校验器验 schema）
node ../../.deploy-tmp/iter-0140/vdisplay/verify-vdisplay-host.mjs
# 7 项：加载器级——负例复现（去掉 inject 用真实产物加载 → cannot get property "tools" without inject）
#       + 正例（inject=['tools'] 在"服务由兄弟 fiber 提供"的真实拓扑下 apply 成功、tools/webServer 均被调用）
#       + 两端无未声明服务属性访问
node ../../.deploy-tmp/iter-0140/vdisplay/verify-vdisplay-loader.mjs
```

说明：本插件的 `node_modules` 只用于本地构建/自检；运行期由引擎树解析依赖（与其它 `@dsh-android/*`
插件一致）。`--legacy-peer-deps` 会跳过 `@deepseek-ai/dsh-tools` 的 peer 闭包，本地跑自检时若报
`Cannot find package '@deepseek-ai/dsh-*'`，用姊妹插件已装好的闭包补齐（junction 即可，勿提交）。
