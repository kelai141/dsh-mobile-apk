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

# 补丁镜像一致性门禁（0.13.8 PR-A1 / apk #171 残留）：scripts/patches 是双仓镜像面
# （云端自包含构建用 apk 仓副本），单边演进 = 云端快照静默缺引擎补丁（幽灵缺陷）。
# registry / apply-patches / README 逐字节 + tests 清单，差异即拒打包。
Write-Host "== 补丁镜像一致性门禁 =="
node (Join-Path $Root "scripts\check-patch-mirror.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "补丁镜像不一致，拒绝打包（先同步镜像 scripts/patches 到对端树）"; exit 1 }

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
    if ($ForceRejectAbi -eq $abi) { Write-Host "自检：强制拒绝 $abi（构建链中止语义自检）"; $rejectedAbis += $abi; continue }
    $snap = Join-Path $Root ".deploy-tmp\snapshot-013\$abi\snapshot.tar.xz"
    if (-not (Test-Path $snap)) { Write-Host "缺快照 $snap（先跑 build-snapshot-013.mjs）"; continue }
    $work = Join-Path $Root ".deploy-tmp\build-\13-$abi"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # 1b. 引擎 overlay 抽验门禁（0.13.3 W1）：登记表在快照内全量落位（版本精确断言 + presets 在场）
    Write-Host "== 引擎 overlay 抽验（$abi）=="
    node (Join-Path $Root "scripts\check-engine-overlay.mjs") $snap 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "引擎 overlay 抽验失败，拒绝打包（$abi）"; $rejectedAbis += $abi; continue }

    # 1. 插件注入（@dsh-android 专用 + 通用根级包）
    if (-not $SkipInject) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".deploy-tmp\plugins") | Out-Null
        # undo-savepoint 注入源：vendor/dsh-undo-savepoint（固化移动端裁剪版——
        # 头部只留快照徽章、移除撤销/恢复快捷键行与全局键盘监听，见其 PATCHES.md 差异表）
        # 三个根级注入源（undo / marketplace / model-sync）同样来自 plugin-dirs.json.externals：
        # marketplace 是固化修复版（上游 0.1.5 pre-execute 守卫不调 next() 导致全工具崩溃，见其
        # PATCHES.md）；model-sync 是 @aiwayds/dsh-model-sync 0.3.1 固化副本（0.13.3 W7）。
        $undo = $externByName['dsh-undo-savepoint']
        $market = $externByName['dshmarketplace-plugin']
        $modelSync = $externByName['dsh-model-sync']
        if (-not (Test-Path (Join-Path $undo "package.json"))) { Write-Host "缺 undo 注入源 $undo（git clone lire1131/dsh-undo-savepoint）"; continue }
        if (-not (Test-Path (Join-Path $market "package.json"))) { Write-Host "缺 marketplace 注入源 $market（vendor 固化副本）"; continue }
        if (-not (Test-Path (Join-Path $modelSync "lib\index.js"))) { Write-Host "缺 model-sync 注入源 $modelSync（vendor 固化副本）"; continue }
        # 统一补丁门禁（Phase 2a）：marketplace A-D + undo E1-E7 幂等施加与校验，
        # 登记表 scripts/patches/registry.json。默认 ensure 语义（缺席即施加，锚点失配拒打包）。
        # 雷点 8：全量输出——Select-First 截断管道会杀 node 致误判失败
        node (Join-Path $Root "scripts\patches\apply-patches.mjs") (Join-Path $Root "vendor") 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "vendor 补丁校验/施加失败，拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
        # 单 pass 注入（2c 提速 2026-09-05）：@dsh-android + 根级插件 + 权威 patch 覆盖合并
        # 为一次 tar 流处理——压缩/解压从 ×4 → ×1（原三步各自全量重压缩 ~743MB）。
        # 雷点 8：全量输出。
        Write-Host "== 单 pass 注入（@dsh-android + undo/market + 权威 patch）（$abi）=="
        # ST-05：--all-profiles = 权威 patch 与注入包覆盖全部真实装配 profile（web + headless；
        # 负控 profile headless-bad 由 inject-all.py 显式跳过）。此前只写 web，headless 停在旧值。
        python (Join-Path $Root "scripts\inject-all.py") $snap (Join-Path $work "snap-final2.tar.xz") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") --dsh-android @pluginDirs --external $undo $market $modelSync --all-profiles 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "注入失败，拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
        # 防回归（审校 C4 2026-08-23）：patch 挂载集 ⊇ 注入集——缺条目（如 linux-env 漏挂）直接拒打包
        Write-Host "== 挂载集校验（$abi）=="
        node (Join-Path $Root "scripts\check-patch-mounts.mjs") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") @pluginDirs $undo $market $modelSync 2>&1 | Select-Object -First 4
        if ($LASTEXITCODE -ne 0) { Write-Host "patch 挂载集校验失败，拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
        # 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → tar 里 import 悬空 → 设备侧引擎启动即死）
        Write-Host "== 注入成员完整性门禁（$abi）=="
        node (Join-Path $Root "scripts\check-inject-completeness.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "注入产物成员不完整（新增文件丢失/import 悬空），拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
        # 剥离清单后置断言（ST-16）：清单项在产物里必须不存在（防剥离静默 no-op）
        Write-Host "== 剥离清单后置断言（$abi）=="
        node (Join-Path $Root "scripts\check-strip-noop.mjs") (Join-Path $work "snap-final2.tar.xz") 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "剥离清单项仍在场（剥离未生效），拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
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
            Write-Host "快照权限模式校验失败，拒绝打包（$abi）"; $rejectedAbis += $abi; continue
        }
    }
    # 第三方许可合规（GPL 义务 A1/A2 门禁 2026-08-23）：copyleft 包许可证全文须随快照分发，
    # 矩阵须覆盖 dpkg status 全部包；缺失直接拒绝打包（--- tar 视图：9p 权限不影响判定）。
    node (Join-Path $Root "scripts\check-third-party.mjs") (Join-Path $work "x") --tar $snapIn 2>&1 | Select-Object -First 4
    if ($LASTEXITCODE -ne 0) { Write-Host "THIRD-PARTY CHECK FAILED，拒绝打包（$abi）"; $rejectedAbis += $abi; continue }
    # 许可资产（LICENSES 标准文本 + notices）打入 APK assets（A2：随包分发）
    $licAssets = Join-Path $apkDir "app\src\main\assets\licenses"
    New-Item -ItemType Directory -Force -Path $licAssets | Out-Null
    Copy-Item (Join-Path $Root "LICENSES\*.txt") $licAssets -Force
    Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $licAssets -Force
    Write-Host "== 许可资产就位（$abi）=="
    # 机密门禁单实现（0.13.8-b ST-06 / F-ENV-08 口径）：check-snapshot-secrets.mjs——跨平台 node
    # 实现，云端链 build-apk.mjs 调用的是同一份；退出码可靠（旧 .ps1 走 cmd /c tar，$LASTEXITCODE
    # 反映 cmd 尾命令而非脚本 exit 码，只能靠输出标记判定）。.ps1 实现已不再被任何链调用。
    Write-Host "== 快照机密门禁（$abi）=="
    node (Join-Path $Root "scripts\check-snapshot-secrets.mjs") $snapIn 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "SNAPSHOT_SECRET_CHECK_FAILED（$abi）：快照含机密，拒绝打包"; continue }
    $wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
    $wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
    wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
    node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $abi 2>&1 | Select-Object -First 3

    # 运行时补丁资产一致性门禁（0.13.8 收尾 / apk #170 复盘）：assets/patched/* 是引擎启动时
    # 覆盖运行树的预打补丁副本，必须与快照同源——否则「构建期 marker 全绿、设备上补丁被改回去」。
    # FX-208.1：按当前 ABI 传参；--require = 快照/资产缺席即失败，不得 SKIP exit 0（旧实现把构建机状态
    # 变成门禁结果）。ST-06：本调用原先落在 foreach 之外（$abi 未定义恒走 x86_64 默认值）——已移进循环。
    Write-Host "== 运行时补丁资产门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-runtime-assets.mjs") $abi --require 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "运行时补丁资产过期或缺失（$abi），拒绝打包（从快照重新生成 assets/patched）"; continue }

    # A1 出厂声明值对账（P-AC-01，--require 严格档）：注入后快照的 profile 清单必须带 patchReload 出厂值。
    Write-Host "== 性能度量入口与 A1 出厂值门禁（$abi，严格）=="
    node (Join-Path $Root "scripts\check-perf-instrumentation.mjs") --require --snapshot $snapIn --abi $abi 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "A1 出厂值/度量入口校验失败（$abi），拒绝打包"; continue }

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
        if (-not (Test-Path $snapIn)) { Write-Host "缺注入后快照 $snapIn，跳过导出（$abi）"; continue }
        $outSnap = Join-Path $Out "snapshot-$abi.tar.xz"
        Copy-Item $snapIn $outSnap -Force
        Set-Content -Path (Join-Path $Out "snapshot-$abi.tar.xz.sha256") -Value ((Get-FileHash $outSnap -Algorithm SHA256).Hash.ToLower()) -NoNewline -Encoding ascii
        Write-Host "快照资产导出: $outSnap"
        $apkOut = Join-Path $Out ("dsh-mobile-apk-v" + $GradleVer + $Suffix + "-" + $abi + ".apk")
        if (Test-Path $apkOut) {
            & (Join-Path $PSScriptRoot "check-snapshot-asset.ps1") -ApkPath $apkOut -SnapshotPath $outSnap
            if ($LASTEXITCODE -ne 0) { Write-Host "快照资产一致性校验失败，拒绝发布组装（$abi）"; $rejectedAbis += $abi; continue }
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
