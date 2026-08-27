param([string]$Serial = "10AF2B0GN0001F2", [string]$Package)
# deploy-embedded.ps1 — embedded-form plugin deploy (run-as com.dsharnessmobile.shell + /data/user/0 paths)
$ErrorActionPreference = "Continue"
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$root = "D:\coding\dsh-mobile"
$pkgDir = Join-Path $root $Package
if (-not (Test-Path (Join-Path $pkgDir "lib\index.js"))) { throw "lib missing — build first" }
$stage = Join-Path $root ".deploy-staging"
$stagePkg = Join-Path $stage $Package
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stagePkg "lib") | Out-Null
Copy-Item (Join-Path $pkgDir "lib\*") (Join-Path $stagePkg "lib") -Recurse -Force
Copy-Item (Join-Path $pkgDir "package.json") $stagePkg -Force
$remote = "/data/local/tmp/" + $Package
& $adb -s $Serial shell "rm -rf $remote" 2>$null | Out-Null
& $adb -s $Serial push $stagePkg "$remote" 2>&1 | Out-Null
$dst = "/data/user/0/com.dsharnessmobile.shell/files/home/.dsh/profiles/web/node_modules/@dsh-android/" + $Package
$inner = "mkdir -p " + (Split-Path $dst -Parent) + " && rm -rf $dst && cp -r $remote $dst && chmod -R a+rX $dst && rm -rf $remote && ls $dst/lib"
& $adb -s $Serial shell "run-as com.dsharnessmobile.shell sh -c '$inner'" 2>&1
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ("deployed " + $Package)
