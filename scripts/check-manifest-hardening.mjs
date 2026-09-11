#!/usr/bin/env node
// check-manifest-hardening.mjs — manifest 加固门禁（0.13.8 PR-B3 / apk issue #183）
// 断言（读源 manifest + 接收器源码，构建期即可判）：
//   1. android:allowBackup="false"
//   2. 不存在 android:usesCleartextTraffic="true"（NSC 接管）
//   3. android:networkSecurityConfig 已配置
//   4. AdbKeyboardReceiver 源码含来源校验（isTrustedSender）
// 退出 0 = 通过；1 = 失败（拒打包）。挂在 build-apk-013.ps1 门禁链与两仓 CI。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(ROOT, 'app', 'src', 'main', 'AndroidManifest.xml')
// 双仓共用构建链：本仓没有壳侧 manifest（协调仓）→ 跳过（镜像一致性由 check-patch-mirror 保证）
if (!existsSync(manifestPath)) {
  console.log('SKIP  本树无 app/src/main/AndroidManifest.xml（协调仓侧，壳侧门禁在 apk 仓构建时执行）')
  process.exit(0)
}
const manifest = readFileSync(manifestPath, 'utf8')

const failures = []
const check = (label, ok) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) failures.push(label)
}

check('allowBackup="false"', /android:allowBackup="false"/.test(manifest))
check('无 usesCleartextTraffic="true"（NSC 接管）', !/usesCleartextTraffic="true"/.test(manifest))
check('networkSecurityConfig 已配置', /android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest))
check('dataExtractionRules 已配置', /android:dataExtractionRules="@xml\/data_extraction_rules"/.test(manifest))
check('fullBackupContent 已配置', /android:fullBackupContent="@xml\/backup_rules"/.test(manifest))

try {
  const receiver = readFileSync(
    join(ROOT, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'AdbKeyboardReceiver.kt'), 'utf8',
  )
  check('AdbKeyboardReceiver 含来源校验（isTrustedSender）', receiver.includes('isTrustedSender'))
} catch {
  check('AdbKeyboardReceiver 含来源校验（isTrustedSender）', false)
}

if (failures.length > 0) {
  console.error('MANIFEST-HARDENING FAILED: ' + failures.join('；'))
  process.exit(1)
}
console.log('MANIFEST-HARDENING PASSED')
