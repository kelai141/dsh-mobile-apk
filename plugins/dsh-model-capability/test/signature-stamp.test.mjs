// ST-03 回归（0.14.0-preview）：① 补给触发签名值敏感（含 baseURL/api 与能力字段值）；②来源戳让
// 「源变化 → 可刷新我方旧写入」成为可达路径，同时用户手写值仍不可覆盖。
// 反证：把签名退回「只记字段有无」形态 → 本文件第 1/2 组用例必须红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilitySignature, canonicalJson } from '../lib/signature.js'
import { createStampStore, planModelPatch } from '../lib/settings-writer.js'

const section = (providers) => ({ providers })

const base = () => section({
  gateway: {
    baseURL: 'https://a.example/v1',
    api: 'openai-completions',
    models: [
      { id: 'glm-5.3-flash', reasoningEfforts: { low: 'low', high: 'high' } },
      { id: 'plain-model', contextWindow: 128000 },
    ],
  },
})

/** 旧实现（只记有无）——仅用作反证对照，不参与生产。 */
function presenceOnlySignature(value) {
  const providers = value?.providers ?? {}
  const parts = []
  for (const route of Object.keys(providers).sort()) {
    const models = Array.isArray(providers[route]?.models) ? providers[route].models : []
    const ids = models.map((model) => {
      if (typeof model === 'string') return model
      const flags = ['reasoningEfforts', 'input', 'contextWindow', 'maxTokens'].map((key) => (model[key] === undefined ? '-' : '+')).join('')
      return `${String(model.id ?? '?')}${flags}`
    })
    parts.push(`${route}:[${ids.join(',')}]`)
  }
  return parts.join('|')
}

test('ST-03-① 换网关（baseURL 值变化）→ 签名必须变；旧「有无」签名不变（反证）', () => {
  const a = base()
  const b = section({
    gateway: { ...a.providers.gateway, baseURL: 'https://b.example/v1' },
  })
  assert.notEqual(capabilitySignature(a), capabilitySignature(b), 'baseURL 值变化必须改变签名')
  assert.equal(presenceOnlySignature(a), presenceOnlySignature(b), '旧签名对 baseURL 不敏感（缺陷复现）')
})

test('ST-03-① api 方言变化 → 签名必须变', () => {
  const a = base()
  const b = section({ gateway: { ...a.providers.gateway, api: 'anthropic-messages' } })
  assert.notEqual(capabilitySignature(a), capabilitySignature(b))
})

test('ST-03-① 能力字段值变化 → 签名必须变（四类字段逐条）', () => {
  const a = base()
  const cases = [
    { reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
    { input: ['text', 'image'] },
    { contextWindow: 1000000 },
    { maxTokens: 131072 },
  ]
  for (const patch of cases) {
    const b = section({
      gateway: {
        ...a.providers.gateway,
        models: [{ ...a.providers.gateway.models[0], ...patch }, a.providers.gateway.models[1]],
      },
    })
    assert.notEqual(capabilitySignature(a), capabilitySignature(b), `字段 ${Object.keys(patch)[0]} 的值变化必须改变签名`)
  }
})

test('ST-03-① 结构增删（新增路由 / 新增模型）→ 签名必须变', () => {
  const a = base()
  const b = section({ ...a.providers, second: { baseURL: 'https://c.example/v1', models: ['x'] } })
  assert.notEqual(capabilitySignature(a), capabilitySignature(b))
  const c = section({
    gateway: { ...a.providers.gateway, models: [...a.providers.gateway.models, { id: 'extra' }] },
  })
  assert.notEqual(capabilitySignature(a), capabilitySignature(c))
})

test('ST-03-① 仅对象键顺序不同 → 签名必须相同（规范化，避免假触发）', () => {
  const a = section({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'm', maxTokens: 8, contextWindow: 4 }] } })
  const b = section({ gateway: { api: 'openai-completions', models: [{ contextWindow: 4, id: 'm', maxTokens: 8 }], baseURL: 'https://a.example/v1' } })
  assert.equal(capabilitySignature(a), capabilitySignature(b))
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
})

test('ST-03-① 限定路由参与签名（config.routes 场景）', () => {
  const a = section({ one: { models: ['m'] }, two: { models: ['n'] } })
  assert.equal(capabilitySignature(a, ['one']), 'one[](m)')
  assert.notEqual(capabilitySignature(a, ['one', 'two']), capabilitySignature(a, ['one']))
})

test('ST-03-② 来源戳：新发现的值可刷新我方旧写入', () => {
  const stamps = createStampStore()
  const models = [{ id: 'm', reasoningEfforts: { low: 'low' } }]
  // 第一阶段：值缺失被填入并记戳
  const first = planModelPatch([{ id: 'm' }], [{ id: 'm', reasoningEfforts: { low: 'low' }, source: 'engine-catalog' }], stamps)
  assert.deepEqual(first.models[0].reasoningEfforts, { low: 'low' })
  stamps.set('m', 'reasoningEfforts', { value: { low: 'low' }, source: 'engine-catalog' })
  // 第二阶段：端点能力变了 → 允许覆盖「我们自己写的」旧值
  const second = planModelPatch(models, [{ id: 'm', reasoningEfforts: { low: 'low', high: 'high' }, source: 'endpoint-descriptor' }], stamps)
  assert.deepEqual(second.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  assert.equal(second.written.length, 1)
})

test('ST-03-② 用户手写值永不被覆盖（无戳）', () => {
  const stamps = createStampStore()
  const models = [{ id: 'm', reasoningEfforts: { user: 'user' } }]
  const plan = planModelPatch(models, [{ id: 'm', reasoningEfforts: { low: 'low' } }], stamps)
  assert.deepEqual(plan.models[0].reasoningEfforts, { user: 'user' })
  assert.equal(plan.changes.length, 0)
})

test('ST-03-② 用户先改掉我方写过的值 → 戳失配，不再覆盖', () => {
  const stamps = createStampStore()
  stamps.set('m', 'maxTokens', { value: 4096, source: 'engine-catalog' })
  const plan = planModelPatch([{ id: 'm', maxTokens: 8192 }], [{ id: 'm', maxTokens: 131072 }], stamps)
  assert.equal(plan.models[0].maxTokens, 8192)
  assert.equal(plan.changes.length, 0)
})

test('ST-03-② 现值与戳一致但新值与旧值相同 → 不产生写入（避免自触发循环）', () => {
  const stamps = createStampStore()
  stamps.set('m', 'maxTokens', { value: 4096, source: 'engine-catalog' })
  const plan = planModelPatch([{ id: 'm', maxTokens: 4096 }], [{ id: 'm', maxTokens: 4096 }], stamps)
  assert.equal(plan.changes.length, 0)
})

test('ST-03-② 不传戳时保持旧「只填空」语义（向后兼容）', () => {
  const plan = planModelPatch([{ id: 'm', maxTokens: 4096 }], [{ id: 'm', maxTokens: 131072 }])
  assert.equal(plan.models[0].maxTokens, 4096)
  assert.equal(plan.changes.length, 0)
})
