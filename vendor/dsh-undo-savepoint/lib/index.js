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
import { promises as fs, watch as fsWatch, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
// node:zlib 的 zstd API（zstdCompressSync/zstdDecompressSync/ZSTD_c_checksumFlag）是
// Node 22.15+ 才提供的。用命名空间导入 + 运行时能力检测：Node 20 下该属性为
// undefined，undo_scan 降级为"明确提示不支持"，插件其余功能不受影响（不再加载即崩）。
import * as zlib from 'node:zlib';
import { homedir } from 'node:os';

/**
 * DSH 家目录解析（issue #6）：
 * 优先读 DSH_HOME 环境变量（与官方启动器一致，第三方客户端支持自定义家目录）；
 * 无 DSH_HOME 时回退 ~/.dsh（标准安装路径）。
 * USERPROFILE / HOME / homedir() 用于定位用户主目录，再拼 '.dsh'。
 */
const USER_HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
const DSH_HOME = process.env.DSH_HOME ?? join(USER_HOME, '.dsh');

/**
 * 解析当前 DSH profile（v0.3.3，issue #3 多 profile 支持）。
 * DSH 启动器（bin.js）解析 --profile <name> 后不设环境变量、不暴露 ctx 服务，
 * 但 process.argv 保留完整参数——这里自行解析。`dsh web` 是 `--profile web`
 * 的别名，回退 'web'。config.profileName 可显式覆盖。
 */
function detectProfileName() {
  const argv = process.argv ?? [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return 'web';
}

/**
 * 快照仓库按 profile 隔离（v0.3.3，issue #3）：
 * 默认 <快照根>/<profileName>/{auto,manual}；兼容旧数据——profile 作用域目录
 * 不存在而旧平铺目录存在时回退平铺（不隐身旧快照）。显式配置（settings 或
 * config）优先级更高，在 apply 里先于本函数生效。
 */
function resolveStoreRoots(profileName) {
  const scoped = join(LEGACY_ROOT, profileName);
  const hasScoped = existsSync(join(scoped, 'auto')) || existsSync(join(scoped, 'manual'));
  const hasFlat = existsSync(join(LEGACY_ROOT, 'auto')) || existsSync(join(LEGACY_ROOT, 'manual'));
  if (hasScoped || !hasFlat) {
    return { manualDir: join(scoped, 'manual'), autoDir: join(scoped, 'auto') };
  }
  return { manualDir: join(LEGACY_ROOT, 'manual'), autoDir: join(LEGACY_ROOT, 'auto') };
}

/**
 * Resolve @deepseek-ai/dsh-tools without hardcoding any machine path.
 * 1) Anchor at THIS plugin's own location first: standard installs
 *    (`dsh plugin add`) place the plugin inside the profile dependency tree,
 *    so createRequire(import.meta.url) resolves the peer dependency.
 * 2) Fall back to $DSH_ROOT (explicitly set for local/junction mounts).
 * 3) Otherwise fail with a clear message instead of a cryptic MODULE_NOT_FOUND.
 */
const DSH_ROOT = process.env.DSH_ROOT ?? '';
let defineTool;
/**
 * 模块级解析锚点（v0.4：跨机预检等多锚点探测复用）。
 * 之前是块级变量，外部函数引用会 ReferenceError（被 try/catch 静默吞掉）。
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
// 'webServer' is injected at the LOADER level (not ctx.get) so the REST routes
// register reliably on cold boot too: the loader waits for the service before
// applying this entry. ctx.get('webServer') at apply time can be undefined
// when the webserver row is still pending (startup ordering), which silently
// skipped route registration (symptom: /api/undo/* -> 404 while tools/baseline
// worked).
export const inject = ['tools', 'systemPrompt', 'webServer'];

/** Legacy flat snapshot root (kept for migration/back-compat). */
const LEGACY_ROOT = process.env.DSH_UNDO_ROOT ?? join(DSH_HOME, 'undo-snapshots');
const SETTINGS_FILE = process.env.DSH_UNDO_SETTINGS ?? join(DSH_HOME, 'undo', 'settings.json');

const DEFAULT_SETTINGS = {
  autoEnabled: true,
  watchDebounceMs: 1500,
  keepAuto: 20,
  keepPre: 10,
  autoCleanup: true,
  manualDir: join(LEGACY_ROOT, 'manual'),
  autoDir: join(LEGACY_ROOT, 'auto'),
};

/**
 * 快照范围的单一事实来源（模块 7：与 tools/dsh-undo-savepoint-lib.ps1 共用
 * lib/spec.json，改动只改这一个文件，Node 与 PowerShell 两端的清单不再漂移）。
 * - configFiles：构成一个 "DSH 状态" 的配置文件；
 * - pluginCodeExts / pluginExclude* / pluginMax*：插件代码树的收集规则（模块 1）。
 */
const SPEC_PATH = new URL('./spec.json', import.meta.url);
const DEFAULT_SPEC = {
  configFiles: [
    { root: 'profile', rel: 'cordis.patch.yml' },
    { root: 'profile', rel: 'package.json' },
    { root: 'profile', rel: 'cordis.yml' },
    { root: 'profile', rel: 'pnpm-workspace.yaml' },
    { root: 'profile', rel: 'pnpm-lock.yaml' },
    { root: 'home', rel: 'cordis.patch.yml' },
    { root: 'home', rel: 'settings.yaml' },
    { root: 'home', rel: '.env' },
    { root: 'home', rel: '.credentials.yaml' },
  ],
  pluginCodeExts: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json', '.yml', '.yaml'],
  pluginExcludeDirNames: ['node_modules', '.git', 'dist', 'build', 'cache', '.cache', 'coverage', '.turbo'],
  pluginExcludeFileNames: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.DS_Store'],
  pluginMaxFileBytes: 262144,
  pluginMaxSnapshotBytes: 5242880,
};
/** 读取 lib/spec.json；读不到时退回内置默认清单（不阻塞插件启动）。 */
function loadSpec() {
  try {
    const j = JSON.parse(readFileSync(SPEC_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SPEC, ...j, configFiles: j.configFiles ?? DEFAULT_SPEC.configFiles };
  } catch { return { ...DEFAULT_SPEC }; }
}
const SPEC = loadSpec();
const FILE_SPECS = SPEC.configFiles;
const WATCHED_BASENAMES = new Set(FILE_SPECS.map((s) => basename(s.rel)));

/** 插件代码树规则（v0.2 模块 1）：白名单扩展名 / 排除目录与文件 / 体积上限。 */
const CODE_EXTS = new Set(SPEC.pluginCodeExts.map((e) => e.toLowerCase()));
const EXCLUDE_DIRS = new Set(SPEC.pluginExcludeDirNames);
const EXCLUDE_NAMES = new Set(SPEC.pluginExcludeFileNames);
const MAX_FILE_BYTES = SPEC.pluginMaxFileBytes;
const MAX_SNAP_BYTES = SPEC.pluginMaxSnapshotBytes;

/** 是否属于"代码/配置类"文件：插件树只快照这类文件，资源文件（gif/png 等）不进快照。 */
function isCodeFile(name) {
  const base = basename(name);
  if (EXCLUDE_NAMES.has(base)) return false;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  return CODE_EXTS.has(ext);
}

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/** 共享 blob 库：<快照根>/blobs/<sha1>，跨快照内容去重（v0.2 模块 1 保险 2）。 */
function blobDir(cfg) {
  return join(dirname(cfg.autoDir), 'blobs');
}
async function readBlob(cfg, hash) {
  try { return await fs.readFile(join(blobDir(cfg), hash)); } catch { return null; }
}
async function writeBlob(cfg, hash, buf) {
  const dir = blobDir(cfg);
  const target = join(dir, hash);
  if (await pathExists(target)) return;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target).catch(() => { /* 并发下另一个快照已写入，忽略 */ });
}

/** 相对路径安全校验：恢复时防 manifest 被篡改后向任意路径写文件。 */
function safeRel(rel) {
  return typeof rel === 'string' && rel !== ''
    && !rel.includes('..') && !rel.startsWith('/') && !rel.startsWith('\\')
    && !/^[A-Za-z]:/.test(rel);
}

// ── 敏感信息处理（v0.3.2：脱敏 + 本机 vault）──────────────────────────────
// 原则：快照里永远只有脱敏版（可自由外传），真实值存本机 vault（内容寻址），
// 本机回滚完整还原、换机回滚得到占位+提示。安全与鲁棒性两头都要。
const SENSITIVE_DESTS = new Set(['home-.env', 'profile-.env', 'home-.credentials.yaml']);
const REDACTED_PLACEHOLDER = '***REDACTED***';

/**
 * .env 行级脱敏：保留键名 / export 前缀 / 引号形式 / 注释 / 空行，只替换值。
 * API_KEY=kfc-vw50        -> API_KEY=***REDACTED***
 * export API_KEY="kfc"    -> export API_KEY="***REDACTED***"
 * # 注释 / 空行 / 无等号  -> 原样保留
 */
function redactEnvContent(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/);
    if (!m) return line;
    const val = m[3];
    const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
    return `${m[1]}${m[2]}${quote}${REDACTED_PLACEHOLDER}${quote}`;
  }).join('\n');
}

/**
 * YAML 键值脱敏（.credentials.yaml）：保留缩进/键名/注释结构，只替换值。
 * apiKey: sk-abc   -> apiKey: ***REDACTED***
 * 注意：多行字符串值（key: | 块）不在处理范围，文档注明此类请用 keep 模式。
 */
function redactYamlContent(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*)(.*)$/);
    if (!m) return line;
    const val = m[2].trim();
    if (val === '' || val.startsWith('#')) return line; // 空值/注释值原样
    return `${m[1]}${REDACTED_PLACEHOLDER}`;
  }).join('\n');
}

/** 敏感文件是否启用脱敏（sensitiveMode !== 'keep' 时脱敏）。 */
function isRedacting(cfg) {
  return cfg.sensitiveMode !== 'keep';
}

/** 本机 vault：<autoDir>/env-vault/<内容sha1>.env（内容寻址去重，不随导出带走）。 */
function vaultDir(cfg) {
  return join(cfg.autoDir, 'env-vault');
}
async function writeVault(cfg, sha1, buf) {
  const dir = vaultDir(cfg);
  const target = join(dir, `${sha1}.env`);
  if (await pathExists(target)) return;
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target).catch(() => { /* 并发写入已存在 */ });
}
async function readVault(cfg, sha1) {
  try { return await fs.readFile(join(vaultDir(cfg), `${sha1}.env`)); } catch { return null; }
}

/**
 * 按文件类型脱敏文本（.env 行级 / YAML 键值）。对已脱敏文本幂等。
 * diff 两侧（快照侧与当前侧）都必须过一遍，否则当前侧明文直接泄露。
 */
function redactByDest(destName, text) {
  return destName.endsWith('.credentials.yaml') ? redactYamlContent(text) : redactEnvContent(text);
}

/**
 * 快照内敏感文件的"对比内容"（v0.3.2）：diff 一律显示脱敏版，不读
 * vault —— 界面零泄露（截屏/旁观也看不到密钥）；恢复时仍从 vault 取真实值。
 * 返回 Buffer 或 null。
 */
async function snapSensitiveBuf(cfg, snap, destName) {
  try { return await fs.readFile(join(snap._dir, destName)); } catch { return null; }
}

function rootDir(cfg, root) {
  return root === 'profile'
    ? (cfg.profileDir ?? join(DSH_HOME, 'profiles', 'web'))
    : (cfg.homeDir ?? DSH_HOME);
}

function filePath(cfg, spec) {
  return join(rootDir(cfg, spec.root), spec.rel);
}

function destName(spec) {
  return `${spec.root}-${spec.rel.replace(/[\\/]/g, '-')}`;
}

/**
 * 发现用户插件（v0.2 模块 1）：
 * 1) settings.pluginDirs 显式指定（优先）；
 * 2) 否则自动发现：扫描候选 node_modules 根下的 junction（Windows 装插件的
 *    标准方式 mklink /J），解析出真实目标目录；
 * 3) 环境变量 DSH_PLUGIN_DIRS（分号/逗号分隔）追加。
 * 返回 [{ name, dir, version }]，dir 为 realpath 后的真实目录。
 */
