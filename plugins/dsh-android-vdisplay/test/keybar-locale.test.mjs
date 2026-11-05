// 九键条与面板的**双语文案选择**回归（离线，node:test，不依赖 jsdom）。
//
// 为什么要有这个文件（issue #151）：
//   labelEn / ariaLabelEn、keybarText()、keybarLabel()、status.ts 的 tr() 是**有真逻辑**的一层：
//   前缀匹配、两级回退（labelEn ?? label）、无 DOM 降级。此前 91 例插件单测**零覆盖**这层，
//   把回退方向写反或把前缀匹配改成等值比较都不会变红。本文件补上这层保护。
//
// 本文件分五组：
//   1. 正向：keybarLabel 按语言给 label / ariaLabel；
//   2. 回退：符号键与缺字段的 spec 在英文界面必须回退，不得返回空串；
//   3. keybarText：按传入的 document 判定，不读全局；
//   4. 无 DOM 降级：宿主半没有 document 时必须降级成中文而不是抛错；
//   5. 反证与源码门禁：把选择逻辑改坏，本文件的判据必须判红。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEYBAR_KEYS, KEYBAR_SPECS } from '../src/keybar/keymap.ts'
import { KEYBAR_TEXT, keybarLabel, keybarText } from '../src/keybar/mount.ts'
import { mapStatusPayload, readPanelState } from '../src/status.ts'
import { VD_STATUS_UNAVAILABLE } from '../src/status.ts'

/** 只带 documentElement.lang 的最小 Document 替身（本层只读这一个字段）。 */
const fakeDoc = (lang) => ({ documentElement: { lang } })

/**
 * keybarLabel 的**坏实现替身**，用来证明本文件的判据确实能分辨好坏。
 *
 * @param spec - 键的静态语义。
 * @param doc - 语言来源。
 * @param broken - 哪种坏法：'reverse' 回退写反 / 'equal' 等值匹配 / 'noFallback' 缺字段不回退。
 * @returns 与 keybarLabel 同形状的结果。
 */
function brokenLabel(spec, doc, broken) {
  const lang = (doc?.documentElement?.lang ?? '').toLowerCase()
  if (broken === 'equal') {
    // 坏法一：把 startsWith('en') 写成 lang === 'en'，en-US 这类真实取值会漏判。
    const english = lang === 'en'
    return { label: english ? (spec.labelEn ?? spec.label) : spec.label,
      ariaLabel: english ? (spec.ariaLabelEn ?? spec.ariaLabel) : spec.ariaLabel }
  }
  if (broken === 'reverse') {
    // 坏法二：把中英选择写反（英文界面给中文）。
    const english = lang.startsWith('en')
    return { label: english ? spec.label : (spec.labelEn ?? spec.label),
      ariaLabel: english ? spec.ariaLabel : (spec.ariaLabelEn ?? spec.ariaLabel) }
  }
  // 坏法三：去掉两级回退，缺字段直接给空串。
  const english = lang.startsWith('en')
  return { label: english ? spec.labelEn : spec.label,
    ariaLabel: english ? spec.ariaLabelEn : spec.ariaLabel }
}

// ── 组 1：正向，按语言给 label / ariaLabel ──────────────────────────────

test('中文界面：keybarLabel 给出中文 label 与中文 ariaLabel', () => {
  const got = keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc('zh-CN'))
  assert.equal(got.label, '键盘')
  assert.equal(got.ariaLabel, '唤起软键盘')
})

test('英文界面：keybarLabel 给出英文 label 与英文 ariaLabel', () => {
  const got = keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc('en'))
  assert.equal(got.label, 'Keys')
  assert.equal(got.ariaLabel, 'Show keyboard')
})

test('英文界面：en-US / en-GB 这类带地区后缀的取值必须按前缀命中', () => {
  for (const lang of ['en-US', 'en-GB', 'en-us']) {
    const got = keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc(lang))
    assert.equal(got.label, 'Keys', 'lang=' + lang + ' 的 label 应为英文')
    assert.equal(got.ariaLabel, 'Show keyboard', 'lang=' + lang + ' 的 ariaLabel 应为英文')
  }
})

test('语言标签大小写不敏感：EN / EN-US 同样按英文处理', () => {
  const got = keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc('EN-US'))
  assert.equal(got.label, 'Keys')
  assert.equal(got.ariaLabel, 'Show keyboard')
})

test('语言缺失或为空时回退中文，不抛错', () => {
  for (const lang of ['', 'zh', 'ja', 'de-DE']) {
    const got = keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc(lang))
    assert.equal(got.label, '键盘', 'lang=' + JSON.stringify(lang) + ' 应回退中文')
    assert.equal(got.ariaLabel, '唤起软键盘')
  }
})

