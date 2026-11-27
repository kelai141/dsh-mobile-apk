/**
 * Stored-session deletion: resolve the session directory, refuse unsafe states,
 * then remove it in two steps (rename out of the way, then delete).
 *
 * The engine has no `session/delete` RPC (see issue #493), so this module owns
 * the on-disk half: sessions live under `<DSH_HOME>/sessions/<cwd-key>/<id>/`
 * with `session.lock` and `session.v4.jsonl.zstd`. Indexes reconcile from the
 * persistence listing, so a directory that disappears stops being listed.
 *
 * Safety rules:
 * - only `session-<uuid>` ids are accepted (no paths, no globs);
 * - a session with running work is refused; a loaded-but-idle one is allowed, and
 *   the caller unloads it through `afterRename` once the directory left the scan
 *   path (see `deleteStoredSession`);
 * - the id must resolve to exactly one directory (two matches are ambiguous and
 *   nothing is deleted);
 * - the directory is renamed first so a concurrent scan cannot observe a
 *   half-deleted session, then removed recursively.
 */
import { lstatSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

/** Session ids are the storage unit name; anything else is a path-injection attempt. */
export const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Structured failure carrying a stable code for the HTTP layer and tests. */
export class SessionDeleteError extends Error {
  /**
   * @param {string} code - stable machine code (`invalid-id` / `not-found` / `ambiguous` / `session-active` / `delete-failed`).
   * @param {string} message - human-readable reason.
   * @param {object} [details] - extra fields for diagnostics.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'SessionDeleteError'
    this.code = code
    this.details = details
  }
}

/**
 * Validate a session id.
 * @param {unknown} sessionId - caller-supplied id.
 * @returns {string} the id.
 * @throws {SessionDeleteError} `invalid-id` when the shape is wrong.
 */
export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionDeleteError('invalid-id', 'session id must be session-<uuid>')
  }
  return sessionId
}

/**
 * Sessions root for a DSH home.
 * @param {string} home - absolute `DSH_HOME`.
 * @returns {string} `<home>/sessions`.
 */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/**
 * Locate the one stored directory for a session.
 * @param {string} root - sessions root.
 * @param {string} sessionId - validated id.
 * @returns {Promise<string>} absolute session directory.
 * @throws {SessionDeleteError} `not-found` / `ambiguous`.
 */
export async function findSessionDir(root, sessionId) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SessionDeleteError('not-found', 'no sessions directory', { sessionId })
    throw error
  }
  const hits = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) hits.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (hits.length === 0) throw new SessionDeleteError('not-found', 'session not found', { sessionId })
  if (hits.length > 1) throw new SessionDeleteError('ambiguous', 'session id appears in more than one workspace directory', { sessionId, paths: hits })
  return hits[0]
}

/**
 * Delete one stored session.
 * @param {object} options - deletion inputs.
 * @param {string} options.home - absolute `DSH_HOME`.
 * @param {string} options.sessionId - session to delete.
 * @param {boolean} options.isActive - whether any provider reports running work for the session.
 * @param {(info: { sessionId: string, dir: string }) => Promise<void>} [options.beforeRemove] - bookkeeping hook
 *   (unarchive/unpin). issue #1617：它在目录已经离开扫描路径、内存会话已卸载**之后**才跑，
 *   失败只记 warn 不阻断删除——记账永远不是「删除失败但副作用已发生」的中间态来源。
 * @param {(info: { sessionId: string, dir: string }) => Promise<void>} [options.afterResolve] - runs once the directory is confirmed (unload the live session).
 * @param {(level: 'info'|'warn'|'error', message: string, extra?: object) => void} [options.logger] - step logger.
 * @param {(target: string, options: object) => Promise<void>} [options.removeDir] - directory remover.
 *   Injectable so a test can prove the **failure** path without needing a real unwritable directory
 *   (issue #1287 ②): the interesting behaviour is what we report, not how we provoke the errno.
 * @returns {Promise<{ ok: true, sessionId: string, dir: string }>} outcome.
 * @throws {SessionDeleteError} on every refused state.
 */
export async function deleteStoredSession({ home, sessionId, isActive, beforeRemove, afterResolve, logger, removeDir }) {
  const log = typeof logger === 'function' ? logger : () => {}
  assertSessionId(sessionId)
  log('info', 'delete requested', { sessionId, isActive: isActive === true })
  if (isActive === true) {
    throw new SessionDeleteError('session-active', 'the conversation is running; stop it before deleting', { sessionId })
  }
  if (typeof home !== 'string' || home === '') throw new SessionDeleteError('delete-failed', 'DSH_HOME is not available')
  const root = sessionsRoot(home)
  let stored
  try {
    stored = await findSessionDir(root, sessionId)
  } catch (error) {
    if (!(error instanceof SessionDeleteError) || error.code !== 'not-found') throw error
  }
  // #1587：永久删除覆盖这个 id 的全部隔离副本；枚举失败不能冒充 not-found。
  // 先完整定位，再开始删除：歧义或隔离区不可读时，不产生部分删除副作用。
  //
  // 边界（审查实测收窄）：隔离区的**形态异常**只在「一处都没命中」时才判失败。
  // 旧实现让任意工作区的杂散 .corrupt 文件升级成全局 delete-failed —— 目标会话完好、
  // 在别的工作区、却删不掉，且错误文案指向用户无法行动的「隔离区不是真目录」。
  const quarantineProblems = []
  const quarantined = await findQuarantinedDirs(root, sessionId, { onProblems: (p) => quarantineProblems.push(...p) })
  // #1587 第二条残留面：上一次删除把目录改名成 `<id>.deleting-*` 后 rm 失败/进程被杀，
  // 该目录既不在扫描路径上、也不在隔离区，却占着整份数据。不并进来就永远删不掉。
  const graveyards = await findGraveyardDirs(root, sessionId, { onProblem: (message) => quarantineProblems.push(message) })
  const dirs = [...(stored ? [stored] : []), ...quarantined, ...graveyards]
  if (dirs.length === 0) {
    if (quarantineProblems.length > 0) {
      throw new SessionDeleteError('delete-failed', quarantineProblems[0], { sessionId, paths: quarantineProblems })
    }
    throw new SessionDeleteError('not-found', 'session not found', { sessionId })
  }
  // 命中已存在：隔离区异常不阻断本次删除，但必须留痕（否则「清不掉」没有线索）。
  for (const problem of quarantineProblems) log('warn', 'quarantine anomaly ignored; the session itself was found', { sessionId, problem })
  for (const [index, dir] of dirs.entries()) {
    await deleteResolvedSessionDir({ sessionId, dir, log, removeDir,
      afterResolve: index === 0 ? afterResolve : undefined,
      beforeRemove: index === 0 ? beforeRemove : undefined })
  }
  await removeSessionProjectionCacheFile(home, sessionId, log)
  return { ok: true, sessionId, dir: dirs[0] }
}

