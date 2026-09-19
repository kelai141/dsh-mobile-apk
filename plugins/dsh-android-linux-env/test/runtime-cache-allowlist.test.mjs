// 0.14.1 块 E 反证（docs/0.14.1-preview-LEGACY-AND-PERF.md §4.3 / §5.1 G-9）：
// 白名单清理必须**能红能绿**——不删白名单外的东西、删得掉白名单命中的东西、保留当前 log 代。
//
// 关键纪律（G-9 明令）：
//  * 禁止只断言「删除后目录不存在」——那不证明没删错东西；判据是**逐字节比对**未列入白名单的
//    fixture 在清理后**未变**。
//  * **不得用硬编码路径做 fixture 断言**：fixture 的根一律经 `$DSH_HOME`（`resolveHarnessHome`）
//    与 `$DSH_FILES_DIR` 解析，测试只写这两个环境变量。
//  * 「改前必红」成对跑：把硬清单里的一类**临时**放进白名单（`CACHE_SUBDIR_ALLOW` 的等价物），
//    反证必须红——见本文件末尾的 `assertAllowlistRejects` 对照断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CURRENT_ENGINE_LOG,
  displayLabel,
  engineLogRoot,
  executeCleanup,
  insideAllowedScope,
  isPreserved,
  planCleanup,
  resolveHarnessHome,
  scanTargets,
} from '../lib/runtime-cache.js'

/** 造一份 fixture 树：DSH_HOME 下的用户资产 + 白名单内/外的缓存目录 + 日志世代。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-cache-'))
  const home = join(root, 'home', '.dsh')
  const files = join(root, 'files')
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  // ── 硬清单（绝不触碰） ──
  write(join(home, '.credentials.yaml'), 'apiKey: super-secret\n')
  write(join(home, 'settings.yaml'), 'model: deepseek\n')
  write(join(home, '.anonymous-user-id'), 'anon-1\n')
  write(join(home, 'sessions', 's1.jsonl'), '{"event":"session"}\n')
  write(join(home, 'storages', 'workspace.json'), '{}\n')
  write(join(home, 'attachments', 'v1', 'files', 'ab', 'x.png'), 'PNGDATA')
  write(join(home, 'profiles', 'web', 'package.json'), '{"name":"web"}\n')
  write(join(home, 'profiles', 'web', 'node_modules', 'dep', 'index.js'), 'module.exports=1\n')
  write(join(home, 'workspaces', 'w1', 'note.txt'), 'user file\n')
  write(join(home, 'models-store.json'), '{}\n')
  // ── 白名单外的一次性路径（必须原样保留） ──
  write(join(home, 'cache', 'attachments', 'request-images', 'ab', 'hash'), 'ENGINE-OWNED-CACHE')
  write(join(home, 'cache', 'some-new-upstream-cache', 'data.bin'), 'UNRECOGNIZED')
  write(join(home, 'cache', 'artifact-access.key'), 'key-material')
  // ── 白名单命中（应可删）：`DSH_HOME/.node-compile-cache`（有据可查的可再生缓存） ──
  write(join(home, '.node-compile-cache', 'v8', 'blob.bin'), 'V8-COMPILE-CACHE')
  // ── 快照在途标志（绝对不删） ──
  write(join(root, 'files', '.snapshot-transaction'), '{"phase":"staged"}\n')
  // ── 引擎日志：当前代 + 历史代 ──
  write(join(files, CURRENT_ENGINE_LOG), 'dsh web: http://127.0.0.1:3080/?token=CURRENT\n')
  write(join(files, 'engine.log.1'), 'OLD-GEN-1\n')
  write(join(files, 'engine.log.2'), 'OLD-GEN-2-LONGER\n')
  return { root, home, files }
}

/** 逐字节快照（路径 → 内容），用于「未列入白名单的 fixture 清理后未变」的断言。 */
function snapshotTree(paths) {
  const out = new Map()
  for (const path of paths) out.set(path, readFileSync(path))
  return out
}

const NON_ALLOWLISTED = [
  ['.credentials.yaml'],
  ['settings.yaml'],
  ['.anonymous-user-id'],
  ['sessions', 's1.jsonl'],
  ['storages', 'workspace.json'],
  ['attachments', 'v1', 'files', 'ab', 'x.png'],
  ['profiles', 'web', 'package.json'],
  ['profiles', 'web', 'node_modules', 'dep', 'index.js'],
  ['workspaces', 'w1', 'note.txt'],
  ['models-store.json'],
  ['cache', 'attachments', 'request-images', 'ab', 'hash'],
  ['cache', 'some-new-upstream-cache', 'data.bin'],
  ['cache', 'artifact-access.key'],
]

