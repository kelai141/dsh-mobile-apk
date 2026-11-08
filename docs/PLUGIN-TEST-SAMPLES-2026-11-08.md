# 第三方插件测试样本计划（2026-11-08）

本文是 `scripts/verify-plugin-compat-evidence.mjs` 的**输入**：选哪些第三方插件、钉在哪个版本、怎么核对、在设备上观察什么算通过。

可执行输入在 `scripts/plugin-test-samples.json`，结构校验在 `scripts/check-plugin-test-samples.mjs`。本轮**未做设备验证**，也没有打包；所有用例状态都是 `unmeasured`。

## 1. 选取口径

样本要回答的问题是：引擎或壳侧改动之后，社区里真实在用的第三方插件是否还装得上，装得上之后是否还能干活。

四条约束：

1. **来源独立**：每个样本只取一个来源（npm 注册表 tarball），版本写死，不用 `latest`。
2. **固定版本可复算**：记录 tarball URL、字节数、`sha512` 完整性与 SHA-256，任何人重下都能逐字节比对。
3. **覆盖低热度**：月下载量 3 万以下算低热度，必测集里至少 4 个。低热度包没人替它们报障，最容易长期带病。
4. **覆盖类别**：记忆、诊断、安全审计、看板、本地媒体、配置、i18n、终端、导入导出，各至少一个。

热度取 `https://api.npmjs.org/downloads/point/last-month/<包名>`，star 取 GitHub REST `repos` 接口，均在 2026-11-08 读取。热度只解释覆盖理由，不作为判据。

## 2. 样本清单

11 个样本全部固定版本，已下载 tarball 并核对完整性、`gitHead`、入口文件与许可证。

| # | 包名 | 版本 | 类别 | 月下载 | star | 主要可观察面 |
|---|---|---|---|---|---|---|
| S1 | `dsh-lite-memory` | 0.18.83 | 记忆 | 15,751 | 4 | `memory_save` / `memory_search` 等 7 个工具，会话侧栏面板 |
| S2 | `@restregular/dsh-memory` | 0.30.1 | 记忆 | 18,043 | 12 | `memory_save` / `memory_search` / `memory_list` 等 6 个工具 |
| S3 | `dsh-plugin-health` | 3.0.7 | 诊断 | 13,543 | 4 | `plugin_health` 只读工具，设置页健康面板 |
| S4 | `dsh-trust-check` | 0.2.5 | 安全审计 | 24,545 | 2 | 设置页信任报告页 |
| S5 | `dsh-task-ledger` | 0.1.8 | 看板 | 24,237 | 6 | 任务看板页、身份设置、随包 skill |
| S6 | `dsh-music-panel` | 0.8.2 | 本地媒体 | 12,579 | 3 | `music_control` 工具、侧栏播放器、曲库设置 |
| S7 | `dsh-config-manager` | 0.4.3 | 配置 | 25,943 | 318 | `config_backup` / `config_list_snapshots` 等 5 个工具 |
| S8 | `@goodandready/dsh-russian-lang` | 0.4.23 | i18n | 13,738 | 67 | 俄语文案切换 |
| S9 | `dsh-gitbash-shell` | 0.51.0 | 终端 | 13,779 | 44 | `gitbash-shell` / `gitbash_native` 工具 |
| S10 | `dsh-chat-import` | 0.26.4 | 导入导出 | 16,037 | 292 | `scan_discover` / `import_chat` / `export_bundle` 等工具 |
| S11 | `@anysearch/anysearch-dsh` | 0.1.8 | 纯宿主工具 | 16,724 | 686 | `anysearch_capabilities` / `anysearch_search` 等工具，无客户端条目 |

11 个样本的月下载量都在 3 万以下，低热度覆盖是 11/11。S11 是唯一的 host-only 样本：它不声明 `dsh.client`，不产生浏览器条目，只注册服务端工具。补充候选（下一轮轮换，不进本轮必测集）：`dsh-video-skin` 0.1.6（纯客户端视觉，月下载 38,537）、`dsh-meme` 0.1.78（图库与上传，月下载 70,755）、`@kenz1117/dsh-engram` 0.13.9（工具面最多，`gitHead` 缺失，只能按 tarball 字节核对）。

