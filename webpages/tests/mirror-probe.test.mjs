// issue #1393：镜像判活不得有执行面（不再用 <script src>），且三态判据必须如实。
//
// 缺陷形态：旧实现把镜像的 MANIFEST.txt 当脚本加载来判活。任一镜像返回可执行 JS（被投毒 /
// 反代把错误页换成 JS / 302 到第三方）就会在**本页 origin 内执行**，而本页是 APK 分发口——
// 执行后可改写所有下载链接指向任意 APK。
//
// 判据分两层：
//   ① 源码级：app.js 不得再为探测创建 <script>（执行面存在的充要条件）；
//   ② 行为级：纯函数 classifyProbe / looksLikeManifest 的三态与 MANIFEST 识别。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { classifyProbe, looksLikeManifest } from '../src/assets/probe.js'

const APP = new URL('../src/assets/app.js', import.meta.url)
const appSource = readFileSync(APP, 'utf8')

/** 去掉注释行，避免注释里提到 <script> 被当成实现。 */
const codeOnly = (text) => text.split('\n').filter((l) => {
  const s = l.trimStart()
  return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))
}).join('\n')

const SHA = 'a'.repeat(64)
const MANIFEST = [
  SHA + '  apk/dsh-mobile-apk-v0.14.9-arm64.apk  12345678',
  SHA + '  notes.md  2048',
  SHA + '  snapshot/snapshot-arm64.tar.xz  99',
  '',
].join('\n')

test('#1393 判活不得再创建 <script>（执行面的充要条件）', () => {
  const code = codeOnly(appSource)
  assert.equal(/createElement\(['"]script['"]\)/.test(code), false,
    'app.js 仍在为探测创建 <script> —— 镜像返回的字节会在本页 origin 内执行')
  assert.equal(/script\.src\s*=/.test(code), false, 'app.js 仍在给 script 赋 src')
  assert.equal(/appendChild\(\s*script\s*\)/.test(code), false, 'app.js 仍把 script 挂进 DOM')
})

test('#1393 判活只用 fetch（无执行面），且 cors 失败会退回 no-cors 再判', () => {
  const code = codeOnly(appSource)
  assert.match(code, /fetch\(url, \{ mode: 'cors'/, '缺少 cors 探测')
  assert.match(code, /fetch\(url, \{ mode: 'no-cors'/, 'cors 被拒时缺少 no-cors 退回')
})

test('#1393 looksLikeManifest：只认 <sha256>  <path>  <size> 的整份正文', () => {
  assert.equal(looksLikeManifest(MANIFEST), true, '真 MANIFEST 必须被认')
  // 被投毒的镜像返回 JS / HTML / 错误页时一律不认——这正是本条要挡的形态
  assert.equal(looksLikeManifest('alert(1)'), false, 'JS 被认成 MANIFEST')
  assert.equal(looksLikeManifest('<html><body>403</body></html>'), false, 'HTML 错误页被认成 MANIFEST')
  assert.equal(looksLikeManifest(''), false)
  assert.equal(looksLikeManifest('   \n\n'), false)
  assert.equal(looksLikeManifest(null), false)
  // 单行混进非 MANIFEST 行也必须整体不认（防「前几行像就放行」）
  assert.equal(looksLikeManifest(MANIFEST + 'alert(1)\n'), false, '尾部追加 JS 仍被认成 MANIFEST')
  assert.equal(looksLikeManifest(SHA + '  apk/x.apk  1'), true, '单行合法也必须被认')
})

test('#1393 classifyProbe：三态必须如实，4xx/opaque 不得算「确认可达」', () => {
  assert.equal(classifyProbe({ ok: true, status: 200, text: MANIFEST }), 'ok', '真 MANIFEST 应判可达')
  assert.equal(classifyProbe({ ok: true, status: 200, text: 'alert(1)' }), 'unknown',
    '200 但正文不是 MANIFEST，不得算确认可达')
  assert.equal(classifyProbe({ ok: false, status: 403, text: null }), 'unknown',
    '403 只证明连得上，不得算可达也不得算不可达（旧实现把它当死线，会让死线被当成最快）')
  assert.equal(classifyProbe({ ok: false, status: 0, text: null }), 'unknown', 'opaque 响应应为无法判定')
  assert.equal(classifyProbe({ aborted: true }), 'unknown', '超时不得算不可达')
  assert.equal(classifyProbe({ error: 'Failed to fetch' }), 'unreachable', '网络层失败应为不可达')
})
