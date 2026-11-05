// Web Speech API 补丁（issue #1307）：Android WebView 里 speechSynthesis / SpeechSynthesisUtterance
// 都是 undefined。补丁把它接到壳面 window.androidBridge.tts*，本文件只判**行为**：
//   ① 桥面被真的调用（调用参数、调用次数）；
//   ② 成功路径的事件与状态（start / speaking / pending）；
//   ③ **失败可见**——桥缺席、桥回 ok:false、方法不存在，都必须派发 error 并把原因留在
//      speechSynthesis.__dshLastError 上；不许静默当作「说过话」；
//   ④ 幂等：内核已经自带 speechSynthesis 时一行都不许改。
// 手法与同目录的 polyfill-*.test.mjs 一致：从 lib/index.js 截真实的 POLYFILLS 条目，
// 拼成页面实际收到的那一段，在删掉原生的 vm realm 里执行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 取真实 POLYFILLS 并按注入口径拼接（与 smoke-injections.mjs 同形）。 */
function polyfillBody() {
  const start = SRC.indexOf('const POLYFILLS = [')
  assert.ok(start > 0, 'lib/index.js 必须定义 POLYFILLS')
  const end = SRC.indexOf('\n];', start)
  assert.ok(end > start, 'POLYFILLS 必须能被完整截取')
  const snippets = new Function(SRC.slice(start, end + 3) + '\nreturn POLYFILLS')()
  assert.ok(Array.isArray(snippets) && snippets.length > 0, 'POLYFILLS 必须是非空数组')
  return snippets.map((s) => s.trim()).map((s) => (s.endsWith(';') ? s : s + ';')).join('\n')
}

const BODY = polyfillBody()

/** 造一个「Android WebView 形态」的 realm：没有 speechSynthesis，注入假桥与记录数组。 */
function realm(bridge) {
  const calls = []
  const errors = []
  const context = createContext({ console: { error: (m) => errors.push(String(m)), log: () => {} } })
  runInContext('delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance;', context)
  context.__calls = calls
  context.__errors = errors
  if (bridge !== undefined) {
    context.__bridge = bridge
    runInContext('globalThis.androidBridge = __bridge', context)
  }
  runInContext(BODY, context)
  return { context, calls, errors }
}

test('#1307 补上两个全局：speechSynthesis 与 SpeechSynthesisUtterance', () => {
  const { context } = realm(undefined)
  assert.equal(runInContext('typeof speechSynthesis', context), 'object')
  assert.equal(runInContext('typeof SpeechSynthesisUtterance', context), 'function')
  assert.equal(runInContext('typeof (new SpeechSynthesisUtterance("hi")).text', context), 'string')
  // 规范默认值（属性面）：rate/pitch/volume = 1、lang/text 空串、voice = null
  const defaults = runInContext('(function(){var u=new SpeechSynthesisUtterance();return JSON.stringify([u.text,u.lang,u.rate,u.pitch,u.volume,u.voice])})()', context)
  assert.deepEqual(JSON.parse(defaults), ['', '', 1, 1, 1, null])
})

test('#1307 getVoices 走桥面并把列表映射成 voice 对象', () => {
  const { context, calls } = realm({
    ttsVoices: () => {
      calls.push(['ttsVoices'])
      return JSON.stringify({ ok: true, voices: [{ name: 'zh-tech', lang: 'zh-CN', local: true }, { name: 'en', lang: 'en-US', local: false }] })
    },
  })
  const out = runInContext('JSON.stringify(speechSynthesis.getVoices())', context)
  const voices = JSON.parse(out)
  assert.deepEqual(calls, [['ttsVoices']], 'getVoices 必须真的问桥面（不是返回空数组了事）')
  assert.deepEqual(voices.map((v) => [v.name, v.lang, v.local]), [['zh-tech', 'zh-CN', true], ['en', 'en-US', false]])
  assert.equal(voices[0].default, true, '第一个 voice 必须标 default（Web Speech 的常见约定）')
  assert.match(voices[0].voiceURI, /^dsh-tts:/, 'voiceURI 必须可区分于原生 voice')
})

test('#1307 speak 走桥面：参数按 (text, lang, rate, pitch) 传，成功后派发 start', () => {
  const { context, calls } = realm({
    ttsSpeak: (text, lang, rate, pitch) => {
      calls.push(['ttsSpeak', text, lang, rate, pitch])
      return JSON.stringify({ ok: true, utteranceId: 'u-1' })
    },
  })
  const result = runInContext(`(function(){
    var u = new SpeechSynthesisUtterance('测试朗读')
    u.lang = 'zh-CN'; u.rate = 1.5; u.pitch = 0.8
    var seen = []
    u.onstart = function(){ seen.push('start') }
    u.onend = function(){ seen.push('end') }
    u.onerror = function(e){ seen.push('error:' + e.reason) }
    speechSynthesis.speak(u)
    return JSON.stringify({ seen: seen, speaking: speechSynthesis.speaking, pending: speechSynthesis.pending, lastError: speechSynthesis.__dshLastError })
  })()`, context)
  const got = JSON.parse(result)
  assert.deepEqual(calls, [['ttsSpeak', '测试朗读', 'zh-CN', 1.5, 0.8]], 'speak 必须把 utterance 的字段原样交给桥面')
  assert.deepEqual(got.seen, ['start'], '成功入队后必须派发 start（v1 不编造 end）')
  assert.equal(got.speaking, true)
  assert.equal(got.pending, true)
  assert.equal(got.lastError, '', '成功路径不得留下错误')
})

