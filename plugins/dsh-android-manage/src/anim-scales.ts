/**
 * 系统动画三开关的取值与回读口径（issue #1526）。
 *
 * 缺陷形态（两条，同源：把「字符串」当成「取值」）：
 *   1. 回读用**字符串等值**：`now[k] === '1'`。ROM 回 `1.0`（或 `1.00`、带空白）时真成功也进
 *      notDone，报「动画未恢复默认」——用户看到的是假失败，而且这条假失败会连带让
 *      `env_prepare` 整条返回 ok=false（`notDone` 非空即失败）；
 *   2. 恢复写的是**常量 1**：`restoreAnimScales({})` 传空对象 ⇒ `old[k] ?? '1'` 一律写 '1'。
 *      用户自己设的 0.5 / 10 倍速被静默抹成默认值——「恢复」把人家的设置改掉了。
 *
 * 为什么抽成独立模块：判据必须验**真实现**。原先的用例读 `src/index.ts` 的文本切片
 * （`src.indexOf('if (restore) {')` 起 900 字符），于是把判定挪进 helper、改个变量名、
 * 或让 settle 的收尾换一行，用例就红/绿无常；而真正的取值口径（1.0 算不算 1、
 * 读不到怎么报、写回什么）一条都没被断言。
 *
 * 口径（本模块即真源）：
 *   - **值**：数值等值，`Number(raw) === 目标`；非有限数（''、'null'、'unknown'）算「读不到」；
 *   - **读不到 ≠ 不是目标**：两种失败必须给两条不同文案——前者是通道/ROM 问题，
 *     后者是真的没写进去，处置方式完全不同（一个要重试/换通道，一个要看写入权限）；
 *   - **恢复**：写回**准备前读到的原值**；原值读不到的键才退回默认 '1'，并在回执里点名。
 */

/** 系统动画三开关的 settings key（顺序即回执里的展示顺序）。 */
export const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const

export type AnimScales = Record<string, string>

/**
 * 解析 `settings list global` 风格的回读输出（`R:key=value` 逐行）。
 *
 * 为什么认 `R:` 前缀：壳侧 readAnimationScales 逐键打印 `R:<key>=<value>`，前缀是它的
 * 可解析标记（值本身可能带空格或被截断，靠位置切不可靠）。
 * @param stdout - 通道原始输出。
 * @returns 键 → 原样字符串值（不做数值化：调用方需要看到 ROM 到底回了什么）。
 */
export function parseAnimScales(stdout: string): AnimScales {
  const out: AnimScales = {}
  for (const m of String(stdout ?? '').matchAll(/R:(\w+)=(\S+)/g)) out[m[1]] = m[2]
  return out
}

/**
 * 一个读回值是否等于目标倍速（**数值**等值，不是字符串等值）。
 *
 * `1.0` / `1.00` / ` 1 ` 都等于 1；`0` / `0.0` 都等于 0。
 * 读不到（键缺失 / 空串 / 非数字）返回 null —— 与「不等于」严格区分。
 * @param raw - 通道回读的原样值（可能是 undefined）。
 * @param target - 期望倍速。
 * @returns true 相等 / false 不相等 / null 读不到。
 */
export function animScaleMatches(raw: string | undefined, target: number): boolean | null {
  if (raw === undefined) return null
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return value === target
}

export interface AnimScaleCheck {
  /** 三项是否都等于目标。 */
  ok: boolean
  /** 读不到的键（通道/ROM 问题）。 */
  unreadable: string[]
  /** 读得到但值不对的键（写入未生效）。 */
  mismatched: string[]
  /** 逐键读回的原始值（回执展示用，未读到的键不在其中）。 */
  readback: AnimScales
}

