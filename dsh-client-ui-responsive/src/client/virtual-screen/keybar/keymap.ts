/**
 * 屏上九键条的**纯函数语义层**（无 DOM、无 React、无 cordis）——本模块是键位语义的唯一真源。
 *
 * 为什么必须独立成纯函数（判据 §6.1）：
 *   1) 键->序列映射与 Ctrl 闩锁状态机是**最容易写错**的部分（Ctrl 发错序列在终端里是真乱码/
 *      真误操作，例如把 Ctrl+C 发成字面量 C，或把 Ctrl+左 手拼成某个不存在的控制字符）；
 *   2) 写进 UI 回调就无法单测 —— 判据明确要求「写进 UI 回调 => 判红」；
 *   3) 九键的语义与「怎么送进终端」是两件事：本模块只产出**意图**（intent），由 UI 层决定经
 *      通路 (c) 合成 keydown（优先，让 xterm 自己按 DECCKM 决定 CSI/SS3）还是通路 (a) 直写字节。
 *
 * DECCKM 纪律（阶段 0 实测，[A]）：acck=false 时方向键发 CSI（ESC [ A），注入 ESC [ ? 1 h 后
 * acck=true 且变 SS3（ESC O A）。**当前模式会变**（vim/less 会打开），因此：
 *   - 首选 xterm 映射（xterm 自己按当前模式产出正确字节）；
 *   - 兜底直写时，本模块同时给出 csi/ss3 两个候选，**由调用方按 xterm.modes.applicationCursorKeysMode
 *     动态选择**，绝不在此写死单一序列。
 *
 * Ctrl 纪律（用户批准「全部纳入」+ 文案约束）：无法映射的组合（如 Ctrl+左）必须**明确提示不支持**，
 * 绝不静默发错序列。因此映射是一张**显式白名单表**，不是 charCode ^ 0x40 的公式 —— 公式对 A-Z
 * 恰好正确，但对任何不在此表的键都会产出垃圾（反证见 test/keybar-keymap.test.mjs 的 CTRL 反证组）。
 */

/** 九键的稳定顺序（一屏一行，左到右）。UI 与单测共用此顺序，避免两处各写一份。 */
export const KEYBAR_KEYS = ['keyboard', 'tab', 'ctrl', 'esc', 'left', 'right', 'up', 'down', 'enter'] as const

/** 九键的键身份。 */
export type KeybarKey = (typeof KEYBAR_KEYS)[number]

/** Ctrl 闩锁超时（毫秒）。用户口径 3-5s，取中 4s；写成常量而非散落魔数。 */
export const CTRL_LATCH_TIMEOUT_MS = 4_000

/**
 * xterm 可映射的键身份（喂给通路 (c) 的合成 KeyboardEvent 用）。
 *
 * keyCode 是**旧式**字段，但 xterm 的按键处理器正是靠它认键：
 * 合成事件里 keyCode=0 时 xterm 会直接丢弃该键（0.14.2 ADB 用户层实测的阻塞级缺陷形态：
 * 事件确实到了 .xterm-helper-textarea，却没有任何 /api/terminal/write）。
 * 因此每个 sends=true 的键都必须登记非 0 keyCode（由单测强制，防漏登记新键）。
 */
export interface XtermKey { readonly key: string; readonly code: string; readonly keyCode: number }

/** 一个键的静态语义。sends=false 的键不产出字节（keyboard 只聚焦，ctrl 只闩锁）。 */
export interface KeySpec {
  readonly id: KeybarKey
  /** 键条上的可见文字（中文默认）。 */
  readonly label: string
  /** English visible text; absent when the label is a symbol. */
  readonly labelEn?: string
  /** 无障碍名（与 label 分开：label 可能是紧凑符号）。 */
  readonly ariaLabel: string
  /** English accessible name. */
  readonly ariaLabelEn?: string
  readonly sends: boolean
  /** 优先通路用的 xterm 键身份；null = 该键不产字节。 */
  readonly xterm: XtermKey | null
  /** 兜底直写：DECCKM **关闭**（普通模式）时的序列。 */
  readonly csi: string | null
  /** 兜底直写：DECCKM **开启**（应用光标键模式）时的序列。 */
  readonly ss3: string | null
}

/**
 * 九键静态表。方向键的 csi/ss3 只作兜底，首选让 xterm 自己映射（见文件头 DECCKM 纪律）。
 *
 * 顺序与 KEYBAR_KEYS 一致：键盘 / Tab / Ctrl / Esc / 左 / 右 / 上 / 下 / 回车。
 */
