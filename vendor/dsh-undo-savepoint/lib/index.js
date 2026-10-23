/**
 * dsh-undo-savepoint: undo/rollback system for DeepSeek Harness.
 *
 * - Tools: undo_snapshot / undo_list / undo_diff / undo_restore
 * - Two save modes with SEPARATE stores (paths configurable in settings):
 *   manual snapshots -> <manualDir> (default D:\dsh\undo-snapshots\manual)
 *   auto/baseline/pre-restore -> <autoDir> (default D:\dsh\undo-snapshots\auto)
 *   Legacy flat layout under <snapshotDir> is read and auto-migrated.
 * - Auto-archiving: snapshots config files AND user-plugin code files whenever
 *   they change (debounced), plus a baseline on mount; all parameters live in
 *   the settings file (D:\dsh\undo\settings.json) and are editable from WebUI.
 * - Plugin code tree (v0.2, module 1): user plugins (junction targets under
 *   node_modules) and profile-local code files (name: './xxx' in
 *   cordis.patch.yml) are snapshotted by content hash into a shared blob store
 *   (<snapshotRoot>/blobs) — plugin code edits are undoable even when no config
 *   file changed (e.g. the whale-kit "yield* is not async iterable" incident).
 *   Snapshot scope comes from lib/spec.json (single source of truth, shared
 *   with the PowerShell tooling — module 7).
 * - WebUI: REST endpoints under /api/undo/* power the header buttons, the
 *   snapshot manager panel (view / delete / restore-to-version) and the
 *   settings row (client half in lib/client.js).
 * - Undo/redo stack: undo restores the newest snapshot whose state differs
 *   from the current one (identical snapshots are skipped with a clear
 *   "nothing to undo" message). Every restore first stores the current state
 *   as a pre-restore snapshot; redo re-applies the newest unconsumed one
 *   (blocked when a real newer change exists). The watcher ignores the
 *   restore's own file writes (content-hash echo detection) so redo is never
 *   blocked by itself. Restoring cordis.patch.yml re-ensures the mount line.
 *
 * The external PowerShell tooling (tools/) shares the same stores/formats and
 * works even when DSH cannot boot.
 *
 * @module dsh-undo-savepoint
 */
import { createRequire } from 'node:module';
import { promises as fs, watch as fsWatch, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  t,
  setTurnProvider,
  renderRestoreResult,
  DSH_HOME,
  SETTINGS_FILE,
  LEGACY_ROOT,
  DEFAULT_SETTINGS,
  FILE_SPECS,
  WATCHED_BASENAMES,
  sha1Hex,
  isCodeFile,
  rootDir,
  filePath,
  destName,
  fmtBytes,
  pathExists,
  loadSettingsFile,
  detectProfileName,
  resolveStoreRoots,
  discoverPlugins,
  collectPluginTree,
  collectProfileCodeRefs,
  isPluginEcho,
  readBootState,
  writeBootState,
  classifyCrash,
  crashAdvice,
  readCrashLogTail,
  zstdUnavailable,
  assertZstd,
  analyzeSessionBytes,
  recodeSessionBytes,
  walkSessionFiles,
  patchVerify,
  lastGoodSnapshot,
  safeModeStatus,
  safeModeSet,
  createSnapshot,
  listSnapshots,
  dirLabel,
  findSnapshot,
  runDoctor,
  runDoctorFix,
  appendMessageOp,
  listMessageOps,
  pruneMessageOps,
  undoMessage,
  undoCompact,
  ensureDesktopShortcut,
  writeBlob,
  currentState,
  sameState,
  undoCandidates,
  ensureMount,
  dedupeMount,
  restore,
  removeSnapshot,
  pruneAuto,
  pruneOrphanBlobs,
  markFlag,
  migrateLegacy,
  classifyChange,
  diffSnapshotStructured,
  diffSnapshot,
  diffTree,
  exportSnapshots,
  importSnapshots,
  pickDirectory,
  pickFile,
  publicSettings,
  setSnapshotMeta,
} from './core.mjs';

const DSH_ROOT = process.env.DSH_ROOT ?? '';
let defineTool;
/**
 * 模块级解析锚点（v0.4：跨机预检等多锚点探测复用）。
 * 解析失败时下面会直接 throw，所以此处保证非 null。
 */
let toolsRequire = null;
{
  try {
    const local = createRequire(import.meta.url);
    local.resolve('@deepseek-ai/dsh-tools');
    toolsRequire = local;
  } catch { /* not resolvable from the plugin location */ }
  if (!toolsRequire && DSH_ROOT !== '') {
    try {
      toolsRequire = createRequire(join(DSH_ROOT, 'package.json'));
      toolsRequire.resolve('@deepseek-ai/dsh-tools');
    } catch { toolsRequire = null; }
  }
  if (!toolsRequire) {
    throw new Error('dsh-undo-savepoint: cannot resolve "@deepseek-ai/dsh-tools". Install the plugin via `dsh plugin add` (peer deps resolve automatically), or set DSH_ROOT to your DSH install root for local junction mounts.');
  }
  try {
    ({ defineTool } = toolsRequire('@deepseek-ai/dsh-tools'));
  } catch {
    // Older Node without require(esm): dynamic import of the resolved path.
    const mod = await import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-tools')).href);
    defineTool = mod.defineTool;
  }
}

export const name = 'dsh-undo-savepoint';
export const inject = ['tools', 'systemPrompt', 'webServer'];

/** 最近一次 apply() 的 ctx 引用（供 hasOpenTurn 取 session store）。 */
let ctxRef = null;

/**
 * 是否有会话正在运行（日志以 turn/start 结尾、未被 turn/end 闭合 = agent 正在执行）。
 * 撤销/恢复会写回配置并触发 DSH 内置 HMR 重建插件树，可能中断所有正在跑的会话——
 * 运行中一律拒绝（修复方案 A 安全闸）。
 */
function hasOpenTurn() {
  const store = ctxRef?.get?.('session');
  const sessions = (typeof store?.list === 'function') ? store.list() : [];
  return sessions.some((s) => {
    const ev = s?.events;
    if (!Array.isArray(ev) || ev.length === 0) return false;
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i].type === 'turn/end') return false;
      if (ev[i].type === 'turn/start') return true;
    }
    return false;
  });
}

// 把局内会话运行守卫注入 core 引擎（局外服务器不注入，默认放行）。
setTurnProvider(hasOpenTurn);

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const PROMPT_TEXT = `## Undo / rollback (dsh-undo-savepoint)
When the user asks to undo the previous action ("撤销上一步", "回退", "恢复", "redo", "保存快照", "查看快照") — typically after installing a plugin, applying a skin, or changing settings — do NOT guess or hand-edit config files:
1. Call undo_list to show available snapshots (auto-created on config changes, plus manual ones).
2. Call undo_restore with mode "undo" to revert the latest change, mode "redo" to re-apply the state saved before the last undo, or mode "id" with a snapshot id from undo_list. Use undo_diff to preview first when unsure.
3. undo_restore never destroys the current state (kept as a pre-restore snapshot) and re-ensures the dsh-undo-savepoint mount itself.
4. Manual snapshots are stored separately from auto snapshots (settings: manualDir / autoDir).
5. PROACTIVE notice: whenever the user mentions or performs a config change (installing a plugin, applying a skin, changing a setting), proactively tell them "配置已自动保存为快照,改错了随时可以撤销/回退", and offer to show the recent snapshots via undo_list. Do not wait to be asked.
6. Crash alert: if undo_list output starts with "⚠️ Previous DSH run did not finish starting", proactively suggest undoing back to the last good state (undo_restore mode "undo") and explain that the previous run crashed before this plugin finished starting.
7. Config-state confusion: when the user is confused about the current config (a plugin/skin/setting suddenly missing or different, or a long futile debugging loop), FIRST call undo_recent to check whether a recent rollback explains it; if so, tell the user exactly which files were rolled back and when. Rollbacks may have happened in another session or via the offline tools, so the user/AI may not have seen them happen.
8. Plugin code: snapshots also include user-plugin CODE files (junction targets under node_modules, e.g. D:\\dsh\\plugins\\*, plus profile-local files like router-global.mjs). A broken plugin EDIT (e.g. "yield* (intermediate value) is not async iterable") can be rolled back even when no config file changed — undo_list rows show the plugin file count.
9. SAFE MODE: when DSH cannot boot at all or a plugin breaks startup, use undo_safe_mode action "on" to disable every user plugin except undo itself, then restart DSH and diagnose; action "off" restores the previous plugin set (restart again). undo_list crash alerts name a concrete last-known-good snapshot to restore (undo_restore mode "id").
10. Dependency sync: when a restore touches package.json / pnpm-lock.yaml, the result reports that node_modules may be out of sync. Re-run undo_restore with sync_deps=true only when the user confirms, because it runs pnpm install --frozen-lockfile.
Note: this system only reverts DSH config/plugin/skin state, not chat history.`;


