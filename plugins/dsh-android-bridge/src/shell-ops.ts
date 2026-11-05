/**
 * 特权 shell 通道（0.14.0 §6：替换退役的内置 adb 的引擎侧 op 面）。
 *
 * 背景：0.14.0 前引擎侧 `execAdbShell` / `execAdbLine` 在快照内经 Termux 再 spawn 一次 `adb`
 * 客户端（android-tools），依赖无线调试配对；0.14.0 起该面退役，改由壳侧 Shizuku UserService
 * （uid 2000）执行，经控制队列投递（`sh*` 四 op）。
 *
 * 三条纪律：
 * - 两条通道独立可用：`sh*` 是 neverA11y（与 browser/vd 同族），由壳侧 ControlCarrier 承载，
 *   不依赖无障碍服务；
 * - 不做「adb 字符串透传」：`translateAdbLine` 把旧行拆成 exec/pull/push 步骤，工具层不再出现
 *   `adb` 执行面（§8.3 迁移清单）；
 * - 失败必须是结构化的：拒绝面由壳侧给 code + guidance，本文件只负责翻译与归一。
 */

/** 壳侧特权 shell op（与 scripts/control-ops-pending.json 的 shell 族逐字对应）。 */
export const SHELL_OPS = ['shExec', 'shPull', 'shPush', 'shRemove'] as const
export type ShellOp = (typeof SHELL_OPS)[number]

/** 控制队列回执（与 browser/vdisplay 两族同形）。 */
export interface ShellControlReply {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

/** 翻译后的单步：只表达「执行 / 取回 / 推送」三种语义，不含 adb 客户端语义。 */
export type ShellStep =
  | { kind: 'exec'; command: string }
  | { kind: 'pull'; remote: string; local: string }
  | { kind: 'push'; local: string; remote: string }

export type ShellLineTranslation =
  | { ok: true; steps: ShellStep[] }
  | { ok: false; error: string }

/**
 * 引号与转义感知的行拆分（顶层分隔符 `;` 与 `&&`；引号内/转义后的分隔符不拆）。
 *
 * 词法按 POSIX shell：
 * - 引号外 `\x` 是转义对 —— `\;` 不是分隔符、`\"` 不开启双引号、`\\` 是字面反斜杠；
 * - 双引号内同样成对消费 —— `\"` 是字面双引号、`\\` 是字面反斜杠，都不结束引号段；
 * - 单引号内一切字符都是字面量（POSIX：反斜杠在单引号内不转义），只有下一个 `'` 结束；
 * - 由此奇偶性自然成立：偶数个反斜杠后的 `"` 是真的引号，奇数个反斜杠后的是字面字符。
 *
 * 取舍（issue #1066）：**看不懂就整行一段，绝不猜**。未闭合引号、行尾孤立反斜杠（续行）、
 * `$'…'` / `$"…"` 这几种形态的边界语义无法静态定死，而猜错的方向恰好是「多切」——
 * 多切等于伪造一条用户没写的设备命令（issue #1066 里 `rm -rf /sdcard/x` 就是这么冒出来的独立设备命令）。
 * 所以一律把整行当成**一段**返回，交给下游 fail-closed 判据（screen-scope.ts 的 `deny-unparsed` 一族）去拒：
 * 宁可少切，不可多切。切出的段是**原文子串**（这里不消引号、不消反斜杠），由下游按 shell 词法自己解释。
 */
function splitSegments(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") {
      // 单引号内：只有下一个 `'` 结束引号，反斜杠是普通字符（POSIX）。
      cur += ch
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      // 双引号内：`\x` 成对消费，`\"` 不结束引号段。
      if (ch === '\\') {
        const next = line[i + 1]
        if (next === undefined) return wholeLineAsSegment(line)
        cur += ch + next
        i += 1
        continue
      }
      cur += ch
      if (ch === '"') quote = null
      continue
    }
    if (ch === '\\') {
      const next = line[i + 1]
      // 行尾孤立反斜杠 = 续行：换行被吃掉后整行的命令边界不可知。
      if (next === undefined) return wholeLineAsSegment(line)
      cur += ch + next
      i += 1
      continue
    }
    if (ch === '$' && (line[i + 1] === '"' || line[i + 1] === "'")) {
      // ANSI-C 引号 $'…' / 本地化引号 $"…"：转义与展开语义随 shell 实现而变，不猜。
      return wholeLineAsSegment(line)
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';') {
      out.push(cur)
      cur = ''
      continue
    }
    if (ch === '&' && line[i + 1] === '&') {
      out.push(cur)
      cur = ''
      i += 1
      continue
    }
    cur += ch
  }
  // 未闭合引号：引号边界是否跨行才有解，单行内无法判定。
  if (quote !== null) return wholeLineAsSegment(line)
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 词法不可判时的 fail-closed 兜底：整行作为**一段**（宁可少切，不可多切）。 */
function wholeLineAsSegment(line: string): string[] {
  const trimmed = line.trim()
  return trimmed.length > 0 ? [trimmed] : []
}