async function discoverPlugins(cfg) {
  const out = [];
  const seen = new Set();
  const add = async (dir, name) => {
    let real = dir;
    try { real = await fs.realpath(dir); } catch { /* 目录已不存在 */ }
    if (seen.has(real)) return;
    seen.add(real);
    let version = '';
    try {
      const pkg = JSON.parse(await fs.readFile(join(real, 'package.json'), 'utf8'));
      version = typeof pkg.version === 'string' ? pkg.version : '';
    } catch { /* 无 package.json 也收（本地插件目录） */ }
    out.push({ name, dir: real, version });
  };
  const envDirs = (process.env.DSH_PLUGIN_DIRS ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const explicit = [...(Array.isArray(cfg.pluginDirs) ? cfg.pluginDirs : []), ...envDirs];
  // cfg.pluginDirs 是数组（哪怕是空数组）就视为显式配置：空 = 关闭自动发现
  // （测试/隔离场景用 pluginDirs: [] 完全离线，绝不触碰真实机器插件目录）
  if (explicit.length > 0 || Array.isArray(cfg.pluginDirs)) {
    for (const d of explicit) await add(d, basename(d));
    return out;
  }
  // 自动发现：只收 junction（避免把 node_modules 里几百个普通包全收进来）
  const roots = new Set([join(DSH_HOME, 'node_modules')]);
  let reqPaths = [];
  try { reqPaths = toolsRequire.resolve.paths('@deepseek-ai/dsh-tools') ?? []; } catch { /* ignore */ }
  for (const p of reqPaths) roots.add(p);
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue; // Windows junction 在 Node 中 isSymbolicLink() = true
      const target = await fs.realpath(join(root, e.name)).catch(() => null);
      if (!target) continue;
      try { if (!(await fs.stat(target)).isDirectory()) continue; } catch { continue; }
      await add(target, e.name);
    }
  }
  return out;
}

/**
 * 收集一个插件目录里的代码文件（扩展名白名单 + 体积上限），返回：
 * { files:[{rel,abs,hash,size}], skipped:[{path,reason}], truncated, dirs }
 * dirs = 相对子目录列表（watcher 需要逐个 fs.watch，Windows 不支持递归 watch）。
 */
async function collectPluginTree(cfg, dir) {
  const files = [];
  const skipped = [];
  const dirs = [];
  let total = 0;
  let truncated = false;
  const walk = async (rel) => {
    if (truncated) return;
    let entries;
    try { entries = await fs.readdir(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        dirs.push(r);
        await walk(r);
      } else if (e.isFile()) {
        if (!isCodeFile(e.name)) continue;
        const abs = join(dir, r);
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { skipped.push({ path: r, reason: 'too-large' }); continue; }
        if (total + st.size > MAX_SNAP_BYTES) { truncated = true; return; }
        const hash = sha1Hex(await fs.readFile(abs));
        files.push({ rel: r, abs, hash, size: st.size });
        total += st.size;
      }
    }
  };
  await walk('');
  return { files, skipped, truncated, dirs };
}

/**
 * profile 目录下的本地插件代码文件：解析 cordis.patch.yml 里
 * `name: './xxx'` 的 insert 条目（如 inspect-tolerance.cjs / router-*.mjs）。
 * 返回 [{ path, hash, size }]，只收代码类且不超上限的文件。
 */
async function collectProfileCodeRefs(cfg) {
  const refs = [];
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  if (!(await pathExists(patch))) return refs;
  const text = await fs.readFile(patch, 'utf8');
  for (const m of text.matchAll(/name:\s*['"]?\.\/([^'"\s]+)['"]?/g)) {
    const rel = m[1];
    if (!safeRel(rel)) continue;
    const abs = join(rootDir(cfg, 'profile'), rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      refs.push({ path: rel, hash: sha1Hex(await fs.readFile(abs)), size: st.size });
    } catch { /* 文件不存在则跳过 */ }
  }
  return refs;
}

/**
 * 插件文件 echo 检测（watcher 用）：恢复动作写回的文件内容仍与
 * restoredHashes 一致 → true（不存档）。fs.watch 只给文件名（basename），
 * 所以要在插件树里找所有同名文件逐一比对：只要有一个同名文件不是恢复
 * 写入的内容（或恢复清单里根本没有它），就是真实变更。
 */
async function isPluginEcho(cfg, plugin, file) {
  const tree = await collectPluginTree(cfg, plugin.dir);
  let matched = false;
  for (const f of tree.files) {
    if (basename(f.rel) !== file) continue;
    const key = `plugin:${plugin.name}/${f.rel}`;
    if (!cfg.restoredHashes.has(key)) return false; // 恢复清单里没有 → 真实变更
    if (cfg.restoredHashes.get(key) !== f.hash) return false; // 内容被改 → 真实变更
    matched = true;
  }
  return matched; // 无匹配文件（被删除）也视为真实变更
}

// ── 崩溃归因（v0.3 模块 3）：boot-state.json 读写 ─────────────────────────
async function readBootState(cfg) {
  try { return JSON.parse(await fs.readFile(join(cfg.autoDir, 'boot-state.json'), 'utf8')); } catch { return null; }
}
async function writeBootState(cfg, state) {
  try {
    await fs.mkdir(cfg.autoDir, { recursive: true });
    await fs.writeFile(join(cfg.autoDir, 'boot-state.json'), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 状态文件写失败不阻塞启动 */ }
}

// ── B5 崩溃归因 v2（v0.3.8）：日志签名分类 ─────────────────────────────────
// 崩溃瞬间无法写文件，归因靠"下一次启动发现上次 ok!=true"；v0.3 只报
// crashed + lastGood，v0.3.8 增加 crashReason——扫上次崩溃前日志尾部匹配
// 已知签名，给 undo_list / WebUI 更具体的处置建议（修会话 / 进安全模式）。
function classifyCrash(text) {
  if (/corrupt Zstandard session log/i.test(text)) return 'session-corrupt';
  if (/declares no dsh\.bundle|cannot resolve profile bundle/i.test(text)) return 'bundle-check';
  if (/already registered|duplicate loader entry|failed to load plugin|cannot find (module|package)/i.test(text)) return 'patch-tree';
  return 'unknown';
}
/** 候选日志：<home>/logs/*.log 与 <home>/dsh.log（启动器常把输出重定向到根目录）。 */
async function candidateLogs(cfg) {
  const homeRoot = cfg.homeDir ?? DSH_HOME;
  const out = [];
  try {
    for (const f of await fs.readdir(join(homeRoot, 'logs'))) {
      if (f.toLowerCase().endsWith('.log')) out.push(join(homeRoot, 'logs', f));
    }
  } catch { /* logs 目录不存在 */ }
  try {
    for (const f of await fs.readdir(homeRoot)) {
      if (f.toLowerCase() === 'dsh.log') out.push(join(homeRoot, f));
    }
  } catch { /* home 不存在 */ }
  return out;
}
/** 读最新候选日志的尾部（≤256KB），返回 { path, text } 或 null。 */
async function readCrashLogTail(cfg) {
  for (const p of await candidateLogs(cfg)) {
    try {
      const st = await fs.stat(p);
      if (st.size === 0) continue;
      const fd = await fs.open(p, 'r');
      try {
        const len = Math.min(st.size, 262144);
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, st.size - len);
        return { path: p, text: buf.toString('utf8') };
      } finally { await fd.close(); }
    } catch { /* 单个日志失败跳过 */ }
  }
  return null;
}
/** 崩溃横幅里按分类给的处置建议（无分类给通用建议）。 */
function crashAdvice(reason) {
  switch (reason) {
    case 'session-corrupt': return ' 疑似会话文件损坏导致启动崩溃——可用 undo_scan 扫描修复(工具: undo_scan)。';
    case 'bundle-check': return ' 疑似 profile bundles 校验失败——undo_safe_mode action "on" 会中和坏 bundle 条目,进入后重启即可。';
    case 'patch-tree': return ' 疑似插件挂载/加载失败——可用 undo_safe_mode action "on" 进入安全模式后再重启。';
    default: return '';
  }
}

// ── B6 undo_scan（v0.3.8）：会话文件健康扫描 + 修复 ─────────────────────────
// DSH 会话 = <home>/sessions/<id>/session.jsonl.zstd，合规布局为多帧 zstd：
//   frame 1 = header 行（恰好一行 + \n）   frame 2..n = 事件行
// "单帧"格式违规（整个 JSONL 流压进一帧）曾导致 DSH 崩溃（8/18 复盘根因）。
// 工具区分 ok / single-frame-violation（可修复）/ corrupt（无法解码）。
const ZSTD_MAGIC = 4247762216;
// 能力检测：Node 22.15+ 才有 zstd Zlib API；Node 20 下为 undefined，B6 走降级提示。
const zstdCompressSync = typeof zlib.zstdCompressSync === 'function' ? zlib.zstdCompressSync : null;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
const ZSTD_CHECKSUM = { params: { [zlib.constants?.ZSTD_c_checksumFlag ?? 1]: 1 } };
const ZSTD_UNSUPPORTED = 'ZSTD_UNSUPPORTED';
/** Node < 22.15 时标记 B6 不可用，并返回给调用方友好提示。 */
function zstdUnavailable() {
  const e = new Error('This Node version does not ship the zstd Zlib API (zstdCompressSync/zstdDecompressSync); undo_scan requires Node.js >= 22.15.');
  e.code = ZSTD_UNSUPPORTED;
  return e;
}
function assertZstd() {
  if (!zstdCompressSync || !zstdDecompressSync) throw zstdUnavailable();
}
/** 逐帧扫描 zstd 字节流（magic + frame header + block 遍历 + checksum），返回帧区间。 */
function zstdScanFrames(b) {
  const frames = [];
  let off = 0;
  while (off < b.length) {
    const start = off;
    if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
    if (b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('bad frame magic at ' + off);
    off += 4;
    if (off === b.length) { frames.push({ start, end: off, torn: true }); return frames; }
    const d = b.readUInt8(off);
    off += 1;
    if ((d & 24) !== 0) throw new Error('reserved frame-header bit at ' + (off - 1));
    const csf = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0, df = d & 3;
    const db = df === 3 ? 4 : df;
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    const rhb = (ss ? 0 : 1) + db + csb;
    if (b.length - off < rhb) { frames.push({ start, end: off, torn: true }); return frames; }
    off += rhb;
    for (;;) {
      if (b.length - off < 3) { frames.push({ start, end: off, torn: true }); return frames; }
      const bh = b.readUIntLE(off, 3);
      off += 3;
      const last = (bh & 1) !== 0, bt = (bh >>> 1) & 3, bs = bh >>> 3;
      if (bt === 3) throw new Error('reserved block type at ' + (off - 3));
      const pl = bt === 1 ? 1 : bs;
      if (b.length - off < pl) { frames.push({ start, end: off, torn: true }); return frames; }
      off += pl;
      if (last) break;
    }
    if (ck) {
      if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames; }
      off += 4;
    }
    frames.push({ start, end: off });
  }
  return frames;
}
/** 解码全部帧拼接为文本；任一帧撕裂/坏 magic 即抛错。 */
function zstdDecodeAll(b) {
  assertZstd();
  const frames = zstdScanFrames(b);
  const parts = [];
  for (const f of frames) {
    if (f.torn) throw new Error('torn frame at byte ' + f.start);
    parts.push(zstdDecompressSync(b.subarray(f.start, f.end)));
  }
  return Buffer.concat(parts).toString('utf8');
}
function tryJsonLine(s) { try { JSON.parse(s); return true; } catch { return false; } }
/** header 行判定：{type:'session', version:number, id:string, createdAt:int>=0, delegationDepth:int>=0} */
function isSessionHeaderLine(v) {
  return typeof v === 'object' && v !== null && v.type === 'session' &&
    typeof v.version === 'number' && typeof v.id === 'string' &&
    typeof v.createdAt === 'number' && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0 &&
    typeof v.delegationDepth === 'number' && Number.isSafeInteger(v.delegationDepth) && v.delegationDepth >= 0;
}
/** 分析单个会话文件字节：{status:'ok'|'fixable'|'corrupt', reason?, events?, frames?} */
function analyzeSessionBytes(b) {
  try {
    const text = zstdDecodeAll(b);
    const frames = zstdScanFrames(b);
    const nl = text.indexOf('\n');
    if (nl === -1) return { status: 'corrupt', reason: 'no newline in decoded text' };
    const headerLine = text.slice(0, nl);
    let parsed = null;
    try { parsed = JSON.parse(headerLine); } catch { /* 首行非 JSON */ }
    if (!isSessionHeaderLine(parsed)) return { status: 'corrupt', reason: 'first line is not a valid session header' };
    const lines = text.split('\n');
    const events = lines.slice(1).filter((l) => l.trim().length > 0).length;
    if (frames.length >= 2) {
      let badJson = 0;
      for (const l of lines) { if (l.trim() && !tryJsonLine(l)) badJson++; }
      if (badJson > 0) return { status: 'corrupt', reason: `${badJson} bad JSON line(s)` };
      return { status: 'ok', events, frames: frames.length };
    }
    return { status: 'fixable', reason: 'single-frame layout violation', events, frames: frames.length };
  } catch (error) {
    if (error?.code === ZSTD_UNSUPPORTED) throw error; // 环境不支持，交给 undo_scan 报告，不误判为文件 corrupt
    return { status: 'corrupt', reason: String(error?.message ?? error) };
  }
}
/** 重编码为合规布局（header 独立帧 + 事件帧），三重校验（round-trip / 逐行 JSON / 重分析）通过才返回。 */
function recodeSessionBytes(b) {
  assertZstd();
  const text = zstdDecodeAll(b);
  const nl = text.indexOf('\n');
  if (nl === -1) throw new Error('no newline in decoded text');
  const headerLine = text.slice(0, nl);
  const rest = text.slice(nl + 1);
  let parsed = null;
  try { parsed = JSON.parse(headerLine); } catch { /* 下抛 */ }
  if (!isSessionHeaderLine(parsed)) throw new Error('first line is not a valid session header');
  const frames = [zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), ZSTD_CHECKSUM)];
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), ZSTD_CHECKSUM));
  const out = Buffer.concat(frames);
  const check = zstdDecodeAll(out);
  if (check !== text) throw new Error('round-trip text mismatch');
  for (const l of check.split('\n')) { if (l.trim() && !tryJsonLine(l)) throw new Error('bad JSON line after recode'); }
  const re = analyzeSessionBytes(out);
  if (re.status !== 'ok') throw new Error(`recode re-analysis failed: ${re.reason}`);
  return out;
}
/** 递归收集 <home>/sessions 下所有 session.jsonl.zstd。 */
async function walkSessionFiles(cfg) {
  const root = join(cfg.homeDir ?? DSH_HOME, 'sessions');
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase() === 'session.jsonl.zstd') out.push(p);
    }
  }
  return out;
}

