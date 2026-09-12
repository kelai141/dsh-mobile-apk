/**
 * 无障碍控制队列（0.13.5 W4，PRD-0.13.2 §3.3 B2）。
 *
 * 方向：**引擎侧是服务端**（本模块注册两条 exact 路由），**壳侧是客户端**（轮询取活、
 * 执行、回填结果）。这样壳不需要开任何监听端口，且复用 file-incoming 已验证的通道形态。
 *
 * 轻载原则：
 *   - 队列空时壳侧**不轮询**（`waiting=false` 就是停轮信号）；
 *   - 一次只允许一个在途请求（壳侧单线程执行）；
 *   - 请求带 `gen`（树代次）：壳侧发现页面已变化时直接失败关闭，不做猜测性点击。
 *
 * 安全：exact 路由不经 /api 浏览器鉴权（0.13.3 实证），因此**必须**自带共享令牌；
 * 令牌由壳写入 shared_prefs（dsh-adb.xml → controlToken），引擎侧读取比对；
 * 未配置令牌时两条路由一律拒绝（fail-closed）。
 */

export interface ControlRequest {
  reqId: string
  op: string
  args: Record<string, unknown>
  /** 树代次（snapshot 返回；非 snapshot 操作必须带上，壳侧校验）。 */
  gen?: number
  createdAt: number
}

export type ControlResult = { ok: true; data: unknown } | { ok: false; error: string }

interface PendingEntry {
  req: ControlRequest
  resolve: (result: ControlResult) => void
  timer: ReturnType<typeof setTimeout>
}

let seq = 0

/** 引擎支持的协议版本上限（壳侧 `pv` 高于此值 = 壳比引擎新）。 */
export const ENGINE_PROTOCOL_VERSION = 2

export interface Negotiation {
  ok: boolean
  /** 壳侧声明的协议版本（未声明按 1 = V1 兼容路径）。 */
  shell: number
  engine: number
  reason: string
}

/**
 * 协议版本协商（0.13.8 P2-15；V2 §S4）：把「新壳 + 老引擎」变成一次**带指引的失败**，
 * 而不是静默产出一棵空树。老壳不声明 `pv` → 按 V1 兼容路径放行（0.13.7 及以前的行为）。
 */
export function negotiateProtocol(shellPv: unknown): Negotiation {
  const engine = ENGINE_PROTOCOL_VERSION
  if (shellPv === undefined || shellPv === null) {
    return { ok: true, shell: 1, engine, reason: '壳侧未声明协议版本——按 V1 兼容路径处理' }
  }
  const shell = Number(shellPv)
  if (!Number.isFinite(shell) || shell < 1) {
    return { ok: false, shell: 0, engine, reason: `壳侧协议版本非法（pv=${String(shellPv)}）` }
  }
  if (shell > engine) {
    return {
      ok: false, shell, engine,
      reason: `壳侧协议 pv=${shell} 比引擎支持的 pv=${engine} 新——请更新引擎快照（android_ui_dump 会一直拿不到可信结果）`,
    }
  }
  return { ok: true, shell, engine, reason: shell === engine ? `协议 pv=${shell} 一致` : `壳侧 pv=${shell} 走 V${shell} 兼容路径` }
}

export class ControlQueue {
  private pending?: PendingEntry
  private waiter?: () => void
  private lastTakeAt = 0
  private lastResultAt = 0
  private served = 0
  private failed = 0
  /** 0.13.8 P2-15：最近一次回填声明的协议版本与能力（诊断面展示 + 协商判定）。 */
  private lastPv?: number
  private lastCaps?: Record<string, unknown>
  /** 0.13.8 #181：在途标记——take 到 settle 之间二次取活必须被拒（防同一请求双执行）。 */
  private inFlight = false

  /** 是否有壳侧未取走的活（false = 壳侧应停轮）。 */
  get waiting(): boolean {
    return this.pending !== undefined
  }

  /** 下一次轮询建议间隔：无活时给一个较大的空闲间隔，有活时 250ms。 */
  get pollHintMs(): number {
    return this.pending ? 250 : 2000
  }