/**
 * 三开关的读回判定（关闭与恢复**共用**这一条口径，不再各写一份）。
 *
 * 缺陷形态里两条分支都各自裸写了一遍字符串比较，所以一处修了另一处照旧；共用判定后
 * 「两边口径必须一致」不再靠人记得。
 * @param now - 读回的键值表。
 * @param target - 期望倍速（关闭 = 0，恢复默认 = 1）。
 * @param keys - 参与判定的键（默认三开关）。
 * @returns 判定结果；`unreadable` 与 `mismatched` 必须分开报。
 */
export function checkAnimScales(
  now: AnimScales,
  target: number,
  keys: readonly string[] = ANIM_KEYS,
): AnimScaleCheck {
  const unreadable: string[] = []
  const mismatched: string[] = []
  const readback: AnimScales = {}
  for (const key of keys) {
    const raw = now[key]
    if (raw !== undefined) readback[key] = raw
    const verdict = animScaleMatches(raw, target)
    if (verdict === null) unreadable.push(key)
    else if (!verdict) mismatched.push(key)
  }
  return { ok: unreadable.length === 0 && mismatched.length === 0, unreadable, mismatched, readback }
}

/** 回执里「读回 …」那一段（三种判定共用的展示格式）。 */
export function animReadbackText(readback: AnimScales, keys: readonly string[] = ANIM_KEYS): string {
  return keys.map((key) => `${key}=${readback[key] ?? '?'}`).join(', ')
}

/**
 * 恢复时该写回什么：**准备前读到的原值**优先，读不到的键才退回默认 '1'。
 *
 * @param before - 准备（关闭）之前读到的原值表。
 * @param keys - 三开关。
 * @returns 写入用的键值表与「原值读不到」的键清单（后者要在回执里点名，不能装作已还原）。
 */
export function animRestoreValues(
  before: AnimScales,
  keys: readonly string[] = ANIM_KEYS,
): { values: AnimScales; unknown: string[] } {
  const values: AnimScales = {}
  const unknown: string[] = []
  for (const key of keys) {
    const raw = before[key]
    if (raw === undefined || raw.trim() === '') {
      unknown.push(key)
      values[key] = '1'
      continue
    }
    values[key] = raw
  }
  return { values, unknown }
}

/**
 * 恢复分支的回执判定：写入并回读之后，**逐键**与该键的目标值比对。
 *
 * 目标不是常量 1：原值 0.5 的键，恢复后必须仍是 0.5（把用户设置改回 1 是新的伤害）。
 * @param readback - 恢复后的读回表。
 * @param expected - `animRestoreValues` 给出的目标值表。
 * @param keys - 三开关。
 * @returns 判定结果，口径与 [checkAnimScales] 一致（读不到 / 不等于分开）。
 */
export function checkAnimRestore(
  readback: AnimScales,
  expected: AnimScales,
  keys: readonly string[] = ANIM_KEYS,
): AnimScaleCheck {
  const unreadable: string[] = []
  const mismatched: string[] = []
  const seen: AnimScales = {}
  for (const key of keys) {
    const raw = readback[key]
    if (raw !== undefined) seen[key] = raw
    const want = Number(String(expected[key] ?? '1').trim())
    const verdict = animScaleMatches(raw, Number.isFinite(want) ? want : 1)
    if (verdict === null) unreadable.push(key)
    else if (!verdict) mismatched.push(key)
  }
  return { ok: unreadable.length === 0 && mismatched.length === 0, unreadable, mismatched, readback: seen }
}
/**
 * 准备前原值的持久化（issue #1526 的第二半）。
 *
 * 为什么要落盘而不是放内存：`env_prepare` 的「关动画」与「恢复」是**两次独立调用**，
 * 中间可能隔着引擎重启、会话切换或另一个进程。放内存时这些情况下原值全部丢失，
 * 恢复又退回写常量 1 —— 正是本 issue 要修的那个伤害。
 *
 * 口径：文件只是**缓存**，任何一步读不到都退回「原值未知」并在回执里点名，
 * 绝不假装已还原。
 */
export const ANIM_STATE_FILE = 'anim-scales.json'

