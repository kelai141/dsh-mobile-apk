param(
  [Parameter(Mandatory=$true)][int]$VmIndex,
  [Parameter(Mandatory=$true)][string]$ExpectedName,
  [Parameter(Mandatory=$true)][string]$EvidenceDir,
  [string]$MuMuCli = 'D:/MuMuPlayer/nx_main/mumu-cli.exe',
  [string]$Adb = 'D:/Android/Sdk/platform-tools/adb.exe'
)

$ErrorActionPreference = 'Stop'
$vm = (& $MuMuCli info --vmindex $VmIndex | Out-String | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $vm.index -ne "$VmIndex" -or $vm.name -ne $ExpectedName -or
    -not $vm.is_android_started -or $vm.adb_host_ip -ne '127.0.0.1' -or $vm.adb_port -notin 1024..65535) {
  throw 'MuMu 实例身份或状态不匹配。'
}
$serial = '127.0.0.1:' + $vm.adb_port
function Invoke-MuMuAdb([string[]]$Arguments) {
  $output = & $Adb -s $serial @Arguments
  if ($LASTEXITCODE -ne 0) { throw "MuMu adb 失败：$($Arguments[0]) ($LASTEXITCODE)" }
  return $output
}
if ((Invoke-MuMuAdb @('get-state')) -ne 'device' -or
    (Invoke-MuMuAdb @('shell','getprop','sys.boot_completed')) -ne '1' -or
    (Invoke-MuMuAdb @('shell','getprop','ro.product.cpu.abi')) -ne 'x86_64') {
  throw 'MuMu 尚未启动完成或 ABI 不匹配。'
}

$base = (New-Item -ItemType Directory -Path $EvidenceDir -Force).FullName
$log = Join-Path $base 'instrumentation.log'
$err = Join-Path $base 'instrumentation.stderr.log'
if ((Test-Path -LiteralPath $log) -or (Test-Path -LiteralPath $err)) { throw '证据目录已有运行记录。' }
$node = & $Adb -s $serial shell pidof node
if ($node) { throw '隔离验证需要 MuMu 内没有正在运行的 Node。' }
$service = 'com.dsharnessmobile.shell/com.dsharnessmobile.shell.DeviceControlService'
$oldServices = (Invoke-MuMuAdb @('shell','settings','get','secure','enabled_accessibility_services') | Out-String).Trim()
$oldEnabled = (Invoke-MuMuAdb @('shell','settings','get','secure','accessibility_enabled') | Out-String).Trim()
$others = @($oldServices -split ':' | Where-Object { $_ -and $_ -ne 'null' -and $_ -ne $service })
function Set-SecureValue([string]$Key, [string]$Value) {
  if ($Value -eq 'null' -or [string]::IsNullOrEmpty($Value)) {
    Invoke-MuMuAdb @('shell','settings','delete','secure',$Key) | Out-Null
  } else {
    Invoke-MuMuAdb @('shell','settings','put','secure',$Key,$Value) | Out-Null
  }
}

try {
  Set-SecureValue 'enabled_accessibility_services' ($others -join ':')
  Invoke-MuMuAdb @('shell','am','start','-W','-a','android.settings.SETTINGS') | Out-Null
  $argsList = @('-s',$serial,'shell','am','instrument','-w','-r',
    '-e','nativeTestEmulator','mumu','-e','nativeTestCapture','yes',
    '-e','class','com.dsharnessmobile.shell.nativecontrol.NativeControlIpcDeviceTest',
    'com.dsharnessmobile.shell.test/androidx.test.runner.AndroidJUnitRunner')
  $proc = Start-Process -FilePath $Adb -ArgumentList $argsList -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
  $until = (Get-Date).AddSeconds(25)
  do {
    $proc.Refresh()
    $captureStarted = (Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue) -match 'test=accessibilityCapturesTheEmulatorDisplayThroughPrivateIpc\r?\nINSTRUMENTATION_STATUS_CODE: 1'
    if ($captureStarted -or $proc.HasExited) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $until)
  if (-not $captureStarted -or $proc.HasExited) { throw '未进入真实截图测试，详见仪器日志。' }
  Set-SecureValue 'enabled_accessibility_services' ((@($others) + $service) -join ':')
  Set-SecureValue 'accessibility_enabled' '1'
  if (-not $proc.WaitForExit(25000)) { throw '仪器进程未在预算内退出。' }
  $body = Get-Content -LiteralPath $log -Raw
  $body
  if ($proc.ExitCode -ne 0 -or $body -notmatch 'OK \(3 tests\)' -or
      ([regex]::Matches($body, '(?m)^INSTRUMENTATION_STATUS_CODE: 0\s*$')).Count -ne 3 -or
      $body -match 'INSTRUMENTATION_STATUS_CODE: -[234]|FAILURES!!!') {
    throw 'MuMu 原生用例未全部通过。'
  }
} finally {
  Set-SecureValue 'enabled_accessibility_services' $oldServices
  Set-SecureValue 'accessibility_enabled' $oldEnabled
}