test('G-9① 白名单反证：硬清单 + 白名单外路径清理后逐字节未变', () => {
  const { home, files } = fixture()
  const env = { DSH_HOME: home, DSH_FILES_DIR: files }
  const plan = planCleanup(env)
  assert.ok(plan.targets.length > 0, '白名单命中路径必须出现在计划里（否则本用例恒真）')

  const before = snapshotTree(NON_ALLOWLISTED.map((seg) => join(home, ...seg)))
  const snapshotBefore = snapshotTree([join(files, CURRENT_ENGINE_LOG), join(files, '.snapshot-transaction')])

  const report = executeCleanup(plan)

  for (const [path, content] of before) {
    assert.ok(existsSync(path), '未列入白名单的路径不得被删除：' + path)
    assert.deepEqual(readFileSync(path), content, '未列入白名单的路径内容必须逐字节未变：' + path)
  }
  for (const [path, content] of snapshotBefore) {
    assert.deepEqual(readFileSync(path), content, '当前 log 代与快照在途标志必须逐字节未变：' + path)
  }
  assert.equal(report.failed, 0, '本 fixture 下不得有失败项')
})

test('G-9② 白名单命中路径可删且保留当前 log 代', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })

  const ids = plan.targets.map((target) => target.id).sort()
  assert.deepEqual(ids, ['engine-log-1', 'engine-log-2', 'home-cache-.node-compile-cache'])
  // 本版 `cache/**` 为空白名单：必须全部显式跳过，绝不出现在 targets 里。
  assert.equal(plan.targets.some((target) => target.kind === 'cache-subdirectory'), false)

  const report = executeCleanup(plan)

  assert.equal(report.removed, 3)
  assert.equal(report.removedBytes, plan.reclaimableBytes, 'G-9③ 统计体积与实际删除量差值必须为 0')
  assert.equal(existsSync(join(home, '.node-compile-cache')), false)
  assert.equal(existsSync(join(files, 'engine.log.1')), false)
  assert.equal(existsSync(join(files, 'engine.log.2')), false)
  // 当前代必须还在（壳侧 EngineAuth.tokenFromLog 的输入）。
  assert.equal(existsSync(join(files, CURRENT_ENGINE_LOG)), true)
  assert.match(readFileSync(join(files, CURRENT_ENGINE_LOG), 'utf8'), /token=CURRENT/)
})

test('G-9：白名单外的 cache 子目录被显式跳过且如实上报（不静默）', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  const reasons = new Map(plan.skipped.map((skip) => [skip.id, skip.reason]))
  assert.equal(reasons.get('cache-attachments'), 'not-allowlisted')
  assert.equal(reasons.get('cache-some-new-upstream-cache'), 'not-allowlisted')
  assert.equal(reasons.get('cache-artifact-access.key'), 'not-allowlisted')
  // cache 根自身绝不出现在 targets（整目录删被禁）。
  assert.equal(plan.targets.some((target) => target.path === join(home, 'cache')), false)
})

test('G-9③ 可回收体积来自现场枚举（不是常量、也不是硬编码路径）', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  const cache = plan.targets.find((target) => target.id === 'home-cache-.node-compile-cache')
  assert.ok(cache)
  assert.equal(cache.bytes, statSync(join(home, '.node-compile-cache', 'v8', 'blob.bin')).size)
  assert.equal(cache.files, 1)
  // 真源是 $DSH_HOME（fixture 随机目录），不是 ~/.dsh。
  assert.equal(plan.dshHome, resolveHarnessHome(undefined, { DSH_HOME: home }))
  assert.equal(plan.logRoot, files)
})

test('G-9④ 中途失败：该项标 failed、其余项照常、当前代与用户资产仍在', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  const audited = []
  const report = executeCleanup(plan, {
    audit: (entry) => { audited.push(entry) },
    // 故障注入：对编译缓存项抛错（等价于文件被占用/权限失败）。
    remove: (path) => {
      if (path === join(home, '.node-compile-cache')) throw new Error('EBUSY: injected')
      rmSync(path, { recursive: true, force: true })
    },
  })
  const failed = report.items.filter((item) => item.status === 'failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 'home-cache-.node-compile-cache')
  assert.match(failed[0].reason, /EBUSY/)
  // 其余项照常完成（不因单项失败中断）。
  assert.equal(report.removed, 2)
  assert.equal(existsSync(join(files, 'engine.log.1')), false)
  assert.equal(existsSync(join(files, 'engine.log.2')), false)
  assert.equal(existsSync(join(home, '.node-compile-cache')), true, '失败项必须原样保留（不强删）')
  // 每项后落审计：审计条数 = 计划项数。
  assert.equal(audited.length, plan.targets.length)
  // 引擎可启动所需的东西都在。
  assert.equal(existsSync(join(files, CURRENT_ENGINE_LOG)), true)
  assert.equal(existsSync(join(home, 'settings.yaml')), true)
  assert.equal(existsSync(join(home, '.credentials.yaml')), true)
})

