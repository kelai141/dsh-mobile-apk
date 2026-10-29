import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const checker = join(root, 'scripts/check-manifest-hardening.mjs')

/**
 * 从门禁脚本现读已登记的 FileProvider 调用点（去掉 .kt 后缀）。
 *
 * 为什么读源码而不在夹具里再抄一份：allowlist 是判据的唯一真源。抄一份就有两个真源，
 * 新增调用点时漏改本文件会表现成「门禁红」，而真正的门禁其实是对的——那种红最耗时，
 * 因为它看起来像功能坏了。
 */
function registeredFileProviderCallers() {
  const source = readFileSync(checker, 'utf8')
  const block = source.slice(source.indexOf('FILE_PROVIDER_CALLER_ALLOWLIST'))
  const names = []
  const re = /'java\/com\/dsharnessmobile\/shell\/([A-Za-z0-9_]+)\.kt'/g
  let m
  while ((m = re.exec(block)) !== null) names.push(m[1])
  if (names.length === 0) throw new Error('未能从 check-manifest-hardening.mjs 读到已登记调用点')
  return names
}

function fixture(t, path, rogue = false) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-xml-reference-'))
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  })
  const files = [
    'app/src/main/AndroidManifest.xml',
    ...['file_paths', 'network_security_config', 'backup_rules', 'data_extraction_rules']
      .map(name => `app/src/main/res/xml/${name}.xml`),
    'app/src/test/java/com/dsharnessmobile/shell/BrowserHostCleartextConsistencyTest.kt',
    // 已登记调用点必须**全部**拷进来：少拷一个，门禁就报「登记调用点缺席」，
    // 这条正向用例会以「门禁红」的形式失败。清单从门禁脚本现读（见上面的 helper），
    // 只拷本树真实存在的文件——分支之间文件集合不同，缺失的不属于本夹具的责任。
    ...registeredFileProviderCallers()
      .filter(name => existsSync(join(root, `app/src/main/java/com/dsharnessmobile/shell/${name}.kt`)))
      .map(name => `app/src/main/java/com/dsharnessmobile/shell/${name}.kt`),
    'app/src/main/java/com/dsharnessmobile/shell/AdbKeyboardReceiver.kt',
  ]
  for (const file of files) {
    const dest = join(dir, file)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(root, file), dest)
  }
  const paths = join(dir, 'app/src/main/res/xml/file_paths.xml')
  const original = readFileSync(paths, 'utf8')
  assert.ok(original.includes('path="."'), 'fixture must replace the real broad mapping')
  writeFileSync(paths, original.replace('path="."', `path="${path}"`))
  if (rogue) writeFileSync(join(dir, 'app/src/main/java/com/dsharnessmobile/shell/Unexpected.kt'),
    'fun emit() = FileProvider.getUriForFile(context, authority, file)\n')
  const result = spawnSync(process.execPath, [checker, '--root', dir], { encoding: 'utf8' })
  assert.ifError(result.error)
  return { status: result.status, output: result.stdout + result.stderr }
}

for (const path of ['.', '&#46;', '&#x2e;', 'tmp/&#46;&#46;', '&#46;&#46;/outside']) {
  test(`full gate rejects an unregistered caller with broad XML path ${path}`, t => {
    const result = fixture(t, path, true)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /未登记调用文件.*Unexpected\.kt/)
  })
}

test('encoded broad mapping accepts the registered caller set', t => {
  const result = fixture(t, '&#x2e;')
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /逐文件\/逐引用登记一致/)
})

for (const path of ['Documents/&#x2e;hidden', '&amp;#46;']) {
  test(`narrow mapping remains narrow after exactly one XML decoding pass: ${path}`, t => {
    const result = fixture(t, path, true)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /无宽范围 FileProvider 映射/)
  })
}
