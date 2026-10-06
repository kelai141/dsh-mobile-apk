# build-and-env.md — 构建与验证命令 + 环境流程

> grep 用法：`grep -n "门禁\|Fast\|abi" docs/AGENTS/build-and-env.md`。

# AGENTS.md — dsh-mobile-apk 开发地图

> **AI 主动更新条款（必须最先执行）**：本文件面向人类与 AI 开发助手，是唯一权威的仓库开发地图。**任何代码变更导致本文件描述失真（文件作用、函数签名、桥协议、构建命令、关键实现落点）时，AI 必须在本轮同步更新本文件，并在文末「更新记录表」登记（时间 + 版本号）。** 变更未触及本文件描述范围时无需更新（避免无意义改写）。若发现本文件与源码不一致，以源码为准并当场修正本文件——不要忽略。
>
> **过期风险声明**：代码演进可能快于文档更新，本文件内容可能过时；一切以源码为准。

---

## 1. 仓库概览与技术栈

- **角色**：DeepSeek Harness 安卓壳应用（包名 `com.dsharnessmobile.shell`）。
- **职责边界**：只保留安卓平台权能与桥——前台服务、看门狗、WebView（主 + 隔离 BrowserHost）、SAF 桥、快照解压与更新、崩溃回退闸门（UndoGate）、Shizuku 特权 transport 与虚拟屏、无障碍/ADB 授权原生写面、通知中心与通知内应答、返回网关、审计、内置控制台、日志。**AI 可见能力全部来自插件**。
- **运行时形态**：内嵌Termux快照；0.14.3源码目标为官方预发布0.2.0-rc.2 / 639ed015397290b3745d163aafe02ffee4aa3f84，监听127.0.0.1:3080；尚无本轮双ABI快照/APK证明。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **依赖**：androidx.activity-ktx / core-ktx、dynamicanimation、commons-compress、xz；Shizuku `dev.rikka.shizuku:api/provider 13.1.5`（直连 transport）。
- **兄弟仓库**（协调仓库下的子目录）：`dsh-shell-termux`（0.2.0，Termux 执行器 + 工具链单一表）、`dsh-client-ui-responsive`（0.3.3，移动 UI 注入层 + 来件消费端）、`dsh-host-web-compat`（0.1.13，页面注入/兼容）、`plugins/`（bridge 0.2.4 / manage 0.3.0 / model-capability 0.2.1 / file-open 0.1.0 / browser 0.1.0 / linux-env 0.1.2 / vdisplay 0.1.0，协调仓库内）、`vendor/`（dshmarketplace-plugin、dsh-undo-savepoint 固化副本 + PATCHES.md）。
- **上游** `deepseek-ai/deepseek-harness`（本地 checkout `dsh/`）：只读参考，**零改动**；一切适配以补丁层/插件/壳侧实现。
- **版本状态**：当前 main 的 Gradle/BuildConfig 声明为 0.14.4 / VC46；用户设备报告经 VC55 回退。设备专用升级 APK 需从签名重封装链 bump manifest 到 VC56、回退包 VC57+；均未构建/验收。
- **环境无关声明**：本文档适用于任意环境（Windows/WSL/Linux/macOS、有/无真机）开发维护者；环境差异点（WSL、ADB 真机、run-as）已在对应章节标注。

## 0.14.3 当前分工与构建钩子交接

- 本source/doc任务只读源码和改文档，不执行tests/build/typecheck/checks/device/Git变更。父任务停止点必须包含#308正常CI/review合并、完整0.14.3同步、双ABI tester APK交付；外部代码/CDP/ADB测试另行执行，不因待外测暂停合并或提前停止，也不写测试通过。发布未授权。
- registry/apply-patches已接PTC A1与官方pi streaming020；A1覆盖host/child，streaming覆盖六provider并在G2之前执行；source-build reconcile与最终快照检查已读additionalTargets及exact verifier。普通build-snapshot的post-apply已改为统一runner --check --scope engine，覆盖companion targets与exact verifier；streaming描述marker不再被错误当产物literal文本。具体台账见 [运行时补丁](<dsh-mobile-apk/docs/AGENTS/RUNTIME-PATCHES.md>)。
- 目标0.2的三条runtime assets必须从目标原始产物/同源补丁重出并最终逐字节对账。历史字节数不是0.14.3测量；不要为文档填造新尺寸/hash。组件lib重建/自包含镜像、root与后续集成PR拆分、版本/changelog/notes及最终构建证据由父任务负责。
- 构建脚本内置门禁按原安全严格度执行，不人为关闭；其结果单列“构建内置检查”，不代替外部完整验收。完整来源链同工作区双跑、真实UID0/boot lease反证、三层设备与arm64发布前补充由外测按 [测试需求](<docs/0.14.3-TEST-REQUIREMENTS.md>) 留证。

