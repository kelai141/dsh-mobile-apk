$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3081'
$tmp = 'D:\coding\dsh-mobile\.deploy-tmp'
[IO.File]::WriteAllText((Join-Path $tmp 'req-c.json'), '{"type":"client-request","rpcId":"k-1","method":"session.create","payload":{}}')
$r1 = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-c.json')) ($base + '/api/session.create')
$sid = ($r1 | ConvertFrom-Json).result.value.sessionId
Write-Output ('sid: ' + $sid)
if (-not $sid) { Write-Output ('CREATE FAILED: ' + $r1); exit 1 }
$promptObj = @{ type='client-request'; rpcId='k-2'; method='session.prompt'; payload=@{ sessionId=$sid; mode='queue'; content=@(@{ type='text'; text='只回复四个字：密钥正常' }) } }
[IO.File]::WriteAllText((Join-Path $tmp 'req-p.json'), ($promptObj | ConvertTo-Json -Depth 6 -Compress))
$r2 = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-p.json')) ($base + '/api/session.prompt')
Write-Output ('prompt: ' + $r2)
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  $histObj = @{ type='client-request'; rpcId='k-3'; method='session.history'; payload=@{ sessionId=$sid; maxMessages=6 } }
  [IO.File]::WriteAllText((Join-Path $tmp 'req-h.json'), ($histObj | ConvertTo-Json -Depth 6 -Compress))
  $hist = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-h.json')) ($base + '/api/session.history')
  $hj = $hist | ConvertFrom-Json
  $events = @($hj.result.value.events)
  $last = $events[-1]
  if ($null -ne $last -and $last.event.type -eq 'turn/end') {
    $reason = $last.event.data.reason
    Write-Output ('turn/end reason: ' + ($reason | ConvertTo-Json -Depth 4 -Compress))
    foreach ($ev in $events) {
      if ($ev.event.type -eq 'assistant/message') {
        $txt = (($ev.event.data.message.content | Where-Object { $_.type -eq 'text' }) | ForEach-Object { $_.text }) -join ' '
        Write-Output ('ASSISTANT: ' + $txt)
      }
    }
    break
  }
  Write-Output ('poll ' + $i + ': ' + $last.event.type)
}