  stats(): {
    waiting: boolean; served: number; failed: number; lastTakeAt: number; lastResultAt: number
    protocol: Negotiation; caps?: Record<string, unknown>
  } {
    const base = {
      waiting: this.waiting, served: this.served, failed: this.failed,
      lastTakeAt: this.lastTakeAt, lastResultAt: this.lastResultAt,
      protocol: negotiateProtocol(this.lastPv),
    }
    // 可选键缺省整键不发（caps 从未声明过时不得在场为 undefined：会让消费面
    // 落到 not lossless JSON——android_privilege_status 的实测缺陷）。
    return this.lastCaps === undefined ? base : { ...base, caps: this.lastCaps }
  }

  /** 记录壳侧声明的协议版本与能力（回填信封；诊断与协商共用）。 */
  noteShell(pv: unknown, caps: unknown): Negotiation {
    const negotiation = negotiateProtocol(pv)
    this.lastPv = negotiation.shell
    if (caps !== null && typeof caps === 'object' && !Array.isArray(caps)) this.lastCaps = caps as Record<string, unknown>
    return negotiation
  }

  /**
   * 提交一个操作并等待壳侧回填。超时/被新请求挤掉都返回失败（fail-closed），
   * 绝不返回「可能成功」的模糊结果。
   */
  enqueue(op: string, args: Record<string, unknown>, timeoutMs = 8000): Promise<ControlResult> {
    if (this.pending) {
      return Promise.resolve({ ok: false, error: '已有在途的设备控制请求——壳侧单线程，请串行调用' })
    }
    const reqId = `c${++seq}-${Date.now().toString(36)}`
    const gen = typeof args.gen === 'number' ? args.gen : undefined
    const req: ControlRequest = { reqId, op, args, gen, createdAt: Date.now() }
    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.req.reqId === reqId) {
          this.pending = undefined
          this.inFlight = false
        }
        this.failed++
        resolve({ ok: false, error: `设备控制超时（${timeoutMs}ms 内壳侧未回填结果）——检查无障碍服务是否在运行` })
      }, Math.max(500, timeoutMs))
      this.pending = { req, resolve, timer }
      // 唤醒挂起的长轮询（有活立即回，壳侧不必短轮询空转）
      this.waiter?.()
    })
  }

  /**
   * 长轮询：有活立即返回；无活则挂起至多 [timeoutMs]。
   * 这是「轻载」的关键——空闲时壳侧每 timeoutMs 才发一次请求，且延迟为 0。
   * 同时这次调用本身就是**存活心跳**：lastTakeAt 每次轮询都刷新，
   * 引擎据此判断壳侧轮询是否真的在跑（防 force-stop 后的僵尸 a11yEnabled）。
   */
  waitForWork(timeoutMs: number): Promise<ControlRequest | null> {
    this.lastTakeAt = Date.now()
    // 0.13.8 #181：在途（已取走未回填）时不再交付——被饿的轮询者拿到 null 会按
    // pollHint 重新轮询，绝不会重复执行同一个 req。
    if (this.pending && !this.inFlight) return Promise.resolve(this.take())
    return new Promise<ControlRequest | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        resolve(null)
      }, Math.max(0, timeoutMs))
      this.waiter = () => {
        clearTimeout(timer)
        this.waiter = undefined
        resolve(this.take())
      }
    })
  }

  /** 最近一次轮询距今毫秒数（Infinity = 从未轮询）。 */
  pollAgeMs(): number {
    return this.lastTakeAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.lastTakeAt
  }

  /** 壳侧取活；没有活时返回 null（并记录取活时间用于诊断）。 */
  take(): ControlRequest | null {
    this.lastTakeAt = Date.now()
    const entry = this.pending
    if (!entry) return null
    // 0.13.8 #181：在途即拒——同一 reqId 只许交付一次（原实现可重复返回 → 双执行）。
    if (this.inFlight) return null
    this.inFlight = true
    return entry.req
  }

  /** 壳侧回填结果。未知/过期 reqId 返回 false（不覆盖在途请求）。 */
  settle(reqId: string, result: ControlResult): boolean {
    const entry = this.pending
    if (!entry || entry.req.reqId !== reqId) return false
    clearTimeout(entry.timer)
    this.pending = undefined
    this.inFlight = false
    this.lastResultAt = Date.now()
    if (result.ok) this.served++
    else this.failed++
    entry.resolve(result)
    return true
  }

  /** 引擎侧主动取消（例如会话中断）。 */
  cancel(reason = 'cancelled'): void {
    const entry = this.pending
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending = undefined
    this.inFlight = false
    entry.resolve({ ok: false, error: reason })
  }
}

