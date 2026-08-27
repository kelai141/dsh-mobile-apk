# push-retry.ps1 — 通用推送脚本（网络不稳时指数退避重试）
# 用法:
#   ./scripts/push-retry.ps1 [-Repo <path>] [-Branch <name>] [-MaxTries <n>] [-Wait <s>]
#   ./scripts/push-retry.ps1 -All          # 推送所有子仓库当前分支 + root
#   ./scripts/push-retry.ps1 -Repo dsh-mobile-apk -Branch release/v0.12.4 -MaxTries 20
# 行为:
#   - 先探活 github.com（最多 5 次，间隔 10s），不通则等待
#   - push 失败（网络/非快进）按指数退避重试（Wait * 2^n，上限 300s）
#   - 非网络错误（如 non-fast-forward）直接报错退出，不重试
param(
  [string]$Repo = "",            # 仓库目录名（相对 root）或绝对路径；空 = root
  [string]$Branch = "",          # 目标分支；空 = 当前分支
  [int]$MaxTries = 15,
  [int]$Wait = 20,               # 初始等待秒数（指数退避）
  [string]$Proxy = "",           # 显式代理（如 http://127.0.0.1:7897）；空 = 自动探测 WinINET
  [switch]$All                   # 推送所有已知仓库
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# 自动探测系统代理（WinINET）：浏览器能开但 git 直连被重置时，走代理推送。
function Get-EffectiveProxy {
  if ($Proxy -ne "") { return $Proxy }
  try {
    $reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($reg.ProxyEnable -eq 1 -and $reg.ProxyServer) { return "http://" + $reg.ProxyServer }
  } catch { }
  return ""
}

function Test-GitHub([string]$proxy, [int]$probeMax = 5) {
  for ($i = 1; $i -le $probeMax; $i++) {
    try {
      $args = @('-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '10')
      if ($proxy) { $args += @('-x', $proxy) } else { $args += @('--noproxy', '*') }
      $code = & curl.exe @args 'https://github.com/' 2>$null
      if ($code -eq '200') { return $true }
      Write-Host "  探活失败($i/$probeMax) http=$code" -ForegroundColor DarkYellow
    } catch {
      Write-Host "  探活失败($i/$probeMax): $($_.Exception.Message.Split("`n")[0])" -ForegroundColor DarkYellow
    }
    Start-Sleep -Seconds 10
  }
  return $false
}

function Push-WithRetry([string]$dir, [string]$branch, [string]$proxy) {
  if ($branch -eq "") { $branch = (git -C $dir rev-parse --abbrev-ref HEAD) }
  Write-Host "== push [$dir] → $branch" -ForegroundColor Cyan
  if ($proxy) { Write-Host "  走代理: $proxy" -ForegroundColor DarkGray }
  if (-not (Test-GitHub $proxy)) { Write-Host "  github 不可达，放弃本次" -ForegroundColor Red; return $false }

  $wait = $Wait
  for ($n = 1; $n -le $MaxTries; $n++) {
    $pushArgs = @('-C', $dir, 'push', 'origin', $branch)
    if ($proxy) { $pushArgs = @('-c', ("http.proxy=" + $proxy), '-C', $dir, 'push', 'origin', $branch) }
    $out = git @pushArgs 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  ✓ 推送成功 (第 $n 次尝试)" -ForegroundColor Green
      return $true
    }
    $errText = ($out | Out-String)
    # 非网络错误直接失败
    if ($errText -match "non-fast-forward|rejected|fetch first|failed to push some refs") {
      Write-Host "  ✗ 非网络错误，不重试:" -ForegroundColor Red
      $out | ForEach-Object { Write-Host "    $_" }
      return $false
    }
    Write-Host "  ✗ 第 $n 次失败 (等待 ${wait}s 后重试): $($out | Select-Object -Last 1)" -ForegroundColor DarkYellow
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
  }
  Write-Host "  ✗ 超过 $MaxTries 次仍失败" -ForegroundColor Red
  return $false
}

$targets = @()
if ($All) {
  $targets += @{ dir = $root; branch = "" }
  foreach ($r in @("dsh-mobile-apk", "dsh-shell-termux", "dsh-client-ui-responsive", "dsh-host-web-compat")) {
    $d = Join-Path $root $r
    if (Test-Path (Join-Path $d ".git")) { $targets += @{ dir = $d; branch = "" } }
  }
} elseif ($Repo -ne "") {
  $d = if ([System.IO.Path]::IsPathRooted($Repo)) { $Repo } else { Join-Path $root $Repo }
  $targets += @{ dir = $d; branch = $Branch }
} else {
  $targets += @{ dir = $root; branch = $Branch }
}

$fail = 0
$proxy = Get-EffectiveProxy
foreach ($t in $targets) {
  if (-not (Push-WithRetry $t.dir $t.branch $proxy)) { $fail++ }
}
if ($fail -gt 0) { Write-Host "== 完成：$fail 个仓库推送失败" -ForegroundColor Red; exit 1 }
Write-Host "== 全部推送成功" -ForegroundColor Green
