#!/usr/bin/env node
// check-snapshot-builder-output.mjs — 快照构建器**产出面**结构断言（0.14.1 P0 反回归；issue #1070）。
//
// 【为什么必须存在（2026-09-19 实锤）】
// 提交 0849579（0.14.0 正式轮）对 scripts/build-snapshot-013.mjs 做了**纯尾部删除**：866 行 → 823 行，
// 删掉的正是「§8 归档」整段（tar -c --mtime … | xz -T0 产出 snapshot.tar.xz、写 snapshot.sha256、
// 归档内 LICENSES 自检、A1 出厂声明值对账）。后果**极其隐蔽**：构建器跑到「瘦身完成」就正常 exit 0，
// **从不产出 tar**；而 build-apk-013.ps1:160 只判「该路径的 tar 是否存在」——于是复用上一次的陈旧快照
// 照常打包，全链零报错（实测：stage 已更新，而 snapshot.tar.xz 的 mtime 仍停在前一轮）。
// 铁证是配置面留下了**死键**（SLIM.reflinkGlobs / SLIM.orphanGlobalNodePackages 无消费者），
// 说明被删的不只是归档、还有依赖这些键的两步瘦身。
//
// 【本门禁的判据（结构化，非 grep 文本在场）】三条强化：
//   1. 产出面构造在场：tar / sha256 / LICENSES 自检 / A1 对账各自必须是**真实调用**（再断言依赖符号可解析）——
//      needle 只出现在注释里不算在场；只作为「声明了却没人调用」的常量字面量也不算在场（复现 A）；
//   2. **配置键消费者闭合**：slim.json 每个键都必须在构建器**代码位置**被消费——
//      注释里提一句 SLIM.treeDelete、或写成字符串 'SLIM.treeDelete'，都不构成消费（复现 B）；
//   3. 产出与判据同源：构建器写出的 tar 路径必须与 build-apk-013.ps1 读取的路径逐字一致。
// 本门禁不解析产物内容（那是 elf-check / check-snapshot-secrets 等的事），只锁「产出面是否还在」。
//
// 用法：node scripts/check-snapshot-builder-output.mjs [--self-test]（退出码 0 通过 / 1 判红 / 2 用法错误）
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const BACKTICK = '\u0060'

const BUILDER = join(ROOT, 'scripts', 'build-snapshot-013.mjs')
const SLIM = join(ROOT, 'scripts', 'snapshot-config', 'slim.json')
const APK_CHAIN = join(ROOT, 'scripts', 'build-apk-013.ps1')
const MIRROR_CHAIN = join(ROOT, 'dsh-mobile-apk', 'scripts', 'build-apk-013.ps1')
const PORTABLE_CHAIN = join(ROOT, 'scripts', 'build-apk.mjs')
const RUNTIME_ASSET_GATE_LOCAL = 'node (Join-Path $Root "scripts\\check-runtime-assets.mjs") $abi --require --snapshot $snapIn'
const RUNTIME_ASSET_GATE_PORTABLE = "run('node', [gate('check-runtime-assets.mjs'), ABI, '--require', '--snapshot', snapIn])"

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/**
 * 产出面构造清单：每条 = 一个「必须真实存在于构建器源码里」的产出动作。
 * 判据是**构造在场 + 依赖符号可解析**，而不是「出现过某个字符串」——
 * 注释里提一句「归档」不构成产出面（这正是本门禁要防的假绿形态）。
 */
