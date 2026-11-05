#!/usr/bin/env node
// check-patch-fixtures.mjs — 补丁测试夹具随版门禁（0.14.2 T6）
//
// 真因（本轮实锤，不是假设）：0.1.7-rc.1 快照构建里 19 条引擎补丁断 9 条，而 `scripts/patches/tests/`
// 的 16 个补丁测试**全绿**——因为它们的夹具目录名写死着上一代（dsh-client-modules-0.1.5-rc.1）。
// 夹具与真产物不是同一代时，「补丁回归」这四个字没有任何含义：测试证明的是补丁对**旧字节**仍成立。
//
// 三条断言：
//   A 台账完备：fixtures/ 下每个目录都必须在 fixtures/manifest.json 里声明（沉默的目录 = 红）；
//   B 随版：source=engine-tgz 的目录版本必须 == contract.baseline，且 manifest 声明的文件真在场；
//     source=synthetic 的必须写明 reason（为什么不用真产物）；
//   C 禁写死：tests/*.test.mjs 里不得再出现内嵌版本号的夹具路径字面量（一律走 lib/fixture.mjs）。
//
// 用法：node scripts/check-patch-fixtures.mjs [--self-test]
// 退出码：0 = PASS；1 = FAIL。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SELF_TEST = process.argv.includes('--self-test')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const fails = []
const check = (label, ok, detail) => {
  if (!ok) fails.push(label + (detail ? ' -> ' + detail : ''))
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
}

/**
 * 源码位掩码：把字符串 / 模板串 / 注释 / 正则字面量的**内容**抹成空格，代码位原样保留。
 *
 * 为什么必须先掩码（#981 真身）：`const IMPLS = { ... }` 的值里含模板字符串，其中有一行收尾 `}`
 * 顶格（第 0 列）。旧实现按「行首第一个 `}` 即块尾」提前 break，于是文件里 26 处
 * `scope: 'engine'` 只认出前 7 处，其余 19 条引擎补丁对下方 D 段（registry 缺 scope 判据）
 * **整体不可见**——门禁照样 PASS，因为「看不见」和「没问题」在返回的 Map 里长得一样。
 *
 * 只做括号配对也不够：模板串 / 注释 / 正则里的 `{` `}` 一样会带偏配对（正则的 `{2,3}`
 * 会让深度永久偏移），所以先按词法掩码、再按配对扫描，两道一起才成立。
 * 掩码与原文**等长**（换行保留），因此任何结构位置都能直接回原文取值。
 * @param source - 源文件全文。
 * @returns 与 source 等长的字符串：代码位原样，字面量/注释位为空格。
 */
