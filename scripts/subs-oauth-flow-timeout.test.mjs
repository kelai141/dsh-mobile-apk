// OAuth 默认超时常量必须真的绑定进 vendored 入口（issue #1728）。
//
// 0.9.12 的已构建入口 `lib/index.js` 在 `OAuthFlowManager.start()` 里用
// `spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS`，但顶部只从 `./auth/oauth-flow.js`
// 导入了 `callbackReceivedPage`。常量在 `lib/auth/oauth-flow.js` 里确实有导出，
// 入口没导入 ⇒ 用户点「登录」时抛 `ReferenceError: DEFAULT_FLOW_TIMEOUT_MS is not defined`。
//
// 这类缺陷只在**执行到该分支**时暴露，静态 import 绑定就是它的判据：
//   1. 入口必须从 oauth-flow 模块导入这个标识符；
//   2. 被导入模块必须真的导出它；
//   3. 入口不得自己再声明一份（否则「同名局部变量」会掩盖漏导入）；
//   4. 合成一份「用了但没导入」的入口，本判据必须判红（证明能抓回原缺陷）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VENDOR = join(ROOT, 'vendor', 'dsh-plugin-subscriptions')
const INDEX = join(VENDOR, 'lib', 'index.js')
const OAUTH_FLOW = join(VENDOR, 'lib', 'auth', 'oauth-flow.js')

/** 入口从 relative 模块导入的绑定名。 */
export function importedBindings(source, modulePath) {
  const pattern = new RegExp('import\\s*\\{([^}]+)\\}\\s*from\\s*["\']' + modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']', 'g')
  const names = new Set()
  for (const match of source.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  return names
}

/** 判据：常量由 oauth-flow 模块提供，入口导入它且不自行声明。 */
export function missingDefaultFlowTimeout(source, exportedByModule) {
  const used = /DEFAULT_FLOW_TIMEOUT_MS/.test(source)
  if (!used) return '入口从未使用 DEFAULT_FLOW_TIMEOUT_MS（判据失效或实现已改）'
  const imported = importedBindings(source, './auth/oauth-flow.js')
  const declared = /(?:const|let|var|function|class)\s+DEFAULT_FLOW_TIMEOUT_MS\b/.test(source)
  if (declared) return '入口自行声明了 DEFAULT_FLOW_TIMEOUT_MS，会掩盖漏导入'
  if (!imported.has('DEFAULT_FLOW_TIMEOUT_MS')) return '入口使用 DEFAULT_FLOW_TIMEOUT_MS 却没有从 ./auth/oauth-flow.js 导入'
  if (!exportedByModule) return './auth/oauth-flow.js 没有导出 DEFAULT_FLOW_TIMEOUT_MS'
  return null
}

test('#1728 vendored 入口导入了 OAuth 默认超时常量', () => {
  const source = readFileSync(INDEX, 'utf8')
  const flow = readFileSync(OAUTH_FLOW, 'utf8')
  const exported = /export\s+const\s+DEFAULT_FLOW_TIMEOUT_MS\s*=/.test(flow)
  assert.equal(exported, true, './auth/oauth-flow.js 必须导出 DEFAULT_FLOW_TIMEOUT_MS')
  assert.equal(missingDefaultFlowTimeout(source, exported), null)
})

test('#1728 负控：用了却没导入的入口必须判红', () => {
  const broken = 'import { callbackReceivedPage } from "./auth/oauth-flow.js";\nconst timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;\n'
  assert.match(missingDefaultFlowTimeout(broken, true) ?? '', /没有从 .*oauth-flow\.js 导入/)
})

test('#1728 负控：入口自行声明同名常量必须判红', () => {
  const shadowed = 'import { callbackReceivedPage } from "./auth/oauth-flow.js";\nconst DEFAULT_FLOW_TIMEOUT_MS = 180000;\nconst timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;\n'
  assert.match(missingDefaultFlowTimeout(shadowed, true) ?? '', /自行声明/)
})

test('#1728 入口语法可解析（真实依赖只在快照树里，单测不加载模块）', () => {
  const check = spawnSync(process.execPath, ['--check', INDEX], { encoding: 'utf8' })
  assert.equal(check.status, 0, 'node --check 失败：' + (check.stderr || ''))
})