const REQUIRED = [
  {
    id: 'tar-archive',
    label: '归档：tar 打包 + xz 压缩产出 snapshot.tar.xz',
    needle: 'tar -c --mtime=@',
    // tar 的输入根必须同时包含 usr 与 home/.dsh（否则打出的快照缺半边装配面）
    deps: ['usr home/.dsh'],
    why: '删掉它 = 构建器不再产出 tar，打包链会静默复用陈旧快照',
  },
  {
    id: 'sha256-sidecar',
    label: '归档：snapshot.sha256 落盘（指纹随产物同批写出）',
    needle: "writeFileSync(join(OUT_DIR, 'snapshot.sha256'",
    deps: ["createHash('sha256')"],
    why: '指纹不落盘 = 下游指纹门禁的声明值恒陈旧',
  },
  {
    id: 'licenses-selfcheck',
    label: '归档后自检：归档内 LICENSES 标准文本计数（防「stage 有、归档无」）',
    needle: 'usr/share/LICENSES/',
    deps: ['tarfile.open'],
    why: '此自检正是历史上「stage 有归档无」怪癖的防线，被删即该缺陷可复发',
  },
  {
    id: 'a1-out-of-band-check',
    label: '归档后对账：A1 出厂声明值（patchReload）按**产物**复核',
    needle: 'check-perf-instrumentation.mjs',
    deps: ['--snapshot'],
    why: 'seed 只保证 stage 正确；对产物的复核被删则「stage 对、归档缺件」无门禁',
  },
  {
    id: 'reflink-slim',
    label: '瘦身：pnpm 跨平台 reflink .node 剔除',
    needle: 'SLIM.reflinkGlobs',
    deps: [],
    why: '步骤被删会让配置键变死键（本次事故的第一手信号）',
  },
  {
    id: 'orphan-global-slim',
    label: '瘦身：global 孤儿重复包剔除',
    needle: 'SLIM.orphanGlobalNodePackages',
    deps: [],
    why: '同上：死键即「某步被删」的确定性证据',
  },
  {
    id: 'tree-delete-slim',
    label: '瘦身：清单驱动整树裁剪（treeDelete，如 usr/share/man）',
    needle: 'SLIM.treeDelete',
    deps: ['assertRelSafe'],
    why: '步骤被删会让 treeDelete 变死键；assertRelSafe 是相对路径安全前置（防清单写 .. 删到树外）',
  },
  {
    id: 'extension-delete-slim',
    label: '瘦身：清单驱动扩展名裁剪（extensionDelete，如引擎子树 .d.ts）',
    needle: 'SLIM.extensionDelete',
    deps: ['assertRelSafe'],
    why: '同上：步骤被删会让 extensionDelete 变死键，裁剪静默失效而门禁全绿',
  },
]


