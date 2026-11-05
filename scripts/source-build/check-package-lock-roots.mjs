import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function normalized(value) {
  return JSON.stringify(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

export function checkPackageLockRoot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  const root = lock.packages?.['']
  if (!root) return [`${directory}: package-lock.json 缺少 packages[""]`]

  const errors = []
  for (const field of ['name', 'version']) {
    if (manifest[field] !== root[field]) {
      errors.push(`${directory}: ${field} 不一致 (${manifest[field]} != ${root[field]})`)
    }
  }
  for (const field of dependencyFields) {
    if (normalized(manifest[field]) !== normalized(root[field])) {
      errors.push(`${directory}: ${field} 与 package-lock.json 根声明不一致`)
    }
  }
  return errors
}

/**
 * 锁文件「就地重写」判据（issue #1615）。
 *
 * 缺陷形态：CI 先跑 `npm install --package-lock-only`，它会**直接改写仓内的 package-lock.json**；
 * 随后只查 root 面（checkPackageLockRoot），而 inputLockSha256 / resolvedLockSha256 只记不判。
 * 于是「提交进仓的 lock 缺 resolved/integrity 字段」时，npm 会静默从 registry 补齐并安装 ——
 * 报告里留下两个不同的哈希，链却全绿，安装图已经不是提交的那一份。
 *
 * 立论与 check-vendor-provenance 同源：锁文件**可以**变，但必须显式、可见（在 PR 里更新并提交）。
 * 这里把「变没变」判成一条可复用的纯函数，供安装器在 npm ci 之前调用。
 *
 * @param {{inputLockSha256: string, resolvedLockSha256: string}} digests 重写前后的锁文件摘要。
 * @returns {string|null} 判红文案；相等（无位移）时返回 null。
 */
export function lockRewriteProblem({
  inputLockSha256, resolvedLockSha256,
  // 参数别名：合并三支时两边的调用点用了不同名字（#1636 的 inputSha256 / #1637 的 inputLockSha256），
  // 判据本体只有一个，别名在此收口，避免为了名字再造一份实现。
  inputSha256, resolvedSha256,
  inputLockText, resolvedLockText, inputText, resolvedText, directoryArg,
} = {}) {
  const a = inputLockSha256 ?? inputSha256
  const b = resolvedLockSha256 ?? resolvedSha256
  const inText = inputLockText ?? inputText
  const resText = resolvedLockText ?? resolvedText
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return '锁文件摘要缺席（input/resolved）——无法判断依赖解析是否就地重写了 lock'
  }
  if (a === b) return null
  // 判红文案必须**点名「就地重写」**并给出差异面：只报一个哈希差，排查者看不出影响范围。
  // 差异面走 lockDiffSummary（结构化），并在图完全相同时如实说明「只有字节不同」——
  // 那一类正是「提交的 lock 缺 resolved/integrity、CI 从 registry 补齐」的可判形态。
  // 差异面：lockDiffSummary 返回结构化对象，这里格式化成可读文本。
  // 「图完全相同、只有字节不同」必须如实说明——那一类正是「提交的 lock 缺 resolved/integrity、
  // CI 从 registry 补齐」的可判形态，只说「哈希变了」会让排查者以为有版本变更。
  let diff = '  (no lock text supplied)\n'
  let graphIdentical = false
  if (typeof inText === 'string' && typeof resText === 'string') {
    try {
      const d = lockDiffSummary(JSON.parse(inText), JSON.parse(resText))
      const parts = []
      if (d.counts.added > 0) parts.push('  added by CI (' + d.counts.added + '): ' + d.added.slice(0, 12).join(', '))
      if (d.counts.removed > 0) parts.push('  removed (' + d.counts.removed + '): ' + d.removed.slice(0, 12).join(', '))
      if (d.counts.changed > 0) parts.push('  changed (' + d.counts.changed + '): ' + d.changed.slice(0, 12).join(', '))
      graphIdentical = parts.length === 0
      // 「提交的 lock 缺 resolved/integrity、CI 从 registry 补齐」这一类必须**显式点名**：
      // 只说「某个包 changed」维护者不知道该补什么字段；这一类的正确修法是重跑 --package-lock-only 并提交。
      const before = JSON.parse(inText)?.packages ?? {}
      const noResolved = Object.keys(before)
        .filter((k) => k !== '' && before[k] && typeof before[k] === 'object' && !('resolved' in before[k]))
      const noResolvedNote = noResolved.length > 0
        ? '  no resolved in committed lock (' + noResolved.length + '): ' + noResolved.slice(0, 12).join(', ') + '\n'
        : ''
      diff = (parts.length === 0
        ? '  (package graph unchanged; only metadata bytes differ)\n'
        : parts.join('\n') + '\n') + noResolvedNote
    } catch {
      diff = '  (lock unparseable)\n'
    }
  }
  // 文案口径：**首句中文点题**（与仓内其余判据一致，且测试与日志检索都按它匹配），
  // 其后英文细节给出差异面与修法。合并三支时两边各写了一种语言，取中文首句 + 英文正文，
  // 不保留两份实现、也不为了适配某一边的夹具去改判据文案。
  return 'npm install --package-lock-only 就地重写了 package-lock.json（'
    + String(a).slice(0, 16) + ' -> ' + String(b).slice(0, 16) + '）。\n'
    + '提交进仓的 lock 不完整（缺 resolved/integrity 或已过期），CI 不得静默从 registry 补齐后照单安装。\n'
    + 'Lock graph diff (committed -> resolved):\n' + diff
    + (graphIdentical ? '  (no resolved/integrity delta in the package graph; only metadata bytes differ)\n' : '')
    + 'Fix: update and commit the lock in a PR — (cd ' + String(directoryArg ?? '<dir>') + ' && npm install --package-lock-only --ignore-scripts).\n'
    + 'issue #1615：锁文件必须先在 PR 里更新并提交。'
}

