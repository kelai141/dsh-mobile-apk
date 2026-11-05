#!/usr/bin/env node
/**
 * B1 辅助：从 snapshot tar 的 `tar -tvJf` 详细清单里重建「WebView 侧要下载的全部 client bundle」
 * 清单，并按包名汇总体积。
 *
 * 为什么不用 tar -xJf 解包：191MB xz 解包是 C 号任务的领域，且极占磁盘。tar -tv 的清单里已有
 * 每个文件的原始字节数，对「体积构成」而言这就是权威口径（解包不会改变字节数）。
 *
 * 输入：由
 *   tar -tvJf <snapshot.tar.xz> > %TEMP%\perf-b-snapshot-tv.txt
 * 产出的清单文件路径（第一个参数，默认 %TEMP%\perf-b-snapshot-tv.txt）。
 *
 * 输出：stdout 打印 JSON；人类可读摘要打到 stderr。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const listingPath = process.argv[2] ?? join(tmpdir(), 'perf-b-snapshot-tv.txt')

// GNU tar 权限串形如 "-rw-r--r--" / "lrwxrwxrwx" / "drwxr-xr-x"
const LINE = /^([-dlbcps])([rwxsStT-]{9})\s+\S+\/\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/

let total = 0
let totalBytes = 0
const files = []
let nonFile = 0

const rl = createInterface({ input: createReadStream(listingPath, 'utf8'), crlfDelay: Infinity })
for await (const raw of rl) {
  const line = raw.trimEnd()
  if (line === '') continue
  total += 1
  const m = LINE.exec(line)
  if (m === null) { nonFile += 1; continue }
  const [, typeChar, , sizeStr, , , name] = m
  if (typeChar !== '-') { nonFile += 1; continue }
  const size = Number(sizeStr)
  totalBytes += size
  files.push({ name, size })
}

/** WebView 侧真正会 fetch 的 client 产物：包根 lib/client.js（不含 lib/types/** 的 node 半边）及 .map。 */
const CLIENT_BUNDLE = /\/lib\/client\.js$/
const CLIENT_MAP = /\/lib\/client\.js\.map$/
/** 插件页/资源类：CSS、字体、图片 */
const ASSET = /\.(css|woff2?|ttf|png|jpe?g|svg|gif|webp)$/i

const bundles = files.filter((f) => CLIENT_BUNDLE.test(f.name))
const maps = files.filter((f) => CLIENT_MAP.test(f.name))
const assets = files.filter((f) => ASSET.test(f.name))

const sum = (arr) => arr.reduce((a, b) => a + b.size, 0)

/** @param {string} name */
function pkgOf(name) {
  const m = name.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)
  if (m === null) return name
  const last = m[m.length - 1]
  return last.replace(/^\/node_modules\//, '').replace(/\/$/, '')
}

const byPkg = new Map()
for (const f of bundles) {
  const p = pkgOf(f.name)
  byPkg.set(p, (byPkg.get(p) ?? 0) + f.size)
}
const pkgRanked = [...byPkg].sort((a, b) => b[1] - a[1])

const report = {
  listingPath,
  entriesTotal: total,
  entriesNonFile: nonFile,
  filesTotal: files.length,
  snapshotUncompressedBytes: totalBytes,
  clientBundle: {
    count: bundles.length,
    bytes: sum(bundles),
  },
  clientBundleMaps: {
    count: maps.length,
    bytes: sum(maps),
  },
  clientBundlesWithSiblings: {
    // 同一包的 client.js 加上它的 .map（首次 DevTools 打开或浏览器主动请求 map 时才拉，
    // 但体积仍随快照落盘）
    count: bundles.length + maps.length,
    bytes: sum(bundles) + sum(maps),
  },
  assetFiles: {
    count: assets.length,
    bytes: sum(assets),
  },
  clientBundleByPackage: pkgRanked.map(([pkg, bytes]) => ({ pkg, bytes })),
  topClientBundles: bundles.sort((a, b) => b.size - a.size).slice(0, 30),
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n')

process.stderr.write(
  `entries=${total} files=${files.length} nonFile=${nonFile}\n`
  + `client bundles: ${bundles.length} files, ${(sum(bundles) / 1048576).toFixed(2)} MiB\n`
  + `client maps:    ${maps.length} files, ${(sum(maps) / 1048576).toFixed(2)} MiB\n`
  + `snapshot uncompressed total: ${(totalBytes / 1048576).toFixed(2)} MiB\n`,
)