// ── B4 补丁托管（v0.3.8）：dsh-session-persistence-jsonl 容错补丁校验 ────────
// 补丁清单在 tools/dsh-patches.json（old = rc8 原始，new = rc6 已验证补丁）；
// 应用/移除走离线脚本 tools/apply-dsh-patches.ps1（DSH 起不来也能用）。
// 本插件只做只读校验：启动时发现缺补丁 → logger.warn 提示，绝不自动改文件。
const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
async function locatePatchTarget(relTarget) {
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  roots.push(join(homedir(), 'node_modules'));
  roots.push(join(DSH_HOME, 'node_modules'));
  for (const r of roots) {
    const p = join(r, relTarget);
    try { await fs.access(p); return p; } catch { /* 下一个候选根 */ }
  }
  return null;
}
/** 只读校验：返回 { ok, missing?, target?, reason? }。missing = 缺哪些补丁 id。 */
async function patchVerify(cfg) {
  try {
    const manifest = JSON.parse(readFileSync(join(TOOLS_DIR, 'dsh-patches.json'), 'utf8'));
    const target = await locatePatchTarget(manifest.target);
    if (!target) return { ok: false, reason: 'target-not-found' };
    const text = readFileSync(target, 'utf8');
    const missing = [];
    for (const p of manifest.patches) {
      if (text.includes(p.new)) continue;
      if (text.includes(p.old)) missing.push(p.id);
      else return { ok: false, reason: `unmatched:${p.id}` };
    }
    return { ok: missing.length === 0, missing, target };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 最后正常状态快照：时间不晚于 lastGoodAt 的最新非 pre-restore 快照。
 * 崩溃后把它作为"建议回退目标"（list 已按新→旧排序）。
 */
async function lastGoodSnapshot(cfg, list) {
  const at = cfg.bootAlert?.lastGoodAt ?? null;
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return list.find((s) => s.kind !== 'pre-restore' && Date.parse(s.time) <= t) ?? null;
}

// ── 一键安全模式（v0.3 模块 4；v0.3.7 按 8/17 复盘补完 R5/B1/B2）──────────
// 状态文件 <autoDir>/safe-mode.json：{ active, enteredAt, backup, snapshotId,
//   homeBackup, homeFingerprint }
// 进入：自动 manual 快照 + 备份 profile/home 两级 cordis.patch.yml → 写最小
//       patch（只留 undo）。patch 缺失时写空备份 []（语义 = 无用户插件可禁用）。
// 退出：从备份恢复两级 patch。崩溃后 DSH 起不来时，安全模式保证一定能启动。
// 不变量：active ⇒ 全部 backup 文件真实存在；进入侧断言失败则拒绝写状态文件
// （8/17 死锁根因：状态引用了从未创建的备份 → 永远退不出）。
async function readSafeModeState(cfg) {
  try { return JSON.parse(await fs.readFile(join(cfg.autoDir, 'safe-mode.json'), 'utf8')); } catch { return { active: false }; }
}
/**
 * home 指纹（B2/H5）：DSH_HOME + profile 名的哈希。家目录/换机/迁移时路径必然
 * 变化 → 旧家残留的 safe-mode.json 降级为不激活，绝不把旧状态带到新家。
 * 刻意不含 settings.yaml 统计：用户安全模式期间正常改设置不应让状态"失效"；
 * 且"同路径重建家目录"时 autoDir 本身已消失，状态文件随之不存在，无需指纹兜底。
 */
async function homeFingerprint(cfg) {
  return sha1Hex(Buffer.from(`${rootDir(cfg, 'home')}|${cfg.profileName}`, 'utf8'));
}

// ── P1 bundle 层中和（v0.3.8，safe-mode-bundle-neutralize-v0.4 设计稿）──────
// 崩溃场景：dsh-app-boot 的 loadProfile 对 dsh.profile.bundles 每一项做三项
// 硬校验（resolveBundleDir 解析不到 / 缺 dsh.bundle.patch / patch 文件缺失），
// 任一失败 DSH 起不来；此时安全模式若只最小化 patch 层就完全无效。故进入
// 安全模式时把坏条目临时剔除，退出时整份恢复（原 package.json 备份在 autoDir）。
function bundleAnchors(cfg) {
  const anchors = [];
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* DSH_HOME 无 package.json 也可 */ }
  try { anchors.push(createRequire(join(rootDir(cfg, 'profile'), 'package.json'))); } catch { /* profile 无 package.json 也可 */ }
  return anchors;
}
/**
 * 与 dsh-app-boot resolveBundleDir + manifest 校验等价的逐项检查。
 * 返回 { ok: true, dir } 或 { ok: false, reason }。保守剔除：无法确定性判定
 * 时倾向剔除（安全模式的职责是保证能启动，宁可多剔不可漏剔）。
 */
async function bundleCheck(cfg, name) {
  for (const r of bundleAnchors(cfg)) {
    for (const sp of (r.resolve.paths(name) ?? [])) {
      const cand = join(sp, name);
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(join(cand, 'package.json'), 'utf8')); } catch { continue; }
      const patch = pkg.dsh?.bundle?.patch;
      if (typeof patch !== 'string' || !patch) {
        return { ok: false, reason: `no dsh.bundle.patch (${name})` };
      }
      if (!(await pathExists(join(cand, patch)))) {
        return { ok: false, reason: `dsh.bundle.patch 文件缺失: ${join(cand, patch)}` };
      }
      return { ok: true, dir: cand };
    }
  }
  return { ok: false, reason: `cannot resolve ${name}` };
}
/** 计算安全 bundles：只剔除坏项，保留顺序；dependencies 里的 link: 条目不动。 */
async function computeSafeBundles(cfg, pkg) {
  const pruned = [];
  const kept = [];
  for (const name of (pkg.dsh?.profile?.bundles ?? [])) {
    if (typeof name !== 'string') {
      pruned.push({ name: String(name), reason: 'non-string bundle entry' });
      continue;
    }
    const r = await bundleCheck(cfg, name);
    if (r.ok) kept.push(name);
    else pruned.push({ name, reason: r.reason });
  }
  return { pruned, kept };
}

