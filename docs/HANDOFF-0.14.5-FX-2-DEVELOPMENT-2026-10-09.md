# 0.14.5-fx-2 第二阶段开发交接

日期：2026-10-09。状态：**WP-1 至 WP-5 已本地集成并完成针对性自检，可以移交 Luna 第三阶段完整验收；尚非发布就绪。** WP-6 条件性完整迁移未授权进入破坏性实施，已完成盘点和低风险来源证明收敛。

## 1. 候选与保护

- APK 基线 `31b43b5737da2f81ebd7232c69498fa9518679ec`，本地分支 `codex/0.14.5-fx-2-development`。
- 协调仓基线 `cc6c7c0a33419edb3e06ab9c51eb7aa9bfa15a21`，本地分支 `codex/0.14.5-fx-2-engineering`。
- 候选代码在上述分支工作区；未创建正式提交、Tag、PR、Release，未远端写入。`git status` 要用只读 `-c filter.lfs.process= -c filter.lfs.required=false`，本机缺 git-lfs。新分支创建时 post-checkout hook 报缺 git-lfs，但分支已成功切换，未删除 hook。
- Gradle 权威版本 `0.14.5-fx-2` / versionCode 49，覆盖 fx1 的 48；未动上游 `dsh/`。
- APK 既有三份 `base/*.tar.xz`、未跟踪 `plugin-hard-manifest.json`、`final-acceptance/` 未纳入开发改动，禁止清理或打包时无证据覆盖。协调仓旧 AGENTS、交接/验收/重构文档、issue 图片/日志删除和未跟踪材料均保留；AGENTS 只追加本阶段路由。
- 第一阶段三个独立 checkout 的 status 仅摘取部分条目，不是完整 dirty 清单。本轮复核：Termux 有 package/lock 引擎 pin 修改；UI 有 GeneralSettings/index/测试修改和两份 sidebar gesture 未跟踪文件；host 有双语 README、lib、watchdog 测试、smoke 修改。这些现有源码/生成物与 APK 对应副本一致，未覆盖、清理或提交独立仓内容。

## 2. 工作包闭环

| 包 | 实际实施与关键证据 | 状态 |
|---|---|---|
| WP-1 / F-02 | bridge `ControlAuth` 移除 internal；公共调用拒绝该字段；JS 私有授权/执行入口封装固定 SF 查询；动画读写为会话授权窄 API。manage 调用专用接口。原始 controlExec shell 也执行危险命令检查。两仓 src/test/lib 已用 robocopy /E 镜像，不使用 /MIR。 | 已集成；插件测试通过，设备权限组合待验 |
| WP-2 / F-01 | local runner 读 HEAD workflow，在非原仓独立浅检出执行，重定 cwd/GITHUB_WORKSPACE/DSH_APK_DIR；拒祖先/后代/别名、未知非空目录、错 HEAD、深层链接/Gitfile 源仓逃逸、object alternates；保留隔离产物，不回写原仓。 | 已集成；破坏性 fixture 及实际 runner 路由测试通过 |
| WP-3 / F-03 | EngineService 快速预算耗尽后五分钟慢复查；Future 安装同步、epoch 退役取消与迟到回调护栏，保留既有 ownership/端口失败分类。 | 已集成；生命周期单测通过；**设备动态 PASS**（AVD 引擎层+用户层全 PASS，MuMu 交叉佐证） |
| WP-4 / F-04 | 查阅现有代码及产品契约确认 suppress=defer、关闭补投；现有 dsh-notify prefs 新增 notify.deferred.v1，pending 八条/五分钟、settled 三十二哈希/五分钟；先同步提交后消费，start 恢复；错误保留源/轮转 cursor；活跃系统通知身份回执处理已发未结算窗口。 | 已集成；145 项 Kotlin 窄回归通过 |
| WP-5 / F-05 | 生成器读取 Gradle/wrapper/registry；生成当前依赖与活动补丁块，保留历史。PR 按输入变化提示维护漂移；功能门禁仍阻断。合并独立 compile 步骤到 testDebugUnitTest，去掉编译 job 重复 code-map，静态 job 仍执行。 | 已集成；生成器反证及接线检查通过 |
| WP-5 / F-06 | 移除没有快照来源的 skip_snapshot_rebuild；Release 必须同次运行双 ABI snapshot 成功，lock provenance 无条件归集。 | 已集成；YAML/接线通过，未运行远端 workflow |
| WP-6 | 来源链移除失效 host 外部 pin/cmp，三组件绑定 APK projectCommit、路径/身份/输入与实际输出 hash，仍检查 Cordis overlay。保持源码布局、包名/版本/repository、tgz 分发与镜像规则。 | 最小收敛完成；完整单一维护源迁移仍条件未满足 |

WP-1 的授权决定调整了第一阶段 token/capability 推荐：采用 JS 真私有方法与固定参数 API，不暴露可转交的 token，更小实现仍隔离公开 auth 数据。但同一 Node 进程的 session/装配信任不是完整恶意插件沙箱，未扩大为进程隔离。

WP-2 使用无共享 object 的独立浅仓而非 worktree，避免构建命令触碰原仓 Git 管理面。隔离仅构建 committed HEAD，不构建 dirty 内容；第三阶段运行正式链前需本地提交候选，否则 HEAD workflow 仍是旧版本。

WP-6 实证修正：旧 pinned host commit `2de902729e01eb3619aa50bdfa164c5231948848` 的 lib hash 为 `e5b13f35bc905da0aa9ca13f1255719fbe9a7f64436e9d4ec9d74f3e90d0cbd4`，APK fx1 已提交 lib 为 `d3250a6b64b5aeb89ce755a4ad4fda95aea2dc69b2cf6df8058056441b677c34`，原 cmp 必然失败。不是为重构而删保护：替换为 APK 提交逐文件一致性、输出来源及 overlay 校验，拒绝 dirty/untracked 输入与构建改写源码。

