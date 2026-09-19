#!/usr/bin/env node
// check-build-parallel-cap.mjs — 构建链并发上限（0.14.1 用户拍板的系统级约束）。
//
// 【为什么必须存在】
// 本开发机是 8 物理核 / 16 逻辑核。构建链原先在压缩/解压处用 `xz -T0`（= 吃满全部逻辑核），
// 于是构建期间开发机会被撑满 → 同时运行的 **MuMu 模拟器卡顿、系统级不稳定**。而「模拟器优先」
// 是本仓铁律 2：本地构建 → MuMu 实测 → 才谈 PR，两者**经常并行**，撑满等于自己踩自己的验收环境。
// 用户 2026-09-19 拍板：**打包固定 8 线程，不撑满 16，保证模拟器与系统稳定**。
//
// 【判据（结构化，不是 grep 文本在场）】
//   1. `-T0` / `-dT0`（吃满）在**可执行代码行**里必须为 0——注释里提到历史写法不算违规
//      （本门禁自己在注释里就要写这个词，故必须区分「代码」与「注释」，否则门禁自伤）。
//   2. 并行度必须来自**单一常量**：`scripts/lib/shell.mjs` 导出的 `XZ_THREADS`（禁各处再写死数字），
//      且该常量默认值 == 8（用户拍板的系统级数字）——写死别的数字或改成读全部核心都判红。
//   3. 消费面：构建链里凡是 `xz` 的**多线程**调用必须用 `${XZ_THREADS}` / `-T<n>` 形式，
//      并且 `build-snapshot-013.mjs` 必须 `import ... XZ_THREADS ...`（否则常量是死代码，形同没接）。
//   4. 设备侧 `make-snapshot.sh` 同样受限（上限 8 / 可覆写），不得出现 `-T0`。
//
// 用法：node scripts/check-build-parallel-cap.mjs [--self-test] [--list]
// 退出码：0 = 通过；1 = 判红；2 = 用法错误。
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

/** 上限出处（单一常量）。 */
const CAP_MODULE = 'scripts/lib/shell.mjs'
const CAP_NAME = 'XZ_THREADS'
const CAP_DEFAULT = 8

