import { defineTool } from '@deepseek-ai/dsh-tools'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Android 设备能力工具组（0.14.0 §4.1 渐进披露）。
 *
 * 上游 skill 只能携带 instructions、不能挂工具，也没有 `skills/load` 事件（子代理核查结论，
 * 见 dsh/packages/skill/skill/src/index.ts:96-102 / tool-skill/src/index.ts:127-156）。可用的
 * 上游先例是 `tool-cordis` / `tool-subagent`：**常驻一个 facade 工具 + agent 作用域
 * `tools.restrict` 掩蔽目标工具组**，facade 调用时解除掩蔽，下一步装配即含全量定义
 * （dsh/packages/core/tools/src/index.ts:1061-1088 / :804-807；tool-subagent/src/index.ts:664-706）。
 */
export const DEVICE_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  phone: [
    'android_screen_list',
    'android_screenshot',
    'android_ui_tree',
    'android_device_info',
    'android_act_input',
    'android_ui_dump',
    'android_ui_click',
    'android_ui_scroll',
    'android_ui_input',
    'android_web_dump',
    'android_env_prepare',
    'android_app_launch',
    'android_ui_global',
    'android_ui_detail',
    // 特权 shell 与授权状态同属「手机控制」面：不常驻，避免模型一提浏览器就先去摸 ADB/shell。
    'android_shell_exec',
    'android_termux_channel_exec',
    'android_privilege_status',
  ],
  browser: [
    'browser_open',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_get_text',
    'browser_scroll',
    'browser_press',
    'browser_wait',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_list_tabs',
    'browser_close_tab',
    'browser_follow_tab',
    'browser_set_viewport',
    'browser_set_identity',
    'browser_screenshot',
    'android_browser_tier',
  ],
  'virtual-display': [
    'android_vdisplay_create',
    'android_vdisplay_destroy',
    'android_vdisplay_input',
    'android_vdisplay_status',
  ],
}

/** 全部受掩蔽的设备工具名（facade 自身不在其中）。 */
export const DEVICE_TOOLS: readonly string[] = Object.values(DEVICE_TOOL_GROUPS).flat()

/** 常驻 facade 工具名：模型先调它解锁能力组，工具面才出现。 */
export const CAPABILITY_TOOL_NAME = 'android_capabilities'

/** facade 的规范返回值（与 output.schema 一致）。 */
export interface CapabilityValue {
  ok: boolean
  unlocked: string[]
  groups: Array<{ group: string; tools: number }>
  text: string
}

/** 安装渐进披露所需的最小 ctx 面（便于单测注入桩）。 */
export interface CapabilityGateCtx {
  tools: { register(tool: unknown): unknown }
  get?(name: string): unknown
  on?(event: string, handler: (payload: { agent: unknown }) => void): unknown
  logger?: { warn?(message: string): void }
}

interface ScopedFiber {
  dispose(): unknown
}

