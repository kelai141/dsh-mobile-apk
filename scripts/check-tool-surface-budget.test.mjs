import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `check-tool-surface-budget.mjs`（240 行）守「模型面工具 wire 预算」，但此前**零测试面**：
// 把 ±2% 的阈值判断删掉、或把「新增可见工具必须评审」的名字级判定删掉，CI 不会有任何反应。
//
// 脚本本来就 `await import()` 各插件的 `lib/index.js` 并真跑 `apply()`，所以测试只需要一棵
// **假插件树** —— 加一个只给测试用的 `--root <dir>`（默认行为不变）就能把六插件、bridge 导出与
// 基线全换成临时目录，既跑得快也不碰真实构建产物。
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-tool-surface-budget.mjs')

const PLUGINS = [
  'dsh-android-bridge', 'dsh-android-manage', 'dsh-android-browser',
  'dsh-android-vdisplay', 'dsh-android-file-open', 'dsh-android-linux-env',
]
const BRIDGE_LIB = ['plugins', 'dsh-android-bridge', 'lib', 'index.js']

/** 一个插件注册哪些工具、导出什么，全由这里的字符串决定，方便逐条破坏。 */
function pluginSource(plugin, { extraTools = [], toolBody = '', dupName = null } = {}) {
  if (plugin === 'dsh-android-bridge') {
    const names = ['android_capabilities', 'android_screen_list', ...extraTools]
    return [
      'export const DEVICE_TOOL_GROUPS = ' + JSON.stringify({ screen: ['android_screen_list'] }),
      "export const CAPABILITY_TOOL_NAME = 'android_capabilities'",
      'export function apply(ctx) {',
      ...names.map((n) => `  ctx.tools.register({ name: '${n}', description: 'd${toolBody}', parameters: {} })`),
      '}',
    ].join('\n')
  }
  const name = dupName ?? ('android_' + plugin.replace(/^dsh-android-/, '') + '_tool')
  const names = [name, ...extraTools]
  return [
    'export function apply(ctx) {',
    ...names.map((n) => `  ctx.tools.register({ name: '${n}', description: 'd${toolBody}', parameters: {} })`),
    '}',
  ].join('\n')
}

/** 直接写一份 bridge 源码（用来制造「组名单漂移」「facade 被掩蔽」这类整体违规）。 */
function bridgeSource({ groups, facade = 'android_capabilities', names = ['android_capabilities', 'android_screen_list'] }) {
  return [
    'export const DEVICE_TOOL_GROUPS = ' + JSON.stringify(groups),
    'export const CAPABILITY_TOOL_NAME = ' + JSON.stringify(facade),
    'export function apply(ctx) {',
    ...names.map((n) => `  ctx.tools.register({ name: '${n}', description: 'd', parameters: {} })`),
    '}',
  ].join('\n')
}

/** 造一棵假插件树；`overrides` 按插件名替换源码。 */
function makeTree(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'surface-budget-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  for (const plugin of PLUGINS) {
    const lib = join(dir, 'plugins', plugin, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(dir, 'plugins', plugin, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(join(lib, 'index.js'), overrides[plugin] ?? pluginSource(plugin))
  }
  return dir
}

function run(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', dir, ...extraArgs], { encoding: 'utf8' })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

/** 造树 + 生成基线（基线必须由合规树生成）。 */
function freshBaseline() {
  const dir = makeTree()
  const seeded = run(dir, ['--update'])
  assert.equal(seeded.status, 0, seeded.out)
  return dir
}

/** 把基线数字放大，制造「字节层面有余量、只有名字级判定能拦」的场景。 */
function inflateBaseline(dir, factor = 1.5) {
  const file = join(dir, 'scripts', 'tool-surface-budget.json')
  const baseline = JSON.parse(readFileSync(file, 'utf8'))
  baseline.baseline = Math.ceil(baseline.baseline * factor)
  baseline.initialVisible = Math.ceil(baseline.initialVisible * factor)
  writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n')
}

test('与基线一致的假插件树通过，并打印两个口径', () => {
  const dir = freshBaseline()
  try {
    const { status, out } = run(dir)
    assert.equal(status, 0, out)
    assert.match(out, /CHECK-TOOL-SURFACE-BUDGET PASSED/)
    assert.match(out, /注册集 \d+ B \/ 基线 \d+ B/)
    assert.match(out, /可见集名单 == 登记/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('description 变长超过 +2% 阈值就判红（注册集）', () => {
  const dir = freshBaseline()
  try {
    const lib = join(dir, 'plugins', 'dsh-android-manage', 'lib', 'index.js')
    writeFileSync(lib, pluginSource('dsh-android-manage', { toolBody: 'x'.repeat(400) }))
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /超预算（注册集）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('字节有余量时，新增一个可见工具仍被名字级判定拦住', () => {
  const dir = freshBaseline()
  try {
    // 先把基线放大，让「注册集/初始集字节」都还在阈值内 —— 这样只剩名字级判定能拦。
    inflateBaseline(dir)
    writeFileSync(
      join(dir, 'plugins', 'dsh-android-browser', 'lib', 'index.js'),
      pluginSource('dsh-android-browser', { extraTools: ['android_n'] }),
    )
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.doesNotMatch(out, /超预算/, '本用例要求字节不超阈值，否则测不到名字级判定')
    assert.match(out, /模型第一眼新增工具（未经判定）：android_n/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('掩蔽清单里出现未注册的名字就判红（组名单与实现漂移）', () => {
  const dir = freshBaseline()
  try {
    writeFileSync(
      join(dir, ...BRIDGE_LIB),
      bridgeSource({ groups: { screen: ['android_screen_list', 'android_ghost'] } }),
    )
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /掩蔽清单里有未注册的工具名/)
    assert.match(out, /android_ghost/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facade 被掩蔽就判红（模型没有任何入口解锁能力组）', () => {
  const dir = freshBaseline()
  try {
    writeFileSync(
      join(dir, ...BRIDGE_LIB),
      bridgeSource({ groups: { screen: ['android_screen_list', 'android_capabilities'] } }),
    )
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /常驻 facade 不在初始可见集/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两个插件注册同名工具就判红（模型面工具名必须唯一）', () => {
  const dir = freshBaseline()
  try {
    writeFileSync(
      join(dir, 'plugins', 'dsh-android-vdisplay', 'lib', 'index.js'),
      pluginSource('dsh-android-vdisplay', { dupName: 'android_screen_list' }),
    )
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /模型面工具名重复/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缺基线文件时判红并给出修法', () => {
  const dir = makeTree()
  try {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /缺少基线文件 .*tool-surface-budget\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--update 会把当前实测写回基线（同一棵树再跑就绿）', () => {
  const dir = makeTree()
  try {
    const first = run(dir)
    assert.equal(first.status, 1, first.out)
    const seeded = run(dir, ['--update'])
    assert.equal(seeded.status, 0, seeded.out)
    const baseline = JSON.parse(readFileSync(join(dir, 'scripts', 'tool-surface-budget.json'), 'utf8'))
    assert.equal(typeof baseline.baseline, 'number')
    assert.ok(Array.isArray(baseline.visibleTools))
    const again = run(dir)
    assert.equal(again.status, 0, again.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
