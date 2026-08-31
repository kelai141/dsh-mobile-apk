param([string]$SnapshotPath)
# Snapshot sensitive-content gate: must pass before packaging/publishing (no output = pass).
# Checks: credentials / sessions / storages / anon-id / settings.yaml 内容级（seed 模板允许，
# 但不得含 sk- 明文 / apiKey 实际值 / 私钥头——0.13.0 C1/Q14）/ 私有源映射 / npmrc。
# 与 check-snapshot-secrets.mjs 语义一致（双仓同规）。退出 0=通过；1=检出敏感内容。
$ErrorActionPreference = 'Continue'
if (-not $SnapshotPath -or -not (Test-Path $SnapshotPath)) { Write-Error 'usage: check-snapshot-secrets.ps1 <snapshot.tar.xz>'; exit 2 }
$fail = 0
function Check($name, $pattern) {
  $hits = cmd /c ('tar -tJf "' + $SnapshotPath + '" 2>nul | findstr /i /c:"' + $pattern + '"') 2>$null
  if ($hits) {
    Write-Output ('FAIL[' + $name + ']: ' + (($hits | Select-Object -First 3) -join '; '))
    $script:fail = 1
  }
}
Check 'credentials' 'home/.dsh/.credentials'
Check 'sessions' 'home/.dsh/sessions/'
Check 'storages' 'home/.dsh/storages/'
Check 'anon-id' '.anonymous-user-id'
  # settings.yaml 内容级校验（0.13.0 C1/Q14）：快照内为「非机密 seed 模板」（空 providers + 注释），
  # 允许文件存在；但从归档提取内容扫描真实凭据形态——命中即拒。
  $hasSettings = cmd /c ('tar -tJf "' + $SnapshotPath + '" 2>nul | findstr /i /c:"home/.dsh/settings.yaml"')
  if ($hasSettings) {
    $content = cmd /c ('tar -xOf "' + $SnapshotPath + '" "home/.dsh/settings.yaml" 2>nul')
    $leak = $content | Select-String -Pattern 'sk-[A-Za-z0-9]{12}|apiKey\s*:\s*\S|api[_-]?key\s*=\s*\S|BEGIN (RSA|OPENSSH|PRIVATE)' | Select-Object -First 1
    if ($leak) {
      # 脱敏后再输出（疑似密钥不落构建日志/工单）：sk-xxx / key 值截断
      $sample = $leak.Line.Trim()
      $sample = [regex]::Replace($sample, '(sk-[A-Za-z0-9]{4})[A-Za-z0-9]+', '$1***')
      $sample = [regex]::Replace($sample, '(api[_-]?key\s*[:=]\s*["'']?[A-Za-z0-9]{4})[A-Za-z0-9]+', '$1***')
      if ($sample.Length -gt 80) { $sample = $sample.Substring(0, 80) + '…' }
      Write-Output ('FAIL[settings-yaml-secret]: ' + $sample)
      $script:fail = 1
    }
  }
  # Sourcemaps: only private plugin packages (@dsh-android) carry custom source in their maps; npm public deps shipping maps is normal.
  $maps = cmd /c ('tar -tJf "' + $SnapshotPath + '" 2>nul | findstr /c:".js.map"')
  $privMaps = @($maps | Where-Object { $_ -match '@dsh-android' })
  if ($privMaps.Count -gt 0) {
    Write-Output ('FAIL[private-sourcemap]: ' + (($privMaps | Select-Object -First 3) -join '; '))
    $script:fail = 1
  }
Check 'npmrc' 'home/.npmrc'
if ($fail -eq 1) { Write-Output 'SNAPSHOT_SECRET_CHECK_FAILED'; exit 1 }
Write-Output 'SNAPSHOT_SECRET_CHECK_PASSED'