export function apply(ctx, config = {}) {
  ctxRef = ctx;
  /**
   * rc8 兼容盖子（2026-08-20）：DSH 服务 API（tools / systemPrompt / webServer
   * 等）调用逐项包 try/catch——rc8 若改了某个服务签名，单项失败只 logger.warn
   * 降级跳过，绝不从 apply() 抛出中断整个插件树（安全模式与离线工具不受影响）。
   */
  const safeEffect = (effectFn, label) => {
    try {
      return ctx.effect(effectFn, label);
    } catch (error) {
      try { ctx.logger.warn(`[dsh-undo-savepoint] ${label} skipped (degraded): ${String(error?.message ?? error)}`); } catch { /* logger 也不可用时静默 */ }
      return undefined;
    }
  };
  /**
   * I12 注册防御：工具注册统一走这里。重复注册（双重挂载漏网、include 未被扫描
   * 到等）只告警跳过，绝不抛错炸掉启动；与 safeEffect 构成双重保险。
   */
  const registeredTools = new Set();
  const registerToolOnce = (tool) => {
    const name = tool?.name;
    if (registeredTools.has(name)) {
      ctx.logger.warn(`[dsh-undo-savepoint] tool "${name}" already registered by this instance; skipping duplicate.`);
      return undefined;
    }
    try {
      // 返回真实 dispose：插件卸载/HMR 时工具要能正常注销（勿吞掉）
      const dispose = ctx.tools.register(tool);
      registeredTools.add(name);
      return dispose ?? (() => { /* 服务未返回 dispose 时空操作 */ });
    } catch (error) {
      if (/already registered/i.test(String(error?.message ?? error))) {
        ctx.logger.warn(`[dsh-undo-savepoint] tool "${name}" is already registered (duplicate mount); degraded: skipped.`);
        return undefined;
      }
      throw error;
    }
  };
  const fileSettings = loadSettingsFile();
  // Legacy option: config.snapshotDir (old flat root) derives the new stores.
  const legacyRoot = config.snapshotDir ?? undefined;
  // 当前 profile（v0.3.3，issue #3）：argv 解析，config.profileName 显式覆盖
  const profileName = config.profileName ?? detectProfileName();
  // 快照仓库默认根：按 profile 隔离，旧平铺目录兼容回退
  const storeRoots = resolveStoreRoots(profileName);
  const cfg = {
    settingsFile: SETTINGS_FILE,
    profileName,
    homeDir: config.homeDir ?? undefined,
    // profileDir 默认 = 当前 profile 目录（此前硬编码 web，issue #3）
    profileDir: config.profileDir ?? join(DSH_HOME, 'profiles', profileName),
    manualDir: config.manualDir ?? (legacyRoot ? join(legacyRoot, 'manual') : undefined) ?? fileSettings.manualDir ?? storeRoots.manualDir,
    autoDir: config.autoDir ?? (legacyRoot ? join(legacyRoot, 'auto') : undefined) ?? fileSettings.autoDir ?? storeRoots.autoDir,
    keepAuto: config.keepAuto ?? fileSettings.keepAuto,
    keepPre: config.keepPre ?? fileSettings.keepPre ?? DEFAULT_SETTINGS.keepPre,
    autoCleanup: config.autoCleanup ?? fileSettings.autoCleanup ?? DEFAULT_SETTINGS.autoCleanup,
    watchDebounceMs: config.watchDebounceMs ?? fileSettings.watchDebounceMs,
    autoEnabled: config.autoEnabled ?? fileSettings.autoEnabled,
    /** 敏感模式（v0.3.2）：'redact' 脱敏+vault（默认）| 'keep' 明文旧行为。 */
    sensitiveMode: config.sensitiveMode ?? fileSettings.sensitiveMode ?? 'redact',
    /** 用户插件目录白名单（v0.2）：空数组 = 自动发现 node_modules 下的 junction。 */
    pluginDirs: Array.isArray(config.pluginDirs) ? config.pluginDirs : (Array.isArray(fileSettings.pluginDirs) ? fileSettings.pluginDirs : []),
    /** 消息级撤销（V0.4.0，P6）设置。 */
    keepMessageOps: config.keepMessageOps ?? fileSettings.keepMessageOps ?? DEFAULT_SETTINGS.keepMessageOps,
    fileToolWhitelist: Array.isArray(config.fileToolWhitelist) ? config.fileToolWhitelist : (Array.isArray(fileSettings.fileToolWhitelist) ? fileSettings.fileToolWhitelist : DEFAULT_SETTINGS.fileToolWhitelist),
    workspaceDirs: Array.isArray(config.workspaceDirs) ? config.workspaceDirs : (Array.isArray(fileSettings.workspaceDirs) ? fileSettings.workspaceDirs : DEFAULT_SETTINGS.workspaceDirs),
    workspaceWatch: config.workspaceWatch ?? fileSettings.workspaceWatch ?? DEFAULT_SETTINGS.workspaceWatch,
    /** 桌面快捷方式（V0.4.0 新增）：插件加载后自动在桌面创建打开局外工具的快捷方式。 */
    createDesktopShortcut: config.createDesktopShortcut ?? fileSettings.createDesktopShortcut ?? DEFAULT_SETTINGS.createDesktopShortcut,
    desktopDir: config.desktopDir ?? fileSettings.desktopDir,
    /** 定时快照（V0.4.0 P4）：间隔制，0=关闭。 */
    scheduledSnapshotEnabled: config.scheduledSnapshotEnabled ?? fileSettings.scheduledSnapshotEnabled ?? DEFAULT_SETTINGS.scheduledSnapshotEnabled,
    scheduledSnapshotMs: config.scheduledSnapshotMs ?? fileSettings.scheduledSnapshotMs ?? DEFAULT_SETTINGS.scheduledSnapshotMs,
    /** >0 while a restore is writing files: the watcher must NOT auto-snapshot
     * the restore's own writes, or the new auto snapshot would block redo. */
    suppressAuto: 0,
    /** destName -> sha1 of what the last restore wrote (echo detection). */
    restoredHashes: new Map(),
  };

  void (async () => {
    try {
      await fs.mkdir(cfg.manualDir, { recursive: true });
      await fs.mkdir(cfg.autoDir, { recursive: true });
      // V0.4.0 桌面快捷方式：插件加载后自动在桌面创建打开局外工具的快捷方式。
      // fire-and-forget（不 await，绝不拖慢启动时序）+ 永不抛出（失败仅告警）。
      try {
        void ensureDesktopShortcut(cfg).then((ds) => {
          if (ds.action === 'created' || ds.action === 'exists') ctx.logger.info(`[dsh-undo-savepoint] desktop shortcut ${ds.action}: ${ds.path ?? ''}`);
          else if (ds.action === 'error') ctx.logger.warn(`[dsh-undo-savepoint] desktop shortcut skipped: ${ds.error ?? 'unknown'}`);
        }).catch((e) => { try { ctx.logger.warn(`[dsh-undo-savepoint] desktop shortcut skipped: ${String(e?.message ?? e)}`); } catch { /* noop */ } });
      } catch (e) { try { ctx.logger.warn(`[dsh-undo-savepoint] desktop shortcut skipped: ${String(e?.message ?? e)}`); } catch { /* noop */ } }
      // I12：启动去重自愈——同插件多处挂载（bundle / profile patch / home patch
      // 叠加，或 include 引用重复）会导致工具重复注册、DSH 启动即崩；启动时
      // 扫描并只保留 canonical 挂载（见 dedupeMount 注释）。
      const dup = await dedupeMount(cfg);
      if (dup.removed.length > 0) {
        ctx.logger.warn(`[dsh-undo-savepoint] duplicate mounts found (${dup.found}): kept ${dup.kept}, removed ${dup.removed.join(', ')}`);
      }
      // R5/B2：安全模式启动校验——残留状态（换 home/profile/重建）降级不激活；
      // 激活中的安全模式若丢了 undo 挂载（profile 初始化竞态 H1），自动补回。
      const sm = await safeModeStatus(cfg);
      if (sm.active) {
        const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
        if (await pathExists(patch)) {
          const text = await fs.readFile(patch, 'utf8');
          if (!text.includes('dsh-undo-savepoint')) {
            if (await ensureMount(cfg)) ctx.logger.warn('[dsh-undo-savepoint] safe mode: undo mount was missing, re-ensured automatically.');
          }
        }
      } else if (sm.stale) {
        ctx.logger.warn('[dsh-undo-savepoint] safe-mode state belongs to another home/profile; treated as not active.');
      }
      const moved = await migrateLegacy(cfg);
      if (moved > 0) ctx.logger.info(`[dsh-undo-savepoint] migrated ${moved} legacy snapshot(s)`);
      // B4：启动时只读校验补丁托管清单——缺补丁只告警提示（绝不自动改文件），
      // 修复走离线脚本 tools/apply-dsh-patches.ps1 apply。
      try {
        const pv = await patchVerify(cfg);
        if (pv.ok === false && Array.isArray(pv.missing) && pv.missing.length > 0) {
          ctx.logger.warn(`[dsh-undo-savepoint] dsh-session-persistence-jsonl 缺 ${pv.missing.length} 个容错补丁（${pv.missing.join(', ')}）——会话文件损坏仍可能导致启动崩溃。离线运行 tools/apply-dsh-patches.ps1 apply 修复。`);
        } else if (pv.ok === false && typeof pv.reason === 'string' && pv.reason.startsWith('unmatched:')) {
          // v0.4.5：DSH 版本演进后补丁子串在产物中找不到（unmatched）此前完全
          // 静默——明确告警，提示清单待更新，避免 rc.1+ 用户误以为补丁仍在。
          ctx.logger.warn(`[dsh-undo-savepoint] 容错补丁与当前 DSH 版本不匹配（${pv.reason}）——补丁子串在产物中未命中，运行 tools/apply-dsh-patches.ps1 status 查看详情。插件功能不受影响，仅容错补丁失效。`);
        }
      } catch { /* 校验失败不影响启动 */ }
      const snap = await createSnapshot(cfg, 'baseline', 'plugin-mounted');
      const list = await listSnapshots(cfg);
      const pruned = await pruneAuto(cfg, list);
      const prunedN = pruned.removedAuto + pruned.removedPre;
      ctx.logger.info(`[dsh-undo-savepoint] baseline snapshot ${snap.id}${prunedN > 0 ? ` (pruned ${prunedN})` : ''}`);
    } catch (error) {
      ctx.logger.warn(`[dsh-undo-savepoint] startup: ${String(error?.message ?? error)}`);
    }
  })();

  // ── crash self-check (v0.3, module 3): boot-state.json ────────────────
  // 旧版 .booting 30s 标记；v0.3 升级为 boot-state.json，记录每次启动结果
  // 并保留"最后正常启动时间"(lastGoodAt)：
  //   apply 时 → 读上次状态，若上次 ok!=true 判定崩溃，写入本次 startedAt
  //   30s 后   → ok=true, lastGoodAt=now（正常启动完成）
  //   dispose  → 正常关闭，立即标记 ok=true
  // 崩溃瞬间无法写文件，靠"下一次启动发现上次 ok!=true"归因；lastGoodAt 用于
  // 计算"最后正常状态的快照"，undo_list / WebUI 给出具体回退目标（模块 3）。
  cfg.bootAlert = { crashed: false, lastGoodAt: null, crashReason: null };
  const bootStatePath = join(cfg.autoDir, 'boot-state.json');
  safeEffect(async () => {
    try {
      await fs.mkdir(cfg.autoDir, { recursive: true });
      // 旧版 .booting 兼容：文件残留也视为上次异常；读后即删
      const legacyCrashed = await pathExists(join(cfg.autoDir, '.booting'));
      if (legacyCrashed) fs.rm(join(cfg.autoDir, '.booting'), { force: true }).catch(() => { /* noop */ });
      let prev = null;
      try { prev = JSON.parse(await fs.readFile(bootStatePath, 'utf8')); } catch { /* 首次启动 */ }
      const crashed = legacyCrashed || (prev !== null && prev.ok !== true);
      // B5：崩溃归因 v2——上次崩溃时扫描日志尾部匹配签名，分类存进 bootAlert
      // 与 boot-state.json（下次启动直接复用，避免日志被滚动覆盖后丢失归因）。
      let crashReason = prev?.crashReason ?? null;
      if (crashed && !crashReason) {
        const tail = await readCrashLogTail(cfg);
        if (tail) crashReason = classifyCrash(tail.text);
      }
      cfg.bootAlert = { crashed, lastGoodAt: prev?.lastGoodAt ?? null, crashReason };
      await writeBootState(cfg, { startedAt: new Date().toISOString(), pid: process.pid, ok: false, okAt: null, lastGoodAt: prev?.lastGoodAt ?? null, crashReason });
      const timer = setTimeout(async () => {
        try {
          const cur = await readBootState(cfg) ?? {};
          await writeBootState(cfg, { ...cur, ok: true, okAt: new Date().toISOString(), lastGoodAt: new Date().toISOString(), crashReason: null });
        } catch { /* noop */ }
      }, 30000);
      return () => {
        clearTimeout(timer);
        // 正常关闭：标记本次启动成功，避免误报崩溃
        writeBootState(cfg, { startedAt: new Date().toISOString(), pid: process.pid, ok: true, okAt: new Date().toISOString(), lastGoodAt: new Date().toISOString(), crashReason: null }).catch(() => { /* noop */ });
      };
    } catch (error) {
      ctx.logger.warn(`[dsh-undo-savepoint] boot state failed: ${String(error?.message ?? error)}`);
      return () => { /* noop */ };
    }
  }, 'dsh-undo-savepoint.bootstate');

  // ── tools ──────────────────────────────────────────────────────────────
  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_snapshot',
    description: 'Create a MANUAL config snapshot (stored in the manual store, never auto-pruned; e.g. "before installing X", "known-good baseline"). Snapshots are also auto-created on config changes (auto store).',
    parameters: {
      reason: { type: 'string', description: 'Why this snapshot is taken.' },
      note: { type: 'string', description: 'Snapshots have a note (optional).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags on this snapshot (optional list).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const reason = typeof args?.reason === 'string' && args.reason !== '' ? args.reason : 'manual';
      const note = typeof args?.note === 'string' ? args.note : undefined;
      const tags = Array.isArray(args?.tags) ? args.tags : undefined;
      const snap = await createSnapshot(cfg, 'manual', reason, { note, tags });
      return t('snap.created', { id: snap.id, n: snap.files.length, reason, dir: cfg.manualDir }) + (tags?.length ? '\n[' + tags.join(', ') + ']' : '');
    },
  })), 'dsh-undo-savepoint.tool.snapshot');

  // V0.4.0 P4：给快照设置/清空备注与标签。
  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_note',
    description: 'Set or clear a snapshot\'s note/tags. Useful to annotate a snapshot after creation. Pass note (or note: \'\' to clear) and/or tags.',
    parameters: {
      id: { type: 'string', description: 'Snapshot id.' },
      note: { type: 'string', description: 'New note; empty string clears the note.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'New tags list; empty array clears the tags.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const id = typeof args?.id === 'string' && args.id ? args.id : null;
      if (!id) return 'Please provide a snapshot id (undo_note id=<id>).';
      const patch = {};
      if ('note' in (args ?? {})) patch.note = args.note ?? null;
      if ('tags' in (args ?? {})) patch.tags = Array.isArray(args.tags) ? args.tags : [];
      const r = await setSnapshotMeta(cfg, id, patch);
      if (!r.ok) return `Failed to update snapshot ${id}: ${r.error ?? 'unknown'}`;
      return `Snapshot ${id} updated: note=${JSON.stringify(r.note ?? '')}, tags=${(r.tags ?? []).join(', ') || '(none)'}`;
    },
  })), 'dsh-undo-savepoint.tool.note');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_list',
    description: 'List all undo snapshots (newest first): id, time, kind (auto/manual/baseline/pre-restore), store (manual/auto), reason, file count, markers (stepped/consumed). Use before undo_restore to pick a target.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const list = await listSnapshots(cfg);
      const lastGood = await lastGoodSnapshot(cfg, list);
      const latestRedacted = (list[0]?.redacted ?? []).length;
      if (list.length === 0) return t('list.empty');
      const rows = list.map((s) => {
        const mark = [s.stepped ? 'stepped' : '', s.consumed ? 'consumed' : ''].filter(Boolean).join(',');
        const loc = s._store ?? dirLabel(cfg, s._dir);
        const pluginCount = (s.plugins ?? []).reduce((n, p) => n + (p.files ?? []).length, 0)
          + (s.profileFiles ?? []).filter((f) => f.hash).length;
        const truncated = (s.plugins ?? []).some((p) => p.truncated);
        const sizeTxt = typeof s.totalBytes === 'number' ? `, ${fmtBytes(s.totalBytes)}` : '';
        return `${s.id}  ${(s.time ?? '').replace('T', ' ').slice(0, 19)}  ${s.kind}${mark ? ` [${mark}]` : ''}${truncated ? ' [truncated]' : ''}  [${loc}]  ${(s.reason ?? '').slice(0, 50)}  (${s.files.length} file(s)${pluginCount > 0 ? `, ${pluginCount} plugin file(s)` : ''}${sizeTxt})`;
      });
      const alert = cfg.bootAlert?.crashed
        ? `⚠️ Previous DSH run did not finish starting (crashed or was killed).${lastGood ? ` Last known-good snapshot: ${lastGood.id} (${(lastGood.time ?? '').replace('T', ' ').slice(0, 19)}${lastGood.reason ? `, ${lastGood.reason}` : ''}).` : ''} You may want to undo back to it: undo_restore mode "id" snapshot_id ${lastGood?.id ?? '<id from list>'}.${crashAdvice(cfg.bootAlert?.crashReason)} If DSH cannot boot at all, use undo_safe_mode action "on" to boot with only this plugin.\n`
        : '';
      return `${alert}Snapshots (newest first):\n${rows.join('\n')}\n\nProfile: ${cfg.profileName}\nSensitive mode: ${cfg.sensitiveMode ?? 'redact'}${latestRedacted > 0 ? ` (latest snapshot redacted ${latestRedacted} file(s))` : ''}\nManual store: ${cfg.manualDir}\nAuto store: ${cfg.autoDir}`;
    },
  })), 'dsh-undo-savepoint.tool.list');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_diff',
    description: 'Preview the difference between the current config and a snapshot, before restoring it.',
    parameters: {
      snapshot_id: { type: 'string', required: true, description: 'Snapshot id from undo_list, or "latest" for the newest one.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const id = typeof args?.snapshot_id === 'string' ? args.snapshot_id : '';
      const list = await listSnapshots(cfg);
      const snap = id === 'latest' ? list[0] ?? null : findSnapshot(list, id);
      if (!snap) return t('diff.notFound', { id: id ?? '(empty)' });
      return t('diff.title', { id: snap.id }) + '\n' + await diffSnapshot(cfg, snap);
    },
  })), 'dsh-undo-savepoint.tool.diff');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_restore',
    description: 'Roll back DSH config to a snapshot. mode "undo" reverts the latest change (undo last action; repeats walk further back); mode "redo" re-applies the state saved before the last undo (only when nothing changed since); mode "id" restores an explicit snapshot from undo_list (restore to a fixed version). The current state is always preserved as a pre-restore snapshot first, and the dsh-undo-savepoint mount itself is re-ensured.',
    parameters: {
      mode: { type: 'string', required: true, description: '"undo" | "redo" | "id"' },
      snapshot_id: { type: 'string', description: 'Required when mode is "id".' },
      sync_deps: { type: 'boolean', description: 'After restoring package.json/pnpm-lock.yaml, run pnpm install --frozen-lockfile so node_modules matches the snapshot. Default false: only reports that dependencies may be out of sync.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const mode = typeof args?.mode === 'string' ? args.mode : 'undo';
      const id = typeof args?.snapshot_id === 'string' ? args.snapshot_id : undefined;
      if (!['undo', 'redo', 'id'].includes(mode)) return t('restore.unknownMode', { mode });
      return renderRestoreResult(await restore(cfg, mode, id, { syncDeps: args?.sync_deps === true }));
    },
  })), 'dsh-undo-savepoint.tool.restore');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_prune',
    description: 'Delete expired snapshots right now: auto/baseline beyond keepAuto and pre-restore beyond keepPre (respects the autoCleanup setting; manual snapshots are never touched). Use when the user asks to clean up snapshots.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const list = await listSnapshots(cfg);
      const r = await pruneAuto(cfg, list);
      if (cfg.autoCleanup === false) return t('prune.disabled');
      return t('prune.done', { a: r.removedAuto, p: r.removedPre, blobs: r.removedBlobs > 0 ? t('prune.blobs', { b: r.removedBlobs }) : '', keepAuto: cfg.keepAuto, keepPre: cfg.keepPre });
    },
  })), 'dsh-undo-savepoint.tool.prune');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_doctor',
    description: 'Run a one-click diagnostic of the snapshot store AND the boot preflight (store dirs writable, blob integrity, settings file, snapshot counts, plus the things that stop DSH from booting before any plugin mounts: profile manifest BOM/JSON/shape, dsh.profile.bundles, link: junctions, duplicate loader entry ids, last unfinished boot). With fix=true it repairs what it can (pre-fix manual snapshot first, re-checked afterwards). Use when the user asks to diagnose, check health, or "is my undo snapshots okay", or when DSH failed to start.',
    // 参数必须是「属性映射」形式（value schema 平铺），与 undo_scan 等一致；
    // dsh-tools 0.0.1-rc.1 的 defineTool 拒绝 { type:'object', properties } 包装（M1 修复）。
    parameters: {
      include_fix_hints: {
        type: 'boolean',
        description: 'Include actionable fix hints for any warn/error checks (default true).',
      },
      fix: {
        type: 'boolean',
        description: 'Repair the fixable problems found by the preflight check (default false). Takes a pre-fix manual snapshot and re-checks the result.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (p) => {
      const hints = p?.include_fix_hints !== false;
      const render = (r) => {
        const lines = [t('doctor.head', { level: r.summary.level, ok: r.summary.ok, warn: r.summary.warn, err: r.summary.err })];
        for (const c of r.checks) {
          const mark = c.level === 'err' ? '❌' : c.level === 'warn' ? '⚠️' : '✅';
          lines.push(`${mark} ${c.name}${c.fixable ? ' [fixable]' : ''}: ${c.detail}`);
          if (hints && c.fix) lines.push(`   → ${c.fix}`);
        }
        if (r.fixable > 0) lines.push(t('doctor.canFix', { n: r.fixable }));
        lines.push(t('doctor.tail', { total: r.counts.total }));
        return lines;
      };
      if (p?.fix) {
        const r = await runDoctorFix(cfg);
        const lines = [t('doctor.fixHead')];
        if (r.snapshotId) lines.push(t('doctor.fixSnapshot', { id: r.snapshotId }));
        if (r.applied.length === 0) lines.push(t('doctor.fixNothing'));
        for (const a of r.applied) {
          lines.push(`${a.ok ? '✅' : '❌'} ${a.code}  ${a.target}`);
          lines.push(`   ${a.action}${a.error ? ` (${a.error})` : ''}`);
        }
        lines.push(t('doctor.fixSummary', { fixed: r.fixed, failed: r.failed }));
        lines.push('', t('doctor.recheck'), ...render(r.report));
        return lines.join('\n');
      }
      return render(await runDoctor(cfg)).join('\n');
    },
  })), 'dsh-undo-savepoint.tool.doctor');

  // ── 消息级撤销（V0.4.0，P6）──────────
  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_message_list',
    description: 'List recorded message-level file-change batches (most recent first). Each batch = a group of file writes by one AI message or a 60s window. Use before undo_message to pick a batch id.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const l = await listMessageOps(cfg);
      if (!l.length) return t('msg.none');
      return t('msg.list', { n: l.length }) + '\n' + l.map((b) => `- ${b.id}  ${b.startedAt ?? '?'}  ${b.files} files  ${b.messageId ? `msg=${b.messageId}` : ''}  [${(b.tools ?? []).join(', ')}]`).join('\n');
    },
  })), 'dsh-undo-savepoint.tool.msgl');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_message',
    description: 'Roll back the file changes made by a message batch (reverse order): restore files to their before-content, or delete newly-created files. Use after undo_message_list to pick a batch id. Does NOT touch the DSH session store (no public delete API); it only restores the workspace files.',
    parameters: {
      message_id: {
        type: 'string',
        description: 'Batch id from undo_message_list, or "latest" (default) for the most recent batch.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (p) => {
      const r = await undoMessage(cfg, p?.message_id ?? 'latest');
      if (!r.ok) return t('msg.failed', { err: r.error });
      return t('msg.undone', { id: r.batchId, msg: r.messageId ?? '-', c: r.changed.length, d: r.deleted.length, m: r.missing.length, n: r.skipped.length }) + (r.notes ? `\n${r.notes}` : '');
    },
  })), 'dsh-undo-savepoint.tool.msg');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_compact',
    description: 'Garbage-collect orphan blob files (blobs not referenced by any snapshot or message batch) and leftover .tmp files. Frees disk space without touching any live snapshot data.',
    parameters: {
      dry_run: { type: 'boolean', description: 'Only report what would be removed without deleting anything (default false).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (p) => {
      if (p?.dry_run === true) return 'undo_compact dry-run: run "undo_compact" (without dry_run) to actually delete orphans.';
      const r = await undoCompact(cfg);
      if (!r.ok) return t('compact.failed', { err: r.error });
      return r.removed === 0 ? t('compact.none') : t('compact.done', { n: r.removed, freed: fmtBytes(r.freed) });
    },
  })), 'dsh-undo-savepoint.tool.compact');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_export',
    description: 'Export ALL snapshots (manual + auto) into a portable ZIP archive (default: <snapshot root>/../undo-exports). Use for backup or moving to another machine. Returns the archive path.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const r = await exportSnapshots(cfg);
      if (!r.ok) return t('export.failed', { err: r.error });
      const warn = r.sensitiveWarning ? t('export.warn') : '';
      return t('export.done', { n: r.count, path: r.path }) + warn;
    },
  })), 'dsh-undo-savepoint.tool.export');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_import',
    description: 'Import snapshots from a dsh-undo-savepoint export ZIP. Snapshots are restored into the matching store by kind; same-id snapshots are skipped. The user can give you the zip path, or you can ask them to click Import in the snapshot panel.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the export zip file.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const path = typeof args?.path === 'string' ? args.path : '';
      const r = await importSnapshots(cfg, path);
      if (!r.ok) return t('import.failed', { err: r.error });
      return t('import.done', { n: r.imported, source: r.source, skipped: r.skipped > 0 ? t('import.skipped', { s: r.skipped }) : '' });
    },
  })), 'dsh-undo-savepoint.tool.import');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_recent',
    description: 'List the most recent rollback operations (undo/redo/restore): time, mode, target snapshot, and WHICH config files were rolled back. Use this when the user is confused about the current config state (e.g. a plugin or setting suddenly missing or different, or a long futile debugging loop) to check whether a recent rollback explains it. Rollbacks may have happened in another session or via the offline tools.',
    parameters: {
      limit: { type: 'string', description: 'How many entries to show (default 5, max 20).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Math.min(20, Math.max(1, parseInt(args?.limit ?? '5', 10) || 5));
      const file = join(dirname(cfg.settingsFile), 'rollback-log.jsonl');
      let lines = [];
      try { lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean); } catch { /* none yet */ }
      if (lines.length === 0) return t('recent.empty');
      const rows = lines.slice(-limit).reverse().map((l) => {
        try {
          const e = JSON.parse(l);
          return `${e.ts ?? ''}  ${e.mode ?? '?'}  -> ${e.targetId ?? ''}${Array.isArray(e.files) && e.files.length > 0 ? `  files: ${e.files.join(', ')}` : ''}`;
        } catch { return '(unreadable entry)'; }
      });
      return `Recent rollback operations (newest first):\n${rows.join('\n')}`;
    },
  })), 'dsh-undo-savepoint.tool.recent');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_safe_mode',
    description: 'Toggle SAFE MODE (v0.3.8): disable ALL user plugins except dsh-undo-savepoint so DSH can always boot even when a plugin broke startup. Entering also neutralizes profile bundles that would fail the boot loader hard check (unresolvable / no dsh.bundle.patch / missing patch file) — the original profile package.json is backed up and fully restored on exit. action "on" enters (auto-snapshots first, backs up cordis.patch.yml), "off" restores the previous plugin set, "status" reports. A DSH restart is required for on/off to take effect.',
    parameters: {
      action: { type: 'string', required: true, description: '"on" | "off" | "status"' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const action = typeof args?.action === 'string' ? args.action : 'status';
      if (action === 'on' || action === 'off') {
        const r = await safeModeSet(cfg, action === 'on');
        if (!r.ok) return t('safemode.failed', { err: typeof r.error === 'string' ? r.error : (r.error?.message ?? 'unknown error') });
        return r.message;
      }
      const st = await safeModeStatus(cfg);
      return st.active ? t('safe.statusOn', { entered: st.enteredAt ?? '?', backup: st.backup ?? '?' }) : t('safe.statusOff');
    },
  })), 'dsh-undo-savepoint.tool.safemode');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_scan',
    description: 'Scan DSH session files (<home>/sessions/**/session.jsonl.zstd) for health: "ok" (compliant multi-frame layout), "fixable" (single-frame layout violation — the 8/18 crash root cause — or synthetic-closer seq overlap), or "corrupt" (undecodable / invalid header / bad JSON lines). With quarantine=true, fixable files are repaired in place: original is copied to <undo root>/corrupt-quarantine/ and kept as <file>.bak, then recoded to header frame + event frames with triple verification (round-trip text, per-line JSON, re-analysis); corrupt files are only isolated (copied, never touched). Read-only by default.',
    parameters: {
      quarantine: { type: 'boolean', description: 'Repair fixable files (backup + recode + verify + replace); corrupt files are isolated only. Default false = read-only scan.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      try { assertZstd(); } catch (e) {
        if (e?.code === ZSTD_UNSUPPORTED) return `undo_scan unavailable on this Node version: ${e.message}`;
        throw e;
      }
      const quarantine = args?.quarantine === true;
      const files = await walkSessionFiles(cfg);
      const lines = [];
      let ok = 0, fixed = 0, needsFix = 0, isolated = 0, corrupt = 0;
      for (const p of files) {
        let raw;
        try { raw = await fs.readFile(p); } catch (error) {
          lines.push(`  unreadable ${p} (${String(error?.message ?? error)})`);
          corrupt++;
          continue;
        }
        const a = analyzeSessionBytes(raw);
        if (a.status === 'ok') {
          lines.push(`  ok       ${p} (${a.events} events, ${a.frames} frames)`);
          ok++;
          continue;
        }
        if (a.status === 'fixable') {
          if (quarantine) {
            try {
              const fixedBytes = recodeSessionBytes(raw, a);
              const qdir = join(cfg.autoDir, '..', 'corrupt-quarantine');
              await fs.mkdir(qdir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              await fs.writeFile(join(qdir, `${basename(dirname(p))}-${stamp}.jsonl.zstd`), raw);
              await fs.writeFile(p + '.bak', raw);
              await fs.writeFile(p, fixedBytes);
              const label = a.reason === 'synthetic-closer overlap'
                ? `synthetic-closer overlap, removed ${a.repairEnd - a.repairStart} bytes -> contiguous tail`
                : 'single-frame violation, header frame + event frame';
              lines.push(`  fixed    ${p} (${label}; original -> .bak)`);
              fixed++;
            } catch (error) {
              lines.push(`  failed   ${p} (${String(error?.message ?? error)})`);
              corrupt++;
            }
          } else {
            const label = a.reason === 'synthetic-closer overlap'
              ? `synthetic-closer overlap, ${a.events} events; rerun with quarantine=true to repair`
              : `single-frame violation, ${a.events} events; rerun with quarantine=true to repair`;
            lines.push(`  fixable  ${p} (${label})`);
            needsFix++;
          }
          continue;
        }
        // corrupt：quarantine 时只隔离（复制），绝不动原件
        let didIsolate = false;
        if (quarantine) {
          try {
            const qdir = join(cfg.autoDir, '..', 'corrupt-quarantine');
            await fs.mkdir(qdir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            await fs.writeFile(join(qdir, `${basename(dirname(p))}-${stamp}-corrupt.jsonl.zstd`), raw);
            didIsolate = true;
            isolated++;
          } catch { /* 隔离失败不阻断扫描 */ }
        }
        lines.push(`  corrupt  ${p} (${a.reason})${didIsolate ? ' -> isolated' : ''}`);
        corrupt++;
      }
      const head = `undo_scan: scanned ${files.length} session file(s)${quarantine ? ' (quarantine mode)' : ''}`;
      return [head, ...lines, `summary: ${ok} ok, ${fixed} fixed, ${needsFix} fixable, ${isolated} isolated, ${corrupt} corrupt`].join('\n');
    },
  })), 'dsh-undo-savepoint.tool.scan');

  safeEffect(() => ctx.systemPrompt.section({
    name: 'tool:dsh-undo-savepoint',
    order: 117,
    text: PROMPT_TEXT,
  }), 'dsh-undo-savepoint.prompt');

  // ── auto-archive watcher (debounced, rebuildable) ──────────────────────
  // v0.2：除 profile/home 配置目录外，还监听用户插件代码树（每个子目录单独
  // fs.watch——Windows 不支持 recursive）。事件只记录 {dir, file}，flush 时
  // 再区分配置变更与插件代码变更，各自做 echo 检测（恢复动作不误伤）。
  let watcherDispose = null;
  const startWatcher = () => {
    if (watcherDispose) { try { watcherDispose(); } catch { /* noop */ } watcherDispose = null; }
    if (!cfg.autoEnabled) return;
    let timer = null;
    const pending = new Set(); // { dir, file }
    const pluginByDir = new Map(); // 插件目录 → 插件信息（flush 时判断事件归属）
    const schedule = () => {
      if (cfg.suppressAuto > 0) return; // a restore is writing files right now
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = null;
        const items = [...pending];
        pending.clear();
        if (items.length === 0) return;
        const configDirs = new Set([rootDir(cfg, 'profile'), rootDir(cfg, 'home')]);
        const configNames = [];
        const pluginEvents = [];
        const profileCodeEvents = []; // #33：profile 根下被 cordis.patch.yml 引用的代码文件
        for (const { dir, file } of items) {
          if (configDirs.has(dir)) {
            if (WATCHED_BASENAMES.has(basename(file))) configNames.push(file);
            else if (isCodeFile(file)) profileCodeEvents.push(file);
          } else if (isCodeFile(file)) {
            pluginEvents.push({ dir, file });
          }
        }
        // #33：profile 根下的事件按 cordis.patch.yml 引用集合过滤——只关心被引用
        // 的代码文件（快照采集收的就是这批，collectProfileCodeRefs 与之同源），
        // 其余（临时文件、无关脚本）不触发。已知边界：fs.watch 对 profile 根是
        // 非递归监听，引用子目录路径时不触发，后续有真实用例再补。
        // echo 检测：恢复动作写回的 profile 代码文件内容仍与 restoredHashes 的
        // `profile:` 记录一致 → echo，不触发快照（否则挡住 redo）。
        const isProfileCodeEcho = async (file) => {
          if (!cfg.restoredHashes || cfg.restoredHashes.size === 0) return false;
          try {
            const h = sha1Hex(await fs.readFile(join(rootDir(cfg, 'profile'), file)));
            return cfg.restoredHashes.get(`profile:${file}`) === h;
          } catch { return false; /* 读不到（已删除）→ 真实变更 */ }
        };
        let profileReasons = [];
        if (profileCodeEvents.length > 0) {
          try {
            const refSet = new Set((await collectProfileCodeRefs(cfg)).map((r) => r.path));
            const candidates = profileCodeEvents.filter((f) => refSet.has(f));
            for (const f of candidates) {
              if (!(await isProfileCodeEcho(f))) profileReasons.push(`profile:${f}`);
            }
          } catch { profileReasons = []; /* 引用集合读不出来时按无事件处理 */ }
        }
        // 配置文件 echo 检测：恢复动作自己写的内容不存档（否则挡住 redo）
        if (configNames.length > 0 && cfg.restoredHashes && cfg.restoredHashes.size > 0) {
          let allEcho = true;
          for (const filename of configNames) {
            const spec = FILE_SPECS.find((s) => basename(s.rel) === filename);
            if (!spec) { allEcho = false; break; }
            try {
              const p = filePath(cfg, spec);
              const h = sha1Hex(await fs.readFile(p));
              if (h !== cfg.restoredHashes.get(destName(spec))) { allEcho = false; break; }
            } catch { allEcho = false; break; }
          }
          if (allEcho) configNames.length = 0; // 全是恢复的 echo，忽略
        }
        // 插件代码 echo 检测：事件文件在插件树里仍全部等于恢复写入的内容 → echo
        const pluginReasons = [];
        for (const ev of pluginEvents) {
          const plugin = pluginByDir.get(ev.dir);
          if (!plugin || await isPluginEcho(cfg, plugin, ev.file)) continue;
          pluginReasons.push(`plugin:${plugin.name}/${ev.file}`);
        }
        if (configNames.length === 0 && pluginReasons.length === 0 && profileReasons.length === 0) return;
        cfg.restoredHashes = new Map(); // a real change supersedes echo records
        try {
          // 优先级沿用既有约定：插件代码 > profile 代码 > 配置文件分类
          const reason = pluginReasons.length > 0 ? 'plugin-code-change'
            : profileReasons.length > 0 ? 'profile-code-change'
              : classifyChange(configNames);
          const snap = await createSnapshot(cfg, 'auto', reason);
          const list = await listSnapshots(cfg);
          const pruned = await pruneAuto(cfg, list);
          const prunedN = pruned.removedAuto + pruned.removedPre;
          if (snap.files.length > 0 || (snap.plugins ?? []).length > 0 || (snap.profileFiles ?? []).length > 0) ctx.logger.info(`[dsh-undo-savepoint] auto snapshot ${snap.id} (${snap.files.length} config file(s), ${(snap.plugins ?? []).length} plugin tree(s), ${(snap.profileFiles ?? []).length} profile code file(s), ${reason}${prunedN > 0 ? `, pruned ${prunedN}` : ''})`);
        } catch (error) {
          ctx.logger.warn(`[dsh-undo-savepoint] auto snapshot failed: ${String(error?.message ?? error)}`);
        }
      }, cfg.watchDebounceMs);
    };
    const onEvent = (dir, _event, filename) => {
      if (typeof filename !== 'string') return;
      pending.add({ dir, file: filename });
      schedule();
    };
    const watchers = [];
    const watchDir = (dir) => {
      if (!existsSync(dir)) return;
      try {
        const w = fsWatch(dir, (e, f) => onEvent(dir, e, f));
        // Windows 上被监听目录被删除/重命名时，FSWatcher 会异步抛 EPERM；
        // 不挂 error 处理器会变成未捕获 'error' 事件，直接把进程炸掉
        // （smoke-test 删临时目录、真实使用中卸载插件/改目录名都会触发）。
        w.on('error', (error) => {
          const idx = watchers.indexOf(w);
          if (idx >= 0) watchers.splice(idx, 1);
          try { w.close(); } catch { /* noop */ }
          ctx.logger.warn(`[dsh-undo-savepoint] watcher stopped on ${dir}: ${String(error?.message ?? error)}`);
        });
        watchers.push(w);
      } catch (error) {
        ctx.logger.warn(`[dsh-undo-savepoint] cannot watch ${dir}: ${String(error?.message ?? error)}`);
      }
    };
    watcherDispose = safeEffect(() => {
      for (const dir of [rootDir(cfg, 'profile'), rootDir(cfg, 'home')]) watchDir(dir);
      // 插件代码树：异步发现（junction 解析），注册配置目录后补上
      void (async () => {
        for (const p of await discoverPlugins(cfg)) {
          const tree = await collectPluginTree(cfg, p.dir);
          // 子目录事件也要能反查到所属插件（fs.watch 每个子目录单独监听）
          pluginByDir.set(p.dir, p);
          watchDir(p.dir);
          for (const rel of tree.dirs) {
            pluginByDir.set(join(p.dir, rel), p);
            watchDir(join(p.dir, rel));
          }
        }
      })();
      return () => {
        for (const w of watchers) { try { w.close(); } catch { /* noop */ } }
        if (timer) clearTimeout(timer);
      };
    }, 'dsh-undo-savepoint.watch');
  };
  startWatcher();

  // ── 定时快照（V0.4.0 P4）：可选，按设置间隔自动创建 auto 快照，销毁时清理。
  let scheduledTimer = null;
  const startScheduledTimer = () => {
    if (scheduledTimer) { clearInterval(scheduledTimer); scheduledTimer = null; }
    const ms = cfg.scheduledSnapshotEnabled ? Math.max(Number(cfg.scheduledSnapshotMs) || 0, 60_000) : 0;
    if (!ms) return;
    scheduledTimer = setInterval(() => {
      void (async () => {
        try {
          await createSnapshot(cfg, 'auto', 'scheduled');
          await pruneAuto(cfg, await listSnapshots(cfg));
        } catch (e) {
          try { ctx.logger.warn(`[dsh-undo-savepoint] scheduled snapshot failed: ${String(e?.message ?? e)}`); } catch { /* noop */ }
        }
      })();
    }, ms);
    if (scheduledTimer.unref) scheduledTimer.unref();
  };
  safeEffect(() => {
    startScheduledTimer();
    return () => { if (scheduledTimer) { clearInterval(scheduledTimer); scheduledTimer = null; } };
  }, 'dsh-undo-savepoint.schedule');

  // ── 消息级撤销追踪（V0.4.0，P6）：tools/pre-execute 记录工作区文件变更 ────
  // 只关心白名单里的文件写入工具；越界/大文件/配置目录一律放行不追踪；
  // 归属按"消息 id（若可解析）否则 60s 时间窗口"分组。任何异常都吞掉并放行，
  // 绝不让追踪层干扰工具执行（追踪是旁路，非阻断）。
  if (typeof ctx.on === 'function') {
    safeEffect(() => {
      let msgBatch = null;
      const filePathFromToolArgs = (name, args) => {
        if (!args || typeof args !== 'object') return null;
        const p = args.path || args.file_path || args.file;
        return typeof p === 'string' && p !== '' ? p : null;
      };
      const inWorkspaceScope = (p) => {
        const abs = p.toLowerCase();
        if ([cfg.manualDir, cfg.autoDir].some((d) => abs.startsWith(d.toLowerCase()))) return false;
        if ([LEGACY_ROOT, DSH_HOME].some((d) => abs.startsWith(d.toLowerCase()))) return false;
        const dirs = (cfg.workspaceDirs?.length ? cfg.workspaceDirs : [process.cwd()]).filter(Boolean);
        return dirs.some((d) => abs.startsWith(d.toLowerCase()));
      };
      const ensureBatch = (exec) => {
        const now = Date.now();
        const msgId = exec?.agent?.messageId ?? exec?.agent ?? null;
        if (msgBatch && (now - msgBatch.lastTs) <= 60000 && msgBatch.messageId === msgId) { msgBatch.lastTs = now; return msgBatch; }
        const batchId = `msg-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.floor(Math.random() * 1000)}`;
        msgBatch = { batchId, messageId: msgId, lastTs: now };
        return msgBatch;
      };
      return ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          const name = exec?.name;
          if (!name || !(cfg.fileToolWhitelist ?? []).includes(name)) return next();
          const p = filePathFromToolArgs(name, exec?.args);
          if (!p || !inWorkspaceScope(p)) return next();
          let buf = null;
          try { buf = await fs.readFile(p); } catch { /* absent */ }
          if (buf && buf.length > 262144) { await next(); return; }
          const beforeHash = buf ? sha1Hex(buf) : null;
          if (buf) await writeBlob(cfg, beforeHash, buf);
          await next();
          // #34：记录工具执行后的内容指纹。撤回守卫据此跳过被后续消息改写的
          // 文件。执行后超过 256KB 的只记 afterExists 不记指纹（守卫退化为
          // 仅存在性比对），与快照采集的体积上限保持一致。
          let afterHash = null;
          let afterExists = false;
          try {
            const afterBuf = await fs.readFile(p);
            afterExists = true;
            if (afterBuf.length <= 262144) afterHash = sha1Hex(afterBuf);
          } catch { /* 执行后文件已不存在 */ }
          const batch = ensureBatch(exec);
          await appendMessageOp(cfg, { batchId: batch.batchId, messageId: batch.messageId, op: { tool: name, path: p, beforeHash, beforeExists: !!buf, afterHash, afterExists, ts: Date.now() } });
          void pruneMessageOps(cfg).catch(() => { /* noop */ });
        } catch (e) {
          try { ctx.logger.warn(`[dsh-undo-savepoint] msg-ops pre-execute hook degraded: ${String(e?.message ?? e)}`); } catch { /* noop */ }
          try { await next(); } catch { /* noop */ }
        }
      });
    }, 'dsh-undo-savepoint.msgops');
  }

  // ── REST API for the WebUI ─────────────────────────────────────────────
  const webServer = ctx.webServer ?? ctx.get('webServer');
  if (webServer) {
    const send = (res, status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); // dsh-mobile undo no-store (U1)
      res.end(text);
    };
    // dsh-mobile undo route auth (U1): /api/undo is a longer prefix than /api, so it must
    // enforce the same Host/Origin/browser-session fence before every read or mutation.
    const dshMobileUndoHeader = (req, name) => {
      const value = req?.headers?.[name];
      return typeof value === 'string' ? value : (Array.isArray(value) ? value[0] : undefined);
    };
    const dshMobileUndoControlToken = () => {
      const valid = (value) => typeof value === 'string' && value.length >= 8 ? value : undefined;
      const prefsPath = process.env.DSH_ADB_PREFS_PATH
        ?? ((process.env.TERMUX__PREFIX && process.env.DSH_HOME) ? '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh-adb.xml' : undefined);
      let fromPrefs;
      if (prefsPath) {
        try { fromPrefs = valid(/<string\s+name="controlToken">([^<]*)<\/string>/.exec(readFileSync(prefsPath, 'utf8'))?.[1]); }
        catch { /* Android prefs unavailable: the browser-session path below remains fail-closed. */ }
      }
      const testMode = process.env.DSH_CONTROL_TOKEN_TEST;
      return testMode === '1' || testMode === 'true' ? valid(process.env.DSH_CONTROL_TOKEN) ?? fromPrefs : fromPrefs;
    };
    // The engine may bind an OS-assigned fallback port. Read it per request so the
    // route cannot keep trusting the default after the shell publishes the real port.
    const dshMobileUndoEnginePort = () => {
      const raw = process.env.DSH_ENGINE_PORT;
      if (raw === undefined) return 4145;
      if (!/^[0-9]+$/.test(raw)) return null;
      const port = Number(raw);
      return Number.isSafeInteger(port) && port >= 1024 && port <= 65535 ? port : null;
    };
    const dshMobileUndoAuthority = (value, origin = false) => {
      const port = dshMobileUndoEnginePort();
      if (port === null || typeof value !== 'string') return false;
      const normalized = value.trim().toLowerCase();
      const prefix = origin ? 'http://' : '';
      return normalized === prefix + '127.0.0.1:' + port || normalized === prefix + 'localhost:' + port;
    };
    const dshMobileUndoAuthorize = (req) => {
      let connection;
      try { connection = ctx.get?.('connection'); } catch { connection = undefined; }
      if (typeof connection?.requestRejection === 'function') {
        try {
          const rejection = connection.requestRejection(req);
          if (rejection === undefined) return undefined;
          if (rejection === 403) return { status: 403 };
          const controlToken = dshMobileUndoControlToken();
          return controlToken !== undefined && controlToken === dshMobileUndoHeader(req, 'x-dsh-control-token') ? undefined : { status: 401 };
        } catch { return { status: 401 }; }
      }
      const host = dshMobileUndoHeader(req, 'host')?.trim().toLowerCase();
      if (!dshMobileUndoAuthority(host)) return { status: 403 };
      if (dshMobileUndoHeader(req, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { status: 403 };
      const origin = dshMobileUndoHeader(req, 'origin');
      if (origin && !dshMobileUndoAuthority(origin, true)) return { status: 403 };
      const controlToken = dshMobileUndoControlToken();
      return controlToken !== undefined && controlToken === dshMobileUndoHeader(req, 'x-dsh-control-token') ? undefined : { status: 401 };
    };
    const dshMobileUndoReject = (res, rejection) => {
      if (rejection.status === 403) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    };
    const readJson = (req) => new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 65536) { req.destroy(); return; } chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw === '') return resolve({});
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    safeEffect(() => webServer.register({
      kind: 'prefix',
      path: '/api/undo',
      handler: async (req, res) => {
        const rejection = dshMobileUndoAuthorize(req);
        if (rejection !== undefined) { dshMobileUndoReject(res, rejection); return; }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local');
          const path = url.pathname;
          const method = (req.method ?? 'GET').toUpperCase();
          // M2 加固：跨站 CSRF 防护——浏览器跨源 POST 必带 Origin，与 Host 不符即拒；
          // 无 Origin（本机脚本/curl）放行。同源 UI 请求 Origin.host === Host，不受影响。
          const origin = req.headers?.origin;
          if (origin) {
            let ok = false;
            try {
              const o = new URL(origin);
              const host = String(req.headers?.host ?? '');
              ok = o.host === host && (o.protocol === 'http:' || o.protocol === 'https:');
            } catch { ok = false; }
            if (!ok) {
              return send(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-origin request rejected' } });
            }
          }
          if (method === 'GET' && path === '/api/undo/list') {
            const snapshots = (await listSnapshots(cfg)).map((s) => {
              const { _dir, _store, ...rest } = s;
              return { ...rest, location: _store ?? dirLabel(cfg, _dir) };
            });
            return send(res, 200, { ok: true, snapshots });
          }
          if (method === 'GET' && path === '/api/undo/status') {
            const list = await listSnapshots(cfg);
            const cur = await currentState(cfg);
            const candidates = await undoCandidates(cfg, list);
            const canUndo = candidates.some((c) => !sameState(cur, c.st));
            const pre = list.find((s) => s.kind === 'pre-restore' && !s.consumed);
            const canRedo = pre !== undefined
              && !list.some((s) => s.time > pre.time && (s.kind !== 'pre-restore' || !s.consumed));
            const lastGood = await lastGoodSnapshot(cfg, list);
            const safeMode = await safeModeStatus(cfg);
            return send(res, 200, { ok: true, canUndo, canRedo, total: list.length, bootAlert: cfg.bootAlert?.crashed === true, crashReason: cfg.bootAlert?.crashReason ?? null, lastGoodSnapshotId: lastGood?.id ?? null, safeModeActive: safeMode.active === true, safeModeEnteredAt: safeMode.enteredAt ?? null });
          }
          if (method === 'GET' && path === '/api/undo/settings') {
            return send(res, 200, { ok: true, settings: publicSettings(cfg) });
          }
          if (method === 'GET' && path === '/api/undo/diff') {
            const id = url.searchParams.get('id') ?? '';
            const list = await listSnapshots(cfg);
            const snap = id === 'latest' ? list[0] ?? null : findSnapshot(list, id);
            if (!snap) return send(res, 404, { ok: false, error: { code: 'not-found', message: `snapshot not found: ${id}` } });
            return send(res, 200, { ok: true, id: snap.id, diff: await diffSnapshotStructured(cfg, snap) });
          }
          if (method === 'GET' && path === '/api/undo/tree') {
            const id = url.searchParams.get('id') ?? '';
            const list = await listSnapshots(cfg);
            const snap = id === 'latest' ? list[0] ?? null : findSnapshot(list, id);
            if (!snap) return send(res, 404, { ok: false, error: { code: 'not-found', message: `snapshot not found: ${id}` } });
            return send(res, 200, { ok: true, id: snap.id, tree: await diffTree(cfg, snap) });
          }
          if (method === 'POST' && path === '/api/undo/note') {
            const body = await readJson(req);
            const r = await setSnapshotMeta(cfg, body?.id ?? '', body ?? {});
            return send(res, r.ok ? 200 : 404, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/settings') {
            const body = await readJson(req);
            if (typeof body.autoEnabled === 'boolean') cfg.autoEnabled = body.autoEnabled;
            if (typeof body.autoCleanup === 'boolean') cfg.autoCleanup = body.autoCleanup;
            if (Number.isFinite(body.watchDebounceMs)) cfg.watchDebounceMs = clamp(Math.round(body.watchDebounceMs), 200, 60000);
            if (Number.isFinite(body.keepAuto)) cfg.keepAuto = clamp(Math.round(body.keepAuto), 1, 500);
            if (Number.isFinite(body.keepPre)) cfg.keepPre = clamp(Math.round(body.keepPre), 0, 500);
            const normDir = (v) => (typeof v === 'string' ? v.trim().replace(/[\\/]+$/, '') : '');
            if (normDir(body.manualDir) !== '') cfg.manualDir = normDir(body.manualDir);
            if (normDir(body.autoDir) !== '') cfg.autoDir = normDir(body.autoDir);
            // v0.2：插件目录白名单（数组或逗号/分号分隔字符串）
            if (Array.isArray(body.pluginDirs)) cfg.pluginDirs = body.pluginDirs.map((s) => String(s).trim()).filter(Boolean);
            else if (typeof body.pluginDirs === 'string') cfg.pluginDirs = body.pluginDirs.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
            // v0.4.0：消息级撤销工作区范围（逗号/分号分隔可多选；非空时覆盖默认 [process.cwd()]；留空=仅当前目录）
            if (Array.isArray(body.workspaceDirs)) cfg.workspaceDirs = body.workspaceDirs.map((s) => String(s).trim()).filter(Boolean);
            else if (typeof body.workspaceDirs === 'string') cfg.workspaceDirs = body.workspaceDirs.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
            // v0.3.2：敏感模式（redact 脱敏+vault | keep 明文）
            if (body.sensitiveMode === 'redact' || body.sensitiveMode === 'keep') cfg.sensitiveMode = body.sensitiveMode;
            // V0.4.0：桌面快捷方式开关（true 时即时创建）
            if (typeof body.createDesktopShortcut === 'boolean') {
              cfg.createDesktopShortcut = body.createDesktopShortcut;
              if (body.createDesktopShortcut) void ensureDesktopShortcut(cfg).catch(() => { /* 尽力而为 */ });
            }
            // V0.4.0 P4：定时快照设置（改了即时生效，重启定时器）。
            if (typeof body.scheduledSnapshotEnabled === 'boolean') cfg.scheduledSnapshotEnabled = body.scheduledSnapshotEnabled;
            if (Number.isFinite(body.scheduledSnapshotMs)) cfg.scheduledSnapshotMs = Math.max(Math.round(body.scheduledSnapshotMs) || 0, 0);
            await fs.mkdir(dirname(cfg.settingsFile), { recursive: true });
            await fs.writeFile(cfg.settingsFile, JSON.stringify(publicSettings(cfg), null, 2), 'utf8');
            await fs.mkdir(cfg.manualDir, { recursive: true });
            await fs.mkdir(cfg.autoDir, { recursive: true });
            startWatcher();
            startScheduledTimer();
            // apply the new retention limits immediately
            const pruned = await pruneAuto(cfg, await listSnapshots(cfg));
            return send(res, 200, { ok: true, settings: publicSettings(cfg), pruned });
          }
          if (method === 'GET' && path === '/api/undo/messages') {
            return send(res, 200, { ok: true, messages: (await listMessageOps(cfg)).map((m) => ({ id: m.id, messageId: m.messageId ?? null, files: m.files ?? 0, tools: m.tools ?? [], startedAt: m.startedAt ?? null, deleted: m.deleted ?? false })) });
          }
          if (method === 'POST' && path === '/api/undo/message') {
            const body = await readJson(req);
            const r = await undoMessage(cfg, body?.id ?? 'latest');
            return send(res, 200, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/prune') {
            const r = await pruneAuto(cfg, await listSnapshots(cfg));
            return send(res, 200, { ok: true, ...r });
          }
          if (method === 'POST' && path === '/api/undo/undo') {
            const body = await readJson(req);
            const r = await restore(cfg, 'undo', undefined, { syncDeps: body?.syncDeps === true });
            return send(res, 200, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/redo') {
            const body = await readJson(req);
            const r = await restore(cfg, 'redo', undefined, { syncDeps: body?.syncDeps === true });
            return send(res, 200, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/restore') {
            const body = await readJson(req);
            const r = await restore(cfg, 'id', body?.id, { syncDeps: body?.syncDeps === true });
            return send(res, 200, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/remove') {
            const body = await readJson(req);
            return send(res, 200, { ok: true, ...await removeSnapshot(cfg, body?.id) });
          }
          if (method === 'POST' && path === '/api/undo/snapshot') {
            const body = await readJson(req);
            return send(res, 200, { ok: true, snapshot: await createSnapshot(cfg, 'manual', body?.reason ?? 'manual:api') });
          }
          if (method === 'POST' && path === '/api/undo/safe-mode') {
            const body = await readJson(req);
            const action = typeof body?.action === 'string' ? body.action : 'status';
            if (action === 'on' || action === 'off') {
              const r = await safeModeSet(cfg, action === 'on');
              return send(res, 200, { ok: r.ok, ...r });
            }
            const st = await safeModeStatus(cfg);
            return send(res, 200, { ok: true, active: st.active === true, enteredAt: st.enteredAt ?? null });
          }
          if (method === 'POST' && path === '/api/undo/pick-dir') {
            return send(res, 200, { ok: true, ...await pickDirectory() });
          }
          if (method === 'POST' && path === '/api/undo/export') {
            const body = await readJson(req);
            const r = await exportSnapshots(cfg, body?.password ?? '');
            return send(res, r.ok ? 200 : 500, { ok: r.ok, ...r });
          }
          if (method === 'POST' && path === '/api/undo/pick-file') {
            return send(res, 200, { ok: true, ...await pickFile() });
          }
          if (method === 'POST' && path === '/api/undo/import') {
            const body = await readJson(req);
            const r = await importSnapshots(cfg, body?.path, body?.password ?? '');
            return send(res, r.ok ? 200 : 500, { ok: r.ok, ...r });
          }
          return send(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${path}` } });
        } catch (error) {
          return send(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } });
        }
      },
    }), 'dsh-undo-savepoint.api');
  }
}
