/**
 * 内嵌 ADB 输入通道（ADBKeyboard 协议）的广播面：命令构造 + 结果码解析。
 *
 * 为什么单独成模块（#413）：这条通道此前的判据只有「`am broadcast` 没报错」，
 * 而 Android 对**没有任何接收者**的广播同样打印 `Broadcast completed: result=0`——
 * 「发送完成」被当成了「文本已提交」。抽成纯函数后，两条真判据可以在无设备环境用
 * 单测守住：
 *   ① 广播必须**点名组件**（`-n …/.AdbKeyboardReceiver`）：targetSdk 26+ 的 manifest
 *      接收器收不到隐式广播（设备实测 `Enqueued broadcast … : 0`，一个接收者都没有）；
 *   ② 必须能解析结果码，把「已提交 / 输入法未就绪 / 来源被拒 / 无输入连接」分开
 *      （壳侧 AdbKeyboardReceiver.setResultCode 写回，`am broadcast` 打印在 stdout）。
 *
 * 结果码与壳侧 `AdbKeyboardService.RESULT_*` 一一对应；壳侧旧版本不写结果码
 * （仍是 0），此时 [parseBroadcastResult] 返回 0，调用方退回「发送成功 + 回读断言」口径。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 内嵌 IME 组件名（`ime enable` / `ime set` 用）。 */
export const IME_ID = 'com.dsharnessmobile.shell/.AdbKeyboardService'

/** 广播接收器组件名（manifest 声明，只接受点名组件的广播）。 */
export const KB_RECEIVER = 'com.dsharnessmobile.shell/.AdbKeyboardReceiver'

export const KB_ACTION_INPUT = 'ADB_INPUT_TEXT'
export const KB_ACTION_CLEAR = 'ADB_CLEAR_TEXT'

/** 壳侧 AdbKeyboardReceiver 写回的广播结果码。 */
export const KB_RESULT = {
  committed: 1,
  imeNotReady: 2,
  rejected: 3,
  badRequest: 4,
  noConnection: 5,
} as const

