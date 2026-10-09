# build-and-env.md — 构建与验证命令 + 环境流程

## fx2 本地来源链

`node scripts/source-build/run-local-source-chain.mjs --list` / `--dry-run` 只读 committed HEAD 的 workflow；实际执行在原仓之外的独立浅检出。未提交源码不参与构建。用 `--build-workspace /tmp/dsh-build --from <阶段>` 指定可复核的续跑目录，必须属于同一 source/commit；输出留在该目录，不自动回写 base。隔离检出禁用 LFS smudge，sources 阶段负责重建 base，不能跳过缺失的实际输入。

三项目组件的来源证明改为本次 APK commit、原目录、包身份、逐文件 SHA-256 与真实输出 SHA-256；不再用独立 host 仓旧 pin 与当前 APK 副本硬比。目录、tgz 以及独立仓入口不变。完整外部消费者迁移仍待确认。

开发期按 AGENTS §2.2 选择测试，文档生成块用 `node scripts/check-maintenance-docs.mjs --write` 更新，再不带参数检查；该维护提示不替代功能门禁。最终完整验收与发布资格仍由双 ABI、设备三层及覆盖升级证据决定。

> grep 用法：`grep -n "门禁\|Fast\|abi" docs/AGENTS/build-and-env.md`。
>
> **当前 0.14.5 重构真值**：本轮目标、GitHub Issue 与用户反馈台账、构建/设备证据统一见[重构计划](../../../docs/REFACTOR-2026-10-05.md)。项目地图与更新协议见 `AGENTS.md`；本页只维护构建、验证和环境事实。

## 2. 构建与验证命令

```powershell
# 一键双 ABI（协调仓库根；快照→注入→门禁→gradle→out/）：
pwsh -File scripts\build-apk-013.ps1 -Suffix ""          # 产物 out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk
# dev 快速档（单 ABI 缺省 x86_64 + 注入 preset 1；产物仅 dev 装机，禁发布资产）：
pwsh -File scripts\build-apk-013.ps1 -Fast
# 快照（Termux 源 + TARGETS 预装（scripts/snapshot-config/preinstall.json）+ licenses + pnpm 装配 + 瘦身 + 按 `DSH_CPU_THREADS` 上限归档）：
node scripts\build-snapshot-013.mjs <arm64|x86_64>
# 插件单测/冒烟：
node scripts\smoke-bridge.mjs                             # bridge 冒烟（现 22 断言，grep -c assert 现数）
cd ..\dsh-client-ui-responsive && npm test && npm run build
cd ..\plugins\dsh-android-<pkg> && npm run build
```

> **多线程/并行优先铁律（2026-09-08 用户定例，改任何构建脚本都适用）**：编译、构建、打包、归档、解压**一律使用多线程脚本**，不得用单线程等价命令替代——目的就是省掉一切可以省掉的构建时间。现行落点：
> - 快照归档 `tar -c ... | xz -T8 -6`（默认 8 线程，由 `DSH_CPU_THREADS` 覆写）（多线程压缩；裸 `tar -cJf` 单线程 ≈380s vs 多线程 `xz` ≈48s，2c 实测）；
> - 快照/基座解压 `xz -dT8 | tar -x`（与构建线程上限一致）（多线程解压，替代 `tar -xJf` 的单线程解码）；
> - 注入链单 pass（`inject-all.py`，压缩次数 ×4→×1）+ dev 循环 `-Fast`（单 ABI + `DSH_INJECT_PRESET=1`）；
> - gradle `org.gradle.parallel=true` / `caching` / `configuration-cache`（`gradle.properties`）；
> - 门禁脚本能用流式并行就用（Python 侧 `tarfile` 单遍流式，勿反复解压同一归档）。
> 新增构建步骤若只能单线程，必须在脚本注释里写明原因（例：9p 写带宽是瓶颈，并行无收益）。