/** Same rename/unload/remove transaction for a stored directory or an explicit quarantine deletion. */
async function deleteResolvedSessionDir({ sessionId, dir, log, removeDir, afterResolve, beforeRemove }) {
  log('info', 'resolved session directory', { sessionId, dir })
  // issue #1617：归档/置顶记账**不得**跑在 rename 之前。
  //
  // 旧实现先 unarchive/unpin、随后 rename 失败（EACCES/ENOSPC）→ 返回 500「删除失败」，会话还在
  // 列表里，但已悄悄退出归档/置顶。用户看到的失败与磁盘事实相反：真正发生的副作用没人告诉他。
  //
  // 现在记账挪到 rename **成功之后**（与 afterResolve 同段）：移动失败 = 什么都没发生，记账也
  // 就一次都没跑过。副作用与「目录已离开扫描路径」这一事实绑定，不再有中间态。
  // issue #1203：顺序必须是**先移目录、后卸载**。
  //
  // 旧实现把 afterResolve（卸载内存会话）放在 rename **之前**，而移动是卸载之后唯一的
  // 步骤。于是 rename 失败（EACCES / ENOSPC / 并发删除）时就正好得到本文件注释声称要
  // 避免的那个状态：**会话从内存里没了、目录还在磁盘上**——用户看到「删除失败」，
  // 但会话在界面上已经消失，下次启动又出现。
  //
  // 现在：rename 先做（目录离开扫描路径 = 事实上的「已删除」，可恢复式两阶段的第一步），
  // 移动成功后才卸载内存会话；卸载失败则把目录**移回去**再报错，不留半成品。
  const graveyard = `${dir}.deleting-${Date.now().toString(36)}`
  try {
    log('info', 'moving session directory out of the scan path', { sessionId, from: dir, to: graveyard })
    await rename(dir, graveyard)
  } catch (error) {
    // 并发删除同一会话时目录会先被别人移走：按 not-found 处理，客户端当成功。
    if (error?.code === 'ENOENT') {
      log('warn', 'session directory disappeared before it could be removed', { sessionId, dir })
      throw new SessionDeleteError('not-found', 'session disappeared while deleting', { sessionId, dir })
    }
    // 移动失败 = 什么都没发生：内存会话仍在，目录仍在原位。这是旧实现在此处唯一正确的行为。
    log('error', 'session deletion failed while moving the directory', { sessionId, dir, error: String(error?.message ?? error) })
    throw new SessionDeleteError('delete-failed', `could not delete the session directory: ${String(error?.message ?? error)}`, { sessionId, dir })
  }
  // 目录已离开扫描路径。卸载失败必须把目录移回去——否则调用方拿到 unload-failed 却
  // 已经丢了目录，「可恢复」就是假的。
  if (typeof afterResolve === 'function') {
    try {
      await afterResolve({ sessionId, dir })
    } catch (error) {
      log('error', 'unload failed after the directory moved; restoring it', { sessionId, dir, error: String(error?.message ?? error) })
      try {
        await rename(graveyard, dir)
      } catch (restoreError) {
        // 回滚本身失败：目录停在 graveyard（下次 sweep 会清），必须如实说明而不是假装成功。
        log('error', 'could not restore the session directory after a failed unload', { sessionId, dir, graveyard, error: String(restoreError?.message ?? restoreError) })
        throw new SessionDeleteError('delete-failed', `could not unload the session and could not restore its directory (kept at ${graveyard})`, { sessionId, dir })
      }
      // 卸载钩子抛的 SessionDeleteError 必须原样上抛：它的 code（如 unload-failed）
      // 决定调用方映射的 HTTP 状态（409 可重试 vs 500），吞掉就丢了语义。
      if (error instanceof SessionDeleteError) throw error
      throw new SessionDeleteError('delete-failed', `could not unload the session: ${String(error?.message ?? error)}`, { sessionId, dir })
    }
  }
  // issue #1617：归档/置顶记账放在**所有可能失败且会回滚的步骤之后**。
  //
  // 旧实现把它放在 rename 之前：先 unarchive/unpin，随后 rename 失败（EACCES/ENOSPC）→
  // 返回 500「删除失败」，会话还在列表里，却已悄悄退出归档/置顶。副作用发生了，用户却以为
  // 什么都没变。现在它在「目录已离开扫描路径且内存已卸载」之后才跑，与删除的事实绑定；
  // 记账自身失败不阻断删除（它只影响列表里的归档/置顶标记），但必须留痕而不是静默。
  if (typeof beforeRemove === 'function') {
    log('info', 'clearing archive/pin membership', { sessionId })
    try {
      await beforeRemove({ sessionId, dir })
      log('info', 'archive/pin membership cleared', { sessionId })
    } catch (error) {
      log('warn', 'archive/pin bookkeeping failed after the directory moved (ignored)', {
        sessionId, dir, error: String(error?.message ?? error),
      })
    }
  }
  try {
    log('info', 'removing session directory', { sessionId, dir: graveyard })
    const remove = typeof removeDir === 'function' ? removeDir : rm
    await remove(graveyard, { recursive: true, force: true })
    log('info', 'session deleted', { sessionId })
  } catch (error) {
    // issue #1287 ②：这里**不能**再报 ok。
    //
    // 旧实现在最终 rm 失败时只 warn 一句、然后 return { ok: true }：会话已离开扫描路径、
    // 内存也已卸载，界面上「看起来删掉了」，而磁盘上 100% 的会话数据停在
    // `<dir>.deleting-*` 里，要等下次启动 sweepGraveyards 才清（实测 graveyard left=1、
    // 回执 ok:true）。用户拿到的「成功」与磁盘事实相反，且**没有任何可行动的信息**。
    //
    // 现在：如实报失败，并把「修它需要什么」一起给出来 —— 路径（哪个目录）、errno
    // （为什么失败）、是否残留（还能不能救）。只报一个 failed 而不给这三样，用户拿到失败也修不了。
    const code = typeof error?.code === 'string' ? error.code : undefined
    let leftover = false
    try {
      leftover = lstatSync(graveyard) !== null
    } catch {
      leftover = false
    }
    log('error', 'session directory removed from the scan path but the final rm failed', {
      sessionId, dir, graveyard, code, leftover, error: String(error?.message ?? error),
    })
    throw new SessionDeleteError(
      'delete-failed',
      `the session was unloaded and moved out of the scan path, but its files could not be removed`
        + ` (path=${graveyard}, errno=${code ?? 'unknown'}, leftover=${leftover ? 'yes' : 'no'})`
        + ` — the leftover directory is cleaned on the next start, or you can remove it manually`,
      { sessionId, dir, graveyard, errno: code, leftover },
    )
  }
  return { ok: true, sessionId, dir }
}

