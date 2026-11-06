import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./check-engine-overlay.mjs', import.meta.url), 'utf8')
const registry = JSON.parse(readFileSync(new URL('./patches/registry.json', import.meta.url), 'utf8'))
// Execute the gate's actual metadata and assertion blocks, not a duplicate implementation.
const mapStart = source.indexOf('    const marker = String(patch.targetMarkers')
const mapEnd = source.indexOf('\n  }\n  if (patch.verifier)', mapStart)
const checkStart = source.indexOf('    if (!meta.verifier && !content.includes(meta.marker))')
const checkEnd = source.indexOf('\n    checked++', checkStart)
assert.ok(mapStart > 0 && mapEnd > mapStart && checkStart > 0 && checkEnd > checkStart)
const metadataCode = source.slice(mapStart, mapEnd)
const assertionCode = source.slice(checkStart, checkEnd)
function metadata(patch, path, want) { runInNewContext(metadataCode, { patch, path, want }); return want.get(path) }
function failures(meta, content) { const fails = []; runInNewContext(assertionCode, { meta, content, fails }); return fails }

test('artifact gate keeps every required marker mandatory, not just the primary one', () => {
  // 用合成 patch 验证机制本身：判据是「requiredMarkers 里任何一条缺席都必须判红」，
  // 与具体是哪个补丁无关。合成而不是绑定某条真实补丁，是因为这个机制是门禁的通用能力，
  // 绑定真实补丁会让「真实补丁退役」连带把机制测试一起带走（原先绑 client-registry-scan-C4
  // 就是这么失效的：补丁在 0.2.2 适配中退役，测试跟着红，而机制其实没问题）。
  const carrier = { id: 'synthetic-carrier', target: 'synthetic.js', marker: 'primary-marker',
    requiredMarkers: ['secondary-marker-a', 'secondary-marker-b'] }
  const want = new Map(), meta = metadata(carrier, carrier.target, want)
  assert.equal(failures(meta, carrier.marker).length, 2, '两条 requiredMarker 都缺席时必须都判红')
  assert.match(failures(meta, carrier.marker)[0], /secondary-marker-a/)
  assert.equal(failures(meta, carrier.marker + '\nsecondary-marker-a').length, 1)
  assert.equal(failures(meta, carrier.marker + '\nsecondary-marker-a\nsecondary-marker-b').length, 0)
})

test('later companion metadata cannot erase main required markers', () => {
  const main = { id: 'main', target: 'main.js', marker: 'main-marker', requiredMarkers: ['main-required'] }
  const want = new Map()
  metadata(main, main.target, want)
  // 伴生补丁指向同一文件、且自带一条只属于自己的 requiredMarkers：
  // 合并结果必须是「主 + 伴生」的并集，不能因为后写就把主的那条抹掉。
  const companion = { id: 'companion', target: 'main.js', marker: 'companion-marker', verifier: 'exact-verifier', requiredMarkers: ['companion-required'] }
  const meta = metadata(companion, main.target, want)
  assert.deepEqual(Array.from(meta.requiredMarkers).sort(), ['companion-required', 'main-required'])
  assert.equal(failures(meta, 'companion-marker\ncompanion-required').length, 1, '主补丁的 required 缺席仍须判红')
  assert.equal(failures(meta, 'companion-marker\ncompanion-required\nmain-required').length, 0)
})

test('retired client-registry-scan-C4 stays retired and out of the overlay', () => {
  // 退役契约：这条补丁一旦被人从 retired 挪回 patches，本断言必须红。
  // 依据是上游 0.2.2 已自带 C4/G1 的能力，我们再加一层只会制造双份真源。
  assert.equal(registry.patches.some(p => p.id === 'client-registry-scan-C4'), false,
    'client-registry-scan-C4 已退役：上游 0.2.2 已具备该能力，不得重新挂回 patches')
  assert.equal(registry.retired.some(p => (p.id ?? p) === 'client-registry-scan-C4'), true,
    'client-registry-scan-C4 必须留在 retired 清单里，退役决定要有账可查')
})

