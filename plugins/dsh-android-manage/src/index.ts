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
  execAdbShell?(command: string): Promise<{ ok: boolean; stdout: string; guidance?: string }>
  /** 真实 ADB 通道：原始 adb 行（自动注入 -s 与幂等 connect；screencap+pull 等组合用）。 */
  execAdbLine?(line: string): Promise<{ ok: boolean; stdout: string; guidance?: string }>
  /** 0.13.5 W4：控制通道策略（a11y 优先 / ADB 回退 / 拒绝，fail-closed）。 */
  controlDecision?(op: string, session?: unknown, forceBackend?: 'a11y' | 'adb'): { backend: 'a11y' | 'adb' | 'deny'; reason: string; guidance?: string }
  /** 0.13.5 W4：无障碍通道执行（壳侧队列往返；未开启无障碍时直接拒绝）。 */
  controlExec?(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>

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
  const guard = (action: string, args: Record<string, unknown>, exec?: { agent?: { session?: unknown } }) => {
    const a = priv.gateFor(exec?.agent?.session)
    priv.audit(action, { tool: 'android-manage', args }, a.ok)
    return a
  }

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
    return changed
      ? '生效校验：界面已变化（已生效）'
      : '生效校验：未观察到界面变化——可能未生效（目标不可点/被遮挡/点击落空），建议重新 dump 核对'
  }

  // ── ADB 可靠性批次公共件（2026-09-05，docs/BUGS-open-2026-09-05-ADB-field-report.md）──

  const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

  /** F1 止血：读动画三开关当前值。$k/$(...) 由 execAdbShell 的远端段整体转义保护（0.1.3 起），
   *  本地 bash 不展开、由设备端求值。 */
  async function readAnimScales(): Promise<Record<string, string>> {
    if (!priv.execAdbShell) return {}
    const cmd = 'for k in ' + ANIM_KEYS.join(' ') + '; do echo R:$k=$(settings get global $k); done'
    const r = await priv.execAdbShell(cmd).catch(() => ({ ok: false, stdout: '' }))
    const out: Record<string, string> = {}
    for (const m of r.stdout.matchAll(/R:(\w+)=(\S+)/g)) out[m[1]] = m[2]
    return out
  }

  /** F1 止血：动画三开关置值——uiautomator dump 的 idle 等待依赖无障碍事件流安静，
   *  音乐类 App 播放条常驻动画使窗口永不 idle（"could not get idle state" 实锤根因）。 */
  async function setAnimScales(v: string): Promise<void> {
    if (!priv.execAdbShell) return
    await priv.execAdbShell(ANIM_KEYS.map((k) => `settings put global ${k} ${v}`).join('; ')).catch(() => undefined)
  }

  /** F1 止血：还原动画三开关（读数失败的键回 1 标准值）。 */
  async function restoreAnimScales(old: Record<string, string>): Promise<void> {
    if (!priv.execAdbShell) return
    await priv.execAdbShell(ANIM_KEYS.map((k) => `settings put global ${k} ${old[k] ?? '1'}`).join('; ')).catch(() => undefined)
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string', required: true },
          width: { type: 'number', description: '设备物理分辨率宽（截图像素坐标换算锚点）' },
          height: { type: 'number', description: '设备物理分辨率高' },
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
    execute: async ({ textRedact = false }, exec) => {
      const a = guard('screenshot', { textRedact }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { imagePath: '', denied: true, text: a.guidance }
      // 0.13.5 W4：无障碍截屏优先（API 30+ 的 AccessibilityService.takeScreenshot——不需要 ADB）
      let adbNote = ''
      if (controlDecision('screenshot', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const r = await a11yExec('screenshot', {}, 12_000)
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
        const r = await priv.execAdbLine(`adb shell screencap -p ${remote} && adb pull ${remote} ${local} && ls -l ${local}; adb shell rm -f ${remote}`)
        if (!r.ok) return { imagePath: '', denied: false, text: r.guidance ?? (r.stdout || '截图执行失败') }
        if (!/^-rw|^-|^total|dsh-shot/.test(r.stdout.trim()) && !existsSync(local)) {
          return { imagePath: '', denied: false, text: '截图未落地：' + (r.stdout.trim().slice(-400) || '无输出') }
        }
        // F2 统一坐标系：回传物理分辨率锚点。模型侧读图可能降采样（maxDim 2048），
        // 严禁直接用截图像素坐标点击——归一化用 android_ui_click 的 nx/ny。
        const size = await screenSize()
        return inlineShot(local, size.w, size.h, exec as ExecLike, `ADB 通道，设备物理分辨率 ${size.w}x${size.h}${adbNote}`)
      } catch (e) {
        return { imagePath: '', denied: false, text: '截图失败：' + String((e as Error).message) }
      }
    },
  })

  const uiTree = defineTool({
    name: 'android_ui_tree',
    description:
      '【兜底】导出原始 uiautomator XML（大而全，token 高）：仅当无障碍通道不可用、或明确需要原始 XML 字段时才用。' +
      '日常定位请优先 android_ui_dump（无障碍语义树，字段更全且无需配对）。未授权失败关闭。',
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
    | { nodes: UiNode[]; byId: ReturnType<typeof pruneNodes>['byId']; byOrig: ReturnType<typeof pruneNodes>['byOrig']; parentByOrig: ReturnType<typeof pruneNodes>['parentByOrig']; screen: { w: number; h: number }; rotation: number; ts: number; gen?: number; fingerprint?: string; rawCount?: number; v2?: V2Decoded }
    | null = null

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

  /** 「界面未变」快路径（P0-4）：指纹一致直接回紧凑摘要，模型可复用上次引用。 */
  const unchangedResponse = (fp: string, gen?: number) => ({
    ok: true,
    denied: false,
    unchanged: true,
    screen: uiCache!.screen,
    rotation: uiCache!.rotation,
    count: uiCache!.nodes.length,
    rawCount: uiCache!.rawCount ?? uiCache!.nodes.length,
    nodes: [] as JsonValue[],
    gen,
    note: '界面未变（结构指纹一致）：上次 dump 的引用（n0..nN）与坐标仍然有效，可直接复用；需完整清单请带 fresh:true 重新 dump',
    text: `界面未变（gen=${gen ?? '未知'}，结构指纹 ${fp}）：上次 dump 的 ${uiCache!.nodes.length} 个节点引用仍有效——直接用 android_ui_click/id:nN 等引用继续，无需重新阅读清单（fresh:true 可强制完整重抓）`,
  })

  /** 0.13.5 W4：控制通道决策。策略面缺席（旧版 bridge）→ 按 ADB 通道处理，保持旧行为。 */
  const controlDecision = (op: string, exec?: { agent?: { session?: unknown } }) => {
    const session = exec?.agent?.session
    const decision = priv.controlDecision?.(op, session)
    return decision ?? { backend: 'adb' as const, reason: '控制策略面缺席（bridge 未提供 controlDecision）——按 ADB 通道处理' }
  }

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
      '【首选】导出当前界面语义控件清单：无障碍语义树优先（一次系统开关即用、无配对、不受 uiautomator idle 阻塞），否则回退 uiautomator dump。'
      + '产出完整结构化节点表（id / 父id / 文本 / 描述 / 类型 / bounds / 可点 / 可滚动 / 可编辑），0.13.5 起不截断；'
      + '界面未变时返回紧凑「未变」摘要（省 token，传 fresh:true 强制完整重抓）。'
      + '下一步用 android_ui_click / android_ui_input / android_ui_scroll 语义动作；页面大幅变化后重新 dump。'
      + '需设备控制授权（无障碍服务已开启，或 ADB 三道门齐备）+ 会话档位 danger-full-access；未授权失败关闭。'
      + '注意：需要原始 uiautomator XML 时才用 android_ui_tree。',
    parameters: {
      fresh: { type: 'boolean', description: 'true = 跳过「界面未变」快路径，强制完整重抓（默认 false）' },
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
          note: { type: 'string' },
          text: { type: 'string' },
          denied: { type: 'boolean' },
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
      const a = guard('ui_dump', {}, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [], text: a.guidance }
      // 0.13.5 W4：无障碍通道优先（一次系统开关即用；不经 uiautomator，故不受 F1 idle 阻塞影响）
      if (controlDecision('snapshot', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        // 现场实测（2026-09-10 真机，B 站播放页）：重 UI/常驻动画页面建树慢，8s 默认超时频繁失败——
        // 这里给到 15s；仍失败则明确指引「先 android_ui_global back 退出重页面再 dump」。
        const r = await a11yExec('snapshot', {}, 15_000)
        if (!r.ok) {
          return {
            ok: false, denied: false, screen: { w: 0, h: 0 }, rotation: 0, count: 0, rawCount: 0, nodes: [],
            text: `无障碍取树失败：${r.error}——重 UI/播放页常见；建议：① android_ui_global back 退回上一级再 dump；`
              + '② 或 android_screenshot 直接看画面；③ ADB 已配对时用 android_ui_tree（uiautomator）。',
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
          return unchangedResponse(fp, v2?.gen ?? data.gen ?? uiCache.gen)
        }
        const screen = v2 ? v2.screen : (data.screen && data.screen.w > 0 ? data.screen : { w: 0, h: 0 })
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
        return {
          ok: true,
          denied: false,
          screen,
          rotation: data.rotation ?? 0,
          count: pruned.nodes.length,
          rawCount: pruned.rawCount,
          nodes: pruned.nodes as unknown as JsonValue[],
          note: `无障碍通道（backend=a11y，协议 ${v2 ? 'V2 列式' : 'V1'}）：id 仅在最近一次 dump 内有效；页面变化后请重新 dump`,
          text: `控件清单（无障碍通道，未截断）：${pruned.nodes.length} 个节点（原始 ${pruned.rawCount}，剔除 ${pruned.rawCount - pruned.nodes.length} 个零尺寸/完全重复节点，屏幕 ${screen.w}x${screen.h}；前台 ${fg?.pkg ?? '?'}/${fg?.activity ?? '?'}）`
            + warn + webHint,
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
          return unchangedResponse(fp, uiCache.gen)
        }
        const size = /Physical size:\s*(\d+)x(\d+)/.exec(r.stdout)
        const screen = size ? { w: Number(size[1]), h: Number(size[2]) } : { w: 0, h: 0 }
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
          note: 'id 仅在最近一次 dump 内有效；页面变化后请重新 dump',
          text: `控件清单（未截断）：${pruned.nodes.length} 个节点（原始 ${pruned.rawCount}，剔除 ${pruned.rawCount - pruned.nodes.length} 个零尺寸/完全重复节点，屏幕 ${screen.w}x${screen.h}）`,
        }
      } finally {
        try { rmSync(local, { force: true }) } catch { /* 清理失败忽略 */ }
      }
    },
  })

  const uiClick = defineTool({
    name: 'android_ui_click',
    description:
      '语义点击/长按：按 android_ui_dump 清单中的引用点按控件（解析 bounds 中心 → input tap，AI 不猜像素）。' +
      '引用格式：id:n3 / text:设置（精确文本）/ desc:… / rid:…；裸数字按 id。' +
      '控件树不可用时可用 nx/ny 归一化坐标兜底：相对设备物理屏幕（0-1），' +
      '由截图像素换算 nx=像素x/截图宽、ny=像素y/截图高——工具层负责映射到物理分辨率，模型无需手工乘缩放系数。' +
      '目标不可点自动回退最近可点祖先；不在最近 dump 中返回引导（页面已变请重新 dump）。' +
      '长按：传 longClick:true（0.13.8 新增，无障碍 ACTION_LONG_CLICK 优先、手势按住 600ms 兜底）。' +
      '需设备控制授权（无障碍或 ADB 三道门）+ 会话档位 danger-full-access；每次调用审计。',
    parameters: {
      ref: { type: 'string', description: '控件引用（id:n3 或 text:精确文本 等；与 nx/ny 二选一）' },
      nx: { type: 'number', description: '归一化 X（0-1，相对物理屏宽；= 截图内像素 x ÷ 截图宽）——无 ref 时使用' },
      ny: { type: 'number', description: '归一化 Y（0-1，相对物理屏高；= 截图内像素 y ÷ 截图高）——无 ref 时使用' },
      longClick: { type: 'boolean', description: 'true = 长按（ACTION_LONG_CLICK 优先，手势按住 600ms 兜底）' },
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
    execute: async ({ ref, nx, ny, longClick }: { ref?: string; nx?: number; ny?: number; longClick?: boolean }, exec) => {
      // 0.13.8 E6：长按走壳侧 longClick op（ACTION_LONG_CLICK 优先 + 手势按住兜底）
      const clickOp = longClick === true ? 'longClick' : 'click'
      const a = guard('ui_click', { ref, nx, ny }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      const useRef = typeof ref === 'string' && ref.trim().length > 0
      const useNorm =
        typeof nx === 'number' && Number.isFinite(nx) && nx >= 0 && nx <= 1 &&
        typeof ny === 'number' && Number.isFinite(ny) && ny >= 0 && ny <= 1
      if (!useRef && !useNorm) return { ok: false, denied: false, text: '需要 ref（语义引用）或 nx/ny（0-1 归一化坐标）二者之一' }
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
          const verdict = await verifyClick(uiCache?.gen, exec as ExecLike)
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
        const payload: Record<string, unknown> = {}
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (useRef) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) {
            return { ok: false, denied: false, text: '没有最近的控件清单——请先执行 android_ui_dump' }
          }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, ref!.trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, text: hit.error }
          let node = hit.node
          if (!node.clickable && !node.editable && !node.scrollable) {
            const anc = actionableAncestorOf(node)
            if (!anc) return { ok: false, denied: false, text: `目标「${(node.text || node.desc).slice(0, 20)}」不可点击且无可用祖先——考虑滚动或重新 dump` }
            node = anc
          }
          const orig = origPathOf(node.id)
          if (!orig) return { ok: false, denied: false, text: '无障碍通道需要节点原始路径——请重新 android_ui_dump' }
          payload.path = orig
          const r = await a11yExec(clickOp, payload)
          if (!r.ok) return { ok: false, denied: false, text: '无障碍点击失败：' + r.error }
          const clicked = (r.data ?? {}) as { x?: number; y?: number; via?: string }
          const verdict = await verifyClick(uiCache?.gen, exec as ExecLike)
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
        if (!r.ok) return { ok: false, denied: false, text: '无障碍点击失败：' + r.error }
        const clicked = (r.data ?? {}) as { x?: number; y?: number; via?: string }
        const verdict = await verifyClick(uiCache?.gen, exec as ExecLike)
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
          return { ok: false, denied: false, text: '没有最近的控件清单——请先执行 android_ui_dump' }
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
        const payload: Record<string, unknown> = {}
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (useRef) {
          if (!putTargetRefById(payload, hitId)) return { ok: false, denied: false, text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        } else {
          payload.nx = nx
          payload.ny = ny
        }
        const r = await a11yExec(clickOp, payload)
        if (!r.ok) return { ok: false, denied: false, text: '无障碍点击失败：' + r.error }
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
      // 0.13.5 W4：无障碍通道优先（ACTION_SCROLL_* 语义滚动；无坐标 swipe）
      if (controlDecision('scroll', exec as { agent?: { session?: unknown } }).backend === 'a11y') {
        const payload: Record<string, unknown> = { direction: dir, fraction: frac }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (args.ref) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) return { ok: false, denied: false, from: [], to: [], text: '没有最近的控件清单——请先执行 android_ui_dump' }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, String(args.ref).trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, from: [], to: [], text: hit.error }
          if (!putTargetRef(payload, hit.node)) return { ok: false, denied: false, from: [], to: [], text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        }
        const r = await a11yExec('scroll', payload)
        if (!r.ok) return { ok: false, denied: false, from: [], to: [], text: '无障碍滚动失败：' + r.error }
        return { ok: true, denied: false, from: [], to: [], text: `已向 ${dir} 滚动（无障碍通道，fraction=${frac}）——建议重新 dump 验证` }
      }
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
    execute: async ({ text, clear, channel, ref }: { text?: string; clear?: boolean; channel?: string; ref?: string }, exec) => {
      const a = guard('ui_input', { text, clear, channel, ref }, exec as { agent?: { session?: unknown } })
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
        const payload: Record<string, unknown> = { text: raw, clear: clear === true }
        if (uiCache?.gen !== undefined) payload.gen = uiCache.gen
        if (typeof ref === 'string' && ref.trim().length > 0) {
          if (!uiCache || Date.now() - uiCache.ts > UI_CACHE_TTL) return { ok: false, denied: false, channel: 'a11y', text: '没有最近的控件清单——请先执行 android_ui_dump' }
          const hit = resolveRef(uiCache.byId, uiCache.nodes, ref.trim(), scopePoolFor())
          if (!hit.ok) return { ok: false, denied: false, channel: 'a11y', text: hit.error }
          if (!putTargetRef(payload, hit.node)) return { ok: false, denied: false, channel: 'a11y', text: '无障碍通道需要节点行句柄/原始路径——请重新 android_ui_dump' }
        }
        const r = await a11yExec('setText', payload)
        if (!r.ok) return { ok: false, denied: false, channel: 'a11y', text: '无障碍输入失败：' + r.error }
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
        let readBack: string | null = null
        if (r.ok && raw.length > 0) {
          const read = async (): Promise<string | null> => {
            const nt = await a11yExec('nodeText', {}, 4000)
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
    execute: async ({ root }: { root?: string }, exec) => {
      const a = guard('web_dump', { root }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, count: 0, nodes: [] as WebNode[], text: a.guidance }
      const r = await a11yExec('webSnapshot', root ? { root } : {}, 8000)
      if (!r.ok) return { ok: false, denied: false, count: 0, nodes: [] as WebNode[], text: 'WebView DOM 快照失败：' + r.error }
      const data = (r.data ?? {}) as {
        ok?: boolean; error?: string; url?: string; title?: string; vw?: number; vh?: number
        scrollY?: number; total?: number; nodes?: WebNode[]
      }
      if (data.ok === false) {
        return { ok: false, denied: false, count: 0, nodes: [] as WebNode[], text: 'WebView DOM 快照失败：' + (data.error ?? '未知') }
      }
      const nodes = data.nodes ?? []
      const lines = nodes.map((n) => {
        const flags = [n.disabled === true ? '禁用' : '', n.editable === true ? '可编辑' : '', n.inView === false ? '视口外' : ''].filter(Boolean).join('/')
        return `  ${String(n.ref)} ${String(n.role || n.tag || '')}${flags ? '[' + flags + ']' : ''} "${String(n.text ?? '').slice(0, 40)}" sel=${String(n.sel ?? '')}`
      })
      return {
        ok: true,
        denied: false,
        count: nodes.length,
        url: data.url,
        title: data.title,
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
      const a = guard('env_prepare', { animations, ime, restore, setImeDefault }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, text: a.guidance }
      if (!priv.execAdbShell) return { ok: false, denied: false, text: 'ADB 执行通道未接通（本工具需要 adb shell；无障碍通道无法改系统设置）' }
      const lines: string[] = []
      if (animations) {
        if (restore) {
          await restoreAnimScales({})
          lines.push('动画：已恢复默认（1）')
        } else {
          await setAnimScales('0')
          lines.push('动画：已关闭（window/transition/animator 三项 = 0）')
        }
      }
      if (ime) {
        const IME_ID = 'com.dsharnessmobile.shell/.AdbKeyboardService'
        const en = await priv.execAdbShell(`ime enable ${IME_ID}`)
        const list = await priv.execAdbShell(`ime list -s | grep -c dsharnessmobile`)
        const enabled = list.ok && Number.parseInt(list.stdout.trim(), 10) > 0
        if (!enabled) {
          lines.push('输入法：启用失败——请在「设置 → 系统 → 语言与输入法」里手动启用「DSH 设备键盘」后重试')
        } else if (setImeDefault) {
          const cur = await priv.execAdbShell(`settings get secure default_input_method`)
          const prev = (cur.ok ? cur.stdout : '').trim().replace(/^"|"$/g, '')
          const set = await priv.execAdbShell(`ime set ${IME_ID}`)
          lines.push(`输入法：已启用并设为默认（原默认 ${prev || '?'}；如需还原：ime set ${prev || '<原输入法>' }）`)
          if (!set.ok) lines.push('输入法：设为默认失败——' + (set.stdout || '').slice(0, 120))
        } else {
          lines.push(`输入法：已启用（${IME_ID}）；android_ui_input 会在注入时临时切换并在结束后还原，无需设为默认`)
        }
        if (!en.ok) lines.push('（ime enable 返回异常：' + (en.stdout || '').slice(0, 120) + '）')
      }
      return { ok: true, denied: false, text: '环境准备完成：\n- ' + lines.join('\n- ') }
    },
  })

  /** 拉起应用（现场实测每次都要手写 monkey；包名由 pm list packages 先查）。 */
  const appLaunch = defineTool({
    name: 'android_app_launch',
    description:
      '按包名拉起应用主界面（monkey -p <pkg> -c android.intent.category.LAUNCHER 1），等待后回报前台 Activity。'
      + '先用 android_device_info 或 pm list packages 找到包名。需 ADB 授权。',
    parameters: {
      pkg: { type: 'string', required: true, description: '应用包名（如 com.netease.cloudmusic）' },
      waitMs: { type: 'number', description: '拉起后等待毫秒数（默认 2500）' },
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
    execute: async ({ pkg, waitMs = 2500 }: { pkg: string; waitMs?: number }, exec) => {
      const a = guard('app_launch', { pkg }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, pkg, text: a.guidance }
      if (!/^[a-zA-Z][\w.]*$/.test(pkg)) return { ok: false, denied: false, pkg, text: '包名不合法：' + pkg }
      if (!priv.execAdbShell) return { ok: false, denied: false, pkg, text: 'ADB 执行通道未接通' }
      const r = await priv.execAdbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`)
      if (!r.ok) return { ok: false, denied: false, pkg, text: r.guidance ?? (r.stdout || '拉起失败') }
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(waitMs, 8000))))
      const fg = await foregroundInfo()
      const matched = fg !== null && fg.pkg === pkg
      return {
        ok: true,
        denied: false,
        pkg,
        foreground: fg ? `${fg.pkg}/${fg.activity}` : '',
        text: `已拉起 ${pkg}；前台 ${fg ? `${fg.pkg}/${fg.activity}` : '未知'}` + (matched ? '' : `（前台不是目标包——可能被权限弹窗/其他窗口遮挡，请 android_ui_dump 核对）`),
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
      '【首选】系统级动作（无障碍通道，不需要 ADB）：back=返回上一级、home=回桌面、recents=最近任务、'
      + 'notifications=下拉通知栏、quickSettings=快捷设置面板、toggleSplitScreen=分屏、powerDialog=关机菜单、'
      + 'lockScreen=锁屏、takeScreenshot=系统截图、menu=菜单键、mediaPlayPause=播放/暂停、'
      + 'dismissNotificationShade=收起通知栏、accessibilityShortcut=无障碍快捷方式。'
      + '卡在子菜单/弹窗/详情页出不来时，第一步就用 back。'
      + '设备实际可用的动作由系统 getSystemActions() 决定，不可用者返回可用清单（不会静默无效果）。'
      + '需设备控制授权（无障碍服务已开启即可）+ 会话档位 danger-full-access。',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['back', 'home', 'recents', 'notifications', 'quickSettings', 'toggleSplitScreen', 'powerDialog',
          'lockScreen', 'takeScreenshot', 'menu', 'mediaPlayPause', 'dismissNotificationShade', 'accessibilityShortcut'],
        description: '要执行的全局动作（可用集由系统决定，不可用会回可用清单）',
      },
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
    execute: async ({ action }: { action: string }, exec) => {
      const a = guard('ui_global', { action }, exec as { agent?: { session?: unknown } })
      if (!a.ok) return { ok: false, denied: true, action, text: a.guidance }
      const GLOBAL_ACTIONS = ['back', 'home', 'recents', 'notifications', 'quickSettings', 'toggleSplitScreen',
        'powerDialog', 'lockScreen', 'takeScreenshot', 'menu', 'mediaPlayPause', 'dismissNotificationShade', 'accessibilityShortcut']
      if (!GLOBAL_ACTIONS.includes(action)) {
        return { ok: false, denied: false, action, text: `action 必须是 ${GLOBAL_ACTIONS.join(' / ')}` }
      }
      const r = await a11yExec('global', { action }, 6000)
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

  return [screenshot, uiTree, deviceInfo, actInput, uiDump, uiClick, uiScroll, uiInput, webDump, envPrepare, appLaunch, uiGlobal]
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
