/**
 * dsh-android-browser 工具面：把 BROWSER_TOOLS 契约逐条落到壳侧 `browser*` 控制 op。
 *
 * 纪律（方案 §4.2 / 验收 §4.5）：
 *  - **ref + pageGeneration 双校验**：snapshot 得到 `{tabId,pageGeneration,refs}` 后，动作工具必须带上
 *    同代 ref；原生侧还会再验一次 generation 与当前页代次。旧 ref / 跨页 ref 一律拒绝，不猜测点击。
 *  - **URL 准入门在原生 BrowserHost**（只允许非本地 http(s)/about:blank）；本层不复制准入逻辑，
 *    但会把拒绝原因原样透传给模型。
 *  - 单一工位（一个 BrowserHost，一个标签页）：多标签工具如实返回单标签事实，不假装支持。
 *  - 每个动作写审计（经 bridge 服务的 audit 面；缺失时静默降级，审计不是主流程门禁）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BROWSER_OPS, BROWSER_TOOLS, IDENTITY_PROFILES, VIEWPORT_PRESETS } from './contract.js'
import type { ControlFace } from './facts.js'

/** 浏览器工具需要的控制面（bridge 服务；browser* 由控制队列承载）。 */
export interface BrowserControlFace extends ControlFace {
  gateFor?(session?: unknown): { ok: true; via?: string } | { ok: false; guidance: string }
  audit?(action: string, detail: Record<string, unknown>, ok: boolean): void
}

type Payload = Record<string, unknown>
type CallResult = { ok: true; data: Payload } | { ok: false; error: string; guidance?: string }

interface SnapshotMemory {
  tabId: string
  pageGeneration: number
  refs: Set<string>
}

/** 最近一次成功 snapshot 的 ref 集（单工位；动作工具据此附带 generation）。 */
let lastSnapshot: SnapshotMemory | undefined

/** 清除浏览器记忆（open/navigate 换页、测试隔离）。 */
export function resetBrowserMemory(): void {
  lastSnapshot = undefined
}

/**
 * 输出 schema 构造器。
 *
 * defineTool 的 schema 形参要求字面量方言（ParameterPropertySpec）；这里集中构造后以 `as never`
 * 交给调用点（与 manage 工具面 `as never` 的既有形态同族）。运行期结构由引擎整值校验与
 * check-tool-output-schema 门禁核对——类型断言不改变运行期契约。
 */
function objectSchema(properties: Record<string, unknown>): never {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      error: { type: 'string' },
      guidance: { type: 'string' },
      ...properties,
    },
  } as never
}

const SNAPSHOT_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ref: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    bounds: { type: 'array' },
    inView: { type: 'boolean' },
    disabled: { type: 'boolean' },
  },
}

/**
 * 把节点列表渲染成**模型可直接使用的行**（每行一个 ref），而不是只报总数。
 *
 * 缺陷形态（用户 2026-09-17 实报）：`browser_snapshot` 的返回值里 `nodes` 明明带着 `ref`，
 * 但 render 只输出「快照 N 个可交互节点」——**模型看不到任何 ref，于是 browser_click/
 * browser_type 根本无从下手**。工具「声称可用」（schema 有 nodes）却「关键信息不可达」，
 * 这正是本轮两轮阻碍的共同主题：能力声明与可用通道不一致。
 *
 * 行格式（紧凑、按预算截断，逐行一个可点目标）：
 *   bx12 button "登录" [in-view]
 * 名称里的换行/引号做转义，避免一行被拆成两行后误读。
 * @param nodes - 快照节点数组（形状不可信，逐字段收窄）。
 * @param budget - 最多渲染的行数（超出如实注明省略数量，不静默截断）。
 * @returns 多行文本；无节点时给明确空态说明。
 */
