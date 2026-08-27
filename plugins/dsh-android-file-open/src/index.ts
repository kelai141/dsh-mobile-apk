/**
 * dsh-android-file-open — 文件直达会话（PRD F5，M3.5 + 消费端补齐 2026-08-23）
 *
 * 引擎侧职责：接收壳侧拷贝完成的临时工作区路径 → 校验（必须在临时工作区内）→
 * 入队并**当场创建强制新会话**（种子消息携带 @文件路径——DSH 文件引用格式，
 * read/视觉链路按 <path> 取用；会话 cwd = 临时工作区，模型只见工作区内路径）→
 * 提供 GET 清单 + claim 端点（前端消费/删除）→ 状态工具。
 *
 * 强制新会话语义：绝不并入既有会话（PRD F5.2 硬规则）——本插件不提供任何"附加到现有会话"路径。
 *
 * 幂等：队列条目若无 sessionId（引擎曾在建会话前崩溃），apply 时的工作循环与每次 POST
 * 后都会补建——已建条目不重复创建（同一会话绝不重复开）。消费（claim）只由前端在
 * 确实把界面路由到新会话后执行。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep, basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-android-file-open'
export const inject = ['tools', 'webServer', 'sessions', 'workspaceRegistry'] as const

/** 临时工作区（与壳侧 FileIncoming.tmpWorkspace 一致；环境注入 DSH_HOME 决定配置根） */
function tmpWorkspace(): string {
  const dshHome = process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
  return join(dshHome, 'workspaces', 'incoming')
}

function queueDir(): string {
  const d = join(tmpWorkspace(), '.sessions')
  mkdirSync(d, { recursive: true })
  return d
}

/** 宿主会话服务最小面（类型局部收敛：跨包服务面走 cast，不引入 dsh-session 编译期整体）。 */
interface HostSession {
  append(type: string, payload: Record<string, unknown>, opts?: { surfaceOp: string }): void
  id: unknown
}
interface HostSessions {
  create(id?: unknown, opts?: { meta?: Record<string, unknown> }): HostSession
}

/** workspaceRegistry 最小面（注册临时工作区让面板可见；create 幂等：同路径复用现有实体）。 */
interface HostWorkspaceRegistry {
  create(path: string, title?: string): Promise<unknown>
}

interface IncomingItem {
  ts: string
  path: string
  context: string
  forcedNewSession: true
  sessionId?: string
  file?: string
}

function readItems(): IncomingItem[] {
  const dir = queueDir()
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as IncomingItem
      j.file = f
      return j
    } catch {
      return null
    }
  }).filter((x): x is IncomingItem => x !== null)
}

/**
 * 强制新会话请求入队（每个文件一条独立清单；会话由 ensureSessions 创建）。
 * 路径边界（H3 修复 2026-08-23）：ws+sep 边界 + realpath 规范化，拒绝跨边界 symlink。
 */
function enqueueSession(path: string): { ok: boolean; sessionFile: string; message: string } {
  const dir = queueDir()
  const ws = resolve(tmpWorkspace())
  const real = safeResolveInside(ws, path)
  if (real === null || !existsSync(real)) {
    return { ok: false, sessionFile: '', message: `路径不在临时工作区内或不存在: ${path}` }
  }
  const sessionFile = join(dir, Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.json')
  const context = `此会话处理外部文件：${real}\n\n请先阅读该文件（图片可直接用视觉工具查看），并按用户意图处理。文件已安全拷贝进临时工作区（不引用外部原始路径）；处理完成后可在设置页手动清理临时工作区。`
  writeFileSync(sessionFile, JSON.stringify({ ts: new Date().toISOString(), path: real, context, forcedNewSession: true }, null, 2))
  return { ok: true, sessionFile, message: '已生成强制新会话请求：' + real }
}

/** 为缺失 sessionId 的队列条目创建会话并播种（幂等；引擎重启后重跑安全）。 */
function ensureSessions(sessions: HostSessions | undefined): number {
  if (!sessions) return 0
  let created = 0
  for (const item of readItems()) {
    if (item.sessionId || !item.file) continue
    try {
      const sess = sessions.create(undefined, {
        // header 的 meta 仅接受白名单键（origin 只允许 "subagent"，实测拒绝自定义值）
        meta: { cwd: tmpWorkspace() },
      })
      // 种子消息：@绝对路径 = DSH 文件引用约定（read/视觉工具按引用取文件）。
      // user/message 是 surface-eligible 事件：必须带 surfaceOp 标记（'append' = 追加式新消息）。
      const text = `@${item.path}\n\n${item.context}`
      sess.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }) as unknown as Record<string, unknown>, { surfaceOp: 'append' })
      const file = join(queueDir(), item.file)
      const updated = { ...item, sessionId: String(sess.id) }
      delete updated.file
      writeFileSync(file, JSON.stringify(updated, null, 2))
      created++
    } catch (e) {
      /* 单条失败不阻断其余；下次 POST/apply 再试——落错误文件供诊断 */
      try {
        writeFileSync(join(queueDir(), 'last-error.txt'), String((e as Error).stack ?? e))
      } catch { /* 诊断文件失败忽略 */ }
    }
  }
  return created
}