## 2. 构建与验证命令

```powershell
# 一键双 ABI（协调仓库根；快照→注入→门禁→gradle→out/）：
pwsh -File scripts\build-apk-013.ps1 -Suffix ""          # 产物 out\v<版本>\dsh-mobile-apk-v<ver>-<abi>.apk
# dev 快速档（单 ABI 缺省 x86_64 + 注入 preset 1；产物仅 dev 装机，禁发布资产）：
pwsh -File scripts\build-apk-013.ps1 -Fast
# 快照（Termux 源 + TARGETS 预装（scripts/snapshot-config/preinstall.json）+ licenses + pnpm 装配 + 瘦身 + xz -T0 归档）：
node scripts\build-snapshot-013.mjs <arm64|x86_64>
# 插件单测/冒烟：
node scripts\smoke-bridge.mjs                             # bridge 冒烟（现 22 断言，grep -c assert 现数）
cd ..\dsh-client-ui-responsive && npm test && npm run build
cd ..\plugins\dsh-android-<pkg> && npm run build
```

> **多线程/并行优先铁律（2026-09-08 用户定例，改任何构建脚本都适用）**：编译、构建、打包、归档、解压**一律使用多线程脚本**，不得用单线程等价命令替代——目的就是省掉一切可以省掉的构建时间。现行落点：
> - 快照归档 `tar -c ... | xz -T0 -6`（多线程压缩；裸 `tar -cJf` 单线程 ≈380s vs `xz -T0` ≈48s，2c 实测）；
> - 快照/基座解压 `xz -dT0 | tar -x`（多线程解压，替代 `tar -xJf` 的单线程解码）；
> - 注入链单 pass（`inject-all.py`，压缩次数 ×4→×1）+ dev 循环 `-Fast`（单 ABI + `DSH_INJECT_PRESET=1`）；
> - gradle `org.gradle.parallel=true` / `caching` / `configuration-cache`（`gradle.properties`）；
> - 门禁脚本能用流式并行就用（Python 侧 `tarfile` 单遍流式，勿反复解压同一归档）。
> 新增构建步骤若只能单线程，必须在脚本注释里写明原因（例：9p 写带宽是瓶颈，并行无收益）。

**门禁（build-apk-013.ps1 内）**：聚合入口 `scripts/check-release-gates.mjs`（`--list` 现数，不维护数量；接进本地链 / 云端 `build-apk.mjs` / 两仓 CI / 发布链 `build-release.ps1`，发布链 `--run --require` 要求 SKIP=0）。内容 = vendor 统一补丁（`scripts/patches/apply-patches.mjs`：marketplace A-D/U2 + undo E1-E8/U1，registry.json 驱动，勿加 Select-First）→ 快照单 pass 注入（`inject-all.py`，补齐 + 修剪双向对齐）→ 注入产物完整性（`check-inject-completeness.mjs`）→ 挂载集（`check-patch-mounts.mjs`）→ 机密（`check-snapshot-secrets.mjs`）→ 第三方合规（`check-third-party.mjs`）→ 路由鉴权（`check-api-route-auth.mjs`）→ 工具 schema / 控制 op / 状态登记 / 桥对称 / 门禁 SKIP / 性能插桩 / Kotlin 注释 / 构建链中止 / strip no-op → 运行时资产（`check-runtime-assets.mjs`）→ 快照指纹（`check-snapshot-fingerprint.mjs`）→ elf-check → 许可资产拷贝（LICENSES → assets/licenses）→ gradle。

