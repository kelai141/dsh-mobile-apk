#!/usr/bin/env node
// check-plugin-tests.mjs — 每个插件自带的 test/*.test.mjs 必须真实跑通（0.14.0 新增）。
//
// 为什么需要这个门禁：虚拟屏插件的 android_vdisplay_create/destroy 曾经**完全不可用**
// （服务方法被摘出服务对象裸调，this 丢失 → controlQueue undefined），而该插件**一个测试都没有**，
// 于是没有任何门禁发现它。这个缺口不是「某个测试漏了」，而是「没有任何机制要求插件有测试」。
//
// 判据（逐插件）：
//   1) 有 test/*.test.mjs → 必须通过，且有效通过数 > 0（全 skip = 假绿，exit 0 不算数）；
//   2) 没有 test 目录 → WARN 不拦（避免把「历史欠账」当阻塞项），但在输出里点名，让缺口可见。
//
// 真实执行插件自己的 test/*.test.mjs，不做静态提取。
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, relative, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN_DIR = join(ROOT, 'plugins')
/** A test runner must not hold CI forever; a hard timeout keeps the failing unit visible. */
const TEST_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 测试运行环境：`NODE_ENV` 必须由门禁自己钉住，**不能继承调用者**。
 *
 * 为什么（2026-10-28 实测，与上面 ANSI 那条同族——都是"环境差异导致假红"）：父进程带着
 * `NODE_ENV=production` 时，`dsh-client-ui-responsive` 的 vitest 会把 `react` 解析成 production 构建，
 * `act(...)` 直接抛 `act(...) is not supported in production builds of React` ⇒ **239 例假红**；
 * 同一份代码在 `NODE_ENV=test` / `development` 下 **939 例全过**。也就是说门禁的结论取决于
 * "谁在什么 shell 里跑的"，本地复现不出 CI 的结果——而门禁的全部价值就是给出与调用环境无关的判定。
 *
 * 钉在唯一入口（`runCommand` 里合并），而不是逐个调用点补：调用点显式传的 `env` 也覆盖不掉它，
 * 于是"某处忘了设"在结构上不可能发生。`--self-test` 直接验证这条语义，不依赖任何插件。
 */
const TEST_NODE_ENV = 'test'

/**
 * 合并子进程环境：**始终**基于 `process.env` 展开。
 * 只写 `{...extra}` 会丢掉 PATH 等变量（调用点只传一个 `NODE_OPTIONS` 时尤其致命），
 * 唯独 `NODE_ENV` 由门禁强制——放在最后，所以调用点覆盖不掉它。
 */
function testEnv(extra) {
  return { ...process.env, ...(extra ?? {}), NODE_ENV: TEST_NODE_ENV }
}

/** Kill the whole process group on POSIX so npm/npx grandchildren cannot hold CI open. */
function runCommand(bin, args, options) {
  const merged = { ...options, env: testEnv(options?.env) }
  if (process.platform !== 'linux') return spawnSync(bin, args, { ...merged, timeout: TEST_TIMEOUT_MS })
  return spawnSync('timeout', ['--kill-after=10s', Math.ceil(TEST_TIMEOUT_MS / 1000) + 's', bin, ...args],
    { ...merged, timeout: TEST_TIMEOUT_MS + 15_000 })
}

/** Convert a Windows drive path for the WSL npm installation when it exists. */
function toWslPath(path) {
  // Resolve Windows junctions before WSL sees their Windows-style targets.
  const full = realpathSync(resolve(path))
  const match = /^([a-z]):[\\/](.*)$/i.exec(full)
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : null
}

function checkResolvedWslPath(actual, expected) {
  if (actual !== expected) throw new Error(`WSL 测试路径不是实际目录: ${actual} != ${expected}`)
}

/** 原生 npm 优先；仅 Windows UI 的 ENOENT/EINVAL 启动错误允许回退 WSL。 */
function runSubrepoNpm(dir, repo, run = runCommand, spawn = spawnSync, platform = process.platform, wslPath = toWslPath) {
  const cwd = realpathSync(dir)
  const npmBin = platform === 'win32' ? 'npm.cmd' : 'npm'
  let result = run(npmBin, ['test'], { cwd, encoding: 'utf8', shell: platform === 'win32' })
  let useWslNpm = false
  if (platform === 'win32' && repo === 'dsh-client-ui-responsive' && ['ENOENT', 'EINVAL'].includes(result.error?.code)) {
    const wslDir = wslPath(cwd)
    const ready = wslDir === null ? null : spawn('wsl.exe', [
      '--cd', wslDir, '--exec', 'bash', '-lc', 'command -v npm >/dev/null && test -e node_modules/.bin/vitest',
    ], { encoding: 'utf8', timeout: TEST_TIMEOUT_MS })
    if (ready?.status === 0 && ready.error === undefined) {
      console.log('NOTE  ' + repo + '：本机 npm 无法启动，尝试 WSL')
      useWslNpm = true
      result = run('wsl.exe', ['--cd', wslDir, '--exec', 'env', 'npm_config_cache=/tmp/dsh-mobile-npm-cache', 'npm', 'test'], { cwd, encoding: 'utf8' })
    }
  }
  return { result, useWslNpm }
}