## 3. 自检证据

以下均为本地开发自检，不是 APK 或真机验收。主代理复查实际 diff 和调用链，不仅引用子代理完成声明。

| 范围 | 命令/证据 | 结果 |
|---|---|---|
| bridge | Windows npm build；Linux `node --test test/*.test.mjs`，覆盖伪造 internal、权限档位、动画读写还原、SF 与 ALS；最后补充 null/数组/非对象参数反证，重跑动画专用接口用例 | 162/162；最后受影响用例1/1 |
| manage | `npm test`，日志协调仓 `.deploy-tmp/fx2-development/manage-tests.log` | 82/82 |
| Kotlin | 单一 Java wrapper `:app:testDebugUnitTest`，选所有 Notify*、NotificationContractTest、StartupLifecycleOwnershipTest、OwnershipLeaseSettlementFixtureTest；非增量、in-process | 11 套件 145 项，0 失败/错误/跳过 |
| Kotlin 证据 | `/tmp/fx2-runtime-tests-final.log`；`app/build/test-results/testDebugUnitTest/TEST-*.xml` | BUILD SUCCESSFUL |
| 隔离/来源 | `node --test scripts/source-build/local-source-workspace.test.mjs scripts/source-build/record-project-components.test.mjs` | 8+7 项通过 |
| 来源既有复跑 | `node --test scripts/source-build/source-chain-rerun.test.mjs` | 14/14 |
| 维护生成器 | `node --test scripts/tests/maintenance-docs.test.mjs`；`node scripts/check-maintenance-docs.mjs` | 3/3；实际 fx2 块一致 |
| 版本 | `node --test scripts/resolve-version-suffix.test.mjs`，测试从实际 Gradle 读取版本而非写死旧版本 | 7/7 |
| 契约/静态 | check-code-map、check-kotlin-comments、check-bridge-symmetry、check-api-route-auth、check-protocol-v2、check-release-gates（无 --run） | 全通过；API SKIP=0，协议10/10；release 为静态接线，不冒充全门禁 |

主代理另外直接解析 Kotlin XML 核实 11/145/0/0/0；PyYAML 解析三个改动 workflow 并断言维护 job 非阻断与 Release skip 已移除；两插件 src/test/lib 及版本测试镜像逐字节相同；限定本轮代码/配置/文档的 diff --check 通过。

环境失败已修复：WSL PowerShell 调用 gradlew.bat 曾提前空返回，但后台两个本任务 runner 同时写 app/build，造成 unresolved 增量类及 R.jar Windows 锁。按命令/PID/父 PID/创建时间确认后仅停止本任务进程；未动用户既有 Gradle daemon。单一 `D:\tools\jdk-17\bin\java.exe` wrapper + `-Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process` 完成有效验证，未清理用户缓存。

Node_modules 的 esbuild 为 Windows 包；Linux TypeScript 能过而客户端 bundle 构建失败后，改 Windows npm build 正常完成。桥 full npm PowerShell 空日志不能用作通过证据，实际采用随后显式 Windows build 与 Linux 完整 Node tests。

## 4. 第三阶段必须完成

1. 核实两仓候选与 dirty 保护，局部提交只包含本轮文件。不要暂存已有 base、manifest、final-acceptance 或协调仓旧用户文档；最终记录真实 commit。仅可复用相同输入 hash/门禁版本/环境的有效自检。
2. 查询 ADB devices 与实际 ABI，再选择开发构建；第二阶段没有选择 ABI、没有 APK 构建，也没有把设备未知推定为 x86_64。最终必须 arm64 与 x86_64 完整 APK、签名、快照来源/哈希和完整门禁，不以热替换代替。
3. MuMu 代码/CDP/ADB 三层真实任务验收，并保留 fx1 #340/#341/#342 横竖屏、bounds 续租、故障分类回归；发布前真机补充。
4. 权限：伪造 public internal 不入队；合法会话/档位、危险开关、SF 查询、动画读写/还原在 Shizuku/root/不可用组合正确，壳屏幕范围门不回归。
5. 服务：无 Activity 的冷启动属主等待，快预算耗尽后恢复；五分钟节拍不空转，销毁重建不执行旧 epoch，端口外来占用诊断不被吞。
6. 通知：显式前台抑制期间进程回收、应用恢复、关闭开关、TTL/容量/覆盖、通知权限变化、journal/offset 提交失败、已发未清结窗口及用户撤通知。未知/损坏 journal 当前 fail-closed 留 source cursor 并记录探针，不自动清空；需核验错误可解释性。OS 与 prefs 无跨系统原子事务，至少一次与有界结算不等于全局 exactly-once。
7. fx1→fx2 覆盖安装，模型配置/历史/工作区/插件清单/设置不丢；不要卸载或清数据冒充升级。新增通知私有正文日志与原 notify 源同一私有边界，diagnostics/备份导出需按既有敏感信息规则处理。
8. clean committed candidate 的 sources 链和 Release graph 全输入验证；三组件 provenance 正确，包/tgz 入口不失效。最终 notes 按真实 Tag/commit、PR、Issue、测试与产物逐项核对，无完成证据不得写已发布。

## 5. 排除与未决

