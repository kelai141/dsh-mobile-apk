// task-18 反证回归（0.14.0 用户反馈五 / 反馈六）：undo_list 时间口径 + undo_scan 会话文件名。
//
// 依据用户 2026-09-19 反馈原文（报错反馈同批）：
//   五：快照 id 用本地时间（`20260919-120038`），undo_list 显示时间用 UTC（`2026-09-19 04:00:38`）→ 差 8 小时。
//   六：本版会话文件名是 `session.v3.jsonl.zstd`，undo_scan 按 `session.jsonl.zstd` 匹配 → `scanned 0 session file(s)`。
//
// 判据形态（禁「grep 文本在场」）：**真跑插件的 apply()**，用桩 ctx 捕获工具，
// 再对真实临时目录调 **真实 execute()**，断言输出文本里的**可观察事实**（时间数值 / 扫描计数）。
// 每项都有「改坏就判红」的构造：⑤ 用带偏移的 TZ 让 UTC 与本地必然不同；
// ⑥ 放一个真实 `session.v3.jsonl.zstd` 文件，旧实现必然数不到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib'

/** zstd 帧参数：与实现重编码时同口径（带 checksum），否则帧边界扫描不认。
 *  键必须取 `ZSTD_c_checksumFlag`（本机实测 = 201），不能硬编码 1（Node 会报「Setting parameter failed」）。 */
const ZSTD_CHECKSUM = { params: { [zlibConstants.ZSTD_c_checksumFlag ?? 1]: 1 } }

const HERE = dirname(fileURLToPath(import.meta.url))
/** 被测实现：默认取本插件 lib/index.js；测试自身可经 UUT 覆盖（判红时指向 HEAD 副本）。 */
const VENDOR = process.env.DSH_UNDO_UUT ?? join(HERE, '..', 'lib', 'index.js')

/**
 * 定位一个能解析 `@deepseek-ai/dsh-tools` 的锚点（本插件的 peer 依赖）。
 * 沿目录上溯找 `<root>/plugins/dsh-android-browser`——真实树与判红用的影子树都能命中，
 * 不写死机器路径（本仓纪律：路径不写死；跨机与影子树布局都能跑）。
 */
function resolveDshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT
  let dir = HERE
  for (let i = 0; i < 8; i += 1) {
    const cand = join(dir, 'plugins', 'dsh-android-browser')
    if (existsSync(join(cand, 'node_modules', '@deepseek-ai', 'dsh-tools'))) return cand
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到可解析 @deepseek-ai/dsh-tools 的锚点（未设 DSH_ROOT 且上溯 8 层无命中）')
}

/** 装载插件，返回 name -> tool。DSH_ROOT 让插件解析到 @deepseek-ai/dsh-tools。 */
async function loadTools(homeDir) {
  process.env.DSH_ROOT = resolveDshRoot()
  process.env.DSH_HOME = join(homeDir, '.dsh')
  // 每次用唯一查询串绕开 ESM 模块缓存（cfg 在 apply 时闭包捕获 homeDir）。
  const mod = await import(pathToFileURL(VENDOR).href + '?t=' + Math.random())
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect: (fn) => { try { const r = fn?.(); return typeof r === 'function' ? r : () => {} } catch { return () => {} } },
    get: () => undefined,
    tools: { register: (t) => { tools.push(t); return () => {} } },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
    on: () => {},
  }
  mod.apply(ctx, {
    homeDir,
    profileDir: join(homeDir, '.dsh', 'profiles', 'web'),
    manualDir: join(homeDir, 'undo', 'manual'),
    autoDir: join(homeDir, 'undo', 'auto'),
    profileName: 'web',
    autoEnabled: false,
    pluginDirs: [],
  })
  return { tools, byName: (n) => tools.find((t) => t.name === n) }
}

/**
 * 写一个**合规**的多帧会话文件（analyzeSessionBytes 判 ok）。
 *
 * 合规判据取自被测实现自身：首行须过 `isSessionHeaderLine`（type=session / version 数字 /
 * id 字符串 / createdAt 非负安全整数 / delegationDepth 非负安全整数），且 zstd 流必须是
 * **≥2 帧**（header 独立帧 + 事件帧）——单帧正是它要报 'fixable' 的历史缺陷形态。
 * 帧参数带 checksum，与实现重编码时一致（否则 zstdScanFrames 的帧边界校验过不去）。
 */
function writeSessionFile(homeDir, rel, events) {
  const header = JSON.stringify({
    type: 'session', version: 3, id: 'sess-1', createdAt: 1789783784493, delegationDepth: 0,
  })
  const rest = events.map((e) => JSON.stringify(e)).join('\n')
  const frames = [zstdCompressSync(Buffer.from(header + '\n', 'utf8'), ZSTD_CHECKSUM)]
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), ZSTD_CHECKSUM))
  const abs = join(homeDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.concat(frames))
  return abs
}

