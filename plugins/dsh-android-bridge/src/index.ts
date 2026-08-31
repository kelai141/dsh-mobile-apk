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
import { mkdirSync, appendFileSync, statSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
function parseAdbPrefsXml(xml: string): ShellAdbPrefs | null {
  const mAllow = /<boolean\s+name="allowSwitch"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mPair = /<boolean\s+name="paired"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mConnected = /<boolean\s+name="connected"\s+value="(true|false)"\s*\/?>/.exec(xml)
  const mPairPort = /<string\s+name="pairPort">([^<]*)<\/string>/.exec(xml)
  const mConnectPort = /<string\s+name="connectPort">([^<]*)<\/string>/.exec(xml)
  if (!mAllow && !mPair) return null
  return {
    allowSwitch: mAllow ? mAllow[1] === 'true' : false,
    paired: mPair ? mPair[1] === 'true' : false,
    connected: mConnected ? mConnected[1] === 'true' : false,
    pairPort: mPairPort?.[1] || undefined,
    connectPort: mConnectPort?.[1] || undefined,
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
 * 授权事实解析（2026-08-23 审校 C6/C7——引擎级 × 会话级两维模型）：
 * - **引擎级（用户是否授权）**：门1 All Files Access（DSH_ADB_FULLACCESS）+ 门2 允许开关
 *   + 门3 配对（live 壳侧 SharedPreferences）+ 无线调试（=paired 间接证明）——设备全局事实；
 * - **会话级（AI 能否获取）**：dsh-sandbox-policy 的当前会话档位（resolve({session})，实时）
 *   ——通道工具在每个 execute 按 `exec.agent.session` resolve；≠'danger-full-access' 即拒绝；
 * - 写面档位默认（sandboxPolicy.defaultMode）只作全局视图/引导显示；自动审批不参与判定。
 */
function currentStatus(env: NodeJS.ProcessEnv, defaultWriteMode?: string): AdbStatus {
  const writeMode = defaultWriteMode ?? env.DSH_WRITE_MODE ?? 'workspace-write'
  const fullAccess = env.DSH_ADB_FULLACCESS === '1'
  // live 优先：壳侧 SharedPreferences（引擎与壳同 UID 直读，只读）；无文件 → env 启动快照。
  const live = readShellAdbState()
  const allowSwitchOn = live ? live.allowSwitch : env.DSH_ADB_ALLOW === '1'
  const paired = live ? live.paired : env.DSH_ADB_PAIRED === '1'
  const wirelessDebugOn = live ? live.paired : env.DSH_ADB_WIRELESS === '1'
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
        ? '未授权：需先授予系统「所有文件访问」（完全访问档位，授予后重启引擎生效）——自动审批模式不构成开放条件'
        : '未授权：请在「开发者选项 → 无线调试」开启并输入配对码与弹窗端口（授权状态在重启后需重新配对）',
    }
  }

/** 引擎级授权就绪（用户是否授权——不掺会话档位）。 */
function engineLevelReady(st: AdbStatus): boolean {
  return st.fullAccess && st.allowSwitchOn === true && st.paired === true && st.wirelessDebugOn === true
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
  constructor(
    private readonly ctx: Context,
    private readonly defaultMode?: () => string | undefined,
    private readonly sandboxPolicy?: { defaultMode?: string; resolve(r?: { session?: unknown }): { mode?: string } },
    private readonly shellFace?: { resolve?(spec: Record<string, unknown>): Record<string, unknown>; run(spec: Record<string, unknown>): Promise<Record<string, unknown>> },
  ) {}

  status(): AdbStatus {
    return currentStatus(process.env, this.defaultMode?.() ?? this.sandboxPolicy?.defaultMode)
  }

  /**
   * 会话级通道门（AI 能否获取——实时）：引擎级授权（三道门+门1）满足后，
   * 按 `exec.agent.session` 的档位 resolve；≠ danger-full-access 即拒绝。
   * 安全方向：会话切回 read-only/workspace-write → 下一次调用立即拒绝。
   */
  gateFor(session?: unknown): { ok: true } | { ok: false; guidance: string } {
    const st = this.status()
    if (!engineLevelReady(st)) {
      return { ok: false, guidance: st.message ?? '未授权' }
    }
    const policy = this.sandboxPolicy?.resolve(session === undefined ? {} : { session })
    const mode = policy?.mode
    if (mode !== 'danger-full-access') {
      return {
        ok: false,
        guidance: `会话级档位 ${mode ?? '未知'}（需 danger-full-access）——引擎级授权已满足，但 AI 获取面不开放；会话内 /permission danger-full-access 可即时开放`,
      }
    }
    return { ok: true }
  }

  /** 授权状态探活（F2.9 / F1.7 授权探活：断线引导重新配对）——引擎级 + 会话级（默认档位视角）。 */
  assertAuthorized(): { ok: true; tier: PrivilegeTier } | { ok: false; guidance: string } {
    const st = this.status()
    if (!engineLevelReady(st)) {
      return { ok: false, guidance: st.message ?? '未授权' }
    }
    if (st.tier === 'T0') {
      return { ok: false, guidance: st.message ?? '未授权' }
    }
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
   * 现场解析可用连接端口：配置端口优先（壳侧 AdbState 记录），失效即回退 5555
   * （vivo 等无线调试常驻端口；NSD 记录值会随无线调试重启轮换——2026-08-27 实锤 37575 失联）。
   * 端口为 loopback 信息不入审计。@returns 可用端口与 connect 输出；全失败返回 undefined。
   */
  private async resolveLivePort(): Promise<{ port: string; output: string } | { port: undefined; output: string }> {
    const candidates = [...new Set([this.connectPort(), '5555'].filter((p): p is string => !!p))]
    let last = ''
    for (const port of candidates) {
      const c = await this.runLine(`adb connect 127.0.0.1:${port}`)
      if (!c.ok) { last = c.stdout; continue }
      last = c.stdout
      if (/connected to|already connected/i.test(c.stdout)) return { port, output: c.stdout }
    }
    return { port: undefined, output: last }
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
        stdout: collectText((r as Record<string, unknown>).stdout) + collectText((r as Record<string, unknown>).stderr),
      }
    } catch (e) {
      return { ok: false, stdout: '执行失败：' + String((e as Error).message) }
    }
  }

  /**
   * 真实 ADB 通道执行（0.14）：引擎级授权就绪后，经快照内 adb（android-tools 36）
   * `adb connect`（幂等）→ `adb -s 127.0.0.1:<port> shell <command>` —— adbd 以 shell uid=2000 执行。
   * 授权锚 = 真实配对（adbd 侧 RSA 授权）+ 三道门（壳侧写面）；会话级门控由调用方（工具层）先行。
   */
  async execAdbShell(command: string): Promise<{ ok: boolean; stdout: string; guidance?: string }> {
    if (!engineLevelReady(this.status())) {
      return { ok: false, stdout: '', guidance: this.status().message ?? '未授权' }
    }
    const live = await this.resolveLivePort()
    if (live.port === undefined) {
      return { ok: false, stdout: live.output.slice(0, 2048), guidance: 'ADB 连接不可用（配置端口与 5555 均失联）：确认「无线调试」仍开启，必要时重新配对' }
    }
    const port = live.port
    const out = await this.runLine(`adb -s 127.0.0.1:${port} shell ${command}`)
    if (!out.ok) return { ok: false, stdout: out.stdout }
    if (/(^|\n)error:|no devices\/emulators|offline/.test(out.stdout)) {
      return { ok: false, stdout: out.stdout.slice(0, 4096), guidance: 'ADB 连接不可用：确认「无线调试」仍开启，必要时重新配对' }
    }
    return { ok: true, stdout: out.stdout.slice(0, 128 * 1024) }
  }

  /**
   * 原始 adb 行执行（manage 等消费：screencap+pull 组合、uiautomator dump+pull）。
   * 自动注入 `-s 127.0.0.1:<port>`（行内每个 `adb ` 前缀）+ 幂等 connect；
   * 授权门槛同 execAdbShell；行内命令自行组织（危险词仍由调用方工具层 blacklist 兜底）。
   */
  async execAdbLine(line: string): Promise<{ ok: boolean; stdout: string; guidance?: string }> {
    if (!engineLevelReady(this.status())) {
      return { ok: false, stdout: '', guidance: this.status().message ?? '未授权' }
    }
    const live = await this.resolveLivePort()
    if (live.port === undefined) {
      return { ok: false, stdout: live.output.slice(0, 2048), guidance: 'ADB 连接不可用（配置端口与 5555 均失联）：确认「无线调试」仍开启，必要时重新配对' }
    }
    const port = live.port
    if (!/^adb\s/.test(line)) return { ok: false, stdout: '', guidance: 'execAdbLine 只能执行以 adb 开头的行' }
    // 仅注入命令位置（行首 / && / ; 之后）的 adb，避免误伤引号内文本（如 adb shell "echo adb hi"）。
    const line2 = line.replace(/(^|&&\s*|;\s*)adb\s/g, `$1adb -s 127.0.0.1:${port} `)
    const out = await this.runLine(`${line2}`)
    if (!out.ok) return { ok: false, stdout: out.stdout }
    return { ok: true, stdout: out.stdout.slice(0, 128 * 1024) }
  }
}

function tools(svc: AndroidPrivilegeService, shellFace?: { resolve?(spec: Record<string, unknown>): Record<string, unknown>; run(spec: Record<string, unknown>): Promise<Record<string, unknown>> }) {
  const statusTool = defineTool({
    name: 'android_privilege_status',
    description:
      '查询安卓调试桥（ADB）授权状态：档位（T0 未授权 / T1 授权调试档）与三道授权人门状态。' +
      '未授权时返回引导文案。手机管理工具全部以此为前置检查，失败关闭。',
    parameters: {},
    output: {
      schema: {
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
          message: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{
        type: 'text',
        text: `授权档位 ${String(v.tier)}${v.message ? '——' + String(v.message) : ''}`,
      }],
    },
    execute: async () => {
      const st = svc.status()
      return { ...st }
    },
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
        return { ok: true, stdout: collectText((r as Record<string, unknown>).stdout), stderr: collectText((r as { stderr?: unknown }).stderr) }
      } catch (e) {
        return { ok: false, text: '执行失败：' + String((e as Error).message) }
      }
    },
  })
  /** 0.14 真实 ADB 通道（adb pair 握手后，经 adbd 以 shell uid=2000 执行）。
   *  门控=引擎级三道门+门1 && 会话级 danger-full-access；黑名单=termux 黑名单 + ADB 系统写面附加项；
   *  每次调用审计。与 termux 通道的区别：执行身份为 adbd（uid=2000 shell），可触达系统面
   *  （dumpsys/uiautomator/screencap/input/pm 查询）。 */
  const adbShellTool = defineTool({
    name: 'android_adb_shell_exec',
    description:
      '真实 ADB 通道执行（0.14）：经本机 adbd 以 shell 身份执行系统命令（配对后可用）。' +
      '用途：screencap/uiautomator/dumpsys/input/getprop 等系统面只读与输入类；' +
      '系统配置写面（settings put/pm grant/appops/mount 等）一律拒绝。' +
      '需完整授权（门1 完全访问档位 + 门2 允许开关 + 门3 真实配对）且会话档位 danger-full-access；未授权失败关闭。',
    parameters: {
      command: { type: 'string', required: true, description: '在 adbd（shell 用户）中执行的命令' },
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
        writeAudit({ action: 'adb-shell', args: { command }, result: 'denied-not-gated' })
        return { ok: false, text: gate.guidance }
      }
      if (looksDangerousAdb(command)) {
        writeAudit({ action: 'adb-shell', args: { command }, result: 'denied-danger' })
        return { ok: false, text: '命令被 ADB 通道危险检查拦截（系统配置/权限写面一律拒绝；自动审批不豁免）' }
      }
      writeAudit({ action: 'adb-shell', args: { command }, result: 'ok' })
      const r = await svc.execAdbShell(command)
      return r.ok
        ? { ok: true, stdout: r.stdout }
        : { ok: false, text: r.guidance ?? (r.stdout || '执行失败') }
    },
  })

  return [statusTool, termuxChannelTool, adbShellTool]
}