export const KEYBAR_SPECS: Readonly<Record<KeybarKey, KeySpec>> = {
  keyboard: {
    id: 'keyboard', label: '键盘', labelEn: 'Keys', ariaLabel: '唤起软键盘', ariaLabelEn: 'Show keyboard',
    sends: false, xterm: null, csi: null, ss3: null,
  },
  tab: {
    id: 'tab', label: 'Tab', ariaLabel: 'Tab 键，补全', ariaLabelEn: 'Tab key, complete',
    sends: true, xterm: { key: 'Tab', code: 'Tab', keyCode: 9 }, csi: '\t', ss3: '\t',
  },
  ctrl: {
    id: 'ctrl', label: 'Ctrl', ariaLabel: 'Ctrl 组合键，粘滞', ariaLabelEn: 'Ctrl combination, sticky',
    sends: false, xterm: null, csi: null, ss3: null,
  },
  esc: {
    id: 'esc', label: 'Esc', ariaLabel: 'Esc 键，取消', ariaLabelEn: 'Esc key, cancel',
    sends: true, xterm: { key: 'Escape', code: 'Escape', keyCode: 27 }, csi: '\u001b', ss3: '\u001b',
  },
  left: {
    id: 'left', label: '\u2190', ariaLabel: '光标左移', ariaLabelEn: 'Move cursor left',
    sends: true, xterm: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, csi: '\u001b[D', ss3: '\u001bOD',
  },
  right: {
    id: 'right', label: '\u2192', ariaLabel: '光标右移', ariaLabelEn: 'Move cursor right',
    sends: true, xterm: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, csi: '\u001b[C', ss3: '\u001bOC',
  },
  up: {
    id: 'up', label: '\u2191', ariaLabel: '上一条历史', ariaLabelEn: 'Previous history entry',
    sends: true, xterm: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, csi: '\u001b[A', ss3: '\u001bOA',
  },
  down: {
    id: 'down', label: '\u2193', ariaLabel: '下一条历史', ariaLabelEn: 'Next history entry',
    sends: true, xterm: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, csi: '\u001b[B', ss3: '\u001bOB',
  },
  enter: {
    id: 'enter', label: '\u23ce', ariaLabel: '回车', ariaLabelEn: 'Enter',
    sends: true, xterm: { key: 'Enter', code: 'Enter', keyCode: 13 }, csi: '\r', ss3: '\r',
  },
}

// ---------------------------------------------------------------------------
// Ctrl 控制字符白名单
// ---------------------------------------------------------------------------

/**
 * 控制字符白名单：**只有表中存在的目标才可发**。
 *
 * 覆盖两类（POSIX 的 caret 记法）：
 *  - 字母 a-z（不分大小写）-> 0x01-0x1A（Ctrl+A 行首 ... Ctrl+Z 挂起）；
 *  - 符号 @ [ 反斜杠 ] ^ _ ? -> 0x00/0x1B/0x1C/0x1D/0x1E/0x1F/0x7F。
 *
 * 有意**不含**数字键（Ctrl+2/3/6/8 在不同终端语义不一，属「可争议」），也不含任何命名键
 * （方向键/Tab/Esc/Enter）—— 那些走 pressKeybarKey 的拒绝分支。
 */
/**
 * 控制字符白名单表：**一行一个事实，控制字节与旧式 keyCode 都显式列出**。
 *
 * 为什么 keyCode 也要在这里（而不是用公式算）：
 *   xterm 的按键处理器靠旧式 keyCode 认键（0.14.2 ADB 用户层实测：合成事件 keyCode=0 时
 *   xterm 直接丢弃，事件到了 textarea 却不产生任何 terminal/write）。
 *   字母的 keyCode 是**大写 ASCII**（A=65..Z=90），与控制字节无关；
 *   若用 charCode ^ 0x40 去算，得到的恰好是**控制字节**而不是 keyCode —— 那是本模块明令禁止的公式。
 *   因此两个值都在表里写死，既不互相推导，也不会因新增键而漂移。
 */
interface ControlEntry {
  /** 该组合应发的控制字节。 */
  readonly data: string
  /** 该组合的旧式 keyCode（字母为大写 ASCII）。 */
  readonly keyCode: number
}

