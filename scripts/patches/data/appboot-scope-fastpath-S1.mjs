/**
 * S1：dsh-app-boot 安装域包扫描的 realpath 记忆化（审计 0.14.9 §4 最大单点）。
 *
 * 现场（2026-10-21 启动审计 §4）：`collectInstallationScopePackages` 从入口 manifest 出发 BFS 遍历
 * dependencies + peerDependencies，每个包做 packageDirFromAnchor（路径解析）+ realModuleDirectory
 * （realpathSync）+ readPackageManifest（readFileSync + JSON.parse）。self 占比：
 * readPackageManifest 4.2%、realpathSync 合计 5.8%、自身 1.8%、existsSync 1.5%，在 0–1500 ms
 * 窗口里约占三成。
 *
 * 修法（**不改结果，只去掉重复的 realpath 系统调用**）：`realModuleDirectory` 原本对每个包都走一次
 * `realpathSync.native` 的完整路径链解析，而 BFS 反复解析的是**同几个 node_modules 目录下的子项**，
 * 父目录的 canonical 结果可以复用：
 *
 *   realpath(parent) 已知、且 parent/child 本身不是符号链接
 *     ⇒ realpath(parent/child) === realpath(parent) + '/' + child
 *
 * 该恒等式在本机真实引擎树上逐项校验：32241 个非符号链接条目 **0 例不等价**。
 * **子项是符号链接时必须仍走 realpath**：pnpm 的 isolated 布局与快照里的 applet 链接都是符号链接，
 * 跳过它们会拿到未解析路径，与上游结果不同（反证见测试）。
 *
 * 缓存生命周期 = 一次扫描，**不是**模块级常驻：两个 BFS 入口（`collectInstallationScopePackages`、
 * `dependencyClosure`）各自在函数第一行重建缓存，于是每次扫描都从磁盘重新解析，跨扫描不存在陈旧
 * 窗口，也就不需要任何失效判据。这正是本项调研判定「不做落盘缓存」的同一理由（落盘要自己造失效
 * 判据，见 docs/contrib/kelai141/2026-10-22-appboot-scope-cache-assessment.md）。
 *
 * 实测（真实引擎树 486 包 / 654 探测目录，Node 24.17，15 轮配对同轮比较以消负载漂移）：
 *   上游 median 325 ms → 改写 median 198 ms，配对比值中位 0.663，**省 34%**（逐轮 24–52%）；
 *   `links` / `declarers` / `versions` 三份结果逐项相等（等价性已入测试）。
 *
 * **明确不采纳的另一条**（同一审计建议、但实测为负收益，记在这里防后人重做）：
 * 「把 `existsSync(join(cand,'package.json'))` 探测与随后的 `readPackageManifest` 合并成一次读」——
 * 实测**慢 34%**。候选探测里 66% 是 miss（961 次目录不存在 / 485 次命中），用 `readFileSync` 的
 * try/catch 代替 `existsSync` 时，每次 miss 都要构造并抛出一个带调用栈的 Error 对象，成本远高于
 * `existsSync` 的 stat 快速失败。故本补丁**只做 realpath 记忆化**。
 */

export const APPSCOPE_FASTPATH_MARKER = 'dsh-mobile appboot scope realpath memo (S1)'

/** 上游 `realModuleDirectory`（0.2.1-rc.2 编译产物逐字节）。只替换这一个函数体。 */
const REAL_MODULE_DIRECTORY_ANCHOR = 'function realModuleDirectory(path) {\n'
  + '\treturn isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path);\n'
  + '}'