/**
 * 一次遍历 `<home>/sessions`：工作区会话、`.corrupt` 条目与删除残留一起读完。
 *
 * 启动阶段以前对同一棵树跑三遍（墓地清扫、隔离件清点、孤立投影核对），每遍都重读
 * `sessions/` 与每个工作区的 `.corrupt/`。这里把「读到什么」与「拿它做什么」拆开：
 * 每个消费者只拿这份快照，单轮只枚举一次目录。
 *
 * 快照同时服务于三类判据：可清理的墓地、可清点的隔离件、投影缓存必须保留的
 * 会话 id（正常目录 / 隔离副本 / 墓地）。取消探针在每个目录边界检查；被取消的
 * 快照 `cancelled: true`，调用方不得拿它执行删除。
 *
 * @param {string} home - 绝对 `DSH_HOME`。
 * @param {{ shouldStop?: () => boolean }} [options] - 取消探针。
 * @returns {Promise<{
 *   cancelled: boolean,
 *   incomplete: boolean,
 *   problems: string[],
 *   quarantineEntries: string[],
 *   graveyardTargets: string[],
 *   liveDirsById: Map<string, string>,
 *   protectedIds: Set<string>,
 * }>} 扫描快照。
 */
async function scanStoredStorage(home, options = {}) {
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false
  const snapshot = {
    cancelled: false,
    incomplete: false,
    problems: [],
    quarantineEntries: [],
    graveyardTargets: [],
    liveDirsById: new Map(),
    protectedIds: new Set(),
  }
  if (typeof home !== 'string' || home === '') return snapshot
  const root = sessionsRoot(home)
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch (error) {
    // 没有 sessions/ 是正常初态（投影核对据此把缓存全判为孤儿）；其它错误一律 fail-closed。
    if (error?.code !== 'ENOENT') {
      snapshot.incomplete = true
      snapshot.problems.push('sessions root unreadable: ' + root + ' (' + String(error?.message ?? error) + ')')
    }
    return snapshot
  }
  for (const workspace of workspaces) {
    if (shouldStop()) { snapshot.cancelled = true; return snapshot }
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let entries
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true })
    } catch (error) {
      // 工作区读不动：墓地清扫/清点跳过它；投影核对必须中止，否则会漏掉受保护的副本。
      snapshot.incomplete = true
      snapshot.problems.push('workspace unreadable: ' + workspaceDir + ' (' + String(error?.message ?? error) + ')')
      continue
    }
    for (const entry of entries) {
      if (shouldStop()) { snapshot.cancelled = true; return snapshot }
      if (!entry.isDirectory()) continue
      if (entry.name === QUARANTINE_DIR) {
        const trash = join(workspaceDir, QUARANTINE_DIR)
        let quarantined
        try {
          quarantined = await readdir(trash, { withFileTypes: true })
        } catch (error) {
          // 与旧核对一致：隔离区读不动就不能断言「缓存是孤儿」。
          snapshot.incomplete = true
          snapshot.problems.push('quarantine dir unreadable: ' + trash + ' (' + String(error?.message ?? error) + ')')
          continue
        }
        for (const candidate of quarantined) {
          const dot = candidate.name.indexOf('.')
          const id = dot > 0 ? candidate.name.slice(0, dot) : candidate.name
          // 保护判据覆盖**所有**条目（链接/文件也算）：宁可多留一份缓存，也不误删可恢复数据。
          if (SESSION_ID_PATTERN.test(id)) snapshot.protectedIds.add(id)
          if (!candidate.isDirectory()) continue
          const target = join(trash, candidate.name)
          snapshot.quarantineEntries.push(target)
          // 只有「明确删除留下的」隔离墓地参与清扫；可恢复隔离件永不过期（issue #1587）。
          if (QUARANTINED_GRAVEYARD_PATTERN.test(candidate.name)) snapshot.graveyardTargets.push(target)
        }
        continue
      }
      if (GRAVEYARD_PATTERN.test(entry.name)) {
        const dot = entry.name.indexOf('.deleting-')
        const id = dot > 0 ? entry.name.slice(0, dot) : ''
        if (SESSION_ID_PATTERN.test(id)) snapshot.protectedIds.add(id)
      }
      if (entry.name.includes('.deleting-')) snapshot.graveyardTargets.push(join(workspaceDir, entry.name))
      if (SESSION_ID_PATTERN.test(entry.name)) snapshot.liveDirsById.set(entry.name, join(workspaceDir, entry.name))
    }
  }
  return snapshot
}

