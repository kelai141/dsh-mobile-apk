// 归一化坐标基准回显（issue #258 的自证面）。这两段此前零测试（在 tools() 闭包里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coordBasisNote, basisFields, COMPAT_NOTE } from '../lib/coord-basis.js'

test('coordBasisNote：老壳侧不回显时如实标注，不假装知道', () => {
  for (const d of [undefined, null, {}, { basis: '' }, { basis: 123 }]) {
    assert.equal(coordBasisNote(d), COMPAT_NOTE, '未回显时必须给兼容标记：' + JSON.stringify(d))
  }
})

test('coordBasisNote：window-current 必须显式告警（#258 的缺陷基准）', () => {
  const s = coordBasisNote({ basis: 'window-current', basisWidth: 733, basisHeight: 412 })
  assert.match(s, /基准 window-current = 733x412/)
  assert.match(s, /按\*\*当前窗口\*\*换算/, 'window-current 没有告警：' + s)
  assert.match(s, /多窗口下可能偏左/)
})

test('coordBasisNote：整屏基准不带告警；宽高缺失时按 0 显示', () => {
  const ok = coordBasisNote({ basis: 'full-screen', basisWidth: 1080, basisHeight: 2400 })
  assert.match(ok, /基准 full-screen = 1080x2400/)
  assert.doesNotMatch(ok, /当前窗口/, '整屏基准不该出现窗口告警：' + ok)
  assert.match(coordBasisNote({ basis: 'full-screen' }), /0x0/)
  assert.match(coordBasisNote({ basis: 'full-screen', basisWidth: '1080', basisHeight: null }), /0x0/, '非 number 宽高应归 0')
})

test('basisFields：字段缺失时**不编造 0 值**（否则「没回显」看起来像「基准是 0x0」）', () => {
  for (const d of [undefined, null, {}, { basis: '' }, { basis: 123 }]) {
    assert.deepEqual(basisFields(d), {}, '不得凭空造 basis 键：' + JSON.stringify(d))
  }
})

test('basisFields：只带壳侧真回显的键', () => {
  assert.deepEqual(basisFields({ basis: 'full-screen', basisWidth: 1080, basisHeight: 2400 }),
    { basis: 'full-screen', basisWidth: 1080, basisHeight: 2400 })
  // 只有 basis、没有宽高 ⇒ 只带 basis（不能补 0）
  assert.deepEqual(basisFields({ basis: 'full-screen' }), { basis: 'full-screen' })
  // 只有宽度、没有高度 ⇒ 只带 basis + basisWidth
  assert.deepEqual(basisFields({ basis: 'full-screen', basisWidth: 1080 }), { basis: 'full-screen', basisWidth: 1080 })
  // 非 number 的宽高不得透传
  assert.deepEqual(basisFields({ basis: 'full-screen', basisWidth: 'x', basisHeight: null }), { basis: 'full-screen' })
})

test('basisFields：NaN / Infinity 宽高不得透传（同 screenOut 的 #204 同族约束）', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(basisFields({ basis: 'full-screen', basisWidth: bad, basisHeight: bad }),
      { basis: 'full-screen' }, '透传了非有限数：' + String(bad))
  }
})

test('coordBasisNote：非有限宽高不得渲染成 NaN（文案要给人看出基准）', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const t = coordBasisNote({ basis: 'full-screen', basisWidth: bad, basisHeight: bad })
    assert.doesNotMatch(t, /NaN|Infinity/, '文案里出现了非有限数：' + t)
    assert.match(t, /0x0/, '非有限数应按 0 呈现：' + t)
  }
  // 合法值必须原样呈现（别把 0 也当成缺失）
  assert.match(coordBasisNote({ basis: 'full-screen', basisWidth: 0, basisHeight: 0 }), /0x0/)
  assert.match(coordBasisNote({ basis: 'full-screen', basisWidth: 1080, basisHeight: -1 }), /1080x-1/)
})
