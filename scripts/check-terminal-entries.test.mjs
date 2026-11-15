// 持久 Shell 后端的双入口不得在同一个平台上同时默认启用（issue #1344）。
//
// 现场（红米 K Pad / HyperOS 3.0.310 / Android 16，0.14.x 代）：插件页红色「组件启用失败」——
//   optional-terminal-pwsh (@deepseek-ai/dsh-terminal-bash):
//   TerminalError: a PTY backend named "shell" is already registered
//
// 真因：@deepseek-ai/dsh-terminal-bash 的每个 loader 入口都按包内
// `Config.backendType = z.string().default('shell')` 注册 PTY 后端，入口本身不覆盖 backendType。
// 上游那时把「pwsh 只在 Windows 开」写成可选 bundle 补丁里的 `!!js process.platform !== 'win32'`，
// 而现场两个入口同时激活 —— 那道 !!js 判据没兜住。本仓当时的兜底是在 profile 层用**字面量**
// `disabled: true` 定向关掉 pwsh 入口（profile 层在所有 bundle 层之后应用，不依赖任何求值）。
//
// **0.2.2-rc.3 上游重排了这个组**（逐字节实测，见下三份内联副本）：
//   · experimental-terminal-bundle 里 bash / pwsh 两个入口**都删了**，该组只剩
//     optional-terminal-registry(dsh-terminal) / optional-terminal-panel(dsh-terminal-panel) /
//     optional-tool-terminal(dsh-tool-terminal)，共 518 字节；
//   · bash 后端改由 web-app 的 agent-preset minimal 在 `persistent-shell` 组里挂：
//     terminal-bash (disabled: !!js process.platform === 'win32')
//     terminal-pwsh (disabled: !!js process.platform !== 'win32')；
//   · **两行仍然都不覆盖 backendType**，即上游没采纳 #1344 建议的修法 1，只是把双入口从
//     可选 bundle 挪到了 preset 层。
//   ⇒ profile 里那条针对 `optional-terminal-pwsh` 的字面量禁用**失去指向目标**（该 id 在上游
//   行面已不存在），已随本代删除。撞名风险没有消失，只是判据换了位置：现在守的是
//   「preset 层那两行的 !!js 是否真的互斥」。
//
// 判据（四条）：
//   ① 缺陷前提仍在：preset 里两个 dsh-terminal-bash 入口都不覆盖 backendType；
//   ② 互斥性：两行的 disabled 表达式互反，且按非 win32（= Android）求值后**恰好一个**启用；
//   ③ 没有幽灵行：profile 不得再出现指向已消失 id 的禁用项；
//   ④ 负控：把 pwsh 行的 !!js 判据去掉（模拟上游回退），合成结果立刻变成两个同名后端 ⇒ 判红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
/**
 * 最小行解析器（只认本判据要的属性）：`- id:` 起一个条目，其下更缩进的
 * `name:` / `disabled:` 归该条目。刻意独立于 check-contract.mjs 的实现——那个脚本是
 * **可执行门禁**（import 会跑全部门禁），判据不能靠它；代价只是两份解析器，
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
      cur = { id: idm[2], name: null, disabledExpr: null, indent: idm[1].length, inInsert: insertDepth !== null }
      rows.push(cur)
      continue
    }
    if (cur === null) continue
    if (ind <= cur.indent) { cur = null; continue }
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv === null) continue
    if (kv[1] === 'name' && cur.name === null) cur.name = kv[2].trim().replace(/^['"]|['"]$/g, '')
    else if (kv[1] === 'disabled') cur.disabledExpr = kv[2].trim()
  }
  if (rows.length === 0) throw new Error(label + ': 解析结果为空——拒绝按空集继续判')
  return rows
}

const ROOT = new URL('../', import.meta.url)
const PROFILE_PATCH = readFileSync(new URL('scripts/profile-web.cordis.patch.yml', ROOT), 'utf8')

/** 上游 @deepseek-ai/dsh-experimental-terminal-bundle@0.2.2-rc.3/cordis.patch.yml 的逐字副本
 *  （518 字节；rc.2 与 rc.3 的这份不同——rc.1 的 646 字节版本还带 bash/pwsh 两个入口）。
 *  放在这里是为了不依赖协调仓 checkout 也能判「上游形态到底是什么」。 */
const UPSTREAM_TERMINAL_BUNDLE = "- insert:\n    - id: optional-persistent-terminals\n      name: cordis:group\n      group: true\n      isolate:\n        terminals: true\n      config:\n        - id: optional-terminal-registry\n          name: '@deepseek-ai/dsh-terminal'\n        - id: optional-terminal-panel\n          name: '@deepseek-ai/dsh-terminal-panel'\n          config:\n            preferredShells: !!js \"process.platform === 'win32' ? ['pwsh', 'powershell'] : []\"\n        - id: optional-tool-terminal\n          name: '@deepseek-ai/dsh-tool-terminal'\n"

/** 上游 packages/bundle/web-app/presets/minimal.patch.yml 里 persistent-shell 组的逐字副本
 *  （只摘 terminal-bash / terminal-pwsh 两行及其 config 头，原文 3724 字节）。 */