- Issue #108 完整卸载备份不实现；不改远端 Issue 状态。
- 不做上游核心扩散，不换 HOME，不清用户插件/配置/历史，不归档远端仓。
- 完整三插件源码真源 cutover 尚不能宣称完成：协调 .gitignore 排除独立仓、README 指向独立入口；build-apk 脚本和 inject-all 按 basename 映射 scoped 包；linux-env file:../../dsh-shell-termux；Release 固定三 tgz；独立 CI 与 Termux/host README 消费入口仍在。未发现 CODEOWNERS，不等于有权替外部维护者指定归属。外部实际消费者、Tag/Release 使用者未做穷举。
- 后续迁移须一次覆盖源码/测试、构建/快照、CI/registry、路径/包身份、CODEOWNERS/README/AGENTS、镜像政策、旧消费者过渡与回退，再独立审查。当前保留这些入口是第一阶段批准的条件边界，不是未完成的强制工作包。

结论：**第二阶段可完成范围已集成，可以移交 Luna 验证。** 完整双 ABI、设备、覆盖升级、真实来源链及最终发布就绪判断尚未执行，不能据开发单测宣称可发布。

## 6. 第三阶段进展（2026-10-10）

第三阶段复核发现 Stage 2 的 F-02 队列私有化仍不充分：`private` TS 构造参数属性编译后是普通 JS 对象属性，可直接取得 `controlQueue`；此外 `ControlAuth.session` 可由插件伪造，实际固定版 sandbox-policy/session-projection 会读取其自报 `snapshotEvents()` 并接受伪造的 `danger-full-access`。独立复现已取消队列项，未与设备交互。

本轮修正：
- bridge 控制队列、策略和执行依赖使用 JS `#private` 字段；SurfaceFlinger 内部查询为私有方法。
- 特权授权只接受 `ctx.sessions.get(session.id) === session` 的活动会话对象；无 Store、无效/伪造对象均 fail-closed。添加对象属性不可见、伪造 Session 不能授权 `gateFor` / `execAdbShell` / `controlExec` 的回归用例。
- 通知 journal 损坏或未知 schema 时保留原始 prefs，不反复解码、不继续消费/写回；记录 probe 并 fail-closed，避免源事件被错误覆盖。
- 更新 `release/v0.14.5-fx-2/notes.md`，明确权限收紧实现和 Kotlin 跳过项，不宣称设备验收完成。

截至该记录：bridge Windows `npm test` 为 157/157；Kotlin `:app:testDebugUnitTest` BUILD SUCCESSFUL，105 XML suites / 1152 tests / 0 failures / 0 errors / 2 skipped。Kotlin XML 位于 `app/build/test-results/testDebugUnitTest/`。屏幕范围回归测试先修复了旧测试遗漏 SurfaceFlinger 第二跳回填后，完整 screen-scope 47/47 通过。实际测试输入为当前未提交修复工作树，故这些结果不适用于更早的 `595562bc76deb81f15514b6a11bed66d215e9405` commit。

最终双 ABI 快照与 APK、MuMu 三层回归、覆盖升级验证尚未执行；此记录是进度证据，不是发布就绪声明。最终交接须追加修复 commit、隔离构建产物哈希、设备测试结果和全部未执行/跳过项。

## 7. 第三阶段最终验证记录（2026-10-10）

### 候选与产物

- APK 仓候选：`acfac65dee19369e05f23643c39e06eca894345f`；协调仓 scratch HEAD：`be3a63dd90fdb6e156ec38362d7b37c217eb6acb`。当时均为本地候选、未 push/PR/tag/release；其后已由 PR #345 / #97 合入并触发 Actions 一键链，见第 9 节。
- APK 仓保留未跟踪输入 `app/src/main/assets/plugin-hard-manifest.json`；构建依赖 `node_modules` 也未跟踪。未清理或纳入交付提交。验证记录更新本文件与 release notes。
- 双 ABI 最终 APK：arm64 SHA256 `5cc0d298bf88831e45b6365c134d5d5536b06e7a51f40b934cc031c2d652ee0d`；x86_64 SHA256 `fc7dbd195c5489f92a7e3b3f715d726c77a65e362e422d3f1d8aab287bc18e3c`。版本 `0.14.5-fx-2` / versionCode 49；最终全链签名及 repo 签名身份门禁通过。
- 最终 runtime snapshots：arm64 SHA256 `88bbcf08bfe64a9805669eaf2c6c66a93e10dc35d7a2eda0d664b5e417713614`；x86_64 SHA256 `44fb9677d378431b21d98dbbaf7f15fa5bff7e90a74c69ca7170d6ad2faf9777`。快照来源指纹、插件闭包、补丁、secret、ABI ELF、权限和嵌入内容均经双 ABI 构建链检查。

### 最终证据矩阵

