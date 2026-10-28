import { readFileSync } from 'node:fs'

/** User-owned, stable screen aliases exposed to model-facing Android tools. */
export type ScreenId = string
export type UserScreenScope = 'virtual-only' | 'real-only' | 'all'

export const DEFAULT_SCREEN_SCOPE: UserScreenScope = 'virtual-only'
export const REAL_SCREEN_ID = 'real'
export const VIRTUAL_SCREEN_ID = 'virtual-1'
export const REAL_DISPLAY_ID = 0

/** 规格 §2.1：壳侧分配 1..N 的 `virtual-N`；本版上限 1 屏。 */
const VIRTUAL_SCREEN_PATTERN = /^virtual-([1-9][0-9]{0,2})$/

/** `virtual-N` 编号；非虚拟别名返回 null。 */
export function virtualScreenOrdinal(screenId: string | undefined): number | null {
  const match = VIRTUAL_SCREEN_PATTERN.exec(screenId ?? '')
  return match === null ? null : Number(match[1])
}

export function isVirtualScreenId(screenId: string | undefined): boolean {
  return virtualScreenOrdinal(screenId) !== null
}

const SHELL_SCREEN_SCOPE_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh_screen_scope.xml'

/** Result returned before a tool reads pixels, a UI tree, or dispatches an input action. */
export type ScreenAccessDecision =
  | { ok: true; screenId: ScreenId; displayId: number; scope: UserScreenScope }
  | { ok: false; reason: 'screen-not-found' | 'screen-out-of-scope' | 'screen-not-ready'; guidance: string; scope: UserScreenScope; screenId: string }

/** review C11：调用方可提供原生注册表解析出的虚拟屏**动态** displayId（alias→id 回填）。 */
export interface ScreenAccessOptions {
  virtualDisplayId?: number | null
  /**
   * 块G F2：壳侧虚拟屏注册表当前登记的 displayId 集合（raw shell 命令的显式 `-d <id>` 核对用）。
   * 缺席/不可达 → 视为空集（fail-closed：不凭命令里的数字自证目标屏属虚拟屏）。
   */
  virtualDisplayIds?: readonly number[] | ReadonlySet<number>
  /**
   * 块G F6：**SurfaceFlinger token** ↔ 产品别名的配对（`screencap -d` 实际吃的 id 空间）。
   *
   * 为什么需要它：`screencap -d <DisplayManager displayId>` 对虚拟屏**必然失败**
   * （设备实测 Status -2），只有传 SF token 才出图；而 SF token 既不在 `virtualDisplayIds` 里、
   * 又超出 2^53/2^63 无法数值化。故必须并存这条字符串映射。
   * 同时必须给 [virtualAliases]——**只有配对别名确属已注册虚拟屏的 token 才可放行**，
   * 真实屏的 SF token 一律拒绝。
   */
  sfVirtualDisplays?: readonly { alias: string; token: string }[]
  /** 当前已注册的虚拟屏**别名**集合（与 sfVirtualDisplays 联合使用，缺一即 fail-closed）。 */
  virtualAliases?: readonly string[] | ReadonlySet<string>
}

/**
 * a11y 承载的、**按设计作用于设备屏内容**的 op——执行点范围复查的分类真源。
 *
 * 0.14.1 块G（F4）口径更正：本常量是**按 op 名**的分类，回答「这个 op 通常是否读写某块设备屏
 * 的内容」，**不是**「这一次调用作用于真实屏」。后者必须由 `args.screenId` 经注册表解析出的
 * **目标屏**判定（见 index.ts 的 controlExec 执行点与 decideScreenAccess）。把前者当成后者，
 * 在 virtual-only + 已建虚拟屏时必然误判，并产出「范围允许 virtual-1 却说不许访问真实屏」的
 * 自相矛盾报文（用户实报；该报文逐字来自 index.ts 执行点的硬编码文案）。
 *
 * 两类刻意不在列：
 *   - `state`：只回代次/失效标记（元数据），不含屏幕内容（U-3 约束的是内容面）；
 *   - `webSnapshot` / `webAction`：目标是**壳自有 WebView**（DSH 自己的 Web UI），不带也不认
 *     `screenId`，与设备屏无关。按 op 名归为「设备屏内容 op」会让 `android_web_dump` 在
 *     virtual-only 下被整体误拒（块G F4b 同源论断：过度拦截与「范围门禁自相矛盾」是同一类缺陷）。
 * browser\* 操作隔离 BrowserHost（第二 WebView），vd\* 管理面不在此列；其中写屏内容的
 * `vdInput` 由 `controlExec` 单独按虚拟目标校验，并由壳侧 `VdisplayController.input` 再次复核。
 */
export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [
  'snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText',
]

/** 该 op 是否读写**设备屏**内容（review C11：controlExec 执行点据此复查范围）。 */
export function controlOpNeedsRealScreen(op: string): boolean {
  return REAL_SCREEN_CONTROL_OPS.includes(op)
}

// ── 目标屏参数：全链路唯一的取值口 ────────────────────────────────────────────────
//
// 三种拼写是设备实测可行形态（`screencap -d` / `input --display` / `-d` 前置）；取值**保留
// 原始十进制串、绝不数值化**：`screencap -d` 吃的是 SurfaceFlinger display token，
// 设备实测虚拟屏形如 `11529215046816944610` —— 它 > 2^53（JS Number 安全整数上界）且
// > 2^63-1（Kotlin Long 上界）。任何数值化都会把它变成 `...944000`（末位失真），
// 于是「设备上能出图的 token」与「命令里写的 token」不再相等，判定与取图必然错位。
// （主屏 token `4619827820427265280` 同样 > 2^53。）
//
// 空白类一律用**显式 ASCII 集**（`[ \t]` / `\s` 的跨语言陷阱见 N-5：JS 的 `\s` 含 Unicode
// 空白、Java 的 `\s` 只含 ASCII ⇒ 两侧正则「逐字相同」却不等价）。Kotlin 侧同名实现必须用
// 同一集合；跨语言 fixture 锁死等价性。

/** 一条 `-d/--display/--display-id` 目标屏参数（值保留原样字符串）。 */
export interface DisplayOption {
  /** 命中的拼写（`-d` / `--display` / `--display-id`）。 */
  flag: string
  /** 原始十进制串（未数值化）。 */
  value: string
  /** 该选项在文本里的起始下标（用于「只认命令词之前」的家族，见 `input`）。 */
  index: number
}

/**
 * 扫描命令里出现的全部目标屏参数（含三种拼写，值原样字符串）。
 *
 * 短选项 `-d` 与长选项的**取值语法不同**，不能共用一个正则：
 *   - `-d` 是 getopt 短选项 ⇒ `-d7`（粘连）与 `-d 7`（空格）合法，**`-d=7` 不合法**。
 *     AOSP 用 `atoi(optarg)`，`atoi("=7") == 0` ⇒ 实际读/操作的是 display **0**（真实屏）。
 *     旧实现用 `[ \t=]+` 让 `-d=7` 吃到了 `7`，于是拿它当"已注册虚拟屏 7"的凭据放行
 *     （2026-10-28 自查，安全侧漏拦）；同时 `-d7` 因为缺分隔符反而认不出来（误拦）。
 *   - 长选项 `--display` / `--display-id` 才接受 `=`。
 */
/**
 * 「形似 display 选项但取值不是纯数字」的形态（`-d=7`、`-dx`）。
 *
 * 为什么要单独判：`-d=7` 的真实值是 `=7`（`atoi` 后为 0），所以它**不能**被当成"已认证 7"；
 * 但也**不能**被当成"没有 display 选项"就放行 —— 它在不同工具下可能落到默认屏 0（真实屏）。
 * 两侧都必须 fail-closed：段里一旦出现这种形态，直接拒。
 */
