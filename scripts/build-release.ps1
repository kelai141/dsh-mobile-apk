param(
  [string]$Version = "",
  [string]$Gradle = "gradle",          # gradle command (accepts a GRADLE_USER_HOME-aware wrapper)
  [switch]$SkipGitCheck,                # skip the git dirty-state gate (emergency releases only)
  [switch]$GatesOnly                    # 只跑到门禁段（0.13.8-b：验收/本地核验用，不做插件构建与打包）
)
# build-release.ps1 v2.1 - dual-ABI release build (release/v<v>/{apk,snapshot,plugins}/ + gates)
# Spec: release/README.md; host injection: plugin builds are injected into both snapshots (prevents "fix not compiled into user env")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
# npm cache must stay inside the workspace (sandbox/CI limit: writes outside the workspace are denied)
$env:npm_config_cache = Join-Path $root ".npm-cache"
$relRoot = Join-Path $root "release"
$pluginSrcs = @('dsh-shell-termux','dsh-client-ui-responsive','dsh-host-web-compat')

# 0a) git dirty-state gate (Review 2026-08-18 R5): release artifacts must trace back to committed source.
#     Abort if any repo has uncommitted changes — otherwise tgz/APK ship uncommitted code that can't be diffed for troubleshooting.
$gitRepos = @('dsh-shell-termux','dsh-client-ui-responsive','dsh-host-web-compat','dsh-mobile-apk')
if (-not $SkipGitCheck) {
  foreach ($repo in $gitRepos) {
    $dirty = & git -C (Join-Path $root $repo) status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { throw ("git 不可用或仓库缺失: " + $repo) }
    if ($dirty) {
      throw ("发布中止：$repo 有未提交改动（共 " + ($dirty.Count) + " 项）——请先提交或显式 -SkipGitCheck。`n" +
        ($dirty | Select-Object -First 5 | ForEach-Object { "  " + $_ }) -join "`n")
    }
  }
  Write-Output "== git 工作区干净（4 仓库）"
}

# 0b) 门禁聚合入口（0.13.8-b 批 B2 FX-208.E2 发布链 / F-ENV-13）：发布组装必须跑与打包**同源**的
#     门禁集，而不是只跑机密与 elf（这是 issue #208 的四条漏网路径之一）。
#     先跑静态接线断言（某条链漏接任一门禁立刻中止），再执行门禁集。
$gateAgg = Join-Path $root "scripts\check-release-gates.mjs"
Write-Output "== 发布门禁接线断言（唯一接线面聚合入口）=="
node $gateAgg
if ($LASTEXITCODE -ne 0) { throw "发布门禁接线断言失败，中止组装" }
Write-Output "== 发布门禁集执行（与打包同源）=="
# ST-31：发布链要求 SKIP=0——--require 让每个支持它的门禁把 SKIP 判为失败（不得以 SKIP 结案）。
node $gateAgg --run --require --snapshot-dir (Join-Path $root "dsh-mobile-apk\snapshot")
if ($LASTEXITCODE -ne 0) { throw "发布门禁未通过，中止组装" }
if ($GatesOnly) { Write-Output "== -GatesOnly：门禁段结束（未做插件构建与打包）=="; exit 0 }

# 0) Version (default: the APK versionName)
$apkVer = (Select-String -Path (Join-Path $root "dsh-mobile-apk\app\build.gradle.kts") -Pattern 'versionName = "([^"]+)"').Matches.Groups[1].Value
if ($Version -eq "") { $Version = $apkVer }
$outDir = Join-Path $relRoot ("v" + $Version)
$apkDir = Join-Path $outDir "apk"
$snapDir = Join-Path $outDir "snapshot"
$plugDir = Join-Path $outDir "plugins"
foreach ($d in @($apkDir, $snapDir, $plugDir)) { New-Item -ItemType Directory -Force $d | Out-Null }
Write-Output ("== release v" + $Version + " -> " + $outDir)

# 1) Plugin build + npm pack (artifacts reused for host injection)
foreach ($p in @($pluginSrcs[0], $pluginSrcs[1])) {
  Write-Output ("== build " + $p)
  Push-Location (Join-Path $root $p)
  npm run build 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ($p + " build failed") }
  npm pack --pack-destination $plugDir 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ($p + " pack failed") }
  Pop-Location
}
Push-Location (Join-Path $root $pluginSrcs[2])
npm pack --pack-destination $plugDir 2>$null | Out-Null
Pop-Location

