# continue-v3.ps1 — 复用已校验 snap-final2.tar.xz 完成 v3 APK 打包（门禁复查 -> 许可资产 -> gradle -> 产物）
# 用法：pwsh scripts\continue-v3.ps1 -Abi arm64|x86_64 -Suffix "-v3"
param(
    [Parameter(Mandatory=$true)][string]$Abi,
    [string]$Suffix = "-v3"
)
$ErrorActionPreference = 'Stop'
$Root = "D:\coding\dsh-mobile"
$Out = Join-Path $Root "out\v0.13.0"
$apkDir = Join-Path $Root "dsh-mobile-apk"
$work = Join-Path $Root ".deploy-tmp\build-\13-$Abi"
$snapIn = Join-Path $work "snap-final2.tar.xz"

if (-not (Test-Path $snapIn)) { Write-Host "缺 snap-final2: $snapIn"; exit 2 }

Write-Host "== 门禁复查（$Abi）=="
node (Join-Path $Root "scripts\check-third-party.mjs") (Join-Path $work "x") --tar $snapIn 2>&1 | Select-Object -First 4
if ($LASTEXITCODE -ne 0) { Write-Host "THIRD-PARTY CHECK FAILED，拒绝打包（$Abi）"; exit 3 }
$secretResult = & node (Join-Path $Root "scripts\check-snapshot-secrets.mjs") $snapIn 2>&1 | Out-String
if ($secretResult -match 'FAIL\[' -or $secretResult -match 'CHECK_FAILED') { Write-Host "SNAPSHOT_SECRET_CHECK_FAILED（$Abi）"; exit 4 }
if ($secretResult -notmatch 'CHECK_PASSED') { Write-Host "门禁输出异常（$Abi）：$($secretResult.Trim())" }
$wslPath = $snapIn.Replace('D:', '/mnt/d').Replace('\', '/')
$wslCmd = "tar -tf `"$wslPath`" | grep -cE '^usr/bin/(node|bash|rg|python|perl|ruby|zip|vim|zsh|openssl|socat|busybox)$'; tar -tf `"$wslPath`" | grep -c '^-'"
wsl -e bash -lc $wslCmd 2>$null | Select-Object -First 2
node (Join-Path $Root "scripts\elf-check.mjs") $snapIn $Abi 2>&1 | Select-Object -First 3
if ($LASTEXITCODE -ne 0) { Write-Host "ELF 架构校验失败，拒绝打包（$Abi）"; exit 5 }

$licAssets = Join-Path $apkDir "app\src\main\assets\licenses"
New-Item -ItemType Directory -Force -Path $licAssets | Out-Null
Copy-Item (Join-Path $Root "LICENSES\*.txt") $licAssets -Force
Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") $licAssets -Force
Write-Host "== 许可资产就位（$Abi）=="

Remove-Item (Join-Path $apkDir "app\build\intermediates\assets") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $apkDir "app\build\outputs\apk\debug") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $snapIn (Join-Path $apkDir "app\src\main\assets\snapshot.tar.xz") -Force
$sha = (Get-FileHash $snapIn -Algorithm SHA256).Hash.ToLower()
Set-Content -Path (Join-Path $apkDir "app\src\main\assets\snapshot.sha256") -Value $sha -NoNewline -Encoding ascii
Write-Host "== snapshot.sha256 = $sha =="

Push-Location $apkDir
try {
    & .\gradlew :app:assembleDebug --no-daemon -PversionNameSuffix="$Suffix" 2>&1 | Select-Object -Last 4
    if ($LASTEXITCODE -ne 0) { throw "gradle 构建失败（$Abi）" }
    $ver = "0.13.0$Suffix"
    Copy-Item "app\build\outputs\apk\debug\app-debug.apk" (Join-Path $Out "dsh-mobile-apk-v$ver-$Abi.apk") -Force
    Write-Host "产物: $Out\dsh-mobile-apk-v$ver-$Abi.apk"
} finally {
    Pop-Location
}
Write-Host "=== 完成（$Abi $Suffix）==="
