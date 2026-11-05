import test from 'node:test'
import assert from 'node:assert/strict'
import { kotlinBridgeMethods, tsDeclaredMembers, jsCallSites, diffSurface } from './check-bridge-symmetry.mjs'

// 这个门禁守的是「壳侧桥面 ↔ 页面侧消费面」的对称性，而它自己此前**没有任何自测**。
// 本轮（2026-10-28）实测到它把注释里提到的 @JavascriptInterface 当成真注解：
// 紧随其后的任意 `fun`（包括私有辅助函数）都会被收进桥面清单 ⇒ 页面侧没有它就误报红，
// 或者把它登记进 kotlinOnly 稀释真实面。下面第一条钉住这个形态。

test('注释里提到的 @JavascriptInterface 不得被当成注解', () => {
  const src = [
    '/**',
    ' * `@JavascriptInterface` 是页面可直达的公开边界，必须自己校验入参。',
    ' */',
    'private fun helperNotABridge(x: Int): Int = x + 1',
    '',
    '@JavascriptInterface',
    'fun realBridge(): String = "x"',
  ].join('\n')
  assert.deepEqual(kotlinBridgeMethods(src), ['realBridge'])
})

test('注解与 fun 之间可隔注释/其它注解，但窗口仍然是 8 行', () => {
  const near = ['@JavascriptInterface', '// 说明', '@Suppress("unused")', 'fun ok(): String'].join('\n')
  assert.deepEqual(kotlinBridgeMethods(near), ['ok'])

  // 超过 8 行窗口就不收：这是现实现的契约，钉住它是为了让"改窗口"这件事必须显式改用例。
  const far = ['@JavascriptInterface', ...Array.from({ length: 9 }, (_, i) => '// filler ' + i), 'fun tooFar()']
  assert.deepEqual(kotlinBridgeMethods(far.join('\n')), [])
})

test('startMarker 限定区域时只扫区域内', () => {
  const src = [
    'object A {',
    '  @JavascriptInterface',
    '  fun insideA(): String',
    '}',
    'object B {',
    '  @JavascriptInterface',
    '  fun insideB(): String',
    '}',
  ].join('\n')
  assert.deepEqual(kotlinBridgeMethods(src, 'object B'), ['insideB'])
})

test('jsCallSites 只取真实调用点且去重保序', () => {
  const html = '<script>window.consoleBridge.writeRaw("x");window.consoleBridge.resize(1,2);' +
    'window.consoleBridge.writeRaw("y")</script>'
  assert.deepEqual(jsCallSites(html, 'window.consoleBridge'), ['writeRaw', 'resize'])
})

// diffSurface 是三张差异表的唯一来源（kotlinOnly / tsOnly / setterWithoutGetter / pairMisses），
// 此前完全没有自测。只给它一个 {id} 就够——实现里 surface 只用于拼 key（`surface/method`）。
const SURFACE = { id: 'demo' }

test('diffSurface 双向缺失各自记账', () => {
  // 注意 a/b 必须同名共有，否则它们自己也会各记一笔（第一版断言就是漏了这个）
  const d = diffSurface(SURFACE, ['shared', 'goneFromPage'], ['shared', 'goneFromKotlin'])
  assert.deepEqual(d.kotlinOnly, ['demo/goneFromPage'], '壳侧有、页面没有')
  assert.deepEqual(d.tsOnly, ['demo/goneFromKotlin'], '页面有、壳侧没有')
  assert.deepEqual(d.setterWithoutGetter, [])
  assert.deepEqual(d.pairMisses, [])
})

test('setter 没有对应 getter 才报，配上了就不报', () => {
  const bad = diffSurface(SURFACE, ['setAlpha'], [])
  assert.deepEqual(bad.setterWithoutGetter, ['demo/setAlpha'])
  const good = diffSurface(SURFACE, ['setAlpha', 'getAlpha'], [])
  assert.deepEqual(good.setterWithoutGetter, [], 'setX + getX 是同 token，不该报')
  const withIs = diffSurface(SURFACE, ['setBeta', 'isBeta'], [])
  assert.deepEqual(withIs.setterWithoutGetter, [], 'isX 也算 getter token')
})

test('声明对是逃生舱：前缀不同也能配对，缺一侧就报 pairMisses', () => {
  // setPrefTheme ↔ readPrefTheme 的 getter token 前缀不同（get/is/has/read 里 read 算），
  // 但真正的问题是 setterToken/getterToken 只做前缀剥离 ⇒ 词根不一致时必须靠声明对。
  const pairs = [{ surface: 'demo', setter: 'setPrefTheme', getter: 'prefThemeValue' }]
  const ok = diffSurface(SURFACE, ['setPrefTheme', 'prefThemeValue'], [], pairs)
  assert.deepEqual(ok.pairMisses, [], '声明对两侧都在场')
  assert.deepEqual(ok.setterWithoutGetter, [], '有声明对时不再走自动 token 匹配')
  const missing = diffSurface(SURFACE, ['setPrefTheme'], [], pairs)
  assert.deepEqual(missing.pairMisses, ['demo/setPrefTheme'], '声明对的 getter 缺席必须报')
})

test('完全对称的面四张表全空', () => {
  const d = diffSurface(SURFACE, ['getA', 'setB', 'getB'], ['getA', 'setB', 'getB'])
  assert.deepEqual(d, { kotlinOnly: [], tsOnly: [], setterWithoutGetter: [], pairMisses: [] })
})
