/**
 * 「手机控制」设置分区（0.14.0 用户定例：把手机控制单独开一个设置页）。
 *
 * 内容：Shizuku 特权通道（状态 + 下载/打开入口 + 视频教程）/ 开放屏幕范围 / 虚拟屏分辨率档位 /
 * 虚拟屏浮窗（退后台自动显示）/ 无障碍入口（含 Android 13+ 受限设置解锁）/ 强制销毁（连点三次确认）。
 *
 * 数据面纪律：全部经 window.androidBridge 只读回读 + 写后回读；桥不可用/抛错一律**如实报不可读**，
 * 不用安全默认值冒充事实（0.14.1 UI 审查：桥缺席时页面显示「未开启 / 0.75 / 仅虚拟屏幕」这些
 * 看起来像事实的值，改完还会自己弹回）。
 *
 * 0.14.1 Shizuku 面重做（用户 2026-09-22 定例，UI 审查 P0）：
 *  - **状态源换掉**：旧实现读的是 `vdisplayStatus()`——标题写「Shizuku 特权通道」，内容却是虚拟屏
 *    状态码与 displayId（只有虚拟屏 blocked 时才顺带透出 Shizuku 的 guidance）。现在读 `shizukuStatus()`，
 *    虚拟屏状态另起一行、名字也改对。
 *  - **两个入口**：左「下载 Shizuku」右「打开 Shizuku」，并列半行宽；**未安装时「打开 Shizuku」不可点**
 *    （旧态是「模型让用户去设置页安装、启动并授权 Shizuku」，而那一页一个入口都没有——死循环）。
 *  - **两个外链共用一条壳侧通道**：下载页与视频教程都只是跳出去，页面只传 key，URL 表在壳侧
 *    （`ExternalLinks`），页面拿不到「打开任意地址」的能力。
 *  - **授权只能由用户在 Shizuku 内完成**（被提权方不得自改授权），壳侧只负责把人送到界面；
 *    回到本页每 2 秒轮询一次状态，授权完成会自动收敛，不需要用户手动点刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { useShellState } from '../mobile/use-shell-state.ts'
import { describeCallReason } from '../user-copy.ts'
import { tr } from '../i18n.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../android-bridge.ts'

type ScreenScope = 'virtual-only' | 'real-only' | 'all'
const SCOPES: readonly ScreenScope[] = ['virtual-only', 'real-only', 'all']
const SCALE_OPTIONS: readonly number[] = [0.5, 0.75, 1]

/** 外链 key（与壳侧 `ExternalLinks` 的登记名逐字一致）。 */
const LINK_DOWNLOAD = 'shizuku-download'
const LINK_TUTORIAL = 'shizuku-tutorial'

type VdisplayState = 'disabled' | 'blocked' | 'ready' | 'active'
interface VdisplayStatus {
  state: VdisplayState
  code: string
  guidance: string
  displayId?: number
}
interface A11yStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败，界面不得冒充「未开启」）。 */
  readable: boolean
  enabled: boolean
  hint: string
  restrictedSettingsApplies: boolean
}
interface ShizukuStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败）。 */
  readable: boolean
  installed: boolean
  running: boolean
  granted: boolean
  bound: boolean
  binding: boolean
  /** issue #471：连续启动失败次数（壳侧 connectFailures）。 */
  connectFailures?: number
  /** 连续失败已达阈值：用户服务启动即崩，真实原因见 diagnostics。 */
  startFailed?: boolean
  /** 距离下一次自动重试的毫秒数（壳侧指数退避）。 */
  retryAfterMs?: number
  /** 壳侧截取的启动失败诊断日志（有界 logcat 片段）。 */
  diagnostics?: string
  guidance: string
}

/**
 * issue #262「AI root 权限」开关状态（壳侧 [RootGrant.state] 的同构面）。
 *
 * 判据要点：`channelRoot` 是**通道身份**（Shizuku 服务端 uid==0），不是「设备是否 root」——
 * 已 root 但 Shizuku 以 ADB 启动的设备此值为 false，开关必须置灰（假绿是 issue 点名的缺陷形态）。
 */
interface RootOwnershipStatus {
  readable: boolean
  running: boolean
  overdue: boolean
  startedAt: number
  completedAt: number
  operation?: string
  result: Record<string, unknown> | undefined
}

interface RootGrantStatus {
  /** 状态是否真的读到了（false = 桥缺席/解析失败，界面不得冒充「未授权」以外的任何状态）。 */
  readable: boolean
  granted: boolean
  /** 「已阅读」同意是否对**当前免责声明版本**有效（绑内容版本，不随 APK 升级失效）。 */
  consentValid: boolean
  /** 通道身份 uid（读不到 = -1）。 */
  channelUid: number
  /** 通道身份是否 root（== 开关是否具备开启资格）。 */
  channelRoot: boolean
  /** 应用级 root 授权（Root 管理器）是否已获得——开关放行的第三道门（2026-09-30 主人定例）。 */
  rootGranted: boolean
  /** 应用级 root 授权状态词（unknown/requesting/granted/denied/timeout/no-su）。 */
  rootState: string
  /** 壳侧诚实性说明（策略门 ≠ 技术沙箱）。 */
  honesty: string
  /** Shared single-flight native maintenance, observed by existing root polling. */
  ownership?: RootOwnershipStatus
}

/**
 * 应用级 root 授权面（壳侧 [RootAccess.state] 的同构面，2026-09-30 主人定例）。
 *
 * 「这个开关应该调用一下 root 弹窗，并且检测 root 是否授权，如果没有，请写好引导去
 * Root 管理器，授予 root」——本面就是那条流程的读面：状态 + 管理器 + 引导语。
 */
interface RootAccessStatus {
  readable: boolean
  /** 本机是否存在可执行的 su（未 root / 未装管理器时为 false）。 */
  suExists: boolean
  /** unknown | requesting | granted | denied | timeout | no-su */
  state: string
  uid: number
  granted: boolean
  /** 请求在飞（弹窗已弹出、等用户在管理器上点「允许」）。 */
  requesting: boolean
  /** Root 管理器（KernelSU / Magisk / APatch）。 */
  managerLabel: string
  managerInstalled: boolean
  /** 壳侧引导语（每态都能说清「下一步做什么」）。 */
  guidance: string
}

const STATUS_LABEL: Record<VdisplayState, string> = {
  disabled: tr('已关闭', 'Off'),
  blocked: tr('需要准备', 'Needs setup'),
  ready: tr('可创建', 'Ready'),
  active: tr('已激活', 'Active'),
}

const A11Y_UNREADABLE: A11yStatus = {
  readable: false,
  enabled: false,
  hint: '',
  restrictedSettingsApplies: false,
}

const SHIZUKU_UNREADABLE: ShizukuStatus = {
  readable: false,
  installed: false,
  running: false,
  granted: false,
  bound: false,
  binding: false,
  connectFailures: 0,
  startFailed: false,
  retryAfterMs: 0,
  diagnostics: '',
  guidance: '',
}

const ROOT_GRANT_UNREADABLE: RootGrantStatus = {
  readable: false,
  granted: false,
  consentValid: false,
  channelUid: -1,
  channelRoot: false,
  rootGranted: false,
  rootState: 'unknown',
  honesty: '',
}