async function safeModeStatus(cfg) {
  const st = await readSafeModeState(cfg);
  // 残留状态识别：指纹不匹配 → 降级为"不激活 + stale 标记"（不删文件、不静默）
  if (st.active && st.homeFingerprint && st.homeFingerprint !== await homeFingerprint(cfg)) {
    return { ...st, active: false, stale: true };
  }
  return st;
}
async function safeModeSet(cfg, on) {
  if (hasOpenTurn()) return busyError();
  // 用 safeModeStatus（含指纹校验）而非裸读：残留状态（换 home/profile）在
  // status/off/on 全路径上都被识别为"不激活 + stale"。
  const st = await safeModeStatus(cfg);
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  const homePatch = filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' });
  const pkgPath = filePath(cfg, { root: 'profile', rel: 'package.json' });
  if (on) {
    // 幂等 + 重扫（P1）：进入后用户可能手动改坏 bundles，重扫只报告不重复写
    if (st.active) {
      let rescanned = [];
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        rescanned = (await computeSafeBundles(cfg, pkg)).pruned;
      } catch { /* package.json 读不到则重扫结果为空 */ }
      return {
        ok: true, active: true,
        message: 'Safe mode is already ON (entered ' + (st.enteredAt ?? '?') + '). '
          + (rescanned.length > 0
            ? `重扫发现 ${rescanned.length} 个会崩溃的 bundle 条目：${rescanned.map((p) => p.name).join(', ')}。`
            : '重扫未发现新的坏 bundle 条目。'),
      };
    }
    const snap = await createSnapshot(cfg, 'manual', 'safe-mode-before');
    const backup = join(cfg.autoDir, `safe-mode-backup-${snap.id}.yml`);
    const homeBackup = join(cfg.autoDir, `safe-mode-home-backup-${snap.id}.yml`);
    const pkgBackup = join(cfg.autoDir, `safe-mode-pkg-${snap.id}.json`);
    // 目录先于文件（8/17 复盘 B1）：备份文件要写进 autoDir，先确保目录存在
    await fs.mkdir(cfg.autoDir, { recursive: true });
    // 空备份回退（B1 补完）：patch 缺失时写 []，而不是留下"从未创建的备份引用"
    if (await pathExists(patch)) await fs.copyFile(patch, backup);
    else await fs.writeFile(backup, '[]\n', 'utf8');
    // 双级 patch（H3）：home 级挂载的插件同样备份/最小化，安全模式才对它们生效
    const homePatchExists = await pathExists(homePatch);
    if (homePatchExists) await fs.copyFile(homePatch, homeBackup);
    // 不变量断言：备份必须真实存在才允许进入（进入侧补齐，退出侧原有检查保留）
    if (!(await pathExists(backup))) {
      return { ok: false, error: `Safe-mode backup write failed (${backup}). Refusing to enter safe mode.` };
    }
    // P1 bundle 中和：备份原 package.json（双保险：快照 + 独立备份文件）→ 用与
    // dsh-app-boot loadProfile 同规则校验每个 bundle 条目 → 剔除坏项写回。
    // 边界：package.json 缺失（无 bundle 可中和）→ 跳过不阻断进入；JSON 损坏 →
    // 不破坏性重写（数据优先），返回错误引导先恢复快照。
    let prunedBundles = [];
    let pkgBackedUp = false;
    let pkgRaw = null;
    try { pkgRaw = await fs.readFile(pkgPath, 'utf8'); } catch { /* package.json 缺失 */ }
    if (pkgRaw !== null) {
      await fs.writeFile(pkgBackup, pkgRaw, 'utf8');
      pkgBackedUp = true;
      try {
        const pkg = JSON.parse(pkgRaw);
        const { pruned, kept } = await computeSafeBundles(cfg, pkg);
        prunedBundles = pruned;
        const orig = pkg.dsh?.profile?.bundles ?? [];
        if (kept.join('\u0000') !== orig.join('\u0000')) {
          pkg.dsh = pkg.dsh ?? {};
          pkg.dsh.profile = pkg.dsh.profile ?? {};
          pkg.dsh.profile.bundles = kept;
          await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        }
      } catch (error) {
        return { ok: false, error: `profile package.json 解析失败，未执行 bundle 中和：${String(error?.message ?? error)}；请先用 undo_restore 恢复快照。` };
      }
    }
    const minimal = `# dsh-undo-savepoint SAFE MODE (entered ${new Date().toISOString()})\n# All user plugins except dsh-undo-savepoint are temporarily disabled.\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n`;
    await fs.writeFile(patch, minimal, 'utf8');
    // 双级最小化：home 级 patch 同样清空（写 []），home 级挂载的插件一并禁用
    if (homePatchExists) {
      await fs.writeFile(homePatch, `# dsh-undo-savepoint SAFE MODE (home level, entered ${new Date().toISOString()})\n[]\n`, 'utf8');
    }
    const state = {
      active: true, enteredAt: new Date().toISOString(), backup, snapshotId: snap.id,
      homeBackup: homePatchExists ? homeBackup : undefined,
      homeFingerprint: await homeFingerprint(cfg),
    };
    if (pkgBackedUp) state.pkgBackup = pkgBackup;
    if (prunedBundles.length > 0) state.prunedBundles = prunedBundles;
    await fs.writeFile(join(cfg.autoDir, 'safe-mode.json'), JSON.stringify(state, null, 2), 'utf8');
    const prunedTxt = prunedBundles.length > 0
      ? ` 中和 ${prunedBundles.length} 个会崩溃的 bundle 条目：${prunedBundles.map((p) => `${p.name}（${p.reason}）`).join('；')}。`
      : '';
    // B4 附带检测：安全模式只处理插件/patch/bundle 层，不解决会话文件损坏；
    // 若 dsh-session-persistence-jsonl 缺容错补丁，进入时一并提示（只读）。
    let patchNote = '';
    try {
      const pv = await patchVerify(cfg);
      if (pv.ok === false && Array.isArray(pv.missing) && pv.missing.length > 0) {
        patchNote = ` 注意：dsh-session-persistence-jsonl 缺 ${pv.missing.length} 个容错补丁（${pv.missing.join(', ')}），会话损坏仍可能导致启动崩溃——离线运行 tools/apply-dsh-patches.ps1 apply 修复。`;
      }
    } catch { /* 检测失败不影响安全模式 */ }
    return { ok: true, active: true, snapshotId: snap.id, prunedBundles, message: `Safe mode ON (pre-snapshot ${snap.id}). Restart DSH to boot with only dsh-undo-savepoint.${prunedTxt}${patchNote}` };
  }
  // off
  if (!st.active) {
    return st.stale
      ? { ok: true, active: false, message: 'Safe mode state belongs to another home/profile (stale); treated as OFF. You can enter safe mode again for the current home.' }
      : { ok: true, active: false, message: 'Safe mode is not active.' };
  }
  // 先校验全部备份在位，再动任何文件（避免恢复一半后才发现缺备份）
  if (!st.backup || !(await pathExists(st.backup))) {
    return { ok: false, error: 'Safe-mode backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  if (st.homeBackup && !(await pathExists(st.homeBackup))) {
    return { ok: false, error: 'Safe-mode home backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  if (st.pkgBackup && !(await pathExists(st.pkgBackup))) {
    return { ok: false, error: 'Safe-mode package.json backup missing. Restore a snapshot from before the crash first (undo_list / undo_restore).' };
  }
  await fs.copyFile(st.backup, patch);
  if (st.homeBackup) await fs.copyFile(st.homeBackup, homePatch);
  let pkgRestored = false;
  if (st.pkgBackup) {
    await fs.copyFile(st.pkgBackup, pkgPath);
    pkgRestored = true;
  }
  await fs.rm(join(cfg.autoDir, 'safe-mode.json'), { force: true });
  const restoreTxt = pkgRestored
    ? ` 已恢复 profile package.json（原 ${st.prunedBundles?.length ?? 0} 个被中和的 bundle 条目已还原）。`
    : ' 旧版本状态：仅恢复 patch，package.json 未动。';
  return { ok: true, active: false, message: 'Safe mode OFF. Restart DSH to load all plugins again.' + restoreTxt };
}

/**
 * 跨机一致性预检（v0.4）：解析目标快照引用的插件包名，探测本机能否解析。
 * 恢复报告据此提示"恢复后可能启动失败"，避免跨机迁移时 patch 挂载了
 * 本机没装的插件（MODULE_NOT_FOUND）。本地文件条目（name: './xxx'）不探测。
 * 返回 { missing: [], checked: n }。
 */
async function preflightSnapshot(cfg, snap) {
  const names = new Set();
  const patchFile = (snap.files ?? []).find((f) => f.name === 'profile-cordis.patch.yml');
  if (patchFile) {
    try {
      const text = await fs.readFile(join(snap._dir, patchFile.name), 'utf8');
      for (const m of text.matchAll(/name:\s*['"]?([^'"\s]+)['"]?/g)) {
        const n = m[1];
        if (n.startsWith('./') || n.startsWith('../') || n.startsWith('/') || n.startsWith('\\')) continue; // 本地文件
        if (n === 'dsh-undo-savepoint') continue; // 自身永远在
        names.add(n);
      }
    } catch { /* patch 缺失则跳过 */ }
  }
  const pkgFile = (snap.files ?? []).find((f) => f.name === 'profile-package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(await fs.readFile(join(snap._dir, pkgFile.name), 'utf8'));
      for (const n of (pkg.dsh?.profile?.bundles ?? [])) {
        if (typeof n === 'string' && n !== 'dsh-undo-savepoint') names.add(n);
      }
    } catch { /* package.json 缺失则跳过 */ }
  }
  const missing = [];
  for (const n of names) {
    if (canResolveAny(cfg, n)) continue;
    missing.push(n);
  }
  return { missing, checked: names.size };
}

/**
 * 多锚点解析探测：DSH 加载插件的路径不止一条——
 * 1) 用户 node_modules 链（junction 安装，锚 ~/package.json）
 * 2) profile 依赖树链（pnpm add 安装，锚 <profile>/package.json）
 * 3) 插件自身位置链（toolsRequire，兄弟插件）
 * 任一锚点能解析即视为"本机可加载"，避免 junction 布局下误报。
 */
function canResolveAny(cfg, name) {
  const anchors = [];
  try { anchors.push(createRequire(join(DSH_HOME, 'package.json'))); } catch { /* ignore */ }
  try { anchors.push(createRequire(join(rootDir(cfg, 'profile'), 'package.json'))); } catch { /* ignore */ }
  anchors.push(toolsRequire);
  for (const r of anchors) {
    try { r.resolve(name); return true; } catch { /* try next anchor */ }
  }
  return false;
}

function findSpec(name) {
  return FILE_SPECS.find((s) => destName(s) === name) ?? null;
}

/** 体积展示（R3 totalBytes）：<1KB 显示 B，否则 KB/MB，方便人类阅读。 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function makeId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function loadSettingsFile() {
  try {
    const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SETTINGS, ...j };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

async function readManifest(dir) {
  const text = await fs.readFile(join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, '')); // tolerate a BOM (PS5.1 wrote it)
}

async function writeManifest(dir, snap) {
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(snap, null, 2), 'utf8');
}

/** All directories that may hold snapshots (manual, auto, legacy root). */
function storeDirs(cfg) {
  return [cfg.manualDir, cfg.autoDir, LEGACY_ROOT];
}

/** Create a snapshot in the store matching its kind. Manual -> manualDir, everything else -> autoDir. */
async function createSnapshot(cfg, kind, reason) {
  const base = kind === 'manual' ? cfg.manualDir : cfg.autoDir;
  await fs.mkdir(base, { recursive: true });
  let id;
  do {
    id = makeId();
  } while (await pathExists(join(base, id)));
  const dir = join(base, id);
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  const envVaultRefs = {};
  const redacted = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    if (!(await pathExists(src))) continue;
    const name = destName(spec);
    const dest = join(dir, name);
    const buf = await fs.readFile(src);
    // 敏感文件（v0.3.2）：脱敏版进快照，真实值进本机 vault
    if (SENSITIVE_DESTS.has(name) && isRedacting(cfg)) {
      const text = buf.toString('utf8');
      const redactedText = name.endsWith('.credentials.yaml') ? redactYamlContent(text) : redactEnvContent(text);
      await fs.writeFile(dest, redactedText, 'utf8');
      const sha = sha1Hex(buf);
      await writeVault(cfg, sha, buf);
      envVaultRefs[name] = sha;
      redacted.push(name);
      files.push({ name, size: Buffer.byteLength(redactedText) });
      continue;
    }
    await fs.copyFile(src, dest);
    files.push({ name, size: buf.length });
  }
  // ── 插件代码树（v0.2 模块 1）：内容寻址写入共享 blob 库，manifest 只记引用 ──
  const plugins = [];
  for (const p of await discoverPlugins(cfg)) {
    const tree = await collectPluginTree(cfg, p.dir);
    const refs = [];
    for (const f of tree.files) {
      await writeBlob(cfg, f.hash, await fs.readFile(f.abs));
      refs.push({ path: f.rel, hash: f.hash, size: f.size });
    }
    plugins.push({ name: p.name, dir: p.dir, version: p.version, files: refs, skipped: tree.skipped, truncated: tree.truncated });
  }
  // profile 本地代码文件（cordis.patch.yml 里 name: './xxx' 引用的文件）
  const profileFiles = [];
  for (const f of await collectProfileCodeRefs(cfg)) {
    await writeBlob(cfg, f.hash, await fs.readFile(join(rootDir(cfg, 'profile'), f.path)));
    profileFiles.push({ path: f.path, hash: f.hash, size: f.size });
  }
  const snap = {
    id, time: new Date().toISOString(), kind, reason, files, plugins, profileFiles,
    sensitiveMode: cfg.sensitiveMode, redacted, envVaultRefs,
    profile: cfg.profileName,
  };
  // totalBytes（v0.3.7，R3）：快照"物化体积" = manifest + 配置文件 + 插件引用
  // 文件 + profile 本地代码。blob 去重是磁盘上的额外节省，这里如实统计引用总量，
  // 供 undo_list 展示与"单快照 ≤5M"约束的可见化。
  const manifestBytes = Buffer.byteLength(JSON.stringify(snap));
  const configBytes = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const pluginBytes = plugins.reduce((n, p) => n + (p.files ?? []).reduce((m, f) => m + (f.size ?? 0), 0), 0);
  const profileBytes = profileFiles.reduce((n, f) => n + (f.size ?? 0), 0);
  snap.totalBytes = manifestBytes + configBytes + pluginBytes + profileBytes;
  await writeManifest(dir, snap);
  return snap;
}

/** List snapshots newest-first across manual/auto/legacy stores. Entries carry _dir and _store. */
async function listSnapshots(cfg) {
  const out = [];
  for (const base of storeDirs(cfg)) {
    if (!(await pathExists(base))) continue;
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      try {
        const snap = await readManifest(dir);
        snap._dir = dir;
        snap._store = dirLabel(cfg, base);
        out.push(snap);
      } catch { /* ignore broken */ }
    }
  }
  out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return out;
}