const exactStart = source.indexOf('function exactRuntimeDependencyGaps(')
const exactEnd = source.indexOf('// Exact dependency resolution ends.', exactStart)
assert.ok(exactStart > 0 && exactEnd > exactStart)
const exactGaps = runInNewContext(source.slice(exactStart, exactEnd) + '\nexactRuntimeDependencyGaps')
const engine = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/'
const consumerPath = engine + '@deepseek-ai/dsh-otel/package.json'
const transformerPath = engine + '@opentelemetry/otlp-transformer/package.json'
const nestedTransformer = consumerPath.replace('/package.json', '/node_modules/@opentelemetry/otlp-transformer/package.json')
const packageMeta = (name, version, runtimeRequirements = {}) => ({ name, version, runtimeRequirements })
function oldTelemetry() {
  return {
    [consumerPath]: packageMeta('@deepseek-ai/dsh-otel', '0.2.1-rc.3', { '@opentelemetry/otlp-transformer': '0.222.0' }),
    [transformerPath]: packageMeta('@opentelemetry/otlp-transformer', '0.220.0'),
  }
}

test('telemetry rejects the installed older exact dependency', () => {
  const gaps = exactGaps(oldTelemetry(), [consumerPath])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].required, '0.222.0')
  assert.equal(gaps[0].actual, '0.220.0')
})
test('consumer-local closure satisfies telemetry without replacing another root version', () => {
  const present = oldTelemetry()
  present[nestedTransformer] = packageMeta('@opentelemetry/otlp-transformer', '0.222.0')
  assert.equal(exactGaps(present, [consumerPath]).length, 0)
  assert.equal(present[transformerPath].version, '0.220.0')
})
test('a stale nested copy cannot be hidden by a matching root copy', () => {
  const present = oldTelemetry()
  present[transformerPath].version = '0.222.0'
  present[nestedTransformer] = packageMeta('@opentelemetry/otlp-transformer', '0.220.0')
  assert.equal(exactGaps(present, [consumerPath])[0].resolved, nestedTransformer)
})
test('nested transitive exact requirements are inspected', () => {
  const present = oldTelemetry()
  present[nestedTransformer] = packageMeta('@opentelemetry/otlp-transformer', '0.222.0', { '@opentelemetry/core': '2.11.0' })
  present[engine + '@opentelemetry/core/package.json'] = packageMeta('@opentelemetry/core', '2.9.0')
  assert.equal(exactGaps(present, [consumerPath])[0].dependency, '@opentelemetry/core')
})
test('missing telemetry dependencies remain failures', () => {
  const present = oldTelemetry()
  delete present[transformerPath]
  assert.equal(exactGaps(present, [consumerPath])[0].actual, null)
})
test('dependency cycles terminate without suppressing exact mismatches', () => {
  const present = oldTelemetry()
  present[transformerPath] = packageMeta('@opentelemetry/otlp-transformer', '0.222.0', { '@deepseek-ai/dsh-otel': '0.2.1-rc.3' })
  assert.equal(exactGaps(present, [consumerPath]).length, 0)
})
test('unmounted unrelated consumers are outside the telemetry contract', () => {
  assert.equal(exactGaps(oldTelemetry(), []).length, 0)
})
test('scanner retains dependency requirements rather than only their names', () => {
  assert.match(source, /'runtimeRequirements': j\.get\('dependencies'\) or \{\}/)
})
test('overlay pins the complete private telemetry SDK closure', () => {
  const overlay = JSON.parse(readFileSync(new URL('./snapshot-config/engine-overlay.json', import.meta.url), 'utf8'))
  const closure = overlay.nested['@deepseek-ai/dsh-otel']
  for (const name of ['api-logs', 'otlp-exporter-base', 'otlp-transformer', 'sdk-logs']) assert.equal(closure['@opentelemetry/' + name], '0.222.0')
  for (const name of ['core', 'resources', 'sdk-metrics', 'sdk-trace']) assert.equal(closure['@opentelemetry/' + name], '2.11.0')
  assert.equal(overlay.nested['@deepseek-ai/dsh-session-telemetry-otel']['@opentelemetry/api-logs'], '0.222.0')
})
