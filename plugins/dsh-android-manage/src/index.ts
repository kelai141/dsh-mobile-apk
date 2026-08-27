/**
 * dsh-android-manage — 手机管理工具面（PRD F1.6）
 *
 * 定位：以 ADB（安卓调试桥）优先的观察-动作-等待-再观察闭环；工具经授权会话执行，
 * 按可用权限自动降级（未授权 → 失败关闭：返回引导，不静默降级、不绕行）。
 *
 * 首版工具集（全部经 ctx.androidPrivilege 前置校验 + 审计）：
 *  - android_screenshot      截屏（接既有视觉链路读图；授权通道执行 screencap）
 *  - android_ui_tree         控件树导出（uiautomator dump，像素边界/坐标/可点属性为主源）
 *  - android_device_info     设备与屏幕信息 + 前台应用（dumpsys 为只读面）
 *  - android_act_input       输入事件（点按/滑动/按键/文本）——高风险动作类，主屏审批前不执行
 *
 * 边界声明（PRD F1.6）：仅操作已授权设备；不做账号接管/验证码/支付/绕过风控；
 * 不隐藏 ADB 或自动化信号。敏感操作（截图/界面树）默认提供脱敏选项（文本脱敏摘要模式）。
 *
 * 执行通道说明：本版经 ctx.androidPrivilege 状态机与审计面落地（桥执行实现随壳侧 adbShell 原语
 * 就绪后接通）；未授权时全部工具返回引导——与 PRD "未授权时全部失败关闭" 语义一致。
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const name = 'dsh-android-manage'
// androidPrivilege 由 dsh-android-bridge 在 apply 时经 ctx.provide 注册；
// cordis 代理对未 inject 的非注册属性读取会抛错（"cannot get property without inject"），
// 故必须显式 inject；加载顺序由装配行保证（android-bridge 在 android-manage 前）。
export const inject = ['tools', 'webServer', 'androidPrivilege'] as const

interface PrivilegeFace {
  /** 会话级授权门（引擎级授权 && 会话档位 danger-full-access——**观察类同为隐私敏感面**）。 */
  gateFor(session?: unknown): { ok: true } | { ok: false; guidance: string }
  /** 真实 ADB 通道：adb shell（adbd 执行，shell uid=2000）。 */
  execAdbShell?(command: string): Promise<{ ok: boolean; stdout: string; guidance?: string }>
  /** 真实 ADB 通道：原始 adb 行（自动注入 -s 与幂等 connect；screencap+pull 等组合用）。 */
  execAdbLine?(line: string): Promise<{ ok: boolean; stdout: string; guidance?: string }>

  audit(action: string, detail: Record<string, unknown>, ok: boolean): void
}

