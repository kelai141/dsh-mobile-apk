/**
 * 虚拟屏（Shizuku 特权通道）宿主半 — 0.14.0 迭代「虚拟屏」线 S1。
 *
 * 职责边界（与源文档 §6.2 架构 A 对齐）：
 *  - **本插件不承载像素**。画面唯一路径是壳侧原生 `SurfaceView` 的 Surface 直接作虚拟屏输出
 *    （源文档 §9.2：禁止把像素经引擎编码→传输→WebView 解码）；右侧栏 Tab 只承载开关/状态/控制。
 *  - 宿主半做两件事：① 注册只读状态端点 `GET /api/android/vdisplay/status`（右侧栏面板的数据源）；
 *    ② 注册 `android_vdisplay_status` 工具（模型面）；两者与桥面同源（`readVdSnapshot`）。
 *
 * `vd*` 的登记是本迭代**独立批次**，不得在本文件落地：新增 op 必须一次改齐六处
 * （壳侧 `DeviceControlService.handle` / `ControlProtocolV2.SUPPORTED_OPS` / 引擎 `ControlOp` /
 * `A11Y_OPS` / `ROUTE_OPS` / manage 工具面），并通过 `scripts/check-control-ops.mjs`（差集 = 0）。
 * 两条硬约束：① `vd*` 是特权面操作，**不得**进 `A11Y_OPS`（无障碍承载不了跨屏建屏/拉应用，
 * 与源文档 §8.2「browser* 不进 A11Y_OPS」同一条推理）；② 登记同批必须跑门禁，漏一处即工具不可达（坑 52）。
 *
 * 端点鉴权口径（坑 78 + review C12）：上游路由是「exact 表先于 prefix 表」，exact 路由挂在 `/api/...` 下会
 * **绕过**该前缀的 cookie 鉴权——本端点与 ADB 授权块的 `/api/android/privilege/status` 同口径
 * （均为 exact、无令牌），载荷不含机密（只有能力状态、错误码、引导文案、op 表与虚屏 id），
 * 并带**回环 Host/Origin 栅栏**（connection 服务优先，缺服务退化为回环白名单）。
 * 一旦将来要返回任何敏感值（路径、包名清单、像素），必须自带令牌或改走受鉴权的前缀路由。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readVdToolSnapshot, readVdSnapshot, VD_STATUS_PATH, type VdOp, type VdisplayFace } from './status.js'

export { VD_OPS, VD_STATUS_PATH, mapStatusPayload, readVdSnapshot, readVdToolSnapshot, snapshotFromRaw } from './status.js'
export type { VdOp, VdPanelState, VdSnapshot, VdState, VdStatusPayload, VdisplayFace } from './status.js'

export const name = '@dsh-android/dsh-android-vdisplay'

/**
 * 必需服务：`tools`（`ctx.tools.register` 是属性访问——坑 82 同形态：未声明 inject 时 cordis
 * 取属性直接抛 "cannot get property ... without inject"，整条 loader entry 失败 → 引擎启动即死）。
 * 可选服务（`webServer` / `androidPrivilege`）一律走 `ctx.get(...)`，缺失即降级（不阻塞 fiber）。
 */
/** The status endpoint is part of this tab's contract, so load only after the web server exists.
 * `androidPrivilege` remains late-bound because the bridge provider may load later. */
export const inject = ['tools', 'webServer'] as const

/** 浏览端面用的最小 res 契约（与 bridge 的 exact 路由同口径，不 import 跨包类型）。 */
interface WsReq {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}
interface WsRes {
  statusCode?: number
  setHeader?(name: string, value: string): void
  end(body: string): void
}

const ENGINE_PORT_ENV = 'DSH_ENGINE_PORT'
const DEFAULT_ENGINE_PORT = 4145

/**
 * 当前引擎端口（每次请求读 env；与 bridge 的 loopbackAuthorities 同口径，跨包不 import 值）。
 *
 * 壳侧 spawn 时注入 `DSH_ENGINE_PORT`；缺失按默认 4145，存在但非十进制/越界则返回 null。
 * 不得在模块顶层缓存：插件 import 早于 server.listen() 写 env，缓存会钉死未绑定前的默认值。
 */
export function enginePortFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[ENGINE_PORT_ENV]
  if (raw === undefined) return DEFAULT_ENGINE_PORT
  if (!/^[0-9]+$/.test(raw)) return null
  const port = Number(raw)
  return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

/** 只信任实际监听端口对应的回环 authority；env 非法时返回空表（调用方一律拒绝）。 */
export function loopbackAuthorities(env: Record<string, string | undefined> = process.env): string[] {
  const port = enginePortFromEnv(env)
  return port === null ? [] : ['127.0.0.1:' + port, 'localhost:' + port]
}

