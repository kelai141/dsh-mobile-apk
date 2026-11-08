#!/usr/bin/env node
// check-snapshot-packages.mjs — 开发快照与 overlay/插件登记的一致性门禁。
//
// 为什么需要它：dev-fast 构建复用 app/src/main/assets/snapshot.tar.xz（不重建、不注入），
// 这份资产一旦落后于 scripts/snapshot-config/engine-overlay.json 或插件登记，就会在设备上
// 表现为「引擎起得来但某些服务永远 pending」——例如缺 @deepseek-ai/dsh-fs-patch 时
// fs-sandbox 导入失败，sessionController 随之不可用，新建会话直接报 service-unavailable。
// 这类缺陷在打包阶段就该拦下，而不是留到设备上排查。
//
// 用法：
//   node scripts/check-snapshot-packages.mjs                     # 校验默认资产
//   node scripts/check-snapshot-packages.mjs --snapshot <tar>    # 校验指定快照
//   node scripts/check-snapshot-packages.mjs --json              # 机器可读输出
//   node scripts/check-snapshot-packages.mjs --self-test         # 判别力自检（无需真实快照）
// 退出码：0 = 通过；1 = 有缺失；2 = 前置不满足（文件不存在/无法列出条目）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULTS = {
  snapshot: join(ROOT, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'),
  overlay: join(ROOT, 'scripts', 'snapshot-config', 'engine-overlay.json'),
  plugins: join(ROOT, 'scripts', 'plugin-dirs.json'),
}
const ENGINE_ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/'
// overlay.packages 既有 @deepseek-ai 作用域包，也有被提升到引擎根 node_modules 的无作用域依赖
// （commander / got / js-yaml / node-addon-require-builtin），两者落点不同，路径要分开算。
const enginePathOf = (name) => ENGINE_ROOT + (name.startsWith('@') ? name : name) + '/package.json'
const PROFILE_ROOTS = ['home/.dsh/profiles/web/node_modules/', 'home/.dsh/profiles/headless/node_modules/']

/** 纯函数：给定清单条目与期望包集合，算出缺失项（自检直接测它）。 */
export function evaluate({ listing, overlayPackages, plugins }) {
  const entries = new Set(listing)
  const missingEngine = overlayPackages.filter((name) => !entries.has(enginePathOf(name)))
  const missingPlugins = []
  for (const plugin of plugins) {
    for (const root of PROFILE_ROOTS) {
      if (!entries.has(root + plugin.name + '/package.json')) missingPlugins.push({ name: plugin.name, root, dir: plugin.dir })
    }
  }
  return { missingEngine, missingPlugins }
}

function wslPath(path) {
  const absolute = resolve(path)
  return absolute.replace(/^([A-Za-z]):[\\/]/, (_m, drive) => '/mnt/' + drive.toLowerCase() + '/').split('\\').join('/')
}

/** 列出 tar.xz 条目。Windows 上的 bsdtar 不保证支持 xz，所以走 WSL。 */
export function listEntries(snapshot) {
  const command = process.platform === 'win32'
    ? ['wsl', ['-d', 'kali-linux', '-e', 'bash', '-lc', "tar -tJf '" + wslPath(snapshot) + "'"]]
    : ['tar', ['-tJf', snapshot]]
  const result = spawnSync(command[0], command[1], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (result.status !== 0 || result.error) {
    return { error: (result.error && result.error.message) || (result.stderr || '').trim() || 'tar 列出失败' }
  }
  return { entries: result.stdout.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean) }
}

function loadOverlayPackages(overlayPath) {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  const packages = overlay && typeof overlay.packages === 'object' ? overlay.packages : null
  if (packages === null) throw new Error('engine-overlay.json 缺少 packages')
  return Object.keys(packages)
}

function loadPlugins(pluginsPath) {
  const manifest = JSON.parse(readFileSync(pluginsPath, 'utf8'))
  const dirs = Array.isArray(manifest.dirs) ? manifest.dirs : []
  return dirs.map((dir) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    return { dir, name: pkg.name }
  })
}