# 2) Snapshot input + host injection (same plugin artifacts) + gates
$snapSrc = Join-Path $root "dsh-mobile-apk\snapshot"
$armSnap = Join-Path $snapSrc "snapshot-arm64.tar.xz"
$x86Snap = Join-Path $snapSrc "snapshot-x86_64.tar.xz"
$ABIS = @(@{n='arm64'; f=$armSnap; expect='aarch64'}, @{n='x86_64'; f=$x86Snap; expect='x86_64'})

foreach ($abi in $ABIS) {
  if (-not (Test-Path $abi.f)) { throw ("快照缺失: " + $abi.f + "（设备侧 make-snapshot.sh 产出后按 ABI 命名放入）") }
  # 2a) ELF arch assertion (read-only extract of a single file into a scratch dir)
  $chkTmp = Join-Path $env:TEMP ("snapchk-" + $abi.n)
  Remove-Item $chkTmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $chkTmp | Out-Null
  tar -xf $abi.f -C $chkTmp "usr/bin/node" 2>$null
  $arch = & node (Join-Path $root "scripts\elf-check.mjs") (Join-Path $chkTmp "usr\bin\node") 2>&1 | Out-String
  if ($arch -notmatch $abi.expect) { throw ("快照架构断言失败: " + $abi.n + " -> " + $arch.Trim()) }
  Remove-Item $chkTmp -Recurse -Force -ErrorAction SilentlyContinue
  # 2b) npm layer assertion
  $hasNpm = & tar -tf $abi.f 2>$null | Select-String "usr/lib/node_modules/@deepseek-ai/dsh/package.json" | Select-Object -First 1
  if (-not $hasNpm) { throw ("快照缺少 npm 层（dsh 引擎未安装）: " + $abi.f) }
  # 2c) Host injection: byte-level tar stream replacement (Python tarfile, zero symlink-metadata loss;
  #     Windows bsdtar needs admin rights to unpack symlinks — silent loss would drop node SONAME libs)
  $injectPy = Join-Path $root "scripts\inject-snapshot.py"
  $outTmp = $abi.f + ".new"
  Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
  $pkgArgs = @()
  foreach ($p in $pluginSrcs) { $pkgArgs += (Join-Path $root $p) }
  python $injectPy $abi.f $outTmp @pkgArgs 2>&1 | Select-Object -Last 3
  if (-not (Test-Path $outTmp)) { throw ("快照注入失败: " + $abi.n) }
  Move-Item $outTmp $abi.f -Force
  Write-Output ("  快照 OK: " + $abi.n + " (" + $abi.expect + " + npm 层 + 插件注入)")
  Copy-Item $abi.f (Join-Path $snapDir ("snapshot-" + $abi.n + ".tar.xz")) -Force
}

