#!/usr/bin/env node
/**
 * check-code-map 符号锚点的变异反证（三组）。
 *
 * 用法：node scripts/check-code-map-anchors.test.mjs [--repo <路径>] [--keep-stage]
 *
 * 为什么要有「变异必须真的落地」的断言：
 * 所有者实测时第一次把 `function tableRows` 当成替换目标，而实际声明是 `const tableRows =`，
 * 替换零命中、门禁自然绿 —— 差一点把机制判成「无效」。
 * 所以每条变异替换后先比对全文，与原文相同即输出 VOID 并判该反证无效，绝不把假绿算成通过。
 * 同理，门禁崩溃（SyntaxError 等）也不算判定，一律 VOID。
 *
 * 为什么变异跑在**临时副本**上（2026-11-01 重做；此前的写法是自毁式的）：
 * 旧实现把变异体 `writeFileSync` 直接写回**真实的** `scripts/check-code-map.mjs`，靠
 * `finally` + SIGINT/SIGTERM/SIGHUP + `process.on('exit')` 三路复原。只要进程被 **SIGKILL**
 * 杀掉（执行器超时、断电、OOM），三条路一条都跑不到，仓库就停在变异态：
 *   · 实测残留：`if (t === '') continue`（删掉了 `#` 注释过滤）+ shebang 后 5 个空行；
 *   · 脏字节被下一个不知情的人当成「别人的改动」`git add -A` 提交进 PR —— 那是把门禁**放宽**
 *     的字节混进产品提交，比红一次严重得多。
 * 结论：**测试不该有写回真实工作树的能力**。现在真实文件全程只读，变异只写临时目录副本，
 * 子进程在副本根下跑门禁；进程怎么死都污染不到仓库。验收判据是跑完
 * `git status --porcelain scripts/` 必须为空（见末尾自检）。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argRepo = process.argv.indexOf('--repo')
const ROOT = argRepo > 0 ? resolvePath(process.argv[argRepo + 1]) : join(HERE, '..')
const TARGET_REL = 'scripts/check-code-map.mjs'
/*
 * 真实工作树的「跑前快照」，必须在**任何动作之前**拍。
 *
 * 为什么不能等测试末尾再拍：旧写法（以及任何「先做再说」的写法）里，脏字节在过程中就已经
 * 落进真实文件了；末尾才拍 before 等于把当年的脏当成基线，自己和自己比永远相等 ——
 * 实测这条自检最初就掉进这个陷阱（负控把变异写回真实文件，自检仍报 ok）。
 * 快照两样：目标文件的**字节 sha** 与 `git status -- scripts` 的文本。
 */
const BEFORE_BYTES = readFileSync(join(ROOT, TARGET_REL), 'utf8')
const beforeStatus = (() => {
  const p = spawnSync('git', ['status', '--porcelain', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  if (p.error !== undefined && p.error !== null) return null
  return p.status === 0 ? (p.stdout || '').trim() : null
})()
const orig = BEFORE_BYTES
const nl = orig.indexOf('\n')
const headPart = orig.slice(0, nl + 1)
const restPart = orig.slice(nl + 1)

/**
 * 临时副本的「大盘目录」：这些目录只读、且体积大，用目录联接（junction）指回真实仓，
 * 不复制。门禁只从中读文件，不写。
 */
const JUNCTION_DIRS = [
  'app', 'docs', 'plugins', 'vendor', 'webpages', 'release', 'dsh-client-ui-responsive',
  'dsh-host-web-compat', 'dsh-shell-termux', 'base', 'final-acceptance', 'qrcode', 'gradle',
  'keystore', 'LICENSES', '.github',
]

/** 把 `rel` 目录整棵复制到 stage（跳过 node_modules / .git）。 */
function copyTree(stage, rel) {
  const abs = join(ROOT, rel)
  mkdirSync(join(stage, rel), { recursive: true })
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel + '/' + entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      copyTree(stage, childRel)
    } else if (entry.isFile()) {
      cpSync(join(ROOT, childRel), join(stage, childRel))
    }
  }
}

/**
 * 建一份可跑的临时副本根。
 * `scripts/` 必须**真复制**（变异体要写在这里），且门禁从自身位置推导 REPO，
 * 所以副本根要看起来像本仓（清单标记 + 地图 + 被盘点的路径）。其余用 junction 指回真实仓。
 * @returns 副本根路径。
 */
function makeStage() {
  const stage = mkdtempSync(join(tmpdir(), 'code-map-mutation-'))
  copyTree(stage, 'scripts')
  for (const dir of JUNCTION_DIRS) {
    try {
      symlinkSync(join(ROOT, dir), join(stage, dir), 'junction')
    } catch {
      // 该目录不在场（或本机不允许联结）：复制而不是失败，判据不依赖「一定是 junction」
      try { cpSync(join(ROOT, dir), join(stage, dir), { recursive: true }) } catch { /* 目录缺省 */ }
    }
  }
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(join(ROOT, entry.name), join(stage, entry.name))
  }
  return stage
}

/** 在副本根里跑门禁；读的永远是副本那份脚本。 */
function gate(stage) {
  const p = spawnSync(process.execPath, [TARGET_REL], { cwd: stage, encoding: 'utf8' })
  const out = (p.stdout || '') + (p.stderr || '')
  const crash = /SyntaxError|ReferenceError|TypeError|ERR_UNSUPPORTED/.test(out)
  const kinds = [...new Set([...out.matchAll(/\[((?:symbol|anchor|bad)-[a-z-]+)\]/g)].map((m) => m[1]))]
  return { code: p.status, passed: /CHECK-CODE-MAP PASSED/.test(out), crash, kinds }
}

