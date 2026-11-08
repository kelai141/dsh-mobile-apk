#!/usr/bin/env node
// plugin-sample-evidence-init.mjs — 生成一份全是 unmeasured 的兼容证据骨架。
//
// 这是 comparator 的默认输入：没跑过适配器时，任何用例都不该是 pass。
// APK 与环境字段必须由调用方显式给出，脚本不猜。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildEvidence } from './lib/plugin-sample-evidence.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const main = () => {
  const { values } = parseArgs({
    options: {
      side: { type: 'string' },
      label: { type: 'string' },
      abi: { type: 'string', default: 'x86_64' },
      'apk-sha256': { type: 'string' },
      'snapshot-fingerprint': { type: 'string' },
      'android-api': { type: 'string' },
      'webview-version': { type: 'string' },
      'device-model': { type: 'string' },
      'android-build': { type: 'string' },
      out: { type: 'string' },
    },
  })
  const need = ['side', 'label', 'apk-sha256', 'snapshot-fingerprint', 'android-api', 'webview-version', 'device-model', 'android-build', 'out']
  const missing = need.filter((k) => !values[k])
  if (missing.length > 0) {
    process.stderr.write('缺参数：' + missing.map((k) => '--' + k).join(' ') + '\n')
    process.exit(2)
  }
  if (!['baseline', 'candidate'].includes(values.side)) {
    process.stderr.write('--side 必须是 baseline 或 candidate\n')
    process.exit(2)
  }
  const plan = JSON.parse(readFileSync(join(HERE, 'plugin-test-samples.json'), 'utf8'))
  const evidence = buildEvidence(plan, {
    side: values.side,
    label: values.label,
    apk: {
      abi: values.abi,
      versionName: values['version-name'] ?? '0.14.11',
      versionCode: Number(values['version-code'] ?? 61),
      apkSha256: values['apk-sha256'],
      snapshotFingerprint: values['snapshot-fingerprint'],
    },
    environment: {
      androidApi: Number(values['android-api']),
      webviewVersion: values['webview-version'],
      emulator: true,
      deviceModel: values['device-model'],
      androidBuild: values['android-build'],
      testPlanSha256: values['test-plan-sha256'] ?? '0'.repeat(64),
    },
    patchSha256: values['patch-sha256'] ?? '0'.repeat(64),
    settingsSha256: values['settings-sha256'] ?? '0'.repeat(64),
  })
  writeFileSync(resolve(values.out), JSON.stringify(evidence, null, 2) + '\n')
  const cases = evidence.samples.reduce((n, s) => n + s.cases.length, 0)
  process.stdout.write('已写出证据骨架：' + resolve(values.out) + '（samples=' + evidence.samples.length + ' cases=' + cases + '，全部 unmeasured）\n')
}

main()