function codeMask(source) {
  const n = source.length
  const out = source.split('')
  const blank = (i) => { if (i < n && source[i] !== '\n' && source[i] !== '\r') out[i] = ' ' }
  // 单层状态 + 模板插值深度栈：'code' 代码位；'sq'/'dq'/'tpl' 字面量；'line'/'block' 注释；
  // 'regex' 正则字面量。模板串的 ${...} 插值区压回 'code' 层，出插值时按 tpl 栈回到 'tpl'。
  let state = 'code'
  const tpl = []
  // 区分「正则字面量」与「除号」：除号前面一定是值（标识符 / ) / ] / 字面量），
  // 正则前面一定是运算符或关键字。判错的方向是保守的：把除号当正则只会多抹掉一段表达式
  // 的**内容**（从而少判条目），不会凭空伪造出块边界。
  let lastChar = ''
  let lastWord = ''
  const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', ''])
  const REGEX_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case', 'throw'])
  let i = 0
  while (i < n) {
    const c = source[i]
    const d = source[i + 1]
    if (state === 'code') {
      if (tpl.length > 0) {
        if (c === '{') tpl[tpl.length - 1] += 1
        else if (c === '}') {
          if (tpl[tpl.length - 1] === 0) { blank(i); tpl.pop(); state = 'tpl'; i += 1; continue }
          tpl[tpl.length - 1] -= 1
        }
      }
      if (c === '/' && d === '/') { blank(i); blank(i + 1); state = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { blank(i); blank(i + 1); state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { blank(i); state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'; i += 1; continue }
      if (c === '/' && (REGEX_PREV.has(lastChar) || REGEX_WORDS.has(lastWord))) { blank(i); state = 'regex'; i += 1; continue }
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1
        lastWord = source.slice(i, j)
        lastChar = source[j - 1]
        i = j
        continue
      }
      if (!/\s/.test(c)) { lastChar = c; lastWord = '' }
      i += 1
      continue
    }
    if (state === 'line') { blank(i); if (c === '\n') state = 'code'; i += 1; continue }
    if (state === 'block') { blank(i); if (c === '*' && d === '/') { blank(i + 1); state = 'code'; i += 2; continue } i += 1; continue }
    if (state === 'regex') {
      // 正则不能跨行：未闭合就撞到行尾时按除号收尾，继续按代码位扫（不吞掉后续结构）。
      if (c === '\n') { state = 'code'; i += 1; continue }
      blank(i)
      if (c === '\\') { blank(i + 1); i += 2; continue }
      if (c === '/') {
        state = 'code'
        let j = i + 1
        while (j < n && /[a-z]/i.test(source[j])) j += 1
        lastChar = '/'; lastWord = ''
        i = j
        continue
      }
      i += 1
      continue
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue }
      if (state === 'tpl') {
        if (c === '$' && d === '{') { blank(i); blank(i + 1); tpl.push(0); state = 'code'; i += 2; continue }
        if (c === '`') { blank(i); state = 'code'; lastChar = 'v'; lastWord = ''; i += 1; continue }
        blank(i); i += 1; continue
      }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { blank(i); state = 'code'; lastChar = 'v'; lastWord = ''; i += 1; continue }
      blank(i); i += 1; continue
    }
    i += 1
  }
  return out.join('')
}

/** 配对扫描：从 mask 的 openIndex（应为 `{`）找到配对的 `}`；找不到返回 -1。
 *  掩码已抹掉字面量与注释，因此深度只由真实代码结构推动。 */
function matchBrace(mask, openIndex) {
  let depth = 0
  for (let i = openIndex; i < mask.length; i += 1) {
    const c = mask[i]
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return i }
  }
  return -1
}

/**
 * 从 apply-patches.mjs 源码里读出每个补丁实现声明的 scope。
 *
 * 为什么读源码而不是 import：apply-patches.mjs 是可直接执行的脚本，顶层就做参数解析与
 * 文件读写，import 会触发它的主流程。
 *
 * 取面口径（#981 重写）：先在掩码上按**括号配对**圈定 `const IMPLS = {` 的真实块尾，再逐个取
 * 「块内深度 1 处的 `{`」为其直接条目，条目体内**深度 0 处**的 `scope:` 才是该条目的声明
 * （嵌套对象 / 箭头函数体里的 scope 不算）。不再依赖任何行首缩进或顶格 `}`。
 * @param source - apply-patches.mjs 全文。
 * @returns 补丁 id -> 声明的 scope（未声明的不在表里）。
 */
function implScopeOf(source) {
  const scopes = new Map()
  const mask = codeMask(source)
  const head = /const IMPLS = \{/.exec(mask)
  if (head === null) return scopes
  const open = head.index + head[0].length - 1
  const close = matchBrace(mask, open)
  if (close < 0) return scopes
  let depth = 1
  for (let i = open + 1; i < close; i += 1) {
    const c = mask[i]
    if (c === '}') { depth -= 1; continue }
    if (c !== '{') continue
    if (depth === 1) {
      // 直接条目的键只可能是字符串字面量：值从**原文**取（掩码把字面量内容抹掉了）。
      const entryHead = /'([^']+)'\s*:\s*\{$/.exec(source.slice(Math.max(open, i - 160), i + 1))
      const entryClose = matchBrace(mask, i)
      if (entryHead !== null && entryClose > i) {
        const body = mask.slice(i + 1, entryClose)
        const re = /scope\s*:\s*/g
        let m
        while ((m = re.exec(body)) !== null) {
          let d2 = 0
          for (let k = 0; k < m.index; k += 1) {
            const ch = body[k]
            if (ch === '{') d2 += 1
            else if (ch === '}') d2 -= 1
          }
          if (d2 !== 0) continue
          const v = /^scope\s*:\s*'([^']+)'/.exec(source.slice(i + 1 + m.index, entryClose))
          if (v !== null) scopes.set(entryHead[1], v[1])
          break
        }
      }
    }
    depth += 1
  }
  return scopes
}