/** 令牌长度下限（壳侧生成 18 字节；下限同时拒绝空串与占位值）。 */
const MIN_TOKEN_LENGTH = 8

/** 显式测试开关：只有它为 `1`/`true` 时 `DSH_CONTROL_TOKEN` 才参与取令牌。 */
export const CONTROL_TOKEN_TEST_ENV = 'DSH_CONTROL_TOKEN_TEST'

/** env 令牌值（仅在测试开关在场时被读取）。 */
const CONTROL_TOKEN_ENV = 'DSH_CONTROL_TOKEN'

/** 令牌比对（常数时间不必要：本地回环 + 仅防同机其它应用误触）。 */
export function tokenMatches(expected: string | undefined, provided: unknown): boolean {
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false
  return typeof provided === 'string' && provided === expected
}

export type RouteRequest = {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: string, cb: (chunk?: Buffer) => void): void
}

export type RouteResponse = {
  writeHead(code: number, headers: Record<string, string>): void
  end(body?: string): void
}

/**
 * 请求体读取（0.13.8 V2 P0-1，坑 D0 修复）：判别联合——超限/解析失败不再静默
 * `resolve({})`（那会把「报文太大」伪装成 403 令牌不匹配，模型完全看不到真因）。
 * 上限 64KB → 1MiB：V2 列式载荷下 MAX_NODES=4000 的最坏报文 ≈ 501KB，1MiB 结构性不可达。
 */
export const CONTROL_BODY_LIMIT = 1024 * 1024

export type ReadBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: 'too_large' | 'bad_json' | 'aborted'; bytes: number; limit: number }

function readBody(req: RouteRequest, limit = CONTROL_BODY_LIMIT): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    req.on('data', (chunk) => {
      if (!chunk) return
      size += chunk.length
      if (size > limit) {
        overLimit = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overLimit) {
        resolve({ ok: false, code: 'too_large', bytes: size, limit })
        return
      }
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      } catch {
        resolve({ ok: false, code: 'bad_json', bytes: size, limit })
      }
    })
    req.on('error', () => resolve({ ok: false, code: 'aborted', bytes: size, limit }))
  })
}

/** 413/400 统一出口：X-DSH-Control-Code/-Bytes/-Limit 响应头（壳侧 ControlPoller 读这些而非盲等）。 */
function sendBodyError(res: RouteResponse, r: { code: string; bytes: number; limit: number }): void {
  const code = r.code === 'too_large' ? 413 : 400
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-dsh-control-code': r.code,
    'x-dsh-control-bytes': String(r.bytes),
    'x-dsh-control-limit': String(r.limit),
  } as Record<string, string>)
  res.end(JSON.stringify({ ok: false, error: `请求体${r.code === 'too_large' ? '超过上限' : '不是合法 JSON'}：${r.bytes}B / 上限 ${r.limit}B`, code: r.code, bytes: r.bytes, limit: r.limit }))
}