function dirLabel(cfg, dir) {
  if (dir === cfg.manualDir) return 'manual';
  if (dir === cfg.autoDir) return 'auto';
  return 'legacy';
}

function findSnapshot(list, id) {
  return list.find((s) => s.id === id) ?? null;
}

/** Content-hash the state a snapshot recorded: sorted [name, sha1] pairs of its files. */
async function stateOf(snap) {
  const pairs = [];
  for (const file of (snap.files ?? [])) {
    // 敏感文件（v0.3.2）：状态 = 快照时点的真实值 sha1（envVaultRefs），
    // 与 currentState 读当前真实文件一致，避免脱敏内容导致"永远有差异"
    if (SENSITIVE_DESTS.has(file.name) && snap.envVaultRefs?.[file.name]) {
      pairs.push([file.name, snap.envVaultRefs[file.name]]);
      continue;
    }
    try {
      const buf = await fs.readFile(join(snap._dir, file.name));
      pairs.push([file.name, sha1Hex(buf)]);
    } catch { /* missing file: skip */ }
  }
  // 插件代码树与 profile 本地代码（v0.2）：哈希来自 manifest 引用（blob 内容寻址）
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) pairs.push([`plugin:${p.name}/${f.path}`, f.hash]);
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (f.hash) pairs.push([`profile:${f.path}`, f.hash]);
  }
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Content-hash the CURRENT config state (only files that exist). */
async function currentState(cfg) {
  const pairs = [];
  for (const spec of FILE_SPECS) {
    const p = filePath(cfg, spec);
    try {
      const buf = await fs.readFile(p);
      pairs.push([destName(spec), sha1Hex(buf)]);
    } catch { /* absent */ }
  }
  // 插件代码树当前状态（v0.2）：配置没变但插件代码变了，undo 也能识别出差异
  for (const p of await discoverPlugins(cfg)) {
    const tree = await collectPluginTree(cfg, p.dir);
    for (const f of tree.files) pairs.push([`plugin:${p.name}/${f.rel}`, f.hash]);
  }
  for (const f of await collectProfileCodeRefs(cfg)) {
    pairs.push([`profile:${f.path}`, f.hash]);
  }
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function sameState(a, b) {
  return a.length === b.length && a.every(([n, h], i) => b[i]?.[0] === n && b[i]?.[1] === h);
}

/** Windows: rename() over an existing file can transiently fail with
 *  EPERM/EBUSY when an AV scanner or another handle briefly holds the
 *  destination. Retry a few times before surfacing the error. */
async function renameWithRetry(src, dest, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (i >= attempts - 1 || !['EPERM', 'EBUSY', 'EEXIST'].includes(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

/** Restore one snapshot's files onto the live config tree (atomic per file).
 * Records the exact content it wrote into cfg.restoredHashes so the watcher
 * can recognize (and skip) the restore's own change events. */
async function applySnapshot(cfg, snap) {
  const restored = [];
  const missing = [];
  const notes = [];
  const hashes = new Map();
  for (const file of (snap.files ?? [])) {
    const spec = findSpec(file.name);
    if (!spec) continue;
    const src = join(snap._dir, file.name);
    if (!(await pathExists(src))) continue;
    let buf = await fs.readFile(src);
    // 敏感文件（v0.3.2）：vault 有真实值 → 完整回滚（本机）；
    // vault 缺失（换机/被清理）→ 写回脱敏占位并明确提示
    let sensitiveNote = null;
    if (SENSITIVE_DESTS.has(file.name)) {
      const ref = snap.envVaultRefs?.[file.name];
      if (ref) {
        const real = await readVault(cfg, ref);
        if (real) buf = real;
        else sensitiveNote = `${file.name}: vault missing — redacted placeholder restored, please fill in the real values`;
      } else if (snap.sensitiveMode === 'redact') {
        sensitiveNote = `${file.name}: restored as redacted placeholder (values were stripped from this snapshot)`;
      }
    }
    const target = filePath(cfg, spec);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.undo-tmp`;
    await fs.writeFile(tmp, buf);
    await renameWithRetry(tmp, target);
    hashes.set(file.name, sha1Hex(buf));
    restored.push(file.name);
    if (sensitiveNote) notes.push(sensitiveNote);
  }

  // ── 插件代码树恢复（v0.2 模块 1）：从 blob 库按哈希取回文件 ──
  // 安全：只写回"当前仍然发现的插件目录"（liveDirs 校验），相对路径不得越界；
  // blob 缺失 / 插件已卸载的情况进 missing 列表明确报告，绝不静默跳过。
  const liveDirs = new Set((await discoverPlugins(cfg)).map((p) => p.dir));
  for (const p of (snap.plugins ?? [])) {
    if (!safeRel(p.name) || !liveDirs.has(p.dir)) {
      missing.push(`plugin ${p.name}: directory no longer present (${p.dir})`);
      continue;
    }
    for (const f of (p.files ?? [])) {
      if (!safeRel(f.path)) { missing.push(`${p.name}/${f.path}: unsafe path, skipped`); continue; }
      const buf = await readBlob(cfg, f.hash);
      if (!buf) { missing.push(`${p.name}/${f.path}: snapshot blob missing`); continue; }
      const target = join(p.dir, f.path);
      await fs.mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.undo-tmp`;
      await fs.writeFile(tmp, buf);
      await renameWithRetry(tmp, target);
      const key = `plugin:${p.name}/${f.path}`;
      hashes.set(key, f.hash);
      restored.push(key);
    }
  }
  // profile 本地代码文件
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash || !safeRel(f.path)) continue;
    const buf = await readBlob(cfg, f.hash);
    if (!buf) { missing.push(`profile:${f.path}: snapshot blob missing`); continue; }
    const target = join(rootDir(cfg, 'profile'), f.path);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.undo-tmp`;
    await fs.writeFile(tmp, buf);
    await renameWithRetry(tmp, target);
    const key = `profile:${f.path}`;
    hashes.set(key, f.hash);
    restored.push(key);
  }

  cfg.restoredHashes = hashes;
  return { restored, missing, notes };
}

/** Config files whose restore changes which package versions the profile should resolve. */
const DEPENDENCY_FILES = new Set(['profile-package.json', 'profile-pnpm-lock.yaml', 'profile-pnpm-workspace.yaml']);

/** A restore needs a DSH restart when it touched the patch mount or any package/profile-level file. */
function testNeedsRestart(restored) {
  return restored.some((n) => n === 'profile-cordis.patch.yml' || n === 'profile-package.json' || n.startsWith('plugin:') || n.startsWith('profile:'));
}

/** Run pnpm with bounded output; a non-zero exit is a normal result, never a throw. */
function runPnpm(args, cwd) {
  return new Promise((resolve) => {
    // Windows npm shims are .cmd files; spawn cmd.exe with the verb list so
    // no user-controlled string is concatenated into a shell command line.
    const windows = process.platform === 'win32';
    execFile(windows ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm', windows ? ['/d', '/s', '/c', 'pnpm', ...args] : args, {
      cwd,
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const tail = (value) => String(value ?? '').slice(-4000);
      resolve({
        ok: error == null,
        code: typeof error?.code === 'string' ? error.code : (error == null ? 0 : 1),
        stdout: tail(stdout),
        stderr: tail(stderr),
        error: error == null ? '' : String(error.message ?? error),
      });
    });
  });
}

/**
 * Reconcile profile dependencies after restoring manifest/lock/workspace files.
 * Default is report-only: a package-manager run can hit the network, lifecycle
 * scripts, or file locks, so it must stay opt-in. An explicit sync never fails
 * the restore itself — restored config files are already on disk.
 */
async function reconcileDependencies(cfg, restored, syncDeps) {
  const touched = restored.some((name) => DEPENDENCY_FILES.has(name));
  if (!touched) return { touched: false, synced: false };
  const profileDir = rootDir(cfg, 'profile');
  if (syncDeps !== true) {
    return {
      touched: true,
      synced: false,
      note: `dependency state may be out of sync — run 'dsh plugin --profile ${cfg.profileName} install' (or 'pnpm install --frozen-lockfile' in ${profileDir})`,
    };
  }
  const lockPath = join(profileDir, 'pnpm-lock.yaml');
  const args = (await pathExists(lockPath)) ? ['install', '--frozen-lockfile'] : ['install'];
  const startedAt = Date.now();
  const result = await runPnpm(args, profileDir);
  const command = `pnpm ${args.join(' ')}`;
  return {
    touched: true,
    synced: result.ok,
    command,
    profileDir,
    durationMs: Date.now() - startedAt,
    ...result,
    note: result.ok
      ? `dependencies synced (${command})`
      : `dependency sync failed (${command}): ${result.stderr || result.error}`,
  };
}

/** Keep the undo plugin itself mounted: append its insert row to cordis.patch.yml when missing. */
/**
 * Keep the plugin loadable after restores, WITHOUT double-loading:
 * - BUNDLE mode (installed via `dsh plugin add`): the plugin is already loaded
 *   from dsh.profile.bundles. We must NOT add a manual patch mount (that would
 *   instantiate the plugin twice -> duplicate tools/entry id). We also remove
 *   any leftover manual mount block that an older ensureMount wrote, fixing
 *   existing double-load setups (reported by the community).
 * - PATCH mode (local junction mount): ensure the manual mount line exists.
 */
async function ensureMount(cfg) {
  const patch = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  if (!(await pathExists(patch))) return false;
  let text = await fs.readFile(patch, 'utf8');

  // detect bundle mode from the profile package.json
  let bundleMode = false;
  try {
    const pkg = JSON.parse(await fs.readFile(filePath(cfg, { root: 'profile', rel: 'package.json' }), 'utf8'));
    bundleMode = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-undo-savepoint');
  } catch { /* profile package.json missing/unreadable: treat as patch mode */ }

  if (bundleMode) {
    // remove a leftover manual mount block (the double-load fix)
    const marker = '# dsh-undo-savepoint mount';
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const rel = text.indexOf('name: dsh-undo-savepoint', idx);
      let end = rel >= 0 ? text.indexOf('\n', rel) : text.indexOf('\n', idx);
      if (end >= 0) end += 1;
      let start = idx;
      if (text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1; // drop the preceding blank line
      if (end > start) {
        await fs.writeFile(patch, text.slice(0, start) + text.slice(end), 'utf8');
        return true; // duplicate mount removed
      }
    }
    return false; // bundle mode: nothing to ensure
  }

  // patch mode: make sure the manual mount line exists
  if (text.includes('dsh-undo-savepoint')) return false;
  text = text.replace(/^\s*\[\]\s*$/m, '');
  const block = `\n# dsh-undo-savepoint mount (re-ensured by dsh-undo-savepoint)\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n`;
  await fs.writeFile(patch, text.replace(/\s*$/, '') + block, 'utf8');
  return true;
}

/**
 * I12 启动去重自愈：扫描全部挂载源（profile 级 patch 及其 include 引用、home 级
 * patch、profile package.json 的 bundles），发现 dsh-undo-savepoint 出现 >1 次时，
 * 先备份（.dsh-undo-bak）再只保留 canonical 挂载（优先级 bundle > profile patch
 * > home patch），其余移除并返回明细——根治"双重挂载 → 工具重复注册 → DSH 启动
 * 即崩"（2026-08-21 rc8 现场，lyncoll 机器）。
 */
async function dedupeMount(cfg) {
  const found = [];
  const profilePatchPath = filePath(cfg, { root: 'profile', rel: 'cordis.patch.yml' });
  const homePatchPath = filePath(cfg, { root: 'home', rel: 'cordis.patch.yml' });
  const pkgPath = filePath(cfg, { root: 'profile', rel: 'package.json' });
  const hasMount = async (p) => (await pathExists(p)) && (await fs.readFile(p, 'utf8')).includes('dsh-undo-savepoint');
  // 1) profile 级 patch（含 - include 引用的文件：include 里也可能藏着重复挂载）
  if (await pathExists(profilePatchPath)) {
    const text = await fs.readFile(profilePatchPath, 'utf8');
    if (text.includes('dsh-undo-savepoint')) found.push({ location: profilePatchPath, kind: 'profile-patch' });
    for (const m of text.matchAll(/^\s*-\s*include:\s*['"]?([^'"\s#]+)/gm)) {
      const inc = join(rootDir(cfg, 'profile'), m[1].replace(/[\\/]$/, ''));
      if (await hasMount(inc)) found.push({ location: inc, kind: 'profile-patch' });
    }
  }
  // 2) home 级 patch
  if (await hasMount(homePatchPath)) found.push({ location: homePatchPath, kind: 'home-patch' });
  // 3) profile package.json 的 bundles（dsh plugin add 的标准产物）
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-undo-savepoint')) {
      found.push({ location: pkgPath, kind: 'bundle' });
    }
  } catch { /* package.json 缺失/损坏：bundle 面视为无 */ }
  if (found.length <= 1) return { found: found.length, kept: null, removed: [] };
  const rank = { bundle: 3, 'profile-patch': 2, 'home-patch': 1 };
  const kept = found.reduce((a, b) => (rank[a.kind] >= rank[b.kind] ? a : b));
  const removed = [];
  for (const m of found) {
    if (m.location === kept.location) continue;
    const bak = `${m.location}.dsh-undo-bak`;
    if (!(await pathExists(bak))) await fs.copyFile(m.location, bak);
    if (m.kind === 'bundle') {
      const pkg = JSON.parse(await fs.readFile(m.location, 'utf8'));
      pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles ?? []).filter((n) => n !== 'dsh-undo-savepoint');
      await fs.writeFile(m.location, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } else {
      await removeMountBlock(m.location);
    }
    removed.push(m.location);
  }
  return { found: found.length, kept: kept.location, removed };
}

/**
 * 从 YAML patch 文件里移除 dsh-undo-savepoint 的挂载块。兼容两种形态：
 * 1) 本插件写的 "# dsh-undo-savepoint mount" 注释块（整块删除）；
 * 2) 裸 insert 列表项（把 "- xxx" 及其缩进续行视为一组，含插件名的组整组删除）。
 */
async function removeMountBlock(file) {
  let text = await fs.readFile(file, 'utf8');
  const marker = '# dsh-undo-savepoint mount';
  if (text.includes(marker)) {
    const idx = text.indexOf(marker);
    const rel = text.indexOf('name: dsh-undo-savepoint', idx);
    let end = rel >= 0 ? text.indexOf('\n', rel) : text.indexOf('\n', idx);
    if (end >= 0) end += 1;
    let start = idx;
    if (text[start - 1] === '\n' && text[start - 2] === '\n') start -= 1;
    if (end > start) text = text.slice(0, start) + text.slice(end);
  } else {
    const lines = text.split('\n');
    const out = [];
    let pending = null;
    const flush = () => {
      if (pending && !pending.some((l) => l.includes('dsh-undo-savepoint'))) out.push(...pending);
      pending = null;
    };
    for (const line of lines) {
      if (/^\s*-\s+/.test(line)) { flush(); pending = [line]; continue; }
      if (pending && /^\s+\S/.test(line)) { pending.push(line); continue; }
      flush();
      out.push(line);
    }
    flush();
    text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }
  await fs.writeFile(file, text.replace(/\s+$/, '') + '\n', 'utf8');
}

/**
 * Prune snapshots in the AUTO store:
 * - auto/baseline beyond keepAuto (oldest first);
 * - pre-restore beyond keepPre (consumed ones first, then oldest);
 * - orphan blobs (no snapshot references them anymore, e.g. cross-machine
 *   import leftovers);
 * - skipped entirely when autoCleanup is off (nothing is ever deleted).
 * Manual snapshots are never touched.
 * @returns {{removedAuto:number, removedPre:number, removedBlobs:number}}
 */
async function pruneAuto(cfg, list) {
  const removed = { removedAuto: 0, removedPre: 0, removedBlobs: 0 };
  if (cfg.autoCleanup === false) return removed;
  const inAuto = (s) => (s._store ?? dirLabel(cfg, s._dir)) === 'auto';
  const remove = async (snap) => {
    await fs.rm(snap._dir, { recursive: true, force: true });
  };
  const auto = list
    .filter((s) => (s.kind === 'auto' || s.kind === 'baseline') && inAuto(s))
    .sort((a, b) => (a.time < b.time ? -1 : 1));
  const excessAuto = auto.slice(0, Math.max(0, auto.length - cfg.keepAuto));
  for (const snap of excessAuto) { await remove(snap); removed.removedAuto++; }
  const pre = list
    .filter((s) => s.kind === 'pre-restore' && inAuto(s))
    .sort((a, b) => {
      // consumed pre-restores are pure garbage (redo chain already walked): delete first
      if (!!a.consumed !== !!b.consumed) return a.consumed ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });
  const excessPre = pre.slice(0, Math.max(0, pre.length - cfg.keepPre));
  for (const snap of excessPre) { await remove(snap); removed.removedPre++; }
  // orphan blobs: not referenced by ANY remaining snapshot (v0.3.2)
  removed.removedBlobs = await pruneOrphanBlobs(cfg, list);
  return removed;
}

/** 删除"没有任何快照引用"的孤儿 blob（跨机导入残留等）。返回删除数。 */
async function pruneOrphanBlobs(cfg, list) {
  const blob = blobDir(cfg);
  if (!(await pathExists(blob))) return 0;
  const refs = new Set();
  for (const s of list) {
    for (const p of (s.plugins ?? [])) {
      for (const f of (p.files ?? [])) if (f.hash) refs.add(f.hash);
    }
    for (const f of (s.profileFiles ?? [])) if (f.hash) refs.add(f.hash);
  }
  let removed = 0;
  for (const entry of await fs.readdir(blob, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!refs.has(entry.name)) {
      await fs.rm(join(blob, entry.name), { force: true });
      removed++;
    }
  }
  return removed;
}

async function markFlag(snap, flag, value) {
  if (!(await pathExists(join(snap._dir, 'manifest.json')))) return;
  snap[flag] = value;
  await writeManifest(snap._dir, snap);
}

/** Migrate legacy flat snapshots under LEGACY_ROOT into manual/auto stores by kind. */
async function migrateLegacy(cfg) {
  if (!(await pathExists(LEGACY_ROOT))) return 0;
  let moved = 0;
  for (const entry of await fs.readdir(LEGACY_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(LEGACY_ROOT, entry.name);
    const mf = join(dir, 'manifest.json');
    if (!(await pathExists(mf))) continue;
    let kind;
    try { kind = (await readManifest(dir)).kind; } catch { continue; }
    const dest = kind === 'manual' ? cfg.manualDir : cfg.autoDir;
    await fs.mkdir(dest, { recursive: true });
    await fs.rename(dir, join(dest, entry.name));
    moved++;
  }
  return moved;
}

/** Classify an auto snapshot by which config files changed (clearer list reasons). */
function classifyChange(names) {
  if (names.some((n) => n === 'package.json')) return 'plugin-change';
  if (names.some((n) => n === 'cordis.patch.yml')) return 'patch-change';
  if (names.some((n) => n === 'settings.yaml')) return 'settings-change';
  return 'config-change';
}

/**
 * Structured per-file diff (added/removed line counts + sample lines) between
 * the current config and a snapshot. Powers the WebUI diff preview and the
 * pre-restore confirmation dialog.
 */
async function diffSnapshotStructured(cfg, snap) {
  const out = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    const name = destName(spec);
    const snapPath = join(snap._dir, name);
    const snapHas = await pathExists(snapPath);
    const curHas = await pathExists(src);
    if (!snapHas && !curHas) continue;
    if (snapHas && !curHas) { out.push({ name, added: 0, removed: 0, addedLines: [], removedLines: ['(file did not exist at snapshot time)'] }); continue; }
    if (!snapHas && curHas) { out.push({ name, added: 1, removed: 0, addedLines: ['(file is absent in snapshot)'], removedLines: [] }); continue; }
    // 敏感文件（v0.3.2）：两侧都脱敏，界面永不出现明文
    let a = (await fs.readFile(snapPath, 'utf8')).split(/\r?\n/);
    let b = (await fs.readFile(src, 'utf8')).split(/\r?\n/);
    if (SENSITIVE_DESTS.has(name)) {
      a = redactByDest(name, a.join('\n')).split(/\r?\n/);
      b = redactByDest(name, b.join('\n')).split(/\r?\n/);
    }
    const setA = new Set(a); const setB = new Set(b);
    const onlyA = [...setA].filter((l) => !setB.has(l));
    const onlyB = [...setB].filter((l) => !setA.has(l));
    if (onlyA.length === 0 && onlyB.length === 0) continue;
    out.push({
      name: SENSITIVE_DESTS.has(name) ? `${name} (redacted)` : name,
      added: onlyB.length,
      removed: onlyA.length,
      addedLines: onlyB.slice(0, 8),
      removedLines: onlyA.slice(0, 8),
    });
  }
  // 插件代码树与 profile 本地代码（v0.2 模块 2）：name 带前缀，前端按行展示即可
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) {
      const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(p.dir, f.path)).catch(() => null));
      if (d) out.push({ name: `plugin:${p.name}/${f.path}`, ...d });
    }
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash) continue;
    const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(rootDir(cfg, 'profile'), f.path)).catch(() => null));
    if (d) out.push({ name: `profile:${f.path}`, ...d });
  }
  return out;
}

