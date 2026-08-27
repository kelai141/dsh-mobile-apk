param(
  [string]$Serial = "127.0.0.1:16416",
  [string]$Package = "dsh-shell-termux",
  [string]$Profile = "web"
)
# Deploy one built adapter package into the device profile node_modules and restart dsh web.
# The plugin must live at the profile layer (isolated from engine upgrades); dependencies resolve to the main app copy via dsh's healed node_modules fallback.
$ErrorActionPreference = "Continue"
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$pkgDir = Join-Path $PSScriptRoot "..\$Package"
if (-not (Test-Path (Join-Path $pkgDir "lib\index.js"))) { throw "$Package lib/index.js missing — run scripts/build.mjs first" }

# 1) staging: runtime artifacts only (exclude node_modules/.git/src/tsconfig/lockfile)
$stage = Join-Path $PSScriptRoot "..\.deploy-staging"
$stagePkg = Join-Path $stage $Package
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stagePkg "lib") | Out-Null
Copy-Item (Join-Path $pkgDir "lib\*") (Join-Path $stagePkg "lib") -Recurse -Force
Copy-Item (Join-Path $pkgDir "package.json") $stagePkg -Force
Copy-Item (Join-Path $pkgDir "README.md") $stagePkg -Force -ErrorAction SilentlyContinue

# 2) push to device temp dir + copy into profile node_modules
$remote = "/data/local/tmp/$Package"
& $adb -s $Serial shell "rm -rf $remote" 2>$null | Out-Null
& $adb -s $Serial push $stagePkg "$remote" 2>&1 | Out-Null
$inner = "mkdir -p /data/data/com.termux/files/home/.dsh/profiles/$Profile/node_modules/@dsh-android && rm -rf /data/data/com.termux/files/home/.dsh/profiles/$Profile/node_modules/@dsh-android/$Package && cp -r /data/local/tmp/$Package /data/data/com.termux/files/home/.dsh/profiles/$Profile/node_modules/@dsh-android/$Package && chmod -R a+rX /data/data/com.termux/files/home/.dsh/profiles/$Profile/node_modules/@dsh-android/$Package && rm -rf /data/local/tmp/$Package && ls /data/data/com.termux/files/home/.dsh/profiles/$Profile/node_modules/@dsh-android/$Package"
& $adb -s $Serial shell "run-as com.termux sh -c '$inner'" 2>&1
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Output "deployed $Package -> profile node_modules; restarting dsh web"
& (Join-Path $PSScriptRoot "..\web-restart.ps1") -Serial $Serial 2>&1