/**
 * Sweep graveyard directories left behind by failed deletions.
 *
 * `deleteStoredSession` renames the session directory to
 * `<dir>.deleting-<t>` before removing it; if the process dies (or `rm` fails)
 * between the two steps the graveyard stays forever with nothing to clean it
 * up. Directories carrying the `.deleting-` marker are only ever produced by
 * that rename step, so the suffix alone identifies them — normal session
 * directories and unrelated files are never touched. Best-effort: every
 * failure (missing root, unreadable workspace, busy file) is swallowed; the
 * sweep must never break route registration.
 *
 * @param {string} home - absolute `DSH_HOME`.
 * @returns {Promise<string[]>} removed graveyard paths (empty when none).
 */
export async function sweepGraveyards(home) {
  const removed = []
  if (typeof home !== 'string' || home === '') return removed
  const snapshot = await scanStoredStorage(home)
  for (const target of snapshot.graveyardTargets) {
    try {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      /* busy or unreadable: leave it for the next sweep */
    }
  }
  return removed
}

/** 坏会话的隔离目录名。放在会话所在的工作区目录下，**不在扫描路径上**。 */
export const QUARANTINE_DIR = '.corrupt'
const QUARANTINED_GRAVEYARD_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+(?:\.deleting-[0-9a-z]+)+$/i

/**
 * 清点隔离区的占用（issue #1587 的「磁盘单调增长」那一半）。
 *
 * 隔离件可以无限累积：每份是一整个会话目录，而被隔离的会话已不在列表里，
 * 用户没有任何入口看到「.corrupt/ 已经吃掉多少空间」。自动过期是**不做**的
 * （隔离承诺可恢复，删了就是替用户删历史，见 sweepGraveyards 与 #912），
 * 但「看不见的增长」得能看见：首屏之后把条数与字节数写进 engine.log，
 * 用户报「存储被吃掉」时有一条可查的事实。
 *
 * @param {string} home - 绝对 `DSH_HOME`。
 * @returns {Promise<{ count: number, bytes: number, dirs: string[] }>} 清点结果（无隔离区时为 0）。
 */
export async function inspectQuarantine(home) {
  const empty = { count: 0, bytes: 0, dirs: [] }
  if (typeof home !== 'string' || home === '') return empty
  const snapshot = await scanStoredStorage(home)
  const occupancy = await countQuarantine(snapshot, () => false)
  return { count: occupancy.count, bytes: occupancy.bytes, dirs: occupancy.dirs }
}

/**
 * 清点快照里的隔离件（只读；不删除任何东西）。
 * @param {{ quarantineEntries: string[] }} snapshot - scanStoredStorage 的快照。
 * @param {() => boolean} shouldStop - 取消探针。
 * @returns {Promise<{ count: number, bytes: number, dirs: string[], cancelled: boolean }>} 清点结果。
 */
async function countQuarantine(snapshot, shouldStop) {
  const dirs = snapshot.quarantineEntries.slice().sort()
  let bytes = 0
  for (const dir of dirs) {
    if (shouldStop()) return { count: dirs.length, bytes, dirs, cancelled: true }
    bytes += await directoryBytes(dir, shouldStop)
  }
  return { count: dirs.length, bytes, dirs, cancelled: false }
}

/**
 * Recursive byte size of a directory (best effort: unreadable entries count as 0).
 * @param {string} dir - absolute directory.
 * @param {() => boolean} [shouldStop] - cancellation probe checked between entries.
 * @returns {Promise<number>} total bytes.
 */
async function directoryBytes(dir, shouldStop = () => false) {
  let total = 0
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (shouldStop()) return total
    const target = join(dir, entry.name)
    if (entry.isDirectory()) { total += await directoryBytes(target, shouldStop); continue }
    try { total += (await stat(target)).size } catch { /* vanished mid-scan */ }
  }
  return total
}

/**
 * 崩溃/失败删除留下的墓地目录：`<工作区>/<id>.deleting-<slug>`。
 *
 * issue #1587（第二条残留面）：永久删除的最后一步是 `rm`，它在进程被杀、磁盘满、EACCES
 * 时失败，目录就停在 `<id>.deleting-*` 里。此后 `findSessionDir` 只报 not-found
 * （名字已不是 id）、`findQuarantinedDirs` 只看 .corrupt/，于是路由 404、客户端按
 * 「已删除」收尾 —— 而整份会话数据仍在磁盘上，重试删除也清不掉，只能等下次启动 sweep。
 * 实测（当前 main）：仅剩 `<id>.deleting-abc` 时 deleteStoredSession 抛 not-found，
 * 目录存在=true。
 */
const GRAVEYARD_PATTERN = /\.deleting-[0-9a-z]+$/i

