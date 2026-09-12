<#
measure-steady.ps1 — 冷启动 + 稳态 CPU + 金属观测（性能 A1/C1 的统一度量入口）。

口径（docs/ANDROID-RUNTIME-PERF-2026-09-12.md 附录 A.1，与 P-AC-04 一致）：
  - 引擎就绪判定 = **设备自身** /proc/net/tcp 出现 0100007F:0C08 ... 0A（127.0.0.1:3080 LISTEN）；
    不使用 adb forward，避免「转发端口看起来通了」的假阳性（P-AC-04 明确禁用 adb forward 判定）。
  - 稳态 CPU = 引擎 node 进程 /proc/<pid>/stat 的 utime+stime 差分（USER_HZ=100 → 1 tick = 10ms）。
输出为 k=v 行（可被 CI/日志采集直接 grep），退出码：0 成功；2 用法/adb 不可用；1 有 FAIL。

用法：
  pwsh -File scripts/perf/measure-steady.ps1 -Serial 127.0.0.1:16416 -Label a1-startup [-IdleSec 30]
  pwsh -File scripts/perf/measure-steady.ps1 -DryRun -Label smoke   # 只打印将要执行的命令（离线自检）
#>
param(
  [string]$Serial = "",
  [string]$Label = "unlabeled",
  [int]$IdleSec = 30,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$pkg = 'com.dsharnessmobile.shell'
$act = "$pkg/.MainActivity"

function Invoke-Adb([string[]]$argv) {
  if ($DryRun) { Write-Output ("DRY adb -s " + $Serial + " " + ($argv -join ' ')); return "" }
  (& adb -s $Serial @argv 2>&1) -join "`n"
}

Write-Output "label=$Label serial=$Serial idleSec=$IdleSec"
Write-Output "pkg=$pkg"

if ($DryRun) {
  Invoke-Adb @('shell','am','force-stop',$pkg) | Out-Null
  Invoke-Adb @('shell','am','start','-W','-n',$act) | Out-Null
  Invoke-Adb @('shell','cat','/proc/net/tcp') | Out-Null
  Write-Output "engineListenMs=<int|空=未就绪>"
  Write-Output "idleCpuPercent=<float>"
  Write-Output "threads=<int> rssMiB=<float> rssPeakMiB=<float>"
  Write-Output "MEASURE-STEADY DRY-RUN OK"
  exit 0
}

if (-not $Serial) { Write-Error "缺 -Serial（设备序列号，如 127.0.0.1:16416）"; exit 2 }
$probe = Invoke-Adb @('get-state')
if ($probe -notmatch 'device') { Write-Error "adb 设备不可用: $probe"; exit 2 }

Invoke-Adb @('shell','am','force-stop',$pkg) | Out-Null
Start-Sleep -Seconds 4
$t0 = Get-Date
Invoke-Adb @('shell','am','start','-W','-n',$act) | Out-Null
$listen = $null
for ($i = 0; $i -lt 480; $i++) {
  if (((Invoke-Adb @('shell','cat','/proc/net/tcp')) -match '0100007F:0C08\s+00000000:0000\s+0A')) {
    $listen = [int]((Get-Date) - $t0).TotalMilliseconds
    break
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "engineListenMs=$listen"

function NodeStats {
  $ps = (Invoke-Adb @('shell','ps','-A','-o','PID,PPID,RSS,NAME')) -split "`n"
  $line = $ps | Where-Object { $_ -match '\snode\s*$' } | Select-Object -First 1
  if (-not $line) { return $null }
  $npid = ($line.Trim() -split '\s+')[0]
  $st = Invoke-Adb @('shell','cat',"/proc/$npid/status")
  $o = [ordered]@{ pid = $npid }
  if ($st -match 'Threads:\s*(\d+)') { $o.threads = [int]$Matches[1] }
  if ($st -match 'VmRSS:\s*(\d+) kB') { $o.rssMiB = [math]::Round([int]$Matches[1] / 1024, 1) }
  if ($st -match 'VmHWM:\s*(\d+) kB') { $o.rssPeakMiB = [math]::Round([int]$Matches[1] / 1024, 1) }
  $f = (Invoke-Adb @('shell','cat',"/proc/$npid/stat")) -split '\s+'
  if ($f.Count -gt 16) { $o.cpuTicks = [int]$f[13] + [int]$f[14] }
  return $o
}

$n0 = NodeStats
Start-Sleep -Seconds $IdleSec
$n1 = NodeStats
if ($n0 -and $n1 -and $null -ne $n0.cpuTicks -and $null -ne $n1.cpuTicks) {
  Write-Output ("idleCpuPercent=" + [math]::Round((($n1.cpuTicks - $n0.cpuTicks) * 10) / ($IdleSec * 1000) * 100, 2))
} else {
  Write-Output "idleCpuPercent=<引擎 node 进程未找到>"
}
if ($n1) { Write-Output ("threads=" + $n1.threads + " rssMiB=" + $n1.rssMiB + " rssPeakMiB=" + $n1.rssPeakMiB) }
Write-Output "MEASURE-STEADY DONE"
