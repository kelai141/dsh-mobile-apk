// 持久 Shell 后端的两个入口不得同时默认启用（issue #1344）。
//
// 现场（红米 K Pad / HyperOS 3.0.310 / Android 16）：插件页红色「组件启用失败」——
//   optional-terminal-pwsh (@deepseek-ai/dsh-terminal-bash):
//   TerminalError: a PTY backend named "shell" is already registered
//
// 真因不是用户配置：@deepseek-ai/dsh-terminal-bash 的两个 loader 入口都按包内
// `Config.backendType = z.string().default("shell")`（lib/index.js:38）注册 PTY 后端，
// 两个入口都没有覆盖 backendType ⇒ 先激活者占名、后者恒撞名。上游把「pwsh 只在 Windows 开」
// 写成可选 bundle 补丁里的 `!!js process.platform !== 'win32'`，而我们的现场里两个入口同时激活，
// 说明那道 !!js 判据在该环境没兜住。
//
// 本仓兜底落在 `scripts/profile-web.cordis.patch.yml`：字面量 `disabled: true` 定向禁用 pwsh 入口
// （profile 层在所有 bundle 层之后应用，不依赖任何求值）。判据守两件事：
//   ① 上游形态确实是「两个入口同名后端」（没有 backendType 覆盖）——修法针对的是真缺陷；
//   ② 叠加我们的 profile 层之后，只剩**一个**默认启用的 dsh-terminal-bash 入口，且关闭项带理由。
// 负控（本文件内联）：把我们的那一行从合成里去掉 ⇒ 默认启用数回到 2，判据立刻红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
/**
 * 最小行解析器（只认本判据要的两个属性）：`- id:` 起一个条目，其下更缩进的
 * `name:` / `disabled:` 归该条目。刻意独立于 check-contract.mjs 的实现——那个脚本是
 * **可执行门禁**（import 会跑全部门禁），判据不能靠它；代价只是两份 20 行解析器，
 * 换来「测试可单独运行」。
 */
function parseCordisRows(text, label) {
  const rows = []
  let cur = null
  let insertDepth = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const ind = raw.length - raw.trimStart().length
    const ins = /^(\s*)- insert:\s*$/.exec(raw)
    if (ins !== null) { insertDepth = ins[1].length; cur = null; continue }
    if (insertDepth !== null && ind <= insertDepth) insertDepth = null
    const idm = /^(\s*)- id:\s*(\S+)\s*$/.exec(raw)
    if (idm !== null) {
      cur = { id: idm[2], name: null, disabled: false, indent: idm[1].length, inInsert: insertDepth !== null }
      rows.push(cur)
      continue
    }
    if (cur === null) continue
    if (ind <= cur.indent) { cur = null; continue }
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv === null) continue
    if (kv[1] === 'name' && cur.name === null) cur.name = kv[2].trim().replace(/^['"]|['"]$/g, '')
    else if (kv[1] === 'disabled') cur.disabled = /^true\b/.test(kv[2].trim())
  }
  if (rows.length === 0) throw new Error(label + ': 解析结果为空——拒绝按空集继续判')
  return rows
}

const ROOT = new URL('../', import.meta.url)
const PROFILE_PATCH = readFileSync(new URL('scripts/profile-web.cordis.patch.yml', ROOT), 'utf8')

/** 上游 @deepseek-ai/dsh-experimental-terminal-bundle@0.2.1-rc.3/cordis.patch.yml 的逐字副本
 *  （646 字节；rc.2 与 rc.3 相同）。放在这里是为了不依赖协调仓 checkout 也能判「修法针对真缺陷」。 */
const UPSTREAM_TERMINAL_BUNDLE = "- insert:\n    - id: optional-persistent-terminals\n      name: cordis:group\n      group: true\n      isolate:\n        terminals: true\n      config:\n        - id: optional-terminal-registry\n          name: '@deepseek-ai/dsh-terminal'\n        - id: optional-terminal-bash\n          name: '@deepseek-ai/dsh-terminal-bash'\n          disabled: !!js process.platform === 'win32'\n        - id: optional-terminal-pwsh\n          name: '@deepseek-ai/dsh-terminal-bash'\n          disabled: !!js process.platform !== 'win32'\n          config:\n            shellDialect: pwsh\n        - id: optional-tool-terminal\n          name: '@deepseek-ai/dsh-tool-terminal'\n"

const rows = (text, label) => parseCordisRows(text, label)
const upstreamRows = rows(UPSTREAM_TERMINAL_BUNDLE, 'upstream experimental-terminal bundle')
const ourRows = rows(PROFILE_PATCH, 'profile-web.cordis.patch.yml')

/** 合成后的默认启用集：上游行被我们的同名 disabled:true 行关掉即算关闭。 */
function composedEnabled(text, ours) {
  const up = rows(text, 'compose-upstream')
  const off = new Set(ours.filter((r) => !r.inInsert && r.disabled).map((r) => r.id))
  return up.filter((r) => !r.disabled && !off.has(r.id))
}

test('#1344 上游形态：同包两个入口都用默认后端名 "shell"（缺陷前提）', () => {
  const shells = upstreamRows.filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(shells.length, 2, '上游应有 bash / pwsh 两个入口: ' + shells.map((r) => r.id).join(', '))
  assert.ok(!UPSTREAM_TERMINAL_BUNDLE.includes('backendType'),
    '上游一旦显式区分 backendType，本仓这条禁用就该复核（两入口可共存了）')
})

test('#1344 profile 层兜底：只剩一个默认启用的 dsh-terminal-bash 入口', () => {
  const enabled = composedEnabled(UPSTREAM_TERMINAL_BUNDLE, ourRows)
    .filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.deepEqual(enabled.map((r) => r.id), ['optional-terminal-bash'],
    '默认启用的持久 Shell 后端必须只剩 bash 一个（pwsh 在 Android 没有可执行文件，且与 bash 抢同一个后端名）: '
    + enabled.map((r) => r.id).join(', '))
})

test('#1344 关闭项必须写明理由（不是无声禁行）', () => {
  const lines = PROFILE_PATCH.split(/\r?\n/)
  const at = lines.findIndex((line) => line.trim() === '- id: optional-terminal-pwsh')
  assert.ok(at > 0, 'profile patch 必须显式禁用 optional-terminal-pwsh')
  // 该条目自身上下文（理由注释 + 两行条目本身）
  const block = lines.slice(Math.max(0, at - 20), at + 2).join('\n')
  assert.match(block, /^\s+-?\s*disabled:\s*true$/m, '必须是字面量 disabled: true（不依赖 !!js 求值）')
  assert.match(block, /#1344/, '理由必须点名 issue')
  assert.match(block, /TerminalError|already registered|后端名/, '理由必须写清撞名现象，而不是一句「暂时禁用」')
})

test('#1344 负控：去掉我们的关闭行，默认启用数回到 2（判据能分辨缺陷与修法）', () => {
  const without = ourRows.filter((r) => r.id !== 'optional-terminal-pwsh')
  const enabled = composedEnabled(UPSTREAM_TERMINAL_BUNDLE, without)
    .filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(enabled.length, 2, '去掉兜底后应看到两个同名后端入口（这正是设备上的冲突形态）')
})