/**
 * 找出某个会话**已被移出扫描路径**的墓地目录（`<工作区>/<id>.deleting-*`）。
 *
 * 与 [findQuarantinedDirs] 分开：隔离件在 `.corrupt/` 下且可恢复（用户可改名回去），
 * 墓地目录是**删除已开始**的产物，没有恢复语义，只等清理。
 *
 * @param {string} root - `<home>/sessions`。
 * @param {string} sessionId - 已校验的 id。
 * @param {{ onProblem?: (message: string) => void }} [options] - 读不动的目录交给收集器。
 * @returns {Promise<string[]>} 命中的墓地目录绝对路径（排序）。
 */
export async function findGraveyardDirs(root, sessionId, options = {}) {
  assertSessionId(sessionId)
  let workspaces
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const hits = []
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries
    try { entries = await readdir(join(root, workspace.name), { withFileTypes: true }) } catch (error) {
      if (error?.code !== 'ENOENT' && typeof options.onProblem === 'function') {
        options.onProblem('workspace is unreadable: ' + join(root, workspace.name) + ' (' + String(error?.message ?? error) + ')')
      }
      continue
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(sessionId + '.') || !GRAVEYARD_PATTERN.test(entry.name)) continue
      // 链接不是本插件产生的形态（rename 只会搬目录）：跳过，绝不顺着它删到树外。
      if (!entry.isDirectory()) continue
      hits.push(join(root, workspace.name, entry.name))
    }
  }
  return hits.sort()
}

/**
 * issue #912：把一个**读不出历史**的会话隔离起来 —— **移动而不是删除**。
 *
 * 为什么是隔离而不是修上游：v0→v1 迁移拒绝某条 `user/message` 是上游判定
 *（`session-format-v0-to-v1`），修它要 engine 补丁 + 真实夹具（当前造不出来，见 #919 同族阻塞）。
 * 而读不出历史的会话**本身已不可用**，用户真正需要的是「别再挡着我」+「数据还能拿回来」。
 *
 * 语义保证：
 * - 目标 `<工作区>/.corrupt/<id>.<时间戳>` 不在 `findSessionDir` 的扫描路径上 ⇒ 会话列表里不再出现；
 * - **不动其它会话**（只 rename 命中的那一个目录）；
 * - **可逆**：文件原样保留，把目录 rename 回去即恢复；
 * - 时间戳后缀使重复隔离不会互相覆盖（也不会盖掉上一次的隔离件）。
 *
 * @param {object} options - 隔离输入。
 * @param {string} options.home - 绝对 `DSH_HOME`。
 * @param {string} options.sessionId - 要隔离的会话 id。
 * @param {boolean} [options.isActive] - 是否有运行中的工作（true 即拒绝）。
 * @param {(info: { sessionId: string, dir: string }) => Promise<void>} [options.beforeResolve] - 目录确认后的记账。
 * @param {(level: 'info'|'warn'|'error', message: string, extra?: object) => void} [options.logger] - 步骤日志。
 * @returns {Promise<{ ok: true, sessionId: string, dir: string, quarantinedTo: string, restorable: true }>} 隔离结果。
 * @throws {SessionDeleteError} 非法 id / 不存在 / 多义 / 仍在运行。
 */

/**
 * 找出某个会话**已被隔离**的目录（`<工作区>/.corrupt/<id>.<时间戳>`）。
 *
 * 为什么需要它：会话被移出扫描路径后，`findSessionDir` 只会报 `not-found` —— 那会把
 * 「已经隔离过」说成「不存在」，用户以为数据丢了。两者的处置完全不同（前者应提示可恢复）。
 *
 * @param {string} root - `<home>/sessions`。
 * @param {string} sessionId - 已校验的 id。
 * @returns {Promise<string[]>} 命中的隔离目录绝对路径（按名字排序，旧→新）。
 */
export async function findQuarantinedDirs(root, sessionId, options = {}) {
  assertSessionId(sessionId)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const hits = []
  // 形态异常先收集，不立即抛：一个**与本会话无关**的工作区里有杂散 .corrupt 文件时，
  // 立即抛会让该设备的会话删除/隔离全部失败（实测：ws-b/.corrupt 是普通文件、
  // 目标会话在 ws-a 且完好，删除仍报 delete-failed 且文件不动）。
  // 判据保留在最后一步：一处都没命中且有异常，才不能被冒充成 not-found。
  const problems = []
  // 形态异常分两档，因为它们的风险性质不同：
  // - blocking：链接/非目录形态**可能把删除引到树外**（遍历风险），无论如何 fail-closed；
  // - advisory：只是一份普通文件占着 .corrupt 这个名字，删不动任何树外的东西，
  //   但它确实让我们看不见该工作区里的副本 —— 只在「一处都没命中」时才据此判失败。
  const note = (message, blocking) => problems.push(blocking ? 'BLOCK:' + message : message)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const trash = join(root, entry.name, QUARANTINE_DIR)
    let names
    try {
      const info = await lstat(trash)
      if (!info.isDirectory()) {
        // 链接可以指到树外：删它等于删别人（#1587 的遍历面）。
        note('quarantine is not a real directory: ' + trash, info.isSymbolicLink())
        continue
      }
      names = await readdir(trash, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      note('quarantine is unreadable: ' + trash + ' (' + String(error?.message ?? error) + ')', false)
      continue
    }
    for (const name of names) {
      if (!name.name.startsWith(sessionId + '.')) continue
      if (!name.isDirectory()) {
        note('quarantined entry is not a real directory: ' + join(trash, name.name), name.isSymbolicLink())
        continue
      }
      hits.push(join(trash, name.name))
    }
  }
  const blocking = problems.filter((p) => p.startsWith('BLOCK:'))
  // 链接/树外形态一律 fail-closed：这条与「命中多少」无关，它是安全边界不是可用性问题。
  if (blocking.length > 0) {
    throw new SessionDeleteError('delete-failed', blocking[0].slice('BLOCK:'.length), { sessionId, paths: blocking })
  }
  // 其余是 advisory：调用方给了收集器就交出去，由它决定「该不该打断本次操作」。
  if (typeof options.onProblems === 'function') {
    options.onProblems(problems)
    return hits.sort()
  }
  if (hits.length === 0 && problems.length > 0) {
    throw new SessionDeleteError('delete-failed', problems[0], { sessionId, paths: problems })
  }
  return hits.sort()
}

