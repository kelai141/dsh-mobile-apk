// scope-module.mjs — 从 dsh-app-boot 真实编译产物里抽出扫描函数字节并组装成可执行模块（S1 测试用）。
//
// 为什么抽字节而不是照源码重写一份实现：本测试要证明的是**产物里那些字节**语义等价，
// 重写一份等于重新发明实现，证明不了任何事。抽出来的函数各自在独立闭包里运行，
// 依赖（fs/path/createRequire）由外部注入，因此不需要整棵 node_modules 就能跑。
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

/** 按函数名抽出一个完整顶层函数定义；大括号配平，跳过字符串与注释。 */
export function extractFunction(source, name) {
  const sig = 'function ' + name + '('
  const start = source.indexOf(sig)
  if (start < 0) throw new Error('抽取失败：找不到 function ' + name)
  if (source.indexOf(sig, start + 1) >= 0) throw new Error('抽取失败：function ' + name + ' 出现多次')
  let i = source.indexOf('{', start)
  if (i < 0) throw new Error('抽取失败：function ' + name + ' 无函数体')
  let depth = 0
  let inString = null
  let inLineComment = false
  let inBlockComment = false
  for (; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 1
      }
      continue
    }
    if (inString !== null) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === inString) inString = null
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '\u0060') {
      inString = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('抽取失败：function ' + name + ' 大括号未配平')
}

const NEEDED = ['isPackagedExecutable', 'realModuleDirectory', 'readPackageManifest',
  'profileDependencyNames', 'packageDirFromAnchor', 'collectInstallationScopePackages', 'dependencyClosure']

/**
 * 用产物里的真实函数字节组装可执行闭包。
 *
 * 顶层 'let dshMobileRealDirectoryCache'（补丁引入的 per-scan 缓存变量）在函数体外，
 * 单独搬运；readProfileManifest 只被 skippedBundles 分支用到，按产物同名契约注入。
 * @param source dsh-app-boot 的 lib/index.js 全文（上游态或补丁后态均可）。
 * @returns 暴露 collectInstallationScopePackages / dependencyClosure / realModuleDirectory 的对象。
 */
export function buildScopeModule(source) {
  const parts = []
  const cacheDecl = /^let dshMobileRealDirectoryCache = .*$/m.exec(source)
  if (cacheDecl !== null) parts.push(cacheDecl[0])
  if (source.includes('function dshMobileRealDirectory(path) {')) {
    parts.push(extractFunction(source, 'dshMobileRealDirectory'))
  }
  for (const name of NEEDED) parts.push(extractFunction(source, name))

  const preamble = [
    'const { existsSync, lstatSync, readFileSync, realpathSync } = fsModule;',
    'const { basename, dirname, join } = pathModule;',
    'const { createRequire } = requireModule;',
    'function readProfileManifest(binName, dir) {',
    '  const p = join(dir, "package.json");',
    '  let raw;',
    '  try { raw = readFileSync(p, "utf8"); } catch (e) { throw new Error(binName + ": failed to read profile manifest " + p + ": " + String(e)); }',
    '  const parsed = JSON.parse(raw);',
    '  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(binName + ": profile manifest " + p + " must hold a JSON object");',
    '  return parsed;',
    '}',
  ].join('\n')
  const postamble = 'return { collectInstallationScopePackages, dependencyClosure, realModuleDirectory };'
  const factory = new Function('fsModule', 'pathModule', 'requireModule',
    [preamble, ...parts, postamble].join('\n'))
  return factory(
    { existsSync, lstatSync, readFileSync, realpathSync },
    { basename, dirname, join },
    { createRequire },
  )
}