// 幂等补建时的日志落点（apply 时注入）
let ctxLogger: ((scope: string) => { warn?(msg: string): void; info?(msg: string): void }) | undefined

/**
 * 解析到工作区内的规范化真实路径（H3 + 2026-08-23 前缀混用修复）：
 * - ws+sep 边界判定（同名前缀碰撞不通过；resolve 折叠 .. 后的落点为准）；
 * - **两侧都 realpath 后再比较**——Android 上 /data/user/0 可能是指向 /data/data 的
 *   软链（实测：仅 realpath 文件侧会把 rp 变成 /data/data 前缀，与未 realpath 的 ws
 *   比较必拒——正是"B7 前缀混用"的运行时表现）；ws 侧 realpath 失败按原样参与比较；
 * - 任一解析失败（不存在/越界/IO 错误）返回 null。
 */
function safeResolveInside(ws: string, path: string): string | null {
  let real: string
  let wsReal: string
  try {
    real = resolve(path)
    const inBound = real === ws || real.startsWith(ws + sep)
    if (!inBound) return null
  } catch {
    return null
  }
  try {
    wsReal = realpathSync(ws)
  } catch {
    wsReal = ws
  }
  try {
    // realpath 跟随符号链接：工作区内软链指向外部时，最终落点越界 → 拒绝
    const rp = realpathSync(real)
    if (rp === wsReal || rp.startsWith(wsReal + sep)) return rp
    // 兼容：若文件确在 ws 内但文件名含坏字符被捕获等情形，走边界回退判定
    return real.startsWith(wsReal + sep) ? real : null
  } catch {
    // 文件不存在（realpath ENOENT）：交由调用方 existsSync 判定
    return real.startsWith(wsReal + sep) ? real : null
  }
}

