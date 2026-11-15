import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderNativeImage, runNativeImage, type NativeImageDelivery, type NativeImageReceipt } from './native-image-delivery.js'
import { createPhoneControlBridge, type PhoneControlBridge, type NativeControlOperation } from './native-bridge.js'

export const name = 'dsh-android-phone-control'
export const inject = ['tools', 'sessions', 'sandboxPolicy'] as const

type Operation = NativeControlOperation
type Reply = Record<string, unknown>
type ModelResult = Record<string, JsonValue> & { ok: boolean; executed: 'yes' | 'no' | 'unknown' }
type Exec = {
  signal?: AbortSignal
  agent?: {
    session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    options?: { provider?: string; model?: string }
  }
}

const screen = { type: 'string', required: true, description: '目标屏幕 ID，由 android_screen_list 返回。' } as const
const ref = { type: 'string', description: '当前 UI 树中的节点引用。' } as const
const coordinate = { type: 'integer', description: '目标屏幕的逻辑坐标。' } as const
const requiredCoordinate = { ...coordinate, required: true } as const
const output = {
  schema: { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true }, code: { type: 'string' },
    executed: { type: 'string', enum: ['yes', 'no', 'unknown'] }, screenId: { type: 'json' },
    tree: { type: 'json' }, data: { type: 'json' }, scope: { type: 'string' }, screens: { type: 'array' },
    device: { type: 'json' }, channels: { type: 'json' }, operations: { type: 'array' },
  } },
  render: (_args: unknown, result: Reply) => [{ type: 'text' as const, text: JSON.stringify(result) }],
} as const
const imageOutput = {
  ...output,
  schema: { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true }, executed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    screenId: { type: 'json' }, denied: { type: 'boolean' }, imagePath: { type: 'string' },
    width: { type: 'number' }, height: { type: 'number' }, region: { type: 'json' }, native: { type: 'json' },
    image: { type: 'json' }, preview: { type: 'json' }, text: { type: 'string' }, error: { type: 'json' },
  } },
  render: (_args: unknown, result: Reply) => renderNativeImage(result as unknown as NativeImageDelivery) as never,
} as const

export function apply(ctx: Context) {
  registerPhoneControlTools(ctx, createPhoneControlBridge(ctx))
}