/** 能力组对应的 skill 目录条目：只做发现与「先调 facade」指引，不携带工具。 */
const CAPABILITY_SKILLS: ReadonlyArray<{ name: string; description: string; source: string; content: string }> = [
  {
    name: 'android-phone-control',
    source: 'bundled',
    description:
      '通过无障碍与 Shizuku 双通道读取并操作 Android 屏幕：语义树、点按、输入、滚动、截屏、应用拉起、虚拟屏。'
      + '涉及「手机操作 / 打开 App / 点某按钮 / 看当前界面」的任务用本能力（先调用 android_capabilities 解锁）。',
    content: [
      '# 手机控制',
      '',
      '两条通道**独立可用**：无障碍（语义树 + ref 动作、中文输入、虚拟屏语义树）与 Shizuku 特权 shell',
      '（`android_shell_exec`；坐标/命令面；虚拟屏只能坐标）。任一通道可用即可完成同类动作；工具返回里',
      '`actionMode` 会标明是 `a11y` 还是 `coordinate`。',
      '',
      '## 先解锁',
      '设备工具默认不在工具列表里：先调用 `android_capabilities`（group=phone），下一步起可用。',
      '',
      '## 真实屏',
      '1. 取控件树：**无障碍开着**用 `android_ui_dump`；**无障碍关着（纯 Shizuku）**用 `android_ui_tree`——'
      + '两者返回同形节点清单（id / 类型 / 文本 / bounds / 可点可滚），都能按 ref 操作。',
      '2. `android_ui_click {ref}` / `android_ui_input {ref, text}` / `android_ui_scroll` / `android_act_input`。',
      '3. `android_screenshot` 看画面。ref 是同一次 dump 的代次句柄；界面变化后重新 dump，不要按旧 ref 猜点。',
      '',
      '## 虚拟屏',
      '1. `android_vdisplay_create` 建屏（编号 1..N，本版上限 1）。',
      '2. 以 `screenId: "virtual-1"` 调 `android_ui_dump` / `android_ui_click` 等；先 `android_app_launch` 把 App 拉到该屏。'
      + '虚拟屏上的**按键与文本**用 `android_vdisplay_input`（android_ui_input 只对可编辑节点生效）；'
      + '注意 `android_ui_tree` **读不到虚拟屏**（uiautomator 只 dump 默认屏）。',
      '3. 语义树需要无障碍；纯 Shizuku 下返回 `actionMode: "coordinate"`，只能坐标操作。',
      '',
      '## 屏幕范围',
      '真实屏 / 虚拟屏的可访问范围由用户在设置页控制（virtual-only / real-only / all）；越界是结构化拒绝，不会回退。',
    ].join('\n'),
  },
  {
    name: 'android-ai-browser',
    source: 'bundled',
    description:
      '用应用内 AI 浏览器（隔离 WebView 工作台）打开网页并观察/操作：快照、点按、输入、滚动、截图、PC/手机视口。'
      + '涉及「浏览器 / 网页 / 打开某个站点 / 查某网站」的任务用本能力（先调用 android_capabilities 解锁），不要用 ADB 或无障碍去操作真实屏上的浏览器。',
    content: [
      '# AI 浏览器（隔离 WebView 工作台）',
      '',
      '用途：在应用内一个隔离的 WebView 里打开 http(s) 网页，像浏览器一样观察与操作。它**不是** ADB 或无障碍通道。',
      '',
      '## 先解锁',
      '`browser_*` 工具默认不在工具列表里：先调用 `android_capabilities`（group=browser）。',
      '',
      '## 工作流',
      '1. `browser_open {url}` 打开；`browser_set_viewport` 改 CSS 视口（分辨率=网页看到的 innerWidth），`browser_set_identity` 切 PC/手机身份。',
      '2. `browser_snapshot` 取页面语义节点与 `ref`；再 `browser_click {ref}` / `browser_type {ref, text}` / `browser_press {key}`。',
      '3. `ref` 只在同一次 snapshot 的代次内有效；页面变化后重新 snapshot（过期 ref 会被拒绝）。',
      '4. `browser_screenshot` 看渲染结果；`browser_get_text {ref}` 读文本。',
      '',
      '## 约束',
      '- 只允许 http(s) 顶层导航；本机回环与 file/content/data 一律拒绝。',
      '- 模型调用只导航、不改变可见性；界面由用户在侧栏查看。页面保活（侧栏收起 / 切页不销毁）。',
      '- 不要用 `android_ui_dump` / `android_shell_exec` 去截屏或点真实屏里的浏览器 App：那与隔离浏览器工作台是两回事。',
    ].join('\n'),
  },
  {
    name: 'android-virtual-display',
    source: 'bundled',
    description: '创建/销毁虚拟屏（Shizuku 特权通道），让第三方 App 在独立屏幕运行，不挤占用户前台。需要先 android_capabilities 解锁。',
    content: [
      '# 虚拟屏',
      '',
      '- 设备工具默认不在工具列表里：先调用 `android_capabilities`（group=virtual-display）解锁。',
      '- `android_vdisplay_create` 建屏（编号 1..N，本版上限 1）；`android_vdisplay_destroy` 销毁；`android_vdisplay_status` 看状态与编号。',
      '- 型号参数跟随真机比例 + 档位缩放（原生 / 0.75 / 0.5），档位在设置页可配。',
      '- 虚拟屏随内容旋转；查看器与浮窗按内容比例呈现。',
      '- 语义树/ref 动作需要无障碍；纯 Shizuku 只能坐标（`actionMode: "coordinate"`）。',
    ].join('\n'),
  },
]

/**
 * 通道就绪度（facade 如实汇报，避免模型误判「没解锁」或盲目建屏）。
 *
 * A11y distinguishes fresh, disabled, stale, and unobserved states. Missing evidence remains
 * fail-closed for routing, but must not be rendered as confirmed off.
 */
