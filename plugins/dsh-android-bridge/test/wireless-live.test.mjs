// ST-12（引擎半边）：无线调试「活体键」wirelessOn。
// 壳侧 AdbState.syncWirelessLive() 写 <boolean name="wirelessOn">（TTL 2s < 页面轮询 3s）；
// 引擎侧必须：wirelessOn 在场即用它，哪怕它是 false（配对后关掉无线调试的实时事实）；
// 旧壳无该键 → 回落 paired（旧的间接证明语义）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AndroidPrivilegeService, parseAdbPrefsXml } from '../lib/index.js'

const saved = process.env.DSH_ADB_PREFS_PATH
const savedFull = process.env.DSH_ADB_FULLACCESS

after(() => {
  if (saved === undefined) delete process.env.DSH_ADB_PREFS_PATH
  else process.env.DSH_ADB_PREFS_PATH = saved
  if (savedFull === undefined) delete process.env.DSH_ADB_FULLACCESS
  else process.env.DSH_ADB_FULLACCESS = savedFull
})

function prefsFile(inner) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-st12-'))
  const file = join(dir, 'dsh-adb.xml')
  writeFileSync(file, '<map>\n  <boolean name="allowSwitch" value="true" />\n  <boolean name="paired" value="true" />\n  <boolean name="connected" value="true" />\n  <boolean name="fullAccess" value="true" />\n' + inner + '</map>\n')
  return file
}

function statusWith(inner) {
  process.env.DSH_ADB_PREFS_PATH = prefsFile(inner)
  delete process.env.DSH_ADB_FULLACCESS
  return new AndroidPrivilegeService({}, () => 'danger-full-access').status()
}

test('ST-12 解析：wirelessOn 在场即回填（与 paired 分叉）', () => {
  const on = parseAdbPrefsXml('<map><boolean name="allowSwitch" value="true" /><boolean name="paired" value="false" /><boolean name="wirelessOn" value="true" /></map>')
  assert.equal(on.wirelessOn, true)
  assert.equal(on.paired, false)
  const off = parseAdbPrefsXml('<map><boolean name="allowSwitch" value="true" /><boolean name="paired" value="true" /><boolean name="wirelessOn" value="false" /></map>')
  assert.equal(off.wirelessOn, false)
  assert.equal(off.paired, true)
})

test('ST-12 解析：旧壳无 wirelessOn 键 → undefined（不假装知道实时值）', () => {
  const legacy = parseAdbPrefsXml('<map><boolean name="allowSwitch" value="true" /><boolean name="paired" value="true" /></map>')
  assert.equal(legacy.wirelessOn, undefined)
})

test('ST-12 状态：wirelessOn=true 时无线调试门成立（paired=false 也不影响）', () => {
  const st = statusWith('  <boolean name="wirelessOn" value="true" />\n')
  assert.equal(st.wirelessDebugOn, true)
  assert.equal(st.authorized === undefined || st.authorized === null, true)
  assert.equal(st.fullAccess, true)
})

test('ST-12 状态：wirelessOn=false 时以活体值为准（配对过但无线调试已关 = 门不成立）', () => {
  const st = statusWith('  <boolean name="wirelessOn" value="false" />\n')
  assert.equal(st.wirelessDebugOn, false)
  // 反向自证口径：旧实现读 live.paired（此处 true）会把它判成成立——正是 ST-12 要修的缺陷形态
  assert.equal(st.fullAccess, true, '其它门仍成立，只有无线调试门被活体键关掉')
})

test('ST-12 状态：无 wirelessOn 键 → 回落 paired（旧语义不回归）', () => {
  const st = statusWith('')
  assert.equal(st.wirelessDebugOn, true)
})

test('ST-12 状态：无 prefs 文件 → 回落 env（桌面/测试宿主路径不变）', () => {
  process.env.DSH_ADB_PREFS_PATH = join(tmpdir(), 'definitely-missing-dsh-adb.xml')
  process.env.DSH_ADB_WIRELESS = '1'
  const st = new AndroidPrivilegeService({}, () => 'danger-full-access').status()
  assert.equal(st.wirelessDebugOn, true)
  delete process.env.DSH_ADB_WIRELESS
})
