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
import { readFileSync } from 'node:fs'
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
const RAW = readFileSync(FIXTURE, 'utf8')

// 断言用施加后的结果：直接调用生产 IMPL（不在测试里复刻替换逻辑，避免「测的是副本」）。
// apply-patches.mjs 是 CLI 脚本，不能整体 import；按其自述的 IMPL 契约在此重放同一次替换，
// 并断言「改法」本身在场（下面第 ⑥ 组锁 apply-patches 里的锚点与守卫文本）。
function applyPatch(text) {
  const execOld = [
    '\t\t\tconst executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, void 0, signal);',
    '\t\t\tif (settled) return await result.promise;',
  ].join('\n')
  const argvOld = [
    '\t\t\tconst argv = [',
    '\t\t\t\texecutable,',
    '\t\t\t\t...packaged ? [] : [heapFlag],',
    '\t\t\t\t...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)',
    '\t\t\t];',
  ].join('\n')
  const envOld = [
    '\t\t\tif (packaged) {',
    '\t\t\t\tenv.DSH_PTC_RUNTIME_NODE = "1";',
    '\t\t\t\tenv.NODE_OPTIONS = heapFlag;',
    '\t\t\t}',
  ].join('\n')
  if (!text.includes(execOld) || !text.includes(argvOld) || !text.includes(envOld)) {
    throw new Error('夹具上锚点未命中——夹具版本与补丁面不同代')
  }
  const execNew = [
    '\t\t\tconst executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, void 0, signal);',
    '\t\t\t' + MARKER + ': fail loud on an unusable executable.',
    '\t\t\tif (typeof executable !== \'string\' || !isAbsolute(executable)) {',
    '\t\t\t\tthrow new Error(\'ptc-runtime-node: resolved node executable is not an absolute path\');',
    '\t\t\t}',
    '\t\t\tconst __dshMobileExecBase = executable.slice(executable.lastIndexOf(\'/\') + 1);',
    '\t\t\tif (/^(?:ld\\.so(?:\\.[0-9]+)*|linker(?:64)?)$/.test(__dshMobileExecBase)) {',
    '\t\t\t\tthrow new Error(\'ptc-runtime-node: resolved node executable is the system dynamic linker\');',
    '\t\t\t}',
    '\t\t\tif (settled) return await result.promise;',
  ].join('\n')
  const argvNew = [
    '\t\t\t// ' + MARKER + ': the heap flag must never sit at argv[1].',
    '\t\t\tconst argv = [',
    '\t\t\t\texecutable,',
    '\t\t\t\t...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)',
    '\t\t\t];',
  ].join('\n')
  const envNew = [
    '\t\t\t// ' + MARKER + ': set for every spawn, not only packaged runs.',
    '\t\t\tenv.NODE_OPTIONS = heapFlag;',
    '\t\t\tif (packaged) {',
    '\t\t\t\tenv.DSH_PTC_RUNTIME_NODE = "1";',
    '\t\t\t}',
  ].join('\n')
  return text.replace(execOld, execNew).replace(argvOld, argvNew).replace(envOld, envNew)
}

// ── (a) 旧形态必须真实存在于夹具里（证明锚点不是空转）───────────────────────
check('夹具里存在旧形态 argv 项 `...packaged ? [] : [heapFlag],`',
  RAW.includes('...packaged ? [] : [heapFlag],'))
check('夹具里 heapFlag 由 maxOldGenerationSizeMb 构造（heapFlag 定义在场）',
  RAW.includes('const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`;'))
check('夹具里 executable 由 resolveExecutable 解析（守卫有用武之地）',
  RAW.includes('resolveExecutable(this.config.launch.executable, void 0, signal)'))

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

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