const OWNERSHIP_UNREADABLE: RootOwnershipStatus = {
  readable: false, running: false, overdue: false, startedAt: 0, completedAt: 0, result: undefined,
}

function readOwnershipState(value: unknown): RootOwnershipStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return OWNERSHIP_UNREADABLE
  const parsed = value as Record<string, unknown>
  if (typeof parsed.running !== 'boolean') return OWNERSHIP_UNREADABLE
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  const result = parsed.result !== null && typeof parsed.result === 'object' && !Array.isArray(parsed.result)
    ? parsed.result as Record<string, unknown> : undefined
  return { readable: true, running: parsed.running, overdue: parsed.overdue === true,
    startedAt: count(parsed.startedAt), completedAt: count(parsed.completedAt),
    operation: typeof parsed.operation === 'string' ? parsed.operation : undefined, result }
}

/** Submitted/running/unknown results must never be rendered as completed repair. */
export function describeOwnershipRepair(state: RootOwnershipStatus): { ok: boolean | undefined; text: string } | undefined {
  if (!state.readable || state.startedAt === 0) return undefined
  if (state.running) return { ok: state.overdue ? false : undefined,
    text: state.overdue
      ? tr('特权工作结果仍不明，已暂停新派发和维护；不要重复操作。无法确认 helper 结算时请重启设备（仅重启应用不算结算）。', 'The privileged task result is still unknown; new work is paused. If the helper never settles, reboot the device.')
      : state.operation !== undefined && !state.operation.includes('ownership')
        ? tr('正在等待已有特权工作结算，尚未开始文件属主维护。', 'Waiting for another privileged task to settle before the ownership check starts.')
        : tr('属主维护进行中，正在有界检查本应用数据目录；结果会自动刷新。', 'File ownership repair is running a bounded check; the result refreshes on its own.') }
  const result = state.result
  if (result === undefined) return { ok: false, text: tr('属主维护结果不可读，不能确认修复完成；请复制诊断日志。', 'The ownership result is unreadable, so the repair is unconfirmed. Copy the diagnostics.') }
  if (result.skipped === 'no-root-path') return { ok: true, text: tr('当前没有可用 root 修复路径，未执行属主变更。', 'No root repair path is available, so ownership was left unchanged.') }
  const count = (key: string): string => typeof result[key] === 'number' && Number.isFinite(result[key])
    && (result[key] as number) >= 0 ? String(result[key]) : tr('未知', 'unknown')
  const counts = tr(
    '检查 ' + count('checked') + ' 项 / 修复 ' + count('healed') + ' 项 / 失败 ' + count('failures') + ' 项',
    count('checked') + ' checked / ' + count('healed') + ' repaired / ' + count('failures') + ' failed',
  )
  const completeCounts = ['checked', 'healed'].every(key => typeof result[key] === 'number'
    && Number.isSafeInteger(result[key]) && (result[key] as number) >= 0)
  if (result.ok === true && completeCounts && result.truncated === false && result.deadlineExceeded === false
    && result.remaining === 0 && result.unverifiedMutations === 0 && result.failures === 0) {
    return { ok: true, text: tr('文件属主维护完成（' + counts + '）；未进行 SELinux 重标记。', 'File ownership repair finished (' + counts + '); no SELinux relabel was done.') }
  }
  const reason = typeof result.reason === 'string' ? result.reason : typeof result.code === 'string' ? result.code : undefined
  return { ok: false, text: tr('文件属主维护未完成（' + counts + '）：', 'File ownership repair did not finish (' + counts + '): ') + describeCallReason(reason) }
}

const ROOT_ACCESS_UNREADABLE: RootAccessStatus = {
  readable: false,
  suExists: false,
  state: 'unknown',
  uid: -1,
  granted: false,
  requesting: false,
  managerLabel: '',
  managerInstalled: false,
  guidance: '',
}

/** issue #262 用户指定文案（**逐字保留**，未 root 通道下的红字）。 */
export const ROOT_GRANT_NOT_ROOT_TEXT = '无法在未 root 的设备上赋予该权限'

/**
 * 外链/拉起失败原因的中文口径在**唯一真源** `../user-copy.ts`（0.14.1 批 3 / P3-1）。
 *
 * 本文件此前自带一张 `LINK_REASON_LABEL` 局部表——与本页其它面、以及壳侧各自的局部表并存，
 * 于是同一个码在不同界面说法不同。局部表已删除：翻译只此一处，码本身只进 `data-*`。
 */

/**
 * Shizuku 通道状态 → 中文状态词。
 *
 * 五态与壳侧 `ShizukuTransport.status()` 的字段一一对应；顺序即真实推进顺序
 * （未安装 → 未启动 → 未授权 → 未绑定 → 就绪），用户据此知道自己在第几步。
 */
export function shizukuStateLabel(status: ShizukuStatus): string {
  if (!status.readable) return tr('状态不可读', 'Status unavailable')
  if (!status.installed) return tr('未安装', 'Not installed')
  if (!status.running) return tr('已安装，Shizuku 未启动', 'Installed, Shizuku not running')
  if (!status.granted) return tr('已启动，尚未授权', 'Running, not granted')
  if (!status.bound) {
    if (status.binding) return tr('已授权，通道建立中', 'Granted, connecting')
    // issue #471：连续启动失败是一条独立的事实，不得继续被「通道未建立」一笔带过。
    if (status.startFailed === true) {
      return tr('已授权，用户服务启动失败', 'Granted, UserService failed to start')
    }
    return tr('已授权，通道未建立', 'Granted, not connected')
  }
  return tr('通道就绪', 'Channel ready')
}

/** 壳侧 guidance 缺失时的兜底说明（每态都能说清「下一步做什么」）。 */
export function shizukuStepHint(status: ShizukuStatus): string {
  if (!status.readable) return tr('读不到 Shizuku 状态：壳侧桥未装配或解析失败。', 'Cannot read Shizuku status: the app bridge is missing or the reply did not parse.')
  if (!status.installed) return tr('点「下载 Shizuku」到发布页装好，再回来点「打开 Shizuku」。', 'Tap Download Shizuku, install it, then come back and tap Open Shizuku.')
  if (!status.running) return tr('点「打开 Shizuku」，在应用内按提示用无线调试启动它（重启设备后需要重做一次）。', 'Tap Open Shizuku and start it there with wireless debugging; repeat after a reboot.')
  if (!status.granted) return tr('点「打开 Shizuku」，在里面允许本应用使用 Shizuku——授权只能由你亲手完成。', 'Tap Open Shizuku and allow this app inside it; only you can grant this.')
  if (!status.bound && status.startFailed === true) {
    return tr(
      '用户服务连续启动失败，展开下方诊断日志查看真实原因。若使用 Shizuku 13.6.0，可降级到 13.5.4，或改用 ADB 通道。',
      'The UserService keeps failing to start. Expand the startup log below. If you use Shizuku 13.6.0, downgrade to 13.5.4 or switch to the ADB channel.',
    )
  }
  if (!status.bound) return tr('状态每 2 秒自动刷新，稍等即可；一直停在这里可以点「打开 Shizuku」重进一次。', 'Status refreshes every 2 seconds; if it stays here, open Shizuku once more.')
  return tr('特权通道已就绪，虚拟屏与特权 shell 可以用了。', 'The privileged channel is ready; virtual screens and the privileged shell work now.')
}

