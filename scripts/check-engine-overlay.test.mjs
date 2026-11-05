import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./check-engine-overlay.mjs', import.meta.url), 'utf8')
const registry = JSON.parse(readFileSync(new URL('./patches/registry.json', import.meta.url), 'utf8'))
const patch = registry.patches.find(p => p.id === 'client-registry-scan-C4')
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

test('artifact gate rejects old C4-only bytes while keeping both markers mandatory', () => {
  assert.deepEqual(patch.requiredMarkers, ['dsh-mobile gateway client source G1'])
  const want = new Map(), meta = metadata(patch, patch.target, want)
  assert.equal(failures(meta, patch.marker).length, 1)
  assert.match(failures(meta, patch.marker)[0], /gateway client source G1/)
  assert.match(failures(meta, patch.requiredMarkers[0])[0], /registry scan C4/)
  assert.equal(failures(meta, patch.marker + '\n' + patch.requiredMarkers[0]).length, 0)
})

test('later companion metadata cannot erase main required markers', () => {
  const want = new Map()
  metadata(patch, patch.target, want)
  const companion = { id: 'companion', target: 'other.js', marker: 'companion-marker', verifier: 'exact-verifier', requiredMarkers: ['only-for-other-target'] }
  const meta = metadata(companion, patch.target, want)
  assert.deepEqual(Array.from(meta.requiredMarkers), patch.requiredMarkers)
  assert.match(failures(meta, 'companion-marker')[0], /gateway client source G1/)
  assert.equal(failures(meta, 'companion-marker\n' + patch.requiredMarkers[0]).length, 0)
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
