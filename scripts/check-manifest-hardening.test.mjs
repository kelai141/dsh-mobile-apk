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

function fixture(t, path, rogue = false, transform = null) {
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
  ]
  for (const file of files) {
    const dest = join(dir, file)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(root, file), dest)
  }
  // issue #1571：真实 file_paths.xml 里的宽映射（`<external-path path="." />`）已删除，夹具
  // 不能再「替换现有那条」——那样会因为源里没有而静默不注入，正向用例变成空转。
  // 现在显式**注入**一条合成宽映射：判据要守的是「宽映射在场时调用点必须逐文件登记」，
  // 而这条判据与真实树里有没有那条映射无关。
  const paths = join(dir, 'app/src/main/res/xml/file_paths.xml')
  const original = readFileSync(paths, 'utf8')
  assert.ok(original.includes('</paths>'), 'fixture must inject the synthetic broad mapping')
  writeFileSync(paths, original.replace(
    '</paths>',
    `  <external-path name="fixture_broad" path="${path}" />\n</paths>`,
  ))
  if (rogue) writeFileSync(join(dir, 'app/src/main/java/com/dsharnessmobile/shell/Unexpected.kt'),
    'fun emit() = FileProvider.getUriForFile(context, authority, file)\n')
  if (transform !== null) transform(dir)
  const result = spawnSync(process.execPath, [checker, '--root', dir], { encoding: 'utf8' })
  assert.ifError(result.error)
  return { status: result.status, output: result.stdout + result.stderr }
}

/** 改写夹具清单；断言 mutate 真的改了文本，避免注入静默空转。 */
function mutateManifest(dir, mutate) {
  const path = join(dir, 'app/src/main/AndroidManifest.xml')
  const before = readFileSync(path, 'utf8')
  const after = mutate(before)
  assert.notEqual(after, before, 'manifest mutation must change the fixture')
  writeFileSync(path, after)
}

function fixtureWithManifest(t, mutate) {
  return fixture(t, '&#x2e;', false, dir => mutateManifest(dir, mutate))
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

test('current manifest passes with its real exported component set', t => {
  const result = fixture(t, '&#x2e;')
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /exported="true" 组件集合 == 白名单/)
  assert.match(result.output, /不注册应用内输入法/)
})

test('legacy ADBKeyboard IME service cannot return to an exported surface', t => {
  const result = fixtureWithManifest(t, source => source.replace('</application>', [
    '    <service',
    '      android:name=".AdbKeyboardService"',
    '      android:exported="true"',
    '      android:permission="android.permission.BIND_INPUT_METHOD">',
    '      <intent-filter>',
    '        <action android:name="android.view.InputMethod" />',
    '      </intent-filter>',
    '      <meta-data android:name="android.view.im" android:resource="@xml/input_method" />',
    '    </service>',
    '</application>',
  ].join('\n')))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /未登记=\s*\.AdbKeyboardService/)
  assert.match(result.output, /不注册应用内输入法/)
})

test('legacy ADBKeyboard broadcast receiver cannot return as an exported surface', t => {
  const result = fixtureWithManifest(t, source => source.replace('</application>', [
    '    <receiver android:name=".AdbKeyboardReceiver" android:exported="true">',
    '      <intent-filter>',
    '        <action android:name="ADB_INPUT_TEXT" />',
    '        <action android:name="ADB_CLEAR_TEXT" />',
    '      </intent-filter>',
    '    </receiver>',
    '</application>',
  ].join('\n')))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /未登记=\s*\.AdbKeyboardReceiver/)
  assert.match(result.output, /无 android:permission，且源码无 isTrustedSender 调用/)
})

test('a newly exported third-party service is rejected even with a permission', t => {
  const result = fixtureWithManifest(t, source => source.replace('</application>',
    '    <service android:name="com.example.InjectedService" android:exported="true" '
      + 'android:permission="android.permission.BIND_JOB_SERVICE" />\n</application>'))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /未登记=\s*com\.example\.InjectedService/)
})

test('a newly exported third-party receiver without permission or source check is rejected', t => {
  const result = fixtureWithManifest(t, source => source.replace('</application>', [
    '    <receiver android:name="com.example.InjectedReceiver" android:exported="true">',
    '      <intent-filter>',
    '        <action android:name="com.example.INJECTED" />',
    '      </intent-filter>',
    '    </receiver>',
    '</application>',
  ].join('\n')))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /未登记=\s*com\.example\.InjectedReceiver/)
  assert.match(result.output, /com\.example\.InjectedReceiver（无 android:permission，且源码无 isTrustedSender 调用）/)
})

test('the accessibility service cannot lose its binding permission', t => {
  const result = fixtureWithManifest(t, source => source.replace(
    /\s+android:permission="android\.permission\.BIND_ACCESSIBILITY_SERVICE"/, ''))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /\.DeviceControlService（无 android:permission）/)
})

test('the Shizuku provider cannot lose its binding permission', t => {
  const result = fixtureWithManifest(t, source => source.replace(
    /\s+android:permission="android\.permission\.INTERACT_ACROSS_USERS_FULL"/, ''))
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /rikka\.shizuku\.ShizukuProvider（无 android:permission）/)
})

for (const path of ['Documents/&#x2e;hidden', '&amp;#46;']) {
  test(`narrow mapping remains narrow after exactly one XML decoding pass: ${path}`, t => {
    const result = fixture(t, path, true)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /无宽范围 FileProvider 映射/)
  })
}
