# Linux 运行时契约

> 本文记录当前 Linux 环境的接口、文件所有权和验收判据。改动实现时同步修订对应条款。桥方法见 `BRIDGE-API.md`，模块入口见 `modules.md`，运行顺序见 `EXECUTION-MAP.md`。

## 1. 组成与所有权

| 面 | 实际职责 | 所有者与状态来源 |
|---|---|---|
| 发布信息 | 固定版本 manifest、bootstrap/runtime 插件、架构对应 backend/rootfs/Node 资产 | bionilux Release；bootstrap 保存 `availableManifest` 与 `pinnedManifest` |
| 下载与解包 | 资产来源检查、下载、摘要/大小验证、安全解包、暂停与续传 | APK `LinuxAssetIO`、`LinuxAssetExtractor`、`LinuxAssetPrepare` |
| 安装队列 | 资产顺序、当前索引、安装阶段、失败状态、EngineService 恢复 | APK `LinuxInstallJob`，文件 `linux-environment/install-job.json` |
| 安装与 runtime | 资产复验、插件目录落位、Cordis 激活、工具注册、启停及状态 | vendored `dsh-linux-bootstrap` 与 `linuxRuntimeManager` |
| 设置页 | manifest 查询、来源/节点选择、进度、安装/更新/启停/终端/工具链入口 | `dsh-client-ui-responsive/src/client/linux-environment/` |

APK 与 bootstrap 之间通过受信 `androidBridge` 准备资产，并通过同源、鉴权的 `/api/android/linux-environment/*` 路由管理运行时。Linux 能力默认关闭，由用户显式启用。

## 2. Manifest、资产与来源

bootstrap manifest 至少包含 `version`、`plugins.bootstrap`、`plugins.runtime` 与 `runtimes[]`。runtime 项提供 `id`、`architecture`、`label`、`backendAsset`、`rootfsAsset`、`nodeAsset`。资产包含 HTTPS URL、SHA-256、字节数；runtime 插件和所选架构的三项资产按 manifest 形成安装队列。设备选择与其 host architecture 匹配的 runtime，安装任务保存所选 `runtimeId` 和 `expectedVersion`。

下载来源与 APT 软件源分开设置。下载来源支持官方 GitHub 与镜像模式。镜像模式可选具体节点，资产的 URL、摘要与大小仍取自官方 manifest，镜像只传输相同身份的字节。资产来源写入安装任务，续传和重试沿用来源选择。

APK 只接受 GitHub Release 白名单 URL，并逐跳校验重定向。SHA-256 与 manifest 字节数都匹配后才解包。资产种类为 `plugin`、`backend`、`rootfs`、`node`，解包器按种类应用符号链接规则和大小上限。宿主暂存位于 `<filesDir>/linux-environment/staging/<sha256>/`，包含 `asset.tar.xz`、`unpacked/` 与 `kind`。下载工作目录为同级 `staging-<sha256>.part`。路径由摘要推导，页面不传目标路径。

bootstrap 通过宿主 `linuxAssetIO` 读取归档并复制解包树。bootstrap 自行重算归档摘要、大小与解包体量，核对包名和入口，再原子落位至 `plugins/runtime/<sha256>/`。bootstrap 的包槽与宿主 staging 分离。缺少暂存资产、校验失败或路径不安全时安装失败并保持 runtime 未激活。

## 3. 持久化安装与下载恢复

`LinuxInstallJob` 将任务原子写入 `linux-environment/install-job.json`，字段包括 `runtimeId`、`version`、`assets`、`index`、`state` 和 `error`。状态包含 `queued`、`paused`、`installing`、`failed`、`done`。单线程 worker 逐个准备资产，资产完成后推进 `index`，全部准备完成后调用 bootstrap `install`。