const MALFORMED_DISPLAY_OPTION = /(?:^|[ \t])-d(?:[ \t]*=[ \t]*\S|(?![0-9\s])\S)/

export function displayOptionsIn(text: string): DisplayOption[] {
  const out: DisplayOption[] = []
  for (const m of text.matchAll(/(?:^|[ \t])-d[ \t]*(\d+)/g)) {
    out.push({ flag: '-d', value: m[1], index: m.index ?? 0 })
  }
  for (const m of text.matchAll(/(?:^|[ \t])(--display|--display-id)[ \t=]+(\d+)/g)) {
    out.push({ flag: m[1], value: m[2], index: m.index ?? 0 })
  }
  return out.sort((a, b) => a.index - b.index)
}

/**
 * ADB shell 命令里显式指定的目标 display id（`-d <id>` / `--display <id>` / `--display-id <id>`）。
 *
 * 用途（块G F2）：raw shell 面的范围复查不能只做**命令词**匹配——`screencap -d 47` 读的是
 * 虚拟屏 47，与无参 `screencap`（读真实屏 0）根本不是一件事；同罪拒绝会让「用户只给
 * virtual-only」也永远读不到自己的虚拟屏。提取目标 id 后交由调用方与壳侧注册表核对。
 * @returns 命令中出现的 display id；空数组 = 命令没有可核对的目标屏（调用方必须 fail-closed）。
 */
export function adbCommandDisplayIds(command: string): number[] {
  const ids: number[] = []
  for (const option of displayOptionsIn(command)) {
    const id = Number(option.value)
    if (Number.isInteger(id)) ids.push(id)
  }
  return ids
}

/**
 * 同上的目标屏参数，但保留原始十进制串、**不做数值化**（理由见本节顶部的 token 值域说明）。
 * @returns 命令中出现的目标屏数字串（原样）；空数组 = 无可核对目标屏。
 */
export function adbCommandDisplayTokens(command: string): string[] {
  return displayOptionsIn(command).map((option) => option.value)
}

// ── 命令段切分：引号感知（§8.3b 洗白绕过的修法） ────────────────────────────────
//
// 缺陷形态（0.14.1 新引入，P0）：判定只看「命令里出现的每个 `-d` 值是否都属于虚拟屏」，
// **不看「整条命令是否只作用于那块屏」**。于是
//   screencap -p -d <虚拟屏 token> /sdcard/a.png; screencap -p /sdcard/real.png
// 里第二段读真实屏，却因第一段的 `-d` 命中而被整体放行（一行参数洗白整行）。
//
// 修法：引号感知切段 + 每一段各自自证。四条不变量：
//   ① 分隔符（`;` `&&` `||` `|` `&` 换行）**只在引号外**切段（引号内的 `|` 是 `grep -E 'a|b'`
//      这类合法形态，误切会把合法命令判成多段）；
//   ② 嵌套执行体（反引号、`$(...)`、`sh -c '<内层>'`）**再切一层**——它们会被 shell 真正执行，
//      不切开就等于放过 `sh -c "screencap -d <token>; input tap 1 2"`；
//   ③ 抽 token / 匹配命令词之前先**剥掉引号内文本**（否则 `echo x -d <token>; …` 里的 token
//      会充当洗白凭据）；
//   ④ 引号不闭合（无法解析）一律判**拒**（fail-closed：绝不在看不懂的命令上放行）。

/** 引号感知切段结果。`unparsed` = 引号不闭合等无法解析形态（调用方必须 fail-closed）。 */
export interface CommandSegments {
  /** 顶层命令段 + 全部嵌套执行体（同一个判据逐个过）。 */
  segments: string[]
  unparsed: boolean
}

/** 嵌套执行体再切一层的深度上限（防御构造出来的深嵌套导致栈溢出）。 */
const MAX_NESTING = 4

/** 反引号段结束位置；`\`` 转义不算结束。返回 -1 = 未闭合。 */
function backtickEnd(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === '`') return i
    i += 1
  }
  return -1
}