## 3. 元数据核对结果

每个样本都从 `https://registry.npmjs.org/<包名>` 读 `versions[<版本>]`，再下载 `dist.tarball` 比对。

| # | 包名@版本 | tarball 字节 | `sha512` 完整性 | `gitHead` 可核 | `license` 字段 / 包内文件 |
|---|---|---|---|---|---|
| S1 | `dsh-lite-memory@0.18.83` | 336,883 | 通过 | 是（`568075ad`，2026-11-04） | MIT / MIT |
| S2 | `@restregular/dsh-memory@0.30.1` | 408,718 | 通过 | 是（`91af4101`，2026-10-31） | MIT / MIT |
| S3 | `dsh-plugin-health@3.0.7` | 433,259 | 通过 | 是（`492ded2d`，2026-11-08） | MIT / MIT |
| S4 | `dsh-trust-check@0.2.5` | 385,948 | 通过 | 是（`7d79a559`，2026-10-23） | MIT / MIT |
| S5 | `dsh-task-ledger@0.1.8` | 7,534,039 | 通过 | 是（`30af1e1a`，2026-11-08） | MIT / **缺 LICENSE 文件** |
| S6 | `dsh-music-panel@0.8.2` | 115,190 | 通过 | 是（`3af6d1e5`，2026-11-08） | MIT / MIT |
| S7 | `dsh-config-manager@0.4.3` | 7,430,802 | 通过 | 是（`daeabac6`，2026-11-06） | MIT / MIT |
| S8 | `@goodandready/dsh-russian-lang@0.4.23` | 649,206 | 通过 | **否**，见下 | MIT / MIT |
| S9 | `dsh-gitbash-shell@0.51.0` | 438,738 | 通过 | 是（`0c763177`，2026-11-07） | MIT / MIT |
| S10 | `dsh-chat-import@0.26.4` | 1,387,398 | 通过 | 是（`2bc71bdf`，2026-11-03） | MIT / MIT |
| S11 | `@anysearch/anysearch-dsh@0.1.8` | 173,153 | 通过 | 是（`d20ab977`，2026-10-10） | MIT / MIT |

两个异常都写进了清单的 `notes`，校验器会要求它们必须带说明：

**S5 缺 LICENSE 文件**。`package.json` 声明 MIT，tarball 内没有 `LICENSE`。测试照常进行，证据里记 `licenseFile: absent`，不得把仓库许可证当成包内许可。

**S8 `gitHead` 不可核**。注册表里的 `gitHead` 是 `16de9e0a3b61aacc25161fcb4fc3d8ef12f64422`，GitHub 对该提交返回 422。该仓发布的是 sanitized 树，`gitHead` 指向的提交在远端不存在。S8 的来源判据只用 tarball 字节哈希，不声称源码可追溯。