function runChecks() {
  if (!existsSync(BUILDER)) { check('构建器在场: scripts/build-snapshot-013.mjs', false); return }
  const text = readFileSync(BUILDER, 'utf8')
  const views = scanText(text)

  console.log('== 1. 产出面构造在场（每条都要求依赖符号可解析） ==')
  for (const r of REQUIRED) {
    const presence = needlePresence(text, r.needle)
    if (!presence.ok) {
      // 区分三类：整段被删 / 只剩注释 / 降级成没人调用的常量（事故定性不同）
      const detail = presence.kind === 'comment-only'
        ? '该构造只剩注释/文档提到，真实调用已不在（' + r.why + '）'
        : presence.kind === 'dead-constant'
          ? '该构造只剩「声明了却没人调用」的常量字面量（' + presence.detail + '）——真实调用已不在（' + r.why + '）'
          : '该构造完全缺席（' + r.why + '）'
      check(r.label, false, detail)
      continue
    }
    const missingDeps = (r.deps ?? []).filter((d) => !text.includes(d))
    check(r.label, missingDeps.length === 0,
      missingDeps.length > 0 ? '构造在场但上游依赖缺失: ' + missingDeps.join(', ') : undefined)
  }

  console.log('== 2. 配置键消费者闭合（死键 = 某步被删的确定性证据） ==')
  if (!existsSync(SLIM)) {
    check('slim.json 在场', false)
  } else {
    let slim
    try { slim = JSON.parse(readFileSync(SLIM, 'utf8')) } catch (e) {
      check('slim.json 可解析', false, String(e).slice(0, 120)); slim = null
    }
    if (slim) {
      const keys = Object.keys(slim).filter((k) => !k.startsWith('$'))
      const dead = keys.filter((k) => !slimKeyConsumed(views.code, k))
      check('slim.json 全部键都被构建器消费（无死键；死键 = 对应步骤已被删）',
        dead.length === 0,
        '死键: ' + dead.join(', ') + '（0.14.0 事故的第一手信号就是 reflinkGlobs/orphanGlobalNodePackages 变死键；'
          + '注释或字符串里提到 SLIM.键 不算消费）')
    }
  }

  console.log('== 3. 产出路径与打包链读取路径同源 ==')
  // 构建器写出的 tar 相对路径 vs 打包链读取的路径，必须指向同一处。
  check('构建器 OUT_DIR = .deploy-tmp/snapshot-013/<abi>', /const OUT_DIR = join\(ROOT, '\.deploy-tmp', 'snapshot-013', ABI\)/.test(text),
    'OUT_DIR 形状变更：须同步复核打包链读取路径')
  const writesTar = text.includes("join(OUT_DIR, 'snapshot.tar.xz')")
  check('构建器 tar 落点 = <OUT_DIR>/snapshot.tar.xz', writesTar)
  const chain = existsSync(APK_CHAIN) ? readFileSync(APK_CHAIN, 'utf8') : null
  if (chain === null) {
    check('打包链在场: scripts/build-apk-013.ps1', false)
  } else {
    check('打包链读取 .deploy-tmp\\snapshot-013\\<abi>\\snapshot.tar.xz（与构建器同源）',
      chain.includes('.deploy-tmp\\snapshot-013\\') && chain.includes('snapshot.tar.xz'),
      '打包链路径变更：两者不同源会产生「写 A 读 B」的静默假绿')
    check('运行时资产门禁显式读取注入后的最终快照（PowerShell）',
      chain.includes(RUNTIME_ASSET_GATE_LOCAL),
      '必须把当前 ABI 的 $snapIn 传给 --snapshot；默认值会错误读取旧 stage tar')
  }
  if (!existsSync(PORTABLE_CHAIN)) {
    check('可移植打包链在场: scripts/build-apk.mjs', false)
  } else {
    const portable = readFileSync(PORTABLE_CHAIN, 'utf8')
    check('运行时资产门禁显式读取注入后的最终快照（portable）',
      portable.includes(RUNTIME_ASSET_GATE_PORTABLE),
      '必须把当前 ABI 的 snapIn 传给 --snapshot；默认值会错误读取旧 stage tar')
  }
  // 2026-10-28 政策：构建 / 门禁脚本以 dsh-mobile-apk 为准，协调仓副本只作历史回退。
  // 两树字节差异不再判红；本门禁继续守构建器产出面、配置键闭合与路径同源。
  if (existsSync(MIRROR_CHAIN)) {
    console.log('APK-CANONICAL  构建脚本以 dsh-mobile-apk 为准（2026-10-28 政策）；两树字节差异不计为失败')
  }
}

/**
 * 一次扫描得到三份视图（行号/偏移完全一致，便于按位置判「代码 / 字符串 / 注释」）：
 *   clean —— 注释换空格，字符串原样；
 *   code  —— 在 clean 之上把字符串**内容**也换空格（引号保留），用它判「这个 needle 是不是代码」；
 *   literals —— 每个字符串/模板字面量的 [start, end)。
 * 逐行剥注释，但**模板字面量允许跨行**（构建器的 wsl()/py 脚本都是多行模板）：反引号状态
 * 跨行保留，并把模板里的 ${…} 表达式当代码看（否则「变量只在模板里被用」会被误判成
 * 「没人用的常量」，那会制造假红）。单/双引号不跨行——正则里的引号不该把后文吞成字符串。
 */
