# 0.14.5-fx-2 第一阶段交接计划

日期：2026-10-09
范围：只读工程调查、事实复核、实施编排；不含正式源码实施、完整构建、设备验收或远端写入。

## 结论

**可以移交 GPT-6 Sol 开发。** 当前 fx1 基线和六项审计发现已按实际代码复核。建议 fx2 优先处理本地构建工作区保护、插件特权边界、开机后台重试和通知延后队列的进程恢复；随后集中处理文档/发布流程。插件单一维护真源是跨多个 Git 仓、npm 发布物和两仓构建链的结构决策，虽然迁移步骤已列出，但外部消费者清单尚未取得，实施前不得删除现有入口或归档远端仓库。

本报告是静态证据；没有运行单测、门禁、构建、CI 或模拟器。未动态复现的行为均明确标为待验收。

## 1. 基线与工作区保护

| 项 | 当前事实 |
|---|---|
| 协调仓 | `/mnt/d/coding/dsh-mobile`，分支 `codex/0.14.5-fx-1-record`，HEAD `cc6c7c0a33419edb3e06ab9c51eb7aa9bfa15a21`。工作区有 AGENTS、交接/重构/验收文档修改，多个 issue 证据删除，新增发布交接、验收材料和 issue 文本。 |
| APK 子仓 | `dsh-mobile-apk/` 是独立 Git 仓，分支 `codex/0.14.5-fx-1-notes-zh`，HEAD `31b43b5737da2f81ebd7232c69498fa9518679ec`，上游同分支无领先/落后显示。普通 status 受缺失 `git-lfs` 影响；用只读禁用 LFS filter 的 status 成功。 |
| fx1 基线 | APK `origin/main` 为 `f6423726`（父提交 `ed2c3e52`）。该提交含 fx1 维护修复：版本 `0.14.5-fx-1` / versionCode 48，BrowserHost/前台恢复等 Kotlin 与插件 UI 修改、测试及文档记录。当前分支额外有中文 release notes 提交 `31b43b5`。 |
| APK 子仓脏内容 | 三个 `base/*.tar.xz` 已修改；`app/src/main/assets/plugin-hard-manifest.json` 与 `final-acceptance/` 未跟踪。均视为用户/其他工作的有效数据，Sol 不得覆盖、清理、暂存或纳入 fx2，除非其所有者明确确认。 |
| 三个组件 checkout | 协调仓下它们也是独立 Git checkout 且均有脏内容：`dsh-shell-termux` 分支 `main`，`package-lock.json` 修改；`dsh-client-ui-responsive` 分支 `codex/0.14.5-fx-1`，`src/client/general-settings/GeneralSettings.tsx` 修改；`dsh-host-web-compat` 分支 `feat/0142-track-017rc1`，`README.md` 修改。不得镜像覆盖或清理这些内容。 |
| 依赖/工具链 | Gradle 声明 compileSdk 36、minSdk 26、targetSdk 34；AGP 8.8.2、Kotlin 2.0.21、Java 17（APK `AGENTS.md`）。引擎 overlay 及 fx1 构建配置应以当前 checkout 实际文件为准。 |
| 调查限制 | `git-lfs` 缺失使 LFS 内容/普通 diff 不可读；没有验证当前设备连接、ABI、真实 APK、CI 状态或用户工作区文件内容。 |

边界保护：fx2 计划以 APK HEAD `31b43b5` 为源码审查起点；上述 dirty 内容不是 fx2 输入。开发开始前重新确认两仓分支/HEAD/status，并保留所有现存修改。不得从旧审计基线 `ed2c3e52` 推断 fx1 最终状态。

## 2. F-01 至 F-06 复核

状态按当前 fx1 checkout 判定，不沿用旧审计固定的 `main` 状态。

### F-01：本地来源构建链可覆盖或删除工作树文件