function tools() {
  const statusTool = defineTool({
    name: 'android_file_incoming_status',
    description: '文件直达会话队列视图：待/已消费的强制新会话清单（每项含文件路径、会话 id 与初始上下文概览）与临时工作区占用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: { type: 'number', required: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tmpWorkspace: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: `待消费新会话请求 ${String(v.pending)} 条（工作区 ${String(v.tmpWorkspace)}）` },
      ],
    },
    execute: async () => {
      const items = readItems()
      return { pending: items.filter((i) => !i.sessionId).length, items, tmpWorkspace: tmpWorkspace() } as never
    },
  })
  // 注意：注入面（前端消费端）claim 后删除条目；本插件无"并入既有会话"路径（安全边界）。
  return [statusTool]
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}) {
  ctxLogger = ctx.logger
  const sessions = (ctx as unknown as { sessions?: HostSessions }).sessions
  const workspaceRegistry = (ctx as unknown as { workspaceRegistry?: HostWorkspaceRegistry }).workspaceRegistry
  for (const t of tools()) ctx.tools.register(t)
  // F5.1：引擎初始化即确保临时工作区存在（PRD：干净安装后首次启动即存在）
  try {
    mkdirSync(tmpWorkspace(), { recursive: true })
  } catch { /* 工作区由入队路径兜底创建 */ }
  // F5.1 / issue #60：**强制把临时工作区登记进 workspace registry**——否则「工作区」面板
  // 始终看不到「临时工作区」条目（registry 只从既有会话 cwd bootstrap；无会话时为空）。
  // create 幂等且复用同路径实体；标题「临时工作区」让设置页/工作区面板可见可清理。
  if (workspaceRegistry) {
    try {
      void workspaceRegistry.create(tmpWorkspace(), '临时工作区')
    } catch (e) {
      ctx.logger?.('dsh-android-file-open')?.warn?.('临时工作区登记失败: ' + String((e as Error).message))
    }
  }
  // 启动即补建（引擎重启后队列里可能残留无 sessionId 的条目——幂等）
  try {
    const n = ensureSessions(sessions)
    if (n > 0) ctx.logger?.('dsh-android-file-open')?.info?.('recovered ' + n + ' incoming session(s) after restart')
  } catch { /* 补建失败不阻断插件 */ }
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): void } }).webServer
  if (wsvc) {
    wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming',
      handler: async (req: {
        method?: string
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: {
        writeHead(code: number, headers: Record<string, string>): void
        end(body: string): void
      }) => {
        if (req.method === 'GET') {
          const items = readItems()
          // R16：展示临时工作区占用（设置页清理入口用；dir 遍历不含 .sessions）
          let bytes = 0
          try {
            for (const f of readdirSync(tmpWorkspace())) {
              if (f === '.sessions') continue
              const st = statSync(join(tmpWorkspace(), f))
              if (st.isFile()) bytes += st.size
            }
          } catch { /* 统计失败不阻断 */ }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, pending: items.filter((i) => !i.sessionId).length, items, bytes }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'GET/POST only' }))
          return
        }
        // body 上限 + 超时——本地 DoS 防护（无限累加耗尽内存）。
        let body = ''
        let settled = false
        const MAX_BODY = 16 * 1024
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          try { req.destroy() } catch { /* noop */ }
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'body too large or timeout' }))
        }, 5000)
        req.on('data', (b: Buffer) => {
          if (settled) return
          body += b.toString()
          if (body.length > MAX_BODY) {
            settled = true
            try { req.destroy() } catch { /* noop */ }
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const path = (JSON.parse(body) as { path?: string }).path ?? ''
            const result = enqueueSession(path)
            if (result.ok) {
              try { ensureSessions(sessions) } catch { /* 建会话失败：队列条目保留，下次补建 */ }
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    })
    // 消费端点：前端已把界面路由到新会话后删除队列条目（条目名白名单校验，拒绝路径穿越）。
    wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/claim',      handler: async (req: {
        method?: string
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: {
        writeHead(code: number, headers: Record<string, string>): void
        end(body: string): void
      }) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'POST only' }))
          return
        }
        let body = ''
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          try { req.destroy() } catch { /* noop */ }
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'timeout' }))
        }, 5000)
        req.on('data', (b: Buffer) => {
          if (settled) return
          body += b.toString()
          if (body.length > 4096) {
            settled = true
            try { req.destroy() } catch { /* noop */ }
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'body too large' }))
          }
        })
        req.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          try {
            const file = (JSON.parse(body) as { file?: string }).file ?? ''
            const name = basename(file)
            // 白名单：仅允许删除队列目录内的 .json 条目（basename 化后拒绝穿越）
            if (name !== file || !name.endsWith('.json')) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid entry name' }))
              return
            }
            const target = join(queueDir(), name)
            if (target !== join(resolve(queueDir()), name)) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid entry path' }))
              return
            }
            if (existsSync(target)) rmSync(target)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
          }
        })
      },
    })
    // F5.1/D15 手动清理：一键清空临时工作区内容（保留 .sessions 队列元数据；会话关联提示由设置页文案承担）。
    wsvc.register({
      kind: 'exact',
      path: '/api/android/file-incoming/clean',
      handler: async (_req: {
        method?: string
        on(_e: string, cb: (b: Buffer) => void): void
        destroy(): void
      }, res: {
        writeHead(code: number, headers: Record<string, string>): void
        end(body: string): void
      }) => {
        let removed = 0
        try {
          for (const f of readdirSync(tmpWorkspace())) {
            if (f === '.sessions') continue
            const p = join(tmpWorkspace(), f)
            try {
              rmSync(p, { recursive: true, force: true })
              removed++
            } catch { /* 单文件失败不阻断 */ }
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, removed }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }))
        }
      },
    })
  }
}
