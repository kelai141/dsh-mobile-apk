#!/usr/bin/env node
// plugin-sample-evidence-init.mjs — 生成一份全是 unmeasured 的兼容证据骨架。
//
// 这是 comparator 的默认输入：没跑过适配器时，任何用例都不该是 pass。
// APK 与环境字段必须由调用方显式给出，脚本不猜。
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildEvidence } from './lib/plugin-sample-evidence.mjs'
import { validateBundle } from './verify-plugin-compat-evidence.mjs'
import { readHarnessIdentity } from './source-build/harness-identity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const main = () => {
  const { values } = parseArgs({
    options: {
      side: { type: 'string' },
      label: { type: 'string' },
      abi: { type: 'string', default: 'x86_64' },
      'apk-sha256': { type: 'string' },
      'snapshot-fingerprint': { type: 'string' },
      'version-name': { type: 'string' },
      'version-code': { type: 'string' },
      'patch-sha256': { type: 'string' },
      'settings-sha256': { type: 'string' },
      'android-api': { type: 'string' },
      'webview-version': { type: 'string' },
      'device-model': { type: 'string' },
      'device-primary-abi': { type: 'string' },
      plan: { type: 'string' },
      'upstream-contract': { type: 'string' },
      'android-build': { type: 'string' },
      out: { type: 'string' },
    },
  })
  const need = ['side', 'label', 'apk-sha256', 'snapshot-fingerprint', 'version-name', 'version-code',
    'patch-sha256', 'settings-sha256', 'android-api', 'webview-version', 'device-model', 'android-build', 'out']
  const missing = need.filter((k) => !values[k])
  if (missing.length > 0) {
    process.stderr.write('缺参数：' + missing.map((k) => '--' + k).join(' ') + '\n')
    process.exit(2)
  }
  if (!['baseline', 'candidate'].includes(values.side)) {
    process.stderr.write('--side 必须是 baseline 或 candidate\n')
    process.exit(2)
  }
  const planBytes = readFileSync(values.plan ?? join(HERE, 'plugin-test-samples.json'))
  const plan = JSON.parse(planBytes.toString('utf8'))
  if (values['upstream-contract']) {
    const upstream = readHarnessIdentity(values['upstream-contract'])
    plan.engine = { ...plan.engine, commit: upstream.commit, baseline: upstream.version }
  }
  const evidence = buildEvidence(plan, {
    side: values.side,
    label: values.label,
    apk: {
      abi: values.abi,
      versionName: values['version-name'],
      versionCode: Number(values['version-code']),
      apkSha256: values['apk-sha256'],
      snapshotFingerprint: values['snapshot-fingerprint'],
    },
    environment: {
      androidApi: Number(values['android-api']),
      webviewVersion: values['webview-version'],
      emulator: true,
      deviceModel: values['device-model'],
      ...(values['device-primary-abi'] ? { devicePrimaryAbi: values['device-primary-abi'] } : {}),
      androidBuild: values['android-build'],
      testPlanSha256: createHash('sha256').update(planBytes).digest('hex'),
    },
    patchSha256: values['patch-sha256'],
    settingsSha256: values['settings-sha256'],
  })
  const issues = validateBundle(evidence, values.side)
  if (issues.length) {
    process.stderr.write(issues.join('\n') + '\n')
    process.exit(2)
  }
  writeFileSync(resolve(values.out), JSON.stringify(evidence, null, 2) + '\n')
  const cases = evidence.samples.reduce((n, s) => n + s.cases.length, 0)
  process.stdout.write('已写出证据骨架：' + resolve(values.out) + '（samples=' + evidence.samples.length + ' cases=' + cases + '，全部 unmeasured）\n')
}

main()