**门禁（build-apk-013.ps1 内）**：聚合入口 `scripts/check-release-gates.mjs`（`--list` 现数，不维护数量；接进本地链 / 云端 `build-apk.mjs` / 两仓 CI / 发布链 `build-release.ps1`，发布链 `--run --require` 要求 SKIP=0）。内容 = vendor 统一补丁（`scripts/patches/apply-patches.mjs`：活动 vendor 项由 registry.json 驱动，完整清单见 RUNTIME-PATCHES.md §6.1；market-A/C 已退役，undo S1/S2 在活动清单内，勿加 Select-First）→ 快照单 pass 注入（`inject-all.py`，补齐 + 修剪双向对齐）→ 注入产物完整性（`check-inject-completeness.mjs`）→ 挂载集（`check-patch-mounts.mjs`）→ 机密（`check-snapshot-secrets.mjs`）→ 第三方合规（`check-third-party.mjs`）→ 路由鉴权（`check-api-route-auth.mjs`）→ 工具 schema / 控制 op / 状态登记 / 桥对称 / 门禁 SKIP / 性能插桩 / Kotlin 注释 / 构建链中止 / strip no-op → 运行时资产（`check-runtime-assets.mjs`）→ 快照指纹（`check-snapshot-fingerprint.mjs`）→ elf-check → 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

**维护文档对账**：Gradle 版本/依赖与活动补丁清单由 `node scripts/check-maintenance-docs.mjs --write` 生成；改声明或 registry 后更新生成区并运行不带 `--write` 的检查。该检查属于维护一致性检查，可按输入路径在 PR 中显示结果，不作为 APK 功能与数据安全门禁的替代。

**Release 快照契约**：`.github/workflows/release.yml` 始终先构建本次运行的 arm64/x86_64 快照，release job 依赖 snapshot job 成功，再下载同一 run 的快照与 lock provenance。已移除无快照来源的 `skip_snapshot_rebuild` 调试输入；失败后可用 GitHub Actions 的重跑失败 job 复用同一 run 中保留的 artifact，artifact 过期则重新构建本次运行。不得用另一 commit 的快照填充发布输入。

**CI 插件复用**：APK `pr-gate.yml` 从 `scripts/plugin-dirs.json` 选择 termux 与 Android 插件，按顺序只准备一次已解析 lock、`npm ci` 和构建产物；协议、插件测试、output schema 和 wire 预算共用这些产物。`@deepseek-ai/dsh-tools` 是 manage 的固定 devDependency，不再额外解析安装。常规 `build-apk.yml` 与来源链也从清单按顺序选择带 build script 的包，各准备并构建一次；来源审计和常规 build 互斥，`abi` 输入决定常规矩阵。Release job 只准备依赖，`build-apk-013.ps1` 统一构建，后续 `npm pack` 复用同一批 `lib/`，不再次安装或构建。

**模型目录跨 job 交接**：快照 job 的生成 `lib/catalog-snapshot.json` 未跟随归档 artifact 上传，后续干净 checkout 不能依赖它。Release job 从实际输入 arm64 快照提取 pi-ai package metadata 与 `dist/providers/data`，运行 `gen-model-catalog.mjs` 后再注入。目录的 `engineRootHint` 使用快照内相对路径，避免将 runner 的本地绝对路径写进发布内容；本地正式构建仍由快照生成器生成同源目录。

**最终签名与资产身份**：上传前同一 `check-apk-signatures.mjs --keystore keystore/debug.keystore` 同时检查 v1/v2/v3 与固定证书身份；Windows 通过 SDK 的 `apksigner.jar` 传独立参数，避免 shell 解释 APK 路径。来源链保留构建前证书预检，最终 gate 再验证实际 APK；publish 下载并核对 MANIFEST 后提升原字节。真实 CI runner 验收状态以重构台账为准。

**冷启动预算读数**：`scripts/check-boot-budget.mjs --self-test` 是门禁自身的廉价回归；设备门禁 `--require-real` 必须消费安装包启动后采集的日志。C1 比较的是壳侧首次成功 HTTP 探测观测时刻与 TCP LISTEN 探测观测时刻，两者来自不同轮询（HTTP 启动轮询约 1s；TCP 探测每 500ms），差值包含探针采样量化和调度延迟；C1 超限不能单独归因于同步 compose，需与 C2 和 P1 phase 对读，4000ms 门槛仍按原值判定。event-loop 可能先输出 `loopP99Ms=-1 loopSamples=0`，再在 debounce 收口后输出最终采样；C4 必须从最后一条完整 `[perf] TOTAL` 成对读取两字段，不能把早期哨兵当最终结果。末条哨兵判 FAIL，末条有效样本则按样本数和预算判定。若补丁源改变，先从当前源码重建对应 ABI 快照，再构建/安装并重新采集日志；旧设备日志只能描述产生它的旧安装包，不能证明新快照行为。详见坑 251。

