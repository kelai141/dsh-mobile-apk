// 0.14.1 块 E 路由面回归：两条 runtime-cache 路由必须**自带鉴权**、只认正确方法、
// 且经路由执行时白名单语义与直接调用 planCleanup/executeCleanup 完全一致（逐字节判据不变）。
//
// 为什么单测路由面而不是只测库面：`/api` 下的 exact 路由不经上游浏览器鉴权（本仓 #222 的
// 既有结论），鉴权只能由注册块自己承担——`check-api-route-auth.mjs` 只做静态标记校验，
// 运行期「拒绝真的发生了」必须在这里断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const TOKEN = 'a'.repeat(32)

function makeCtx(services = {}) {
  const routes = new Map()
  const resolvedServices = { ...services }
  const target = {
    tools: { register() {} },
    webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    get: (name) => resolvedServices[name],
    effect(cb) { cb(); return () => {} },
  }
  return { ctx: target, routes }
}

function makeRes() {
  return {
    code: 0,
    body: '',
    headers: {},
    writeHead(code, headers) { this.code = code; this.headers = headers ?? {} },
    end(body) { this.body = body ?? '' },
  }
}

async function call(harness, path, {
  method = 'GET',
  token = TOKEN,
  host = '127.0.0.1:3080',
} = {}) {
  const route = harness.routes.get(path)
  assert.ok(route, '路由必须注册：' + path)
  const headers = { host }
  if (token !== '') headers['x-dsh-control-token'] = token
  const res = makeRes()
  await route.handler({ method, headers }, res)
  return res
}