/**
 * 单文件行级差异（快照内容 vs 当前内容），文本/结构化两个 diff 函数共用。
 * snapBuf / curBuf 为 Buffer 或 null（缺失）；无差异返回 null。
 */
function diffFileContent(snapBuf, curBuf) {
  if (snapBuf && !curBuf) return { added: 0, removed: 1, addedLines: [], removedLines: ['(file was deleted after snapshot)'] };
  if (!snapBuf && curBuf) return { added: 1, removed: 0, addedLines: ['(snapshot content unavailable — blob missing)'], removedLines: [] };
  if (!snapBuf && !curBuf) return null;
  const a = snapBuf.toString('utf8').split(/\r?\n/);
  const b = curBuf.toString('utf8').split(/\r?\n/);
  const setA = new Set(a); const setB = new Set(b);
  const onlyA = [...setA].filter((l) => !setB.has(l));
  const onlyB = [...setB].filter((l) => !setA.has(l));
  if (onlyA.length === 0 && onlyB.length === 0) return null;
  return { added: onlyB.length, removed: onlyA.length, addedLines: onlyB.slice(0, 8), removedLines: onlyA.slice(0, 8) };
}

/** 简单 line-level diff summary between current files and a snapshot. */
async function diffSnapshot(cfg, snap) {
  const lines = [];
  for (const spec of FILE_SPECS) {
    const src = filePath(cfg, spec);
    const name = destName(spec);
    const snapPath = join(snap._dir, name);
    const snapHas = await pathExists(snapPath);
    const curHas = await pathExists(src);
    if (!snapHas && !curHas) continue;
    if (snapHas && !curHas) { lines.push(`${name}: file did not exist at snapshot time`); continue; }
    if (!snapHas && curHas) { lines.push(`${name}: NEW file (absent in snapshot)`); continue; }
    // 敏感文件（v0.3.2）：diff 两侧都过脱敏（快照侧可能是旧快照明文，
    // 当前侧是真实明文——任何一侧都不能泄露真实值）
    const snapBuf = SENSITIVE_DESTS.has(name) ? await snapSensitiveBuf(cfg, snap, name) : await fs.readFile(snapPath).catch(() => null);
    let a = (snapBuf ? snapBuf.toString('utf8') : '').split(/\r?\n/);
    let b = (await fs.readFile(src, 'utf8')).split(/\r?\n/);
    if (SENSITIVE_DESTS.has(name)) {
      a = redactByDest(name, a.join('\n')).split(/\r?\n/);
      b = redactByDest(name, b.join('\n')).split(/\r?\n/);
    }
    const setA = new Set(a); const setB = new Set(b);
    const onlyA = [...setA].filter((l) => !setB.has(l));
    const onlyB = [...setB].filter((l) => !setA.has(l));
    if (onlyA.length === 0 && onlyB.length === 0) continue;
    lines.push(`${name}: snapshot has ${onlyA.length} unique line(s), current has ${onlyB.length} unique line(s)`);
    if (SENSITIVE_DESTS.has(name)) lines.push(`  (sensitive values are redacted in diffs; restore pulls real values from the local vault)`);
    for (const l of onlyA.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    for (const l of onlyB.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
  }
  // 插件代码树与 profile 本地代码（v0.2 模块 2）
  for (const p of (snap.plugins ?? [])) {
    for (const f of (p.files ?? [])) {
      const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(p.dir, f.path)).catch(() => null));
      if (!d) continue;
      const label = `plugin ${p.name}/${f.path}`;
      const note = [...d.removedLines, ...d.addedLines].find((l) => l.startsWith('('));
      if (note) { lines.push(`${label}: ${note}`); continue; }
      lines.push(`${label}: snapshot has ${d.removed} unique line(s), current has ${d.added} unique line(s)`);
      for (const l of d.removedLines.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
      for (const l of d.addedLines.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    }
  }
  for (const f of (snap.profileFiles ?? [])) {
    if (!f.hash) continue;
    const d = diffFileContent(await readBlob(cfg, f.hash), await fs.readFile(join(rootDir(cfg, 'profile'), f.path)).catch(() => null));
    if (!d) continue;
    const label = `profile ./${f.path}`;
    const note = [...d.removedLines, ...d.addedLines].find((l) => l.startsWith('('));
    if (note) { lines.push(`${label}: ${note}`); continue; }
    lines.push(`${label}: snapshot has ${d.removed} unique line(s), current has ${d.added} unique line(s)`);
    for (const l of d.removedLines.slice(0, 6)) lines.push(`  - (in snapshot) ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
    for (const l of d.addedLines.slice(0, 6)) lines.push(`  + (current)    ${l.length > 120 ? l.slice(0, 120) + '…' : l}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no differences)';
}

/**
 * Undo candidates: non-pre-restore snapshots whose recorded state is not also
 * recorded by an unconsumed pre-restore (states we undid from), newest first.
 */
async function undoCandidates(cfg, list) {
  const unconsumedPre = list.filter((s) => s.kind === 'pre-restore' && !s.consumed);
  const preStates = [];
  for (const p of unconsumedPre) preStates.push(await stateOf(p));
  const candidates = [];
  for (const s of list) {
    if (s.kind === 'pre-restore') continue;
    const st = await stateOf(s);
    if (preStates.some((p) => sameState(p, st))) continue; // undid from this state
    candidates.push({ s, st });
  }
  return candidates;
}

/**
 * Append one rollback event to <settings dir>/rollback-log.jsonl (kept to the
 * last 100 lines). This log is independent of snapshots and never blocks a
 * rollback on failure; it lets OTHER sessions / the AI learn which config
 * files were rolled back and when.
 */
async function appendRollbackLog(cfg, entry) {
  try {
    const dir = dirname(cfg.settingsFile);
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'rollback-log.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch { /* new file */ }
    text += line;
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length > 100) text = lines.slice(lines.length - 100).join('\n') + '\n';
    await fs.writeFile(file, text, 'utf8');
  } catch { /* logging must never break rollback */ }
}

/**
 * Undo/redo stack.
 * undo: restore the newest candidate whose state differs from the current one
 *   (identical snapshots are skipped); the current state is always preserved
 *   as a pre-restore snapshot first.
 * redo: apply the newest unconsumed pre-restore, but only when nothing newer
 *   exists except already-consumed pre-restores (i.e. no real change happened
 *   since the undo); consuming it un-steps matching regular snapshots so undo
 *   can walk back through them again.
 */
async function restore(cfg, mode, id, options = {}) {
  if (hasOpenTurn()) return busyError();
  const syncDeps = options.syncDeps === true;
  const list = await listSnapshots(cfg);

  if (mode === 'undo') {
    const cur = await currentState(cfg);
    const candidates = await undoCandidates(cfg, list);
    if (candidates.length === 0) return { ok: false, error: 'nothing to undo' };
    const target = candidates.find((c) => !sameState(cur, c.st)) ?? null;
    if (!target) {
      return {
        ok: true,
        unchanged: true,
        targetId: candidates[0].s.id,
        message: 'Current config already matches every undoable snapshot — no real change since the last snapshot, so there is nothing to undo.',
      };
    }
    const stepped = target !== candidates[0];
    const pre = await createSnapshot(cfg, 'pre-restore', `before-restore:${target.s.id} (${target.s.kind}: ${target.s.reason ?? ''})`);
    cfg.suppressAuto++;
    try {
      const { restored, missing, notes } = await applySnapshot(cfg, target.s);
      if (stepped) await markFlag(candidates[0].s, 'stepped', true);
      const remounted = await ensureMount(cfg);
      const needsRestart = testNeedsRestart(restored);
      const deps = await reconcileDependencies(cfg, restored, syncDeps);
      const preflight = await preflightSnapshot(cfg, target.s);
      await appendRollbackLog(cfg, { mode: 'undo', targetId: target.s.id, targetKind: target.s.kind, preSnapshotId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
      return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: target.s.id, targetKind: target.s.kind, targetReason: target.s.reason, preSnapshotId: pre.id, stepped, remounted };
    } finally {
      cfg.suppressAuto--;
    }
  }

  if (mode === 'redo') {
    const pre = list.find((s) => s.kind === 'pre-restore' && !s.consumed);
    if (!pre) return { ok: false, error: 'nothing to redo' };
    // Block only when a REAL change happened after the undo: a newer snapshot
    // that is not an already-consumed pre-restore.
    const newer = list.find((s) => s.time > pre.time && (s.kind !== 'pre-restore' || !s.consumed));
    if (newer) return { ok: false, error: 'redo blocked: newer changes exist after the undo' };
    cfg.suppressAuto++;
    try {
      const { restored, missing, notes } = await applySnapshot(cfg, pre);
      await markFlag(pre, 'consumed', true);
      // Un-step any regular snapshot whose state matches the consumed pre-restore,
      // so a later undo can walk back through it again.
      const preState = await stateOf(pre);
      for (const s of list) {
        if (s.kind === 'pre-restore' || !s.stepped) continue;
        if (sameState(preState, await stateOf(s))) await markFlag(s, 'stepped', false);
      }
      const needsRestart = testNeedsRestart(restored);
      const deps = await reconcileDependencies(cfg, restored, syncDeps);
      const preflight = await preflightSnapshot(cfg, pre);
      await appendRollbackLog(cfg, { mode: 'redo', targetId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
      return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: pre.id, preSnapshotId: pre.id, remounted: false };
    } finally {
      cfg.suppressAuto--;
    }
  }

  // mode 'id'
  const target = findSnapshot(list, id ?? '');
  if (!target) return { ok: false, error: `snapshot not found: ${id}` };
  const pre = await createSnapshot(cfg, 'pre-restore', `before-restore:${target.id} (${target.kind}: ${target.reason ?? ''})`);
  cfg.suppressAuto++;
  try {
    const { restored, missing, notes } = await applySnapshot(cfg, target);
    const remounted = await ensureMount(cfg);
    const needsRestart = testNeedsRestart(restored);
    const deps = await reconcileDependencies(cfg, restored, syncDeps);
    const preflight = await preflightSnapshot(cfg, target);
    await appendRollbackLog(cfg, { mode: 'restore', targetId: target.id, targetKind: target.kind, preSnapshotId: pre.id, files: restored, missing, notes, needsRestart, deps, preflightMissing: preflight.missing });
    return { ok: true, restored, missing, notes, needsRestart, deps, preflight, targetId: target.id, targetKind: target.kind, targetReason: target.reason, preSnapshotId: pre.id, stepped: false, remounted };
  } finally {
    cfg.suppressAuto--;
  }
}

/** Delete one snapshot by id (from whichever store it lives in). */
async function removeSnapshot(cfg, id) {
  const list = await listSnapshots(cfg);
  const snap = findSnapshot(list, id ?? '');
  if (!snap) return { ok: false, error: `snapshot not found: ${id}` };
  await fs.rm(snap._dir, { recursive: true, force: true });
  return { ok: true, removed: id };
}

/** Open a native folder-picker dialog via PowerShell and resolve the chosen path. */
function pickDirectory() {
  return new Promise((resolve) => {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$f.Description = 'Select snapshot directory'",
      '$f.ShowNewFolderButton = $true',
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-Command', script], {
      timeout: 300000, // give the user time to browse; cancel returns empty
      windowsHide: true, // no console flash
      encoding: 'utf8',
    }, (_err, stdout) => {
      const p = (stdout ?? '').trim();
      if (p) return resolve({ ok: true, path: p });
      return resolve({ ok: false, cancelled: true });
    });
  });
}

/** Open a native file-picker dialog via PowerShell (used to choose an export zip). */
function pickFile() {
  return new Promise((resolve) => {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      "$f.Filter = 'ZIP archives (*.zip)|*.zip|All files (*.*)|*.*'",
      '$f.Title = "Select a dsh-undo-savepoint snapshot export"',
      "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }",
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-Command', script], {
      timeout: 300000,
      windowsHide: true,
      encoding: 'utf8',
    }, (_err, stdout) => {
      const p = (stdout ?? '').trim();
      if (p) return resolve({ ok: true, path: p });
      return resolve({ ok: false, cancelled: true });
    });
  });
}