**C4 换尺（2026-10-06）**：C4 的 `loopP99Ms` 原先取自 `perf_hooks` 的 event-loop-delay monitor，而它对「与 `enable()` 同 tick 内开始的同步块」**结构性失明**（设备上一段 2.0s 启动阻塞被读成 11ms；本机 95/500/1500/2000ms 各档一律读成约 11ms）。现改为 P1 **自建、arming 时锚定墙钟基线**的采样器。⇒ **换尺后读数不可比**：旧值 37.0/61.6/77.1ms 与新值不是同一个量，本阈值已按新尺在 MuMu x86_64（16416）n=8 重标为 **3400ms**（实测 1468.4–2886.5ms）。该阈值是**回归哨兵**，不是性能目标：窗口的支配项是上游引擎激活全部 Loader entry（`loader-settle-wait` 1624–3249ms），本仓的 `constructor-flush` 仅 57–182ms、`compose` 单次最大 5–29ms。阈值取自模拟器，**真机 arm64 未测**，发布前须补同口径采样。

**本地发布链（`build-release.ps1`）的 gradle 调用必须与开发链同口径（0.14.2-fx-2 修）**：发布链原用**系统 gradle**
+ `--offline --rerun-tasks`，而开发链（`build-apk-013.ps1`）用项目 wrapper 且不带 `--offline` —— 系统 gradle 的依赖缓存里
没有本工程的 AndroidX 产物，离线档下 arm64-v8a/x86_64 组装**必失败**（`No cached version of androidx.webkit:webkit:1.12.1
available for offline mode`，22s 即 break），且该行把 gradle 输出重定向进 `$null`，日志里只剩一句 `APK build failed (…)`。
现统一走项目 wrapper。`build-release.ps1 -Version 0.14.5` 的参数是最终版本名，因此传给 Gradle 的 `versionNameSuffix` 为空；测试构建可显式用 `-VersionSuffix "-preview"`（最终目录/包名为 `0.14.5-preview`），或传完整标签 `-Version "0.14.5-preview"`。脚本基于 Gradle 中的 `0.14.5` 派生后缀，拒绝不匹配的完整版本，避免把 `0.14.5` 再拼到自身后面；派生逻辑由 `scripts/resolve-version-suffix.mjs` 与 Node 回归用例覆盖。Gradle调用示例：`.\gradlew.bat :app:assembleDebug --no-daemon "-PversionNameSuffix=$VersionSuffix"`。**改任何一条链的调用前先问：另一条链是不是这条命令**（详档见坑 194）。