export function parseRootReply(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

interface BridgeAnswer {
  ok?: boolean
  reason?: string
  message?: string
}

function parseAnswer(raw: string | undefined): BridgeAnswer | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    return JSON.parse(raw) as BridgeAnswer
  } catch {
    return undefined
  }
}

/** 外链/拉起类调用统一结算：成功给人话，失败给「原因 + 下一步」，绝不静默。 */
export function settleLinkCall(
  raw: string | undefined,
  okText: string,
  failLead: string,
): { ok: boolean; text: string } {
  const answer = parseAnswer(raw)
  if (answer?.ok === true) return { ok: true, text: okText }
  return { ok: false, text: failLead + '：' + describeCallReason(answer?.reason) }
}

/** 受限设置解锁结算（壳侧回 `{ok, message}`，message 已是人话）。 */
export function settleUnlockCall(raw: string | undefined): { ok: boolean; text: string } {
  const answer = parseAnswer(raw)
  if (answer?.ok === true) {
    return { ok: true, text: answer.message ?? tr('已解锁受限设置，现在可以回系统页开启无障碍服务。', 'Restricted settings unlocked; go back to the system page and turn on accessibility.') }
  }
  return {
    ok: false,
    text: tr('解锁失败：', 'Unlock failed: ') + (answer?.message ?? describeCallReason(answer?.reason)),
  }
}

function readScope(): ScreenScope {
  try {
    const raw = window.androidBridge?.getScreenScope?.()
    if (SCOPES.includes(raw as ScreenScope)) return raw as ScreenScope
  } catch {
    /* old/desktop shells retain the safe default */
  }
  return 'virtual-only'
}

function readVdisplay(): VdisplayStatus {
  try {
    const raw = window.androidBridge?.vdisplayStatus?.()
    const parsed = raw ? JSON.parse(raw) as Partial<VdisplayStatus> : undefined
    const state = parsed?.state
    return {
      state: state === 'disabled' || state === 'blocked' || state === 'ready' || state === 'active' ? state : 'blocked',
      code: typeof parsed?.code === 'string' ? parsed.code : 'vdisplay-status-unavailable',
      guidance: typeof parsed?.guidance === 'string'
        ? parsed.guidance
        : tr('虚拟屏状态暂不可读；不会把虚拟屏请求回退到真实屏幕。', 'Virtual screen status is unavailable; requests are not sent to the real screen.'),
      ...(typeof parsed?.displayId === 'number' ? { displayId: parsed.displayId } : {}),
    }
  } catch {
    // P3-6：旧文案是「虚拟屏状态读取失败（fail-closed）。」——`fail-closed` 是内部策略词，
    // 对用户没有意义；这里说清「读不到 + 不会做什么 + 能做什么」，策略词只留在 code 里。
    return { state: 'blocked', code: 'vdisplay-status-unavailable', guidance: tr('读不到虚拟屏状态：应用内桥未接好或解析失败。重新打开应用再试；读不到时不会把虚拟屏请求回退到真实屏幕。', 'Cannot read virtual screen status: the app bridge is missing or the reply did not parse. Requests are not sent to the real screen.') }
  }
}

function readScale(): number {
  try {
    const value = window.androidBridge?.getVdisplayScale?.()
    if (typeof value === 'number' && Number.isFinite(value)) return value
  } catch {
    /* fall through to the default tier */
  }
  return 0.75
}

function readFloat(): boolean {
  try {
    return window.androidBridge?.getVdisplayFloatEnabled?.() ?? true
  } catch {
    return true
  }
}

/**
 * Shizuku 通道状态（**唯一**「装没装」的事实来源）。
 *
 * `installed` 字段决定「打开 Shizuku」是否可点：拿不到状态时按**未安装**处理（复用
 * [SHIZUKU_UNREADABLE]），于是按钮不可点而不是点了没反应——死路形态在本页被结构性排除。
 */
export function readShizuku(): ShizukuStatus {
  try {
    const raw = window.androidBridge?.shizukuStatus?.()
    const parsed = parseRootReply(raw)
    if (parsed === undefined || typeof parsed.installed !== 'boolean') return SHIZUKU_UNREADABLE
    return {
      readable: true,
      installed: parsed.installed === true,
      running: parsed.running === true,
      granted: parsed.granted === true,
      bound: parsed.bound === true,
      binding: parsed.binding === true,
      connectFailures: typeof parsed.connectFailures === 'number' ? parsed.connectFailures : 0,
      startFailed: parsed.startFailed === true,
      retryAfterMs: typeof parsed.retryAfterMs === 'number' ? parsed.retryAfterMs : 0,
      diagnostics: typeof parsed.diagnostics === 'string' ? parsed.diagnostics : '',
      guidance: typeof parsed.guidance === 'string' ? parsed.guidance : '',
    }
  } catch {
    return SHIZUKU_UNREADABLE
  }
}

/**
 * issue #262「AI root 权限」读面（壳侧 [RootGrant.state] 的桥接）。
 *
 * 读不到一律回落 [ROOT_GRANT_UNREADABLE]（`readable:false`）：界面据此显示「状态不可读」
 * 而不是冒充「未授权」或「可开启」——与 [readShizuku] 同纪律。
 */
export function readRootGrant(): RootGrantStatus {
  try {
    const raw = window.androidBridge?.rootGrantState?.()
    const parsed = parseRootReply(raw)
    if (parsed === undefined || typeof parsed.granted !== 'boolean') return ROOT_GRANT_UNREADABLE
    return {
      readable: true,
      granted: parsed.granted === true,
      consentValid: parsed.consentValid === true,
      channelUid: typeof parsed.channelUid === 'number' ? parsed.channelUid : -1,
      channelRoot: parsed.channelRoot === true,
      rootGranted: parsed.rootGranted === true,
      rootState: typeof parsed.rootState === 'string' ? parsed.rootState : 'unknown',
      honesty: typeof parsed.honesty === 'string' ? parsed.honesty : '',
      ownership: readOwnershipState(parsed.ownership),
    }
  } catch {
    return ROOT_GRANT_UNREADABLE
  }
}

/**
 * 应用级 root 授权读面（壳侧 [RootAccess.state] 的桥接）。
 *
 * 读不到一律回落 [ROOT_ACCESS_UNREADABLE]（`readable:false`）：界面据此显示「状态不可读」
 * 而不是冒充「未授权」或「已授权」——与 [readRootGrant] 同纪律。
 */
export function readRootAccess(): RootAccessStatus {
  try {
    const raw = window.androidBridge?.rootAccessState?.()
    const parsed = parseRootReply(raw)
    if (parsed === undefined || typeof parsed.state !== 'string') return ROOT_ACCESS_UNREADABLE
    const manager = (parsed.manager ?? {}) as Record<string, unknown>
    return {
      readable: true,
      suExists: parsed.suExists === true,
      state: parsed.state,
      uid: typeof parsed.uid === 'number' ? parsed.uid : -1,
      granted: parsed.granted === true,
      requesting: parsed.requesting === true,
      managerLabel: typeof manager.label === 'string' ? manager.label : '',
      managerInstalled: manager.installed === true,
      guidance: typeof parsed.guidance === 'string' ? parsed.guidance : '',
    }
  } catch {
    return ROOT_ACCESS_UNREADABLE
  }
}