/** 临时 home 夹具。**必须 await**：回调是 async，若不 await，finally 会在测试体执行前
 *  就把目录删掉，测试全部变成「目录不存在」的假红（本文件初版即踩此坑，已实测确认）。 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-undo-task18-'))
  try { return await fn(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

// ── 反馈六：undo_scan 必须认 session.vN.jsonl.zstd ────────────────────────────

test('反馈六反证：undo_scan 必须扫到本版 session.v3.jsonl.zstd（旧实现恒 0）', async () => {
  await withTempHome(async (home) => {
    // 本版实际命名（引擎权威：session-format/src/filename.ts 的 canonical 名 + .zstd 压缩后缀）
    writeSessionFile(home, 'sessions/proj-a/session.v3.jsonl.zstd', [{ type: 'message', role: 'user', text: 'hi' }])
    const { byName } = await loadTools(home)
    const scan = byName('undo_scan')
    assert.ok(scan, 'undo_scan 必须注册')
    const text = String(await scan.execute({}, {}))
    // 判据：扫到的文件数 > 0。旧实现输出 "scanned 0 session file(s)"。
    const m = /scanned (\d+) session file\(s\)/.exec(text)
    assert.ok(m, '输出必须含 scanned N session file(s) 计数：' + text)
    assert.ok(Number(m[1]) > 0, '本版 session.v3.jsonl.zstd 必须被扫到（旧实现恒 0）：' + text)
    assert.match(text, /ok\s+.*session\.v3\.jsonl\.zstd/, '该文件必须被判 ok 并逐条列出：' + text)
  })
})

test('反馈六回归：v0 旧名 session.jsonl.zstd 必须仍被扫到（向后兼容，不得只修新名）', async () => {
  await withTempHome(async (home) => {
    writeSessionFile(home, 'sessions/proj-old/session.jsonl.zstd', [{ type: 'message', role: 'user', text: 'legacy' }])
    const { byName } = await loadTools(home)
    const text = String(await byName('undo_scan').execute({}, {}))
    const m = /scanned (\d+) session file\(s\)/.exec(text)
    assert.ok(m && Number(m[1]) === 1, 'v0 旧名必须仍被扫到：' + text)
    assert.match(text, /session\.jsonl\.zstd/, '旧名文件必须逐条列出：' + text)
  })
})

test('反馈六反例（防放宽过度）：非规范名不得混入扫描面', async () => {
  await withTempHome(async (home) => {
    // 上游 filename.ts 明确「临时/大写/前导零/.v0/压缩后缀名」都非 canonical：
    // 只放宽到「带合法代数」，不改成 *.jsonl.zstd 通配。
    writeSessionFile(home, 'sessions/p1/session.v3.jsonl.zstd', [{ type: 'message', role: 'user', text: 'real' }])
    for (const bogus of ['session.jsonl.zstd.tmp', 'session.v0.jsonl.zstd', 'session.v03.jsonl.zstd', 'notes.jsonl.zstd']) {
      mkdirSync(join(home, 'sessions', 'p1'), { recursive: true })
      writeFileSync(join(home, 'sessions', 'p1', bogus), Buffer.from('not-a-session'))
    }
    const { byName } = await loadTools(home)
    const text = String(await byName('undo_scan').execute({}, {}))
    const m = /scanned (\d+) session file\(s\)/.exec(text)
    assert.ok(m && Number(m[1]) === 1, '只应扫到 1 个规范名文件，非规范名不得计入：' + text)
  })
})

// ── 反馈五：undo_list 时间口径必须与快照 id 同源（本地时间）───────────────────

test('反馈五反证：undo_list 显示时间必须与快照 id 同口径（不得是 UTC 差 8 小时）', async () => {
  // 固定时区：UTC+8。这样 UTC 串 04:00:38 与本地 12:00:38 必然不同（可判红）。
  const savedTz = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    await withTempHome(async (home) => {
      // 造一个真实快照目录：id 用本地时间（makeId 口径），time 用 UTC ISO（manifest 口径）。
      const local = new Date('2026-09-19T04:00:38.000Z') // UTC 04:00 = 本地 12:00
      const p = (n) => String(n).padStart(2, '0')
      const id = `${local.getFullYear()}${p(local.getMonth() + 1)}${p(local.getDate())}-${p(local.getHours())}${p(local.getMinutes())}${p(local.getSeconds())}-ab12`
      const autoDir = join(home, 'undo', 'auto')
      mkdirSync(join(autoDir, id), { recursive: true })
      writeFileSync(join(autoDir, id, 'manifest.json'), JSON.stringify({
        id, time: local.toISOString(), kind: 'auto', reason: 'test', files: [], plugins: [], profileFiles: [],
      }))

      const { byName } = await loadTools(home)
      const text = String(await byName('undo_list').execute({}, {}))
      const row = text.split('\n').find((l) => l.includes(id))
      assert.ok(row, 'undo_list 必须列出该快照：' + text)

      // 判据：行内显示的时刻必须等于「本地 12:00:38」，不是「UTC 04:00:38」。
      const shown = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(row)
      assert.ok(shown, '快照行必须含可解析的显示时间：' + row)
      assert.equal(shown[1], '2026-09-19 12:00:38',
        '显示时间必须与快照 id 同口径（本地时间）；UTC 口径会显示 04:00:38：' + row)
      // 与 id 做交叉校验：id 里的时间分量必须能在显示时间中找到（防「换了口径但两处仍不一致」）。
      assert.ok(shown[1].startsWith('2026-09-19') && shown[1].includes('12:00:38'),
        'id 与显示时间必须一致：' + row)
    })
  } finally {
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  }
})

test('反馈五边界：不可解析的 time 原样回显，不得伪造成有效时刻或抛错', async () => {
  const savedTz = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    await withTempHome(async (home) => {
      const autoDir = join(home, 'undo', 'auto')
      const id = '20260919-120038-ab12'
      mkdirSync(join(autoDir, id), { recursive: true })
      writeFileSync(join(autoDir, id, 'manifest.json'), JSON.stringify({
        id, time: 'not-a-timestamp', kind: 'auto', reason: 'test', files: [], plugins: [], profileFiles: [],
      }))
      const { byName } = await loadTools(home)
      const text = String(await byName('undo_list').execute({}, {}))
      assert.ok(text.includes(id), '损坏 time 的快照仍须列出（不得整行消失）：' + text)
      assert.ok(!/Invalid Date/.test(text), '不得输出 Invalid Date：' + text)
    })
  } finally {
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  }
})
