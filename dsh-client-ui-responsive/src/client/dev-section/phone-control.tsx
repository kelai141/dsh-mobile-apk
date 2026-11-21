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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SUBLAYER_POP_EVENT } from '../mobile/back-stack.ts'
import { useShellState } from '../mobile/use-shell-state.ts'
import { phoneStateOptions, watchPhoneControlPanel } from './phone-control-poll.ts'
import { describeCallReason } from '../user-copy.ts'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { observeDocumentLanguage, tr } from '../i18n.ts'
import { PHONE_CONTROL_CSS } from './phone-control.css.ts'
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
  /**
   * 壳侧就绪三态（issue #1476）：`ShizukuTransport.status()` 的 readyState。
   *
   * 为什么必须单独透出来：`bound` 只证明 **binder 代理活着**，不证明 UserService 能应答。
   * issue #1476 的现场正是「面板说就绪、工具说 30s 超时」——两者读的是同一个 binder，
   * 差别在于壳侧当时只验了 ping。壳侧现在多验一次功能探测（`protocolVersion()` 真过 binder），
   * 结论落在 readyState 上；UI 若只看 `bound` 就会继续复述那个错误结论。
   *
   * 缺席（旧壳/旧桥）按旧口径走——见 [shizukuStateLabel]。
   */
  readyState?: ShizukuReadyState
  /** 功能探测的失败原因（readyState 为 not-ready 时的可读原因）。 */
  probeError?: string
  guidance: string
}

/** 壳侧就绪三态；`unknown` = 探测尚未完成，**不等于**不可用（坑 161）。 */
export type ShizukuReadyState = 'ready' | 'not-ready' | 'unknown'

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
  /** 本次维护的唯一 ID（壳侧租约分配）；轮询按它领取结果，防止把历史结果当成本次。 */
  operationId?: string
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

type PhoneControlView = 'home' | 'a11y' | 'shizuku' | 'vdisplay' | 'advanced' | 'root'

function vdisplayStateLabel(state: VdisplayState): string {
  switch (state) {
    case 'disabled': return tr('已关闭', 'Off')
    case 'blocked': return tr('需要准备', 'Needs setup')
    case 'ready': return tr('可创建', 'Ready')
    default: return tr('已激活', 'Active')
  }
}

function scopeLabel(scope: ScreenScope): string {
  switch (scope) {
    case 'virtual-only': return tr('仅虚拟屏幕', 'Virtual only')
    case 'real-only': return tr('仅真实屏幕', 'Real only')
    default: return tr('全部开放', 'All screens')
  }
}

function scopeSentence(scope: ScreenScope): string {
  switch (scope) {
    case 'virtual-only': return tr('仅虚拟屏幕对模型开放，真实屏幕不可读、不可控。', 'Only virtual screens are open; the real screen cannot be read or controlled.')
    case 'real-only': return tr('仅真实屏幕对模型开放，虚拟屏不可读、不可控。', 'Only the real screen is open; virtual screens cannot be read or controlled.')
    default: return tr('虚拟屏幕与真实屏幕都可被模型读取和控制。', 'Both virtual and real screens can be read and controlled.')
  }
}

function a11yRowState(status: A11yStatus): string {
  if (!status.readable) return tr('状态不可读', 'Unreadable')
  if (status.enabled) return tr('已开启', 'On')
  return status.restrictedSettingsApplies ? tr('需解锁受限设置', 'Restricted settings') : tr('未开启', 'Off')
}

function rootRowState(status: RootGrantStatus, access: RootAccessStatus): string {
  if (!status.readable) return tr('状态不可读', 'Unreadable')
  if (status.granted) return tr('AI 已开启', 'Model on')
  if (!status.channelRoot && !status.rootGranted) {
    return access.readable && !access.suExists ? tr('本机不可用', 'Unavailable') : tr('需授权', 'Needs grant')
  }
  return tr('AI 未开启', 'Model off')
}

function shizukuRowHint(status: ShizukuStatus): string {
  if (!status.readable) return tr('状态不可读；进入查看可用的操作。', 'Status unreadable. Open for available actions.')
  if (!status.installed) return tr('未安装；进入可下载 Shizuku。', 'Not installed. Open to download Shizuku.')
  if (!status.running) return tr('已安装但未启动；进入可打开 Shizuku。', 'Installed but not running. Open to start it.')
  if (!status.granted) return tr('已启动但未授权；进入可发起官方授权请求。', 'Running but not granted. Open to request access.')
  if (status.bound) return tr('特权通道已就绪。', 'The privileged channel is ready.')
  return tr('已授权，通道仍在建立。', 'Granted; the channel is still connecting.')
}

function vdisplayIsReadable(status: VdisplayStatus): boolean {
  return status.code !== 'vdisplay-status-unavailable'
}

function rootHomeHint(status: RootGrantStatus, access: RootAccessStatus): string {
  if (!status.readable) return tr('状态不可读；进入查看授权与风险说明。', 'Status unreadable. Open for grant and risk details.')
  if (status.granted) return tr('AI 已获得 root 执行权限；进入可随时收回。', 'The model can use root. Open to revoke it at any time.')
  if (!status.channelRoot && !status.rootGranted) {
    return access.readable && !access.suExists
      ? tr('本机不可用；进入查看授权说明。', 'Unavailable on this device. Open for grant details.')
      : tr('未检测到可用 root 通道；进入查看授权说明。', 'No usable root channel. Open for grant details.')
  }
  if (!status.consentValid) return tr('需阅读风险说明并确认后才能开启。', 'Read and accept the risk notice before turning this on.')
  return tr('当前未开启；进入可授权。', 'Currently off. Open to grant access.')
}

/** The one explicit Shizuku action for the current fact set; never requested automatically. */
function shizukuPrimary(status: ShizukuStatus): 'download' | 'open' | 'request' | undefined {
  if (!status.readable) return undefined
  if (!status.installed) return 'download'
  if (!status.running) return 'open'
  if (!status.granted) return 'request'
  return undefined
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
  readyState: 'unknown',
  probeError: '',
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
    ...(typeof parsed.operationId === 'string' && parsed.operationId !== '' ? { operationId: parsed.operationId } : {}),
    operation: typeof parsed.operation === 'string' ? parsed.operation : undefined, result }
}

/**
 * 按当前 operationId 领取本次维护的结算结果（PRD 5.2 / AC-08）。
 *
 * 为什么不能只看 rootGrantState().ownership.result：那份状态是「最近一次」的快照，包含历史成功
 * 记录。这里把调用方持有的 operationId 交给壳侧核对，只有结果自身的 ID 与它相符时才采纳；
 * 不符（operation-id-mismatch）或还没结算时保留既有状态，绝不把别的任务的结果显示成本次结果。
 *
 * @param operationId 当前任务的 ID（来自 ownership 状态）。
 * @returns 结算信封里的状态字段；不可读或不属于本次时 undefined。
 */