**状态：仍存在。** `scripts/source-build/run-local-source-chain.mjs` 将仓库根设为 `GITHUB_WORKSPACE`、读取当前 HEAD SHA 后，在根目录执行 workflow 步骤；前置检查核实工具与 Android SDK，但未检查 dirty/untracked 状态，也没有为整个工作树创建隔离副本。对应 workflow `.github/workflows/build-apk-source.yml` 的来源链步骤会 `rm -rf vendor/dshmarketplace-plugin` 后解包替换；还会用 `git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > ...` 覆盖当前工作树文件。之后存在针对特定配置的备份/恢复 trap，但不能恢复任意本地改动，且 marketplace 替换前只验证有限的 manifest 差异。

触发条件是运行本地来源链且本地改动落在这些写入目录/文件。影响包括未提交源码、追踪文件修改和未跟踪数据丢失。保护措施：workflow 的固定 commit/hash、定向配置备份和部分变更核验能约束输入，但不保护整个 dirty worktree。修复收益是避免本地开发数据被构建链破坏；主要风险是隔离副本的路径/权限与 CI 语义不一致。建议优先隔离到 disposable worktree/副本，并在执行任何写操作前检测 dirty（包括 untracked）；无法隔离时 fail-closed。不要仅靠写前备份少数目标文件解决目录删除面。源码路径已证实，未运行链验证实际损失。

### F-02：普通插件可伪造 `internal` 字符串授权

**状态：仍存在。** `plugins/dsh-android-bridge/src/index.ts` 的 `ControlAuth.internal?: string` 是普通数据；`androidPrivilege` 作为 Cordis service 被 `ctx.provide` 暴露。`resolveAuth` 优先接受调用传入的 `internal`，`authorizePrivileged` 用字符串索引 `INTERNAL_PRIVILEGED` 后仅校验命令形态，并返回 `internal: true`。`execAdbShell` 对此路径跳过危险命令拒绝，但后续仍经过范围检查和窄命令校验。已见授权项涵盖三种动画设置键及 SurfaceFlinger token 查询等固定操作，故旧审计所述影响应按各白名单实际范围陈述，不能泛化成任意 shell。

触发前提是同一引擎进程中的插件可取得该 provider 并直接调用 service；静态接口与服务路径成立，第三方插件实际注入可达性尚未动态核实。已有保护是逐命令形态白名单、控制队列/设备范围门和审计日志；这些不能证明调用者身份。修复收益是恢复插件间信任边界；主要回归风险是 manage 等受信任内置操作被误拒。建议把内部能力封装在服务闭包/受限方法中，调用者不能传入授权名称；保留每个操作的最窄参数校验和审计。优先级 P0（权限安全），需设计反证测试验证伪造名称、已知名称、错误命令、无 session、正常内置调用。

### F-03：服务路径快速重试耗尽后没有慢速复查

**状态：仍存在。** `EngineService.ensureEngine` 在 `startupOwnershipPending` 时用每个 service epoch 的 `StartupOwnershipRetryBudget` 排程有限次快速重试；预算耗尽时清 `startupQueued` 并返回。文件定义 `SLOW_OWNERSHIP_RECHECK_MS = 300_000L`，注释约定预算耗尽后慢速复查；`EngineStartFlow` 前台路径实际使用 `nextDelayMs() ?: SLOW_OWNERSHIP_RECHECK_MS`，但 `EngineService` 耗尽分支没有使用它。`OwnershipLeaseSettlementFixtureTest` 仅断言慢速复查在 Activity 流存在，支持该路径差异。

触发条件是开机后仅由 BootReceiver 启动服务、属主状态在快速预算后仍 pending、用户未打开 Activity。潜在结果是服务 epoch 内不再自动检查，直到外部重新 start。现有保护是有限退避、后续 external start 可重新检查以及 Activity 路径慢复查；后两者没有覆盖 service-only 生命周期。修复收益是无人打开界面时仍可自愈；风险是后台定时唤醒、旧 epoch 竞态或重复启动。建议明确重试所有权，避免 Activity 与 Service 分叉；至少让服务 epoch 在有界低频下继续复查并在销毁/新 epoch 时取消旧任务。静态证实，未设备验证系统后台限制、生命周期或复查实际调度。

