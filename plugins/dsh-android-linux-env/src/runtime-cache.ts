/**
 * 运行时缓存清理（0.14.1 块 E，设计 = `docs/0.14.1-preview-LEGACY-AND-PERF.md` §4.3）。
 *
 * 语义边界：清的是**引擎运行时残留**（可再生、与用户数据无关的中间产物），不是 Android 的
 * 「应用缓存」目录，也不是任何用户资产。
 *
 * 四条硬约束（逐条对应 §4.3 的判据，实现只依赖这些不变量）：
 *
 * ① **白名单制**：唯一可删的东西是本文件 `scanTargets()` 枚举出来的**具体项**；任何不在该枚举
 *    里的路径一律不删。`DSH_HOME` 下与用户资产同树（`sessions/`、`storages/`、`attachments/`、
 *    `.credentials.yaml`、`settings.yaml`、`profiles/**`、`workspaces/` 等）因此天然免疫——
 *    它们不是「黑名单被挡住」，而是从未进入删除通道。
 * ② **保留当前代**：`engine.log.1..N` 可删，但当前代 `engine.log` 绝不删——壳侧鉴权链
 *    `EngineAuth.tokenFromLog` 从它解析 launch token（`EngineManager.kt:191` 的
 *    `File(context.filesDir, "engine.log")`），删了整条 `/api` 鉴权断链。日志根目录从
 *    `$DSH_FILES_DIR`（壳侧注入点 `EngineManager.kt:1316`）解析，不写死。
 * ③ **不得硬编码路径**：`DSH_HOME` 经 `$DSH_HOME`（壳侧注入点 `EngineManager.kt:1314`
 *    `ensurePrivateDshData()`）解析，未注入才回落 `~/.dsh`；候选子目录**运行期探测存在性**；
 *    未识别/不存在的路径显式跳过并如实上报，绝不猜着删。
 * ④ **失败不得改坏引擎**：逐项独立执行、每项后落审计、单项异常只让该项标 failed，不中断其余项，
 *    不强删/降权/改权限。删除只做两件事：取消链接文件、删除空目录。
 *
 * 明确**不纳入**（§4.3 表）：
 *  - pnpm/npm store 陈旧项：与已装插件强耦合，误删会让 `dsh plugin add` 重下；
 *  - 快照解压残留（`.snapshot-transaction` / `.snapshot-transaction.tmp`）：它是在途标志，删掉会让
 *    「刷新是否完成」失去唯一判据；
 *  - 整目录删除：`DSH_HOME/cache/**` 一律**按子目录分别裁定**（见 `CACHE_SUBDIR_ALLOW`；本版该表
 *    为空集 = `cache/**` 全部显式跳过，理由见其注释）；
 *  - 无据可查的目录名（如 `pip` / `dsh-vision-toolkit`）：名字像缓存不构成「可安全再生」的依据，
 *    不得照名字猜着删——只清理本版有据可查的项。
 */
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 日志世代探测上限：与壳侧 `ENGINE_LOG_GENERATIONS` 同量级，多留不误删（不存在即跳过）。 */
const MAX_LOG_GENERATIONS = 32

/** 当前代文件名（**绝不删**：壳侧 `tokenFromLog` 的唯一输入）。 */
export const CURRENT_ENGINE_LOG = 'engine.log'

/** 历史代文件名模式（`engine.log.1` .. `engine.log.N`）。 */
const ROTATED_LOG = /^engine\.log\.(\d+)$/

/**
 * `DSH_HOME/cache/**` 的子目录白名单：**逐子目录裁定**，只列「删掉后引擎能自行重建且不丢用户语义」
 * 且**在本仓有据可查**的子目录。
 *
 * 为什么整目录删不行：`cache/` 下既有可再生产物，也可能有引擎自管缓存（0.1.6-alpha.1 起
 * `cache/attachments/request-images` 是引擎自管的请求图片缓存，见
 * `docs/UPSTREAM-0.1.6-ALPHA2-DELTA-2026-09-17.md:257`）。整目录删会把它一起带走，而它是否
 * 可再生属上游语义——所以**未列入本表的子目录一律跳过并上报**（覆盖面随上游变化是有意为之）。
 *
 * **本版为空集，这是判定的结果而不是漏写**：本仓没有对任何 `cache/` 子目录给出「可安全再生」的
 * 依据（§4.3 的判据要求逐条成立才删；`pip` 之类看起来像工具缓存的目录名，在本仓无证据证明它就是
 * 那个缓存，照名字猜着删正是 §4.3⑤ 禁止的「猜测性删除」）。因此本版 `cache/**` **全部显式跳过**，
 * 并在结果里逐项上报 `not-allowlisted`；将来拿到上游/设备证据时只需往本表加名字。
 */