**S8 的 peer 冲突落在安装期**。它要求 `@deepseek-ai/cordis` 为 `~4.0.4 || ~4.0.5`，当前契约是 4.1.0。上游 boot 期只判 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`，`@deepseek-ai/cordis` 不在那一条里，所以这属于 npm 安装期的判定。测试必须如实记录安装结果（成功、ERESOLVE 或用了什么覆盖），不能写成 boot 期禁用。

## 4. 可观察功能判据

每个样本至少三条：装得上、装配成功、功能可见。装配必须分两面判定，不能合成一条。

| 用例 | 类型 | 适用 | 通过判据 |
|---|---|---|---|
| `install` | install | 全部 | `dsh plugin add <包名>@<版本>` 退出码 0，profile 的 `dsh.profile.bundles` 出现该包名 |
| `activate-host` | activate | 全部 | `pluginManager/listPlugins` 返回 `moduleName` 为该包名的行，`enabled` 为 true 且 `fiberPhase` 为 `active` |
| `activate-client` | activate | 仅声明了 `dsh.client` 的包 | 冷启动后 `window.__DSH_BOOT__.entries`（数组）里有该插件的条目，且条目 url 指向 `<包名>/client`；页面不出现 `Failed to load plugins` |

三处结构必须按实际取值，写错会让判据恒假：

- `window.__DSH_BOOT__` 的条目图字段是 **`entries` 数组**，没有 `ids`。每个条目含 `id`、`url`、`rev`。
- `entries[].id` 是 **profile 补丁行的 id**，不是包名。例如 `dsh-lite-memory` 的行 id 是 `lite-memory`，`dsh-chat-import` 的是 `import-claude`，`dsh-music-panel` 的是 `music`。包名出现在条目 `url` 里，所以核对要两边都看。
- 少数包的补丁行 id 恰好与包名相同（`dsh-trust-check`、`dsh-task-ledger`）。清单里用 `clientEntryIdsSameAsPackage` 显式登记，与「把包名当 id 猜」区分开。

**服务端工具不一定有客户端条目。** 只注册宿主工具、或只在服务端做事的插件，本来就不会进 `entries`。这类样本只能靠 `activate-host` 加工具可调用判定；拿条目缺失去判失败会把正常插件判成坏的。

功能判据逐样本如下。`ui` 在界面上看，`tool` 由模型发起一次真实调用并读回结果。判据只描述观察到的结果，不规定实现路径。

| # | 用例 | 类型 | 通过判据 |
|---|---|---|---|
| S1 | `memory-roundtrip` | tool | `memory_save` 写入带唯一标记的记录后，`memory_search` 用该标记能召回同一条，返回值含该标记 |
| S1 | `panel-visible` | ui | 会话侧栏出现记忆面板，且面板列表里能看到上一步写入的记录 |
| S2 | `memory-roundtrip` | tool | `memory_save` 写入唯一标记后 `memory_search` 能召回，`memory_list` 输出里能看到该条目 |
| S3 | `health-report` | tool | `plugin_health` 返回结构化结果并列出已装插件与其版本；单个插件缺字段时整体仍返回结果 |
| S3 | `health-panel` | ui | 设置页出现插件健康面板，其中列出的插件与 `plugin_health` 返回的一致 |
| S4 | `trust-report` | ui | 设置页信任报告页可打开且不白屏，页面上至少列出一个已装插件的能力披露条目 |
| S5 | `board-empty` | ui | 任务看板页可打开；未初始化身份时页面给出建立身份的引导，而不是报错或空白 |
| S5 | `identity-setup` | ui | 建立身份后看板显示汇总卡片，刷新页面后身份仍在 |
| S6 | `music-tool` | tool | `music_control` 在曲库为空时返回可读结果（说明曲库为空或没有可播放项），不抛未捕获异常 |
| S6 | `music-panel` | ui | 侧栏出现播放器入口；设置页能编辑曲库根目录并保存，重新打开设置页后值仍在 |
| S7 | `config-backup` | tool | `config_backup` 返回成功并给出快照标识，`config_list_snapshots` 的输出里包含同一标识 |
| S7 | `settings-page` | ui | 设置页出现配置管理分区，可打开，且其中快照列表与 `config_list_snapshots` 结果一致 |
| S8 | `locale-switch` | ui | 界面语言切到俄语后，设置页与主界面的固定文案变为俄语；切回中文后恢复原样 |
| S9 | `shell-tool` | tool | `gitbash-shell` 执行一条无副作用命令（`pwd`）并返回输出，输出非空且退出码为 0 |
| S10 | `scan-import` | tool | `scan_discover` 返回本机可发现的会话来源；对同一来源再次 `import_chat` 时不产生重复会话 |
| S11 | `host-tools` | tool | `anysearch_capabilities` 返回可用的域名或标签清单；未配置 API Key 时返回可读的错误说明，而不是静默空结果 |

判据刻意不写死实现。S9 只要求命令执行并回读输出，不管走 Git Bash 还是原生执行器；S6 只要求空库下给出可读结果，不规定文案。

S9 的补丁里还有一条 `better-sidebar` 编辑行，指向外部包 `dsh-better-sidebar`。该行在未装侧栏的 profile 上只 warn 并跳过，因此它既不是本样本的客户端条目，也不构成安装失败。清单里把它记在 `surfaces.foreignPatchRows`。

取证时按这张表核对 `entries`：`id` 列才是条目 id，包名只出现在条目 url 里。

| 样本 | entries[].id | 客户端入口 | 宿主工具 |
|---|---|---|---|
| s01-lite-memory | lite-memory | ./client.js | memory_save / memory_search |
| s02-restregular-memory | dsh-memory | ./lib/client.js | memory_save / memory_search / memory_list |
| s03-plugin-health | plugin-health | ./src/ui/client.js | plugin_health |
| s04-trust-check | dsh-trust-check | ./lib/client.js | - |
| s05-task-ledger | dsh-task-ledger | ./dist/client.js | - |
| s06-music-panel | music | ./client.js | music_control |
| s07-config-manager | config-manager | ./lib/client.js | config_backup / config_list_snapshots |
| s08-russian-lang | dsh-russian-lang | ./lib/client.js | - |
| s09-gitbash-shell | gitbash-shell | ./src/client.js | gitbash-shell |
| s10-chat-import | import-claude | ./lib/client.js | scan_discover / import_chat |
| s11-anysearch | 无客户端条目 | 无（host-only） | anysearch_capabilities / anysearch_search |

## 5. 来源与校验方式

复算一个样本三步，全部离线可做：

1. 读元数据：`https://registry.npmjs.org/<包名>`，取 `versions[<版本>].dist`。
2. 下载 `dist.tarball`，比对 `dist.integrity`（`sha512-...`）与 `dist.unpackedSize`。
3. 解包核对 `package.json` 的 `name` / `version` 与请求一致，再核 `license`、`main` 指向的文件、`dsh.bundle.patch` 指向的文件是否存在。