### F-04：前台抑制待投通知队列不能跨进程恢复

**状态：仍存在。** `NotifySuppressQueue` 将 `Pending` 列表保存在进程内 `queue`；`enqueue` 只更新内存列表。`flush` 先从队列中摘出待投条目，再调用 `NotifyCenter.deliverDeferred`；失败时仅重新放入内存。`NotifyStore` 持久化源日志消费 offset（`KEY_OFFSET`），因此进程在源事件已消费、待投条目尚未成功补投时终止，重启后的空内存队列无法从已推进的 offset 重建该条目。

现有 TTL、最大条数、去重、tick 和失败重试只在当前进程有效。是否为产品承诺需看 `suppressForeground` 用户语义；在确认前按潜在数据/通知丢失处理。建议增加耐久 pending/settlement 存储，以稳定事件 ID 幂等投递；先确定「已通知但未清结」和 Android NotificationManager 状态之间的恢复语义、锁/并发边界、TTL/容量上限及迁移兼容，再实现。修复收益是延后通知在进程死亡后仍可达；风险是重复通知、敏感内容落盘及队列格式迁移。旧通知格式和现有 offset 必须向后兼容。静态路径已证，进程终止恢复未动态验证。

### F-05：维护文档与版本/patch registry 漂移

**状态：仍存在。** `docs/AGENTS/DEPENDENCIES.md` 当前仍写 0.14.3/versionCode 45，并链接到已失效的 `app/build.gradle.kts#L127-L150`；当前 fx1 `app/build.gradle.kts` 声明 0.14.5-fx-1/versionCode 48。`docs/AGENTS/RUNTIME-PATCHES.md` 的 engine 列表仍将 `atomic-stale-lock-F4` 列为当前项，但同一文档注明 registry 已退役；其全量列举未包含已登记的 `pi-upstream-streaming-020`、`mimo-thinking-toggle-056`、`ptc-android-native-A1`。`build-and-env.md` 提到的 marketplace A/C 已退役，且遗漏 undo S1/S2。文档和源码/registry 可直接比对。

影响主要是排查和维护说明失真；目前无证据证明这些漂移令 CI 漏跑实际功能门禁。修复收益是减少依据过期清单做错误诊断；风险是生成器/检查器自身成为新漂移源或误改历史记录。建议将易漂移的版本号和活动补丁索引从 Gradle/registry 生成，或加轻量一致性检查；历史章节保留历史语义，不用全局替换污染旧记录。低于安全/运行缺陷优先级。静态对照已证，未运行文档门禁。

### F-06：Release 跳过快照重建入口在干净 runner 不可用

**状态：仍存在。** `.github/workflows/release.yml` 将 `skip_snapshot_rebuild` 设为调试输入；为 true 时跳过 snapshot job 与 artifact 下载。之后工作流创建空 `snapshot/`，跳过复制快照，却仍逐项要求 `snapshot/snapshot-arm64.tar.xz` 和 `snapshot/snapshot-x86_64.tar.xz`。这些输入不属于干净 checkout 的跟踪文件，因此新 runner 上该调试路径缺输入而失败。

默认正式发布路径要求 false，故不是默认发布主路径缺陷。修复收益是恢复可复现的调试/复跑流程；风险是允许误用不匹配的旧快照影响 APK。建议二选一：调试复用时要求指定并校验可追溯的快照 artifact（含 commit、ABI、hash），或移除这个无效开关及对应分支。不得让正式发布可无意复用旧快照。静态证实，未启动 workflow。

## 3. 范围与优先级

### fx2 建议纳入