**快照构建入口已收敛为单一链（0.14.5，删除已死的并行 workflow）**：apk 仓原有的 `.github/workflows/build-snapshot.yml`
已删除，连同只服务它的 `docs/ci-snapshot-build.md` 与 `scripts/upload-snapshot-input.mjs`。四路证据：
① 它的输入是 draft release tag `snapshot-input` 的资产，由 `upload-snapshot-input.mjs` 上传，而**全仓没有任何 workflow 调用该上传脚本**（输入源在 CI 里无人维护）；
② 它的触发 `push: branches: ['release/*']` 指向 v0.12.4/v0.12.5 时代的分支——`release.yml` 只建 draft Release，**此后不再创建 `release/*` 分支**，该触发已死；
③ 功能被 `build-apk.yml` 覆盖且后者更完整——它只走 `inject-snapshot.py` 的**三包注入**，不做引擎 overlay / 引擎补丁 / 语法降级（EXECUTION-MAP 曾自记「仍带坑 63 语义」）；
④ 它**绕过**共享终端组装引擎 `build-apk-engine.mjs`，直接调 Gradle `:app:assembleDebug`。
⇒ 属 §14「测试和 Release 使用不同构建逻辑」「重复而没有新增信息的过度防御」。现在快照构建只有两条活链：
`build-apk.yml`（自包含，源重建）与 `release.yml`（发布，Build Once → 同 artifact 提升）。
**将来若需要快照专用产物，走这两条，不要再新建第三条。**
**LFS 底座按需拉取**：`build-apk.yml` 与 `release.yml` 的快照 job 使用 `lfs: false`，缓存未命中时只拉当前 ABI 的 `base-usr` 和共用 `base-dsh`；缓存键取当前 pointer 文件哈希。Release 的 APK job 消费上游 job 的 snapshot artifact，不拉底座。`require-lfs-materialized.mjs` 拒绝用 pointer 文本冒充归档。
旧版文档把 `lfs: true` 说成 `git lfs fetch --all` 并据历史对象估算下载量，此结论已于 2026-10-07 撤回：checkout v4 实际执行 `git lfs fetch origin <ref>`，普通 Git 的 `fetch-depth: 0` 不证明历史 LFS 全量下载。依据：[官方 command manager](https://github.com/actions/checkout/blob/v4/src/git-command-manager.ts#L352-L357)、[官方调用点](https://github.com/actions/checkout/blob/v4/src/git-source-provider.ts#L186-L193)。当前优化减少无用 ABI 与重复 job 的下载；实际流量收益应以 runner 日志核实。
**云端构建（0.13.0 起，宿主=本仓库，自包含）**：`.github/workflows/build-apk.yml`（`workflow_dispatch` 手动，matrix arm64/x86_64）托管整套构建链并只操作本仓库——快照从源重建（`base/` 底座归档为输入，Git LFS）、按统一清单准备并构建插件、注入/门禁/gradle 全部云端完成，仅 `upload-artifact` 供本地下载 debug，不出 Release；**不依赖协调库**（私库，GITHUB_TOKEN 无法签出）。`build-apk.mjs` 以 `DSH_APK_DIR=$GITHUB_WORKSPACE` 指向本仓库（gradle 在此）。本地仍在协调库根跑 `pwsh scripts\build-apk-013.ps1`（`scripts/` 前缀）。

**CI 权限与正式发布**：构建/PR workflow 的 `GITHUB_TOKEN` 明确只读，checkout 禁止持久化凭据；`release.yml` 的快照构建、APK 构建、测试和签名核验均在只读 job 完成并上传 `release-v<version>` artifact。独立 `publish` job 只下载同一 artifact 并创建 draft Release / 上传资产，写权限仅授予该 job。发布阶段不重新构建或重签资产。PR 与来源构建 workflow 的源码 Node 测试使用 `node --test scripts/source-build/*.test.mjs`，新增测试自动进入该测试集。

**APK 三方案签名核验**：最终 APK 必须通过 `scripts/check-apk-signatures.mjs`，并断言 JAR/v1、APK v2、APK v3 均为 true。核验命令显式传 `apksigner verify --min-sdk-version 18`：APK 的 `minSdk=26`，而默认核验会按 26 判断老系统兼容性，可能把只供旧系统使用的 v1 SHA-256 签名报告为 false；API 18 起支持此 v1 摘要算法。此参数只选择核验兼容性下限，不改 APK 内容或签名。仍要求 apksigner 返回码为 0，并保留原始输出、scheme 判定与退出码。

**APK 根目录传递约定**：云端 workflow 与本地来源链都显式传 `DSH_APK_DIR`；`check-runtime-assets.mjs` 必须优先使用该绝对根目录，不能仅凭 `ROOT/dsh-mobile-apk` 猜测协调仓布局。`--require` 仍严格要求该根下 `app/src/main/assets/patched`、快照和 registry 在场；缺件不得 SKIP 或自动生成。 `build-apk-013.ps1` 同样保留前置布局自检测得到的 `$apkDir`，不得在版本解析后重新硬编码 `Root\dsh-mobile-apk`。 发布链临时文件也不得假设 `$env:TEMP` 在所有 PowerShell runner 上存在；跨平台脚本使用 `[IO.Path]::GetTempPath()`。

**来源审计构建（ARM64）**：固定官方Harness 639ed015397290b3745d163aafe02ffee4aa3f84 / 0.2.0-rc.2，workflow检查packageManager pnpm11.7.0及Node范围 ^22.19.0 || >=24.0.0（来源runner使用Node24）。不启用LFS、不读旧base快照；第一方产物由固定源码构建并记录manifest/commit/hash。Electron桌面bundle不属于Android CLI部署闭包，构建脚本临时排除并留provenance；Cordis依赖按本次官方源码，不回退旧版源码伪装新pin。Termux bootstrap固定SHA认证、官方InRelease验签与逐deb哈希仍执行；node-pty源码/NDK与上游原生二进制输入分别披露，不声称全部本地编译。固定debug签名与apksigner自证沿用，真实APK/hash/provenance待构建后记录；source后缀与artifact名不代表另一签名。

**同工作区复跑**：两处源码 clone 可复用，但固定 commit 的 fetch/detach/assert 仍执行；bootstrap 与 NDK 只在固定哈希命中时复用，损坏/半包重下，解包前校验不省略。Harness 阶段从本次 `GITHUB_SHA` 恢复权威 overlay，先复位专用源码 checkout（保留 ignored 依赖），deploy 只清理验证过的专用目标。`source-chain-rerun.test.mjs` 使用本 workflow 的实际守卫和本地假输入覆盖 cache-hit/miss、下载中断、坏字节拒绝解包、依赖保留与清理边界；CI 与本地预检均调用。来源链两次完整运行的证据不得由局部守卫测试代替。

**派发前必须本地预检**：`node scripts/source-build/preflight-source-chain.mjs`。远程 `build-apk-source` 一次 60-90 分钟，而近期判红的几类问题（市场补丁锚点失配、期望补丁集过期、与上游脱钩）**都能在本地提前复现**。预检覆盖五面：① 是否落后 `upstream/main`（合并会换掉链的输入，坑 204/204 都出在合并之后）② 登记表补丁对仓库镜像自洽（`apply-patches --check`）③ 市场插件链按 workflow 里钉的 URL+sha256 取发布产物、解包、打补丁，再与 `vendor/dshmarketplace-plugin/` 逐字节比对 ④ 来源链单测 ⑤ `check-code-map`。版本与哈希都从 workflow 读，不在脚本里重复钉。`--no-network` 可跳过取件与 `git fetch`（此时发布产物必须已在 `.deploy-tmp/component-sources/` 缓存里）。

来源流程的 marketplace 用**固定 npm 发布产物**：`curl` 拉 `dshmarketplace-plugin-0.1.7.tgz` → `sha256sum --check` 对照钉在 workflow 里的哈希 → 解包进 `vendor/dshmarketplace-plugin`（**不再从其 `src/` 重建**，也不参与插件源码构建循环）。理由：仓库镜像与全部 market-* 补丁都按发布字节定义（`vendor/dshmarketplace-plugin/PATCHES.md`），重建会用不同工具链产出不同字节并把补丁锚空（0.1.5 时代就是这样，见坑 205；此前靠适配器里一段源码构建专用改写兜着，已随 0.1.7 退役）。随后运行 `node scripts/source-build/apply-source-marketplace-patches.mjs vendor --apply`：这一步**不修改共享补丁器**，适配器只把生成副本的 `HERE` 指回 `scripts/patches`，然后按原参数执行；共享 runner、生成 runner、registry、适配器自身及补丁后产物的哈希写入 `marketplace-patch-adapter.json`。锚点整体失配不需要适配器兜底——共享执行器对「check 为假且 apply 零改动」本就判红并拒报 ALL OK。已登记的移动端补丁（包括 `/api/dshmarketplace/*` 鉴权）先施加到解包产物，随后 API 路由门禁才能检查最终注入文件。artifact 的 `marketplace-source-provenance.json` 记录发布 tarball URL 与哈希、包版本、补丁 registry/实现哈希及补丁后 lib 哈希。

Harness按固定0.2.0-rc.2源码完成全仓构建；prepare-harness-vendor-overrides保留来源登记接口但不再把五个旧Cordis源码覆盖新官方目标。reconcile-harness-vendor-lock只接受目标pin约束，不以旧importer规则掩盖依赖漂移；来源报告必须记录实际版本/lock。工作区链接仍禁止递归copytree跟随复制。

来源构建还会从本仓九个带 `package-lock.json` 的插件/组件目录执行 `npm ci`。`check-package-lock-roots.mjs` 在 PR 与来源构建的早期步骤核对各目录 `package.json` 与锁文件根声明中的名称、版本及四类依赖，发现镜像后的旧声明就立即报错，避免完成 Harness 和 Termux 构建后才在插件安装阶段失败（坑 196）。锁文件更新后还应对受影响目录运行 `npm ci --dry-run --ignore-scripts --no-audit --no-fund`，因为根声明一致不能证明整份依赖图有效。

`check-android-native-runtime-packages.mjs` 对部署树中的 `.node` / `.node.wasm` 逐文件计数、取哈希，并只接受已审计包族。固定 Harness 当前依赖图还带入 trycua、ubjs、sherpa-onnx 与 node-addon-require-builtin 的 Linux GNU 原生文件；它们作为跨平台部署的外平台 payload 记录，不视为 Android 绑定。新增版本、不同架构路径或未知包族继续拒绝；匹配用例在 PR 与来源构建入口运行（坑 197）。

快照构建器沿用boot-pending标签调用当前dsh-app-boot的auditStartupEntries回归，required pending/failed致命、optional第三方告警；该构建内置检查不是本轮外部验收。当前验收证据见协调仓重构台账；该内置检查不替代设备三层验收。

`check-dsh-source-snapshot.mjs` 的内置预设载体断言与权威门禁 `check-engine-overlay.mjs` 的 CARRIERS 同源，清单在 `scripts/source-build/preset-carriers.mjs`：载体是 `agent-preset/skills/` 与 `web-app/presets/`（0.1.7 把 `dsh-agent-presets` 拆成 agent-preset + agent-preset-registry 后的新形态），判据是目录在场且递归文件数 ≥ 1。`preset-carriers.test.mjs` 读权威源文本双向比对两侧载体集合——权威源重锚而本侧没跟上的话，判红落在秒级的 PR 门禁上，而不是四十分钟后的云端构建（坑 200）。

来源链在构建期会把 `@deepseek-ai/*` 从 `scripts/snapshot-config/engine-overlay.json` 摘除（否则快照构建器会按登记表回拉上游发布版 tarball，整目录覆盖已注入的源码产物），摘除清单记进 `source-build-policy.json`；APK 步骤先由 `scripts/source-build/restore-overlay-pins.mjs` 把这份清单并回去，再跑门禁集——`check-contract.mjs` 第 7 节正是按它定运行时版本、并判 profile 里引擎包 insert 行是否与运行时同版（该门禁在拿不到 semver 时 SKIP，旧链因此从未真判过）。还原记录进策略 provenance，退出 trap 覆盖回原文件（坑 201）。

**设备验证链路**（真机 arm64 vivo V2425A；模拟器 MuMu x86_64 竖屏 `127.0.0.1:16416`、横屏 `127.0.0.1:16384`——横屏实例勿改回竖屏）：
- 安装：`adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore；**指纹变更触发 refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器实测 ~8 分钟，勿在解压中杀进程——中途杀进程看门狗会拿半解压运行时拉引擎，见坑 37）**）。
- 引擎探活：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`。
- WebView 调试：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `forward tcp:29225 localabstract:webview_devtools_remote_<pid>`（**每次重启 pid 变**）→ CDP ws 连接后 Runtime.evaluate 驱动（例子脚本见 `.deploy-tmp/cdp-*.mjs`；断言注意 input placeholder 不在 innerText 里）。
- 远程 RPC（测试面）：POST `/api/<method>`，body 必须全信封 `{"type":"client-request","rpcId":"r1","method":"session.list","payload":{}}`；`session.prompt` 拒绝 live 会话（被 UI 打开的）——直接 API 测代理需先用 session.create 建全新会话。
- **构建前核对 ABI（见坑 18）**：无真机环境用模拟器（MuMu x86_64 竖屏 `127.0.0.1:16416` / 横屏 `127.0.0.1:16384`），有真机则安装 ABI 匹配的 APK——debug 包默认带 x86_64 快照，覆盖装到 arm64 真机会引擎崩溃。

## 3. 环境无关的开发/维护流程（新人先读此节再动手）

> 本节与协调仓库根 `AGENTS.md` §2-4 对齐，但以壳子仓库为落点；**下列命令均在协调仓库根执行（除非注明「壳内」）**，shell 引用路径用 `scripts/` 前缀。

### 3.1 环境矩阵（先对号入座）

| 组合 | 快照构建（node scripts\build-snapshot-013.mjs） | 打包/门禁（pwsh scripts\build-apk-013.ps1） | 设备验证 |
|---|---|---|---|
| Windows + WSL | **必须在 WSL 跑**（Termux 源/依赖闭包需 Linux；见 3.4） | PowerShell 直跑 | ADB 真机 或 MuMu |
| Windows 无 WSL | **不可本地构建快照**（跳过 3.2 步 2，用已发布快照/CI 产物） | 可 | MuMu（debug 包默认 x86_64 快照可用） |
| Linux / macOS | 直接跑（无 WSL 层，路径用 `/`） | 直接跑 | ADB 真机（arm64 需匹配快照） |
| 无真机 | — | — | MuMu x86_64 竖屏 `127.0.0.1:16416` / 横屏 `127.0.0.1:16384`（装 x86_64 包） |
| 有真机 arm64 | — | — | vivo V2425A（**必须装 arm64 快照包**，坑 18） |

### 3.2 新环境起步流程（克隆 → 首包 → 装机验证）

1. **取代码**：clone 协调仓库（主分支 `main`）；壳子仓库 `dsh-mobile-apk/` 是**独立 git**（主分支亦 `main`），按需 clone/关联；上游 `dsh/` 只读。
2. **构建快照**（仅 Windows 需 WSL）：`node scripts\build-snapshot-013.mjs <arm64|x86_64>`——Termux 源装配 + TARGETS 预装 + pnpm + 权威 cordis patch 覆盖 + 瘦身 + 归档（产物 snapshot.tar.xz + snapshot.sha256）。
3. **一键打包**：`pwsh -File scripts\build-apk-013.ps1 -Suffix ""` → `out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk`；门禁失败会中断并提示（清单见第 2 节）。
4. **ABI 核对（坑 18）**：`aapt dump badging <apk>` 看 native-code，或解快照 tar 读 `usr/bin/node` 的 ELF e_machine（**62=x86_64，183=arm64**）——与目标设备一致再装。
5. **装机**：真机 `adb -s <serial> install -r -t out\v<版本>\...apk`（同签名 debug.keystore，坑 10）；模拟器 `adb -s 127.0.0.1:16416 install -r -t ...-x86_64.apk`。**首装/指纹变 → refreshSnapshot 全量重解压（真机 ≈2-4 分钟、模拟器 ~8 分钟），勿杀进程（坑 37）**。
6. **验证**：`adb -s <serial> forward tcp:23080 tcp:3080` → `http://127.0.0.1:23080/`；WebView CDP 与 RPC 信封写法见第 2 节。
7. **插件依赖（门禁真检的前提，2026-09-22 补）**：聚合门禁会**真加载**插件构建产物（`check-tool-output-schema` 动态 import 每个插件入口、`check-protocol-v2` 跑 manage 的 lib 产物），故这些目录本机必须有 `node_modules`：
   - `plugins/dsh-android-*/`（`manage` 的 `@deepseek-ai/dsh-tools` 同时是引擎校验器来源，缺席时该门禁整体 SKIP）；
   - `dsh-shell-termux/`（`plugins/dsh-android-linux-env/lib/index.js` → `@dsh-android/dsh-shell-termux` → 四个 peer 依赖 `@deepseek-ai/dsh-bash-local` / `dsh-shell` / `dsh-subprocess` / `dsh-sandbox`，具体版本以本包 `package.json` 为准。**这一个目录没装，聚合链会在第 6 条门禁处中止，后面 20 多条一条都不跑**）。
   装法（registry 已配 `registry.npmmirror.com`，各目录 `npm install` 即可）：

   ```powershell
   # 协调仓根与 dsh-mobile-apk/ 两棵树各自独立，都要装
   Get-ChildItem plugins -Directory | ForEach-Object { Push-Location $_.FullName; npm install; Pop-Location }
   Push-Location dsh-shell-termux; npm install; Pop-Location
   ```

   未装时的行为是**如实 SKIP 并计数**（`SKIP(#n) 宿主缺 peer 依赖：…`），`--require`（本地链/发布链）下判红——不允许用 SKIP 冒充绿。

### 3.3 改动流程规范（改哪个仓库、改完必做三件事）

| 改动面 | 落点 | 约束 |
|---|---|---|
| 壳层（桥/服务/看门狗/快照/权限） | 壳内 `app/src/main/java/com/dsharnessmobile/shell/` | 提交在壳子仓库独立 git |
| 快照内容 / assets | 壳内 `app/src/main/assets/` | `snapshot.tar.xz` + `snapshot.sha256` **必须成对换**（坑 18） |
| 构建链 / 门禁 | 协调根 `scripts/` | 改后跑完整门禁；命令变更须同步本文档 |
| 安卓能力插件 | 协调根 `plugins/dsh-android-*` | `npm run build` 通过；重装配须「权威 patch 覆盖 + 冷启动」（坑 19） |
| UI 注入层 | 协调根 `dsh-client-ui-responsive/` | `npm test && npm run build` |
| 执行器 / 页面兼容 | `dsh-shell-termux/`、`dsh-host-web-compat/` | 装配进快照 |
| 上游引擎 | 协调根 `dsh/` | **禁改**（只读参考）；一律以补丁/插件/壳侧适配（vendor/ + PATCHES.md） |

**每次改动关闭前必做三件事**：
1. **文档同步**：本文件描述失真处当场更新 + 文末「更新记录表」登记（时间/版本/内容/更新者）。
2. **GPL 合规**：新增依赖登记 `scripts/third-party-licenses.json` + `THIRD_PARTY_NOTICES.md`（80 组件矩阵）；copyleft 全文三形态在场（快照 `usr/share/LICENSES/`、仓库 `LICENSES/`、APK `assets/licenses/`）；`check-third-party.mjs` 不过即拒打包（第 7 节）。
3. **PR 规范**（pr-guidelines）：标题 `<type>: <描述>`（`fix:`/`feat:`/`docs:`/`chore:` 等，type 与主标签一致）；每个 PR 1-3 个标签；破坏性变更 type 后加 `!`。
- **禁用 emoji**：提交信息、PR 标题/描述、文档一律不使用 emoji（以文字描述代替，如「机密」而非锁形 Emoji）。存量文档中的 emoji 随触碰逐步清除。

### 3.4 环境差异点速查（踩坑对照）

| 差异点 | 现象 / 规则 | 出处 |
|---|---|---|
| WSL（Windows 特有） | 快照构建必须在 WSL（tar 解压/符号链接/relocate 需 Linux 语义）；Windows 直读 WSL 9p 文件 = EACCES，校验走 `wsl tar -tvf` 视图；wsl.exe 输出前有 localhost 代理噪音行，解析时过滤 | 坑 6 |
| ADB 真机特有步骤 | 同签名 debug.keystore 才能覆盖安装；配对走真实 `adb pair`、码值只进 argv（第 4 节 AdbState.kt）；CDP 每次重启 pid 变 | 坑 10/14、第 2/4 节 |
| run-as 限制 | run-as 裸环境无 termux-exec 钩子 → `not executable: 64-bit ELF` / `CANNOT LINK` 是**假错误**；验证快照内二进制须带全套引擎 env（`LD_PRELOAD` + `TERMUX_EXEC__*` + `LD_LIBRARY_PATH` + `OPENSSL_CONF`） | 坑 22 |
| PowerShell 转义 | 双引号内 `$var` 本地展开（引号地狱）；二进制经 `adb exec-out`/push 传输 | 坑 8 |
| ABI 匹配 | debug 包默认 x86_64 快照，装 arm64 真机必崩；构建/安装前核对（3.2 步 4） | 坑 18 |
| 工作树行尾噪声 | `git status` 的 ` M` 与 `check-patch-mirror` 的「仅行尾差异」WARN 常来自 autocrlf（一侧检出为 CRLF），**不是**内容漂移。先逐字节复核（`cmp a b` / `git diff --ignore-cr-at-eol`）再决定要不要动文件，别按噪声改内容 | 铁律 5/6 |

## 更新记录表

| 日期 | 版本 | 内容 | 更新者 |
|---|---|---|---|
| 2026-10-05 | 0.14.5 | 标明当前重构真值入口和 APK 版本码；记录三签门禁与 release 版本后缀解析规则。 | Codex |
| 2026-10-05 | 0.14.5 | 补充冷启动预算日志的来源要求与 `loopP99Ms=-1` 哨兵判定；详见坑 251。 | Codex |


### engine 补丁变更后的快照重建（2026-10-06）

`build-apk.mjs --snapshot <tar>` 复用输入快照，后续插件注入不重新应用 engine 补丁。修改 engine 补丁后必须先运行 `build-snapshot-013.mjs <abi>`，再构建 APK。`check-perf-instrumentation.mjs --require --snapshot <tar> --abi <abi>` 现在读取归档实际 P1 模块并拒绝缺 phase 的旧版本。版本号、文件时间及 APK/设备快照指纹一致只能证明所用产物一致，不能证明它包含当前补丁。装机后仍需核对实际 phase 日志并重新执行真实冷启动门禁。

## Android SDK 许可资产

`third-party-licenses.json` 除 dpkg 矩阵还登记 Shizuku api/provider/aidl/shared 13.1.5（官方固定版本 POM 的 MIT 许可）。`check-third-party.mjs` 校验实际 Gradle 版本与固定 MIT 文本 SHA256；本地和 portable 构建门禁从实际快照生成 notices，再将 `LICENSES/*.txt` 和 notices 复制到 `assets/licenses/`。缺文本、改文本、未登记版本或无法核实依赖必须拒打包；PR 与本地入口跑 `check-third-party.test.mjs`。最终包另需检查两个 ABI 的实际 assets，源码门禁不替代它。