| 验收范围 | 输入/环境 | 结果 | 证据边界 |
|---|---|---|---|
| 插件、补丁、CI 合同与静态门禁 | 最终 scratch 源码候选；Windows + WSL Node；官方 APK build chain | PASS（附已知 fixture 失败） | 双 ABI 门禁运行；镜像、版本、API auth、协议、工具合同、patch registry/fixture、插件测试及 Kotlin 105 个 XML suite / 1152 项测试通过，0 失败、0 错误、2 跳过。完整链中两项预先登记的 emergency CLI patch fixture 仍为失败用例，manifest 明确容许且总门禁通过；不得把它们表述为通过。 |
| Snapshot 与 APK | 同一最终候选；arm64 + x86_64 | PASS | 双 ABI snapshot、最终 APK、签名及 SHA256 已生成并核对；产物位于本地 scratch `out/v0.14.5-fx-2/`，不是发布附件。 |
| fx1→fx2 覆盖安装及私有数据保留 | 隔离 Android 35 x86_64 AVD；官方 fx1 release APK SHA256 `1c46a266d642a66cac0131709f49afeefd4d3ef42bb4c47983f12c33eb379624`；fx2 最终 APK；ADB | PASS（持久化子集） | fx1 versionCode 48 升级到 49；合成私有文件中的模型配置、history、workspace、plugin registry 标记均在覆盖后、force-stop/reopen 和 OS reboot 后保留。API `session/list` 在 reboot 后仍返回相同空白 session。未清除数据或卸载。文件标记并非 Harness 实际配置文件，因此不等于模型配置解析和真实对话端到端测试。 |
| fx2 全新数据目录首次安装与快照恢复 | 新建隔离 Android 35 x86_64 AVD `Codex_FX2_Clean`，ADB serial `emulator-5570`；x86_64 最终 APK SHA256 如上 | PASS（运行与页面）；首装性能需关注 | 全新 AVD 直接安装 versionCode 49；首个 `am start -W` 返回 timeout，但 Activity 随后启动，约 8 分钟完成快照暂存/提交，fingerprint `3a15f94d90bf07c2804aa2e13e216423f20a8843f5ed719465cdad72482c3f2c` 与 x86_64 最终快照一致，`.snapshot-stage` 消失，`127.0.0.1:3080` LISTEN。没有 `snapshot-transaction-in-flight` 或 `boot-fail.log`。Android 截图和 CDP 页面 ready，点击“Configure later”后主页可见；CDP 调用 `session/list` 返回 HTTP 200、一个空白 session。首装耗时包含模拟器中的完整快照解包，不与运行时 boot-budget 混为一谈。 |
| Android 前后台、Service 与恢复 | 隔离 Android 35 x86_64 AVD `Codex_FX2_Stable`；ADB/CDP | PASS（AVD 范围） | 前后台切换后 Service 保持前台，Activity 重开为 warm；force-stop 后进程 cold restart 成功、CDP 页面和 session/list 恢复。OS reboot 后，在未启动 MainActivity 时观察到 `BOOT_COMPLETED` 启动 EngineService 且 `127.0.0.1:3080` LISTEN；之后打开 Activity，WebView 页面 ready 且 session 元数据仍存在。此项不是 MuMu / 真机验证。 |
| MuMu fx1→fx2 覆盖安装与真实 MiMo 任务（三层验收） | MuMu `PGBM10` / `127.0.0.1:16512`，x86_64；从 fx1（versionCode 47）覆盖安装最终 fx2 APK（versionCode 49，SHA256 `fc7dbd195c5489f92a7e3b3f715d726c77a65e362e422d3f1d8aab287bc18e3c`）；ADB + WebView CDP；MiMo 2.5 | PASS（三层任务、升级和冷重启） | **代码层：** 最终候选 APK 安装并启动，runtime fingerprint 为 x86_64 目标 `3a15f94d90bf07c2804aa2e13e216423f20a8843f5ed719465cdad72482c3f2c`，快照 staging 完成后目录消失，`127.0.0.1:3080` LISTEN。**CDP 层：** 新建独立会话，确认选择器为 MiMo 2.5；真实请求完成并返回 1 轮 4 步，报告为 `8,240 + 5,880 - 4,130 = 9,990` 分。**ADB 用户层：** 屏幕截图显示完成答复和附件卡片；文件 `files/home/.dsh/workspaces/incoming/fx2-mumu-mimo-report-20261010.md` 已落盘（1,649 bytes），逐项金额、分类小计及算式复核正确。目标文件发送前确认不存在；覆盖前已存在的两份合成报告、`upgrade-check.txt`（内容 `UPGRADE-OK`）及 `.credentials.yaml` 均保留，凭据内容未读取或输出；force-stop 后 cold launch（2,563ms）再查，输出文件、`upgrade-check.txt` 和会话仍可见，模型选择仍为 MiMo 2.5。首次安装后曾记录一次 `engine-died` 诊断，快照事务完成后服务恢复；未证明其具体根因，后续运行与冷重启通过。该工作区只新增本任务唯一指定文件；另一台 MuMu `PJJ110` 未触碰。 |
| Boot budget 真数据与 C5 活性 | 同一最终快照；AVD 冷启动原始日志、MuMu 五轮串行冷启动；正式 `check-boot-budget.mjs --require-real` | 逐轮结果保留，非全环境性能保证 | AVD 首轮 C1=6901ms/C4=7887.6ms FAIL，随后 C1=2428/2690ms、C4=7102.3/6788.5ms PASS。从最终 snapshot 提取真实 patched modules 后重新执行 C5/C5+，HTTP 200、154 bytes、同一 lazyBody Promise，SKIP=0；目录是部分离线对照树，不冒充完整恢复。MuMu cold1 C1=5054/C4=9107.4 FAIL，cold2 C1=6196 FAIL/C4=6076.5 PASS，cold3 C1=1499/C4=4668.2 PASS，cold4 C1=1389/C4=1930.4 PASS，cold5 C1=728/C4=2046.2 PASS，后3轮连续 PASS/SKIP=0。cold1/2同期宿主free RAM约1182MB；关闭本任务已完成的5570后约5462MB；时间相关不等于确定因果。慢窗在loader-settle-wait，不是同步compose（max 5–18ms）；不能把红项称为噪声或直接指认某插件。 |
| MuMu Shizuku、屏幕范围与真实模型任务 | MuMu PGBM10；Shizuku UID2000；MiMo 2.5；最终 APK；`verify-screen-scope-matrix.mjs` | 9/9 PASS，FAIL=0，INCONCLUSIVE=0 | 新建专用 full-access 会话，模型自行编排18步；Settings 新 ActivityRecord 落在目标虚拟屏 display3，模型输入改变该屏像素，不抢真实屏前台；real-only 下 virtual-only 操作明确 screen-out-of-scope。模型尝试图片输入被原配置拒绝后自行恢复，不擅改模型 modality。恢复原 virtual-only scope，销毁本轮屏。原未确认 full-access 运行的 INCONCLUSIVE 保留为前置错误。证据 `.deploy-tmp/scope-matrix/2026-10-09T22-41-49/`。 |
| RootGrant 与 F-02 设备动态反证 | Android 35 x86_64 AVD5570；Shizuku UID0；最终部署真实 bridge/Node/app UID | root 6/6、伪造 6/6 PASS | 未同意、OFF、已同意但OFF均拒绝；ON后实际修改 ACCESS_RESTRICTED_SETTINGS appop，撤销后拒绝；Shizuku 未授权即使 root 门 ON 仍拒绝。internal/伪会话/复制ID/bindSession伪对象全部 enqueue=0；合成registry测试不是模型工具。临时桥插桩未形成结果且已还原候选 SHA，正式矩阵在原字节下执行。恢复 grant=false/consent0/授权false/appops default。证据 `.deploy-tmp/stage3-remaining/root/evidence.md`。 |
| 原生跨层状态同步 | Android 35 AVD5570；原样 `verify-state-sync.mjs` | 10/10 PASS | all-files、overlay、immersive、dev-log、a11y 五组 on/off；回读真实系统与偏好。恢复appops default/a11y null，删除仅本轮新增而原缺席的三个prefs key，未清其他数据。 |
| F-04 通知故障矩阵与实际消费 | Android 35 AVD5558；最终 APK；原始通知文件/授权保存后故障注入 | 矩阵10/10、消费5/5 PASS | 前台持久化、force-stop恢复/补投、权限撤销保留/恢复补投、坏journal保留原文与offset、恢复有效journal重放、TTL301秒过期、同会话覆盖、容量8、分批3/3/2全部通过。实际5分钟heartbeat和去重/offset收敛通过。初测SELinux拒run-as硬链接、未授通知权限导致的前置失败保留；临时驱动用root仅建同inode链接并测试期授权，原脚本断言不变。finally精确还原原文件与原拒绝授权。证据 `.deploy-tmp/stage3-remaining/notify/` 与 `.deploy-tmp/notify-consumption/2026-10-09T22-52-09/results.json`。 |
| WebView、BrowserHost 与虚拟屏 viewer | MuMu + Android 35 AVD5570；原样对应 verify 脚本 | WebView39/39、BrowserHost及viewer PASS | MuMu WebView旧版无MULTI_PROFILE，返回browser-profile-unsupported（正确fail-closed，不算BrowserHost可用）；在支持profile的AVD原样BrowserHost脚本通过隔离、loopback拒绝、第三方桥不存在、CSS视口和桌面身份。初测错误文档chrome-error/viewport0，恢复真实前台页后复测通过。viewer自动呈现、close不销毁、reopen重新挂载、真实屏禁止选择、cleanup销毁通过。 |
| ADB 实际横竖屏操作 | MuMu PGBM10；900×1600、1600×900；真实input tap/keyevent与截图 | 两方向 PASS | 用ADB点击导航/设置，CDP验证真实设置页面，截图人眼复核控件无遮挡且按钮无文字溢出；测试驱动曾误选离屏按钮，已修驱动后复测，不改产品/断言。恢复原 accelerometer_rotation=1/user_rotation=0。证据 `.deploy-tmp/stage3-remaining/adb-ui-result.json`、`portrait.png`、`landscape.png`。 |
| GitHub Actions、真机与发布工作流 | GitHub / release / 真实 arm64 设备 | NOT RUN | Actions 未触发；没有远端 CI 通过证据。真机发布门禁未执行。未经授权不触发 Release 工作流。 |