/**
 * 去掉 ANSI 颜色转义。为什么必须去（本轮实测）：vitest 的输出是
 * `[2m Tests [22m [1m[32m262 passed[39m[22m`，按裸文本匹配 `Tests\s+(\d+) passed` 永远不中，
 * 于是「测试全绿」被判成「未产生有效通过数（全 skip = 假绿）」——**假红**。
 * 这条路径此前没被走过（7 个插件都用 node:test），接上子仓后才暴露。
 * @param text - 子进程输出（stdout + stderr）。
 * @returns 去掉 ESC[...m 序列的文本。
 */
function stripAnsi(text) {
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * 递归枚举插件 `test/` 下的测试文件（**子目录也算**）。
 *
 * 旧实现是 `readdirSync(testDir)` 顶层扫 —— 子目录里的 `*.test.mjs` 不会被跑，
 * 而 `test` 脚本的 `test/*.test.mjs` glob 也是顶层匹配，于是两边**同时**漏，谁也不会报。
 */
const collectTestFiles = (dir) => {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) { out.push(...collectTestFiles(p)); continue }
    if (entry.isFile() && (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.test.ts'))) out.push(p)
  }
  return out.sort()
}

/**
 * 从 `package.json` 的 test 脚本里抽出**测试路径模式集合**。
 *
 * 这是形态判据与覆盖数判据的**唯一解析入口**（#989）。两条判据此前各写一份解析：
 * `scriptFormProblem` 用三条手写正则认形态（只认顶层 glob 那一种写法），
 * `scriptCoverage` 用另一套 `matchAll` 抽模式。同一份脚本于是在两边得到相反结论——
 * 递归 glob 能覆盖全部文件，却被形态判据判成「不可识别的形态」。
 * 「同一个事实两处各解析一遍」必然漂移，只是漂到哪种写法上而已。
 * @param script package.json 的 test 脚本。
 * @returns 形如 `test/*.test.mjs` 或递归 glob 的模式串（去重、保序）。
 */
const testPathTokens = (script) => {
  const text = String(script ?? '').trim()
  if (text === '') return []
  const tokens = text.match(/(?:\.\/)?test\/[^\s"';&|]+/g) ?? []
  return [...new Set(tokens.map((t) => t.replace(/^\.\//, '')))]
}

/**
 * 插件自身 `test` 脚本**能覆盖到**的文件数（元断言的左操作数）。
 *
 * - 显式清单与 glob 均按真实路径匹配；重复文件和不存在的文件不能凑数。
 * - mjs / ts 与嵌套目录按各自模式匹配，覆盖数必须等于递归发现数。
 */
const scriptCoverage = (testDir, script) => {
  const patterns = testPathTokens(script)
  return collectTestFiles(testDir).filter((file) => {
    const name = relative(dirname(testDir), file).replaceAll('\\', '/')
    return patterns.some((pattern) => matchesGlob(name, pattern))
  }).length
}

// issue #1143：插件构建有**跨包依赖顺序**——dsh-android-linux-env 的 package.json 依赖
// `file:../../dsh-shell-termux`（根目录那个包，不在这里的 plugins/ 下），所以它必须先被构建，
// 否则 linux-env 的 tsc 报 TS2307 Cannot find module '@dsh-android/dsh-shell-termux'。
//
// .github/workflows/pr-gate.yml 的「准备插件产物」段正是按 scripts/plugin-dirs.json 的顺序
// 逐个 `npm run build`（termux 在清单首位，注释写明「linux-env 编译依赖它的 lib」）。
// 这里沿用同一份顺序来源，避免两处对构建序各自拍脑袋——顺序错了只会在 linux-env 上炸，
// 而那看起来像「插件构建失败」，真因却在别处的构建序。
const pluginOrder = (() => {
  try {
    const { dirs } = JSON.parse(readFileSync(join(ROOT, 'scripts', 'plugin-dirs.json'), 'utf8'))
    return dirs.filter((d) => d.startsWith('plugins/')).map((d) => d.slice('plugins/'.length))
  } catch { return [] }
})()
const pluginsOnDisk = existsSync(PLUGIN_DIR)
  ? readdirSync(PLUGIN_DIR).filter((n) => existsSync(join(PLUGIN_DIR, n, 'package.json')))
  : []
// 清单里有的按清单位置排前，其余按名字排后（磁盘上新增但还没登记的插件也要跑，不能被静默漏掉）。
const orderIndex = new Map(pluginOrder.map((n, i) => [n, i]))
const plugins = [...pluginsOnDisk].sort((a, b) => {
  const ia = orderIndex.has(a) ? orderIndex.get(a) : Number.MAX_SAFE_INTEGER
  const ib = orderIndex.has(b) ? orderIndex.get(b) : Number.MAX_SAFE_INTEGER
  return ia !== ib ? ia - ib : a.localeCompare(b)
})
if (plugins.length === 0) { console.error('CHECK-PLUGIN-TESTS FAILED：找不到任何插件'); process.exit(1) }

// ── --self-test：验证「子进程 NODE_ENV 被钉住」这条语义本身 ────────────────────────
// 不跑任何插件测试（那会把自检变成分钟级）：只问子进程「你看到的 NODE_ENV 是什么」。
// 三类调用形态各一条，因为踩到的正是「调用点传了 env 就覆盖掉全局设定」这一类：
//   1) 调用点显式指定 NODE_ENV=production —— 必须被门禁改写（否则就是本轮那个 239 例假红）；
//   2) 调用点只传一个无关变量（NODE_OPTIONS）—— NODE_ENV 要钉住，且 PATH 不能被吞掉
//      （吞掉 PATH 的直接后果是子进程根本起不来，那是比假红更糟的假绿：什么都测不了还报通过）；
//   3) 完全不传 env —— 走默认合并路径。
/**
 * issue #957：本地 test 脚本必须是**可识别的 glob 形态**，不允许回退成显式清单。
 *
 * 为什么单独立一条：`scriptCoverage` 对两种形态都算得出数来，于是「有人把 glob 改回显式清单」
 * 只要清单暂时是完整的，元断言照样绿 —— 而它下一轮新增测试文件时就静默少跑。
 * 这类「当下正确、以后必错」的写法必须被形态判据挡在门外，不能靠人数数。
 *
 * @param {string} plugin 插件名（用于错误文案）。
 * @param {string} script `package.json` 的 test 脚本。
 * @returns {string|null} null = 合规；否则返回判红理由。
 */
const scriptFormProblem = (plugin, script) => {
  const trimmed = String(script || '').trim()
  if (trimmed === '') return plugin + ' 有测试文件但没有 test 脚本'
  /* 形态判据与覆盖数判据共用 testPathTokens（#989）：否则同一份脚本在两边得到相反结论——
   * 递归 glob 能覆盖全部文件（scriptCoverage 认），却被手写正则判成「不可识别的形态」。
   * 判据只认一种写法时，换一种等价写法就零命中。 */
  const tokens = testPathTokens(trimmed)
  if (tokens.length === 0) return plugin + ' 的 test 脚本里没有 test/ 路径（脚本：' + trimmed + '）'
  const GLOB_META = /[*?[\]{}]/
  // 显式清单：某个 token 既无 glob 元字符、又带扩展名 ⇒ 就是一个具体文件名。
  const explicit = tokens.filter((t) => !GLOB_META.test(t) && /\.[a-z]+$/i.test(t))
  if (explicit.length > 0) {
    return plugin + ' 的 test 脚本是**显式清单**，必须是 glob：node --test test/*.test.mjs（清单项：'
      + explicit.join(', ') + '；脚本：' + trimmed + '）'
  }
  /* 合规 glob：token 里带 glob 元字符即可。
   * 曾经这里还要求「后缀是测试文件扩展名」，但 `test/**` 这种按目录递归的写法完全合法
   * （scriptCoverage 认它覆盖全部文件），额外后缀要求只会把它误判成「不可识别的形态」——
   * 那正是 #989 的同一个病：判据比真实解析多了一条自己的想象。
   * 现在唯一的要求是「有元字符」；「别写显式清单」由上面的 explicit 分支守。 */
  if (!tokens.some((t) => GLOB_META.test(t))) {
    return plugin + ' 的 test 脚本不是可识别的 glob 形态（脚本：' + trimmed + '）'
  }
  return null
}

if (process.argv.includes('--self-test') || process.argv.includes('--self-test-negative')) {
  const probe = (extraEnv) => {
    const r = runCommand(process.execPath,
      ['-e', 'process.stdout.write(String(process.env.NODE_ENV))'],
      { cwd: ROOT, encoding: 'utf8', env: extraEnv })
    return { got: (r.stdout ?? '').trim(), status: r.status, err: r.error?.code ?? null }
  }
  const checks = [
    ['调用点指定 NODE_ENV=production', probe({ NODE_ENV: 'production' })],
    ['调用点只传 NODE_OPTIONS', probe({ NODE_OPTIONS: '--no-deprecation' })],
    ['调用点完全不传 env', probe(undefined)],
  ]
  let bad = 0
  for (const [label, r] of checks) {
    if (r.status !== 0) {
      bad += 1
      console.error('FAIL  [self-test] ' + label + '：子进程起不来（status=' + String(r.status) + ', error=' + String(r.err) + '）——PATH 等基础变量被吞掉了')
      continue
    }
    if (r.got !== TEST_NODE_ENV) {
      bad += 1
      console.error('FAIL  [self-test] ' + label + '：子进程看到 NODE_ENV=' + JSON.stringify(r.got) + '，应为 ' + JSON.stringify(TEST_NODE_ENV))
      continue
    }
    console.log('PASS  [self-test] ' + label + ' → NODE_ENV=' + TEST_NODE_ENV)
  }
  let assertions = checks.length
  const verify = (label, fn) => {
    assertions += 1
    try { fn(); console.log('PASS  [self-test] ' + label) }
    catch (error) { bad += 1; console.error('FAIL  [self-test] ' + label + '：' + error.message) }
  }
  const fixture = mkdtempSync(join(tmpdir(), 'plugin-gate-self-'))
  try {
    const actual = join(fixture, 'actual package')
    const link = join(fixture, 'junction package')
    const testDir = join(actual, 'test')
    mkdirSync(join(testDir, 'nested'), { recursive: true })
    writeFileSync(join(testDir, 'a.test.mjs'), '')
    writeFileSync(join(testDir, 'b.test.ts'), '')
    writeFileSync(join(testDir, 'nested', 'c.test.mjs'), '')
    symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    verify('真实联接路径解析（含空格）', () => {
      assert.equal(realpathSync(link), realpathSync(actual))
      if (process.platform === 'win32') {
        assert.match(toWslPath(link), /^\/mnt\/[a-z]\//)
        checkResolvedWslPath(toWslPath(link), toWslPath(actual))
        assert.ok(!toWslPath(link).includes('junction package'))
      }
    })
    verify('#957 递归发现 mjs/ts 与嵌套测试', () => assert.equal(collectTestFiles(testDir).length, 3))
    /* ── #989：形态判据与覆盖数判据必须共用同一个解析器（testPathTokens）──────────
     * 原来形态判据用三条手写正则，只认顶层 glob 那一种写法，把递归 glob 判成「不可识别的
     * 形态」；而同一文件里的 scriptCoverage 用另一套 matchAll 抽模式，把它正确当成覆盖全部。
     * 两条判据对同一份脚本给出相反结论。下面每条都同时钉「形态判据」与「覆盖数」，两边必须一致。 */
    const formCases = [
      { script: 'node --test test/*.test.mjs', form: null, cover: 1, label: '顶层 glob：合规' },
      { script: 'node --test "test/**/*.test.{mjs,ts}"', form: null, cover: 3, label: '递归 glob（带引号 + 花括号）：合规' },
      // 无花括号的递归 glob 只匹配 .mjs ⇒ 覆盖 a.test.mjs 与 nested/c.test.mjs 两个（b.test.ts 不在内）。
      { script: 'node --test test/**/*.test.mjs', form: null, cover: 2, label: '递归 glob（无引号）：合规' },
      { script: 'node --test test/a.test.mjs test/b.test.ts test/nested/c.test.mjs', form: 'explicit', cover: 3, label: '显式清单：判红（形态）' },
      { script: 'vitest run', form: 'noglob', cover: 0, label: '无 test/ 路径：判红（形态）' },
      { script: '', form: 'noscript', cover: 0, label: '空脚本：判红（形态）' },
    ]
    for (const c of formCases) {
      verify('#989 形态与覆盖一致：' + c.label, () => {
        const problem = scriptFormProblem('demo', c.script)
        const classified = problem === null ? null
          : problem.includes('显式清单') ? 'explicit'
            : problem.includes('没有 test/ 路径') ? 'noglob'
              : problem.includes('没有 test 脚本') ? 'noscript' : 'other'
        assert.equal(classified, c.form, '形态判据给出 ' + JSON.stringify(classified) + '（问题：' + problem + '）')
        assert.equal(scriptCoverage(testDir, c.script), c.cover, '覆盖数不一致（' + c.script + '）')
      })
    }
    /* #989 的核心不变量：形态判据**不得**拒绝一个覆盖数判据认得的写法。
     * 具体地——形态判据判合规的脚本，其 token 必须就是 scriptCoverage 拿去 matchesGlob 的
     * 那一组（这正是「两条判据共用同一个解析器」的可执行形态）。
     * 注意不能把它写成「覆盖数 == 递归发现数」：顶层 glob 在含嵌套测试的树上**本来就**只覆盖
     * 顶层那几个，那是 #957 的正确语义，不是漂移。 */
    verify('#989 不变量：形态判红「不是可识别的 glob」⇒ 覆盖数必须为 0（否则就是两条判据打架）', () => {
      const forms = [
        'node --test test/*.test.mjs',
        'node --test "test/**/*.test.{mjs,ts}"',
        'node --test test/**/*.test.mjs',
        'node --test test/**',
        'vitest run',
        'node --test test/a.test.mjs',
      ]
      for (const script of forms) {
        const problem = scriptFormProblem('demo', script)
        const unrecognized = problem !== null && problem.includes('不是可识别的 glob 形态')
        if (unrecognized) {
          // 这正是 #989 的原始形态：形态判据说「认不出」，覆盖数却说「覆盖了 N 个」。
          assert.equal(scriptCoverage(testDir, script), 0,
            script + ' 被判「不可识别的形态」，覆盖数却是 ' + scriptCoverage(testDir, script) + '——两条判据在同一份脚本上打架')
        }
      }
      // 递归 glob 必须判合规（这是 #989 的修复本体），
      // 显式清单与无 test/ 路径必须仍然判红（#957 的规矩不能因 #989 松动）。
      assert.equal(scriptFormProblem('demo', 'node --test test/**/*.test.mjs'), null, '递归 glob 应判合规')
      assert.equal(scriptFormProblem('demo', 'node --test "test/**/*.test.{mjs,ts}"'), null, '带引号递归 glob 应判合规')
      assert.notEqual(scriptFormProblem('demo', 'node --test test/a.test.mjs'), null, '显式清单应判红')
      assert.notEqual(scriptFormProblem('demo', 'vitest run'), null, '无 test/ 路径应判红')
    })
    verify('#957 顶层 mjs glob 不得假装覆盖 ts/嵌套测试', () => assert.equal(scriptCoverage(testDir, 'node --test test/*.test.mjs'), 1))
    verify('#957 递归 glob 覆盖全部文件', () => assert.equal(scriptCoverage(testDir, 'node --test "test/**/*.test.{mjs,ts}"'), 3))
    verify('#957 显式嵌套清单覆盖全部文件', () => assert.equal(scriptCoverage(testDir, 'node --test test/a.test.mjs test/b.test.ts test/nested/c.test.mjs'), 3))
    verify('#957 重复/不存在的清单不能凑够覆盖数', () => assert.equal(scriptCoverage(testDir, 'node --test test/a.test.mjs test/a.test.mjs test/absent.test.ts'), 1))
    const okResult = { status: 0, stdout: '', stderr: '' }
    for (const scenario of [
      { label: '原生成功', native: okResult, fallback: false },
      { label: '真实测试失败不回退', native: { status: 1 }, fallback: false },
      { label: '无状态且无启动错误不回退', native: { status: null }, fallback: false },
      { label: 'ENOENT 可回退', native: { status: null, error: { code: 'ENOENT' } }, fallback: true },
      { label: 'EINVAL 可回退', native: { status: null, error: { code: 'EINVAL' } }, fallback: true },
      { label: 'ETIMEDOUT 不回退', native: { status: null, error: { code: 'ETIMEDOUT' } }, fallback: false },
      { label: 'EACCES 不回退', native: { status: null, error: { code: 'EACCES' } }, fallback: false },
      { label: 'WSL 不可用保留原生错误', native: { status: null, error: { code: 'ENOENT' } }, ready: 1, fallback: false },
    ]) {
      verify('runner ' + scenario.label, () => {
        const calls = []
        const run = (bin, args, options) => {
          calls.push({ bin, args, options })
          return calls.length === 1 ? scenario.native : okResult
        }
        const spawn = () => { calls.push({ bin: 'WSL probe' }); return { status: scenario.ready ?? 0 } }
        const result = runSubrepoNpm(link, 'dsh-client-ui-responsive', run, spawn, 'win32', () => '/mnt/c/actual package')
        assert.equal(calls[0].bin, 'npm.cmd')
        assert.equal(calls[0].options.cwd, realpathSync(actual))
        assert.equal(calls[0].options.shell, true)
        assert.equal(result.useWslNpm, scenario.fallback)
        const probed = ['ENOENT', 'EINVAL'].includes(scenario.native.error?.code)
        assert.equal(calls.length, scenario.fallback ? 3 : probed ? 2 : 1)
        assert.equal(result.result, scenario.fallback ? okResult : scenario.native)
      })
    }
    verify('路径受控负控（错误联接路径必须判红）', () => {
      checkResolvedWslPath('/mnt/c/actual/package', process.argv.includes('--self-test-negative')
        ? '/mnt/c/junction/package' : '/mnt/c/actual/package')
    })
    // 只枚举当前插件的文件与 npm 脚本，不执行任何真实插件测试。
    for (const plugin of plugins.sort()) {
      const dir = join(PLUGIN_DIR, plugin, 'test')
      if (!existsSync(dir)) continue
      verify('#957 当前插件覆盖 ' + plugin, () => {
        const script = JSON.parse(readFileSync(join(PLUGIN_DIR, plugin, 'package.json'), 'utf8')).scripts?.test ?? ''
        const found = collectTestFiles(dir).length
        assert.equal(scriptCoverage(dir, script), found)
        console.log('INFO  ' + plugin + '：npm 覆盖 = 递归发现 = ' + found + ' 个文件（未执行）')
      })
    }
  } finally {
    // fixture 是本次 mkdtempSync 创建的独立临时目录；删除联接本身，不改实际仓库。
    rmSync(fixture, { recursive: true, force: true })
  }
  if (bad > 0) { console.error('CHECK-PLUGIN-TESTS SELF-TEST FAILED（' + bad + '/' + assertions + ' 项）'); process.exit(1) }
  console.log('CHECK-PLUGIN-TESTS SELF-TEST PASSED（' + assertions + ' 项）')
  process.exit(0)
}

let ran = 0
let failed = 0
const noTests = []

// issue #1143：先构建**根级**的 dsh-shell-termux —— plugins/dsh-android-linux-env 依赖
// `file:../../dsh-shell-termux`，不先建它的 lib 就跑 linux-env 的 tsc 会报 TS2307。
// CI 的准备段把它排在 plugin-dirs.json 首位正是这个原因；不在此处重复，linux-env 必红。
{
  const termuxDir = join(ROOT, 'dsh-shell-termux')
  const termuxPkg = join(termuxDir, 'package.json')
  // 与下面各插件同一口径：**总是构建**（不因「lib 已在场」而跳过 —— 那份产物可能来自旧源码，
  // 跳过等于让测试断言一份陈旧产物。构建脚本只跑本地 tsc/node，不联网）。
  if (existsSync(termuxPkg)) {
    const buildScript = (() => {
      try { return JSON.parse(readFileSync(termuxPkg, 'utf8')).scripts?.build ?? null } catch { return null }
    })()
    if (buildScript) {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      console.log('BUILD dsh-shell-termux（' + buildScript + '，linux-env 的编译前置）')
      const rb = runCommand(npmBin, ['run', 'build', '--silent'], {
        cwd: termuxDir, encoding: 'utf8', shell: process.platform === 'win32',
      })
      const outB = stripAnsi((rb.stdout ?? '') + (rb.stderr ?? ''))
      if (rb.status !== 0) {
        failed += 1
        console.error('FAIL  dsh-shell-termux 构建失败（它是 plugins/dsh-android-linux-env 的编译前置）')
        console.error(outB.split('\n').slice(-25).join('\n'))
      }
    }
  }
}

const pluginTestScript = (plugin) => {
  try { return JSON.parse(readFileSync(join(PLUGIN_DIR, plugin, 'package.json'), 'utf8')).scripts?.test ?? '' }
  catch { return '' }
}
for (const plugin of plugins.sort()) {
  const testDir = join(PLUGIN_DIR, plugin, 'test')
  if (!existsSync(testDir)) { noTests.push(plugin); continue }
  const files = collectTestFiles(testDir)
  // issue #957：本地 `npm test` 与门禁必须用**同一份发现逻辑**，否则本地会漏跑而没人知道。
  // 元断言：脚本覆盖数 == 递归发现数。改 glob 成单个文件名、或把测试挪进子目录，都会在这里判红。
  // issue #957：先判**形态**（glob），再判覆盖数 —— 形态错要单独报，否则只会看到一个数字对不上。
  const formProblem = scriptFormProblem(plugin, pluginTestScript(plugin))
  if (formProblem !== null) {
    console.error('FAIL  ' + formProblem)
    failed += 1
  }
  const covered = scriptCoverage(testDir, pluginTestScript(plugin))
  if (covered !== files.length) {
    console.error('FAIL  ' + plugin + ' 的本地 npm test 覆盖 ' + covered + ' 个测试文件，门禁递归发现 '
      + files.length + ' 个 —— 本地会漏跑或两处发现逻辑不一致')
    failed += 1
  }
  if (files.length === 0) { noTests.push(plugin); continue }
  // issue #1143：**跑测试前先构建**（本 runner 直接 spawn node --test / vitest，不经过插件的 npm test）。
  //
  // 真因：各插件 package.json 里 `test: "npm run build && node --test ..."` 自带构建前置，
  // 但本 runner 直连测试运行器，绕过了它。7 个插件的 test 脚本都带 build，唯独
  // dsh-session-delete 没有 —— 于是 test/client-wiring.test.mjs 第 9 行
  // `readFileSync(new URL('../lib/client.js', ...))` 在净检出上 ENOENT（lib/ 是构建产物，未入仓）。
  // CI 上表现为「单测未产生有效通过数（全 skip = 假绿）」：测试在 import 期就抛，node --test 记 0 pass，
  // 正好撞上 #957 那条假绿判据。
  //
  // 修法取向：**在 runner 里补构建**，而不是要求每个测试改写成兼容 src/。
  // 理由：lib/ 才是插件的交付产物，测试断言的是产物行为；让测试读 src 等于把判据挪离交付面，
  // 且每加一个读产物的测试就要再改一次。一次构建、后续测试直接跑，成本也更低。
  //
  // 只对**声明了 build 脚本**的插件构建：build 缺失 = 该插件没有产物面，不能替它跑一个不存在的脚本。
  //
  // 注意：**不放宽下方「全 skip = 假绿」（passN2 <= 0）那条判据**。构建失败必须在这里显式判红并
  // 带出构建日志——绝不能靠 pass 数为 0 去兜，那样真因会被埋进一句「全 skip」里。
  const buildScript = (() => {
    try { return JSON.parse(readFileSync(join(PLUGIN_DIR, plugin, 'package.json'), 'utf8')).scripts?.build ?? null } catch { return null }
  })()
  if (buildScript) {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    console.log('BUILD ' + plugin + '（' + buildScript + '）')
    // Windows 上 spawnSync 直连 npm.cmd 会 EINVAL（与 L73 runSubrepoNpm 同一个坑，本仓既有写法是
    // 在 win32 显式开 shell）——这里照同一口径，否则构建永远 EINVAL，被判成「插件构建失败」。
    const rb = runCommand(npmBin, ['run', 'build', '--silent'], {
      cwd: join(PLUGIN_DIR, plugin), encoding: 'utf8', shell: process.platform === 'win32',
    })
    const outB = stripAnsi((rb.stdout ?? '') + (rb.stderr ?? ''))
    if (rb.status !== 0) {
      failed += 1
      console.error('FAIL  ' + plugin + ' 构建失败（门禁跑测试前必须先把 lib/ 产物建出来；测试读的是交付产物，不是 src）'
        + (rb.error?.code === 'ETIMEDOUT' ? ' timeout=' + TEST_TIMEOUT_MS + 'ms' : ''))
      console.error(outB.split('\n').slice(-25).join('\n'))
      continue
    }
  }
  ran += 1
  // 运行器按文件内容自动判定：本仓 6 个插件用 node:test，client/UI 侧用 vitest。
  // 写死任一个都会把另一种判成失败（首次跑本门禁即实测到该误报）。
  // 扫**全文件**而非固定行窗口：注释头长度不定，只看前 N 行会把 import 挡在窗口外
  // （首次跑本门禁实测到：vdisplay 的 16 行注释把 node:test import 挤到第 17 行，检测漏判）。
  // 同时看所有测试文件：一个插件可能混用（任一文件用 node:test 即按 node:test 跑）。
  const usesNodeTest = files.some((f) => /from 'node:test'/.test(readFileSync(f, 'utf8')))
  const args = usesNodeTest
    ? ['--test', '--test-force-exit', '--test-reporter=spec', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
    : ['vitest', 'run', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  // 不用 shell:true——execPath 在 Windows 上含空格（'C:\Program Files\...'），shell 会把它拆断
  // （首次跑本门禁实测到该误报）。直接以 argv 形式 spawn，由内核处理路径。
  // vitest 的 --root 固定到插件目录，避免从上层配置解析导致 'No test suite found'。
  const spawnArgs = usesNodeTest
    ? args
    : ['vitest', 'run', '--root', join(PLUGIN_DIR, plugin), ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  const bin = usesNodeTest ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx')
  console.log('RUN   ' + plugin + '（' + (usesNodeTest ? 'node:test' : 'vitest') + '）')
  const r2 = runCommand(bin, spawnArgs, { cwd: join(PLUGIN_DIR, plugin), encoding: 'utf8' })
  const out2 = (r2.stdout ?? '') + (r2.stderr ?? '')
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'。两者都接受，任一为 0 判红。
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'；Node 20 TAP 报 '# pass N'。
  const plain2 = stripAnsi(out2)
  const passN2 = Number((/^ℹ pass (\d+)/m.exec(plain2) ?? /Tests\s+(\d+) passed/m.exec(plain2) ?? /# pass (\d+)/m.exec(plain2))?.[1] ?? '0')
  // 失败数：必须锚定字段本身，不能用裸 /(\d+) failed/ —— 它会命中 'cancelled 0' 之类无关行的
  // 相邻数字，或把 'ℹ fail 0' 里的 0 与别处的数字混起来（首次跑本门禁实测到该误判）。
  const failN2 = Number(/^ℹ fail (\d+)/m.exec(plain2)?.[1] ?? /^\s*(\d+) failed/m.exec(plain2)?.[1] ?? '0')
  if (r2.status !== 0 || failN2 !== 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未通过（runner=' + (usesNodeTest ? 'node:test' : 'vitest') + (r2.error?.code === 'ETIMEDOUT' ? ', timeout=' + TEST_TIMEOUT_MS + 'ms' : '') + '）')
    console.error(out2.split('\n').slice(-25).join('\n'))
  } else if (passN2 <= 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未产生有效通过数（全 skip = 假绿）')
  } else {
    console.log('PASS  ' + plugin + '（' + files.length + ' 个文件 / ' + passN2 + ' 项通过，' + (usesNodeTest ? 'node:test' : 'vitest') + '）')
  }
}
if (noTests.length > 0) {
  console.log('WARN  以下插件没有 test/*.test.mjs（缺口可见，不阻塞）：' + noTests.join(', '))
}

// ── 注入层与子仓（0.14.1 批 3 补）：测试在场，但**此前没人按开关** ────────────────
//
// 真因（2026-09-23 设备实测）：`dsh-host-web-compat/lib/index.js` 是**每次页面加载最先求值的代码**，
// 它的注入脚本以模板串拼装；模板串内的注释里出现一个反引号就会把模板提前截断，症状是
// **引擎启动即失败**（`SyntaxError: Unexpected identifier`），用户看到「引擎启动失败」。
// 该仓自带 `npm test`（把模板切片 eval 出来逐一断言）**能判红这件事**——实测注入一个反引号即
// `ℹ fail 1 / ReferenceError: api is not defined`；但本门禁此前只扫 `plugins/*`，
// 于是「探测器在场、没人按开关」。下面两段把开关接上。
let skipped = 0

// ① 免依赖的**解析门**（始终可跑，不参与 SKIP）：`node --check` 尊重 package.json 的 `type=module`，
//    且不需要 node_modules，所以这一条没有「环境缺依赖就跳过」的借口。
const SYNTAX_CHECKED = ['dsh-host-web-compat/lib/index.js']
/** SKIP 计数器 + 行格式：check-gate-skips.mjs 要求每个 SKIP 行自带 `(#n)` 计数（或显式 SKIP=）。 */
const skipLine = (msg) => { skipped += 1; console.log('SKIP(#' + skipped + ') ' + msg) }
for (const rel of SYNTAX_CHECKED) {
  if (!existsSync(join(ROOT, rel))) {
    skipLine('解析门（文件不在场）：' + rel)
    continue
  }
  ran += 1
  const r4 = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' })
  const out4 = (r4.stdout ?? '') + (r4.stderr ?? '')
  if (r4.status !== 0) {
    failed += 1
    console.error('FAIL  ' + rel + ' 语法不合法（页面注入会整块失效、引擎可能起不来）')
    console.error(out4.split('\n').slice(0, 12).join('\n'))
  } else {
    console.log('PASS  解析门：' + rel)
  }
}

// ② 子仓自带测试（更细的行为断言）。两条路径：
//    - 依赖装好（node_modules 在场）→ 跑它自己声明的 `npm test`（完整契约，含 smoke 脚本）；
//    - 依赖缺失 → 退到 `node --test` 跑它自带的 *.test.mjs（这些用例只依赖 node 内置模块，
//      例如注入层的套件用 `new Function` 解析模板片段，不需要 cordis）。
//    两条都不可用时才 SKIP 计数（不判绿）。
const fsmod = await import('node:fs')
const SUBREPO_TESTS = ['dsh-host-web-compat', 'dsh-client-ui-responsive']
for (const repo of SUBREPO_TESTS) {
  const dir = join(ROOT, repo)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    skipLine(repo + ' 的子仓测试（子仓不在场）')
    continue
  }
  const pkg = JSON.parse(fsmod.readFileSync(pkgPath, 'utf8'))
  const hasDeps = existsSync(join(dir, 'node_modules'))
  const bare = []
  for (const sub of ['test', 'scripts']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of fsmod.readdirSync(d)) if (f.endsWith('.test.mjs')) bare.push(join(sub, f))
  }
  if (!hasDeps && bare.length === 0) {
    skipLine(repo + ' 的子仓测试（无依赖且无自带 *.test.mjs）')
    continue
  }
  if (!hasDeps && typeof pkg.scripts?.test !== 'string') {
    skipLine(repo + ' 的子仓测试（无依赖且未声明 test 脚本）')
    continue
  }
  ran += 1
  const useNpm = hasDeps && typeof pkg.scripts?.test === 'string'
  const npmRun = useNpm ? runSubrepoNpm(dir, repo) : null
  const useWslNpm = npmRun?.useWslNpm ?? false
  const r3 = useNpm
    ? npmRun.result
    : runCommand(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', ...bare], { cwd: realpathSync(dir), encoding: 'utf8' })
  if (r3.error !== undefined && r3.error !== null) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试无法启动：' + String(r3.error.message) + (r3.error.code === 'ETIMEDOUT' ? '（timeout=' + TEST_TIMEOUT_MS + 'ms）' : ''))
    continue
  }
  const out3 = (r3.stdout ?? '') + (r3.stderr ?? '')
  // 通过数：node:test 报 'ℹ pass N' / '# pass N'；vitest 报 'Tests N passed'。
  // 必须先剥 ANSI：vitest 的输出里 'Tests' 与数字之间夹着颜色转义，裸文本匹配永远不中（假红）。
  const plain3 = stripAnsi(out3)
  const passN3 = Number((/^ℹ pass (\d+)/m.exec(plain3) ?? /Tests\s+(\d+) passed/m.exec(plain3) ?? /^# pass (\d+)/m.exec(plain3))?.[1] ?? '0')
  const failN3 = Number(/^ℹ fail (\d+)/m.exec(plain3)?.[1] ?? /^\s*(\d+) failed/m.exec(plain3)?.[1] ?? '0')
  const how = useWslNpm ? 'WSL npm test' : useNpm ? 'npm test' : 'node --test（无依赖路径）'
  if (r3.status !== 0 || failN3 !== 0) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试未通过（' + how + '）')
    console.error(out3.split('\n').slice(-25).join('\n'))
  } else if (passN3 <= 0) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试未产生有效通过数（全 skip = 假绿）')
  } else {
    console.log('PASS  ' + repo + '（' + how + ' / ' + passN3 + ' 项通过）')
  }
}

if (failed > 0) {
  console.error('CHECK-PLUGIN-TESTS FAILED（' + failed + ' 个单测单元有问题；已跑 ' + ran + ' 个；SKIP=' + skipped + '）')
  process.exit(1)
}
// SKIP= 必须出现在收口行：聚合链的 check-gate-skips.mjs 按它核对「跳过项被如实计数」，
// 只写中文「N 项 SKIP」会被判成「有 SKIP 行但汇总缺席」。
console.log('CHECK-PLUGIN-TESTS PASSED（已跑 ' + ran + ' 个单测单元；SKIP=' + skipped
  + (noTests.length > 0 ? '；' + noTests.length + ' 个插件暂无测试' : '') + '）')