**本地发布链（`build-release.ps1`）的 gradle 调用必须与开发链同口径（0.14.2-fx-2 修）**：发布链原用**系统 gradle**
+ `--offline --rerun-tasks`，而开发链（`build-apk-013.ps1`）用项目 wrapper 且不带 `--offline` —— 系统 gradle 的依赖缓存里
没有本工程的 AndroidX 产物，离线档下 arm64-v8a/x86_64 组装**必失败**（`No cached version of androidx.webkit:webkit:1.12.1
available for offline mode`，22s 即 break），且该行把 gradle 输出重定向进 `$null`，日志里只剩一句 `APK build failed (…)`。
现统一为 `.\gradlew.bat :app:assembleDebug --no-daemon -PversionNameSuffix="$Version"`。**改任何一条链的调用前先问：另一条链是不是这条命令**（详档见坑 194）。

**云端构建（0.13.0 起，宿主=本仓库，自包含）**：`.github/workflows/build-apk.yml`（`workflow_dispatch` 手动，matrix arm64/x86_64）托管整套构建链并只操作本仓库——快照从源重建（`base/` 底座归档为输入，Git LFS）、6 个缺 lib/ 的插件 npm 构建、注入/门禁/gradle 全部云端完成，仅 `upload-artifact` 供本地下载 debug，不出 Release；**不依赖协调库**（私库，GITHUB_TOKEN 无法签出）。`build-apk.mjs` 以 `DSH_APK_DIR=$GITHUB_WORKSPACE` 指向本仓库（gradle 在此）。本地仍在协调库根跑 `pwsh scripts\build-apk-013.ps1`（`scripts/` 前缀）。

**APK 根目录传递约定**：云端 workflow 与本地来源链都显式传 `DSH_APK_DIR`；`check-runtime-assets.mjs` 必须优先使用该绝对根目录，不能仅凭 `ROOT/dsh-mobile-apk` 猜测协调仓布局。`--require` 仍严格要求该根下 `app/src/main/assets/patched`、快照和 registry 在场；缺件不得 SKIP 或自动生成。 `build-apk-013.ps1` 同样保留前置布局自检测得到的 `$apkDir`，不得在版本解析后重新硬编码 `Root\dsh-mobile-apk`。 发布链临时文件也不得假设 `$env:TEMP` 在所有 PowerShell runner 上存在；跨平台脚本使用 `[IO.Path]::GetTempPath()`。

**来源审计构建（ARM64）**：固定官方Harness 639ed015397290b3745d163aafe02ffee4aa3f84 / 0.2.0-rc.2，workflow检查packageManager pnpm11.7.0及Node范围 ^22.19.0 || >=24.0.0（来源runner使用Node24）。不启用LFS、不读旧base快照；第一方产物由固定源码构建并记录manifest/commit/hash。Electron桌面bundle不属于Android CLI部署闭包，构建脚本临时排除并留provenance；Cordis依赖按本次官方源码，不回退旧版源码伪装新pin。Termux bootstrap固定SHA认证、官方InRelease验签与逐deb哈希仍执行；node-pty源码/NDK与上游原生二进制输入分别披露，不声称全部本地编译。固定debug签名与apksigner自证沿用，真实APK/hash/provenance待构建后记录；source后缀与artifact名不代表另一签名。

**同工作区复跑**：两处源码 clone 可复用，但固定 commit 的 fetch/detach/assert 仍执行；bootstrap 与 NDK 只在固定哈希命中时复用，损坏/半包重下，解包前校验不省略。Harness 阶段从本次 `GITHUB_SHA` 恢复权威 overlay，先复位专用源码 checkout（保留 ignored 依赖），deploy 只清理验证过的专用目标。`source-chain-rerun.test.mjs` 使用本 workflow 的实际守卫和本地假输入覆盖 cache-hit/miss、下载中断、坏字节拒绝解包、依赖保留与清理边界；CI 与本地预检均调用。来源链两次完整运行的证据不得由局部守卫测试代替。