### 阻塞与发布判断

API 37.1 Play Store AVD 的 `surfaceflinger` / 系统服务曾异常退出；该失败路径已由稳定 API 35 AVD 的升级与 clean-install 测试补充，不抹除历史异常。首次 MuMu `engine-died` 诊断由启动前镜像诊断入口产生；相关退出/拒绝/树损坏文件均无记录，logcat窗口被覆盖，证据不足以证明真正引擎崩溃或指认精确时序；后续快照完成、实际任务与冷启动成功。详见 `.deploy-tmp/stage3-remaining/boot-runtime-diagnostic.md`。

补充说明：AVD kernel protected_hardlinks=0 时 ownership 自愈正确拒绝且mutations=0，不是自愈成功；F-03 已在隔离 AVD 以可逆安全前置和真实 Binder 暂停完成快重试耗尽→五分钟慢复查恢复的动态验证，引擎层与用户层均 PASS（详见第 8 节）。真实 arm64 设备与实际 GitHub Actions 仍 NOT RUN，二者是发布前门禁，不能假称通过。当前继续本地测试，不以这些发布前事项停止可自主执行的工作。未执行任何 GitHub 远端写操作。

## 8. 第三阶段接续记录（2026-10-10）

### 当前候选和工作区

- 继续使用上面的候选：APK repo HEAD `acfac65dee19369e05f23643c39e06eca894345f`，协调仓 scratch HEAD `be3a63dd90fdb6e156ec38362d7b37c217eb6acb`。本次没有正式源码变更，未重建 APK；只更新本交接和 fx2 notes、`docs/AGENTS/build-and-env.md`。APK hashes仍为本节第7部分所列值。
- 未提交任何更改。状态复查的跟踪文件只有上述三个文档；既有未跟踪 `plugin-hard-manifest.json` 和多个 `node_modules` 保留，不纳入版本材料。不要做清理或 reset。
- 最新的横竖屏截图：`.deploy-tmp/stage3-remaining/portrait.png` / `landscape.png`；MiMo 最终答复与附件的 ADB 截图：`.deploy-tmp/stage3-remaining/cashflow-adb.png`。真正的 ADB 输入、orientation、设置页回读证据为 `adb-ui-result.json`；运行后已恢复原 `accelerometer_rotation=1` 与 `user_rotation=0`。
- 维护生成器、`check-code-map.mjs`、`git diff --check` 均通过。WebView MuMu 竖屏与横屏运行均 39/39；MuMu `verify-vdisplay-viewer`、`verify-vdisplay-float` 通过。另运行的 `verify-engine-log-copy.mjs` 只完成真源侧五项，工具脚本明确将剪贴板 UI 断言留给引导页检查，不把它声称为UI通过；该检查非本轮受影响功能的必需门禁。