/** Run a short PowerShell command (zip helpers); rejects on failure. */
function runPowershell(parts) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', parts.join(' ')], {
      windowsHide: true,
      timeout: 180000,
    }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Export directory for snapshot archives (next to the snapshot root). */
const EXPORT_ROOT = process.env.DSH_UNDO_EXPORT ?? join(dirname(LEGACY_ROOT), 'undo-exports');

/** Zip the manual + auto stores into D:\dsh\undo-exports\*.zip (portable backup / transfer). */
async function exportSnapshots(cfg) {
  await fs.mkdir(EXPORT_ROOT, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = join(EXPORT_ROOT, `tmp-${ts}`);
  const zip = join(EXPORT_ROOT, `dsh-undo-export-${ts}.zip`);
  let count = 0;
  // 导出前风险提示（v0.3.2）：keep 模式或旧快照可能含明文敏感文件
  let sensitiveWarning = false;
  try {
    await fs.mkdir(tmp, { recursive: true });
    for (const base of [cfg.manualDir, cfg.autoDir]) {
      if (!(await pathExists(base))) continue;
      const label = base === cfg.manualDir ? 'manual' : 'auto';
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!(await pathExists(join(base, entry.name, 'manifest.json')))) continue;
        try {
          const snap = await readManifest(join(base, entry.name));
          if (snap.sensitiveMode !== 'redact' && (snap.files ?? []).some((f) => SENSITIVE_DESTS.has(f.name))) {
            sensitiveWarning = true;
          }
        } catch { /* broken manifest: ignore */ }
        await fs.cp(join(base, entry.name), join(tmp, label, entry.name), { recursive: true });
        count++;
      }
    }
    // v0.2：插件代码 blob 库一起打包，否则导入后 restore 缺内容
    const blob = blobDir(cfg);
    if (await pathExists(blob)) {
      await fs.mkdir(join(tmp, 'blobs'), { recursive: true });
      for (const entry of await fs.readdir(blob, { withFileTypes: true })) {
        if (entry.isFile()) await fs.cp(join(blob, entry.name), join(tmp, 'blobs', entry.name));
      }
    }
    await runPowershell(['Compress-Archive', '-Path', `"${tmp}\\*"`, '-DestinationPath', `"${zip}"`, '-Force']);
    return { ok: true, path: zip, count, sensitiveWarning };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ });
  }
}

