/**
 * Field-level settings write-back for discovered capabilities (0.13.5 W3)。
 *
 * Invariants (decision D6):
 *   - only *missing* fields are filled; a value the user already declared is
 *     never overwritten (not even with a "better" one);
 *   - only model-level entries are written — never a provider-wide setting;
 *   - the route's other keys and every other model's entry are left byte-identical;
 *   - one `set` on `providers.<route>.models` under the current revision, with a
 *     single re-read/retry on SETTINGS_CONFLICT (same protocol as model-sync).
 *
 * 0.14.0-preview（ST-03 / F-PLUG-02）追加**来源戳**：
 *   「只填空」有一个已知代价——端点能力若后来变了（换网关、供应商升级），我们上一轮写下的旧值
 *   会永久留存，因为它在「字段已存在」这条规则下不可再动。为此写回时记录「这个值是我们写的」
 *   （字段级来源戳，进程内），下一轮若**新发现的值与戳不同**，则允许覆盖**我们自己写下的**旧值；
 *   用户手写值没有戳，因此永不覆盖。进程重启后戳丢失 → 退回「只填空」（保守面，宁可不动）。
 */
import type { ReasoningEfforts } from './capability-probe.js'
import { canonicalJson } from './signature.js'

export interface ModelPatch {
  id: string
  reasoningEfforts?: ReasoningEfforts
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  compat?: Record<string, unknown>
  /** Provenance label recorded in the change log, e.g. 'engine-catalog'. */
  source?: string
}

/** 字段级来源戳：记录「该字段现在的值是我方在某个来源下写下的」。 */
export interface ProvenanceStamp {
  value: unknown
  source: string
}

export interface StampStore {
  get(modelId: string, field: string): ProvenanceStamp | undefined
  set(modelId: string, field: string, stamp: ProvenanceStamp): void
}

export function createStampStore(): StampStore {
  const map = new Map<string, Map<string, ProvenanceStamp>>()
  return {
    get(modelId, field) {
      return map.get(modelId)?.get(field)
    },
    set(modelId, field, stamp) {
      const fields = map.get(modelId) ?? new Map<string, ProvenanceStamp>()
      fields.set(field, stamp)
      map.set(modelId, fields)
    },
  }
}

/** 写回计划里「实际写入」的字段明细（用于记录来源戳与结构化日志）。 */
export interface WrittenField {
  id: string
  field: string
  value: unknown
}

