/**
 * dsh-android-bridge — 安卓授权桥（PRD F1.7：唯一受控提权扩展层）
 *
 * 职责（壳应用只做平台权能，策略在插件——洋葱原则）：
 *  - ctx.androidPrivilege 服务面：授权状态机（T0/T1/T2 三档语义）
 *    · 授权状态 = 完全访问档位（写面档位）+ 三道授权人门（系统无线调试 / 应用内允许访问开关 / 配对码）
 *    · 自动审批模式不构成开放条件（门控限死为完全访问档位）
 *  - 失败关闭：未授权 → 全部调用返回未授权引导，绝不静默降级
 *  - 审计：每次提权操作写 files/audit/ 换行分隔 JSON（时间/工具/参数/结果，不含凭据）
 *  - 执行：经桥原语 adbExec（壳侧实现；本插件面只看状态与审计——执行本体由 dsh-android-manage 消费）
 *
 * 状态来源：DSH_WRITE_MODE 环境（shell-termux 注入的写面档位）+ 壳侧桥状态（经 HTTP 端点/env 注入）
 * 首版（无 ADB 通道实现时）：状态查询 + 审计 + 失败关闭引导——与 PRD "未授权全部失败关闭" 语义一致。
 */
import { readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { A11Y_OPS, decideControl, type ControlDecision, type ControlOp } from './control-policy.js'
import {
  currentScreenScope,
  decideScreenAccess,
  controlOpNeedsRealScreen,
  realScreenAdbCommandDenied,
  adbCommandDisplayTokens,
  screenTokensFromSfDump,
  isVirtualScreenId,
  type ScreenAccessDecision,
  type UserScreenScope,
} from './screen-scope.js'
import { negotiateProtocol } from './control-queue.js'
import { translateAdbLine } from './shell-ops.js'
import { installCapabilityGate, DEVICE_TOOL_GROUPS, DEVICE_TOOLS, CAPABILITY_TOOL_NAME } from './capability-gate.js'
import {
  ControlQueue,
  controlTokenFrom,
  registerControlRoutes,
  tokenMatches,
  type ControlResult,
} from './control-queue.js'
import { toLosslessJson, findUndefinedPaths } from './lossless-json.js'
import {
  authorizeMobileRoute,
  authorizePublicReadOnlyRoute,
  sendMobileRouteRejection,
  CONTROL_TOKEN_HEADER,
  FALLBACK_LOOPBACK_HOSTS,
  ConnectionRouteAuth,
} from './route-auth.js'
import {
  SessionNotifyState,
  formatDuration,
  reportOutcomeLabel,
  sessionTag,
  shouldPopupReport,
  summarize,
  todoProgress,
  turnEndKind,
  turnEndOk,
  TURN_END_KINDS,
} from './notify-projection.js'

export {
  decideControl,
  currentScreenScope,
  decideScreenAccess,
  ControlQueue,
  registerControlRoutes,
  controlTokenFrom,
  tokenMatches,
  SessionNotifyState,
  formatDuration,
  reportOutcomeLabel,
  sessionTag,
  shouldPopupReport,
  summarize,
  todoProgress,
  turnEndKind,
  turnEndOk,
  TURN_END_KINDS,
  toLosslessJson,
  findUndefinedPaths,
  authorizeMobileRoute,
  sendMobileRouteRejection,
  CONTROL_TOKEN_HEADER,
  FALLBACK_LOOPBACK_HOSTS,
  // 0.14.0 §4.1：能力分组常量与 facade 名从单一源再导出——工具面预算门禁据此推导「初始可见集」
  // （= 注册集 - 被 capability gate 掩蔽的组），避免门禁另写一份组名单而与实现漂移。
  DEVICE_TOOL_GROUPS,
  DEVICE_TOOLS,
  CAPABILITY_TOOL_NAME,
}
export type {
  MobileRouteRequest,
  MobileRouteResponse,
  ConnectionRouteAuth,
  MobileRouteAuthOptions,
  MobileRouteRejection,
} from './route-auth.js'
export type { TurnEndKind, TurnEndKindOrUnknown, TodoProgress, ReportEntry } from './notify-projection.js'
export type { LosslessJson } from './lossless-json.js'
export type { ControlDecision, ControlOp } from './control-policy.js'
export type { ScreenAccessDecision, ScreenId, UserScreenScope } from './screen-scope.js'
export type { ControlRequest, ControlResult } from './control-queue.js'

export const name = 'dsh-android-bridge'
// 注意：inject 声明的服务必须预先存在——ctx.logger 是 cordis 内置方法（不需 inject），
// 误声明 'logger' 会导致插件 pending（waiting for service: logger）→ 整个插件树装载失败。
// 'shell' = dsh-shell-termux 提供的 Termux 原生执行器（F0.2 Termux 宿主通道经它执行）。
// 'sandboxPolicy' = dsh-sandbox-policy（会话级档位实时 resolve——AI 获取面）。
export const inject = ['tools', 'webServer', 'shell', 'sandboxPolicy'] as const

/** 授权档位（PRD F1.8 三档应用域语义；T1 为 shell 级授权档） */
export type PrivilegeTier = 'T0' | 'T1' | 'T2'

export interface AdbStatus {
  tier: PrivilegeTier
  /** 完全访问档位（All Files Access，系统权限；门1 前置） */
  fullAccess: boolean
  /** 写面档位（shell-termux sandboxMode；第二独立前置，非 danger 不构成开放条件） */
  writeMode?: string
  /** 系统无线调试已开启（第一道人门，应用不可程序化开启） */
  wirelessDebugOn?: boolean
  /** 应用内「允许访问」开关（第二道人门，默认关闭） */
  allowSwitchOn?: boolean
  /** 已配对（第三道人门；0.14 起 = 真实 adb pair 握手成功） */
  paired?: boolean
  /** 通道连接状态（配对后 adb connect 探活缓存；0.14 真实通道） */
  connected?: boolean
  /** 到期/错误信息（未授权时为引导文案） */
  message?: string
}

/** 审计记录落点：files/audit/audit.ndjson（换行分隔 JSON；DSH_ADB_AUDIT_PATH 可覆盖供测试） */
function auditDir(): string {
  return process.env.DSH_ADB_AUDIT_PATH ?? '/data/user/0/com.dsharnessmobile.shell/files/audit'
}

function writeAudit(entry: Record<string, unknown>) {
  try {
    const dir = auditDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'audit.ndjson')
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
    // 滚动截断：>2MB 时保留尾部（简单实现；ESM 下用导入的 fs 而非 require）
    try {
      if (statSync(file).size > 2 * 1024 * 1024) {
        const lines = readFileSync(file, 'utf8').split('\n')
        writeFileSync(file, lines.slice(-500).join('\n'))
      }
    } catch { /* 截断失败不阻断 */ }
  } catch { /* 审计失败不阻断主流程（隐私优先，静默放弃） */ }
}

/**
 * ADS 授权持久面（0.13.0 F1.7 设置页闭环，2026-08-23；Shizuku 对照收紧）：
 * 壳侧 AdbState 以 SharedPreferences 存「允许访问开关 / 配对」（dsh-adb.xml）。
 * 引擎进程与壳应用同 UID（ProcessBuilder 子进程），**只读**该 XML 作 live 状态面——
 * 开关/配对即时生效（不再依赖重启后 env 注入的启动快照），且**写面唯一在壳侧原生
 * AdbState**（setAllowSwitch/pairWithCode/revokePair + 审计）：被提权方（本插件/设置页
 * 端点）不得自改授权布尔（Shizuku：授权由管理器+特权服务器写入，客户端无权自授信）。
 * 桌面/非安卓宿主：文件路径不存在 → readShellAdbState 返回 undefined → 回落 env。
 */
const SHELL_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh-adb.xml'

export interface ShellAdbPrefs {
  allowSwitch: boolean
  paired: boolean
  /** 0.14 真实通道：配对端口/连接端口（系统「无线调试」弹窗抄录；连接端口供引擎侧 adb connect/shell）。 */
  pairPort?: string
  connectPort?: string
  /** 配对后 connect 探活缓存（壳侧 AdbState 维护；引擎只读）。 */
  connected?: boolean
  /** 0.13.5 W4：无障碍服务已连接（壳侧 DeviceControlService 维护；控制通道开关事实）。 */
  a11yEnabled?: boolean
  /** 0.13.5 W4：无障碍控制队列的共享令牌（壳侧每次启动生成；引擎侧比对）。 */
  controlToken?: string
  /** 0.13.5 W4：轮询心跳（epoch ms）——判定服务是否真的活着（防僵尸 a11yEnabled）。 */
  controlHeartbeat?: number
  /** 0.13.8 #180：门1 live 键（壳 syncFullAccess 写入；undefined = prefs 无该键 → 上层回落 env）。 */
  fullAccess?: boolean
  /**
   * ST-12：无线调试的**活体键**（壳 AdbState.syncWirelessLive 写入，TTL 2s < 页面轮询 3s）。
   * 与 paired 的区别：paired 是「曾经配对成功」的历史事实（授权持久化），wirelessOn 是
   * 「系统无线调试此刻开着」的实时开关——两者会分叉（用户配对后关掉无线调试）。
   * undefined = prefs 无该键（旧壳）→ 回落 paired（旧语义，不假装知道实时值）。
   */
  wirelessOn?: boolean
}

/** 持久文件路径：环境变量显式指定（测试/桌面模拟）优先；安卓壳域默认；其余返回 null。 */
function shellPrefsPath(): string | null {
  const explicit = process.env.DSH_ADB_PREFS_PATH
  if (explicit) return explicit
  // 安卓引擎进程的 process.platform 是 'linux'（Termux 快照），以 TERMUX__PREFIX 作壳域标记。
  if (process.env.TERMUX__PREFIX && process.env.DSH_HOME) return SHELL_PREFS_DEFAULT
  return null
}

/** SharedPreferences XML → 布尔/字符串状态；不存在/解析失败返回 undefined（上层回落 env）。 */
export function parseAdbPrefsXml(xml: string): ShellAdbPrefs | null {
  const mAllow = /<boolean\s+name="allowSwitch"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mPair = /<boolean\s+name="paired"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mConnected = /<boolean\s+name="connected"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mPairPort = /<string\s+name="pairPort">([^<]*)<\/string>/.exec(xml)
  const mConnectPort = /<string\s+name="connectPort">([^<]*)<\/string>/.exec(xml)
  // 0.13.5 W4：无障碍控制通道事实（服务连接状态 + 队列共享令牌）
  const mA11y = /<boolean\s+name="a11yEnabled"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mToken = /<string\s+name="controlToken">([^<]*)<\/string>/.exec(xml)
  const mHeartbeat = /<long\s+name="controlHeartbeat"\s+value="(\d+)"\s*\/?>/.exec(xml)
  // 0.13.8 #180：门1 live 化——fullAccess 键在场即解析（写端 = 壳侧 syncFullAccess）。
  const mFullAccess = /<boolean\s+name="fullAccess"\s+value="(true|false)"\s*\/?>/.exec(xml)
  // ST-12：无线调试活体键（写端 = 壳侧 AdbState.syncWirelessLive；TTL 2s）。
  const mWirelessOn = /<boolean\s+name="wirelessOn"\s+value="(true|false)"\s*\/?>/.exec(xml)
  // 只要任一受管键在场就解析——无障碍通道独立于 ADB 三道人门，
  // 未开启 ADB 时 prefs 里可能只有 a11yEnabled/controlToken（0.13.5 实测踩坑）。
  if (!mAllow && !mPair && !mA11y && !mToken && !mFullAccess) return null
  return {
    allowSwitch: mAllow ? mAllow[1] === 'true' : false,
    paired: mPair ? mPair[1] === 'true' : false,
    connected: mConnected ? mConnected[1] === 'true' : false,
    pairPort: mPairPort?.[1] || undefined,
    connectPort: mConnectPort?.[1] || undefined,
    a11yEnabled: mA11y ? mA11y[1] === 'true' : false,
    controlToken: mToken?.[1] || undefined,
    controlHeartbeat: mHeartbeat ? Number(mHeartbeat[1]) : undefined,
    fullAccess: mFullAccess ? mFullAccess[1] === 'true' : undefined,
    wirelessOn: mWirelessOn ? mWirelessOn[1] === 'true' : undefined,
  }
}