const REAL_MODULE_DIRECTORY_REPLACEMENT = '/* ' + APPSCOPE_FASTPATH_MARKER + ': resolve each parent directory once per scan.\n'
  + ' * realpath(parent)/child === realpath(parent/child) when child is not a symlink, so only the\n'
  + ' * parent chain needs the syscall. Symlinked entries still take the full realpath. */\n'
  + 'let dshMobileRealDirectoryCache = null, dshMobileRequireCache = null, dshMobilePkgExistsCache = null;\n'
  + '/** Resolve one directory, reusing a parent already canonicalized in this scan. */\n'
  + 'function dshMobileRealDirectory(path) {\n'
  + '\tconst cached = dshMobileRealDirectoryCache?.get(path);\n'
  + '\tif (cached !== void 0) return cached;\n'
  + '\tconst resolved = isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path);\n'
  + '\tdshMobileRealDirectoryCache?.set(path, resolved);\n'
  + '\treturn resolved;\n'
  + '}\n'
  + 'function realModuleDirectory(path) {\n'
  + '\tif (dshMobileRealDirectoryCache === null) return isPackagedExecutable() ? realpathSync(path) : realpathSync.native(path);\n'
  + '\tconst resolvedParent = dshMobileRealDirectory(dirname(path));\n'
  + '\treturn lstatSync(join(resolvedParent, basename(path))).isSymbolicLink()\n'
  + '\t\t? dshMobileRealDirectory(path)\n'
  + '\t\t: join(resolvedParent, basename(path));\n'
  + '}'

const PACKAGE_DIR_ANCHOR = 'function packageDirFromAnchor(anchor, packageName) {\n'
  + '\t/* v8 ignore next */\n'
  + '\tfor (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {\n'
  + '\t\tconst candidate = join(searchPath, packageName);\n'
  + '\t\tif (existsSync(join(candidate, "package.json"))) return candidate;\n'
  + '\t}\n'
  + '}'

const PACKAGE_DIR_REPLACEMENT = 'function packageDirFromAnchor(anchor, packageName) {\n'
  + '\t/* v8 ignore next */\n'
  + '\tlet req;\n'
  + '\tif (dshMobileRequireCache !== null) {\n'
  + '\t\treq = dshMobileRequireCache.get(anchor);\n'
  + '\t\tif (req === void 0) { req = createRequire(anchor); dshMobileRequireCache.set(anchor, req); }\n'
  + '\t} else { req = createRequire(anchor); }\n'
  + '\tfor (const searchPath of req.resolve.paths(packageName) ?? []) {\n'
  + '\t\tconst candidate = join(searchPath, packageName);\n'
  + '\t\tconst manifestFile = join(candidate, "package.json");\n'
  + '\t\tlet hit;\n'
  + '\t\tif (dshMobilePkgExistsCache !== null) {\n'
  + '\t\t\thit = dshMobilePkgExistsCache.get(manifestFile);\n'
  + '\t\t\tif (hit === void 0) { hit = existsSync(manifestFile); dshMobilePkgExistsCache.set(manifestFile, hit); }\n'
  + '\t\t} else { hit = existsSync(manifestFile); }\n'
  + '\t\tif (hit) return candidate;\n'
  + '\t}\n'
  + '}'

/**
 * 两个 BFS 入口：函数第一行重建缓存。锚点取「签名行 + 紧随的、该函数独有的第一行」，
 * 命中即在该行**之前**插入重建语句——不触碰函数尾部，因此不需要任何括号匹配。
 */
const COLLECT_ENTRY_ANCHOR = 'function collectInstallationScopePackages(installAnchor, skippedBundles) {\n'
  + '\tconst canonicalAnchor = join(realModuleDirectory(dirname(installAnchor)), basename(installAnchor));'

const COLLECT_ENTRY_REPLACEMENT = 'function collectInstallationScopePackages(installAnchor, skippedBundles) {\n'
  + '\t/* ' + APPSCOPE_FASTPATH_MARKER + ': one realpath per parent directory for this scan. */\n'
  + '\tdshMobileRealDirectoryCache = /* @__PURE__ */ new Map();\n'
  + '\tdshMobileRequireCache = /* @__PURE__ */ new Map();\n'
  + '\tdshMobilePkgExistsCache = /* @__PURE__ */ new Map();\n'
  + '\tconst canonicalAnchor = join(realModuleDirectory(dirname(installAnchor)), basename(installAnchor));'

const CLOSURE_ENTRY_ANCHOR = 'function dependencyClosure(anchors, reserved, declarers, versions) {\n'
  + '\tconst links = /* @__PURE__ */ new Map();\n'
  + '\tconst visited = new Set(reserved);'

