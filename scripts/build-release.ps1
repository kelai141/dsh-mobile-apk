param(
  [string]$Version = "",
  [string]$VersionSuffix = "",
  [string]$Gradle = "gradle",          # gradle command (accepts a GRADLE_USER_HOME-aware wrapper)
  [switch]$SkipGitCheck,                # skip the git dirty-state gate (emergency releases only)
  [switch]$GatesOnly,                   # 只跑到门禁段（0.13.8-b：验收/本地核验用，不做插件构建与打包）
  # issue #1705：glibc loader 源目录。缺省取 DSH_NATIVE_LINUX_LOADER_DIR；不给时行为同改动前。
  [string]$NativeLinuxLoaderDir = $env:DSH_NATIVE_LINUX_LOADER_DIR
)
# build-release.ps1 v2.1 - dual-ABI release build (release/v<v>/{apk,snapshot,plugins}/ + gates)
# Spec: release/README.md; host injection: plugin builds are injected into both snapshots (prevents "fix not compiled into user env")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
# npm cache must stay inside the workspace (sandbox/CI limit: writes outside the workspace are denied)
$env:npm_config_cache = Join-Path $root ".npm-cache"
$relRoot = Join-Path $root "release"
$pluginSrcs = @('dsh-shell-termux','dsh-client-ui-responsive','dsh-host-web-compat','plugins/dsh-linux-bootstrap')

# 0a) git dirty-state gate (Review 2026-08-18 R5): release artifacts must trace back to committed source.
#     Abort if any repo has uncommitted changes — otherwise tgz/APK ship uncommitted code that can't be diffed for troubleshooting.
$gitRepos = @('dsh-shell-termux','dsh-client-ui-responsive','dsh-host-web-compat','dsh-mobile-apk')
if (-not $SkipGitCheck) {
  $checked = 0
  foreach ($repo in $gitRepos) {
    $dirty = & git -C (Join-Path $root $repo) status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0) { throw ("git 不可用或仓库缺失: " + $repo) }
    if ($dirty) {
      throw ("发布中止：$repo 有未提交改动（共 " + ($dirty.Count) + " 项）——请先提交或显式 -SkipGitCheck。`n" +
        ($dirty | Select-Object -First 5 | ForEach-Object { "  " + $_ }) -join "`n")
    }
    $checked += 1
  }
  # 协调仓根（0.14.1 §1.1b 决策 1 / §2.4 前置项 2）：上面四个子仓**漏掉了协调仓根自身**——
  # plugins/** 与 scripts/** 有未提交改动不会绊停发布链，而这两处正是注入集与门禁的实现面
  # （漏掉 = 发布产物可追溯到未提交的门禁/插件源码，正是本门禁要防的那种不可 diff 交付）。
  # 布局判定：只有**协调仓布局**（根下存在 dsh-mobile-apk 子仓）才做本检查；apk 自包含树里
  # 根本身就是 apk 仓（已在上面列表中，`dsh-mobile-apk` 子目录不存在）——不做本检查，避免重复。
  # pathspec 限定到**喂给发布产物的目录**：根级未跟踪草稿（.tmp-*、临时截图、研究目录）不属发布面，
  # 不该拦发布；用全仓 status 会把它们当脏（实测根仓有数十项此类未跟踪文件）。
  $coordRoot = Test-Path (Join-Path $root "dsh-mobile-apk")
  if ($coordRoot) {
    $releasePaths = @('plugins','scripts','vendor','LICENSES')
    $dirtyRoot = & git -C $root status --porcelain -- @releasePaths 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git 不可用或协调仓根不是 git 仓库" }
    if ($dirtyRoot) {
      throw ("发布中止：协调仓根有未提交改动（发布面 " + ($releasePaths -join '/') + "，共 " + ($dirtyRoot.Count) + " 项）——请先提交或显式 -SkipGitCheck。`n" +
        ($dirtyRoot | Select-Object -First 5 | ForEach-Object { "  " + $_ }) -join "`n")
    }
    $checked += 1
  }
  Write-Output ("== git 工作区干净（" + $checked + " 个仓库面）")
}

