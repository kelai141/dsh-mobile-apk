// 隔离件容量统计与孤立投影核对必须离开启动首屏窗口：
//   - 延后任务在 dispose/HMR 重载时被取消（定时器清掉，已在跑的也不得继续删）；
//   - 两项维护共用同一份目录快照，单轮只枚举一次 sessions/ 与 .corrupt/。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { apply, DEFERRED_MAINTENANCE_DELAY_MS, scheduleDeferredMaintenance } from '../src/index.js'

const ID_LIVE = 'session-11111111-1111-4111-8111-111111111111'
const ID_ORPH = 'session-33333333-3333-4333-8333-333333333333'
const ID_QUAR = 'session-22222222-2222-4222-8222-222222222222'

function cacheDoc(id, createdAt) {
  return JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt, cwd: '/ws', isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: 1, seq: 0, val: 'title-' + id } },
    },
  })
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-deferred-maintenance-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const workspace = join(home, 'sessions', 'workspace')
  const liveDir = join(workspace, ID_LIVE)
  await mkdir(liveDir, { recursive: true })
  await writeFile(join(liveDir, 'session.v4.jsonl'), JSON.stringify({ version: 4, id: ID_LIVE, createdAt: 1000 }) + '\n')
  const quarantined = join(workspace, '.corrupt', ID_QUAR + '.1700000000')
  await mkdir(quarantined, { recursive: true })
  await writeFile(join(quarantined, 'history'), 'x'.repeat(64))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const liveCache = join(cacheDir, ID_LIVE + '.json')
  const orphanCache = join(cacheDir, ID_ORPH + '.json')
  await writeFile(liveCache, cacheDoc(ID_LIVE, 1000))
  await writeFile(orphanCache, cacheDoc(ID_ORPH, 3000))
  return { home, quarantined, liveCache, orphanCache }
}

/** 假 host ctx：effect 收集 disposer（unload 等价 fiber 卸载），路由表与真 WebServer 同形。 */
function makeHost() {
  const disposers = []
  const routes = new Map()
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register: (route) => {
        if (routes.has(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"')
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    waterfall: async () => [],
    logger: { info() {}, warn() {}, error() {} },
  }
  return {
    ctx,
    routes,
    disposers,
    /** 模拟 HMR / 设置页「禁用→启用」：倒序卸载本次 apply 装上的全部 effect。 */
    unload() { while (disposers.length > 0) disposers.pop()() },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

async function missing(path) {
  try {
    await stat(path)
    return false
  } catch {
    return true
  }
}

test('deferred maintenance runs after the delay and shares one scan for occupancy + projection', async (t) => {
  const { home, quarantined, liveCache, orphanCache } = await fixture(t)
  const lines = []
  const host = makeHost()
  scheduleDeferredMaintenance(host.ctx, home, { delayMs: 100, logger: (_level, message) => lines.push(message) })
  assert.equal(host.disposers.length, 1, '调度必须挂在 ctx.effect 上（HMR 可回收）')

  // 定时器未到点：清理不得提前发生。
  assert.equal(existsSync(orphanCache), true, '延后窗口内不得开始删除')

  assert.equal(await waitFor(() => missing(orphanCache)), true, '延后任务必须清掉孤儿缓存')
  assert.equal(lines.includes('quarantine occupancy'), true, '隔离件容量统计必须跑（且只读）')
  assert.equal(lines.includes('swept orphan session projection cache entries'), true, '投影核对必须在同一轮跑')
  assert.equal(existsSync(liveCache), true, '身份匹配的活会话缓存必须保留')
  assert.equal(existsSync(quarantined), true, '清点只读：隔离件不得被删')
})

test('dispose before the delay cancels the pending maintenance timer', async (t) => {
  const { home, orphanCache } = await fixture(t)
  const lines = []
  const host = makeHost()
  scheduleDeferredMaintenance(host.ctx, home, { delayMs: 40, logger: (_level, message) => lines.push(message) })
  host.unload()

  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(existsSync(orphanCache), true, '卸载后未执行的定时器不得再跑')
  assert.equal(lines.includes('quarantine occupancy'), false)
})

test('dispose while the deferred task is running stops it before the destructive phase', async (t) => {
  const { home, orphanCache } = await fixture(t)
  const host = makeHost()
  let occupancySeen = false
  scheduleDeferredMaintenance(host.ctx, home, {
    delayMs: 0,
    logger: (_level, message) => {
      if (message !== 'quarantine occupancy') return
      occupancySeen = true
      // 容量统计完成后立即卸载：投影核对不得再删任何文件。
      host.unload()
    },
  })
  assert.equal(await waitFor(() => occupancySeen), true)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(existsSync(orphanCache), true, '已开跑的任务必须在删除前停下')
})

test('apply schedules the deferred maintenance on a fourth effect and unload cancels it', async (t) => {
  const { home, orphanCache } = await fixture(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    mock.timers.reset()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  const host = makeHost()
  apply(host.ctx)
  assert.equal(host.disposers.length, 4, '三条路由 + 一个延后维护 effect')
  assert.equal(host.routes.size, 3)
  assert.equal(existsSync(orphanCache), true, 'apply 不得在首屏同步跑投影核对')

  host.unload()
  mock.timers.tick(DEFERRED_MAINTENANCE_DELAY_MS)
  mock.timers.reset()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(existsSync(orphanCache), true, '卸载后即使时间到点也不得执行')
})