/** 受约束的构建脚本（代码行里不得出现吃满型线程参数）。 */
const CONSTRAINED = [
  'scripts/build-snapshot-013.mjs',
  'scripts/build-apk-013.ps1',
  'scripts/build-apk.mjs',
  'scripts/inject-all.py',
  'scripts/make-snapshot.sh',
]

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const readOrNull = (rel) => {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
/**
 * 剥掉注释后的「代码」视图。
 * 必要性：本门禁的关键字（`-T0`）**必然**出现在说明它为何被禁的注释里；若不剥注释，
 * 门禁会把自己的文档判成违规（自伤）。覆盖三种注释形态：
 *   - `//` 行注释（JS/PS1）
 *   - `/* *​/` 与 `<# #>` 块注释（JS / PowerShell）
 *   - `#` 行注释（Python/Shell）——**含 Python 的三引号文档字符串**（本仓 inject-all.py 的
 *     模块头就是 docstring；它是「文档」不是「代码」，其中提到历史写法 `-T0` 不算违规）。
 * 字符串字面量不剥——`'-T0'` 出现在字符串里同样是真风险（可能被拼进命令），保守判红。
 * **必须先归一化行尾**：Windows 工作树是 CRLF，而 `$`（未加 m 标志）在 `\r` 前不匹配，
 * 于是 `^\s*#.*$` 对 CRLF 行**恒不匹配** → 注释行会被当成代码（本门禁首版即因此自伤判红）。
 */
const codeOnly = (text) => text
  .replace(/\r\n/g, '\n')                           // CRLF -> LF（否则行尾锚点失效）
  .replace(/\r/g, '\n')                             // 裸 CR
  .replace(/\/\*[\s\S]*?\*\//g, '')                 // JS/PS1 块注释
  .replace(/<#[\s\S]*?#>/g, '')                     // PowerShell 块注释
  .replace(/"""[\s\S]*?"""/g, '')                   // Python 三引号 docstring（双）
  .replace(/'''[\s\S]*?'''/g, '')                   // Python 三引号 docstring（单）
  .split('\n')
  .map((l) => l
    .replace(/(^|[^:"'`])\/\/.*$/, '$1')            // // 行注释（避开 http:// 之类）
    .replace(/^[ \t]*#.*$/, ''))                    // # 行注释（Python/Shell；[ \t] 而非 \s 防吃换行）
  .join('\n')

function runChecks() {
  // ── 1. 可执行代码行里不得有 -T0 / -dT0 ────────────────────────────────
  console.log('== 1. 吃满型线程参数（-T0 / -dT0）在可执行代码里必须为 0 ==')
  for (const rel of CONSTRAINED) {
    const text = readOrNull(rel)
    if (text === null) { check('受约束脚本在场: ' + rel, false, '文件缺席（清单失效）'); continue }
    const code = codeOnly(text)
    const hits = code.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter((o) => /-[dT]?T0\b|\s-T\s*0\b|--threads[= ]0\b/.test(o.l))
    check(rel + ' 无吃满型线程参数（-T0）', hits.length === 0,
      hits.slice(0, 3).map((h) => 'L' + h.n + ': ' + h.l.trim().slice(0, 90)).join(' | ')
      + '（构建期撑满 16 逻辑核 → MuMu 卡顿/系统不稳；上限见 ' + CAP_MODULE + '）')
  }

  // ── 2. 单一常量：默认 8 ────────────────────────────────────────────────
  console.log('== 2. 并发上限来自单一常量且默认 ' + CAP_DEFAULT + ' ==')
  const capText = readOrNull(CAP_MODULE)
  if (capText === null) {
    check('上限常量模块在场: ' + CAP_MODULE, false)
  } else {
    check(CAP_MODULE + ' 导出 ' + CAP_NAME, new RegExp('export\\s+const\\s+' + CAP_NAME + '\\b').test(capText))
    // 默认值必须恰好是用户拍板的 8（允许 DSH_CPU_THREADS 覆写，但默认不得是「全部核心」）
    const m = new RegExp('export\\s+const\\s+CPU_THREADS_CAP\\s*=\\s*(\\d+)').exec(capText)
    check('默认上限 == ' + CAP_DEFAULT + '（用户拍板的系统级数字）', m !== null && Number(m[1]) === CAP_DEFAULT,
      m === null ? 'CPU_THREADS_CAP 常量缺席' : '实测 ' + m[1])
    // 不得出现「读全部核心」的默认行为（那就是原来的问题）
    const capsToAllCores = /os\.cpus\(\)\.length|os\.cpu_count|nproc\b/.test(codeOnly(capText))
    check('默认不取「全部核心数」（禁回到吃满行为）', !capsToAllCores,
      '上限模块里出现「核心数」推导；用户口径是固定 8，不是「有多少用多少」')
  }

  // ── 3. 消费面：构建链真的用了这个常量 ────────────────────────────────
  console.log('== 3. 构建链消费上限常量（否则常量是死代码） ==')
  const snap = readOrNull('scripts/build-snapshot-013.mjs')
  if (snap === null) {
    check('build-snapshot-013.mjs 在场', false)
  } else {
    check('build-snapshot-013.mjs import 了 ' + CAP_NAME,
      new RegExp("import\\s*\\{[^}]*\\b" + CAP_NAME + "\\b[^}]*\\}\\s*from\\s*'\\./lib/shell\\.mjs'").test(snap))
    const uses = (codeOnly(snap).match(/-T\$\{XZ_THREADS\}|-dT\$\{XZ_THREADS\}/g) ?? []).length
    check('build-snapshot-013.mjs 的 xz 调用使用 ${' + CAP_NAME + '}（实测 ' + uses + ' 处）', uses >= 2,
      '至少要覆盖「解压基座」与「归档压缩」两处多线程 xz')
    // 反向：代码里不得再有裸数字线程参数（写死 8 也不行——那就不是单一常量了）
    const hardcoded = (codeOnly(snap).match(/-T\d+|-dT\d+/g) ?? []).filter((s) => !s.includes('${'))
    check('build-snapshot-013.mjs 无写死的线程数字（须走常量）', hardcoded.length === 0,
      '命中: ' + hardcoded.join(', '))
  }
  const apk = readOrNull('scripts/build-apk-013.ps1')
  if (apk !== null) {
    const hard = (codeOnly(apk).match(/-T\d+/g) ?? []).filter((s) => !s.includes('${'))
    check('build-apk-013.ps1 无写死的线程数字', hard.length === 0, '命中: ' + hard.join(', '))
  }

  // ── 4. 设备侧脚本同样受限 ────────────────────────────────────────────
  console.log('== 4. 设备侧 make-snapshot.sh 同受限（且可覆写） ==')
  const ms = readOrNull('scripts/make-snapshot.sh')
  if (ms === null) {
    check('make-snapshot.sh 在场', false, '文件缺席（清单失效）')
  } else {
    const code = codeOnly(ms)
    check('make-snapshot.sh 无 -T0', !/-T0\b/.test(code))
    check('make-snapshot.sh 使用可覆写的固定上限（DSH_CPU_THREADS:-' + CAP_DEFAULT + '）',
      new RegExp('DSH_CPU_THREADS:-' + CAP_DEFAULT).test(code) || new RegExp('\\$-\\{?DSH_CPU_THREADS').test(code),
      '设备侧也应固定上限并可覆写，避免手机 SoC 被撑满')
  }
}

// ── --self-test：反向对照必须判红（门禁自身的反假绿）──────────────────────
/**
 * 在隔离目录里用**真实读取路径**重跑判据（不复制判据逻辑，避免「副本与正本各自演进」）。
 *
 * 做法：把整个 scripts/ 树**真实拷贝**进临时根，只把上限常量文件替换成变异体，然后以该临时根为
 * ROOT 跑本门禁的正式模式。这样 ROOT 解析、readOrNull、CONSTRAINED 清单全部走真实代码路径。
 *
 * 为什么必须真重跑：原实现只断言 `brokenCap !== realCap`（字符串换掉了）——那是**永真**命题，
 * 只要 replace 命中就通过；把判据整段删掉也照样绿。探针从未证明「改坏之后会红」。
 *
 * 为什么必须**拷贝**而不是 symlink/junction：Windows 上对**文件**建 junction 会静默失败
 * （`symlinkSync(..., 'junction')` 对文件不报错但不生效）→ 隔离树里少文件 → 判据因「文件缺席」
 * 判红（**假红**）→ 探针变成永真（实测踩到：完整常量也判红）。scripts/ 树仅 1.4 MB / 134 文件，
 * 整树拷贝成本可忽略，换来「真正跑的是副本、且副本完整」。
 *
 * @param mutatedCapText - 变异后的 scripts/lib/shell.mjs 内容。
 * @returns `{ red, detail }`：判据是否判红，以及命中的判据标题。
 */
function rerunChecksWithCap(mutatedCapText) {
  const tmp = mkdtempSync(join(tmpdir(), 'parallel-cap-'))
  try {
    cpSync(join(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true })
    writeFileSync(join(tmp, 'scripts', 'lib', 'shell.mjs'), mutatedCapText)
    const r = spawnSync(process.execPath, [join(tmp, 'scripts', 'check-build-parallel-cap.mjs')], { cwd: tmp, encoding: 'utf8' })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const hit = out.split('\n').find((l) => /^FAIL\s+/.test(l.trim()))?.trim() ?? ''
    return { red: r.status === 1, detail: hit }
  } catch (e) {
    return { red: false, detail: '重跑失败: ' + String(e.message).slice(0, 160) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function selfTest() {
  console.log('== 门禁自证（--self-test） ==')
  const st = []
  const probe = (label, cond) => { st.push([label, cond]); console.log((cond ? 'PASS  ' : 'FAIL  ') + label) }

  // ① 正向：当前仓库必须通过
  const before = failures.length
  runChecks()
  probe('正向对照：当前仓库通过全部并发上限判据', failures.length === before)

  // ② 反向：把 -T0 塞回可执行代码 → 必须判红（用真实读取路径复现判据，不复制逻辑）
  const realSnap = readFileSync(join(ROOT, 'scripts', 'build-snapshot-013.mjs'), 'utf8')
  const brokenSnap = realSnap.replace(`xz -T\${XZ_THREADS} -6`, 'xz -T0 -6')
  probe('反向对照：归档压缩改回 -T0 时判据命中（判红）',
    brokenSnap !== realSnap
    && codeOnly(brokenSnap).split('\n').some((l) => /-[dT]?T0\b/.test(l)))

  // ③ 反向：注释里的 -T0 不得算违规（防门禁自伤）
  probe('反向对照：纯注释行的 -T0 不计入违规（防门禁自伤）',
    !codeOnly('// 历史写法是 xz -T0，已禁用\nconst a = 1\n').split('\n').some((l) => /-[dT]?T0\b/.test(l)))

  // ③b CRLF 回归：Windows 工作树是 CRLF；`$` 在 `\r` 前不匹配 → 注释行会被当成代码（本门禁首版
  // 即因此自伤判红）。这条断言把「必须先归一化行尾」钉成回归判据。
  probe('反向对照：CRLF 行尾的注释行同样不计入违规（本门禁曾在此自伤）',
    !codeOnly('# 历史写法是 xz -T0\r\nconst a = 1\r\n').split('\n').some((l) => /-[dT]?T0\b/.test(l)))

  // ④ 反向：把常量默认值改成 16 → 必须**真重跑判据**（此前只断言「字符串替换发生了」，
  //    那是**永真**命题：只要 replace 命中就通过，把判据本身删掉也照样绿 —— 该探针从未证明
  //    「改坏之后门禁会红」。现改为：在隔离目录里用真实读取路径跑一遍完整判据，断言它判红。
  const realCap = readFileSync(join(ROOT, CAP_MODULE), 'utf8')
  const brokenCap = realCap.replace('export const CPU_THREADS_CAP = 8', 'export const CPU_THREADS_CAP = 16')
  const capRedResult = rerunChecksWithCap(brokenCap)
  probe('反向对照：默认上限改成 16 时**真重跑判据**必须判红（原实现只断言字符串换掉了）',
    brokenCap !== realCap && capRedResult.red,
    '变异生效=' + (brokenCap !== realCap) + '；重跑判红=' + capRedResult.red
    + (capRedResult.detail !== '' ? '；命中判据=' + capRedResult.detail : ''))

  // ⑤ 反向：默认改成「读全部核心」→ 同样真重跑
  const allCoreCap = realCap.replace(
    'export const CPU_THREADS_CAP = 8',
    'export const CPU_THREADS_CAP = os.cpus().length')
  const allCoreResult = rerunChecksWithCap(allCoreCap)
  probe('反向对照：默认上限改成「全部核心」时**真重跑判据**必须判红',
    allCoreCap !== realCap && allCoreResult.red,
    '重跑判红=' + allCoreResult.red + (allCoreResult.detail !== '' ? '；命中判据=' + allCoreResult.detail : ''))

  // ⑥ 正向：常量确实被构建器消费（防死代码）
  probe('正向对照：构建器 import 并使用了 XZ_THREADS',
    /import\s*\{[^}]*\bXZ_THREADS\b[^}]*\}\s*from\s*'\.\/lib\/shell\.mjs'/.test(realSnap)
    && (realSnap.match(/-T\$\{XZ_THREADS\}|-dT\$\{XZ_THREADS\}/g) ?? []).length >= 2)

  const bad = st.filter(([, ok]) => !ok)
  console.log(bad.length === 0
    ? '\nPARALLEL-CAP SELF-TEST PASSED'
    : '\nPARALLEL-CAP SELF-TEST FAILED: ' + bad.map(([l]) => l).join('; '))
  process.exit(bad.length === 0 ? 0 : 1)
}

if (argv.includes('--self-test')) selfTest()
else if (argv.includes('--list')) {
  console.log('受约束脚本：')
  for (const rel of CONSTRAINED) console.log('   ' + rel)
  console.log('上限出处：' + CAP_MODULE + ' 的 ' + CAP_NAME + '（默认 ' + CAP_DEFAULT + '）')
  process.exit(0)
} else if (argv.length > 0) {
  console.error('用法: node scripts/check-build-parallel-cap.mjs [--self-test] [--list]')
  process.exit(2)
} else {
  runChecks()
  if (failures.length > 0) {
    console.error('')
    console.error('PARALLEL-CAP FAILED（' + failures.length + ' 项）：构建并发不得吃满全部逻辑核'
      + '（0.14.1 用户拍板：固定 ' + CAP_DEFAULT + ' 线程，保证 MuMu 模拟器与系统稳定）')
    process.exit(1)
  }
  console.log('')
  console.log('PARALLEL-CAP PASSED（并发上限单一常量 + 默认 ' + CAP_DEFAULT + ' + 构建链已消费 + 设备侧同受限）')
}