function renderSnapshotNodes(nodes: unknown[], budget = 120): string {
  if (nodes.length === 0) {
    return '（本页没有可交互节点——可能是纯文本页、页面尚未加载完，或内容在 iframe 内。）'
  }
  const lines: string[] = []
  for (const raw of nodes.slice(0, budget)) {
    if (raw === null || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    const ref = typeof node.ref === 'string' ? node.ref : ''
    const role = typeof node.role === 'string' && node.role !== '' ? node.role : 'node'
    // 审查 N-12：旧写法是 `/\\s+/g`（笔误：匹配「反斜杠 + s」，不匹配任何空白）——页面可控的
    // 节点名里的换行不会被折叠，可在模型看到的快照清单里**插入伪造行**（本行上方的注释本来就
    // 声称做了这件事）。必须是 `\s+`。
    const name = typeof node.name === 'string' ? node.name.replace(/\s+/g, ' ').trim() : ''
    const flags = node.inView === false ? ' [off-screen]' : ''
    const disabled = node.disabled === true ? ' [disabled]' : ''
    const label = name === '' ? '' : ' "' + name.replace(/"/g, "'").slice(0, 80) + '"'
    lines.push((ref === '' ? '(no-ref) ' : ref + ' ') + role + label + flags + disabled)
  }
  if (nodes.length > budget) lines.push('…（还有 ' + String(nodes.length - budget) + ' 个节点未列出）')
  return lines.join('\n')
}

/**
 * 收窄壳侧 `loadState`（BrowserHost.status() 的单一真源）。
 *
 * 缺失/非字符串一律按 `'unknown'` 如实上报——**不得回落成 `'loaded'`**：那正是 issue #232 的
 * 假成功形态（「壳侧知道失败、回执当成功」）。未知就说未知，模型据此决定是否复核。
 * @param v - 工具返回值。
 * @returns 可直接进回执文本的状态串。
 */
function loadStateOf(v: Record<string, unknown>): string {
  return typeof v.loadState === 'string' && v.loadState !== '' ? v.loadState : 'unknown'
}

/**
 * 把壳侧加载状态渲染成**模型能判别**的回执后缀（issue #232 修复核心）。
 *
 * 缺陷形态（用户 2026-09-18 实报，社区 issue #232）：`browser_open` 的 render 恒拼
 * 「已打开 <url>」，而壳侧失败时 `tab.url` 仍是**失败的 URL**（`BrowserHost.kt:627`），
 * 于是成功与失败两条路径的 render 输出**逐字相同**——模型没有任何可判别信号。
 * 这不是「信息缺失」，是**两种相反的事实被渲染成同一句话**。
 *
 * 本助手是 F1/F4 的公共调用点：`error` 必须显式出现在回执里并带壳侧 `reason` 与下一步指引；
 * 非 error 也如实报状态（缺失时是 `unknown`，不是成功）。集中一处避免两处再次漂移。
 * @param v - 工具返回值（含 loadState/reason）。
 * @returns 以「；」开头的后缀片段。
 */
function renderLoadState(v: Record<string, unknown>): string {
  const state = loadStateOf(v)
  const reason = typeof v.reason === 'string' && v.reason !== '' ? '，reason=' + v.reason : ''
  if (state === 'error') {
    return '；loadState=error' + reason
      + '（该页未加载成功，不要按成功处理：先用 browser_get_text 读错误页正文确认原因，'
      + '再核对地址与网络后决定是否重试）'
  }
  return '；loadState=' + state + reason
}

/**
 * 页面标题后缀（schema 已声明 `title` 却从未渲染，模型看不到站点是否换页）。
 * @param v - 工具返回值。
 * @returns `，title "<title>"`；无标题时给空串（不出现空引号）。
 */
function renderTitle(v: Record<string, unknown>): string {
  const title = typeof v.title === 'string' && v.title !== '' ? v.title.replace(/"/g, "'").slice(0, 80) : ''
  return title === '' ? '' : '，title "' + title + '"'
}

/**
 * 单页回执行渲染（`browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` 共用）。
 *
 * 壳侧 `tabSummaries()`（`BrowserHost.kt:80-91`）**已提供** `tabId`/`url`/`title`/`loadState`/
 * `active` 五字段，故逐页回执**无需改壳侧**——此前 render 只回「N 个网页」，模型看不到任何
 * url/title（issue #232 P1；与 `tools.ts:73-87` 记过的 `browser_snapshot` 同族缺陷同形）。
 * @param raw - 壳侧 tab 摘要（形状不可信，逐字段收窄）。
 * @param activeTabId - 活动页 id（壳侧权威值）。
 * @returns 一行文本：`<tabId> <url> "<title>" loadState=<state> [活动页]`。
 */
function renderTabLine(raw: unknown, activeTabId: string): string {
  const tab = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const tabId = typeof tab.tabId === 'string' && tab.tabId !== '' ? tab.tabId : '(未知页)'
  const url = typeof tab.url === 'string' && tab.url !== '' ? tab.url : '(无地址)'
  const title = typeof tab.title === 'string' && tab.title !== ''
    ? ' "' + tab.title.replace(/"/g, "'").slice(0, 80) + '"' : ''
  const state = typeof tab.loadState === 'string' && tab.loadState !== '' ? tab.loadState : 'unknown'
  const active = tab.active === true || (activeTabId !== '' && tabId === activeTabId) ? ' 活动页' : ''
  return tabId + ' ' + url + title + ' loadState=' + state + active
}

/**
 * 多页回执清单（表头 + 逐页行）。空态如实说明，不静默给空串。
 * @param v - 含 `tabs`/`activeTabId` 的返回值。
 * @returns 多行文本。
 */
function renderTabLines(v: Record<string, unknown>): string {
  const tabs = Array.isArray(v.tabs) ? (v.tabs as unknown[]) : []
  const activeTabId = typeof v.activeTabId === 'string' ? v.activeTabId : ''
  if (tabs.length === 0) return '当前没有打开的网页。'
  return '共 ' + String(tabs.length) + ' 个网页（活动 ' + (activeTabId === '' ? '无' : activeTabId) + '）：'
    + '\n' + tabs.map((t) => renderTabLine(t, activeTabId)).join('\n')
}

export function browserTools(face: () => BrowserControlFace | undefined): unknown[] {
  /** 会话键：控制 op 一律带归属会话，壳侧据此做单实例归属校验（0.14.0）。 */
  const sessionScope = new AsyncLocalStorage<string>()

  const sessionOf = (exec: unknown): string | undefined => {
    const session = (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session
    if (typeof session === 'string' && session !== '') return session
    if (session !== null && session !== undefined && typeof session === 'object') {
      const id = (session as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') return id
    }
    return undefined
  }

  /**
   * 工具面统一包裹（2026-09-15）：
   * - 失败渲染兜底：拒绝/失败对象（denied(...)）此前仍被 render 渲染，字段取不到就输出 undefined，
   *   snapshot 的 render 还会在 undefined 上抛错——真实 error/guidance 被吞掉；现 ok:false 一律渲染原文；
   * - 会话注入：execute 期间把归属会话放进作用域，`call` 自动附加到控制 op 参数上（壳侧归属校验）。
   */
  const withFailureText = (tool: unknown): unknown => {
    const definition = tool as {
      output?: { render?: unknown }
      execute?: (args: unknown, exec: unknown) => unknown
    }
    const originalExecute = definition.execute
    const wrapped = (() => {
      const output = definition.output
      if (output === undefined || typeof output.render !== 'function') return tool
      const original = output.render as (args: unknown, v: Record<string, unknown>) => unknown
      return {
        ...(tool as Record<string, unknown>),
        output: {
          ...(output as Record<string, unknown>),
          render: (args: unknown, v: Record<string, unknown>) => {
            if (v !== null && typeof v === 'object' && v.ok === false) {
              const error = typeof v.error === 'string' && v.error !== '' ? v.error : 'tool-failed'
              const guidance = typeof v.guidance === 'string' && v.guidance !== '' ? '（' + v.guidance + '）' : ''
              // 失败回执必须带上**已声明且值确实存在**的判别字段（G2a-4 / issue #232 同族）：
              // browser_wait 超时返回 `{ok:false, waited, reason:'stable-timeout'}` 却无 `error`，
              // 通用兜底只印「失败：tool-failed」——把壳侧给的真实原因（超时类型）吞掉了，
              // 而 `reason` 恰是 schema 声明、模型最需要的那个信号。此处如实透出，不再一律 tool-failed。
              const reason = typeof v.reason === 'string' && v.reason !== '' ? '，reason=' + v.reason : ''
              const waited = typeof v.waited === 'number' && Number.isFinite(v.waited) ? '，waited=' + v.waited + 'ms' : ''
              return [{ type: 'text', text: '失败：' + error + reason + waited + guidance }]
            }
            return original(args, v)
          },
        },
      }
    })()
    if (typeof originalExecute !== 'function') return wrapped
    return {
      ...(wrapped as Record<string, unknown>),
      execute: (args: unknown, exec: unknown) => {
        const session = sessionOf(exec)
        return session === undefined
          ? originalExecute(args, exec)
          : sessionScope.run(session, () => originalExecute(args, exec))
      },
    }
  }

  const call = async (op: string, args: Payload, timeoutMs = 15_000): Promise<CallResult> => {
    const session = sessionScope.getStore()
    const payload: Payload = session === undefined ? args : { ...args, session }
    const control = face()
    if (control?.controlExec === undefined) {
      return { ok: false, error: 'bridge-unavailable', guidance: '引擎侧桥服务（androidPrivilege）未装配，无法调用浏览器控制通道。' }
    }
    try {
      const reply = await control.controlExec(op, payload, timeoutMs)
      if (reply === null || typeof reply !== 'object' || (reply as { ok?: unknown }).ok !== true) {
        const message = (reply as { error?: unknown } | null)?.error
        return { ok: false, error: typeof message === 'string' && message !== '' ? message : 'control-failed' }
      }
      const data = ((reply as { data?: unknown }).data ?? {}) as Payload
      if (data.ok === false) {
        return {
          ok: false,
          error: typeof data.reason === 'string' ? data.reason : 'op-rejected',
          ...(typeof data.guidance === 'string' ? { guidance: data.guidance } : {}),
        }
      }
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: 'control-exception: ' + String((e as Error).message) }
    }
  }

  // 浏览器面**不做任何授权校验**（0.14.0 实锤缺陷修复）。
  //
  // 原实现复用 bridge 的 device-control gateFor()：它要求会话档位 danger-full-access 且
  // a11y / Shizuku / adb 三条至少有其一。于是「无障碍未开 + Shizuku 未就绪」的机器上
  // browser_open 直接报 session-not-full-access，引导用户去开无障碍或装 Shizuku——而浏览器是
  // **应用内隔离 WebView**（壳侧 BrowserHost 自持一个 WebView），既不碰无障碍、也不碰 Shizuku、
  // 也不碰 adb，与设备控制完全无关。这条误门把本来可用的能力锁死（用户实测三个站点全部失败）。
  //
  // 为什么校验**不放在工具层**：这是权限/归属问题，不是工具能力问题。真正要守的两件事都在
  // 原生 BrowserHost 内强制执行、且与工具层无关：
  //   ① 会话归属——bindOwner/requireOwner 按 args.session 判定，非归属会话结构化拒绝；
  //   ② URL 准入——只允许非本地 http(s)/about:blank，拒 loopback/file/content/data/javascript。
  // 因此本层直接透传，由原生执行点做它该做的校验（单一真源，避免两处各写一份漂移）。
  const gate = (_exec: unknown): { ok: true } | { ok: false; guidance: string } => ({ ok: true })

  const audit = (tool: string, args: Payload, ok: boolean): void => {
    try { face()?.audit?.(tool, { tool, args }, ok) } catch { /* 审计缺失不阻塞 */ }
  }

  const parseJsJson = (value: unknown): Payload | undefined => {
    if (typeof value !== 'string') return undefined
    try {
      const parsed = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' ? (parsed as Payload) : undefined
    } catch {
      return undefined
    }
  }

  const denied = (result: { ok: false; error: string; guidance?: string }, extra: Payload = {}): Payload => ({
    ok: false,
    error: result.error,
    ...(result.guidance === undefined ? {} : { guidance: result.guidance }),
    ...extra,
  })

  const stateOf = async (): Promise<Payload> => {
    const result = await call(BROWSER_OPS.state, {}, 6_000)
    return result.ok ? result.data : {}
  }

  const pageGenerationOf = (data: Payload): number => {
    const value = data.pageGeneration
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  const requireSnapshot = (): SnapshotMemory | undefined => lastSnapshot

  const tools: unknown[] = [
    defineTool({
      name: BROWSER_TOOLS.open,
      description:
        '打开侧栏 AI 浏览器并导航到一个 http(s) 地址（本地回环/file/content/data/javascript 一律拒绝）。'
        + '可选先应用视口档（viewport）与身份档（identity）。返回页面代次，后续 snapshot/click 以它为准。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的 http(s) 地址' },
        viewport: { type: 'string', description: '视口档 id（见 browser_set_viewport 的预设表）' },
        identity: { type: 'string', description: '身份档 id：android-real | linux-desktop | windows-desktop' },
        tabId: { type: 'string', description: '（可选）任务标识：给定时复用/新建该标识的网页，便于把后续动作收敛到同一页' },
      },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          title: { type: 'string' },
          loadState: { type: 'string' },
          reason: { type: 'string' },
          pageGeneration: { type: 'number' },
          appliedViewport: { type: 'string' },
          appliedIdentity: { type: 'string' },
          tabId: { type: 'string' },
        }),
        // issue #232：失败时壳侧 url 仍是失败的 URL，故「已打开 <url>」在成功/失败两条路径上逐字相同。
        // 现在动词、状态与原因都随 loadState 走（loadState=error 时给出可执行指引），模型才有可判别信号。
        render: (_args, v: Record<string, unknown>) => [{
          type: 'text',
          text: (loadStateOf(v) === 'error' ? '打开失败 ' : '已打开 ') + String(v.url)
            + '（页 ' + String(v.tabId) + '，代次 ' + String(v.pageGeneration) + '）'
            + renderTitle(v) + renderLoadState(v),
        }],
      },
      execute: async ({ url, viewport, identity, tabId }: { url: string; viewport?: string; identity?: string; tabId?: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'browser-not-authorized', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.open, { url, viewport, identity }, true)
        let appliedViewport: string | undefined
        if (typeof viewport === 'string' && viewport !== '') {
          const preset = VIEWPORT_PRESETS.find((p) => p.id === viewport)
          // 未知预设必须**回报可用取值**（用户实报：只报 unknown-viewport，模型无从得知有哪些档，
          // 只能靠猜——猜不到就放弃整条路径）。与 browser_set_viewport 的错误形状保持一致。
          if (preset === undefined && viewport !== 'follow-screen' && viewport !== 'device') {
            return {
              ok: false, error: 'unknown-viewport',
              guidance: '可用视口：' + VIEWPORT_PRESETS.map((p) => p.id).join(', ') + '（device/follow-screen = 跟随工位）。',
            } as never
          }
          const result = await call(BROWSER_OPS.viewport, { preset: viewport, route: 'S2', width: preset?.width ?? 0, height: preset?.height ?? 0 }, 8_000)
          if (!result.ok) return denied(result) as never
          appliedViewport = viewport
        }
        let appliedIdentity: string | undefined
        if (typeof identity === 'string' && identity !== '') {
          const profile = IDENTITY_PROFILES.find((p) => p.id === identity)
          if (profile === undefined) {
            return {
              ok: false, error: 'unknown-identity',
              guidance: '可用身份：' + IDENTITY_PROFILES.map((p) => p.id).join(', ') + '。',
            } as never
          }
          const result = await call(BROWSER_OPS.setUa, { profile: profile.id, ua: profile.ua, platform: profile.platform, mobile: profile.mobile }, 8_000)
          if (!result.ok) return denied(result) as never
          appliedIdentity = profile.id
        }
        // tabId = 任务标识：给了就用它（存在则复用、不存在则新建），不给就**开一个新页**。
        // 这是「AI 可以同时控制多网页」的入口语义：每次 browser_open 默认得到独立一页。
        const route = typeof tabId === 'string' && tabId !== '' ? { tabId } : { newTab: true }
        const opened = await call(BROWSER_OPS.open, { url, ...route }, 20_000)
        if (!opened.ok) return denied(opened) as never
        resetBrowserMemory()
        const state = await stateOf()
        const openedTabId = typeof opened.data.tabId === 'string' ? opened.data.tabId : ''
        return {
          ok: true,
          tabId: openedTabId,
          url: typeof state.url === 'string' ? state.url : url,
          title: typeof state.title === 'string' ? state.title : '',
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          // issue #232：壳侧 status() 的 reason（BrowserHost.kt:818 `lastError`，如 `load-error:-1`）
          // 此前被整条丢弃 —— 回执既不知道失败、也无法诊断。整键缺席而非空串（lossless JSON 纪律）。
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
          pageGeneration: pageGenerationOf({ ...opened.data, ...state }),
          ...(appliedViewport === undefined ? {} : { appliedViewport }),
          ...(appliedIdentity === undefined ? {} : { appliedIdentity }),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.snapshot,
      description:
        '对当前浏览器页面建立结构化 DOM/ARIA 快照：返回标签、页面代次、视口与可交互节点列表（ref/role/name/bounds/inView）。'
        + '后续 click/type 必须使用本快照的 ref，并会校验页面代次；页面已变化时旧 ref 一律拒绝。',
      parameters: {
        delta: { type: 'boolean', description: '保留参数：当前实现总是返回完整快照（单工位页面通常很小）' },
      },
      output: {
        schema: objectSchema({
          tabId: { type: 'string' },
          pageGeneration: { type: 'number' },
          surface: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          viewport: { type: 'object', additionalProperties: true },
          nodes: { type: 'array', items: SNAPSHOT_NODE_SCHEMA },
          truncated: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => {
          const nodes = Array.isArray(v.nodes) ? v.nodes : []
          // 必须把 ref 行显式渲染出来（用户实报：只报计数时 click/type 完全不可用）。
          const blocks: Array<{ type: 'text'; text: string }> = [
            // title 此前 schema 已声明却从不渲染（G2a-4 实测命中）：模型看不到当前是哪一页。
            { type: 'text', text: '快照 ' + String(nodes.length) + ' 个可交互节点（' + String(v.url) + '，代次 ' + String(v.pageGeneration)
              + '）' + renderTitle(v) },
            { type: 'text', text: renderSnapshotNodes(nodes) },
          ]
          // 节点极少时给出**可执行的**下一步（0.14.0 模拟器实锤）。
          //
          // 现象：移动档下打开 B 站（m.bilibili.com），snapshot 只回 1-2 个节点，search 框之外什么都拿不到，
          // 于是 browser_click 无从下手，模型反复 snapshot/wait 直到放弃。
          // 真因**不是**选择器太窄（实测该站 1339 个元素里 cursor:pointer 为 0，内容是 JS 委托的非语义 div），
          // 而是站点按 UA 返回了非语义的移动版页面。换桌面身份档后同一 URL 直接给 135 个可交互节点。
          // 这个「换档」是模型自己推不出来的（它只看到「这页没元素」），必须在返回里点明。
          if (nodes.length <= 3) {
            blocks.push({ type: 'text', text:
              '可交互节点过少（' + String(nodes.length) + ' 个）：该站很可能按 UA 返回了非语义的移动版页面（内容用非语义 div + JS 事件委托，快照取不到）。'
              + '建议先 browser_set_identity { profile: "linux-desktop" } 再 browser_navigate 同一地址——实测同一页面可交互节点会从 1-2 个升到上百个。'
              + '若仍不足，用 browser_get_text 读正文或 browser_screenshot 看画面。' })
          }
          return blocks
        },
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { snapshot: true }, 15_000)
        if (!result.ok) return denied(result) as never
        const nodes = Array.isArray(result.data.nodes) ? (result.data.nodes as Payload[]) : []
        const refs = new Set<string>()
        for (const node of nodes) if (typeof node.ref === 'string') refs.add(node.ref)
        const tabId = typeof result.data.tabId === 'string' ? result.data.tabId : 'tab-1'
        const pageGeneration = pageGenerationOf(result.data)
        lastSnapshot = { tabId, pageGeneration, refs }
        return {
          ok: true,
          tabId,
          pageGeneration,
          surface: typeof result.data.surface === 'string' ? result.data.surface : 'browser',
          url: typeof result.data.url === 'string' ? result.data.url : '',
          title: typeof result.data.title === 'string' ? result.data.title : '',
          viewport: (result.data.viewport ?? {}) as Payload,
          nodes,
          truncated: result.data.truncated === true,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.click,
      description: '点击最近一次 snapshot 的 ref 指向的元素。必须与快照同页面代次；旧 ref/旧代次返回 stale-error，不做猜测性点击。',
      parameters: { ref: { type: 'string', required: true, description: '快照中的 ref（形如 bx12）' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          changed: { type: 'boolean' },
          pageGeneration: { type: 'number' },
          // N-14（issue #232 同族残留）：点击**会引发导航**（链接/按钮提交），回执必须能反映落点状态，
          // 否则「点完仍然是错误页」与「点完正常」在回执上长得一样。schema 不声明即被通用判据豁免——见 K-2。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '点击后页面失败 ' : '已点击 ') + String(v.url)
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async ({ ref }: { ref: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const memory = requireSnapshot()
        if (memory === undefined) {
          return { ok: false, error: 'snapshot-required', guidance: '先调用 browser_snapshot 拿到 ref，再点击；不猜测坐标。' } as never
        }
        audit(BROWSER_TOOLS.click, { ref }, true)
        const result = await call(BROWSER_OPS.input, { kind: 'tap', ref, pageGeneration: memory.pageGeneration }, 15_000)
        if (!result.ok) return denied(result) as never
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          changed: result.data.changed === true,
          pageGeneration: pageGenerationOf({ ...state, ...result.data }),
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          title: typeof state.title === 'string' ? state.title : '',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.type,
      description: '向最近一次 snapshot 的 ref 元素输入文本（默认替换原内容）。与 click 同一套 ref/代次校验。',
      parameters: {
        ref: { type: 'string', required: true, description: '快照中的 ref' },
        text: { type: 'string', required: true, description: '要输入的文本' },
        replace: { type: 'boolean', description: 'true（默认）替换原值；false 追加' },
      },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          value: { type: 'string' },
          pageGeneration: { type: 'number' },
          // N-14：输入同样可能引发导航（表单提交），与 click 同一判据。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        // url 此前 schema 已声明却从不渲染（G2a-4 实测命中）：输入后模型看不到页面是否被跳转
        // （表单提交类输入会引发导航），也就无法判断该不该重新 snapshot。
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '输入后页面失败 ' : '已输入文本 ') + '（当前值 ' + String(v.value).slice(0, 40)
          + (typeof v.url === 'string' && v.url !== '' ? '，当前页 ' + v.url : '') + '）'
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async ({ ref, text, replace }: { ref: string; text: string; replace?: boolean }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const memory = requireSnapshot()
        if (memory === undefined) {
          return { ok: false, error: 'snapshot-required', guidance: '先调用 browser_snapshot 拿到 ref，再输入。' } as never
        }
        audit(BROWSER_TOOLS.type, { ref, length: text.length }, true)
        const result = await call(BROWSER_OPS.input, {
          kind: 'text', ref, text, replace: replace !== false, pageGeneration: memory.pageGeneration,
        }, 15_000)
        if (!result.ok) return denied(result) as never
        const afterType = await stateOf()
        return {
          ok: true,
          url: typeof result.data.url === 'string' ? result.data.url : '',
          value: typeof result.data.value === 'string' ? result.data.value : '',
          pageGeneration: pageGenerationOf(result.data),
          loadState: typeof afterType.loadState === 'string' ? afterType.loadState : 'unknown',
          title: typeof afterType.title === 'string' ? afterType.title : '',
          ...(typeof afterType.reason === 'string' && afterType.reason !== '' ? { reason: afterType.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.press,
      description: '发送按键：Enter/Tab/Escape/Backspace/Delete/方向键/PageUp/PageDown/Home/End，或单个可打印字符（插入聚焦元素）。',
      parameters: { key: { type: 'string', required: true, description: '按键名或单个字符' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoBack: { type: 'boolean' },
          // N-14：Enter 会提交表单/触发导航，回执同样必须能反映落点状态。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '按键后页面失败 ' : '已发送按键 ') + String(v.url)
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async ({ key }: { key: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.press, { key }, true)
        const result = await call(BROWSER_OPS.input, { kind: 'key', key }, 10_000)
        if (!result.ok) return denied(result) as never
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          canGoBack: state.canGoBack === true,
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          title: typeof state.title === 'string' ? state.title : '',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.scroll,
      description: '滚动当前页面。返回滚动后的 scrollY 与是否到底；不改变页面代次。',
      parameters: {
        direction: { type: 'string', required: true, description: 'up | down | left | right' },
        amount: { type: 'number', description: '像素量（默认 600）' },
      },
      output: {
        schema: objectSchema({
          scrollY: { type: 'number' },
          atEnd: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: 'scrollY=' + String(v.scrollY) + (v.atEnd === true ? '（已到底）' : '') }],
      },
      execute: async ({ direction, amount }: { direction: string; amount?: number }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const step = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(1, Math.min(4000, Math.abs(amount))) : 600
        const dx = direction === 'left' ? -step : direction === 'right' ? step : 0
        const dy = direction === 'up' ? -step : direction === 'down' ? step : 0
        const expression = 'window.scrollBy(' + dx + ',' + dy + ');JSON.stringify({scrollY:window.scrollY,atEnd:(window.scrollY+(window.innerHeight||0))>=(document.documentElement.scrollHeight-2)})'
        const result = await call(BROWSER_OPS.js, { expr: expression }, 10_000)
        if (!result.ok) return denied(result) as never
        const payload = parseJsJson(result.data.value) ?? {}
        return { ok: true, scrollY: typeof payload.scrollY === 'number' ? payload.scrollY : 0, atEnd: payload.atEnd === true } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.getText,
      description: '读取当前页面的可见文本（可指定 CSS 像素矩形区域，取该点元素文本）。默认整页文本，超过 20000 字符截断。',
      parameters: {
        region: {
          type: 'object', additionalProperties: true,
          description: '{x,y,w,h}（CSS 像素；取区域中心元素的文本）',
        },
      },
      output: {
        schema: objectSchema({
          sourceUrl: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => {
          const text = String(v.text ?? '')
          if (text !== '') return [{ type: 'text', text: text.slice(0, 4000) }]
          // 空文本时不能再输出空字符串：模型看到空正文会以为「工具没返回」而放弃，
          // 而真实原因通常是「页面还没加载完 / 正文在 iframe 内 / 取错了区域」。
          return [{ type: 'text', text: '（页面可见文本为空。可能原因：页面尚未加载完、正文在 iframe 内，或 region 落点没有文本；'
            + '可先用 browser_snapshot 看可交互节点，或用 browser_wait 等页面稳定后重试。）' }]
        },
      },
      execute: async ({ region }: { region?: { x?: number; y?: number; w?: number; h?: number } }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const hasRegion = region !== undefined && typeof region.x === 'number' && typeof region.y === 'number'
        const cx = hasRegion ? Number(region!.x) + (typeof region!.w === 'number' ? Number(region!.w) / 2 : 0) : 0
        const cy = hasRegion ? Number(region!.y) + (typeof region!.h === 'number' ? Number(region!.h) / 2 : 0) : 0
        const expression = hasRegion
          ? '(function(){var el=document.elementFromPoint(' + cx + ',' + cy + ');var t=el?el.innerText:\'\';return JSON.stringify({text:String(t).slice(0,20000),url:location.href});})()'
          : '(function(){var body=document.body;var t=body?body.innerText:\'\';return JSON.stringify({text:String(t).slice(0,20000),url:location.href});})()'
        const result = await call(BROWSER_OPS.js, { expr: expression }, 10_000)
        if (!result.ok) return denied(result) as never
        const payload = parseJsJson(result.data.value) ?? {}
        const text = typeof payload.text === 'string' ? payload.text : ''
        return {
          ok: true,
          sourceUrl: typeof payload.url === 'string' ? payload.url : '',
          text,
          truncated: text.length >= 20000,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.wait,
      description: '等待页面条件：选择器出现（selector），或页面文本/地址稳定（stable，默认）。有超时上限，超时返回 ok=false + 原因。',
      parameters: {
        selector: { type: 'string', description: 'CSS 选择器；不传则等待页面稳定' },
        stable: { type: 'boolean', description: 'true 时等待文本长度与地址不再变化' },
        timeoutMs: { type: 'number', description: '超时（默认 8000，最大 20000）' },
      },
      output: {
        schema: objectSchema({
          waited: { type: 'number' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '等待结束：' + String(v.reason) + '（' + String(v.waited) + 'ms）' }],
      },
      execute: async ({ selector, stable, timeoutMs }: { selector?: string; stable?: boolean; timeoutMs?: number }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? Math.max(500, Math.min(20_000, timeoutMs)) : 8_000
        const started = Date.now()
        const wantStable = stable !== false && (selector === undefined || selector === '')
        let previous = ''
        let stableHits = 0
        while (Date.now() - started < budget) {
          if (!wantStable && selector !== undefined && selector !== '') {
            const expression = '(function(){return JSON.stringify({ready:!!document.querySelector(' + JSON.stringify(selector) + '),readyState:document.readyState,url:location.href});})()'
            const result = await call(BROWSER_OPS.js, { expr: expression }, 6_000)
            if (result.ok) {
              const payload = parseJsJson(result.data.value) ?? {}
              if (payload.ready === true) return { ok: true, waited: Date.now() - started, reason: 'selector-present' } as never
            }
          } else {
            const expression = '(function(){var b=document.body;return JSON.stringify({url:location.href,len:(b?b.innerText:\'\').length,readyState:document.readyState});})()'
            const result = await call(BROWSER_OPS.js, { expr: expression }, 6_000)
            if (result.ok) {
              const payload = parseJsJson(result.data.value) ?? {}
              const signature = String(payload.url ?? '') + '#' + String(payload.len ?? '') + '#' + String(payload.readyState ?? '')
              if (signature === previous && payload.readyState === 'complete') stableHits += 1
              else stableHits = 0
              previous = signature
              if (stableHits >= 2) return { ok: true, waited: Date.now() - started, reason: 'page-stable' } as never
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return { ok: false, waited: Date.now() - started, reason: wantStable ? 'stable-timeout' : 'selector-timeout' } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.navigate,
      description: '把当前浏览器工位导航到新的 http(s) 地址（沿用同一 WebView，与 browser_open 的准入规则一致）。',
      parameters: { url: { type: 'string', required: true, description: '要导航到的 http(s) 地址' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          title: { type: 'string' },
          // issue #232：本工具此前 schema 未声明 loadState、execute 未取、render 未渲染 ——
          // 三处全缺，比 issue 报告的 browser_open 更深一层，必须三处同批改（F4）。
          loadState: { type: 'string' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{
          type: 'text',
          text: (loadStateOf(v) === 'error' ? '导航失败 ' : '已导航 ') + String(v.url)
            + renderTitle(v) + renderLoadState(v),
        }],
      },
      execute: async ({ url }: { url: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.navigate, { url }, true)
        const result = await call(BROWSER_OPS.open, { url }, 20_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : url,
          title: typeof state.title === 'string' ? state.title : '',
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.back,
      description: '浏览器历史后退（仅能在准入过的页面间移动）。返回新地址与是否还能后退。',
      parameters: {},
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoBack: { type: 'boolean' },
          // issue #232 同族残留（本轮收口）：此前 schema **不声明 loadState** —— 于是「调用成功即回执成功」，
          // 与 browser_open 修复前的假回执同形（后退到的页面可能是错误页；壳侧 loadState 已是 'error'）。
          // 注意：schema 不声明该键时，通用判据会把它当「未声明字段」自动豁免 —— 这正是该缺陷族能存活的原因。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        // 回执按**真实 loadState** 判定（不再恒报「已后退」）：error 时给失败动词 + reason + 指引。
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '后退失败 ' : '已后退 ') + String(v.url)
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'history.back();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        await new Promise((resolve) => setTimeout(resolve, 400))
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          canGoBack: state.canGoBack === true,
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          title: typeof state.title === 'string' ? state.title : '',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.forward,
      description: '浏览器历史前进（仅能在准入过的页面间移动）。返回新地址与是否还能前进。',
      parameters: {},
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoForward: { type: 'boolean' },
          // 同 browser_back：schema 不声明 loadState 即被通用判据豁免，故必须一并声明（K-2 堵洞）。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '前进失败 ' : '已前进 ') + String(v.url)
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'history.forward();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        await new Promise((resolve) => setTimeout(resolve, 400))
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          canGoForward: state.canGoForward === true,
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          title: typeof state.title === 'string' ? state.title : '',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.reload,
      description: '重新加载当前页面；页面代次会递增，旧快照 ref 随即失效。',
      parameters: {},
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          // 同 browser_back：重载可能落到错误页，回执必须能反映（schema 声明是前提，否则被豁免）。
          loadState: { type: 'string' },
          title: { type: 'string' },
          reason: { type: 'string' },
        }),
        // 措辞刻意区分「已请求」与「已加载完成」：重载是异步的，回执只能反映**此刻**的 loadState。
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: (loadStateOf(v) === 'error' ? '重载失败 ' : '已请求重载 ') + String(v.url)
          + renderTitle(v) + renderLoadState(v) }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'location.reload();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          loadState: typeof state.loadState === 'string' ? state.loadState : 'unknown',
          title: typeof state.title === 'string' ? state.title : '',
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.listTabs,
      description: '列出当前打开的全部网页（多页签）。返回每页的 tabId / url / title / 是否活动页。'
        + 'AI 可以同时控制多个网页：用 tabId 指定目标页做 snapshot/click/type 等动作。',
      parameters: {},
      output: {
        schema: objectSchema({
          tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          activeTabId: { type: 'string' },
          tabCount: { type: 'number' },
        }),
        // issue #232 P1：此前只回「N 个网页（活动 tab-X）」，模型看不到任何 url/title。
        // 壳侧 tabSummaries() 五字段齐全，故逐页渲染即可（无需改壳侧）。
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: renderTabLines(v) }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'browser-not-authorized', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.tabs, {}, 8_000)
        if (!result.ok) return denied(result) as never
        const tabs = Array.isArray(result.data.tabs) ? (result.data.tabs as Payload[]) : []
        return {
          ok: true,
          tabs,
          activeTabId: typeof result.data.activeTabId === 'string' ? result.data.activeTabId : '',
          tabCount: tabs.length,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.followTab,
      description: '把指定网页设为活动页（不新建、不销毁）。目标页的后续动作与快照都作用于它。',
      parameters: { tabId: { type: 'string', required: true, description: '要切换到的网页 tabId（见 browser_list_tabs）' } },
      output: {
        schema: objectSchema({
          activeTabId: { type: 'string' },
          url: { type: 'string' },
          tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        // issue #232 P1：此前只回「已切到 tab-X」，目标页的 url/title/loadState 全部不可达
        // （execute 明明已返回 url + tabs）。现在按目标页如实回执。
        render: (_args: unknown, v: Record<string, unknown>) => {
          const target = (Array.isArray(v.tabs) ? (v.tabs as unknown[]) : [])
            .find((t) => t !== null && typeof t === 'object' && (t as Record<string, unknown>).tabId === v.activeTabId)
          return [{ type: 'text', text: '已切到 ' + String(v.activeTabId)
            + (target === undefined ? '（壳侧未回该页摘要，可 browser_list_tabs 复核）'
              : '：' + renderTabLine(target, String(v.activeTabId)))
            + '\n' + renderTabLines(v) }]
        },
      },
      execute: async ({ tabId }: { tabId: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'browser-not-authorized', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.followTab, { tabId }, 8_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          activeTabId: typeof result.data.activeTabId === 'string' ? result.data.activeTabId : tabId,
          url: typeof result.data.url === 'string' ? result.data.url : '',
          tabs: Array.isArray(result.data.tabs) ? result.data.tabs : [],
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.closeTab,
      description: '关闭指定网页并销毁它的页面进程（不保留状态；其它页不受影响）。'
        + '省略 tabId 时关闭当前活动页；关闭最后一页等价于关闭整个浏览器工作台。',
      parameters: { tabId: { type: 'string', description: '要关闭的 tabId（省略 = 当前活动页）' } },
      output: {
        schema: objectSchema({
          closedTabId: { type: 'string' },
          activeTabId: { type: 'string' },
          tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        // 同族形态（详档 §9.3 `:738-750` 已点名，本次一并收口）：此前只回「已关闭 tab-X（剩 N 个网页）」，
        // 剩余页的 url/title/loadState 不可达；execute 已返回 tabs，逐页渲染即可。
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '已关闭 ' + String(v.closedTabId) + '\n' + renderTabLines(v) }],
      },
      execute: async ({ tabId }: { tabId?: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'browser-not-authorized', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.closeTab, tabId === undefined ? {} : { tabId }, 8_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          closedTabId: typeof result.data.closedTabId === 'string' ? result.data.closedTabId : '',
          activeTabId: typeof result.data.activeTabId === 'string' ? result.data.activeTabId : '',
          tabs: Array.isArray(result.data.tabs) ? result.data.tabs : [],
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.setIdentity,
      description: '切换浏览器身份档（android-real 默认真实身份 / linux-desktop / windows-desktop）。'
        + '身份切换后重新加载当前页面并递增页面代次；本机未编入 UA-CH 覆写，只改 UA 串（返回 degraded 说明）。'
        + '不承诺规避反爬或站点风控。',
      parameters: { profile: { type: 'string', required: true, description: '身份档 id' } },
      output: {
        schema: objectSchema({
          profile: { type: 'string' },
          uaChApplied: { type: 'boolean' },
          degraded: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '身份档 ' + String(v.profile) + (v.uaChApplied === true ? '' : '（UA 串模式）') }],
      },
      execute: async ({ profile }: { profile: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const selected = IDENTITY_PROFILES.find((p) => p.id === profile)
        if (selected === undefined) {
          return { ok: false, error: 'unknown-identity', guidance: '可用身份：' + IDENTITY_PROFILES.map((p) => p.id).join(', ') } as never
        }
        audit(BROWSER_TOOLS.setIdentity, { profile }, true)
        const result = await call(BROWSER_OPS.setUa, {
          profile: selected.id, ua: selected.ua, platform: selected.platform, mobile: selected.mobile,
        }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          profile: selected.id,
          uaChApplied: result.data.uaChApplied === true,
          ...(typeof result.data.degraded === 'string' ? { degraded: result.data.degraded } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.setViewport,
      description: '切换浏览器呈现分辨率（letterbox 到舞台内，不做坐标缩放）。档位表见 panelStatus.viewportPresets；'
        + 'device = 跟随工位实际尺寸。切换后建议重新 snapshot（布局变化可能改变 ref 位置）。',
      parameters: {
        preset: { type: 'string', required: true, description: '视口档 id（device / phone-portrait / tablet / …）' },
        fit: { type: 'string', description: 'fit（默认，等比缩入舞台）| one-to-one（1:1，超出裁掉）' },
      },
      output: {
        schema: objectSchema({
          preset: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          route: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '视口 ' + String(v.preset) + '（' + String(v.width) + '×' + String(v.height) + '）' }],
      },
      execute: async ({ preset, fit }: { preset: string; fit?: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const selected = VIEWPORT_PRESETS.find((p) => p.id === preset || (preset === 'follow-screen' && p.id === 'device'))
        if (selected === undefined) {
          return { ok: false, error: 'unknown-viewport', guidance: '可用视口：' + VIEWPORT_PRESETS.map((p) => p.id).join(', ') } as never
        }
        audit(BROWSER_TOOLS.setViewport, { preset, fit }, true)
        const result = await call(BROWSER_OPS.viewport, {
          preset: selected.id, route: 'S2', width: selected.width, height: selected.height,
        }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          preset: selected.id,
          width: typeof result.data.width === 'number' ? result.data.width : selected.width,
          height: typeof result.data.height === 'number' ? result.data.height : selected.height,
          route: typeof result.data.route === 'string' ? result.data.route : 'S2',
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.screenshot,
      description: '对浏览器工位实际画面矩形截图（不包含舞台留黑）。返回引擎可读的私有路径与字节数；截图落在应用私有目录，工具层读完即删。',
      parameters: { inline: { type: 'boolean', description: '保留参数；当前返回路径而不内联像素（避免大图进上下文）' } },
      output: {
        schema: objectSchema({
          path: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          health: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => {
          const path = typeof v.path === 'string' ? v.path : ''
          // N-14：旧回执在 path 为空时仍渲染「截图已保存：」——把「没有文件」说成已保存
          // （与 issue #232「回执与事实相反」同形）。
          if (path === '') {
            return [{ type: 'text', text: '截图失败：壳侧未返回文件路径（' + String(v.health ?? 'unknown') + '）' }]
          }
          const health = typeof v.health === 'string' && v.health !== '' ? v.health : 'unknown'
          return [{ type: 'text', text: (health === 'ok' ? '截图已保存：' : '截图已保存（健康度 ' + health + '，画面可能不完整）：') + path }]
        },
      },
      execute: async ({ inline }: { inline?: boolean }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.screenshot, { inline: inline === true }, true)
        const result = await call(BROWSER_OPS.shot, { inline: inline === true }, 15_000)
        if (!result.ok) return denied(result) as never
        return {
          ok: true,
          path: typeof result.data.path === 'string' ? result.data.path : '',
          bytes: typeof result.data.bytes === 'number' ? result.data.bytes : 0,
          width: typeof result.data.width === 'number' ? result.data.width : 0,
          height: typeof result.data.height === 'number' ? result.data.height : 0,
          // 缺失 health 时回落 'unknown' 而**不是** 'ok'：壳侧从未产生 'ok' 以外的值时，
          // 旧写法等于把「没测过」伪造成「测过且正常」（审查 R7 的同族形态）。
          health: typeof result.data.health === 'string' && result.data.health !== '' ? result.data.health : 'unknown',
        } as never
      },
    }),
  ]

  // 档位工具（android_browser_tier）由 index.ts 注册（依赖 index 的 tier 报告）；这里只补动作工具面。
  return tools.map(withFailureText)
}
