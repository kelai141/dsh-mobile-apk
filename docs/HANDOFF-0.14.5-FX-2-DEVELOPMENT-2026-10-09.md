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
| WP-3 / F-03 | EngineService 快速预算耗尽后五分钟慢复查；Future 安装同步、epoch 退役取消与迟到回调护栏，保留既有 ownership/端口失败分类。 | 已集成；生命周期单测通过 |
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
