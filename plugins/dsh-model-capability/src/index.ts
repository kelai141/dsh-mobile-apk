/**
 * dsh-model-capability — host-side capability discovery for user-declared provider
 * routes (issues #122 / #125: a custom provider has no selectable reasoning effort).
 *
 * Sources, in strict order — a capability that no source states stays absent:
 *   1. `endpoint-descriptor` — a passive GET of metadata the endpoint itself returns;
 *   2. `vendor-descriptor`  — explicit capability schemas (OpenRouter / Google / Ollama);
 *   3. `engine-catalog`     — exact model-id lookup in the pi-ai vendor catalogs the
 *      engine ships (a vendor *declaration*, never a name heuristic);
 *   4. `active-probe`       — only with explicit approval, and only after a negative
 *      control proves the endpoint actually validates the effort field.
 *
 * Write-back is opt-in per call (or by the startup pass) and field-level: it only
 * fills missing model-level fields and never overwrites a value the user declared.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DIALECT_COMPAT_KEYS,
  THINKING_LEVELS,
  probePassive,
  probeReasoningEfforts,
  type FetchLike,
  type ModelCapabilities,
  type ProbeReport,
  type ReasoningEfforts,
} from './capability-probe.js'
import { hasCapabilities, lookupCatalog, type CatalogSnapshot } from './catalog-lookup.js'
import { providerFromSettings, type SettingsLike } from './settings-config.js'
import { applyModelPatch, createStampStore, type ModelPatch, type SettingsWriteLike } from './settings-writer.js'
import { capabilitySignature } from './signature.js'

export const name = 'dsh-model-capability'

/** `settings` is the write-back seam; `tools` registers the discovery tools. */
export const inject = ['tools', 'settings'] as const

export {
  THINKING_LEVELS,
  probePassive,
  probeReasoningEfforts,
  parseDescriptor,
  parseOllamaShow,
  effortsFrom,
} from './capability-probe.js'
export type {
  ActiveProbeResult,
  ModelCapabilities,
  ProbeReport,
  ProviderConfig,
  ReasoningEfforts,
  ThinkingLevel,
} from './capability-probe.js'
export { providerFromSettings } from './settings-config.js'
export type { SettingsLike } from './settings-config.js'
export { lookupCatalog, effortsOf, hasCapabilities } from './catalog-lookup.js'
export type { CatalogEntry, CatalogMatch, CatalogSnapshot } from './catalog-lookup.js'
export { planModelPatch, applyModelPatch } from './settings-writer.js'
export type { ModelPatch, PlanResult, WriteResult } from './settings-writer.js'

export interface PluginConfig {
  /** Fill missing model capabilities automatically on startup (default true). */
  autoApply?: boolean
  /** Seconds to wait after startup before the automatic pass (default 8). */
  startupDelaySeconds?: number
  /** Seconds between capability-signature polls (default 5; in-memory read, no disk I/O). */
  pollIntervalSeconds?: number
  /** Restrict the automatic pass to these routes (default: every declared route). */
  routes?: string[]
}

interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