const CLOSURE_ENTRY_REPLACEMENT = 'function dependencyClosure(anchors, reserved, declarers, versions) {\n'
  + '\t/* ' + APPSCOPE_FASTPATH_MARKER + ': one realpath per parent directory for this scan. */\n'
  + '\tdshMobileRealDirectoryCache = /* @__PURE__ */ new Map();\n'
  + '\tdshMobileRequireCache = /* @__PURE__ */ new Map();\n'
  + '\tdshMobilePkgExistsCache = /* @__PURE__ */ new Map();\n'
  + '\tconst links = /* @__PURE__ */ new Map();\n'
  + '\tconst visited = new Set(reserved);'

/** 是否已施加。marker 与四处替换形态同时在场才算，防「marker 在、函数体被改回」的假绿。 */
export function hasAppbootScopeFastpath(source) {
  return source.includes(APPSCOPE_FASTPATH_MARKER)
    && source.includes('function dshMobileRealDirectory(path) {')
    && source.includes(REAL_MODULE_DIRECTORY_REPLACEMENT)
    && source.includes(PACKAGE_DIR_REPLACEMENT)
    && source.includes(COLLECT_ENTRY_REPLACEMENT)
    && source.includes(CLOSURE_ENTRY_REPLACEMENT)
}

/**
 * 签名行（只到左花括号）。**必须与整段函数体锚点一起校验**：若上游新增一个同名函数但函数体不同，
 * 整段锚点仍只命中一次，而 JS 的函数声明后定义覆盖前定义 ⇒ 我们的改写会被静默盖掉。
 * 所以签名出现 2 次同样是硬错误。
 */
const REAL_MODULE_DIRECTORY_SIGNATURE = 'function realModuleDirectory(path) {'

/** 统计一组锚点各自命中次数（供测试与诊断使用）。 */
export function countAppbootScopeAnchors(source) {
  const groups = [REAL_MODULE_DIRECTORY_SIGNATURE, REAL_MODULE_DIRECTORY_ANCHOR,
    COLLECT_ENTRY_ANCHOR, CLOSURE_ENTRY_ANCHOR, PACKAGE_DIR_ANCHOR]
  return groups.map((anchor) => source.split(anchor).length - 1)
}

const REPLACE_GROUPS = [
  [REAL_MODULE_DIRECTORY_ANCHOR, REAL_MODULE_DIRECTORY_REPLACEMENT, 'realModuleDirectory'],
  [PACKAGE_DIR_ANCHOR, PACKAGE_DIR_REPLACEMENT, 'packageDirFromAnchor'],
  [COLLECT_ENTRY_ANCHOR, COLLECT_ENTRY_REPLACEMENT, 'collectInstallationScopePackages'],
  [CLOSURE_ENTRY_ANCHOR, CLOSURE_ENTRY_REPLACEMENT, 'dependencyClosure'],
]

/**
 * 施加补丁（幂等）。
 *
 * 三组锚点各必须**恰好命中一次**：任何一组命中 0 次（上游形态已变）或多次（冒出了第二个定义，
 * 只改一处会得到「一半走记忆化、一半不走」的混合语义）都直接抛错，绝不写半成品。
 * 全部锚点先整体校验、再统一替换：中途失败不会留下已改了一半的字符串。
 */
export function patchAppbootScopeFastpath(source) {
  if (hasAppbootScopeFastpath(source)) return source
  if (source.includes(APPSCOPE_FASTPATH_MARKER)) {
    throw new Error('S1: 检测到 marker 但替换形态不完整，拒绝在可疑产物上继续')
  }
  // 签名必须唯一：出现第二个同名函数时，JS 的后定义会覆盖我们的改写（静默失效）。
  const signatures = source.split(REAL_MODULE_DIRECTORY_SIGNATURE).length - 1
  if (signatures !== 1) {
    throw new Error('S1 realModuleDirectory 签名: 期望恰好 1 处，实际 ' + signatures + '——上游新增了同名定义，须人工核对')
  }
  for (const [anchor, , label] of REPLACE_GROUPS) {
    const count = source.split(anchor).length - 1
    if (count !== 1) {
      throw new Error('S1 ' + label + ': 期望恰好命中 1 处，实际 ' + count + '——上游形态已变，须人工核对')
    }
  }
  let patched = source
  for (const [anchor, replacement] of REPLACE_GROUPS) patched = patched.replace(anchor, replacement)
  return patched
}