# 0b) 门禁聚合入口（0.13.8-b 批 B2 FX-208.E2 发布链 / F-ENV-13）：发布组装必须跑与打包**同源**的
#     门禁集，而不是只跑机密与 elf（这是 issue #208 的四条漏网路径之一）。
#     先跑静态接线断言（某条链漏接任一门禁立刻中止），再执行门禁集。
$gateAgg = Join-Path $root "scripts\check-release-gates.mjs"
Write-Output "== 发布门禁接线断言（唯一接线面聚合入口）=="
node $gateAgg
if ($LASTEXITCODE -ne 0) { throw "发布门禁接线断言失败，中止组装" }
# G.0 ① 净冗余消除（0.14.2-fx-2，用户裁定「裁剪掉无意义校验」）：**发布路径不再在注入前输入上复跑整套门禁**。
# 真因（实测）：这两个输入 tar 由 build-apk-013.ps1 产出，而它**已经**对它们跑过自己的内联门禁集；
# 本脚本第 2f) 段还会对**真正的发布物**（注入后 tar）再跑一次同一套 `--run --require`。
# 原先这里（第 60 行）再跑一遍 = 同一批门禁在三种输入上各跑一次，而本段输入既不是发布物、也不是唯一输入面 ⇒ 净冗余。
# 不可裁面：门禁集本身仍在发布关键路径上（2f 对发布物逐 ABI 跑，--require 严格档），本段只是去掉它的副本。
if ($GatesOnly) {
  # -GatesOnly 是「只跑门禁、不打包」的验收档，此时 2f) 不会执行，故本档仍需在此跑一次。
  Write-Output "== 发布门禁集执行（-GatesOnly 档，与打包同源）=="
  node $gateAgg --run --require --snapshot-dir (Join-Path $root "dsh-mobile-apk\snapshot")
  if ($LASTEXITCODE -ne 0) { throw "发布门禁未通过，中止组装" }
  Write-Output "== -GatesOnly：门禁段结束（未做插件构建与打包）=="; exit 0
}