1. **P0 权限边界：F-02。** 普通插件输入不可授予 internal capability；测试证明允许的内置调用仍工作，伪造/越权调用 fail closed。
2. **P1 工作区完整性：F-01。** 来源链隔离或至少 dirty/untracked 前置拒绝；保护 marketplace、overlay 等实际写入面；意外中断不损坏用户工作区。
3. **P1 后台启动恢复：F-03。** service-only 启动在快速重试耗尽后仍有低频复查，且 epoch teardown 不遗留重复任务。
4. **P1 通知待投恢复：F-04。** 将抑制中的已消费通知持久化并幂等补投；或以真实用户语义证据证明不承诺跨进程延迟时，先记录明确产品决策，不做无收益存储迁移。因当前存在 offset 越过条目的丢失窗口，默认按纳入处理。
5. **P2 发布流程：F-06。** 修复或删掉调试入口，确保来源 artifact 可追溯。
6. **P2 文档/Notes/门禁流程：F-05 与流程治理。** 修复当前权威字段与索引；从版本记录建立时持续维护 `release/v0.14.5-fx-2/notes.md` 草稿，最终以目标 tag/commit、已合并 PR、issues、CI、验收证据和资产核对；Release Notes 面向用户，明确覆盖升级方式、ABI、数据保留限制、已知问题、验证状态和产物。

### 明确排除

- Issue #108 完整卸载备份：已标记 `not planned`，不纳入 fx2 必做；不得借通知持久队列或工作区保护扩展成卸载备份项目。
- 未经新证据证实的旧审计建议、无用户收益的纯形式重构、完整模拟器回归/双 ABI APK 构建逐工作包执行。
- Push、PR、Tag、Release、Issue 修改、远端仓库归档或其他远端写入。

## 4. 结构性调整方案

### 三个插件仓的真实关系

当前协调仓 `/mnt/d/coding/dsh-mobile` 含三个独立 Git checkout：`dsh-shell-termux`、`dsh-client-ui-responsive`、`dsh-host-web-compat`；APK 仓另含同名自包含目录。协调仓 `AGENTS.md` 要求改源后镜像到 APK 副本；APK 构建/快照注入、`scripts/plugin-dirs.json`、contract、API 鉴权检查及源码链均引用 APK 仓副本。APK Release 还对这三目录执行 `npm pack` 并分发 tgz。三个包 `package.json` 保留各自 GitHub repository URL 且标为 `private: true`；APK 来源 workflow 对 host-web-compat 还会 checkout 固定 commit 并逐文件比对镜像。各独立仓有自己的 PR Gate。由此可证：当前是独立组件仓 + 协调仓工作 checkout + APK 自包含构建副本的多份协作关系，不是简单复制垃圾目录。

**建议：** APK 构建必须保持自包含；长期减少“编辑一份、镜像一份”的漂移有收益。但尚无完整 npm/外部消费者/其他下游调用清单，无法确认把 APK 仓改为唯一维护源不破坏既有组件发布、版本历史和外部集成。因此 fx2 可先完成只读消费者/发布契约盘点和迁移设计，不在缺少清单时删除独立 checkout、改包身份或取消兼容发布。

若盘点确认迁移可行，单一维护源迁移应作为一个成组可审查的工作包，覆盖：组件源码与测试；package.json/锁文件及版本策略；本地/快照/Release 构建和 npm pack 入口；快照注入及 runtime lib 产物；源码审计固定 commit/hash、镜像比较与门禁；所有路径引用、验证脚本、API/contract 清单；PR/组件 CI 与 APK CI 的职责及触发条件；CODEOWNERS；README、贡献/发布说明、AGENTS/架构/依赖文档；兼容旧 tgz、包名、repository URL 和下游升级路径。先给出可运行的兼容矩阵及迁移前后同源证据，再删除镜像门禁/旧路径。远端仓库保留可恢复、不可擅自归档；归档/重定向由用户另行授权。

### 开发流程和 CI/CD