const CONTROL_CHARS: Readonly<Record<string, ControlEntry>> = {
  a: { data: '\u0001', keyCode: 65 }, b: { data: '\u0002', keyCode: 66 },
  c: { data: '\u0003', keyCode: 67 }, d: { data: '\u0004', keyCode: 68 },
  e: { data: '\u0005', keyCode: 69 }, f: { data: '\u0006', keyCode: 70 },
  g: { data: '\u0007', keyCode: 71 }, h: { data: '\u0008', keyCode: 72 },
  i: { data: '\u0009', keyCode: 73 }, j: { data: '\u000a', keyCode: 74 },
  k: { data: '\u000b', keyCode: 75 }, l: { data: '\u000c', keyCode: 76 },
  m: { data: '\u000d', keyCode: 77 }, n: { data: '\u000e', keyCode: 78 },
  o: { data: '\u000f', keyCode: 79 }, p: { data: '\u0010', keyCode: 80 },
  q: { data: '\u0011', keyCode: 81 }, r: { data: '\u0012', keyCode: 82 },
  s: { data: '\u0013', keyCode: 83 }, t: { data: '\u0014', keyCode: 84 },
  u: { data: '\u0015', keyCode: 85 }, v: { data: '\u0016', keyCode: 86 },
  w: { data: '\u0017', keyCode: 87 }, x: { data: '\u0018', keyCode: 88 },
  y: { data: '\u0019', keyCode: 89 }, z: { data: '\u001a', keyCode: 90 },
  // 符号类的旧式 keyCode 是各键自身的 ASCII 码值（不是 charCode ^ 0x40）。
  '@': { data: '\u0000', keyCode: 50 }, '[': { data: '\u001b', keyCode: 219 },
  '\\': { data: '\u001c', keyCode: 220 }, ']': { data: '\u001d', keyCode: 221 },
  '^': { data: '\u001e', keyCode: 54 }, _: { data: '\u001f', keyCode: 189 },
  '?': { data: '\u007f', keyCode: 191 },
}

/**
 * 单字符 -> 控制字符。
 * @param char - 单个字符。
 * @returns 控制字符；不在白名单返回 null（调用方必须据此报「不支持」，不得回退到公式）。
 */
export function controlCharFor(char: string): string | null {
  if (char.length !== 1) return null
  return CONTROL_CHARS[char.toLowerCase()]?.data ?? null
}

/**
 * 单字符 -> 该组合的旧式 keyCode。
 * @param char - 单个字符。
 * @returns 大写 ASCII（字母）/ 键码（符号）；不在白名单返回 null。
 */
export function controlKeyCodeFor(char: string): number | null {
  if (char.length !== 1) return null
  return CONTROL_CHARS[char.toLowerCase()]?.keyCode ?? null
}

// ---------------------------------------------------------------------------
// 意图（intent）
// ---------------------------------------------------------------------------

/** Ctrl 闩锁的**可见状态指示**（UI 高亮 + 计时）。 */
export interface LatchState {
  readonly latched: boolean
  /** 闩锁到期时刻（毫秒，与传入的 nowMs 同基准）；未闩锁为 null。 */
  readonly expiresAtMs: number | null
}

/** 初始闩锁状态。 */
export const INITIAL_LATCH: LatchState = { latched: false, expiresAtMs: null }

/** 一次按键解析出的**效果**。UI 层只负责把效果映射到副作用，不再做任何键位判断。 */
export type KeyEffect =
  /** 唤起软键盘（在真实用户手势内 focus xterm）。 */
  | { readonly type: 'focus' }
  /** 闩锁状态变化（UI 据此高亮；同时用于「已取消」的可见反馈）。 */
  | { readonly type: 'latch'; readonly latched: boolean; readonly expiresAtMs: number | null }
  /** 发送一个键。xterm 非空时**优先**走合成 keydown；否则用 data 直写。 */
  | {
      readonly type: 'send'
      readonly key: KeybarKey
      readonly xterm: XtermKey | null
      readonly data: string
      readonly ctrlKey: boolean
    }
  /** 明确拒绝：UI 必须提示，不得静默。 */
  | { readonly type: 'reject'; readonly reason: 'unsupported-control-combo'; readonly key: KeybarKey }

/** 一次按键解析的完整结果。 */
export interface KeyOutcome {
  readonly state: LatchState
  readonly effects: readonly KeyEffect[]
}

/**
 * 解析一次九键按键（**纯函数**：无 IO、无时间读取，nowMs 由调用方注入）。
 * @param state - 当前闩锁状态。
 * @param key - 被按下的九键之一。
 * @param nowMs - 当前时刻（毫秒）。
 * @param timeoutMs - Ctrl 闩锁超时，默认 CTRL_LATCH_TIMEOUT_MS。
 * @returns 新状态与该次按键产生的效果序列。
 */
