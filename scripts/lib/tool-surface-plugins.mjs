// issue #1049：工具面预算要统计的插件集合 —— **动态发现**，不硬编码。
//
// 旧实现在门禁文件里写死 6 个插件名 ⇒ 第 7 个插件（dsh-session-delete）注册的工具
// 完全不计入预算，而预算判据的意义正是「总工具面不许悄悄变大」。
//
// 抽到 lib 的理由：门禁文件顶层有副作用（读产物、process.exit），单测无法直接 import。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 无 `lib/index.js` 产物的插件 —— **逐条带理由**，不是硬编码白名单。
 * 判据只有一条：它是否由插件构建产出 `lib/index.js`。
 */
export const NO_LIB_ARTIFACT = {
  'dsh-linux-bootstrap': '纯 JS 引导包（src/index.js 直接分发），构建不产出 lib/index.js',
}

/**
 * 退役插件目录：**不参与**装配，也就不允许以「插件」身份进预算。
 *
 * 名单从 `scripts/plugin-dirs.json` 的 `retiredDirs` 读，不在门禁里另写一份：
 * 两处各写一份必然漂移，而漂移的表现正是「退役插件又被算进模型面预算」这种假红/假绿。
 */
export const retiredPluginNames = (root = ROOT) => {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'plugin-dirs.json'), 'utf8'))
    return new Set((manifest.retiredDirs ?? []).map((dir) => join(root, dir)).map((dir) => {
      const parts = dir.split(/[\\/]/)
      return parts[parts.length - 1]
    }))
  } catch {
    return new Set()
  }
}

/** `plugins/*` 下所有带 `package.json` 的目录名（排序）。 */
export const discoverToolPlugins = (root = ROOT) => {
  const dir = join(root, 'plugins')
  if (!existsSync(dir)) return []
  const retired = retiredPluginNames(root)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .filter((name) => NO_LIB_ARTIFACT[name] === undefined && !retired.has(name))
    .sort()
}

export const PLUGINS = discoverToolPlugins()