export async function quarantineStoredSession({ home, sessionId, isActive, beforeResolve, logger }) {
  const log = typeof logger === 'function' ? logger : () => {}
  assertSessionId(sessionId)
  if (isActive === true) {
    throw new SessionDeleteError('session-active', 'the conversation is running; stop it before quarantining', { sessionId })
  }
  const root = sessionsRoot(home)
  let dir
  try {
    dir = await findSessionDir(root, sessionId)
  } catch (error) {
    // issue #912：已隔离的会话不在扫描路径上，`findSessionDir` 只会报 not-found。
    // 这里必须与「真的不存在」区分 —— 前者要告诉用户「文件还在，可恢复」。
    if (error instanceof SessionDeleteError && error.code === 'not-found') {
      const already = await findQuarantinedDirs(root, sessionId)
      if (already.length > 0) {
        throw new SessionDeleteError('already-quarantined', 'this session is already quarantined; the files are kept and can be restored', {
          sessionId,
          paths: already,
        })
      }
      // #1587：只剩「删除进行到一半」的墓地目录时，不能说 not-found ——
      // 那会让客户端把「文件还在」当成「已删除」，而隔离入口又给不出任何可行动信息。
      // 独立错误码：它既不是「已隔离」（不保证可恢复），也不是「不存在」。
      const crashed = await findGraveyardDirs(root, sessionId)
      if (crashed.length > 0) {
        throw new SessionDeleteError('deletion-incomplete', 'a previous deletion stopped before its files were removed; delete again to finish it', {
          sessionId,
          paths: crashed,
        })
      }
    }
    throw error
  }
  // issue #1203：与 delete 同形 —— 先移目录、后卸载。
  //
  // 旧实现 beforeResolve（卸载）在 mkdir/rename **之前**：`.corrupt` 已存在且是普通文件时
  // mkdir 抛 EEXIST，会话已从内存摘掉而目录仍在扫描路径上。
  const trash = join(dirname(dir), QUARANTINE_DIR)
  const target = join(trash, sessionId + '.' + Date.now())
  try {
    await mkdir(trash, { recursive: true })
    await rename(dir, target)
  } catch (error) {
    log('error', 'session quarantine failed while moving the directory', { sessionId, dir, error: String(error?.message ?? error) })
    throw new SessionDeleteError('delete-failed', `could not quarantine the session directory: ${String(error?.message ?? error)}`, { sessionId, dir })
  }
  if (typeof beforeResolve === 'function') {
    try {
      await beforeResolve({ sessionId, dir })
    } catch (error) {
      log('error', 'unload failed after quarantine moved the directory; restoring it', { sessionId, dir, error: String(error?.message ?? error) })
      try {
        await rename(target, dir)
      } catch (restoreError) {
        log('error', 'could not restore the quarantined directory', { sessionId, dir, target, error: String(restoreError?.message ?? restoreError) })
        throw new SessionDeleteError('delete-failed', `could not unload the session and could not restore its directory (kept at ${target})`, { sessionId, dir })
      }
      // 卸载钩子抛的 SessionDeleteError 必须原样上抛：它的 code（如 unload-failed）
      // 决定调用方映射的 HTTP 状态（409 可重试 vs 500），吞掉就丢了语义。
      if (error instanceof SessionDeleteError) throw error
      throw new SessionDeleteError('delete-failed', `could not unload the session: ${String(error?.message ?? error)}`, { sessionId, dir })
    }
  }
  log('info', 'session quarantined', { sessionId, path: target })
  return { ok: true, sessionId, dir, quarantinedTo: target, restorable: true }
}

function projectionCacheSessionsDir(home) {
  return join(home, 'storages', 'session_projcache', 'sessions')
}

/** Remove the per-session projection cache file (and stale .bak.* siblings) after permanent session delete. */
export async function removeSessionProjectionCacheFile(home, sessionId, logger) {
  const log = typeof logger === 'function' ? logger : () => {}
  if (typeof home !== 'string' || home === '' || !SESSION_ID_PATTERN.test(sessionId)) return { removed: [] }
  const cacheDir = projectionCacheSessionsDir(home)
  const removed = []
  let entries
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed }
    log('warn', 'session projection cache directory unreadable during delete cleanup (ignored)', {
      sessionId, cacheDir, error: String(error?.message ?? error),
    })
    return { removed }
  }
  const exact = `${sessionId}.json`
  const bakPrefix = `${exact}.bak.`
  for (const entry of entries) {
    if (entry.name !== exact && !entry.name.startsWith(bakPrefix)) continue
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const target = join(cacheDir, entry.name)
    try {
      await unlink(target)
      removed.push(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        log('warn', 'failed to remove session projection cache file (ignored)', {
          sessionId, target, error: String(error?.message ?? error),
        })
      }
    }
  }
  if (removed.length > 0) log('info', 'removed session projection cache entries', { sessionId, count: removed.length })
  return { removed }
}

const LOG_NAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/** 首行身份最多解析 8 KiB（与未压缩日志的首块上限一致）。 */
const SESSION_LOG_HEADER_MAX_BYTES = 8 * 1024
/** 每次只喂给解压器 64 KiB 压缩数据。 */
const SESSION_LOG_HEADER_CHUNK_BYTES = 64 * 1024
/** 压缩日志最多读取 1 MiB：首行身份只可能落在文件开头，读更多没有意义。 */
const SESSION_LOG_HEADER_MAX_INPUT_BYTES = 1024 * 1024