第 3 步的两个文件缺失是实测到的真实故障形态：`main` 指向不存在的文件时插件静默不生效；`cordis.patch.yml` 缺失时 `dsh plugin add` 只把它当普通依赖，`dsh.profile.bundles` 不会更新。本轮 11 个样本的这两项都存在。

本地校验命令：

```bash
node scripts/check-plugin-test-samples.mjs            # 结构、覆盖、判据
node scripts/check-plugin-test-samples.mjs --self-test # 1 条正样本 + 13 条受控负控 + 1 条骨架断言
node --test scripts/check-plugin-test-samples.test.mjs  # 与比较器的接缝测试
node scripts/check-plugin-test-samples.mjs --emit-samples  # 导出证据骨架，全部 unmeasured
```

## 6. 与兼容证据的关系

本清单提供 `samples[].plugin` 的取值：`name`、`version`、`artifactSha256`。`artifactSha256` 是 tarball 字节哈希，可与 npm 完整性交叉验证。

`--emit-samples` 产出的骨架可以直接填进证据文件的 `samples` 数组；`config.patchSha256` 与 `config.settingsSha256` 仍需按当轮实际装配清单与设置补齐。

两侧（基线 / 候选）必须使用同一份清单与同一批用例 id。换版本或改用例名都会让比较器判不可比，这是设计意图。

## 7. 本轮未做的事

| 项 | 状态 | 说明 |
|---|---|---|
| 设备安装与功能实测 | 未做 | 全部用例 `unmeasured` |
| `dsh plugin add` 实际行为 | 未实测 | `install` 判据来自上游 CLI 源码口径 |
| 运行期依赖解析 | 未核 | S6 的 `music-metadata`、S7 的 `js-yaml` 等需要真实装配后才能确认 |
| arm64 样本 | 未区分 | 样本本身与 ABI 无关，但快照内原生依赖需要按 ABI 分别验 |