interface CtxLike {
  settings?: SettingsLike & SettingsWriteLike
  logger?: (name: string) => { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
  effect?: (fn: () => () => void) => void
  /** cordis 服务查询：未提供的服务返回 undefined（不要直接读 ctx.<service>——未 inject 会抛）。 */
  get?: (name: string) => unknown
  tools: { register(tool: unknown): void }
}

/** 可选服务读取：未声明 inject 时直接读属性会抛（cordis 4 实测），统一走 ctx.get。 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  try {
    const getter = (ctx as { get?: (n: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    return getter.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

let cachedSnapshot: CatalogSnapshot | undefined
let snapshotTried = false

/**
 * 诊断轨迹（DSH_MODEL_CAPABILITY_TRACE=0 可关）：追加到 $DSH_HOME/model-capability.log。
 * 引擎 stdout（engine.log）轮转很快、只留极短尾部，自动补给的静默失败在真机上无法定位——
 * 这条文件轨迹是现场排障的唯一可靠面（不含任何凭据）。
 */
function diag(message: string): void {
  if (process.env.DSH_MODEL_CAPABILITY_TRACE === '0') return
  try {
    const home = process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
    appendFileSync(`${home}/model-capability.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 诊断失败不影响主流程
  }
}

/** Loads the build-time catalog snapshot shipped beside this module. */
export function loadCatalogSnapshot(): CatalogSnapshot | undefined {
  if (snapshotTried) return cachedSnapshot
  snapshotTried = true
  try {
    cachedSnapshot = JSON.parse(readFileSync(new URL('./catalog-snapshot.json', import.meta.url), 'utf8')) as CatalogSnapshot
  } catch {
    cachedSnapshot = undefined
  }
  return cachedSnapshot
}

/**
 * Keep only the wire-dialect compat keys, and only when the catalog actually
 * declares a thinking format — a partial dialect (e.g. only maxTokensField)
 * would still let pi-ai fall back to a detected default (issue #134).
 * @param compat - unanimous compat map from the catalog lookup.
 * @returns the dialect keys to write, or undefined when the dialect is unknown.
 */
export function pickDialect(compat: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!compat || compat.thinkingFormat === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const key of DIALECT_COMPAT_KEYS) {
    const value = compat[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Injects catalog-derived capabilities into a probe report and recomputes unknowns. */export function mergeCatalog(
  report: ProbeReport,
  declared: string[],
  snapshot: CatalogSnapshot | undefined,
  api: string | undefined,
): ProbeReport {
  const byId = new Map<string, ModelCapabilities>(report.models.map((model) => [model.id, model]))
  for (const id of declared) {
    if (!byId.has(id)) {
      const fresh: ModelCapabilities = { id, sources: {} }
      byId.set(id, fresh)
      report.models.push(fresh)
    }
  }
  for (const model of byId.values()) {
    const match = lookupCatalog(snapshot, model.id, api)
    if (match.providers.length > 0) report.notes.push(`${model.id}: 引擎目录命中 ${match.providers.join('/')}`)
    for (const conflict of match.conflicts) report.notes.push(`${model.id}: ${conflict}`)
    const capabilities = match.capabilities
    // 方言优先（issue #134）：reasoningEfforts 只有在「pi-ai 知道该模型的方言」时才写。
    // 目录里同名模型来自多个厂商、thinkingFormat 冲突或缺失时，pi-ai 会按探测默认
    // （未知 baseURL → openai）序列化 reasoning_effort，真实网关可能直接 400。
    const dialect = pickDialect(capabilities.compat)
    if (dialect && !model.compat) {
      model.compat = dialect
    }
    if (capabilities.reasoningEfforts && !model.reasoningEfforts) {
      if (dialect) {
        model.reasoningEfforts = capabilities.reasoningEfforts
        model.sources.reasoningEfforts = 'engine-catalog'
      } else {
        report.notes.push(
          `${model.id}: 目录未给出统一 thinkingFormat（方言不明）——跳过 reasoningEfforts 写入，`
          + '避免按错误方言发送推理等级导致请求被拒；如需档位请在设置里显式声明 compat.thinkingFormat',
        )
      }
    }
    if (capabilities.input && !model.input) {
      model.input = capabilities.input
      model.sources.input = 'engine-catalog'
    }
    if (capabilities.contextWindow && !model.contextWindow) {
      model.contextWindow = capabilities.contextWindow
      model.sources.contextWindow = 'engine-catalog'
    }
    if (capabilities.maxTokens && !model.maxTokens) {
      model.maxTokens = capabilities.maxTokens
      model.sources.maxTokens = 'engine-catalog'
    }
  }
  report.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  report.unknown = declared.filter((id) => {
    const found = byId.get(id)
    return !found || Object.keys(found.sources).length === 0
  })
  return report
}

function summarize(report: ProbeReport): string {
  const lines = [`提供商路由 ${report.route}：抓取 ${report.fetched.length} 个端点，识别 ${report.models.length} 个模型`]
  for (const model of report.models) {
    const parts: string[] = []
    if (model.input) parts.push('模态 ' + model.input.join('/'))
    if (model.contextWindow) parts.push('上下文 ' + model.contextWindow)
    if (model.maxTokens) parts.push('输出上限 ' + model.maxTokens)
    if (model.reasoningEfforts) parts.push('推理等级 ' + Object.keys(model.reasoningEfforts).join('/'))
    const sources = Object.entries(model.sources).map(([key, source]) => `${key}<-${source}`).join(' ')
    lines.push(`- ${model.id}: ${parts.length > 0 ? parts.join('，') : '未声明任何能力'}${sources ? ' [' + sources + ']' : ''}`)
  }
  if (report.unknown.length > 0) lines.push(`未获得能力元数据：${report.unknown.join(', ')}`)
  for (const note of report.notes) lines.push('注：' + note)
  return lines.join('\n')
}

/** Turns a report into field-level patches, keeping each field's provenance. */
export function patchesFrom(report: ProbeReport): ModelPatch[] {
  const patches: ModelPatch[] = []
  for (const model of report.models) {
    const patch: ModelPatch = { id: model.id }
    let any = false
    if (model.reasoningEfforts) { patch.reasoningEfforts = model.reasoningEfforts; any = true }
    if (model.compat) { patch.compat = model.compat; any = true }
    if (model.input) { patch.input = model.input; any = true }
    if (model.contextWindow) { patch.contextWindow = model.contextWindow; any = true }
    if (model.maxTokens) { patch.maxTokens = model.maxTokens; any = true }
    if (any) {
      const sources = Object.values(model.sources)
      patch.source = [...new Set(sources)].join('+')
      patches.push(patch)
    }
  }
  return patches
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const c = ctx as unknown as CtxLike
  const settings = c.settings
  const log = c.logger?.('dsh-model-capability')
  const snapshot = loadCatalogSnapshot()
  diag(`apply(): settings=${settings ? 'yes' : 'no'} catalog=${snapshot ? `${snapshot.source} models=${String(snapshot.modelCount ?? 0)}` : 'absent'} autoApply=${String(config.autoApply)} startupDelay=${String(config.startupDelaySeconds ?? 8)}`)
  if (snapshot) log?.info?.(`catalog snapshot: ${snapshot.source} / ${String(snapshot.modelCount ?? 0)} models`)
  else log?.info?.('catalog snapshot absent — engine-catalog stage disabled')

  /** Resolves the route's API key: explicit settings value first, then the credential ref. */
  async function resolveConfig(route: string) {
    const config = providerFromSettings(settings, route)
    if (!config) return undefined
    const credentials = optionalService<CredentialsLike>(ctx, 'credentials')
    if (!config.apiKey && config.apiKeyEnv && credentials) {
      try {
        const resolved = await credentials.resolve(config.apiKeyEnv)
        if (resolved?.value) config.apiKey = resolved.value
      } catch {
        // 凭据不可读不阻断被动探测（有些端点 /models 免鉴权）
      }
    }
    return config
  }

  async function discover(route: string, options: { active?: boolean; confirm?: boolean; levels?: string[]; offline?: boolean } = {}) {
    const providerConfig = await resolveConfig(route)
    if (!providerConfig) {
      diag(`discover(${route}): providerFromSettings 返回 undefined（路由或 baseURL 不在 llm-pi-ai 里）`)
      return undefined
    }
    diag(`discover(${route}): baseURL=${providerConfig.baseURL} api=${providerConfig.api ?? '-'} models=${JSON.stringify(providerConfig.models ?? [])} apiKey=${providerConfig.apiKey ? 'yes' : 'no'}`)
    const fetchImpl = globalThis.fetch as unknown as FetchLike
    const report = options.offline
      ? { route, fetched: [], models: [], unknown: [...(providerConfig.models ?? [])], notes: [] } as ProbeReport
      : await probePassive(providerConfig, { fetchImpl })
    mergeCatalog(report, providerConfig.models ?? [], snapshot, providerConfig.api)
    if (options.active) {
      if (!options.confirm) {
        report.notes.push('active=true 但缺少 confirm=true（主动探测会消耗额度，需用户明确批准）——本次仅做被动发现')
      } else {
        const levels = options.levels && options.levels.length > 0 ? options.levels : ['low', 'medium', 'high']
        const url = providerConfig.baseURL.replace(/\/+$/, '') + '/chat/completions'
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(providerConfig.apiKey ? { authorization: `Bearer ${providerConfig.apiKey}` } : {}),
          ...(providerConfig.headers ?? {}),
        }
        // 负控（决策 D7）：端点若连无效值都接受，则「接受某个等级」不构成证据。
        const control = await probeReasoningEfforts({
          url, headers, levels: ['__dsh_invalid__'], fetchImpl, timeoutMs: 15_000,
          body: (level) => ({ model: report.models[0]?.id ?? '', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: level }),
        })
        const validates = control.rejected.length > 0
        if (!validates) {
          report.notes.push('负控失败：端点接受无效 reasoning_effort 值 → 接受性探测不可信，本次不据此写入等级（只保留被动/目录结论）')
        } else {
          for (const model of report.models) {
            if (model.reasoningEfforts) continue
            const result = await probeReasoningEfforts({
              url, headers, levels, fetchImpl,
              body: (level) => ({ model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: level }),
            })
            if (result.efforts) {
              model.reasoningEfforts = result.efforts
              model.sources.reasoningEfforts = 'active-probe'
            }
            if (result.rejected.length > 0) report.notes.push(`${model.id}: 端点拒绝的等级 ${result.rejected.map((r) => r.level).join(', ')}`)
            for (const item of result.inconclusive) report.notes.push(`${model.id}: 等级 ${item.level} 结果不确定（${item.reason}）`)
          }
        }
      }
    }
    return { providerConfig, report }
  }

  const probeTool = defineTool({
    name: 'model_capability_probe',
    description:
      'Discover capability metadata for a user-declared provider route: passive endpoint descriptors first, vendor schemas second, then an exact model-id lookup in the vendor catalogs the engine ships. ' +
      'Never infers capabilities from URLs or model names; unknown stays unknown. ' +
      'Active probes (which spend quota) run only when active=true and confirm=true, and are discarded when a negative control shows the endpoint does not validate the field. ' +
      'Set apply=true to write the discovered model-level capabilities back into settings (missing fields only).',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id, e.g. "my-gateway"' },
      active: { type: 'boolean', description: 'Also run active reasoning-effort probes (default false)' },
      confirm: { type: 'boolean', description: 'Explicit user approval for active probes (required when active=true)' },
      levels: { type: 'array', items: { type: 'string' }, description: 'Candidate effort words for active probes (default low/medium/high)' },
      apply: { type: 'boolean', description: 'Write discovered capabilities back to settings (missing fields only)' },
      offline: { type: 'boolean', description: 'Skip network entirely and use only the engine catalog (default false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          report: { type: 'object', additionalProperties: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; levels?: string[]; apply?: boolean; offline?: boolean }) => {
      const found = await discover(args.provider, args)
      if (!found) {
        return { ok: false, text: `未在 llm-pi-ai 设置中找到提供商路由「${args.provider}」或其 baseURL——请先在设置页填写自定义提供商。`, report: {} } as never
      }
      const { report } = found
      let applied: Record<string, unknown> | undefined
      if (args.apply) {
        const result = await applyModelPatch(settings, args.provider, patchesFrom(report), log)
        applied = result as unknown as Record<string, unknown>
        report.notes.push(result.wrote
          ? `已写回 ${result.changes.length} 项：${result.changes.join('；')}`
          : `未写回（${result.reason}）${result.changes.length > 0 ? '：' + result.changes.join('；') : ''}`)
      }
      return { ok: true, text: summarize(report), report, applied } as never
    },
  })

  const applyTool = defineTool({
    name: 'model_capability_apply',
    description:
      'Discover (engine catalog + passive endpoint metadata) and write back missing model-level capabilities for one user-declared provider route. ' +
      'Only fills fields the route does not declare; never overwrites a user value and never writes a provider-wide setting. ' +
      'Does not spend quota unless active=true and confirm=true.',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id' },
      active: { type: 'boolean', description: 'Also run active reasoning-effort probes (default false)' },
      confirm: { type: 'boolean', description: 'Explicit approval for active probes' },
      offline: { type: 'boolean', description: 'Use only the engine catalog (default true for apply)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; offline?: boolean }) => {
      const found = await discover(args.provider, { ...args, offline: args.offline ?? true })
      if (!found) {
        return { ok: false, text: `未找到提供商路由「${args.provider}」。` } as never
      }
      const result = await applyModelPatch(settings, args.provider, patchesFrom(found.report), log)
      const lines = [summarize(found.report)]
      lines.push(result.wrote
        ? `已写回：${result.changes.join('；')}`
        : `未写回（${result.reason}）`)
      if (result.skipped.length > 0) lines.push(`跳过：${result.skipped.join('；')}`)
      return { ok: true, text: lines.join('\n'), applied: result as unknown as Record<string, unknown> } as never
    },
  })

  ctx.tools.register(probeTool)
  ctx.tools.register(applyTool)
  log?.info?.('model_capability_probe / model_capability_apply registered')

  // 自动补给（决策 D5，对齐 model-sync 的启动轮）：延迟一轮，只做目录 + 被动，
  // 只写「缺失且无歧义」的字段；失败静默落日志。
  //
  // 回归场景（2026-09-10 用户口径）：用户在设置页「添加自定义供应商」后，
  // 不重启、不手改 settings.yaml，思考档位就应出现。settings 服务只对**自有命名空间**
  // 暴露 watch，故此处用「轻量签名轮询」：每 pollIntervalSeconds 读一次内存里的
  // llm-pi-ai 描述符（无磁盘 I/O），签名变化（新增路由/模型）即跑一轮补给。
  if (config.autoApply !== false && settings) {
    const delayMs = Math.max(0, config.startupDelaySeconds ?? 8) * 1000
    const pollMs = Math.max(2, config.pollIntervalSeconds ?? 5) * 1000
    let signature = ''

    const routesToConsider = (): string[] => {
      // describe(options) 的 options 被实现忽略 → 必须按 ns 查找（不能用 [0]）
      const descriptor = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
      const section = descriptor?.value as { providers?: Record<string, unknown> } | undefined
      return config.routes ?? Object.keys(section?.providers ?? {})
    }

    /**
     * 能力补给触发签名（0.14.0-preview / ST-03）：**值敏感**——含路由级键（baseURL/api 等）的规范化值
     * 与模型级能力字段的值，结构增删同样改变签名。旧实现只记「字段有无」，换网关/手改配置不触发重跑。
     * 见 src/signature.ts 与计划文档 §4.2 ST-03。
     */
    const signatureOf = (): string => {
      try {
        const descriptor = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
        return capabilitySignature(descriptor?.value, config.routes)
      } catch {
        return ''
      }
    }

    /** 来源戳：记录「该字段现在的值是我方写下的」，使新发现的值可刷新我方旧写入（用户手写值无戳）。 */
    const stamps = createStampStore()

    const runAutoPass = async () => {
      const routes = routesToConsider()
      diag(`runAutoPass: routes=${JSON.stringify(routes)}`)
      for (const route of routes) {
        try {
          const found = await discover(route, { offline: true })
          if (!found) continue
          diag(`runAutoPass(${route}): models=${found.report.models.length} efforts=${JSON.stringify(found.report.models.map((m) => [m.id, m.reasoningEfforts ?? null]))}`)
          const patches = patchesFrom(found.report).filter((patch) => patch.reasoningEfforts !== undefined)
          diag(`runAutoPass(${route}): patches=${patches.length}`)
          if (patches.length === 0) continue
          const result = await applyModelPatch(settings, route, patches, log, stamps)
          diag(`runAutoPass(${route}): wrote=${result.wrote} reason=${result.reason} changes=${JSON.stringify(result.changes)}`)
          if (result.wrote) log?.info?.(`auto-apply ${route}: ${result.changes.join('；')}`)
        } catch (error) {
          diag(`runAutoPass(${route}) failed: ${(error as Error)?.message ?? String(error)}`)
          log?.warn?.(`auto-apply ${route} failed: ${(error as Error)?.message ?? String(error)}`)
        }
      }
    }

    const tick = async () => {
      const next = signatureOf()
      diag(`tick: signature=${next.slice(0, 120)} changed=${next !== signature}`)
      if (next === signature) return
      signature = next
      await runAutoPass()
      // 写回会改变签名，刷新一次基线避免下一轮重复执行
      signature = signatureOf()
    }

    c.effect?.(() => {
      let stopped = false
      diag('auto-apply effect armed')
      const startup = setTimeout(() => { if (!stopped) void tick() }, delayMs)
      const interval = setInterval(() => { if (!stopped) void tick() }, pollMs)
      return () => {
        stopped = true
        clearTimeout(startup)
        clearInterval(interval)
      }
    })
  } else {
    diag(`auto-apply 未启用（autoApply=${String(config.autoApply)} settings=${settings ? 'yes' : 'no'}）`)
  }
}