- **按输入选择测试：** 每个门禁记录读取的源码/配置/生成物、保护目标和有效证据的 commit/hash；相关输入、运行环境或门禁实现变化即失效。最终候选仍集中执行完整要求门禁。
- **批量修改统一验：** 一个工作包实现完成后跑其廉价单测/静态检查；关联代码修正完成后，再集中执行受影响套件与设备验收。权限、持久化事务、桥协议、签名、门禁自身等安全敏感改动例外，及时做窄范围验证。
- **快照热替换：** 仅纯快照 JS/插件改动可用于开发期快速迭代；Kotlin、Manifest、签名、APK assets 或快照封装变更仍需实际 APK。热推不证明最终 APK。
- **ABI：** 每轮开发先用 ADB 盘点已连接设备及其 ABI；只有设备非空且 ABI 均明确为 x86/x86_64 时，才可把开发测试构建缩为 x86_64。设备为空或 ABI 未知不可推断。最终仍需从最终源码构建双 ABI，并检查 APK/快照身份和哈希。
- **门禁分层：** 阻断门禁包括用户数据安全、权限/功能实际生效、运行时正确性、ABI/签名/APK/快照完整性和可追溯产物。文档、清单、路径索引等维护一致性检查可放 PR Gate 可见，并按路径运行；如果不是合并必需条件，不得配置为 required status。门禁分类由实际保护目标决定，不以脚本名称决定。
- **发布说明：** 从 `notes.md` 大纲持续更新，草稿标清计划/待验证；最终清掉未实现内容。对照上一正式 Release、目标 tag/commit、已合并 PR、issue、CI/设备证据和最终产物逐项核对。没有证据的兼容/数据保留承诺不得写入。

## 5. Sol 实施工作包

### WP-1：内部特权 capability（P0）

- **目标/证据：** 修复 F-02；目标模块为 `plugins/dsh-android-bridge/src/index.ts` 及其测试。服务 provider 与 `ControlAuth.internal` 的调用者可控字符串现可绕过 session/tier 门，并让 shell 检查跳过 dangerous-command deny。
- **方向/自主空间：** 优先将固定受限操作移入专用 service 方法，或由可信闭包生成不可由普通插件构造的 capability。Sol 可在既有 Cordis/TS 结构内选型，但不能仅换一种可序列化字符串或公开 symbol 名称。
- **依赖/冲突：** 与其他桥面工作隔离；若改变 service API，需搜索 manage、bridge 内部全部调用方并同步协议/架构文档及相关协调仓镜像流程。避免覆盖 fx1 工作区的未提交数据。
- **兼容/自检：** 不改变合法 manage 操作效果、范围/命令白名单和审计；加入伪造、误用、无 session、危险命令反证及合法内置调用测试。桥/插件协议静态门禁按改动触发。
- **第三阶段验收：** 单测/静态门禁；MuMu 安装最终候选后用真实高层任务覆盖拒绝和允许路径，检查代码/CDP/ADB 三层及日志审计。优先级 P0，收益是消除可由同进程插件伪造的信任边界，回归风险是内置维护功能误拒。

### WP-2：来源构建工作树隔离（P1）

- **目标/证据：** 修复 F-01；涉及 `scripts/source-build/run-local-source-chain.mjs` 与 `.github/workflows/build-apk-source.yml` 中 marketplace 目录替换、overlay 写入及后续恢复步骤。
- **方向/自主空间：** 优先采用独立临时 worktree/副本；若平台约束阻止，至少在任何变更前对完整 tracked + untracked dirty 状态拒绝，并对允许修改的路径建立可恢复、逐项校验的事务。不得清理已有 dirty 数据。
- **依赖/冲突：** 触及 workflow/构建治理；需对照本地 runner 与 CI 同步语义。不要修改不相关 `.deploy-tmp` 证据或快照基线。
- **兼容/自检：** clean 输入行为和 pinned source/hash 必须不变；测试 dirty tracked、untracked、目标目录含额外文件、失败/中断恢复。无完整链构建要求。
- **第三阶段验收：** 在隔离测试副本确认 dirty 状态被安全拒绝或原地输入完全不变；完整来源链作为集中验证策略决定是否执行。收益是防止开发数据丢失；风险是隔离增加磁盘/耗时或路径差异。

### WP-3：service-only 属主慢速复查（P1）