function deny(guidance: string) {
  return {
    text: `未授权：${guidance}\n\n请完成授权：完全访问档位 → 开发者选项「无线调试」开启 → 应用内「允许访问」开关 → 输入配对码。`,
    denied: true,
  }
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

function tools(priv: PrivilegeFace) {
  const guard = (action: string, args: Record<string, unknown>, exec?: { agent?: { session?: unknown } }) => {
    const a = priv.gateFor(exec?.agent?.session)
    priv.audit(action, { tool: 'android-manage', args }, a.ok)
    return a
  }

  const screenshot = defineTool({
    name: 'android_screenshot',
    description:
      '对设备截屏（PNG，经视觉链路读图）。用于界面观察闭环。需 ADB 授权；未授权失败关闭。' +
      '可传 textRedact: true 获得文本脱敏摘要（避免敏感屏幕内容进入上下文）。',
    parameters: {
      textRedact: { type: 'boolean', description: '文本脱敏摘要模式（默认 false 返回原图路径）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string', required: true },
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text', 'imagePath') || '(no output)' },
      ],
    },
    execute: async ({ textRedact = false }, exec) => {
      const a = guard('screenshot', { textRedact }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { imagePath: '', denied: true, text: a.guidance }
      // 0.14 真实通道：adbd（shell uid）执行 screencap → adb pull 回引擎私有临时目录（app uid 可读）。
      if (!priv.execAdbLine) return { imagePath: '', denied: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      try {
        const n = Date.now()
        const remote = `/data/local/tmp/dsh-shot-${n}.png`
        const local = join(process.env.TMPDIR ?? '/tmp', `dsh-shot-${n}.png`)
        const r = await priv.execAdbLine(`adb shell screencap -p ${remote} && adb pull ${remote} ${local} && ls -l ${local}`)
        if (!r.ok) return { imagePath: '', denied: false, text: r.guidance ?? (r.stdout || '截图执行失败') }
        if (!/^-rw|^-|^total|dsh-shot/.test(r.stdout.trim()) && !existsSync(local)) {
          return { imagePath: '', denied: false, text: '截图未落地：' + (r.stdout.trim().slice(-400) || '无输出') }
        }
        return { imagePath: local, denied: false, text: `截图已保存：${local}` }
      } catch (e) {
        return { imagePath: '', denied: false, text: '截图失败：' + String((e as Error).message) }
      }
    },
  })

  const uiTree = defineTool({
    name: 'android_ui_tree',
    description:
      '导出当前界面控件树（uiautomator dump）：每个节点的像素级边界、坐标与可点属性——' +
      'AI 定位判定以控件树为主源、截图视觉为辅。未授权失败关闭。',
    parameters: {},
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
    execute: async (_args, exec) => {
      const a = guard('ui_tree', {}, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { treeXmlPath: '', denied: true, text: a.guidance }
      // 0.14 真实通道：uiautomator dump（shell uid）→ pull 回引擎私有临时目录。
      if (!priv.execAdbLine) return { treeXmlPath: '', denied: false, text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      try {
        const n = Date.now()
        const remote = `/data/local/tmp/dsh-ui-${n}.xml`
        const local = join(process.env.TMPDIR ?? '/tmp', `dsh-ui-${n}.xml`)
        const r = await priv.execAdbLine(`adb shell uiautomator dump ${remote} && adb pull ${remote} ${local} && ls -l ${local}`)
        if (!r.ok) return { treeXmlPath: '', denied: false, text: r.guidance ?? (r.stdout || '控件树导出失败') }
        if (!existsSync(local)) {
          return { treeXmlPath: '', denied: false, text: '控件树未落地（厂商 ROM 可能限制 uiautomator）：' + (r.stdout.trim().slice(-400) || '无输出') }
        }
        return { treeXmlPath: local, denied: false, text: `控件树已导出：${local}` }
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
          denied: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text') || '(no output)' },
      ],
    },
    execute: async (_args, exec) => {
      const a = guard('device_info', {}, exec as { agent?: { session?: unknown } })
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
        return {
          model: kv.MODEL ?? '(未知)',
          // 热补丁：可选成员一律空串兜底——undefined 成员会被引擎 lossless-JSON
          // 校验整值拒绝（INVALID_TOOL_OUTPUT，2026-08-27 vivo dumpsys 被过滤时实锤）。
          androidVersion: kv.VER ?? '',
          frontApp: kv.FOCUS ? kv.FOCUS.replace(/^.*mCurrentFocus=\{\s*(\S+).*$/, '$1') : '',
          resolution: kv.RES ? kv.RES.replace(/^.*init=(\d+x\d+).*$/, '$1') : '',
          denied: false,
          text: `model=${kv.MODEL ?? '?'} ver=${kv.VER ?? '?'} sdk=${kv.SDK ?? '?'} focus=${kv.FOCUS ?? '?'} res=${kv.RES ?? '?'}`,
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'text') || '(no output)' },
      ],
    },
    execute: async (args: { action?: string; x?: number; y?: number; x2?: number; y2?: number; duration?: number; keycode?: number; text?: string }, exec) => {
      const a = guard('act_input', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, text: a.guidance }
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

  return [screenshot, uiTree, deviceInfo, actInput]
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
  for (const t of tools(face)) ctx.tools.register(t)
}
