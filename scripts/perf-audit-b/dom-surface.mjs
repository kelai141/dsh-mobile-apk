#!/usr/bin/env node
/**
 * B3 辅助：静态统计 WebView 侧 DOM 现场操作面（不是渲染节点总数——那需要真机 CDP）。
 *
 * 统计口径与它为什么可信：
 *   - 只数「每次调用都会产出 / 遍历 DOM」的原语：createElement、querySelectorAll、getElementById、
 *     appendChild、innerHTML=、addEventListener。这些是字节级计数，不受 CPU 抖动影响（度量纪律里的硬证据）。
 *   - 用 git grep 取已跟踪文件，排除 node_modules 与构建产物。
 *   - 不声称「运行时一定创建 N 个节点」——只给「代码里有几处会创建/遍历 DOM」，
 *     节点数上限留给报告里按调用点语义逐条推导，并明确标注为推导。
 *
 * 用法：node scripts/perf-audit-b/dom-surface.mjs <仓库根目录>
 */
import { execFileSync } from 'node:child_process'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/dom-surface.mjs <仓库根目录>')
  process.exit(2)
}

function grepCount(pattern, paths) {
  const args = ['grep', '-c', '-I', '-E', pattern, '--', ...paths]
  try {
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const rows = []
    let total = 0
    for (const line of out.trim().split(/\r?\n/)) {
      if (line === '') continue
      const m = /^(.+):(\d+)$/.exec(line)
      if (m === null) continue
      const n = Number(m[2])
      total += n
      rows.push({ file: m[1], count: n })
    }
    rows.sort((a, b) => b.count - a.count)
    return { total, rows }
  } catch (e) {
    if (e.status === 1 || e.status === 128) return { total: 0, rows: [] }
    throw e
  }
}

const CLIENT_SRC = ['dsh-client-ui-responsive/src']
const SHELL_ASSETS = ['app/src/main/assets']

const PRIMITIVES = [
  { key: 'createElement', re: 'createElement\\(' },
  { key: 'querySelectorAll', re: 'querySelectorAll\\(' },
  { key: 'querySelector', re: 'querySelector\\(' },
  { key: 'getElementById', re: 'getElementById\\(' },
  { key: 'appendChild', re: 'appendChild\\(' },
  { key: 'innerHTML=', re: 'innerHTML[[:space:]]*=' },
  { key: 'addEventListener', re: 'addEventListener\\(' },
  { key: 'MutationObserver', re: 'MutationObserver' },
  { key: 'requestAnimationFrame', re: 'requestAnimationFrame\\(' },
]

/** @type {Record<string, {clientSrc: any, shellAssets: any, allTotal: number}>} */
const report = { root, primitives: {} }
for (const p of PRIMITIVES) {
  const clientSrc = grepCount(p.re, CLIENT_SRC)
  const shellAssets = grepCount(p.re, SHELL_ASSETS)
  report.primitives[p.key] = {
    clientSrcTotal: clientSrc.total,
    shellAssetsTotal: shellAssets.total,
    allTotal: clientSrc.total + shellAssets.total,
    topClientSrc: clientSrc.rows.slice(0, 8),
    topShellAssets: shellAssets.rows.slice(0, 8),
  }
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n')

const lines = ['原语                     client-ui  assets  合计']
for (const p of PRIMITIVES) {
  const r = report.primitives[p.key]
  lines.push(p.key.padEnd(24) + String(r.clientSrcTotal).padStart(9) + String(r.shellAssetsTotal).padStart(8) + String(r.allTotal).padStart(7))
}
process.stderr.write(lines.join('\n') + '\n')
