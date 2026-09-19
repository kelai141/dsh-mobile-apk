# build-apk-013.ps1 — 0.13.0 双 ABI APK 本地构建编排（插件注入 → 门禁 → gradle 双 ABI）
# 前置：scripts/build-snapshot-013.mjs 已产出 .deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz
# 用法：pwsh build-apk-013.ps1 [-Suffix ""] [-SkipInject] [-OnlyAbi arm64]
param(
    [string]$Suffix = "-SN-1-13",          # 快照测试后缀；正式版传 ""
    [string]$OnlyAbi = "",
    [switch]$SkipInject,
    [switch]$ExportSnapshots,              # 0.13.2 增补：导出注入后快照资产 + 一致性门禁（见第 4 步）
    [string]$ForceRejectAbi = "",          # 自检钩子（仅供 check-build-chain-abort --self-test）：强制某 ABI 走拒绝路径，验证整链非 0
[switch]$Fast                          # 2c 快速档（2026-09-05）：单 ABI（缺省 x86_64=MuMu 开发目标）+ 注入链 preset 1
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
# Fast 档：dev 循环产物（sha256 与内嵌自洽即可，体积大不发布）——注入链压缩 380s→75s/遍（实测）。
if ($Fast) {
    if (-not $OnlyAbi) { $OnlyAbi = 'x86_64' }
    $env:DSH_INJECT_PRESET = '1'
    Write-Host "== Fast 档：OnlyAbi=$OnlyAbi，DSH_INJECT_PRESET=1（产物体积增大，禁止用于发布资产）=="
}
# 根自检测：协调仓布局（apk 子仓在 $Root\dsh-mobile-apk）与 apk 仓自包含布局（$Root 即 apk 仓根）
# 共用同一份脚本——双仓字节级同版，杜绝雷点 10 单边演进。
$apkDir = Join-Path $Root "dsh-mobile-apk"
if (-not (Test-Path $apkDir)) { $apkDir = $Root }

# 统一 per-ABI 拒绝记账（坑 94 / review C2，2026-09-14）：曾有三处拒绝路径只 `continue` 不记账
# （机密 / 运行时资产 / A1 出厂值）+ elf-check 退出码被丢弃 → 请求双 ABI 时只交付单 ABI 仍 exit 0。
# 全部拒绝路径必须走本函数；check-build-chain-abort.mjs 静态锁「$rejectedAbis 只在本函数内自增」+
# 「拒绝文案只在本函数内出现」（机器标识，不再 grep 中文文案——文案一改守卫就瞎）。
function Deny-Abi([string]$Abi, [string]$Reason) {
    Write-Host "拒绝打包（$Abi）：$Reason"
    $script:rejectedAbis += $Abi
}

# 补丁镜像一致性门禁（0.13.8 PR-A1 / apk #171 残留）：scripts/patches 是双仓镜像面
# （云端自包含构建用 apk 仓副本），单边演进 = 云端快照静默缺引擎补丁（幽灵缺陷）。
# registry / apply-patches / README 逐字节 + tests 清单，差异即拒打包。
Write-Host "== 补丁镜像一致性门禁 =="
node (Join-Path $Root "scripts\check-patch-mirror.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "补丁镜像不一致，拒绝打包（先同步镜像 scripts/patches 到对端树）"; exit 1 }

# 适配层契约门禁（review C6）：上游 bundle 行引用 / 注入包 lib 产物 / 客户端槽位 / 版本钉台账。
# 本地链 --require 严格档（上游 dsh/ 与本机 node_modules 都在场）；云端自包含链无这些本机产物，
# 对应小节按 SKIP 计数（check-release-gates --run --require 在发布链上强制齐全）。
Write-Host "== 适配层契约门禁（严格）=="
node (Join-Path $Root "scripts\check-contract.mjs") --require 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "适配层契约失败（bundle 行/构建产物/版本钉），拒绝打包"; exit 1 }

# 制度性门禁（0.13.8-b 批 B2 ST-25/26/31）：状态登记制、桥面对称性、SKIP 纪律与门禁覆盖清单化。
# 三者都是离线静态断言（不依赖快照），与 CI 同源（pr-gate 亦调用）——本地链漏接即形同虚设。
Write-Host "== 状态登记制门禁 =="
node (Join-Path $Root "scripts\check-state-registry.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "状态登记制校验失败（PR 模板四栏/登记表 evidence），拒绝打包"; exit 1 }
Write-Host "== 桥面对称性门禁 =="
node (Join-Path $Root "scripts\check-bridge-symmetry.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "桥面出现新的不对称（只有 setter/getter 返偏好），拒绝打包"; exit 1 }
Write-Host "== 门禁覆盖与 SKIP 纪律门禁 =="
node (Join-Path $Root "scripts\check-gate-skips.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "门禁覆盖清单/SKIP 纪律失败（发布链要求 SKIP=0），拒绝打包"; exit 1 }

# 构建链中止语义（任一 ABI 被门禁拒绝 = 整链非 0；含尾部守卫动态自检）
Write-Host "== 构建链中止语义门禁 =="
node (Join-Path $Root "scripts\check-build-chain-abort.mjs") --self-test 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "构建链中止语义失效（某 ABI 被拒后仍可能 exit 0），拒绝打包"; exit 1 }

# 快照指纹对账门禁（0.13.8-b 批 B2 ST-04 / F-ENV-01）：sha256(assets/snapshot.tar.xz) == assets/snapshot.sha256。
# 预检：净检出下 tar 不在场 → SKIP 计数（exit 0）；第 3 步写完本 ABI 的声明值后再以 --require 严格复核。
# 「手工替换 tar」这一动作此前没有任何机器校验（壳侧 snapshotFresh() 只做字符串比较）。
Write-Host "== 快照指纹对账门禁（预检）=="
node (Join-Path $Root "scripts\check-snapshot-fingerprint.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "快照指纹与声明值不一致（手工替换 tar？），拒绝打包"; exit 1 }

# manifest 加固门禁（0.13.8 PR-B3 / apk #183）：allowBackup/NSC/接收器来源校验在场
Write-Host "== manifest 加固门禁 =="
node (Join-Path $Root "scripts\check-manifest-hardening.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "manifest 加固校验失败，拒绝打包"; exit 1 }

# Kotlin 块注释嵌套（KDoc 里写 node_modules/** 会吞掉整个文件；dev-shell 实测）
Write-Host "== Kotlin 注释嵌套门禁 =="
node (Join-Path $Root "scripts\check-kotlin-comments.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Kotlin 块注释嵌套，拒绝打包"; exit 1 }

# 子进程无界读 grep 门禁（0.13.8 #173）：输出必须走 ProcIo.readBounded
Write-Host "== 有界读门禁 =="
node (Join-Path $Root "scripts\check-bounded-io.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "无界读命中，拒绝打包"; exit 1 }

# /api 路由鉴权门禁（0.14.0 #222）：exact/更长 prefix 不得绕过 browser auth；公开状态路由必须入白名单。
Write-Host "== /api 路由鉴权门禁 =="
node (Join-Path $Root "scripts\check-api-route-auth.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "/api 路由未登记或缺少本地鉴权，拒绝打包"; exit 1 }

# 控制协议 V2 往返 + 体积门禁（0.13.8 批 F / DESIGN-PROTOCOL-V2.md §S6）
Write-Host "== 协议 V2 门禁 =="
node (Join-Path $Root "scripts\check-protocol-v2.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "协议 V2 门禁失败，拒绝打包"; exit 1 }

# 工具返回值 vs output.schema 运行时契约门禁（0.13.8-b 批 B2 T2 / E-10，issue #204 的假绿防线）：
# 用引擎同一个 validateJsonSchemaValue 校验各工具分支返回值 + 递归无 undefined + 源码级注册差集 = 0。
Write-Host "== 工具输出 schema 契约门禁 =="
node (Join-Path $Root "scripts\check-tool-output-schema.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "工具返回值与 output.schema 不一致，拒绝打包"; exit 1 }

# 控制 op 六处登记链一致性门禁（0.13.8-b 批 B2）：漏一处 = a11y 通道下该 op 静默 deny（坑 52）。
Write-Host "== 控制 op 登记链门禁 =="
node (Join-Path $Root "scripts\check-control-ops.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "控制 op 登记链漂移（六处集合不一致），拒绝打包"; exit 1 }

# 插件单测门禁（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：脚本自 0.14.0 起存在却从未被任何路径调用，
# 7 个插件的 34 个测试文件全部没人跑。判据：有 test/*.test.mjs 必须真跑通且有效通过数 > 0（全 skip = 假绿）。
# 需 plugins/*/lib 构建产物（本链在注入前已构建）；产物的新鲜度由 check-tool-output-schema 等另行守。
Write-Host "== 插件单测门禁 =="
node (Join-Path $Root "scripts\check-plugin-tests.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "插件单测未通过（或全 skip 假绿），拒绝打包"; exit 1 }

# 冷启动预算门禁（0.14.1 块F P0-2）：口径从「LISTEN 达标」换成「首个 HTTP 响应 + 无 >2s 同步块」。
# 【0.14.1 P0-a 修复】此前这里写死 --self-test，导致**真检被结构性绕开**：门禁对设备真产物会判红
# （C1 首个响应−LISTEN 超预算、C4 p99 超预算），但四条调用点全都只跑自证 → 判据虽真会红，却永不执行。
# 现改为**默认档**：门禁自己按优先级发现真产物（显式 --segments/--probe > DSH_BOOT_BUDGET_DIR > 约定落点），
#   有产物 → 真检（超预算即 exit 1 拒打包）；无产物 → 打印 SKIP(real-data) 并退 --self-test（exit 0）。
# 即「无产物 = SKIP，绝不等于绿」，且构建机无设备时不会因此误拒。
Write-Host "== 冷启动预算门禁（有设备产物则真检，否则退自证） =="
node (Join-Path $Root "scripts\check-boot-budget.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "冷启动预算门禁失败（真产物超预算，或自证判据已退化为假绿），拒绝打包"; exit 1 }

# 快照构建器产出面门禁（0.14.1 P0 反回归）：0849579 曾删掉 §8 归档整段，构建器 exit 0 却不产 tar，
# 打包链只判「tar 是否存在」→ 静默复用陈旧快照。本门禁锁产出面构造 + slim 配置键闭合 + 路径同源。
Write-Host "== 快照构建器产出面门禁 =="
node (Join-Path $Root "scripts\check-snapshot-builder-output.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "快照构建器产出面缺失/漂移（可能静默复用陈旧快照），拒绝打包"; exit 1 }

# 构建并发上限门禁（0.14.1 用户拍板的系统级约束）：构建期压缩/解压不得吃满全部逻辑核——原写法是
# `xz -T0`（= 16 逻辑线程），会把开发机撑满 → 同时运行的 MuMu 模拟器卡顿、甚至系统级不稳。而
# 「模拟器优先」是铁律 2（本地构建 → MuMu 实测），两者经常并行，撑满等于自己踩自己的验收环境。
# 用户口径：固定 8 线程（= 物理核），不撑满 16。上限唯一出处见 scripts/lib/shell.mjs 的 XZ_THREADS。
Write-Host "== 构建并发上限门禁 =="
node (Join-Path $Root "scripts\check-build-parallel-cap.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "构建并发吃满全部核心（模拟器/系统不稳），拒绝打包"; exit 1 }

# Kotlin 单测数量反回归（0.14.1 P0）：CI 从不跑 Kotlin 单测（pr-gate 只 compileDebugKotlin），
# 417 例契约断言此前只在本地手动跑过；且「只按退出码判」分不清「全绿」与「一个用例都没跑」
# （测试类被删/改名/漏编译时 exit 仍 0）。本门禁逐类比对基线（只许升）+ 断言无缺席 + 结果新鲜。
# 注意时序：本步在 gradle 构建**之前**，故用的是**上一次**的测试结果——若尚无结果则显式
# SKIP(#1) 计数（不计入绿）。真正的「本次构建前必须重跑单测」由发布链步骤保证（见 build-release.ps1）。
Write-Host "== Kotlin 单测数量反回归门禁 =="
node (Join-Path $Root "scripts\check-kotlin-test-count.mjs") --allow-missing 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Kotlin 单测防线数量/新鲜度不达标（可能有用例被删或结果陈旧），拒绝打包"; exit 1 }

# pi-ai 目录 diff（0.13.3 W1/P2）：baseline -> pin 信息性输出（构建日志 + 报告文件），
# 删除清单供回归报告引用——不拒绝构建（删除项由 W4 降级补丁兜底）。
$overlayManifest = Join-Path $Root "scripts\snapshot-config\engine-overlay.json"
if (Test-Path $overlayManifest) {
    $ov = Get-Content $overlayManifest -Raw | ConvertFrom-Json
    if ($ov.catalogDiff -and $ov.pins) {
        $pinVer = $ov.pins.'@earendil-works/pi-ai'
        if ($pinVer -and $ov.catalogDiff.baseline) {
            Write-Host "== pi-ai 目录 diff（$($ov.catalogDiff.baseline) -> $pinVer，信息性）=="
            node (Join-Path $Root "scripts\pi-catalog-diff.mjs") --from $ov.catalogDiff.baseline --to $pinVer --out (Join-Path $Root ".deploy-tmp\pi-catalog-diff-report.md") 2>&1 | Select-Object -Last 6
            if ($LASTEXITCODE -ne 0) { Write-Host "pi-ai 目录 diff 执行失败（网络/元数据）——继续构建但回归报告须补跑" }
        }
    }
}

# 版本单一来源：build.gradle.kts（0.13.1 踩坑：硬编码 out\v0.13.0 与 $ver 会让纯净版产物错误命名旧版本）
$GradleVer = (Select-String -Path (Join-Path $apkDir "app\build.gradle.kts") -Pattern 'versionName = "([^"]+)"').Matches[0].Groups[1].Value
$Out = Join-Path $Root ("out\v" + $GradleVer)
$apkDir = Join-Path $Root "dsh-mobile-apk"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 注入集单一常量（0.13.8-b ST-06 / F-ENV-04）：dirs/externals 都在 scripts/plugin-dirs.json，
# 与云端链 dsh-mobile-apk/scripts/build-apk.mjs 共用同一份——此前两条链各写一份，云端
# pluginDirs 少一个「权威 patch 已挂载」的包（dsh-model-capability）且无任何门禁能发现。
# 注入四件套的历史背景（2026-08-23 修复 C3）：此前快照仅有 3 个 @dsh-android 包，而权威 patch
# 挂载了 bridge/manage/linux-env/file-open → 装配失败/功能缺席。
$pluginManifest = Get-Content (Join-Path $Root "scripts\plugin-dirs.json") -Raw | ConvertFrom-Json
$pluginDirs = @($pluginManifest.dirs | ForEach-Object { Join-Path $Root $_ })
$externDirs = @($pluginManifest.externals | ForEach-Object { Join-Path $Root $_ })
$externByName = @{}
foreach ($d in $externDirs) { $externByName[(Split-Path $d -Leaf)] = $d }

$rejectedAbis = @()
$producedAbis = @()
foreach ($abi in @('arm64', 'x86_64')) {
    if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
    # 自检钩子：强制该 ABI 走「拒绝打包」路径（默认空 = 永不触发），用于锁住「任一 ABI 被拒 → 整链非 0」。
    if ($ForceRejectAbi -eq $abi) { Write-Host "自检：强制拒绝 $abi（构建链中止语义自检）"; Deny-Abi $abi "自检钩子"; continue }
    $snap = Join-Path $Root ".deploy-tmp\snapshot-013\$abi\snapshot.tar.xz"
    if (-not (Test-Path $snap)) { Deny-Abi $abi "缺快照 $snap（先跑 build-snapshot-013.mjs）"; continue }
    $work = Join-Path $Root ".deploy-tmp\build-\13-$abi"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # 1b. 引擎 overlay 抽验门禁（0.13.3 W1）：登记表在快照内全量落位（版本精确断言 + presets 在场）
    Write-Host "== 引擎 overlay 抽验（$abi）=="
    node (Join-Path $Root "scripts\check-engine-overlay.mjs") $snap 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "引擎 overlay 抽验失败"; continue }

    # 1. 插件注入（@dsh-android 专用 + 通用根级包）
    if (-not $SkipInject) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".deploy-tmp\plugins") | Out-Null
        # undo-savepoint 注入源：vendor/dsh-undo-savepoint（固化移动端裁剪版——
        # 头部只留快照徽章、移除撤销/恢复快捷键行与全局键盘监听，见其 PATCHES.md 差异表）
        # 两个根级注入源（undo / marketplace）同样来自 plugin-dirs.json.externals：
        # marketplace 是固化修复版（上游 0.1.5 pre-execute 守卫不调 next() 导致全工具崩溃，见其
        # PATCHES.md）；undo 是固化移动端裁剪版。model-sync 已于 0.14.1 摘除（见 profile-web patch 的注释）。
        $undo = $externByName['dsh-undo-savepoint']
        $market = $externByName['dshmarketplace-plugin']
        if (-not (Test-Path (Join-Path $undo "package.json"))) { Deny-Abi $abi "缺 undo 注入源 $undo（git clone lire1131/dsh-undo-savepoint）"; continue }
        if (-not (Test-Path (Join-Path $market "package.json"))) { Deny-Abi $abi "缺 marketplace 注入源 $market（vendor 固化副本）"; continue }
        # 统一补丁门禁（Phase 2a）：marketplace A-D + undo E1-E7 幂等施加与校验，
        # 登记表 scripts/patches/registry.json。默认 ensure 语义（缺席即施加，锚点失配拒打包）。
        # 雷点 8：全量输出——Select-First 截断管道会杀 node 致误判失败
        node (Join-Path $Root "scripts\patches\apply-patches.mjs") (Join-Path $Root "vendor") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "vendor 补丁校验/施加失败"; continue }
        # 浏览器语法下限：注入段的 lib/client.js 降级（0.14.1 块C G-1 的第二段）。
        # 为什么注入段也要降：快照段的降级（build-snapshot-013.mjs 的 0f-1b）只覆盖快照内已有产物，
        # 而注入包里**新进来**的 lib/client.js 不在其中。我方 3 个带 client bundle 的包已改自身构建
        # 目标（tsdown.client.ts / build-client.mjs 的 chrome87），但 vendor/（marketplace /
        # undo-savepoint）**无构建源**（只有 lib/，package.json 指向不存在的 build.mjs）→ 改不了源，
        # 只能在此处按产物降级。
        # **就地 vs 暂存（这条是硬约束，不是偏好）**：`plugins/*/lib/` 在 .gitignore 内（就地降级对
        # git 不可见，安全）；但 `vendor/*/lib/` 是**入库跟踪**的（.gitignore 有显式 `!vendor/...` 例外）
        # ——就地降级会把它写脏，进而绊停发布链自己的 dirty 门禁（也会让「产物可追溯到已提交源码」失效）。
        # 故 vendor 三个源先复制到 $work 下再降级，并把**暂存路径**交给 combo 预计算与 inject-all
        # （两处必须用同一份，否则 combo 键与注入内容不一致）。
        # **顺序硬约束**：必须在 combo 预计算之前——T7 实测同一棵树「先算 combo」与「降级后再算」的
        # 键集合仅 49/62 重叠（13 条键随降级改变）；顺序反了这 13 条必然 miss（fail-open 静默回退）。
        # **权威判据不在本步**：注入完成后的 `check-browser-syntax-floor.mjs --scan <注入后 tar>`
        # 才是判红点（见下方「浏览器语法下限门禁」），本步只负责把产物改成合规形态。
        # 雷点 8：全量输出，不用 Select-* 截断管道（会杀 node 致误判）。
        Write-Host "== 浏览器语法下限：注入段降级（$abi）=="
        $degradeStaged = Join-Path $work "degrade-src"
        New-Item -ItemType Directory -Force -Path $degradeStaged | Out-Null
        $degradeFailDetail = ""
        # 默认仍指向原源目录（表示「不降级」）；只有真的降级成功才改指向暂存副本。
        # **必须显式初始化**：无 lib/client.js 的源不会进下面的 if，若这两个变量保持未定义/为 $null，
        # 后续 `@($undoDeg, ...)` 会含 $null 元素，经 splatting 传给 node 时造成**参数错位**
        # （实测表现：--out 的值被当成未知参数）。
        $undoDeg = $undo; $marketDeg = $market
        # vendor 两源：**暂存副本**再降级（vendor/*/lib 是入库跟踪的，就地降级会写脏仓库并绊停
        # 发布链自己的 dirty 门禁）。无 lib/client.js 的源不复制、保持原路径。
        # 本段刻意**不写中间 continue**：构建链静态锁「每个 continue 都必须是经 Deny-Abi 记账的
        # 拒绝路径」（check-build-chain-abort.mjs），而「该源没有浏览器 bundle」是正常跳过不是拒绝；
        # 且嵌套 foreach 里的 continue 只会继续内层循环、不会跳过本 ABI。故失败只记明细，
        # 统一在段末用一条 `Deny-Abi $abi "..."; continue` 记账并跳过本 ABI。
        foreach ($pair in @(@('undo-degraded', $undo), @('market-degraded', $market))) {
            $leaf = $pair[0]; $src = $pair[1]
            if (Test-Path (Join-Path $src "lib\client.js")) {
                $dst = Join-Path $degradeStaged $leaf
                Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
                robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
                node (Join-Path $Root "scripts\check-browser-syntax-floor.mjs") --degrade --stage $dst 2>&1
                if ($LASTEXITCODE -ne 0) { $degradeFailDetail = "注入段浏览器语法降级失败（$leaf）" }
                elseif ($leaf -eq 'undo-degraded') { $undoDeg = $dst }
                elseif ($leaf -eq 'market-degraded') { $marketDeg = $dst }
            }
        }
        # **不降级我方 plugin**（原实现会 `--degrade --stage <plugin>` 就地改写）：
        #   · 它们已在自己**构建源**里钉了 chrome87（tsdown.client.ts / build-client.mjs），实测
        #     「只扫本包自己的 lib/client.js」为 0 违规（判据1 0 / 判据2 0）→ 再降一次是**多余的**；
        #   · 就地降级会改写 lib/ 与包内 node_modules 副本 → 与 apk 仓镜像产生**无意义的漂移**，
        #     把 check-patch-mirror 判红（实测踩到），发布链断在无关门禁上。
        #   · 真正需要产物级降级的是 **vendor/**（无构建源），已由上面「暂存副本」分支覆盖。
        # 注入后的权威判据是下方 `check-browser-syntax-floor.mjs --scan <注入后 tar>`——它扫全清单，
        # 一旦有包没降到位就判红；不需要在这里「顺手再降一遍」。
        if (-not [string]::IsNullOrEmpty($degradeFailDetail)) { Deny-Abi $abi $degradeFailDetail; continue }
        # combo 缓存注入段（A3 启动性能）：注入链的 client.js 不在快照段预计算范围内，这里对
        # 注入源逐个补算为 client-combos.inject.json + <sha256>.map，经 inject-all --combo-cache-delta
        # 作为新 tar 条目合入 home/.dsh/profiles/web/.combo-cache/。覆盖由注入后门禁 check-combo-cache 断言。
        # 用**降级后的**源（与下方 inject-all 同一份），否则 combo 键与注入内容不一致。
        # 雷点 8：全量输出。
        Write-Host "== combo 缓存注入段预计算（$abi）=="
        $comboDelta = Join-Path $work "combo-cache-delta"
        New-Item -ItemType Directory -Force -Path $comboDelta | Out-Null
        $comboArgs = @()
        foreach ($d in (@($pluginDirs) + @($undoDeg, $marketDeg))) { $comboArgs += @("--scan", $d) }
        node (Join-Path $Root "scripts\lib\combo-precompute.mjs") @comboArgs --out $comboDelta --manifest client-combos.inject.json --engine inject 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "combo 缓存注入段预计算失败"; continue }
        # 单 pass 注入（2c 提速 2026-09-05）：@dsh-android + 根级插件 + 权威 patch 覆盖合并
        # 为一次 tar 流处理——压缩/解压从 ×4 → ×1（原三步各自全量重压缩 ~743MB）。
        # 雷点 8：全量输出。
        Write-Host "== 单 pass 注入（@dsh-android + undo/market + 权威 patch）（$abi）=="
        # ST-05：--all-profiles = 权威 patch 与注入包覆盖全部真实装配 profile（web + headless；
        # 负控 profile headless-bad 由 inject-all.py 显式跳过）。此前只写 web，headless 停在旧值。
        python (Join-Path $Root "scripts\inject-all.py") $snap (Join-Path $work "snap-final2.tar.xz") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") --dsh-android @pluginDirs --external $undoDeg $marketDeg --all-profiles --combo-cache-delta $comboDelta 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入失败"; continue }
        # 防回归（审校 C4 2026-08-23）：patch 挂载集 ⊇ 注入集——缺条目（如 linux-env 漏挂）直接拒打包
        Write-Host "== 挂载集校验（$abi）=="
        node (Join-Path $Root "scripts\check-patch-mounts.mjs") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") @pluginDirs $undo $market 2>&1 | Select-Object -First 4
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "patch 挂载集校验失败"; continue }
        # 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → tar 里 import 悬空 → 设备侧引擎启动即死）
        Write-Host "== 注入成员完整性门禁（$abi）=="
        node (Join-Path $Root "scripts\check-inject-completeness.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入产物成员不完整（新增文件丢失/import 悬空）"; continue }
        # combo 缓存覆盖（A3）：注入后 tar 的每条 client.js 必须有 sha256 命中的缓存条目（含注入段增量）
        Write-Host "== combo 缓存覆盖门禁（$abi）=="
        node (Join-Path $Root "scripts\check-combo-cache.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "combo 缓存覆盖不全（回退将吞掉全部启动收益）"; continue }

        # 浏览器语法下限（0.14.1 块C G-1）：发往浏览器的 bundle 不得携带老内核（WebView <94）解析
        # 不了的语法——入口 chunk 里一个 `static{}` 就会让整模块不执行 → 纯白无字（自 0.13.3 起每版皆有）。
        # 判据 = 真实解析器 AST + esbuild 双 arm 逐字节差分（禁 grep 文本在场）；扫**全清单**（dist + 每个
        # lib/client.js），不是只扫入口 chunk。降级动作在快照构建期由同一脚本的 --degrade 完成。
        Write-Host "== 浏览器语法下限门禁（$abi）=="
        node (Join-Path $Root "scripts\check-browser-syntax-floor.mjs") --scan (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "发往浏览器的 bundle 携带未降级的 ES2022 语法（老内核白屏）"; continue }
        # 模型面工具 wire 预算（0.14.0 §4.1）：注册集 + 初始可见集双口径。真跑各插件 apply()，
        # 需 plugins/*/lib 构建产物（本链前置已构建）。防「工具面无声膨胀」吃掉每会话固定预算。
        Write-Host "== 工具面预算门禁（$abi）=="
        node (Join-Path $Root "scripts\check-tool-surface-budget.mjs") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "模型面工具 wire 超预算（新增工具须归组掩蔽或评审改基线）"; continue }
        # #222：源文件 guard 不等于发行 tar guard；必须逐 profile 读取已注入 artifact 的 marker。
        Write-Host "== 注入后 /api 路由鉴权门禁（$abi）=="
        node (Join-Path $Root "scripts\check-api-route-auth.mjs") --snapshot (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "注入后 /api 路由鉴权 marker 缺失"; continue }
        # 剥离清单后置断言（ST-16）：清单项在产物里必须不存在（防剥离静默 no-op）
        Write-Host "== 剥离清单后置断言（$abi）=="
        node (Join-Path $Root "scripts\check-strip-noop.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "剥离清单项仍在场（剥离未生效）"; continue }
        $snapIn = Join-Path $work "snap-final2.tar.xz"
    } else {
        $snapIn = $snap
    }

    # 2. 门禁（关键工具存在性 + ELF 架构 + 权限模式 + 🔒 机密 + GPL 合规）
    Write-Host "== 门禁（$abi）=="
    Write-Host "== 快照权限模式校验（$abi）=="
    node (Join-Path $Root "scripts\check-snapshot-file-modes.mjs") $snapIn 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($SkipInject) {
            # -SkipInject 直接打包 build-snapshot 原始产物；WSL 9p 挂载 chmod 无效，模式归一化只
            # 发生在 inject-all.py 重打包时（dev 专档，禁止用于发布资产）。
            Write-Host "警告：-SkipInject 档快照未做权限归一化（dev 专档，禁止发布）"
        } else {
            Deny-Abi $abi "快照权限模式校验失败"; continue
        }
    }
    # 第三方许可合规（GPL 义务 A1/A2 门禁 2026-08-23）：copyleft 包许可证全文须随快照分发，
    # 矩阵须覆盖 dpkg status 全部包；缺失直接拒绝打包（--- tar 视图：9p 权限不影响判定）。
    node (Join-Path $Root "scripts\check-third-party.mjs") (Join-Path $work "x") --tar $snapIn 2>&1 | Select-Object -First 4
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "THIRD-PARTY CHECK FAILED（许可合规）"; continue }
    # 许可资产（LICENSES 标准文本 + notices）打入 APK assets（A2：随包分发）
    $licAssets = Join-Path $apkDir "app\src\main\assets\licenses"
    New-Item -ItemType Directory -Force -Path $licAssets | Out-Null
    Copy-Item (Join-Path $Root "LICENSES\*.txt") $licAssets -Force
    Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $licAssets -Force
    Write-Host "== 许可资产就位（$abi）=="
    # 机密门禁单实现（0.13.8-b ST-06 / F-ENV-08 口径）：check-snapshot-secrets.mjs——跨平台 node
    # 实现，云端链 build-apk.mjs 调用的是同一份；退出码可靠（旧 .ps1 走 cmd /c tar，$LASTEXITCODE
    # 反映 cmd 尾命令而非脚本 exit 码，只能靠输出标记判定）。.ps1 实现已不再被任何链调用。
    Write-Host "== 快照机密门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-snapshot-secrets.mjs") $snapIn --require 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "SNAPSHOT_SECRET_CHECK_FAILED：快照含机密或归档不可读"; continue }
    $wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
    $wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
    wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
    $elfOut = node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $abi 2>&1
    $elfCode = $LASTEXITCODE
    $elfOut
    if ($elfCode -ne 0) { Deny-Abi $abi "ELF 架构校验失败（ABI 错配的 node？）"; continue }

    # 运行时补丁资产一致性门禁（0.13.8 收尾 / apk #170 复盘）：assets/patched/* 是引擎启动时
    # 覆盖运行树的预打补丁副本，必须与快照同源——否则「构建期 marker 全绿、设备上补丁被改回去」。
    # FX-208.1：按当前 ABI 传参；--require = 快照/资产缺席即失败，不得 SKIP exit 0（旧实现把构建机状态
    # 变成门禁结果）。ST-06：本调用原先落在 foreach 之外（$abi 未定义恒走 x86_64 默认值）——已移进循环。
    Write-Host "== 运行时补丁资产门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-runtime-assets.mjs") $abi --require 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "运行时补丁资产过期或缺失（从快照重新生成 assets/patched）"; continue }

    # A1 出厂声明值对账（P-AC-01，--require 严格档）：注入后快照的 profile 清单必须带 patchReload 出厂值。
    Write-Host "== 性能度量入口与 A1 出厂值门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-perf-instrumentation.mjs") --require --snapshot $snapIn --abi $abi 2>&1
    if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "A1 出厂值/度量入口校验失败"; continue }

    # 3. 双 ABI APK（cp 快照 + 指纹 → gradle assembleDebug）
    Write-Host "== 构建 APK（$abi, suffix=$Suffix）=="
    # 增量打包防护（2026-08-23 修复）：mergeDebugAssets 缓存随 ABI 切换不会失效，
    # 且打包器会在旧 APK 上叠加同名条目（产品曾出现双 snapshot.tar.xz、APK 288MB）——每次迭代前清理。
    Remove-Item (Join-Path $apkDir "app\build\intermediates\assets") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $apkDir "app\build\outputs\apk\debug") -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $snapIn (Join-Path $apkDir "app\src\main\assets\snapshot.tar.xz") -Force
    $sha = (Get-FileHash $snapIn -Algorithm SHA256).Hash.ToLower()
    Set-Content -Path (Join-Path $apkDir "app\src\main\assets\snapshot.sha256") -Value $sha -NoNewline -Encoding ascii
    # ST-04 严格复核：本 ABI 的 tar 与刚写入的声明值必须逐字节一致（--require：缺件即失败，不得 SKIP）。
    # 两个 ABI 各自构建时各自声明值与各自 tar 一致——不得再出现「入库值是单一 ABI 构建的事实」。
    node (Join-Path $Root "scripts\check-snapshot-fingerprint.mjs") --require 2>&1
    if ($LASTEXITCODE -ne 0) { throw "快照指纹对账失败（$abi）：tar 与声明值不一致，拒绝打包" }
    Push-Location $apkDir
    try {
        & .\gradlew :app:assembleDebug --no-daemon -PversionNameSuffix="$Suffix" 2>&1 | Select-Object -Last 4
        if ($LASTEXITCODE -ne 0) { throw "gradle 构建失败（$abi）" }
        $ver = "$GradleVer$Suffix"
        Copy-Item "app\build\outputs\apk\debug\app-debug.apk" (Join-Path $Out "dsh-mobile-apk-v$ver-$abi.apk") -Force
        Write-Host "产物: $Out\dsh-mobile-apk-v$ver-$abi.apk"
    } finally {
        Pop-Location
    }
    $producedAbis += $abi
}

