// ptc-argv-L1.test.mjs — PTC 子进程堆参数移出 argv + 可执行文件守卫的静态回归（缺陷 C 的更深一层）。
//
// 现象：模型在 PTC 里连最简代码块都失败，报
//   code run failed (worker-exit): Node process exited before completing (1):
//   error: expected absolute path: "--max-old-space-size=512"
// 真因：产物 index.js:947 `...packaged ? [] : [heapFlag],` ⇒ packaged===false 时 heapFlag 落在 argv[1]；
// 而 executable 若被解析成安卓系统链接器（direct exec 被拒时壳侧改走 /system/bin/linker64，
// process.execPath 随之被污染），linker64 把第一个非选项参数当程序路径，heapFlag 排在它前面
// ⇒ linker64 自己报 expected absolute path 并退出，Node 从未被加载。
//
// 修法：① heapFlag 永不进 argv，改由 env.NODE_OPTIONS 无条件下发；
//       ② executable 必须是绝对路径且不是系统动态链接器（fails loud，不静默回退、不猜替代路径）。
//
// 本测试对**工厂夹具**（构建期同一批 tgz 写出，与快照引擎树逐字节同源）断言，实测四条反证均判红。
// 用法：node scripts/patches/tests/ptc-argv-L1.test.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const MARKER = 'dsh-mobile ptc argv heap via NODE_OPTIONS (L1)'
const FIXTURE = versionedFixture('dsh-ptc-runtime-node', 'lib', 'index.js')
const APPLY = readFileSync(join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), 'utf8')
const REGISTRY = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'patches', 'registry.json'), 'utf8'))
// 目标相对路径取自 registry（补丁产物面唯一真源），不在此另写一份。
const REL = REGISTRY.patches.find((patch) => patch.id === 'ptc-argv-L1').target
const RAW = readFileSync(FIXTURE, 'utf8')

// 断言用施加后的结果：**直接跑生产 CLI**（apply-patches.mjs --apply --only ptc-argv-L1），
// 不在测试里复刻替换逻辑。
//
// 为什么改成这个形态（0.2.2-rc.3）：旧实现在本文件里复刻了一份 OLD/NEW 锚点与替换串，那份副本
// 就是缺陷来源——rc.3 把 packaged 分支的 NODE_OPTIONS 改成 `${heapFlag} --experimental-vm-modules`，
// 且 bootstrapArgs 少了一个实参，副本立刻「锚点未命中」，于是测试红而补丁是对的。
// 跑生产 CLI 之后，断言的对象是**生产施加产物**，实现换代时这里不必跟着抄一遍。
function applyPatch(text) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-l1-'))
  const file = join(root, REL)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  try {
    const applied = spawnSync(process.execPath,
      [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), root, '--apply', '--scope', 'engine', '--only', 'ptc-argv-L1'],
      { encoding: 'utf8' })
    if (applied.status !== 0) {
      throw new Error('生产 CLI 施加失败：' + (applied.stdout || '') + (applied.stderr || ''))
    }
    return readFileSync(file, 'utf8')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// ── (a) 旧形态必须真实存在于夹具里（证明锚点不是空转）───────────────────────
check('夹具里存在旧形态 argv 项 `...packaged ? [] : [heapFlag],`',
  RAW.includes('...packaged ? [] : [heapFlag],'))
check('夹具里 heapFlag 由 maxOldGenerationSizeMb 构造（heapFlag 定义在场）',
  RAW.includes('const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`;'))
check('夹具里 executable 由 resolveExecutable 解析（守卫有用武之地）',
  RAW.includes('resolveExecutable(this.config.launch.executable, void 0, this.controller.signal)'))

const OUT = applyPatch(RAW)

// ── (b) marker 在场 ────────────────────────────────────────────────────────
check('施加后 marker 在场', OUT.includes(MARKER))