function scanText(text) {
  const clean = []
  const code = []
  const literals = []
  let index = 0
  let inBlock = false
  let quote = null
  let literalStart = -1
  let templateExprDepth = 0
  while (index < text.length) {
    const c = text[index]
    const next = text[index + 1]
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; clean.push(' ', ' '); code.push(' ', ' '); index += 2; continue }
      clean.push(c === '\n' ? '\n' : ' ')
      code.push(c === '\n' ? '\n' : ' ')
      index += 1
      continue
    }
    if (quote === BACKTICK && templateExprDepth === 0 && c === '$' && next === '{') {
      templateExprDepth = 1
      clean.push(c); clean.push('{'); code.push(c); code.push('{'); index += 2; continue
    }
    if (quote !== null && templateExprDepth > 0) {
      // 模板插值表达式内部：按代码处理（花括号配平后回到字面量文本）。
      if (c === '{') templateExprDepth += 1
      else if (c === '}') templateExprDepth -= 1
      clean.push(c)
      code.push(c === '\n' ? '\n' : c)
      index += 1
      continue
    }
    if (quote !== null) {
      if (c === '\\') { clean.push(c, next ?? ''); code.push(' ', ' '); index += 2; continue }
      clean.push(c)
      code.push(c === '\n' ? '\n' : ' ')
      if (c === quote) { quote = null; literals.push({ start: literalStart, end: index + 1 }) }
      index += 1
      continue
    }
    if (c === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') { clean.push(' '); code.push(' '); index += 1 }
      continue
    }
    if (c === '/' && next === '*') { inBlock = true; clean.push(' ', ' '); code.push(' ', ' '); index += 2; continue }
    if (c === '"' || c === "'" || c === BACKTICK) {
      quote = c
      literalStart = index
      clean.push(c); code.push(c); index += 1
      continue
    }
    clean.push(c); code.push(c); index += 1
  }
  return { clean: clean.join(''), code: code.join(''), literals }
}

/** 该字面量是不是「const|let|var NAME = <字面量>」的右值？是则返回 NAME，否则 null。 */
function declaredByAssignment(clean, literalStart) {
  const before = clean.slice(Math.max(0, literalStart - 400), literalStart)
  const m = /(?:^|[;{}\n])\s*(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]*)?=\s*$/.exec(before)
  return m === null ? null : m[1]
}

/** 标识符在**代码视图**里出现的次数（声明本身算一次）。 */
function identifierOccurrences(code, name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('\\b' + escaped + '\\b', 'g')
  return [...code.matchAll(pattern)].length
}

/**
 * needle 是否以**真实调用形态**在场。
 * @returns {ok, kind, detail?}
 *   kind: 'code'           —— 出现在代码位置（最直接的真实调用）
 *         'called-literal' —— 出现在字面量里，但该字面量处在调用/运算位置（或声明的常量确被用到）
 *         'comment-only'   —— 原始文本有、剥注释后没了 = 只剩注释提到
 *         'dead-constant'  —— 只作为「声明了却没人调用」的常量字面量（#1070 复现 A）
 *         'absent'         —— 完全缺席
 */
function needlePresence(rawText, needle) {
  const { clean, code, literals } = scanText(rawText)
  if (!clean.includes(needle)) {
    return { ok: false, kind: rawText.includes(needle) ? 'comment-only' : 'absent' }
  }
  const positions = []
  for (let at = clean.indexOf(needle); at >= 0; at = clean.indexOf(needle, at + 1)) positions.push(at)
  if (positions.some((at) => code.slice(at, at + needle.length) === needle)) return { ok: true, kind: 'code' }
  const deadNames = []
  let calledSomewhere = false
  for (const at of positions) {
    const literal = literals.find((l) => at >= l.start && at < l.end)
    if (literal === undefined) { calledSomewhere = true; continue }
    const name = declaredByAssignment(clean, literal.start)
    if (name === null) { calledSomewhere = true; continue }
    if (identifierOccurrences(code, name) > 1) { calledSomewhere = true; continue }
    deadNames.push(name)
  }
  if (calledSomewhere) return { ok: true, kind: 'called-literal' }
  return { ok: false, kind: 'dead-constant', detail: [...new Set(deadNames)].join(', ') }
}

