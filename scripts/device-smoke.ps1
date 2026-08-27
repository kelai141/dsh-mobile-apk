param([string]$Serial = "127.0.0.1:16416")
# M1.4 staged smoke: T0 config assertions → T1 headless smoke → T2 golden-session regression
$ErrorActionPreference = "Continue"
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$fail = 0
$here = $PSScriptRoot

Write-Output "=== T0: 配置断言 ==="
& (Join-Path $here "t0-check.ps1") -Serial $Serial
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Output ""
Write-Output "=== T1: headless 冒烟（bash 实弹） ==="
$t1 = & $adb -s $Serial shell "run-as com.termux sh /data/data/com.termux/files/home/run-t1.sh" 2>&1 | Out-String
if ($t1 -match "=== EXIT: 0 ===" -and ($t1 -match "total " -or $t1 -match "命令执行成功" -or $t1 -match "目录")) { Write-Output "  T1 PASS" }
else { Write-Output "  T1 FAIL"; Write-Output ($t1.Substring(0, [Math]::Min(300, $t1.Length))); $fail++ }

Write-Output ""
Write-Output "=== T2: 黄金会话回归 ==="
$dir = (& $adb -s $Serial shell "run-as com.termux sh -c 'ls -t /data/data/com.termux/files/home/.dsh/sessions/--data-data-com.termux-files-home--/ | head -1'" 2>$null | Out-String).Trim()
& $adb -s $Serial push (Join-Path $here "golden/extract-seq.mjs") "/data/local/tmp/es2.mjs" 2>$null | Out-Null
& $adb -s $Serial shell "run-as com.termux sh -c 'export PATH=/data/data/com.termux/files/usr/bin; cd /data/data/com.termux/files/home; zstd -d -f .dsh/sessions/--data-data-com.termux-files-home--/$dir/session.jsonl.zstd -o smoke-session.jsonl 2>/dev/null; cp /data/local/tmp/es2.mjs .; node es2.mjs smoke-session.jsonl > last-seq.json'" 2>&1 | Out-Null
$raw = & $adb -s $Serial exec-out run-as com.termux cat /data/data/com.termux/files/home/last-seq.json 2>$null | Out-String
[System.IO.File]::WriteAllText((Join-Path $here "golden/last-run.json"), $raw, [System.Text.UTF8Encoding]::new($false))
$golden = Get-Content (Join-Path $here "golden/session-golden.json") -Raw | ConvertFrom-Json
$last = Get-Content (Join-Path $here "golden/last-run.json") -Raw | ConvertFrom-Json
$gSeq = ($golden | ForEach-Object { $_.name }) -join ","
$lSeq = ($last | ForEach-Object { $_.name }) -join ","
if ($gSeq -eq $lSeq -and $last.Count -gt 0) { Write-Output "  T2 PASS (工具序列: $lSeq)" }
else { Write-Output "  T2 FAIL (golden: $gSeq vs last: $lSeq)"; $fail++ }

Write-Output ""
if ($fail -eq 0) { Write-Output "SMOKE ALL PASS" } else { Write-Output "SMOKE FAIL ($fail)"; exit 1 }