/** 去掉一层成对引号（`"..."` / `'...'`）。 */
function unquote(text: string): string {
  const t = text.trim()
  if (t.length >= 2) {
    const first = t[0]
    if ((first === '"' || first === "'") && t[t.length - 1] === first) return t.slice(1, -1)
  }
  return t
}

/** 引号感知的参数拆分（pull/push 的两个位置参数）。 */
function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const ch of text.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** 剥掉 adb 全局开关（`-s <serial>` / `-d` / `-e` / `-H <host>` / `-P <port>`）。 */
function stripAdbFlags(rest: string): string {
  let cur = rest.trim()
  for (;;) {
    const match = /^(?:-s\s+\S+|-[de]|-H\s+\S+|-P\s+\S+)\s+/.exec(cur)
    if (match === null) return cur
    cur = cur.slice(match[0].length)
  }
}

/** 把一行旧 adb 用法翻译成特权 shell 步骤；无法翻译一律结构化拒绝（绝不退化成透传）。 */
export function translateAdbLine(line: string): ShellLineTranslation {
  const steps: ShellStep[] = []
  for (const segment of splitSegments(line)) {
    if (!/(^|\s)adb\s/.test(segment) && !segment.startsWith('adb ')) {
      steps.push({ kind: 'exec', command: segment })
      continue
    }
    if (!segment.startsWith('adb ')) {
      steps.push({ kind: 'exec', command: segment })
      continue
    }
    const rest = stripAdbFlags(segment.slice(4))
    if (rest === 'shell' || rest.startsWith('shell ')) {
      const command = unquote(rest.slice('shell'.length))
      if (command.length === 0) return { ok: false, error: 'adb shell 缺少命令' }
      steps.push({ kind: 'exec', command })
      continue
    }
    if (rest.startsWith('pull ')) {
      const args = splitArgs(rest.slice('pull'.length))
      if (args.length < 2) return { ok: false, error: 'adb pull 需要 <远端> <本地> 两个参数' }
      steps.push({ kind: 'pull', remote: args[0], local: args[1] })
      continue
    }
    if (rest.startsWith('push ')) {
      const args = splitArgs(rest.slice('push'.length))
      if (args.length < 2) return { ok: false, error: 'adb push 需要 <本地> <远端> 两个参数' }
      steps.push({ kind: 'push', local: args[0], remote: args[1] })
      continue
    }
    if (rest.startsWith('devices')) {
      // 旧用法只用于展示；换通道后由 shell 自称身份（型号 + 序列号）保持同一信息面。
      steps.push({ kind: 'exec', command: "printf 'List of devices attached\\n%s\\tdevice\\n' \"$(getprop ro.serialno)\"" })
      continue
    }
    if (/^(?:connect|disconnect|kill-server|start-server)\b/.test(rest)) {
      // 常驻 server / 配对语义随 adb 退役：幂等 no-op（不再有需要拉起的服务）。
      steps.push({ kind: 'exec', command: 'true' })
      continue
    }
    return { ok: false, error: `不支持的 adb 子命令（0.14.0 起特权 shell 通道不再提供 adb 客户端语义）：adb ${rest.split(/\s+/)[0] ?? ''}` }
  }
  if (steps.length === 0) return { ok: false, error: '空行（无可执行步骤）' }
  return { ok: true, steps }
}
