// FX-204.3（B1）：android_env_recipe 的返回面（version / profilePatch）必须都在 output.schema
// 声明面内——引擎在 render 之前用同一个 validateJsonSchemaValue 校验整值，多一个未声明键整条拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

function applyEnv() {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: { status: () => ({ tier: 'T1' }) },
  })
  return { tools, byName: (n) => tools.find((t) => t.name === n) }
}

test('FX-204.3：android_env_recipe 返回值过引擎同款校验器（违规条数 = 0）', async () => {
  const { byName } = applyEnv()
  const tool = byName('android_env_recipe')
  assert.ok(tool, 'android_env_recipe 必须已注册')
  const v = await tool.execute({}, { agent: { session: 's1' } })

  const bad = validateJsonSchemaValue(tool.output.schema, v, 'value')
  assert.equal(bad.length, 0, '违规条数必须 = 0：' + bad.join('; '))
  assert.equal(typeof v.version, 'string', 'version 必须在场（DSH_APP_VERSION 单一来源）')
  assert.ok(!Object.values(v).some((x) => x === undefined), '可选键必须整键不发，不得是 undefined')

  // 反向自证（内嵌）：撤掉任一声明，同一形态的返回值立刻违规——证明这两条声明是承重的。
  for (const key of ['version', 'profilePatch']) {
    const properties = { ...tool.output.schema.properties }
    delete properties[key]
    const sample = { ...v, [key]: key === 'profilePatch' ? 'patch: content' : '0.14.0-preview' }
    const viol = validateJsonSchemaValue({ ...tool.output.schema, properties }, sample, 'value')
    assert.ok(viol.length > 0 && viol[0].includes(key), `撤掉 ${key} 声明必须违规：` + JSON.stringify(viol))
  }
})
