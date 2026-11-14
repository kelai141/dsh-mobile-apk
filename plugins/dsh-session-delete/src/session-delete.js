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
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  const dirs = stored ? [stored, ...quarantined] : quarantined
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
  const root = sessionsRoot(home)
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return removed // no sessions directory yet: nothing to sweep
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(root, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    // 隔离件本身不自动过期（可恢复承诺）；只扫用户已明确删除留下的 graveyard。
    const quarantine = entries.find((entry) => entry.name === QUARANTINE_DIR && entry.isDirectory())
    if (quarantine) {
      try {
        const trash = join(root, workspace.name, QUARANTINE_DIR)
        for (const entry of await readdir(trash, { withFileTypes: true })) {
          if (!entry.isDirectory() || !QUARANTINED_GRAVEYARD_PATTERN.test(entry.name)) continue
          const target = join(trash, entry.name)
          try {
            await rm(target, { recursive: true, force: true })
            removed.push(target)
          } catch { /* retry on the next startup */ }
        }
      } catch { /* best effort, as with the workspace sweep */ }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes('.deleting-')) continue
      const target = join(root, workspace.name, entry.name)
      try {
        await rm(target, { recursive: true, force: true })
        removed.push(target)
      } catch {
        /* busy or unreadable: leave it for the next sweep */
      }
    }
  }
  return removed
}

/** 坏会话的隔离目录名。放在会话所在的工作区目录下，**不在扫描路径上**。 */
export const QUARANTINE_DIR = '.corrupt'
const QUARANTINED_GRAVEYARD_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+(?:\.deleting-[0-9a-z]+)+$/i

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