/**
 * 有界读取 zstd 日志的首行，只为投影核对取身份。
 *
 * 旧实现 `readFile` 整份日志再同步 `zstdDecompressSync`：日志动辄几十上百 MB，
 * 启动核对却只要一行身份。引擎格式保证**第一个 zstd frame 就是单独的一行身份头**
 * （`assertIndependentHeaderFrame`），所以这里流式解压，喂到首行出现为止：
 * 压缩输入上限 1 MiB、解压后首行上限 8 KiB，主线程不做整份同步解压。
 *
 * 取不到可判定的首行（损坏 / 截断 / 超过上限 / 解码错误）返回 null —— 调用方
 * 据此**保留**缓存，绝不把「不知道」当成「身份不同」。
 *
 * @param {string} filePath - zstd 日志绝对路径。
 * @returns {Promise<string|null>} 首行文本；无法有界确定时为 null。
 */
async function readZstdFirstLine(filePath) {
  const handle = await open(filePath, 'r')
  let decoder
  const chunks = []
  let length = 0
  let done = false
  let text = null
  let settle
  const firstLine = new Promise((resolve) => { settle = resolve })
  const finish = (value) => {
    if (done) return
    done = true
    text = value
    settle()
  }
  try {
    decoder = createZstdDecompress()
  } catch (error) {
    await handle.close()
    throw error
  }
  decoder.on('data', (chunk) => {
    if (done) return
    const newline = chunk.indexOf(10)
    const line = newline === -1 ? chunk : chunk.subarray(0, newline)
    if (length + line.length > SESSION_LOG_HEADER_MAX_BYTES) { finish(null); return }
    if (line.length > 0) {
      chunks.push(Buffer.from(line))
      length += line.length
    }
    if (newline !== -1) finish(Buffer.concat(chunks, length).toString('utf8'))
  })
  decoder.on('error', () => finish(null))
  decoder.on('end', () => finish(null))
  try {
    const buffer = Buffer.allocUnsafe(SESSION_LOG_HEADER_CHUNK_BYTES)
    let position = 0
    while (!done && position < SESSION_LOG_HEADER_MAX_INPUT_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead <= 0) break
      position += bytesRead
      // 必须复制：解码在 libuv 线程池异步消费，复用同一个读缓冲会把它改坏。
      decoder.write(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    if (!done) {
      // 输入读完（或到上限）仍没有首行：等解码器收尾，由 data/error/end 落定。
      decoder.end()
      await firstLine
    }
    return done ? text : null
  } finally {
    decoder?.destroy()
    await handle.close()
  }
}

/** Read the header line identity `{ createdAt, formatVersion }` from a session's active log file. */
async function readSessionLogIdentity(sessionDir) {
  let entries
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = LOG_NAME_RE.exec(entry.name)
    if (!match) continue
    const version = match[1] ? Number.parseInt(match[1], 10) : 0
    const zstd = match[2] === '.zstd'
    candidates.push({ name: entry.name, version, zstd })
  }
  candidates.sort((a, b) => (b.version - a.version) || (Number(b.zstd) - Number(a.zstd)))
  for (const candidate of candidates) {
    const filePath = join(sessionDir, candidate.name)
    try {
      let headerText
      if (!candidate.zstd) {
        const handle = await open(filePath, 'r')
        try {
          const buf = Buffer.allocUnsafe(SESSION_LOG_HEADER_MAX_BYTES)
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          if (bytesRead <= 0) continue
          const slice = buf.subarray(0, bytesRead)
          const nl = slice.indexOf(10)
          headerText = (nl >= 0 ? slice.subarray(0, nl) : slice).toString('utf8')
        } finally {
          await handle.close()
        }
      } else {
        headerText = await readZstdFirstLine(filePath)
        // 取不到首行 = 身份未知：原样交给调用方保留缓存（fail-closed）。
        if (headerText === null) return null
      }
      const header = JSON.parse(headerText)
      if (header && typeof header === 'object' && !Array.isArray(header)) {
        return {
          createdAt: typeof header.createdAt === 'number' && Number.isSafeInteger(header.createdAt) ? header.createdAt : undefined,
          formatVersion: typeof header.version === 'number' && Number.isSafeInteger(header.version) ? header.version : undefined,
        }
      }
    } catch {
      return null
    }
  }
  return null
}

/**
 * 用一份目录快照核对孤立投影缓存：保留有身份证据的、隔离/墓地里的缓存，只删
 * 「会话已不存在」或「同一 id 已被重建、身份不再匹配」的那些。
 *
 * fail-closed：快照不完整（有工作区/隔离区读不动）或身份读不出来时一律保留。
 * @param {string} home - 绝对 `DSH_HOME`。
 * @param {object} snapshot - `scanStoredStorage` 的快照。
 * @param {(level: 'info'|'warn'|'error', message: string, extra?: object) => void} log - 日志。
 * @param {{ shouldStop?: () => boolean }} [options] - 取消探针。
 * @returns {Promise<{ scanned: number, removed: string[], kept: number, aborted: boolean, cancelled: boolean }>} 结果。
 */