test('G-9④ 执行可中断：中断后未开始项标 skipped 且未触碰', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  let seen = 0
  const report = executeCleanup(plan, {
    shouldStop: () => { seen += 1; return seen > 1 },
  })
  assert.deepEqual(report.items.map((item) => item.status), ['removed', 'skipped', 'skipped'])
  assert.equal(report.items[1].reason, 'aborted')
  // 中断不留下半删状态：被跳过的项仍完整在场（日志代是文件、编译缓存是目录）。
  const skippedPaths = report.items.filter((item) => item.status === 'skipped').map((item) => item.path)
  for (const path of skippedPaths) {
    assert.ok(existsSync(path), '中断后未开始项必须原样在场：' + path)
  }
  assert.equal(statSync(join(files, 'engine.log.2')).isFile(), true)
  assert.equal(statSync(join(home, '.node-compile-cache')).isDirectory(), true)
  assert.equal(existsSync(join(home, '.node-compile-cache', 'v8', 'blob.bin')), true)
})

test('作用域复核：越界路径一律拒绝（含 cache 根自身与当前 log 代）', () => {
  const { home, files } = fixture()
  assert.equal(insideAllowedScope(join(home, '.node-compile-cache'), home, files), true)
  assert.equal(insideAllowedScope(join(files, 'engine.log.3'), home, files), true)
  assert.equal(insideAllowedScope(join(files, CURRENT_ENGINE_LOG), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'cache'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'cachefoo', 'x'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'sessions', 's1.jsonl'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'settings.yaml'), home, files), false)
  assert.equal(insideAllowedScope(join(files, 'boot-segments.log'), home, files), false)
  assert.equal(insideAllowedScope(join('/etc', 'passwd'), home, files), false)
  // 本版 cache/** 为空白名单 → 任何 cache 子目录都拒绝（含引擎自管的 request-images）。
  assert.equal(insideAllowedScope(join(home, 'cache', 'pip'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'cache', 'dsh-vision-toolkit'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'cache', 'attachments', 'request-images', 'ab', 'hash'), home, files), false)
  assert.equal(insideAllowedScope(join(home, 'cache', 'some-new-upstream-cache', 'data.bin'), home, files), false)
})

test('未识别路径显式跳过并上报，绝不静默：DSH_FILES_DIR 缺失 / cache 目录缺席', () => {
  const { home } = fixture()
  const noFiles = planCleanup({ DSH_HOME: home })
  assert.equal(noFiles.targets.every((target) => target.kind !== 'engine-log-generation'), true)
  assert.ok(noFiles.skipped.some((skip) => skip.reason === 'log-root-unresolved'))

  const absent = planCleanup({ DSH_HOME: join(home, '..', 'does-not-exist'), DSH_FILES_DIR: '/nope/files' })
  assert.equal(absent.targets.length, 0)
  assert.ok(absent.skipped.some((skip) => skip.id === 'cache-root' && skip.reason === 'absent'))

  // 引擎尚未启动（无当前代）时如实上报，但仍清理历史代。
  const { home: h2, files: f2 } = fixture()
  rmSync(join(f2, CURRENT_ENGINE_LOG))
  const plan2 = planCleanup({ DSH_HOME: h2, DSH_FILES_DIR: f2 })
  assert.ok(plan2.skipped.some((skip) => skip.id === 'engine-log-current' && skip.reason === 'current-generation-absent'))
  assert.equal(plan2.targets.some((target) => target.id === 'engine-log-1'), true)
})

test('硬清单口径：preservedNames 同源判定（含 profiles 整体）', () => {
  for (const name of ['sessions', 'storages', 'attachments', 'workspaces', 'undo-snapshots', 'llm-deepseek',
    '.credentials.yaml', 'settings.yaml', '.anonymous-user-id', '.private-layout', 'models-store.json', 'profiles', 'cache']) {
    assert.equal(isPreserved(name), true, name + ' 必须在硬清单里')
  }
  assert.equal(isPreserved('pip'), false)
  assert.equal(isPreserved('engine.log'), false)
  assert.equal(isPreserved('.node-compile-cache'), false, '编译缓存不在硬清单里（可再生产物，§12.2 已区分两种语义）')
})

