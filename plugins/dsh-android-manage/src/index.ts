/**
 * dsh-android-manage — 手机管理工具面（PRD F1.6）
 *
 * 定位：以 ADB（安卓调试桥）优先的观察-动作-等待-再观察闭环；工具经授权会话执行，
 * 按可用权限自动降级（未授权 → 失败关闭：返回引导，不静默降级、不绕行）。
 *
 * 工具集（全部经 ctx.androidPrivilege 前置校验 + 审计）：
 *  - android_screenshot      截屏（接既有视觉链路读图；授权通道执行 screencap）
 *  - android_ui_tree         控件树原始 XML 导出（uiautomator dump，高级/脚本面）
 *  - android_device_info     设备与屏幕信息 + 前台应用（dumpsys 为只读面）
 *  - android_act_input       输入事件（点按/滑动/按键/文本）——高风险动作类，主屏审批前不执行
 *  - android_ui_dump         语义控件清单（ADB 2.0 Phase A：解析+剪枝+编号，紧凑 JSON）
 *  - android_ui_click        语义点击（按 id/text/desc 引用，bounds 中心 tap；不可点回退祖先）
 *  - android_ui_scroll       语义滚动（按节点或屏幕方向/fraction swipe）
 *  - android_ui_input        语义文本输入（ASCII 走 input text；非 ASCII 走 ADBKeyboard 广播）
 *  调用序（PRD-0.13.2 §3.2）：先 android_ui_dump 拿语义清单，失败再截图兜底。
 *
 * 边界声明（PRD F1.6）：仅操作已授权设备；不做账号接管/验证码/支付/绕过风控；
 * 不隐藏 ADB 或自动化信号。敏感操作（截图/界面树）默认提供脱敏选项（文本脱敏摘要模式）。
 *
 * 执行通道说明：本版经 ctx.androidPrivilege 状态机与审计面落地（桥执行实现随壳侧 adbShell 原语
 * 就绪后接通）；未授权时全部工具返回引导——与 PRD "未授权时全部失败关闭" 语义一致。
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { parseUiTreeXml, pruneNodes, resolveRef, findActionableAncestor, checkUiTreeParse, type UiNode, actionableAncestorV2, scopePoolV2 } from './ui-tree.js'
import { cacheFromV2, decodeV2, isV2Payload, type V2Decoded } from './protocol-v2.js'
import { detailRecord, pageRows, writeDetailStore } from './detail-store.js'
import { resolveVirtualDisplayToken, vdTokenMissingText } from './vd-shot.js'

/**
 * 0.13.8 #183：键盘广播来源校验 nonce 参数（壳侧 AdbKeyboardReceiver 私有文件，
 * 引擎与壳同 uid 可读）。文件缺失（旧壳 / 桌面宿主）返回空串 = 不带 auth 参数，
 * 由壳侧 34+ sentFromUid 白名单兜底；桌面宿主无广播路径不受影响。
 */
function adbKeyboardAuthArg(): string {
  const base = process.env.DSH_FILES_DIR
  if (!base) return ''
  try {
    const nonce = readFileSync(join(base, 'adb-keyboard-nonce'), 'utf8').trim()
    return nonce ? ` --es auth '${nonce}'` : ''
  } catch {
    return ''
  }
}

export const name = 'dsh-android-manage'
// androidPrivilege 由 dsh-android-bridge 在 apply 时经 ctx.provide 注册；
// cordis 代理对未 inject 的非注册属性读取会抛错（"cannot get property without inject"），
// 故必须显式 inject；加载顺序由装配行保证（android-bridge 在 android-manage 前）。
export const inject = ['tools', 'webServer', 'androidPrivilege'] as const

interface PrivilegeFace {
  /** 会话级通道门：无障碍通道（服务已开启）或 ADB 三道人门任一成立即放行；会话档位 danger-full-access 恒需。 */
  gateFor(session?: unknown): { ok: true; via?: 'a11y' | 'adb' } | { ok: false; guidance: string }
  /** 真实 ADB 通道：adb shell（adbd 执行，shell uid=2000）。 */
  execAdbShell?(command: string, auth?: { session?: unknown; internal?: string }): Promise<{ ok: boolean; stdout: string; guidance?: string }>
  /** 真实 ADB 通道：原始 adb 行（自动注入 -s 与幂等 connect；screencap+pull 等组合用）。 */
  execAdbLine?(line: string, auth?: { session?: unknown; internal?: string }): Promise<{ ok: boolean; stdout: string; guidance?: string }>
  /** 0.13.5 W4：控制通道策略（a11y 优先 / ADB 回退 / 拒绝，fail-closed）。 */
  controlDecision?(op: string, session?: unknown, forceBackend?: 'a11y' | 'adb'): { backend: 'a11y' | 'adb' | 'deny'; reason: string; guidance?: string }
  /** 0.13.5 W4：无障碍通道执行（壳侧队列往返；未开启无障碍时直接拒绝）。 */
  controlExec?(op: string, args: Record<string, unknown>, timeoutMs?: number, auth?: { session?: unknown; internal?: string }): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
  /** S-5：绑定本次调用的会话（bridge 服务面据此复查档位；见其 KDoc）。 */
  bindSession?(session: unknown): void

  /** 0.14: current native-owned access range; no model tool can mutate it. */
  screenScope?(): 'virtual-only' | 'real-only' | 'all'
  /** 0.14: fail-closed target decision before any real/virtual content operation. */
  screenAccess?(screenId?: string):
    | { ok: true; screenId: string; displayId: number; scope: 'virtual-only' | 'real-only' | 'all' }
    | { ok: false; reason: string; guidance: string; scope: 'virtual-only' | 'real-only' | 'all'; screenId: string }
  /**
   * **异步**版屏幕决策：虚拟屏别名 → 动态 displayId 的解析要问壳侧注册表（vdInfo），
   * 同步面拿不到，必然把已建好的虚拟屏判成 `screen-not-ready`（0.14.0 用户测试项目第一项实锤：
   * displayId=32/state=active 的真屏被拒，工具只回「virtual-1 尚未就绪」）。
   * 工具层一律优先用这个；缺失时才回退同步 `screenAccess`。
   */
  screenAccessResolved?(screenId?: string): Promise<
    | { ok: true; screenId: string; displayId: number; scope: 'virtual-only' | 'real-only' | 'all' }
    | { ok: false; reason: string; guidance: string; scope: 'virtual-only' | 'real-only' | 'all'; screenId: string }
  >

  audit(action: string, detail: Record<string, unknown>, ok: boolean): void
}

/**
 * 热补丁（2026-08-27 真机实锤）：模型侧文本取值——仅 string 原样放行；其余类型
 * JSON.stringify 转写（对象值顺带自证形状），杜绝 `[object Object]` 进入转录。
 */
