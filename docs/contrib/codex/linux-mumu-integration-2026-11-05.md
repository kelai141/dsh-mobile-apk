# Linux 环境接入收口：Cordis 激活、工具 schema 与资产恢复（2026-11-05）

本文记录 DSH Mobile 在 MuMu 独立工作树上接入 Bionilux + Debian 环境的设计和本轮根因。最终本地 debug APK 已用真实模型完成一键安装、工具调用、工作区共享、官方 zstd 构建测试打包与冷启动恢复；结果限于本次 MuMu 与本地模拟下载服务，不等于全 ABI 发布验收。

## 结论

Linux 环境由三段组成：宿主侧资产准备、引擎侧 bootstrap 控制面、Release 下发的 runtime。三段各自校验，前一段成功不能变为后一段的可用性证明。

本轮两个独立缺陷共同制造了“设置页看起来可用、模型却没有 Linux 工具”：

1. bootstrap 没被挂进 Cordis，或挂载时缺少它需要的运行目录，状态面只能返回 503 或不可读。
2. runtime 的 `linux_bash` / `linux_session` 使用了非标准 JSON schema，真实 `ToolRuntime` 拒绝注册；`syncTool` 吞掉异常并继续报 `healthy`，于是 fiber 正常、工具面为空。

上述两处都已修；runtime 工具测试使用真实 rc3 `ToolRuntime`，最终安装包中的模型调用和冷启动后新会话也已实测通过。

## bootstrap 为什么没有激活

### 访问声明与运行目录

bundled bootstrap 的 `apply(ctx, config)` 需要 `dataDir`，也允许从 `ctx.filesDir` / `ctx.get('filesDir')` 推导。但模块自身只声明：

```js
export const inject = ['linuxPluginHost']
```

未声明的服务如果在运行时被当作普通属性读取，会踩 Cordis 的访问约束；若改走 `ctx.get`，没有提供者时也只能得到空值。两种路径都无法凭“已提供 `linuxPluginHost`”自动补出 `filesDir`。

当前宿主不把希望押在隐式服务上：`dsh-android-linux-env.apply()` 用 `process.env.DSH_FILES_DIR`（由 `EngineManager` 注入 `context.filesDir`）和 `DSH_APP_VERSION` 构造显式配置，`dataDir = <filesDir>/linux-environment`，并带上 `linuxAssetIO`、`stagingDirectory`、`appVersionProvider`。拿不到 `dataDir` 时 bootstrap 会在激活前抛 `dataDir or ctx.filesDir is required`；这是失败关闭，不应被解释成环境不可用。

### 父 mount 非阻塞与 ACTIVE 检查

父子依赖是单向的：

- 宿主插件 `dsh-android-linux-env` 在 `apply()` 内 `provide('linuxPluginHost', …)`。
- bootstrap 注入 `linuxPluginHost`，在 `apply()` 内 `provide('linuxBootstrap', …)`。
- 宿主设置路由每次请求现取 `linuxBootstrap`；缺席返回 503。

因此父 `apply()` **不能** await 子 fiber：子 fiber 要等父作用域提供的服务，父 fiber 要等子 fiber 完成，二者互锁。现实现：

```ts
void mountLinuxBootstrap(ctx, { config: bootstrapConfig }).catch(error => {
  ctx.logger?.('dsh-android-linux-env')?.warn?.(
    'Linux bootstrap 装载失败，Linux 环境设置面不可用：' + message(error),
  )
})
```

父 fiber 先落定，子 fiber 随后装载。mount 失败只会留下一条 warn，根因按实际错误暴露，不伪造一个可用服务。

装载器本身也有等待面：`ctx.plugin(...)` 返回可等待 fiber，`await fiber` 后才检查 `fiber.state === FiberState.ACTIVE`；否则会读到 PENDING，并误报 `Linux bootstrap activation failed (state …)`。宿主激活 runtime 时同理，`cordisScope` 保留 `ready` 可等待性，ACTIVE 检查发生在真实 `apply()` 落定之后。

## runtime 工具 schema：从“healthy 却无工具”到真实注册

### 现象

Linux 环境显示已安装，设置页和健康记录都正常，但模型侧没有 `linux_bash`、`linux_session`。ACTIVE 与 `status().healthy` 都通过，工具面为空。