function selfTest() {
  const plugins = [{ dir: 'plugins/demo', name: '@dsh-android/demo' }]
  const good = evaluate({
    listing: [enginePathOf('@deepseek-ai/dsh-fs-patch'), PROFILE_ROOTS[0] + '@dsh-android/demo/package.json', PROFILE_ROOTS[1] + '@dsh-android/demo/package.json'],
    overlayPackages: ['@deepseek-ai/dsh-fs-patch'],
    plugins,
  })
  const bad = evaluate({
    listing: ['usr/bin/bash'],
    overlayPackages: ['@deepseek-ai/dsh-fs-patch'],
    plugins,
  })
  const ok = good.missingEngine.length === 0 && good.missingPlugins.length === 0 && bad.missingEngine.length === 1 && bad.missingPlugins.length === 2
  if (!ok) {
    console.error('SELF-TEST FAILED: 判别力不符合预期')
    console.error(JSON.stringify({ good, bad }, null, 2))
    return 1
  }
  console.log('CHECK-SNAPSHOT-PACKAGES SELF-TEST PASSED（缺包与缺插件都能判红）')
  return 0
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
  }
  const snapshot = resolve(flag('--snapshot', DEFAULTS.snapshot))
  const overlay = resolve(flag('--overlay', DEFAULTS.overlay))
  const plugins = resolve(flag('--plugins', DEFAULTS.plugins))
  const json = argv.includes('--json')
  for (const [label, path] of [['快照', snapshot], ['overlay', overlay], ['插件登记', plugins]]) {
    if (!existsSync(path)) {
      console.error('前置缺失: ' + label + ' 不存在: ' + path)
      if (label === '快照') console.error('  快照是 gitignore 的本地产物，请从当前 Release 下载后放到该路径（见 docs/AGENTS/build-and-env.md）。')
      return 2
    }
  }
  let listing
  try {
    listing = listEntries(snapshot)
  } catch (error) {
    console.error('前置缺失: 无法列出快照条目: ' + (error && error.message))
    return 2
  }
  if (listing.error) {
    console.error('前置缺失: 无法列出快照条目: ' + listing.error)
    return 2
  }
  const overlayPackages = loadOverlayPackages(overlay)
  const pluginList = loadPlugins(plugins)
  const { missingEngine, missingPlugins } = evaluate({ listing: listing.entries, overlayPackages, plugins: pluginList })
  if (json) {
    console.log(JSON.stringify({ snapshot, missingEngine, missingPlugins, checked: { engine: overlayPackages.length, plugins: pluginList.length } }, null, 2))
  } else {
    console.log('快照: ' + snapshot)
    console.log('校验: overlay 引擎包 ' + overlayPackages.length + ' 个，登记插件 ' + pluginList.length + ' 个')
  }
  if (missingEngine.length > 0 || missingPlugins.length > 0) {
    if (!json) {
      for (const name of missingEngine) console.error('  - 引擎包缺失: ' + name + '（overlay 列了它，快照里没有该包的 package.json）')
      for (const item of missingPlugins) console.error('  - 插件缺失: ' + item.name + '（来自 ' + item.dir + '，快照缺 ' + item.root + item.name + '/package.json）')

      console.error('')
      console.error('修复方式：')
      console.error('  1) 取当前 Release 附带的快照（不要用历史遗留的本地副本）：')
      console.error('       gh release download <tag> -R kelai141/dsh-mobile-apk --pattern \"snapshot-<abi>.tar.xz\" -D .deploy-tmp/snap')
      console.error('  2) 覆盖本地资产：')
      console.error('       copy .deploy-tmp/snap/snapshot-<abi>.tar.xz app/src/main/assets/snapshot.tar.xz')
      console.error('  3) 重跑本脚本确认 PASSED，再构建：')
      console.error('       node scripts/check-snapshot-packages.mjs')
      console.error('CHECK-SNAPSHOT-PACKAGES FAILED：开发快照落后于 overlay/插件登记，构建已阻断')
    }
    return 1
  }
  if (!json) console.log('CHECK-SNAPSHOT-PACKAGES PASSED（引擎包与登记插件齐全）')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