test('展示标签不泄漏绝对路径（UI 只拿到 $DSH_HOME/$DSH_FILES_DIR 形态）', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  assert.equal(displayLabel(join(home, 'cache', 'pip'), plan), '$DSH_HOME/cache/pip')
  assert.equal(displayLabel(join(files, 'engine.log.1'), plan), '$DSH_FILES_DIR/engine.log.1')
  assert.equal(displayLabel(join(home, '.node-compile-cache'), plan), '$DSH_HOME/.node-compile-cache')
  assert.equal(displayLabel(join(home, 'sessions'), plan), '$DSH_HOME/sessions')
  assert.equal(displayLabel(join('/etc', 'passwd'), plan), '<unknown>')
})

test('本版 allowlist 只含有据可查的项（cache/** 空白名单，不照名字猜着删）', () => {
  const { home, files } = fixture()
  // 造一批「名字像缓存但本仓无据」的目录：一律不得被删，且必须逐项上报。
  const unevidenced = ['pip', 'dsh-vision-toolkit', 'tmp', 'blobs', 'node-gyp', 'some-new-upstream-cache']
  for (const name of unevidenced) {
    mkdirSync(join(home, 'cache', name), { recursive: true })
    writeFileSync(join(home, 'cache', name, 'keep.bin'), 'KEEP-' + name)
  }
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  const before = new Map(unevidenced.map((name) => [join(home, 'cache', name, 'keep.bin'), 'KEEP-' + name]))

  executeCleanup(plan)

  for (const [path, content] of before) {
    assert.equal(readFileSync(path, 'utf8'), content, '无据可查的路径绝不删：' + path)
  }
  const reported = new Map(plan.skipped.map((skip) => [skip.id, skip.reason]))
  for (const name of unevidenced) {
    assert.equal(reported.get('cache-' + name), 'not-allowlisted', name + ' 必须显式上报为未列入白名单')
  }
})

test('engineLogRoot 真源 = $DSH_FILES_DIR（壳侧注入点），空/空白视为不可用', () => {
  assert.equal(engineLogRoot({ DSH_FILES_DIR: '/x/files' }), '/x/files')
  assert.equal(engineLogRoot({ DSH_FILES_DIR: '   ' }), '')
  assert.equal(engineLogRoot({}), '')
})

// ── 改前必红：把硬清单里的一类临时放进白名单 → 反证必须红 ──────────────────────────
// 这不是「再跑一遍同样的断言」，而是对**白名单语义本身**的校验：若 allowlist 判定退化成
// 「凡 DSH_HOME 下的东西都可删」（黑名单制/无判定），下面的对照断言必然失败。
test('反证（改前必红）：把 sessions 放行后同一组断言必须红——证明白名单确实在拦', () => {
  const { home, files } = fixture()
  const plan = planCleanup({ DSH_HOME: home, DSH_FILES_DIR: files })
  // 对照实现：把 sessions 与白名单外的 cache 子目录当作「白名单项」直接构造 target
  // （等价于把硬清单项/未识别路径放进 allowlist，即白名单判定退化成黑名单制/无判定）。
  const corrupted = {
    ...plan,
    targets: [
      ...plan.targets,
      { id: 'cache-sessions', kind: 'cache-subdirectory', path: join(home, 'sessions'), bytes: 1, files: 1 },
      { id: 'cache-request-images', kind: 'cache-subdirectory', path: join(home, 'cache', 'attachments'), bytes: 1, files: 1 },
    ],
  }
  const report = executeCleanup(corrupted)
  const sessionsItem = report.items.find((item) => item.id === 'cache-sessions')
  assert.equal(sessionsItem.status, 'skipped')
  assert.equal(sessionsItem.reason, 'scope-rejected')
  assert.equal(existsSync(join(home, 'sessions', 's1.jsonl')), true)
  // 白名单外的 cache 子目录同样被第二道闸门挡住（引擎自管的 request-images 必须活着）。
  const sharedCache = report.items.find((item) => item.id === 'cache-request-images')
  assert.equal(sharedCache.status, 'skipped')
  assert.equal(sharedCache.reason, 'scope-rejected')
  assert.equal(existsSync(join(home, 'cache', 'attachments', 'request-images', 'ab', 'hash')), true)

  // 反向对照：真白名单项在同样调用下**确实**被删（证明上面的 skipped 不是「因为整个执行没干活」）。
  assert.ok(report.items.some((item) => item.status === 'removed'))
})