/** 应用级 root 授权状态 → 中文状态词（与壳侧 RootAccess 的状态常量一一对应）。 */
export function rootAccessStateLabel(status: RootAccessStatus): string {
  if (!status.readable) return tr('状态不可读', 'Status unavailable')
  switch (status.state) {
    case 'granted': return tr('已授权（uid 0）', 'Granted (uid 0)')
    case 'requesting': return tr('正在检测授权…', 'Checking the grant…')
    case 'denied': return tr('已拒绝', 'Denied')
    case 'timeout': return tr('检测超时，请在管理器确认后重试', 'Check timed out; confirm in your root manager and retry')
    case 'no-su': return tr('本机没有可用的 su', 'No usable su on this device')
    default: return tr('未检测', 'Not checked')
  }
}

/** 请求按钮可否点：有 su 且没有请求在飞。 */
export function canRequestRoot(status: RootAccessStatus): boolean {
  return status.readable && status.suExists && !status.requesting
}

/**
 * 开关状态 → 中文状态词（与壳侧字段一一对应，供测试直接断言）。
 *
 * 顺序即真实判据顺序：读不到 → 通道非 root（置灰）→ 未授权 → 已授权。
 */
export function rootGrantStateLabel(status: RootGrantStatus): string {
  if (!status.readable) return tr('状态不可读', 'Status unavailable')
  if (!status.channelRoot && !status.rootGranted) return tr('没有可用 root 通道', 'No root channel')
  if (!status.granted) return tr('未授权', 'Not granted')
  return tr('已授权（AI 可用 root）', 'Granted (model can use root)')
}

/** 开关可否点击：只有**通道身份确为 root**才可点（读不到/非 root 一律不可点）。 */
export function canToggleRootGrant(status: RootGrantStatus): boolean {
  return status.readable && (status.channelRoot || status.rootGranted)
}

/** Shizuku 以 ADB（shell）身份启动时的通道 uid（issue #262 点名的分流判据）。 */
export const SHIZUKU_SHELL_UID = 2000

/**
 * 非 root 通道下的引导语（issue #262 要求**按通道身份分流**，2026-09-30 对账补）：
 *  - 通道 uid == 2000（Shizuku 以 ADB 启动，设备**可能已 root**）⇒ 引导「在 Shizuku 内以 root 启动」；
 *  - 其它（无通道 / 未 root）⇒ 用户指定红字「无法在未 root 的设备上赋予该权限」（逐字）。
 *
 * 两者都置灰开关；区别只在**用户下一步该做什么**——把已 root 的设备误报成「未 root」会让人
 * 去折腾设备 root，而真正要做的是重启 Shizuku 的启动方式。
 */
export function rootGrantChannelHint(status: RootGrantStatus): { text: string; kind: 'shell-identity' | 'not-root' | 'none' } {
  if (!status.readable) return { text: '', kind: 'none' }
  if (status.channelRoot) return { text: '', kind: 'none' }
  if (status.channelUid === SHIZUKU_SHELL_UID) {
    return {
      text: tr(
        'Shizuku 当前以 shell（uid 2000）身份运行——请在 Shizuku 内以 root 启动它，再回到本页开启。',
        'Shizuku runs as shell (uid 2000). Start it as root inside Shizuku, then turn this on here.',
      ),
      kind: 'shell-identity',
    }
  }
  return {
    text: tr(ROOT_GRANT_NOT_ROOT_TEXT, 'Cannot grant this on a device without root'),
    kind: 'not-root',
  }
}

/** 无障碍通道状态；读不到时如实报不可读，不冒充「未开启」（0.14.1 UI 审查 P1）。 */
export function readA11y(): A11yStatus {
  try {
    const raw = window.androidBridge?.a11yStatus?.()
    if (typeof raw === 'string' && raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return {
        readable: true,
        enabled: parsed.enabled === true,
        hint: typeof parsed.hint === 'string' ? parsed.hint : '',
        restrictedSettingsApplies: parsed.restrictedSettingsApplies === true,
      }
    }
  } catch {
    /* bridge absent: report unavailable rather than guessing */
  }
  return A11Y_UNREADABLE
}

/**
 * 渲染「手机控制」设置分区。
 * @returns 分区元素树。
 */