- **目标/证据：** 修复 F-03；`EngineService.ensureEngine` 的预算耗尽分支与 `EngineStartFlow` 使用相同 retry budget/slow interval 的差异。
- **方向/自主空间：** 明确一个 epoch 的重试 owner；快速预算后复用五分钟复查或统一调度器。复查期间检查 epoch 有效性，销毁时取消，不允许旧 epoch 启动引擎。
- **依赖/冲突：** Kotlin 生命周期模块；新类/职责变化需更新 `docs/AGENTS/EXECUTION-MAP.md`、modules/architecture 按需更新，并跑 code-map 门禁。避免顺手重写 watchdog。
- **兼容/自检：** 不增加高频唤醒、不绕过 Shizuku 权限、snapshot recovery 或 engineReady 门；覆盖 retry 次数、慢复查、epoch 取消/替换测试。
- **第三阶段验收：** MuMu 验证 service-only pending 后恢复属主的最终启动，Activity 路径不重复启动，ADB 用户层确认真实任务完成；设备系统后台策略待验证。收益是开机无人操作时可自行恢复；风险是重复复查/后台唤醒。

### WP-4：前台抑制通知耐久队列（P1）

- **目标/证据：** 修复 F-04；`NotifySuppressQueue` 内存列表与 `NotifyStore` 持久化 offset 之间存在消费/补投丢失窗口。
- **方向/自主空间：** 采用原子持久化的 bounded pending ledger、稳定 ID 与投递结算；允许复用现有存储层，但必须先写出并测试进程终止时序。不要将此改造成完整备份系统。
- **依赖/冲突：** Kotlin 通知链，和 WP-3 无源码冲突但共享设备验收资源。涉及持久化 key/文件需登记 `PERSISTENT-DATA.md`；不新增不必要依赖。
- **兼容/自检：** 保留当前通知格式、排序、TTL、容量、去重、关闭抑制时补投语义；已有数据无需迁移或有明确兼容迁移。覆盖 enqueue→offset advance→process death→restart、重复投递、投递失败、TTL、并发和损坏存储 fail-safe。
- **第三阶段验收：** 通过可控进程终止/重启验证不会静默丢失或无限重复，再做 MuMu UI 通知实际体验与三层验收。收益是可靠延后通知；风险是重复通知、存储膨胀和通知内容敏感数据落盘。

### WP-5：文档权威化、Release 调试开关与开发流程（P2）

- **目标/证据：** 修复 F-05/F-06；`DEPENDENCIES.md`、`RUNTIME-PATCHES.md`、`build-and-env.md` 与当前 Gradle/registry 不一致；Release 的 skip snapshot 分支在干净 runner 缺输入。
- **方向/自主空间：** 将易漂移索引生成或校验；版本引用对齐当前源码且保留历史章节；修通 artifact 复用或移除无效输入。按本计划第 4 节补齐 AGENTS 流程规则、notes 证据核对与门禁分类。
- **依赖/冲突：** 建议和代码工作包分开提交/审查；流程规则适用于协调仓及 APK 仓，注意协调仓现有脏 `AGENTS.md` 与其他文档，不覆盖它们。
- **兼容/自检：** 不降低功能/数据/产物阻断门禁，不让旧快照进入正式发布；文档一致性测试覆盖实际 registry 和 Gradle。Release notes 不得把计划、未合并 PR 或开发热推写成已交付。
- **第三阶段验收：** 静态检查/PR Gate 结果和 notes 追溯核对；不需单独跑设备回归。收益是提高排查和发版说明可信度；风险是历史文档误改及把非阻断检查误设成 required。

### WP-6：三插件维护真源迁移评估（条件性 P2）