async function reconcileProjectionCaches(home, snapshot, log, options = {}) {
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false
  const empty = { scanned: 0, removed: [], kept: 0, aborted: false, cancelled: false }
  const cacheDir = projectionCacheSessionsDir(home)
  let cacheEntries
  try {
    cacheEntries = await readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return empty
    log('warn', 'projection cache sweep aborted: cache directory unreadable', {
      cacheDir, error: String(error?.message ?? error),
    })
    return { ...empty, aborted: true }
  }
  const jsonEntries = cacheEntries.filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.json'))
  if (jsonEntries.length === 0) return empty
  const scanned = jsonEntries.length
  if (snapshot.incomplete) {
    log('warn', 'projection cache sweep aborted: session storage scan incomplete', {
      root: sessionsRoot(home), problem: snapshot.problems[0] ?? 'unknown',
    })
    return { scanned, removed: [], kept: scanned, aborted: true, cancelled: false }
  }
  if (snapshot.cancelled || shouldStop()) return { scanned, removed: [], kept: scanned, aborted: false, cancelled: true }

  const removed = []
  let kept = 0
  for (const entry of jsonEntries) {
    if (shouldStop()) return { scanned, removed, kept, aborted: false, cancelled: true }
    const id = entry.name.slice(0, -5)
    if (!SESSION_ID_PATTERN.test(id)) {
      kept += 1
      continue
    }
    if (snapshot.protectedIds.has(id)) {
      kept += 1
      continue
    }
    const liveDir = snapshot.liveDirsById.get(id)
    let shouldRemove = false
    if (liveDir === undefined) {
      shouldRemove = true
    } else {
      try {
        const parsed = JSON.parse(await readFile(join(cacheDir, entry.name), 'utf8'))
        const cachedIdentity = parsed?.record?.identity
        if (cachedIdentity && typeof cachedIdentity.createdAt === 'number') {
          const liveIdentity = await readSessionLogIdentity(liveDir)
          // 身份无法确定（损坏/截断/超限）→ 保留缓存：绝不把「不知道」当成「不是同一个会话」。
          if (liveIdentity !== null) {
            if (liveIdentity.createdAt !== undefined && liveIdentity.createdAt !== cachedIdentity.createdAt) {
              shouldRemove = true
            } else if (
              typeof cachedIdentity.formatVersion === 'number'
              && liveIdentity.formatVersion !== undefined
              && cachedIdentity.formatVersion > liveIdentity.formatVersion
            ) {
              shouldRemove = true
            }
          }
        }
      } catch {
        // Malformed or unreadable: leave alone for dsh-session-projection-cache backup-and-skip.
      }
    }
    if (!shouldRemove) {
      kept += 1
      continue
    }
    if (shouldStop()) return { scanned, removed, kept, aborted: false, cancelled: true }
    const target = join(cacheDir, entry.name)
    try {
      await unlink(target)
      removed.push(target)
    } catch {
      kept += 1
      continue
    }
    const bakPrefix = `${entry.name}.bak.`
    for (const sibling of cacheEntries) {
      if (!sibling.isFile() || sibling.isSymbolicLink() || !sibling.name.startsWith(bakPrefix)) continue
      if (shouldStop()) break
      try {
        const bakPath = join(cacheDir, sibling.name)
        await unlink(bakPath)
        removed.push(bakPath)
      } catch { /* ignore sibling cleanup errors */ }
    }
  }
  if (removed.length > 0) {
    log('info', 'swept orphan session projection cache entries', { count: removed.length, kept })
  }
  return { scanned, removed, kept, aborted: false, cancelled: false }
}

/**
 * Reconcile `<home>/storages/session_projcache/sessions/*.json` against stored sessions.
 * Preserves all live sessions with matching/unproven identity and all quarantined/graveyard sessions.
 * Fail-closed if the sessions tree cannot be scanned completely.
 */
export async function sweepOrphanProjectionCaches(home, logger) {
  const log = typeof logger === 'function' ? logger : () => {}
  if (typeof home !== 'string' || home === '') return { scanned: 0, removed: [], kept: 0, aborted: false, cancelled: false }
  const snapshot = await scanStoredStorage(home)
  return reconcileProjectionCaches(home, snapshot, log)
}

/**
 * 首屏之后才跑的存储维护：隔离件容量统计 + 孤立投影核对。
 *
 * 两者共用**同一份**目录快照，不再各自枚举 `sessions/` 与每个 `.corrupt/`。
 * 调用方（host apply）用延后定时器把它挪出启动首屏窗口；dispose/HMR 时通过
 * `shouldStop` 在下一个目录边界取消，尚未开始的删除一律不发生。
 *
 * @param {string} home - 绝对 `DSH_HOME`。
 * @param {(level: 'info'|'warn'|'error', message: string, extra?: object) => void} [logger] - 日志。
 * @param {{ shouldStop?: () => boolean }} [options] - 取消探针。
 * @returns {Promise<{
 *   cancelled: boolean,
 *   quarantine: { count: number, bytes: number, dirs: string[] },
 *   projection: { scanned: number, removed: string[], kept: number, aborted: boolean, cancelled: boolean },
 * }>} 清点与核对结果；取消时两者都是部分结果且不执行删除。
 */
export async function runDeferredStorageMaintenance(home, logger, options = {}) {
  const log = typeof logger === 'function' ? logger : () => {}
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false
  const result = {
    cancelled: false,
    quarantine: { count: 0, bytes: 0, dirs: [] },
    projection: { scanned: 0, removed: [], kept: 0, aborted: false, cancelled: false },
  }
  if (typeof home !== 'string' || home === '') return result
  const snapshot = await scanStoredStorage(home, { shouldStop })
  if (snapshot.cancelled || shouldStop()) {
    result.cancelled = true
    return result
  }
  const occupancy = await countQuarantine(snapshot, shouldStop)
  if (occupancy.cancelled || shouldStop()) {
    result.cancelled = true
    return result
  }
  result.quarantine = { count: occupancy.count, bytes: occupancy.bytes, dirs: occupancy.dirs }
  // 清点是只读的：先写进 engine.log，再做会删文件的核对。
  if (occupancy.count > 0) log('info', 'quarantine occupancy', { count: occupancy.count, bytes: occupancy.bytes })
  result.projection = await reconcileProjectionCaches(home, snapshot, log, { shouldStop })
  if (result.projection.cancelled) result.cancelled = true
  return result
}