// ── (c) argv 内不再含 heapFlag ─────────────────────────────────────────────
const argvBlock = OUT.slice(OUT.indexOf('const argv = ['), OUT.indexOf('const argv = [') + 260)
check('施加后 argv 构造块不再含 heapFlag', !argvBlock.includes('heapFlag'), argvBlock.replace(/\t/g, '\\t').slice(0, 160))
check('施加后旧 argv 项已消失', !OUT.includes('...packaged ? [] : [heapFlag],'))

// ── (d) env.NODE_OPTIONS = heapFlag 无条件在场 ─────────────────────────────
const envAt = OUT.indexOf('env.NODE_OPTIONS = heapFlag;')
check('施加后 env.NODE_OPTIONS = heapFlag 在场', envAt >= 0)
// 无条件：紧随其后的第一个 if (packaged) 只应包含 DSH_PTC_RUNTIME_NODE。
const afterEnv = OUT.slice(envAt, envAt + 200)
check('NODE_OPTIONS 赋值在 if (packaged) 之前（无条件）',
  afterEnv.indexOf('env.NODE_OPTIONS = heapFlag;') < afterEnv.indexOf('if (packaged) {'))
check('DSH_PTC_RUNTIME_NODE 仍只在 packaged 分支内',
  /if \(packaged\) \{\s*\n\s*env\.DSH_PTC_RUNTIME_NODE = "1";/.test(OUT))

// ── (e) 两条守卫在场 ───────────────────────────────────────────────────────
check('绝对值守卫在场（isAbsolute + not an absolute path）',
  OUT.includes('!isAbsolute(executable)') && OUT.includes('not an absolute path'))
check('系统链接器守卫在场（linker/ld.so 正则 + 点名错误）',
  OUT.includes('system dynamic linker') && OUT.includes('linker(?:64)?') && OUT.includes('ld\\.so'))
check('守卫用 ptc-runtime-node: 前缀（措辞与既有 isAbsolute 校验一致）',
  (OUT.match(/ptc-runtime-node: resolved node executable/g) || []).length === 2)
check('守卫是 fails loud（抛错），不是静默回退',
  OUT.includes("throw new Error('ptc-runtime-node: resolved node executable is not an absolute path")
  && OUT.includes("throw new Error('ptc-runtime-node: resolved node executable is the system dynamic linker"))

// ── (f) 补丁面自洽：registry 条目 + apply-patches 锚点/复查 ─────────────────
const reg = REGISTRY.patches.find((p) => p.id === 'ptc-argv-L1')
check('registry 登记 ptc-argv-L1（scope=engine）', !!reg && reg.scope === 'engine', JSON.stringify(reg && reg.id))
check('registry marker 与 IMPL 一致', !!reg && reg.marker === MARKER)
check('registry target 指向 ptc-runtime-node/lib/index.js',
  !!reg && reg.target === 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js')
check('apply-patches 里 IMPL 的 OLD 锚点含旧 argv 项', APPLY.includes('...packaged ? [] : [heapFlag],'))
check('apply-patches 锚点未命中时抛可执行指引',
  APPLY.includes('ptc-argv 锚点未命中') && APPLY.includes('引擎升级后请人工核对'))
check('apply-patches 写回后自查 marker', APPLY.includes("if (!s.includes('" + MARKER + "')) throw new Error('ptc-argv 复核失败"))

// ── (g) 负控：锚点真缺时生产 CLI 必须判红，且不写回 ──────────────────────
// 把 argv 项改坏一个字节：既不是「已施加」（marker 不在），锚点也不命中。
// 若这里静默通过，上面所有 PASS 都可能是「零改动」的假绿。
const DAMAGED = RAW.replace('...packaged ? [] : [heapFlag],', '...packaged ? [] : [heapFlag,],')
check('负控前提：改坏后锚点确实不再命中', DAMAGED !== RAW && !DAMAGED.includes('...packaged ? [] : [heapFlag],'))
let damagedThrew = false
try { applyPatch(DAMAGED) } catch { damagedThrew = true }
check('负控：锚点缺失时生产 CLI 判红（不是静默零改动）', damagedThrew)

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