/** Import snapshots from an export zip: snapshot dirs with manifests are copied
 * into the matching store by kind (manual -> manual, everything else -> auto).
 * Same-id snapshots are skipped (never overwritten). */
async function importSnapshots(cfg, zipPath) {
  if (!zipPath || !(await pathExists(zipPath))) return { ok: false, error: `file not found: ${zipPath ?? '(none)'}` };
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = join(EXPORT_ROOT, `imp-${ts}`);
  let imported = 0;
  let skipped = 0;
  try {
    await fs.mkdir(tmp, { recursive: true });
    await runPowershell(['Expand-Archive', '-Path', `"${zipPath}"`, '-DestinationPath', `"${tmp}"`, '-Force']);
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (!entry.isDirectory()) continue;
        const mf = join(p, 'manifest.json');
        if (!(await pathExists(mf))) { await walk(p); continue; }
        let kind;
        try { kind = (await readManifest(p)).kind; } catch { kind = 'auto'; }
        const dest = kind === 'manual' ? cfg.manualDir : cfg.autoDir;
        if (await pathExists(join(dest, entry.name))) { skipped++; continue; }
        await fs.cp(p, join(dest, entry.name), { recursive: true });
        imported++;
      }
    };
    await walk(tmp);
    // v0.2：导入 blob 库（内容寻址，已存在则跳过）
    const blobTmp = join(tmp, 'blobs');
    if (await pathExists(blobTmp)) {
      const destBlob = blobDir(cfg);
      await fs.mkdir(destBlob, { recursive: true });
      for (const entry of await fs.readdir(blobTmp, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!(await pathExists(join(destBlob, entry.name)))) {
          await fs.cp(join(blobTmp, entry.name), join(destBlob, entry.name));
        }
      }
    }
    return { ok: true, imported, skipped, source: zipPath };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* noop */ });
  }
}

function renderRestoreResult(r) {
  if (!r.ok) {
    const err = typeof r.error === 'string' ? r.error : (r.error?.message ?? 'unknown error');
    return `undo_restore failed: ${err}`;
  }
  if (r.unchanged) return r.message ?? 'No undoable changes.';
  const lines = [
    `Restored snapshot ${r.targetId} (${r.targetKind}${r.targetReason ? `: ${r.targetReason}` : ''})`,
    `Files restored: ${r.restored.length > 0 ? r.restored.join(', ') : '(none)'}`,
    `Current state preserved as ${r.preSnapshotId} (redo target)`,
  ];
  if (r.stepped) lines.push('(stepped back past a post-change record)');
  if (r.remounted) lines.push('dsh-undo-savepoint mount re-ensured in cordis.patch.yml');
  if (Array.isArray(r.missing) && r.missing.length > 0) lines.push(`Not restored: ${r.missing.join(', ')}`);
  if (r.needsRestart) lines.push('NOTE: a restart of DSH is required for the restored state to take effect.');
  if (r.deps?.touched) {
    if (r.deps.synced) {
      lines.push(`Dependencies synced: ${r.deps.command}`);
    } else {
      lines.push(`⚠️ ${r.deps.note}`);
      lines.push('Restored config files are in place; re-run with sync_deps=true to rebuild dependencies automatically.');
    }
  }
  if (Array.isArray(r.preflight?.missing) && r.preflight.missing.length > 0) {
    lines.push(`⚠️ Cross-machine preflight: referenced but NOT resolvable on this machine: ${r.preflight.missing.join(', ')}`);
    lines.push('DSH may fail to start after restore — install them first, or use undo_safe_mode action "on" to boot with only the undo system.');
  }
  if (Array.isArray(r.notes) && r.notes.length > 0) {
    for (const n of r.notes) lines.push(`Note: ${n}`);
  }
  return lines.join('\n');
}

function publicSettings(cfg) {
  return {
    autoEnabled: cfg.autoEnabled,
    watchDebounceMs: cfg.watchDebounceMs,
    keepAuto: cfg.keepAuto,
    keepPre: cfg.keepPre,
    autoCleanup: cfg.autoCleanup,
    manualDir: cfg.manualDir,
    autoDir: cfg.autoDir,
    snapshotDir: LEGACY_ROOT,
    pluginDirs: Array.isArray(cfg.pluginDirs) ? cfg.pluginDirs : [],
    sensitiveMode: cfg.sensitiveMode ?? 'redact',
  };
}

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

/** 最近一次 apply() 的 ctx 引用（供 hasOpenTurn 取 session store）。 */
let ctxRef = null;

/**
 * 是否有会话正在运行（日志以 turn/start 结尾、未被 turn/end 闭合 = agent 正在执行）。
 * 依据：DSH 会话日志事件（dsh-session 包，turn/start / turn/end 边界；dsh-agent-instructions
 * 的 interruptedTurnClosers 判定同源）。撤销/恢复会写回配置并触发 DSH 内置 HMR 重建插件树，
 * 可能中断所有正在跑的会话——运行中一律拒绝（修复方案 A 安全闸）。
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

/** 会话运行中拒绝提示（restore / safe-mode 守卫统一口径）。 */
function busyError() {
  return { ok: false, error: { code: 'busy', message: '有会话正在运行(agent 执行中)。撤销/恢复会重载配置并热重启插件树,可能中断所有会话;请先等待当前任务结束或手动中断它,再重试。' } };
}

/**
 * Host plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
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
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const reason = typeof args?.reason === 'string' && args.reason !== '' ? args.reason : 'manual';
      const snap = await createSnapshot(cfg, 'manual', reason);
      return `Manual snapshot ${snap.id} created (${snap.files.length} file(s), reason: ${reason}). Store: ${cfg.manualDir}`;
    },
  })), 'dsh-undo-savepoint.tool.snapshot');

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
      if (list.length === 0) return 'No snapshots yet. They appear automatically when config files change.';
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
      if (!snap) return `Snapshot not found: ${id ?? '(empty)'}. Run undo_list first.`;
      return `Diff of ${snap.id} vs current:\n${await diffSnapshot(cfg, snap)}`;
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
      if (!['undo', 'redo', 'id'].includes(mode)) return `undo_restore: unknown mode "${mode}" (use undo | redo | id)`;
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
      if (cfg.autoCleanup === false) return 'Auto-cleanup is disabled in settings — no snapshots were deleted.';
      return `Pruned ${r.removedAuto} auto/baseline and ${r.removedPre} pre-restore snapshot(s)${r.removedBlobs > 0 ? `, ${r.removedBlobs} orphan blob(s)` : ''}. Auto keeps ${cfg.keepAuto}, pre-restore keeps ${cfg.keepPre}.`;
    },
  })), 'dsh-undo-savepoint.tool.prune');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_export',
    description: 'Export ALL snapshots (manual + auto) into a portable ZIP archive (default: <snapshot root>/../undo-exports). Use for backup or moving to another machine. Returns the archive path.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const r = await exportSnapshots(cfg);
      if (!r.ok) return `undo_export failed: ${r.error}`;
      const warn = r.sensitiveWarning
        ? '\n⚠️ WARNING: this archive contains REAL secrets (.env / .credentials.yaml in keep mode or legacy snapshots) — do NOT share it.'
        : '';
      return `Exported ${r.count} snapshot(s) to ${r.path}${warn}`;
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
      if (!r.ok) return `undo_import failed: ${r.error}`;
      return `Imported ${r.imported} snapshot(s) from ${r.source}${r.skipped > 0 ? ` (${r.skipped} skipped: already present)` : ''}.`;
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
      if (lines.length === 0) return 'No rollback operations recorded yet.';
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
        if (!r.ok) return `undo_safe_mode failed: ${typeof r.error === 'string' ? r.error : (r.error?.message ?? 'unknown error')}`;
        return r.message;
      }
      const st = await safeModeStatus(cfg);
      return st.active ? `Safe mode is ON (entered ${st.enteredAt ?? '?'}, backup: ${st.backup ?? '?'}).` : 'Safe mode is OFF.';
    },
  })), 'dsh-undo-savepoint.tool.safemode');

  safeEffect(() => registerToolOnce(defineTool({
    name: 'undo_scan',
    description: 'Scan DSH session files (<home>/sessions/**/session.jsonl.zstd) for health: "ok" (compliant multi-frame layout), "fixable" (single-frame layout violation — the 8/18 crash root cause), or "corrupt" (undecodable / invalid header / bad JSON lines). With quarantine=true, fixable files are repaired in place: original is copied to <undo root>/corrupt-quarantine/ and kept as <file>.bak, then recoded to header frame + event frames with triple verification (round-trip text, per-line JSON, re-analysis); corrupt files are only isolated (copied, never touched). Read-only by default.',
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
              const fixedBytes = recodeSessionBytes(raw);
              const qdir = join(cfg.autoDir, '..', 'corrupt-quarantine');
              await fs.mkdir(qdir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              await fs.writeFile(join(qdir, `${basename(dirname(p))}-${stamp}.jsonl.zstd`), raw);
              await fs.writeFile(p + '.bak', raw);
              await fs.writeFile(p, fixedBytes);
              lines.push(`  fixed    ${p} (single-frame violation, ${a.events} events -> header frame + event frame; original -> .bak)`);
              fixed++;
            } catch (error) {
              lines.push(`  failed   ${p} (${String(error?.message ?? error)})`);
              corrupt++;
            }
          } else {
            lines.push(`  fixable  ${p} (single-frame violation, ${a.events} events; rerun with quarantine=true to repair)`);
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
        for (const { dir, file } of items) {
          if (configDirs.has(dir)) {
            if (WATCHED_BASENAMES.has(basename(file))) configNames.push(file);
          } else if (isCodeFile(file)) {
            pluginEvents.push({ dir, file });
          }
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
        if (configNames.length === 0 && pluginReasons.length === 0) return;
        cfg.restoredHashes = new Map(); // a real change supersedes echo records
        try {
          const reason = pluginReasons.length > 0 ? 'plugin-code-change' : classifyChange(configNames);
          const snap = await createSnapshot(cfg, 'auto', reason);
          const list = await listSnapshots(cfg);
          const pruned = await pruneAuto(cfg, list);
          const prunedN = pruned.removedAuto + pruned.removedPre;
          if (snap.files.length > 0 || (snap.plugins ?? []).length > 0) ctx.logger.info(`[dsh-undo-savepoint] auto snapshot ${snap.id} (${snap.files.length} config file(s), ${(snap.plugins ?? []).length} plugin tree(s), ${reason}${prunedN > 0 ? `, pruned ${prunedN}` : ''})`);
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

  // ── REST API for the WebUI ─────────────────────────────────────────────
  const webServer = ctx.webServer ?? ctx.get('webServer');
  if (webServer) {
    const send = (res, status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(text);
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
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local');
          const path = url.pathname;
          const method = (req.method ?? 'GET').toUpperCase();
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
            // v0.3.2：敏感模式（redact 脱敏+vault | keep 明文）
            if (body.sensitiveMode === 'redact' || body.sensitiveMode === 'keep') cfg.sensitiveMode = body.sensitiveMode;
            await fs.mkdir(dirname(cfg.settingsFile), { recursive: true });
            await fs.writeFile(cfg.settingsFile, JSON.stringify(publicSettings(cfg), null, 2), 'utf8');
            await fs.mkdir(cfg.manualDir, { recursive: true });
            await fs.mkdir(cfg.autoDir, { recursive: true });
            startWatcher();
            // apply the new retention limits immediately
            const pruned = await pruneAuto(cfg, await listSnapshots(cfg));
            return send(res, 200, { ok: true, settings: publicSettings(cfg), pruned });
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
            return send(res, 200, { ok: true, ...await exportSnapshots(cfg) });
          }
          if (method === 'POST' && path === '/api/undo/pick-file') {
            return send(res, 200, { ok: true, ...await pickFile() });
          }
          if (method === 'POST' && path === '/api/undo/import') {
            const body = await readJson(req);
            return send(res, 200, { ok: true, ...await importSnapshots(cfg, body?.path) });
          }
          return send(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${path}` } });
        } catch (error) {
          return send(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } });
        }
      },
    }), 'dsh-undo-savepoint.api');
  }
}