export interface PlanResult {
  /** The complete models array to write (unchanged entries preserved verbatim). */
  models: unknown[]
  /** Human-readable list of fields actually added. */
  changes: string[]
  /** Model ids that were declared but could not be patched, with the reason. */
  skipped: string[]
  /** Machine-readable counterpart of [changes]. */
  written: WrittenField[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (isRecord(entry) && typeof entry.id === 'string') return entry.id
  return undefined
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

/**
 * 该字段是否可写：
 * - 缺失（只填空，既有语义）；或
 * - 现值**逐字等于**我方上一轮写下的戳值，且本轮发现值与之不同（源变化 → 允许刷新我方旧写入）。
 * 用户手写值没有戳 → 恒不可写。
 */
function canWrite(
  stamps: StampStore | undefined,
  id: string,
  field: string,
  current: unknown,
  next: unknown,
): boolean {
  if (isEmpty(current)) return true
  if (!stamps) return false
  const stamp = stamps.get(id, field)
  if (!stamp) return false
  if (canonicalJson(stamp.value) !== canonicalJson(current)) return false
  return canonicalJson(next) !== canonicalJson(current)
}

/**
 * Builds the write-back plan. [patches] are applied in order; the first patch for
 * a given id wins for a field that is still missing after earlier patches.
 */
export function planModelPatch(rawModels: unknown, patches: ModelPatch[], stamps?: StampStore): PlanResult {
  const models = Array.isArray(rawModels) ? [...rawModels] : []
  const changes: string[] = []
  const skipped: string[] = []
  const written: WrittenField[] = []
  if (models.length === 0) {
    for (const patch of patches) skipped.push(`${patch.id}: 路由未声明该模型（不凭空创建条目）`)
    return { models, changes, skipped, written }
  }

  for (const patch of patches) {
    const index = models.findIndex((entry) => idOf(entry) === patch.id)
    if (index < 0) {
      skipped.push(`${patch.id}: 路由未声明该模型（不凭空创建条目）`)
      continue
    }
    let entry = models[index]
    if (typeof entry === 'string') entry = { id: entry }
    if (!isRecord(entry)) {
      skipped.push(`${patch.id}: 条目形态无法写入`)
      continue
    }
    const next: Record<string, unknown> = { ...entry }
    const tag = patch.source ? ` (${patch.source})` : ''
    const source = patch.source ?? ''

    if (patch.reasoningEfforts && canWrite(stamps, patch.id, 'reasoningEfforts', next.reasoningEfforts, patch.reasoningEfforts)) {
      next.reasoningEfforts = patch.reasoningEfforts
      changes.push(`${patch.id}: 补 reasoningEfforts=${Object.keys(patch.reasoningEfforts).join('/')}${tag}`)
      written.push({ id: patch.id, field: 'reasoningEfforts', value: patch.reasoningEfforts })
    }
    if (patch.input && patch.input.length > 0 && canWrite(stamps, patch.id, 'input', next.input, patch.input)) {
      next.input = patch.input
      changes.push(`${patch.id}: 补 input=${patch.input.join('/')}${tag}`)
      written.push({ id: patch.id, field: 'input', value: patch.input })
    }
    if (typeof patch.contextWindow === 'number' && canWrite(stamps, patch.id, 'contextWindow', next.contextWindow, patch.contextWindow)) {
      next.contextWindow = patch.contextWindow
      changes.push(`${patch.id}: 补 contextWindow=${patch.contextWindow}${tag}`)
      written.push({ id: patch.id, field: 'contextWindow', value: patch.contextWindow })
    }
    if (typeof patch.maxTokens === 'number' && canWrite(stamps, patch.id, 'maxTokens', next.maxTokens, patch.maxTokens)) {
      next.maxTokens = patch.maxTokens
      changes.push(`${patch.id}: 补 maxTokens=${patch.maxTokens}${tag}`)
      written.push({ id: patch.id, field: 'maxTokens', value: patch.maxTokens })
    }
    if (patch.compat) {
      const existingCompat = isRecord(next.compat) ? { ...next.compat } : {}
      const added: string[] = []
      const addedEntries: Array<[string, unknown]> = []
      for (const [key, value] of Object.entries(patch.compat)) {
        if (canWrite(stamps, patch.id, `compat.${key}`, existingCompat[key], value)) {
          existingCompat[key] = value
          added.push(key)
          addedEntries.push([`compat.${key}`, value])
        }
      }
      if (added.length > 0) {
        next.compat = existingCompat
        changes.push(`${patch.id}: 补 compat.${added.join(',')}${tag}`)
        for (const [field, value] of addedEntries) written.push({ id: patch.id, field, value })
      }
    }

    if (changes.length > 0 || next !== entry) models[index] = next
  }

  return { models, changes, skipped, written }
}

export interface SettingsDescriptorLike {
  ns: string
  value: unknown
  revision: number
}

export interface SettingsWriteLike {
  describe(options?: { namespaces?: readonly string[] }): SettingsDescriptorLike[]
  mutate(ns: string, ops: unknown[], expectedRevision?: number): Promise<unknown>
}

export interface WriteResult {
  wrote: boolean
  reason: string
  changes: string[]
  skipped: string[]
  written?: WrittenField[]
}

function modelsOf(descriptor: SettingsDescriptorLike, route: string): unknown {
  const section = isRecord(descriptor.value) ? descriptor.value : {}
  const providers = isRecord(section.providers) ? section.providers : {}
  const routeConfig = isRecord(providers[route]) ? providers[route] as Record<string, unknown> : {}
  return routeConfig.models
}

/**
 * Applies [patches] to one route's model list. Returns what happened; never throws
 * for an ordinary rejection (the caller reports it).
 *
 * [stamps] 可选：成功写入后把「我方写下的值」记入戳表；下一轮据此才允许刷新我方旧写入。
 */
export async function applyModelPatch(
  settings: SettingsWriteLike | undefined,
  route: string,
  patches: ModelPatch[],
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
  stamps?: StampStore,
): Promise<WriteResult> {
  if (!settings) return { wrote: false, reason: 'settings-unavailable', changes: [], skipped: [] }
  if (patches.length === 0) return { wrote: false, reason: 'nothing-to-apply', changes: [], skipped: [] }

  const sourceOf = new Map(patches.map((patch) => [patch.id, patch.source ?? '']))

  const run = async (retry: boolean): Promise<WriteResult> => {
    const descriptor = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
    if (!descriptor) return { wrote: false, reason: 'namespace-absent', changes: [], skipped: [] }
    const plan = planModelPatch(modelsOf(descriptor, route), patches, stamps)
    if (plan.changes.length === 0) {
      return { wrote: false, reason: 'no-change', changes: [], skipped: plan.skipped, written: [] }
    }
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route, 'models'], value: plan.models }], descriptor.revision)
      if (stamps) {
        for (const field of plan.written) stamps.set(field.id, field.field, { value: field.value, source: sourceOf.get(field.id) ?? '' })
      }
      return { wrote: true, reason: 'wrote', changes: plan.changes, skipped: plan.skipped, written: plan.written }
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === 'SETTINGS_CONFLICT' && !retry) {
        logger?.info?.(`dsh-model-capability: SETTINGS_CONFLICT for route ${route}; retrying once`)
        return run(true)
      }
      logger?.warn?.(`dsh-model-capability: write-back failed for route ${route}: ${(error as Error)?.message ?? String(error)}`)
      return { wrote: false, reason: code === 'SETTINGS_CONFLICT' ? 'conflict-retry-failed' : 'mutate-rejected', changes: [], skipped: plan.skipped, written: [] }
    }
  }

  return run(false)
}