const CACHE_SUBDIR_ALLOW = new Set<string>([])

/**
 * `DSH_HOME` 下**有据可查**的可再生缓存项（顶层名 → 依据）。
 *
 * 仅一项，且是三条独立证据的交汇：
 *  - `EngineManager.kt:1350`：`NODE_COMPILE_CACHE` 指向 `ensurePrivateDshData()/.node-compile-cache`
 *    ——即它就是 `DSH_HOME` 下的 V8 编译缓存目录，不是猜的；
 *  - `SnapshotUserData.kt:33` 把它列进 `preservedNames`（快照刷新不覆盖它）；
 *  - `docs/0.14.3-preview-PARALLEL-AGENT.md:654` 明确：它在保留名单里**不代表不可删**，
 *    属可再生产物（两项语义要分开）。
 *
 * 与 `cache/**` 的关系：`cache/` 整目录**永远不删**（见 `PRESERVED_TOP`），本表是独立的白名单项。
 */
const HOME_CACHE_ALLOW = new Map<string, string>([
  ['.node-compile-cache', 'NODE_COMPILE_CACHE（EngineManager.kt:1350）+ 可再生产物（§12.2）'],
])

/** DSH_HOME 下**永不触碰**的顶层名（§4.3② 硬清单与 §12.2 的 preservedNames 同口径）。 */
const PRESERVED_TOP = [
  'sessions',
  'storages',
  'attachments',
  'workspaces',
  'undo-snapshots',
  'llm-deepseek',
  '.credentials.yaml',
  'settings.yaml',
  '.anonymous-user-id',
  '.private-layout',
  'models-store.json',
  'profiles',
  'cache',
] as const

/** 一个白名单命中的清理项。 */
export interface CleanupTarget {
  /** 稳定 id（审计与 UI 展示用）。 */
  id: string
  /** 类别：引擎日志历史代 / `cache/**` 子目录 / `DSH_HOME` 下有名有据的缓存目录。 */
  kind: 'engine-log-generation' | 'cache-subdirectory' | 'home-cache-directory'
  /** 绝对路径。 */
  path: string
  /** 实测可回收字节（目录递归求和）。 */
  bytes: number
  /** 命中项数（目录项递归计数；单文件为 1）。 */
  files: number
}

/** 显式跳过项（未识别/不存在/被硬清单拒绝），如实上报，不静默。 */
export interface CleanupSkip {
  /** 稳定 id。 */
  id: string
  /** 绝对路径或候选名。 */
  path: string
  /** 跳过原因（机器可读短码）。 */
  reason: string
}

/** 扫描结果：可回收项 + 跳过项 + 汇总字节。 */
export interface CleanupPlan {
  /** 解析出的 DSH_HOME（绝对路径）。 */
  dshHome: string
  /** 日志根目录（壳侧 `files` 域，来自 `$DSH_FILES_DIR`）；未注入时为 `''`。 */
  logRoot: string
  /** 白名单命中、可执行删除的项。 */
  targets: CleanupTarget[]
  /** 显式跳过项。 */
  skipped: CleanupSkip[]
  /** `targets` 的字节合计——执行前的可回收体积。 */
  reclaimableBytes: number
}

/** 单项执行结果（审计单位 = 一项）。 */
export interface CleanupItemResult {
  /** 对应 `CleanupTarget.id`。 */
  id: string
  /** 绝对路径。 */
  path: string
  /** 执行结果。 */
  status: 'removed' | 'failed' | 'skipped'
  /** 实际释放字节（`removed` 时 = 扫描值，其余为 0）。 */
  bytes: number
  /** 失败/跳过原因（`removed` 时缺席）。 */
  reason?: string
}

/** 执行结果总览。 */
export interface CleanupReport {
  /** 逐项结果（顺序 = 扫描顺序）。 */
  items: CleanupItemResult[]
  /** 实际释放字节合计。 */
  removedBytes: number
  /** 成功项数。 */
  removed: number
  /** 失败项数。 */
  failed: number
}

