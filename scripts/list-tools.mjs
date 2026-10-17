#!/usr/bin/env node
// list-tools.mjs — 列出全部已注册工具（真跑各插件 apply()，与 check-tool-surface-budget 同源）。
// 用途：给「全工具连通性扫描」提供权威清单，避免手抄工具名漂移。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGINS = [
  'dsh-android-manage',
  'dsh-android-browser',
  'dsh-android-bridge',
  'dsh-android-vdisplay',
  'dsh-android-file-open',
  'dsh-android-linux-env',
]

// 与预算门禁同款桩：捕获 ctx.tools.register(def)。
function makeStub(captured) {
  const target = function () { return makeStub(captured) }
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'register') return (def) => { captured.push(def); return () => {} }
      if (prop === 'tools') return makeStub(captured)
      if (prop === 'effect' || prop === 'on' || prop === 'inject' || prop === 'slots' || prop === 'logger') return () => {}
      if (prop === 'get') return () => makeStub(captured)
      if (prop === 'then') return undefined
      return makeStub(captured)
    },
    apply() { return makeStub(captured) },
  })
}

const all = []
for (const plugin of PLUGINS) {
  const lib = join(ROOT, 'plugins', plugin, 'lib', 'index.js')
  if (!existsSync(lib)) { console.error('SKIP ' + plugin + '（无 lib）'); continue }
  const captured = []
  try {
    const mod = await import(pathToFileURL(lib).href)
    if (typeof mod.apply !== 'function') { console.error('SKIP ' + plugin + '（未导出 apply）'); continue }
    mod.apply(makeStub(captured), {})
  } catch (e) { console.error('ERR  ' + plugin + ': ' + (e?.message ?? e)) }
  for (const def of captured) {
    if (def && typeof def.name === 'string') all.push({ plugin, name: def.name })
  }
}

const seen = new Set()
const out = all.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
console.log(JSON.stringify(out.map((t) => t.name)))
console.log('共 ' + out.length + ' 个工具（插件分布：' + [...new Set(out.map((t) => t.plugin))].map((p) => p + '=' + out.filter((x) => x.plugin === p).length).join(', ') + '）')