/** slim.json 的某个键是否被**代码位置**消费（注释/字符串里提到不算）。 */
function slimKeyConsumed(codeText, key) {
  return codeText.includes('SLIM.' + key)
}

// ── --self-test：每条判据都钉**双向**（能红 / 能绿）────────────────────────────
// 旧版这里有一条恒真断言（archiveStillReal === true || archiveStillReal === false），
// 「本门禁自证能防注释洗白」这个结论曾经是空的（issue #1070 ③）。现在每条都必须是
// 真断言：造出该形态 -> 判据必须红；真实调用 -> 判据必须绿。
function selfTest() {
  console.log('== 门禁自证（--self-test） ==')
  const st = []
  const probe = (label, cond) => { st.push([label, cond]); console.log((cond ? 'PASS  ' : 'FAIL  ') + label) }
  const BT = BACKTICK
  const join2 = (...parts) => parts.join('')
  const tarNeedle = 'tar -c --mtime=@'
  const licNeedle = 'usr/share/LICENSES/'

  // ① needle 判据：真实调用 / 行尾注释 / 块注释 / 降级常量 / 被用到的常量
  const realCall = join2('wsl(', BT, '  cd x && ', tarNeedle, '${E} usr home/.dsh | xz -6 > a', BT, ')')
  probe('正向：wsl 多行模板里的 tar 调用判在场', needlePresence(realCall, tarNeedle).ok === true)
  const lineComment = join2('wsl(', BT, 'x', BT, ') // ', tarNeedle, ' 已下线待观察')
  probe('反向：行尾注释里的 needle 不算在场', needlePresence(lineComment, tarNeedle).ok === false
    && needlePresence(lineComment, tarNeedle).kind === 'comment-only')
  const blockComment = join2('/* ', tarNeedle, ' usr home/.dsh */', '\n', 'process.exit(0)', '\n')
  probe('反向：块注释里的 needle 不算在场', needlePresence(blockComment, tarNeedle).kind === 'comment-only')
  const deadConst = join2('const ARCHIVE_CMD = ', BT, 'x && ', tarNeedle, '${E} usr home/.dsh | xz -6 > a', BT, '\n')
  probe('反向（#1070 复现 A）：降级成「没人调用的常量」不算在场', needlePresence(deadConst, tarNeedle).ok === false
    && needlePresence(deadConst, tarNeedle).kind === 'dead-constant')
  const usedConst = join2('const PY = ', BT, 'x ', licNeedle, BT, '\nexecSync(PY)\n')
  probe('正向：声明后确实被调用的常量字面量算在场', needlePresence(usedConst, licNeedle).ok === true)
  const unusedConst = join2('const PY = ', BT, 'x ', licNeedle, BT, '\n')
  probe('反向：同一个字面量声明了却没人调用 ⇒ 不算在场', needlePresence(unusedConst, licNeedle).ok === false)
  probe('反向：完全缺席判 absent', needlePresence('const x = 1\n', tarNeedle).kind === 'absent')

  // ② 配置键消费：只有代码位置算消费（#1070 复现 B）
  const codeOf = (src) => scanText(src).code
  probe('正向：for (const e of SLIM.treeDelete ?? []) 算消费',
    slimKeyConsumed(codeOf('for (const e of SLIM.treeDelete ?? []) { x(e) }\n'), 'treeDelete') === true)
  probe('反向：注释里提到 SLIM.treeDelete 不算消费',
    slimKeyConsumed(codeOf('// SLIM.treeDelete\nconst LEGACY = []\n'), 'treeDelete') === false)
  probe('反向：写成字符串 SLIM.treeDelete 不算消费',
    slimKeyConsumed(codeOf(join2('const s = ', "'", 'SLIM.treeDelete', "'", '\n')), 'treeDelete') === false)

  // ③ 当前真实构建器必须全绿（正向对照）
  const text = readFileSync(BUILDER, 'utf8')
  const missingNow = REQUIRED.filter((r) => needlePresence(text, r.needle).ok === false)
  probe('正向对照：当前构建器的产出面构造全部在场（缺=' + missingNow.length + '）', missingNow.length === 0)
  const slim = JSON.parse(readFileSync(SLIM, 'utf8'))
  const keys = Object.keys(slim).filter((k) => !k.startsWith('$'))
  const codeNow = scanText(text).code
  const deadNow = keys.filter((k) => !slimKeyConsumed(codeNow, k))
  probe('正向对照：现有 slim 键全部在代码位置被消费（死键=' + deadNow.length + '）', keys.length > 0 && deadNow.length === 0)

  // ④ 尾部删除整段归档后必须判红（0.14.0 事故原形）
  const cut = text.replace(/\n\/\/ ── 8\. 归档[\s\S]*$/, '\n')
  const missingAfterCut = REQUIRED.filter((r) => needlePresence(cut, r.needle).ok === false)
  probe('反向对照：尾部删掉归档段后，产出面判据必须判红（实测缺=' + missingAfterCut.length + '）', missingAfterCut.length >= 4)

  // ⑤ 路径同源判据可红
  const localChain = readFileSync(APK_CHAIN, 'utf8')
  const portableChain = readFileSync(PORTABLE_CHAIN, 'utf8')
  probe('正向对照：两条打包链都将最终快照传给运行时资产门禁',
    localChain.includes(RUNTIME_ASSET_GATE_LOCAL) && portableChain.includes(RUNTIME_ASSET_GATE_PORTABLE))
  probe('反向对照：省略 PowerShell --snapshot 会被门禁自测识别',
    localChain.replace(' --snapshot $snapIn', '').includes(RUNTIME_ASSET_GATE_LOCAL) === false)
  probe('反向对照：省略 portable --snapshot 会被门禁自测识别',
    portableChain.replace(RUNTIME_ASSET_GATE_PORTABLE,
      RUNTIME_ASSET_GATE_PORTABLE.replace(", '--snapshot', snapIn", '')).includes(RUNTIME_ASSET_GATE_PORTABLE) === false)
  const tampered = text.replace("const OUT_DIR = join(ROOT, '.deploy-tmp', 'snapshot-013', ABI)", "const OUT_DIR = join(ROOT, 'elsewhere', ABI)")
  probe('反向对照：篡改 OUT_DIR 形状后同源判据必须判红',
    /const OUT_DIR = join\(ROOT, '\.deploy-tmp', 'snapshot-013', ABI\)/.test(tampered) === false)

  const bad = st.filter(([, ok]) => !ok)
  console.log(bad.length === 0
    ? '\nSNAPSHOT-BUILDER-OUTPUT SELF-TEST PASSED（' + st.length + ' 项：needle 四形态 + 配置键消费 + 真实树正反向对照）'
    : '\nSNAPSHOT-BUILDER-OUTPUT SELF-TEST FAILED: ' + bad.map(([l]) => l).join('; '))
  process.exit(bad.length === 0 ? 0 : 1)
}

if (argv.includes('--self-test')) selfTest()
else {
  if (argv.length > 0) {
    console.error('用法: node scripts/check-snapshot-builder-output.mjs [--self-test]')
    process.exit(2)
  }
  runChecks()
  if (failures.length > 0) {
    console.error('')
    console.error('SNAPSHOT-BUILDER-OUTPUT FAILED（' + failures.length + ' 项）：产出面缺失会让打包链静默复用陈旧快照')
    process.exit(1)
  }
  console.log('')
  console.log('SNAPSHOT-BUILDER-OUTPUT PASSED（产出面构造 + 配置键闭合 + 路径同源）')
}