### F-03 最终结论：PASS（引擎层判据 + 用户层判据）

判据分两层，**未削弱任何一项**：**引擎层**保留第 8 节原有的全部严格条件（同一应用 PID、无 Activity 重启、快速重试整个窗口内 3080 不监听、SIGCONT 后至少等满慢速定时才恢复、3080 重新 LISTEN、焦点留在系统 Settings）；**用户层**另立一条独立记录（用户回到前台后，Harness 页面在引擎源上带同源凭据请求得 HTTP 200）。分层的理由是下面的探针定性：后台 WebView 会挂起页面内 fetch，把「后台窗口内取到授权 HTTP 200」写进判据等于在测平台而不是测 F-03。

- 最终 PASS 运行在隔离 Android 35 x86_64 AVD `emulator-5558`，tag `avd5558-verify`。结果见 `.deploy-tmp/stage3-remaining/f03-runs/avd5558-verify/results.json`：`root-mode`、`root-shizuku-server`、`protected-hardlinks-armed`、`shizuku-user-service-bound`、`precondition-engine-serving`、`simulated-boot-trigger`、`quick-budget-to-slow-recheck`、`slow-autonomous-recovery`、`user-layer-page-available`、`test-environment-restored` 全 PASS。关键事实：六次快速退避耗尽后于 333s 观察到 `dsh-root: service startup remains deferred; ownership recheck in 300000ms`；整个快速重试窗口内 3080 不监听；SIGCONT 后 332s（≥245000ms）3080 重新 LISTEN；应用主 PID 7791 前后一致、无 Activity 重启；焦点仍为 `com.android.settings/.Settings`；用户回到前台后 `doc=http://127.0.0.1:3080/` 授权请求 HTTP 200。日志 `before.log` / `slow-installed.log` / `final.log`，还原 `environment-after.json`。
- MuMu PGBM10 交叉验证（`127.0.0.1:16512`，PGBM10 / Android 15 / SDK 35），tag `mumu-pgbm10-v2`：`root-mode`（adbroot）、`root-shizuku-server`、`protected-hardlinks-armed`、`shizuku-user-service-bound`、`precondition-engine-serving`、`simulated-boot-trigger`、`quick-budget-to-slow-recheck`（332s）、`user-layer-page-available`（HTTP 200）、`test-environment-restored` 均 PASS。严格判据只有**焦点项**偏离：恢复窗口内焦点是 `com.dsharnessmobile.shell/.MainActivity` 而非 Settings。归因证据：整个运行中 `ActivityTaskManager` 没有产品发起的 `START u0 ... MainActivity`；20:34:59 出现的是同一 task 37 的 `TO_FRONT`（`WindowManagerShell onActivityRestartAttempt ... wasVisible=false`），即 MuMu 系统把已存在的任务拉到前台；应用 PID 3143 全程未变、无 Activity 重建。故这是 MuMu 的任务前台化行为，不是产品或驱动发起的 relaunch；但它是原严格判据在该设备上的环境性偏差，因此 **MuMu 这一条不翻写为 PASS**，F-03 的全 PASS 结论以 AVD 那轮为准，MuMu 作为交叉佐证。
- 探针定性（本轮最重要的环境结论）：后台 WebView 会挂起页面内 `fetch`，表现为 CDP evaluate 永不返回或 `TypeError: Failed to fetch`。主机侧经 `adb forward` 直连 3080 可正常得到 401，token 换 cookie 后 303/后续路由 404（路由不存在，非鉴权失败），说明引擎 HTTP 层本身正常。
- 本轮另修两处**驱动自身**错误：注入页面表达式里的 `\n` 在单引号 JS 字符串中被写成真实换行，页面报 `SyntaxError: Invalid or unexpected token`；以及把上一轮残留在设备上的 `dsh-vdisplay` 误选为暂停目标，真 UserService 继续存活导致故障注入无效（表现为 `Engine unexpectedly running before releasing the ownership fault`）。两者都不是产品问题。
- 运行顺序结论：`protected_hardlinks=1` 必须在**首次启动之前**就位。为 0 时修复被应用侧以 `hardlink-protection-unavailable` 拒绝，不会派发特权 RPC，也就不会产生 F-03 依赖的 pending/unknown lease；若先以 0 启动、之后再置 1，首次启动会走满快速退避。
- 设备还原：`protected_hardlinks` 回到 0、临时 Shizuku manager 卸载、`POST_NOTIFICATIONS` 回到测试前 `false`、`accelerometer_rotation=1`/`user_rotation=0`、无遗留 `shizuku`/`vdisplay` 进程、lease 为 `<map />`。AVD 与 MuMu 两侧运行后都出现过残留 `dsh-vdisplay`，已显式终止并回读确认；驱动已加入启动前的残留清理与「恰好一个 uid 0 UserService」校验。
- Lease quarantine 事件（保留）：某轮 teardown 在修复进行中移除了特权通道，`dsh_root_execution_lease.xml` 留下 `dispatched=shizuku / operation=shizuku-ownership-repair`，引擎以 `service startup remains deferred; ownership recheck in 300000ms` 永久延迟。这是设计上的 fail-closed 隔离，不是产品缺陷，退出方式是设备重启（reboot 后 boot_id 改变、lease 自愈为 `<map />`）；详见 `.deploy-tmp/stage3-remaining/f03-lease-quarantine-incident.md`。驱动已改为在移除特权通道前先等 lease 结算。