/** `$(` 的配对 `)` 位置（内部引号与嵌套括号都计入）。返回 -1 = 未闭合。 */
function parenEnd(text: string, from: number): number {
  let depth = 1
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < text.length) {
        if (quote === '"' && text[i] === '\\') { i += 2; continue }
        if (text[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * `sh -c '<内层>'` 形式的嵌套执行体（含 `/system/bin/sh`、`busybox sh`、`su` 等包装）。
 *
 * 末段必须是「短选项**簇**且簇尾是 `c`」（`-[a-zA-Z]*c`），不能只认光杆 `-c`：
 * `sh -lc '…'` / `sh -ec '…'` / `sh -xc '…'` / `su -lc '…'` 的 `c` 都在一个组合簇里，
 * 光杆 `-c` 匹配不到 ⇒ 载荷不展开 ⇒ 该段无命令词 ⇒ 放行。小米 14 Pro（SDK 37，mksh）实测
 * 四种簇形态**都会真的执行**引号里的脚本（`bash` 在设备上不存在，但 Linux 侧同样成立）；
 * `-l -c` 分离写法旧实现本来就能认。
 *
 * 前置组还要能跳过**带独立参数的短选项**（`-o` / `+o` 各吃一个词）：
 * `sh -o errexit -c '…'` 里 `errexit` 既不是 `-` 开头也不在选项簇里，旧前置组会卡在它上面
 * ⇒ 整条不匹配 ⇒ 载荷不展开 ⇒ 放行。小米 14 Pro（mksh）实测 `sh -o errexit -c 'echo X'` 与
 * `sh +o errexit -c 'echo X'` **都会真的执行**。`[+-]o` 必须排在 `-[^\s]+` **前面**，否则
 * `-o` 会被整词分支先吃掉、剩下 `errexit` 无处可去。
 */
const SHELL_C_PAYLOAD = /(?:^|[ \t])(?:[^\s]*\/)?(?:sh|bash|mksh|ash|dash|zsh|busybox|toybox|su)[ \t]+(?:[+-]o[ \t]+\S+[ \t]+|-[^\s]+[ \t]+)*-[a-zA-Z]*c[ \t]+([\s\S]*)$/

/**
 * `eval <payload>`：载荷会被 shell **再解释一遍**（等价于把那段文本当命令粘回来执行）。
 *
 * 为什么必须单独列：`eval "screencap -p /sdcard/real.png"` 的引号内容会被 `stripQuotedText`
 * 抹掉，命令词面里看不到 `screencap` ⇒ 只靠 `sh -c` 那条正则时它**一路放行**（2026-10-28 自查实测）。
 * 与 `sh -c` 同型处理：拿**原文**载荷、解一层引号、递归扫。前面的分界符覆盖 `;` / `&&` / `||` / 管道。
 */
const EVAL_PAYLOAD = /(?:^|[ \t;&|(])eval[ \t]+([\s\S]*)$/

/**
 * `trap <payload> <signals…>`：第一个参数是**要执行的命令**，退出/收到信号时 shell 会照跑。
 * 与 `eval` / `sh -c` 并列进"载荷再解释"入口（2026-10-28 自查：`trap 'screencap …' EXIT` 实测可执行且被放行）。
 */
const TRAP_PAYLOAD = /(?:^|[ \t;&|(])trap[ \t]+([\s\S]*)$/

/**
 * 取 shell 文本的**第一个词**（quote-aware，去掉包裹它的引号）。
 *
 * 为什么载荷不能再用 `unwrapOneQuote(整个剩余)`：`sh -c 'screencap …' sh` 的剩余串是
 * `'screencap …' sh`，首尾不同一个引号 ⇒ 旧实现判定"不成对"、整段不展开 ⇒ 载荷里的真实屏命令
 * 一路放行（2026-10-28 自查，安全侧漏拦）。shell 只把 `-c` 的**第一个词**当脚本，尾随的是 $0/$1。
 * `trap` 同理（第一个参数是要执行的命令，后面是信号名）。
 */
function firstShellWord(text: string): { word: string; rest: string } {
  let i = 0
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  if (i >= text.length) return { word: '', rest: '' }
  const quote = text[i]
  if (quote === '\'' || quote === '"') {
    let j = i + 1
    while (j < text.length) {
      if (quote === '"' && text[j] === '\\') { j += 2; continue }
      if (text[j] === quote) return { word: text.slice(i + 1, j), rest: text.slice(j + 1) }
      j += 1
    }
    return { word: text.slice(i + 1), rest: '' } // 未闭合：按剩余全部当载荷（fail-closed 方向）
  }
  let j = i
  while (j < text.length && !/[ \t;&|]/.test(text[j])) j += 1
  return { word: text.slice(i, j), rest: text.slice(j) }
}

/**
 * 载荷里第一个**非选项终结符**词：`--` 只是选项终结符，真正的载荷在它后面。
 *
 * 缺陷形态（2026-10-28 自查实测，安全侧漏拦）：`trap -- 'screencap -p /sdcard/real.png' EXIT`、
 * `sh -c -- '…'`、`eval -- '…'` 的 `payload[1]` 以 `--` 开头，旧实现直接把它当载荷 ⇒ 真正的内层
 * 命令被丢弃 ⇒ 该段既无屏幕命令词、也无目标屏参数 ⇒ `continue` 放行（读真实屏）。
 * 小米 14 Pro（`/system/bin/sh` = mksh，SDK 37）实测三条**都会真的执行 `--` 后面的命令**；
 * 本机 dash / bash / busybox sh 同样执行。`--` 被引号包裹时也是终结符
 * （`trap "--" 'cmd' EXIT` 真机实测执行），故判据用**解引号后**的词是否恰好等于 `--`。
 */
function firstPayloadWord(text: string): string {
  let rest = text
  for (let guard = 0; guard < 8; guard += 1) {
    const { word, rest: remainder } = firstShellWord(rest)
    if (word !== '--') return word
    rest = remainder
  }
  return ''
}

const INTERPRETER_NAMES = new Set(['sh', 'bash', 'mksh', 'ash', 'dash', 'zsh'])
const INTERPRETER_WRAPPERS = new Set([
  'env', 'timeout', 'nohup', 'xargs', 'busybox', 'toybox', 'su', 'command', 'exec',
  // 调度 / 资源类（真机实测可喂 sh）
  'nice', 'ionice', 'taskset', 'setsid', 'chrt', 'numactl', 'unshare', 'runcon',
  // 缓冲 / 计时 / 锁类
  'stdbuf', 'time', 'flock', 'watch',
])

/**
 * 该段的命令词是不是「载荷对判定器不可见」的解释器调用（#509 的放宽版）。
 *
 * 只有 `sh -c '<可见载荷>'` 能被展开后判定；其余形态的载荷都来自**运行时**，静态看不到：
 *   - `sh -s` / `sh -e` / 无参 `sh`（读 stdin）；
 *   - `sh /tmp/x.sh`、`. /tmp/x.sh`、`source x`（读脚本文件）；
 *   - 经 `env` / `timeout` / `xargs` / `busybox` 包装的同族形态。
 * 这些一律 deny-unparsed（fail-closed）。旧实现只有「整段恰好等于解释器名」这一条最窄规则，
 * 且**只在壳侧**——引擎侧连 `| sh` 都放行（两层漂移，fixture 也没锁住）。
 */
export function interpreterPayloadUnparsed(segment: string): boolean {
  let text = segment.trim()
  for (let guard = 0; guard < 8; guard += 1) {
    const { word, rest } = firstShellWord(text)
    if (word.length === 0) return false
    const base = word.replace(/^.*\//, '')
    // 变量赋值前缀、包装器、包装器自己的选项/数字参数都不改变"命令词"。
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { text = rest.trim(); continue }
    if (INTERPRETER_WRAPPERS.has(base) || word.startsWith('-') || /^\d+$/.test(word)) {
      text = rest.trim()
      continue
    }
    if (base === '.' || base === 'source') return true
    if (INTERPRETER_NAMES.has(base)) return !/(?:^|[ \t])-[^\s]*c[^\s]*(?:[ \t]|$)/.test(rest)
    return false
  }
  return false
}

/**
 * 段**命令名位置**上是不是运行时值（`$CMD`、`$(…)`、`` `…` ``）。
 *
 * 小米 14 Pro（SDK 37）实测都会真的执行变量/文件里的内容：
 *   `CMD='echo X'; sh -c "$CMD"` → `X`
 *   `sh -c "$(cat /data/local/tmp/s.sh)"` → 文件里的命令
 *   `sh -c "\`cat /data/local/tmp/s.sh\`"` → 同上
 *   `trap "$(cat …)" EXIT` / `eval "$(cat …)"` → 同上
 * 与 `sh /x.sh`（脚本文件）同一性质：执行什么静态看不到 ⇒ fail-closed。
 *
 * 只看**段首词**：参数位置的替换（`echo "$(date)"`、`x=$(cat f); echo $x`）不改变命令身份，不得误拦。
 */
/**
 * 「当前段已经走到**载荷位置**」的尾巴判据（`sh -c ` / `eval ` / `trap ` 之后）。
 *
 * 用来认**不带引号**的运行时载荷：`` sh -c `cat /sdcard/x.sh` `` 的反引号在顶层切段时就被展开，
 * 段里不再留反引号字符，段级判据看不见它 —— 只能在切段当场看「替换前那段 buf 是否停在载荷位置」。
 * 带引号的同型形态（`sh -c "$CMD"`）由 `payloadIsRuntimeValue` 覆盖。
 * `sh -c "a b" $(date)` 这种「载荷已给、替换在下一个参数」的形态**不命中**（脚本静态可见）。
 */
const PAYLOAD_SLOT_TAIL = /(?:^|[ \t])(?:-[^\s]*c|eval|trap)[ \t]+$/

function isRuntimeCommandName(segment: string): boolean {
  const head = firstShellWord(segment.trim()).word
  // `$'…'` / `$"…"` 是 **ANSI-C 引号**（静态字面量），不是变量引用 —— 不得误拦（S-7c）。
  if (head.startsWith('$\'') || head.startsWith('$"')) return false
  return head.startsWith('$') || head.startsWith('`')
}

/**
 * `awk` 的 `system(…)` 能执行任意命令，而程序文本通常整段在引号里 —— `stripQuotedText` 之后
 * 命令词面只剩 `awk`，载荷里的屏幕命令完全不可见。
 *
 * 真机实测（2026-10-29，小米 14 Pro / SDK 37 / toybox awk）：
 *   `awk 'BEGIN{system("screencap -p /sdcard/awk.png")}'`    RC=0，出图 2872362 B
 * 双引号形态 `awk "BEGIN{system(\"screencap …\")}"` 也 RC=0（2872137 B），它修前是被引号
 * 状态机在嵌套处判成 unparsed 才偶然拦住的。修前单引号形态判 allow。
 * 对照必须继续放行：`awk '{print $1}' /sdcard/a.txt`（无 system 调用）。
 */
const AWK_EXEC_PAYLOAD =
  /^[ \t]*(?:[^\s]*\/)?(?:busybox[ \t]+|toybox[ \t]+)?awk\b[^;|&]*\bsystem[ \t]*\(/i
/** shell glob 元字符是否出现在**引号外**（引号内的 `*`/`?` 不展开，不参与判定）。 */
function hasUnquotedGlob(text: string): boolean {
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === '') {
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '*' || ch === '?' || ch === '[') return true
    } else if (ch === quote) {
      quote = ''
    }
  }
  return false
}

/**
 * 经典贪心 glob 匹配（`*` / `?` / `[abc]` / `[!abc]` 单字符集）。
 * 与壳侧 `ShellOps.globMatch` 逐分支同构 —— 两侧算法一致比「各自实现、口头等价」容易核对，
 * 也避开「转成正则再 match」那一步自身的转义判定面（`$` / 反斜杠 / `[` 漏一处就是漏拦或误拦）。
 * 不支持范围写法（`[a-z]`）：判据只需回答「这个名字能不能拼出已知命令名」，单字符集足够。
 */
function globMatch(pattern: string, subject: string): boolean {
  let pi = 0
  let si = 0
  let starPi = -1
  let starSi = 0
  while (si < subject.length) {
    const pc = pi < pattern.length ? pattern[pi] : ''
    if (pi < pattern.length && (pc === '?' || pc === subject[si])) {
      pi += 1
      si += 1
    } else if (pi < pattern.length && pc === '[') {
      const close = pattern.indexOf(']', pi + 1)
      if (close < 0) return false
      let body = pattern.slice(pi + 1, close)
      const negate = body.startsWith('!')
      if (negate) body = body.slice(1)
      const hit = body.includes(subject[si])
      if (hit === negate) return false
      pi = close + 1
      si += 1
    } else if (pi < pattern.length && pc === '*') {
      starPi = pi
      starSi = si
      pi += 1
    } else if (starPi >= 0) {
      pi = starPi + 1
      starSi += 1
      si = starSi
    } else {
      return false
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi += 1
  return pi === pattern.length
}

/**
 * 命令词用 glob 拼出屏幕命令名（`/system/bin/scr?encap` / `[s]creencap` / `scree*cap`）：
 * shell 会先展开成 `screencap` 再执行，而词面与任何家族 pattern 都不匹配 ⇒ 一路放行。
 * 真机实测（2026-10-28，小米 14 Pro / SDK 37 / mksh），均 RC=0 且出图与对照同字节：
 *   `/system/bin/scr?encap` 2861741 B、`/system/bin/[s]creencap` 2861741 B、
 *   `/system/bin/scree*cap` 2861649 B、对照 `screencap` 2861649 B。
 * 只认**引号外**的 glob：`"/system/bin/scr?encap"` 不展开（真机 RC=127），属无害字面量。
 * 参数位的 glob 不改变命令身份 —— `ls /sdcard/*.png`、`rm /sdcard/x*` 必须继续放行。
 */
const SCREEN_EXECUTABLE_NAMES = [
  'screencap', 'screenrecord', 'input', 'wm', 'uiautomator', 'dumpsys',
  'sendevent', 'getevent', 'monkey', 'am',
]
/** 这些可执行名本身无害，但**子命令位**才决定是否碰真实屏（`cmd win?ow size 900x1600`）。 */
const SCREEN_SUBCOMMAND_HEADS = [
  'cmd', 'wm', 'input', 'am', 'dumpsys', 'uiautomator', 'monkey', 'sendevent', 'getevent',
]

function globExpandsToScreenCommand(segment: string): boolean {
  if (!hasUnquotedGlob(segment)) return false
  const head = firstShellWord(segment.trim()).word
  const base = head.slice(head.lastIndexOf('/') + 1)
  if (/[*?\[]/.test(base)) {
    if (SCREEN_EXECUTABLE_NAMES.some((name) => globMatch(base, name))) return true
  }
  return SCREEN_SUBCOMMAND_HEADS.includes(base)
}

/** 去掉一层首尾成对的引号（`sh -c "…"` 的载荷取值）。不成对则原样返回。 */
function unwrapOneQuote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'") && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 引号感知地把一条命令切成**可判定段**：顶层段 + 反引号 / `$()` / `sh -c` 的嵌套执行体。
 *
 * 纯函数（无 IO、无全局态），与壳侧 `ShellOps.splitCommandSegments` 同一算法，由跨语言
 * fixture 锁死等价性。
 */
export function splitCommandSegments(command: string): CommandSegments {
  const segments: string[] = []
  let unparsed = false
  const scan = (text: string, depth: number): void => {
    if (depth > MAX_NESTING) { unparsed = true; return }
    let buf = ''
    // 词首状态（注释判定用，见下方 `#` 分支）。分隔符/空白把它置位，其它字符（含转义对）清除。
    let atWordStart = true
    const flush = (): void => { segments.push(buf); buf = ''; atWordStart = true }
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') { buf += text.slice(i, i + 2); i += 2; atWordStart = false; continue }
      if (ch === "'") {
        const end = text.indexOf("'", i + 1)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        buf += text.slice(i, end + 1); i = end + 1; continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < text.length) {
          const inner = text[j]
          if (inner === '\\') { j += 2; continue }
          if (inner === '"') break
          // 双引号内的 `$(...)` 与反引号**会执行**（单引号才不执行）：必须按原文递归扫，
          // 否则 `echo "$(screencap -p /sdcard/real.png)"` 会把真实屏命令当纯文本放行（issue #674）。
          if (inner === '`') {
            const end = backtickEnd(text, j + 1)
            if (end < 0) { unparsed = true; j = text.length; break }
            scan(text.slice(j + 1, end), depth + 1)
            j = end + 1
            continue
          }
          if (inner === '$' && text[j + 1] === '(') {
            const end = parenEnd(text, j + 2)
            if (end < 0) { unparsed = true; j = text.length; break }
            scan(text.slice(j + 2, end), depth + 1)
            j = end + 1
            continue
          }
          j += 1
        }
        if (j >= text.length) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        buf += text.slice(i, j + 1); i = j + 1; continue
      }
      if (ch === '`') {
        const end = backtickEnd(text, i + 1)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        // **命令位置**上的命令替换：替换结果是运行时文本，会被当成命令执行 ⇒ 执行什么静态不可判
        // （`sh -c "\`cat /sdcard/x.sh\`"` 真机实测执行文件内容）。参数位置的替换不影响命令身份；
        // 但**载荷位置**上的替换（`` sh -c \`cat f\` ``）等于整段脚本来自运行时，同样 fail-closed。
        if (buf.trim().length === 0 || PAYLOAD_SLOT_TAIL.test(buf)) unparsed = true
        scan(text.slice(i + 1, end), depth + 1)
        buf += ' '; i = end + 1; continue
      }
      if (ch === '$' && text[i + 1] === '(') {
        const end = parenEnd(text, i + 2)
        if (end < 0) { unparsed = true; buf += text.slice(i); i = text.length; continue }
        // 同上：`sh -c "$(cat /sdcard/x.sh)"` / `sh -c "echo hi; $(cat x.sh)"` 的第二段都是
        // 「命令名来自运行时」⇒ 与 `sh /x.sh`（脚本文件）同档，fail-closed。
        if (buf.trim().length === 0 || PAYLOAD_SLOT_TAIL.test(buf)) unparsed = true
        scan(text.slice(i + 2, end), depth + 1)
        buf += ' '; i = end + 1; continue
      }
      // shell 注释：`#` 只有在**词首**才开注释。词首＝未转义、未引用的 ASCII 空白 / `;` / `&` / `|`
      // 之后（由 atWordStart 显式跟踪）——不能用「buf 末尾是 \s」判定：`echo\ #; screencap …` 里
      // 那个空格是**转义的**（属于词内容），`#` 因此是 echo 的参数而不是注释，screencap 照跑
      // （dash 实测：`echo\ #; echo REACHED` 会执行 REACHED）。同理 VT/FF/CR/NBSP 都不是分隔符。
      if (ch === '#' && atWordStart) {
        const lineEnd = text.indexOf('\n', i)
        i = lineEnd < 0 ? text.length : lineEnd
        continue
      }
      if (ch === ';' || ch === '\n' || ch === '\r') { flush(); i += 1; continue }
      if (ch === '&' || ch === '|') {
        // `&&` / `||` 与单个 `&` / `|` 都是分隔符；两个字符都要吃掉。
        flush()
        i += text[i + 1] === ch ? 2 : 1
        continue
      }
      if (ch === ' ' || ch === '\t') atWordStart = true
      else atWordStart = false
      buf += ch; i += 1
    }
    flush()
  }
  scan(command, 0)
  // `sh -c` 载荷是**再看一层**的入口：它整段都在引号里（`stripQuotedText` 会把它抹掉），
  // 必须用**原文**匹配、再解一层引号把内层当命令扫。工作队列让嵌套的 `sh -c "sh -c …"` 也被展开
  // （载荷是子串，必然收缩；上限 16 层只是防御性护栏）。
  const pending = segments.slice()
  for (let round = 0; pending.length > 0 && round < 16; round += 1) {
    const segment = pending.shift() as string
    // `sh -c` 与 `eval` 都是「载荷会被再解释一遍」的入口，两者都要展开（issue #674 同类）。
    const payload = SHELL_C_PAYLOAD.exec(segment) ?? EVAL_PAYLOAD.exec(segment) ?? TRAP_PAYLOAD.exec(segment)
    if (payload === null) continue
    // 取载荷的**第一个词**（不是整段剩余）：`sh -c 'cmd' sh`、`eval 'cmd' foo`、`trap 'cmd' EXIT`
    // 的尾随 argv 会让「整段首尾成对」判据失效，从而整段不展开（安全侧漏拦）。
    // `--` 是**选项终结符**，不是载荷：`trap -- 'cmd' EXIT` 真机会执行 cmd（见 `firstPayloadWord`）。
    const inner = firstPayloadWord(payload[1])
    if (inner.length === 0) continue
    const before = segments.length
    scan(inner, 1)
    pending.push(...segments.slice(before))
  }
  return { segments, unparsed }
}

/**
 * 把**引号内文本与转义字符**替换成 shell 真正会执行的字面量：
 *   - 引号段整体抹成空白（引号内不是命令词，也不是参数——`echo "screencap"` 不执行它）；
 *   - `\x` 解成 `x`（shell 会消掉反斜杠：`input \-d 0 tap 1 2` 实际执行的就是 `input -d 0 tap 1 2`，
 *     不解转义则这行会从命令词面里溜走）。
 */
export function stripQuotedText(text: string): string {
  let out = ''
  let i = 0
  // 只对**段内第一个词**（命令词位置）做 quote removal —— shell 在查找命令前会剥掉那里的引号，
  // 所以 `"screencap" -p /sdcard/x` 真的会执行 screencap（dash 实测），旧实现把引号段一律抹平
  // ⇒ 命令词位置上的引号内容也被抹掉 ⇒ 整条判 allow（2026-10-28 自查，安全侧漏拦）。
  // 反之参数位置的引号必须继续抹掉：`echo "screencap"` 只是打印，抹掉才对
  // （fixture「双引号内纯文本不得误拦」）。故判据是「第一个词内」，不是「每个词首」。
  let inFirstWord = true
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      out += i + 1 < text.length ? text[i + 1] : ''
      i += 2
      inFirstWord = false
      continue
    }
    // `$'…'` / `$"…"`（ANSI-C 与本地化引号）在词首同样属于命令词：dash/bash 实测 `$'screencap' -p …` 会执行。
    const ansiC = inFirstWord && ch === '$' && (text[i + 1] === "'" || text[i + 1] === '"')
    if (ch === "'" || ch === '"' || ansiC) {
      const quote = ansiC ? text[i + 1] : ch
      let j = (ansiC ? i + 1 : i) + 1
      while (j < text.length) {
        if (quote === '"' && text[j] === '\\') { j += 2; continue }
        if (text[j] === quote) break
        j += 1
      }
      if (j >= text.length) { out += ' '; i = text.length; continue }
      out += inFirstWord ? text.slice((ansiC ? i + 1 : i) + 1, j) : ' '
      i = j + 1
      inFirstWord = false
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r') {
      // 第一个词在此结束：之后的引号都是参数，回到「抹掉」语义。
      inFirstWord = false
      out += ch
      i += 1
      continue
    }
    inFirstWord = false
    out += ch
    i += 1
  }
  return out
}

/** 把目标屏参数整体抹成空白（命令词匹配前归一化，使 `input -d 0 tap …` 也进命令词面）。 */
export function stripDisplayOptions(text: string): string {
  return text
    .replace(/(?:^|[ \t])-d[ \t]*\d+/g, ' ')
    .replace(/(?:^|[ \t])(?:--display|--display-id)[ \t=]+\d+/g, ' ')
}

// ── 命令词家族：每个家族自带「哪种拼写才算它的目标屏」 ──────────────────────────
//
// 缺陷形态（§8.3，P1）：旧实现是**单个大正则**，`input\s+(?:tap|swipe|…)` 要求动词**紧跟**
// `input`。而 Android CLI 的正式形态是 `input [-d DISPLAY_ID] <command>`（选项在**前**）⇒
// `input -d 0 tap 500 800` 不进命令词面 → 直接放行（读/写真实屏）。
//
// 修法：命令词在**归一化后**（stripDisplayOptions）匹配；并且每个家族各自声明
// **哪些拼写可以认证它的目标屏**——因为 `-d` 并非处处都是 display 参数：
//   `am start -d 5 -n p/.A` 里的 `-d` 是 **Intent data**（不是屏），拿它当目标屏凭据
//   等于给「启动到真实屏」发通行证；`am` 的显示参数是 `--display`。
//
// 命令词面本身**不得缩水**（缩水 = 直接放行真实屏），Kotlin 侧同名表 + fixture 双向锁死。

interface ScreenCommandFamily {
  /** 家族名（诊断与 fixture 用）。 */
  name: string
  /** 归一化文本上的命令词面。 */
  pattern: RegExp
  /**
   * 可作「目标屏认证」的拼写白名单；**空数组 = 该命令没有目标屏参数** ⇒ 在 virtual-only 下
   * 任何命中本家族的命令都无法自证，一律拒绝（无参 `screencap`、`uiautomator dump`、
   * `dumpsys window`、`monkey -p x 1` 都属这一类：它们读的就是**默认屏**）。
   */
  targetFlags: readonly string[]
}

const ALL_DISPLAY_FLAGS: readonly string[] = ['-d', '--display', '--display-id']

/** 命令词面（与修复前的大正则逐词一致 + `input keycombination`）。 */
const SCREEN_COMMAND_FAMILIES: readonly ScreenCommandFamily[] = [
  { name: 'screencap', pattern: /\bscreencap\b/i, targetFlags: ALL_DISPLAY_FLAGS },
  { name: 'screenrecord', pattern: /\bscreenrecord\b/i, targetFlags: ALL_DISPLAY_FLAGS },
  {
    name: 'input',
    // 正式语法是 `input [<source>] [-d DISPLAY_ID] <command> [<arg>…]`：source 是位置词
    // （touchscreen/touchpad/…），漏了它整类命令都进不了命令词面（`input touchscreen tap 500 800`
    // 实测放行）。`press` 是 0.14 起的新命令，同族。
    //
    // source 用**通配**而不是列举：2026-10-29 自查发现枚举里少了 `touchpad`
    // （`input` 裸跑打印的 source 清单里有它，属 InputDevice.SOURCE_TOUCHPAD），于是
    //   `input touchpad tap 9999 9999`             RC=0（与 `input touchscreen tap` 只差一个 source 词）
    //   `input touchpad swipe 9999 9999 9999 9999` RC=0
    //   `input touchpad -d 0 tap 9999 9999`         RC=0
    // 三条全部通过，而门禁判 allow。非 source 的词（`input bogus tap`）真机本来就报
    // `Unknown command: bogus` ⇒ 多拦无风险；而新 ROM 新增 source 时通配不会漏
    // （枚举式判据的失效方向是放行，与 `wm` 那处同源）。
    pattern:
      /\binput[ \t]+(?:[a-z][a-z0-9_-]*[ \t]+)?(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent|keycombination|press)\b/i,
    targetFlags: ALL_DISPLAY_FLAGS,
  },
  // `wm` 是窗口管理器命令面。修前用**子命令白名单**（size|density|overscan|user-rotation|
  // fixed-to-user-rotation），而 `wm` 实际有 20+ 子命令 ⇒ 白名单之外的一律放行。2026-10-29 自查实测：
  //   `wm dump-visible-window-views`   RC=0，65704 B 的 ZIP（PK 头），内含
  //       `com.miui.home/com.miui.home.launcher.Launcher`、
  //       `LauncherOverlayWindow:com.miui.personalassistant` 等每个窗口的 View 层级
  //       ⇒ 与 `uiautomator dump` 同级的「读真实屏 UI」；
  //   `wm dismiss-keyguard`            RC=0（解锁真实屏）；
  //   `wm reset` / `wm disable-blur`   RC=0（重置 / 改真实屏显示覆盖）。
  // 改成**反向表**：除 `help` 与 `get-*`（纯查询）之外的每个子命令都进家族 —— 新增子命令默认拒
  // （fail-closed），不再随 ROM 升版本静默漏拦。`wm -d 47 <cmd>` 真机实测 "Unknown command: -d"
  // ⇒ `-d` 只跟在子命令之后，不需要穿透前导选项。
  {
    name: 'wm',
    pattern: /\bwm[ \t]+(?!help\b|get-)[a-z][a-z-]*/i,
    targetFlags: ALL_DISPLAY_FLAGS,
  },
  // 其中三个子命令**不解析 `-d`**：`wm dump-visible-window-views -d 47` 真机仍 dump 出真实屏
  // 窗口树（65702 B，同一批窗口名）、`wm dismiss-keyguard -d 47` RC=0 照常解锁、
  // `wm disable-blur` 把 `-d 47` 当 blur 参数（随后 SecurityException 拒绝 —— uid 2000 无写权限）。
  // 它们无法自证目标屏 ⇒ 必须与 `dumpsys` 同档恒拒，否则 `-d <已注册虚拟屏 token>` 就是通行证。
  {
    name: 'wm-no-target',
    pattern: /\bwm[ \t]+(?:dump-visible-window-views|dismiss-keyguard|disable-blur)\b/i,
    targetFlags: [],
  },
  // `cmd window <size|density|scaling|user-rotation|dismiss-keyguard>` 是 `wm` 的等价拼写：
  // 小米 14 Pro 实测 `cmd window size 900x1600` 真的把真实屏改成 `Override size: 900x1600`
  // （`wm size reset` 才恢复），而修前它不在任何家族里 ⇒ 放行（2026-10-28 自查）。
  // 它的目标屏参数是**子命令内**的 `[-d DISPLAY_ID]`（实测 `cmd window size 900x1600 -d 7`
  // 被接受、返回 `Physical size: 0x0`），所以按 ALL_DISPLAY_FLAGS 取凭据。
  { name: 'cmd-window', pattern: /\bcmd[ \t]+window\b/i, targetFlags: ALL_DISPLAY_FLAGS },
  // `cmd display <set-brightness|set-user-preferred-display-mode|…>` 同样改真实屏（亮度/显示模式），
  // 但它的目标屏参数是 `--id DISPLAY_ID`，与既有凭据口径（-d/--display/--display-id）不同、
  // 也不是 `ScreenTarget` 的两种 id 空间之一 ⇒ 无法自证，按 `dumpsys` 同档恒拒。
  { name: 'cmd-display', pattern: /\bcmd[ \t]+display\b/i, targetFlags: [] },
  // `uiautomator dump` 没有目标屏参数：dump 的就是**默认屏**的语义树 ⇒ 无法自证，恒拒。
  { name: 'uiautomator', pattern: /\buiautomator\b/i, targetFlags: [] },
  // `dumpsys` 系列：这些子命令的输出里都带**真实屏**的 UI 结构或几何。
  //
  // `activity` 是 2026-10-28 自查补进来的：`dumpsys activity top` 会打出完整的
  // `View Hierarchy:` 树（DecorView → LinearLayout → FrameLayout → WebView，逐个带 `0,0-1440,3200`
  // 这类 bounds）以及 `android.widget.TextView{… 42,0-699,103}` 等控件行 —— 与 `uiautomator dump`
  // 同级的「读真实屏 UI」，而修前它不匹配 `window|display|input` ⇒ 整条放行。
  // `battery`/`meminfo` 这类与屏无关的子命令不受影响（见 fixture 里的对照用例）。
  { name: 'dumpsys', pattern: /\bdumpsys[ \t]+(?:window|display|input|activity)\b/i, targetFlags: [] },
  // 直接读写 input 设备的命令：`sendevent` 能向 `/dev/input/*` 注入任意事件（含触摸坐标），
  // `getevent` 能读回用户的触摸/按键事件。两者**都没有目标屏参数** ⇒ 永远自证不了「作用于已注册
  // 虚拟屏」，与 `uiautomator` 同档（恒拒）。
  // 小米 14 Pro 实测（2026-10-28 自查）：shell 直写 `/dev/input/eventN` 被拒（Permission denied），
  // 但设备已 root 时 `su -c 'sendevent /dev/input/event1 0 0 0'` **RC=0**；而 `su -c` 的载荷会被
  // 本门禁展开重扫，扫到 `sendevent` 却不在任何家族里 ⇒ 整条放行（实测 `allow`）。
  { name: 'sendevent', pattern: /\bsendevent\b/i, targetFlags: [] },
  { name: 'getevent', pattern: /\bgetevent\b/i, targetFlags: [] },
  // `am` 的显示参数是 `--display`；`-d` 是 Intent data，**不得**作为目标屏凭据（见上）。
  { name: 'am', pattern: /\bam[ \t]+(?:start|start-activity|force-stop|kill)\b/i, targetFlags: ['--display', '--display-id'] },
  { name: 'monkey', pattern: /\bmonkey\b/i, targetFlags: ['--display', '--display-id'] },
  // `cmd activity <start-activity|start|force-stop|kill>` 与 `am start` 走同一个
  // ActivityManagerShellCommand（无 `--display` 时默认 display 0）——只认 `am` 会把这条等价
  // 拼写整类放行（2026-10-28 自查）。`--display` 才是它的目标屏参数。
  {
    name: 'cmd-activity',
    pattern: /\bcmd[ \t]+activity[ \t]+(?:start-activity|start|force-stop|kill|stop-app)\b/i,
    targetFlags: ['--display', '--display-id'],
  },
]

/** 命令（归一化后）命中哪些命令词家族。 */
export function screenCommandFamilies(command: string): string[] {
  const normalized = stripDisplayOptions(stripQuotedText(command))
  return SCREEN_COMMAND_FAMILIES.filter((family) => family.pattern.test(normalized)).map((f) => f.name)
}

/** 该命令是否命中真实屏读写命令词面（不论它能否自证目标屏）。 */
export function commandTargetsRealScreen(command: string): boolean {
  return screenCommandFamilies(command).length > 0
}

/**
 * 屏幕范围判定的结果码（跨语言契约：Kotlin `ScreenCommandVerdict` 与本联合的字符串逐字相同，
 * 由 `scripts/gen-screen-scope-fixture.mjs` 的 fixture 双向锁死）。
 */
export type ScreenCommandVerdict = 'allow' | 'deny-unparsed' | 'deny-orphan-target-token' | 'deny-uncertified-target'

/**
 * 纯判据：一条 raw shell 命令在 virtual-only 下是否**只**作用于已注册虚拟屏。
 *
 * `isOwnedTarget(raw)`：该十进制串是否属于一块**已注册**虚拟屏（displayId 空间或 SF token
 * 空间，两个空间的取值都按**原样字符串**比对；`0` 恒为真实屏、永不属于）。
 *
 * 三态拒绝（每一态都有独立的反证用例）：
 *   - `deny-unparsed`：引号不闭合 / 嵌套过深 —— 看不懂就不放行；
 *   - `deny-orphan-target-token`：某段带目标屏参数却**自身不含任何屏幕命令词**。这类 token 没有
 *     合法用途，它的存在只为「给同一行的其它命令发通行证」（`echo -d <token>; cat …` 形态）；
 *   - `deny-uncertified-target`：命中屏幕命令词面，但该家族**没有**可用目标屏参数、参数缺席、
 *     或参数值不在注册表里（无参 `screencap`、`-d 0`、`-d <未知>`、`am start -d 5` 都在此列）。
 *
 * 与壳侧 `ShellOps.decideScreenCommand` 同一算法（Kotlin 侧为执行点复查的第二份实现）。
 */
export function screenCommandVerdict(
  command: string,
  isOwnedTarget: (raw: string) => boolean,
): ScreenCommandVerdict {
  const { segments, unparsed } = splitCommandSegments(command)
  if (unparsed) return 'deny-unparsed'
  for (const segment of segments) {
    const bare = stripQuotedText(segment)
    // 命令名来自运行时（`$CMD` / `"$(cat /sdcard/x.sh)"` / 反引号）：执行什么静态不可判。
    if (isRuntimeCommandName(segment)) return 'deny-unparsed'
    // `awk` 的 system() 载荷不可见（程序文本在引号里）⇒ fail-closed。
    if (AWK_EXEC_PAYLOAD.test(segment)) return 'deny-unparsed'
    // 命令词用 glob 拼出屏幕命令名（`/system/bin/scr?encap`）：词面不等于执行词 ⇒ 不可判。
    if (globExpandsToScreenCommand(segment)) return 'deny-unparsed'
    // 载荷不可见的解释器调用：静态判不了，fail-closed。
    if (interpreterPayloadUnparsed(bare)) return 'deny-unparsed'
    const options = displayOptionsIn(bare)
    if (MALFORMED_DISPLAY_OPTION.test(bare)) return 'deny-uncertified-target'
    const families = SCREEN_COMMAND_FAMILIES.filter(
      (family) => family.pattern.test(stripDisplayOptions(bare)),
    )
    if (families.length === 0) {
      // 非屏幕命令段：允许，但**不得**携带目标屏凭据（否则就是洗白凭据）。
      if (options.length > 0) return 'deny-orphan-target-token'
      continue
    }
    for (const family of families) {
      if (family.targetFlags.length === 0) return 'deny-uncertified-target'
      // `input` 的 `-d` 只在 **command 词之前**有意义：`input tap 1 2 -d 7` 里的 `-d 7` 是 tap 的
      // 多余 argv，真实 input 仍操作默认 display 0（Android 的 input 只在 command 前解析 -d）。
      // 旧实现做全段扫描 ⇒ 尾随 `-d <owned>` 反而成了"已认证"的通行证（2026-10-28 自查）。
      const limit = family.name === 'input' ? inputCommandIndex(bare) : bare.length
      const owned = options
        .filter((option) => family.targetFlags.includes(option.flag) && option.index < limit)
        .map((option) => option.value)
      // 该家族必须在**本段内**自证：参数缺席、或任一值不属于已注册虚拟屏 → 拒（不得只认证其中一个）。
      if (owned.length === 0) return 'deny-uncertified-target'
      if (!owned.every(isOwnedTarget)) return 'deny-uncertified-target'
    }
  }
  return 'allow'
}

/** `input` 家族里 command 词的位置（用作「只有它之前的 `-d` 才算凭据」的边界）。 */
const INPUT_COMMAND_RE =
  /\b(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent|keycombination|press)\b/i

function inputCommandIndex(text: string): number {
  const m = INPUT_COMMAND_RE.exec(text)
  return m === null ? text.length : (m.index ?? text.length)
}

/** 由注册表投影构造「该值是否属于已注册虚拟屏」的判据（两个 id 空间都按原样字符串比对）。 */
function ownedTargetPredicate(options: ScreenAccessOptions): (raw: string) => boolean {
  const ids = options.virtualDisplayIds
  const idSet = ids === undefined ? null : (ids instanceof Set ? ids : new Set<number>(ids))
  const sf = options.sfVirtualDisplays
  const aliases = options.virtualAliases
  let ownedTokens: ReadonlySet<string> = new Set<string>()
  if (sf !== undefined && aliases !== undefined && sf.length > 0) {
    const aliasSet = aliases instanceof Set ? aliases : new Set<string>(aliases)
    if (aliasSet.size > 0) {
      ownedTokens = new Set(sf.filter((entry) => aliasSet.has(entry.alias)).map((entry) => entry.token))
    }
  }
  return (raw: string): boolean => {
    if (raw === String(REAL_DISPLAY_ID)) return false
    const id = Number(raw)
    if (idSet !== null && Number.isInteger(id) && idSet.has(id)) return true
    return ownedTokens.has(raw)
  }
}

/**
 * 块G F6：解析 `dumpsys SurfaceFlinger` 输出里的**虚拟屏 token ↔ 产品别名**配对。
 *
 * 输入取自受支持的抽取命令（输出很小，避免全文超壳侧 16 KiB 上限）：
 * ```
 * dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'
 * ```
 * 设备实测（MuMu x86_64 模拟器 / Android 15 / API 35）逐字形态：
 * ```
 *     name="mumuscreen000"
 * Virtual Display 11529215046816944610
 *     name="DSH virtual-1"
 * ```
 * 该命令**不被** [SCREEN_COMMAND_FAMILIES] 命中（后者只认 `dumpsys (window|display|input)`），
 * 故本次改动**不扩大 shell 命令词面**——它只让范围判定能核对 SF token，不是放宽执行面。
 *
 * 尾随空白必须容忍：设备 `dumpsys` 输出常见行尾空格，而旧实现用 `matchEntire` 钉死整行 ⇒
 * 壳侧解析恒空、判定恒拒（N-5 的功能回归面；本函数按 `trimEnd` 语义匹配）。
 *
 * 纯函数：无 IO、无全局态，可离线单测。token 全程按字符串（见 [adbCommandDisplayTokens]）。
 */
export function screenTokensFromSfDump(sfDump: string): Array<{ alias: string; token: string }> {
  const out: Array<{ alias: string; token: string }> = []
  let pending: string | null = null
  for (const rawLine of String(sfDump ?? '').split(/\r?\n/)) {
    const tokenLine = /^Virtual Display[ \t]+(\d+)[ \t]*$/.exec(rawLine.trim())
    if (tokenLine !== null) {
      pending = tokenLine[1]
      continue
    }
    if (pending === null) continue
    const nameLine = /^[ \t]*name="([^"]*)"[ \t]*$/.exec(rawLine)
    if (nameLine === null) continue
    const displayName = nameLine[1]
    // 壳侧 createVirtualDisplay 用 "DSH <alias>" 命名（VdisplayController.create）。
    if (displayName.startsWith('DSH ')) out.push({ alias: displayName.slice('DSH '.length), token: pending })
    // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
    pending = null
  }
  return out
}

/**
 * Raw shell 面的屏幕范围判定（**引擎侧第一道**；壳侧 `ShellOps.scopeDenied` 是执行点的第二道）。
 *
 * @returns 拒绝文案（目标显示超出当前范围或无法认证）；null = 放行。
 */
export function realScreenAdbCommandDenied(
  scope: UserScreenScope,
  command: string,
  options: ScreenAccessOptions = {},
): string | null {
  if (scope === 'all') return null
  if (scope === 'real-only') {
    const parsed = splitCommandSegments(command)
    if (parsed.unparsed) return realOnlyScreenScopeMessage()
    for (const segment of parsed.segments) {
      const bare = stripQuotedText(segment)
      const options = displayOptionsIn(bare)
      const families = SCREEN_COMMAND_FAMILIES.filter(
        (family) => family.pattern.test(stripDisplayOptions(bare)),
      )
      for (const family of families) {
        // Commands without a display selector use Android's physical default display (0).
        // If a family has no documented selector, any display-looking option is ambiguous.
        const relevant = options.filter((option) => family.targetFlags.includes(option.flag))
        if (family.targetFlags.length === 0 && options.length > 0) return realOnlyScreenScopeMessage()
        if (relevant.some((option) => option.value !== String(REAL_DISPLAY_ID))) {
          return realOnlyScreenScopeMessage()
        }
      }
    }
    return null
  }
  const verdict = screenCommandVerdict(command, ownedTargetPredicate(options))
  if (verdict === 'allow') return null
  const head = '用户当前开放屏幕范围为 virtual-only，不允许读取或操作真实屏内容'
    + '（screencap/screenrecord/uiautomator/input/wm/dumpsys window|display|input/am start/monkey）。'
  if (verdict === 'deny-unparsed') {
    return head + '本条命令含无法解析的引号/嵌套（引号未闭合），无法核对目标屏，故拒绝。'
      + '请改写为单条、引号配对的命令后重试。'
  }
  if (verdict === 'deny-orphan-target-token') {
    return head + '本条命令的某个命令段携带了 `-d`/`--display` 目标屏参数，自身却不含任何屏幕命令词——'
      + '目标屏参数只能由**作用在该屏上**的命令段携带（一行参数不得给同行其它命令发通行证）。'
      + '若该参数不是屏幕目标参数（例如 `curl -d <数据>`），请改用其长选项写法（如 `--data`）后重试。'
  }
  return head + '命令里显式指定的目标屏若确为**已注册虚拟屏**（DisplayManager displayId 或该屏的 '
    + 'SurfaceFlinger token）即可放行；本条命令的目标屏未能与壳侧注册表核对上，故拒绝。'
    + '请确认虚拟屏仍在活跃状态（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。'
}

function realOnlyScreenScopeMessage(): string {
  return '用户当前开放屏幕范围为 real-only；屏幕命令只能作用于物理屏 display 0。'
    + '虚拟屏或无法确认的显式显示目标已拒绝。非屏幕 shell 命令仍按原策略执行。'
}

/** Normalize only the three product settings values; corrupt data fails closed. */
export function normalizeScreenScope(value: unknown): UserScreenScope {
  return value === 'virtual-only' || value === 'real-only' || value === 'all' ? value : DEFAULT_SCREEN_SCOPE
}

/** Parse the native ScreenScopePrefs XML without allowing an engine plugin to write that preference. */
export function parseScreenScopePrefsXml(xml: string): UserScreenScope {
  const match = /<string\s+name="scope">([^<]*)<\/string>/.exec(xml)
  return normalizeScreenScope(match?.[1])
}

function scopePrefsPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DSH_SCREEN_SCOPE_PREFS_PATH) return env.DSH_SCREEN_SCOPE_PREFS_PATH
  if (env.TERMUX__PREFIX && env.DSH_HOME) return SHELL_SCREEN_SCOPE_PREFS_DEFAULT
  return undefined
}

