# build-apk-013.ps1 — 0.13.0 双 ABI APK 本地构建编排（插件注入 → 门禁 → gradle 双 ABI）
# 前置：scripts/build-snapshot-013.mjs 已产出 .deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz
# 用法：pwsh build-apk-013.ps1 [-Suffix ""] [-SkipInject] [-OnlyAbi arm64]
param(
    [string]$Suffix = "-SN-1-13",          # 快照测试后缀；正式版传 ""
    [string]$OnlyAbi = "",
    [switch]$SkipInject,
    [switch]$ExportSnapshots,              # 0.13.2 增补：导出注入后快照资产 + 一致性门禁（见第 4 步）
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

# manifest 加固门禁（0.13.8 PR-B3 / apk #183）：allowBackup/NSC/接收器来源校验在场
Write-Host "== manifest 加固门禁 =="
node (Join-Path $Root "scripts\check-manifest-hardening.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "manifest 加固校验失败，拒绝打包"; exit 1 }

# 子进程无界读 grep 门禁（0.13.8 #173）：输出必须走 ProcIo.readBounded
Write-Host "== 有界读门禁 =="
node (Join-Path $Root "scripts\check-bounded-io.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "无界读命中，拒绝打包"; exit 1 }

# 控制协议 V2 往返 + 体积门禁（0.13.8 批 F / DESIGN-PROTOCOL-V2.md §S6）
Write-Host "== 协议 V2 门禁 =="
node (Join-Path $Root "scripts\check-protocol-v2.mjs") 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "协议 V2 门禁失败，拒绝打包"; exit 1 }

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

$pluginDirs = @(
    (Join-Path $Root "dsh-shell-termux"),
    (Join-Path $Root "dsh-client-ui-responsive"),
    (Join-Path $Root "dsh-host-web-compat"),
    # 0.13.0 F1.6/F1.7/F5 四件套（2026-08-23 修复 C3：此前快照仅有 3 个 @dsh-android 包，
    # 而权威 patch 挂载了 bridge/manage/linux-env/file-open → 装配失败/功能缺席）
    (Join-Path $Root "plugins\dsh-android-bridge"),
    (Join-Path $Root "plugins\dsh-android-manage"),
    (Join-Path $Root "plugins\dsh-android-linux-env"),
    (Join-Path $Root "plugins\dsh-android-file-open"),
    # 0.13.5 W3（issue #125）：自定义提供商能力发现——被动端点描述符 + 厂商 schema +
    # 引擎目录精确 id 查表 + 显式批准后的主动探测；字段级写回 llm-pi-ai 模型能力。
    (Join-Path $Root "plugins\dsh-model-capability")
)

foreach ($abi in @('arm64', 'x86_64')) {
    if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
    $snap = Join-Path $Root ".deploy-tmp\snapshot-013\$abi\snapshot.tar.xz"
    if (-not (Test-Path $snap)) { Write-Host "缺快照 $snap（先跑 build-snapshot-013.mjs）"; continue }
    $work = Join-Path $Root ".deploy-tmp\build-\13-$abi"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # 1b. 引擎 overlay 抽验门禁（0.13.3 W1）：登记表在快照内全量落位（版本精确断言 + presets 在场）
    Write-Host "== 引擎 overlay 抽验（$abi）=="
    node (Join-Path $Root "scripts\check-engine-overlay.mjs") $snap 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host "引擎 overlay 抽验失败，拒绝打包（$abi）"; continue }

    # 1. 插件注入（@dsh-android 专用 + 通用根级包）
    if (-not $SkipInject) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".deploy-tmp\plugins") | Out-Null
        # undo-savepoint 注入源：vendor/dsh-undo-savepoint（固化移动端裁剪版——
        # 头部只留快照徽章、移除撤销/恢复快捷键行与全局键盘监听，见其 PATCHES.md 差异表）
        $undo = Join-Path $Root "vendor\dsh-undo-savepoint"
        # marketplace 注入源：vendor/dshmarketplace-plugin（固化修复版，见其 PATCHES.md——
        # 上游 0.1.5 pre-execute 守卫不调 next() 导致全工具崩溃；build 前强制校验修复在场）
        $market = Join-Path $Root "vendor\dshmarketplace-plugin"
        # model-sync 注入源（0.13.3 W7）：vendor/dsh-model-sync（@aiwayds/dsh-model-sync 0.3.1
        # 固化副本，MIT；ZCode 式隐式模型补给，见其 PATCHES.md）
        $modelSync = Join-Path $Root "vendor\dsh-model-sync"
        if (-not (Test-Path (Join-Path $undo "package.json"))) { Write-Host "缺 undo 注入源 $undo（git clone lire1131/dsh-undo-savepoint）"; continue }
        if (-not (Test-Path (Join-Path $market "package.json"))) { Write-Host "缺 marketplace 注入源 $market（vendor 固化副本）"; continue }
        if (-not (Test-Path (Join-Path $modelSync "lib\index.js"))) { Write-Host "缺 model-sync 注入源 $modelSync（vendor 固化副本）"; continue }
        # 统一补丁门禁（Phase 2a）：marketplace A-D + undo E1-E7 幂等施加与校验，
        # 登记表 scripts/patches/registry.json。默认 ensure 语义（缺席即施加，锚点失配拒打包）。
        # 雷点 8：全量输出——Select-First 截断管道会杀 node 致误判失败
        node (Join-Path $Root "scripts\patches\apply-patches.mjs") (Join-Path $Root "vendor") 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "vendor 补丁校验/施加失败，拒绝打包（$abi）"; continue }
        # 单 pass 注入（2c 提速 2026-09-05）：@dsh-android + 根级插件 + 权威 patch 覆盖合并
        # 为一次 tar 流处理——压缩/解压从 ×4 → ×1（原三步各自全量重压缩 ~743MB）。
        # 雷点 8：全量输出。
        Write-Host "== 单 pass 注入（@dsh-android + undo/market + 权威 patch）（$abi）=="
        python (Join-Path $Root "scripts\inject-all.py") $snap (Join-Path $work "snap-final2.tar.xz") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") --dsh-android @pluginDirs --external $undo $market $modelSync 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host "注入失败，拒绝打包（$abi）"; continue }
        # 防回归（审校 C4 2026-08-23）：patch 挂载集 ⊇ 注入集——缺条目（如 linux-env 漏挂）直接拒打包
        Write-Host "== 挂载集校验（$abi）=="
        node (Join-Path $Root "scripts\check-patch-mounts.mjs") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") @pluginDirs $undo $market $modelSync 2>&1 | Select-Object -First 4
        if ($LASTEXITCODE -ne 0) { Write-Host "patch 挂载集校验失败，拒绝打包（$abi）"; continue }
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
            Write-Host "快照权限模式校验失败，拒绝打包（$abi）"; continue
        }
    }
    # 第三方许可合规（GPL 义务 A1/A2 门禁 2026-08-23）：copyleft 包许可证全文须随快照分发，
    # 矩阵须覆盖 dpkg status 全部包；缺失直接拒绝打包（--- tar 视图：9p 权限不影响判定）。
    node (Join-Path $Root "scripts\check-third-party.mjs") (Join-Path $work "x") --tar $snapIn 2>&1 | Select-Object -First 4
    if ($LASTEXITCODE -ne 0) { Write-Host "THIRD-PARTY CHECK FAILED，拒绝打包（$abi）"; continue }
    # 许可资产（LICENSES 标准文本 + notices）打入 APK assets（A2：随包分发）
    $licAssets = Join-Path $apkDir "app\src\main\assets\licenses"
    New-Item -ItemType Directory -Force -Path $licAssets | Out-Null
    Copy-Item (Join-Path $Root "LICENSES\*.txt") $licAssets -Force
    Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $licAssets -Force
    Write-Host "== 许可资产就位（$abi）=="
    # 注：check-snapshot-secrets.ps1 内部走 cmd /c tar，外层 $LASTEXITCODE 不可靠
    # （反映 cmd 尾命令而非脚本 exit 码——PASSED 时可能残留 1 造成误判 continue）。
    # 以脚本输出标记为准。
    $secretResult = & (Join-Path $PSScriptRoot "check-snapshot-secrets.ps1") $snapIn 2>&1 | Out-String
    if ($secretResult -match 'FAIL\[' -or $secretResult -match 'CHECK_FAILED') {
        Write-Host "🔒 SNAPSHOT_SECRET_CHECK_FAILED（$abi）：快照含机密，拒绝打包"
        ($secretResult -split "`n") | Select-Object -First 6
        continue
    }
    if ($secretResult -notmatch 'CHECK_PASSED') {
        Write-Host "⚠️ 门禁输出异常（$abi）：$($secretResult.Trim())"
    }
    $wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
    $wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
    wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
    node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $abi 2>&1 | Select-Object -First 3

    # 3. 双 ABI APK（cp 快照 + 指纹 → gradle assembleDebug）
    Write-Host "== 构建 APK（$abi, suffix=$Suffix）=="
    # 增量打包防护（2026-08-23 修复）：mergeDebugAssets 缓存随 ABI 切换不会失效，
    # 且打包器会在旧 APK 上叠加同名条目（产品曾出现双 snapshot.tar.xz、APK 288MB）——每次迭代前清理。
    Remove-Item (Join-Path $apkDir "app\build\intermediates\assets") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $apkDir "app\build\outputs\apk\debug") -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $snapIn (Join-Path $apkDir "app\src\main\assets\snapshot.tar.xz") -Force
    $sha = (Get-FileHash $snapIn -Algorithm SHA256).Hash.ToLower()
    Set-Content -Path (Join-Path $apkDir "app\src\main\assets\snapshot.sha256") -Value $sha -NoNewline -Encoding ascii
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
            if ($LASTEXITCODE -ne 0) { Write-Host "快照资产一致性校验失败，拒绝发布组装（$abi）"; continue }
        } else {
            Write-Host "警告: 缺 APK $apkOut，跳过一致性校验（$abi）"
        }
    }
}
Write-Host "=== 完成。产物目录：$Out ==="