test('不传 document 时按中文处理（宿主半与旧调用点的缺省口径）', () => {
  const got = keybarLabel(KEYBAR_SPECS.keyboard, undefined)
  assert.equal(got.label, '键盘')
  assert.equal(got.ariaLabel, '唤起软键盘')
})

test('九键全部键位在两种语言下都拿得到非空 label 与 ariaLabel', () => {
  for (const key of KEYBAR_KEYS) {
    for (const lang of ['zh-CN', 'en-US']) {
      const got = keybarLabel(KEYBAR_SPECS[key], fakeDoc(lang))
      assert.notEqual(got.label, '', key + ' / ' + lang + ' 的 label 不得为空')
      assert.notEqual(got.ariaLabel, '', key + ' / ' + lang + ' 的 ariaLabel 不得为空')
    }
  }
})

// ── 组 2：回退，符号键与缺字段的 spec ──────────────────────────────────

test('符号键在英文界面仍回退到符号本身，不得返回空串', () => {
  // 方向键与回车键故意不带 labelEn：它们的可见文字就是符号，翻译反而会错。
  const symbols = { left: '\u2190', right: '\u2192', up: '\u2191', down: '\u2193', enter: '\u23ce' }
  for (const [key, symbol] of Object.entries(symbols)) {
    const spec = KEYBAR_SPECS[key]
    assert.equal(spec.labelEn, undefined, key + ' 是符号键，不应带 labelEn')
    assert.equal(keybarLabel(spec, fakeDoc('en-US')).label, symbol, key + ' 在英文界面应回退到符号')
    // ariaLabel 是读屏唯一可见信息，符号键有英文名，必须用英文。
    assert.notEqual(keybarLabel(spec, fakeDoc('en-US')).ariaLabel, spec.ariaLabel,
      key + ' 的英文 ariaLabel 不应停留在中文')
  }
})

test('只带 label 的自造 spec：英文界面回退原值而不是空串', () => {
  const bare = { id: 'x', label: '原值', ariaLabel: '原名', sends: true, xterm: null, csi: null, ss3: null }
  const got = keybarLabel(bare, fakeDoc('en-US'))
  assert.equal(got.label, '原值')
  assert.equal(got.ariaLabel, '原名')
})

test('只挂 labelEn 不挂 ariaLabelEn：两字段各自独立回退', () => {
  const half = { id: 'x', label: '原值', labelEn: 'Value', ariaLabel: '原名',
    sends: true, xterm: null, csi: null, ss3: null }
  const got = keybarLabel(half, fakeDoc('en-US'))
  assert.equal(got.label, 'Value', '有 labelEn 就用英文')
  assert.equal(got.ariaLabel, '原名', '缺 ariaLabelEn 时回退中文，不得空串')
})

// ── 组 3：keybarText 读传入的 document，不读全局 ────────────────────────

test('keybarText 按传入 document 的语言选择文案', () => {
  assert.equal(keybarText('中文提示', 'English notice', fakeDoc('zh-CN')), '中文提示')
  assert.equal(keybarText('中文提示', 'English notice', fakeDoc('en-US')), 'English notice')
})

test('keybarText 不传 document 时给中文', () => {
  assert.equal(keybarText('中文提示', 'English notice'), '中文提示')
})

test('keybarText 读的是传入的 document，而不是全局 document', () => {
  // 全局设成英文、传入中文 document：结果必须是中文。写死读全局的实现会在这里判红。
  const saved = globalThis.document
  globalThis.document = fakeDoc('en-US')
  try {
    assert.equal(keybarText('中文提示', 'English notice', fakeDoc('zh-CN')), '中文提示',
      '传入了中文 document，结果就不能被全局 document 带成英文')
  } finally {
    if (saved === undefined) delete globalThis.document
    else globalThis.document = saved
  }
})

test('KEYBAR_TEXT 仍导出中文提示原文（既有引用点不受影响）', () => {
  assert.match(KEYBAR_TEXT.noticeUnsupported, /该组合不支持/)
  assert.match(KEYBAR_TEXT.noticeKeyboardFailed, /无法唤起软键盘/)
  assert.match(KEYBAR_TEXT.noticeNoPath, /终端输入面尚未就绪/)
})

// ── 组 4：无 DOM 降级（宿主半） ────────────────────────────────────────

test('没有 document 时面板失败文案降级成中文且不抛错', () => {
  const saved = globalThis.document
  delete globalThis.document
  try {
    const blocked = mapStatusPayload(null)
    assert.equal(blocked.state, 'blocked')
    assert.equal(blocked.code, VD_STATUS_UNAVAILABLE)
    assert.match(blocked.detail, /状态端点返回体不是对象/)
  } finally {
    if (saved !== undefined) globalThis.document = saved
  }
})

