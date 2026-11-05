#!/usr/bin/env node
// check-patch-mounts.mjs — 权威 patch 挂载集 vs 注入集**双向**校验（防 P1-F2 类回归 + ST-06 反向缺席）。
//
// 背景（2026-08-23 审校 C4）：profile-web.cordis.patch.yml 曾缺 android-linux-env——
// inject-snapshot.py 把它注进快照但 patch 未挂载 → 功能静默不装载，且 update-snapshot-patch.py
// 不校验该方向，门禁拦不住。本脚本补上：patch 中 `name:` 包名集合必须 ⊇ 注入包集合。
//
// 反向差集（0.13.8-b ST-06 / F-ENV-05）：只做单向 `注入 ⊆ 挂载` 抓不到相反方向——
// 从注入清单（scripts/plugin-dirs.json）删掉一个包而权威 patch 仍挂载它时，快照里那个包
// 就不再被注入（或注入旧版），上游只报「模块找不到」，而单向门禁**全绿**。
// 判定：挂载集里的**本仓注入面**必须都在注入集内。`@deepseek-ai/*` 由引擎树自带（不在注入集
// 内，属合法差异）；其余挂载项（`@dsh-android/*` 与 vendor 固化包）都是本仓注入面。
//
// 0.14.2（D12）条目级解析：旧实现用 `/^\s+name:` 抓任意深度的 `name:`，于是设备实装的 patch
// （带 `- id: llm-pi-ai` + 36 个模型定义）会把 36 个**模型显示名**（`MiMo 2.5` 等）读成
// 挂载包 → 直接跑设备文件**误报 39 项**、exit 1。现在只认**装配条目**（与壳侧
// `PluginMounts.entryNames` / `FactoryProfilePatch.blockIds` 同源判据）：
//   - 顶层条目 = 列 0 的 `- id:` / `- name:`；其余键（含 `name:`）按「键缩进 = 0 + 2」归属该条目；
//   - insert 组的一层子条目 = 组内**最浅缩进**的 `- id:` / `- name:`；`name:` 限于「子条目缩进 + 2」；
//   - 配置块内更深的 `id:` / `name:` 不是条目，不计入。
//
// 用法：node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...
//       加 --self-test 跑内置正反控（不读文件）。
// 退出码：0 = 双向一致；1 = 任一方向有缺失（打印缺失清单）；2 = 用法错误。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const TOP_ITEM = /^-(?:\s|$)/
const TOP_ENTRY = /^(?:-\s+id:|-\s+name:)/
const ENTRY_ITEM = /^(\s*)-\s+(id|name):\s*(.*)$/
const KEY_NAME = /^(\s*)name:\s*(.*)$/

/** 去掉 YAML 标量的引号与行尾注释。 */
function scalar(value) {
  let v = String(value).trim()
  const hash = v.indexOf(' #')
  if (hash >= 0) v = v.slice(0, hash).trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1)
  return v.trim()
}

/**
 * 从 patch 文本提取**插件条目**：返回 `{ id, name }` 数组（name 缺失时为 null）。
 *
 * 判据见文首注释。纯函数、无副作用，供 `--self-test` 与真检共用。
 * @param text - patch 文件全文。
 * @returns 条目数组，按出现顺序。
 */