/** webServer 注册面（与 file-open 同型）。 */
type WsReq = {
  method?: string
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
  const svc = new AndroidPrivilegeService(ctx, shellMode, sandboxPolicy, shellFace)
  try {
    ctx.provide('androidPrivilege', svc)
  } catch (e) {
    // 服务已提供（重复装载）：忽略，保持首个实例
    ctx.logger?.('dsh-android-bridge')?.debug?.('androidPrivilege already provided')
  }
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
        const d = ev.data as { outcome?: unknown }
        appendLive(JSON.stringify({ t, s, k: 'turn_end', ok: d?.outcome === 'success' }) + '\n')
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
      // 通知标记（既有）：仅 assistant/message 完成轮次
      if (type === 'assistant/message') {
        const content = (ev.data as { message?: { content?: Array<{ text?: string }> } })?.message?.content
        const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('').trim() : ''
        const snippet = text.slice(0, 80) || '任务完成'
        const sess = session as { id?: unknown; header?: { title?: string } } | undefined
        appendTaskMarker(sess?.id, sess?.header?.title, snippet)
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
  for (const t of tools(svc, shellFace)) ctx.tools.register(t)
  // 状态端点（浏览端面/设置页查询与展示）。**只读**：无任何写面——授权变更经
  // window.androidBridge.setAdbAllow/setAdbPair/revokeAdbPair 由壳侧原生 AdbState 执行
  // （Shizuku 对照：被提权方不得自改授权；引擎侧不设 POST 写端点）。
  const wsvc = (ctx as unknown as { webServer?: { register(r: unknown): void } }).webServer
  if (wsvc) {
    wsvc.register({
      kind: 'exact',
      path: '/api/android/privilege/status',
      handler: async (_req: WsReq, res: WsRes) => {
        sendJson(res, 200, svc.status())
      },
    })
  }
}