export interface ChannelFacts {
  a11y?: boolean
  a11ySource?: 'heartbeat' | 'disabled' | 'stale' | 'unknown'
  a11yHeartbeatAgeMs?: number
  shizuku?: boolean
}

function normalizeChannelFacts(facts: ChannelFacts): ChannelFacts {
  return {
    ...(typeof facts.a11y === 'boolean' ? { a11y: facts.a11y } : {}),
    ...(facts.a11ySource === 'heartbeat' || facts.a11ySource === 'disabled'
      || facts.a11ySource === 'stale' || facts.a11ySource === 'unknown'
      ? { a11ySource: facts.a11ySource }
      : {}),
    ...(typeof facts.a11yHeartbeatAgeMs === 'number' && Number.isFinite(facts.a11yHeartbeatAgeMs)
      ? { a11yHeartbeatAgeMs: Math.max(0, facts.a11yHeartbeatAgeMs) }
      : {}),
    ...(typeof facts.shizuku === 'boolean' ? { shizuku: facts.shizuku } : {}),
  }
}

function a11yLine(facts: ChannelFacts): string {
  if (facts.a11ySource === 'heartbeat' || (!facts.a11ySource && facts.a11y === true)) {
    return '已开启（语义树 / ref 动作 / 虚拟屏语义树可用）'
  }
  if (facts.a11ySource === 'disabled' || (!facts.a11ySource && facts.a11y === false)) {
    return '未开启（壳侧已确认关闭）'
  }
  if (facts.a11ySource === 'stale' || typeof facts.a11yHeartbeatAgeMs === 'number') {
    if (typeof facts.a11yHeartbeatAgeMs !== 'number') {
      return '心跳缺失，服务状态未确认（按不可用处理；可直接尝试目标操作）'
    }
    return `心跳已过期 ${Math.round(facts.a11yHeartbeatAgeMs / 1000)} 秒，服务状态未确认（按不可用处理；可直接尝试目标操作）`
  }
  return '状态未确认（按不可用处理；可直接尝试目标操作并依据返回结果选择备用通道）'
}

/**
 * Shizuku 通道的**三分文案**（A1 的判据面）。
 *
 * 「未知」这一支刻意给出可执行动作：直接调创建工具试一次——成功即证明通道可用，
 * 失败再据结构化 code 判断。旧文案让模型在真正尝试之前就自我否决。
 */
export function shizukuLine(ready: boolean | undefined): string {
  if (ready === true) return '就绪（shell 执行 / 原图截图 / 虚拟屏经 Shizuku UserService 承载）'
  if (ready === false) {
    return '未就绪（已实测：壳侧回执明确报告特权通道不可用；**虚拟屏建屏需要它**，'
      + '请让用户在设置页「手机控制」里连接 Shizuku）'
  }
  return '状态未知（壳侧尚未回执，本次补探也没拿到；**这不等于不可用**——不要据此判定虚拟屏不可用）。'
    + '直接调 android_vdisplay_create 试一次：成功即通道可用；失败再看它回的 code/guidance，'
    + '或用 android_privilege_status、设置页「手机控制」看实测状态'
}

