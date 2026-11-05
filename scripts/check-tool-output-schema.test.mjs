import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `check-tool-output-schema.mjs`（590 行）守「工具返回值 vs output.schema 运行时契约」，此前**零测试面**：
// 把 schema 整值校验、undefined 成员检测、render 判据（G2a）、url/loadState 二选一（G2b'）、
// 注册完整性任一段删掉，CI 不会有任何反应。
//
// 脚本自己就留了反向验证的口子（`--plugin <目录>` 替掉装配集），所以测试不需要改门禁：
// 造一个临时插件，用 `--plugin` 指过去即可。`--engine-tools` 不用传——脚本会自己在
// `plugins/dsh-android-manage/node_modules/@deepseek-ai/dsh-tools` 找到引擎同一个校验器。
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-tool-output-schema.mjs')

const TOOL = 'android_fixture_probe'

/** 源码侧的 `defineTool({ name: '<名>' })`。**必须用单引号**：门禁的解析正则只认字面量单引号
 *  （`name:\s*(?:'([^']+)'|常量引用)`），写双引号会让名字集合解析为空，判据改走
 *  「解析为空但运行时注册了 N 个」那条分支——本文件第一版就踩了这个坑。 */
const defineToolSrc = (name) => "export const TOOLS = [defineTool({ name: '" + name + "' })]\n"

/** 一个**合规**工具：schema 自洽、render 非空、返回值与 schema 完全一致。 */
function toolSource({
  schema = "{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }",
  render = "(_a, v) => [{ type: 'text', text: 'ok=' + String(v.ok) }]",
  execute = 'async () => ({ ok: true })',
  name = TOOL,
} = {}) {
  return [
    'export function apply(ctx) {',
    '  ctx.tools.register({',
    '    name: ' + JSON.stringify(name) + ',',
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    output: {',
    '      schema: ' + schema + ',',
    render === null ? '' : '      render: ' + render + ',',
    '    },',
    '    execute: ' + execute + ',',
    '  })',
    '}',
  ].filter((l) => l !== '').join('\n') + '\n'
}

/** 造一棵最小插件树；`lib` 的 mtime 必须晚于 `src`，否则时效判据会先拦。 */
function makePlugin({ lib, src = defineToolSrc(TOOL) }) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-output-schema-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-probe', type: 'module' }))
  writeFileSync(join(dir, 'src', 'index.ts'), src)
  writeFileSync(join(dir, 'lib', 'index.js'), lib)
  const past = new Date(Date.now() - 60_000)
  utimesSync(join(dir, 'src', 'index.ts'), past, past)
  return dir
}

function run(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--plugin', dir, ...extraArgs], {
    encoding: 'utf8',
    cwd: HERE,
    timeout: 120_000,
  })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

function withPlugin(opts, fn) {
  const dir = makePlugin(opts)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('合规假插件通过（schema 自洽 + render 非空 + 注册完整）', () => {
  withPlugin({ lib: toolSource() }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 0, out)
    assert.match(out, /CHECK-TOOL-OUTPUT-SCHEMA PASSED/)
  })
})

test('返回值多一个未声明键就判红（引擎整值校验会拒绝）', () => {
  withPlugin({ lib: toolSource({ execute: 'async () => ({ ok: true, extra: 1 })' }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /CHECK-TOOL-OUTPUT-SCHEMA FAILED/)
    assert.match(out, /extra/)
  })
})

test('返回值含 undefined 成员就判红（会被 lossless 物化丢弃，语义与声明不符）', () => {
  withPlugin({ lib: toolSource({ execute: 'async () => ({ ok: undefined })' }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /undefined/)
  })
})

test('不声明 render 就判红（G2a-1：工具结果无从传达给模型）', () => {
  withPlugin({ lib: toolSource({ render: null }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /未声明 render（G2a-1）/)
  })
})

test('render 输出空文本就判红（模型什么都看不到）', () => {
  withPlugin({ lib: toolSource({ render: "() => [{ type: 'text', text: '   ' }]" }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /render 输出为空文本/)
  })
})

test('output.schema 缺 additionalProperties:false 就判红（整值校验无从成立）', () => {
  withPlugin({ lib: toolSource({ schema: "{ type: 'object', properties: { ok: { type: 'boolean' } } }" }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /output\.schema 不自洽/)
  })
})

test('src 里 defineTool 了但运行时没注册就判红（死代码，提示文案还在引导模型去调它）', () => {
  const lib = toolSource({ name: 'android_other_name' })
  const src = defineToolSrc(TOOL)
  withPlugin({ lib, src }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /defineTool 了但没进 tools\(\) 注册集合/)
  })
})

test('execute 抛异常就判红（工具必须返回错误对象而非抛异常）', () => {
  withPlugin({ lib: toolSource({ execute: "async () => { throw new Error('boom') }" }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /execute 抛错/)
    assert.match(out, /boom/)
  })
})

test('schema 声明 url 但不声明 loadState 就判红（G2b\u2032：url 单值区分不了成功/失败）', () => {
  const schema = "{ type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, url: { type: 'string' } } }"
  withPlugin({ lib: toolSource({ schema, execute: "async () => ({ ok: true, url: 'https://e.x/' })" }) }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /声明了 url 但\*\*未声明 loadState\*\*/)
  })
})

test('声明 loadState 但两态 render 逐字相同就判红（G2a-2：issue #232 的假回执形态）', () => {
  // 工具从夹具 face 的 browserState op 取两态（脚本内部按 isError 切换 loaded/error）。
  const schema = "{ type: 'object', additionalProperties: false, properties: { loadState: { type: 'string' }, reason: { type: 'string' } } }"
  const lib = [
    "let face = null",
    'export function apply(ctx) {',
    "  face = ctx.get('androidPrivilege')",
    '  ctx.tools.register({',
    '    name: ' + JSON.stringify(TOOL) + ',',
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    output: {',
    '      schema: ' + schema + ',',
    "      render: () => [{ type: 'text', text: '加载状态回执' }],",
    '    },',
    '    execute: async () => {',
    "      const r = await face.controlExec('browserState', {})",
    '      const state = r?.data ?? {}',
    "      return { loadState: String(state.loadState ?? ''), reason: String(state.reason ?? '') }",
    '    },',
    '  })',
    '}',
  ].join('\n') + '\n'
  withPlugin({ lib }, (dir) => {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /两态的 render 文本\*\*逐字相同\*\*（G2a-2）/)
  })
})
