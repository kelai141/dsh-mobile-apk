// ST-16 回归（离线）：环境配方三键改为运行期实时读——切换会话档位后配方随之为变，
// 不再把「从未注入的 env 快照」当权威；每个键都带来源标签。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, liveFacts } from '../lib/index.js'

function makeCtx(services) {
  const routes = new Map()
  const tools = []
  const target = {
    tools: { register(t) { tools.push(t) } },
    webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    get: (name) => services[name],
  }
  return { ctx: target, routes, tools }
}

async function callRoute(harness, path) {
  const route = harness.routes.get(path)
  assert.ok(route, '路由必须注册：' + path)
  const res = { code: 0, body: '', headers: {}, writeHead(c, h) { this.code = c; this.headers = h ?? {} }, end(b) { this.body = b ?? '' } }
  await route.handler({}, res)
  assert.equal(res.code, 200)
  return JSON.parse(res.body)
}

test('ST-16：会话档位切换后配方随之为变（≤5s 判据的可离线化形态：无缓存、每次现读）', async () => {
  const policy = { defaultMode: 'workspace-write', resolve: () => ({ mode: policy.defaultMode }) }
  const harness = makeCtx({ sandboxPolicy: policy, androidPrivilege: { status: () => ({ tier: 'T0' }) } })
  apply(harness.ctx)

  const first = await callRoute(harness, '/api/android/env/recipe')
  assert.equal(first.writeMode, 'workspace-write')
  assert.equal(first.writeModeSource, 'sandboxPolicy.default')

  // 只动系统侧真源：部署档位切到完全访问
  policy.defaultMode = 'danger-full-access'
  const second = await callRoute(harness, '/api/android/env/recipe')
  assert.equal(second.writeMode, 'danger-full-access', '档位切换后配方必须随之为变（不得吃启动快照）')
  assert.equal(second.writeModeSource, 'sandboxPolicy.default')
})

test('ST-16：有会话时按该会话实时 resolve（exec.agent.session 路径）', () => {
  const policy = { defaultMode: 'workspace-write', resolve: (req) => ({ mode: req.session === 's1' ? 'danger-full-access' : 'workspace-write' }) }
  const harness = makeCtx({ sandboxPolicy: policy })
  const sessionFacts = liveFacts(harness.ctx, 's1')
  assert.equal(sessionFacts.writeMode, 'danger-full-access')
  assert.equal(sessionFacts.writeModeSource, 'sandboxPolicy.session')
  const noSession = liveFacts(harness.ctx)
  assert.equal(noSession.writeMode, 'workspace-write')
  assert.equal(noSession.writeModeSource, 'sandboxPolicy.default')
})

test('ST-16：sandboxPolicy 缺席时回落 env 但必须标注来源（不伪装成真理）', () => {
  const harness = makeCtx({})
  const previous = process.env.DSH_WRITE_MODE
  process.env.DSH_WRITE_MODE = 'workspace-write'
  try {
    const facts = liveFacts(harness.ctx)
    assert.equal(facts.writeModeSource, 'env-fallback')
    assert.equal(facts.writeMode, 'workspace-write')
  } finally {
    if (previous === undefined) delete process.env.DSH_WRITE_MODE
    else process.env.DSH_WRITE_MODE = previous
  }
})

test('ST-16：workspace 实时取引擎启动目录（应用工作区根），env 仅作显式覆盖', () => {
  const harness = makeCtx({})
  const previous = process.env.DSH_WORKSPACE
  delete process.env.DSH_WORKSPACE
  try {
    const facts = liveFacts(harness.ctx)
    assert.equal(facts.workspace, process.cwd(), '无显式覆盖时必须取实时 cwd（0.13.7 起 = 应用工作区根）')
    assert.equal(facts.workspaceSource, 'engine-cwd')
  } finally {
    if (previous !== undefined) process.env.DSH_WORKSPACE = previous
  }
})

test('ST-16：配方含三键来源标签，且工具面/状态路由仍在场', async () => {
  const harness = makeCtx({ sandboxPolicy: { defaultMode: 'workspace-write' }, androidPrivilege: { status: () => ({ tier: 'T0' }) } })
  apply(harness.ctx)
  const recipe = await callRoute(harness, '/api/android/env/recipe')
  for (const key of ['writeMode', 'writeModeSource', 'workspace', 'workspaceSource', 'sharedDirsSource']) {
    assert.ok(key in recipe, '配方缺来源键：' + key)
  }
  const status = await callRoute(harness, '/api/android/env/status')
  assert.equal(status.adbTier, 'T0')
  assert.deepEqual(harness.tools.map((t) => t.name).sort(), ['android_env_recipe', 'android_toolchain_status'])
})