# 2e) In-snapshot plugin hash consistency gate (must pass after injection; catches missed injection)
Write-Output "== 快照内插件一致性检查"
$tmp2 = Join-Path $env:TEMP "snap-plugins-check"
Remove-Item $tmp2 -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $tmp2 | Out-Null
tar -xf $armSnap -C $tmp2 "home/.dsh/profiles/web/node_modules/@dsh-android" 2>$null
foreach ($p in $pluginSrcs) {
  $inSnap = Get-ChildItem (Join-Path $tmp2 ("home\.dsh\profiles\web\node_modules\@dsh-android\" + $p + "\lib")) -File -ErrorAction SilentlyContinue | Select-Object -First 1
  $tgz = Get-ChildItem (Join-Path $plugDir ("*" + $p + "*.tgz")) | Select-Object -First 1
  if (-not $inSnap -or -not $tgz) { throw ("  " + $p + ": 快照缺插件或 tgz 缺失"); }
  $tgzTmp = Join-Path $env:TEMP ("tgz-" + $p)
  Remove-Item $tgzTmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tgzTmp | Out-Null
  tar -xzf $tgz.FullName -C $tgzTmp 2>$null
  $inTgz = Get-ChildItem (Join-Path $tgzTmp "package\lib") -File -ErrorAction SilentlyContinue | Select-Object -First 1
  $h1 = (Get-FileHash $inSnap.FullName -Algorithm SHA256).Hash
  $h2 = (Get-FileHash $inTgz.FullName -Algorithm SHA256).Hash
  if ($h1 -ne $h2) { throw ("快照内插件与发布 tgz 不一致（" + $p + "）——宿主注入失败，中止") }
  Write-Output ("  " + $p + " 一致 OK")
}
Remove-Item $tmp2 -Recurse -Force -ErrorAction SilentlyContinue

# 3) Dual-ABI APK build (swap snapshot in assets, build twice)
$assets = Join-Path $root "dsh-mobile-apk\app\src\main\assets\snapshot.tar.xz"
foreach ($abi in @(@{n='arm64-v8a'; f=$armSnap}, @{n='x86_64'; f=$x86Snap})) {
  Write-Output ("== build APK " + $abi.n)
  Copy-Item $abi.f $assets -Force
  # Snapshot fingerprint: the shell compares filesDir/.snapshot-fingerprint at boot and re-extracts the
  # embedded snapshot on mismatch (upgrades auto-update runtime/plugins; v0.10.7 fixed "upgrade not applied").
  $fpPath = Join-Path $root "dsh-mobile-apk\app\src\main\assets\snapshot.sha256"
  $fpValue = (Get-FileHash $abi.f -Algorithm SHA256).Hash.ToLower()
  [IO.File]::WriteAllText($fpPath, $fpValue)
  # ST-04 严格复核：本 ABI 的快照与刚写入的指纹必须逐字节一致（--require：缺件即失败，不得 SKIP）。
  node (Join-Path $root "scripts\check-snapshot-fingerprint.mjs") --require
  if ($LASTEXITCODE -ne 0) { throw ("快照指纹对账失败（" + $abi.n + "）：tar 与声明值不一致，中止组装") }
  Push-Location (Join-Path $root "dsh-mobile-apk")
  & $Gradle assembleDebug --offline --no-daemon --rerun-tasks 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ("APK build failed (" + $abi.n + ")") }
  Pop-Location
  $apk = Get-ChildItem (Join-Path $root "dsh-mobile-apk\app\build\outputs\apk\debug\app-debug.apk") | Select-Object -First 1
  Copy-Item $apk.FullName (Join-Path $apkDir ("dsh-mobile-apk-v" + $Version + "-" + $abi.n + ".apk")) -Force
}

# 4) Snapshot security gate（ST-06 / F-ENV-08 口径：机密门禁只有一份被调用的实现 = .mjs 跨平台版；
# 旧 .ps1 走 cmd /c tar，$LASTEXITCODE 反映 cmd 尾命令而非脚本 exit 码，只能靠输出标记判定）
node (Join-Path $root "scripts\check-snapshot-secrets.mjs") $armSnap
if ($LASTEXITCODE -ne 0) { throw "arm64 快照安全门禁未通过，发布中止" }
node (Join-Path $root "scripts\check-snapshot-secrets.mjs") $x86Snap
if ($LASTEXITCODE -ne 0) { throw "x86_64 快照安全门禁未通过，发布中止" }

# 5) sha256 manifest + notes template
$manifest = @()
foreach ($f in Get-ChildItem $outDir -Recurse -File | Where-Object { $_.Name -ne 'MANIFEST.txt' -and $_.Name -ne 'notes.md' }) {
  $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
  $rel = $f.FullName.Substring($outDir.Length + 1).Replace("\","/")
  $manifest += ($hash + "  " + $rel + "  " + $f.Length)
}
$manifest | Sort-Object | Set-Content (Join-Path $outDir "MANIFEST.txt")
$notes = Join-Path $outDir "notes.md"
if (-not (Test-Path $notes)) {
  $notesContent = @(
    "# v" + $Version + " 发布说明",
    "",
    "## 改动",
    "- ",
    "",
    "## 验证记录（门禁要求：每个 ABI 必须引用验证）",
    "- arm64-v8a: （真机/MuMu 记录）",
    "- x86_64: （MuMu 记录）"
  )
  $notesContent | Set-Content $notes
}
Write-Output ""
Write-Output ("== release 产物: " + $outDir)
Get-ChildItem $outDir -Recurse -File | ForEach-Object { Write-Output ("  " + $_.FullName.Substring($outDir.Length + 1) + "  " + [math]::Round($_.Length / 1MB, 1) + " MB") }
