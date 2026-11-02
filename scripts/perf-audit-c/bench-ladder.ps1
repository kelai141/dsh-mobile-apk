# scripts/perf-audit-c/bench-ladder.ps1
# 解压成本归因梯：nullsink -> nopath -> noperms -> full，每级只加一件事。
# 相邻两级之差 = 那一层的真实成本；这不是估算，是同一份输入、同一段循环的实测差分。
param([int]$Runs = 3, [string]$Variants = 'nullsink,nopath,noperms,full')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cp = 'D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\perf-audit\scripts\perf-audit-c\jvm\classes;C:\Users\17765\.gradle\caches\modules-2\files-2.1\org.apache.commons\commons-compress\1.28.0\e482f2c7a88dac3c497e96aa420b6a769f59c8d7\commons-compress-1.28.0.jar;C:\Users\17765\.gradle\caches\modules-2\files-2.1\org.tukaani\xz\1.10\1be8166f89e035a56c6bfc67dbc423996fe577e2\xz-1.10.jar;C:\Users\17765\.gradle\caches\modules-2\files-2.1\commons-io\commons-io\2.20.0\36f3474daec2849c149e877614e7f979b2082cd2\commons-io-2.20.0.jar;C:\Users\17765\.gradle\caches\modules-2\files-2.1\org.apache.commons\commons-lang3\3.18.0\fb14946f0e39748a6571de0635acbe44e7885491\commons-lang3-3.18.0.jar'
$archive = 'D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets\snapshot.tar.xz'
$tmp = Join-Path $env:TEMP 'dsh-perf-c-ladder'
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out ('bench-ladder-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
'# ladder ' + (Get-Date -Format o) + ' archive=' + $archive | Tee-Object -FilePath $log
foreach ($v in $Variants.Split(',')) {
  for ($i = 1; $i -le $Runs; $i++) {
    $d = Join-Path $tmp ($v + '-' + $i)
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $line = (& java -Xmx384m -cp $cp ExtractBench $archive $v $d 2>&1) -join ' '
    $sw.Stop()
    $files = 0; $bytes = 0
    if ($v -ne 'nullsink') {
      $m = Get-ChildItem $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
      $files = $m.Count; $bytes = $m.Sum
    }
    $s = $line
    Write-Output $s
    Add-Content -Path $log -Value $s -Encoding UTF8
    $s2 = '  wall-ms=' + [int]$sw.Elapsed.TotalMilliseconds + ' ondisk-files=' + $files + ' ondisk-bytes=' + $bytes
    Write-Output $s2
    Add-Content -Path $log -Value $s2 -Encoding UTF8
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
  }
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
'# done ' + (Get-Date -Format o) | Tee-Object -FilePath $log -Append
Write-Output ('LOG=' + $log)