### 真实根因

旧 runtime 的 schema 把 `required: true` 写在**字段内部**：

```js
stdout: { type: 'string', required: true },
stderr: { type: 'string', required: true },
```

`linux_bash` 的 `parameters` 也直接是一组字段，而没有对象外壳；`linux_session` 的字段同样没有 `type: 'object'` 与对象级 `required` 数组。真实 `ToolRuntime` 的 schema 校验器拒绝这种形态，`tools.register(...)` 在注册 `linux_session` 时抛错。

`syncTool` 原先吞掉注册异常：

```js
try {
  disposeTool = registerLinuxBash(ctx, manager) ?? (() => {})
} catch {
  disposeTool = () => {}
}
```

结果：`linux_bash` 可能已经注册、`linux_session` 注册失败并抛错，异常被吞后运行时仍处于健康态；Agent 看到的是一个残缺或空的工具面，而状态层没有任何红灯。

### 修法

- 参数与输出都改为标准 JSON schema：`type: 'object'`、`properties`、对象级 `required` 数组、`additionalProperties`；删除字段级的 `required: true`。
- `linux_session` 的 `action` 由对象级 `required: ['action']` 表达。
- 让注册错误上抛：activation 必须失败，不再报告“健康但没工具”。
- 部分注册回滚：`linux_session` 注册失败时释放已注册的 `linux_bash`，并释放本函数拥有的 session registry；`apply()` 失败时清理 `change` 监听与自身拥有的 manager。
- 用真实的 rc3 `ToolRuntime`（而非手写 stub）固定注册与 execute 链路，并另用故障注入验证部分注册会回滚。

### 证据

在独立 checkout `D:/coding/dsh-bionilux` 复跑：

```text
node --test packages/linux-runtime/test/tool-registry.test.mjs
✔ real engine registry exposes and executes both Linux tools (28.3732ms)
✔ tool rejection fails activation and partial registration is rolled back (1.4515ms)
ℹ pass 2 / fail 0
```

用例读取 `@deepseek-ai/dsh-tools` 的真实 `ToolRuntime`，用 `assertObjectJsonSchema` 检查每个工具的参数，再通过 `execute` 跑 `linux_bash` 与 `linux_session`；第二个用例注入第二次注册失败，断言 activation 抛错、第一次注册已被释放且 `change` 监听清零。这是代码层证据，不替代设备三层验收。

## 首次 manifest 为空

`GET /api/android/linux-environment/manifest` 只读持久状态，不触网。`readLinuxManifest` 优先 `availableManifest`，退回 `pinnedManifest`；缺失、损坏或从未 check 时返回 `null`。

页面的顺序是：

1. `GET /manifest`；
2. 若为空，`POST /check`（手动检查只报告可用版本，不安装）；
3. 再 `GET /manifest`；
4. 仍为空才提示宿主没有发布清单。

旧宿主在 `/manifest` 返回 404/405 时只回退一次 `check`，避免缓存空清单；新的宿主不会因为“第一次没 check”就把安装按钮判死。状态刷新和页面轮询都可见时才发生，后台 WebView 不空转。

## 四类 native assets

安装前必须把四类资产逐个落进宿主暂存区，全部 `ok` 后才由引擎安装：

| 来源 | `kind` | 用途 |
|---|---|---|
| `plugins.runtime` | `plugin` | Release 下发的 `@dsh-android/linux-runtime` 插件包 |
| 所选 runtime 的 `backendAsset` | `backend` | Bionilux 启动器 |
| 所选 runtime 的 `rootfsAsset` | `rootfs` | Debian 根文件系统 |
| 所选 runtime 的 `nodeAsset` | `node` | 共享 glibc Node.js / npm |

页面对 `window.androidBridge.linuxAssetPrepare` 串行投递 `{url,sha256,size,kind}`，再轮询 `linuxAssetPrepareStatus()`。宿主：

- 先验摘要格式和体量，再碰文件系统；
- 只接受 https、本仓 Releases 的版本化资产与逐跳 CDN 白名单；
- 流式下载并同时验 SHA-256 和实读字节数；
- 按 kind 选择链接与炸弹上限，解到 `<filesDir>/linux-environment/staging-<sha256>.part`；
- 全部成功后原子改名为 `staging/<sha256>/`，保留 `asset.tar.xz` 与 `unpacked/`；
- 任一步失败删除工作目录，不发布半成品。