function readOwnershipResult(operationId: string): RootOwnershipStatus | undefined {
  let raw: string | undefined
  try { raw = window.androidBridge?.rootOwnershipResult?.(operationId) } catch { return undefined }
  const parsed = parseRootReply(raw)
  if (parsed === undefined) return undefined
  if (parsed.code === 'operation-id-mismatch' || parsed.code === 'invalid-operation-id') return undefined
  const observed = readOwnershipState(parsed.state ?? parsed)
  if (!observed.readable) return undefined
  // 信封顶层 result 才是本次结算；state 里若仍是旧快照则以信封为准。
  const settled = parsed.result !== null && typeof parsed.result === 'object' && !Array.isArray(parsed.result)
    ? parsed.result as Record<string, unknown> : undefined
  return settled === undefined ? observed : { ...observed, result: settled }
}

/**
 * 状态里有 operationId 时按 ID 领取本次结算（轮询的每一步都只认本次 ID）。
 *
 * 没有 ID（尚未派发/旧壳）时原样返回：此时没有可核对的「本次」，不额外造一次调用。
 * @param state 从 rootGrantState().ownership 读到的状态。
 * @returns 可核对的本次状态。
 */
function enrichOwnership(state: RootOwnershipStatus): RootOwnershipStatus {
  if (!state.readable || state.operationId === undefined) return state
  // 已结算且带结果：本次已有可信结论，不再为同一 ID 反复跨桥。
  if (!state.running && state.result !== undefined) return state
  const settled = readOwnershipResult(state.operationId)
  return settled === undefined ? state : { ...state, ...settled, operationId: state.operationId }
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
  // issue #1476：`bound` 只证明 binder 代理活着。壳侧还会做一次**功能探测**
  // （`protocolVersion()` 真过 binder），结论在 readyState 上。只看 bound 就会复述
  // 「面板说就绪、工具说超时」那个错误结论——本缺陷的用户可见形态正是它。
  //
  // 缺席（旧壳无这条判据）必须退回旧的 bound 口径，否则老壳永久显示探测中。
  if (status.readyState === 'not-ready') {
    return tr('已授权，用户服务不可用', 'Granted, UserService not responding')
  }
  if (status.readyState === 'unknown') {
    return tr('已授权，正在验证通道', 'Granted, verifying the channel')
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
  // issue #1476：binder 连上了但功能探测失败——这时「已就绪」是假的，必须说清下一步。
  if (status.readyState === 'not-ready') {
    return tr(
      '通道已连上，但用户服务不应答（功能探测失败' + (status.probeError ? '：' + status.probeError : '') +
        '）。点「重置链接」重建通道；仍失败请展开诊断日志反馈。',
      'The channel is connected but the UserService does not answer (probe failed' +
        (status.probeError ? ': ' + status.probeError : '') +
        '). Tap Reset link to rebuild; if it persists, expand the diagnostics and report it.',
    )
  }
  if (status.readyState === 'unknown') {
    return tr(
      '通道已连上，正在做首次功能探测（这不代表不可用）；探测一落地即转就绪，现在就可以让 AI 试。',
      'The channel is connected; the first functional probe is running (not a sign of trouble). It turns ready once the probe lands; you can let the AI try now.',
    )
  }
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

/**
 * 桥面读值 + **是否真的读到了**（issue #1629）。
 *
 * 文件头（:7-9）明写「桥不可用/抛错一律如实报不可读，不用安全默认值冒充事实」，而本页三个
 * 读面（屏幕范围 / 虚拟屏档位 / 浮窗开关）此前正是被点名的那三个值：`virtual-only` / `0.75` /
 * `true`。桌面宿主或旧壳（没有 `getScreenScope`/`setScreenScope`）时，页面把「仅虚拟屏幕/75%/
 * 浮窗开」当**事实**显示；用户改成「全部开放」后 `setScope` 静默 no-op，紧接着的 `refreshScope()`
 * 把值弹回且无回执——用户按一个假值做隐私决策。
 *
 * 现在三面与 vdisplay/a11y/shizuku/root 同构：`readable:false` 时控件置灰 + 一行「状态不可读」，
 * 兜底值只作为**展示占位**存在，不冒充读到的状态；写后回读保留（readable 时值仍来自真源）。
 */
interface ShellRead<T> {
  /** 是否真的读到了（false = 桥缺席 / 抛错 / 取值非法）。
   * false 时 [value] 只是展示占位，不是事实。 */
  readonly readable: boolean
  readonly value: T
}

/** 不可读时的展示占位（**不是事实**；配 data-code 的「状态不可读」一行共同出现）。 */
const SCOPE_UNREADABLE: ScreenScope = 'virtual-only'
const SCALE_UNREADABLE = 0.75
const FLOAT_UNREADABLE = true

export function readScope(): ShellRead<ScreenScope> {
  try {
    const raw = window.androidBridge?.getScreenScope?.()
    if (SCOPES.includes(raw as ScreenScope)) return { readable: true, value: raw as ScreenScope }
  } catch {
    /* bridge absent or threw: report unreadable, do not claim a scope */
  }
  // 没有 getScreenScope（旧壳/桌面宿主）与「读到了但取值非法」同档：都证明不了当前范围。
  return { readable: false, value: SCOPE_UNREADABLE }
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

export function readScale(): ShellRead<number> {
  try {
    const value = window.androidBridge?.getVdisplayScale?.()
    if (typeof value === 'number' && Number.isFinite(value)) return { readable: true, value }
  } catch {
    /* bridge absent or threw: report unreadable, do not claim a tier */
  }
  return { readable: false, value: SCALE_UNREADABLE }
}

export function readFloat(): ShellRead<boolean> {
  try {
    const value = window.androidBridge?.getVdisplayFloatEnabled?.()
    if (typeof value === 'boolean') return { readable: true, value }
  } catch {
    /* bridge absent or threw: report unreadable, do not claim the window is on */
  }
  return { readable: false, value: FLOAT_UNREADABLE }
}

/**
 * 壳侧 readyState 的解析（issue #1476）。
 *
 * 只认三个字面量；其余（含缺席）一律 `undefined`——**缺席不等于 unknown**：
 * `undefined` 表示「这个壳没有这条判据」，UI 必须退回旧的 `bound` 口径；
 * `'unknown'` 表示「壳有判据、但探测还没跑完」，那条路径要如实说探测中。
 * 把两者混成一个值会让老壳永久卡在「探测中」，也会让新壳的诚实态被当成陈旧。
 */
export function parseShizukuReadyState(value: unknown): ShizukuReadyState | undefined {
  return value === 'ready' || value === 'not-ready' || value === 'unknown' ? value : undefined
}

/** 功能探测快照的失败原因（壳侧 `functionalProbe.error`；缺席或非字符串给空串）。 */
function parseProbeError(probe: unknown): string {
  if (probe === null || typeof probe !== 'object') return ''
  const error = (probe as { error?: unknown }).error
  return typeof error === 'string' ? error : ''
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
      // 旧壳没有 readyState：给 undefined 而不是 'unknown'，让 [shizukuStateLabel] 能区分
      // 「壳侧明说尚未探测」与「这个壳根本没这条判据」——后者必须退回旧的 bound 口径，
      // 否则升级 UI 会让老壳设备永久显示「探测中」。
      readyState: parseShizukuReadyState(parsed.readyState),
      probeError: parseProbeError(parsed.functionalProbe),
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
      ownership: enrichOwnership(readOwnershipState(parsed.ownership)),
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

/** issue #1377：等待授权**必须有上界**；超时即写终态，而不是无限停在「正在检测」。 */
export const ROOT_GRANT_PENDING_TIMEOUT_MS = 30_000

/**
 * issue #1377：root 授权等待的**终态收敛**（纯函数，便于逐态钉住）。
 *
 * 旧实现只 `setPendingEnable(false)` 就 return，文案停在「正在检测 root 授权」——用户分不清
 * 「还在等」与「已被拒」，于是反复点开关。三种终态必须**可辨**，因为下一步动作不同：
 *
 * | 状态 | 可重试 | 原因 |
 * | --- | --- | --- |
 * | `denied` | 是 | 用户在管理器里点了拒绝，改过来就能过 |
 * | `timeout` | 是 | 等太久，重来一次即可 |
 * | `no-su` | **否** | 本机没有 su：这不是权限问题，重试永远不会成功 |
 *
 * @param state 壳侧 `RootAccess.state`。
 * @returns 终态信息；非终态（granted / requesting / unknown）返回 null。
 */
export function rootGrantTerminal(state: string): { code: string; text: string; retryable: boolean } | null {
  if (state === 'denied') {
    return {
      code: 'root-denied',
      retryable: true,
      text: tr('已拒绝 root 授权：可在系统的 Root 管理器里改成「允许」，然后重新点开关。', 'Root access was denied. Allow it in your root manager, then toggle again.'),
    }
  }
  if (state === 'timeout') {
    return {
      code: 'root-grant-timeout',
      retryable: true,
      text: tr('等待授权超时：可以再点一次开关重试。', 'Timed out waiting for the grant; toggle again to retry.'),
    }
  }
  if (state === 'no-su') {
    return {
      code: 'root-no-su',
      retryable: false,
      text: tr('本机没有 su：这不是权限问题，重试也不会成功。需要换一台已 root 的设备，或先刷入 root。', 'No su on this device: this is not a permission problem, so retrying will not help. Use a rooted device or flash root first.'),
    }
  }
  return null
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
 * 只读原生控制诊断（Rust 有界 64 条脱敏审计 + exchanges / elapsedUs 计数）。
 *
 * 为什么按需读而不是随页面轮询：这份 JSON 比其他状态大，且只有用户主动排查问题时才需要；
 * 默认主页面不显示，展开时才读一次。桥缺席或抛错返回 undefined——页面据此说明「不可读」，
 * 而不是显示一段编造的空审计。
 * @returns 原生返回的原始 JSON 文本；不可读时 undefined。
 */
export function readNativeControlDiagnostics(): string | undefined {
  try {
    const raw = window.androidBridge?.nativeControlDiagnostics?.()
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * 渲染「手机控制」设置分区。
 * @returns 分区元素树。
 */
export function PhoneControlSection(_props: PropsRuntime<'settings.section'>) {
  const [, setLanguageTick] = useState(0)
  const languageMountedRef = useRef(false)
  const [scopeRead, refreshScope] = useShellState(readScope, phoneStateOptions)
  const [vdisplay, refreshVdisplay] = useShellState(readVdisplay, phoneStateOptions)
  const [shizuku, refreshShizuku] = useShellState(readShizuku, phoneStateOptions)
  const [scaleRead, refreshScale] = useShellState(readScale, phoneStateOptions)
  const [floatRead, refreshFloat] = useShellState(readFloat, phoneStateOptions)
  const [a11y, refreshA11y] = useShellState(readA11y, phoneStateOptions)
  const [rootGrant, refreshRootGrant] = useShellState(readRootGrant, phoneStateOptions)
  const [rootAccess, refreshRootAccess] = useShellState(readRootAccess, phoneStateOptions)
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
  const [view, setView] = useState<PhoneControlView>('home')
  /**
   * 原生控制审计的按需快照（null = 还没展开过）。
   *
   * 只在「高级诊断」里用户展开 <details> 时读一次；默认页面与轮询都不碰它，
   * 避免为一屏诊断白烧跨桥调用。
   */
  const [nativeDiag, setNativeDiag] = useState<string | null>(null)
  /** 本次展开是否已经读过：toggle 在部分内核里会对同一次展开连发两次，用 ref 收敛成一次。 */
  const nativeDiagReadRef = useRef(false)

  /**
   * Only re-render on later language changes. Re-rendering from the observer's initial call would
   * make React commit inside the mounting effect and trip its act() contract.
   */
  useEffect(() => {
    const stop = observeDocumentLanguage(() => {
      if (languageMountedRef.current) setLanguageTick((tick) => tick + 1)
    })
    languageMountedRef.current = true
    return () => {
      stop()
      languageMountedRef.current = false
    }
  }, [])

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
  /** 发起修复时的属主维护基线（issue #1376/#1518）：只在状态**可读**时记，不可读记 null（没有可比对象）。 */
  const repairBaselineRef = useRef<{ startedAt: number; completedAt: number } | null>(null)
  const polledRepair = rootGrant.ownership ?? OWNERSHIP_UNREADABLE
  const repairState = polledRepair.readable && polledRepair.startedAt >= (repairReply?.startedAt ?? 0)
    ? polledRepair : repairReply ?? polledRepair
  const repairFeedback = repairFailure === undefined ? describeOwnershipRepair(repairState) : { ok: false, text: repairFailure }

  /** Native request is asynchronous and single-flight; only later native result counts as completed. */
  const repairOwnership = useCallback(() => {
    // 点击即记基线：此后只认「越过基线」。没有比较对象时，只看「现在是不是 running/completed」
    // 会把**上一次**的成功记录当成这次的自愈证据。
    // 基线取**已渲染状态**（repairState，含上一次点击回执）而不是 polledRepair：界面渲染的是
    // repairState，判据与渲染必须同源，否则「轮询不可读、回执已推进」时两边各说各话（#1519）。
    // 不可读时记 null：记成 {0,0} 会让任意一条历史成功记录都算越过基线（#1518）。
    repairBaselineRef.current = repairState.readable ? { startedAt: repairState.startedAt, completedAt: repairState.completedAt } : null
    let raw: string | undefined
    try { raw = window.androidBridge?.repairRootOwnership?.() } catch { raw = undefined }
    const parsed = parseRootReply(raw)
    const dispatch = readOwnershipState(parsed)
    // 派发回执本身可能已带 operationId：按它领一次结算，避免把「派发成功」当成本次结果。
    const observed = dispatch.operationId === undefined
      ? dispatch
      : readOwnershipResult(dispatch.operationId) ?? dispatch
    if (parsed?.ok === true && (parsed.code === 'repair-started' || parsed.code === 'repair-running')
      && observed.readable && observed.startedAt > 0
      && (observed.running || (observed.completedAt >= observed.startedAt && observed.result !== undefined))) {
      setRepairReply(observed)
      setRepairFailure(undefined)
    } else {
      setRepairFailure('启动文件属主维护失败：' + describeCallReason(typeof parsed?.reason === 'string' ? parsed.reason : undefined))
    }
    refreshRootGrant()
  }, [refreshRootGrant, repairState])

  // issue #1376：红字不可自愈——点「修复文件属主」失败后，后续 2s 轮询即使把 ownership 刷成
  // running / completed，界面仍停在「启动文件属主维护失败」。这里在轮询看到推进时清掉失败态，
  // 让 describeOwnershipRepair 重新接管文案（成功/进行中/结果不可读各自有话说）。
  useEffect(() => {
    if (repairFailure === undefined) return
    // 判据是「**越过基线**」，不是「现在看起来在跑/已完成」：设备上以前成功修过一次时，
    // 轮询里永远有一条旧的 completed 记录；只按形态判断会把刚出现的红字在下一个 tick 立刻
    // 抹掉——失败**根本不会显示**（同 startedAt 更不该清）。
    // 比较对象是 repairState（与渲染同源），不是 polledRepair：轮询不可读时 polledRepair 恒为
    // OWNERSHIP_UNREADABLE，这里会直接放弃，而界面早已由点击回执推进到「进行中/完成」——
    // 红字与正文自相矛盾（#1519）。
    const base = repairBaselineRef.current
    if (base === null) {
      // 点击时状态不可读 ⇒ 没有可比基线。此时只认**活证据**（running）：历史 completed 记录的
      // startedAt 恒大于 0，用它判自愈等于让任意一次旧成功清掉本次失败（#1518）。
      if (repairState.readable && repairState.running) setRepairFailure(undefined)
      return
    }
    const advanced = repairState.startedAt > base.startedAt
      || (repairState.completedAt > base.completedAt && repairState.result !== undefined)
    if (advanced) setRepairFailure(undefined)
  }, [repairState, repairFailure])

  /**
   * 自动续开（2026-09-30 主人定例的体验闭环）：用户开开关 → 壳侧因「root 未授权」拦下并
   * **弹出授权框** → 用户点「允许」→ 本页 2s 轮询看到 `rootAccess.granted` → 自动把开关续开。
   * 用户只需点一次开关 + 在弹窗上点一次「允许」，不必回设置页再点一次。
   */
  useEffect(() => {
    if (!pendingEnable) return
    if (!rootGrant.consentValid) {
      setPendingEnable(false)
      return
    }
    // issue #1377：三态收敛时**必须把终态写回文案**。旧实现只关掉 pending 就 return，
    // 界面仍停在「正在检测 root 授权」——分不清「还在等」与「已被拒」，用户会反复点开关。
    const terminal = rootGrantTerminal(rootAccess.state)
    if (terminal !== null) {
      setPendingEnable(false)
      setRootOk(false)
      setRootMsg(terminal.text)
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

  /**
   * issue #1377：等待授权**必须有上界**。旧实现只等壳侧状态收敛；壳侧不收敛（管理器无响应、
   * 弹窗被系统吞掉）时界面会永久停在「正在检测」。
   *
   * 超时写的是**终态**（`timeout` 语义的文案），不是回到「未授权」——回到未授权等于什么都没发生，
   * 用户又得猜。文案里明写「可以再点一次重试」，所以它是可重试终态而不是死路。
   */
  useEffect(() => {
    if (!pendingEnable) return undefined
    const timer = window.setTimeout(() => {
      setPendingEnable(false)
      setRootOk(false)
      setRootMsg(rootGrantTerminal('timeout')?.text ?? null)
    }, ROOT_GRANT_PENDING_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [pendingEnable])

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

  const shizukuAction = shizukuPrimary(shizuku)

  const renderReceipt = (
    message: string | null,
    ok: boolean | null,
    code?: string,
    live = false,
  ) => message === null ? null : (
    <p
      className={ok === true ? 'dsh-dev-hint' : 'dsh-dev-error'}
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
      {...(code === undefined ? {} : { 'data-code': code })}
    >{message}</p>
  )

  /**
   * 一行「手机控制」入口。
   *
   * 真因（用户实报 C：右侧状态 + 箭头那块点不动）：旧结构是 `<div class="dsh-pc-row">` 里放一个
   * `<button class="dsh-pc-row-main">`（只装左侧标题/说明）+ 一个纯展示的 `<span class="dsh-pc-side">`
   * （状态文案 + 箭头）。**可点区域就是那个 button 的盒子**，右侧那半截根本不在命中面上——它不是被
   * 谁挡住了，而是从来就不是控件。所以修法不是「给右侧补一个 click」（那会变成同一行两个命中面，
   * 中间还有一段仍然点不动），而是**把整行收敛成一个按钮**：整块都是命中面，一次语义、一个焦点。
   *
   * 副作用与取舍：旧结构允许在行内嵌一个次级按钮（inline 动作），而按钮不能嵌套按钮。该能力
   * 在本文件里**从未有过调用点**（`inlineLabel/onInline` 只有定义），故随本次收敛一并删除，
   * 需要行内次要动作时另起一行或放在右侧之外的独立控件里。
   */
  const row = (
    title: string,
    description: string,
    state: string | undefined,
    action: () => void,
    options: {
      titleId?: string
      unreadable?: boolean
      dataCode?: string
    } = {},
  ) => (
    <button
      type="button"
      className="dsh-pc-row"
      onClick={action}
      {...(options.titleId === undefined ? {} : { id: options.titleId })}
    >
      <span className="dsh-pc-row-main">
        <span className="dsh-gs-title">{title}</span>
        <span className="dsh-gs-desc">{description}</span>
      </span>
      <span className="dsh-pc-side">
        {state === undefined ? null : (
          <span
            className="dsh-pc-state"
            {...(options.unreadable === true ? { 'data-unreadable': 'true' } : {})}
            {...(options.dataCode === undefined ? {} : { 'data-code': options.dataCode })}
          >{state}</span>
        )}
        <span className="dsh-pc-chevron" aria-hidden="true">›</span>
      </span>
    </button>
  )

  /**
   * 「手机控制」的下一级页眉（无障碍通道 / Shizuku 授权 / 虚拟屏设置 / 高级设置 / Root）。
   *
   * 真因（用户实报 A：设置页出现两个返回按钮 / B：第三层系统返回直接跳回第一层）：
   * 这一层此前只存在于本分区自己的 `view` 状态里，设置中心的分层容器（`mobile/settings-nav.ts`）
   * 完全看不见它——它仍然认为自己在「二级页」，于是系统返回被它按「二级页 -> 首页」处理，
   * 一口气跳过本页；同时它自己的顶部条也画一个返回箭头，与本页眉这个箭头并排 → 两个返回。
   *
   * 修法：本页眉把「我是一层下级」这件事**显式登记到 DOM 上**（`data-dsh-settings-sublayer` +
   * 自己的返回控件与标题），由分层容器接管返回与标题：手机形态下它用顶部条那个唯一的返回箭头
   * 弹本层（样式表把本页眉的箭头藏掉，避免两个出口），横屏/无分层容器时本页眉的箭头仍在。
   */
  const subhead = (title: string) => (
    <div className="dsh-pc-subhead">
      <button
        type="button"
        className="dsh-pc-back"
        data-dsh-settings-sublayer-back=""
        onClick={() => setView('home')}
      >
        <span aria-hidden="true">‹</span>{tr('手机控制', 'Phone control')}
      </button>
      <strong data-dsh-settings-sublayer-title="">{title}</strong>
    </div>
  )

  /**
   * 分层容器请本页退出下级层：监听它派发在那个登记节点上的可取消事件。
   *
   * 为什么不是「让容器点本页眉那个返回按钮」：手机形态下本页眉的箭头被样式表隐藏
   * （一屏只能有一个返回出口），而全局激活护栏会拦掉落在隐藏控件上的程序化点击，
   * 于是容器「点它」在真机上等于什么都没发生（设备实测：系统返回后仍停在第三层）。
   * 契约因此改成事件：容器只管说「退一层」，怎么退由本页自己决定。
   */
  const sublayer = useRef<HTMLDivElement>(null)
  const homePanel = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = view === 'home' ? homePanel.current : sublayer.current
    if (!panel) return
    return watchPhoneControlPanel(panel, {
      fast: () => { refreshVdisplay(); refreshShizuku(); refreshRootGrant(); refreshRootAccess() },
      accessibility: refreshA11y,
      onReturn: () => { refreshScope(); refreshScale(); refreshFloat() },
    })
  }, [view, refreshVdisplay, refreshShizuku, refreshRootGrant, refreshRootAccess,
    refreshA11y, refreshScope, refreshScale, refreshFloat])
  useLayoutEffect(() => {
    const node = sublayer.current
    if (node === null) return
    const onPop = (event: Event): void => {
      event.preventDefault()
      setView('home')
    }
    node.addEventListener(SUBLAYER_POP_EVENT, onPop)
    return () => { node.removeEventListener(SUBLAYER_POP_EVENT, onPop) }
  }, [view])

  /** 当前下级页的标题（上游注册名之外的本页自造名，中英各一份）。 */
  const viewTitle = view === 'a11y' ? tr('无障碍通道', 'Accessibility channel')
    : view === 'shizuku' ? tr('Shizuku 授权', 'Shizuku access')
      : view === 'vdisplay' ? tr('虚拟屏设置', 'Virtual screen settings')
        : view === 'advanced' ? tr('高级设置与诊断', 'Advanced and diagnostics')
          : tr('Root 权限', 'Root access')

  if (view !== 'home') return (
    <div
      data-plugin="dev-phone-control"
      data-native-control-protected=""
      /* 登记「本分区自己还有一层下级页」：分层容器（mobile/settings-nav.ts）读这两个属性决定
         系统返回弹本层还是直接退到设置首页。属性缺席 = 停在「手机控制」这一层。 */
      ref={sublayer}
      data-dsh-settings-sublayer=""
      data-dsh-settings-sublayer-title={viewTitle}
      {...(vdisplay.displayId === undefined ? {} : { 'data-display-id': String(vdisplay.displayId) })}
    >
      <style>{PHONE_CONTROL_CSS}</style>
      {subhead(viewTitle)}
      {view === 'a11y' ? (
        <>
          <div className="dsh-gs-row">
            <div className="dsh-gs-text">
              <div className="dsh-gs-title">{tr('无障碍通道', 'Accessibility channel')}</div>
              <div className="dsh-gs-desc">
                {a11y.readable && a11y.enabled
                  ? tr('语义读取、点击与输入已可用。', 'Semantic read, tap and type are available.')
                  : tr('语义读取、点击与输入都走系统无障碍服务。', 'Semantic read, tap and type go through the system accessibility service.')}
              </div>
            </div>
            <div className="dsh-gs-control">
              <span className="dsh-pc-state" {...(a11y.readable ? {} : { 'data-unreadable': 'true' })}>{a11yRowState(a11y)}</span>
            </div>
          </div>
          <p className="dsh-dev-hint" data-code={a11y.readable ? undefined : 'a11y-status-unreadable'}>
            {!a11y.readable
              ? tr('状态不可读：应用内桥没有返回无障碍状态；这不等于未开启。', 'State unreadable: the app bridge did not return accessibility status. This does not mean it is off.')
              : (a11y.hint !== '' ? a11y.hint : (a11y.enabled
                ? tr('已开启：模型可以读取屏幕语义、点击与输入。', 'On: the model can read semantics, tap and type.')
                : tr('未开启：到 系统设置 → 无障碍 → 已下载的服务 里开启本应用。', 'Off: open Settings → Accessibility → Downloaded services and turn on this app.')))}
          </p>
          {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
            <p className="dsh-dev-hint">{tr(
              'Android 13 及以上对侧载应用默认开启「受限设置」，系统页里本应用的开关是灰的：先点「解锁受限设置」（经 Shizuku 特权通道，只影响本应用这一项），再回去开启。',
              'Android 13 and later restrict sideloaded apps, so this app switch is greyed out. Tap Unlock restricted settings (Shizuku, affects only this app), then turn it on again.',
            )}</p>
          ) : null}
          <div className="dsh-dev-row dsh-pc-actions">
            <button type="button" className="dsh-dev-btn" onClick={openA11y}>{tr('去开启无障碍服务', 'Open accessibility settings')}</button>
            {a11y.readable && !a11y.enabled && a11y.restrictedSettingsApplies ? (
              <button type="button" className="dsh-dev-btn" onClick={unlockA11y}>{tr('解锁受限设置', 'Unlock restricted settings')}</button>
            ) : null}
          </div>
          {renderReceipt(a11yMsg, a11yOk)}
        </>
      ) : null}
      {view === 'shizuku' ? (
        <>
          <div className="dsh-pc-detail">
            <div className="dsh-screen-control-detail">
              <strong>{tr('Shizuku 特权通道', 'Shizuku privileged channel')}</strong>
              <span data-code={shizuku.readable ? undefined : 'shizuku-status-unreadable'}>
                {shizukuStateLabel(shizuku)}
              </span>
            </div>
            <p className="dsh-dev-hint">
              {shizuku.guidance !== '' ? shizuku.guidance : shizukuStepHint(shizuku)}
            </p>
            {shizukuAction === 'download' ? (
              <button type="button" className="dsh-dev-btn dsh-pc-primary" onClick={downloadShizuku}>
                {tr('下载 Shizuku', 'Download Shizuku')}
              </button>
            ) : null}
            {shizukuAction === 'open' ? (
              <button type="button" className="dsh-dev-btn dsh-pc-primary" onClick={openShizuku}>
                {tr('打开 Shizuku', 'Open Shizuku')}
              </button>
            ) : null}
            {shizukuAction === 'request' ? (
              <button
                type="button"
                className="dsh-dev-btn dsh-pc-primary"
                disabled={!shizuku.readable || !shizuku.running}
                onClick={requestShizukuPermission}
              >
                {tr('请求 Shizuku 授权', 'Request Shizuku access')}
              </button>
            ) : null}
            {shizukuAction === 'request' ? (
              <p className="dsh-dev-hint">{tr('这一步只在你点击后发起官方授权请求，不会自动申请。授权框需要前台界面才会弹出。', 'This starts the official grant request only when you tap it; nothing is requested automatically. The dialog needs the app in front.')}</p>
            ) : null}
            {shizukuAction !== undefined ? (
              <p className="dsh-dev-hint">{tr('入口会跳到应用外；授权只能在 Shizuku 内由你亲手完成。装好并授权后回到本页，状态每 2 秒自动刷新。', 'The entry leaves the app; only you can grant inside Shizuku. Come back afterwards; status refreshes every 2 seconds.')}</p>
            ) : null}
          </div>
          {shizuku.diagnostics ? (
            <details className="dsh-dev-diag dsh-pc-detail">
              <summary>{tr('查看启动失败诊断日志', 'Show the startup failure log')}</summary>
              <pre>{shizuku.diagnostics}</pre>
            </details>
          ) : null}
          <div className="dsh-pc-detail">
            <p className="dsh-pc-detail-title">{tr('连接维护', 'Connection tools')}</p>
            <div className="dsh-dev-row">
              <button type="button" className="dsh-dev-link" onClick={tutorialShizuku}>{tr('点击查看教程', 'Watch the tutorial')}</button>
              <button type="button" className="dsh-dev-btn" onClick={refreshShizuku}>{tr('刷新状态', 'Refresh status')}</button>
              <button type="button" className="dsh-dev-btn" onClick={resetShizuku}>{tr('重置链接', 'Reset link')}</button>
            </div>
            <p className="dsh-dev-hint">{tr('重置只重建 Shizuku 连接，不改变授权。', 'Reset only rebuilds the Shizuku link; it does not change grants.')}</p>
            {renderReceipt(shizukuMsg, shizukuOk)}
          </div>
        </>
      ) : null}
      {view === 'vdisplay' ? (
        <>
          <label className="dsh-screen-scope-row">
            <span>
              <strong>{tr('虚拟屏分辨率档位', 'Virtual screen scale')}</strong>
              <small>{tr('跟随真机比例缩放（下次建屏生效；默认 0.75）。', 'Scales with the device; applies to the next screen (default 0.75).')}</small>
              {scaleRead.readable ? null : (
                <small className="dsh-dev-hint" data-code="vdisplay-scale-unreadable">
                  {tr('状态不可读：本页拿不到当前档位，当前值不是事实，也不能在这里改。', 'State unreadable: this page cannot read the current tier, so the value is not a fact and cannot be changed here.')}
                </small>
              )}
            </span>
            <select
              aria-label={tr('虚拟屏分辨率档位', 'Virtual screen scale')}
              disabled={!scaleRead.readable}
              value={String(scaleRead.value)}
              onChange={(event) => setScale(Number(event.target.value))}
            >
              {SCALE_OPTIONS.map((option) => (
                <option key={option} value={String(option)}>
                  {option === 1 ? tr('原生', 'Native') : String(Math.round(option * 100)) + '%'}
                </option>
              ))}
            </select>
          </label>
          <div className="dsh-gs-row">
            <div className="dsh-gs-text">
              <div className="dsh-gs-title">{tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window (shown in the background)')}</div>
              <div className="dsh-gs-desc">
                {tr('只读浮窗：退后台时显示虚拟屏画面，前台只在侧栏可见。不是开发者选项里的「悬浮球」（那个是任务面板入口）。', 'Read-only window: it shows the virtual screen in the background and only in the sidebar in front. It is not the floating ball in developer options.')}
              </div>
              {floatRead.readable ? null : (
                <div className="dsh-dev-hint" data-code="vdisplay-float-unreadable">
                  {tr('状态不可读：本页拿不到浮窗开关，当前值不是事实，也不能在这里改。', 'State unreadable: this page cannot read the window switch, so the value is not a fact and cannot be changed here.')}
                </div>
              )}
            </div>
            <div className="dsh-gs-control">
              <Switch
                checked={floatRead.value}
                disabled={!floatRead.readable}
                onChange={(next) => setFloat(next)}
                label={tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window')}
              />
            </div>
          </div>
          <div className="dsh-pc-detail">
            <p className="dsh-pc-detail-title">{tr('强制销毁虚拟屏', 'Force destroy virtual screens')}</p>
            <p className="dsh-dev-hint">{tr('销毁全部虚拟屏与其上的任务（无视会话归属）；需连续点击三次确认，点错可取消。', 'Destroys every virtual screen and its tasks, regardless of owner. Tap three times to confirm; you can cancel.')}</p>
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
          </div>
        </>
      ) : null}
      {view === 'advanced' ? (
        <>
          <div className="dsh-pc-detail">
            <p className="dsh-pc-detail-title">{tr('屏幕范围详情', 'Screen access detail')}</p>
            <div className="dsh-screen-control-detail">
              <strong>{tr('开放屏幕范围', 'Screen access')}</strong>
              <span>{scopeLabel(scopeRead.value)}</span>
            </div>
            <p className="dsh-dev-hint">{tr(
              '范围同时约束截图、坐标点击与文本输入。仅虚拟屏幕是默认值；改成真实屏幕前请确认你接受模型读取该屏内容。',
              'The scope also bounds screenshots, taps and text input. Virtual only is the default; before opening the real screen, confirm that you accept the model reading it.',
            )}</p>
            {scopeRead.readable ? null : (
              <p className="dsh-dev-hint" data-code="screen-scope-unreadable">
                {tr('状态不可读：本页拿不到当前屏幕范围，当前值不是事实，也不能在这里改。', 'State unreadable: this page cannot read the current screen access, so the value is not a fact and cannot be changed here.')}
              </p>
            )}
          </div>
          <div className="dsh-pc-detail">
            <p className="dsh-pc-detail-title">{tr('诊断', 'Diagnostics')}</p>
            <div className="dsh-screen-control-detail">
              <strong>{tr('虚拟屏状态', 'Virtual screen status')}</strong>
              <span data-code={vdisplay.code}>{vdisplayStateLabel(vdisplay.state)}</span>
            </div>
            <p className="dsh-dev-hint">{vdisplay.guidance}</p>
            <div className="dsh-screen-control-detail">
              <strong>{tr('Shizuku 特权通道', 'Shizuku privileged channel')}</strong>
              <span>{shizukuStateLabel(shizuku)}</span>
            </div>
            <p className="dsh-dev-hint">
              {shizuku.guidance !== '' ? shizuku.guidance : shizukuStepHint(shizuku)}
            </p>
            {shizuku.diagnostics ? (
              <details className="dsh-dev-diag">
                <summary>{tr('查看启动失败诊断日志', 'Show the startup failure log')}</summary>
                <pre>{shizuku.diagnostics}</pre>
              </details>
            ) : null}
            {view === 'advanced' ? (
              <details
                className="dsh-dev-diag"
                onToggle={(event) => {
                  const node = event.currentTarget as HTMLDetailsElement
                  if (!node.open) {
                    // 收起后允许下次展开重新读一次最新审计。
                    nativeDiagReadRef.current = false
                    return
                  }
                  if (nativeDiagReadRef.current) return
                  nativeDiagReadRef.current = true
                  setNativeDiag(readNativeControlDiagnostics() ?? '')
                }}
              >
                <summary>{tr('查看原生控制审计（脱敏）', 'Show native control audit (redacted)')}</summary>
                <p className="dsh-dev-hint">{tr(
                  '最多 64 条脱敏记录与调用计数；不含命令文本、页面文本或图像数据。',
                  'At most 64 redacted entries plus call counters; no command text, page text, or image data.',
                )}</p>
                <pre>{nativeDiag === null ? '' : nativeDiag.trim() === ''
                  ? tr('原生诊断不可读（桥未提供或调用失败）。', 'Native diagnostics unreadable (bridge missing or the call failed).')
                  : nativeDiag}</pre>
              </details>
            ) : null}
            <div className="dsh-dev-row">
              <button type="button" className="dsh-dev-btn" onClick={refreshShizuku}>{tr('刷新状态', 'Refresh status')}</button>
              <button type="button" className="dsh-dev-btn" onClick={resetShizuku}>{tr('重置链接', 'Reset link')}</button>
            </div>
            {renderReceipt(shizukuMsg, shizukuOk)}
          </div>
          <div className="dsh-gs-row">
            <div className="dsh-gs-text">
              <div className="dsh-gs-title">{tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window (shown in the background)')}</div>
              <div className="dsh-gs-desc">{tr('只读浮窗；关闭后前台仍可在侧栏查看。', 'Read-only window; when off, the sidebar still shows it in front.')}</div>
            </div>
            <div className="dsh-gs-control">
              <Switch
                checked={floatRead.value}
                disabled={!floatRead.readable}
                onChange={(next) => setFloat(next)}
                label={tr('虚拟屏浮窗（退后台自动显示）', 'Virtual screen window')}
              />
            </div>
          </div>
          <div className="dsh-pc-detail">
            <p className="dsh-pc-detail-title">{tr('强制销毁虚拟屏', 'Force destroy virtual screens')}</p>
            <p className="dsh-dev-hint">{tr('销毁全部虚拟屏与其上的任务（无视会话归属）；需连续点击三次确认，点错可取消。', 'Destroys every virtual screen and its tasks, regardless of owner. Tap three times to confirm; you can cancel.')}</p>
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
          </div>
        </>
      ) : null}
      {view === 'root' ? (
        <section className="dsh-root-access-card dsh-pc-plain" aria-label={tr('Root 权限设置', 'Root access settings')}>
          <div className="dsh-screen-control-detail">
            <strong>{tr('Root 权限', 'Root access')}</strong>
            <span data-code={rootGrant.readable ? undefined : 'root-grant-unreadable'}>{rootGrantStateLabel(rootGrant)}</span>
          </div>
          <p className="dsh-dev-hint">{tr('先确认可用通道，再决定是否允许 AI 使用。', 'Confirm an available channel before letting the model use it.')}</p>

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
            <div className="dsh-gs-row">
              <div className="dsh-gs-text">
                <div className="dsh-gs-title">{tr('已阅读免责声明', 'Disclaimer read')}</div>
                <div className="dsh-gs-desc">
                  {tr('理解 root 操作可能修改或删除系统与个人数据，并承担相应风险。应用升级不需重新确认（免责声明内容更新时才需）；撤销同意会同时关闭 AI 开关。', 'Root operations can change or delete system and personal data, and you accept that risk. App updates keep this consent; revoking it also turns model access off.')}
                </div>
              </div>
              <div className="dsh-gs-control">
                <Switch
                  checked={rootGrant.consentValid}
                  disabled={!rootGrant.readable}
                  onChange={(next) => toggleRootConsent(next)}
                  label={tr('已阅读免责声明', 'Disclaimer read')}
                />
              </div>
            </div>
            <div className="dsh-gs-row">
              <div className="dsh-gs-text">
                <div className="dsh-gs-title">{tr('授权 AI 使用 root', 'Allow model root access')}</div>
                <div className="dsh-gs-desc">
                  {rootGrant.honesty || tr('这是策略与知情同意开关，不是技术沙箱。关闭后 AI 的 root 执行路径会被拒绝。', 'This is a policy and consent switch, not a sandbox. When off, model root execution is refused.')}
                </div>
              </div>
              <div className="dsh-gs-control">
                <Switch
                  checked={rootGrant.granted}
                  // issue #1377：no-su 时开关**不能开**——重试永远不会成功。置灰的原因由下方
                  // data-code="root-no-su" 那条明文解释（灰开关不解释 = 用户以为坏了）。
                  //
                  // issue #1592：no-su 只约束「开」，不约束「关」。壳侧 RootAccess.state() 的判据是
                  // `su == null && state != requesting → no-su`，而 granted 是 SharedPreferences 持久化的，
                  // 两者独立：已 root 设备上开启 AI root 后卸载 root / 把本应用加进 Magisk DenyList
                  // （suPath() 返回 null），开关 ON 但灰、点不动，用户无法从本页收回已生效的 root 授权，
                  // 唯一出路是去点名字完全不同的「已阅读免责声明」开关。收回权限必须是永远可做的动作。
                  disabled={!rootGrant.readable || (!rootGrant.granted && (rootAccess.state === 'no-su' || !canToggleRootGrant(rootGrant) || !rootGrant.consentValid))}
                  onChange={(next) => toggleRootGrant(next)}
                  label={tr('授权 AI 使用 root', 'Allow model root access')}
                />
              </div>
            </div>
            {rootGrant.readable && canToggleRootGrant(rootGrant) && !rootGrant.consentValid ? (
              <p className="dsh-dev-hint">{tr('请先阅读并确认免责声明，才能开启 AI root 权限。', 'Read and accept the disclaimer before turning on model root access.')}</p>
            ) : null}
            {/* issue #1377：灰开关必须解释为什么；issue #1592：已开启时改成「可关闭」口径。 */}
            {rootAccess.state === 'no-su' ? (
              rootGrant.granted ? (
                <p className="dsh-dev-hint" data-code="root-no-su">
                  {tr(
                    '本机现在读不到可用的 su（卸载了 root，或本应用被加进了 DenyList）。已经开启的 AI root 授权仍可从本开关关闭——关闭不需要 su。',
                    'No usable su right now (root was removed, or this app was added to a DenyList). The model root grant that is already on can still be turned off here; turning it off does not need su.',
                  )}
                </p>
              ) : (
                <p className="dsh-dev-hint" data-code="root-no-su">
                  {rootGrantTerminal('no-su')?.text}
                </p>
              )
            ) : null}
            {renderReceipt(rootMsg, rootOk, undefined, true)}
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
      ) : null}
    </div>
  )

  return (
    <section
      ref={homePanel}
      data-plugin="dev-phone-control"
      data-native-control-protected=""
      aria-labelledby="dsh-phone-control-title"
      {...(vdisplay.displayId === undefined ? {} : { 'data-display-id': String(vdisplay.displayId) })}
    >
      <style>{PHONE_CONTROL_CSS}</style>
      <div className="dsh-pc-screen">
        <div className="dsh-pc-screen-head">
          <strong id="dsh-phone-control-title" className="dsh-gs-title">{tr('屏幕访问范围', 'Screen access')}</strong>
          <span className="dsh-pc-state" {...(scopeRead.readable ? {} : { 'data-unreadable': 'true', 'data-code': 'screen-scope-unreadable' })}>
            {scopeRead.readable ? scopeLabel(scopeRead.value) : tr('检测中', 'Checking')}
          </span>
        </div>
        <div className="dsh-pc-segment" role="radiogroup" aria-label={tr('屏幕访问范围', 'Screen access')}>
          {SCOPES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={scopeRead.value === option}
              disabled={!scopeRead.readable}
              onClick={() => setScope(option)}
            >
              {scopeLabel(option)}
            </button>
          ))}
        </div>
        <p className="dsh-pc-scope-line" data-code={scopeRead.readable ? undefined : 'screen-scope-unreadable'}>
          {scopeRead.readable
            ? scopeSentence(scopeRead.value)
            : tr('屏幕范围不可读：当前选中项不是事实，也不能在这里改动。', 'Screen access is unreadable: the selection is not a fact and cannot be changed here.')}
        </p>
      </div>

      {row(
        tr('无障碍通道', 'Accessibility channel'),
        a11y.readable && a11y.enabled
          ? tr('语义读取、点击与输入已可用。', 'Semantic read, tap and type are available.')
          : tr('系统无障碍服务，用于读取语义、点击与输入。', 'The system accessibility service for semantics, taps and typing.'),
        a11yRowState(a11y),
        () => setView('a11y'),
        { dataCode: a11y.readable ? undefined : 'a11y-status-unreadable', unreadable: !a11y.readable },
      )}
      {row(
        tr('Shizuku 授权', 'Shizuku access'),
        shizukuRowHint(shizuku),
        shizukuStateLabel(shizuku),
        () => setView('shizuku'),
        { dataCode: shizuku.readable ? undefined : 'shizuku-status-unreadable', unreadable: !shizuku.readable },
      )}
      {row(
        tr('虚拟屏设置', 'Virtual screen settings'),
        tr('分辨率档位、只读浮窗与强制销毁。', 'Scale, read-only window and force destroy.')
          + ' ' + tr('当前状态：', 'Status: ') + vdisplayStateLabel(vdisplay.state)
          + (scaleRead.readable ? ' · ' + (scaleRead.value === 1 ? tr('原生', 'Native') : Math.round(scaleRead.value * 100) + '%') : ''),
        !scaleRead.readable ? tr('档位不可读', 'Scale unreadable') : undefined,
        () => setView('vdisplay'),
        { unreadable: !scaleRead.readable || !floatRead.readable || !vdisplayIsReadable(vdisplay) },
      )}
      {row(
        tr('高级设置与诊断', 'Advanced and diagnostics'),
        !scaleRead.readable
          ? tr('档位不可读；诊断里保留全部可读状态。', 'Scale unreadable; diagnostics keep every readable state.')
          : tr('状态回执、连接维护与销毁入口。', 'Status receipts, connection tools and destroy entry.'),
        undefined,
        () => setView('advanced'),
      )}
      {row(
        tr('Root 权限', 'Root access'),
        rootHomeHint(rootGrant, rootAccess),
        rootRowState(rootGrant, rootAccess),
        () => setView('root'),
        { dataCode: rootGrant.readable ? undefined : 'root-grant-unreadable', unreadable: !rootGrant.readable },
      )}
    </section>
  )
}
