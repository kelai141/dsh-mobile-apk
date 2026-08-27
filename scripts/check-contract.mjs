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

console.log('== 4. 客户端槽位声明 ==')
const slotText = readFileSync(join(root, contract.clientSlots.repo, 'src/client/index.ts'), 'utf8')
for (const slot of contract.clientSlots.slots) {
  if (slotText.includes("'" + slot + "'")) ok('槽位 ' + slot + ' 已声明')
  else fail('槽位 ' + slot + ' 未声明')
}

console.log('== 5. 环境契约键 ==')
const envText = readFileSync(join(root, contract.envContract.repo, 'src/index.ts'), 'utf8')
for (const key of contract.envContract.keys) {
  if (envText.includes(key)) ok('环境键 ' + key + ' 注入')
  else fail('环境键 ' + key + ' 未注入')
}

console.log('== 6. 版本钉（package.json vs contract.json） ==')
for (const repo of contract.inserted.map(i => i.repo)) {
  const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
  for (const [dep, pin] of Object.entries(pkg.devDependencies ?? {})) {
    if (dep.startsWith('@deepseek-ai/dsh-') && pin !== contract.baseline) {
      fail(repo + ': ' + dep + ' 钉 ' + pin + ' ≠ 基线 ' + contract.baseline)
    }
  }
  const cordisPin = pkg.devDependencies?.['@deepseek-ai/cordis'] ?? pkg.peerDependencies?.['@deepseek-ai/cordis']
  if (cordisPin !== contract.cordis) fail(repo + ': cordis 钉 ' + cordisPin + ' ≠ ' + contract.cordis)
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