**派发前必须本地预检**：`node scripts/source-build/preflight-source-chain.mjs`。远程 `build-apk-source` 一次 60-90 分钟，而近期判红的几类问题（市场补丁锚点失配、期望补丁集过期、与上游脱钩）**都能在本地提前复现**。预检覆盖五面：① 是否落后 `upstream/main`（合并会换掉链的输入，坑 204/204 都出在合并之后）② 登记表补丁对仓库镜像自洽（`apply-patches --check`）③ 市场插件链按 workflow 里钉的 URL+sha256 取发布产物、解包、打补丁，再与 `vendor/dshmarketplace-plugin/` 逐字节比对 ④ 来源链单测 ⑤ `check-code-map`。版本与哈希都从 workflow 读，不在脚本里重复钉。`--no-network` 可跳过取件与 `git fetch`（此时发布产物必须已在 `.deploy-tmp/component-sources/` 缓存里）。

来源流程的 marketplace 用**固定 npm 发布产物**：`curl` 拉 `dshmarketplace-plugin-0.1.7.tgz` → `sha256sum --check` 对照钉在 workflow 里的哈希 → 解包进 `vendor/dshmarketplace-plugin`（**不再从其 `src/` 重建**，也不参与插件源码构建循环）。理由：仓库镜像与全部 market-* 补丁都按发布字节定义（`vendor/dshmarketplace-plugin/PATCHES.md`），重建会用不同工具链产出不同字节并把补丁锚空（0.1.5 时代就是这样，见坑 205；此前靠适配器里一段源码构建专用改写兜着，已随 0.1.7 退役）。随后运行 `node scripts/source-build/apply-source-marketplace-patches.mjs vendor --apply`：这一步**不修改共享补丁器**，适配器只把生成副本的 `HERE` 指回 `scripts/patches`，然后按原参数执行；共享 runner、生成 runner、registry、适配器自身及补丁后产物的哈希写入 `marketplace-patch-adapter.json`。锚点整体失配不需要适配器兜底——共享执行器对「check 为假且 apply 零改动」本就判红并拒报 ALL OK。已登记的移动端补丁（包括 `/api/dshmarketplace/*` 鉴权）先施加到解包产物，随后 API 路由门禁才能检查最终注入文件。artifact 的 `marketplace-source-provenance.json` 记录发布 tarball URL 与哈希、包版本、补丁 registry/实现哈希及补丁后 lib 哈希。

Harness按固定0.2.0-rc.2源码完成全仓构建；prepare-harness-vendor-overrides保留来源登记接口但不再把五个旧Cordis源码覆盖新官方目标。reconcile-harness-vendor-lock只接受目标pin约束，不以旧importer规则掩盖依赖漂移；来源报告必须记录实际版本/lock。工作区链接仍禁止递归copytree跟随复制。

来源构建还会从本仓九个带 `package-lock.json` 的插件/组件目录执行 `npm ci`。`check-package-lock-roots.mjs` 在 PR 与来源构建的早期步骤核对各目录 `package.json` 与锁文件根声明中的名称、版本及四类依赖，发现镜像后的旧声明就立即报错，避免完成 Harness 和 Termux 构建后才在插件安装阶段失败（坑 196）。锁文件更新后还应对受影响目录运行 `npm ci --dry-run --ignore-scripts --no-audit --no-fund`，因为根声明一致不能证明整份依赖图有效。

`check-android-native-runtime-packages.mjs` 对部署树中的 `.node` / `.node.wasm` 逐文件计数、取哈希，并只接受已审计包族。固定 Harness 当前依赖图还带入 trycua、ubjs、sherpa-onnx 与 node-addon-require-builtin 的 Linux GNU 原生文件；它们作为跨平台部署的外平台 payload 记录，不视为 Android 绑定。新增版本、不同架构路径或未知包族继续拒绝；匹配用例在 PR 与来源构建入口运行（坑 197）。

快照构建器沿用boot-pending标签调用当前dsh-app-boot的auditStartupEntries回归，required pending/failed致命、optional第三方告警；该构建内置检查不是本轮外部验收。本source/doc分工没有执行任何测试/检查。

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
   - `dsh-shell-termux/`（`plugins/dsh-android-linux-env/lib/index.js` → `@dsh-android/dsh-shell-termux` → 四个 peer 依赖 `@deepseek-ai/dsh-bash-local` / `dsh-shell` / `dsh-subprocess` / `dsh-sandbox` @ `0.1.5-rc.1`。**这一个目录没装，聚合链会在第 6 条门禁处中止，后面 20 多条一条都不跑**）。
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