/** 序列化准备前的原值（只保留三开关里读到的键）。 */
export function serializeAnimState(before: AnimScales, keys: readonly string[] = ANIM_KEYS): string {
  const kept: AnimScales = {}
  for (const key of keys) {
    const raw = before[key]
    if (raw !== undefined && raw.trim() !== '') kept[key] = raw
  }
  return JSON.stringify({ version: 1, scales: kept })
}

/**
 * 解析落盘的原值。
 *
 * 宽容处理（版本不符 / 非 JSON / 结构不对一律当「没有记录」）：这个文件的唯一作用是
 * 让恢复更准，它坏掉不该让 `env_prepare` 失败。
 * @param text - 文件内容（读不到时传空串）。
 * @returns 原值表；无法解析时为空对象。
 */
export function parseAnimState(text: string): AnimScales {
  if (typeof text !== 'string' || text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const scales = (parsed as { scales?: unknown }).scales
  if (typeof scales !== 'object' || scales === null) return {}
  const out: AnimScales = {}
  for (const key of ANIM_KEYS) {
    const value = (scales as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value
  }
  return out
}

/**
 * 关闭分支的回执（issue #1526）：把「读不到」与「不等于」拆成两条。
 *
 * 为什么必须拆：读不到 = 通道/ROM 问题（重试或换通道有意义），不等于 = 写入没生效
 * （要查权限或安全策略）。旧实现把两者压成同一句「未关闭生效」，用户无从下手。
 * @param check - `checkAnimScales` 的结果。
 * @returns 成功行（ok）或失败行（不 ok）。
 */
export function animDisableVerdict(check: AnimScaleCheck): { ok: boolean; text: string } {
  if (check.ok) return { ok: true, text: '动画：已关闭（window/transition/animator 三项 = 0）' }
  const parts: string[] = []
  if (check.unreadable.length > 0) {
    parts.push('读不回 ' + check.unreadable.join(', ') + '（通道未回值，不代表已关闭）')
  }
  if (check.mismatched.length > 0) {
    parts.push('未生效 ' + check.mismatched.join(', ') + '（写入后读回仍不是 0）')
  }
  return {
    ok: false,
    text: '动画未关闭生效（读回 ' + animReadbackText(check.readback) + '；' + parts.join('；') + '）',
  }
}

/**
 * 恢复分支的回执（issue #1526）。
 *
 * 三种结局各有独立文案，因为处置方式完全不同：
 *   - 已还原到**准备前的原值**（不是常量 1）；
 *   - 原值没记录（本工具从未关过动画 / 记录丢了）→ 写回默认 1，回执必须点名「原值未知」；
 *   - 恢复后读不回或读回不等于目标 → 分别报通道问题与写入未生效。
 * @param check - `checkAnimRestore` 的结果。
 * @param expected - 本次写回的目标值表。
 * @param unknown - 原值未知（写回默认 1）的键。
 * @returns 成功行（ok）或失败行（不 ok）。
 */
export function animRestoreVerdict(
  check: AnimScaleCheck,
  expected: AnimScales,
  unknown: readonly string[],
): { ok: boolean; text: string } {
  const unknownNote = unknown.length > 0
    ? '；原值未记录，已写回默认 1 的键：' + unknown.join(', ')
    : ''
  if (check.ok) {
    return { ok: true, text: '动画：已恢复原值（' + animReadbackText(expected) + unknownNote + '）' }
  }
  const parts: string[] = []
  if (check.unreadable.length > 0) {
    parts.push('读不回 ' + check.unreadable.join(', ') + '（通道未回值，不代表已恢复）')
  }
  if (check.mismatched.length > 0) {
    parts.push('未生效 ' + check.mismatched.join(', ') + '（写入后读回与目标不一致）')
  }
  return {
    ok: false,
    text: '动画未恢复到目标值（读回 ' + animReadbackText(check.readback)
      + '；期望 ' + animReadbackText(expected) + '；' + parts.join('；') + unknownNote + '）',
  }
}