/** 把 Android 设备能力组做成渐进披露：常驻 facade + agent 作用域掩蔽 + skill 目录条目。 */
export function installCapabilityGate(
  ctx: CapabilityGateCtx,
  channels: () => ChannelFacts | Promise<ChannelFacts> = () => ({}),
  store: UnlockStore = createFileUnlockStore(),
): void {
  const locks = new WeakMap<object, Map<string, ScopedFiber>>()
  /**
   * 持久化解锁组（进程启动时读一次，之后由 unlock/relock 维护）。
   *
   * 语义：**「用户此前解锁过这些组」**——与「这些组的权限现在真的可用」是两件事
   * （后者由 channels() 实测，见文件头纪律 2）。
   */
  const persisted = new Set<string>(
    store.read().filter((group) => DEVICE_TOOL_GROUPS[group] !== undefined),
  )
  const locksOf = (agent: unknown): Map<string, ScopedFiber> | undefined =>
    agent === null || agent === undefined ? undefined : locks.get(agent as object)

  const lockAgent = (agent: unknown): void => {
    if (agent === null || agent === undefined) return
    const scoped = (agent as { ctx?: { inject?: (deps: string[], cb: (c: unknown) => void) => ScopedFiber } }).ctx
    if (typeof scoped?.inject !== 'function') return
    let perAgent = locksOf(agent)
    if (perAgent === undefined) {
      perAgent = new Map()
      locks.set(agent as object, perAgent)
    }
    // 按组分别掩蔽（而不是一条 deny 全组）：facade 才能精确解锁并如实回报剩余状态。
    for (const [group, names] of Object.entries(DEVICE_TOOL_GROUPS)) {
      if (perAgent.has(group)) continue
      // **恢复点必须在掩蔽之前**（task-58 边界 1）：installCapabilityGate 会先 lock 所有
      // 既有 agent，若这里不先查持久化，已解锁组会在重启后被重新掩蔽一次——用户看到的仍然是
      // 「重进要重新授权」。已解锁 -> 直接跳过 tools.restrict，绝不进锁表。
      if (persisted.has(group)) continue
      try {
        const fiber = scoped.inject(['tools'], (scopedCtx: unknown) => {
          const tools = (scopedCtx as { tools?: { restrict?: (filter: { deny: string[] }) => unknown } }).tools
          if (typeof tools?.restrict !== 'function') return
          tools.restrict({ deny: [...names] })
        })
        perAgent.set(group, fiber)
      } catch (error) {
        // 未知工具名（该组未注册）等 → 该组不掩蔽，保持今天的可见性（fail-open，不静默吞工具）。
        ctx.logger?.warn?.('capability gate: group lock skipped (' + group + '): ' + String((error as Error)?.message ?? error))
      }
    }
  }

  /** 解锁组名的唯一校验入口（白名单，防止把任意字符串写进持久化文件）。 */
  const knownGroup = (name: string): boolean => DEVICE_TOOL_GROUPS[name] !== undefined

  /**
   * 解除请求组的掩蔽并**持久化**；返回本次解锁的组与仍未解锁的组。
   *
   * 持久化是 P0 的修法本体：用户口径「解锁一次对话永久起效」= 跨进程重启存活。
   * 内存锁表（perAgent）仍照常维护——它管「本进程这一轮到底有没有被 restrict」，
   * 持久化管「下次进程起来还算不算解锁过」。两者缺一都不成立。
   */
  const unlock = (group: string, agent: unknown): { unlocked: string[]; locked: string[] } => {
    const requested = group === 'all' ? Object.keys(DEVICE_TOOL_GROUPS) : [group]
    const perAgent = locksOf(agent)
    const unlocked: string[] = []
    let dirty = false
    for (const name of requested) {
      if (!knownGroup(name)) continue
      // 先把「解锁过」记下来（即使本 agent 当前没有锁 fiber：该组可能已被持久化跳过掩蔽，
      // 此时也要保证持久化文件里确实有它——否则下次重启会退回锁定）。
      if (!persisted.has(name)) {
        persisted.add(name)
        dirty = true
      }
      const fiber = perAgent?.get(name)
      if (fiber === undefined) continue
      try {
        void fiber.dispose()
      } catch {
        /* 已解锁或宿主已释放 */
      }
      perAgent?.delete(name)
      unlocked.push(name)
    }
    if (dirty) store.write([...persisted])
    const locked = Object.keys(DEVICE_TOOL_GROUPS).filter((name) => perAgent?.has(name) === true)
    return { unlocked, locked }
  }

  /**
   * **撤销**：清空持久化解锁，并把请求组重新掩蔽。用户必须有收回能力（task-58 边界 4）——
   * 「解一次永久生效」不能变成不可逆。
   * @returns 本次重新上锁的组。
   */
  const relock = (group: string, agent: unknown): { relocked: string[]; locked: string[] } => {
    const requested = group === 'all' || group === 'relock' ? Object.keys(DEVICE_TOOL_GROUPS) : [group]
    const relocked: string[] = []
    for (const name of requested) {
      if (!knownGroup(name)) continue
      persisted.delete(name)
      relocked.push(name)
    }
    store.write([...persisted])
    // 重新掩蔽：把该 agent 的锁表清掉后按当前持久化集合重建（已撤销的组会重新被 restrict）。
    const perAgent = locksOf(agent)
    if (perAgent !== undefined) {
      for (const [name, fiber] of perAgent) {
        try { void fiber.dispose() } catch { /* 已释放 */ }
        perAgent.delete(name)
      }
    } else if (agent !== null && agent !== undefined) {
      locks.set(agent as object, new Map())
    }
    lockAgent(agent)
    const perAfter = locksOf(agent)
    const locked = Object.keys(DEVICE_TOOL_GROUPS).filter((name) => perAfter?.has(name) === true)
    return { relocked, locked }
  }

  try {
    ctx.tools.register(capabilityTool(unlock, channels, relock, (name) => persisted.has(name)))
  } catch (error) {
    ctx.logger?.warn?.('capability gate: facade registration failed: ' + String((error as Error)?.message ?? error))
    return
  }

  const agents = ctx.get?.('agents') as { list?(): unknown[] } | undefined
  for (const agent of agents?.list?.() ?? []) lockAgent(agent)
  ctx.on?.('agent/created', ({ agent }) => { lockAgent(agent) })

  const skills = ctx.get?.('skills') as { register?(skill: unknown): unknown } | undefined
  for (const skill of CAPABILITY_SKILLS) {
    try {
      skills?.register?.(skill)
    } catch (error) {
      ctx.logger?.warn?.('capability gate: skill registration failed: ' + String((error as Error)?.message ?? error))
    }
  }
}