# 0) Version (default: the APK versionName)
$apkVer = (Select-String -Path (Join-Path $root "dsh-mobile-apk\app\build.gradle.kts") -Pattern 'versionName = "([^"]+)"').Matches.Groups[1].Value
$versionArgs = @('--base', $apkVer)
if ($Version) { $versionArgs += @('--version', $Version) }
if ($VersionSuffix) { $versionArgs += @('--suffix', $VersionSuffix) }
$versionResolution = & node (Join-Path $root "scripts\resolve-version-suffix.mjs") @versionArgs
if ($LASTEXITCODE -ne 0) { throw "版本参数必须基于 Gradle versionName；完整版本号不能重复作为 versionNameSuffix" }
$versionResolution = ($versionResolution -join "`n") | ConvertFrom-Json
$Version = $versionResolution.version
$VersionSuffix = $versionResolution.suffix
node --test (Join-Path $root "scripts\check-apk-signatures.test.mjs") (Join-Path $root "scripts\resolve-version-suffix.test.mjs") (Join-Path $root "scripts\build-apk-engine.test.mjs")
if ($LASTEXITCODE -ne 0) { throw "APK scheme/version regression tests failed" }
$outDir = Join-Path $relRoot ("v" + $Version)
$apkDir = Join-Path $outDir "apk"
$snapDir = Join-Path $outDir "snapshot"
$plugDir = Join-Path $outDir "plugins"
foreach ($d in @($apkDir, $snapDir, $plugDir)) { New-Item -ItemType Directory -Force $d | Out-Null }
# Release output is regenerated as a unit. Old APKs must not survive into this version's
# directory-wide signature check or MANIFEST, even when a prior build used a different ABI set.
Get-ChildItem $apkDir -Filter '*.apk' -File -Recurse | Remove-Item -Force
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
  # 2c) Host injection —— G.0 ② 净冗余消除（0.14.2-fx-2）：**输入已是注入后产物时跳过重复注入**。
  #     判据（正向事实，不是「大概齐」）：tar 里已存在注入集插件路径
  #     `home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-bridge/lib/` ⇒ 该输入就是
  #     build-apk-013.ps1 导出的**注入后**快照（发布链的输入正是它），再注入一遍是纯重复
  #     （每 ABI 全量重打包约 743MB），且下方 2e) 会逐字节核对「插件确实在快照里且与发布 tgz 同源」
  #     ——即「是否真的注入过」仍由门禁守着，不靠这里重做一遍来保证。
  $alreadyInjected = & tar -tf $abi.f 2>$null | Select-String "home/.dsh/profiles/web/node_modules/@dsh-android/dsh-android-bridge/lib/" | Select-Object -First 1
  if ($alreadyInjected) {
    Write-Output ("  注入跳过（输入已是注入后产物，2e 逐字节复核）: " + $abi.n)
  } else {
    # 字节级 tar 流替换（Python tarfile，零符号链接元数据损失）——
    # Windows bsdtar 解软链需管理员权限，静默丢链会丢 node 的 SONAME 库。
    $injectPy = Join-Path $root "scripts\inject-snapshot.py"
    $outTmp = $abi.f + ".new"
    Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
    $pkgArgs = @()
    foreach ($p in $pluginSrcs) { $pkgArgs += (Join-Path $root $p) }
    # issue #1613：python 的退出码此前被**完全丢弃**——旧写法是「管道直连 Select-Object 后只判
    # Test-Path $outTmp」。inject-snapshot.py 用 tarfile 流式写 .new，中途抛错（磁盘满 / 条目损坏 /
    # 权限）会留下一个**存在但截断**的 .new，紧接着 Move-Item 就把原输入覆盖掉：一次注入失败 +
    # 一次成功的下游重跑，输入位里就是那份截断件（下游 2f 拦得住「解不开」，拦不住「解得开、少一批条目」）。
    #
    # 现在三层，全部是**行为判据**，缺一即拒绝覆盖：
    #   ① 退出码：不直连管道（会吞 $LASTEXITCODE），先收进变量再截尾打印；
    #   ② 完成标记 + 字节数：脚本写完 dst 才打印 written: <dst> <bytes>，该行在场且文件实际字节
    #      与之相等，才证明「写完了」而不是「写了一半」；
    #   ③ 成员数对账：用**另一个解码器**（系统 bsdtar）数条目，产物少于输入即拒（截断件通常少一批）。
    $injectOut = python $injectPy $abi.f $outTmp @pkgArgs 2>&1
    $injectCode = $LASTEXITCODE
    ($injectOut | Select-Object -Last 3) | Out-Host
    if ($injectCode -ne 0) {
        Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
        throw ("快照注入失败: " + $abi.n + "（python exit " + $injectCode + "）")
    }
    if (-not (Test-Path $outTmp)) { throw ("快照注入失败: " + $abi.n + "（python exit 0 但无产物）") }
    $writtenLine = @($injectOut | Where-Object { $_ -match '^written: ' } | Select-Object -Last 1)
    if ($writtenLine.Count -eq 0) {
        Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
        throw ("快照注入失败: " + $abi.n + "（python exit 0 但没有完成标记 written: —— 拒绝用未写完的产物覆盖输入）")
    }
    $writtenBytes = [int64]($writtenLine[0] -replace '^written:\s+\S+\s+', '')
    $actualBytes = (Get-Item $outTmp).Length
    if ($writtenBytes -ne $actualBytes) {
        Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
        throw ("快照注入产物被截断: " + $abi.n + "（脚本报 " + $writtenBytes + " 字节，实际 " + $actualBytes + "）")
    }
    # ③ 成员数对账走独立门禁（scripts/check-injection-output.mjs，自带 --self-test 的 1 正控 + 3 负控）：
    #    判据本体是「产物条目数 >= 输入」，且两侧都**读得出**成员清单——读不出不等于零条目。
    #    为什么单独成脚本：这条判据要能被反证（截断件 / 解不开 / 输入读不出三种负控），
    #    写在 ps1 里就只剩「跑过没红」这一层证据。
    node (Join-Path $root "scripts\check-injection-output.mjs") $abi.f $outTmp 2>&1 | Out-Host
    $injectVerifyCode = $LASTEXITCODE
    if ($injectVerifyCode -ne 0) {
        Remove-Item $outTmp -Force -ErrorAction SilentlyContinue
        throw ("快照注入产物完整性门禁未通过: " + $abi.n + "（exit " + $injectVerifyCode + "）——拒绝覆盖原快照")
    }
    Move-Item $outTmp $abi.f -Force
    Write-Output ("  快照 OK: " + $abi.n + " (" + $abi.expect + " + npm 层 + 插件注入)")
  }
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

# 2f) 注入后产物门禁（review §2.3，2026-09-14）：0b 的聚合入口跑在宿主注入之前（验的是**输入**快照），
#     而发布物是注入后的 tar——在发布快照上复跑聚合入口（--snapshot-dir 指向 $snapDir），并补跑
#     不在声明集合里的长驻产物门禁（挂载集 / overlay 抽验 / 权限模式 / 第三方合规）。
Write-Output "== 注入后产物门禁（发布物级复跑）=="
node $gateAgg --run --require --snapshot-dir $snapDir
if ($LASTEXITCODE -ne 0) { throw "注入后产物门禁未通过，中止组装" }
$pluginManifestAll = Get-Content (Join-Path $root "scripts\plugin-dirs.json") -Raw | ConvertFrom-Json
$pluginDirsAll = @($pluginManifestAll.dirs | ForEach-Object { Join-Path $root $_ })
$externDirsAll = @($pluginManifestAll.externals | ForEach-Object { Join-Path $root $_ })
node (Join-Path $root "scripts\check-patch-mounts.mjs") (Join-Path $root "scripts\profile-web.cordis.patch.yml") @pluginDirsAll @externDirsAll 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "注入后 patch 挂载集校验失败，中止组装" }
foreach ($s in @(@{n='arm64'; f=$armSnap}, @{n='x86_64'; f=$x86Snap})) {
  node (Join-Path $root "scripts\check-engine-overlay.mjs") $s.f 2>&1 | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) { throw ("注入后引擎 overlay 抽验失败: " + $s.n) }
  node (Join-Path $root "scripts\check-snapshot-file-modes.mjs") $s.f 2>&1 | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) { throw ("注入后快照权限模式校验失败: " + $s.n) }
}
node (Join-Path $root "scripts\check-third-party.mjs") x --tar $x86Snap 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "注入后第三方合规校验失败（x86_64）" }
Write-Output "  注入后产物门禁全部通过"