/**
 * review C12：公开只读状态路由的回环栅栏——载荷只有元数据（不要求令牌），但必须拒绝
 * 非回环 Host 与跨站请求；connection 服务的 Host/Origin 判定（403）优先，异常一律 fail-closed。
 */
function publicRouteRejected(req: WsReq, connection?: { requestRejection?(r: unknown): 401 | 403 | undefined }): boolean {
  if (connection !== undefined) {
    try {
      return connection.requestRejection?.(req) === 403
    } catch {
      return true
    }
  }
  const headerOf = (name: string): string | undefined => {
    const v = req.headers?.[name]
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
  }
  const host = headerOf('host')?.trim().toLowerCase()
  const trusted = loopbackAuthorities()
  if (trusted.length === 0 || host === undefined || !trusted.includes(host)) return true
  if (headerOf('sec-fetch-site')?.toLowerCase() === 'cross-site') return true
  const origin = headerOf('origin')
  if (origin !== undefined && origin !== '' && !trusted.some((authority) => origin.toLowerCase() === 'http://' + authority)) {
    return true
  }
  return false
}

/** 只读 JSON 响应。 */
function sendJson(res: WsRes, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 宿主半入口：注册只读状态端点与状态工具。开关未接通前不注册任何特权 op、不改任何默认路径。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const faceOf = (): VdisplayFace | undefined => ctx.get('androidPrivilege') as VdisplayFace | undefined

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_status',
    description:
      '查询虚拟屏（Shizuku 特权通道）的能力与运行状态：开关、fail-closed 探测结果、可用 op 表、'
      + '错误码与补救指引。本工具只读、不改设备状态；返回 ok=false 时表示当前不可用（看 code/guidance），'
      + '此时仍可用真实屏控制。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          code: { type: 'string', required: true },
          guidance: { type: 'string', required: true },
          ops: { type: 'array', required: true, items: { type: 'string' } },
          transports: { type: 'array', items: { type: 'string' } },
          displayId: { type: 'integer' },
          selected: { type: 'string' },
          screens: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                displayId: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                state: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                densityDpi: { type: 'integer', required: true },
                selectable: { type: 'boolean', required: true },
                reason: { type: 'string', required: true },
                viewerId: { type: 'string' },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.guidance ?? '') }],
    },
    execute: async () => {
      // 状态必须走**与控制 op 同一条通路**（0.14.0 真机实锤缺陷）。
      //
      // 缺陷形态：`android_vdisplay_create` 成功（displayId=25/state=active），同一时刻
      // `android_vdisplay_status` 报「虚拟屏桥面尚未接通」。真因不是壳侧没落地，而是两条通路
      // 形状不同——create 走 controlExec（引擎侧 androidPrivilege 只暴露这一个面），
      // status 却去读 `vdisplayStatus?.()`，而**该字段在引擎侧服务上从未存在**。
      // 于是 status 恒拿 undefined → 恒报 blocked/vdisplay-shell-not-wired。
      //
      // 后果（用户实测）：模型看到「有屏但没用处」，据此判定能力不可用而放弃整条路径。
      // **声称不可用而实际可用**，与「声称可用而实际不可用」危害相同——都会让模型做出错误决策。
      //
      // 修法：`readVdToolSnapshot` 优先走控制队列 vdInfo（与 create/destroy 同源），
      // 拿不到才回退桥面；失败时的 code/guidance 必须**归因准确**（读不到 ≠ 没落地）。
      const snap = await readVdToolSnapshot(faceOf())
      return { ...snap, text: snap.ok ? snap.guidance : '虚拟屏不可用：' + snap.code + '。' + snap.guidance }
    },
  }))

  /** 会话对象（`exec.agent.session` 原样）——**档位门**要的是它，不是 id 字符串。 */
  const rawSessionOf = (exec: unknown): unknown =>
    (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session

  /** 会话 id：生命周期 op 的**归属键**，壳侧据此做单实例归属校验（0.14.0）。 */
  const sessionOf = (exec: unknown): string | undefined => {
    const session = rawSessionOf(exec)
    if (typeof session === 'string' && session !== '') return session
    if (session !== null && session !== undefined && typeof session === 'object') {
      const id = (session as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') return id
    }
    return undefined
  }

  /**
   * AI 自主建屏：把 vd* 生命周期 op 经控制队列投递给壳侧（neverA11y 的壳桥 op 借队列投递）。
   * 失败一律结构化（ok:false + 稳定 code/guidance），从不静默，也不在工具层猜测壳侧状态。
   */
  const callVdOp = async (op: VdOp, timeoutMs: number, exec?: unknown, extra?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const session = sessionOf(exec)
    // **必须以服务对象为接收者调用**（0.14.0 设备实锤：Agent 全工具扫描揪出）。
    //
    // 错误写法（曾存在）：先 const controlExec = faceOf()?.controlExec，再 controlExec(op, ...)。
    // 把方法从服务对象上摘下来原地调用会丢 this，于是 AndroidPrivilegeService.controlExec 内部的
    // this.controlQueue 变成 undefined.controlQueue，抛
    //   Cannot read properties of undefined (reading 'controlQueue')
    // 并被下面的 catch 包成 vdisplay-control-exception。现象：android_vdisplay_create/destroy 恒失败，
    // 而**壳侧桥直接调用同一 op 完全正常**——这正是区分「工具层缺陷」与「壳侧缺陷」的关键证据。
    //
    // 与客户端侧坑 108（@JavascriptInterface 方法不得裸调）同源：凡方法依赖 this，就不得摘出来裸调。
    const service = faceOf()
    if (service?.controlExec === undefined) {
      return {
        ok: false,
        code: 'vdisplay-control-unavailable',
        guidance: '引擎侧桥服务（androidPrivilege）未装配：无法经控制队列调用 ' + op + '。',
      }
    }
    try {
      const payload: Record<string, unknown> = { ...(extra ?? {}) }
      // 两个「会话」用途不同，别混：
      //   · payload.session —— 壳侧单实例**归属**校验（0.14.0：生命周期 op 带归属会话）；
      //   · auth.session    —— bridge 服务面的**档位门**来源。`TIER_REQUIRED_OPS`（含 vdInput）
      //     按 resolveAuth 取值顺序「显式 auth > AsyncLocalStorage 绑定 > 无」解析，解析不到即
      //     fail-closed 拒绝。0.14.1 设备实测：本插件此前只给 payload、不给 auth，也不 bindSession
      //     ⇒ `android_vdisplay_input` 恒回「缺少调用方会话」，而工具描述与三处指引都在承诺它可用。
      if (session !== undefined) payload.session = session
      // 档位门（`authorizePrivileged` → `gateFor` → `sandboxPolicy.resolve({session})`）要的是
      // **会话对象**，不是 id 字符串：上游 resolve 会访问会话上的成员，传字符串会抛
      // 「session.snapshotEvents is not a function」——设备实测（W2 真实任务）第一次修就是
      // 传了 id 字符串，于是 vdInput 从「denied-no-session」变成另一条失败，仍旧不可用。
      // 与 manage 的 `bindSession(exec?.agent?.session)` 同源：**原样传对象**。
      const raw = rawSessionOf(exec)
      const reply = await service.controlExec(
        op, payload, timeoutMs, raw === undefined || raw === null ? undefined : { session: raw },
      )
      if (reply === null || typeof reply !== 'object' || reply.ok !== true) {
        const message = typeof reply?.error === 'string' && reply.error !== ''
          ? reply.error
          : op + ' 调用失败（控制队列未返回结果）。'
        const replyCode = typeof reply?.code === 'string' ? reply.code : undefined
        const stableCode = ['screen-out-of-scope', 'screen-not-ready', 'screen-not-found'].includes(replyCode ?? '')
          ? replyCode
          : /^(screen-out-of-scope|screen-not-ready|screen-not-found)(?=[:：]|$)/.exec(message)?.[1]
        return { ok: false, code: stableCode ?? 'vdisplay-op-failed', guidance: message }
      }
      const data = (reply.data ?? {}) as Record<string, unknown>
      if (data.ok === false) {
        return {
          ok: false,
          code: typeof data.reason === 'string' && data.reason !== '' ? data.reason : 'vdisplay-op-rejected',
          guidance: typeof data.guidance === 'string' && data.guidance !== '' ? data.guidance : op + ' 被拒绝。',
        }
      }
      const out: Record<string, unknown> = {
        ok: true,
        code: 'vdisplay-ok',
        guidance: typeof data.guidance === 'string' ? data.guidance : '',
        state: typeof data.state === 'string' && data.state !== '' ? data.state : 'ready',
      }
      if (typeof data.displayId === 'number') out.displayId = data.displayId
      if (typeof data.screenId === 'string' && data.screenId !== '') out.screenId = data.screenId
      return out
    } catch (e) {
      return { ok: false, code: 'vdisplay-control-exception', guidance: '控制通道异常：' + String((e as Error).message) }
    }
  }

  /** 生命周期工具的输出 schema/渲染（两工具同形：ok + code + guidance + state + displayId?）。 */
  const lifecycleOutput = (verb: string) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        code: { type: 'string', required: true },
        guidance: { type: 'string', required: true },
        state: { type: 'string' },
        displayId: { type: 'integer' },
      },
    },
    render: (_args: unknown, v: Record<string, unknown>) => [{
      type: 'text',
      text: verb + (v.ok === true ? '成功' : '失败')
        + '（code=' + String(v.code ?? '')
        + (typeof v.displayId === 'number' ? '，displayId=' + String(v.displayId) : '')
        + (typeof v.state === 'string' ? '，state=' + v.state : '')
        + '）：' + String(v.guidance ?? ''),
    }],
  })

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_create',
    description:
      '创建（或复用已存在的）虚拟屏并让 AI 于其上工作。Shizuku 特权通道、幂等；成功后右侧栏自动露出'
      + '「虚拟屏」查看器，真实屏不受影响。失败时返回结构化 code/guidance（能力缺项、通道未就绪等），'
      + '此时请用 android_vdisplay_status 复核，不要假设屏幕已存在。',
    parameters: {},
    output: lifecycleOutput('虚拟屏创建') as never,
    execute: async (_args: unknown, exec: unknown) => callVdOp('vdCreate', 45_000, exec) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_destroy',
    description:
      '销毁当前虚拟屏及其上的任务（Shizuku 特权通道）。幂等：不存在时也返回成功形态；'
      + '调用前应确认虚拟屏上没有任何未保存的用户工作。',
    parameters: {},
    output: lifecycleOutput('虚拟屏销毁') as never,
    execute: async (_args: unknown, exec: unknown) => callVdOp('vdDestroy', 30_000, exec) as never,
  }))
  /** 输入工具的拒绝形态（与 callVdOp 的失败形态同形，便于模型统一处理）。 */
  const rejectInput = (guidance: string): Record<string, unknown> => ({ ok: false, code: 'invalid-arguments', guidance })

  /** 输入工具的输出 schema（回执里带屏身份，让模型能自证注入落在哪块屏）。 */
  const inputOutput = (label: string) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        code: { type: 'string', required: true },
        guidance: { type: 'string', required: true },
        state: { type: 'string' },
        verb: { type: 'string' },
        screenId: { type: 'string' },
        displayId: { type: 'integer' },
      },
    },
    render: (_args: unknown, v: Record<string, unknown>) => [{
      type: 'text',
      text: label + (v.ok === true ? '成功' : '失败')
        + '（code=' + String(v.code ?? '')
        + (typeof v.screenId === 'string' ? '，screenId=' + v.screenId : '')
        + (typeof v.displayId === 'number' ? '，displayId=' + String(v.displayId) : '')
        + '）：' + String(v.guidance ?? ''),
    }],
  })

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_input',
    description:
      '向虚拟屏注入输入（tap/swipe/keyevent/text）：坐标基于**该虚拟屏自身像素**（先用 android_vdisplay_status 看宽高），'
      + '经壳侧 `input -d <displayId>` 的固定 argv 执行，真实屏前台不受影响。'
      + '虚拟屏上的**按键与文本**只有这一条路；能按语义节点点击时优先 android_ui_click（ref）。'
      + 'screenId 缺省取当前选中的虚拟屏。',
    parameters: {
      verb: { type: 'string', required: true, enum: ['tap', 'swipe', 'keyevent', 'text'], description: '输入动作类型' },
      x: { type: 'number', description: 'tap/swipe 起点 X（该屏像素）' },
      y: { type: 'number', description: 'tap/swipe 起点 Y（该屏像素）' },
      x2: { type: 'number', description: 'swipe 终点 X（该屏像素）' },
      y2: { type: 'number', description: 'swipe 终点 Y（该屏像素）' },
      duration: { type: 'number', description: 'swipe 时长 ms（默认 300，上限 20000）' },
      keycode: { type: 'number', description: 'keyevent 键码（如 4=返回、3=主页、26=电源）' },
      text: { type: 'string', description: 'text 要输入的文本（1-500 字符；argv 直传，中文可用）' },
      screenId: { type: 'string', description: '目标虚拟屏别名 virtual-N（缺省取当前选中）' },
    },
    output: inputOutput('虚拟屏输入') as never,
    execute: async (args: Record<string, unknown> | undefined, exec: unknown) => {
      const a = (args ?? {}) as {
        verb?: string; x?: number; y?: number; x2?: number; y2?: number
        duration?: number; keycode?: number; text?: string; screenId?: string
      }
      const verb = a.verb ?? ''
      const payload: Record<string, unknown> = { verb }
      if (typeof a.screenId === 'string' && a.screenId !== '') payload.target = a.screenId
      // 逐 verb 校验后在**本地**拦一次：壳侧也有同源校验，但先拦能省一次往返并给出可执行文案。
      const coord = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 99999
      if (verb === 'tap') {
        if (!coord(a.x) || !coord(a.y)) return rejectInput('tap 需要合法整数坐标 (x, y)') as never
        payload.x = a.x
        payload.y = a.y
      } else if (verb === 'swipe') {
        if (!coord(a.x) || !coord(a.y) || !coord(a.x2) || !coord(a.y2)) {
          return rejectInput('swipe 需要合法整数 (x, y, x2, y2)') as never
        }
        const d = a.duration ?? 300
        if (!Number.isInteger(d) || d < 0 || d > 20_000) return rejectInput('swipe 的 duration 需为 0-20000 毫秒') as never
        payload.x = a.x
        payload.y = a.y
        payload.x2 = a.x2
        payload.y2 = a.y2
        payload.duration = d
      } else if (verb === 'keyevent') {
        if (!Number.isInteger(a.keycode) || a.keycode! < 0 || a.keycode! > 255) {
          return rejectInput('keyevent 需要合法整数 keycode（0-255）') as never
        }
        payload.keycode = a.keycode
      } else if (verb === 'text') {
        const raw = a.text ?? ''
        if (raw.length === 0 || raw.length > 500) return rejectInput('text 长度需为 1-500 字符') as never
        payload.text = raw
      } else {
        return rejectInput('verb 必须是 tap / swipe / keyevent / text') as never
      }
      return { ...(await callVdOp('vdInput', 15_000, exec, payload)), verb } as never
    },
  }))

  // 工具面决策更正（0.14.1 设备实测，2026-09-19）：此处原文写「本插件不新增模型面工具」，理由是
  // 「预算 + 模型在同义工具间试探」，并主张用 android_app_launch/android_ui_click 传 screenId 承担。
  // 该结论被设备实测推翻：**指引三处承诺 `android_vdisplay_input` 而它从未存在**
  // （manage 的工具描述与两处失败文案、bridge 的坐标模式指引），模型按指引调用只得 `unknown tool`；
  // 而虚拟屏上的 keyevent/text 在工具面**完全无路可达**（android_ui_input 只对可编辑节点生效）。
  // 「指引指向一条不存在的路」比拒绝更难排查——本仓已为同一形态的缺陷修过一次（manage 的 x/y 分支）。
  // 故本轮**补实现**（能力早已在壳侧 `vdInput`：固定 argv `input -d <displayId>`），不删文档承诺。
  // 预算代价：注册集 +1 个工具，已按流程重算 `scripts/tool-surface-budget.json`（初始可见集不变——
  // 本工具归入 virtual-display 组，受渐进披露掩蔽）。

  // 右侧栏面板的数据源（只读；与工具面同源）。webServer 服务缺席时只告警：面板会走
  // "状态源不可达 → blocked"，不影响引擎启动，也不假装可用。
  // 可选服务一律走 ctx.get（不 inject）：属性访问 ctx.webServer 在未声明 inject 时会抛
  // cannot get property "webServer" without inject——与 tools 同一条 cordis 规则（坑 82）。
  const wsvc = ctx.get('webServer') as { register(r: unknown): void } | undefined
  if (!wsvc) {
    ctx.logger?.('dsh-android-vdisplay')?.warn?.('webServer 服务缺席——状态端点未注册（面板将显示 blocked）')
    return
  }
  const publicRouteConnection = (() => {
    try {
      return ctx.get('connection') as { requestRejection?(r: unknown): 401 | 403 | undefined } | undefined
    } catch {
      return undefined
    }
  })()
  wsvc.register({
    kind: 'exact',
    path: VD_STATUS_PATH,
    handler: async (req: WsReq, res: WsRes) => {
      if (req.method !== undefined && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'vdisplay-method-not-allowed' })
        return
      }
      // review C12：公开只读 ≠ 无栅栏——非回环 Host/跨站请求在读取任何状态前拒绝。
      if (publicRouteRejected(req, publicRouteConnection)) {
        res.statusCode = 403
        res.setHeader?.('cache-control', 'no-store')
        res.end('')
        return
      }
      // 与控制 op 同源（readVdToolSnapshot 的说明）：控制队列 vdInfo 优先，桥面兜底。
      sendJson(res, 200, await readVdToolSnapshot(faceOf()))
    },
  })
}