export function pressKeybarKey(
  state: LatchState,
  key: KeybarKey,
  nowMs: number,
  timeoutMs: number = CTRL_LATCH_TIMEOUT_MS,
): KeyOutcome {
  const spec = KEYBAR_SPECS[key]

  // 「键盘」键：只聚焦，不发任何序列。闩锁若开着则先解除（避免用户以为还挂着 Ctrl）。
  if (key === 'keyboard') {
    const effects: KeyEffect[] = []
    if (state.latched) effects.push({ type: 'latch', latched: false, expiresAtMs: null })
    effects.push({ type: 'focus' })
    return { state: INITIAL_LATCH, effects }
  }

  // 「Ctrl」键：开/关闩锁（再点一次即主动取消，用户不会卡在 Ctrl 态）。
  if (key === 'ctrl') {
    const latched = !state.latched
    const expiresAtMs = latched ? nowMs + timeoutMs : null
    return { state: { latched, expiresAtMs }, effects: [{ type: 'latch', latched, expiresAtMs }] }
  }

  // 闩锁开启时，九键里除 Ctrl 外**没有任何一个**能映射成控制字符：
  //   Tab / Esc / Enter 不是控制字符（Ctrl+[ 才是 ESC，但那是字符 [ 不是 Esc 键）；
  //   方向键根本没有对应控制字符。
  // 按用户口径必须**明确拒绝**，而不是猜一个序列发出去。
  if (state.latched) {
    return {
      state: INITIAL_LATCH,
      effects: [
        { type: 'latch', latched: false, expiresAtMs: null },
        { type: 'reject', reason: 'unsupported-control-combo', key },
      ],
    }
  }

  /* v8 ignore start -- 静态表由本模块自己拥有且保证 sends 与序列同真同假，此分支不可达 */
  if (!spec.sends || spec.csi === null) {
    return { state, effects: [{ type: 'reject', reason: 'unsupported-control-combo', key }] }
  }
  /* v8 ignore stop */

  return {
    state,
    effects: [{ type: 'send', key, xterm: spec.xterm, data: spec.csi, ctrlKey: false }],
  }
}

/**
 * 闩锁超时检查（**纯函数**）：UI 的定时器到点后调用，或每次事件前先调用以收敛过期闩锁。
 * @param state - 当前闩锁状态。
 * @param nowMs - 当前时刻（毫秒）。
 * @returns 到期则返回已解除的状态与一条取消效果；未到期原样返回。
 */
export function expireLatch(state: LatchState, nowMs: number): KeyOutcome {
  if (!state.latched || state.expiresAtMs === null || nowMs < state.expiresAtMs) {
    return { state, effects: [] }
  }
  return { state: INITIAL_LATCH, effects: [{ type: 'latch', latched: false, expiresAtMs: null }] }
}

/**
 * Ctrl 闩锁下输入单个字符的解析结果。
 * xterm 身份里**必须**带旧式 keyCode（实测：keyCode=0 时 xterm 丢弃该键）。
 */
export type CtrlCharResult =
  | { readonly ok: true; readonly data: string; readonly xterm: XtermKey }
  | { readonly ok: false; readonly reason: 'unsupported-control-combo' }

/**
 * 闩锁开启时，处理一个**来自软键盘/物理键盘的单字符**（Termux 同款体验：Ctrl 闩锁 + 键盘敲字母）。
 * 不在白名单的字符必须走 rejected，UI 据此提示「不支持 Ctrl+该键」。
 * @param char - 单个字符。
 * @returns 命中则给出控制字节与优先走 xterm 的键身份；否则 ok=false。
 */
export function resolveCtrlChar(char: string): CtrlCharResult {
  const data = controlCharFor(char)
  const keyCode = controlKeyCodeFor(char)
  // 两个都必须命中（同一张表，不会只有一个）：缺任一都按「不支持」处理，绝不发半个事实。
  if (data === null || keyCode === null) return { ok: false, reason: 'unsupported-control-combo' }
  const lower = char.toLowerCase()
  // 字母走 KeyX 身份（PhysicalKeyboard 键码语义）；符号类控制字符没有 KeyX 形式，
  // 退回该字符本身作 key，KeyX 无法表达时 xterm 仍按 keydown 的 key 处理。
  // keyCode 来自白名单表（字母为大写 ASCII 65-90），**不是** charCode^0x40 公式。
  const code = /^[a-z]$/u.test(lower) ? 'Key' + lower.toUpperCase() : char
  return { ok: true, data, xterm: { key: lower, code, keyCode } }
}

/**
 * 兜底直写时按当前 DECCKM 选择序列（**纯函数**）。
 *
 * 阶段 0 [A] 实测：acck=false -> CSI（ESC [ A）；acck=true -> SS3（ESC O A）。绝不写死。
 * @param spec - 键的静态表项。
 * @param applicationCursorKeys - xterm.modes.applicationCursorKeysMode 的当前值。
 * @returns 该模式下应发的序列；该键不发字节则返回 null。
 */
export function fallbackSequence(spec: KeySpec, applicationCursorKeys: boolean): string | null {
  if (!spec.sends) return null
  return applicationCursorKeys ? spec.ss3 : spec.csi
}