### F-03 历史前置失败（保留，不得当成通过）

- 两次实际快复试验定位并修正了驱动错误。第一轮漏停 Android 上名为 `linker64` 的既有引擎进程，慢复查计时误从原有 3080 监听得出；HTTP还因没带同源 cookie 得 401。该轮 `driver-completion` 与恢复都不计通过。第二轮证明 `stopservice` 的返回是 status 255、stdout 为明确的 `Stopping service`、stderr 为 `Service stopped`，且服务记录处于短暂异步 Destroying；驱动现等待 EngineService 从活动和 Destroying 列表同时消失。
- 第三次 setup 因 Shizuku root server 重启后管理器未重新授予/绑定，`shizukuStatus` 回报 `granted=false`, `shizuku-denied`，在测试前置失败；脚本 finally 已恢复 protected_hardlinks=0、恢复原通知授权、移除临时 Shizuku manager并续跑暂停的 UserService。不要将这一轮算作产品缺陷或通过。
- 最近启动的第四轮已经记录：临时 root Shizuku server PID `4319`；显式 root BOOT_COMPLETED 广播；应用主 PID `4361` 保留在后台；真实 Shizuku UserService PID `4588` 被 SIGSTOP；通过 `/proc/<pid>/cmdline` 校验唯一应用管理的 `linker64` 引擎 PID `4495` 后终止，并等待 3080 listener 消失，然后才触发广播。它正在观察完整六次快速退避和 300000ms 慢速复查；当前 `results.json` 已有 root-server / simulated-boot 两条PASS，但 `quick-budget-to-slow-recheck` 和 `slow-autonomous-recovery` 尚未产生，**该轮当时为 IN PROGRESS，不能写 PASS**（其后由 `avd5558-verify` 轮完成，见前文“最终结论”；本条作为历史前置记录保留）。
- 当前驱动和日志：`.deploy-tmp/stage3-remaining/notify/f03-device.mjs`、`service-exact-recheck.log`、`service/results.json`、`service/before.log`、`service/slow-installed.log`、`service/final.log`、`service/service-stopped.txt`、`service/service-final.txt`。驱动以最终 APK repo 的临时脚本运行，包含 finally 恢复 kernel 值、临时 manager、POST_NOTIFICATIONS、暂停的进程和应用首页。下一个执行者先查看 `service/results.json` 与 `service-exact-recheck.log` 是否已结束，再检查最终状态；若脚本仍活跃，不要启动第二份同设备测试。
- 当前恢复终判要求：日志出现六次退避耗尽后的 `ownership recheck in 300000ms`；在暂停 Binder期间监听保持关闭；SIGCONT 后**至少等待慢速定时到期**才恢复；同应用进程 PID不变、Activity仍为系统 Settings、3080重新LISTEN，并在 Harness页面上下文用授权请求 `/api/android/privilege/status` 得 HTTP 200。HTTP 401是探测缺授权，不能判产品失败；任何窗口中仍在监听旧Engine时必须判这次注入无效。确认最终restore：protected_hardlinks=0、Shizuku manager卸载和DeepCode授权false、POST_NOTIFICATIONS保持测试前原值false、UserService不再paused、应用 Activity 可打开。

### 其余未决与交接操作

- Boot budget 五轮cold1/2超限保留，cold3/4/5连续通过，宿主内存时间相关证据不是严格单因果。三轮稳定结果支持无需无证据改插件启动顺序；下一位不要提高7200ms门槛或删掉历史FAIL。cold1/2/3/4/5日志和每轮真实正式门禁在 `.deploy-tmp/stage3-remaining/mumu-cold-*/`；分析及输入SHA在 `mumu-cold-1-analysis.md` 与 `mumu-cold-diagnosis-inputs.sha256`。
- 所有源码、最终双 ABI 快照/APK与被测设备安装包一致；本轮只改文档，因此既有构建无需因文档复跑。当前仍未运行arm64真机发布补充门禁、真实GitHub Actions；远端PR、Push、Tag、Release也未执行。
- 没有确认可自主修复且属于产品源码的问题。此前的唯一本地未闭环项（真实 F-03 慢复查动态恢复）已由 `avd5558-verify` 轮闭环为 PASS，历次前置失败与 boot-budget FAIL 均按原样保留。真实 arm64 设备门禁仍未执行，故仍**不能**宣称 FX2 无条件发布就绪。
- 交接前已清理 MuMu PGBM10 本轮新增的 Shizuku 安装和授权：管理器“授权的应用”中关闭 DeepCode，uiautomator 回读开关 `checked=false`；结束临时 UID2000 server 并卸载刚安装的 manager。回读无 `moe.shizuku.privileged.api` 包；原旋转设置恢复为 accelerometer_rotation=1 / user_rotation=0。MuMu PJJ110 未操作。