let ok = true
const stage = makeStage()
try {
  function run(label, content, want) {
    if (content === orig) {
      console.log('  VOID  ' + label + ' —— 变异未落地（替换零命中），该反证无效')
      return false
    }
    // 变异只写副本；真实工作树自始至终没有被打开来写
    writeFileSync(join(stage, TARGET_REL), content, 'utf8')
    const r = gate(stage)
    if (r.crash) { console.log('  VOID  ' + label + ' —— 门禁崩溃，非判定，该反证无效'); return false }
    const pass = want === 'green' ? (r.passed && r.code === 0) : (!r.passed && r.code === 1)
    console.log((pass ? '  ok    ' : '  FAIL  ') + label + ' -> exit=' + r.code
      + (r.kinds.length ? ' [' + r.kinds.join(',') + ']' : ''))
    return pass
  }

  console.log('== 组 1：改符号名 / 改函数体 -> 必须红 ==')
  const r1 = orig.replace(/tableRows/g, 'tableRowsX')
  if (r1 === orig) { console.log('  VOID  tableRows 改名 —— 未命中'); ok = false }
  else ok = run('tableRows -> tableRowsX（全部引用）', r1, 'red') && ok
  const r2 = orig.replace(/parseDoc/g, 'parseDocX')
  if (r2 === orig) { console.log('  VOID  parseDoc 改名 —— 未命中'); ok = false }
  else ok = run('parseDoc -> parseDocX（全部引用）', r2, 'red') && ok
  const r3 = orig.replace("if (t === '' || t.startsWith('#')) continue", "if (t === '') continue")
  if (r3 === orig) { console.log('  VOID  parseDoc 体改动 —— 未命中'); ok = false }
  else ok = run('parseDoc 函数体改动', r3, 'red') && ok

  console.log('== 组 2：上方插行 / 加空行 / 只挪行 -> 必须绿 ==')
  ok = run('shebang 后插 1 行（全文行号 +1）', headPart + '// inserted by mutation control\n' + restPart, 'green') && ok
  ok = run('shebang 后插 5 个空行', headPart + '\n\n\n\n\n' + restPart, 'green') && ok
  ok = run('parseDoc 上方插 3 空行', orig.replace('export function parseDoc(text) {', '\n\n\nexport function parseDoc(text) {'), 'green') && ok
  ok = run('tableRows 上方插 2 行注释', orig.replace('const tableRows = (chunk) => {', '// a\n// b\nconst tableRows = (chunk) => {'), 'green') && ok

  console.log('== 组 3：符号移走 + 保留同名其它符号 -> 必须红（消歧不误判）==')
  const r4 = orig
    .replace('export function parseDoc(text) {', 'export function parseDocBase(text) {')
    .replace(/\bparseDoc\(/g, 'parseDocBase(')
    + '\nclass DecoyA {\n  parseDoc(x) {\n    return x\n  }\n}\n'
    + '\nclass DecoyB {\n  parseDoc(y) {\n    return y\n  }\n}\n'
  ok = run('原符号移走 + 两个不同类的同名方法', r4, 'red') && ok
} finally {
  if (process.argv.includes('--keep-stage')) console.log('  stage kept: ' + stage)
  else rmSync(stage, { recursive: true, force: true })
}

/*
 * 验收判据（本文件的立身之本）：跑完之后**真实工作树里 scripts/ 不得有任何变化**。
 *
 * 为什么把这条写进测试而不是只写在 PR 里：旧实现之所以能把变异字节留进仓库，正是因为
 * 「跑完工作树是干净的」这件事**从来没有被判据盯住**——它靠的是 `finally` 的自觉。
 * 这里用 git 自己作答：拿 `git status --porcelain -- scripts` 的快照与跑前的快照比对。
 * 分不清「本来就有的改动」与「本次新留下的脏」时，比对快照就不会误报（开发者改这行代码时
 * 工作树本来就是脏的）。
 */
function scriptsStatus() {
  const p = spawnSync('git', ['status', '--porcelain', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  if (p.error !== undefined && p.error !== null) return null // 不是 git 工作树：此判据不适用
  if (p.status !== 0) return null
  return (p.stdout || '').trim()
}

// ① 字节判据（主判据）：目标文件必须与测试开头读到的那份**逐字节相同**。
//    不依赖 git，也不依赖「这次改的是哪一行」——任何写回真实文件的路径都会让它红。
const nowBytes = readFileSync(join(ROOT, TARGET_REL), 'utf8')
const bytesClean = nowBytes === BEFORE_BYTES
console.log((bytesClean ? '  ok    ' : '  FAIL  ') + 'scripts/check-code-map.mjs 在跑完后与跑前逐字节相同（真实文件从未被写）'
  + (bytesClean ? '' : '\n        长度 跑前=' + BEFORE_BYTES.length + ' 跑后=' + nowBytes.length))
ok = bytesClean && ok

// ② 状态判据（辅助）：scripts/ 不得出现**新的**改动条目（开发者本来就改了别的文件时不会误报）。
const afterStatus = scriptsStatus()
const statusClean = beforeStatus === null || beforeStatus === afterStatus
console.log((statusClean ? '  ok    ' : '  FAIL  ') + '真实工作树 git status -- scripts 与跑前一致'
  + (statusClean ? '' : '\n        跑前: ' + JSON.stringify(beforeStatus) + '\n        跑后: ' + JSON.stringify(afterStatus)))
ok = statusClean && ok

console.log(ok ? 'ALL 10 CHECKS PASSED（8 条变异反证 + 字节只读自检 + git 状态自检）' : 'SOME CONTROLS FAILED OR VOID')
process.exit(ok ? 0 : 1)