function pickText(v: Record<string, unknown>, ...keys: string[]): string {
  return keys
    .map((k) => {
      const x = v[k]
      if (typeof x === 'string') return x
      if (x === undefined || x === null) return ''
      try { return JSON.stringify(x) } catch { return String(x) }
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

function tools(ctx: Context, priv: PrivilegeFace) {
  // Every route that can observe or manipulate an Android display goes through this one scope gate
  // before it chooses a11y/ADB. That prevents the legacy ADB fallback from bypassing virtual-only.
  // review C11：`device_info` 已移出——它只读型号/版本等元数据，不含屏幕内容；默认 virtual-only
  // 下把它整体拒绝属过度拦截（U-3 约束的是「屏幕内容读取与操作」）。
  // 块G F4b（0.14.1）：`web_dump` 同型移出——它读的是**壳自有 WebView**（DSH 自己的 Web UI，
  // 壳侧 handleWebSnapshot 走 MainActivity.webViewRef），既没有 `screenId` 参数也与设备屏无关。
  // 留在本集合里的后果是确定的过度拦截：guard 的 requested 恒为 undefined → decideScreenAccess
  // 落到 real → virtual-only 下 android_web_dump 必然被拒，而它根本不读设备屏。
  const SCREEN_ACTIONS = new Set([
    'screenshot', 'ui_detail', 'ui_tree', 'act_input', 'ui_dump', 'ui_click',
    'ui_scroll', 'ui_input', 'app_launch', 'ui_global',
  ])
  /**
   * 屏幕范围门 + 会话通道门。
   *
   * **args 必须是工具收到的完整实参**（0.14.0 真机实锤）。
   *
   * 缺陷形态（用户两轮阻碍之一）：各调用点传的是**手搓的子集**，例如
   *   guard('ui_dump', {}, exec)      // 只传空对象
   *   guard('ui_click', { ref, nx, ny }, exec)
   * 于是 `screenId` 在到达 `screenAccess()` 之前就被丢掉了——**无论模型传 virtual-1 还是别的，
   * 这道门永远按 `real` 判定**，接着壳侧按真实屏执行、再被范围拒掉。模型看到的现象是
   * 「屏幕参数像是没生效」，实际是「参数根本没进门」。
   *
   * 这也解释了为什么同一族工具有的能路由、有的不能：差别只在调用点是否碰巧把 screenId 抄进去了。
   * 修法不是逐个补字段（下次加字段还会漏），而是**唯一入口收完整实参**。
   */
  const guard = async (action: string, args: Record<string, unknown>, exec?: { agent?: { session?: unknown } }) => {
    // S-5：把本次调用的会话绑定到**当前异步上下文**——bridge 的服务面据此复查档位。
    // 为什么在这里绑：本插件的私有面调用点有 40+ 处（分散在各 helper 里，多数拿不到 exec），
    // 逐个改签名噪声大且必漏；而 guard 是每个工具入口的唯一必经点，语义正是「这次调用属于谁」。
    priv.bindSession?.(exec?.agent?.session)
    if (SCREEN_ACTIONS.has(action) && (priv.screenAccessResolved ?? priv.screenAccess)) {
      const requested = typeof args.screenId === 'string' ? args.screenId : undefined
      // **必须用异步面**：`virtual-N` → displayId 要经壳侧 vdInfo 注册表解析，同步面做不到，
      // 会把已建好的虚拟屏一律判成「尚未就绪」（0.14.0 用户测试项目第一项实锤：
      // 壳侧 displayId=32/state=active，工具却回「virtual-1 尚未就绪」）。
      const screen = priv.screenAccessResolved !== undefined
        ? await priv.screenAccessResolved(requested)
        : priv.screenAccess!(requested)
      if (!screen.ok) {
        priv.audit(action, { tool: 'android-manage', args, reason: screen.reason, scope: screen.scope }, false)
        return { ok: false as const, guidance: screen.guidance }
      }
    }
    const a = priv.gateFor(exec?.agent?.session)
    priv.audit(action, { tool: 'android-manage', args }, a.ok)
    return a
  }

  /**
   * 目标屏幕参数（SPEC §2.2 / §4.2）：real 默认，virtual-N 走虚拟屏；语义树需无障碍。
   *
   * **必须带 description（0.14.0 真机实锤修正）**：此前注释的理由是「wire 预算敏感，语义唯一归属地
   * = android_screen_list 的工具描述」，假设模型会先调 android_screen_list 再传参。
   * 设备会话实录推翻了该假设：模型看到 `screenId` 是个**无说明的字符串**，直接忽略，
   * `android_app_launch` 因此把第三方 App 拉到了真实屏（它想要的是虚拟屏），
   * 随后整轮都在错误前提下排查。**对模型不可发现的参数等于不存在的参数。**
   *
   * 该参数内联进 10 处，故文案压到最短的可判别形式（"real|虚拟-N"），语义靠 android_screen_list 展开。
   */
  const SCREEN_PARAM = {
    type: 'string',
    description: '目标屏 real|virtual-N',
  } as const

  /**
   * 本机当前活跃虚拟屏的别名（无则 null）。
   *
   * 用途：`android_app_launch` 在**未传 screenId** 却拉起成功时，把「本机其实有虚拟屏、以及怎么用」
   * 当场回给模型（0.14.0 设备实锤：模型漏传 screenId → App 落真实屏 → 整轮在错误前提下排查）。
   * 枚举真源同 android_screen_list：壳侧 `vdInfo` 注册表，不硬编码 virtual-1。
   * 读失败一律返回 null——兜底提示是增益，不得因为它让拉起本身失败。
   */
  const activeVirtualAlias = async (): Promise<string | null> => {
    try {
      const info = await priv.controlExec?.('vdInfo', {})
      if (info === undefined || !info.ok) return null
      const data = info.data as { screens?: Array<{ alias?: string; kind?: string }> }
      const virtual = (data.screens ?? []).find((s) => s.kind === 'virtual' && typeof s.alias === 'string')
      return virtual?.alias ?? null
    } catch {
      return null
    }
  }

  /**
   * 把 args 里的 screenId 转成壳侧控制参数（缺省不发键，保持真实屏语义）。
   *
   * 用途与 `guard` 互补，两者必须成对：`guard` 用 screenId 做**范围判定**，本函数把它
   * **投递到壳侧执行**。只做前者的后果（0.14.0 真机实锤）：门按 virtual-N 放行了，
   * 执行却仍落在真实屏——模型看到「参数生效了但画面没变」，比直接拒绝更难排查。
   */
  const screenArgs = (args: unknown): Record<string, unknown> => {
    const screenId = (args as { screenId?: unknown } | undefined)?.screenId
    return typeof screenId === 'string' && screenId !== '' ? { screenId } : {}
  }

  /**
   * 动作模式（SPEC §4.2）：壳侧对每个真实屏 op 回填 `actionMode`。
   *
   * 两类取值（与壳侧 DeviceControlService.REAL_SCREEN_OPS 回填同源）：
   *   - `a11y`        语义树 / ref 动作可用（无障碍通道在线）；
   *   - `coordinate`  该屏只能坐标操作（典型：纯 Shizuku、或虚拟屏尚无窗口）。
   *
   * 为什么必须逐条进 output schema：引擎在 `additionalProperties:false` 下做整值校验，
   * 返回体里出现 schema 未声明的键 → 整条 ToolOutputError，模型**拿不到任何数据**
   * （0.13.8 #204 的实测教训）。故凡透传 actionMode 的工具都必须先声明它。
   */
  // 唯一需要说明的字段（模型据此决定下一步），其余三件套靠类型自明。
  const ACTION_MODE_PROP = { type: 'string' } as const

  /** 通道受限时的可执行下一步（与 actionMode 成对出现；schema 漏声明会被整值拒绝）。 */
  const GUIDANCE_PROP = { type: 'string' } as const

  /** 屏幕三件套（screenId / displayId / scope）：壳侧对真实屏 op 逐条回填，故同样要声明。 */
  // 这三个字段的语义由工具描述与 SCREEN_PARAM 承载；此处 description 极简（wire 预算敏感：
  // 它们要重复出现在 5 个工具的 schema 里，每个字都要乘 5，见 check-tool-surface-budget）。
  const SCREEN_ID_PROP = { type: 'string' } as const
  const DISPLAY_ID_PROP = { type: 'number' } as const
  const SCOPE_PROP = { type: 'string' } as const

  const screenList = defineTool({
    name: 'android_screen_list',
    description: '列出稳定屏幕别名及当前用户开放范围。只返回 capability 元数据，不读取页面内容；屏幕读写仍要求 danger-full-access。虚拟屏（virtual-N）的语义树/ref 动作需无障碍通道；纯 Shizuku 下虚拟屏只能坐标操作——用 android_vdisplay_input（tap/swipe/keyevent/text）。真实屏用 android_ui_click 的 nx/ny。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          screens: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async () => {
      const scope = priv.screenScope?.() ?? 'virtual-only'
      const realInScope = scope === 'real-only' || scope === 'all'
      const virtualInScope = scope === 'virtual-only' || scope === 'all'
      // 规格 §2.1：别名 1..N 由壳侧分配；枚举真源是原生注册表（vdInfo），不硬编码 virtual-1。
      const virtuals: Array<{ screenId: string; displayId?: number }> = []
      try {
        const info = await priv.controlExec?.('vdInfo', {})
        if (info !== undefined && info.ok) {
          const data = info.data as { screens?: Array<{ alias?: string; displayId?: number; kind?: string }> }
          for (const screen of data.screens ?? []) {
            if (screen.kind === 'virtual' && typeof screen.alias === 'string') {
              virtuals.push({ screenId: screen.alias, displayId: screen.displayId })
            }
          }
        }
      } catch {
        /* 注册表不可达：下面如实报告「尚未建立」 */
      }
      const screens: Record<string, unknown>[] = [
        {
          screenId: 'real', displayId: 0, kind: 'physical', label: '真实屏幕', inScope: realInScope,
          reason: realInScope ? '可在完全访问会话中使用无障碍或已授权 transport 操作。' : '当前用户范围不允许读取或操作真实屏幕。',
        },
      ]
      for (const virtual of virtuals) {
        screens.push({
          screenId: virtual.screenId,
          displayId: virtual.displayId,
          kind: 'virtual',
          label: '虚拟屏幕 ' + virtual.screenId.replace('virtual-', ''),
          inScope: virtualInScope,
          reason: virtualInScope ? '已就绪；语义树需开启无障碍（纯 Shizuku 只能坐标操作）。' : '当前用户范围不允许读取或操作虚拟屏幕。',
        })
      }
      if (virtuals.length === 0) {
        screens.push({
          screenId: 'virtual-1', kind: 'virtual', label: '虚拟屏幕 1', inScope: virtualInScope,
          reason: virtualInScope ? 'VirtualDisplay 尚未建立；不会映射到 display 0。' : '当前用户范围不允许读取或操作虚拟屏幕。',
        })
      }
      return {
        scope,
        screens,
        text: `开放范围：${scope}。real = display 0；虚拟屏别名 virtual-N（当前 ${virtuals.length} 块），绝不回退到真实屏幕。`,
      } as never
    },
  })

  /** 可选服务最小面：不引 dsh-attachment/dsh-llm 依赖，能力缺失时自动回退路径模式。 */
  interface AttachmentFace {
    imageLimits: { mediaTypes: readonly string[]; maxImageBytes: number; maxMessageImageBytes: number }
    saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{
      attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string
    }>
  }

  interface LlmFace {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }>
  }

  /** 工具执行上下文里取路由所需的最小面。 */
  type ExecLike = {
    agent?: {
      session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
      options?: { provider?: string; model?: string }
    }
    signal?: AbortSignal
  }

  /** 截图工具的规范返回值（与 output.schema 一致；image 在场即内联回图）。 */
  type ShotValue = {
    imagePath: string
    width: number
    height: number
    denied: boolean
    text: string
    image?: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }
  }

  /**
   * 一次性读图（issue #127）：把刚落的截图直接并入工具结果（图像块）并删除临时文件——
   * 模型不再需要额外一轮 read_image，也不残留文件。仅当附件服务在场且当前路由声明
   * 图像输入时启用；否则回退到「返回路径」的旧行为（文件已落引擎可读目录，read_image 可用）。
   */
  async function inlineShot(
    filePath: string, width: number, height: number, exec: ExecLike, channelNote: string,
  ): Promise<ShotValue> {
    const fallback = (why: string): ShotValue => ({
      imagePath: filePath,
      denied: false,
      width,
      height,
      text: `截图已保存：${filePath}（${channelNote}${why}）`,
    })
    const attachments = ctx.get('attachments') as AttachmentFace | undefined
    if (!attachments) return fallback('；未挂载附件服务，请用 read_image 读该路径')
    if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
      return fallback('；本部署不接受 PNG 附件，请用 read_image 读该路径')
    }
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm') as LlmFace | undefined
    if (!llm || provider === undefined || model === undefined) {
      return fallback('；无法解析当前模型路由，请用 read_image 读该路径')
    }
    try {
      const info = await llm.resolveModelInfo(provider, model, exec.signal)
      if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
        return fallback(`；当前模型 ${model} 不声明图像输入，请切换到支持图像的模型后用 read_image 读该路径`)
      }
    } catch {
      return fallback('；模型能力解析失败，请用 read_image 读该路径')
    }
    try {
      const data = readFileSync(filePath)
      if (data.byteLength > attachments.imageLimits.maxImageBytes) {
        return fallback(`；图像 ${data.byteLength} 字节超出内联上限，请用 read_image 读该路径`)
      }
      const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: `android-shot-${Date.now()}.png` })
      rmSync(filePath, { force: true })
      return {
        imagePath: filePath,
        denied: false,
        width: ref.width || width,
        height: ref.height || height,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
        text: `截图已内联返回（${channelNote}；设备物理分辨率 ${width}x${height}，${ref.bytes} 字节，临时文件已删除）。`
          + '图像就在本结果里，无需再调用 read_image；像素坐标换算用归一化 nx/ny。',
      }
    } catch (e) {
      return fallback('；内联读图失败（' + String((e as Error).message) + '），请用 read_image 读该路径')
    }
  }

  /**
   * 点击生效校验（issue #129）：点后短暂等待，读壳侧便宜状态（快照代次 + 失效标记，不建树）。
   * 代次变化或 invalidated=true 即判定界面确实变了；否则明确回报「未观察到变化」，
   * 让模型不必靠「再 dump 一次」才发现点击落空。
   */
  async function verifyClick(beforeGen: number | undefined, exec: ExecLike): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 260))
    const s = await a11yExec('state', {}, 4000)
    if (!s.ok) return `（生效校验不可用：${s.error}）`
    const d = (s.data ?? {}) as { gen?: number; invalidated?: boolean }
    const changed = d.invalidated === true
      || (typeof d.gen === 'number' && beforeGen !== undefined && d.gen !== beforeGen)
    if (changed) return '生效校验：界面已变化（已生效）'
    // **「未观察到变化」不等于「没生效」**（0.14.0 模拟器实锤，坑 138）。
    //
    // 实测：点击虚拟屏上的「深色主题」开关，返回「未观察到界面变化——可能未生效」，
    // 但紧接着的 `android_ui_dump` 明确显示 Switch 从 `[已选中]` 变为未选中——**点击其实成功了**。
    // 真因：本函数比对的 `beforeGen` 传的是 `uiCache.gen`（那是**配置代次**，如 fp0c052e71，恒定），
    // 而壳侧 `state` 回的是**快照代次**（每次建树自增）。两个量根本不同源，比较必然判「未变」。
    //
    // 不确定时的措辞必须诚实（用户口径：不要用错误结论误导模型）：
    // 「校验本身不可靠」与「点击落空」是两件事，模型据此决定「重试」还是「放弃」，不能混。
    return '生效校验：本次未能确认界面变化（该判据对部分控件不可靠，不代表点击失败）——请用 android_ui_dump 核对实际状态'
  }

  // ── ADB 可靠性批次公共件（2026-09-05，docs/BUGS-open-2026-09-05-ADB-field-report.md）──

  const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

  /** F1 止血：读动画三开关当前值。$k/$(...) 由 execAdbShell 的远端段整体转义保护（0.1.3 起），
   *  本地 bash 不展开、由设备端求值。 */
  async function readAnimScales(): Promise<Record<string, string>> {
    if (!priv.execAdbShell) return {}
    const cmd = 'for k in ' + ANIM_KEYS.join(' ') + '; do echo R:$k=$(settings get global $k); done'
    // S-5：`settings get/put global` 命中服务面危险命令黑名单，故走**具名内部白名单**——
    // 白名单按命令形态逐条校验（bridge 的 isAnimationScaleCommand），不是名字对了就放行。
    const r = await priv.execAdbShell(cmd, { internal: 'animation-scales' }).catch(() => ({ ok: false, stdout: '' }))
    const out: Record<string, string> = {}
    for (const m of r.stdout.matchAll(/R:(\w+)=(\S+)/g)) out[m[1]] = m[2]
    return out
  }

  /** F1 止血：动画三开关置值——uiautomator dump 的 idle 等待依赖无障碍事件流安静，
   *  音乐类 App 播放条常驻动画使窗口永不 idle（"could not get idle state" 实锤根因）。 */
  async function setAnimScales(v: string): Promise<void> {
    if (!priv.execAdbShell) return
    await priv.execAdbShell(ANIM_KEYS.map((k) => `settings put global ${k} ${v}`).join('; '), { internal: 'animation-scales' })
      .catch(() => undefined)
  }

  /** F1 止血：还原动画三开关（读数失败的键回 1 标准值）。 */
  async function restoreAnimScales(old: Record<string, string>): Promise<void> {
    if (!priv.execAdbShell) return
    await priv.execAdbShell(ANIM_KEYS.map((k) => `settings put global ${k} ${old[k] ?? '1'}`).join('; '), { internal: 'animation-scales' })
      .catch(() => undefined)
  }

  /** F10：本地临时产物统一目录（TMPDIR/dsh-tmp/）+ 按 prefix LRU 清理，杜绝私有目录无限堆积。 */
  function pruneTmp(prefix: string, keep: number): string {
    const dir = join(process.env.TMPDIR ?? '/tmp', 'dsh-tmp')
    try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
    try {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const x of files.slice(keep)) {
        try { rmSync(join(dir, x.f), { force: true }) } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    return dir
  }

  const screenshot = defineTool({
    name: 'android_screenshot',
    description:
      '对设备截屏，并**把图像直接放在本次结果里返回**（一次性：临时文件读完即删，无需再调用 read_image）。' +
      '用于界面观察闭环（配合 android_ui_dump 的语义清单核对渲染结果）。' +
      '无障碍通道优先（API 30+，无需 ADB），否则走 ADB screencap。未授权失败关闭。' +
      '当前模型不声明图像输入时回退为返回文件路径（此时再用 read_image）。' +
      '可传 textRedact: true 获得文本脱敏摘要（避免敏感屏幕内容进入上下文）。',
    parameters: {
      textRedact: { type: 'boolean', description: '文本脱敏摘要模式（默认 false 返回图像/路径）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string', required: true },
          width: { type: 'number', description: '设备物理分辨率宽（截图像素坐标换算锚点）' },
          height: { type: 'number', description: '设备物理分辨率高' },
          screenId: SCREEN_ID_PROP,
          displayId: DISPLAY_ID_PROP,
          scope: SCOPE_PROP,
          actionMode: ACTION_MODE_PROP,
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => {
        const blocks: Array<Record<string, unknown>> = [
          { type: 'text', text: pickText(v, 'text', 'imagePath') || '(no output)' },
        ]
        const image = v.image as { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string } | undefined
        if (image !== undefined) blocks.push({ type: 'image', attachment: image })
        return blocks as never
      },
    },
    execute: async (args: { textRedact?: boolean; screenId?: string }, exec) => {
      const textRedact = args?.textRedact === true
      const screenId = args?.screenId
      const a = await guard('screenshot', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { imagePath: '', denied: true, text: a.guidance }
      // 0.13.5 W4：无障碍截屏优先（API 30+ 的 AccessibilityService.takeScreenshot——不需要 ADB）
      let adbNote = ''
      if (controlDecision('screenshot', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const r = await a11yExec('screenshot', { ...screenArgs(args) }, 12_000)
        if (!r.ok) {
          // 0.13.8 E6：无障碍截屏不可用（API<30 无 takeScreenshot / FLAG_SECURE 被拒 / 服务未就绪）
          // → 回落 ADB screencap，而不是把「没有截图能力」当结论抛给模型。
          if (priv.execAdbLine) {
            adbNote = `（无障碍截屏不可用：${r.error}——已回落 ADB 通道）`
          } else {
            return {
              imagePath: '', denied: false,
              text: `无障碍截屏失败：${r.error}。ADB 通道未接通，无法回落——`
                + '需要截图请先完成 ADB 授权（完全访问 → 允许访问开关 → 配对码），或用 android_ui_dump 读结构。',
            }
          }
        } else {
          const data = (r.data ?? {}) as { path?: string; width?: number; height?: number }
          if (!data.path) {
            if (!priv.execAdbLine) return { imagePath: '', denied: false, text: '无障碍截屏未返回文件路径，且 ADB 通道未接通（无法回落）' }
            adbNote = '（无障碍截屏未返回文件路径——已回落 ADB 通道）'
          } else {
            return inlineShot(
              data.path,
              data.width ?? 0,
              data.height ?? 0,
              exec as ExecLike,
              `无障碍通道，设备物理分辨率 ${data.width ?? '?'}x${data.height ?? '?'}`,
            )
          }
        }
      }
      // 0.14 真实通道：adbd（shell uid）执行 screencap → adb pull 回引擎私有临时目录（app uid 可读）。
      if (!priv.execAdbLine) return { imagePath: '', denied: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      try {
        const n = Date.now()
        const remote = `/data/local/tmp/dsh-shot-${n}.png`
        const local = join(pruneTmp('dsh-shot-', 20), `dsh-shot-${n}.png`)
        // 目标屏（0.14.0 设备实锤修正）：无障碍离线时走这条 ADB 回落，而它此前**完全忽略 screenId**——
        // 无参数地 `screencap` 只会抓默认屏（display 0），于是模型对虚拟屏截图拿到的是真实屏画面，
        // 却以为自己在看虚拟屏（设备会话里 agent 正是据此误判「设置没开在虚拟屏上」）。
        // 屏幕范围已在 guard() 里判定过；这里只负责把它落到 screencap 上。
        //
        // **0.14.1 块G F6（设备实测真因）**：`screencap -d` 吃的是 **SurfaceFlinger token**，
        // 不是 DisplayManager displayId——两者是不相交的 id 空间（虚拟屏 token 形如
        // 11529215046816944610，displayId 只是 2/3/5 这样的小整数）。此前传 displayId ⇒
        // 必然 `Failed to take screenshot. Status: -2`。故虚拟屏目标必须先反查 SF token。
        // token 全程按**字符串**（超 2^53 与 2^63-1，数值化即失真）。
        const isVirtualTarget = typeof screenId === 'string' && screenId !== '' && screenId !== 'real'
        const targetDisplay = isVirtualTarget
          ? (await priv.screenAccessResolved?.(screenId)) ?? priv.screenAccess?.(screenId)
          : undefined
        let displayFlag = ''
        if (isVirtualTarget) {
          // 反查 SF token：经 shell 通道收窄读取（全量 dumpsys 会超出 inline 回传窗口）。
          const sf = await priv.execAdbShell?.("dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'")
          const sfOut = sf?.ok === true ? sf.stdout : ''
          const token = resolveVirtualDisplayToken(sfOut, screenId)
          if (token === null) {
            // fail-closed：**绝不**回落 displayId 硬试、**绝不**回落无参 screencap（会抓真实屏）。
            return { imagePath: '', denied: false, text: vdTokenMissingText(screenId) }
          }
          displayFlag = `-d ${token} `
        } else if (targetDisplay !== undefined && targetDisplay.ok === true && targetDisplay.displayId !== 0) {
          displayFlag = `-d ${targetDisplay.displayId} `
        }
        const r = await priv.execAdbLine(`adb shell screencap -p ${displayFlag}${remote} && adb pull ${remote} ${local} && ls -l ${local}; adb shell rm -f ${remote}`)
        if (!r.ok) return { imagePath: '', denied: false, text: r.guidance ?? (r.stdout || '截图执行失败') }
        if (!/^-rw|^-|^total|dsh-shot/.test(r.stdout.trim()) && !existsSync(local)) {
          return { imagePath: '', denied: false, text: '截图未落地：' + (r.stdout.trim().slice(-400) || '无输出') }
        }
        // F2 统一坐标系：回传物理分辨率锚点。模型侧读图可能降采样（maxDim 2048），
        // 严禁直接用截图像素坐标点击——归一化用 android_ui_click 的 nx/ny。
        // 目标屏是虚拟屏时，锚点必须是**该屏自己的**像素尺寸，否则坐标换算全错。
        const virtualSize = targetDisplay !== undefined && targetDisplay.ok === true && targetDisplay.displayId !== 0
          ? await priv.controlExec?.('vdInfo', {})
          : undefined
        const screenTarget = (virtualSize?.ok === true ? (virtualSize.data ?? {}) : {}) as {
          screens?: Array<{ alias?: string; width?: number; height?: number }>
        }
        const matched = (screenTarget.screens ?? []).find((s) => s.alias === screenId)
        const size = matched?.width !== undefined && matched?.height !== undefined && matched.width > 0 && matched.height > 0
          ? { w: matched.width, h: matched.height }
          : await screenSize()
        const targetDisplayId = targetDisplay !== undefined && targetDisplay.ok === true ? targetDisplay.displayId : 0
        // 虚拟屏的锚点说明点名 SF token（displayId 对它无意义，写出来会误导坐标换算的排查）。
        const scopeNote = displayFlag === ''
          ? ''
          : isVirtualTarget
            ? `（目标屏 ${screenId}，SurfaceFlinger token）`
            : `（目标屏 ${screenId}，displayId ${targetDisplayId}）`
        return inlineShot(local, size.w, size.h, exec as ExecLike, `ADB 通道，设备物理分辨率 ${size.w}x${size.h}${scopeNote}${adbNote}`)
      } catch (e) {
        return { imagePath: '', denied: false, text: '截图失败：' + String((e as Error).message) }
      }
    },
  })

  const uiDetail = defineTool({
    name: 'android_ui_detail',
    description:
      '【两级披露第二级】按需取回 dump 的全量明细：给 ref 取单个节点的逐字段记录（完整文本/几何/祖先，'
      + '不受默认渲染压缩影响）；给 all=true 分页取整表（offset/limit，默认 60 行并如实报告省略量）。'
      + '只在默认清单不够用时用——日常定位用 android_ui_dump。需先执行过 android_ui_dump。',
    parameters: {
      ref: { type: 'string', description: '节点引用（id:nN / text:… / desc:… / rid:…；与 all 二选一）' },
      all: { type: 'boolean', description: 'true = 取整表分页（配 offset/limit）' },
      offset: { type: 'number', description: '整表起始行（默认 0）' },
      limit: { type: 'number', description: '整表每页行数（默认 60，上限 200）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          denied: { type: 'boolean' },
          handle: { type: 'string' },
          path: { type: 'string' },
          node: { type: 'object', additionalProperties: true },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total: { type: 'number' },
          offset: { type: 'number' },
          omitted: { type: 'number' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{
        type: 'text',
        text: String(v.text ?? '') + (Array.isArray(v.rows) && v.rows.length > 0
          ? '\n' + v.rows.map((r) => JSON.stringify(r)).join('\n')
          : v.node ? '\n' + JSON.stringify(v.node) : ''),
      }],
    },
    execute: async (args: { ref?: string; all?: boolean; offset?: number; limit?: number; screenId?: string }, exec) => {
      const { ref, all, offset, limit } = args ?? {}
      const a = await guard('ui_detail', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
        return { ok: false, denied: false, text: '没有最近的控件清单——请先 android_ui_dump，再按需取明细' }
      }
      const handle = detailHandle
      const path = detailPath
      if (ref !== undefined && ref.trim() !== '') {
        const hit = resolveRef(uiCache.byId, uiCache.nodes, ref.trim(), scopePoolFor())
        if (!hit.ok) return { ok: false, denied: false, handle, path, text: hit.error }
        const idx = uiCache.nodes.findIndex((n) => n.id === hit.node.id)
        const rows = uiCache.nodes
        const extra: Record<string, unknown> = {}
        const v2 = uiCache.v2
        if (v2 && idx >= 0) {
          const anc = v2.actionableAncestor[idx]
          extra.actionableAncestor = anc >= 0 ? 'n' + anc : null
          extra.subtree = { start: 'n' + idx, end: v2.subtreeEnd[idx] > idx ? 'n' + v2.subtreeEnd[idx] : null }
        }
        const parent = uiCache.nodes.find((n) => n.id === hit.node.parentId)
        if (parent) extra.parentLabel = `${parent.type || 'View'}${parent.text ? ' text="' + parent.text.slice(0, 24) + '"' : ''}`
        return {
          ok: true, denied: false, handle, path, total: rows.length,
          node: detailRecord(hit.node, extra) as unknown as Record<string, JsonValue>,
          text: `明细 ${hit.node.id}（句柄 ${handle}${path ? '，离线 ' + path : ''}）`,
        }
      }
      if (all === true) {
        const lim = Math.min(Math.max(Number(limit ?? 60) || 60, 1), 200)
        const { page, offset: off, omitted } = pageRows(uiCache.nodes, Number(offset ?? 0) || 0, lim)
        return {
          ok: true, denied: false, handle, path, rows: page.map((n) => detailRecord(n)) as unknown as Array<Record<string, JsonValue>>,
          total: uiCache.nodes.length, offset: off, omitted,
          text: `全量明细第 ${off}..${off + page.length - 1} 行 / 共 ${uiCache.nodes.length} 行`
            + (omitted > 0 ? `（本页外还有 ${omitted} 行，请带 offset 继续）` : '')
            + `；句柄 ${handle}${path ? '，离线可 read/grep：' + path : ''}`,
        }
      }
      return { ok: false, denied: false, handle, path, text: '请给 ref（单节点）或 all=true（整表分页）' }
    },
  })

  const uiTree = defineTool({
    name: 'android_ui_tree',
    description:
      '【ADB 专属 / 兜底】导出原始 uiautomator XML（大而全，token 高）：仅当无障碍通道不可用、或明确需要原始 XML 字段时才用。' +
      '日常定位请优先 android_ui_dump（无障碍语义树，字段更全且无需配对）。未授权失败关闭。',
    parameters: { screenId: SCREEN_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          treeXmlPath: { type: 'string', required: true },
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text', 'treeXmlPath') || '(no output)' },
      ],
    },
    execute: async (args: { screenId?: string } | undefined, exec) => {
      const a = await guard('ui_tree', (args ?? {}) as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { treeXmlPath: '', denied: true, text: a.guidance }
      const cap = adbChannelOnly('ui_tree', exec as { agent?: { session?: unknown } })
      if (!cap.ok) return { treeXmlPath: '', denied: true, text: cap.text }
      // 0.14 真实通道：uiautomator dump（shell uid）→ pull 回引擎私有临时目录。
      if (!priv.execAdbLine) return { treeXmlPath: '', denied: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      try {
        const n = Date.now()
        const remote = `/data/local/tmp/dsh-ui-${n}.xml`
        const local = join(pruneTmp('dsh-ui-', 10), `dsh-ui-${n}.xml`)
        // F1 止血：dump 前关动画（事件流安静才能过 idle 等待），dump 后还原。
        const oldAnim = await readAnimScales()
        await setAnimScales('0')
        try {
          const r = await priv.execAdbLine(`adb shell uiautomator dump ${remote} && adb pull ${remote} ${local} && ls -l ${local}; adb shell rm -f ${remote}`)
          if (!r.ok) return { treeXmlPath: '', denied: false, text: r.guidance ?? (r.stdout || '控件树导出失败') }
          if (!existsSync(local)) {
            return { treeXmlPath: '', denied: false, text: '控件树未落地（厂商 ROM 可能限制 uiautomator）：' + (r.stdout.trim().slice(-400) || '无输出') }
          }
          return { treeXmlPath: local, denied: false, text: `控件树已导出：${local}` }
        } finally {
          await restoreAnimScales(oldAnim)
        }
      } catch (e) {
        return { treeXmlPath: '', denied: false, text: '控件树导出失败：' + String((e as Error).message) }
      }
    },
  })

  const deviceInfo = defineTool({
    name: 'android_device_info',
    description:
      '设备与屏幕信息 + 当前前台应用（只读；dumpsys —— 系统属性读取在部分厂商 ROM 受限时如实降级）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          androidVersion: { type: 'string' },
          frontApp: { type: 'string' },
          resolution: { type: 'string' },
          devices: { type: 'array', items: { type: 'string' }, description: '当前 adb 设备清单（serial+型号+状态，多设备消歧用）' },
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text') || '(no output)' },
      ],
    },
    execute: async (_args, exec) => {
      const a = await guard('device_info', {}, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { model: '', denied: true, text: a.guidance }
      // 0.14 真实通道：getprop + dumpsys 只读面（厂商差异：vivo 等对 dumpsys 部分过滤时如实降级）。
      if (!priv.execAdbShell) return { model: '', denied: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbShell）' }
      try {
        const r = await priv.execAdbShell(
          'echo MODEL=$(getprop ro.product.model); echo VER=$(getprop ro.build.version.release);' +
          'echo SDK=$(getprop ro.build.version.sdk); echo FOCUS=$(dumpsys window 2>/dev/null | grep -m1 mCurrentFocus);' +
          'echo RES=$(dumpsys window displays 2>/dev/null | grep -m1 init=)',
        )
        if (!r.ok) return { model: '', denied: false, text: r.guidance ?? (r.stdout || '设备信息查询失败') }
        const kv: Record<string, string> = {}
        for (const line of r.stdout.split('\n')) {
          const m = /^(MODEL|VER|SDK|FOCUS|RES)=(.*)$/.exec(line.trim())
          if (m) kv[m[1]] = m[2].trim()
        }
        // F4 多设备消歧：宿主侧 adb devices -l 原样列出（serial+model:device 状态），
        // 供模型/用户确认工具绑定的是哪台设备（127.0.0.1:5555 与 emulator 并存时实测踩坑）。
        const dl = priv.execAdbLine ? await priv.execAdbLine('adb devices -l').catch(() => ({ ok: false, stdout: '' })) : { ok: false, stdout: '' }
        const devices = (dl.ok ? dl.stdout : '').split('\n').map((s) => s.trim()).filter((s) => s.includes('\t') || s.includes('device product:'))
        return {
          model: kv.MODEL ?? '(未知)',
          // 热补丁：可选成员一律空串兜底——undefined 成员会被引擎 lossless-JSON
          // 校验整值拒绝（INVALID_TOOL_OUTPUT，2026-08-27 vivo dumpsys 被过滤时实锤）。
          androidVersion: kv.VER ?? '',
          frontApp: kv.FOCUS ? kv.FOCUS.replace(/^.*mCurrentFocus=\{\s*(\S+).*$/, '$1') : '',
          resolution: kv.RES ? kv.RES.replace(/^.*init=(\d+x\d+).*$/, '$1') : '',
          devices,
          denied: false,
          text: `model=${kv.MODEL ?? '?'} ver=${kv.VER ?? '?'} sdk=${kv.SDK ?? '?'} focus=${kv.FOCUS ?? '?'} res=${kv.RES ?? '?'}` +
            (devices.length ? `\nadb 设备：\n  ${devices.join('\n  ')}` : ''),
        }
      } catch (e) {
        return { model: '', denied: false, text: '设备信息查询失败：' + String((e as Error).message) }
      }
    },
  })

  const actInput = defineTool({
    name: 'android_act_input',
    description:
      '输入事件（点按/滑动/按键/文本）：经真实 ADB 通道（adbd，shell uid）向设备注入输入——' +
      'F1.6 观察-动作-等待闭环的「动作」环节。需完整授权（门1/门2/门3）+ 会话档位 danger-full-access；' +
      '每次调用审计。文本仅允许可见 ASCII（空格转 %s，shell 元字符拒绝）；keycode 为 Android KeyEvent 码。',
    parameters: {
      action: { type: 'string', required: true, enum: ['tap', 'swipe', 'keyevent', 'text'], description: '输入动作类型' },
      x: { type: 'number', description: 'tap/swipe 起点 X' },
      y: { type: 'number', description: 'tap/swipe 起点 Y' },
      x2: { type: 'number', description: 'swipe 终点 X' },
      y2: { type: 'number', description: 'swipe 终点 Y' },
      duration: { type: 'number', description: 'swipe 时长 ms（默认 300）' },
      keycode: { type: 'number', description: 'keyevent 键码（如 26=电源、4=返回、3=主页）' },
      text: { type: 'string', description: 'text 要输入的文本（≤200 可见字符）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
          // D8：拒绝分支的通用信号——本工具此前是 13 个工具里唯一漏发的。
          denied: { type: 'boolean' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text') || '(no output)' },
      ],
    },
    execute: async (args: { action?: string; x?: number; y?: number; x2?: number; y2?: number; duration?: number; keycode?: number; text?: string }, exec) => {
      const a = await guard('act_input', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const cap = adbChannelOnly('act_input', exec as { agent?: { session?: unknown } })
      if (!cap.ok) return { ok: false, denied: true, text: cap.text }
      let line = ''
      switch (args.action) {
        case 'tap': {
          if (!Number.isInteger(args.x) || !Number.isInteger(args.y) || args.x! < 0 || args.y! < 0 || args.x! > 99999 || args.y! > 99999) {
            return { ok: false, text: 'tap 需要合法整数坐标 (x, y)' }
          }
          line = `tap ${args.x} ${args.y}`
          break
        }
        case 'swipe': {
          const nums = [args.x, args.y, args.x2, args.y2, args.duration ?? 300]
          if (!nums.slice(0, 4).every((n) => Number.isInteger(n) && n! >= 0 && n! <= 99999) || !Number.isInteger(nums[4]) || nums[4]! < 0 || nums[4]! > 60000) {
            return { ok: false, text: 'swipe 需要合法整数 (x, y, x2, y2[, duration])' }
          }
          line = `swipe ${nums.join(' ')}`
          break
        }
        case 'keyevent': {
          if (!Number.isInteger(args.keycode) || args.keycode! < 0 || args.keycode! > 255) {
            return { ok: false, text: 'keyevent 需要合法整数 keycode（0-255）' }
          }
          line = `keyevent ${args.keycode}`
          break
        }
        case 'text': {
          const raw = args.text ?? ''
          if (raw.length === 0 || raw.length > 200) return { ok: false, text: 'text 长度需为 1-200 字符' }
          // 仅可见 ASCII；shell 元字符拒绝；空格按 input text 约定转 %s
          if (!/^[\x20-\x7E]+$/.test(raw) || /[\\'"\`$;&|<>*?(){}[\]\n\r]/.test(raw)) {
            return { ok: false, text: 'text 仅允许可见 ASCII（不含 shell 元字符）' }
          }
          line = `text ${raw.replace(/ /g, '%s')}`
          break
        }
        default:
          return { ok: false, text: `未知 action: ${String(args.action)}` }
      }
      if (!priv.execAdbShell) return { ok: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbShell）' }
      const r = await priv.execAdbShell(`input ${line}`)
      if (!r.ok) return { ok: false, text: r.guidance ?? (r.stdout || '输入执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      return { ok: !errMark, text: errMark ? '输入执行返回异常：' + r.stdout.slice(0, 400) : `input 已注入（${args.action}${args.action === 'text' ? ': ' + String(args.text).slice(0, 40) : ''}）` }
    },
  })

  // ── ADB 2.0 Phase A（PRD-0.13.2 §3.2）：语义化控件清单 + 语义动作 ──────────

  // 最近一次 dump 缓存：android_ui_click/scroll 引用节点 id 无需重复 dump。
  // 引擎单进程内模块级缓存（n 值 ≤60，内存代价可忽略）。
  //
  // **TTL 必须远大于「模型读完清单再决定点哪里」的耗时**（0.14.0 模拟器实锤）。
  // 旧值 30s 太短：审计时间戳实测 dump→click 间隔 57s（模型要思考、比较、选目标），
  // 于是缓存先过期，工具回「没有可用的控件清单（缓存已失效）——请先执行 android_ui_dump 拿新 ref」，
  // 模型只好重新 dump、再思考、再过期——**陷入 dump/过期的死循环**（实测连续 6 轮）。
  //
  // 正确性不靠墙钟：页面若真变了，壳侧 `gen` 校验会明确回「控件清单已过期」；
  // 而墙钟无法区分「模型想得久」与「页面变了」，只会把前者误判成失效。
  // 故 TTL 只作为内存回收上限，放宽到 10 分钟。
  const UI_CACHE_TTL = 10 * 60_000
  let uiCache:
    | { nodes: UiNode[]; byId: ReturnType<typeof pruneNodes>['byId']; byOrig: ReturnType<typeof pruneNodes>['byOrig']; parentByOrig: ReturnType<typeof pruneNodes>['parentByOrig']; screen: { w: number; h: number }; rotation: number; ts: number; gen?: number; fingerprint?: string; rawCount?: number; v2?: V2Decoded }
    | null = null

  /** 明细文件目录（与截图/XML 同一个 dsh-tmp；LRU 按前缀清理，保留最近 20 份）。 */
  const detailDir = (): string => pruneTmp('ui-detail-', 20)

  /**
   * 发布两级披露的第二级（0.13.8 P2-13）：把全量节点表按**确定性句柄**（结构指纹）落盘，
   * 第一次调用给出一句「全量明细在哪」。节点数低于阈值时返回空提示——那种规模的清单
   * 默认渲染已经够全，多说一句只是噪音。
   */
  const DETAIL_HINT_MIN_NODES = 60
  const publishDetail = (
    nodes: UiNode[],
    meta: { gen: number; protocol: string; view: string; screen: { w: number; h: number }; rotation: number; rawCount: number },
  ): { handle: string; path: string; hint: string } => {
    const handle = treeFingerprint(nodes)
    let path = ''
    try {
      path = writeDetailStore(detailDir(), handle, nodes.map((n) => detailRecord(n)), { ...meta, count: nodes.length, handle })
    } catch {
      // 落盘失败绝不影响主结果（与上游 spill 的取向一致：落盘是尽力而为），但 D9：必须把模块级
      // 句柄一起清空——否则 android_ui_detail 仍握着上一轮的句柄/路径，模型会按旧句柄取到旧屏明细。
      detailHandle = ''
      detailPath = ''
      return { handle: '', path: '', hint: '' }
    }
    detailHandle = handle
    detailPath = path
    if (nodes.length < DETAIL_HINT_MIN_NODES) return { handle, path, hint: '' }
    return {
      handle,
      path,
      hint: `\n全量明细（${nodes.length} 节点逐字段，含完整文本/几何/祖先，可按需或离线 read/grep）：android_ui_detail all=true（句柄 ${handle}）`,
    }
  }

  /** 最近一次 dump 的明细句柄（两级披露取回时用；无 dump 时为空）。 */
  let detailHandle = ''
  let detailPath = ''

  /**
   * 0.13.8 P0-4：树结构指纹（FNV-1a）——「界面未变」快路径的判定依据。
   * 覆盖定位所需字段（文本/描述/类型/几何/交互性）；任一变化 → 指纹翻转 → 完整重抓。
   * 纯追加语义：指纹相同只回一行「未变」摘要，绝不改写历史结果（L1）。
   */
  const treeFingerprint = (nodes: UiNode[]): string => {
    let h = 0x811c9dc5
    for (const n of nodes) {
      const s = `${n.id}|${n.parentId}|${n.text}|${n.desc}|${n.rid}|${n.type}|${n.cx},${n.cy},${n.w},${n.h}|${n.clickable ? 1 : 0}${n.editable ? 1 : 0}${n.scrollable ? 1 : 0}${n.checked ? 1 : 0}${n.visible ? 1 : 0}`
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
      h ^= 0xff
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return 'fp' + h.toString(16).padStart(8, '0')
  }

  /**
   * 「界面未变」快路径（P0-4）：指纹一致直接回紧凑摘要，模型可复用上次引用。
   * D3：`gen` 只有在**确实是 number** 时才发键——`{type:'number'}` 收 null/undefined 都会整值拒绝，
   * 而含 undefined 成员的对象更不是 lossless JSON（引擎直接抛错）。
   */
  const unchangedResponse = (fp: string, gen?: number) => ({
    ok: true,
    denied: false,
    unchanged: true,
    screen: uiCache!.screen,
    rotation: uiCache!.rotation,
    count: uiCache!.nodes.length,
    rawCount: uiCache!.rawCount ?? uiCache!.nodes.length,
    nodes: [] as JsonValue[],
    ...(typeof gen === 'number' ? { gen } : {}),
    note: '界面未变（结构指纹一致）：上次 dump 的引用（n0..nN）与坐标仍然有效，可直接复用；需完整清单请带 fresh:true 重新 dump',
    text: `界面未变（gen=${gen ?? '未知'}，结构指纹 ${fp}）：上次 dump 的 ${uiCache!.nodes.length} 个节点引用仍有效——直接用 android_ui_click/id:nN 等引用继续，无需重新阅读清单（fresh:true 可强制完整重抓）`,
  })

  /** 0.13.5 W4：控制通道决策。策略面缺席（旧版 bridge）→ 按 ADB 通道处理，保持旧行为。 */
  const controlDecision = (op: string, exec?: { agent?: { session?: unknown } }) => {
    const session = exec?.agent?.session
    const decision = priv.controlDecision?.(op, session)
    return decision ?? { backend: 'adb' as const, reason: '控制策略面缺席（bridge 未提供 controlDecision）——按 ADB 通道处理' }
  }

  /**
   * 0.14 D5：ADB 专属工具的**就地提前能力门**（本迭代不新增控制 op）。
   *
   * 用 `forceBackend: 'adb'` 提问，三态放行/拒绝：'adb' 放行；'a11y' **也放行**——旧 bridge 不认
   * 第三个参数，无障碍开启时仍回 'a11y'，那不是「ADB 不可用」的证据；策略面缺席（旧装配）放行，
   * 保持旧行为。只有 'deny'（新 bridge 明确答「ADB 通道不可用」）才在动手之前拒绝——否则是
   * 「先放行再深处失败」，模型会反复真发起 adb 调用。不得用 gateFor().via 判定（a11y 与 ADB
   * 都在线时它也返回 a11y，据此判会误拒）。
   */
  const ADB_ONLY_ALTERNATIVE: Record<string, string> = {
    ui_tree: '改用 android_ui_dump（无障碍语义树，字段更全且无需配对）',
    app_launch: '手动从桌面/最近任务进入目标应用',
    env_prepare: '无障碍通道下动画与输入法这两项都不需要本工具',
    act_input: '点击/滚动/文本用 android_ui_click / android_ui_scroll / android_ui_input，按键类动作用 android_ui_global',
  }
  const adbChannelOnly = (tool: string, exec?: { agent?: { session?: unknown } }): { ok: true } | { ok: false; text: string } => {
    if (!priv.controlDecision) return { ok: true }
    const d = priv.controlDecision('snapshot', exec?.agent?.session, 'adb')
    if (d.backend !== 'deny') return { ok: true }
    return {
      ok: false,
      text: `本工具需要 ADB 通道（当前策略拒绝：${d.reason}）——替代路径：${ADB_ONLY_ALTERNATIVE[tool] ?? '见工具描述'}`
        + (d.guidance ? `；${d.guidance}` : ''),
    }
  }

  /**
   * 语义 op 失败时的统一出口（SPEC §4.2②）：
   *   - 若失败属于「通道受限、可改坐标」（bridge 回填 actionMode='coordinate'），
   *     则把它**结构化**带出（actionMode / screenId / guidance 三个字段），而不只是拼一句话；
   *   - 否则维持原有的「一句话 + denied:false」形态（不改变既有语义）。
   *
   * 为什么必须把 guidance 单独带出：模型按字段决定下一步。塞进 text 里它可能只当描述读过去，
   * 单独成字段 + schema 声明后，它在结构上就是「可执行的下一步」。
   */
  const semanticFail = (
    r: { error?: string; actionMode?: unknown; screenId?: unknown; guidance?: unknown },
    prefix: string,
  ): { ok: boolean; denied: boolean; text: string; actionMode?: string; screenId?: string; guidance?: string } => {
    const actionMode = typeof r.actionMode === 'string' ? r.actionMode : undefined
    const out: Record<string, unknown> = { ok: false, denied: false, text: prefix + (r.error ?? '未知失败') }
    if (actionMode !== undefined) out.actionMode = actionMode
    if (typeof r.screenId === 'string' && r.screenId !== '') out.screenId = r.screenId
    if (typeof r.guidance === 'string' && r.guidance !== '') out.guidance = r.guidance
    return out as { ok: boolean; denied: boolean; text: string; actionMode?: string; screenId?: string; guidance?: string }
  }

  /**
   * 从壳侧返回里取出屏幕三件套 + actionMode，**原样**附到工具返回值上（SPEC §4.2）。
   *
   * 为什么是「原样透传」而不是引擎推断：后端选择发生在壳侧（它才知道无障碍是否在线、
   * 目标屏是否有窗口），引擎侧再推断一遍就会出现两处真源、互相打架。壳侧 DeviceControlService
   * 对 REAL_SCREEN_OPS 逐条回填 screenId/displayId/scope/actionMode，这里只负责搬运。
   *
   * 缺省策略：壳侧未回填 actionMode 时**不编造**（不发键），让模型按「未知」处理；
   * 编一个 a11y 会让模型以为语义树可用而实际不可用（错误引导比缺失更糟）。
   */
  const screenOut = (data: unknown): Record<string, unknown> => {
    const d = (data ?? {}) as { screenId?: unknown; displayId?: unknown; scope?: unknown; actionMode?: unknown }
    const out: Record<string, unknown> = {}
    if (typeof d.screenId === 'string' && d.screenId !== '') out.screenId = d.screenId
    if (typeof d.displayId === 'number') out.displayId = d.displayId
    if (typeof d.scope === 'string' && d.scope !== '') out.scope = d.scope
    if (typeof d.actionMode === 'string' && d.actionMode !== '') out.actionMode = d.actionMode
    return out
  }

  /**
   * 纯 Shizuku（无障碍关）下虚拟屏的**坐标模式**结构化响应（SPEC §4.2）。
   *
   * 语义树只有无障碍通道可达；无障碍关时不该把「通道不可用」当硬错误抛给模型，
   * 而应给出 actionMode=coordinate + 可直接照做的引导（改用坐标操作），
   * 让模型在**同一轮**里继续推进任务，而不是停下来问用户。
   */
  const coordinateMode = (screenId: string, reason: string, guidance: string): Record<string, unknown> => ({
    ok: false,
    actionMode: 'coordinate',
    screenId,
    reason,
    guidance,
  })

  /** 0.13.5 W4：无障碍通道往返封装（统一错误文案，超时 8s）。 */
  const a11yExec = async (op: string, args: Record<string, unknown>, timeoutMs = 8000) => {
    if (!priv.controlExec) return { ok: false as const, error: '无障碍执行面未接通（bridge 未提供 controlExec）' }
    return priv.controlExec(op, args, timeoutMs)
  }

  /** 无障碍取树的壳侧载荷（与 uiautomator XML 的 RawNode 同构，复用同一剪枝/引用层）。 */
  interface A11ySnapshot {
    gen?: number
    rotation?: number
    screen?: { w: number; h: number }
    nodes?: Array<{ id: string; parentId: string; attrs: Record<string, string> }>
  }

  /** 公开 id → 原始路径 id（无障碍动作按路径回指壳侧节点）。 */
  const origPathOf = (publicId: string): string | undefined => uiCache?.byId.get(publicId)?.origPath

  /** resolveRef 的 V2 子树池（预序区间切片）；V1 缓存返回 undefined（走 origPath 前缀匹配）。 */
  const scopePoolFor = (): ((id: string) => UiNode[] | null) | undefined => {
    const v2 = uiCache?.v2
    return v2 ? (id: string) => scopePoolV2(v2, id) : undefined
  }

  /** 无障碍动作回指（§S5.1 DD-10）：V2 发 row（行句柄，壳侧零字符串解析）；V1 发 path（原始路径）。
   *  V2 下 byId 条目的 origPath 槽位承载行下标（见 protocol-v2.cacheFromV2）。 */
  const putTargetRefById = (payload: Record<string, unknown>, publicId: string): boolean => {
    const handle = origPathOf(publicId)
    if (handle === undefined || handle === '') return false
    if (uiCache?.v2) payload.row = Number(handle)
    else payload.path = handle
    return true
  }
  const putTargetRef = (payload: Record<string, unknown>, node: UiNode): boolean => putTargetRefById(payload, node.id)

  /** 祖先回退：V2 查表 O(1)（壳侧编码时已完成同一上溯，DD-8）；V1 走父链上溯（含跳过被剪层）。 */
  const actionableAncestorOf = (node: UiNode): UiNode | null => {
    const v2 = uiCache?.v2
    if (v2) return actionableAncestorV2(v2, node)
    if (!uiCache) return null
    return findActionableAncestor(uiCache.byId, uiCache.byOrig, uiCache.parentByOrig, node)
  }

  /**
   * 前台真值（现场实测教训 2026-09-10：uiautomator/a11y 可能抓到 DSH shell 覆盖层或错误的窗口，
   * `dumpsys` 的 mCurrentFocus / ResumedActivity 才是权威）。
   */
  async function foregroundInfo(): Promise<{ pkg: string; activity: string } | null> {
    if (!priv.execAdbLine) return null
    const r = await priv.execAdbLine(`adb shell dumpsys window | grep -m1 mCurrentFocus`)
    const m = /u0\s+([\w.]+)\/([\w.$]+)/.exec(r.ok ? r.stdout : '')
    if (m) return { pkg: m[1], activity: m[2] }
    const r2 = await priv.execAdbLine(`adb shell dumpsys activity activities | grep -m1 ResumedActivity`)
    const m2 = /([\w.]+)\/([\w.$]+)/.exec(r2.ok ? r2.stdout : '')
    return m2 ? { pkg: m2[1], activity: m2[2] } : null
  }

  /** F2 统一坐标系锚点：屏幕物理尺寸（wm size）。uiDump 缓存优先，否则现场查。 */
  async function screenSize(): Promise<{ w: number; h: number }> {
    if (uiCache && Date.now() - uiCache.ts <= UI_CACHE_TTL && uiCache.screen.w > 0) return uiCache.screen
    if (!priv.execAdbLine) return { w: 0, h: 0 }
    const s = await priv.execAdbLine(`adb shell wm size | grep -m1 'Physical size'`)
    const m = /Physical size:\s*(\d+)x(\d+)/.exec(s.ok ? s.stdout : '')
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 }
  }

  /** 语义清单渲染（模型侧文本；完整 JSON 在 return 里）。 */
  const nodeSummary = (nodes: UiNode[]): string => {
    const lines = nodes.slice(0, 8).map((n) => `  ${n.id} ${n.clickable ? '可点' : n.editable ? '可编辑' : n.scrollable ? '可滚动' : '文本'} "${(n.text || n.desc).slice(0, 24)}"`)
    return `共 ${nodes.length} 个节点（物化清单见本工具 JSON）：\n` + lines.join('\n') + (nodes.length > 8 ? '\n  …（其余见 JSON nodes）' : '')
  }

  const uiDump = defineTool({
    name: 'android_ui_dump',
    description:
      '【首选】导出当前界面语义控件清单（无障碍语义树优先，否则回退 uiautomator dump）。'
      + '产出结构化节点表（id/父id/文本/描述/类型/bounds/可点/可滚动/可编辑，不截断）；'
      + '界面未变时返回「未变」摘要（传 fresh:true 强制重抓）。'
      + '下一步用 android_ui_click / android_ui_input / android_ui_scroll；页面大幅变化后重新 dump。'
      + '需 danger-full-access；原始 XML 用 android_ui_tree。',
    parameters: {
      fresh: { type: 'boolean', description: 'true = 跳过「界面未变」快路径，强制完整重抓（默认 false）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          screen: { type: 'object', required: true, additionalProperties: false, properties: { w: { type: 'number' }, h: { type: 'number' } } },
          rotation: { type: 'number', required: true },
          count: { type: 'number', required: true },
          rawCount: { type: 'number', required: true },
          nodes: { type: 'array', required: true },
          // FX-204.1 + FX-204.2（B0，必须同批）：两条返回路径的键集合都必须在声明面内——
          // 完整抓取发 detailHandle/detailPath，未变快路径发 unchanged/gen。漏声明 = 引擎
          // validateJsonSchemaValue 有任一 violation 就整条 ToolOutputError，模型拿不到任何数据。
          detailHandle: { type: 'string', description: '本次 dump 全量明细的确定性句柄（android_ui_detail 取回用）' },
          detailPath: { type: 'string', description: '明细 JSONL 落盘路径（可离线 read/grep；落盘失败时为空串）' },
          unchanged: { type: 'boolean', description: 'true = 命中「界面未变」快路径：nodes 为空，上次 dump 的引用与坐标仍有效' },
          gen: { type: 'number', description: '壳侧快照代次（只在「界面未变」快路径返回；壳侧未报代次时整键不发）' },
          note: { type: 'string' },
          text: { type: 'string' },
          denied: { type: 'boolean' },
          // SPEC §4.2：屏幕三件套 + 动作模式（壳侧对真实屏 op 逐条回填）。
          screenId: SCREEN_ID_PROP,
          displayId: DISPLAY_ID_PROP,
          scope: SCOPE_PROP,
          actionMode: ACTION_MODE_PROP,
          guidance: GUIDANCE_PROP,
        },
      },
      // 0.13.5 W4：把节点清单**完整结构化**渲染进模型可见文本——模型看到的是 render 输出，
      // 不是 return 的 JSON。每行给足定位信息：父节点 + 类型 + resource-id + 文本/描述 + 完整 bounds
      // + 状态（用户拍板：语义树不截断、尽量完整暴露；协作轮反馈「最缺层级/区域归属」）。
      render: (_args, v: Record<string, unknown>) => {
        const nodes = Array.isArray(v.nodes) ? v.nodes as Array<Record<string, unknown>> : []
        // 同名/同描述节点**保留但标注序号**（#k，1 基，按 dump 顺序）——模型可用 text:X#k 精确引用；
        // 解析层对歧义一律拒绝而非静默挑选（见 ui-tree.resolveRef）。
        const dupCount = new Map<string, number>()
        for (const n of nodes) {
          const key = `${String(n.text || '').trim()}|${String(n.desc || '').trim()}`
          if (key === '|') continue
          dupCount.set(key, (dupCount.get(key) ?? 0) + 1)
        }
        const seenSoFar = new Map<string, number>()
        let prevPkg = ''
        let prevWin = ''
        const lines = nodes.map((n) => {
          const flags = [
            n.clickable ? '可点' : '',
            n.editable ? '可编辑' : '',
            n.scrollable ? '可滚动' : '',
            n.checked ? '已选中' : '',
            n.visible === false ? '不可见' : '',
          ].filter(Boolean).join('/')
          const type = String(n.type || '') || 'View'
          const rid = String(n.rid || '')
          const parent = String(n.parentId || '')
          const text = String(n.text || '').trim()
          const desc = String(n.desc || '').trim()
          const box = `${String(n.x ?? 0)},${String(n.y ?? 0)} ${String(n.w)}x${String(n.h)}`
          const depth = typeof n.depth === 'number' ? n.depth : 0
          const key = `${text}|${desc}`
          let occ = ''
          if (key !== '|' && (dupCount.get(key) ?? 0) > 1) {
            const k = (seenSoFar.get(key) ?? 0) + 1
            seenSoFar.set(key, k)
            occ = `#${k}`
          }
          const pkg = String(n.pkg || '')
          const win = String(n.windowId || '')
          const owner: string[] = []
          if (pkg !== '' && pkg !== prevPkg) { owner.push(`pkg=${pkg}`); prevPkg = pkg }
          if (win !== '' && win !== prevWin) { owner.push(`win=${win}`); prevWin = win }
          const parts = [
            '  '.repeat(Math.min(depth, 12)) + `${String(n.id)}`,
            parent ? `^${parent}` : '',
            `${type}${rid ? '#' + rid : ''}`,
            `[${flags || '静态'}]`,
            owner.join(' '),
            text ? `text="${text}"${occ}` : '',
            desc ? `desc="${desc}"` : '',
            !text && !desc ? '(无文本)' : '',
            `bounds=${box}`,
          ].filter(Boolean)
          return parts.join(' ')
        })
        return [{
          type: 'text',
          text: String(v.text ?? '') + (lines.length > 0 ? '\n' + lines.join('\n') : ''),
        }]
      },
    },
    execute: async (args, exec) => {
      const forceFresh = (args as { fresh?: boolean } | undefined)?.fresh === true
      // SPEC §4.2：screenId 透传进控制队列（缺省不发键 = 真实屏语义，与改造前一致）。
      const scoped = screenArgs(args)
      const targetScreen = typeof (args as { screenId?: unknown }).screenId === 'string'
        ? String((args as { screenId?: string }).screenId)
        : 'real'
      const a = await guard('ui_dump', (args ?? {}) as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: a.guidance }
      // 0.13.5 W4：无障碍通道优先（一次系统开关即用；不经 uiautomator，故不受 F1 idle 阻塞影响）
      if (controlDecision('snapshot', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        // 现场实测（2026-09-10 真机，B 站播放页）：重 UI/常驻动画页面建树慢，8s 默认超时频繁失败——
        // 这里给到 15s；仍失败则明确指引「先 android_ui_global back 退出重页面再 dump」。
        const r = await a11yExec('snapshot', { ...scoped }, 15_000)
        if (!r.ok) {
          // 通道受限（纯 Shizuku / 虚拟屏无窗口）时，壳侧会带 actionMode=coordinate + guidance：
          // 原样带出，让模型在同一轮改用坐标路径，而不是停在「取树失败」。
          return {
            ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [],
            ...screenOut(r),
            // 目标屏是虚拟屏时，坐标路径必须指向**真实存在**的工具（android_vdisplay_input），
            // 不要再把模型引到 android_ui_tree（ADB 面）——virtual-only 下那条路同样被范围拒绝。
            text: `无障碍取树失败：${r.error ?? '未知'}——重 UI/播放页常见；建议：① android_ui_global back 退回上一级再 dump；`
              + (targetScreen !== 'real'
                ? '② 纯 Shizuku 下虚拟屏改用 android_vdisplay_input（tap/swipe/keyevent/text，坐标基于该屏像素）；'
                  + '③ 或用 android_vdisplay_status 复核屏幕是否还在。'
                : '② 或 android_screenshot 直接看画面；③ ADB 已配对时用 android_ui_tree（uiautomator）。'),
          }
        }
        const data = (r.data ?? {}) as A11ySnapshot
        // 协议分流（§S4.3 兼容矩阵）：壳侧 V2 列式载荷（v=2）→ 解码为同形节点表 + 祖先/子树表；
        // 老壳侧（无 v）继续走 V1 剪枝路径——两条路产出的 UiNode 同形，下游零改动。
        let pruned: {
          nodes: UiNode[]
          byId: ReturnType<typeof pruneNodes>['byId']
          byOrig: ReturnType<typeof pruneNodes>['byOrig']
          parentByOrig: ReturnType<typeof pruneNodes>['parentByOrig']
          rawCount: number
        }
        let v2: V2Decoded | undefined
        if (isV2Payload(data)) {
          const dec = decodeV2(data)
          if (!dec.ok) {
            return {
              ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [],
              text: `无障碍载荷解码失败（协议 V2，拒绝产出不可信清单）：${dec.error}——请更新 APK，或改用 ADB 通道（android_ui_tree）`,
            }
          }
          v2 = dec.value
          const built = cacheFromV2(v2)
          pruned = { ...built, rawCount: v2.rawCount }
        } else {
          pruned = pruneNodes(data.nodes ?? [])
        }
        const fp = treeFingerprint(pruned.nodes)
        // 0.13.8 P0-4：「界面未变」快路径——结构指纹一致且缓存新鲜 → 纯追加一行摘要（L1）
        if (!forceFresh && uiCache && uiCache.fingerprint === fp && Date.now() - uiCache.ts <= UI_CACHE_TTL) {
          const gen = v2?.gen ?? data.gen ?? uiCache.gen
          // FX-206.3：壳侧每次建树都递增代次（buildSnapshot(force=true)），快路径若不推进
          // uiCache.gen/ts，下一个动作就带着旧 gen 被 requireFresh 拒（文案还误报「界面已变化」）。
          // 命中即续期：时间戳前移、代次对齐本次载荷。
          uiCache.ts = Date.now()
          if (typeof gen === 'number') uiCache.gen = gen
          if (v2) uiCache.v2 = v2
          return unchangedResponse(fp, gen)
        }
        // 0.14 D11：显式重建 screen——老壳 V1 载荷的 data.screen 可能多带键，按引用返回会让整条
        // dump 被 additionalProperties:false 拒绝（构造法可测；无老壳包可实测，见报告「需实测」）。
        const rawScreen = data.screen as { w?: unknown; h?: unknown } | undefined
        const rawW = Number(rawScreen?.w)
        const rawH = Number(rawScreen?.h)
        const screen = v2
          ? v2.screen
          : (Number.isFinite(rawW) && rawW > 0 ? { w: rawW, h: Number.isFinite(rawH) ? rawH : 0 } : { w: 0, h: 0 })
        uiCache = {
          nodes: pruned.nodes,
          byId: pruned.byId,
          byOrig: pruned.byOrig,
          parentByOrig: pruned.parentByOrig,
          screen,
          rotation: v2?.rotation ?? data.rotation ?? 0,
          ts: Date.now(),
          gen: v2?.gen ?? data.gen,
          fingerprint: fp,
          rawCount: pruned.rawCount,
          v2,
        }
        const fg = await foregroundInfo()
        const dumpPkg = pruned.nodes.find((n) => String(n.pkg || '') !== '')?.pkg ?? ''
        const mismatch = fg !== null && dumpPkg !== '' && fg.pkg !== dumpPkg
        const webNode = pruned.nodes.find((n) => /WebView/i.test(String(n.type || '')))
        const warn = mismatch
          ? `\n注意：dump 包名 ${dumpPkg} 与前台 ${fg!.pkg} 不一致——可能抓到覆盖层/错误窗口，以 dumpsys 为准。`
          : ''
        const webHint = webNode
          ? `\n检测到 WebView 容器 ${webNode.id}：其内部控件在本通道不可见。若目标是 DSH 自有 Web UI，改用 android_web_dump（DOM 快照，毫秒级、按选择器精准命中）；第三方网页仍只能靠坐标。`
          : ''
        const detail = publishDetail(pruned.nodes, {
          gen: v2?.gen ?? data.gen ?? -1,
          protocol: v2 ? 'v2' : 'v1',
          view: v2?.view ?? 'all',
          screen,
          rotation: v2?.rotation ?? data.rotation ?? 0,
          rawCount: pruned.rawCount,
        })
        return {
          ok: true,
          denied: false,
          screen,
          rotation: v2?.rotation ?? data.rotation ?? 0,
          count: pruned.nodes.length,
          rawCount: pruned.rawCount,
          nodes: pruned.nodes as unknown as JsonValue[],
          detailHandle: detail.handle,
          detailPath: detail.path,
          note: `无障碍通道（backend=a11y，协议 ${v2 ? 'V2 列式' : 'V1'}）：id 仅在最近一次 dump 内有效；页面变化后请重新 dump`,
          // FX-206.4：截断状态按壳侧载荷真值渲染（V2 带 truncated 列）；V1 载荷不带该信息，
          // 如实标「未知」而不是写死「未截断」——半棵树被说成完整比没有信息更危险。
          text: `控件清单（无障碍通道，${v2 ? (v2.truncated ? '已截断：壳侧建树预算耗尽，仅含部分子树，缺失区域请重新 dump' : '未截断') : '截断状态未知（V1 载荷不带该字段）'}）：${pruned.nodes.length} 个节点（原始 ${pruned.rawCount}，剔除 ${pruned.rawCount - pruned.nodes.length} 个零尺寸/完全重复节点，屏幕 ${screen.w}x${screen.h}；前台 ${fg?.pkg ?? '?'}/${fg?.activity ?? '?'}）`
            + warn + webHint + detail.hint,
        }
      }
      if (!priv.execAdbLine) return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      const n = Date.now()
      const remote = `/data/local/tmp/dsh-ui-${n}.xml`
      const local = join(pruneTmp('dsh-ui-', 10), `dsh-ui-${n}.xml`)
      try {
        // F1 止血：uiautomator dump 阻塞等待窗口 idle——音乐类 App 播放条常驻动画使事件流
        // 永不安静（"could not get idle state" 实锤）。dump 前关动画三开关，dump 后还原。
        const oldAnim = await readAnimScales()
        await setAnimScales('0')
        let r: { ok: boolean; stdout: string; guidance?: string }
        try {
          r = await priv.execAdbLine(
            `adb shell uiautomator dump ${remote}; adb pull ${remote} ${local} >/dev/null 2>&1; adb shell rm -f ${remote}; adb shell wm size | grep -m1 'Physical size'`,
          )
        } finally {
          await restoreAnimScales(oldAnim)
        }
        if (!r.ok) return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: r.guidance ?? (r.stdout || '控件清单导出失败') }
        if (!existsSync(local)) {
          return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: '控件树未落地（厂商 ROM 可能限制 uiautomator）：' + (r.stdout.trim().slice(-300) || '无输出') }
        }
        const xml = readFileSync(local, 'utf8')
        const parsed = parseUiTreeXml(xml)
        // 0.13.8 P0-2：结构自检——解析结果与源 XML 矛盾时响亮拒绝（错误树比没有树更危险）
        const check = checkUiTreeParse(xml, parsed.raw)
        if (!check.ok) {
          return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: '控件树解析自检失败（拒绝产出不可信清单）：' + check.reason }
        }
        const pruned = pruneNodes(parsed.raw)
        const fp = treeFingerprint(pruned.nodes)
        // 0.13.8 P0-4：同 a11y 分支——「界面未变」快路径
        if (!forceFresh && uiCache && uiCache.fingerprint === fp && Date.now() - uiCache.ts <= UI_CACHE_TTL) {
          uiCache.ts = Date.now()   // FX-206.3：同 a11y 分支，快路径必须推进时间戳（ADB 载荷不带代次）
          return unchangedResponse(fp, uiCache.gen)
        }
        const size = /Physical size:\s*(\d+)x(\d+)/.exec(r.stdout)
        const screen = size ? { w: Number(size[1]), h: Number(size[2]) } : { w: 0, h: 0 }
        // 0.14 D4（与注册同批）：ADB 完整抓取分支也必须落明细并回句柄，否则走 ADB 时
        // android_ui_detail 只有空句柄（a11y 分支在同位置已发）。
        const detail = publishDetail(pruned.nodes, {
          gen: -1,
          protocol: 'adb-xml',
          view: 'all',
          screen,
          rotation: parsed.rotation,
          rawCount: pruned.rawCount,
        })
        uiCache = {
          nodes: pruned.nodes,
          byId: pruned.byId,
          byOrig: pruned.byOrig,
          parentByOrig: pruned.parentByOrig,
          screen,
          rotation: parsed.rotation,
          ts: Date.now(),
          fingerprint: fp,
          rawCount: pruned.rawCount,
        }
        return {
          ok: true,
          denied: false,
          screen,
          rotation: parsed.rotation,
          count: pruned.nodes.length,
          rawCount: pruned.rawCount,
          // UiNode 全原始字段，JsonValue 转型安全（引擎 lossless-JSON 校验按 schema 逐字段验证）
          nodes: pruned.nodes as unknown as JsonValue[],
          detailHandle: detail.handle,
          detailPath: detail.path,
          note: 'id 仅在最近一次 dump 内有效；页面变化后请重新 dump',
          text: `控件清单（未截断）：${pruned.nodes.length} 个节点（原始 ${pruned.rawCount}，剔除 ${pruned.rawCount - pruned.nodes.length} 个零尺寸/完全重复节点，屏幕 ${screen.w}x${screen.h}）`
            + detail.hint,
        }
      } finally {
        try { rmSync(local, { force: true }) } catch { /* 清理失败忽略 */ }
      }
    },
  })

  const uiClick = defineTool({
    name: 'android_ui_click',
    description:
      '语义点击/长按：按 android_ui_dump 清单的引用点按控件。引用格式 id:n3 / text:精确文本 / desc:… / rid:…；裸数字按 id。' +
      '无控件树时用 nx/ny（0-1，相对物理屏；由截图像素换算 nx=x/截宽、ny=y/截高，工具层负责映射）。' +
      '虚拟屏坐标用 x/y 绝对像素 + screenId。目标不可点自动回退最近可点祖先；不在最近 dump 中返回引导。' +
      'longClick:true = 长按。需 danger-full-access；每次调用审计。',
    parameters: {
      ref: { type: 'string', description: '控件引用（id:n3 或 text:精确文本 等；与 nx/ny 二选一）' },
      nx: { type: 'number', description: '归一化 X（0-1，相对物理屏宽；= 截图内像素 x ÷ 截图宽）——无 ref 时使用' },
      ny: { type: 'number', description: '归一化 Y（0-1，相对物理屏高；= 截图内像素 y ÷ 截图高）——无 ref 时使用' },
      longClick: { type: 'boolean', description: 'true = 长按（ACTION_LONG_CLICK 优先，手势按住 600ms 兜底）' },
      x: { type: 'number', description: '绝对 X 像素（虚拟屏坐标模式用；需配 screenId）' },
      y: { type: 'number', description: '绝对 Y 像素（虚拟屏坐标模式用；需配 screenId）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ref: { type: 'string' },
          id: { type: 'string' },
          label: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string' },
          denied: { type: 'boolean' },
          screenId: SCREEN_ID_PROP,
          displayId: DISPLAY_ID_PROP,
          scope: SCOPE_PROP,
          actionMode: ACTION_MODE_PROP,
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? '') },
      ],
    },
    execute: async (args: { ref?: string; nx?: number; ny?: number; longClick?: boolean; screenId?: string; x?: number; y?: number }, exec) => {
      const { ref, nx, ny, longClick, x, y, screenId } = args ?? {}
      // 0.13.8 E6：长按走壳侧 longClick op（ACTION_LONG_CLICK 优先 + 手势按住兜底）
      const clickOp = longClick === true ? 'longClick' : 'click'
      const a = await guard('ui_click', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const useRef = typeof ref === 'string' && ref.trim().length > 0
      const useNorm =
        typeof nx === 'number' && Number.isFinite(nx) && nx >= 0 && nx <= 1 &&
        typeof ny === 'number' && Number.isFinite(ny) && ny >= 0 && ny <= 1
      const useAbs = typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
      if (!useRef && !useNorm && !useAbs) {
        return { ok: false, denied: false, text: '需要 ref（语义引用）、nx/ny（0-1 归一化）或 x/y（绝对像素，需配 screenId）三者之一' }
      }
      // **归一化坐标在虚拟屏上是歧义的，必须拒绝**（0.14.0 模拟器实锤的新缺陷）。
      //
      // 实测经过：模型对 virtual-1 传 nx/ny 想点虚拟屏上的「显示」，工具放行，但 nx/ny 由**壳侧按真实屏**
      // （900x1600）换算 → 实际注入 (203,1290)，于是：① 点在真实屏上；② 虚拟屏毫无变化，
      // 而返回文案却说「已点击」。模型据此以为点击成功、继续 dump 却看不到变化，陷入反复重试。
      //
      // 归一化的分母是「哪块屏」这件事在参数里表达不出来（nx/ny 没有携带屏幕尺寸），
      // 所以对非 real 屏只能拒绝并指向**无歧义的 x/y**（像素基于该屏自身）。宁可明确拒绝，
      // 也不要「静默点到别的屏」——后者比拒绝难排查得多。
      if (useNorm && !useRef && !useAbs && typeof screenId === 'string' && screenId !== '' && screenId !== 'real') {
        return {
          ok: false, denied: false,
          text: '在 ' + screenId + ' 上不能用 nx/ny：归一化按哪块屏换算存在歧义（壳侧会按真实屏算，实际点到真屏上）。'
            + '请改用 x/y（绝对像素，基于 ' + screenId + ' 自身尺寸；可先 android_vdisplay_status 看该屏宽高），或先用 android_ui_dump 拿 ref。',
        }
      }
      // 虚拟屏「坐标模式」的真实执行面（0.14.0 用户实报修复）。
      //
      // 缺陷形态：桥给模型的指引是「纯 Shizuku 下改用 x/y + screenId」，但壳侧 `click` op 只认
      // ref/nx/ny，`/system/bin/input` 也没有屏幕维度——**指引指向一条不存在的路**。
      // 现在 x/y + screenId 走壳侧 vdInput（`input -d <displayId>`），坐标基于该虚拟屏自身像素。
      if (useAbs && typeof screenId === 'string' && screenId !== '' && screenId !== 'real') {
        const vd = await priv.controlExec?.('vdInput', {
          verb: longClick === true ? 'swipe' : 'tap',
          x: Math.round(x!), y: Math.round(y!),
          ...(longClick === true ? { x2: Math.round(x!), y2: Math.round(y!), duration: 600 } : {}),
          target: screenId,
        }, 15_000)
        const data = ((vd?.ok === true ? vd.data : {}) ?? {}) as { ok?: boolean; guidance?: string; displayId?: number; screenId?: string }
        if (vd?.ok !== true || data.ok === false) {
          return {
            ok: false, denied: false, x, y,
            text: '虚拟屏坐标点击失败：' + (data.guidance ?? (vd?.ok === true ? '壳侧拒绝' : vd?.error))
              + '——请先用 android_vdisplay_status 确认虚拟屏存在。',
          }
        }
        return {
          ok: true, denied: false,
          ref: '', id: 'abs(' + Math.round(x!) + ',' + Math.round(y!) + ')', label: '虚拟屏坐标',
          x: typeof data.displayId === 'number' ? data.displayId : 0, y: 0,
          ...screenOut(data),
          text: data.guidance ?? ('已在 ' + screenId + ' 注入坐标点击 (' + Math.round(x!) + ',' + Math.round(y!) + ')'),
        }
      }
      // #128 L1：WebView DOM 引用（wN / css: / text: / role:）走自有 WebView 通道，
      // 不依赖无障碍虚拟树，也不需要坐标。
      if (useRef) {
        const webRef = ref!.trim()
        // 0.13.8 P0-6（D8）：只有显式 css:/role:/wN 才走自有 WebView DOM 通道——
        // text: 曾被无条件劫持到本通道，原生页面 text: 必然失败且报错指向 WebView。
        // text:/desc:/rid: 一律走快照模型（resolveRef 的 text 分支恢复可达）。
        const isWebRef = /^w\d+$/.test(webRef) || webRef.startsWith('css:') || webRef.startsWith('role:')
        if (isWebRef) {
          const payload: Record<string, unknown> = { op: 'click' }
          if (/^w\d+$/.test(webRef)) payload.ref = webRef
          else if (webRef.startsWith('css:')) payload.sel = webRef.slice(4).trim()
          else if (webRef.startsWith('text:')) payload.text = webRef.slice(5).trim()
          else payload.role = webRef.slice(5).trim()
          const wr = await a11yExec('webAction', payload, 8000)
          if (!wr.ok) return { ok: false, denied: false, text: 'WebView 点击失败：' + wr.error }
          const wd = (wr.data ?? {}) as { ok?: boolean; error?: string; via?: string; target?: { tag?: string; text?: string } }
          if (wd.ok === false) return { ok: false, denied: false, text: 'WebView 点击失败：' + (wd.error ?? '未知') }
          // beforeGen 传 undefined：手里只有**配置代次**（uiCache.gen，恒定如 fp0c052e71），
          // 与壳侧快照代次不同源，拿它比对必然假报「未变化」（坑 138）。
          // 宁可如实报「未能确认」，也不给模型一个错误的「点击失败」结论。
          const verdict = await verifyClick(undefined, exec as ExecLike)
          return {
            ok: true,
            denied: false,
            ref: webRef,
            id: webRef,
            label: (wd.target?.text ?? '').slice(0, 24),
            x: 0,
            y: 0,
            text: `已在 WebView 内点击 ${wd.target?.tag ?? ''}「${(wd.target?.text ?? '').slice(0, 24)}」（DOM 通道 via=${wd.via ?? 'ref'}）；${verdict}`,
          }
        }
      }
      // 0.13.5 W4：无障碍通道优先。坐标由壳侧用**它自己的屏幕尺寸**换算——
      // 工具层不再需要屏幕尺寸，也就不会因「dump 缓存过期」把 nx/ny 点击误拒（实机踩坑）。
      if (controlDecision('click', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        // 块G F3：payload 必须带 screenId——此分支此前是裸 `{}`，门按 virtual-N 放行、执行却落真实屏，
        // 模型看到「点了但画面没变」比直接拒绝更难排查（同 ui_dump 的双修口径）。
        const payload: Record<string, unknown> = { ...screenArgs(args) }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (useRef) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
            return { ok: false, denied: false, text: '没有可用的控件清单（缓存已失效）——请先执行 android_ui_dump 拿新 ref' }
          }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, ref!.trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, text: hit.error }
          let node = hit.node
          if (!node.clickable && !node.editable && !node.scrollable) {
            const anc = actionableAncestorOf(node)
            if (!anc) return { ok: false, denied: false, text: `目标「${(node.text || node.desc).slice(0, 20)}」不可点击且无可用祖先——考虑滚动或重新 dump` }
            node = anc
          }
          // FX-206.2：与其余 4 处一致走公共封装——V2 发 row（载荷行下标经 o 列映射回原始行号），
          // V1 才发 path。就地发 path 会把行号当成根的子下标解析（点错 / 假性「路径已不存在」）。
          if (!putTargetRefById(payload, node.id)) {
            return { ok: false, denied: false, text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
          }
          const r = await a11yExec(clickOp, payload)
          if (!r.ok) return semanticFail(r, '无障碍点击失败：')
          const clicked = (r.data ?? {}) as { x?: number; y?: number; via?: string }
          // beforeGen 传 undefined：手里只有**配置代次**（uiCache.gen，恒定如 fp0c052e71），
          // 与壳侧快照代次不同源，拿它比对必然假报「未变化」（坑 138）。
          // 宁可如实报「未能确认」，也不给模型一个错误的「点击失败」结论。
          const verdict = await verifyClick(undefined, exec as ExecLike)
          return {
            ok: true, denied: false, ref: ref!.trim(), id: node.id,
            label: (node.text || node.desc).slice(0, 24),
            x: clicked.x ?? node.cx, y: clicked.y ?? node.cy,
            text: `已点击 ${node.id}「${(node.text || node.desc).slice(0, 24)}」（无障碍通道 ${clicked.via ?? 'performAction'}，`
              + `坐标 ${Math.round(clicked.x ?? node.cx)},${Math.round(clicked.y ?? node.cy)}）；${verdict}`,
          }
        }
        payload.nx = nx
        payload.ny = ny
        const r = await a11yExec(clickOp, payload)
        if (!r.ok) return semanticFail(r, '无障碍点击失败：')
        const clicked = (r.data ?? {}) as { x?: number; y?: number; via?: string }
        // beforeGen 传 undefined：我们手里只有**配置代次**（uiCache.gen），与壳侧
        // 快照代次不同源，拿它比对必然假报「未变」（坑 138）。宁可如实报「未能确认」。
        const verdict = await verifyClick(undefined, exec as ExecLike)
        return {
          ok: true, denied: false, ref: '', id: `norm(${nx!.toFixed(3)},${ny!.toFixed(3)})`, label: '归一化坐标',
          x: clicked.x ?? 0, y: clicked.y ?? 0,
          text: `已按归一化坐标 (${nx!.toFixed(3)},${ny!.toFixed(3)}) 点击（无障碍通道，实际坐标 `
            + `${Math.round(clicked.x ?? 0)},${Math.round(clicked.y ?? 0)}）；${verdict}`,
        }
      }
      let cx = 0; let cy = 0; let hitId = ''; let label = ''
      if (useRef) {
        if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
          return { ok: false, denied: false, text: '没有可用的控件清单（缓存已失效）——请先执行 android_ui_dump 拿新 ref' }
        }
        const hit = resolveRef(uiCache.byId, uiCache.nodes, ref!.trim(), scopePoolFor())
        if (!hit.ok) return { ok: false, denied: false, text: hit.error }
        let node = hit.node
        if (!node.clickable && !node.editable && !node.scrollable) {
          const anc = actionableAncestorOf(node)
          if (!anc) return { ok: false, denied: false, text: `目标「${(node.text || node.desc).slice(0, 20)}」不可点击且无可用祖先——考虑滚动或重新 dump` }
          node = anc
        }
        cx = node.cx; cy = node.cy; hitId = node.id; label = (node.text || node.desc).slice(0, 24)
      } else {
        // 0-1 归一化坐标：无障碍通道从最近一次快照取屏幕尺寸（不依赖 ADB）
        const size = uiCache && Date.now() - uiCache.ts <= UI_CACHE_TTL && uiCache.screen.w > 0
          ? uiCache.screen
          : await screenSize()
        if (!size.w || !size.h) return { ok: false, denied: false, text: '屏幕尺寸未知（无障碍通道需先 android_ui_dump；ADB 通道需 wm size）——请先 dump 或改用 ref' }
        cx = Math.round(nx! * size.w); cy = Math.round(ny! * size.h)
        hitId = `norm(${nx!.toFixed(3)},${ny!.toFixed(3)})`
        label = '归一化坐标'
      }
      // 0.13.5 W4：无障碍通道优先（语义 performAction；不经 input tap 坐标）
      if (controlDecision('click', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const payload: Record<string, unknown> = { ...screenArgs(args) }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (useRef) {
          if (!putTargetRefById(payload, hitId)) return { ok: false, denied: false, text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        } else {
          payload.nx = nx
          payload.ny = ny
        }
        const r = await a11yExec(clickOp, payload)
        if (!r.ok) return semanticFail(r, '无障碍点击失败：')
        return {
          ok: true,
          denied: false,
          ref: useRef ? ref!.trim() : '',
          id: hitId,
          label,
          x: cx,
          y: cy,
          text: `已点击 ${hitId}「${label}」（无障碍通道）——建议重新 dump 验证`,
        }
      }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      const r = await priv.execAdbShell(`input tap ${cx} ${cy}`)
      if (!r.ok) return { ok: false, denied: false, text: r.guidance ?? (r.stdout || '点击执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      return {
        ok: !errMark,
        denied: false,
        ref: useRef ? ref!.trim() : '',
        id: hitId,
        label,
        x: cx,
        y: cy,
        text: errMark
          ? '点击返回异常：' + r.stdout.slice(0, 300)
          : `已点击 ${hitId}「${label}」(${cx},${cy})${useRef ? '——建议重新 dump 验证' : '（归一化坐标）'}`,
      }
    },
  })

  const uiScroll = defineTool({
    name: 'android_ui_scroll',
    description:
      '语义滚动：按控件引用（可选）或屏幕方向滚动。有 ref 时在节点 bounds 内滑动；' +
      '无 ref 时按屏幕尺寸滑动。direction: up/down/left/right；fraction 为滑动比例（默认 0.6）。' +
      '需 dump 提供屏幕尺寸；无缓存时自动查 wm size。需设备控制授权（无障碍服务已开启，或 ADB 三道门齐备）+ 会话档位 danger-full-access。',
    parameters: {
      ref: { type: 'string', description: '控件引用（滚动容器；可选）' },
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'] },
      fraction: { type: 'number', description: '滑动比例（0.1-1.0，默认 0.6）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          from: { type: 'array', items: { type: 'number' } },
          to: { type: 'array', items: { type: 'number' } },
          text: { type: 'string' },
          denied: { type: 'boolean' },
          screenId: SCREEN_ID_PROP,
          displayId: DISPLAY_ID_PROP,
          scope: SCOPE_PROP,
          actionMode: ACTION_MODE_PROP,
          guidance: GUIDANCE_PROP,
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? (v.guidance as string | undefined) ?? '') },
      ],
    },
    execute: async (args: { ref?: string; direction?: string; fraction?: number; screenId?: string }, exec) => {
      const a = await guard('ui_scroll', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const dir = args.direction === 'left' || args.direction === 'right' ? args.direction : args.direction === 'up' || args.direction === 'down' ? args.direction : ''
      if (!dir) return { ok: false, denied: false, text: `未知方向：${String(args.direction)}` }
      const frac = Math.min(Math.max(args.fraction ?? 0.6, 0.1), 1.0)
      // 0.13.5 W4：无障碍通道优先（ACTION_SCROLL_* 语义滚动；无坐标 swipe）
      if (controlDecision('scroll', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const payload: Record<string, unknown> = { direction: dir, fraction: frac, ...screenArgs(args) }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (args.ref) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) return { ok: false, denied: false, from: [], to: [], text: '没有可用的控件清单（缓存已失效）——请先执行 android_ui_dump 拿新 ref' }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, String(args.ref).trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, from: [], to: [], text: hit.error }
          if (!putTargetRef(payload, hit.node)) return { ok: false, denied: false, from: [], to: [], text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        }
        const r = await a11yExec('scroll', payload)
        if (!r.ok) return { ...semanticFail(r, '无障碍滚动失败：'), from: [], to: [] } as never
        return { ok: true, denied: false, from: [], to: [], text: `已向 ${dir} 滚动（无障碍通道，fraction=${frac}）——建议重新 dump 验证` }
      }
      // D7：ADB 面检查必须在 a11y 分支**之后**——a11y 分支的所有路径都已 return，而它在只开无障碍、
      // 未配对 ADB 的部署下根本不需要 adb（此前挡在前面 → 语义滚动被误判成「ADB 执行通道未接通」）。
      if (!priv.execAdbLine || !priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      // 屏幕尺寸：缓存优先（dump 附带），无缓存现场查
      let screen = uiCache && Date.now() - uiCache.ts <= UI_CACHE_TTL ? uiCache.screen : null
      if (!screen || screen.w === 0) {
        const s = await priv.execAdbLine(`adb shell wm size | grep -m1 'Physical size'`)
        const m = /Physical size:\s*(\d+)x(\d+)/.exec(s.ok ? s.stdout : '')
        screen = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 2400 }
      }
      // 滑动区域：有 ref 取节点 bounds；否则全屏
      let area = { x1: 0, y1: 0, x2: screen.w, y2: screen.h }
      if (args.ref) {
        if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
          return { ok: false, denied: false, text: 'ref 滚动需要最近的 android_ui_dump 缓存' }
        }
        const hit = resolveRef(uiCache.byId, uiCache.nodes, args.ref, scopePoolFor())
        if (!hit.ok) return { ok: false, denied: false, text: hit.error }
        const n = hit.node
        area = { x1: n.cx - Math.floor(n.w / 2), y1: n.cy - Math.floor(n.h / 2), x2: n.cx + Math.floor(n.w / 2), y2: n.cy + Math.floor(n.h / 2) }
      }
      const sx = area.x1 + Math.floor((area.x2 - area.x1) / 2)
      const sy = area.y1 + Math.floor((area.y2 - area.y1) / 2)
      let from: [number, number]; let to: [number, number]
      if (dir === 'up' || dir === 'down') {
        const dy = Math.floor((area.y2 - area.y1) * frac)
        from = [sx, dir === 'up' ? area.y2 - Math.floor(dy / 2) : area.y1 + Math.floor(dy / 2)]
        to = [sx, dir === 'up' ? from[1] - dy : from[1] + dy]
      } else {
        const dx = Math.floor((area.x2 - area.x1) * frac)
        from = [dir === 'left' ? area.x2 - Math.floor(dx / 2) : area.x1 + Math.floor(dx / 2), sy]
        to = [dir === 'left' ? from[0] - dx : from[0] + dx, sy]
      }
      const r = await priv.execAdbShell(`input swipe ${from[0]} ${from[1]} ${to[0]} ${to[1]} 300`)
      if (!r.ok) return { ok: false, denied: false, text: r.guidance ?? (r.stdout || '滑动执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      return {
        ok: !errMark,
        denied: false,
        from,
        to,
        text: errMark ? '滑动返回异常：' + r.stdout.slice(0, 300) : `已滑动（${dir} ${Math.round(frac * 100)}%）——建议重新 dump 验证`,
      }
    },
  })

  const uiInput = defineTool({
    name: 'android_ui_input',
    description:
      '语义文本输入：向当前聚焦输入框注入文本。默认走 ADBKeyboard 广播（input text 在部分 ROM 丢字/丢空格——F5 实锤），' +
      '含自动 IME 引导：探测当前输入法、临时切到内嵌 ADB 输入通道、注入后还原。' +
      'clear: true 先原子清空聚焦框（全选+删除，可单独使用）。channel: "input" 可强制走 input text（仅 ASCII，不推荐）。' +
      '长度 ≤500。需设备控制授权（无障碍服务已开启，或 ADB 三道门齐备）+ 会话档位 danger-full-access。',
    parameters: {
      text: { type: 'string', description: '要输入的文本（≤500 字符；与 clear 至少其一）' },
      clear: { type: 'boolean', description: '先清空当前聚焦输入框（ADBKeyboard ADB_CLEAR_TEXT 广播；可单独使用）' },
      channel: { type: 'string', enum: ['auto', 'adbkeyboard', 'input'], description: '输入通道（默认 auto=ADBKeyboard 优先）' },
      ref: { type: 'string', description: '无障碍通道的目标输入框引用（id:n3 / text:… / desc:…；缺省用当前聚焦框）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          channel: { type: 'string' },
          text: { type: 'string' },
          denied: { type: 'boolean' },
          screenId: SCREEN_ID_PROP,
          displayId: DISPLAY_ID_PROP,
          scope: SCOPE_PROP,
          actionMode: ACTION_MODE_PROP,
          guidance: GUIDANCE_PROP,
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? (v.guidance as string | undefined) ?? '') },
      ],
    },
    execute: async (args: { text?: string; clear?: boolean; channel?: string; ref?: string; screenId?: string }, exec) => {
      const { text, clear, channel, ref, screenId } = args ?? {}
      const a = await guard('ui_input', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const raw = typeof text === 'string' ? text : ''
      if (!clear && (raw.length === 0 || raw.length > 500)) return { ok: false, denied: false, text: 'text 长度需为 1-500，或传 clear: true 单独清空' }
      // #128 L1：WebView DOM 引用（wN / css: / text: / role:）→ 自有 WebView 通道直接写值
      // （原生 value setter + input/change 事件，兼容 React 受控组件），不经 IME、不会汉字化。
      const webRef = typeof ref === 'string' ? ref.trim() : ''
      // 0.13.8 P0-6（D8）：同 ui_click——text: 不再劫持进 DOM 通道，走快照模型。
      const isWebRef = /^w\d+$/.test(webRef) || webRef.startsWith('css:') || webRef.startsWith('role:')
      if (isWebRef) {
        const payload: Record<string, unknown> = { op: 'setText', value: raw }
        if (/^w\d+$/.test(webRef)) payload.ref = webRef
        else if (webRef.startsWith('css:')) payload.sel = webRef.slice(4).trim()
        else if (webRef.startsWith('text:')) payload.text = webRef.slice(5).trim()
        else payload.role = webRef.slice(5).trim()
        const wr = await a11yExec('webAction', payload, 8000)
        if (!wr.ok) return { ok: false, denied: false, channel: 'web', text: 'WebView 输入失败：' + wr.error }
        const wd = (wr.data ?? {}) as { ok?: boolean; error?: string; via?: string; value?: string; target?: { text?: string } }
        if (wd.ok === false) return { ok: false, denied: false, channel: 'web', text: 'WebView 输入失败：' + (wd.error ?? '未知') }
        return {
          ok: true,
          denied: false,
          channel: 'web',
          text: `已在 WebView 内写入「${(wd.value ?? raw).slice(0, 40)}」（DOM 通道 via=${wd.via ?? 'ref'}，目标 ${(wd.target?.text ?? '').slice(0, 20)}）`,
        }
      }
      // 0.13.5 W4：无障碍通道优先（ACTION_SET_TEXT 原子写入——绕开 IME 切换与丢字问题 F5）
      if (controlDecision('setText', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const payload: Record<string, unknown> = { text: raw, clear: clear === true, ...screenArgs(args) }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (typeof ref === 'string' && ref.trim().length > 0) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) return { ok: false, denied: false, channel: 'a11y', text: '没有可用的控件清单（缓存已失效）——请先执行 android_ui_dump 拿新 ref' }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, ref.trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, channel: 'a11y', text: hit.error }
          if (!putTargetRef(payload, hit.node)) return { ok: false, denied: false, channel: 'a11y', text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        }
        const r = await a11yExec('setText', payload)
        if (!r.ok) return { ...semanticFail(r, '无障碍输入失败：'), channel: 'a11y' } as never
        const act = [clear ? '已清空' : '', raw ? `已输入 ${raw.slice(0, 24)}${raw.length > 24 ? '…' : ''}` : ''].filter(Boolean).join(' + ')
        return { ok: true, denied: false, channel: 'a11y', text: `${act}（无障碍通道 setText）` }
      }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      const wantKb = channel !== 'input'
      const IME_ID = 'com.dsharnessmobile.shell/.AdbKeyboardService'
      if (wantKb) {
        // ADBKeyboard 协议：am broadcast -a ADB_INPUT_TEXT / ADB_CLEAR_TEXT --es msg <文本>。
        // 本应用 0.13.2 起内嵌同协议 IME。F5 修复：ime enable 只入列不生效（广播被静默丢弃）——
        // 探测当前默认 IME → 临时 ime set 切到本通道 → 注入 → 还原原 IME（借道不劫持）。
        const cur = await priv.execAdbShell(`settings get secure default_input_method`).catch(() => ({ ok: false, stdout: '' }))
        const prev = (cur.ok ? cur.stdout : '').trim().replace(/^"|"$/g, '')
        await priv.execAdbShell(`ime enable ${IME_ID}`).catch(() => undefined)
        const needSwitch = prev.length > 0 && prev !== IME_ID
        if (needSwitch) await priv.execAdbShell(`ime set ${IME_ID}`).catch(() => undefined)
        // 0.13.8 #183：键盘广播来源校验 nonce——壳侧私有文件（DSH_FILES_DIR），引擎与壳
        // 同 uid 可读，随广播 --es auth 携带；API 34+ 壳侧另有 sentFromUid 白名单兜底。
        const authArg = adbKeyboardAuthArg()
        const parts: string[] = []
        if (clear) parts.push(`am broadcast -a ADB_CLEAR_TEXT${authArg}`)
        if (raw) parts.push(`am broadcast -a ADB_INPUT_TEXT${authArg} --es msg '${raw.replace(/'/g, `'\\''`)}'`)
        let r: { ok: boolean; stdout: string; guidance?: string } = { ok: true, stdout: '' }
        for (const p of parts) {
          r = await priv.execAdbShell(p)
          if (!r.ok) break
        }
        // 现场实测（2026-09-10）：`input text` 偶发丢尾字符、中文 IME 可能把字母汉字化——
        // 注入后**回读断言**（壳侧 nodeText 读聚焦框，便宜），不一致自动重试一次。
        // 块G F3：回读必须带目标屏——否则壳侧按真实屏读聚焦框，校验与注入不在同一块屏上，
        // 会假报「输入未落地」（模型据此重试或改道，实际输入早已成功）。
        const nodeTextArgs = { ...screenArgs(args) }
        let readBack: string | null = null
        if (r.ok && raw.length > 0) {
          const read = async (): Promise<string | null> => {
            const nt = await a11yExec('nodeText', { ...nodeTextArgs }, 4000)
            if (!nt.ok) return null
            const d = (nt.data ?? {}) as { text?: string }
            return d.text ?? ''
          }
          await new Promise((resolve) => setTimeout(resolve, 260))
          readBack = await read()
          if (readBack !== null && readBack !== raw) {
            await priv.execAdbShell(`am broadcast -a ADB_CLEAR_TEXT${authArg}`).catch(() => undefined)
            await priv.execAdbShell(`am broadcast -a ADB_INPUT_TEXT${authArg} --es msg '${raw.replace(/'/g, `'\\''`)}'`).catch(() => undefined)
            await new Promise((resolve) => setTimeout(resolve, 320))
            readBack = await read()
          }
        }
        // 还原用户原 IME（广播已被接收器入队提交，留 0.4s 提交窗口防切换竞态）。
        if (needSwitch) await priv.execAdbShell(`sleep 0.4; ime set ${prev}`).catch(() => undefined)
        if (!r.ok) return { ok: false, denied: false, channel: 'adbkeyboard', text: r.guidance ?? (r.stdout || 'ADBKeyboard 输入失败') }
        if (readBack !== null && raw.length > 0 && readBack !== raw) {
          return {
            ok: false,
            denied: false,
            channel: 'adbkeyboard',
            text: `输入未落地：期望「${raw.slice(0, 30)}」，回读实际「${readBack.slice(0, 30)}」——`
              + '已自动重试一次仍不一致；建议：确认目标输入框处于聚焦态后重试，或改用 android_web_dump + ref=wN（自有 Web UI），'
              + '纯 ASCII 也可试 channel:"input"',
          }
        }
        const act = [clear ? '已清空' : '', raw ? `已输入 ${raw.slice(0, 24)}${raw.length > 24 ? '…' : ''}` : ''].filter(Boolean).join(' + ')
        const verifyNote = readBack === null ? '' : '，回读一致'
        return {
          ok: true,
          denied: false,
          channel: 'adbkeyboard',
          text: `${act}（ADBKeyboard${needSwitch ? '，IME 已临时切换并还原' : ''}${verifyNote}）`,
        }
      }
      // input text 兜底（channel: "input" 强制；仅可见 ASCII——部分 ROM 丢字/丢空格，F5 不推荐）
      const asciiOnly = /^[\x20-\x7E]+$/.test(raw)
      if (!asciiOnly) return { ok: false, denied: false, text: 'input text 仅允许可见 ASCII（中文等请走默认 ADBKeyboard 通道）' }
      if (/[\\'"\`$;&|<>*?(){}[\]\n\r]/.test(raw)) return { ok: false, denied: false, text: 'text 含 shell 元字符' }
      if (clear) await priv.execAdbShell(`input keyevent 123`).catch(() => undefined) // 123=MOVE_END；长文本清空建议 clear + ADBKeyboard
      const r = await priv.execAdbShell(`input text ${raw.replace(/ /g, '%s')}`)
      if (!r.ok) return { ok: false, denied: false, channel: 'input', text: r.guidance ?? (r.stdout || '输入执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      return { ok: !errMark, denied: false, channel: 'input', text: errMark ? '输入返回异常：' + r.stdout.slice(0, 300) : `已输入 ${raw.slice(0, 24)}${raw.length > 24 ? '…' : ''}（input text）` }
    },
  })

  /** #128 L1：WebView DOM 快照节点（与壳侧 webSnapshot 回包同形）。 */
  type WebNode = {
    ref: string
    sel?: string
    tag?: string
    role?: string
    text?: string
    editable?: boolean
    disabled?: boolean
    inView?: boolean
    bounds?: number[]
  }

  /** D10：壳侧 DOM 快照的声明字段白名单——只透出 output.schema 声明过的键，其余一律丢弃。 */
  const WEB_NODE_FIELDS = ['ref', 'sel', 'tag', 'role', 'text', 'editable', 'disabled', 'inView', 'bounds'] as const
  const mapWebNode = (n: WebNode): WebNode => {
    const src = n as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of WEB_NODE_FIELDS) {
      const v = src[k]
      if (v !== undefined && v !== null) out[k] = v
    }
    return out as WebNode
  }

  /**
   * #128 L1：DSH 自有 WebView 的 DOM 语义快照（毫秒级、按选择器精准命中，不依赖无障碍虚拟树）。
   * 第三方应用的 WebView 不属于本通道（不是我们的页面）。
   */
  const webDump = defineTool({
    name: 'android_web_dump',
    description:
      '【WebView 专用，首选】导出 DSH 自有 Web UI（WebView 页面）的 DOM 语义快照：每个可交互元素给 '
      + 'ref（wN，可直接用于 android_ui_click / android_ui_input）/ CSS 选择器 / role / 文本 / bounds / 可编辑 / 是否在视口内。'
      + '解决「无障碍树只看到一个 WebView 容器、内部控件不可见」的问题（issue #128）。'
      + '仅对 DSH 自己的 Web UI 有效；第三方 App 的网页仍用 android_ui_dump + 坐标。',
    parameters: {
      root: { type: 'string', description: '可选：限定根选择器（CSS），默认整页' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          denied: { type: 'boolean' },
          count: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                sel: { type: 'string' },
                tag: { type: 'string' },
                role: { type: 'string' },
                text: { type: 'string' },
                editable: { type: 'boolean' },
                disabled: { type: 'boolean' },
                inView: { type: 'boolean' },
                bounds: { type: 'array', items: { type: 'number' } },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? '(no output)') },
      ],
    },
    execute: async (args: { root?: string; screenId?: string }, exec) => {
      const { root } = args ?? {}
      const a = await guard('web_dump', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, count: 0, nodes: [] as WebNode[], text: a.guidance }
      // 注意：本工具读的是**壳自有 WebView**（DSH 自己的 Web UI），不是设备屏幕，
      // 故**不带 screenId**——加了只会让模型误以为它可以被投到虚拟屏上。
      const r = await a11yExec('webSnapshot', { ...(root ? { root } : {}) }, 8000)
      if (!r.ok) return { ok: false, denied: false, count: 0, nodes: [] as WebNode[], text: 'WebView DOM 快照失败：' + r.error }
      const data = (r.data ?? {}) as {
        ok?: boolean; error?: string; url?: string; title?: string; vw?: number; vh?: number
        scrollY?: number; total?: number; nodes?: WebNode[]
      }
      if (data.ok === false) {
        return { ok: false, denied: false, count: 0, nodes: [] as WebNode[], text: 'WebView DOM 快照失败：' + (data.error ?? '未知') }
      }
      // D10：返回前按声明字段白名单映射——壳侧多带一个未声明键就会让整条 web_dump 被
      // additionalProperties:false 整值拒绝（声明面与实现面一致，不放宽 items 的 additionalProperties）。
      const nodes = (data.nodes ?? []).map(mapWebNode)
      const lines = nodes.map((n) => {
        const flags = [n.disabled === true ? '禁用' : '', n.editable === true ? '可编辑' : '', n.inView === false ? '视口外' : ''].filter(Boolean).join('/')
        return `  ${String(n.ref)} ${String(n.role || n.tag || '')}${flags ? '[' + flags + ']' : ''} "${String(n.text ?? '').slice(0, 40)}" sel=${String(n.sel ?? '')}`
      })
      return {
        ok: true,
        denied: false,
        count: nodes.length,
        // D6：可选字段按 typeof 判定——undefined/null 一律整键不发（{type:'string'} 收 null 同样整值拒绝）。
        ...(typeof data.url === 'string' ? { url: data.url } : {}),
        ...(typeof data.title === 'string' ? { title: data.title } : {}),
        nodes: nodes as WebNode[],
        text: `WebView DOM 快照：${data.title ?? ''} ${data.url ?? ''}（视口 ${data.vw ?? '?'}x${data.vh ?? '?'}，滚动 ${data.scrollY ?? 0}；`
          + `命中 ${data.total ?? nodes.length} 个可交互元素，返回 ${nodes.length} 个）\n` + lines.join('\n')
          + '\n点击用 ref=wN，或 css:<选择器> / text:<文本> / role:<role>。',
      }
    },
  })

  /**
   * 环境一次性准备（现场实测建议先跑）：关动画让 dump/tap 后界面立即稳定；
   * 启用内嵌 ADBKeyboard 协议输入法，治「中文 IME 把字母汉字化 / input text 丢尾字符」。
   */
  const envPrepare = defineTool({
    name: 'android_env_prepare',
    description:
      '设备环境一次性准备（现场实测推荐在长流程开始前跑一次）：① 关闭三项系统动画（dump/tap 后界面立即稳定，减少等待）；'
      + '② 启用内嵌 ADBKeyboard 协议输入法 com.dsharnessmobile.shell/.AdbKeyboardService（中文 IME 汉字化/丢字的治本手段）。'
      + 'restore=true 时恢复动画（输入法不还原）；setImeDefault=true 时把该输入法设为默认（会改变用户全局输入法，谨慎）。'
      + '需 ADB 授权或无障碍通道。',
    parameters: {
      animations: { type: 'boolean', description: '是否处理动画（默认 true）' },
      ime: { type: 'boolean', description: '是否启用内嵌输入法（默认 true）' },
      restore: { type: 'boolean', description: 'true = 恢复动画默认值（1）而不是关闭' },
      setImeDefault: { type: 'boolean', description: 'true = 同时设为默认输入法（默认 false，仅启用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.text ?? '') }],
    },
    execute: async (
      { animations = true, ime = true, restore = false, setImeDefault = false }: { animations?: boolean; ime?: boolean; restore?: boolean; setImeDefault?: boolean },
      exec,
    ) => {
      const a = await guard('env_prepare', { animations, ime, restore, setImeDefault }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const cap = adbChannelOnly('env_prepare', exec as { agent?: { session?: unknown } })
      if (!cap.ok) return { ok: false, denied: true, text: cap.text }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通（本工具需要 adb shell；无障碍通道无法改系统设置）' }
      const lines: string[] = []
      // D5：任一子步骤未执行成功必须显式说明（此前无论成败都以「环境准备完成」收尾 = 假成功）。
      const notDone: string[] = []
      if (animations) {
        if (restore) {
          await restoreAnimScales({})
          lines.push('动画：已恢复默认（1）')
        } else {
          await setAnimScales('0')
          // 回读验证：写失败被 setAnimScales 吞掉，只有读回才能证明「已关闭」。
          const now = await readAnimScales()
          if (ANIM_KEYS.every((k) => now[k] === '0')) {
            lines.push('动画：已关闭（window/transition/animator 三项 = 0）')
          } else {
            notDone.push('动画未关闭生效（读回 ' + ANIM_KEYS.map((k) => `${k}=${now[k] ?? '?'}`).join(', ') + '）')
          }
        }
      }
      if (ime) {
        const IME_ID = 'com.dsharnessmobile.shell/.AdbKeyboardService'
        const en = await priv.execAdbShell(`ime enable ${IME_ID}`)
        const list = await priv.execAdbShell(`ime list -s | grep -c dsharnessmobile`)
        const enabled = list.ok && Number.parseInt(list.stdout.trim(), 10) > 0
        if (!enabled) {
          notDone.push('输入法未启用（请在「设置 → 系统 → 语言与输入法」里手动启用「DSH 设备键盘」后重试'
            + (list.stdout.trim() ? `；ime list 返回 ${list.stdout.trim().slice(0, 80)}` : '') + '）')
        } else if (setImeDefault) {
          const cur = await priv.execAdbShell(`settings get secure default_input_method`)
          const prev = (cur.ok ? cur.stdout : '').trim().replace(/^"|"$/g, '')
          const set = await priv.execAdbShell(`ime set ${IME_ID}`)
          lines.push(`输入法：已启用并设为默认（原默认 ${prev || '?'}；如需还原：ime set ${prev || '<原输入法>' }）`)
          if (!set.ok) notDone.push('输入法设为默认失败（' + (set.stdout || '').slice(0, 120) + '）')
        } else {
          lines.push(`输入法：已启用（${IME_ID}）；android_ui_input 会在注入时临时切换并在结束后还原，无需设为默认`)
        }
        if (!en.ok) notDone.push('ime enable 返回异常（' + (en.stdout || '').slice(0, 120) + '）')
      }
      const body = lines.concat(notDone.map((s) => '未成功：' + s))
      if (notDone.length > 0) {
        return {
          ok: false, denied: false,
          text: '环境准备未完成（有子步骤未执行成功——不要假设动画/输入法已就绪）：\n- ' + body.join('\n- '),
        }
      }
      return { ok: true, denied: false, text: '环境准备完成：\n- ' + body.join('\n- ') }
    },
  })

  /** 拉起应用（现场实测每次都要手写 monkey；包名由 pm list packages 先查）。 */
  const appLaunch = defineTool({
    name: 'android_app_launch',
    description:
      '按包名拉起应用并回报前台 Activity。默认落真实屏；要开到虚拟屏必须传 screenId="virtual-N"（见 android_screen_list）。'
      + '包名先用 android_device_info 或 pm list packages 查。',
    parameters: {
      pkg: { type: 'string', required: true, description: '应用包名（如 com.netease.cloudmusic）' },
      waitMs: { type: 'number', description: '拉起后等待毫秒数（默认 2500）' },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          denied: { type: 'boolean' },
          pkg: { type: 'string' },
          foreground: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.text ?? '') }],
    },
    execute: async (args: { pkg: string; waitMs?: number; screenId?: string }, exec) => {
      const { pkg, waitMs = 2500, screenId } = args
      const a = await guard('app_launch', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, pkg, text: a.guidance }
      // 跨屏拉起（0.14.0 用户实报补齐）：指定虚拟屏时不能走 `monkey -p`——那条命令没有屏幕维度，
      // 永远落在真实屏上。改经 vdLaunchApp（壳侧 Shizuku + `--display <id>`，argv 全由原生构造）。
      if (typeof screenId === 'string' && screenId !== '' && screenId !== 'real') {
        const vd = await (priv.controlExec?.('vdLaunchApp', { pkg, target: screenId }, 30_000)
          ?? Promise.resolve({ ok: false as const, error: 'vdisplay-control-unavailable' }))
        const data = (vd.ok ? (vd.data ?? {}) : {}) as { ok?: boolean; code?: string; guidance?: string; displayId?: number; screenId?: string }
        if (vd.ok !== true || data.ok === false) {
          return {
            ok: false, denied: false, pkg,
            text: '跨屏拉起失败：' + (data.guidance ?? (vd.ok ? '壳侧拒绝' : vd.error))
              + '——若虚拟屏尚未建立，先用 android_vdisplay_create；仅需真实屏拉起时不要传 screenId。',
          }
        }
        return {
          ok: true, denied: false, pkg,
          foreground: '',
          text: data.guidance ?? ('已在 ' + screenId + ' 上拉起 ' + pkg),
        }
      }
      const cap = adbChannelOnly('app_launch', exec as { agent?: { session?: unknown } })
      if (!cap.ok) return { ok: false, denied: true, pkg, text: cap.text }
      if (!/^[a-zA-Z][\w.]*$/.test(pkg)) return { ok: false, denied: false, pkg, text: '包名不合法：' + pkg }
      if (!priv.execAdbShell) return { ok: false, denied: false, pkg, text: 'ADB 执行通道未接通' }
      const r = await priv.execAdbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
      if (!r.ok) return { ok: false, denied: false, pkg, text: r.guidance ?? (r.stdout || '拉起失败') }
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(waitMs, 8000))))
      const fg = await foregroundInfo()
      const matched = fg !== null && fg.pkg === pkg
      // 兜底可发现性（0.14.0 设备实录）：模型漏传 screenId 时，本机可能恰好有活跃虚拟屏，
      // 于是「拉起来但不在虚拟屏上」成了它看不到的误判前提。真实屏拉起成功不是错，但必须把
      // 「你还有另一种选择、以及怎么用」当场告诉它——这比让它事后读文档可靠得多。
      // 只在确有活跃虚拟屏时追加，避免无谓把每次真实屏拉起都变长（wire 预算是输出面，不冲突）。
      const activeAlias = await activeVirtualAlias()
      const hint = activeAlias === null
        ? ''
        : `（注意：本机有活跃虚拟屏 ${activeAlias}；若要它出现在虚拟屏上，请带 screenId="${activeAlias}" 重新拉起）`
      return {
        ok: true,
        denied: false,
        pkg,
        foreground: fg ? `${fg.pkg}/${fg.activity}` : '',
        text: `已拉起 ${pkg}；前台 ${fg ? `${fg.pkg}/${fg.activity}` : '未知'}` + (matched ? '' : `（前台不是目标包——可能被权限弹窗/其他窗口遮挡，请 android_ui_dump 核对）`) + hint,
      }
    },
  })

  /**
   * 全局动作（无障碍通道，无需 ADB）：返回 / 主页 / 最近任务 / 通知栏。
   * 现场实测缺口（2026-09-10 真机）：AI 在子菜单里出不来——此前没有任何工具能按返回键，
   * `android_act_input keyevent` 又依赖 ADB 通道（未配对即不可用）。
   */
  const uiGlobal = defineTool({
    name: 'android_ui_global',
    description:
      '【首选】系统级动作（无障碍通道，不需要 ADB），取值见 action 枚举。'
      + '卡在子菜单/弹窗/详情页出不来时，第一步就用 back。'
      + '可用集由系统 getSystemActions() 决定，不可用者返回可用清单（不会静默无效果）。'
      + '需 danger-full-access。',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['back', 'home', 'recents', 'notifications', 'quickSettings', 'toggleSplitScreen', 'powerDialog',
          'lockScreen', 'takeScreenshot', 'menu', 'mediaPlayPause', 'dismissNotificationShade', 'accessibilityShortcut'],
        description: '要执行的全局动作（可用集由系统决定，不可用会回可用清单）',
      },
      screenId: SCREEN_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          denied: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.text ?? '') }],
    },
    execute: async (args: { action: string; screenId?: string }, exec) => {
      const { action } = args
      const a = await guard('ui_global', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, action, text: a.guidance }
      const GLOBAL_ACTIONS = ['back', 'home', 'recents', 'notifications', 'quickSettings', 'toggleSplitScreen',
        'powerDialog', 'lockScreen', 'takeScreenshot', 'menu', 'mediaPlayPause', 'dismissNotificationShade', 'accessibilityShortcut']
      if (!GLOBAL_ACTIONS.includes(action)) {
        return { ok: false, denied: false, action, text: `action 必须是 ${GLOBAL_ACTIONS.join(' / ')}` }
      }
      const r = await a11yExec('global', { action, ...screenArgs(args) }, 6000)
      if (!r.ok) {
        return { ok: false, denied: false, action, text: `全局动作 ${action} 失败：${r.error}（无障碍通道不可用时，改用 android_act_input keyevent，但那条路需要 ADB 配对）` }
      }
      const d = (r.data ?? {}) as { global?: string }
      return {
        ok: true,
        denied: false,
        action,
        text: `已执行全局动作 ${d.global ?? action}`
          + (action === 'back' ? '（返回上一级；页面已变化，请重新 dump 再定位）' : '')
          + (action === 'home' ? '（已回桌面）' : ''),
      }
    },
  })

  // 0.14 D4：uiDetail 此前 defineTool 了但没进注册数组（死代码，而提示文案还在引导模型调用）。
  return [screenList, screenshot, uiTree, deviceInfo, actInput, uiDump, uiClick, uiScroll, uiInput, webDump, envPrepare, appLaunch, uiGlobal, uiDetail]
}

export function apply(ctx: Context, _config: Record<string, unknown> = {}) {
  const priv = (ctx as unknown as { androidPrivilege?: PrivilegeFace }).androidPrivilege
  if (!priv) {
    ctx.logger?.('dsh-android-manage')?.warn?.('androidPrivilege 服务缺失：dsh-android-bridge 未装配——管理工具将全部失败关闭')
  }
  const face: PrivilegeFace = priv ?? {
    gateFor: () => ({ ok: false, guidance: '授权桥（dsh-android-bridge）未装配' }),
    audit: () => {},
  }
  for (const t of tools(ctx, face)) ctx.tools.register(t)
}
