#!/usr/bin/env node
/**
 * B2 辅助：统计「WebView 首屏要 fetch + 求值多少个 client bundle」。
 *
 * 判据来自引擎侧权威实现（快照内 dsh-client-modules/lib/index.js:108/717-723）：
 *   node 半边扫 Host Loader 的全部 entry，凡 package.json 里 `dsh.client.platform === "web"`
 *   的包，都会被收进 client 模块表，其 `./client` 导出成为首屏要加载的 bundle。
 * 所以「首屏 JS 条数」= 快照里声明了 dsh.client(platform=web) 的包数，与它们 lib/client.js 的字节数。
 *
 * 用法：node scripts/perf-audit-b/client-boot-surface.mjs <解包后的快照根目录>
 * 输出：stdout JSON；stderr 人类可读摘要。
 */
import { readdirSync, readFileSync, statSync,
  // eslint-disable-next-line
} from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/client-boot-surface.mjs <解包后的快照根目录>')
  process.exit(2)
}

/** 递归找所有 package.json（跳过明显的非包目录以免白跑）。 */
function findPackageJsons(dir, out = []) {
  let names
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of names) {
    if (!e.isDirectory()) {
      if (e.name === 'package.json') out.push(join(dir, e.name))
      continue
    }
    if (e.name === '.git' || e.name === '.bin') continue
    findPackageJsons(join(dir, e.name), out)
  }
  return out
}

const pkgJsons = findPackageJsons(root)
const clients = []
let scanned = 0
let parseFailed = 0
for (const p of pkgJsons) {
  let pkg
  try { pkg = JSON.parse(readFileSync(p, 'utf8')) } catch { parseFailed += 1; continue }
  scanned += 1
  const decl = pkg.dsh?.client
  if (decl === undefined || decl === null || typeof decl !== 'object') continue
  if (decl.platform !== 'web') continue
  // 解析 ./client 导出指向的物理文件（引擎侧 clientExportOf 的等价物，做保守近似）
  const exp = pkg.exports?.['./client']
  let rel = undefined
  if (typeof exp === 'string') rel = exp
  else if (exp !== null && typeof exp === 'object') rel = exp.default ?? exp.import ?? exp.require
  let bytes = undefined
  let resolvedPath = undefined
  if (typeof rel === 'string') {
    resolvedPath = join(p.replace(/package\.json$/, ''), rel)
    try { bytes = statSync(resolvedPath).size } catch { bytes = undefined }
  }
  clients.push({
    packageJson: relative(root, p).split('\\').join('/'),
    name: pkg.name,
    version: pkg.version,
    clientEntry: rel,
    bytes,
    immediately: decl.immediately === true,
    inject: Array.isArray(decl.inject) ? decl.inject : [],
  })
}

clients.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
const withBytes = clients.filter((c) => c.bytes !== undefined)
const total = withBytes.reduce((a, c) => a + c.bytes, 0)

const report = {
  root,
  packageJsonsFound: pkgJsons.length,
  packageJsonsParsed: scanned,
  parseFailed,
  webClientPluginCount: clients.length,
  resolvedBundleCount: withBytes.length,
  totalClientBundleBytes: total,
  totalClientBundleMiB: Number((total / 1048576).toFixed(2)),
  immediatelyCount: clients.filter((c) => c.immediately).length,
  clients,
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n')

process.stderr.write([
  '扫描 package.json ' + scanned + ' 个（解析失败 ' + parseFailed + '）',
  'dsh.client(platform=web) 声明 ' + clients.length + ' 个包',
  '  其中 ./client 能落盘解析 ' + withBytes.length + ' 个，合计 ' + report.totalClientBundleMiB + ' MiB',
  '  immediately=true ' + report.immediatelyCount + ' 个',
].join('\n') + '\n')