## 9. PR 与发布执行记录（2026-10-10）

### 已执行

- **分支推送**：`codex/0.14.5-fx-2-development`（apk 仓）与 `codex/0.14.5-fx-2-engineering`（协调仓）此前均只在本地、远端不存在（远端查询为 404）。两分支各领先 `origin/main` 4 个提交，且均与 `origin/main` 分叉，已先 merge `origin/main` 再推送。推送使用 Windows git（本机 WSL 侧 git-lfs 缺失；`base/*.tar.xz` 为 LFS 指针，远端 LFS 解析正常，指针与 `origin/main` 逐字节一致，未上传底座归档）。
- **PR 与合并**：apk 仓 PR #345（fix/docs）、协调仓 PR #97（fix/docs）均已合入 `main`。apk 仓 `main` 受 ruleset `protect`（要求 1 个 approve + code owner）保护，仓库所有者以 bypass 权限合并；协调仓直接合并。
- **Actions 一键链实跑**：由 `main` 触发 `release` workflow（run 38057063736），四个 job 全部成功——`snapshot (arm64)` 4m25s、`snapshot (x86_64)` 4m38s、`release` 24m17s、`publish`。产出 draft Release `v0.14.5-fx-2`（`targetCommitish=main`）。
- **Release 资产**（共 12 项）：双 ABI APK、双 ABI 注入后快照、三个子仓 tgz、三份 plugin-lock-resolution、`MANIFEST.txt`、`notes.md`。已下载双 ABI APK 并按 `MANIFEST.txt` 校验 SHA256 自洽。
- **签名与版本核对**：两个 ABI 的 Release APK 均由同一把固定发布密钥签名（证书 SHA-256 `1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd`，与 v0.14.5-fx-1 发布资产一致；DN 显示 `CN=Android Debug` 是该固定密钥的既有名义，非临时调试签名）。versionCode 49、versionName `0.14.5-fx-2`。
- **发布说明修正**（PR #346，已合并）：原 notes 写「尚未创建 Tag、PR 或 Release」「GitHub Actions 尚未运行」，并只给出一组「本地 APK」哈希，容易被误当作 Release 校验值。已改为：区分「开发期三层验收候选」与「Release 实际分发」两组 SHA256、据实写明 Actions 四 job 已成功、补记 PR 号。draft Release 的 body 与 `notes.md` 附件均已同步为修正版。

### 关键结论：CI 与本地候选字节不同，属设计行为而非缺陷

- Release 两个 ABI 的 APK 与开发期完成三层验收的本地候选**不是同一批字节**：arm64 本地 `5cc0d298…` vs Release `5e54183f…`；x86_64 本地 `fc7dbd19…` vs Release `3350213b…`。
- 已逐条目对比确认：APK 内除 `assets/snapshot.tar.xz` 外**其余 234 个条目逐一相同**。原因是 CI 一键链按设计**从源重建快照**：x86_64 快照条目表完全一致但字节不同；arm64 另叠加 `libsqlite3` 版本漂移（CI 为 `libsqlite3.54.0.so`，本地候选为 `libsqlite3.53.4.so`）。
- 根因：`scripts/snapshot-config/preinstall.json` 只列包名、**不锁版本**，Termux 包在构建期由镜像链解析，故跨时间/跨机构建不保证字节一致。这是既有设计，不是本轮引入。
- **已知边界（不得掩盖）**：开发期三层设备验收是在本地候选上完成的，**未在 Release 实际字节上重跑**。`dsh-mobile-apk/AGENTS.md` §2 明确「发布包不经本地：由 GitHub Action 一键链产出」，因此 Release 字节的权威性成立；但若要宣称 Release 字节本身已完成三层验收，须下载 Release APK 重装重验。

### 仍未执行

- 真实 arm64 真机补充门禁（V2425A）。
- Release 尚未转正式：按 `release.yml` 的刻意保守设计，只出 **draft** Release，转正式需人工核对后手动操作，本轮未转。

### 相关文档索引

- [第一阶段调查与实施计划](HANDOFF-0.14.5-FX-2-PLAN-2026-10-09.md)：F-01 至 F-06 最新复核、批准范围与工作包基线。
- [fx2 版本说明](../release/v0.14.5-fx-2/notes.md)：面向用户的本轮变更与验证说明。
- [构建与环境手册](AGENTS/build-and-env.md)：本地构建、门禁、设备和环境故障排查。
- [模拟器三层验收规范](AGENTS/emulator-test-protocol.md)：代码层、CDP 层及 ADB 用户体验层的验收契约。
- [执行地图](AGENTS/EXECUTION-MAP.md)：关键运行链、模块边界及症状排查入口。
- [持久化数据契约](AGENTS/PERSISTENT-DATA.md)：覆盖升级与模型配置、历史、工作区等用户数据的兼容边界。
- [系统架构](AGENTS/ARCHITECTURE.md)：模块职责与依赖方向。
- [已知陷阱](AGENTS/gotchas.md)：已复现的环境和实现注意事项。

本记录中 `.deploy-tmp/stage3-remaining/` 下的日志、截图和 JSON 是本地临时验收证据，不属于稳定文档入口；查阅 F-03 当前动态结果时，优先看 `f03-runs/avd5558-verify/results.json`（全 PASS）与 `f03-runs/mumu-pgbm10-v2/results.json`（交叉验证）；早期 `service/results.json` 与 `service-exact-recheck.log` 只作为历史前置失败记录。当前驱动为 `f03-final.mjs`，可用 `F03_SERIAL` / `F03_TAG` 指定目标设备；同一设备不要同时跑第二份测试。