# 3) Dual-ABI APK build (swap snapshot in assets, build twice)
foreach ($abi in @(@{n='arm64-v8a'; f=$armSnap}, @{n='x86_64'; f=$x86Snap})) {
  Write-Output ("== build APK " + $abi.n)
  # The release assembler shares the terminal build engine but keeps its
  # release snapshot/plugin gates and release/v<version>/apk artifact layout.
  # This job still builds once; the publish job only verifies/uploads this artifact.
  $gradleCommand = $Gradle
  if ($gradleCommand -eq "gradle") { $gradleCommand = ".\gradlew.bat" }
  $engineArgs = @(
    (Join-Path $root "scripts\build-apk-engine.mjs"), "assemble",
    "--snapshot", $abi.f,
    "--apk-dir", (Join-Path $root "dsh-mobile-apk"),
    "--output-dir", $apkDir,
    "--artifact-name", ("dsh-mobile-apk-v" + $Version + "-" + $abi.n + ".apk"),
    "--gradle", $gradleCommand
  )
  # Empty native arguments are dropped by Windows PowerShell and would shift the following
  # option into the suffix value. The engine defaults to an empty suffix when omitted.
  if (-not [string]::IsNullOrEmpty($VersionSuffix)) { $engineArgs += @("--suffix", $VersionSuffix) }
  # issue #1705：ABI 与 loader 源目录。本循环的 $abi.n 是 APK 口径（arm64-v8a / x86_64），
  # 引擎的 normalizeLoaderAbi 认这种写法；分档与产物断言都在引擎里，本脚本不重复实现。
  $engineArgs += @("--abi", $abi.n)
  if ($NativeLinuxLoaderDir) {
    if (-not (Test-Path $NativeLinuxLoaderDir)) { throw ("loader 源目录不在场: " + $NativeLinuxLoaderDir + "（issue #1705）") }
    $engineArgs += @("--native-linux-loader-dir", $NativeLinuxLoaderDir)
    Write-Output ("== glibc loader (" + $abi.n + "): " + $NativeLinuxLoaderDir)
  }
  node @engineArgs
  if ($LASTEXITCODE -ne 0) { throw ("APK build engine failed (" + $abi.n + ")") }
}

# Verify the exact APK files in the final release directory before MANIFEST/upload assembly.
Write-Output "== final APK signing gate (v1 + v2 + v3) =="
$signatureGate = Join-Path $root "scripts\check-apk-signatures.mjs"
node $signatureGate --self-test
if ($LASTEXITCODE -ne 0) { throw "APK signature gate self-test failed" }
node (Join-Path $root "scripts\build-apk-engine.mjs") verify --dir $apkDir --skip-self-test
if ($LASTEXITCODE -ne 0) { throw "A final release APK is missing a required v1/v2/v3 signature" }

# 4) Snapshot security gate —— G.0 ④ 冗余消除（0.14.2-fx-2）：**本段不再单独跑**。
#
# 真因（实测）：上面 2f) 的 `node $gateAgg --run --require --snapshot-dir $snapDir` 已经对**同一个** $snapDir
# 里的两个 tar 逐 ABI 跑了 check-snapshot-secrets（聚合入口的 secrets 分支对 abis 循环，且带 --require 严格档）。
# 而本段原先的两条直接调用读的是 $armSnap / $x86Snap —— 它们正是第 118 行 `Copy-Item $abi.f $snapDir` 的**源**，
# 即**逐字节同一份文件**。故本段是纯重复执行：单次 72.7s，一次发版白付约 145s，且**严格度更低**
# （不带 --require，缺件时可能以非严格口径结案）——重复 + 更弱，属净损失。
# 收敛后 secrets 在发布链上的执行遍数：注入前聚合 2 遍（每 ABI 一次，输入是注入前 tar）+ 注入后聚合 2 遍
# （每 ABI 一次，输入是发布物 tar）；两个输入面**内容不同**、都必须验，故保留。本段删除的只是它们的副本。
# 不可裁面声明：机密门禁本身仍在发布关键路径上（聚合入口 --run --require），只是不再跑第三遍。

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