bootstrap 不信任宿主写下的标记：它按 manifest 摘要重新定位、复制并重算摘要与体量，重算 `unpackedSize`，校验 runtime 包名与 `lib/index.js` 后才激活。宿主暂存目录与 bootstrap 自己的包槽位刻意分开，避免包槽位替换时删掉复验源。

## Debug loopback

`debug-download-origin` 只服务于 debug 构建的本地回放：

- 生产构建不读取该文件；官方 URL 仍按正式 https 白名单和本仓 Releases 形态校验。
- `DSH_DEBUG_BUILD=1` 时，若文件在场，只接受 `http://127.0.0.1:<port>/`；无凭据、query、fragment 或额外路径。
- 只替换官方 URL 的 origin，保留官方 pathname；允许的官方路径仅为本仓 `/releases/latest` API 和版本化 `/releases/download/<tag>/<asset>`。
- Kotlin 下载器用 `Proxy.NO_PROXY`，关闭自动重定向，逐跳复核 CDN 落点；引擎侧 debug fetch 也设 `redirect: 'error'`，响应 `url` 保留官方身份供清单来源复核。

因此 HTTP 回放不会放宽正式白名单，也不会把局域网地址当成下载源。

## 恢复工具与恢复边界

引擎启动顺序是 `restoreActivation()` → `synchronizeInjectionState()`。这是必需的：

- 恢复只针对持久 `enabled && injectionActivated` 且 `installedLinuxVersion` 在场的安装；
- 目录必须在 bootstrap 自己的插件根内，且 `lib/index.js` 在场；
- 不下载、不重建、不复活用户手工删除的目录；
- 重新激活成功后，`status()` 读取 runtime 的 `active.json`；`healthy: false` 会写入可读错误，而不是报“已恢复可用”；
- `isInjected` 只读目录，不创建也不修复；
- 冷启动时宿主尚未加载 runtime，不能被 `active: false` 误判成用户移除并清掉 opt-in。

设置页的“重新安装”是另一条显式用户动作：不需要页面先重新准备资产，由 bootstrap 用 pinned manifest 再次执行安装；失败保留页面和错误，提供重试。

## UI 与路由

“Linux环境”分区的唯一注册方是 `dsh-client-ui-responsive/src/client/index.ts`（`settings.section`，id `linux-environment`，order 95）。vendored bootstrap 的浏览器条目只声明 `inject = ['slots']`，不再注册同名分区，避免 list 槽重复 id 抛错。`mobile/settings-nav.ts` 保留与注册 label 对齐的短说明。

页面只通过同源受鉴权路由读取状态和发起动作，不把引擎 Cordis 服务注入浏览器。资产走 Android 桥，避开设备控制队列的权限要求。

## 实测与边界

最终本地 debug APK `dsh-mobile-linux-source-final-x64.apk` 已装入 MuMu，并从未安装 Linux 的状态一键下载、激活。真实 d1 模型直接调用 Linux 工具，自主通过 apt 配置工具链、构建官方 zstd 1.5.7 的可执行文件与静态/共享库，完成两轮有界官方测试、往返校验、打包与解包验证。637 个原始文件未修改。APK 内 24 个插件实例、566 个文件与工作树构建产物逐字节一致；签名 v1/v2/v3 通过。

nullable 的 exitCode/pid/cwd/signal 使用标准 oneOf 表达，真实 registry 生命周期回归通过。Linux 工具从 workingDirectory.ensure 读取会话工作区，作为内部 sharedPaths 传给 manager/session；显式 guest cwd 不取消共享，后续调用不重置持久 cwd。会话按 agent 隔离。设备上的双向文件探针具有相同设备号和 inode，证明没有复制两份。

实际冷启动后复用同一 Linux 实例，文件和安装软件保留，未重新下载；活 shell 随旧进程结束，下一次工具调用创建新会话。中英文及横竖屏已实际点击截图。本轮是本地模拟下载服务器验收，未上传正式 Release，也不等于所有 ABI 真机的发布验收。完整证据见 Bionilux 仓的 docs/MUMU_APP_ACCEPTANCE.md 与 target/independent-linux/mumu-ui/。