/** 对一棵 fixtures/tests 树跑三条断言，返回失败列表（--self-test 用临时树驱动反例）。 */
function audit(fixturesDir, testsDir, baseline, sourceCommit = null, registry = null) {
  const out = []
  const manifestPath = join(fixturesDir, 'manifest.json')
  if (!existsSync(manifestPath)) return ['夹具台账缺席: ' + manifestPath]
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.fixtures ?? {}
  if (registry && (manifest.capture?.engine !== baseline || manifest.capture?.sourceCommit !== sourceCommit
    || manifest.capture?.registrySha256 !== sha256(readFileSync(join(HERE, 'patches', 'registry.json'))))) {
    out.push('夹具捕获登记身份/补丁集与当前合同不符：必须从本代真实构建产物重新捕获')
  }
  // A 台账完备
  const dirs = readdirSync(fixturesDir).filter((d) => statSync(join(fixturesDir, d)).isDirectory())
  for (const d of dirs) if (!declared[d]) out.push(`夹具目录未在台账声明: ${d}`)
  // B 随版
  for (const [dir, meta] of Object.entries(declared)) {
    if (!existsSync(join(fixturesDir, dir))) { out.push(`台账声明的夹具目录缺席: ${dir}`); continue }
    if (meta.source === 'engine-tgz') {
      if (meta.engine !== baseline) out.push(`夹具未随版: ${dir} engine=${meta.engine} != contract.baseline=${baseline}`)
      if (!dir.endsWith('-' + meta.engine)) out.push(`夹具目录名与台账版本不符（改名没改台账）: ${dir} vs ${meta.engine}`)
      const files = meta.files ?? []
      if (!files.length || new Set(files).size !== files.length) out.push('夹具文件集为空/重复: ' + dir)
      const provenance = meta.provenance
      if (!provenance || !/^[0-9a-f]{64}$/.test(provenance.tarballSha256 ?? '')
        || !/^[^/\\]+\.tgz$/.test(provenance.tarballFile ?? '')
        || !['source-build', 'published-tarball'].includes(provenance.inputKind)) out.push('夹具缺真实产物来源/hash: ' + dir)
      if (provenance?.inputKind === 'source-build' && (!/^[0-9a-f]{40}$/.test(provenance.sourceCommit ?? '')
        || (sourceCommit && provenance.sourceCommit !== sourceCommit))) out.push('夹具源码提交与合同不符: ' + dir)
      for (const f of files) {
        if (typeof f !== 'string' || f.startsWith('/') || f.includes('\\') || f.split('/').some(part => part === '..' || part === '.')) {
          out.push('夹具文件路径不安全: ' + dir + '/' + f); continue
        }
        const path = join(fixturesDir, dir, f)
        if (!existsSync(path)) out.push('夹具文件缺席: ' + dir + '/' + f)
        else if (meta.fileSha256?.[f] !== sha256(readFileSync(path))) out.push('夹具文件实际 hash 与捕获记录不符: ' + dir + '/' + f)
      }
      if (!files.includes('package.json')) out.push('夹具缺包身份清单: ' + dir)
      else if (existsSync(join(fixturesDir, dir, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(fixturesDir, dir, 'package.json'), 'utf8'))
        if (meta.package !== pkg.name + '@' + pkg.version) out.push('夹具包身份与台账不符: ' + dir)
      }
    } else if (meta.source === 'synthetic') {
      if (!String(meta.reason ?? '').trim()) out.push(`合成夹具必须写明 reason（为什么不用真产物）: ${dir}`)
    } else if (meta.source === 'runtime-capture') {
      if (meta.engine !== baseline) out.push(`运行时夹具未随版: ${dir} engine=${meta.engine} != contract.baseline=${baseline}`)
      const files = meta.files ?? []
      if (!files.length || new Set(files).size !== files.length) out.push('运行时夹具文件集为空/重复: ' + dir)
      for (const f of files) {
        if (typeof f !== 'string' || f.startsWith('/') || f.includes('\\') || f.split('/').some(part => part === '..' || part === '.')) {
          out.push('运行时夹具文件路径不安全: ' + dir + '/' + f); continue
        }
        const path = join(fixturesDir, dir, f)
        if (!existsSync(path)) out.push('夹具文件缺席: ' + dir + '/' + f)
        else if (meta.fileSha256?.[f] !== sha256(readFileSync(path))) out.push('夹具文件实际 hash 与捕获记录不符: ' + dir + '/' + f)
      }
      if (!files.includes('package.json')) out.push('运行时夹具缺包身份清单: ' + dir)
      else if (existsSync(join(fixturesDir, dir, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(fixturesDir, dir, 'package.json'), 'utf8'))
        if (meta.package !== pkg.name + '@' + pkg.version || pkg.version !== baseline) out.push('运行时夹具包身份/版本与台账不符: ' + dir)
      }
      const provenance = meta.provenance ?? {}
      const safeLocalPath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
        && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.')
      for (const [label, path, digest] of [
        ['captureRecord', provenance.captureRecord, provenance.captureRecordSha256],
        ['evidence', provenance.evidence, provenance.evidenceSha256],
      ]) {
        if (!safeLocalPath(path) || !files.includes(path)) { out.push(`运行时夹具 ${label} 路径不安全/未登记: ${dir}`); continue }
        const absolute = join(fixturesDir, dir, path)
        if (!existsSync(absolute) || digest !== sha256(readFileSync(absolute)) || meta.fileSha256?.[path] !== digest) {
          out.push(`运行时夹具 ${label} 文件/hash 不符: ${dir}`)
        }
      }
      if (safeLocalPath(provenance.captureRecord) && existsSync(join(fixturesDir, dir, provenance.captureRecord))) {
        const record = JSON.parse(readFileSync(join(fixturesDir, dir, provenance.captureRecord), 'utf8'))
        if (record.engine !== meta.engine || record.package !== meta.package || !files.includes(record.capturedFile)
          || record.sourceSha256 !== meta.fileSha256?.[record.capturedFile]) {
          out.push(`运行时夹具捕获凭据与包/源码 hash 不符: ${dir}`)
        }
      }
    } else if (meta.source === 'superseded') {
      // 上一代夹具：只允许作为「等删除」的登记项存在，任何测试再引用它就是假绿回归。
      if (!String(meta.reason ?? '').trim()) out.push(`代弃夹具必须写明 reason: ${dir}`)
      if (meta.engine === baseline) out.push(`代弃夹具的版本等于当前基线，应改为 engine-tgz 登记: ${dir}`)
      const ref = new RegExp(`['"]${dir.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`)
      if (readdirSync(testsDir).filter((x) => x.endsWith('.test.mjs'))
        .some((f) => ref.test(readFileSync(join(testsDir, f), 'utf8')))) {
        out.push(`测试仍在引用代弃夹具（等于拿旧字节做回归）: ${dir}`)
      }
    } else out.push(`夹具 source 未知: ${dir} = ${meta.source}`)
  }
  // D scope 与实现同步：registry 缺 scope 而 IMPLS 声明 engine -> 红（issue #888）。
  //
  // 为什么必须单独判：下面的 B 段按 `patch.scope ?? 'vendor'` 过滤，缺字段的 engine 补丁
  // 会被静默当成 vendor 跳过，于是「每个 engine 补丁的目标必须恰有一份当前代真夹具」
  // 这条判据对它们根本不执行。两道门禁（registry↔IMPLS 的 id 集合校验只比 id 不比 scope）
  // 之间正好漏这一格：实测 T1/A1 两条的夹具数都是 0，而 CI 全绿。
  const implScopes = implScopeOf(readFileSync(join(HERE, 'patches', 'apply-patches.mjs'), 'utf8'))
  for (const patch of [...(registry?.patches ?? []), ...(registry?.retired ?? [])]) {
    if (patch.scope !== undefined) continue
    if (implScopes.get(patch.id) !== 'engine') continue
    out.push('registry 条目缺 scope 但实现声明 engine（会被 B 段静默跳过）: ' + patch.id)
  }
  // 多文件补丁：所有目标必须由当前代真产物提供；主文件存在不能洗绿缺席的 companion。
  for (const patch of [...(registry?.patches ?? []), ...(registry?.retired ?? [])]) {
    if ((patch.scope ?? 'vendor') !== 'engine') continue
    let targets = [patch.target, ...(patch.additionalTargets ?? [])]
    if (patch.id === 'terminal-inspector-android-D1') {
      const discovered = manifest.capture?.discoveredTargets?.[patch.id]
      const prefix = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/'
      if (!Array.isArray(discovered) || discovered.length !== 1 || !discovered[0].startsWith(prefix)
        || !/^lib\/runner-launch-[^/]+\.js$/.test(discovered[0].slice(prefix.length))) {
        out.push('D1 缺精确真实构建 chunk 发现记录'); continue
      }
      const target = discovered[0]
      const matches = Object.entries(declared).flatMap(([dir, meta]) => meta.source === 'engine-tgz' && meta.engine === baseline
        ? Object.entries(meta.targets ?? {}).filter(([, capturedTarget]) => capturedTarget === target && meta.patchIds?.includes(patch.id))
          .map(([inner]) => join(fixturesDir, dir, inner)) : [])
      const anchor = 'function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {'
      if (matches.length !== 1 || !existsSync(matches[0]) || !readFileSync(matches[0], 'utf8').includes(anchor)
        || !readFileSync(matches[0], 'utf8').includes('terminal inspection is unsupported on platform')) out.push('D1 发现记录不对应唯一真实 inspector 文件')
      targets = [...discovered, ...(patch.additionalTargets ?? [])]
    }
    for (const target of targets) {
      const captured = Object.values(declared).filter(meta => ['engine-tgz', 'runtime-capture'].includes(meta.source) && meta.engine === baseline
        && Object.entries(meta.targets ?? {}).some(([inner, capturedTarget]) => capturedTarget === target && meta.files?.includes(inner)))
      if (captured.length !== 1) out.push('登记补丁目标必须恰有一份当前真夹具: ' + patch.id + ' ' + target)
    }
  }
  // C 禁写死
  const hardcoded = /['"]fixtures['"],\s*['"][a-z0-9-]+-\d+\.\d+\.\d+[^'"]*['"]/
  for (const f of readdirSync(testsDir).filter((x) => x.endsWith('.test.mjs'))) {
    const text = readFileSync(join(testsDir, f), 'utf8')
    if (hardcoded.test(text)) out.push(`夹具路径写死版本（改走 tests/lib/fixture.mjs）: ${f}`)
  }
  return out
}

if (SELF_TEST) {
  // 反证：每条断言都必须能在被破坏时变红——否则门禁本身是假的。
  const base = mkdtempSync(join(tmpdir(), 'patch-fixtures-'))
  try {
    const mk = (name, mut, registry = null) => {
      const fx = join(base, name, 'fixtures'); const ts = join(base, name, 'tests')
      mkdirSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib'), { recursive: true })
      mkdirSync(ts, { recursive: true })
      writeFileSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib', 'index.js'), '// fixture\n')
      // Self-test-only fixture metadata; never written to the repository ledger.
      const packageBytes = JSON.stringify({ name: 'dsh-demo', version: '0.9.9-rc.1' })
      writeFileSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'package.json'), packageBytes)
      writeFileSync(join(fx, 'manifest.json'), JSON.stringify({
        fixtures: { 'dsh-demo-0.9.9-rc.1': {
          source: 'engine-tgz', engine: '0.9.9-rc.1', package: 'dsh-demo@0.9.9-rc.1',
          files: ['lib/index.js', 'package.json'],
          fileSha256: { 'lib/index.js': sha256('// fixture\n'), 'package.json': sha256(packageBytes) },
          provenance: { inputKind: 'published-tarball', tarballFile: 'self-test.tgz', tarballSha256: sha256('self-test provenance only') },
        } },
      }))
      writeFileSync(join(ts, 'demo.test.mjs'), "const FIXTURE = 'x'\n")
      mut({ fx, ts })
      return audit(fx, ts, '0.9.9-rc.1', null, registry)
    }
    const cases = [
      { label: '反证：夹具未随版判红', want: true, run: ({ fx }) => {
        const m = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8'))
        m.fixtures['dsh-demo-0.9.9-rc.1'].engine = '0.9.8-rc.1'
        writeFileSync(join(fx, 'manifest.json'), JSON.stringify(m))
      } },
      { label: '反证：真实字节 hash 漂移判红', want: true, run: ({ fx }) => {
        writeFileSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib', 'index.js'), '// different bytes\n')
      } },
      { label: '反证：丢失产物来源判红', want: true, run: ({ fx }) => {
        const m = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8'))
        delete m.fixtures['dsh-demo-0.9.9-rc.1'].provenance
        writeFileSync(join(fx, 'manifest.json'), JSON.stringify(m))
      } },
      { label: '反证：未声明目录判红', want: true, run: ({ fx }) => { mkdirSync(join(fx, 'dsh-orphan-0.9.9-rc.1'), { recursive: true }) } },
      { label: '反证：夹具文件缺席判红', want: true, run: ({ fx }) => { rmSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib', 'index.js')) } },
      { label: '反证：合成夹具无 reason 判红', want: true, run: ({ fx }) => {
        const m = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8'))
        m.fixtures['dsh-demo-0.9.9-rc.1'] = { source: 'synthetic' }
        writeFileSync(join(fx, 'manifest.json'), JSON.stringify(m))
      } },
      { label: '反证：测试里写死夹具版本判红', want: true, run: ({ ts }) => {
        writeFileSync(join(ts, 'demo.test.mjs'), "const F = join(here, 'fixtures', 'dsh-demo-0.1.5-rc.1', 'lib', 'index.js')\n")
      } },
    ]
    // 反例 8 走另一条入口：registry 缺 scope 但实现声明 engine（issue #888）。
    // 它必须由 D 段抓住——否则 B 段按 `scope ?? 'vendor'` 把这条 engine 补丁静默跳过。
    const missingScope = mk('case-scope', () => {}, {
      patches: [{ id: 'zsh-fpath-A1', target: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js' }],
    })
    check('反例 8 被抓住（反证：registry 缺 scope 而实现声明 engine）',
      missingScope.some((m) => m.includes('缺 scope 但实现声明 engine')),
      missingScope.join(' | ') || '没有判红，门禁失效')
    let i = 0
    for (const c of cases) {
      i++
      const res = mk('case' + i, c.run)
      if (c.want) check(`反例 ${i} 被抓住（${c.label}）`, res.length > 0, res.join(' | ') || '没有判红，门禁失效')
    }
    const clean = mk('clean', () => {})
    check('对照组：合规树不判红', clean.length === 0, clean.join(' | '))

    /* ── #981 取面自证：implScopeOf 的诱饵用例 ──────────────────────────────────
     * 这组用例直接打 implScopeOf（纯函数，不落盘），因为真正的缺陷就在**取面**本身：
     * 老实现按「行首第一个顶格 } 即块尾」提前 break，真实 apply-patches.mjs 里 26 处
     * `scope: 'engine'` 只认出 7 处，而门禁照旧 PASS。
     * 每个用例都要求诱饵**前后的 id 都被认出来**——只测「诱饵没把结果弄脏」不够：
     * 漏认（提前 break）与误认（把诱饵里的 scope 当条目声明）是同一枚硬币的两面。 */
    const scopeSample = (body) => 'const IMPLS = {\n' + body + '\n}\n\nconst OTHER = { x: 1 }\n'
    const decoys = [
      {
        label: '#981 诱饵：IMPLS 内含顶格 } 的模板字符串（真实成因）',
        source: scopeSample([
          "  'before-tpl': {",
          "    file: 'a.js',",
          "    apply: (s) => {",
          "      const helper = \u0060function f() {",
          "  try { return 1 } catch { return 2 }",
          "}",
          "\u0060",
          "      return s + helper",
          "    },",
          "    scope: 'engine',",
          "  },",
          "  'after-tpl': {",
          "    file: 'b.js',",
          "    scope: 'engine',",
          "  },",
        ].join('\n')),
        want: { 'before-tpl': 'engine', 'after-tpl': 'engine' },
      },
      {
        label: '#981 诱饵：单双引号里含 } 且含假 id 形状',
        source: scopeSample([
          "  'before-quote': {",
          "    file: 'a.js',",
          "    marker: \"  'fake-in-dq': {  scope: 'engine', }\",",
          "    other: '  },  }',",
          "    scope: 'engine',",
          "  },",
          "  'after-quote': {",
          "    file: 'b.js',",
          "    scope: 'engine',",
          "  },",
        ].join('\n')),
        want: { 'before-quote': 'engine', 'after-quote': 'engine' },
      },
      {
        label: '#981 诱饵：行注释与块注释里含 } 与假 scope',
        source: scopeSample([
          "  'before-comment': {",
          "    file: 'a.js',",
          "    // } 这一行注释里的右括号不算块尾，scope: 'engine' 也不算声明",
          "    /* }",
          "       } 整块注释里的 scope: 'engine'",
          "    */",
          "    scope: 'engine',",
          "  },",
          "  'after-comment': {",
          "    file: 'b.js',",
          "    scope: 'engine',",
          "  },",
        ].join('\n')),
        want: { 'before-comment': 'engine', 'after-comment': 'engine' },
      },
      {
        label: '#981 回归：嵌套（非直接条目）里的 scope 不得冒充条目声明',
        source: scopeSample([
          "  'nested-scope': {",
          "    file: 'a.js',",
          "    opts: { scope: 'vendor' },",
          "    scope: 'engine',",
          "  },",
          "  'no-scope': {",
          "    file: 'b.js',",
          "    opts: { scope: 'engine' },",
          "  },",
        ].join('\n')),
        want: { 'nested-scope': 'engine' },
        reject: ['no-scope'],
      },
    ]
    for (const c of decoys) {
      const got = implScopeOf(c.source)
      const missing = Object.entries(c.want).filter(([id, v]) => got.get(id) !== v)
      const extra = (c.reject ?? []).filter((id) => got.has(id))
      check(c.label, missing.length === 0 && extra.length === 0,
        '缺/错: ' + JSON.stringify(missing) + (extra.length > 0 ? ' 误认: ' + extra.join(',') : ''))
    }
    /* 取面与**字面计数**必须相等：这是 #981 的直接判据，也是上面诱饵用例想保住的长期不变量。 */
    {
      const src = scopeSample(["  'a': { file: 'x', scope: 'engine' },", "  'b': { file: 'y', scope: 'vendor' },"].join('\n'))
      const literal = (src.match(/\bscope\s*:\s*'[^']+'/g) ?? []).length
      const parsed = implScopeOf(src).size
      check('#981 取面完备：解析数 == 字面数（合成源）', parsed === literal, '解析 ' + parsed + ' / 字面 ' + literal)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  if (fails.length) { console.error(`SELF-TEST FAILED（${fails.length} 项）`); process.exit(1) }
  console.log('PATCH-FIXTURES SELF-TEST PASSED')
  process.exit(0)
}

const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'contract.json'), 'utf8'))
const fixturesDir = join(ROOT, 'scripts', 'patches', 'tests', 'fixtures')
const testsDir = join(ROOT, 'scripts', 'patches', 'tests')
const ledgerPresent = existsSync(join(fixturesDir, 'manifest.json'))
check('夹具台账在场', ledgerPresent, '跑 node scripts/probe-engine-anchors.mjs --fixtures 生成')

/**
 * D 段的**取面自证**（#981）：解析出的 scope 数必须等于源码里 `scope: '<v>'` 的字面出现数。
 *
 * 这条判据守的不是补丁、是**取面本身**。D 段（registry 缺 scope 而实现声明 engine）只会遍历
 * 它「看得见」的实现；取面少认一条，那条补丁对 D 段就是不存在的——而「不存在」和「没问题」
 * 在返回的 Map 里长得一模一样。所以取面必须自己先自证，否则 D 段全绿只说明取面静默。
 */
const implSource = readFileSync(join(HERE, 'patches', 'apply-patches.mjs'), 'utf8')
const implScopes = implScopeOf(implSource)
const literalScopeCount = (implSource.match(/\bscope\s*:\s*'[^']+'/g) ?? []).length
check('IMPLS 取面完备（解析出的 scope 数 == 源码字面出现数）',
  literalScopeCount > 0 && implScopes.size === literalScopeCount,
  '解析 ' + implScopes.size + ' 处 / 字面 ' + literalScopeCount + ' 处——取面漏认会让 D 段静默少判')

if (ledgerPresent) {
  for (const m of audit(fixturesDir, testsDir, contract.baseline, contract.upstream.commit,
    JSON.parse(readFileSync(join(HERE, 'patches', 'registry.json'), 'utf8')))) fails.push(m)
  check('夹具三条断言（台账完备 / 随版 / 禁写死）', fails.length === 0, fails.join(' | '))
}
if (fails.length) {
  console.error(`PATCH-FIXTURES CHECK FAILED（${fails.length} 项）`)
  process.exit(1)
}
console.log(`PATCH-FIXTURES CHECK PASSED（夹具代 ${contract.baseline}）`)
