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
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { parseUiTreeXml, pruneNodes, resolveRef, findActionableAncestor, type UiNode } from './ui-tree.js'

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

  // ── ADB 2.0 Phase A（PRD-0.13.2 §3.2）：语义化控件清单 + 语义动作 ──────────

  // 最近一次 dump 缓存（30s TTL）：android_ui_click/scroll 引用节点 id 无需重复 dump。
  // 引擎单进程内模块级缓存（n 值 ≤60，内存代价可忽略）。
  const UI_CACHE_TTL = 30_000
  let uiCache:
    | { nodes: UiNode[]; byId: ReturnType<typeof pruneNodes>['byId']; byOrig: ReturnType<typeof pruneNodes>['byOrig']; screen: { w: number; h: number }; rotation: number; ts: number }
    | null = null

  /** 语义清单渲染（模型侧文本；完整 JSON 在 return 里）。 */
  const nodeSummary = (nodes: UiNode[]): string => {
    const lines = nodes.slice(0, 8).map((n) => `  ${n.id} ${n.clickable ? '可点' : n.editable ? '可编辑' : n.scrollable ? '可滚动' : '文本'} "${(n.text || n.desc).slice(0, 24)}"`)
    return `共 ${nodes.length} 个节点（物化清单见本工具 JSON）：\n` + lines.join('\n') + (nodes.length > 8 ? '\n  …（其余见 JSON nodes）' : '')
  }

  const uiDump = defineTool({
    name: 'android_ui_dump',
    description:
      '导出当前界面语义控件清单（ADB 2.0）：uiautomator dump → 解析剪枝 → 紧凑 JSON 节点表（' +
      'id(text/desc 语义定位用，同一次 dump 内稳定)/文本/描述/类型/中心坐标/尺寸/可点/可滚动/可编辑）。' +
      '节点上限 60（超出截断）、文本截 50 字符——token 远低于原始 XML 与截图。' +
      '调用序：先 android_ui_dump 定位目标，再 android_ui_click/scroll/input 语义动作；' +
      '复杂页面动作后建议重新 dump 验证。需 ADB 授权 + 会话档位 danger-full-access；未授权失败关闭。',
    parameters: {},
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
          note: { type: 'string' },
          text: { type: 'string' },
          denied: { type: 'boolean' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? ((v as { count?: number }).count ?? 0) + ' nodes') },
      ],
    },
    execute: async (_args, exec) => {
      const a = guard('ui_dump', {}, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: a.guidance }
      if (!priv.execAdbLine) return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: 'ADB 执行通道未接通（dsh-android-bridge 未提供 execAdbLine）' }
      const n = Date.now()
      const remote = `/data/local/tmp/dsh-ui-${n}.xml`
      const local = join(process.env.TMPDIR ?? '/tmp', `dsh-ui-${n}.xml`)
      try {
        const r = await priv.execAdbLine(
          `adb shell uiautomator dump ${remote}; adb pull ${remote} ${local} >/dev/null 2>&1; adb shell wm size | grep -m1 'Physical size'`,
        )
        if (!r.ok) return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: r.guidance ?? (r.stdout || '控件清单导出失败') }
        if (!existsSync(local)) {
          return { ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: '控件树未落地（厂商 ROM 可能限制 uiautomator）：' + (r.stdout.trim().slice(-300) || '无输出') }
        }
        const xml = readFileSync(local, 'utf8')
        const parsed = parseUiTreeXml(xml)
        const pruned = pruneNodes(parsed.raw)
        const size = /Physical size:\s*(\d+)x(\d+)/.exec(r.stdout)
        const screen = size ? { w: Number(size[1]), h: Number(size[2]) } : { w: 0, h: 0 }
        uiCache = {
          nodes: pruned.nodes,
          byId: pruned.byId,
          byOrig: pruned.byOrig,
          screen,
          rotation: parsed.rotation,
          ts: Date.now(),
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
          note: 'id 仅在最近一次 dump 内有效；页面变化后请重新 dump',
          text: `控件清单：${pruned.nodes.length} 个节点（原始 ${pruned.rawCount}，屏幕 ${screen.w}x${screen.h}）`,
        }
      } finally {
        try { rmSync(local, { force: true }) } catch { /* 清理失败忽略 */ }
      }
    },
  })

  const uiClick = defineTool({
    name: 'android_ui_click',
    description:
      '语义点击：按 android_ui_dump 清单中的引用点按控件（解析 bounds 中心 → input tap，AI 不猜像素）。' +
      '引用格式：id:n3 / text:设置（精确文本）/ desc:… / rid:…；裸数字按 id。' +
      '目标不可点自动回退最近可点祖先；不在最近 dump 中返回引导（页面已变请重新 dump）。' +
      '需 ADB 授权 + 会话档位 danger-full-access；每次调用审计。',
    parameters: {
      ref: { type: 'string', required: true, description: '控件引用（id:n3 或 text:精确文本 等）' },
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
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? '') },
      ],
    },
    execute: async ({ ref }: { ref: string }, exec) => {
      const a = guard('ui_click', { ref }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
        return { ok: false, denied: false, text: '没有最近的控件清单——请先执行 android_ui_dump' }
      }
      const hit = resolveRef(uiCache.byId, uiCache.nodes, ref)
      if (!hit.ok) return { ok: false, denied: false, text: hit.error }
      let node = hit.node
      if (!node.clickable && !node.editable && !node.scrollable) {
        const anc = findActionableAncestor(uiCache.byOrig, node)
        if (!anc) return { ok: false, denied: false, text: `目标「${(node.text || node.desc).slice(0, 20)}」不可点击且无可用祖先——考虑滚动或重新 dump` }
        node = anc
      }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      const r = await priv.execAdbShell(`input tap ${node.cx} ${node.cy}`)
      if (!r.ok) return { ok: false, denied: false, text: r.guidance ?? (r.stdout || '点击执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      return {
        ok: !errMark,
        denied: false,
        ref,
        id: node.id,
        label: (node.text || node.desc).slice(0, 40),
        x: node.cx,
        y: node.cy,
        text: errMark ? '点击返回异常：' + r.stdout.slice(0, 300) : `已点击 ${node.id}「${(node.text || node.desc).slice(0, 24)}」(${node.cx},${node.cy})——建议重新 dump 验证`,
      }
    },
  })

  const uiScroll = defineTool({
    name: 'android_ui_scroll',
    description:
      '语义滚动：按控件引用（可选）或屏幕方向滚动。有 ref 时在节点 bounds 内滑动；' +
      '无 ref 时按屏幕尺寸滑动。direction: up/down/left/right；fraction 为滑动比例（默认 0.6）。' +
      '需 dump 提供屏幕尺寸；无缓存时自动查 wm size。需 ADB 授权 + 会话档位 danger-full-access。',
    parameters: {
      ref: { type: 'string', description: '控件引用（滚动容器；可选）' },
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'] },
      fraction: { type: 'number', description: '滑动比例（0.1-1.0，默认 0.6）' },
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
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? '') },
      ],
    },
    execute: async (args: { ref?: string; direction?: string; fraction?: number }, exec) => {
      const a = guard('ui_scroll', args as Record<string, unknown>, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      if (!priv.execAdbLine || !priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      const dir = args.direction === 'left' || args.direction === 'right' ? args.direction : args.direction === 'up' || args.direction === 'down' ? args.direction : ''
      if (!dir) return { ok: false, denied: false, text: `未知方向：${String(args.direction)}` }
      const frac = Math.min(Math.max(args.fraction ?? 0.6, 0.1), 1.0)
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
        const hit = resolveRef(uiCache.byId, uiCache.nodes, args.ref)
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
      '语义文本输入：向当前聚焦输入框注入文本。纯可见 ASCII + 无 shell 元字符走 input text；' +
      '含中文等非 ASCII 走 ADBKeyboard 广播（am broadcast ADB_INPUT_TEXT，需设备装有 ADBKeyboard 系 IME' +
      '——0.13.2 内嵌 IME 落地后自动可用）。长度 ≤500。需 ADB 授权 + 会话档位 danger-full-access。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本（≤500 字符）' },
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
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: String(v.text ?? '') },
      ],
    },
    execute: async ({ text }: { text: string }, exec) => {
      const a = guard('ui_input', { text }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通' }
      const raw = text ?? ''
      if (raw.length === 0 || raw.length > 500) return { ok: false, denied: false, text: 'text 长度需为 1-500 字符' }
      const asciiOnly = /^[\x20-\x7E]+$/.test(raw)
      let line: string; let channel: string
      if (asciiOnly) {
        if (/[\\'"\`$;&|<>*?(){}[\]\n\r]/.test(raw)) return { ok: false, denied: false, text: 'text 含 shell 元字符（仅允许可见 ASCII；中文请走 ADBKeyboard）' }
        line = `input text ${raw.replace(/ /g, '%s')}`
        channel = 'input'
      } else {
        // ADBKeyboard 协议：am broadcast -a ADB_INPUT_TEXT --es msg <文本>
        // shell 单引号包裹 + 内部单引号用 '\'' 惯用法转义
        const quoted = `'${raw.replace(/'/g, `'\\''`)}'`
        line = `am broadcast -a ADB_INPUT_TEXT --es msg ${quoted}`
        channel = 'adbkeyboard'
      }
      const r = await priv.execAdbShell(line)
      if (!r.ok) return { ok: false, denied: false, text: r.guidance ?? (r.stdout || '输入执行失败') }
      const errMark = /error:|Error|Exception|unknown/.test(r.stdout)
      if (errMark && channel === 'adbkeyboard' && /not found|Unable to find|无|没有/.test(r.stdout)) {
        return { ok: false, denied: false, channel, text: 'ADBKeyboard IME 未安装：中文输入暂不可用（0.13.2 内嵌 IME 落地后解除）；ASCII 文本可用 input text' }
      }
      return { ok: !errMark, denied: false, channel, text: errMark ? '输入返回异常：' + r.stdout.slice(0, 300) : `已输入 ${raw.slice(0, 24)}${raw.length > 24 ? '…' : ''}（${channel}）` }
    },
  })

  return [screenshot, uiTree, deviceInfo, actInput, uiDump, uiClick, uiScroll, uiInput]
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