/** 读壳侧持久状态（live，**只读**——写面归属壳侧原生 AdbState）。 */
function readShellAdbState(): ShellAdbPrefs | undefined {
  const p = shellPrefsPath()
  if (!p) return undefined
  try {
    return parseAdbPrefsXml(readFileSync(p, 'utf8')) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 当前控制令牌实时值：生产 = 壳侧 prefs（每次启动由壳生成，重装/清数据后自愈）；
 * 只有显式测试开关 `DSH_CONTROL_TOKEN_TEST=1` 在场时 `DSH_CONTROL_TOKEN` 才生效
 * （ST-07）。同批鉴权的 exact 路由（dsh-android-file-open 的来件三条）复用本函数，
 * 不另造令牌方案。
 * @returns 令牌；未配置为 undefined（调用方必须 fail-closed）。
 */
export function shellControlToken(): string | undefined {
  return controlTokenFrom(process.env, readShellAdbState())
}

/**
 * 授权事实解析（2026-08-23 审校 C6/C7——引擎级 × 会话级两维模型）：
 * - **引擎级（用户是否授权）**：门1 All Files Access（DSH_ADB_FULLACCESS）+ 门2 允许开关
 *   + 门3 配对（live 壳侧 SharedPreferences）+ 无线调试（=paired 间接证明）——设备全局事实；
 * - **会话级（AI 能否获取）**：dsh-sandbox-policy 的当前会话档位（resolve({session})，实时）
 *   ——通道工具在每个 execute 按 `exec.agent.session` resolve；≠'danger-full-access' 即拒绝；
 * - 写面档位默认（sandboxPolicy.defaultMode）只作全局视图/引导显示；自动审批不参与判定。
 */
function currentStatus(env: NodeJS.ProcessEnv, defaultWriteMode?: string): AdbStatus {
  const writeMode = defaultWriteMode ?? env.DSH_WRITE_MODE ?? 'workspace-write'
  // live 优先：壳侧 SharedPreferences（引擎与壳同 UID 直读，只读）；无文件 → env 启动快照。
  const live = readShellAdbState()
  // 0.13.8 #180：门1 live 化——live prefs 优先（与门2/门3 完全同构），env 启动快照兜底；
  // 同一判定里不再有两套时效语义（桌面/测试宿主无 prefs 时回落 env）。
  const fullAccess = live ? (live.fullAccess ?? (env.DSH_ADB_FULLACCESS === '1')) : (env.DSH_ADB_FULLACCESS === '1')
  const allowSwitchOn = live ? live.allowSwitch : env.DSH_ADB_ALLOW === '1'
  const paired = live ? live.paired : env.DSH_ADB_PAIRED === '1'
  // ST-12：无线调试以活体键为准（wirelessOn 在场即用，哪怕它是 false——那是「配对后关掉
  // 无线调试」的实时事实）；旧壳无该键 → 回落 paired（旧的间接证明语义）。
  const wirelessDebugOn = live ? (live.wirelessOn ?? live.paired) : env.DSH_ADB_WIRELESS === '1'
  const connected = live ? live.connected === true : false
  const authorized = fullAccess && allowSwitchOn && paired && wirelessDebugOn
  const tier: PrivilegeTier = authorized && writeMode === 'danger-full-access' ? 'T1' : 'T0'
  return {
    tier,
    fullAccess,
    writeMode,
    wirelessDebugOn,
    allowSwitchOn,
    paired,
    connected,
    message: authorized
      ? writeMode === 'danger-full-access'
        ? connected === false
          ? '已配对——连接待建立：执行时自动重连；仍失败请核对「无线调试」弹窗端口或重新配对'
          : undefined
        : `已授权（引擎级）——当前部署档位 ${writeMode}，会话内档位实时判定（/permission danger-full-access 可即时开放）`
      : !fullAccess
        ? '未授权：需先授予系统「所有文件访问」（完全访问档位，回前台即生效）——自动审批模式不构成开放条件'
        : '未授权：请在「开发者选项 → 无线调试」开启并输入配对码与弹窗端口（授权状态在重启后需重新配对）',
    }
  }

/** 引擎级授权就绪（用户是否授权——不掺会话档位）。 */
function engineLevelReady(st: AdbStatus): boolean {
  return st.fullAccess && st.allowSwitchOn === true && st.paired === true && st.wirelessDebugOn === true
}

/** 0.13.5 W4：结构化授权事实（设置页与工具层共用，便于 AI 分卡定位失败原因）。 */
/** ST-23：无障碍在线的新鲜窗口（队列取活心跳与壳侧独立心跳共用同一口径）。 */
export const A11Y_FRESH_MS = 20_000

export interface ControlGateFacts {
  a11yEnabled: boolean
  /**
   * ST-23：无障碍在线判定的**来源标注**——queue=控制队列取活心跳新鲜，heartbeat=壳侧独立
   * 心跳线程新鲜（慢建树场景），off=两条都不新鲜。两口径并存时靠它区分，不再只能看一个布尔。
   */
  a11ySource: 'queue' | 'heartbeat' | 'off'
  fullAccess: boolean
  allowSwitch: boolean
  paired: boolean
  wirelessDebug: boolean
  adbReady: boolean
  /** 0.14.0 §6：Shizuku 特权 shell 通道就绪（壳侧 live caps；ADB 面退役后的特权承载者）。 */
  shizukuReady: boolean
}

/**
 * 危险命令检测（C2 修复）：shell 命令注入面不可只锚定开头——`echo x; rm -rf /`、
 * `:(){ :|:& };:` 变体、dd of=/system 等都可绕过旧黑名单。
 * 策略：① argv 词集合检测（常见高危工具/参数组合，分隔符切分后逐词匹配）
 *   ② 全命令正则（覆盖重定向/多命令拼接中的模式）
 * ③ 破坏性系统写面（mkfs/shutdown/reboot/wipe 等）一律拒绝。
 * 该通道面向「Termux 原生系统工具上下文」，正常用途（ps/dmesg/getprop/package 查询）
 * 不受影响。
 */
function looksDangerous(command: string): boolean {
  const c = command.trim()
  if (c === '') return true
  const lower = c.toLowerCase()
  // 全命令正则：多命令拼接/重定向场景
  const PATTERNS = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\/\*|~|\$home)\b/i,
    /\bmkfs(\.\w+)?\b/,
    /\bdd\b[^|&;]*\bof=\/(dev\/|system\/|\/)/,
    /\bchmod\s+-R\s+\d{3,4}\s+\//,
    /\bshutdown\b|\breboot\b|\bpoweroff\b|\bsync;?\s*reboot\b/,
    /:\s*\(\s*\)\s*\{[^}]*:\s*\|[^}]*&\s*\}/,
    /\bwipe(data|system)?\b/,
    /\bpm\s+uninstall\b/,
    /\bsvc\s+(power|netd|crypto)\b/,
  ]
  if (PATTERNS.some((p) => p.test(c))) return true
  // argv 级：分隔符切词（同时覆盖 && ; | 拼接的后续段）
  const words = c.split(/[\s;&|<>`$()]+/).filter(Boolean)
  const DANGER_WORDS = new Set([
    'mkfs', 'mkfs.ext4', 'mkfs.ext2', 'mkfs.f2fs', 'mkfs.xfs',
    'shutdown', 'reboot', 'poweroff', 'halt',
    'wipe', 'wipefs', 'wipeall',
  ])
  if (words.some((w) => DANGER_WORDS.has(w))) return true
  // rm -rf 指向系统根/家目录的变体
  for (let i = 0; i < words.length - 2; i++) {
    if (words[i] === 'rm' && (words[i + 1] === '-rf' || words[i + 1] === '-fr' || words[i + 1] === '-r' || words[i + 1] === '-R')
      && (words[i + 2] === '/' || words[i + 2] === '/*' || words[i + 2] === '*' || words[i + 2] === '~' || words[i + 2].startsWith('$home'))) {
      return true
    }
  }
  return false
}

/** ADB 通道附加黑名单（shell uid=2000 执行面比 app uid 更危险：系统级配置/权限写面一律拒绝）。 */
function looksDangerousAdb(command: string): boolean {
  if (looksDangerous(command)) return true
  const c = command.toLowerCase()
  const PATTERNS_ADB = [
    /\bsettings\s+(put|delete)\b/,
    /\bpm\s+(grant|revoke|set-permission|uninstall|install|disable-user|enable)\b/,
    /\bappops\s+(set|reset)\b/,
    /\bcontent\s+(insert|update|delete)\b/,
    /\bsvc\b/,
    /\bmount\b/,
    /\bcmd\s+(package|wifi|connectivity)\s+(set|reset|enable|disable)\b/,
    /\binput\s+(keyevent|text)\s+.*(power|home|menu)/,
  ]
  return PATTERNS_ADB.some((p) => p.test(c))
}

// ── 审查 §5.1 / S-5：授权门从**调用方**下沉到**服务面** ────────────────────────────────
//
// 缺陷形态：`gateFor(session)`（会话档位 danger-full-access）与危险命令黑名单此前只存在于
// 工具壳（manage 的 guard、bridge 的 shell 工具）里，而服务面 `controlExec` / `execAdbShell`
// **自身不判档位**。于是任何能 `ctx.get('androidPrivilege')` 的引擎侧代码（含市场装的第三方
// 插件）都能直接驱动 uid 2000 特权 shell 或向屏幕注入输入，与用户选的会话档位无关。
// in-tree 反例即 manage 的动画开关：同类命令经工具走会被黑名单拒，因为它是**内部直连**所以畅通
// ——说明「危险命令一律拒绝」是工具壳的属性，不是通道的属性。
//
// 修法：判据下沉到服务面，且**单一真源**（工具壳的检查保留为 UX 快速路径，服务面是地板）。
//
// 会话来源（两级，都显式）：
//   ① 调用点直接传 `{ session }`（首选）；
//   ② 工具层进入时 `bindSession(session)` 绑定到**当前异步上下文**（AsyncLocalStorage）——
//      manage 有 40+ 处私有面调用点分散在各 helper 里，逐个改签名既噪声大又易漏；
//      绑定点放在每个工具入口的 `guard()` 内，语义等价于「这次调用属于哪个会话」。
// 两者都没有 → **默认拒绝**（fail-closed：无来源的特权调用不接受）。
//
// 已知残余（如实登记）：恶意插件可以尝试 `bindSession(<别人的会话 id>)` 冒充来源——档位按该 id
// 实时 resolve，故它需要先知道一个处于 danger-full-access 的会话 id；且每次特权调用都落审计
// （含会话），事后可查。彻底消除需要上游提供「不可伪造的调用方身份」，不在本仓可控面。

/** 特权执行面的授权上下文。 */
export interface ControlAuth {
  /** 调用方会话（模型视角）——用于 `gateFor` 的档位判定。 */
  session?: unknown
  /**
   * 引擎内部**已知安全调用**：具名白名单（见 [INTERNAL_PRIVILEGED]）。
   * 名字必须在注册表里，且本次命令必须通过该名字自带的校验器；每次调用留审计。
   * **不是万能通行证**：未知名字 / 校验不过 / 该名字不适用于此 op 一律拒。
   */
  internal?: string
}

/**
 * 需要会话档位的控制 op —— 「一旦被任意引擎侧代码直接驱动，等价于拿到 uid 2000 shell
 * 或向设备屏注入输入」的面。
 *
 * 刻意不在列（各自的理由不同，别一刀切）：
 *  - `browser*`：0.14.0 做过一次**正确方向**的纠偏（浏览器不该被设备控制门锁死，见 control-policy
 *    的注释），本常量不把它加回来；它的权限档位问题走契约侧对齐（审查 §3.2-S5 / H-8）。
 *  - `vdInfo`/`vdCreate`/`vdDestroy`/`state`/`snapshot`/`nodeText`/`screenshot`/`web*`：读面或
 *    管理面，已被范围门与 A11Y_OPS 门覆盖；把它们也纳入会让「读设备状态」也变得过不去。
 */
const TIER_REQUIRED_OPS: readonly string[] = [
  'shExec', 'shPull', 'shPush', 'shRemove',
  'vdInput', 'vdLaunch', 'vdLaunchApp', 'vdMoveTask',
  'click', 'longClick', 'setText', 'scroll', 'global',
]

/** 动画三开关（manage 的 android_env_prepare 读写面）。 */
const ANIMATION_SCALE_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

/**
 * 动画三开关命令的**逐条形态**校验器（内部白名单不是「名字对了就放行」）。
 * 只接受两种由本仓代码构造的形态：
 *   读：`for k in <三键>; do echo R:$k=$(settings get global $k); done`
 *   写：`settings put global <三键之一> <数值|null>`，可多段以 `;` 连接
 */
function isAnimationScaleCommand(command: string): boolean {
  const text = command.trim()
  if (text === 'for k in ' + ANIMATION_SCALE_KEYS.join(' ') + '; do echo R:$k=$(settings get global $k); done') return true
  const parts = text.split(';').map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length === 0) return false
  return parts.every((part) => new RegExp(
    '^settings put global (' + ANIMATION_SCALE_KEYS.join('|') + ') ([0-9.]+|null)$').test(part))
}

/** 引擎内部已知安全调用注册表：名字 → 该名字**允许的命令形态**（形态外一律拒）。 */
const INTERNAL_PRIVILEGED: Record<string, { why: string; allows: (command: string) => boolean }> = {
  'sf-token-lookup': {
    why: '屏幕范围判定自身要核对 SurfaceFlinger 的虚拟屏 token；这条 dumpsys 读命令是判定的组成部分，与档位无关',
    allows: (command) => command.trim() === "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
  },
  'animation-scales': {
    why: 'manage 的动画三开关读写（uiautomator dump 需要事件流安静）；形态由 isAnimationScaleCommand 逐条钉死',
    allows: isAnimationScaleCommand,
  },
}

/**
 * 特权 shell 的超时口径（审查 §5.2 的错配修法）。
 *
 * **`shellTimeout < engineTimeout` 是硬不变量**：壳侧执行时限必须先到，引擎才能在命令真的
 * 执行完 / 被壳侧终止之后拿到结论。反了（旧实现：壳侧 20s、引擎入队 8s）会制造
 * 「假失败 + 副作用已发生」——模型按失败重试即**二次执行**（点击/输入/写入类 op 非幂等）。
 * 单测 test/screen-scope.test.mjs 钉住这条不变量。
 */
export const SHELL_EXEC_TIMEOUT_MS = 20_000
/** 引擎侧入队超时：必须**大于**壳侧执行时限（见上）。 */
export const SHELL_QUEUE_TIMEOUT_MS = 25_000

/** 当前异步上下文的调用方授权（由工具层 [AndroidPrivilegeService.bindSession] 绑定）。 */
const callerAuth = new AsyncLocalStorage<ControlAuth>()

/**
 * 热补丁（2026-08-27 真机实锤）：通道结果 → 模型文本。
 * 指定键的值仅 string 放行原样；其余类型一律 JSON.stringify 转写（含对象形状自证）——
 * 从机制上杜绝 `[object Object]` 进入模型转录（引擎序列化边界事故的现场补救）。
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

/**
 * 折叠重复行（0.14.0 设备实锤）。
 *
 * 缺陷形态：`android_termux_channel_exec` 跑 Termux 的 `am` 包装脚本时，同一条 loader 报错
 * 重复 40+ 次并**互相交错**，回执 25 KB 全是乱码：
 *
 *   CANNOT LINK EXECUTABLE "CANNOT LINK EXECUTABLE "grep": library ... not found
 *   grep": library ... not found
 *
 * 真因（源码实证，非推断）：Termux 的 `$PREFIX/bin/am` 在 exec 前显式执行
 *   `unset LD_LIBRARY_PATH LD_PRELOAD`
 * 于是它之后派生的任何 Termux 二进制（`grep` 等）都丢了库搜索路径 → 每条都以链接失败收场。
 * 这是 Termux 打包方的决定，**不是我们的环境注入有缺陷**（`printenv` 实测两项都在、`grep` 单跑正常）。
 *
 * 模型侧真正需要的结论只有一条：「这条命令失败了，原因是 X」。所以这里按行折叠，
 * 相同行只留一次并标注次数，把 25 KB 压回可读长度。
 */
export function condenseRepeatedText(text: string, maxRuns = 400): string {
  if (text.length === 0) return text
  const lines = text.split('\n')
  const out: string[] = []
  let prev: string | null = null
  let count = 0
  const flush = (): void => {
    if (prev === null) return
    out.push(count === 1 ? prev : `${prev}   （同句重复 ${count} 次）`)
    count = 0
  }
  for (const line of lines) {
    if (line === prev) { count += 1; continue }
    flush()
    prev = line
    count = 1
  }
  flush()
  // 行数仍超上限时保留首尾：开头与结尾最能说明问题，中间是同一故障的重复。
  if (out.length <= maxRuns) return out.join('\n')
  const head = out.slice(0, Math.floor(maxRuns / 2))
  const tail = out.slice(-Math.floor(maxRuns / 2))
  return [...head, `   …（中间省略 ${out.length - maxRuns} 行同类输出）…`, ...tail].join('\n')
}

/**
 * 热补丁根修（2026-08-27 活体插桩实锤）：dsh-shell run() 契约返回收集输出结构体
 * `{text, truncated, spillPath?}`（引擎内置 bash 工具经 streamText(output).text 同款读取），
 * 历史代码误按字符串 String() 直取 —— 进程真实执行（审计恒 ok）、转录恒 "[object Object]"，
 * 并连带 device_info 全占位符（拿乱码去 grep MODEL= 零匹配）。此处统一解包。
 */
function collectText(x: unknown): string {
  if (x === null || x === undefined) return ''
  if (typeof x === 'string') return x
  const o = x as Record<string, unknown>
  if (typeof o.text === 'string') return o.text
  try { return JSON.stringify(x) } catch { return '' }
}

/**
 * 服务面：ctx.androidPrivilege —— 授权状态机（供 dsh-android-manage 等消费）。
 * 全部方法失败关闭：未授权 → 拒绝（return 未授权引导），不执行、不降级。
 */
export class AndroidPrivilegeService {
  /** 最近一次连接校验缓存的设备型号（F4 多设备消歧；空 = 未校验/校验失败）。 */
  private liveModel = ''

  constructor(
    private readonly ctx: Context,
    private readonly defaultMode?: () => string | undefined,
    private readonly sandboxPolicy?: { defaultMode?: string; resolve(r?: { session?: unknown }): { mode?: string } },
    private readonly shellFace?: { resolve?(spec: Record<string, unknown>): Record<string, unknown>; run(spec: Record<string, unknown>): Promise<Record<string, unknown>> },
    /** 0.13.5 W4：无障碍控制队列（apply() 注入；缺省 = 控制通道不可用）。 */
    private readonly controlQueue?: ControlQueue,
  ) {}

  status(): AdbStatus {
    const st = currentStatus(process.env, this.defaultMode?.() ?? this.sandboxPolicy?.defaultMode)
    // 0.14.0 §6 双通道：Shizuku 特权通道是 ADB 面的替代通道（内置 adb 退役）——状态面必须如实
    // 说明当前由谁承载，而不是回显已无意义的 ADB 门文案。
    if (this.shizukuReady() && !engineLevelReady(st)) {
      return {
        ...st,
        message: '特权通道：Shizuku（已授权）——shell 执行 / 截屏 / uiautomator 经 Shizuku UserService（uid 2000）执行；'
          + '内置 adb 已退役（无线调试配对 / 常驻 server 不再需要）。',
      }
    }
    return st
  }

  /** 壳侧 live caps 声明的特权 shell 通道事实（0.14.0 §6：Shizuku UserService 可用）。 */
  shizukuReady(): boolean {
    return this.controlQueue?.stats().caps?.shizuku === true
  }

  /** 两条通道任一就绪即引擎级放行（不掺会话档位）：无障碍见 a11yEnabled，特权面 = ADB 或 Shizuku。 */
  private privilegedReady(st: AdbStatus): boolean {
    return engineLevelReady(st) || this.shizukuReady()
  }

  /** Native user preference, read live; model code has no write surface for it. */
  screenScope(): UserScreenScope {
    return currentScreenScope()
  }

  /** Fail-closed screen target decision shared by all real/virtual content tool paths. */
  screenAccess(screenId?: string): ScreenAccessDecision {
    return decideScreenAccess(this.screenScope(), screenId)
  }

  /**
   * review C11 alias 契约：把 `virtual-1` 解析为**当次**动态 displayId（经壳侧 vdInfo 注册表）。
   * 只认原生回报的 kind=virtual 且 displayId>0 的条目；未就绪/不可达一律 null（绝不回退 display 0）。
   */
  async resolveScreenDisplayId(screenId: string): Promise<number | null> {
    if (screenId === 'real') return 0
    if (!isVirtualScreenId(screenId)) return null
    try {
      const r = await this.controlExec('vdInfo', {})
      if (!r.ok) return null
      const data = (r.data ?? {}) as { screens?: Array<{ alias?: string; displayId?: number; kind?: string }> }
      const hit = (data.screens ?? []).find((s) => s.alias === screenId && s.kind === 'virtual')
      const id = hit?.displayId
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
    } catch {
      return null
    }
  }

  /** 异步解析版决策（review C11）：虚拟屏经注册表回填动态 displayId 后再判范围/就绪。 */
  async screenAccessResolved(screenId?: string): Promise<ScreenAccessDecision> {
    const scope = this.screenScope()
    const base = decideScreenAccess(scope, screenId)
    if (base.ok || base.reason !== 'screen-not-ready') return base
    return decideScreenAccess(scope, screenId, { virtualDisplayId: await this.resolveScreenDisplayId(base.screenId) })
  }

  /**
   * 块G F2：壳侧虚拟屏注册表当前登记的**全部** displayId（不按别名过滤）。
   *
   * 用途：raw shell 命令里显式出现 `-d <id>` 时，只有能证明该 id 属于一块虚拟屏才可放行
   * （否则「用户只给 virtual-only」会连自己的虚拟屏截图都拿不到）。只认原生回报的 kind=virtual
   * 且 displayId>0 的条目；注册表不可达一律空集（fail-closed：绝不凭命令里的数字自证是虚拟屏）。
   * 只在命令确实带了目标 id 时才去问壳侧，保持低成本路径零额外往返。
   */
  /**
   * 块G F2 + F6：一次 `vdInfo` 同时拿回**注册表的两个投影**（displayId 集合 + 别名集合）。
   *
   * 为什么合并成一次：控制队列是壳侧单线程（在途请求会被直接拒），两次分别问 vdInfo 不仅多一次
   * 往返，还会在并发/交叉调用下互相踩。一次取回、两处使用。
   * 注册表不可达 → 两个集合都为空（fail-closed）。
   */
  async registeredVirtualScreens(): Promise<{ ids: number[]; aliases: string[] }> {
    try {
      const r = await this.controlExec('vdInfo', {})
      if (!r.ok) return { ids: [], aliases: [] }
      const data = (r.data ?? {}) as { screens?: Array<{ alias?: string; displayId?: number; kind?: string }> }
      const virtual = (data.screens ?? []).filter((s) => s.kind === 'virtual')
      return {
        ids: virtual
          .map((s) => s.displayId)
          .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0),
        aliases: virtual
          .map((s) => s.alias)
          .filter((a): a is string => typeof a === 'string' && a.length > 0),
      }
    } catch {
      return { ids: [], aliases: [] }
    }
  }

  async registeredVirtualDisplayIds(): Promise<number[]> {
    return (await this.registeredVirtualScreens()).ids
  }

  /**
   * 块G F6：`dumpsys SurfaceFlinger` 的虚拟屏 **token ↔ 别名** 配对。
   *
   * 为什么需要（设备实测真因，见 screen-scope.ts 的 screenTokensFromSfDump）：`screencap -d` 吃的是
   * **SurfaceFlinger display token**，而壳侧注册表（`vdInfo`）给的是 **DisplayManager displayId**；
   * 两个 id 空间**不相交**——用 displayId 传 `-d` 对虚拟屏必然 Status -2，用 token 才出图。
   * 故范围判定必须能核对 token 归属，否则「放行的值取不到图、能取到图的值被拒」。
   *
   * **必须先用 grep 收窄**（设备实测，别改回全量）：全量 `dumpsys SurfaceFlinger` 在本机是 31,590 B，
   * 而虚拟屏段落在 **第 ~9,500 字节之后**，超出壳侧 capture 路径的 8 KiB inline 窗口（其余进 spool
   * 文件、不回传）⇒ 全量取回**必然**拿不到 `Virtual Display` 行，反查恒空、判定恒拒。
   * 收窄后只有 25 B 量级，稳稳落在窗口内。
   *
   * fail-closed：命令不可达/超时/解析不出 → 返回空数组（判定侧视为无 token 可核对 → 拒绝）。
   */
  async shellSfVirtualDisplayTokens(): Promise<Array<{ alias: string; token: string }>> {
    try {
      const r = await this.controlExec('shExec', {
        // 只取「Virtual Display <token>」与其紧跟的 name= 行；输出 ~25 B。
        command: "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
        timeoutMs: 15_000,
      }, SHELL_QUEUE_TIMEOUT_MS, { internal: 'sf-token-lookup' })
      if (!r.ok) return []
      const data = (r.data ?? {}) as Record<string, unknown>
      const stdout = typeof data.stdout === 'string' ? data.stdout : ''
      if (data.ok !== true || stdout.length === 0) return []
      return screenTokensFromSfDump(stdout)
    } catch {
      return []
    }
  }

  /**
   * 块G F2：raw shell 命令的屏幕范围复查（三个执行点共用）。
   *
   * 与纯 `realScreenAdbCommandDenied` 的区别：命令里带了可解析的目标 display id 且**基础判据确实要拒**
   * 时，才去问壳侧注册表核对；目标确为虚拟屏 → 放行。低成本路径（范围含 real / 命令不命中命令面 /
   * 命令无目标屏）零额外往返——不为一条本来就不该拦的命令多打一次 vdInfo。
   */
  private async adbCommandScopeDenied(command: string): Promise<string | null> {
    const base = realScreenAdbCommandDenied(this.screenScope(), command)
    if (base === null) return null
    if (adbCommandDisplayTokens(command).length === 0) return base
    // 块G F2 + F6：两个 id 空间都核对——DisplayManager displayId（F2）与 SurfaceFlinger token（F6）。
    //
    // 顺序刻意如此（两个理由，都别改）：
    //  ① **短路**：先只问注册表（一次 vdInfo，与 F2 既有开销一致）。命中即放行——绝大多数调用是
    //     displayId 形态，不该为它们多打一次 SurfaceFlinger 往返。
    //  ② **串行**：控制队列是壳侧单线程（`ControlQueue.enqueue` 在途时直接返回「已有在途的设备控制
    //     请求」），发 SF 反查前**必须**等注册表那一跳结束。并发发请求会让后一个立即失败 → token
    //     集合恒空 → 已注册虚拟屏的 token 也被拒（比不修更糟）。
    const registry = await this.registeredVirtualScreens()
    const byDisplayId = realScreenAdbCommandDenied(this.screenScope(), command, {
      virtualDisplayIds: registry.ids,
    })
    if (byDisplayId === null) return null
    // displayId 空间不命中：再核对 SurfaceFlinger token（只有这一路需要额外往返与别名集合）。
    if (registry.aliases.length === 0) return byDisplayId
    const sf = await this.shellSfVirtualDisplayTokens()
    return realScreenAdbCommandDenied(this.screenScope(), command, {
      virtualDisplayIds: registry.ids,
      virtualAliases: registry.aliases,
      sfVirtualDisplays: sf,
    })
  }

  /** 同上，公开面（android_shell_exec 工具执行点在类外，需要经服务对象调用）。 */
  shellCommandScopeDenied(command: string): Promise<string | null> {
    return this.adbCommandScopeDenied(command)
  }

  /**
   * 会话级通道门（AI 能否获取——实时）：引擎级授权（三道门+门1）满足后，
   * 按 `exec.agent.session` 的档位 resolve；≠ danger-full-access 即拒绝。
   * 安全方向：会话切回 read-only/workspace-write → 下一次调用立即拒绝。
   */
  /**
   * 会话级通道门（AI 能否获取——实时）。
   *
   * 0.13.5 W4 重构（PRD-0.13.2 §3.3 B3）：授权面从「ADB 三道人门」改为
   * **两条等价通道，无障碍优先**——
   *   - 无障碍通道：系统设置里开启「DSH 设备控制」一次即成立（设备控制面 dump/click/input/scroll）；
   *   - ADB 通道：完全访问 + 允许访问开关 + 无线调试配对（降级为高级/脚本通道：shell 执行、
   *     原图截图、系统面 pm/dumpsys）。
   * 两者都要求会话档位 danger-full-access（隐私敏感面不因通道简化而放宽）。
   * 任一通道成立即放行；都不可用时引导文案**先讲无障碍**（一次开关），再讲 ADB。
   */
  gateFor(session?: unknown): { ok: true; via?: 'a11y' | 'adb' | 'shizuku' } | { ok: false; guidance: string; gates?: ControlGateFacts } {
    const st = this.status()
    const a11ySource = this.a11ySource()
    const a11y = a11ySource !== 'off'
    // 0.13.8 #172：能力门只由「引擎级三道门 + 会话档位实时门」决定——部署默认写面
    // 档位（tier）降级为视图字段，不再参与门禁（坑 29：勿把部署默认当死锁）。
    const adbReady = engineLevelReady(st)
    const shizukuReady = this.shizukuReady()
    const gates: ControlGateFacts = {
      a11yEnabled: a11y,
      a11ySource,
      fullAccess: st.fullAccess === true,
      allowSwitch: st.allowSwitchOn === true,
      paired: st.paired === true,
      wirelessDebug: st.wirelessDebugOn === true,
      adbReady,
      shizukuReady,
    }
    const policy = this.sandboxPolicy?.resolve(session === undefined ? {} : { session })
    const mode = policy?.mode
    if (mode !== 'danger-full-access') {
      return {
        ok: false,
        gates,
        guidance: `会话档位为 ${mode ?? '未知'}，设备控制面要求 danger-full-access（无障碍通道同样受此门约束）——会话内 /permission danger-full-access 可即时开放`,
      }
    }
    if (a11y) return { ok: true, via: 'a11y' }
    if (shizukuReady) return { ok: true, via: 'shizuku' }
    if (adbReady) return { ok: true, via: 'adb' }
    return {
      ok: false,
      gates,
      guidance: '设备控制未授权。任选其一即可：'
        + '①（推荐，一次开关）到 系统设置 → 无障碍 → 已下载的服务 开启「DSH 设备控制」；'
        + '②到设置页「手机控制」安装、启动并授权 Shizuku（shell / 截屏 / uiautomator / 虚拟屏走它执行）。'
        + '两者都会即时生效，无需重启。',
    }
  }

  /** 授权状态探活（F2.9 / F1.7 授权探活：断线引导重新配对）——引擎级 + 会话级（默认档位视角）。 */
  assertAuthorized(): { ok: true; tier: PrivilegeTier } | { ok: false; guidance: string } {
    const st = this.status()
    if (!this.privilegedReady(st)) {
      const shizuku = this.shizukuReady()
      return {
        ok: false,
        guidance: shizuku
          ? (st.message ?? '未授权')
          : '未授权：到设置页「手机控制」开启「DSH 设备控制」无障碍服务，或安装、启动并授权 Shizuku（特权 shell / 截屏 / 虚拟屏）。',
      }
    }
    // 0.13.8 #172：tier（部署默认档位视图）不再作为拒绝条件——会话档位由各 execute 实时门禁。
    return { ok: true, tier: st.tier }
  }

  /** 审计写入（工具层每次提权操作调用） */
  audit(action: string, detail: Record<string, unknown>, ok: boolean) {
    writeAudit({ action, tool: detail.tool ?? '', args: detail.args ?? {}, result: ok ? 'ok' : 'denied' })
  }

  /** live 连接端口（真实通道；配对后由壳侧 AdbState 写入）。 */
  connectPort(): string | undefined {
    return readShellAdbState()?.connectPort
  }

  /**
   * ST-23：无障碍在线的**判定来源**。prefs 的 a11yEnabled 会在进程被 force-stop 后变成僵尸
   * true（onDestroy 不保证执行），所以叠加两类心跳，同一个 20s 新鲜窗口：
   *  - queue：控制队列最近一次取活（pollAgeMs）新鲜——慢建树的轮次里队列可能长时间没取活；
   *  - heartbeat：壳侧独立心跳线程写的 live prefs 键 controlHeartbeat 新鲜（防慢建树被误判掉线）；
   *  - off：都不新鲜 / prefs 未声明 a11yEnabled（fail-closed）。
   * 两条口径并存时必须能看出走的哪条，故对外同时暴露 {@link a11ySource}。
   */
  a11ySource(): 'queue' | 'heartbeat' | 'off' {
    const live = readShellAdbState()
    if (live?.a11yEnabled !== true) return 'off'
    if (this.controlQueue && this.controlQueue.pollAgeMs() < A11Y_FRESH_MS) return 'queue'
    const heartbeat = live.controlHeartbeat
    if (typeof heartbeat === 'number' && Number.isFinite(heartbeat) && Date.now() - heartbeat < A11Y_FRESH_MS) {
      return 'heartbeat'
    }
    return 'off'
  }

  /** 0.13.5 W4：无障碍服务是否**真的活着**（ST-23：队列心跳或独立心跳任一新鲜即可）。 */
  a11yEnabled(): boolean {
    return this.a11ySource() !== 'off'
  }

  /** 0.13.5 W4：结构化授权事实（两条通道各自的门）。 */
  gateFacts(): ControlGateFacts {
    const st = this.status()
    // 0.13.8 #172：同 gateFor——部署档位视图不参与能力门。
    const adbReady = engineLevelReady(st)
    const a11ySource = this.a11ySource()
    return {
      a11yEnabled: a11ySource !== 'off',
      a11ySource,
      fullAccess: st.fullAccess === true,
      allowSwitch: st.allowSwitchOn === true,
      paired: st.paired === true,
      wirelessDebug: st.wirelessDebugOn === true,
      adbReady,
      shizukuReady: this.shizukuReady(),
    }
  }

  /** 0.13.5 W4：当前操作应走哪个后端（纯策略，fail-closed）。 */
  controlDecision(op: ControlOp, session?: unknown, forceBackend?: 'a11y' | 'adb'): ControlDecision {
    const st = this.status()
    const mode = this.sandboxPolicy?.resolve(session === undefined ? {} : { session })?.mode
    return decideControl({
      op,
      a11yEnabled: this.a11yEnabled(),
      // 特权面就绪 = 内置 adb 三道门 或 Shizuku UserService（0.14.0 §6 双通道的同一事实面）。
      adbReady: engineLevelReady(st) || this.shizukuReady(),
      sessionMode: mode,
      forceBackend,
    })
  }

  /** 0.13.5 W4：队列统计（诊断用；不泄漏页面内容）。 */
  controlStats() {
    // 队列缺失时的降级视图：同样遵守「可选键缺省整键不发」（caps 不在此列）。
    return this.controlQueue?.stats() ?? {
      waiting: false, served: 0, failed: 0, lastTakeAt: 0, lastResultAt: 0,
      protocol: negotiateProtocol(undefined),
    }
  }

  /**
   * 工具层入口绑定本次调用的会话（审查 §5.1 / S-5）。
   *
   * 为什么用 AsyncLocalStorage 而不是模块级变量：工具调用**可以并发**（同一引擎上多个会话），
   * 模块级的「当前会话」会被并发调用互相覆盖——那正是 M5（browser 的 lastSnapshot 单槽）同型缺陷。
   * ALS 把会话绑在**当前异步上下文**上，工具体内调用的所有嵌套 helper 自动继承。
   */
  bindSession(session: unknown): void {
    if (session === undefined || session === null) return
    callerAuth.enterWith({ session })
  }

  /** 本次调用的授权：显式参数 > 当前异步上下文绑定 > 无（fail-closed 拒绝）。 */
  private resolveAuth(auth?: ControlAuth): ControlAuth {
    if (auth?.internal !== undefined || auth?.session !== undefined) return auth
    const bound = callerAuth.getStore()
    return bound === undefined ? {} : bound
  }

  /**
   * 特权面的服务侧授权（S-5）。`allowed:false` = 拒绝；`internal:true` = 走内部白名单放行
   * （已审计，调用方可据此跳过危险命令黑名单）。
   */
  private authorizePrivileged(
    auth: ControlAuth | undefined,
    op: string,
    command: string | undefined,
  ): { allowed: true; internal: boolean } | { allowed: false; error: string } {
    const resolved = this.resolveAuth(auth)
    const internal = resolved.internal
    if (typeof internal === 'string' && internal.length > 0) {
      const entry = INTERNAL_PRIVILEGED[internal]
      const ok = entry !== undefined && command !== undefined && entry.allows(command)
      writeAudit({ action: 'privileged-internal', call: internal, op, command: command ?? '', result: ok ? 'ok' : 'denied-internal-shape' })
      if (ok) return { allowed: true, internal: true }
      return {
        allowed: false,
        error: `内部特权调用 ${internal} 未登记、或本次命令不在其允许形态内（服务面拒绝）——`
          + '内部白名单按**命令形态**逐条校验，不是名字对了就放行。',
      }
    }
    if (resolved.session === undefined) {
      writeAudit({ action: 'privileged', op, command: command ?? '', result: 'denied-no-session' })
      return {
        allowed: false,
        error: `缺少调用方会话：特权面（${op}）不接受无来源调用（服务面默认拒绝）。`
          + '模型侧请经工具调用（工具层会绑定会话）；插件侧请显式传 { session }。',
      }
    }
    const gate = this.gateFor(resolved.session)
    if (!gate.ok) {
      writeAudit({ action: 'privileged', op, command: command ?? '', result: 'denied-not-gated' })
      return { allowed: false, error: gate.guidance }
    }
    return { allowed: true, internal: false }
  }

  /**
   * 0.13.5 W4：把一个壳桥操作交给壳侧执行。
   * 0.14.0 双通道（承载拆离）：只有 a11y 承载的 op（A11Y_OPS）要求无障碍在线；browser 与 vd 两组
   * 是 neverA11y（见 control-ops-pending.json），由壳侧 ControlCarrier 在无障碍关闭时照常承载——
   * 两条通道互不为前提，模型侧任一通道可用即可完成同类动作（不降级到 ADB/Shizuku——降级由工具层的策略决定）。
   */
  async controlExec(op: ControlOp, args: Record<string, unknown>, timeoutMs?: number, auth?: ControlAuth): Promise<ControlResult> {
    if (!this.controlQueue) return { ok: false, error: '控制队列未装配（插件未挂载 webServer？）' }
    // 审查 §5.1 / S-5：档位门在**服务面**复查（工具壳的检查是 UX 快速路径，不是唯一防线）。
    if (TIER_REQUIRED_OPS.includes(op)) {
      const command = typeof args.command === 'string' ? args.command : undefined
      const decision = this.authorizePrivileged(auth, op, command)
      if (!decision.allowed) return { ok: false, error: decision.error }
    }
    if (A11Y_OPS.includes(op) && !this.a11yEnabled()) {
      // SPEC §4.2②：无障碍关（纯 Shizuku）不等于「这条路走不通」——语义树/ref 动作确实不可用，
      // 但**坐标操作仍然可用**。此前这里返回硬错误，模型拿到一句「先去开无障碍」就停在原地；
      // 现在改为**结构化坐标模式指引**：如实说明当前只能坐标操作、并给出可直接照做的下一步，
      // 让模型在同一轮里继续推进任务（不静默失败、也不假装语义树可用）。
      //
      // 为什么坐标模式下这些 op 仍算失败：它们**本就是语义 op**（需要 ref/语义树）。
      // 坐标路径由 android_ui_click 的 nx/ny（以及对虚拟屏的 x/y + screenId）承担，
      // 那条路径不经 A11Y_OPS 门，故不受此处影响。
      const screenId = typeof args.screenId === 'string' && args.screenId !== '' ? args.screenId : 'real'
      return {
        ok: false,
        error: 'action-mode-coordinate: 无障碍未开启，' + op + ' 需要的语义树不可用；当前只能坐标操作。',
        coordinate: true,
        actionMode: 'coordinate',
        screenId,
        guidance: '改用坐标操作：① 真实屏 → android_screenshot 拿分辨率锚点，再 android_ui_click 传 nx/ny（0-1 归一化）；' +
          '② 虚拟屏 → android_vdisplay_input（tap/swipe/keyevent/text，坐标基于该屏自身像素，经 input -d 注入，真实屏不受影响）。' +
          '若确实需要语义树/ref 动作，请由用户在系统设置里开启「DSH 设备控制」无障碍服务。',
      }
    }
    // review C11 范围复查下沉到执行点：manage 工具层之外（其它插件/直连调用）不得绕过。
    //
    // 0.14.1 块G（F1）诊断修正：本判据此前是「按 op 名一刀切」——只看
    // `controlOpNeedsRealScreen(op)` 与用户范围，**从不读 `args.screenId`**，命中后还硬编码
    // 「不允许读取或操作真实屏幕」。于是范围 virtual-only、屏幕上确有 virtual-1 时，
    // `snapshot`/`screenshot`（本就带 screenId 且此刻目标是虚拟屏）被判成「读真实屏」而拒绝。
    // 用户实报的那条自相矛盾报文逐字来自这里——**是文案在撒谎，不是参数在漂移**
    // （screenId 在 args 里全程都在，manage guard 用的也是完整实参）。
    //
    // 正确判据 = **目标屏**，不是 op 名：REAL_SCREEN_CONTROL_OPS 表达的是「这个 op 按设计作用于
    // 屏幕内容」，而「这一次调用作用于哪块屏」必须由 args.screenId 经注册表解析后判定。
    // 未知别名 → screen-not-found，未就绪虚拟屏 → screen-not-ready，真实屏+范围不含 real →
    // screen-out-of-scope：三者都是 fail-closed，放宽的只是「目标确为虚拟屏且范围允许」这一例。
    if (controlOpNeedsRealScreen(op)) {
      const requested = typeof args.screenId === 'string' && args.screenId !== '' ? args.screenId : undefined
      const decision = await this.screenAccessResolved(requested)
      if (!decision.ok) {
        return { ok: false, error: decision.reason + ': ' + decision.guidance }
      }
    }
    return this.controlQueue.enqueue(op, args, timeoutMs)
  }

  /**
   * 最近一次连接校验缓存的设备型号（F4；空 = 未校验/校验失败）。
   * 0.14.0：ADB 连接面退役后不再有 connect/型号回读，本字段保留给诊断面（由 shell 通道的
   * `getprop ro.product.model` 回填的旧值）。
   */
  boundModel(): string {
    return this.liveModel
  }

  /** 经 termux 通道执行一行命令（adb 可执行；连接端口自动注入 `-s`）。 */
  private async runLine(line: string): Promise<{ ok: boolean; stdout: string }> {
    if (!this.shellFace) return { ok: false, stdout: 'Termux 执行器（dsh-shell-termux）未装配' }
    try {
      const input = { command: line, cwd: '/', env: {} }
      const spec = this.shellFace.resolve ? this.shellFace.resolve(input) : input
      const r = await this.shellFace.run(spec)
      return {
        ok: true,
        stdout: condenseRepeatedText(
          collectText((r as Record<string, unknown>).stdout) + collectText((r as Record<string, unknown>).stderr),
        ),
      }
    } catch (e) {
      return { ok: false, stdout: '执行失败：' + String((e as Error).message) }
    }
  }

  /**
   * 特权 shell 执行（0.14.0 §6）：经控制队列投递到壳侧 Shizuku UserService（uid 2000）执行。
   *
   * 0.14.0 前本方法在快照内经 Termux spawn `adb`（要无线调试配对 + 常驻 server）；0.14.0 起内置
   * adb 退役，失败一律回壳侧结构化 code/guidance（未安装 / 未启动 / 未授权 → 明确拒绝，非超时）。
   */
  async execAdbShell(command: string, auth?: ControlAuth): Promise<{ ok: boolean; stdout: string; guidance?: string }> {
    // 审查 §5.1 / S-5：特权面在**服务面**复查档位与危险命令（工具壳的同名检查保留为 UX 快速路径）。
    const decision = this.authorizePrivileged(auth, 'shExec', command)
    if (!decision.allowed) return { ok: false, stdout: '', guidance: decision.error }
    if (!decision.internal && looksDangerousAdb(command)) {
      writeAudit({ action: 'shell-exec', args: { command }, result: 'denied-danger-service' })
      return {
        ok: false,
        stdout: '',
        guidance: '命令被特权 shell 通道危险检查拦截（系统配置/权限写面一律拒绝；自动审批不豁免）'
          + '——该判据在**服务面**复查，任何插件直连同样生效。',
      }
    }
    // review C11：raw shell 是绕过页面/工具层的执行面——范围不含 real 时真实屏读写命令在此拒绝。
    // 块G F2：命令显式指定了目标屏（`-d <id>`）时按**目标屏**判定，不再按命令词一刀切。
    const scopeDenied = await this.adbCommandScopeDenied(command)
    if (scopeDenied !== null) return { ok: false, stdout: '', guidance: scopeDenied }
    // S-6：壳侧执行时限与引擎入队时限**同时**下发，且入队 > 壳侧（见 SHELL_QUEUE_TIMEOUT_MS 的说明）。
    const r = await this.controlExec(
      'shExec',
      { command, timeoutMs: SHELL_EXEC_TIMEOUT_MS },
      SHELL_QUEUE_TIMEOUT_MS,
      auth,
    )
    if (!r.ok) return { ok: false, stdout: '', guidance: r.error }
    const data = (r.data ?? {}) as Record<string, unknown>
    const stdout = typeof data.stdout === 'string' ? data.stdout : ''
    if (data.ok !== true) return { ok: false, stdout: stdout.slice(0, 4096), guidance: shellFailureText(data) }
    return { ok: true, stdout: stdout.slice(0, 128 * 1024) }
  }

  /**
   * 原始设备行执行（manage 等消费：screencap+pull 组合、uiautomator dump+pull）。
   * 0.14.0 §6：不再有 adb 客户端语义——行先翻译成 exec / pull / push 步骤（`translateAdbLine`），
   * 再逐步投递到壳侧特权 shell 通道；`adb` 字符串不出现于执行面。
   */
  async execAdbLine(line: string, auth?: ControlAuth): Promise<{ ok: boolean; stdout: string; guidance?: string }> {
    // 审查 §5.1 / S-5：与 execAdbShell 同一道服务面门（档位 + 危险命令黑名单）。
    const decision = this.authorizePrivileged(auth, 'shExec', line)
    if (!decision.allowed) return { ok: false, stdout: '', guidance: decision.error }
    if (!decision.internal && looksDangerousAdb(line)) {
      writeAudit({ action: 'shell-exec', args: { command: line }, result: 'denied-danger-service' })
      return {
        ok: false,
        stdout: '',
        guidance: '命令被特权 shell 通道危险检查拦截（系统配置/权限写面一律拒绝；自动审批不豁免）'
          + '——该判据在**服务面**复查，任何插件直连同样生效。',
      }
    }
    // review C11：screencap+pull / uiautomator dump 等行同样要在执行点复查屏幕范围。
    // 块G F2：`screencap -p -d <虚拟屏 id>` 是**读范围内的屏**，必须与无参 screencap 区分开。
    const scopeDenied = await this.adbCommandScopeDenied(line)
    if (scopeDenied !== null) return { ok: false, stdout: '', guidance: scopeDenied }
    const translated = translateAdbLine(line)
    if (!translated.ok) return { ok: false, stdout: '', guidance: translated.error }
    let out = ''
    for (const step of translated.steps) {
      if (step.kind === 'exec') {
        const r = await this.controlExec('shExec', { command: step.command, timeoutMs: SHELL_EXEC_TIMEOUT_MS }, SHELL_QUEUE_TIMEOUT_MS, auth)
        if (!r.ok) return { ok: false, stdout: out, guidance: r.error }
        const data = (r.data ?? {}) as Record<string, unknown>
        out += typeof data.stdout === 'string' ? data.stdout : ''
        continue
      }
      const r = step.kind === 'pull'
        ? await this.controlExec('shPull', { remote: step.remote, local: step.local }, SHELL_QUEUE_TIMEOUT_MS, auth)
        : await this.controlExec('shPush', { local: step.local, remote: step.remote }, SHELL_QUEUE_TIMEOUT_MS, auth)
      if (!r.ok) return { ok: false, stdout: out, guidance: r.error }
      const data = (r.data ?? {}) as Record<string, unknown>
      if (data.ok !== true) return { ok: false, stdout: out, guidance: shellFailureText(data) }
    }
    return { ok: true, stdout: out.slice(0, 128 * 1024) }
  }
}

/**
 * 壳侧 sh\* 回执的失败文案：优先 guidance，其次 error，最后给出可执行的通用引导（不得只回「失败」）。
 *
 * 「正在建立」与「未就绪」**必须分开**（0.14.0 设备实锤）：前者是可以立刻重试的瞬时态，
 * 后者才需要去设置页排查。此前两者共用「特权 shell 通道执行失败；请查看 Shizuku 状态」，
 * 于是壳侧明明还在正常建连，模型却被告知通道有问题——设备会话里 agent 正是据此放弃了特权通道。
 */
function shellFailureText(data: Record<string, unknown>): string {
  const guidance = typeof data.guidance === 'string' && data.guidance.length > 0 ? data.guidance : ''
  if (guidance.length > 0) return guidance
  const error = typeof data.error === 'string' && data.error.length > 0 ? data.error : ''
  if (error.length > 0) return error
  const code = typeof data.code === 'string' ? data.code : ''
  if (code === 'shizuku-user-service-connecting') {
    return 'Shizuku shell 通道正在建立（瞬时态）：请直接重试同一命令，不要改道或去设置页排查。'
  }
  return `特权 shell 通道执行失败${code.length > 0 ? `（${code}）` : ''}；请在设置页「手机控制」查看 Shizuku 状态与引导。`
}

/** 诊断面展示路由的常用操作（与工具面一一对应）。 */
const ROUTE_OPS: ControlOp[] = ['snapshot', 'click', 'scroll', 'setText', 'screenshot', 'global']

/**
 * android_privilege_status 的**声明面**（工具 schema）。返回面必须与它一致——
 * 离线用例 test/privilege-status.test.mjs 直接拿本常量做递归校验，声明与实现不再各写一份。
 */
export const PRIVILEGE_STATUS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tier: { type: 'string', required: true },
    fullAccess: { type: 'boolean', required: true },
    wirelessDebugOn: { type: 'boolean' },
    allowSwitchOn: { type: 'boolean' },
    paired: { type: 'boolean' },
    connected: { type: 'boolean' },
    authorized: { type: 'boolean' },
    writeMode: { type: 'string' },
    deviceModel: { type: 'string', description: '当前绑定设备型号（连接校验缓存；空=未知）' },
    message: { type: 'string' },
    gates: { type: 'object', additionalProperties: true, description: '结构化授权事实（a11yEnabled/fullAccess/allowSwitch/paired/wirelessDebug/adbReady）' },
    control: { type: 'object', additionalProperties: true, description: '控制通道运行时状态（a11yEnabled/queue/tokenConfigured）' },
    route: { type: 'object', additionalProperties: true, description: '每个常用操作走哪条通道/为什么/另一条缺什么（结构化路由）' },
    shell: { type: 'object', additionalProperties: true, description: '壳侧声明的协议版本与能力（caps.ops/view/gz）与协商结论' },
  },
}

/**
 * exact 路由 /api/android/privilege/status 的返回体（与工具面同源）。
 *
 * 出口必过 [toLosslessJson]：svc.status() 的 message、controlStats() 的 caps 都可能是
 * undefined——可选键缺省**整键不发**，否则返回体被工具体判为 not lossless JSON
 * （与 #204 同型：声明面与返回面脱钩）。
 */
export function buildPrivilegeStatusPayload(
  svc: AndroidPrivilegeService,
  controlTokenConfigured: boolean,
): Record<string, unknown> {
  return toLosslessJson({
    ...svc.status(),
    // 0.13.8 #172：结构化通道事实（两通道各自的门）——展示面与诊断共用，
    // adbReady 只看引擎级三道门（部署档位视图不参与，坑 29）。
    gates: svc.gateFacts(),
    // 0.13.5 W4：控制通道事实（只读；令牌本身绝不回显）
    control: {
      a11yEnabled: svc.a11yEnabled(),
      queue: svc.controlStats(),
      tokenConfigured: controlTokenConfigured,
    },
  }) as Record<string, unknown>
}

/**
 * android_privilege_status 的**返回面**（工具出口；离线用例直接调它做递归断言）。
 * 出口必过 [toLosslessJson]：st.message（已授权但连接未建立时是 undefined）与
 * queue.caps（壳侧从未声明能力时是 undefined）都是可选键——缺省就整键不发。
 */
export function buildPrivilegeStatusToolPayload(
  svc: AndroidPrivilegeService,
  session: unknown,
  controlTokenConfigured: boolean,
): Record<string, JsonValue> {
  const st = svc.status()
  // 0.13.8 P2-15：结构化 route 块——每个常用操作**走哪条通道、为什么、另一条缺什么**。
  // 以前这些判断只存在于代码路径里，模型只能靠「失败后猜」。
  const route: Record<string, unknown> = {}
  const facts = svc.gateFacts()
  for (const op of ROUTE_OPS) {
    const d = svc.controlDecision(op, session)
    // 0.14.0 §6：特权面 = Shizuku（内置 adb 退役）；无障碍仍是内容面的首选通道。
    const altPrivileged = facts.adbReady === true || facts.shizukuReady === true
    const altA11y = svc.a11yEnabled()
    route[op] = {
      backend: d.backend,
      reason: d.reason,
      alternative: d.backend === 'a11y'
        ? { backend: 'shizuku', available: altPrivileged, missing: altPrivileged ? null : '设置页「手机控制」：安装 / 启动 / 授权 Shizuku' }
        : { backend: 'a11y', available: altA11y, missing: altA11y ? null : '系统设置 → 无障碍 → 开启「DSH 设备控制」' },
    }
  }
  const queue = svc.controlStats()
  return toLosslessJson({
    ...st,
    deviceModel: svc.boundModel(),
    gates: svc.gateFacts(),
    route,
    shell: {
      protocol: queue.protocol,
      caps: queue.caps ?? null,
    },
    control: { a11yEnabled: svc.a11yEnabled(), queue, tokenConfigured: controlTokenConfigured },
  }) as Record<string, JsonValue>
}

function tools(svc: AndroidPrivilegeService, shellFace?: { resolve?(spec: Record<string, unknown>): Record<string, unknown>; run(spec: Record<string, unknown>): Promise<Record<string, unknown>> }, controlTokenConfigured: () => boolean = () => false) {
  const statusTool = defineTool({
    name: 'android_privilege_status',
    description:
      '查询设备控制授权状态。无障碍通道为主（系统设置开启「DSH 设备控制」一次即成立，'
      + '提供 dump/click/input/scroll 语义操作）；特权 shell 通道由 Shizuku 承载（设置页「手机控制」安装、启动并授权后：'
      + 'shell 执行、原图截图、pm/dumpsys、虚拟屏）。两条通道独立可用，任一就绪即可完成同类动作；'
      + '返回结构化 gates 与 control 字段；都不可用时给出两条开启路径的引导。手机管理工具全部以此为前置检查，失败关闭。',
    parameters: {},
    output: {
      // 运行期仍是 PRIVILEGE_STATUS_OUTPUT_SCHEMA 的完整对象；这里只把**静态类型**放宽为
      // json 根——execute 的返回类型由 schema 字面量推断，而本工具的返回体是运行期按
      // status/gates/route/shell 拼装后过 toLosslessJson 的聚合值。声明面与返回面的一致性
      // 由 test/privilege-status.test.mjs 拿同一常量做递归校验（不靠类型系统兜）。
      schema: PRIVILEGE_STATUS_OUTPUT_SCHEMA as unknown as { type: 'json' },
      render: (_args, value) => {
        // schema 静态类型放宽为 json 根后，渲染侧自行收窄（运行期结构由 schema 校验保证）。
        const v = value as Record<string, unknown>
        const gates = v.gates as ControlGateFacts | undefined
        const control = v.control as { tokenConfigured?: boolean; queue?: { lastTakeAt?: number } } | undefined
        const queueFresh = typeof control?.queue?.lastTakeAt === 'number' && control.queue.lastTakeAt > 0
          && Date.now() - control.queue.lastTakeAt < 20_000
        return [{
          type: 'text',
          text: [
            `授权档位 ${String(v.tier)}${v.deviceModel ? ' · ' + String(v.deviceModel) : ''}`,
            '无障碍通道：' + (gates?.a11yEnabled
              ? '已开启（可用·来源 ' + String(gates?.a11ySource ?? 'unknown') + '）'
              : '未开启')
              + (control?.tokenConfigured === true ? ' · 令牌已配置' : '')
              + `${queueFresh ? ' · 壳侧轮询在线' : ' · 壳侧轮询离线'}`,
            `ADB 通道：${gates?.adbReady ? '已就绪' : `未就绪（完全访问=${String(gates?.fullAccess)} 允许访问=${String(gates?.allowSwitch)} 配对=${String(gates?.paired)} 无线调试=${String(gates?.wirelessDebug)}）`}`,
            gates?.a11yEnabled ? '结论：设备控制可用（走无障碍通道）——下一步用 android_ui_dump（manage）拿语义清单'
              : gates?.adbReady ? '结论：设备控制可用（走 ADB 通道，仅兜底）——下一步用 android_ui_dump（无障碍优先）或 android_ui_tree（ADB）'
                : '结论：不可用——开启任一通道即可（推荐无障碍：系统设置 → 无障碍 → DSH 设备控制，一步即用）',
            v.message ? `ADB 提示：${String(v.message)}` : '',
            (() => {
              const shell = v.shell as { protocol?: { shell?: number; engine?: number; ok?: boolean; reason?: string }; caps?: { ops?: unknown[] } | null } | undefined
              if (!shell?.protocol) return ''
              const p = shell.protocol
              const capsOps = Array.isArray(shell.caps?.ops) ? (shell.caps!.ops as unknown[]).length : 0
              return `壳侧协议：pv=${String(p.shell)}（引擎支持 ${String(p.engine)}）${p.ok ? '' : ' —— 不兼容：' + String(p.reason)}`
                + (capsOps > 0 ? ` · 声明能力 ${capsOps} 项` : ' · 未声明能力（老壳）')
            })(),
            '路由（dump/click/scroll/input/screenshot/global）：'
              + Object.entries((v.route ?? {}) as Record<string, { backend?: string }>)
                .map(([op, r]) => `${op}=${String(r?.backend ?? '?')}`).join(' '),
          ].filter((line) => line !== '').join('\n'),
        }]
      },
    },
    execute: async (_args, exec) => buildPrivilegeStatusToolPayload(
      svc,
      (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session,
      controlTokenConfigured(),
    ),
  })
  const termuxChannelTool = defineTool({
    name: 'android_termux_channel_exec',
    description:
      'Termux 宿主通道（F0.2，第三授权通道）：仅当引擎级授权（门1 完全访问档位 + 门2 允许开关 + 门3 真实配对）' +
      '且会话档位 danger-full-access 时可用（自动审批不构成开放条件）；危险命令黑名单对该通道同样生效；' +
      '每次调用写审计。用于需要 Termux 环境原生命令（含系统工具上下文）的操作。',
    parameters: {
      command: { type: 'string', required: true, description: '要在 Termux 环境执行的 shell 命令' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'stdout', 'stderr', 'text') || '(no output)' },
      ],
    },
    execute: async ({ command }: { command: string }, exec) => {
      // 门控 = 引擎级授权（三道门+门1）&& 会话级档位（sandboxPolicy 按 exec.agent.session 实时 resolve）。
      // 自动审批只免交互确认，绝不作为特权档位替代——与文件头「自动审批不构成开放条件」一致。
      const gate = svc.gateFor((exec as { agent?: { session?: unknown } }).agent?.session)
      if (!gate.ok) {
        writeAudit({ action: 'termux-channel', args: { command }, result: 'denied-not-gated' })
        return { ok: false, text: gate.guidance }
      }
      // 危险命令阻挡（C2 修复：锚定开头黑名单可被 echo x; rm -rf / 等绕过）。
      // 改为命令词 argv 级检测 + 全命令正则双保险；仍以"允许类别 + 拒绝清单"为策略，
      // 高危面收窄到真正需要的系统工具上下文。
      if (looksDangerous(command)) {
        const guidance = '命令被危险命令检查拦截（自动审批不豁免安全地板）'
        writeAudit({ action: 'termux-channel', args: { command }, result: 'denied-danger' })
        return { ok: false, text: guidance }
      }
      writeAudit({ action: 'termux-channel', args: { command }, result: 'ok' })
      if (!shellFace) return { ok: false, text: 'Termux 执行器（dsh-shell-termux）未装配' }
      try {
        // P2-F4（审校 2026-08-23）：按 dsh-shell 契约「resolve 后 run」——resolve 注入
        // termuxEnv 烙印（PATH/PREFIX/LD_LIBRARY_PATH/HOME 等，拒绝被 request.env 覆盖），
        // 直接 run 会绕开环境注入导致通道命令找不到工具。
        const raw = { command, cwd: '/', env: {} }
        const spec = shellFace.resolve ? shellFace.resolve(raw) : raw
        const r = await shellFace.run(spec)
        return {
          ok: true,
          stdout: condenseRepeatedText(collectText((r as Record<string, unknown>).stdout)),
          stderr: condenseRepeatedText(collectText((r as { stderr?: unknown }).stderr)),
        }
      } catch (e) {
        return { ok: false, text: '执行失败：' + String((e as Error).message) }
      }
    },
  })
  /** 0.14.0 特权 shell 通道（Shizuku UserService，uid=2000；内置 adb 已退役，见 SPEC §6）。
   *  门控=引擎级授权 + 会话级 danger-full-access；黑名单=termux 黑名单 + 系统写面附加项；
   *  每次调用审计。执行身份为 shell（uid=2000），可触达系统面
   *  （dumpsys/uiautomator/screencap/input/pm 查询）；未安装/未启动/未授权 Shizuku → 结构化拒绝。 */
  const shellTool = defineTool({
    name: 'android_shell_exec',
    description:
      '特权 shell 通道执行（0.14.0，Shizuku UserService / uid 2000）：执行系统命令。' +
      '用途：screencap/uiautomator/dumpsys/input/getprop 等系统面只读与输入类；' +
      '系统配置写面（settings put/pm grant/appops/mount 等）一律拒绝。' +
      '需会话档位 danger-full-access 且设备已安装、启动并授权 Shizuku'
      + '（部署默认写面档位只是视图，不参与门禁——0.13.8 #172）；未就绪失败关闭并给出引导。',
    parameters: {
      command: { type: 'string', required: true, description: '在 shell（uid 2000）中执行的命令' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stdout: { type: 'string' },
          guidance: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [
        { type: 'text', text: pickText(v, 'stdout', 'guidance', 'text') || '(no output)' },
      ],
    },
    execute: async ({ command }: { command: string }, exec) => {
      const gate = svc.gateFor((exec as { agent?: { session?: unknown } }).agent?.session)
      if (!gate.ok) {
        writeAudit({ action: 'shell-exec', args: { command }, result: 'denied-not-gated' })
        return { ok: false, text: gate.guidance }
      }
      if (looksDangerousAdb(command)) {
        writeAudit({ action: 'shell-exec', args: { command }, result: 'denied-danger' })
        return { ok: false, text: '命令被特权 shell 通道危险检查拦截（系统配置/权限写面一律拒绝；自动审批不豁免）' }
      }
      // review C11：屏幕范围在执行点复查（工具层黑名单之外）——virtual-only 下 screencap/input 等真实屏命令拒绝。
      // 块G F2：命令带 `-d <id>` 时按**目标屏**判定（目标确为已注册虚拟屏则放行）。
      const scopeDenied = await svc.shellCommandScopeDenied(command)
      if (scopeDenied !== null) {
        writeAudit({ action: 'shell-exec', args: { command }, result: 'denied-screen-scope' })
        return { ok: false, text: scopeDenied }
      }
      writeAudit({ action: 'shell-exec', args: { command }, result: 'ok' })
      // S-5：把会话显式传到服务面（服务面自己也会判一次档位；工具壳的检查只是快速路径）。
      const r = await svc.execAdbShell(command, { session: (exec as { agent?: { session?: unknown } }).agent?.session })
      return r.ok
        ? { ok: true, stdout: r.stdout }
        : { ok: false, guidance: r.guidance ?? '', text: r.guidance ?? (r.stdout || '执行失败') }
    },
  })

  return [statusTool, termuxChannelTool, shellTool]
}

/** webServer 注册面（与 file-open 同型）。 */
type WsReq = {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  on(_e: string, cb: (b: Buffer) => void): void
  destroy(): void
}
type WsRes = {
  writeHead(code: number, headers: Record<string, string>): void
  end(body: string): void
}

function sendJson(res: WsRes, code: number, obj: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export function apply(ctx: Context, config: Record<string, unknown> = {}) {
  // 写面默认档位回退：shell-termux 实例（config 面）；主权威 = sandboxPolicy.defaultMode（部署默认）。
  const shellMode = (): string | undefined => {
    try {
      const shell = (ctx as unknown as { shell?: { sandboxMode?: string } }).shell
      return shell?.sandboxMode
    } catch {
      return undefined
    }
  }
  const sandboxPolicy = (ctx as unknown as {
    sandboxPolicy?: { defaultMode?: string; resolve(r?: { session?: unknown }): { mode?: string } }
  }).sandboxPolicy
  const shellFace = (ctx as unknown as {
    shell?: { resolve?(spec: Record<string, unknown>): Record<string, unknown>; run(spec: Record<string, unknown>): Promise<Record<string, unknown>> }
  }).shell
  // 0.13.5 W4：无障碍控制队列（引擎侧服务端；壳侧轮询取活/回填）。
  // 令牌实时读壳侧 prefs（每次启动生成）；DSH_CONTROL_TOKEN 只在显式测试开关
  // DSH_CONTROL_TOKEN_TEST=1 下生效（ST-07）；两处皆缺 → 路由 fail-closed。
  const controlQueue = new ControlQueue()
  const svc = new AndroidPrivilegeService(ctx, shellMode, sandboxPolicy, shellFace, controlQueue)
  try {
    ctx.provide('androidPrivilege', svc)
  } catch (e) {
    // 服务已提供（重复装载）：忽略，保持首个实例
    ctx.logger?.('dsh-android-bridge')?.debug?.('androidPrivilege already provided')
  }
  const controlToken = () => shellControlToken()
  ctx.effect?.(() => () => controlQueue.cancel('plugin disposed'))
  // F0.3 引擎事件桥（最小版，2026-08-24）：session 事件 → 「任务完成」标记文件。
  // 壳侧 WatchdogV2 每 5s 探活周期顺带消费标记 → 系统通知栏弹「任务完成」（POST_NOTIFICATIONS
  // 已由壳首启授权）。引擎→壳方向无页面依赖（不依赖 androidBridge/WebView 上下文）——
  // 标记文件路经 files/home/.dsh/.task-done.ndjson，壳读后清空。事件面：assistant/message
  // （agent 完成一轮完整输出）+ assistant/message.interrupted（被打断不弹）。
  const TASK_DONE_MARKER = (process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh') + '/.task-done.ndjson'
  const appendTaskMarker = (sessionId: unknown, title: string | undefined, text: string) => {
    try {
      const entry = JSON.stringify({ ts: new Date().toISOString(), sessionId: String(sessionId), title: title ?? '', text }) + '\n'
      appendFileSync(TASK_DONE_MARKER, entry)
    } catch { /* 标记失败不阻断（通知不是关键路径） */ }
  }
  // ── 通知信道 `.notify.ndjson`（0.14.0-preview §6.2.1）──
  // 唯一权威新信道：逐行 JSON、追加写、壳侧 FileObserver 按偏移消费后截断/轮转。
  // `kind` 是唯一分类权威（silent/todo/report/question/approval/resolve）；本插件只写
  // report（turn/end）与 todo（todo/write）——提问/审批的弹窗由壳侧 NotifyBridge 从
  // `$events` waterfall 直接投放（应答必须走 mux + `$events/result`，不经本文件）。
  // `.task-done.ndjson` 兼容期保留（老壳仍读它）；新壳只读本文件，双读不双发。
  const NOTIFY_FILE = (process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh') + '/.notify.ndjson'
  const NOTIFY_MAX = 512 * 1024
  let notifyBytes = 0
  try { notifyBytes = statSync(NOTIFY_FILE).size } catch { /* 新文件 */ }
  const appendNotify = (entry: Record<string, unknown>) => {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
      if (notifyBytes + line.length > NOTIFY_MAX) {
        try { renameSync(NOTIFY_FILE, NOTIFY_FILE + '.1') } catch { rmSync(NOTIFY_FILE, { force: true }) }
        notifyBytes = 0
      }
      appendFileSync(NOTIFY_FILE, line)
      notifyBytes += line.length
    } catch { /* 通知不是关键路径：写失败不阻断引擎 */ }
  }
  // 会话级投影状态（D13/D14 修复的载体：标题表 + 轮次用时/工具数 + 摘要 + 产出文件）
  const notifyState = new SessionNotifyState()
  // 探针（诊断用）：插件 apply 执行即写——验证插件加载与事件桥注册（2026-08-24 联调）。
  try {
    const probe = TASK_DONE_MARKER.replace('.task-done.ndjson', '.notify-probe.log')
    appendFileSync(probe, new Date().toISOString() + ' apply-ran\n')
  } catch { /* 探针失败忽略 */ }
  try {
    // ── 实时事件流（W7 悬浮球，2026-08-31；PRD-0.13.2 §4.2）──
    // 壳侧 OverlayService 经 FileObserver tail 消费（毫秒级、省电）；文件上限
    // 512KB，超限轮转 .1 一代。条目使用紧凑键：t=epoch ms s=sessionId k=类型。
    const LIVE_FILE = (process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh') + '/.live.ndjson'
    const LIVE_MAX = 512 * 1024
    let liveBytes = 0
    try { liveBytes = statSync(LIVE_FILE).size } catch { /* 新文件 */ }
    const appendLive = (line: string) => {
      try {
        if (liveBytes + line.length > LIVE_MAX) {
          try { renameSync(LIVE_FILE, LIVE_FILE + '.1') } catch { rmSync(LIVE_FILE, { force: true }) }
          liveBytes = 0
        }
        appendFileSync(LIVE_FILE, line)
        liveBytes += line.length
      } catch { /* 实时流失败不阻断主流程 */ }
    }
    // callId → {name, args, start}（tool/result 按 source.callId 配对，给耗时与参数）
    const liveCalls = new Map<string, { name: string; args: string; start: number }>()
    const live = (session: unknown, ev: { type?: string; data?: Record<string, unknown> }) => {
      const sess = session as { id?: unknown } | undefined
      const s = String(sess?.id ?? '')
      const t = Date.now()
      const k = ev.type ?? ''
      // 0.1.4（0.13.3 D6/W3）：turn/start 专门行退役——壳侧忙态改消费官方
      // api-session/status（agent/status → running 布尔，经 $events 流转发），
      // 语义等价且覆盖所有起轮路径；.live.ndjson 仅保留工具名 chip 所需的
      // tool_call/tool_result（壳侧保留 turn_start 行处理兼容旧包在装）。
      if (k === 'tool/call') {
        const d = ev.data as { name?: string; arguments?: string; callId?: string }
        const args = String(d.arguments ?? '').slice(0, 240)
        if (d.callId) liveCalls.set(String(d.callId), { name: String(d.name ?? ''), args, start: t })
        appendLive(JSON.stringify({ t, s, k: 'tool_call', name: String(d.name ?? ''), args }) + '\n')
        return
      }
      if (k === 'tool/result') {
        const d = ev.data as { message?: { source?: { callId?: string }; content?: Array<Record<string, unknown>> } }
        const callId = d?.message?.source?.callId ? String(d.message.source.callId) : ''
        const call = callId ? liveCalls.get(callId) : undefined
        const err = Array.isArray(d?.message?.content) && d.message.content.some((c) => c.isError === true)
        appendLive(JSON.stringify({
          t, s, k: 'tool_result', name: call?.name ?? '', args: call?.args ?? '',
          dur: call ? t - call.start : undefined, err,
        }) + '\n')
        if (callId) liveCalls.delete(callId)
        if (liveCalls.size > 256) { const first = liveCalls.keys().next().value; if (first !== undefined) liveCalls.delete(first) }
        return
      }
      if (k === 'assistant/message') {
        const content = (ev.data as { message?: { content?: Array<{ text?: string }> } })?.message?.content
        const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('').trim() : ''
        appendLive(JSON.stringify({ t, s, k: 'text', sum: text.slice(0, 160) || '（空回复）' }) + '\n')
        return
      }
      if (k === 'turn/end') {
        // D13（§6.5 NT-22）：载荷是 {turn, reason: TurnEndReason}，没有 outcome 字段。
        // 旧实现判 `d?.outcome === 'success'` 恒 false（.live.ndjson 的 turn_end.ok 全灭）。
        //
        // 0.14.1 块H（详档 §5.2 选项 C）：除 ok 之外必须**同时**写 kind——壳侧完成态语义标签
        // 优先消费 `turn_end.kind`（completed/aborted/blocked/error/max-tokens/interrupted），
        // `ok` 只是兜底。此前只写 ok，于是 ok=false 时壳侧只能显示笼统的「结果未知」，
        // 无法区分失败/被阻塞/被中断/被取消。kind 与 ok 同源（turnEndKind/turnEndOk 都读 reason.kind），
        // 未知 reason 一律 `unknown`，绝不映射成 completed（不得把未知当成功）。
        const d = ev.data as { turn?: unknown; reason?: unknown }
        appendLive(JSON.stringify({ t, s, k: 'turn_end', ok: turnEndOk(d?.reason), kind: turnEndKind(d?.reason) }) + '\n')
        return
      }
      if (k === 'session/title') {
        const d = ev.data as { title?: string }
        appendLive(JSON.stringify({ t, s, k: 'title', title: String(d?.title ?? '').slice(0, 80) }) + '\n')
      }
    }
    ctx.on('session/event', (session: unknown, event: unknown) => {
      if (event === null || typeof event !== 'object') return
      const ev = event as { type?: string; data?: Record<string, unknown> }
      const type = ev.type ?? ''
      const sessId = String((session as { id?: unknown } | undefined)?.id ?? '')
      const now = Date.now()
      // ── 通知投影（§6.2.1 信道协议；`.notify.ndjson` 逐行追加）──
      // 标题来源是 session/title（D14）；成败判定是 reason.kind（D13）。两处都不得回退
      // 到「session.header.title」或「reason.outcome」——那些字段不存在。
      try {
        switch (type) {
          case 'session/title':
            notifyState.setTitle(sessId, ev.data?.title)
            break
          case 'turn/start':
            notifyState.startTurn(sessId, ev.data?.turn, now)
            break
          case 'tool/call':
            notifyState.countToolCall(sessId)
            break
          case 'assistant/message': {
            const content = (ev.data as { message?: { content?: Array<{ text?: string }> } })?.message?.content
            const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('').trim() : ''
            notifyState.setSummary(sessId, text)
            // 兼容期：老壳仍读 .task-done.ndjson（新壳只读 .notify.ndjson，双读不双发）。
            appendTaskMarker(sessId, notifyState.titleFor(sessId), summarize(text, 80) || '任务完成')
            break
          }
          case 'deliverables/presented':
            notifyState.setPresented(sessId, (ev.data as { files?: unknown } | undefined)?.files)
            break
          case 'todo/write': {
            const progress = todoProgress(ev.data?.todos)
            // ≥1s 节流 + 进度签名不变不重投（R6：高频静默更新会拖累同包弹窗类的提醒强度）
            if (notifyState.acceptTodo(sessId, progress, now)) {
              appendNotify({
                kind: 'todo',
                done: progress.done,
                total: progress.total,
                current: progress.current,
                sessionId: sessId,
                title: notifyState.titleFor(sessId),
              })
            }
            break
          }
          case 'turn/end': {
            const kind = turnEndKind(ev.data?.reason)
            if (kind === 'unknown') {
              ctx.logger?.('dsh-android-bridge')?.warn?.(
                'turn/end reason.kind 未知（上游新增 kind？）：' + JSON.stringify(ev.data?.reason ?? null),
              )
            }
            const report = notifyState.endTurn({ sessionId: sessId, turn: ev.data?.turn, reason: ev.data?.reason, now })
            appendNotify({
              kind: 'report',
              outcome: report.outcome,
              outcomeLabel: reportOutcomeLabel(report.outcome),
              sessionId: report.sessionId,
              title: report.title,
              summary: report.summary,
              durationMs: report.durationMs,
              durationLabel: formatDuration(report.durationMs),
              toolCount: report.toolCount,
              turn: report.turn,
              presentedFiles: report.presentedFiles,
              // aborted（用户自己按停）不弹窗，其余（含未知）都弹——NT-05
              popup: shouldPopupReport(report.outcome),
            })
            break
          }
          default:
            break
        }
      } catch (e) {
        ctx.logger?.('dsh-android-bridge')?.warn?.('notify projection failed: ' + String((e as Error).message))
      }
      // 实时流（悬浮球）
      try { live(session, ev) } catch { /* 单条失败忽略 */ }
    })
    try {
      const probe = TASK_DONE_MARKER.replace('.task-done.ndjson', '.notify-probe.log')
      appendFileSync(probe, new Date().toISOString() + ' listener-registered\n')
    } catch { /* 探针失败忽略 */ }
  } catch (e) {
    ctx.logger?.('dsh-android-bridge')?.warn?.('task-done marker listener failed: ' + String((e as Error).message))
    try {
      const probe = TASK_DONE_MARKER.replace('.task-done.ndjson', '.notify-probe.log')
      appendFileSync(probe, new Date().toISOString() + ' listener-FAILED: ' + String((e as Error).message) + '\n')
    } catch { /* 探针失败忽略 */ }
  }
  for (const t of tools(svc, shellFace, () => controlToken() !== undefined)) ctx.tools.register(t)
  // 渐进披露（0.14.0 §4.1）：设备工具默认对每个 agent 掩蔽，模型经 skill 目录发现能力后调用
  // android_capabilities 解锁；facade 之外的工具不再常驻系统提示词。
  installCapabilityGate(
    ctx as unknown as Parameters<typeof installCapabilityGate>[0],
    () => ({ a11y: svc.a11yEnabled(), shizuku: svc.shizukuReady() }),
  )
  // 状态端点（浏览端面/设置页查询与展示）。**只读**：无任何写面——授权变更经
  // window.androidBridge.setAdbAllow/setAdbPair/revokeAdbPair 由壳侧原生 AdbState 执行
  // （Shizuku 对照：被提权方不得自改授权；引擎侧不设 POST 写端点）。
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): void } }).webServer
  if (wsvc) {
    // review C12：公开只读状态路由补回环栅栏（connection 的 Host/Origin 判定优先；缺服务时退化为回环白名单）。
    const publicRouteConnection = (() => {
      try {
        return (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection') as ConnectionRouteAuth | undefined
      } catch {
        return undefined
      }
    })()
    wsvc.register({
      kind: 'exact',
      path: '/api/android/privilege/status',
      handler: async (req: WsReq, res: WsRes) => {
        const rejection = authorizePublicReadOnlyRoute(req, { connection: publicRouteConnection })
        if (rejection !== undefined) {
          sendMobileRouteRejection(res, rejection)
          return
        }
        sendJson(res, 200, buildPrivilegeStatusPayload(svc, controlToken() !== undefined))
      },
    })
    // 0.13.5 W4：无障碍控制队列两条 exact 路由（自带共享令牌；壳侧轮询取活/回填）。
    registerControlRoutes(wsvc, {
      queue: controlQueue,
      token: controlToken,
      logger: ctx.logger?.('dsh-android-bridge'),
    })
  }
}