export function registerPhoneControlTools(ctx: Context, bridge: PhoneControlBridge) {
  if (!bridge?.nativeControlCapabilities || !bridge.nativeControlExecute) {
    throw new Error('dsh-android-phone-control requires the native shell bridge')
  }
  const native = bridge
  function argsWithoutScreen(raw: { screenId: string } & Reply) {
    const { screenId, ...args } = raw
    return { screenId, args: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) }
  }
  function invoke(operation: Operation, raw: { screenId: string } & Reply, exec: Exec) {
    const { screenId, args } = argsWithoutScreen(raw)
    if (typeof args.ref === 'string' && /^w[a-f0-9]+_[0-9]+$/.test(args.ref) &&
        ['click', 'longClick', 'setText', 'scroll'].includes(operation)) {
      const { ref, text, clear, direction } = args
      const payload = Object.fromEntries(Object.entries({ action: operation, ref, text, clear, direction })
        .filter(([, value]) => value !== undefined))
      return native.nativeControlExecute('webAction', '', payload, exec.agent?.session, exec.signal)
    }
    return native.nativeControlExecute(operation, screenId, args, exec.agent?.session, exec.signal)
  }
  function settle(result: Reply, includeTree = false): ModelResult {
    const { ok, code, executed, screenId, tree, data } = result
    return {
      ok: ok === true, code: typeof code === 'string' ? code : 'native-result-unavailable',
      executed: executed === 'yes' || executed === 'no' ? executed : 'unknown',
      screenId: typeof screenId === 'string' ? screenId : null,
      ...(ok === true && includeTree && tree && typeof tree === 'object' ? { tree: tree as JsonValue } : {}),
      ...((ok === true || executed === 'yes') && !includeTree && data && typeof data === 'object' ? { data: data as JsonValue } : {}),
    }
  }
  async function image(operation: 'screenshot' | 'readRegion', raw: { screenId: string } & Reply, exec: Exec) {
    type Options = Parameters<typeof runNativeImage>[1]
    const config = exec.agent?.session?.requestHeader?.()?.config
    const options: Options = {
      attachments: ctx.get('attachments') as Options['attachments'],
      llm: ctx.get('llm') as Options['llm'],
      route: { provider: config?.provider ?? exec.agent?.options?.provider,
        model: config?.model ?? exec.agent?.options?.model, signal: exec.signal },
    }
    const result = await runNativeImage(raw.screenId, options, async () =>
      await invoke(operation, raw, exec) as unknown as NativeImageReceipt)
    return result as unknown as ModelResult
  }

  for (const tool of [
    defineTool({
      name: 'android_screen_list', description: '列出手机控制识别的屏幕和当前访问范围。',
      parameters: {}, output,
      execute: async (_args, exec) => {
        const { ok, code, scope, screens } = await native.nativeControlCapabilities((exec as Exec).agent?.session, exec.signal)
        return { ok: ok === true, code: typeof code === 'string' ? code : 'native-facts-unavailable',
          ...(typeof scope === 'string' ? { scope } : {}),
          ...(Array.isArray(screens) ? { screens: screens as JsonValue[] } : {}) }
      },
    }),
    defineTool({
      name: 'android_ui_dump', description: '读取目标屏幕的 UI 树。游戏和一些特殊软件无法读取 UI 树。',
      parameters: { screenId: screen }, output,
      execute: async (args: { screenId: string }, exec) => settle(await invoke('snapshot', args, exec as Exec), true),
    }),
    defineTool({
      name: 'android_ui_click', description: '点击或长按指定节点、屏幕坐标。',
      parameters: { screenId: screen, ref, x: coordinate, y: coordinate, long: { type: 'boolean' } }, output,
      execute: async ({ long, ...args }: { screenId: string; ref?: string; x?: number; y?: number; long?: boolean }, exec) =>
        settle(await invoke(long ? 'longClick' : 'click', args, exec as Exec)),
    }),
    defineTool({
      name: 'android_ui_input', description: '写入文本或发送一个按键，二选一。空文本并替换可清空输入框。',
      parameters: { screenId: screen, ref: {...ref, description: '文本输入的节点引用；按键使用目标屏当前焦点。'},
        text: { type: 'string' }, clear: { type: 'boolean', description: '替换现有文本，默认开启。' },
        key: { type: 'string', enum: ['enter', 'tab', 'escape', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right', 'back'] } },
      output,
      execute: async (args: { screenId: string; ref?: string; text?: string; clear?: boolean; key?: string }, exec) =>
        settle(await invoke(args.key === undefined ? 'setText' : 'keyEvent', args, exec as Exec)),
    }),
    defineTool({
      name: 'android_ui_scroll', description: '按方向滚动指定节点或屏幕位置。',
      parameters: { screenId: screen, ref, x: coordinate, y: coordinate,
        direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'] } },
      output,
      execute: async (args: { screenId: string; ref?: string; x?: number; y?: number; direction: string }, exec) =>
        settle(await invoke('scroll', args, exec as Exec)),
    }),
    defineTool({
      name: 'android_ui_swipe', description: '在目标屏幕的两个实际坐标之间滑动。',
      parameters: { screenId: screen, x1: requiredCoordinate, y1: requiredCoordinate,
        x2: requiredCoordinate, y2: requiredCoordinate, durationMs: {type: 'integer', description: '50 到 2000 毫秒，默认 300。'} }, output,
      execute: async (args: {screenId: string; x1: number; y1: number; x2: number; y2: number; durationMs?: number}, exec) =>
        settle(await invoke('swipe', args, exec as Exec)),
    }),
    defineTool({
      name: 'android_ui_global', description: '执行返回、回主屏幕等系统动作。',
      parameters: { screenId: screen, action: { type: 'string', required: true } }, output,
      execute: async (args: { screenId: string; action: string }, exec) => settle(await invoke('global', args, exec as Exec)),
    }),
    defineTool({
      name: 'android_screenshot', description: '截取目标屏幕，直接返回一张图和实际屏幕尺寸。',
      parameters: { screenId: screen }, output: imageOutput,
      execute: (args: { screenId: string }, exec) => image('screenshot', args, exec as Exec),
    }),
    defineTool({
      name: 'android_read_region', description: '按屏幕实际坐标截取一个矩形区域并直接返回图像。',
      parameters: { screenId: screen, x1: requiredCoordinate, y1: requiredCoordinate,
        x2: requiredCoordinate, y2: requiredCoordinate },
      output: imageOutput,
      execute: (args: { screenId: string; x1: number; y1: number; x2: number; y2: number }, exec) =>
        image('readRegion', args, exec as Exec),
    }),
  ]) ctx.tools.register(tool)

  ctx.tools.register(defineTool({
    name: 'android_device_info', description: '读取设备型号、Android 版本和当前屏幕信息。', parameters: {}, output,
    execute: async (_args, exec) => {
      const result = await native.nativeControlCapabilities((exec as Exec).agent?.session, exec.signal)
      return {ok: result.ok === true && result.device != null,
        code: result.device != null ? 'device-info' : 'device-info-unavailable',
        ...(result.device != null ? {device: result.device as JsonValue} : {}),
        ...(Array.isArray(result.screens) ? {screens: result.screens as JsonValue[]} : {})}
    },
  }))
  ctx.tools.register(defineTool({
    name: 'android_privilege_status', description: '按需查看手机控制权限与可用能力。', parameters: {}, output,
    execute: async (_args, exec) => {
      const result = await native.nativeControlCapabilities((exec as Exec).agent?.session, exec.signal)
      return {ok: result.ok === true, code: typeof result.code === 'string' ? result.code : 'capabilities-unavailable',
        ...(typeof result.scope === 'string' ? {scope: result.scope} : {}),
        ...(result.channels != null ? {channels: result.channels as JsonValue} : {}),
        ...(Array.isArray(result.operations) ? {operations: result.operations as JsonValue[]} : {})}
    },
  }))
  ctx.tools.register(defineTool({
    name: 'android_ui_detail', description: '读取当前 UI 树中一个节点的文本。',
    parameters: { screenId: screen, ref: { ...ref, required: true } }, output,
    execute: async (args: { screenId: string; ref: string }, exec) => settle(await invoke('nodeText', args, exec as Exec)),
  }))
  ctx.tools.register(defineTool({
    name: 'android_web_dump', description: '读取 DSH 自有页面的 DOM 内容。',
    parameters: { root: { type: 'string', description: '可选的根元素选择器。' } }, output,
    execute: async (args: { root?: string }, exec) => settle(await invoke('webSnapshot', { screenId: '', ...args }, exec as Exec)),
  }))

  // The native registry decides availability at each model step. Conditions share only this
  // step's promise; executions always obtain fresh native admission and never reuse permission.
  type Activation = { agent: { session?: unknown }; signal: AbortSignal }
  const observations = new WeakMap<object, Promise<Reply>>()
  const when = (operation: Operation) => async (context: Activation) => {
    let facts = observations.get(context)
    if (!facts) {
      facts = native.nativeControlCapabilities(context.agent.session, context.signal)
      observations.set(context, facts)
    }
    const result = await facts
    return result.ok === true && Array.isArray(result.operations) &&
      (result.operations.includes(operation) || (operation === 'vdLaunchApp' && result.operations.includes('launchApp')))
  }
  for (const [operation, name, description] of [
    ['shExec', 'android_shell_exec', '使用已授权的 Shizuku 执行只读系统查询。屏幕动作使用统一屏幕工具。'],
    ['rootExec', 'android_root_exec', '使用独立授权的 Root 通道执行命令。'],
    ['termuxExec', 'android_termux_channel_exec', '在应用自有的 Termux 环境执行命令。'],
  ] as const) {
    ctx.tools.register(defineTool({
      name, description, output,
      parameters: { command: { type: 'string', required: true, description: '要执行的命令。' } },
      execute: async (args: { command: string }, exec) => settle(await invoke(operation, { ...args, screenId: '' }, exec as Exec)),
    }), { when: when(operation) })
  }
  ctx.tools.register(defineTool({
    name: 'android_env_prepare', description: '临时关闭系统动画，或恢复此前数值。',
    parameters: {restore: {type: 'boolean'}}, output,
    execute: async (args: {restore?: boolean}, exec) => settle(await invoke('prepareEnvironment', {...args, screenId: ''}, exec as Exec)),
  }), {when: when('prepareEnvironment')})
  for (const [operation, name, description, extra] of [
    ['vdCreate', 'android_vdisplay_create', '创建或复用虚拟屏幕。', {
      width: { type: 'integer' }, height: { type: 'integer' }, densityDpi: { type: 'integer' },
    }],
    ['vdDestroy', 'android_vdisplay_destroy', '销毁指定虚拟屏幕。', {}],
    ['vdInfo', 'android_vdisplay_status', '查看虚拟屏幕状态。', {}],
    ['vdLaunchApp', 'android_app_launch', '在指定屏幕打开应用。', {
      pkg: { type: 'string', required: true },
    }],
  ] as const) {
    ctx.tools.register(defineTool({
      name, description, parameters: { screenId: screen, ...extra }, output,
      execute: async (args: { screenId: string } & Reply, exec) => settle(await invoke(
        operation === 'vdLaunchApp' && args.screenId === 'real' ? 'launchApp' : operation, args, exec as Exec)),
    }), { when: when(operation) })
  }
}