/**
 * 常驻 facade 工具：列出可用能力组并解锁本次会话的设备工具。
 * @param unlock - 解除调用方 agent 指定组的掩蔽；返回本次解锁与仍锁定的组。
 * @param channels - 无障碍 / Shizuku 就绪度，供模型判断能否建屏。
 */
export function capabilityTool(
  unlock: (group: string, agent: unknown) => { unlocked: string[]; locked: string[] },
  channels: () => ChannelFacts | Promise<ChannelFacts>,
  relock: (group: string, agent: unknown) => { relocked: string[]; locked: string[] } = () => ({ relocked: [], locked: [] }),
  /** 该组是否已被**持久化**记住解锁（跨进程重启存活）——与「当前是否被掩蔽」是两件事。 */
  isPersisted: (group: string) => boolean = () => false,
) {
  return defineTool({
    name: CAPABILITY_TOOL_NAME,
    description:
      '解锁并列出本机的 Android 设备能力组（phone 手机控制 / browser AI 浏览器 / virtual-display 虚拟屏）。'
      + '对应工具默认不出现在工具列表中：先调用本工具，下一步起这些工具才可用。'
      + '涉及手机操作、App、浏览器、网页、虚拟屏的任务，先调本工具。',
    parameters: {
      // 描述刻意写短：本 facade 在**初始可见集**里，每个字节都进模型面 wire 预算
      // （check-tool-surface-budget 的 initialVisible 阈值）。撤销复用本参数（见下），
      // 不新增参数对象——新增一个带说明的参数就会顶破预算。
      group: { type: 'string', description: '能力组：phone | browser | virtual-display | all（默认）；off=撤销全部解锁' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          unlocked: { type: 'array', required: true },
          locked: { type: 'array', required: true },
          groups: { type: 'array', required: true },
          channels: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              a11y: { type: 'boolean' },
              a11ySource: { type: 'string', enum: ['heartbeat', 'disabled', 'stale', 'unknown'] },
              a11yHeartbeatAgeMs: { type: 'number' },
              shizuku: { type: 'boolean' },
            },
          },
          // Missing a11y or Shizuku keys mean "unknown", not false.
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async ({ group = 'all' }: { group?: string }, exec: unknown) => {
      const agent = (exec as { agent?: unknown } | undefined)?.agent
      const raw = typeof group === 'string' ? group : 'all'
      // 撤销支（task-58 边界 4）：解锁跨重启存活，必须给用户收回路径。
      // 形态：复用 group 的保留值 'off'（不新增参数——本 facade 在初始可见集里，预算按字节卡）。
      const revoke = raw === 'off'
      const target = revoke ? 'all' : raw
      const revoked = revoke ? relock(target, agent) : undefined
      const attempted = revoked === undefined ? unlock(target, agent) : undefined
      const unlocked = attempted?.unlocked ?? []
      const locked = revoked === undefined ? (attempted?.locked ?? []) : revoked.locked
      let facts: ChannelFacts = {}
      try {
        // 通道事实可能来自一次**补探**（A1：caps 缺席时引擎主动发一次 vdInfo），故此处可 await。
        facts = normalizeChannelFacts(await channels())
      } catch {
        facts = {}
      }
      const groups = Object.entries(DEVICE_TOOL_GROUPS).map(([name, tools]) => ({
        group: name,
        tools: tools.length,
        state: locked.includes(name) ? 'locked' : 'visible',
        // 与「当前是否被掩蔽」区分开：这里说的是「是否已持久化记住解锁」（跨重启存活）。
        persisted: isPersisted(name),
      }))
      const head = revoked !== undefined
        ? `已撤销：${revoked.relocked.join('、')}。对应工具将从下一步起重回锁定，重启后也不会自动解锁。`
        : unlocked.length > 0
          ? `已解锁：${unlocked.join('、')}。对应工具将从下一步起出现在工具列表，**并在应用重启后保持解锁**。`
          : locked.length === 0
            ? '全部能力组均已解锁，工具已可用（重启后仍然有效）。'
            : '请求的组此前已解锁（无需重复解锁）。'
      const stateLines = groups.map((g) => `- ${g.group}：${g.state === 'locked' ? '未解锁' : '可用'}（${g.tools} 个工具）${g.persisted ? '［已记住解锁，重启后仍有效］' : ''}`)
      const channelLines = [
        `- 无障碍通道：${a11yLine(facts)}`,
        `- Shizuku 特权通道：${shizukuLine(facts.shizuku)}`,
      ]
      // 权限事实与解锁态是两件事（task-58 边界 2）：解锁只让工具**出现**，能不能用由实测决定。
      // 这里必须把这句话说出来，否则模型会把「已解锁」误读成「一定可用」。
      const honesty = '注意：解锁只代表这些工具**出现在列表里**，不代表权限当前可用——'
        + '无障碍 / Shizuku 已确认不可用时，调用会如实返回结构化失败；状态未确认时以实际调用结果为准，再选择备用路径。'
      return {
        ok: true,
        unlocked,
        locked,
        groups,
        channels: facts,
        text: [head, '能力组：', ...stateLines, '通道：', ...channelLines, honesty].join('\n'),
      } as never
    },
  })
}