/**
 * 解析引擎实际使用的 DSH_HOME。
 *
 * 优先级与上游 `resolveDshHome`（`dsh/packages/util/home-paths/src/index.ts:87`）逐条一致：
 * `$DSH_HOME` 优先（壳侧 `EngineManager.kt:1314` 注入 `ensurePrivateDshData()`），未注入才回落
 * `~/.dsh`。空/纯空白视为未设置——绝不把 home 解析成当前工作目录。
 *
 * 为什么不直接 import 上游 `@deepseek-ai/dsh-home-paths`：本插件走 `tsc` 直译、不做打包，
 * 该包不在注入集（`scripts/plugin-dirs.json`）的依赖闭合里，加进去会让快照装配期
 * `ERR_MODULE_NOT_FOUND`。语义与上游等价，且本函数只被本文件消费。
 * @param configured - 显式覆盖（当前无调用方；为测试与将来的 config 字段保留）。
 * @param env - 环境映射（默认真实环境）。
 * @returns 归一化的绝对路径。
 */
export function resolveHarnessHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.DSH_HOME
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'))
  return resolve(selected)
}

/**
 * 解析日志根目录。
 *
 * 真源 = 壳侧注入的 `$DSH_FILES_DIR`（`EngineManager.kt:1316` 的 `context.filesDir`），引擎
 * `engine.log` 就落在它下面（`EngineManager.kt:836`）。
 * @param env - 环境映射。
 * @returns 绝对路径；未注入时返回 `''`（调用方据此显式跳过，不猜路径）。
 */
export function engineLogRoot(env: Record<string, string | undefined> = process.env): string {
  const dir = env.DSH_FILES_DIR
  return dir !== undefined && dir.trim() !== '' ? dir : ''
}

/**
 * 判定一名顶层条目是否属硬清单（永不触碰）。
 * @param name - `DSH_HOME` 下的顶层名。
 * @returns `true` = 保留。
 */
export function isPreserved(name: string): boolean {
  return (PRESERVED_TOP as readonly string[]).includes(name)
}

/** 递归求目录/文件的字节与项数；符号链接按链接本身体积计（不跟随，避免越界）。 */
function measure(path: string): { bytes: number; files: number } {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return { bytes: stat.isFile() ? stat.size : 0, files: 1 }
  let bytes = 0
  let files = 0
  for (const name of readdirSync(path)) {
    try {
      const inner = measure(join(path, name))
      bytes += inner.bytes
      files += inner.files
    } catch {
      /* 不可读子项不计入体积：执行阶段该项会失败并如实上报，不阻断其余项 */
    }
  }
  return { bytes, files }
}

/** 递归删一个白名单命中的目录：逐文件取消链接，目录自底向上 rmdir。 */
function removeTree(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const name of readdirSync(path)) {
    const child = join(path, name)
    if (lstatSync(child).isDirectory()) removeTree(child)
    else unlinkSync(child)
  }
  rmdirSync(path)
}

/**
 * 枚举白名单候选（**唯一删除依据**）。
 * @param dshHome - 已解析的 `DSH_HOME`。
 * @param logRoot - 已解析的日志根目录（`''` = 不可用）。
 * @returns 命中项与跳过项。
 */
export function scanTargets(dshHome: string, logRoot: string): { targets: CleanupTarget[]; skipped: CleanupSkip[] } {
  const targets: CleanupTarget[] = []
  const skipped: CleanupSkip[] = []

  // ── 引擎日志历史代：保留当前代 ──────────────────────────────────────────────
  if (logRoot === '') {
    skipped.push({ id: 'engine-log-root', path: '$DSH_FILES_DIR', reason: 'log-root-unresolved' })
  } else {
    if (!existsSync(join(logRoot, CURRENT_ENGINE_LOG))) {
      // 当前代不在场不阻止清理历史代（引擎可能尚未启动），但如实上报这一事实。
      skipped.push({ id: 'engine-log-current', path: join(logRoot, CURRENT_ENGINE_LOG), reason: 'current-generation-absent' })
    }
    for (let generation = 1; generation <= MAX_LOG_GENERATIONS; generation += 1) {
      const candidate = join(logRoot, CURRENT_ENGINE_LOG + '.' + String(generation))
      if (!existsSync(candidate)) continue
      try {
        const measured = measure(candidate)
        targets.push({
          id: 'engine-log-' + String(generation),
          kind: 'engine-log-generation',
          path: candidate,
          bytes: measured.bytes,
          files: measured.files,
        })
      } catch {
        skipped.push({ id: 'engine-log-' + String(generation), path: candidate, reason: 'unreadable' })
      }
    }
  }

  // ── DSH_HOME/cache/**：只按子目录分别裁定（整目录删被禁） ────────────────────
  const cacheRoot = join(dshHome, 'cache')
  if (!existsSync(cacheRoot)) {
    skipped.push({ id: 'cache-root', path: cacheRoot, reason: 'absent' })
  } else {
    let entries: string[]
    try {
      entries = readdirSync(cacheRoot)
    } catch {
      skipped.push({ id: 'cache-root', path: cacheRoot, reason: 'unreadable' })
      entries = []
    }
    for (const name of entries.sort()) {
      const candidate = join(cacheRoot, name)
      if (!CACHE_SUBDIR_ALLOW.has(name)) {
        // 未列入白名单的子目录（含引擎自管的 request-images 一类）：显式跳过并上报，不静默。
        skipped.push({ id: 'cache-' + name, path: candidate, reason: 'not-allowlisted' })
        continue
      }
      if (isPreserved(name)) {
        skipped.push({ id: 'cache-' + name, path: candidate, reason: 'preserved' })
        continue
      }
      try {
        const measured = measure(candidate)
        targets.push({
          id: 'cache-' + name,
          kind: 'cache-subdirectory',
          path: candidate,
          bytes: measured.bytes,
          files: measured.files,
        })
      } catch {
        skipped.push({ id: 'cache-' + name, path: candidate, reason: 'unreadable' })
      }
    }
  }

  // ── DSH_HOME 下有名有据的缓存目录（依据见 HOME_CACHE_ALLOW） ────────────────
  for (const name of [...HOME_CACHE_ALLOW.keys()].sort()) {
    const candidate = join(dshHome, name)
    if (!existsSync(candidate)) {
      skipped.push({ id: 'home-cache-' + name, path: candidate, reason: 'absent' })
      continue
    }
    try {
      const measured = measure(candidate)
      targets.push({
        id: 'home-cache-' + name,
        kind: 'home-cache-directory',
        path: candidate,
        bytes: measured.bytes,
        files: measured.files,
      })
    } catch {
      skipped.push({ id: 'home-cache-' + name, path: candidate, reason: 'unreadable' })
    }
  }
  return { targets, skipped }
}