export function PhoneControlSection(_props: PropsRuntime<'settings.section'>) {
  const [scope, refreshScope] = useShellState<ScreenScope>(readScope)
  const [vdisplay, refreshVdisplay] = useShellState<VdisplayStatus>(readVdisplay, { pollMs: 2_000 })
  const [shizuku, refreshShizuku] = useShellState<ShizukuStatus>(readShizuku, { pollMs: 2_000 })
  const [scale, refreshScale] = useShellState<number>(readScale)
  const [floatOn, refreshFloat] = useShellState<boolean>(readFloat)
  const [a11y, refreshA11y] = useShellState<A11yStatus>(readA11y, { pollMs: 3_000 })
  // issue #262：root 授权面（2s 轮询与 Shizuku 面同拍——开关资格取决于通道身份，二者必须同源同拍）。
  const [rootGrant, refreshRootGrant] = useShellState<RootGrantStatus>(readRootGrant, { pollMs: 2_000 })
  // 2026-09-30 主人定例：应用级 root 授权面（2s 同拍——开关资格与授权状态必须同源同拍）。
  const [rootAccess, refreshRootAccess] = useShellState<RootAccessStatus>(readRootAccess, { pollMs: 2_000 })
  /** 用户尝试开启开关但 root 未授权：壳侧已弹授权框，授权一到就自动续开（见下方 effect）。 */
  const [pendingEnable, setPendingEnable] = useState(false)
  const [rootMsg, setRootMsg] = useState<string | null>(null)
  const [rootOk, setRootOk] = useState<boolean | null>(null)
  const [confirmStage, setConfirmStage] = useState(0)
  // 失败回执带 `code`：码只进 `data-code`（可 grep / 可截图给维护方），不进正文（P3-1/P3-6）。
  const [forceMsg, setForceMsg] = useState<{ ok: boolean; text: string; code?: string } | null>(null)
  const [shizukuMsg, setShizukuMsg] = useState<string | null>(null)
  const [shizukuOk, setShizukuOk] = useState<boolean | null>(null)
  const [a11yMsg, setA11yMsg] = useState<string | null>(null)
  const [a11yOk, setA11yOk] = useState<boolean | null>(null)

  // 三连点确认：4 秒内没有下一步就复位，避免「隔很久点一下」误触。
  useEffect(() => {
    if (confirmStage === 0) return undefined
    const timer = window.setTimeout(() => setConfirmStage(0), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmStage])

  const setScope = useCallback((next: ScreenScope) => {
    try { window.androidBridge?.setScreenScope?.(next) } catch { /* readback keeps the truth */ }
    refreshScope()
  }, [refreshScope])

  const setScale = useCallback((next: number) => {
    try { window.androidBridge?.setVdisplayScale?.(next) } catch { /* readback keeps the truth */ }
    refreshScale()
  }, [refreshScale])

  const setFloat = useCallback((enable: boolean) => {
    try { window.androidBridge?.setVdisplayFloatEnabled?.(enable) } catch { /* readback keeps the truth */ }
    refreshFloat()
  }, [refreshFloat])

  const openA11y = useCallback(() => {
    try { window.androidBridge?.openA11ySettings?.() } catch { /* bridge absent on desktop */ }
  }, [])

  const unlockA11y = useCallback(() => {
    let raw: string | undefined
    try { raw = window.androidBridge?.unlockRestrictedSettings?.() } catch { raw = undefined }
    const settled = settleUnlockCall(raw)
    setA11yOk(settled.ok)
    setA11yMsg(settled.text)
    refreshA11y()
  }, [refreshA11y])

  /** 外链与拉起的共同收口（两个入口共用一条通道，结算也共用）。 */
  const runShizukuAction = useCallback((
    call: (() => string) | undefined,
    okText: string,
    failLead: string,
  ) => {
    let raw: string | undefined
    try { raw = call?.() } catch { raw = undefined }
    const settled = settleLinkCall(raw, okText, failLead)
    setShizukuOk(settled.ok)
    setShizukuMsg(settled.text)
    refreshShizuku()
  }, [refreshShizuku])

  const downloadShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openExternalLink
        ? () => window.androidBridge!.openExternalLink!(LINK_DOWNLOAD)
        : undefined,
      tr('已打开 Shizuku 发布页——下载 release 版 APK 装好后回到这里。', 'The Shizuku release page is open; install the release APK, then come back.'),
      tr('打开下载页失败', 'Could not open the download page'),
    )
  }, [runShizukuAction])

  const tutorialShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openExternalLink
        ? () => window.androidBridge!.openExternalLink!(LINK_TUTORIAL)
        : undefined,
      tr('已用浏览器打开视频教程。', 'The video tutorial is open in the browser.'),
      tr('打开教程失败', 'Could not open the tutorial'),
    )
  }, [runShizukuAction])

  const openShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.openShizukuManager
        ? () => window.androidBridge!.openShizukuManager!()
        : undefined,
      tr('已打开 Shizuku——在那里启动并授权后，回到本页状态会自动刷新。', 'Shizuku is open; start and grant it there, then come back. Status refreshes on its own.'),
      tr('打开 Shizuku 失败', 'Could not open Shizuku'),
    )
  }, [runShizukuAction])

  /**
   * 2026-09-30：**显式请求 Shizuku 授权**。
   *
   * 实测缺陷：授权请求此前只在 `ensureBound` 的后台路径自动发起，而 Shizuku 的
   * `requestPermission` 需要前台 Activity 才能把对话框落到用户眼前 ⇒ 静默失败，
   * 管理器「应用管理」列表里根本没有本应用、状态恒 denied，用户没有任何可点的授权入口。
   * 本入口在 UI 线程发起请求，对话框随即出现。
   */
  const requestShizukuPermission = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.requestShizukuPermission
        ? () => window.androidBridge!.requestShizukuPermission!()
        : undefined,
      tr('已发起 Shizuku 授权请求——请在弹窗上点「允许」（本页每 2 秒自动刷新）。', 'Shizuku grant requested; tap Allow in the dialog. This page refreshes every 2 seconds.'),
      tr('请求 Shizuku 授权失败', 'The Shizuku grant request failed'),
    )
  }, [runShizukuAction])

  /**
   * 「重置链接」：强制移除 Shizuku 侧 UserService 并清空绑定态。
   *
   * 与「刷新状态」同一行（都是非破坏性只读/自愈动作），结算沿用既有 [runShizukuAction] →
   * [settleLinkCall]，**不新造结算口径**：壳侧回 {ok, code/guidance}，ok=false 走失败支并把人话原因说清。
   *
   * 「持续扫描链接」= 既有的 2 秒轮询（[runShizukuAction] 内部已调 refreshShizuku 立刻回读一次，
   * 之后交给 useShellState 的 2s 轮询自然收敛）。**不新开定时器**：新增常驻轮询=新增常驻 CPU，
   * 与 T1（dsh-model-capability 每 5s 全量 describe 造成 24-26% CPU）同族，明确禁止。
   */
  const resetShizuku = useCallback(() => {
    runShizukuAction(
      window.androidBridge?.resetShizukuConnection
        ? () => window.androidBridge!.resetShizukuConnection!()
        : undefined,
      tr('已重置 Shizuku 连接，正在重新建立通道（本页每 2 秒自动重扫）。', 'Shizuku link reset; the channel is reconnecting. This page rescans every 2 seconds.'),
      tr('重置 Shizuku 连接失败', 'Could not reset the Shizuku link'),
    )
  }, [runShizukuAction])

  /**
   * issue #262：root 授权面三个动作（开关 / 「已阅读」确认 / 免责声明）的共同收口。
   *
   * 结算口径沿用 [settleLinkCall]（壳侧回 {ok, code/guidance}），写后立刻 [refreshRootGrant] 回读——
   * 不新造结算口径、不新开定时器（2s 轮询已由 useShellState 承担）。
   */
  const runRootAction = useCallback((
    call: (() => string) | undefined,
    okText: string,
    failLead: string,
    preRaw?: string,
  ) => {
    let raw: string | undefined = preRaw
    if (raw === undefined) {
      try { raw = call?.() } catch { raw = undefined }
    }
    const settled = settleLinkCall(raw, okText, failLead)
    setRootOk(settled.ok)
    setRootMsg(settled.text)
    refreshRootGrant()
    refreshRootAccess()
  }, [refreshRootGrant, refreshRootAccess])

  const toggleRootGrant = useCallback((next: boolean) => {
    // 尝试开启 ⇒ 记 pending：若壳侧因「root 未授权」拦下并弹出授权框，授权一到自动续开。
    setPendingEnable(false)
    let raw: string | undefined
    try {
      raw = window.androidBridge?.setRootGranted ? window.androidBridge.setRootGranted(next) : undefined
    } catch { raw = undefined }
    // 「请求已发起」不是失败（2026-09-30 复核补）：壳侧在被第三道门拦下时当场弹授权框并回
    // `code=request-started`——渲染成「进行中」，否则用户先看到红字「开启失败」、2 秒后开关
    // 又自己开起来（提示与实际结果自相矛盾）。
    const parsed = parseRootReply(raw)
    if (next && parsed?.code === 'request-started') {
      setPendingEnable(true)
      setRootOk(true)
      setRootMsg(tr('正在检测 root 授权。若没有弹窗，请在你使用的 Root 管理器中允许本应用；授权后会继续本次开启操作。', 'Checking root access. If no dialog appears, allow this app in your root manager; the switch turns on once granted.'))
      refreshRootGrant()
      refreshRootAccess()
      return
    }
    runRootAction(
      undefined,
      next
        ? tr('已开启 AI root 权限：特权通道按 root 身份执行，请在需要时使用、用完即关。', 'Model root access is on: the privileged channel runs as root. Use it only when needed and turn it off afterwards.')
        : tr('已关闭 AI root 权限：特权通道已恢复整体拒绝。', 'Model root access is off: the privileged channel refuses root again.'),
      next ? tr('开启 AI root 权限失败', 'Could not turn on model root access') : tr('关闭 AI root 权限失败', 'Could not turn off model root access'),
      raw,
    )
  }, [runRootAction, refreshRootGrant, refreshRootAccess])

  /**
   * 检测 / 尝试获取 root 授权（壳侧后台跑一次 `su -c id`；本页 2s 轮询看到结果）。
   *
   * ★口径（2026-09-30 主人指正）：**多数 Root 管理器不再自动弹授权框**（除 Magisk 外，
   * 用户得自己打开管理器授予）✗ ⇒ 文案**不承诺"会弹窗"**，只承诺"取一次真实身份并如实回报" ✓。
   */
  const requestRoot = useCallback(() => {
    runRootAction(
      window.androidBridge?.requestRootAccess
        ? () => window.androidBridge!.requestRootAccess!()
        : undefined,
      tr('已发起 root 授权检测，结果会自动刷新；检测成功不代表 AI root 开关已开启。', 'Root access check started; the result refreshes on its own. A pass does not turn on model root access.'),
      tr('检测 root 授权未通过', 'The root access check did not pass'),
    )
    refreshRootAccess()
  }, [runRootAction, refreshRootAccess])

  const [repairReply, setRepairReply] = useState<RootOwnershipStatus | undefined>()
  const [repairFailure, setRepairFailure] = useState<string | undefined>()
  const polledRepair = rootGrant.ownership ?? OWNERSHIP_UNREADABLE
  const repairState = polledRepair.readable && polledRepair.startedAt >= (repairReply?.startedAt ?? 0)
    ? polledRepair : repairReply ?? polledRepair
  const repairFeedback = repairFailure === undefined ? describeOwnershipRepair(repairState) : { ok: false, text: repairFailure }

  /** Native request is asynchronous and single-flight; only later native result counts as completed. */
  const repairOwnership = useCallback(() => {
    let raw: string | undefined
    try { raw = window.androidBridge?.repairRootOwnership?.() } catch { raw = undefined }
    const parsed = parseRootReply(raw)
    const observed = readOwnershipState(parsed)
    if (parsed?.ok === true && (parsed.code === 'repair-started' || parsed.code === 'repair-running')
      && observed.readable && observed.startedAt > 0
      && (observed.running || (observed.completedAt >= observed.startedAt && observed.result !== undefined))) {
      setRepairReply(observed)
      setRepairFailure(undefined)
    } else {
      setRepairFailure('启动文件属主维护失败：' + describeCallReason(typeof parsed?.reason === 'string' ? parsed.reason : undefined))
    }
    refreshRootGrant()
  }, [refreshRootGrant])

  /**
   * 自动续开（2026-09-30 主人定例的体验闭环）：用户开开关 → 壳侧因「root 未授权」拦下并
   * **弹出授权框** → 用户点「允许」→ 本页 2s 轮询看到 `rootAccess.granted` → 自动把开关续开。
   * 用户只需点一次开关 + 在弹窗上点一次「允许」，不必回设置页再点一次。
   */
  useEffect(() => {
    if (!pendingEnable) return
    if (!rootGrant.consentValid || ['denied', 'timeout', 'no-su'].includes(rootAccess.state)) {
      setPendingEnable(false)
      return
    }
    if (rootGrant.granted) {
      setPendingEnable(false)
      return
    }
    if (rootAccess.granted) {
      setPendingEnable(false)
      toggleRootGrant(true)
    }
  }, [pendingEnable, rootGrant.granted, rootGrant.consentValid, rootAccess.granted, rootAccess.state, toggleRootGrant])

  const toggleRootConsent = useCallback((next: boolean) => {
    runRootAction(
      window.androidBridge?.setRootConsent
        ? () => window.androidBridge!.setRootConsent!(next)
        : undefined,
      next
        ? tr('已记录「已阅读」——与免责声明版本绑定，应用升级不需重新确认；免责声明内容更新后才需再确认。', 'Marked as read; this stays valid across app updates until the disclaimer text changes.')
        : tr('已撤销同意，并同时关闭了 AI root 权限。', 'Consent withdrawn; model root access was turned off too.'),
      next ? tr('记录「已阅读」失败', 'Could not record the read confirmation') : tr('撤销同意失败', 'Could not withdraw consent'),
    )
  }, [runRootAction])

  const openRootDisclaimer = useCallback(() => {
    runRootAction(
      window.androidBridge?.openRootDisclaimer
        ? () => window.androidBridge!.openRootDisclaimer!()
        : undefined,
      tr('已打开免责声明（APK 内置文档，离线可读）。', 'The disclaimer is open (bundled in the app, works offline).'),
      tr('打开免责声明失败', 'Could not open the disclaimer'),
    )
  }, [runRootAction])

  const tapForce = useCallback(() => {
    const next = confirmStage + 1
    if (next < 3) {
      setConfirmStage(next)
      setForceMsg(null)
      return
    }
    setConfirmStage(0)
    try {
      const raw = window.androidBridge?.forceDestroyVdisplay?.()
      const parsed = raw ? JSON.parse(raw) as { ok?: boolean; code?: string } : undefined
      const ok = parsed?.ok === true
      setForceMsg(ok
        ? { ok: true, text: tr('已强制销毁全部虚拟屏。', 'All virtual screens were destroyed.') }
        : { ok: false, text: tr('销毁失败：', 'Destroy failed: ') + describeCallReason(parsed?.code), code: String(parsed?.code ?? 'unknown') })
    } catch {
      setForceMsg({ ok: false, text: tr('销毁调用失败（应用内桥不可用）——请重新打开应用后重试。', 'The destroy call failed: the app bridge is unavailable. Reopen the app and retry.'), code: 'bridge-threw' })
    }
    refreshVdisplay()
  }, [confirmStage, refreshVdisplay])

  const forceLabel = confirmStage === 0
    ? tr('强制销毁虚拟屏', 'Force destroy virtual screens')
    : tr('再次点击确认（', 'Tap again to confirm (') + confirmStage + '/3)'
  // P5-5：进入确认态后必须给**取消途径**。旧实现没有任何退出通道——误点一下就只能
  // 「再点两下把它执行掉」或者等 4 秒超时（超时不可见，用户并不知道自己还能等）。
  const forceArmed = confirmStage > 0
  const cancelForce = useCallback(() => {
    setConfirmStage(0)
    setForceMsg(null)
  }, [])

  // 「打开 Shizuku」的可点条件：只有**确知已安装**才可点（读不到状态时按未安装处理）。
  const canOpenShizuku = shizuku.readable && shizuku.installed

  return (
    <section
      className="dsh-screen-control-card"
      aria-labelledby="dsh-phone-control-title"
      {...(vdisplay.displayId === undefined ? {} : { 'data-display-id': String(vdisplay.displayId) })}
    >
      <header className="dsh-screen-control-header">
        <span>
          <strong id="dsh-phone-control-title">{tr('手机控制', 'Phone control')}</strong>
          <small>{tr('屏幕与特权通道的授权设置；模型改不了这里的设置。', 'Screen and privileged channel settings. The model cannot change them.')}</small>
        </span>
        <span className="dsh-screen-control-state" data-state={vdisplay.state}>{STATUS_LABEL[vdisplay.state]}</span>
      </header>

      {/* 虚拟屏的状态说明：壳侧在 blocked 态把 Shizuku 的 guidance 原样透给 vdisplayStatus，
          于是这句话会和下面 Shizuku 区块**逐字重复**（0.14.1 设备实测）。按值去重——
          只是不重复同一句，不臆造替代文案。 */}
      {vdisplay.guidance !== shizuku.guidance ? (
        <p className="dsh-dev-hint">{vdisplay.guidance}</p>
      ) : null}

      <div className="dsh-screen-control-detail">
        <strong>{tr('Shizuku 特权通道', 'Shizuku privileged channel')}</strong>
        <span data-code={shizuku.readable ? undefined : 'shizuku-status-unreadable'}>
          {shizukuStateLabel(shizuku)}
        </span>
      </div>
      <p className="dsh-dev-hint">
        {shizuku.guidance !== '' ? shizuku.guidance : shizukuStepHint(shizuku)}
      </p>
      {/* issue #471：连续启动失败时把壳侧截取的子进程堆栈直接展开给用户/反馈者，
          不再让真实原因只沉在 logcat 里。 */}
      {shizuku.diagnostics ? (
        <details className="dsh-dev-diag">
          <summary>{tr('查看启动失败诊断日志', 'Show the startup failure log')}</summary>
          <pre>{shizuku.diagnostics}</pre>
        </details>
      ) : null}
      <div className="dsh-dev-row dsh-dev-split">
        <button type="button" className="dsh-dev-btn" onClick={downloadShizuku}>{tr('下载 Shizuku', 'Download Shizuku')}</button>
        <button
          type="button"
          className="dsh-dev-btn"
          disabled={!canOpenShizuku}
          onClick={openShizuku}
        >
          {tr('打开 Shizuku', 'Open Shizuku')}
        </button>
      </div>
      {/* 精简（0.14.7-B D5）：保留「两个入口都会跳出去」「授权只能由你亲手完成」；状态自动刷新
          这句已由上方状态行与本页 2 秒轮询承担，不再复述。 */}
      <p className="dsh-dev-hint">{tr('两个入口都会跳到应用外（系统浏览器 / Shizuku 应用）；装好并授权后回本页即可，授权只能在 Shizuku 内由你亲手完成。', 'Both buttons leave the app (browser or Shizuku). Come back here after installing and granting; only you can grant inside Shizuku.')}</p>
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-link" onClick={tutorialShizuku}>{tr('点击查看教程', 'Watch the tutorial')}</button>
        <button type="button" className="dsh-dev-btn" onClick={refreshShizuku}>{tr('刷新状态', 'Refresh status')}</button>
        <button type="button" className="dsh-dev-btn" onClick={resetShizuku}>{tr('重置链接', 'Reset link')}</button>
      </div>
      {shizuku.granted ? null : (
        <div className="dsh-dev-row">
          <button
            type="button"
            className="dsh-dev-btn"
            disabled={!shizuku.readable || !shizuku.running}
            onClick={requestShizukuPermission}
          >
            {tr('请求 Shizuku 授权', 'Request Shizuku access')}
          </button>
          {/* 失败机理保留（用户据此判断「为什么点了没反应」），只压掉重复的前提句。 */}
          <span className="dsh-dev-hint">{tr('授权框需要前台界面才会弹出，后台自动请求会静默失败。', 'The grant dialog only appears with the app in front; background requests fail silently.')}</span>
        </div>
      )}
      {shizukuMsg === null ? null : (
        <p className={shizukuOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{shizukuMsg}</p>
      )}

      <section className="dsh-root-access-card" aria-label={tr('Root 权限设置', 'Root access settings')}>
        <div className="dsh-screen-control-header">
          <span><strong>{tr('Root 权限', 'Root access')}</strong><small>{tr('先确认可用通道，再决定是否允许 AI 使用。', 'Confirm an available channel before letting the model use it.')}</small></span>
          <span className="dsh-screen-control-state" data-state={rootGrant.granted ? 'active' : 'disabled'}>
            {rootGrant.granted ? tr('AI 已开启', 'Model access on') : tr('AI 未开启', 'Model access off')}
          </span>
        </div>

        <div className="dsh-root-step">
          <div className="dsh-screen-control-detail">
            <strong>{tr('1. 应用 root 授权', '1. App root access')}</strong>
            <span data-code={rootAccess.readable ? rootAccess.state : 'root-access-unreadable'}>
              {rootAccessStateLabel(rootAccess)}
            </span>
          </div>
          <p className="dsh-dev-hint">
            {rootAccess.guidance || tr('检测应用的 su 授权；Shizuku 已以 root 启动时，也可直接使用该通道。', 'Checks the app su grant. If Shizuku runs as root, that channel works too.')}
          </p>
          <button type="button" className="dsh-dev-btn" disabled={!canRequestRoot(rootAccess)} onClick={requestRoot}>
            {rootAccess.requesting ? tr('正在检测…', 'Checking…') : tr('检测 root 授权', 'Check root access')}
          </button>
          {rootAccess.managerInstalled ? (
            <p className="dsh-dev-hint">{tr('Root 管理器：', 'Root manager: ')}{rootAccess.managerLabel}{tr('——在管理器中允许本应用，再回这里检测。', ' — allow this app there, then check again here.')}</p>
          ) : null}
        </div>

        <div className="dsh-root-step">
          <div className="dsh-screen-control-detail">
            <strong>{tr('2. AI root 权限', '2. Model root access')}</strong>
            <span data-code={rootGrant.readable ? undefined : 'root-grant-unreadable'}>{rootGrantStateLabel(rootGrant)}</span>
          </div>
          {!rootGrant.readable ? (
            <p className="dsh-dev-error">{tr('授权状态不可读。重新打开应用再试；读不到时不会允许 AI 使用 root。', 'The grant state cannot be read. Reopen the app; without it, the model never gets root.')}</p>
          ) : !rootGrant.channelRoot && !rootGrant.rootGranted ? (
            <p className={rootGrantChannelHint(rootGrant).kind === 'shell-identity' ? 'dsh-dev-hint' : 'dsh-dev-error'}
              data-code={rootGrantChannelHint(rootGrant).kind === 'shell-identity' ? 'shizuku-shell-identity' : 'not-root-channel'}>
              {rootGrantChannelHint(rootGrant).text}
            </p>
          ) : (
            <p className="dsh-dev-hint">{tr('可用通道：', 'Channel: ')}{rootGrant.channelRoot ? 'Shizuku root' : tr('应用 su root', 'app su root')}{tr('。应用获得授权不等于已允许 AI 使用。', '. An app grant does not by itself allow the model.')}</p>
          )}
          <button type="button" className="dsh-dev-link" onClick={openRootDisclaimer}>{tr('阅读《AI root 权限免责声明》', 'Read the root access disclaimer')}</button>
          <label className="dsh-screen-scope-row dsh-root-toggle-row">
            <span><strong>{tr('已阅读免责声明', 'Disclaimer read')}</strong><small>{tr('理解 root 操作可能修改或删除系统与个人数据，并承担相应风险。应用升级不需重新确认（免责声明内容更新时才需）；撤销同意会同时关闭 AI 开关。', 'Root operations can change or delete system and personal data, and you accept that risk. App updates keep this consent; revoking it also turns model access off.')}</small></span>
            <input type="checkbox" aria-label={tr('已阅读免责声明', 'Disclaimer read')} checked={rootGrant.consentValid}
              disabled={!rootGrant.readable} onChange={(event) => toggleRootConsent(event.target.checked)} />
          </label>
          <label className="dsh-screen-scope-row dsh-root-toggle-row">
            <span><strong>{tr('授权 AI 使用 root', 'Allow model root access')}</strong><small>{rootGrant.honesty || tr('这是策略与知情同意开关，不是技术沙箱。关闭后 AI 的 root 执行路径会被拒绝。', 'This is a policy and consent switch, not a sandbox. When off, model root execution is refused.')}</small></span>
            <input type="checkbox" role="switch" aria-label={tr('授权 AI 使用 root', 'Allow model root access')} checked={rootGrant.granted}
              disabled={!rootGrant.readable || (!rootGrant.granted && (!canToggleRootGrant(rootGrant) || !rootGrant.consentValid))}
              onChange={(event) => toggleRootGrant(event.target.checked)} />
          </label>
          {rootGrant.readable && canToggleRootGrant(rootGrant) && !rootGrant.consentValid ? (
            <p className="dsh-dev-hint">{tr('请先阅读并确认免责声明，才能开启 AI root 权限。', 'Read and accept the disclaimer before turning on model root access.')}</p>
          ) : null}
          {rootMsg === null ? null : (
            <p role="status" aria-live="polite" className={rootOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{rootMsg}</p>
          )}
        </div>

        <details className="dsh-root-maintenance">
          <summary>{tr('文件属主维护', 'File ownership repair')}</summary>
          <p className="dsh-dev-hint">{tr('root 写盘后应用无法读取文件时使用。仅修复本应用数据目录，不改变 AI 授权。', 'Use this after root writes make files unreadable. It repairs only this app data folder.')}</p>
          <button type="button" className="dsh-dev-btn" disabled={repairState.running || (!rootAccess.granted && !rootGrant.channelRoot)} onClick={repairOwnership}>
            {repairState.running ? tr('属主维护进行中', 'Repair running') : tr('修复文件属主', 'Repair ownership')}
          </button>
          {repairFeedback === undefined ? null : (
            <p role="status" aria-live="polite" className={repairFeedback.ok === false ? 'dsh-dev-error' : 'dsh-dev-hint'}>{repairFeedback.text}</p>
          )}
        </details>
      </section>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>{tr('开放屏幕范围', 'Screen access')}</strong>
          <small>{tr('默认仅虚拟屏幕；真实屏幕、截图与控制都受此范围约束。', 'Defaults to virtual screens only; screenshots and control follow this scope.')}</small>
        </span>
        <select aria-label={tr('开放屏幕范围', 'Screen access')} value={scope} onChange={(event) => setScope(event.target.value as ScreenScope)}>
          <option value="virtual-only">{tr('仅虚拟屏幕', 'Virtual only')}</option>
          <option value="real-only">{tr('仅真实屏幕', 'Real only')}</option>
          <option value="all">{tr('全部开放', 'All screens')}</option>
        </select>
      </label>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>{tr('虚拟屏分辨率档位', 'Virtual screen scale')}</strong>
          <small>{tr('跟随真机比例缩放（下次建屏生效；默认 0.75）。', 'Scales with the device; applies to the next screen (default 0.75).')}</small>
        </span>
        <select aria-label={tr('虚拟屏分辨率档位', 'Virtual screen scale')} value={String(scale)} onChange={(event) => setScale(Number(event.target.value))}>
          {SCALE_OPTIONS.map((option) => (
            <option key={option} value={String(option)}>
              {option === 1 ? tr('原生', 'Native') : String(Math.round(option * 100)) + '%'}
            </option>
          ))}
        </select>
      </label>

      <label className="dsh-screen-scope-row">
        <span>
          <strong>{tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window (shown in the background)')}</strong>
          {/* P5-6：与开发者选项里的「悬浮球」去混淆。两者都叫「浮」，但一个是**虚拟屏只读画面**，
              一个是**任务面板入口**——旧文案各说各的，用户在两页之间对不上号。 */}
          <small>{tr('只读浮窗：退后台时显示虚拟屏画面，前台只在侧栏可见。不是开发者选项里的「悬浮球」（那个是任务面板入口）。', 'Read-only window: it shows the virtual screen in the background and only in the sidebar in front. It is not the floating ball in developer options.')}</small>
        </span>
        <input
          aria-label={tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window')}
          type="checkbox"
          checked={floatOn}
          onChange={(event) => setFloat(event.target.checked)}
        />
      </label>

      <div className="dsh-screen-control-detail">
        <strong>{tr('无障碍通道', 'Accessibility channel')}</strong>
        <span>
          {!a11y.readable
            ? tr('状态不可读', 'State unreadable')
            : (a11y.enabled ? tr('已开启（语义读取/点击/输入）', 'On (semantic read, tap, type)') : tr('未开启（推荐开启）', 'Off (recommended)'))}
        </span>
        {a11y.hint !== '' ? <span>{a11y.hint}</span> : null}
      </div>
      {/* 权限引导必须保留：说明为什么系统页开关是灰的、以及解锁只影响本应用这一项。 */}
      {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
        <p className="dsh-dev-hint">{tr(
          'Android 13 及以上对侧载应用默认开启「受限设置」，系统页里本应用的开关是灰的：先点「解锁受限设置」（经 Shizuku 特权通道，只影响本应用这一项），再回去开启。',
          'Android 13 and later restrict sideloaded apps, so this app switch is greyed out. Tap Unlock restricted settings (Shizuku, affects only this app), then turn it on again.',
        )}</p>
      ) : null}
      <div className="dsh-dev-row">
        <button type="button" className="dsh-dev-btn" onClick={openA11y}>{tr('去开启无障碍服务', 'Open accessibility settings')}</button>
        {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
          <button type="button" className="dsh-dev-btn" onClick={unlockA11y}>{tr('解锁受限设置', 'Unlock restricted settings')}</button>
        ) : null}
      </div>
      {a11yMsg === null ? null : (
        <p className={a11yOk === true ? 'dsh-dev-hint' : 'dsh-dev-error'}>{a11yMsg}</p>
      )}

      <div className="dsh-screen-control-detail">
        <strong>{tr('强制销毁虚拟屏', 'Force destroy virtual screens')}</strong>
        <span>{tr('销毁全部虚拟屏与其上的任务（无视会话归属）；需连续点击三次确认，点错可取消。', 'Destroys every virtual screen and its tasks, regardless of owner. Tap three times to confirm; you can cancel.')}</span>
      </div>
      {/* P5-5：破坏性按钮必须与同页的普通按钮**看得出区别**（dsh-dev-danger），
          并在确认态给「取消」。此前它长得和「刷新状态」一模一样，还紧邻其它按钮。 */}
      <div className="dsh-dev-row">
        <button
          type="button"
          className={forceArmed ? 'dsh-dev-btn dsh-dev-danger' : 'dsh-dev-btn'}
          data-stage={confirmStage}
          data-armed={forceArmed ? 'true' : 'false'}
          onClick={tapForce}
        >
          {forceLabel}
        </button>
        {forceArmed ? (
          <button type="button" className="dsh-dev-link" onClick={cancelForce}>{tr('取消', 'Cancel')}</button>
        ) : null}
      </div>
      {forceMsg === null ? null : (
        <p
          className={forceMsg.ok ? 'dsh-dev-hint' : 'dsh-dev-error'}
          {...(forceMsg.code === undefined ? {} : { 'data-code': forceMsg.code })}
        >{forceMsg.text}</p>
      )}
    </section>
  )
}