- **目标/证据：** 解决多仓重复编辑/镜像的维护成本；当前代码、构建、npm pack、来源 workflow pinned commit 比对都依赖现有多份副本。
- **方向/自主空间：** 本轮先完成外部消费者、npm 分发、各仓 release/tag、版本兼容和维护权限盘点；形成保留兼容包名/版本/repository URL、灰度 cutover、回退和历史归属方案。若证据证明无破坏性且无需外部授权，可在 Sol 阶段实施完整仓内迁移；否则仅交付决策与可执行后续步骤，不删除入口。
- **迁移必须覆盖：** 源码/测试、构建、快照注入、CI、路径引用、pinned source/hash、CODEOWNERS、README、AGENTS/架构/维护文档、npm tgz/消费兼容、镜像门禁移除和恢复方案。不得在本地迁移后自动归档远端仓。
- **验收：** 改前改后同一源码/产物哈希证明；clean checkout 的 APK build/package 来源完整；独立组件 CI 和旧消费者过渡政策明确。风险高、跨仓面大；仅在消费者清单通过审查后进入实施。

## 6. 并行安排、开发期自检与第三阶段验收

建议 Sol 先串行完成 WP-1 的接口决策，再并行 WP-2、WP-3、WP-4、WP-5；WP-6 只做消费者盘点并独立决策。WP-3/WP-4 文件面分离，可并行编码，但集中使用单一设备/构建资源，避免并发快照刷新和 MuMu 回归。Sol 应成组完成关联修正后跑针对性单测与静态门禁，不在每个包里重复跑双 ABI build/全量模拟器验收。

第三阶段集中执行：

1. 复核最终提交、双仓状态、工作区保护、Issue #108 排除和 fx2 变更清单。
2. 代码层：相关 Kotlin/插件测试、dirty-worktree/来源链反证、桥对称、code-map、release gates 及受影响静态检查；门禁按输入变化复用有效证据并记录 hash/commit。
3. 构建层：最终源码双 ABI 快照与 APK、签名/manifest/版本/快照内容/哈希和 Release 资产一致性核验。开发期 x86 快捷构建不能替代此项。
4. MuMu x86_64：按 `dsh-mobile-apk/AGENTS.md` 与 `docs/AGENTS/emulator-test-protocol.md` 完成真实模型自行编排任务；代码、CDP、ADB 用户实际操作三层均需 PASS，竖屏/横屏按改动范围覆盖并留截图、命令与结论行。
5. 故障恢复：service-only 启动、进程终止后的通知恢复、来源链 dirty 输入保护须有专项证据；做覆盖升级并核实会话、插件、模型配置、工作区设置、对话历史仍可用。完整卸载备份不在范围内。
6. 最终 ARM64 快照/APK与真机属于发布前补充门禁；按仓库流程验证，但不能作为开发前置，也不能用 MuMu 结果替代。发布说明只使用最终 tag/commit 与已完成证据。

## 7. 未决风险与决策

- **F-02 威胁模型：** Cordis 对普通插件的 provider 可见范围和实际第三方插件装载链尚未动态验证；静态设计已足以移除调用者自带授权标记。
- **F-04 产品语义：** 前台抑制是否承诺跨进程保留需确认；默认计划按通知不可丢处理，避免现有消费 offset 造成静默损失。队列内容持久化需评估隐私。
- **插件消费者：** 未调查所有外部用户、npm tgz 历史消费、各独立仓 release/tag 与下游 fork；迁移工作包不得据“private”推断无人依赖。
- **动态运行：** 六项均未进行设备/CI 复现；F-01/F-02 的触发可达性，F-03 的 Android 生命周期行为，F-04 的实际丢失时序，F-06 的 workflow 新 runner 行为都待第三阶段或针对性 CI 验证。
- **当前用户内容：** 三个大体积 LFS 底座变更、hard manifest、final acceptance 文件和协调仓脏文档均不属于自动清理对象。
- **Issue #108：** 旧报告有卸载备份建议，但本轮明确排除，不得在工作包中复活。

**交接判定：可以移交 Sol。** 先要求 Sol 保留本报告所列两仓 dirty 内容，并确认使用 APK 子仓 `31b43b5` 作为 fx1 代码基线；关键未决风险是插件外部消费者盘点及通知延后是否具备跨进程产品承诺，不妨碍 WP-1 至 WP-3 开始，WP-4 按本报告的保守数据保护方向执行。
