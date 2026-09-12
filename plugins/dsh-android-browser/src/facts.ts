/**
 * 浏览器事实来源（按"实时性 x 可信度"排序，每次读取都带来源标签，禁止隐藏降级）。
 *
 *  1) 壳桥 browserCaps op（经 dsh-android-bridge 的 controlExec 走既有控制通道）——真实档位；
 *     op 未实现 / 超时 / 队列忙 都只作为"暂时拿不到"回落，绝不猜测能力；
 *  2) 壳侧注入的环境 JSON DSH_BROWSER_FACTS（壳侧/构建期提前联调的临时通道）；
 *  3) .deploy-tmp/iter-0140/browser-p0.md 的实测基线（**只读读数，不是能力承诺**）。
 */
import { BROWSER_OPS } from './contract.js'
import { MEASURED_DEVICE_BASELINE, type BrowserFacts } from './tier.js'

/** 一次事实读取的结果与来源。 */
export interface FactsRead {
  facts: BrowserFacts
  /** 来源标签（原样进工具返回与面板状态，供人核对"档位是不是实测出来的"）。 */
  source: string
  /** browserCaps 不可用时的原因（回落时在场，成功时缺省）。 */
  capsNote?: string
}

/** 控制通道最小面（dsh-android-bridge 的 AndroidPrivilegeService.controlExec）。 */
export interface ControlFace {
  controlExec?(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

const BOOLEAN_FIELDS = ['uaChAvailable', 'androidxWebkitCompiled', 'androidxWebkitAvailable', 'densityOverrideSupported', 'browserWebViewAvailable', 'cdpEnabled'] as const
const NUMBER_FIELDS = ['webviewMajor', 'screenWidth', 'screenHeight', 'densityDpi'] as const

/**
 * 从任意载荷里挑出 BrowserFacts 成员（未知键忽略、类型不符忽略：绝不半信半疑）。
 * @param value - browserCaps/data 或 env JSON 解析结果。
 * @returns 事实对象；一个字段都对不上时 undefined。
 */
export function pickFacts(value: unknown): BrowserFacts | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const src = value as Record<string, unknown>
  const out: BrowserFacts = {}
  let hit = 0
  for (const key of BOOLEAN_FIELDS) {
    if (typeof src[key] === 'boolean') { out[key] = src[key] as boolean; hit++ }
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof src[key] === 'number' && Number.isFinite(src[key])) { out[key] = src[key] as number; hit++ }
  }
  return hit === 0 ? undefined : out
}

/** env 通道 / 实测基线（同步；测试与"控制通道不可用"时使用）。 */
export function factsFromEnv(env: NodeJS.ProcessEnv = process.env): FactsRead {
  const raw = env.DSH_BROWSER_FACTS
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const picked = pickFacts(JSON.parse(raw))
      if (picked !== undefined) return { facts: picked, source: 'shell-env(DSH_BROWSER_FACTS)' }
    } catch {
      /* 解析失败按"未上报"处理 */
    }
  }
  return { facts: MEASURED_DEVICE_BASELINE, source: 'measured-baseline(p0-2026-09-12, MuMu/WebView110)' }
}

/** 壳桥 browserCaps 读取（异步；不可用返回 undefined 由调用方回落）。 */
export async function factsFromShell(control: ControlFace | undefined, timeoutMs = 1500): Promise<FactsRead | undefined> {
  if (control?.controlExec === undefined) return undefined
  try {
    const reply = await control.controlExec(BROWSER_OPS.caps, {}, timeoutMs)
    if (reply !== null && typeof reply === 'object') {
      const envelope = reply as { ok?: unknown; data?: unknown; error?: unknown }
      if (envelope.ok === true) {
        const picked = pickFacts(envelope.data)
        if (picked !== undefined) return { facts: picked, source: 'shell-op(' + BROWSER_OPS.caps + ')' }
        return undefined
      }
      if (envelope.ok === false) {
        return undefined
      }
      // 无信封（直接回载荷）也要接受：壳侧实现可简化返回值
      const picked = pickFacts(reply)
      if (picked !== undefined) return { facts: picked, source: 'shell-op(' + BROWSER_OPS.caps + ')' }
    }
  } catch {
    /* 控制通道异常：按"暂时拿不到"处理 */
  }
  return undefined
}

let cache: { at: number; value: FactsRead } | undefined

/** 清缓存（测试用；运行时缓存 TTL 见 readFacts）。 */
export function factsCacheReset(): void {
  cache = undefined
}

/**
 * 读取当前浏览器事实（带短 TTL 缓存，避免面板轮询把控制队列打满）。
 * @param options - env / 控制通道 / 缓存 TTL（毫秒）。
 * @returns 事实 + 来源标签（+ 回落原因）。
 */
export async function readFacts(options: { env?: NodeJS.ProcessEnv; control?: ControlFace; cacheTtlMs?: number } = {}): Promise<FactsRead> {
  const ttl = options.cacheTtlMs ?? 5000
  if (cache !== undefined && Date.now() - cache.at < ttl) return cache.value
  const envFallback = factsFromEnv(options.env ?? process.env)
  const fromShell = await factsFromShell(options.control)
  const value: FactsRead = fromShell ?? {
    ...envFallback,
    capsNote:
      options.control?.controlExec === undefined
        ? '控制通道不可用（bridge 服务缺席）'
        : 'browserCaps 未实现或超时（壳侧 op 待落地）',
  }
  cache = { at: Date.now(), value }
  return value
}
