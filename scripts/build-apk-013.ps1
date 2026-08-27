# build-apk-013.ps1 — 0.13.0 双 ABI APK 本地构建编排（插件注入 → 门禁 → gradle 双 ABI）
# 前置：scripts/build-snapshot-013.mjs 已产出 .deploy-tmp/snapshot-013/<abi>/snapshot.tar.xz
# 用法：pwsh build-apk-013.ps1 [-Suffix ""] [-SkipInject] [-OnlyAbi arm64]
param(
    [string]$Suffix = "-SN-1-13",          # 快照测试后缀；正式版传 ""
    [string]$OnlyAbi = "",
    [switch]$SkipInject
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root "out\v0.13.0"
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
    (Join-Path $Root "plugins\dsh-android-file-open")
)

foreach ($abi in @('arm64', 'x86_64')) {
    if ($OnlyAbi -and $OnlyAbi -ne $abi) { continue }
    $snap = Join-Path $Root ".deploy-tmp\snapshot-013\$abi\snapshot.tar.xz"
    if (-not (Test-Path $snap)) { Write-Host "缺快照 $snap（先跑 build-snapshot-013.mjs）"; continue }
    $work = Join-Path $Root ".deploy-tmp\build-\13-$abi"
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # 1. 插件注入（@dsh-android 专用 + 通用根级包）
    if (-not $SkipInject) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root ".deploy-tmp\plugins") | Out-Null
        # undo-savepoint 注入源：vendor/dsh-undo-savepoint（固化移动端裁剪版——
        # 头部只留快照徽章、移除撤销/恢复快捷键行与全局键盘监听，见其 PATCHES.md 差异表）
        $undo = Join-Path $Root "vendor\dsh-undo-savepoint"
        # marketplace 注入源：vendor/dshmarketplace-plugin（固化修复版，见其 PATCHES.md——
        # 上游 0.1.5 pre-execute 守卫不调 next() 导致全工具崩溃；build 前强制校验修复在场）
        $market = Join-Path $Root "vendor\dshmarketplace-plugin"
        if (-not (Test-Path (Join-Path $undo "package.json"))) { Write-Host "缺 undo 注入源 $undo（git clone lire1131/dsh-undo-savepoint）"; continue }
        if (-not (Test-Path (Join-Path $market "package.json"))) { Write-Host "缺 marketplace 注入源 $market（vendor 固化副本）"; continue }
        # marketplace 修复门禁：非修复版直接拒绝打包（幂等脚本，输出 already fixed / patched ok 即通过）
        node (Join-Path $Root "scripts\patch-marketplace.mjs") (Join-Path $market "lib\index.js") 2>&1 | Select-Object -First 2
        if ($LASTEXITCODE -ne 0) { Write-Host "marketplace 修复校验失败，拒绝打包（$abi）"; continue }
        # undo 移动端适配门禁：非裁剪版（含快捷键行/全局键盘监听）直接拒绝打包
        node (Join-Path $Root "scripts\patch-undo-mobile.mjs") (Join-Path $undo "lib\client.js") --check 2>&1 | Select-Object -First 2
        if ($LASTEXITCODE -ne 0) { Write-Host "undo 移动端裁剪校验失败，拒绝打包（$abi）"; continue }
        Write-Host "== 注入 @dsh-android 插件（$abi）=="
        python (Join-Path $Root "scripts\inject-snapshot.py") $snap (Join-Path $work "snap-injected.tar.xz") @pluginDirs | Select-Object -Last 2
        Write-Host "== 注入根级插件（undo/market）=="
        python (Join-Path $Root "scripts\inject-external-plugins.py") (Join-Path $work "snap-injected.tar.xz") (Join-Path $work "snap-final.tar.xz") $undo $market | Select-Object -Last 2
        # 权威装配覆盖（C2 修复 2026-08-23）：update-snapshot-patch.py 此前是手工步骤，
        # snap-final 停留在 0.12.5 旧装配（缺 undo/market/bridge）。接入自动化，保证
        # 出品的快照 patch === scripts/profile-web.cordis.patch.yml 的当前权威版。
        Write-Host "== 权威 patch 覆盖（$abi）=="
        python (Join-Path $Root "scripts\update-snapshot-patch.py") (Join-Path $work "snap-final.tar.xz") (Join-Path $work "snap-final2.tar.xz") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") | Select-Object -Last 2
        # 防回归（审校 C4 2026-08-23）：patch 挂载集 ⊇ 注入集——缺条目（如 linux-env 漏挂）直接拒打包
        Write-Host "== 挂载集校验（$abi）=="
        node (Join-Path $Root "scripts\check-patch-mounts.mjs") (Join-Path $Root "scripts\profile-web.cordis.patch.yml") @pluginDirs $undo $market 2>&1 | Select-Object -First 4
        if ($LASTEXITCODE -ne 0) { Write-Host "patch 挂载集校验失败，拒绝打包（$abi）"; continue }
        $snapIn = Join-Path $work "snap-final2.tar.xz"
    } else {
        $snapIn = $snap
    }

    # 2. 门禁（关键工具存在性 + ELF 架构 + 🔒 机密 + GPL 合规）
    Write-Host "== 门禁（$abi）=="
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
    $secretResult = & node (Join-Path $Root "scripts\check-snapshot-secrets.mjs") $snapIn 2>&1 | Out-String
    if ($secretResult -match 'FAIL\[' -or $secretResult -match 'CHECK_FAILED') {
        Write-Host "SNAPSHOT_SECRET_CHECK_FAILED（$abi）：快照含机密，拒绝打包"
        ($secretResult -split "`n") | Select-Object -First 6
        continue
    }
    if ($secretResult -notmatch 'CHECK_PASSED') {
        Write-Host "gate 输出异常（$abi）：$($secretResult.Trim())"
    }
    $wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
    $wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
    wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
    node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $abi 2>&1 | Select-Object -First 3
    if ($LASTEXITCODE -ne 0) { Write-Host "ELF 架构校验失败，拒绝打包（$abi）"; continue }

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
        $ver = "0.13.0$Suffix"
        Copy-Item "app\build\outputs\apk\debug\app-debug.apk" (Join-Path $Out "dsh-mobile-apk-v$ver-$abi.apk") -Force
        Write-Host "产物: $Out\dsh-mobile-apk-v$ver-$abi.apk"
    } finally {
        Pop-Location
    }
}
Write-Host "=== 完成。产物目录：$Out ==="
