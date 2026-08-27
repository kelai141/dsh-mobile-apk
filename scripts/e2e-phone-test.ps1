$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3081'
$tmp = 'D:\coding\dsh-mobile\.deploy-tmp'

# 1. create session
[IO.File]::WriteAllText((Join-Path $tmp 'req-create.json'), '{"type":"client-request","rpcId":"t-1","method":"session.create","payload":{}}')
$resp = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-create.json')) ($base + '/api/session.create')
$json = $resp | ConvertFrom-Json
$sid = $json.result.value.sessionId
Write-Output ('SESSION_ID: ' + $sid)
if (-not $sid) { Write-Output ('CREATE FAILED: ' + $resp); exit 1 }

# 2. prompt with bash task
$promptObj = @{ type='client-request'; rpcId='t-2'; method='session.prompt'; payload=@{ sessionId=$sid; mode='queue'; content=@(@{ type='text'; text='请用 bash 工具运行 echo hello-from-phone-arm64 和 uname -m,然后把输出结果告诉我' }) } }
$promptBody = $promptObj | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText((Join-Path $tmp 'req-prompt.json'), $promptBody)
$resp2 = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-prompt.json')) ($base + '/api/session.prompt')
Write-Output ('PROMPT RESP: ' + $resp2)

# 3. poll history up to 120s
Write-Output '--- polling ---'
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  $histObj = @{ type='client-request'; rpcId='t-3'; method='session.history'; payload=@{ sessionId=$sid; maxMessages=10 } }
  $histBody = $histObj | ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText((Join-Path $tmp 'req-hist.json'), $histBody)
  $hist = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-hist.json')) ($base + '/api/session.history')
  try { $hj = $hist | ConvertFrom-Json } catch { Write-Output ('poll ' + $i + ': parse fail: ' + $hist); continue }
  $items = @($hj.result.value.events)
  if ($items.Count -eq 0) { Write-Output ('poll ' + $i + ': no items'); continue }
  $last = $items[-1]
  Write-Output ('poll ' + $i + ': last=' + $last.event.type)
  foreach ($it in $items) {
    if ($it.event.type -eq 'message' -and $it.event.data.role -eq 'assistant') {
      $txt = ($it.event.data.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' '
      if ($txt) { Write-Output ('ASSISTANT: ' + $txt.Substring(0, [Math]::Min(200, $txt.Length))) }
    }
  }
  $running = $items | Where-Object { $_.event.type -eq 'status' -and $_.event.data.state -eq 'running' } | Select-Object -First 1
  if (-not $running -and $last.event.type -eq 'message' -and $i -gt 5) { Write-Output 'DONE: agent finished'; break }
}