/**
 * 扫描一条完整清理计划（只读，无副作用）。
 * @param env - 环境映射（默认 `process.env`；`DSH_HOME`/`DSH_FILES_DIR` 的真源）。
 * @returns 计划：可回收项、跳过项、可回收字节。
 */
export function planCleanup(env: Record<string, string | undefined> = process.env): CleanupPlan {
  const dshHome = resolveHarnessHome(undefined, env)
  const logRoot = engineLogRoot(env)
  const { targets, skipped } = scanTargets(dshHome, logRoot)
  const allowed = targets.filter((target) => insideAllowedScope(target.path, dshHome, logRoot))
  for (const target of targets) {
    if (!allowed.includes(target)) skipped.push({ id: target.id, path: target.path, reason: 'scope-rejected' })
  }
  return {
    dshHome,
    logRoot,
    targets: allowed,
    skipped,
    reclaimableBytes: allowed.reduce((sum, target) => sum + target.bytes, 0),
  }
}

/**
 * 执行清理计划：**逐项删、每项后落审计回调、单项失败不中断其余项**。
 *
 * 调用方必须先展示 `plan.reclaimableBytes` 并由用户确认（§4.3③「先给出可回收体积再执行」）。
 * @param plan - `planCleanup` 的产物。
 * @param options - `audit` 每项完成后的审计回调；`shouldStop` 返回 true 时在**当前项之后**停止
 *   （执行可中断：已完成项保持已删除，未开始项一律不动，不留半删状态）；`remove` 为删除动作的
 *   测试接缝（缺省 = `removeTree`；仅用于**故障注入**断言「单项失败不改坏其余项」）。
 * @returns 逐项结果与汇总。
 */
export function executeCleanup(
  plan: CleanupPlan,
  options: {
    audit?: (entry: CleanupItemResult) => void
    shouldStop?: () => boolean
    remove?: (path: string) => void
  } = {},
): CleanupReport {
  const remove = options.remove ?? removeTree
  const items: CleanupItemResult[] = []
  for (const target of plan.targets) {
    if (options.shouldStop?.() === true) {
      // 中断：剩余项标 skipped（未触碰），而不是默默丢掉——调用方据此如实上报。
      items.push({ id: target.id, path: target.path, status: 'skipped', bytes: 0, reason: 'aborted' })
      continue
    }
    let result: CleanupItemResult
    try {
      // 执行前对每一项再复核作用域：扫描与执行之间若有任何状态漂移，拒绝而非误删。
      if (!insideAllowedScope(target.path, plan.dshHome, plan.logRoot)) {
        result = { id: target.id, path: target.path, status: 'skipped', bytes: 0, reason: 'scope-rejected' }
      } else if (!existsSync(target.path)) {
        result = { id: target.id, path: target.path, status: 'skipped', bytes: 0, reason: 'vanished' }
      } else {
        remove(target.path)
        result = { id: target.id, path: target.path, status: 'removed', bytes: target.bytes }
      }
    } catch (error) {
      // 失败一律捕获如实上报：不为「清干净」强删/降权/改权限。
      result = {
        id: target.id,
        path: target.path,
        status: 'failed',
        bytes: 0,
        reason: String((error as Error | undefined)?.message ?? error),
      }
    }
    items.push(result)
    if (options.audit !== undefined) {
      try {
        options.audit(result)
      } catch {
        /* 审计面不可用不改变删除结果（该项已 settled） */
      }
    }
  }
  const removedItems = items.filter((item) => item.status === 'removed')
  return {
    items,
    removedBytes: removedItems.reduce((sum, item) => sum + item.bytes, 0),
    removed: removedItems.length,
    failed: items.filter((item) => item.status === 'failed').length,
  }
}

