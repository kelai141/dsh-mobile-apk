#!/usr/bin/env node
// check-api-route-auth.mjs — 0.14.0 #222 mobile-owned route inventory gate.
// D2（2026-09-25）追加「上游路由面审计」独立段：RUNTIME_ROOTS 只覆盖 mobile-owned 面，上游
// dsh/packages/** 的注册此前不在任何判据里（rc.1 的 /oauth/callback 即零判定）；见文件末段注释。
//
// Upstream WebServer checks exact routes before prefix routes and then selects the longest prefix.
// A mobile route below /api therefore bypasses client-connection unless the registration itself
// authenticates the request. This gate discovers every shipped mobile `register({ kind, path })`
// candidate across plugin/vendor sources and requires an explicit policy row. Candidate discovery is
// deliberately fail-closed: comment/string lookalikes can make the gate reject, but cannot hide a
// route. Protected rows need a local guard marker; narrow public rows need a response marker and a
// reviewed rationale.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readSnapshotRouteFiles, snapshotRouteVerdicts } from './lib/snapshot-route-auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const policyIndex = process.argv.indexOf('--policy')
// --policy 只为反证夹具留缝（把改坏的登记表指到临时副本），与 check-contract 的 --contract 同例：
// 正式链一律不传 ⇒ 反证不靠「改仓库文件再改回来」（半途被杀就留下脏树）。
const policyPath = policyIndex >= 0 && process.argv[policyIndex + 1] !== undefined
  ? String(process.argv[policyIndex + 1])
  : join(here, 'api-route-auth-policy.json')
const selfTest = process.argv.includes('--self-test')
// --require（发布链/构建链严格档）：任何 SKIP 即判红——上游树不在场时「跳过」不得冒充绿。
const REQUIRE = process.argv.includes('--require')
const snapshotIndex = process.argv.indexOf('--snapshot')
const snapshotPath = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : undefined
const failures = []
let skips = 0

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** 计数并打印一条 SKIP；--require 下同时计入失败（check-gate-skips 要求 SKIP 行带计数）。 */
function skip(message) {
  skips += 1
  console.log('SKIP(#' + skips + ')  ' + message + (REQUIRE ? ' —— --require 档不得 SKIP' : ''))
  if (REQUIRE) failures.push('SKIP: ' + message)
}

