// check-contract.mjs — adapter-layer contract point check (core M1.4 adapter chain check).
// Consumes scripts/contract.json; any broken point → non-zero exit + report. Usage: node scripts/check-contract.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const contract = JSON.parse(readFileSync(join(root, 'scripts/contract.json'), 'utf8'))
const issues = []
const ok = (msg) => console.log('  OK  ' + msg)
const fail = (msg) => { issues.push(msg); console.log('  FAIL ' + msg) }

function dtsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...dtsFiles(p))
    else if (p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

console.log('== 1. bundle 行引用 ==')
for (const row of contract.rows) {
  const patchFile = join(root, contract.upstreamRepo, 'packages/bundle', row.bundle, 'cordis.patch.yml')
  if (!existsSync(patchFile)) { fail('bundle patch 缺失: ' + patchFile); continue }
  const text = readFileSync(patchFile, 'utf8')
  const hit = text.split('\n').find(l => l.trim() === '- id: ' + row.id)
  if (hit === undefined) fail('行 ' + row.id + ' 在上游 ' + row.bundle + ' bundle 中不存在（patch 静默失效风险）')
  else ok('行 ' + row.id + ' @ ' + row.bundle + ' 存在')
}

console.log('== 2. 插入行包存在（仓库 + 构建产物） ==')
for (const ins of contract.inserted) {
  const repo = join(root, ins.repo)
  if (!existsSync(join(repo, 'package.json'))) fail('仓库缺失: ' + ins.repo)
  else ok('仓库 ' + ins.repo + ' 存在')
  const built = existsSync(join(repo, 'lib/index.js')) || existsSync(join(repo, 'lib/client.js'))
  if (!built) fail(ins.repo + ' 未构建（lib/ 缺失）')
  else ok(ins.repo + ' lib/ 已构建')
}

console.log('== 3. 继承符号（基线 node_modules 类型面） ==')
const baseline = join(root, contract.symbols[0].repo, 'node_modules/@deepseek-ai')
for (const sym of contract.symbols) {
  const typesDir = join(baseline, sym.pkg, 'lib/types')
  if (!existsSync(typesDir)) { fail('基线缺失 ' + sym.pkg + '/lib/types（先 npm install）'); continue }
  const found = dtsFiles(typesDir).some(f => readFileSync(f, 'utf8').includes(sym.symbol))
  if (found) ok(sym.pkg + ': ' + sym.symbol)
  else fail(sym.pkg + ': 符号 ' + sym.symbol + ' 不在基线类型面（继承面断裂）')
}

// 0.2.0 起注入层不再替换上游框架：它组合进上游的座位，绝不注册 'root'。
console.log('== 4. 客户端槽位声明（组合面，非框架替换） ==')
const slotText = readFileSync(join(root, contract.clientSlots.repo, 'src/client/index.ts'), 'utf8')
for (const slot of contract.clientSlots.slots) {
  if (slotText.includes("'" + slot + "'")) ok('槽位 ' + slot + ' 已组合')
  else fail('槽位 ' + slot + ' 未组合')
}
if (contract.clientSlots.ownRoot === false) {
  if (/name:\s*'root'/.test(slotText)) fail("注入层注册了 'root' 槽（框架替换回归）")
  else ok("未注册 'root' 槽（上游 ui-layout 持有框架）")
}
if (contract.clientSlots.enabledRow !== undefined) {
  const patchText = readFileSync(join(root, 'scripts/profile-web.cordis.patch.yml'), 'utf8')
  const disabled = new RegExp('- id:\\s*' + contract.clientSlots.enabledRow + '\\s*\\n\\s*disabled:\\s*true').test(patchText)
  if (disabled) fail('profile patch 禁用了 ' + contract.clientSlots.enabledRow + '（0.1.5 起为布局服务中枢，禁用即会话与左栏同时失效）')
  else ok('profile patch 保留 ' + contract.clientSlots.enabledRow + ' 启用')
}

console.log('== 5. 环境契约键 ==')
const envText = readFileSync(join(root, contract.envContract.repo, 'src/index.ts'), 'utf8')
for (const key of contract.envContract.keys) {
  if (envText.includes(key)) ok('环境键 ' + key + ' 注入')
  else fail('环境键 ' + key + ' 未注入')
}

console.log('== 6. 版本钉（package.json vs contract.json；覆盖面 = scripts/plugin-dirs.json） ==')
// 覆盖清单（0.13.8-b ST-06 / F-ENV-05）：注入集单一常量的每个包都必须登记进 contract.inserted，
// 否则「peer 版本钉」对它们没有覆盖面（契约少登记一个包 = 该包的钉永远不被检查）。
const pluginManifest = JSON.parse(readFileSync(join(root, 'scripts', 'plugin-dirs.json'), 'utf8'))
const insertedRepos = new Set(contract.inserted.map(i => i.repo))
const uncovered = pluginManifest.dirs.filter(d => !insertedRepos.has(d))
if (uncovered.length > 0) fail('注入集未登记进 contract.inserted（版本钉无覆盖面）: ' + uncovered.join(', '))
else ok('注入集 ' + pluginManifest.dirs.length + ' 个包全部登记在 contract.inserted')

// 版本钉两面（devDependencies + peerDependencies）都要钉：只看 dev 会漏掉「发布面钉旧版」。
// 说明符允许 ^/~ 前缀（区间语义仍指向同一版本），其余严格等值。
const norm = (spec) => String(spec).replace(/^[\^~]/, '')
const expectedPin = (dep) => dep === '@deepseek-ai/cordis' ? contract.cordis
  : dep === '@deepseek-ai/schemastery' ? contract.schemastery
  : contract.baseline // @deepseek-ai/dsh-*
const isPinnedDep = (dep) => dep.startsWith('@deepseek-ai/dsh-')
  || dep === '@deepseek-ai/cordis' || dep === '@deepseek-ai/schemastery'
const deviations = (repo) => {
  const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
  const out = new Set()
  for (const [dep, spec] of Object.entries({ ...(pkg.peerDependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
    if (!isPinnedDep(dep)) continue
    if (norm(spec) !== norm(expectedPin(dep))) out.add(dep + '@' + norm(spec))
  }
  return out
}
// 未对齐的显式声明（scripts/contract-pin-gaps.json）：§8.4 要求先对齐基线再扩门禁，
// 声明期内在场 = 红-able；对齐后条目变 stale 也会红，必须删除。
const gapsPath = join(root, 'scripts', 'contract-pin-gaps.json')
const pinGaps = existsSync(gapsPath) ? (JSON.parse(readFileSync(gapsPath, 'utf8')).gaps ?? []) : []
for (const ins of contract.inserted) {
  if (!existsSync(join(root, ins.repo, 'package.json'))) continue // 仓库缺失已在第 2 节报过
  const actual = [...deviations(ins.repo)].sort()
  const gap = pinGaps.find(g => g.repo === ins.repo)
  if (gap === undefined) {
    if (actual.length > 0) {
      fail(ins.repo + ': 版本钉偏离且未声明: ' + actual.join(', ')
        + '（基线 ' + contract.baseline + ' / cordis ' + contract.cordis + ' / schemastery ' + contract.schemastery + '）')
    } else ok(ins.repo + ': 版本钉 == 基线/cordis/schemastery')
    continue
  }
  if (!gap.reason || !String(gap.reason).trim()) { fail(ins.repo + ': contract-pin-gaps 条目缺 reason'); continue }
  const accepted = [...new Set(gap.accepted ?? [])].sort()
  const undeclared = actual.filter(d => !accepted.includes(d))
  const stale = accepted.filter(d => !actual.includes(d))
  if (undeclared.length > 0 || stale.length > 0) {
    fail(ins.repo + ': 声明与事实不符（未声明偏离: [' + undeclared.join(', ') + ']；已对齐却仍声明: [' + stale.join(', ') + ']）')
  } else ok(ins.repo + ': 版本钉偏离已显式声明（' + accepted.length + ' 项，基线 ' + contract.baseline + '）')
}
for (const g of pinGaps) {
  if (!contract.inserted.some(i => i.repo === g.repo)) {
    fail('contract-pin-gaps 声明了未登记进 contract.inserted 的仓库: ' + g.repo)
  }
}
ok('版本钉检查完成')

if (issues.length > 0) {
  console.error('')
  console.error('CONTRACT FAIL (' + issues.length + '):')
  for (const i of issues) console.error('  - ' + i)
  process.exit(1)
}
console.log('')
console.log('CONTRACT PASS')