export function parseEntries(text) {
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    if (TOP_ITEM.test(line)) {
      current = { head: line, lines: [line] }
      blocks.push(current)
    } else if (current !== null) {
      current.lines.push(line)
    }
  }
  const entries = []
  for (const block of blocks) {
    const isInsert = /^-\s+insert:\s*$/.test(block.head)
    let entryIndent = 0
    if (isInsert) {
      let min = -1
      for (const line of block.lines) {
        const m = ENTRY_ITEM.exec(line)
        if (m === null) continue
        const indent = m[1].length
        if (indent === 0) continue
        if (min < 0 || indent < min) min = indent
      }
      if (min < 0) continue
      entryIndent = min
    } else if (!TOP_ENTRY.test(block.head)) {
      continue
    }
    let entry = null
    for (const line of block.lines) {
      const m = ENTRY_ITEM.exec(line)
      if (m !== null && m[1].length === entryIndent) {
        entry = { id: null, name: null }
        if (m[2] === 'id') entry.id = scalar(m[3])
        else entry.name = scalar(m[3])
        entries.push(entry)
        continue
      }
      if (entry === null) continue
      const k = KEY_NAME.exec(line)
      if (k !== null && k[1].length === entryIndent + 2 && entry.name === null) entry.name = scalar(k[2])
    }
  }
  return entries.filter((e) => e.id !== null || e.name !== null)
}

/** 条目名集合（只认条目，不认配置块内的显示名）。 */
export function mountedNames(text) {
  const out = new Set()
  for (const entry of parseEntries(text)) if (entry.name !== null && entry.name !== '') out.add(entry.name)
  return out
}

/**
 * 动态加载豁免：scripts/plugin-dirs.json 的 dynamicOnly。
 *
 * 为什么需要：bootstrap 的 apply() 需要函数型 config（linuxAssetIO），YAML 装配表达不了，
 * 只能由宿主在用户显式启用时动态加载 —— 它必须随快照注入，却**不能**出现在 profile patch。
 * 不做显式登记时，双向 ⊇ 判据会把它当漏挂拒包（判据正确，结论错误）。
 *
 * 豁免不是全局跳过：每个豁免项都必须在仓内找到**静态 import 该包名**的源码，
 * 找不到就判红（否则谁都能往登记表塞包）；未登记的包照旧按漏挂判红。
 */
export function dynamicOnlyOf(manifest) {
  const list = Array.isArray(manifest?.dynamicOnly) ? manifest.dynamicOnly : []
  return new Set(list.map((d) => String(d).replace(/\\/g, '/').replace(/\/+$/, '')))
}

