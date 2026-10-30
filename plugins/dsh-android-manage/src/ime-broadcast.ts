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
 * 文件缺失（旧壳 / 桌面宿主）返回空串 = 不带 auth 参数。
 * #679 之后壳侧**不再有 uid 白名单兜底**（uid 2000 的隐式信任已撤销，Shizuku 应用可冒用）：
 * 新壳对不带 auth 的广播一律拒绝——引擎路径不受影响（nonce 文件由壳 onCreate 幂等创建，
 * 引擎与本应用同 uid 读得到）；桌面宿主经 adb 驱动键盘输入的旧用法需要目标端先启动过一次应用，
 * 且 nonce 无法经 adb 读取（应用私有域），此类直发在新壳上会被拒（result=3）。
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
 * 构造一次键盘广播命令。
 *
 * `-n` 是 #413 的关键：不点名组件时，targetSdk 34 应用的 manifest 接收器**收不到**
 * 隐式广播，命令照样返回 result=0，现场表现就是「链路全绿、文本不动」。
 */
export function adbKeyboardBroadcast(action: string, msg: string | null | undefined, auth: string): string {
  const parts = [`am broadcast -n ${KB_RECEIVER} -a ${action}`]
  if (auth) parts.push(`--es auth ${shellQuote(auth)}`)
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