test('#1307 cancel 走桥面 ttsStop，并结束挂起的 utterance', () => {
  const { context, calls } = realm({
    ttsSpeak: () => {
      calls.push(['ttsSpeak'])
      return JSON.stringify({ ok: true, utteranceId: 'u-1' })
    },
    ttsStop: () => {
      calls.push(['ttsStop'])
      return JSON.stringify({ ok: true })
    },
  })
  const result = runInContext(`(function(){
    var seen = []
    var u = new SpeechSynthesisUtterance('x')
    u.onend = function(){ seen.push('end') }
    speechSynthesis.speak(u)
    speechSynthesis.cancel()
    return JSON.stringify({ seen: seen, speaking: speechSynthesis.speaking, pending: speechSynthesis.pending })
  })()`, context)
  assert.deepEqual(calls.map((c) => c[0]), ['ttsSpeak', 'ttsStop'], 'cancel 必须真的让桥面停止')
  const got = JSON.parse(result)
  assert.deepEqual(got.seen, ['end'], 'cancel 必须给挂起的 utterance 一个 end（否则调用方永远等）')
  assert.equal(got.speaking, false)
  assert.equal(got.pending, false)
})

test('#1307 失败必须可见：桥缺席 ⇒ error 事件 + __dshLastError，而不是静默', () => {
  const { context, errors } = realm(undefined)
  const result = runInContext(`(function(){
    var u = new SpeechSynthesisUtterance('x')
    var seen = []
    u.onerror = function(e){ seen.push(String(e.error) + '|' + String(e.reason)) }
    speechSynthesis.speak(u)
    var afterSpeak = speechSynthesis.__dshLastError
    var voices = speechSynthesis.getVoices()
    return JSON.stringify({ seen: seen, voices: voices.length, lastError: afterSpeak, voicesError: speechSynthesis.__dshLastError, speaking: speechSynthesis.speaking })
  })()`, context)
  const got = JSON.parse(result)
  assert.equal(got.seen.length, 1, '桥缺席时 speak 必须派发一次 error（不许静默）: ' + JSON.stringify(got))
  assert.match(got.seen[0], /^synthesis-failed\|/, 'error 事件必须带机器可读的 error 名')
  assert.match(got.seen[0], /ttsSpeak/, 'reason 必须点名缺的是哪个桥方法')
  assert.match(got.lastError, /ttsSpeak/, '原因必须留在 __dshLastError 上（失败可见）')
  assert.equal(got.voices, 0)
  assert.match(got.voicesError, /ttsVoices/, 'getVoices 的失败同样要留在 __dshLastError 上')
  assert.equal(got.speaking, false)
  assert.ok(errors.length >= 1, '同时必须写 console.error（日志可见）')
})

test('#1307 失败必须可见：桥回 ok:false ⇒ error 携带桥面原因', () => {
  const { context } = realm({
    ttsSpeak: () => JSON.stringify({ ok: false, reason: 'tts engine has no zh-CN voice' }),
    ttsVoices: () => JSON.stringify({ ok: false, reason: 'tts not initialized' }),
  })
  const result = runInContext(`(function(){
    var u = new SpeechSynthesisUtterance('x')
    var seen = []
    u.onerror = function(e){ seen.push(String(e.reason)) }
    speechSynthesis.speak(u)
    speechSynthesis.getVoices()
    return JSON.stringify({ seen: seen, lastError: speechSynthesis.__dshLastError })
  })()`, context)
  const got = JSON.parse(result)
  assert.deepEqual(got.seen, ['tts engine has no zh-CN voice'], '桥面的 ok:false 原因必须原样转达（不许当成成功）')
  assert.equal(got.lastError, 'tts not initialized')
})

test('#1307 pause/resume 不假装成功：派发 error 说明 v1 不支持', () => {
  const { context } = realm({ ttsSpeak: () => JSON.stringify({ ok: true }), ttsStop: () => JSON.stringify({ ok: true }) })
  const result = runInContext(`(function(){
    var u = new SpeechSynthesisUtterance('x')
    var seen = []
    u.onerror = function(e){ seen.push(String(e.reason)) }
    speechSynthesis.speak(u)
    speechSynthesis.pause()
    speechSynthesis.resume()
    return JSON.stringify({ seen: seen, paused: speechSynthesis.paused })
  })()`, context)
  const got = JSON.parse(result)
  assert.equal(got.seen.length, 2, 'pause/resume 各派发一次 error: ' + JSON.stringify(got))
  assert.match(got.seen[0], /not supported/)
  assert.equal(got.paused, false, 'paused 必须如实为 false')
})

test('#1307 幂等：内核已自带 speechSynthesis 时一行都不改', () => {
  const context = createContext({ console })
  runInContext('globalThis.speechSynthesis = { native: true }; globalThis.SpeechSynthesisUtterance = function N(){}', context)
  runInContext(BODY, context)
  assert.equal(runInContext('speechSynthesis.native', context), true, '原生实现不得被覆盖')
  assert.equal(runInContext('SpeechSynthesisUtterance.name', context), 'N', '原生构造器不得被覆盖')
})
