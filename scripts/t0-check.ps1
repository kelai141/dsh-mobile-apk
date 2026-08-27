param([string]$Serial = "127.0.0.1:16416")
# T0: dump-config assertions (M1.1 first verification step)
$ErrorActionPreference = "Stop"
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$inner = "export PATH=/data/data/com.termux/files/usr/bin; export HOME=/data/data/com.termux/files/home; export LD_LIBRARY_PATH=/data/data/com.termux/files/usr/lib; cd /data/data/com.termux/files/home; node --expose-internals /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config > dumpcfg.txt 2>&1; cat dumpcfg.txt"
$dump = & $adb -s $Serial shell "run-as com.termux sh -c '$inner'" 2>&1 | Out-String
$fail = 0
foreach ($row in @("shell-termux", "bash-sandbox", "permission")) {
  $hit = ($dump -match [regex]::Escape($row))
  Write-Output ("row '{0}': {1}" -f $row, $(if ($hit) { "FOUND" } else { "MISSING" }))
  if (-not $hit) { $fail++ }
}
# Assertion semantics: the shell-termux row exists and is not disabled
if ($dump -match "shell-termux[sS]{0,200}?disabled:s*true") { Write-Output "WARN: shell-termux appears disabled"; $fail++ }
if ($fail -gt 0) { Write-Output "T0 FAIL ($fail)"; exit 1 }
Write-Output "T0 PASS"