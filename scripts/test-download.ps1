$ErrorActionPreference = 'Continue'
$tmp = 'D:\coding\dsh-mobile\.deploy-tmp'
[IO.File]::WriteAllText((Join-Path $tmp 'req-list.json'), '{"type":"client-request","rpcId":"dl-2","method":"session.list","payload":{}}')
$r1 = curl.exe -s -m 10 -X POST -H 'Content-Type: application/json' --data-binary ("@" + (Join-Path $tmp 'req-list.json')) http://127.0.0.1:3081/api/session.list
$sid = ($r1 | ConvertFrom-Json).result.value.items[0].sessionId
Write-Output ('sid: ' + $sid)
if ($sid) {
  $dl = curl.exe -s -m 20 -o D:\coding\dsh-mobile\.deploy-tmp\dl-test.zip -w ('dl http:%{http_code} size:%{size_download}') ('http://127.0.0.1:3081/api/session.export?sessionId=' + $sid + '&includeDescendants=true')
  Write-Output ('dl: ' + $dl)
  if (Test-Path D:\coding\dsh-mobile\.deploy-tmp\dl-test.zip) { Write-Output ('file: ' + (Get-Item D:\coding\dsh-mobile\.deploy-tmp\dl-test.zip).Length + ' bytes') }
}