/** 锁文件结构性差异（用于把「重写了什么」打到日志里，不让差异只活在一个哈希里）。 */
export function lockDiffSummary(before, after, limit = 12) {
  const flatten = (lock) => {
    const out = new Map()
    for (const [key, value] of Object.entries(lock?.packages ?? {})) {
      out.set(key, JSON.stringify(value))
    }
    return out
  }
  const a = flatten(before)
  const b = flatten(after)
  const added = [...b.keys()].filter((k) => !a.has(k))
  const removed = [...a.keys()].filter((k) => !b.has(k))
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k))
  return {
    added: added.slice(0, limit), removed: removed.slice(0, limit), changed: changed.slice(0, limit),
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  }
}

export function packageDirectories(repoRoot) {
  const candidates = ['dsh-client-ui-responsive', 'dsh-shell-termux']
  const pluginRoot = path.join(repoRoot, 'plugins')
  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join('plugins', entry.name))
  }
  return candidates
    .map((relative) => path.join(repoRoot, relative))
    .filter((directory) => fs.existsSync(path.join(directory, 'package-lock.json')))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(process.argv[2] ?? '.')
  const directories = packageDirectories(repoRoot)
  // 空过守卫：受检集合是**发现式**的（packageDirectories 只收「存在 package-lock.json」的目录），
  // 旧实现下「锁文件缺席」与「根声明一致」都表现为绿——删掉/改名任一锁文件，该目录即从集合里
  // 静默消失，门禁照印「一致」退 0。而这正是它要防的事：构建链那边（build-apk-source.yml 的
  // 插件循环）按 `if [ -f package-lock.json ]` 决定 `npm ci` 还是 `npm install`，锁一缺就从
  // 「严格按锁文件」降级成「重新解析版本区间」——产出不再可复现，全链仍然绿。
  // 故对**具名**的两个目录（它们不靠发现，是写死在 packageDirectories 里的）断言必须在场。
  const named = ['dsh-client-ui-responsive', 'dsh-shell-termux']
  const errors = [
    ...named
      .filter((relative) => !directories.includes(path.join(repoRoot, relative)))
      .map((relative) => `${relative}: package-lock.json 缺席——该目录已从受检集合消失（构建会降级为不可复现的 npm install）`),
    ...directories.flatMap(checkPackageLockRoot),
  ]
  if (directories.length === 0) {
    errors.push('受检目录为空——锁文件根声明判据没有任何输入（大概率是锁文件被删/被改名）')
  }
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else {
    console.log(`package-lock 根声明一致: ${directories.length} 个目录`)
  }
}