# 4. 发布快照资产导出 + 一致性门禁（0.13.2 增补；0.13.1 实锤教训：Release snapshot-*.tar.xz
#    被误取为注入前 build-snapshot 原始产物——缺 6 个注入包 + shell-termux 0.1.2 无 FENCE_KEYS，
#    而 APK 内嵌的是注入后 snap-final2。铁律：发布快照资产必须与 APK 内嵌快照同源一致，
#    禁止手工从 .deploy-tmp\snapshot-013\<abi>\ 拷贝）
if ($ExportSnapshots) {
    foreach ($abi in @('arm64', 'x86_64')) {
        if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
        $snapIn = Join-Path $Root ".deploy-tmp\build-\13-$abi\snap-final2.tar.xz"
        if (-not (Test-Path $snapIn)) { Deny-Abi $abi "缺注入后快照 $snapIn（导出失败：发布资产不完整）"; continue }
        $outSnap = Join-Path $Out "snapshot-$abi.tar.xz"
        Copy-Item $snapIn $outSnap -Force
        Set-Content -Path (Join-Path $Out "snapshot-$abi.tar.xz.sha256") -Value ((Get-FileHash $outSnap -Algorithm SHA256).Hash.ToLower()) -NoNewline -Encoding ascii
        Write-Host "快照资产导出: $outSnap"
        $apkOut = Join-Path $Out ("dsh-mobile-apk-v" + $GradleVer + $Suffix + "-" + $abi + ".apk")
        if (Test-Path $apkOut) {
            & (Join-Path $PSScriptRoot "check-snapshot-asset.ps1") -ApkPath $apkOut -SnapshotPath $outSnap
            if ($LASTEXITCODE -ne 0) { Deny-Abi $abi "快照资产与 APK 内嵌不一致（拒绝发布组装）"; continue }
        } else {
            Write-Host "警告: 缺 APK $apkOut，跳过一致性校验（$abi）"
        }
    }
}
$producedList = (($producedAbis | Select-Object -Unique) -join ", ")
$rejectedList = (($rejectedAbis | Select-Object -Unique) -join ", ")
Write-Host "=== 汇总。已产出 ABI: [$producedList] / 被拒 ABI: [$rejectedList] ==="
Write-Host "=== 产物目录：$Out ==="
# 任一 ABI 被门禁拒绝 = 不得交付（单 ABI 产物发布 = 缺 ABI 的 release）——必须非 0 退出，
# 由 scripts/check-build-chain-abort.mjs 静态锁住（0.13.8-b：arm64 被拒后整链仍 exit 0 的实锤）。
if ($rejectedAbis.Count -gt 0) { Write-Host "有 ABI 被门禁拒绝——不发版（exit 1）"; exit 1 }
if ($producedAbis.Count -eq 0) { Write-Host "没有任何 ABI 产出——不发版（exit 1）"; exit 1 }