/** 单引号安全转义（与既有 `--es msg` 写法同口径）。 */
export function shellQuote(raw: string): string {
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

/**
 * 读取键盘广播 nonce（应用私有文件，引擎与壳同 uid 可读）。
 *
 * #679 之后壳侧**没有任何 uid 白名单**（shell 与 root 的隐式信任都已撤销——Shizuku 两种模式
 * 都会把对应身份借给已授权第三方应用），所以 nonce 是**唯一**凭据，取不到就等于发不出去。
 * 本函数保留只是为了让「命令构造」这一层仍可被单测驱动；真实调用方应改用
 * [adbKeyboardAuthState] 拿到结构化原因，而不是把空串当成「不带 auth 也能发」。
 */
export function adbKeyboardAuth(filesDir: string | undefined): string {
  if (!filesDir) return ''
  try {
    return readFileSync(join(filesDir, 'adb-keyboard-nonce'), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * nonce 可用性（#679 硬切后这是**唯一**凭据，所以取不到必须能说清是哪一种取不到）。
 *
 * 为什么另给一个结构化版本：`adbKeyboardAuth` 把三种失败压成同一个空串，调用方无法区分原因，
 * 也就给不出可自助的报错。实测三种情形（见 PR）：变量未设 / 文件不存在 / 文件存在但只有空白
 * 全部返回空串；只有文件存在且有值才拿到 token。
 *
 * 注意：nonce **没有过期概念**——壳侧 `ensureNonce` 一旦写入就永久复用（无时间戳、无 TTL、
 * 无轮换），所以不存在「文件在但过期」这一态。
 */
export type KeyboardAuthState =
  | { ok: true; auth: string }
  | { ok: false; reason: string }

export function adbKeyboardAuthState(filesDir: string | undefined): KeyboardAuthState {
  if (!filesDir) return { ok: false, reason: 'DSH_FILES_DIR 未设置' }
  let raw: string
  try {
    raw = readFileSync(join(filesDir, 'adb-keyboard-nonce'), 'utf8').trim()
  } catch {
    return { ok: false, reason: 'nonce 文件不存在或不可读' }
  }
  if (!raw) return { ok: false, reason: 'nonce 文件为空' }
  return { ok: true, auth: raw }
}

/**
 * 构造一次键盘广播命令。
 *
 * `-n` 是 #413 的关键：不点名组件时，targetSdk 34 应用的 manifest 接收器**收不到**
 * 隐式广播，命令照样返回 result=0，现场表现就是「链路全绿、文本不动」。
 *
 * #679：`auth` 为空时**直接抛错**，不再构造一条注定被壳侧拒收（result=3）的命令。
 * 理由：壳侧已撤销 uid 白名单，只认 nonce；空 auth 的命令 100% 会被拒，发出去只会
 * 让调用方看到「广播完成但 result=3」，把「凭据缺失」伪装成「来源被拒」。
 * 调用方应先用 [adbKeyboardAuthState] 取原因并向用户给出可自助的报错。
 */
export function adbKeyboardBroadcast(action: string, msg: string | null | undefined, auth: string): string {
  if (!auth) {
    throw new Error('keyboard auth nonce is required (#679: no uid fallback in shell)')
  }
  const parts = [`am broadcast -n ${KB_RECEIVER} -a ${action}`, `--es auth ${shellQuote(auth)}`]
  if (typeof msg === 'string' && msg.length > 0) parts.push(`--es msg ${shellQuote(msg)}`)
  return parts.join(' ')
}

/** 从 `am broadcast` 的 stdout 里取结果码；取不到（旧壳 / 输出被截断）返回 null。 */
export function parseBroadcastResult(stdout: string): number | null {
  const m = /Broadcast completed:\s*result=(-?\d+)/.exec(stdout ?? '')
  return m ? Number.parseInt(m[1], 10) : null
}

/**
 * 这个结果码是否可视为「已提交」。
 *
 * 兼容口径：0 与 null 都必须放行——0.14.7 及更早的壳不写结果码，即使提交成功
 * 也只回报 `result=0`（`am` 的默认返回值）；把它们判红会让「新插件 + 旧壳」的热推
 * 场景全部误报失败。旧壳路径仍由无障碍回读断言兜底（a11y 关闭时无法判定，如实
 * 在返回文案里不宣称「结果码确认」）。
 */
export function isCommitAccepted(code: number | null): boolean {
  return code === null || code === 0 || code === KB_RESULT.committed
}

/**
 * issue #1067：这个结果码是否**有权威证据**说明「已提交」。
 *
 * `isCommitAccepted` 的兼容口径把 `null` 与 `0` 也放行（旧壳只回 `result=0`，判红会让
 * 「新插件 + 旧壳」的热推场景全部误报失败）——但「放行」不等于「证实」。这两个值都取不到
 * 提交证据：`null` = 那行根本没打印（输出被截断 / ROM 不打印），`0` = `am` 的默认返回值。
 *
 * 判据分开的理由：返回文案必须能如实说明。此前 verifyNote 在 `readBack === null` 且
 * `resultCode !== committed` 时是**空串**，于是一条无法证实的结果被渲染成
 * 「已输入 xxx（ADBKeyboard）」——正是本文件 `-n` 那次修复要消灭的「链路全绿、文本不动」形态
 * （a11y 关闭时没有回读兜底，这条是唯一判据）。
 */
/**
 * IME id 归一化（issue #1520）：`pkg/pkg.Class` → `pkg/.Class`。
 *
 * Android 的 `ComponentName.flattenToShortString()` 两种形态等价，而 `ime list -s` 与
 * `settings get secure default_input_method` 在不同 ROM 上会给出不同形态。任何**等值比较**
 * （尤其是「这是不是本通道自己」）都必须先归一化，否则 ROM 打全组件名时 DSH 自己会被当成
 * 可还原目标——回执写「已还原」，实际把用户留在 DSH 键盘上。
 *
 * 只用于**比较**：拼进 `ime set` 的仍是 ROM 原样给出的那串（各 ROM 的 `InputMethodInfo.getId()`
 * 形态不完全一致，改写它反而可能撞「Unknown id」）。
 */
export function normalizeImeId(raw: string): string {
  const v = String(raw ?? '').trim().replace(/^"|"$/g, '')
  const m = /^([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)$/.exec(v)
  if (!m) return v
  const pkg = m[1]
  const cls = m[2]
  return cls.startsWith(pkg + '.') ? pkg + '/.' + cls.slice(pkg.length + 1) : v
}

/**
 * 可还原的 IME id 形态（issue #1371）：必须是 `pkg/.Component`。
 *
 * `settings get secure default_input_method` 在未显式赋值时打印字面 `null`；把它拼进
 * `ime set null` 必然失败，而失败又被吞掉 ⇒ 用户输入法永久停在 DSH 键盘。
 */
export function restorableImeId(raw: string): boolean {
  const v = normalizeImeId(raw)
  if (v === '' || v.toLowerCase() === 'null') return false
  return /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(v)
}

/** 还原目标的来源：读回值 / 已启用列表兜底 / 都没有。 */
export type ImeRestoreSource = 'readback' | 'fallback' | 'none'

/** 还原目标。`id` 为空串表示「没有可还原目标」（仍会切换，但无法还原）。 */
export interface ImeRestoreTarget {
  id: string
  source: ImeRestoreSource
}

/**
 * 已启用列表的候选排序（issue #1517）。
 *
 * 缺陷形态：兜底取 `ime list -s` 的**第一行**——那是 ROM 的枚举顺序，与用户实际在用谁无关，
 * 于是「还原」把用户切到一个他根本不用的输入法。可用的偏好信号只有两条：
 *   ① 本插件上一次读到的用户输入法（`readback` 成功时记进 [userImeHistory]）——最强信号；
 *   ② 都没有时退回 ROM 顺序（至少确定、且回执里写明了还原到谁）。
 * 本通道自己（含 `pkg/pkg.Class` 全形态，issue #1520）、不可还原形态、重复项全部剔除。
 *
 * 返回值是**ROM 原样字符串**（不归一化）：拼进 `ime set` 的串要与设备自己的形态一致。
 *
 * @param imeList `ime list -s` 的原样输出（每行一个 id）。
 * @param selfId 本通道自己的 IME id（按归一化比较排除）。
 * @param preferred 偏好候选（最近使用优先）；命中者排到最前。
 */
export function rankImeRestoreCandidates(imeList: string, selfId: string, preferred: readonly string[] = []): string[] {
  const self = normalizeImeId(selfId)
  const lines = String(imeList ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
  const seen = new Set<string>()
  const candidates: Array<{ id: string; key: string }> = []
  for (const line of lines) {
    if (!restorableImeId(line)) continue
    const key = normalizeImeId(line)
    if (key === self || seen.has(key)) continue
    seen.add(key)
    candidates.push({ id: line, key })
  }
  const ranked: string[] = []
  for (const want of preferred) {
    const key = normalizeImeId(want)
    const hit = candidates.find((candidate) => candidate.key === key && !ranked.includes(candidate.id))
    if (hit !== undefined) ranked.push(hit.id)
  }
  for (const candidate of candidates) if (!ranked.includes(candidate.id)) ranked.push(candidate.id)
  return ranked
}

/**
 * 「用户常用输入法」记忆（issue #1517，进程内最近若干条，最近使用优先）。
 *
 * 为什么要有记忆：读回值场景下我们**本来就知道**用户在用谁，下一次 `settings get` 变成
 * `null` 时不该把这个知识丢掉、退化成「列表第一行」。列表本身随用户开关输入法变化，
 * 记忆里的条目若已不在 `ime list -s` 中自然不会命中，不需要过期机制。
 */
export interface ImeHistory {
  /** 记住一个用户输入法（归一化后去重、前插、截断）。 */
  remember(id: string): void
  /** 最近使用优先的 id 列表（副本）。 */
  list(): readonly string[]
}

export function createImeHistory(limit = 3): ImeHistory {
  const ids: string[] = []
  return {
    remember(id: string) {
      const v = normalizeImeId(id)
      if (v === '' || v.toLowerCase() === 'null' || !restorableImeId(v)) return
      const at = ids.indexOf(v)
      if (at >= 0) ids.splice(at, 1)
      ids.unshift(v)
      if (ids.length > limit) ids.length = limit
    },
    list: () => ids.slice(),
  }
}

/** 进程级单例（与 imeBorrowLock 同口径：同一进程内所有借道共享一份偏好）。 */
export const userImeHistory: ImeHistory = createImeHistory()

/**
 * 解析还原目标（issue #1371 第三条路，2026-11-04 维护者裁定）。
 *
 * 为什么不能「不可还原就不切换」：不切换 ⇒ 本通道键盘没被激活 ⇒ 广播拿 `imeNotReady`，
 * 文本注入整条失效；而那批设备（读回值 `null`/非组件形态）正是本 issue 的现场。
 * 也不能「照样切换但不管还原」：那正是原来的伤害（用户输入法被劫持）。
 *
 * 所以：读回值可用就用它；否则从 `ime list -s` 里挑一个**非本通道**的已启用输入法
 * （issue #1517：按 [rankImeRestoreCandidates] 排序，偏好命中优先，不取 ROM 顺序第一行）；
 * 两者都没有才承认「无法还原」（仍切换，回执明写）。
 *
 * @param rawPrev `settings get secure default_input_method` 的原样输出。
 * @param imeList `ime list -s` 的原样输出（每行一个 id）；空串表示没有可用行。
 * @param selfId 本通道自己的 IME id（永不作为还原目标；按归一化比较，issue #1520）。
 * @param preferred 偏好候选（通常是 `userImeHistory.list()`）。
 */
export function resolveImeRestoreTarget(
  rawPrev: string,
  imeList: string,
  selfId: string,
  preferred: readonly string[] = [],
): ImeRestoreTarget {
  if (restorableImeId(rawPrev)) {
    const v = String(rawPrev).trim().replace(/^"|"$/g, '')
    // issue #1520：等值比较必须归一化——ROM 打全组件名时短形态比较会把本通道自己当还原目标。
    if (normalizeImeId(v) !== normalizeImeId(selfId)) return { id: v, source: 'readback' }
  }
  const ranked = rankImeRestoreCandidates(imeList, selfId, preferred)
  if (ranked.length > 0) return { id: ranked[0], source: 'fallback' }
  return { id: '', source: 'none' }
}

export function hasAuthoritativeCommit(code: number | null): boolean {
  return code === KB_RESULT.committed
}