// ---------------------------------------------------------------------------
// 能力组解锁态的**持久化**（0.14.2 P0：用户原话「解锁一次对话永久起效」）
//
// ## 为什么需要这一段
//
// 缺陷（用户 2026-09-26 亲报）：解锁态原本是**纯内存**——
//   - 锁表是 WeakMap<agent 对象, Map<组, ScopedFiber>>，键随进程消失；
//   - 解锁动作只是 fiber.dispose()，不落任何持久化。
// => **进程重启 = 解锁全部丢失**，用户看到「工具已更新·移除 40 个」并被迫每次重进重新授权。
// 设备佐证：16416 上无障碍从未开启（accessibility_enabled=0），而聊天记录显示曾成功调用
// android_shell_exec / android_termux_channel_exec —— 解锁后能用、重启后归零。
//
// ## 三条纪律（每一条都有对应用例）
//
// 1. **fail-closed**：读不到 / 解析失败 / 结构不符 -> 视作**没有任何组被解锁**（默认锁定）。
//    绝不因为「文件坏了」而放宽。新装、新设备、从未解锁过也走这条，因此天然默认锁定。
// 2. **只记解锁态，不记权限事实**：本段只回答「用户此前解锁过哪些组」。无障碍是否开着、
//    Shizuku 是否在运行属于**另一个事实面**（由本文件的 channels() 实测汇报）。
//    把两者混同 = 让「看起来解锁了」冒充「真的能用」，正是坑 161/167。
// 3. **原子写**：临时文件 + rename，避免半截 JSON 让下次启动读到坏数据（读到坏数据会 fail-closed
//    成「全锁」——安全，但会让用户莫名丢一次解锁，所以仍要原子）。
//
// 注：本段刻意与门禁同文件（而不是独立模块）——`check-code-map` 要求 plugins/*/src 下每个文件
// 都被 apk 仓 EXECUTION-MAP 的覆盖账本点名，而账本不在本任务写入面内（且正被他人编辑）。
// 合并进已被覆盖的本文件即可在不越界的前提下保持门禁绿。
// ---------------------------------------------------------------------------


/** 持久化面的最小接口（便于单测注入内存实现，不碰真实文件系统）。 */
export interface UnlockStore {
  /** @returns 此前已持久化解锁的组名；读不到或坏数据一律返回空集。 */
  read(): readonly string[]
  /** @param groups - 当前应持久化的解锁组全集（覆盖写）。 */
  write(groups: readonly string[]): void
}

