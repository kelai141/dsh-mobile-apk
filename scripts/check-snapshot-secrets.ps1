param([string]$SnapshotPath)
# Snapshot sensitive-content gate: must pass before packaging/publishing (no output = pass).
# Checks (path-level filename matches): credentials / sessions / storages / anon-id / settings.yaml / private sourcemaps / npmrc.
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
  # settings.yaml: 0.13.0 C1（Q14=a）起快照内为「非机密 seed 模板」（无 key），
  # 不再因「存在 settings.yaml」即 FAIL；改为内容级校验——模板不得含 sk- 明文 /
  # apiKey: 实际值 / 真实 endpoint key 形态（只允许空 providers 骨架与注释行）。
  $settingsHits = cmd /c ('tar -tJf "' + $SnapshotPath + '" 2>nul | findstr /i /c:"home/.dsh/settings.yaml"')
  if ($settingsHits) {
    $leak = $null
    foreach ($line in $settingsHits) {
      if ($line -match 'sk-|apiKey\s*:\s*\S|api[_-]?key\s*=\s*\S|BEGIN (RSA|OPENSSH|PRIVATE)') {
        $leak = $line; break
      }
    }
    if ($leak) {
      Write-Output ('FAIL[settings-yaml-secret]: ' + $leak)
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