const UPSTREAM_PRESET_SHELL = [
  '- insert:',
  '    - id: preset-minimal',
  '      name: cordis:group',
  '      group: true',
  '      config:',
  '          - id: persistent-shell',
  '            name: cordis:group',
  '            group: true',
  '            isolate:',
  '              terminals: true',
  '            config:',
  "              - id: pty",
  "                name: '@deepseek-ai/dsh-terminal'",
  "              - id: terminal-bash",
  "                name: '@deepseek-ai/dsh-terminal-bash'",
  "                disabled: !!js process.platform === 'win32'",
  '                config:',
  '                  timeoutMs: 300000',
  "              - id: terminal-pwsh",
  "                name: '@deepseek-ai/dsh-terminal-bash'",
  "                disabled: !!js process.platform !== 'win32'",
  '                config:',
  '                  shellDialect: pwsh',
  '                  timeoutMs: 300000',
  '',
].join('\n')

const rows = (text, label) => parseCordisRows(text, label)

/** 按给定 process.platform 求值 `!!js` 表达式。只支持本判据出现的两种形态——
 *  刻意不 eval 任意代码：判据要证的是「这两条表达式互反」，不是实现一个 JS 解释器。 */
function evalDisabled(expr, platform) {
  if (expr === null) return false
  const m = /^!!js\s+process\.platform\s*(===|!==)\s*'([^']+)'$/.exec(expr)
  if (m === null) throw new Error('判据不认识的 disabled 表达式（形态变了要复核本测试）: ' + expr)
  // !!js 表达式的**值就是 disabled 的值**（不是它的取反）：\`=== 'win32'\` 在 android 上是 false ⇒ 不禁用。
  const value = platform === m[2]
  return m[1] === '===' ? value : !value
}

const enabledOn = (text, platform) => rows(text, 'compose').filter((r) => !evalDisabled(r.disabledExpr, platform))

test('#1344 上游形态：preset 里两个 dsh-terminal-bash 入口仍都不覆盖 backendType（缺陷前提）', () => {
  const shells = rows(UPSTREAM_PRESET_SHELL, 'upstream preset minimal').filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(shells.length, 2, 'preset 应有 terminal-bash / terminal-pwsh 两个入口: ' + shells.map((r) => r.id).join(', '))
  assert.ok(!UPSTREAM_PRESET_SHELL.includes('backendType'),
    '上游一旦显式区分 backendType，本仓这段判断就该复核（两入口可以共存了）')
  // 可选 bundle 里已经不再有 bash/pwsh 行——这条断言防「上游又搬回去」而无人发现
  const bundleShells = rows(UPSTREAM_TERMINAL_BUNDLE, 'upstream experimental-terminal bundle')
    .filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(bundleShells.length, 0,
    'experimental-terminal bundle 里不该再有 dsh-terminal-bash 入口（0.2.2-rc.3 已搬去 preset 层）: '
    + bundleShells.map((r) => r.id).join(', '))
})

test('#1344 互斥性：非 win32（Android）下恰好一个 dsh-terminal-bash 入口启用', () => {
  for (const platform of ['android', 'linux', 'darwin']) {
    const enabled = enabledOn(UPSTREAM_PRESET_SHELL, platform).filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
    assert.deepEqual(enabled.map((r) => r.id), ['terminal-bash'],
      platform + ' 上默认启用的持久 Shell 后端必须只剩 bash 一个（pwsh 与 bash 抢同一个后端名 "shell"）: '
      + enabled.map((r) => r.id).join(', '))
  }
  const onWin = enabledOn(UPSTREAM_PRESET_SHELL, 'win32').filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.deepEqual(onWin.map((r) => r.id), ['terminal-pwsh'], 'win32 上反过来只该剩 pwsh')
})

test('#1344 profile 不再针对已消失的 terminal 行做禁用（旧兜底随本代下线）', () => {
  // 全量「禁用目标必须在上游存在」由 check-contract §8 守（它扫 base+web-app 全部行 id）。
  // 本测试只判与 #1344 相关的那一条：rc.3 上游已无 optional-terminal-pwsh 行。
  assert.ok(!PROFILE_PATCH.includes('- id: optional-terminal-pwsh'),
    'rc.3 上游已无 optional-terminal-pwsh 行，profile 不该再保留针对它的禁用条目')
  // 取而代之的是「preset 层互斥」这条判据——它必须在，否则等于本代把风险判断整段丢了。
  const shellRows = rows(UPSTREAM_PRESET_SHELL, 'preset').filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(shellRows.length, 2, 'preset 层两个入口必须在场，才能谈互斥')
  assert.ok(shellRows.every((r) => r.disabledExpr !== null && r.disabledExpr.startsWith('!!js ')),
    '两个入口都必须带 !!js 平台判据（缺一个就是 #1344 的原始缺陷形态）: '
    + shellRows.map((r) => r.id + '=' + r.disabledExpr).join(', '))
})

test('#1344 负控：去掉 pwsh 行的 !!js 判据后，两个同名后端同时启用（判据能分辨缺陷与修法）', () => {
  const regressed = UPSTREAM_PRESET_SHELL.replace(
    "                disabled: !!js process.platform !== 'win32'\n",
    '',
  )
  assert.notEqual(regressed, UPSTREAM_PRESET_SHELL, '负控本身要真的改到字节（否则是在测同一份输入）')
  const enabled = enabledOn(regressed, 'android').filter((r) => r.name === '@deepseek-ai/dsh-terminal-bash')
  assert.equal(enabled.length, 2,
    '去掉互斥判据后应看到两个同名后端入口（这正是设备上的冲突形态）: ' + enabled.map((r) => r.id).join(', '))
})