/**
 * 面向 UI/审计的展示标签：绝不把应用私有目录的绝对路径下发到页面。
 * @param path - 绝对路径。
 * @param plan - 提供 `dshHome` 与 `logRoot` 的计划。
 * @returns `$DSH_HOME/...` 或 `$DSH_FILES_DIR/...` 形式的标签；不在两个根下时返回 `<unknown>`。
 */
export function displayLabel(path: string, plan: Pick<CleanupPlan, 'dshHome' | 'logRoot'>): string {
  if (plan.logRoot !== '') {
    const underLog = relativeUnder(path, plan.logRoot)
    if (underLog !== undefined && underLog !== '') return '$DSH_FILES_DIR/' + underLog
  }
  const underCache = relativeUnder(path, join(plan.dshHome, 'cache'))
  if (underCache !== undefined && underCache !== '') return '$DSH_HOME/cache/' + underCache
  const underHome = relativeUnder(path, plan.dshHome)
  if (underHome !== undefined && underHome !== '') return '$DSH_HOME/' + underHome
  return '<unknown>'
}

/** 统一成 `/` 分隔后比较：Windows 上 `join()` 产出 `\`，两侧混杂会漏判（本仓跨平台单测实测）。 */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 判断 `path` 是否落在 `root` 之下，返回相对片段（`undefined` = 不在其下）。
 * 按 `posix` 归一化两侧，避免 Windows 反斜杠与 `/` 混用导致漏判。
 */
function relativeUnder(path: string, root: string): string | undefined {
  const normalizedPath = toPosix(path)
  const normalizedRoot = toPosix(root).replace(/\/+$/, '')
  if (normalizedPath === normalizedRoot) return ''
  if (!normalizedPath.startsWith(normalizedRoot + '/')) return undefined
  return normalizedPath.slice(normalizedRoot.length + 1)
}

/**
 * 断言一条删除路径在白名单作用域内（执行前的防御性复核）。
 *
 * 三段独立判定，任一段不成立即拒绝。这是与 `scanTargets()` **相互独立**的第二道闸门：即便扫描面
 * 被改坏（把 `cache/attachments`、`sessions/` 之类塞进了计划），执行面仍然拒绝。
 *  1. `DSH_HOME/cache/<seg>`：`<seg>` **必须**再次命中 `CACHE_SUBDIR_ALLOW`（本版为空集 → 全拒）；
 *     两端以路径分隔符对齐，避免 `cache` 前缀匹配到 `cachefoo`；
 *  2. `DSH_HOME/<name>`：`<name>` 必须在 `HOME_CACHE_ALLOW` 且不在硬清单里；
 *  3. 日志根的 `engine.log.<N>` 一族（当前代 `engine.log` 与任何其它名字都拒绝）。
 * @param path - 待删的绝对路径。
 * @param dshHome - 已解析的 `DSH_HOME`。
 * @param logRoot - 已解析的日志根（`''` = 不可用）。
 * @returns `true` = 在白名单作用域内。
 */
export function insideAllowedScope(path: string, dshHome: string, logRoot: string): boolean {
  const underCache = relativeUnder(path, join(dshHome, 'cache'))
  if (underCache !== undefined && underCache !== '') {
    const segment = underCache.split('/')[0] ?? ''
    return CACHE_SUBDIR_ALLOW.has(segment) && !isPreserved(segment)
  }
  const underHome = relativeUnder(path, dshHome)
  if (underHome !== undefined && underHome !== '' && !underHome.includes('/')) {
    return HOME_CACHE_ALLOW.has(underHome) && !isPreserved(underHome)
  }
  if (logRoot === '') return false
  const underLog = relativeUnder(path, logRoot)
  return underLog !== undefined && underLog !== '' && ROTATED_LOG.test(underLog)
}