/** 仓内是否有一处源码静态 import/require 了该包名（跳过 node_modules / lib 产物）。 */
export function hasStaticImport(root, pkgName) {
  const needle = new RegExp(
    String.raw`(?:from|import|require)\s*\(?\s*['"]` + pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(?:/[^'"]*)?['"]`,
  )
  const SKIP = new Set(['node_modules', 'lib', '.git', 'build', 'out', '.deploy-tmp', '_dsh-wt'])
  const walk = (dir, depth) => {
    if (depth > 6) return false
    let names = []
    try { names = readdirSync(dir) } catch { return false }
    for (const name of names) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { if (walk(full, depth + 1)) return true; continue }
      if (!/\.(?:m?js|cjs|ts|tsx)$/.test(name)) continue
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch { continue }
      if (needle.test(text)) return true
    }
    return false
  }
  return walk(root, 0)
}

/**
 * 正向差集判定（纯函数，真检与 --self-test 共用）。
 * @param injected - 注入包名集合。
 * @param mounted - profile patch 挂载包名集合。
 * @param dynamicNames - dynamicOnly 登记项对应的包名集合。
 * @param hasImport - 包名 -> 仓内是否有静态 import。
 * @returns { missing, deadExemptions }
 */
export function exemptionGaps(injected, mounted, dynamicNames, hasImport) {
  const missing = [...injected].filter((n) => !mounted.has(n) && !dynamicNames.has(n))
  const deadExemptions = [...dynamicNames].filter((n) => !hasImport(n))
  return { missing, deadExemptions }
}

/**
 * 豁免项的可证性：仓内要么有静态 import 该包名的源码，要么该包自己的 package.json
 * 声明了同名且入口指向 `./lib`（loader 按 node_modules 解析、注入器只带 lib/** + package.json）。
 * 两条都不成立 ⇒ 这个包进了注入集却没有任何加载路径，豁免就是掩盖漏挂。
 * @param root - 仓根。
 * @param dirs - 注入源目录（相对仓根）。
 * @param dynamicOnly - 豁免登记（相对仓根的目录集合）。
 * @returns { name, dir }[] 无加载证据的豁免项。
 */
export function unprovenExemptions(root, dirs, dynamicOnly) {
  const out = []
  for (const dir of dynamicOnly) {
    const full = join(root, dir)
    let pkg
    try { pkg = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8')) } catch { out.push({ name: null, dir }); continue }
    if (!dirs.includes(dir)) { out.push({ name: pkg.name ?? null, dir }); continue }
    const entry = pkg.exports?.['.'] ?? pkg.main
    const loadable = typeof pkg.name === 'string' && entry === './lib/index.js'
    if (!loadable || !hasStaticImport(root, pkg.name)) out.push({ name: pkg.name ?? null, dir })
  }
  return out
}

if (process.argv.includes('--self-test')) {
  // 正控：条目形态（顶层行 / insert 子条目 / 引号）都要认出来；
  // 反控：配置块内的 id/name（llm-pi-ai 的模型表）一个都不许进集合。
  const fixture = [
    '# comment',
    '- id: bash-sandbox',
    '  disabled: true',
    '- insert:',
    "    - id: shell-termux",
    "      name: '@dsh-android/dsh-shell-termux'",
    '    - id: host-web-compat',
    "      name: '@dsh-android/dsh-host-web-compat'",
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        models:',
    '          - id: mimo-v2.5',
    '            name: MiMo 2.5',
    '            contextWindow: 262144',
    '- id: office-to-pdf',
    '  disabled: true',
  ].join('\n')
  const got = mountedNames(fixture)
  const want = new Set(['@dsh-android/dsh-shell-termux', '@dsh-android/dsh-host-web-compat', '@deepseek-ai/dsh-llm-pi-ai'])
  const missing = [...want].filter((x) => !got.has(x))
  const extra = [...got].filter((x) => !want.has(x))
  const ok = missing.length === 0 && extra.length === 0 && got.size === 3
  console.log((ok ? 'PATCH-MOUNTS SELF-TEST PASSED' : 'PATCH-MOUNTS SELF-TEST FAILED')
    + '（条目名 ' + got.size + ' / 期望 3；缺 ' + JSON.stringify(missing) + '；多 ' + JSON.stringify(extra) + '）')
  if (!ok) process.exit(1)

  // 动态加载豁免的判据：豁免项免于「必须挂载」，但**不豁免**静态 import 证据；
  // 未登记的包照旧按漏挂判红（负控 2 证明这条没有变成全局跳过）。
  const controls = [
    {
      label: '正控: dynamicOnly 包不挂载也通过（且 import 可证）',
      run: () => exemptionGaps(
        new Set(['@dsh-android/linux-bootstrap', '@dsh-android/dsh-session-delete']),
        new Set(['@dsh-android/dsh-session-delete']),
        new Set(['@dsh-android/linux-bootstrap']),
        () => true,
      ),
      ok: (g) => g.missing.length === 0 && g.deadExemptions.length === 0,
    },
    {
      label: '负控: 未登记的注入包缺挂载必须判红',
      run: () => exemptionGaps(
        new Set(['@dsh-android/linux-bootstrap', '@dsh-android/dsh-session-delete']),
        new Set(),
        new Set(['@dsh-android/linux-bootstrap']),
        () => true,
      ),
      ok: (g) => g.missing.length === 1 && g.missing[0] === '@dsh-android/dsh-session-delete',
    },
    {
      label: '负控: 豁免项没有静态 import 证据必须判红',
      run: () => exemptionGaps(
        new Set(['@dsh-android/linux-bootstrap']),
        new Set(),
        new Set(['@dsh-android/linux-bootstrap']),
        () => false,
      ),
      ok: (g) => g.deadExemptions.length === 1,
    },
  ]
  let bad = 0
  for (const control of controls) {
    const produced = control.run()
    if (control.ok(produced)) console.log('SELF-TEST PASSED  ' + control.label)
    else {
      console.log('SELF-TEST FAILED  ' + control.label + ' — produced: ' + JSON.stringify(produced))
      bad += 1
    }
  }
  if (bad > 0) process.exit(1)
  process.exit(0)
}

const [patchPath, ...dirs] = process.argv.slice(2)
if (!patchPath || dirs.length === 0) {
  console.error('用法: node scripts/check-patch-mounts.mjs <patch.yml> <pkg_dir>...')
  process.exit(2)
}

const patch = readFileSync(patchPath, 'utf8')
// patch 挂载集：**插件条目**的 `name:` 包名（含 `@scope/` 形式；配置块内的显示名不计）。
const mounted = mountedNames(patch)

const injected = new Set()
const dynamicNames = new Set()
const manifestPath = join(ROOT, 'scripts', 'plugin-dirs.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
const dynamicOnly = dynamicOnlyOf(manifest)
for (const d of dirs) {
  try {
    const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    injected.add(pkg.name)
    const rel = String(d).replace(/\\/g, '/').replace(new RegExp('^' + ROOT.replace(/\\/g, '/') + '/'), '')
    if (dynamicOnly.has(rel)) dynamicNames.add(pkg.name)
  } catch {
    injected.add(d.split(/[\\/]/).pop())
  }
}

// 正向：注入集 ⊆ 挂载集（注入进快照却未挂载 = 功能静默不装载）。
// 唯一例外是 dynamicOnly 显式登记的包：不挂 profile，但必须有仓内静态 import 证据。
const gaps = exemptionGaps(injected, mounted, dynamicNames, (n) => hasStaticImport(ROOT, n))
const missing = gaps.missing
// 豁免的可证性用 unprovenExemptions 判（静态 import 或包自身清单），不再只看 import。
const deadExemptions = unprovenExemptions(ROOT, (manifest.dirs ?? []).map((d) => String(d).replace(/\\/g, '/')),
  [...dynamicOnly]).map((e) => e.name ?? e.dir)
// 反向：挂载集 ∩ 本仓注入面 ⊆ 注入集（挂载了但清单/调用方没注入 = 装配失败或旧版残留）
const ENGINE_SCOPE = '@deepseek-ai/'
const unmounted = [...mounted].filter((n) => !injected.has(n) && !n.startsWith(ENGINE_SCOPE))

if (deadExemptions.length > 0) {
  console.error('dynamicOnly 豁免项在仓内找不到静态 import（豁免必须可证）: ' + deadExemptions.join(', '))
  console.error('（请补源码里的 import，或从 scripts/plugin-dirs.json 的 dynamicOnly 删除该条目）')
  process.exit(1)
}
if (missing.length === 0 && unmounted.length === 0) {
  console.log('patch mounts ok (双向): ' + injected.size + ' 个注入包全部挂载'
    + (dynamicNames.size > 0 ? '（dynamicOnly 豁免 ' + [...dynamicNames].sort().join(', ') + '）' : '')
    + '（' + [...injected].sort().join(', ') + '）')
  process.exit(0)
}
if (missing.length > 0) {
  console.error('patch 挂载集缺少注入包: ' + missing.join(', '))
  console.error('（注入进快照却未挂载 = 功能静默不装载；请补 profile-web.cordis.patch.yml 条目）')
}
if (unmounted.length > 0) {
  console.error('权威 patch 挂载了注入面之外的包（反向差集）: ' + unmounted.join(', '))
  console.error('（清理单里删了包/patch 多挂了条目 = 快照缺该包或版本停留旧值；'
    + '请把包补回 scripts/plugin-dirs.json 对应链，或从 profile-web.cordis.patch.yml 删条目）')
}
process.exit(1)