test('没有 document 且 fetch 抛错时，readPanelState 仍返回中文文案而不是抛错', async () => {
  const saved = globalThis.document
  delete globalThis.document
  try {
    const boom = () => { throw new Error('boom') }
    const result = await readPanelState(boom)
    assert.equal(result.state, 'blocked')
    assert.match(result.detail, /状态端点不可达/)
    assert.match(result.detail, /boom/)
  } finally {
    if (saved !== undefined) globalThis.document = saved
  }
})

test('有 document 且英文时，面板失败文案走英文分支', async () => {
  const saved = globalThis.document
  globalThis.document = fakeDoc('en-US')
  try {
    const blocked = mapStatusPayload(null)
    assert.match(blocked.detail, /did not return an object/)
    const unreachable = await readPanelState(() => { throw new Error('boom') })
    assert.match(unreachable.detail, /Status endpoint unreachable/)
  } finally {
    if (saved === undefined) delete globalThis.document
    else globalThis.document = saved
  }
})

// ── 组 5：反证与源码门禁 ──────────────────────────────────────────────

test('反证：等值匹配的坏实现会在 en-US 用例上判红（证明前缀判据真的在起作用）', () => {
  const broken = brokenLabel(KEYBAR_SPECS.keyboard, fakeDoc('en-US'), 'equal')
  // 坏实现给出中文，正向断言要英文 => 该用例必然失败。这里只断言「坏实现与本文件期望不一致」。
  assert.notEqual(broken.label, keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc('en-US')).label,
    '等值匹配在 en-US 上的结果必须与真实现不同，否则前缀判据没有被测到')
  assert.equal(broken.label, '键盘', '坏实现落到中文，正是要被用例抓住的行为')
})

test('反证：把中英选择写反的坏实现会判红', () => {
  const broken = brokenLabel(KEYBAR_SPECS.keyboard, fakeDoc('en-US'), 'reverse')
  assert.equal(broken.label, '键盘', '写反后英文界面给中文，正是要被抓住的行为')
  assert.notEqual(broken.label, keybarLabel(KEYBAR_SPECS.keyboard, fakeDoc('en-US')).label)
})

test('反证：去掉回退的坏实现，在符号键上给出空串（证明回退断言有效）', () => {
  const broken = brokenLabel(KEYBAR_SPECS.left, fakeDoc('en-US'), 'noFallback')
  assert.equal(broken.label, undefined, '去掉回退后符号键拿不到 label，正是要被抓住的行为')
  // 真实现必须给出符号本身，不能落进 empty 判定。
  assert.notEqual(keybarLabel(KEYBAR_SPECS.left, fakeDoc('en-US')).label, '')
})

test('源码门禁：mount.ts 必须用前缀匹配，不得用等值比较判断语言', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/keybar/mount.ts', import.meta.url)), 'utf8')
  assert.match(source, /startsWith\('en'\)/, '语言判定必须是 startsWith，否则 en-US 会漏判')
  assert.doesNotMatch(source, /lang\s*===\s*'en'/, '不得用等值比较判断语言')
})

test('源码门禁：status.ts 的语言探测必须包在 try 内并降级成中文', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/status.ts', import.meta.url)), 'utf8')
  // 宿主半没有 document：没有这层 try/catch，模块一加载就抛 ReferenceError。
  assert.match(source, /document\.documentElement\.lang/, '语言探测必须读 documentElement.lang')
  assert.match(source, /catch\s*\{\s*return zh\s*\}/, '无 DOM 时必须 catch 并返回 zh')
  // 两者必须在同一个函数体内：取 try/catch 的位置，确认语言探测就在 try 块里。
  const tryAt = source.indexOf('try {')
  const catchAt = source.indexOf('catch {')
  assert.ok(tryAt >= 0 && catchAt > tryAt, 'tr() 必须用 try/catch 包住语言探测')
  assert.ok(source.slice(tryAt, catchAt).includes('document.documentElement.lang'),
    'documentElement.lang 必须在 try 块内，否则无 DOM 环境会直接抛错')
})

test('源码门禁：labelEn / ariaLabelEn 必须是可选字段（否则符号键无法表达）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/keybar/keymap.ts', import.meta.url)), 'utf8')
  assert.match(source, /readonly labelEn\?:\s*string/, 'labelEn 必须可选')
  assert.match(source, /readonly ariaLabelEn\?:\s*string/, 'ariaLabelEn 必须可选')
})