`linuxInstallJob('pause')` 仅在当前资产下载阶段接受暂停。`retry` 恢复 `paused` 或 `failed` 任务。`LinuxAssetPrepare` 保留 HTTP 下载产生的 `.part` 文件并支持 Range 续传，完整校验失败时清除不可信工作目录。EngineService 启动时调用 `resumePending()`，恢复 `queued` 与 `installing` 任务。下载进度、速度、剩余字节和阶段由 `linuxAssetPrepareStatus()` 提供，`LinuxDownloadNotification` 同步系统通知。

资产准备阶段为 `downloading`、`verifying`、`extracting`，安装队列随后进入 `installing`。暂停、失败、重试与完成状态写回任务文件。界面退出不会取消队列；EngineService 启动时恢复 `queued` 与 `installing` 任务。Android 通知展示当前下载/安装阶段。设备进程终止后的 `.part` 续传、任务恢复与通知展示列入设备验收。

## 4. Runtime 启停与启动策略

bootstrap 状态文件为 `linux-bootstrap-state.json`，通过临时文件写入后 rename 更新。关键字段包括 `installedLinuxVersion`、`installedSystemMobileVersion`、`runtimeId`、`pluginDirectory`、`enabled`、`injectionActivated`、`autoStartEnabled`、`autoUpdateEnabled`、manifest 与检查时间。

- `installed` 表示记录中有已安装 Linux 版本。
- `enabled` 与 `injectionActivated` 表示 runtime 插件当前已激活。`setRuntimeRunning(false)` dispose 插件作用域并清除运行态；重新启动时从仍在场的已安装目录恢复激活。
- `autoStartEnabled` 默认开启。设置页的「随应用启动」开关持久化该值。bootstrap 服务启动时仅在安装存在且自动启动开启时恢复 runtime。
- `autoUpdateEnabled` 默认关闭，与自动启动分开。已安装的 Linux 环境在引擎启动时检查 Bionilux 发布。自动安装更新适用于已安装且启用的运行时。
- 插件在场由 `linuxPluginHost.isInjected()` 查询。手工移除目录后，状态同步清除激活与 enabled，不从新 Release 或 APK 升级自动恢复安装。
- APK 升级保留 Linux rootfs、runtime 状态和用户选择。应用版本变化检查、startup 检查与用户手动检查走 bootstrap 的不同 source。

运行中禁用 Linux 会结束该 runtime 作用域中的终端和任务。设置页在停用前提示这一影响。「Linux 设置」的运行诊断展示最近健康检查结果、架构、运行时标识和已记录的错误原因。

## 5. 持久化终端

设置页 `/terminal` 路由由 `createLinuxTerminal()` 创建单个插件实例级 PTY 会话。首次打开确认 Linux runtime 健康且无安装/更新管理锁，再使用 runtime manager 的 `_sessionLaunch()`、执行环境和 `Subprocess.spawnTerminal()` 启动交互 shell。PTY 使用 `xterm-256color`，初始 guest 工作目录为 `/root`，宿主工作目录为 runtime dataDir，终端尺寸由前端同步。用户可在终端中输入并执行 Linux 命令，包含交互式 TUI 与长时间运行进程。

请求动作包括 `open`、`restart`、`read`、`write`、`resize`、`stop`。读写带会话 ID，读取以字符游标分页，并返回运行状态和退出结果。服务端保留有界输出历史，旧游标过期时返回 `reset` 供 xterm 清屏后接续。并发首次打开共享同一启动 promise。

离开设置子页面只销毁 xterm 前端实例和轮询，不调用 `stop`。重新打开后通过 `open` 连接仍在运行的 PTY，恢复 shell 进程、工作目录与会话运行状态，并从输出游标读取保留内容。用户确认结束会话、Linux runtime 停止或插件进程退出时，PTY 才结束。会话生命周期与 Linux 插件进程一致。

## 6. Debian APT 与工具链

