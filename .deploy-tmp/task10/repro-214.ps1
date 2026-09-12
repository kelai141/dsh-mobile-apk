# #214 设备复现/还原（MuMu x86_64 127.0.0.1:16416）—— 五档：backup / inject / start / evidence / restore
# 备份与还原都发生在设备私有目录内（cp 到同目录 .bak-214），不做主机往返，避免换行/字节被改写。
param([string]$Mode = "evidence", [string]$Serial = "127.0.0.1:16416")
$ErrorActionPreference = "Stop"
$pkg = "com.dsharnessmobile.shell"
$profile = "/data/data/" + $pkg + "/files/home/.dsh/profiles/web"
$dev = $profile + "/cordis.patch.yml"
$bak = $dev + ".bak-214"
Write-Output ("device=" + $Serial)
switch ($Mode) {
  "backup" {
    adb -s $Serial shell ("run-as " + $pkg + " cp " + $dev + " " + $bak)
    $m1 = (adb -s $Serial shell ("run-as " + $pkg + " md5sum " + $dev)).Trim()
    $m2 = (adb -s $Serial shell ("run-as " + $pkg + " md5sum " + $bak)).Trim()
    $n = (adb -s $Serial shell ("run-as " + $pkg + " wc -l " + $dev)).Trim()
    Write-Output ("before: " + $m1)
    Write-Output ("backup: " + $m2 + "  lines=" + $n)
  }
  "inject" {
    $inner = "run-as " + $pkg + " sh -c 'cat " + $dev + "; printf \"\n- id: ui-layout\n  disabled: true\n\"'";
    # 已装过修复版时一次性标记在场会跳过自愈——复现/自愈验证前先清掉
    adb -s $Serial shell ("run-as " + $pkg + " sh -c 'rm -f files/.profile-patch-repair-*'")
    adb -s $Serial shell ($inner + " > /data/local/tmp/cordis-injected.yml")
    adb -s $Serial shell ("run-as " + $pkg + " cp /data/local/tmp/cordis-injected.yml " + $dev)
    Write-Output "injected legacy block: - id: ui-layout / disabled: true"
    adb -s $Serial shell ("run-as " + $pkg + " tail -n 3 " + $dev)
  }
  "start" {
    adb -s $Serial shell ("am force-stop " + $pkg)
    Start-Sleep -Seconds 3
    adb -s $Serial shell ("am start -n " + $pkg + "/.MainActivity")
    Write-Output "cold start issued (fingerprint unchanged -> no re-extract)"
  }
  "evidence" {
    Write-Output "--- live patch tail ---"
    adb -s $Serial shell ("run-as " + $pkg + " tail -n 4 " + $dev)
    Write-Output "--- ui-layout occurrence ---"
    adb -s $Serial shell ("run-as " + $pkg + " grep -n ui-layout " + $dev)
    Write-Output "--- logcat ---"
    adb -s $Serial logcat -d -t 600 | Select-String -Pattern "Failed to load plugins|did not activate|pending \(waiting|ui-layout|layout" | Select-Object -First 40
  }
  "heal-evidence" {
    Write-Output "--- live patch after fixed build cold start ---"
    adb -s $Serial shell ("run-as " + $pkg + " ls -l " + $profile)
    adb -s $Serial shell ("run-as " + $pkg + " grep -c ui-layout " + $dev)
    adb -s $Serial shell ("run-as " + $pkg + " ls files/ | grep profile-patch-repair")
    adb -s $Serial shell ("run-as " + $pkg + " sh -c 'cat <files/log/dsh-*.log 2>/dev/null | tail -20'")
  }
  "restore" {
    adb -s $Serial shell ("run-as " + $pkg + " cp " + $bak + " " + $dev)
    $m1 = (adb -s $Serial shell ("run-as " + $pkg + " md5sum " + $dev)).Trim()
    $m2 = (adb -s $Serial shell ("run-as " + $pkg + " md5sum " + $bak)).Trim()
    Write-Output ("after-restore: " + $m1)
    Write-Output ("backup       : " + $m2)
    adb -s $Serial shell ("run-as " + $pkg + " rm -f " + $bak)
    Write-Output "backup copy removed"
  }
}