/** 一次性 fixture：DSH_HOME 下的用户资产 + 白名单内/外缓存 + 日志世代。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rc-route-'))
  const home = join(root, 'home', '.dsh')
  const files = join(root, 'files')
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  write(join(home, '.credentials.yaml'), 'apiKey: secret\n')
  write(join(home, 'settings.yaml'), 'model: deepseek\n')
  write(join(home, 'sessions', 's1.jsonl'), '{"event":"session"}\n')
  write(join(home, 'attachments', 'v1', 'x.png'), 'PNGDATA')
  write(join(home, 'profiles', 'web', 'node_modules', 'dep', 'index.js'), 'module.exports=1\n')
  write(join(home, 'cache', 'attachments', 'request-images', 'ab', 'hash'), 'ENGINE-OWNED')
  // 白名单命中项（有据可查的可再生产物）：V8 编译缓存。
  write(join(home, '.node-compile-cache', 'v8', 'blob.bin'), 'V8-COMPILE-CACHE')
  write(join(files, 'engine.log'), 'dsh web: http://127.0.0.1:3080/?token=CURRENT\n')
  write(join(files, 'engine.log.1'), 'OLD-GEN-1\n')
  write(join(files, 'engine.log.2'), 'OLD-GEN-2\n')
  return { root, home, files }
}

/** 在给定 fixture 上装插件（env 是唯一路径真源，符合「不得硬编码路径」）。 */
function applyOn(fixtureEnv) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_FILES_DIR: process.env.DSH_FILES_DIR, DSH_CONTROL_TOKEN_TEST: process.env.DSH_CONTROL_TOKEN_TEST, DSH_CONTROL_TOKEN: process.env.DSH_CONTROL_TOKEN }
  Object.assign(process.env, { DSH_HOME: fixtureEnv.home, DSH_FILES_DIR: fixtureEnv.files, DSH_CONTROL_TOKEN_TEST: '1', DSH_CONTROL_TOKEN: TOKEN })
  const harness = makeCtx()
  apply(harness.ctx)
  return {
    harness,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test('鉴权：无令牌 401、空令牌 401、令牌缺失即拒绝（fail-closed），且拒绝发生在任何副作用之前', async () => {
  const fixtureEnv = fixture()
  const { harness, restore } = applyOn(fixtureEnv)
  try {
    const session = join(fixtureEnv.home, 'sessions', 's1.jsonl')
    const before = readFileSync(session)

    const scanNoToken = await call(harness, '/api/android/runtime-cache/scan', { token: '' })
    assert.equal(scanNoToken.code, 401)

    const execNoToken = await call(harness, '/api/android/runtime-cache/execute', { method: 'POST', token: '' })
    assert.equal(execNoToken.code, 401)

    // 拒绝先于删除：历史代与用户资产逐字节未变。
    assert.equal(existsSync(join(fixtureEnv.files, 'engine.log.1')), true)
    assert.deepEqual(readFileSync(session), before)
  } finally { restore() }
})

test('鉴权：非回环 Host 403；带令牌但错误令牌 401', async () => {
  const fixtureEnv = fixture()
  const { harness, restore } = applyOn(fixtureEnv)
  try {
    const foreignHost = await call(harness, '/api/android/runtime-cache/scan', { host: 'evil.example' })
    assert.equal(foreignHost.code, 403)
    const wrongToken = await call(harness, '/api/android/runtime-cache/scan', { token: 'b'.repeat(32) })
    assert.equal(wrongToken.code, 401)
    assert.equal(existsSync(join(fixtureEnv.files, 'engine.log.1')), true)
  } finally { restore() }
})

test('方法面：scan 只认 GET、execute 只认 POST（其余 405 且带 allow）', async () => {
  const fixtureEnv = fixture()
  const { harness, restore } = applyOn(fixtureEnv)
  try {
    const scanPost = await call(harness, '/api/android/runtime-cache/scan', { method: 'POST' })
    assert.equal(scanPost.code, 405)
    assert.equal(scanPost.headers.allow, 'GET')

    const execGet = await call(harness, '/api/android/runtime-cache/execute', { method: 'GET' })
    assert.equal(execGet.code, 405)
    assert.equal(execGet.headers.allow, 'POST')
  } finally { restore() }
})

test('scan 面：返回实测可回收体积与逐项标签，绝不下发绝对路径', async () => {
  const fixtureEnv = fixture()
  const { harness, restore } = applyOn(fixtureEnv)
  try {
    const res = await call(harness, '/api/android/runtime-cache/scan')
    assert.equal(res.code, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.ok(payload.reclaimableBytes > 0)
    const labels = payload.targets.map((target) => target.label).sort()
    assert.deepEqual(labels, ['$DSH_FILES_DIR/engine.log.1', '$DSH_FILES_DIR/engine.log.2', '$DSH_HOME/.node-compile-cache'])
    for (const target of payload.targets) {
      assert.equal(String(target.label).startsWith('$DSH_'), true, '标签必须是符号形态：' + target.label)
      assert.equal(String(target.label).includes(fixtureEnv.home), false, '标签不得含绝对路径')
    }
    assert.equal(res.body.includes(fixtureEnv.home), false)
    assert.equal(res.body.includes(fixtureEnv.files), false)
    // 白名单外子目录如实上报。
    assert.ok(payload.skipped.some((skip) => skip.id === 'cache-attachments' && skip.reason === 'not-allowlisted'))
  } finally { restore() }
})

test('execute 面：白名单命中被删、白名单外与用户资产逐字节未变、当前 log 代保留', async () => {
  const fixtureEnv = fixture()
  const { harness, restore } = applyOn(fixtureEnv)
  try {
    const scan = JSON.parse((await call(harness, '/api/android/runtime-cache/scan')).body)
    const untouched = [
      join(fixtureEnv.home, '.credentials.yaml'),
      join(fixtureEnv.home, 'settings.yaml'),
      join(fixtureEnv.home, 'sessions', 's1.jsonl'),
      join(fixtureEnv.home, 'attachments', 'v1', 'x.png'),
      join(fixtureEnv.home, 'profiles', 'web', 'node_modules', 'dep', 'index.js'),
      join(fixtureEnv.home, 'cache', 'attachments', 'request-images', 'ab', 'hash'),
      join(fixtureEnv.files, 'engine.log'),
    ]
    const before = new Map(untouched.map((path) => [path, readFileSync(path)]))

    const res = await call(harness, '/api/android/runtime-cache/execute', { method: 'POST' })
    assert.equal(res.code, 200)
    const report = JSON.parse(res.body)
    assert.equal(report.ok, true)
    assert.equal(report.removed, 3)
    assert.equal(report.failed, 0)
    // G-9③：统计体积与实际删除量差值必须为 0。
    assert.equal(report.removedBytes, report.plannedBytes)
    assert.equal(report.plannedBytes, scan.reclaimableBytes)

    for (const [path, content] of before) {
      assert.ok(existsSync(path), '未列入白名单的路径不得被删除：' + path)
      assert.deepEqual(readFileSync(path), content, '内容必须逐字节未变：' + path)
    }
    assert.equal(existsSync(join(fixtureEnv.files, 'engine.log.1')), false)
    assert.equal(existsSync(join(fixtureEnv.files, 'engine.log.2')), false)
    assert.equal(existsSync(join(fixtureEnv.home, '.node-compile-cache')), false)
    // 当前代仍在且内容未变（壳侧 tokenFromLog 的唯一输入）。
    assert.match(readFileSync(join(fixtureEnv.files, 'engine.log'), 'utf8'), /token=CURRENT/)
    // 逐项结果如实呈现（含 skipped/failed 的分类字段）。
    assert.equal(report.items.length, 3)
    for (const item of report.items) {
      assert.equal(item.status, 'removed')
      assert.equal(String(item.label).startsWith('$DSH_'), true)
    }
  } finally { restore() }
})

test('execute 面在无白名单命中时只返回空计划（不误删、不报错）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rc-empty-'))
  const home = join(root, 'home', '.dsh')
  const files = join(root, 'files')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(files, { recursive: true })
  writeFileSync(join(home, 'sessions', 's1.jsonl'), '{}\n')
  writeFileSync(join(files, 'engine.log'), 'current\n')
  const { harness, restore } = applyOn({ home, files })
  try {
    const res = await call(harness, '/api/android/runtime-cache/execute', { method: 'POST' })
    assert.equal(res.code, 200)
    const report = JSON.parse(res.body)
    assert.equal(report.removed, 0)
    assert.equal(report.failed, 0)
    assert.equal(report.removedBytes, 0)
    assert.equal(existsSync(join(home, 'sessions', 's1.jsonl')), true)
    assert.equal(existsSync(join(files, 'engine.log')), true)
  } finally { restore() }
})

test('块 E 的平面裁定（用户裁定 7）：两条路由不注册任何模型可见工具', async () => {
  const fixtureEnv = fixture()
  const registered = []
  const harness = makeCtx()
  harness.ctx.tools.register = (tool) => { registered.push(tool) }
  const previousEnv = { DSH_HOME: process.env.DSH_HOME, DSH_FILES_DIR: process.env.DSH_FILES_DIR }
  Object.assign(process.env, { DSH_HOME: fixtureEnv.home, DSH_FILES_DIR: fixtureEnv.files })
  try {
    apply(harness.ctx)
    const names = registered.map((tool) => String(tool?.name ?? ''))
    assert.deepEqual(names.sort(), ['android_env_recipe', 'android_toolchain_status'], '工具面必须与块 E 之前逐字一致')
    assert.equal(names.some((name) => /cache/i.test(name)), false, '不得新增模型可见的缓存工具')
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
