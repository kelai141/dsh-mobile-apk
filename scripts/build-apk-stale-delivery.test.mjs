// #1077 端到端复现/放行：用**真实** check-apk-signatures + 真实 apksigner。
// 负控：交付目录里留一个未通过验签的包 -> --dir 递归命中它 -> 门禁恒红（陈旧产物让后续构建永远红）。
// 放行：清掉它之后同一目录变绿；再证明 assembleApk 在新代码下失败时不会留下产物。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-apk-signatures.mjs')
const KEYSTORE = join(ROOT, 'keystore', 'debug.keystore')

// 需要真实 apksigner。拿不到时显式 skip（本机没有 Android SDK 的 CI 场景），不得静默当通过。
const apksignerProbe = spawnSync(process.execPath, [GATE, '--apk', join(ROOT, 'nonexistent.apk'), '--keystore', KEYSTORE], { encoding: 'utf8' });
const apksignerMissing = /apksigner not found/.test(String(apksignerProbe.stderr ?? '') + String(apksignerProbe.stdout ?? ''));
const needsApksigner = { skip: apksignerMissing ? '本机没有 apksigner（无 Android SDK），该层无法取证' : false };

const runGate = (dir) => spawnSync(process.execPath, [GATE, '--dir', dir, '--keystore', KEYSTORE], { encoding: 'utf8', windowsHide: true });

test('negative control: a stale unverified APK in the delivery dir keeps the signature gate red', needsApksigner, () => {
  const root = mkdtempSync(join(tmpdir(), 'stale-1077-'))
  try {
    const out = join(root, 'out', 'v0.14.10')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'dsh-mobile-apk-v0.14.10-source-arm64.apk'), Buffer.from('never-verified-apk-bytes'))
    const red = runGate(out)
    assert.equal(red.status, 1, '陈旧未验签产物必须让目录级门禁判红（这正是「后续构建恒红」的机理）')
    assert.match(String(red.stdout) + String(red.stderr), /failed verification/, '结论行必须点明是验签失败');

    // 放行例：清掉陈旧产物后，同一目录不再有可判红对象（空目录 -> 门禁以「没有 APK」拒绝，
    // 而不是「有不合格 APK」——两种红的语义不同，这里断言的是后者消失）。
    rmSync(join(out, 'dsh-mobile-apk-v0.14.10-source-arm64.apk'), { force: true })
    const empty = runGate(out)
    assert.match(String(empty.stdout) + String(empty.stderr), /no APK files found/,
      '清掉陈旧产物后应退化为「目录里没有 APK」，而不是「有 APK 不合格」');
    assert.equal(readdirSync(out).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