/**
 * Read the native preference afresh for each device operation. Test-only environment input is
 * intentionally gated, so a stale generic environment value cannot override the shell preference.
 */
export function currentScreenScope(env: NodeJS.ProcessEnv = process.env): UserScreenScope {
  if (env.DSH_SCREEN_SCOPE_TEST === '1' || env.DSH_SCREEN_SCOPE_TEST === 'true') {
    return normalizeScreenScope(env.DSH_SCREEN_SCOPE)
  }
  const path = scopePrefsPath(env)
  if (path === undefined) return DEFAULT_SCREEN_SCOPE
  try {
    return parseScreenScopePrefsXml(readFileSync(path, 'utf8'))
  } catch {
    return DEFAULT_SCREEN_SCOPE
  }
}

/**
 * Decide the executable physical/virtual-screen target for the user-owned scope.
 *
 * VirtualDisplay is deliberately not guessed from an Android numeric id: the alias must be resolved
 * through the native registry (`screens()` / `vdInfo`) and passed in via [ScreenAccessOptions].
 * Without a resolved id, before the display is ready every virtual request fails explicitly
 * (`screen-not-ready`) — never a silent fallback to display 0 (U-3).
 */
export function decideScreenAccess(
  scope: UserScreenScope,
  requested?: string,
  options: ScreenAccessOptions = {},
): ScreenAccessDecision {
  const screenId = requested === undefined || requested === '' ? REAL_SCREEN_ID : requested
  if (screenId !== REAL_SCREEN_ID && !isVirtualScreenId(screenId)) {
    return {
      ok: false,
      reason: 'screen-not-found',
      scope,
      screenId,
      guidance: `未知屏幕 ${screenId}；请先调用 android_screen_list，并使用 real 或 virtual-N。`,
    }
  }
  const inScope = scope === 'all' || (scope === 'real-only' && screenId === REAL_SCREEN_ID) || (scope === 'virtual-only' && isVirtualScreenId(screenId))
  if (!inScope) {
    return {
      ok: false,
      reason: 'screen-out-of-scope',
      scope,
      screenId,
      guidance: `用户当前开放屏幕范围为 ${scope}，不允许读取或操作 ${screenId}。请由用户在设置中修改范围。`,
    }
  }
  if (isVirtualScreenId(screenId)) {
    const resolved = options.virtualDisplayId
    if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved > 0) {
      // review C11 alias 契约闭环：原生注册表给出的动态 displayId（绝不假设恒为 1、绝不回退 0）。
      return { ok: true, screenId, displayId: resolved, scope }
    }
    return {
      ok: false,
      reason: 'screen-not-ready',
      scope,
      screenId,
      guidance: `虚拟屏幕 ${screenId} 尚未就绪；系统绝不会把虚拟屏静默映射为真实屏幕 display 0。`,
    }
  }
  return { ok: true, screenId: REAL_SCREEN_ID, displayId: REAL_DISPLAY_ID, scope }
}