function sendJson(res: RouteResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * 令牌来源（ST-07 / F-PLUG-01：**生产一律以壳侧 prefs 实时值为准**）。
 *
 * 反转前 env 恒压过 prefs：壳侧重装或清数据后重新生成令牌，而引擎进程里仍是启动快照
 * 里的旧值 → 取活与回填两条 exact 路由恒定 403 且不可自愈（唯一恢复手段是重启引擎），
 * 同时 prefs 的 `a11yEnabled` 仍为 true —— 把「配置陈旧」伪装成「服务未开启」。
 * 现语义：未显式声明 `DSH_CONTROL_TOKEN_TEST=1` 时 **env 完全不参与**；显式测试模式下
 * env 优先（测试需要确定性），env 缺失时回落 prefs。
 * @param env - 进程环境（测试可注入）。
 * @param prefs - 壳侧 prefs 解析结果（实时读取）。
 * @returns 当前生效的令牌；缺失或过短时为 undefined（调用方 fail-closed）。
 */
export function controlTokenFrom(
  env: NodeJS.ProcessEnv,
  prefs: { controlToken?: string } | undefined,
): string | undefined {
  const valid = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length >= MIN_TOKEN_LENGTH ? value : undefined
  const fromPrefs = valid(prefs?.controlToken)
  const rawFlag = env[CONTROL_TOKEN_TEST_ENV]
  if (rawFlag !== '1' && rawFlag !== 'true') return fromPrefs
  return valid(env[CONTROL_TOKEN_ENV]) ?? fromPrefs
}

export interface RegisterOptions {
  queue: ControlQueue
  /** 每次请求实时读取令牌（壳侧写入 prefs 后即时生效）。 */
  token: () => string | undefined
  logger?: { warn?: (msg: string) => void }
}

/** 注册两条 exact 路由：取活（POST，带令牌）与回填（POST，带令牌）。 */
export function registerControlRoutes(webServer: { register(route: unknown): void }, options: RegisterOptions): void {
  const { queue, token, logger } = options
  webServer.register({
    kind: 'exact',
    path: '/api/android/ui/pending',
    handler: async (req: RouteRequest, res: RouteResponse) => {
      const rb = await readBody(req)
      if (!rb.ok) {
        logger?.warn?.(`control/pending: ${rb.code} (${rb.bytes}B / ${rb.limit}B)`)
        sendBodyError(res, rb)
        return
      }
      const body = rb.body
      if (!tokenMatches(token(), body.token)) {
        logger?.warn?.('control/pending: 令牌不匹配或未配置，拒绝')
        sendJson(res, 403, { ok: false, error: 'control token missing or mismatched' })
        return
      }
      const request = await queue.waitForWork(Number.isFinite(Number(body.waitMs)) ? Math.min(Math.max(Number(body.waitMs), 0), 30_000) : 5000)
      sendJson(res, 200, { ok: true, req: request, pollHintMs: queue.pollHintMs })
    },
  })
  webServer.register({
    kind: 'exact',
    path: '/api/android/ui/result',
    handler: async (req: RouteRequest, res: RouteResponse) => {
      const rb = await readBody(req)
      if (!rb.ok) {
        logger?.warn?.(`control/result: ${rb.code} (${rb.bytes}B / ${rb.limit}B)`)
        sendBodyError(res, rb)
        return
      }
      const body = rb.body
      if (!tokenMatches(token(), body.token)) {
        logger?.warn?.('control/result: 令牌不匹配或未配置，拒绝')
        sendJson(res, 403, { ok: false, error: 'control token missing or mismatched' })
        return
      }
      const reqId = typeof body.reqId === 'string' ? body.reqId : ''
      const ok = body.ok === true
      const result: ControlResult = ok
        ? { ok: true, data: body.data }
        : { ok: false, error: typeof body.error === 'string' ? body.error : '设备控制失败（壳侧未给出原因）' }
      // 0.13.8 P2-15：先做协议协商——壳比引擎新时明确失败并给升级指引，
      // 不让模型看到一株「看起来正常」的空树（§S4.1 场景 3）。
      const negotiation = queue.noteShell(body.pv, body.caps)
      if (!negotiation.ok) {
        logger?.warn?.(`control/result: 协议不兼容（壳 pv=${negotiation.shell} / 引擎 pv=${negotiation.engine}）`)
        queue.settle(reqId, { ok: false, error: negotiation.reason })
        sendJson(res, 422, { ok: false, code: 'schema_invalid', error: negotiation.reason })
        return
      }
      const accepted = queue.settle(reqId, result)
      if (!accepted) logger?.warn?.(`control/result: rejected (409, reqId=${reqId})`)
      sendJson(res, accepted ? 200 : 409, { ok: accepted, reason: accepted ? 'settled' : 'unknown-or-stale-reqId' })
    },
  })
}