Linux APT 源由工具链页面独立管理，当前选项为 `official`、`tuna`、`ustc`，分别映射 Debian 主仓和 security 仓 URL。镜像切换通过 runtime manager 执行，只改写已识别 Debian 源文件并记录选择到 `/etc/apt/dsh-mirror`。软件包列表以 `apt-mark showmanual` 为准，建议工具链由插件提供。

安装单个包前执行 `apt-get update`，再以 `--no-remove` 安装；卸载执行 `apt-get remove`。动作要求 `confirmed: true`，包名按固定格式校验。存储状态报告 rootfs 与 APT cache 占用，清理动作运行 `apt-get clean`。操作要求 runtime 已运行。

APT 镜像属于 guest 的 Debian 软件源配置，Release 下载镜像属于 APK 资产传输，两者状态和配置文件独立。升级 runtime 时插件会收集旧 rootfs 的已安装包列表，将 `home`、`root`、`opt`、`usr/local`、`etc/apt` 合并到新 rootfs；补回基础 runtime 后比较 dpkg 包状态，对缺失包执行 `apt-get update` 与 `apt-get install --no-remove`。升级失败时 bootstrap 事务回滚原 runtime。

## 7. 更新、重装与卸载

手动 `check` 只刷新 manifest，不安装。安装或更新先读取 manifest 并固定目标版本，创建持久任务，顺序下载 runtime 插件、所选 runtime 的 backend、rootfs 与 Node。全部资产准备后调用 `/install`，传入 `confirmed`、`activate`、`runtimeId` 与 `expectedVersion`。bootstrap 若发现 manifest 版本已变化会拒绝本次安装，页面需重新检查并准备资产。

自动更新要求用户开启 `autoUpdateEnabled`，且 runtime 已安装并启用。引擎启动时查询发布通道。APK 任务队列读取新版本并负责下载与安装。自动更新保留 runtime 启用状态及 runtimeId。重装使用已 pin 的 manifest 与 runtimeId，并走同一资产复验及安装事务。卸载由 bootstrap 移除 runtime 与 rootfs 插件资产并清理宿主暂存；工作区与用户目录按 runtime 实际卸载策略处理。

## 8. 运行状态和健康判据

bootstrap status 是版本、操作、更新与启用偏好的权威。运行时工具面由 runtime manager 实际注册和执行。界面 `ready` 状态应来自健康检查及可用工具事实，不以已安装版本字段单独推断。

操作期由 bootstrap 串行化并通过 `operation` 表示 `starting`、`stopping`、安装、更新、重装与卸载等阶段。路由按状态返回 409、503 或结构化错误。所有 `/api/android/linux-environment/*` 路由执行 `authorizeMobileRoute`，响应禁止缓存。

## 9. 验收判据与当前状态

代码层覆盖 APK 资产摘要/大小校验、来源跳转、解包路径安全、安装任务状态持久化、断点续传、失败重试、manifest 版本固定、bootstrap 更新回滚、运行启停、终端读写/resize/stop、APT 包与镜像管理，以及 runtime 升级后的用户数据和包保留。

设备验收覆盖：

1. 真实 Release manifest 与资产，验证下载节点、进度/速度/剩余量、系统通知、暂停续传与失败恢复。
2. 下载中离开设置页并切换工作区，随后返回确认后台任务继续；重启 app 后确认持久任务恢复。
3. 安装、冷启动自动启动开关、手动启停、更新、重装、回滚与卸载，并检查用户工作区、APT 源及手动安装包。
4. 终端执行交互命令、`cd`、长时间运行任务与 TUI，离开页面后重进继续输入，核验工作目录、输出游标、resize、快捷键与结束操作。
5. 通过官方源和各镜像安装/卸载真实 Debian 包，核验 APT 索引失败提示与 root/cache 占用清理。
6. arm64 真机与 x86_64 模拟器验证 Linux runtime 命令可执行及升级后 loader、rootfs、包和工作区状态。

当前代码与页面处于设备验证途中，尚无完整设备证据。验收结论记录实际命令、设备、阶段和证据路径后，再更新本节状态。
