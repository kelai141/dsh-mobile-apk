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
export function hasAuthoritativeCommit(code: number | null): boolean {
  return code === KB_RESULT.committed
}
