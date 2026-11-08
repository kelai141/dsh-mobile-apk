# Linux 运行时契约（0.15.0 冻结面）

> 本文件冻结「独立 Linux 环境」在正式发布链上的接口与所有权。任何一项改动都是契约变更，
> 必须同 PR 更新本文件，并说明受影响的验收判据。背景与分工见
> `docs/AGENTS/known-gaps.md` 的 Linux 内部插件节；执行顺序见 `docs/AGENTS/EXECUTION-MAP.md`。

## 1. 三段成分与所有权

| 段 | 内容 | 所有者 | 事实来源 |
|---|---|---|---|
| 宿主准备面 | 下载、完整性校验（sha256 + 字节数 + 包名）、安全解包、暂存区 | 本仓 Kotlin（`LinuxAssetIO` / `LinuxAssetExtractor` / `LinuxAssetPrepare`） | `linux-bootstrap-state.json` + 暂存目录 |
| 引擎控制面 | bootstrap 激活、版本状态、安装/更新/卸载/回滚、最终落位 | vendored `plugins/dsh-linux-bootstrap`（源 `kelai141/dsh-bionilux`，随快照分发、`dynamicOnly`、用户显式启用时动态加载） | bootstrap 自己的状态与复验结果 |
| 运行时面 | Debian guest 的 launcher/preload/rootfs/Node、`linuxRuntimeManager`、`linux_bash`/`linux_session` | bionilux Release（固定 tag 的资产） | 实际工具注册 + 真实 exec 探针 |

**权威规则**：状态可以有三份描述，但「可用」只能有一个权威判据（见 §4）。三段中任一段自证成功都不构成后一段的可用性证明。

## 2. 版本轴（三条彼此独立）

| 版本 | 所有者 | 说明 |
|---|---|---|
| `DSH Mobile 0.15.0` | 本仓 | APK 版本；与前两者无强绑定，只做最低兼容声明 |
| `Linux Runtime x.y.z` | bionilux Release tag | 运行时插件与 launcher 的版本 |
| rootfs 构建身份 | Linux Release 资产摘要 | 每个 rootfs/Node 资产各自的 sha256，随清单下发 |

- 安装与检查**不得**解析 `latest`：APK 携带钉定的 release tag（或由已安装状态记录），升级才走显式检查。
- 设置页必须同时显示 runtime 版本与 rootfs digest，用户要知道自己装了什么。

## 3. 资产清单契约（`linux-release.json`，由 bionilux Release 发布）

- 顶层：`schemaVersion`、`releaseTag`、`runtimeVersion`、`minAppVersion`、`assets[]`。
- 每个资产：`kind`（`plugin`/`runtime`/`backend`/`rootfs`/`node`）、`name`、`sha256`、`size`、`url`（固定 tag 的直链）、可选 `entry`。
- 契约规则：
  - 清单只做**加法**；删除或改语义必须换 `schemaVersion` 并在本文件记录。
  - 宿主只接受 https + GitHub 主机（逐跳校验重定向），落点由摘要推导，调用方不能指定路径。
  - 字节必须与清单的 sha256 与 size 同时匹配；任一不符即失败关闭，不留半装。
  - `minAppVersion` 高于当前 APK 时，安装入口必须禁用并说明原因。

## 4. 状态机与「可用」的唯一判据

```
NOT_INSTALLED -> PREPARING_ASSETS -> VERIFYING -> INSTALLED_DISABLED -> ACTIVATING -> READY
                                                                  \-> FAILED
READY -> UPDATING -> READY | FAILED
READY -> DISABLING -> INSTALLED_DISABLED
```

- `PREPARING_ASSETS`/`VERIFYING` 归宿主准备面；`INSTALLED_DISABLED`/`ACTIVATING`/`READY` 归 bootstrap；
  `READY` 之后的事实（工具是否真能执行）归运行时面。
- **`READY` 的判据 = 工具注册成功 + 一次真实 exec 探针成功**（在 guest 里跑一条无副作用的命令并回读输出）。
  不得用「fiber ACTIVE」「status().healthy」「已安装标记」替代——11-05 的「设置页显示已安装、模型侧没有
  `linux_bash`」就是投影被当成权威。`linux_environment_status` 必须由上述判据推导。
- 失败码保持稳定且可区分来源：`linux-asset-not-prepared` / `linux-asset-spec-invalid` /
  `linux-host-tree-unsafe` / `linux-asset-url-rejected` / `linux-asset-timeout` / `linux-asset-integrity`。

## 5. 下载：身份与传输分离

- **身份**来自钉定 tag 的清单与哈希，**传输**可替换；镜像只能搬字节，不能换身份。
- GitHub 官方直连是默认来源。备用镜像**默认关闭**，用户显式同意后才启用，界面显示实际来源。
- 若清单本身经镜像取得，必须另有信任锚（应用内置的清单哈希或签名）——否则镜像可同时替换清单与资产。

## 6. 数据与工作区

- 工作区路径不变、与宿主文件工具共享同一物理路径（不是复制）。
- 卸载删除运行时与 rootfs；**共享工作区默认保留**，除非用户在卸载确认里显式勾选删除。
- 重装更换 rootfs，但同一工作区路径必须跨重装存活；活 shell 属于进程，进程结束即失效。
- APK 升级不重装运行时、不自动启用、不复活用户关闭的系统；自动更新只对已启用系统生效，且必须由用户打开开关。

## 7. 控制台与 Debian shell（验收入口）

- 控制台默认运行快照 bash（Termux），该行为不变。
- debug 构建可通过 `<filesDir>/console-shell-override.json` 把控制台指向别的 argv（如 bionilux 的
  Debian bash），用于验「现有 node-pty 中继能否驱动 guest bash」。release 变体永不读取。
  条目支持 `env`（覆盖）与 `unset`（显式删除宿主环境键，例如 `TERMUX__PREFIX`——留着会让 guest
  launcher 误判前缀并 exec 宿主路径）；`unset` 先于 `env` 生效。
- 启动描述：壳侧把「启动什么」收敛成单通道 `DSH_CONSOLE_LAUNCH`（JSON：schemaVersion / shell / argv /
  cwd / env / unset），中继只消费描述并 spawn，不解释启动策略（ADR-0001）。`ConsoleLaunch` 是唯一生产者。
- 冻结的判据：tty 真实（非 `not a tty`）、job control 打开、`stty size` 非 `0 0`、SIGWINCH 可送达、
  交互输入被 guest 执行、`Ctrl-C` 中断、`exit` 后进程被回收。未通过前不得对外宣称「交互式 Linux 终端」。

## 8. 发布验收口径（阻断项）

真实（非 draft）Release 资产 + 真实 CDN；双 ABI 制品；x86_64 模拟器与 arm64 真机各一次；
安装→冷启动复用→升级→回滚→卸载 全链；失败注入（断网、摘要不符、磁盘不足、安装中断）；
真实模型自行编排一次「apt 装工具链并构建一个产物」的任务。以上缺一即未验收。

## 9. 待定项

- runtime 镜像链是否默认关闭（当前按关闭设计，等委托人确认）。
- `minAppVersion` 的取值策略（是否允许旧 APK 安装新 runtime）。