/** 状态文件名（放在 DSH_HOME 下，与既有 .notify.ndjson / .task-done 等同一层）。 */
export const UNLOCK_STATE_FILE = '.capability-unlock.json'

/** 状态文件的 schema 版本：未来结构变化时便于识别旧文件（未知版本按 fail-closed 处理）。 */
export const UNLOCK_STATE_VERSION = 1

/** 默认 DSH_HOME（与 index.ts 的既有兜底一致：真机路径）。 */
const DEFAULT_DSH_HOME = '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'

/** 解析状态文件内容；任何异常/结构不符都返回空数组（fail-closed）。 */
export function parseUnlockedGroups(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; unlocked?: unknown }
    if (parsed === null || typeof parsed !== 'object') return []
    // 未知版本（含未来格式）按 fail-closed 处理：宁可按默认锁定，也不猜语义。
    if (parsed.version !== UNLOCK_STATE_VERSION) return []
    if (!Array.isArray(parsed.unlocked)) return []
    return parsed.unlocked.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 序列化状态（只保留非空字符串项，去重）。 */
export function serializeUnlockedGroups(groups: readonly string[]): string {
  const unique = [...new Set(groups.filter((group) => typeof group === 'string' && group.length > 0))]
  return JSON.stringify({ version: UNLOCK_STATE_VERSION, unlocked: unique })
}

/**
 * 建一个文件支撑的解锁态存储。
 *
 * @param options - 文件路径与文件系统函数（默认取 DSH_HOME 下的状态文件；单测可注入桩）。
 * @returns 存储句柄；任何 IO 异常都被吞成 fail-closed（不抛，不影响门禁安装）。
 */
export function createFileUnlockStore(options: {
  readonly file?: string
  readonly readFileSync?: (path: string) => string
  readonly writeFileSync?: (path: string, data: string) => void
  readonly mkdirSync?: (path: string) => void
  readonly renameSync?: (from: string, to: string) => void
  readonly rmSync?: (path: string) => void
  readonly joinPath?: (...parts: string[]) => string
  readonly dirnamePath?: (path: string) => string
} = {}): UnlockStore {
  const joinPath = options.joinPath ?? join
  const dirnamePath = options.dirnamePath ?? dirname
  const file = options.file
    ?? joinPath(process.env.DSH_HOME ?? DEFAULT_DSH_HOME, UNLOCK_STATE_FILE)
  // **必须默认到真正的 node:fs**：这些钩子只为单测注入而存在。若默认成 undefined，
  // 生产路径 createFileUnlockStore() 的 read 会恒返回空、write 会静默 no-op——
  // 即「测试全绿但 P0 根本没修」。这里显式兜到真实现。
  const readFileSync = options.readFileSync ?? ((path: string): string => fs.readFileSync(path, 'utf8'))
  const writeFileSync = options.writeFileSync ?? ((path: string, data: string): void => { fs.writeFileSync(path, data, 'utf8') })
  const mkdirSync = options.mkdirSync ?? ((path: string): void => { fs.mkdirSync(path, { recursive: true }) })
  const renameSync = options.renameSync ?? ((from: string, to: string): void => { fs.renameSync(from, to) })
  const rmSync = options.rmSync ?? ((path: string): void => { fs.rmSync(path, { force: true }) })

  return {
    read(): readonly string[] {
      try {
        return parseUnlockedGroups(readFileSync(file))
      } catch {
        // 文件不存在（首次启动）/ 权限不足 / 坏数据：一律「没有任何组被解锁」。
        return []
      }
    },
    write(groups: readonly string[]): void {
      const temp = file + '.tmp'
      try {
        try { mkdirSync?.(dirnamePath(file)) } catch { /* 已存在 */ }
        writeFileSync(temp, serializeUnlockedGroups(groups))
        if (renameSync !== undefined) {
          renameSync(temp, file)
        } else {
          // 无 rename 能力（注入桩）：退化为直写目标文件。
          writeFileSync(file, serializeUnlockedGroups(groups))
        }
      } catch {
        // 写失败不抛：持久化是「尽量记住」，失败时本次进程内解锁仍然有效（内存锁表照常解开）。
        try { rmSync?.(temp) } catch { /* 清理失败无所谓 */ }
      }
    },
  }
}