function read(relativePath) {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    check('API 路由源文件在场: ' + relativePath, false)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

/**
 * Find route registration candidates without a brittle bounded-expression regex.
 *
 * `kind` and `path` are mandatory WebRoute fields and occur before a handler body in every
 * supported registration form. Scanning to the next registration (rather than a fixed character
 * window) keeps large handlers and field order from masking a candidate.
 */
function routeRegistrations(source) {
  const found = []
  const calls = [...source.matchAll(/\bregister\s*\(\s*\{/g)]
  for (let index = 0; index < calls.length; index += 1) {
    const start = calls[index].index
    const end = calls[index + 1]?.index ?? source.length
    const objectHead = source.slice(start, end)
    const kindMatch = /\bkind\s*:\s*(['"])(exact|prefix)\1/.exec(objectHead)
    const pathMatch = /\bpath\s*:\s*([^,\n}]+)/.exec(objectHead)
    const shorthandPath = /(?:^|[,\n])\s*path\s*(?:,|\n|})/.test(objectHead)
    if (kindMatch === null || (pathMatch === null && !shorthandPath)) continue
    const pathExpression = pathMatch?.[1].trim() ?? 'path'
    const literal = /^(['"])(\/api(?:\/[^'"]*)?)\1$/.exec(pathExpression)
    found.push({ kind: kindMatch[2], pathExpression, literalPath: literal?.[2], head: objectHead, index: start })
  }
  // issue #1050 ②：register(标识符) 形式此前**完全不在扫描面**（只认对象字面量、且每条注册之间
  // 以「下一个 register」为界，标识符形态一条都看不见）。上游同名扫描器用 objectLiteralOf 解析
  // 同文件 const 定义，这里采用同一口径：解析得到对象字面量且带 kind + path 才算路由站点。
  // 解析不到的一律不算（ctx.tools.register(t) 这类循环变量/工具注册不是 WebRoute）。
  for (const call of source.matchAll(/\bregister\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const name = call[1]
    const object = objectLiteralOf(source, name)
    if (object === null) continue
    const kindMatch = /\bkind\s*:\s*(['"])(exact|prefix)\1/.exec(object)
    const pathMatch = /\bpath\s*:\s*([^,\n}]+)/.exec(object)
    const shorthandPath = /(?:^|[,\n])\s*path\s*(?:,|\n|})/.test(object)
    if (kindMatch === null || (pathMatch === null && !shorthandPath)) continue
    const pathExpression = pathMatch?.[1].trim() ?? 'path'
    const literal = /^(['"])(\/api(?:\/[^'"]*)?)\1$/.exec(pathExpression)
    found.push({
      kind: kindMatch[2],
      pathExpression,
      literalPath: literal?.[2],
      head: object + '\n' + call[0],
      index: call.index,
      viaIdentifier: name,
    })
  }
  found.sort((a, b) => a.index - b.index)
  return found
}

function dynamicRoutePathLiterals(source) {
  const paths = []
  for (const match of source.matchAll(/for\s*\(\s*const\s*\[\s*path\s*,[\s\S]*?\]\s+of\s+\[([\s\S]*?)\]\s+as\s+const\s*\)/g)) {
    for (const literal of match[1].matchAll(/(['"])(\/api(?:\/[A-Za-z0-9._~-]+)*)\1/g)) paths.push(literal[2])
  }
  return paths
}

/** Files carrying product runtime route registrations; test/data/node_modules trees are excluded. */
const RUNTIME_ROOTS = [
  { dir: 'plugins', include: (path) => path.includes('/src/') },
  { dir: 'vendor', include: (path) => path.includes('/lib/') },
  { dir: 'dsh-host-web-compat', include: (path) => path.includes('/src/') || path.includes('/lib/') },
  { dir: 'dsh-shell-termux', include: (path) => path.includes('/src/') || path.includes('/lib/') },
]
const CODE_SUFFIX = /\.(?:[cm]?js|tsx?)$/

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, files)
    else if (CODE_SUFFIX.test(name)) files.push(full)
  }
  return files
}

function discoveredRouteSources() {
  const result = new Map()
  for (const runtimeRoot of RUNTIME_ROOTS) {
    const absolute = join(root, runtimeRoot.dir)
    if (!existsSync(absolute)) continue
    for (const file of walk(absolute)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      if (!runtimeRoot.include('/' + rel)) continue
      const registrations = routeRegistrations(readFileSync(file, 'utf8'))
      if (registrations.length > 0) result.set(rel, registrations)
    }
  }
  return result
}

let policy
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'))
} catch (error) {
  console.error('CHECK-API-ROUTE-AUTH FAILED: policy parse error: ' + String(error?.message ?? error))
  process.exit(1)
}

const routes = Array.isArray(policy.routes) ? policy.routes : []
const registrations = Array.isArray(policy.routeRegistrations) ? policy.routeRegistrations : []
check('API 路由清单非空', routes.length > 0 && registrations.length > 0,
  'routes=' + routes.length + ' registrations=' + registrations.length)

const routeIds = new Set()
const routePaths = new Set()
for (const route of routes) {
  const id = typeof route.id === 'string' ? route.id : ''
  const path = typeof route.path === 'string' ? route.path : ''
  check('API 路由 id/path 合法: ' + (id || '<missing>'), id !== '' && path.startsWith('/api/'))
  check('API 路由 id 唯一: ' + (id || '<missing>'), !routeIds.has(id))
  check('API 路由 path 唯一: ' + (path || '<missing>'), !routePaths.has(path))
  routeIds.add(id)
  routePaths.add(path)

  const registrationSource = typeof route.registrationSource === 'string' ? route.registrationSource : ''
  const endpointSource = typeof route.endpointSource === 'string' ? route.endpointSource : ''
  const registration = typeof route.registration === 'string' ? route.registration : ''
  const registrationText = read(registrationSource)
  const endpointText = read(endpointSource)
  check(id + ' 注册表达式在场', registration !== '' && registrationText.includes(registration))
  check(id + ' endpoint 常量/字面量在场', endpointText.includes(path))

  if (route.access === 'protected') {
    const marker = typeof route.authMarker === 'string' ? route.authMarker : ''
    const callMarker = typeof route.authCallMarker === 'string' ? route.authCallMarker : ''
    // review §2.3（2026-09-14）收紧：guard 必须落在**该条注册的对象块内**。旧实现是文件级
    // includes——同文件里删掉某条 guard、只要别处还提一句 marker 就绿（已实测复现）。
    // 注册块在 registrationSource（register() 所在文件；endpointSource 可能是 client/contract 面）。
    // authMarker = 来源注释/函数名的文件级证据；authCallMarker = 注册块内的**调用形态**证据。
    const regs = routeRegistrations(registrationText)
    const hit = regs.find((r) => r.literalPath === path) ?? regs.find((r) => r.head.includes(registration))
    if (hit === undefined) {
      check(id + ' 受保护路由的 guard 在注册块内', false, '未在 ' + registrationSource + ' 定位到该注册的容器块')
    } else {
      // issue #1050 ①：guard 判据必须是**代码位置**的子串，不是裸 includes——
      // 一行 '// 令牌校验…tokenMatches(token(), body.token)' 就能让旧判据判绿，而 handler 零鉴权。
      // 剥离只删文本、不造文本，故最坏结果是误判红，不会把缺失的 guard 判绿。
      const cleanHead = stripSourceComments(hit.head)
      const guardPresent = callMarker !== '' && cleanHead.includes(callMarker)
      const commentOnly = !guardPresent && callMarker !== '' && hit.head.includes(callMarker)
      check(id + ' 受保护路由的 guard 在注册块内',
        marker !== '' && guardPresent,
        (callMarker === '' ? '缺 authCallMarker 声明'
          : commentOnly ? '调用形态只出现在注释里（剥注释后不在场）: ' + callMarker
            : '调用形态不在注册块内（已剥注释）: ' + callMarker))
    }
  } else if (route.access === 'public') {
    const marker = typeof route.publicResponseMarker === 'string' ? route.publicResponseMarker : ''
    const rationale = typeof route.rationale === 'string' ? route.rationale.trim() : ''
    check(id + ' 公开路由有窄响应 marker', marker !== '' && registrationText.includes(marker))
    check(id + ' 公开路由有审阅理由', rationale.length >= 30)
  } else {
    check(id + ' access 明确为 protected 或 public', false, String(route.access))
  }
}

const discovered = discoveredRouteSources()
const registrationSources = new Set()
for (const entry of registrations) {
  const sourcePath = typeof entry.source === 'string' ? entry.source : ''
  const expected = Number(entry.expected)
  const sourceRoutes = discovered.get(sourcePath) ?? []
  check('API 注册计数声明合法: ' + (sourcePath || '<missing>'), sourcePath !== '' && Number.isInteger(expected) && expected >= 0)
  check('API exact/prefix 注册数锁定: ' + sourcePath, sourceRoutes.length === expected,
    'expected=' + expected + ' actual=' + sourceRoutes.length)
  registrationSources.add(sourcePath)
}

const unlistedSources = [...discovered.keys()].filter((sourcePath) => !registrationSources.has(sourcePath)).sort()
const staleSources = [...registrationSources].filter((sourcePath) => !discovered.has(sourcePath)).sort()
check('所有 mobile-owned route registration source 均已登记', unlistedSources.length === 0,
  unlistedSources.join(', '))
check('route policy 无失效 registration source', staleSources.length === 0, staleSources.join(', '))

for (const route of routes) {
  check(route.id + ' 的 registration source 已锁定', registrationSources.has(route.registrationSource))
}

const unknownLiteralPaths = new Set()
for (const [sourcePath, sourceRoutes] of discovered) {
  for (const registration of sourceRoutes) {
    if (registration.literalPath !== undefined && registration.literalPath.startsWith('/api/') && !routePaths.has(registration.literalPath)) {
      unknownLiteralPaths.add(registration.literalPath)
    }
  }
  for (const path of dynamicRoutePathLiterals(read(sourcePath))) {
    if (!routePaths.has(path)) unknownLiteralPaths.add(path)
  }
}
check('所有直接字面量 /api 路由均已登记', unknownLiteralPaths.size === 0,
  [...unknownLiteralPaths].sort().join(', '))

// review §2.3（2026-09-14）：变量/展开/别名注册此前可整体逃逸（scanner 只认字面量 path）。现要求
// 每条非字面量 path 表达式在 policy.dynamicPathExpressions 显式声明并可核验：
//   resolvesTo        必须都是已登记 policy route；
//   literalEvidence   必须在该源文件里逐字出现（证明表达式确实解析到这些路径，且改动会踩爆门禁）。
const dynamicDecls = Array.isArray(policy.dynamicPathExpressions) ? policy.dynamicPathExpressions : []
const usedExpressions = new Set()
const unresolvedExpressions = []
for (const [sourcePath, sourceRoutes] of discovered) {
  for (const registration of sourceRoutes) {
    if (registration.literalPath !== undefined) continue
    const key = sourcePath + ' :: ' + registration.pathExpression
    usedExpressions.add(key)
    const decl = dynamicDecls.find((d) => d.source === sourcePath && d.expression === registration.pathExpression)
    if (decl === undefined) { unresolvedExpressions.push(key); continue }
    const srcText = read(sourcePath)
    const resolves = Array.isArray(decl.resolvesTo) ? decl.resolvesTo : []
    const badResolves = resolves.filter((p) => typeof p !== 'string' || !routePaths.has(p))
    const evidence = typeof decl.literalEvidence === 'string' ? decl.literalEvidence : ''
    const reason = typeof decl.reason === 'string' ? decl.reason.trim() : ''
    check('动态 path 表达式声明可核验: ' + key,
      resolves.length > 0 && badResolves.length === 0 && evidence !== '' && srcText.includes(evidence) && reason.length >= 20,
      '未登记 resolvesTo=[' + badResolves.join(', ') + ']；literalEvidence ' + (evidence === '' ? '缺' : (srcText.includes(evidence) ? '在场' : '不在源文件')) + '；reason ' + (reason.length >= 20 ? 'ok' : '过短/缺'))
  }
}
check('所有非字面量 path 表达式已声明（变量/展开注册不得逃逸）', unresolvedExpressions.length === 0,
  unresolvedExpressions.join('；'))
const staleExpressions = dynamicDecls
  .map((d) => String(d.source) + ' :: ' + String(d.expression))
  .filter((key) => !usedExpressions.has(key))
check('dynamicPathExpressions 无 stale 声明', staleExpressions.length === 0, staleExpressions.join('；'))


// ── 上游路由面审计（D2，2026-09-25）──────────────────────────────────────────
// 为什么是独立一段（而不是把 dsh/ 塞进 RUNTIME_ROOTS）：RUNTIME_ROOTS 的口径是「mobile-owned
// 出货面」——routeRegistrations 的 expected 计数、「所有 mobile-owned source 均已登记」、
// dynamicPathExpressions 三条判据都建立在该口径上。上游是 60 个包 / 6000+ 文件 / 自带测试夹具
// 的另一棵树，混进去会让这个口径失真。故上游面另起一段，各自计数、各自 SKIP。
//
// 判据三条（缺一不可）：
//   ① 正向：上游树里每条已发现的注册站点都必须在 policy.upstreamRoutes 有一条显式判定；
//   ② 反向（本段的价值所在）：上游树里**存在**而 policy 无判定的路由 ⇒ 判红并点名；
//   ③ stale：policy 有判定行而上游树里已不存在（上游删了/改名了）⇒ 判红。
// 三种判定形态：protected（注册块内的 guard 调用形态，或经 connection 载体 guardedBy）/
// public（窄响应证据 + 理由）/ not-mounted（给出本平台不挂载该行的可核验依据）。
//
// 存在性断言一律先剥注释（历史实锤：对空壳 insert / 注释掉的 guard 做裸 contains 恒真 = 假绿）；
// 剥注释只删文本、不造文本，故最坏结果是误判红，不会把缺失的 guard 判绿。
const UPSTREAM_FORMS = ['web', 'upgrade', 'fetch']
const UPSTREAM_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'tests', '__tests__', 'fixtures'])
const UPSTREAM_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/

/** 剥掉行注释与块注释，保留字符串/模板字面量内容。正则字面量里的斜杠序列可能被误剥，只会误判红。 */
function stripSourceComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const c = source[index]
    const next = source[index + 1]
    if (c === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue }
    if (c === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (c === '"' || c === "'" || c === '\u0060') {
      const quote = c
      out += c
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') { out += source[index] + (source[index + 1] ?? ''); index += 2; continue }
        out += source[index]
        const closed = source[index] === quote
        index += 1
        if (closed) break
      }
      continue
    }
    out += c
    index += 1
  }
  return out
}

/** openIndex 处 { 或 ( 起配平组的文本（跳过字符串）；未配平返回 null。 */
function balancedGroup(source, openIndex) {
  const open = source[openIndex]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  let index = openIndex
  while (index < source.length) {
    const c = source[index]
    if (c === '"' || c === "'" || c === '\u0060') {
      const quote = c
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        const closed = source[index] === quote
        index += 1
        if (closed) break
      }
      continue
    }
    if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, index + 1)
    }
    index += 1
  }
  return null
}

/** 文件里 const|let|var name = { … } 的对象字面量文本；缺失或非对象返回 null。 */
function objectLiteralOf(source, name) {
  const pattern = new RegExp('(?:const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*(?::[^=]+)?=\\s*\\{')
  const match = pattern.exec(source)
  if (match === null) return null
  return balancedGroup(source, source.indexOf('{', match.index + match[0].length - 1))
}

/** 把一个注册实参对象描述成站点：kind / path 表达式 / 字面量 / 容器块文本。 */
function describeUpstreamSite(form, block, via) {
  const kind = /\bkind\s*:\s*(['"])(exact|prefix)\1/.exec(block)?.[2]
  const match = /\bpath\s*:\s*([^,\n}]+)/.exec(block)
  const shorthand = /(?:^|[{,\n])\s*path\s*(?:,|\n|})/.test(block)
  const expression = match === null ? (shorthand ? 'path' : undefined) : match[1].trim()
  const literal = expression === undefined ? undefined : /^(['"])(\/[^'"]*)\1$/.exec(expression)?.[2]
  return { form, kind, expression, literal, via, block }
}

/**
 * 上游一个文件里的全部路由注册站点。
 * 三类：.webServer.register({...}) / .webServer.register(标识符) / .webServer.registerUpgrade({...})
 * （WebServer 具名 HTTP 路由与 upgrade 路由）与 .connection.fetch.register({...})（Connection 共享
 * carrier 的精确 Fetch 面）。走到下一个站点而不是固定窗口，使大 handler 与字段顺序不构成遮蔽。
 * 字符串里的注册形态照样计为站点（fail-closed：可以误拒，不能藏路由），注释里的不算（注释不执行）。
 */
function scanUpstreamRouteSites(source) {
  const clean = stripSourceComments(source)
  const calls = []
  for (const call of clean.matchAll(/\.\s*(registerUpgrade|register)\s*\(/g)) {
    const receiver = clean.slice(Math.max(0, call.index - 80), call.index)
    if (!/(?:^|[^\w$])[Ww]ebServer\s*$/.test(receiver)) continue
    calls.push({ form: call[1] === 'registerUpgrade' ? 'upgrade' : 'web', start: call.index, open: call.index + call[0].length - 1 })
  }
  for (const call of clean.matchAll(/\.\s*fetch\s*\.\s*register\s*\(/g)) {
    calls.push({ form: 'fetch', start: call.index, open: call.index + call[0].length - 1 })
  }
  calls.sort((a, b) => a.start - b.start)
  return calls.map((call) => {
    const group = balancedGroup(clean, call.open)
    if (group === null) return { form: call.form, unresolved: '调用实参未配平' }
    if (!/^\(\s*\{/.test(group)) {
      const name = /^\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(group)?.[1]
      const object = name === undefined ? null : objectLiteralOf(clean, name)
      if (object === null) return { form: call.form, unresolved: name === undefined ? '实参不是对象字面量' : '变量 ' + name }
      return describeUpstreamSite(call.form, object, name)
    }
    return describeUpstreamSite(call.form, group, undefined)
  })
}

/** 站点/判定的稳定键：上游根相对路径 加 形态 加 path 表达式。 */
function upstreamSiteKey(source, site) {
  return source + ' :: ' + site.form + ' :: ' + (site.expression === undefined ? '<未解析>' : site.expression)
}

/** profile patch 里顶层（缩进 0）带 disabled: true 的行 id。 */
function profileDisabledRowIds(text) {
  const ids = new Set()
  let current
  let disabled = false
  const flush = () => { if (current !== undefined && disabled) ids.add(current) }
  for (const line of text.split(/\r?\n/)) {
    const top = /^- id:\s*(\S+)\s*$/.exec(line)
    if (top !== null) { flush(); current = top[1]; disabled = false; continue }
    if (/^- /.test(line)) { flush(); current = undefined; disabled = false; continue }
    if (current !== undefined && /^\s+disabled:\s*true\s*$/.test(line)) disabled = true
  }
  flush()
  return ids
}

/**
 * 一条上游判定行的全部问题（空数组 = 通过）。
 * bundleRows / disabledRowIds / bundleTexts 为 null 表示对应对端面不可得（调用方已计 SKIP），跳过该项证据。
 */
function upstreamVerdictIssues(row, context) {
  const issues = []
  const verdict = row.verdict
  const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : ''
  if (evidence.length < 30) issues.push('evidence 少于 30 字（判定理由不可审阅）')
  if (row.kind !== undefined && row.kind !== context.site.kind) {
    issues.push('kind 漂移: 声明=' + String(row.kind) + ' 实扫=' + String(context.site.kind))
  }
  if (row.kind === undefined && context.site.kind !== undefined) {
    issues.push('登记缺 kind（上游现为 ' + context.site.kind + '）')
  }
  if (context.site.literal !== undefined && row.pathText !== context.site.literal) {
    issues.push('pathText 与上游字面量不一致: 声明=' + String(row.pathText) + ' 实扫=' + context.site.literal)
  }
  if (context.site.literal === undefined && typeof row.pathText === 'string' && row.pathText !== '') {
    const evidenceFile = typeof row.pathEvidence?.file === 'string' ? row.pathEvidence.file : ''
    const marker = typeof row.pathEvidence?.marker === 'string' ? row.pathEvidence.marker : ''
    const pathText = evidenceFile === '' ? null : context.evidenceText(evidenceFile)
    if (pathText === null) issues.push('pathEvidence.file 取不到: ' + (evidenceFile || '<缺>'))
    else if (marker === '' || !pathText.includes(marker)) {
      issues.push('pathEvidence.marker 不在 ' + evidenceFile + '（无法证明表达式解析到 ' + row.pathText + '）')
    }
  }
  if (row.pathText === null) {
    const reason = typeof row.dynamicPathReason === 'string' ? row.dynamicPathReason.trim() : ''
    if (reason.length < 30) issues.push('pathText 为 null 时必须给 dynamicPathReason（>=30 字，说明路径为何不是构建期常量）')
  }
  const bundleRowId = typeof row.bundleRowId === 'string' ? row.bundleRowId.trim() : ''
  if (verdict === 'protected') {
    const guardedBy = typeof row.guardedBy === 'string' ? row.guardedBy : ''
    if (guardedBy !== '') {
      const carrier = context.rowsByKey.get(guardedBy)
      if (carrier === undefined) issues.push('guardedBy 指向未登记的上游站点: ' + guardedBy)
      else if (carrier.verdict !== 'protected') issues.push('guardedBy 指向的载体不是 protected: ' + guardedBy)
      else if (typeof carrier.guardedBy === 'string' && carrier.guardedBy !== '') issues.push('guardedBy 不得链式（载体自身还靠 guardedBy）: ' + guardedBy)
    } else {
      const marker = typeof row.authMarker === 'string' ? row.authMarker.trim() : ''
      const callMarker = typeof row.authCallMarker === 'string' ? row.authCallMarker.trim() : ''
      if (marker === '' || !context.sourceText.includes(marker)) issues.push('authMarker 不在（已剥注释的）源文件: ' + (marker || '<缺>'))
      if (callMarker === '' || !context.blockText.includes(callMarker)) {
        issues.push('authCallMarker 不在注册块内（已剥注释）: ' + (callMarker || '<缺>'))
      }
    }
    // 行面证据：该判定指向的上游 bundle 行必须真的存在（上游改名/删行后判定即悬空）。
    if (context.bundleRows !== null && (bundleRowId === '' || !context.bundleRows.has(bundleRowId))) {
      issues.push('bundleRowId 未命中上游 base/web-app bundle 行: ' + (bundleRowId || '<缺>'))
    }
  } else if (verdict === 'public') {
    const marker = typeof row.publicResponseMarker === 'string' ? row.publicResponseMarker.trim() : ''
    if (marker === '' || !context.sourceText.includes(marker)) issues.push('publicResponseMarker 不在（已剥注释的）源文件: ' + (marker || '<缺>'))
    if (context.bundleRows !== null && (bundleRowId === '' || !context.bundleRows.has(bundleRowId))) {
      issues.push('bundleRowId 未命中上游 base/web-app bundle 行: ' + (bundleRowId || '<缺>'))
    }
  } else if (verdict === 'not-mounted') {
    const disabledRowId = typeof row.disabledRowId === 'string' ? row.disabledRowId.trim() : ''
    const packageName = typeof row.packageName === 'string' ? row.packageName.trim() : ''
    if ((disabledRowId === '') === (packageName === '')) {
      issues.push('not-mounted 必须且只能给一项依据: disabledRowId（profile patch 顶层禁用行）或 packageName（不在任何上游 bundle 行）')
    } else if (disabledRowId !== '') {
      // 禁用行依据优先在**本树** profile patch 里核验；该文件缺席（apk 自包含面）时退到上游 bundle 行面。
      if (context.disabledRowIds !== null && !context.disabledRowIds.has(disabledRowId)) {
        issues.push('disabledRowId 不是 profile patch 的顶层禁用行: ' + disabledRowId)
      } else if (context.disabledRowIds === null && context.bundleRows !== null && !context.bundleRows.has(disabledRowId)) {
        issues.push('profile patch 不在场且 disabledRowId 未命中上游 bundle 行: ' + disabledRowId)
      }
    } else if (context.bundleTexts !== null) {
      const hit = context.bundleTexts.some((text) => text.includes(packageName))
      if (hit) issues.push('packageName 出现在上游 bundle patch 里（该行可被装配挂载）: ' + packageName)
    }
  } else {
    issues.push('verdict 必须是 protected / public / not-mounted，实为 ' + String(verdict))
  }
  return issues
}

{
  const upstreamIndex = process.argv.indexOf('--upstream')
  const upstreamOverride = upstreamIndex >= 0 ? String(process.argv[upstreamIndex + 1] ?? '') : ''
  console.log('== 上游路由面审计（D2：上游新长出的注册面必须被显式判定一次；独立于 mobile-owned 口径）==')
  const upstreamDeclared = Array.isArray(policy.upstreamRoutes) ? policy.upstreamRoutes : []
  const contractPath = join(here, 'contract.json')
  let upstreamRepo = upstreamOverride
  let contractRead = true
  if (upstreamRepo === '') {
    if (!existsSync(contractPath)) contractRead = false
    else {
      try { upstreamRepo = String(JSON.parse(readFileSync(contractPath, 'utf8')).upstreamRepo ?? '') }
      catch (error) { contractRead = false; check('上游路由面: scripts/contract.json 可解析', false, String(error?.message ?? error)) }
    }
  }
  const upstreamDir = upstreamRepo === '' ? '' : join(root, upstreamRepo)
  const upstreamPresent = contractRead && upstreamRepo !== ''
    && existsSync(join(upstreamDir, 'package.json')) && existsSync(join(upstreamDir, 'packages'))
  if (!upstreamPresent) {
    skip('上游路由面未执行: '
      + (contractRead
        ? '上游树 ' + upstreamRepo + '/ 不在场（只读 checkout；apk 自包含树不含）'
        : 'scripts/contract.json 不在场或不可解析（上游树根无从解析）')
      + ' —— policy 里 ' + upstreamDeclared.length + ' 条判定行未核验，0 条上游站点进入判据')
  } else {
    // 发现面与 mobile-owned 面一致：上游 packages/**/src/** 的产品源码。tests/__tests__/fixtures 与
    // *.spec.* / *.test.* 是测试夹具（apps/desktop/scripts/smoke-runtime.ts 的 /desktop-smoke 亦属
    // 该面），它们不是装配进我们 profile 的产品注册面。
    const sources = new Map()
    for (const file of walk(join(upstreamDir, 'packages'))) {
      const rel = relative(upstreamDir, file).replace(/\\/g, '/')
      if (rel.split('/').some((segment) => UPSTREAM_EXCLUDED_DIRS.has(segment))) continue
      if (!rel.includes('/src/')) continue
      if (UPSTREAM_TEST_FILE.test(rel)) continue
      const text = readFileSync(file, 'utf8')
      if (!text.includes('register')) continue
      const sites = scanUpstreamRouteSites(text)
      if (sites.length > 0) sources.set(rel, { text, sites })
    }
    const scan = []
    for (const [rel, entry] of sources) {
      const cleanText = stripSourceComments(entry.text)
      const seen = new Map()
      for (const site of entry.sites) {
        const key = upstreamSiteKey(rel, site)
        const occurrence = (seen.get(key) ?? 0) + 1
        seen.set(key, occurrence)
        scan.push({
          key: occurrence === 1 ? key : key + ' #' + occurrence,
          source: rel,
          site,
          sourceText: cleanText,
          blockText: typeof site.block === 'string' ? site.block : '',
        })
      }
    }
    // 树在场却一条站点都没枚举到 = 扫描形态与上游不符，拒绝按空集继续判（否则整段恒绿）。
    check('上游路由面: 站点枚举非空', scan.length > 0, 'sources=' + sources.size + ' sites=0')

    const bundleRows = new Set()
    const bundleTexts = []
    for (const bundle of ['base', 'web-app']) {
      const patchPath = join(upstreamDir, 'packages', 'bundle', bundle, 'cordis.patch.yml')
      if (!existsSync(patchPath)) continue
      const text = readFileSync(patchPath, 'utf8')
      bundleTexts.push(text)
      for (const match of text.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9@/._-]+)/gm)) bundleRows.add(match[1])
    }
    if (bundleTexts.length !== 2) skip('上游路由面 bundle 行面依据不完整: base/web-app cordis.patch.yml 未同时在场')

    const profilePatchPath = join(root, 'scripts', 'profile-web.cordis.patch.yml')
    const disabledRowIds = existsSync(profilePatchPath) ? profileDisabledRowIds(readFileSync(profilePatchPath, 'utf8')) : null
    if (disabledRowIds === null) skip('上游路由面 not-mounted 的禁用行依据未执行: scripts/profile-web.cordis.patch.yml 不在场')

    if (upstreamDeclared.length === 0) {
      check('上游路由面: policy.upstreamRoutes 已登记', false,
        '零判定行 —— 上游 ' + scan.length + ' 条注册站点全部无判定，正是本段要关闭的盲区')
    }

    const declaredKeys = new Set()
    const rowsByKey = new Map()
    for (const row of upstreamDeclared) {
      const valid = typeof row.source === 'string' && row.source !== '' && UPSTREAM_FORMS.includes(row.form)
        && typeof row.expression === 'string' && row.expression !== ''
      const key = valid
        ? upstreamSiteKey(row.source, { form: row.form, expression: row.expression })
        : '<非法判定行: ' + JSON.stringify(row.source ?? null) + ' / ' + String(row.form) + ' / ' + String(row.expression) + '>'
      check('上游路由面判定行键合法: ' + key, valid)
      if (declaredKeys.has(key)) check('上游路由面判定行键唯一: ' + key, false)
      declaredKeys.add(key)
      rowsByKey.set(key, row)
    }

    const scannedKeys = new Set(scan.map((entry) => entry.key))
    const undeclared = scan.filter((entry) => !declaredKeys.has(entry.key))
    const staleKeys = [...declaredKeys].filter((key) => !scannedKeys.has(key))
    // 反向断言（本段的价值所在）：上游**存在**的注册站点必须在 policy 里有显式判定。
    check('上游路由面: 上游存在的注册站点均已显式判定（反向断言）', undeclared.length === 0,
      undeclared.length === 0
        ? undefined
        : undeclared.map((entry) => entry.key).join('；')
          + ' —— 每条要么给 guard / 窄响应证据，要么显式记 not-mounted 并给不挂载依据')
    check('上游路由面: policy 判定行无 stale（上游已删/改名 ⇒ 判定悬空）', staleKeys.length === 0,
      staleKeys.length === 0 ? undefined : staleKeys.join('；') + ' —— 判定行不再指向任何真实注册')

    const evidenceCache = new Map()
    for (const entry of scan) {
      const row = rowsByKey.get(entry.key)
      if (row === undefined) continue
      const context = {
        site: entry.site,
        sourceText: entry.sourceText,
        blockText: entry.blockText,
        bundleRows: bundleTexts.length === 2 ? bundleRows : null,
        bundleTexts: bundleTexts.length === 2 ? bundleTexts : null,
        disabledRowIds,
        rowsByKey,
        evidenceText: (evidenceFile) => {
          if (evidenceCache.has(evidenceFile)) return evidenceCache.get(evidenceFile)
          const absolute = join(upstreamDir, evidenceFile)
          const text = existsSync(absolute) ? stripSourceComments(readFileSync(absolute, 'utf8')) : null
          evidenceCache.set(evidenceFile, text)
          return text
        },
      }
      const issues = upstreamVerdictIssues(row, context)
      check('上游判定: ' + entry.key + ' [' + String(row.verdict) + ']', issues.length === 0, issues.join('；'))
    }
    console.log('上游路由面: sources=' + sources.size + ' sites=' + scan.length + ' 判定行=' + upstreamDeclared.length
      + ' 未判定=' + undeclared.length + ' stale=' + staleKeys.length)
  }
}

// Source/lib checks prove intent; this optional strict face proves the actual injected package files
// still contain the guards after snapshot assembly. Both shipped profiles are checked because a
// missing member in one profile otherwise manifests only as a device-side loader failure.
if (snapshotIndex >= 0 && snapshotPath === undefined) {
  check('--snapshot 参数完整', false, '缺少 tar 路径')
} else if (snapshotPath !== undefined) {
  check('post-injection route-auth snapshot 在场', existsSync(snapshotPath), snapshotPath)
  const artifactMarkers = [
    ['dsh-undo-savepoint/lib/index.js', 'dsh-mobile undo route auth (U1)'],
    ['dshmarketplace-plugin/lib/index.js', 'dsh-mobile marketplace route auth (U2)'],
    ['@dsh-android/dsh-android-bridge/lib/route-auth.js', 'authorizeMobileRoute'],
    ['@dsh-android/dsh-android-linux-env/lib/index.js', 'authorizeMobileRoute(req, authOptions())'],
    ['@dsh-android/dsh-android-file-open/lib/route-auth.js', 'authorizeMobileRoute'],
    ['@dsh-android/dsh-android-file-open/lib/index.js', "path: '/api/android/file-incoming/content'"],
    ['@dsh-android/dsh-android-browser/lib/index.js', 'if (connection !== undefined)'],
    ['@dsh-android/dsh-host-web-compat/lib/index.js', "const authorized = (req) => token !== ''"],
  ]
  if (existsSync(snapshotPath)) {
    try {
      const manifest = JSON.parse(readFileSync(join(here, 'plugin-dirs.json'), 'utf8'))
      const retiredPackages = new Set((manifest.retiredExternals ?? []).map(dir =>
        JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name))
      const members = ['web', 'headless'].flatMap(profile => [
        'home/.dsh/profiles/' + profile + '/cordis.patch.yml',
        ...artifactMarkers.map(([path]) => 'home/.dsh/profiles/' + profile + '/node_modules/' + path),
      ])
      const files = readSnapshotRouteFiles(snapshotPath, members)
      for (const verdict of snapshotRouteVerdicts(files, artifactMarkers, retiredPackages)) {
        check('post-injection marker: ' + verdict.label, verdict.ok, verdict.detail)
      }
    } catch (error) {
      check('post-injection route-auth archive readable', false, error.message)
    }
  }
}

if (selfTest) {
  const artifactTests = spawnSync(process.execPath, ['--test', join(here, 'check-api-route-auth-artifact.test.mjs')], { stdio: 'inherit' })
  check('self-test: artifact route marker ownership and retired package boundaries', artifactTests.status === 0)
  const longBody = 'x'.repeat(1024)
  const reordered = 'server.register({ path: "/api/self-test-unlisted", handler: () => ({ note: "' + longBody + '" }), kind: "exact" })'
  const commented = '/* server.register({ kind: "exact", path: "/api/commented-fake" }) */\nconst text = "server.register({ kind: \'prefix\', path: \'/api/string-fake\' })"'
  const reorderedRoutes = routeRegistrations(reordered)
  check('self-test: scanner handles path-before-kind and long handlers',
    reorderedRoutes.length === 1 && reorderedRoutes[0].kind === 'exact' && reorderedRoutes[0].literalPath === '/api/self-test-unlisted')
  check('self-test: comment/string-like candidate fails closed instead of hiding a route', routeRegistrations(commented).length === 2)
  check('self-test: unlisted source/path would be rejected',
    !registrationSources.has('plugins/new-runtime/src/index.ts') && !routePaths.has('/api/self-test-unlisted'))
  // #1050 ②：register(标识符) 形式的注册必须在扫描面内（同文件 const 对象字面量可解析）
  const viaIdentifierSource = [
    "const LEAK_ROUTE = { kind: 'exact', path: '/api/android/control/leak' }",
    'webServer.register(LEAK_ROUTE)',
  ].join('\n')
  const viaIdentifier = routeRegistrations(viaIdentifierSource)
  check('self-test(#1050②): register(标识符) 解析到同文件 const 对象字面量',
    viaIdentifier.length === 1 && viaIdentifier[0].literalPath === '/api/android/control/leak'
      && viaIdentifier[0].viaIdentifier === 'LEAK_ROUTE' && viaIdentifier[0].kind === 'exact')
  check('self-test(#1050②): 解析不到的标识符（ctx.tools.register(t) 这类）不算路由站点',
    routeRegistrations('for (const t of tools()) ctx.tools.register(t)').length === 0
      && routeRegistrations('ctx.tools.register({ name: "android_ui_dump" })').length === 0)
  // #1050 ①：guard 判据必须剥注释——注释里那句调用形态不得冒充 handler 内的鉴权
  const commentedGuardHead = "{ kind: 'exact', path: '/api/x', handler: (req, body) => {\n  // tokenMatches(token(), body.token) 临时下线待观察\n  return ok(body)\n} }"
  const realGuardHead = "{ kind: 'exact', path: '/api/x', handler: (req, body) => {\n  if (!tokenMatches(token(), body.token)) return denied()\n} }"
  check('self-test(#1050①): 注释掉的 guard 不算「注册块内 guard」',
    stripSourceComments(commentedGuardHead).includes('tokenMatches(token(), body.token)') === false
      && commentedGuardHead.includes('tokenMatches(token(), body.token)') === true)
  check('self-test(#1050①): 真实 guard 调用仍判在场',
    stripSourceComments(realGuardHead).includes('tokenMatches(token(), body.token)') === true)
  // D2 上游路由面审计的反证夹具（全部走本段的纯函数，不碰仓库文件）。
  const upstreamFixture = [
    "const ROUTE = { kind: 'exact', path: '/api/upstream-fixture' }",
    'ctx.webServer.register(ROUTE)',
    "webServer.register({ kind: 'prefix', path: PATH_CONST })",
    "ctx.connection.fetch.register({ path: FETCH_CONST, methods: ['GET'] })",
    "/* webServer.register({ kind: 'exact', path: '/api/commented' }) */",
  ].join('\n')
  const fixtureSites = scanUpstreamRouteSites(upstreamFixture)
  check('self-test(上游): 变量实参可解析到注册块（register(ROUTE)）',
    fixtureSites.length === 3
      && fixtureSites[0].literal === '/api/upstream-fixture'
      && fixtureSites[0].kind === 'exact'
      && fixtureSites[0].via === 'ROUTE')
  check('self-test(上游): 注释掉的注册不算站点（剥注释生效）',
    fixtureSites.every((site) => site.literal !== '/api/commented')
      && !stripSourceComments("/* webServer.register({ kind: 'exact', path: '/api/commented' }) */").includes('/api/commented'))
  check('self-test(上游): connection.fetch carrier 计入站点', fixtureSites.some((site) => site.form === 'fetch'))
  check('self-test(上游): 剥注释后 guard 存在性断言不再被注释满足',
    stripSourceComments("// if (!authorize(req)) return\nhandler(req)").includes('!authorize(req)') === false
      && stripSourceComments('const s = "if (!authorize(req))"').includes('!authorize(req)'))
  const fixtureSource = "webServer.register({ kind: 'exact', path: '/api/fixture', handler: (req) => { if (!authorize(req)) return } })"
  const fixtureBundleTexts = ["- insert:\n    - id: fixture-row\n      name: '@scope/fixture'"]
  const verdictContext = () => ({
    site: { form: 'web', kind: 'exact', expression: "'/api/fixture'", literal: '/api/fixture' },
    sourceText: fixtureSource,
    blockText: fixtureSource,
    bundleRows: new Set(['fixture-row']),
    bundleTexts: fixtureBundleTexts,
    disabledRowIds: new Set(['fixture-disabled']),
    rowsByKey: new Map(),
    evidenceText: () => "export const FIXTURE_PATH = '/api/fixture'",
  })
  const goodRow = { verdict: 'protected', kind: 'exact', pathText: '/api/fixture', authMarker: '!authorize(req)', authCallMarker: '!authorize(req)', bundleRowId: 'fixture-row', evidence: 'x'.repeat(40) }
  check('self-test(上游): 合法 protected 判定通过', upstreamVerdictIssues(goodRow, verdictContext()).length === 0)
  check('self-test(上游): guard 证据改错即判红（反证③的判据）',
    upstreamVerdictIssues({ ...goodRow, authCallMarker: '!authorizeWrong(req)' }, verdictContext()).length > 0)
  check('self-test(上游): 空注册块时 callMarker 不再恒真',
    upstreamVerdictIssues(goodRow, { ...verdictContext(), blockText: '' }).length > 0)
  check('self-test(上游): bundle 行 id 漂移即判红',
    upstreamVerdictIssues({ ...goodRow, bundleRowId: 'renamed-row' }, verdictContext()).length > 0)
  check('self-test(上游): kind 漂移即判红',
    upstreamVerdictIssues({ ...goodRow, kind: 'prefix' }, verdictContext()).length > 0)
  check('self-test(上游): 非字面量表达式缺 pathEvidence 即判红',
    upstreamVerdictIssues({ ...goodRow, pathEvidence: undefined },
      { ...verdictContext(), site: { form: 'web', kind: 'exact', expression: 'FIXTURE_PATH' } }).length > 0)
  check('self-test(上游): public 缺窄响应 marker 即判红',
    upstreamVerdictIssues({ verdict: 'public', kind: 'exact', pathText: '/api/fixture', bundleRowId: 'fixture-row', evidence: 'x'.repeat(40) }, verdictContext()).length > 0)
  check('self-test(上游): not-mounted 的 disabledRowId 必须是 profile 顶层禁用行',
    upstreamVerdictIssues({ verdict: 'not-mounted', kind: 'exact', pathText: '/api/fixture', disabledRowId: 'not-a-disabled-row', evidence: 'x'.repeat(40) }, verdictContext()).length > 0
      && upstreamVerdictIssues({ verdict: 'not-mounted', kind: 'exact', pathText: '/api/fixture', disabledRowId: 'fixture-disabled', evidence: 'x'.repeat(40) }, verdictContext()).length === 0)
  check('self-test(上游): not-mounted 的 packageName 必须不在上游 bundle 里',
    upstreamVerdictIssues({ verdict: 'not-mounted', kind: 'exact', pathText: '/api/fixture', packageName: '@scope/fixture', evidence: 'x'.repeat(40) }, verdictContext()).length > 0
      && upstreamVerdictIssues({ verdict: 'not-mounted', kind: 'exact', pathText: '/api/fixture', packageName: '@scope/not-mounted', evidence: 'x'.repeat(40) }, verdictContext()).length === 0)
  check('self-test(上游): profile 顶层禁用行解析（缩进 0 + 同块 disabled: true）',
    profileDisabledRowIds("- id: a\n  disabled: true\n- insert:\n    - id: b\n      disabled: true\n- id: c\n  disabled: false\n").size === 1
      && profileDisabledRowIds("- id: a\n  disabled: true\n- insert:\n    - id: b\n      disabled: true\n- id: c\n  disabled: false\n").has('a'))
}

console.log('SKIP=' + skips)

if (failures.length > 0) {
  console.error('CHECK-API-ROUTE-AUTH FAILED (' + failures.length + '): ' + failures.join('; '))
  process.exit(1)
}
console.log('CHECK-API-ROUTE-AUTH PASSED (routes=' + routes.length + ', registrations=' + registrations.length + ', discovered=' + discovered.size + ', SKIP=' + skips + ')')
