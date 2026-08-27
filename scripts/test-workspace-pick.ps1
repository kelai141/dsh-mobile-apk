$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3081'
$tmp = 'D:\coding\dsh-mobile\.deploy-tmp'
# 1. start pick RPC in background (long-lived connection)
[IO.File]::WriteAllText((Join-Path $tmp 'req-pick.json'), '{"type":"client-request","rpcId":"pick-7","method":"host.pickDirectory","payload":{}}')
$job = Start-Job -ScriptBlock { param($base, $tmp)
  curl.exe -s -m 60 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-pick.json')) ($base + '/api/host.pickDirectory')
} -ArgumentList $base, $tmp
Start-Sleep -Seconds 2
# 2. page poll picks up the request
$r2 = curl.exe -s -m 5 ($base + '/api/android/dir-pick/poll')
Write-Output ('poll: ' + $r2)
$reqId = ($r2 | ConvertFrom-Json).requestId
if (-not $reqId) { Write-Output 'NO REQUEST'; Stop-Job $job; Remove-Job $job; exit 1 }
# 3. WebView bridge result (SAF picked /storage/emulated/0/dsh-workspace-test)
[IO.File]::WriteAllText((Join-Path $tmp 'req-pick-result.json'), (ConvertTo-Json -InputObject @{ requestId=$reqId; path='/storage/emulated/0/dsh-workspace-test' } -Depth 6 -Compress))
$r3 = curl.exe -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-pick-result.json')) ($base + '/api/android/dir-pick/result')
Write-Output ('result POST: ' + $r3)
# 4. collect pick RPC response
Start-Sleep -Seconds 2
$pickOut = Receive-Job $job -Wait -AutoRemoveJob | Out-String
Write-Output ('pick RPC: ' + $pickOut)
# 5. workspace.create with the picked path
[IO.File]::WriteAllText((Join-Path $tmp 'req-ws.json'), '{"type":"client-request","rpcId":"ws-1","method":"workspace.create","payload":{"path":"/storage/emulated/0/dsh-workspace-test"}}')
$r4 = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-ws.json')) ($base + '/api/workspace.create')
Write-Output ('workspace.create: ' + $r4)