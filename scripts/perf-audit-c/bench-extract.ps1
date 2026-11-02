# scripts/perf-audit-c/bench-extract.ps1
# 冷启动路径 C1 的核心测量：内嵌快照 xz 解压的真实吞吐。
#
# 为什么要在宿主机上跑 JVM 而不是「估」：Android 侧用的正是
#   org.apache.commons.compress 1.28.0 + org.tukaani:xz 1.10（纯 Java 解码器，见 app/build.gradle.kts:122-123）
# 同一对 jar、同一段解压循环（ExtractBench 逐行复刻 SnapshotExtractor.extractEntries）。
# 因此宿主机 JVM 读数不是「类比」，而是同一份算法的上界（手机会更慢，不会更快）。
#
# 用法： pwsh -File scripts/perf-audit-c/bench-extract.ps1 [-Runs 5] [-Archive <path>]
#
# 输出： scripts/perf-audit-c/out/bench-<timestamp>.txt（原始逐次读数，报告引用的就是这个文件）

param(
  [int]$Runs = 5,
  [string]$Archive = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = (Get-Location).Path
if ([string]::IsNullOrEmpty($Archive)) {
  $Archive = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'app\src\main\assets\snapshot.tar.xz'
  if (-not (Test-Path $Archive)) {
    # 工作区里 assets/snapshot.tar.xz 被 gitignore：回落到主工作区的真实产物（只读）。
    $Archive = 'D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets\snapshot.tar.xz'
  }
}
if (-not (Test-Path $Archive)) { throw "archive not found: $Archive" }

$gc = Join-Path $env:USERPROFILE '.gradle\caches\modules-2\files-2.1'
$jars = @(
  (Join-Path $gc 'org.apache.commons\commons-compress\1.28.0\e482f2c7a88dac3c497e96aa420b6a769f59c8d7\commons-compress-1.28.0.jar'),
  (Join-Path $gc 'org.tukaani\xz\1.10\1be8166f89e035a56c6bfc67dbc423996fe577e2\xz-1.10.jar'),
  (Join-Path $gc 'commons-io\commons-io\2.20.0\36f3474daec2849c149e877614e7f979b2082cd2\commons-io-2.20.0.jar'),
  (Join-Path $gc 'org.apache.commons\commons-lang3\3.18.0\fb14946f0e39748a6571de0635acbe44e7885491\commons-lang3-3.18.0.jar')
)
foreach ($j in $jars) { if (-not (Test-Path $j)) { throw "missing jar: $j" } }
$cp = (@((Join-Path $here 'jvm\classes')) + $jars) -join ';'

$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $out "bench-$stamp.txt"

$tmpRoot = Join-Path $env:TEMP 'dsh-perf-c'
$free = (Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='" + (Split-Path -Qualifier $tmpRoot) + "'")).FreeSpace

function Write-Both([string]$s) { Write-Output $s; Add-Content -Path $log -Value $s -Encoding UTF8 }

Write-Both "# bench-extract $(Get-Date -Format o)"
Write-Both "# host: $env:COMPUTERNAME  java: $((& java -version 2>&1 | Select-Object -First 1))"
Write-Both "# archive: $Archive  bytes: $((Get-Item $Archive).Length)"
Write-Both "# note: 宿主并发负载下测得（同机另有 3 个审计 agent 在跑），绝对值可能偏高；相对比较有效。"
Write-Both "# free on $((Split-Path -Qualifier $tmpRoot)): $([math]::Round($free/1GB,1)) GB"

# --- 负控：同一份输入，换解码器实现。若尺子失明，这两种实现会读出同一读数。 ---
Write-Both ''
Write-Both '## NEGATIVE-CONTROL: native liblzma (xz.exe -t) vs pure-java tukaani xz'
for ($i = 1; $i -le $Runs; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & xz -t $Archive 2>$null
  $sw.Stop()
  Write-Both ("ctrl-native-xz-t run=$i ms=" + [int]$sw.Elapsed.TotalMilliseconds + " exit=" + $LASTEXITCODE)
}

# --- 各变体逐次计时 ---
function Invoke-Variant([string]$variant, [int]$runs, [string]$heap) {
  Write-Both ''
  Write-Both "## variant=$variant runs=$runs"
  for ($i = 1; $i -le $runs; $i++) {
    $dest = Join-Path $tmpRoot ("dest-" + $variant + "-" + $i)
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $line = & java "-Xmx$heap" -cp $cp ExtractBench $Archive $variant $dest 2>&1
    Write-Both ($line -join ' ')
    if ($variant -ne 'nullsink' -and $variant -ne 'digest') {
      $files = (Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
      Write-Both ("  dest-files=" + $files)
      Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
    }
    if ($variant -eq 'digest') { Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue }
  }
}

Invoke-Variant 'digest'   $Runs '256m'
Invoke-Variant 'nullsink' $Runs '512m'

Write-Both ''
Write-Both "# done $(Get-Date -Format o)"
Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
Write-Output "LOG=$log"
