/**
 * dsh-app-boot 0.2.1-rc.2：profile 的 node_modules 里第三方软链不可读时，整份 profile 组合失败。
 *
 * 现象：用户在 profile 里用本地路径或 pnpm link 接入第三方包；升级后链接目标被删、权限变化，
 * 或链接指向普通文件时，`linkedProfileRoots()` 的 `realpath` / `stat` 直接抛出
 * EACCES / EPERM / ENOENT / ENOTDIR，调用链一路冒泡，整个 profile 的运行时解析（以及启动）失败。
 * 一个坏链接不应该让其余插件都不可用。
 *
 * 修法：只在这条扫描链上把四种「该链接不可用」的文件系统错误降级为跳过并告警。
 *   - 根 node_modules 或 @scope 目录不可读时，跳过该范围，其余目录继续扫描；
 *   - 单个链接的 realpath 失败，或 realpath 成功后目标消失（stat 失败），跳过该链接；
 *   - EIO、EMFILE、EINVAL 等其它错误原样抛出，不把系统故障伪装成坏链接；
 *   - 告警只写相对名称与错误码，不写 error.message（可能带完整路径）或异常对象；
 *   - 同一模块目录、名称与错误码每进程只告警一次，重复计算分辨率不刷屏。
 *
 * 合法链接的判定保持不变：仍排除 profiles 共享树内、活动 profile 内、以及目标不是目录的链接。
 * `removeLinkProjections()` 继续使用不带回调的 `symlinksUnder()`，任何读取失败仍会抛出。
 */

export const PROFILE_LINK_SKIP_MARKER = 'dsh-mobile profile link skip (PL1)'
export const PROFILE_LINK_SKIP_ID = 'profile-link-skip-PL1'

const SYMLINKS_ANCHOR = [
  '/** Top-level and scoped entries under a node_modules directory that are symlinks or junctions. */',
  'function symlinksUnder(modules) {',
  '\tconst links = [];',
  '\tif (!existsSync(modules)) return links;',
  '\tfor (const entry of readdirSync(modules, { withFileTypes: true })) {',
  '\t\tconst path = join(modules, entry.name);',
  '\t\tif (entry.isSymbolicLink()) links.push(path);',
  '\t\telse if (entry.name.startsWith("@") && entry.isDirectory()) {',
  '\t\t\tfor (const child of readdirSync(path, { withFileTypes: true })) if (child.isSymbolicLink()) links.push(join(path, child.name));',
  '\t\t}',
  '\t}',
  '\treturn links;',
  '}',
].join('\n')

const LINKS_ANCHOR = [
  '/**',
  '* Active profile `node_modules` entries linked outside the shared profiles tree and the active profile.',
  "* Missing targets and files are not linked roots; invalid link chains retain Node's diagnostic.",
  '*/',
  'function linkedProfileRoots(profile, profilesDir) {',
  '\tconst modules = join(profile.dir, "node_modules");',
  '\tconst links = symlinksUnder(modules);',
  '\tif (links.length === 0) return [];',
  '\tlet tree;',
  '\ttry {',
  '\t\ttree = realModuleDirectory(profilesDir) + sep;',
  '\t} catch (error) {',
  '\t\tif (error.code !== "ENOENT") throw error;',
  '\t\ttree = resolve(profilesDir) + sep;',
  '\t}',
  '\tconst excludedTrees = [tree, realModuleDirectory(profile.dir) + sep];',
  '\tconst roots = [];',
  '\tfor (const linkPath of links) {',
  '\t\tlet realPath;',
  '\t\ttry {',
  '\t\t\trealPath = realModuleDirectory(linkPath);',
  '\t\t} catch (error) {',
  '\t\t\tif (error.code !== "ENOENT") throw error;',
  '\t\t\tcontinue;',
  '\t\t}',
  '\t\tif (excludedTrees.some((prefix) => realPath + sep === prefix || realPath.startsWith(prefix)) || !statSync(realPath).isDirectory()) continue;',
  '\t\troots.push({',
  '\t\t\tname: relative(modules, linkPath).split(sep).join("/"),',
  '\t\t\trealPath',
  '\t\t});',
  '\t}',
  '\treturn roots.sort((left, right) => left.name.localeCompare(right.name));',
  '}',
].join('\n')

const ANCHOR = SYMLINKS_ANCHOR + '\n' + LINKS_ANCHOR

const REPLACEMENT = [
  "/* " + PROFILE_LINK_SKIP_MARKER + ": a linked package in the profile's node_modules may become",
  ' * unreadable (EACCES/EPERM), vanish (ENOENT), or stop being a directory (ENOTDIR). Skip that',
  ' * link with one bounded warning so the rest of the profile still resolves; every other',
  ' * filesystem failure stays fatal. Legitimate external directory links are still collected,',
  ' * while links inside the profiles tree, the active profile, and non-directories stay excluded. */',
  'const DSH_MOBILE_PROFILE_LINK_SKIP_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR"]);',
  'const DSH_MOBILE_PROFILE_LINK_WARNED = /* @__PURE__ */ new Set();',
  '/**',
  '* Whether a filesystem failure only means one linked package is unusable.',
  '* @param error - the caught filesystem error.',
  '* @returns true for permission, missing-target, and not-a-directory failures.',
  '*/',
  'function dshMobileProfileLinkSkip(error) {',
  '\treturn DSH_MOBILE_PROFILE_LINK_SKIP_CODES.has(String(error?.code));',
  '}',
  '/**',
  '* Warn once per scanned directory, entry name, and code.',
  '* Only the relative name and the code are printed: an error message may carry a full path',
  '* (or other host detail) and this scan must not copy it into the engine log.',
  '* @param modules - the profile node_modules directory being scanned.',
  '* @param name - the entry name relative to that directory.',
  '* @param error - the caught filesystem error.',
  '*/',
  'function dshMobileWarnProfileLink(modules, name, error) {',
  '\tconst code = String(error?.code);',
  '\tconst key = modules + "\\0" + name + "\\0" + code;',
  '\tif (DSH_MOBILE_PROFILE_LINK_WARNED.has(key)) return;',
  '\tDSH_MOBILE_PROFILE_LINK_WARNED.add(key);',
  '\tconsole.warn(' + '`dsh-mobile profile link skip (PL1): skipped ${JSON.stringify(name)} (${code}); the profile continues without it. Remove or relink the package to clear this warning.`' + ');',
  '}',
  '/**',
  '* Top-level and scoped entries under a node_modules directory that are symlinks or junctions.',
  '* @param modules - the node_modules directory to scan.',
  '* @param onSkip - optional sink for an unreadable directory; without it every error is thrown.',
  '* @returns the symlink paths discovered.',
  '*/',
  'function symlinksUnder(modules, onSkip) {',
  '\tconst links = [];',
  '\tif (!existsSync(modules)) return links;',
  '\tlet entries;',
  '\ttry {',
  '\t\tentries = readdirSync(modules, { withFileTypes: true });',
  '\t} catch (error) {',
  '\t\tif (onSkip === void 0 || !dshMobileProfileLinkSkip(error)) throw error;',
  '\t\tonSkip(modules, "node_modules", error);',
  '\t\treturn links;',
  '\t}',
  '\tfor (const entry of entries) {',
  '\t\tconst path = join(modules, entry.name);',
  '\t\tif (entry.isSymbolicLink()) links.push(path);',
  '\t\telse if (entry.name.startsWith("@") && entry.isDirectory()) {',
  '\t\t\tlet children;',
  '\t\t\ttry {',
  '\t\t\t\tchildren = readdirSync(path, { withFileTypes: true });',
  '\t\t\t} catch (error) {',
  '\t\t\t\tif (onSkip === void 0 || !dshMobileProfileLinkSkip(error)) throw error;',
  '\t\t\t\tonSkip(modules, entry.name, error);',
  '\t\t\t\tcontinue;',
  '\t\t\t}',
  '\t\t\tfor (const child of children) if (child.isSymbolicLink()) links.push(join(path, child.name));',
  '\t\t}',
  '\t}',
  '\treturn links;',
  '}',
  '/**',
  '* Active profile `node_modules` entries linked outside the shared profiles tree and the active profile.',
  '* Unreadable, missing, or non-directory linked targets are skipped with a warning; other',
  "* filesystem failures keep Node's diagnostic.",
  '*/',
  'function linkedProfileRoots(profile, profilesDir) {',
  '\tconst modules = join(profile.dir, "node_modules");',
  '\tconst links = symlinksUnder(modules, (root, name, error) => dshMobileWarnProfileLink(root, name, error));',
  '\tif (links.length === 0) return [];',
  '\tlet tree;',
  '\ttry {',
  '\t\ttree = realModuleDirectory(profilesDir) + sep;',
  '\t} catch (error) {',
  '\t\tif (error.code !== "ENOENT") throw error;',
  '\t\ttree = resolve(profilesDir) + sep;',
  '\t}',
  '\tconst excludedTrees = [tree, realModuleDirectory(profile.dir) + sep];',
  '\tconst roots = [];',
  '\tfor (const linkPath of links) {',
  '\t\tconst name = relative(modules, linkPath).split(sep).join("/");',
  '\t\tlet realPath;',
  '\t\ttry {',
  '\t\t\trealPath = realModuleDirectory(linkPath);',
  '\t\t} catch (error) {',
  '\t\t\tif (!dshMobileProfileLinkSkip(error)) throw error;',
  '\t\t\tdshMobileWarnProfileLink(modules, name, error);',
  '\t\t\tcontinue;',
  '\t\t}',
  '\t\tlet isDirectory;',
  '\t\ttry {',
  '\t\t\tisDirectory = statSync(realPath).isDirectory();',
  '\t\t} catch (error) {',
  '\t\t\tif (!dshMobileProfileLinkSkip(error)) throw error;',
  '\t\t\tdshMobileWarnProfileLink(modules, name, error);',
  '\t\t\tcontinue;',
  '\t\t}',
  '\t\tif (excludedTrees.some((prefix) => realPath + sep === prefix || realPath.startsWith(prefix)) || !isDirectory) continue;',
  '\t\troots.push({',
  '\t\t\tname,',
  '\t\t\trealPath',
  '\t\t});',
  '\t}',
  '\treturn roots.sort((left, right) => left.name.localeCompare(right.name));',
  '}',
].join('\n')

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error(PROFILE_LINK_SKIP_ID + ': ' + label + ': 期望恰好命中 1 处，实际 ' + count)
  return text.replace(before, after)
}

/** 是否已完整施加（marker、四个错误码与告警去重都必须在场）。 */
export function hasProfileLinkSkip(source) {
  return source.includes(PROFILE_LINK_SKIP_MARKER)
    && source.includes('DSH_MOBILE_PROFILE_LINK_SKIP_CODES')
    && source.includes('DSH_MOBILE_PROFILE_LINK_WARNED')
    && source.includes('dshMobileWarnProfileLink')
    && source.includes('function symlinksUnder(modules, onSkip) {')
    && source.includes('symlinksUnder(modules, (root, name, error)')
}

/**
 * 施加补丁（幂等）。
 *
 * 锚点必须恰好命中一次：`symlinksUnder` 与 `linkedProfileRoots` 在发布产物里各只有一处。
 * 出现两处说明上游新增了扫描点，必须人工重新判断；marker 在但结构不完整说明产物被改过，
 * 同样拒绝写回。
 * @param source - 上游 `dsh-app-boot/lib/index.js` 的原始文本。
 * @returns 施加后的文本；已施加时返回原对象。
 */
export function patchProfileLinkSkip(source) {
  if (hasProfileLinkSkip(source)) return source
  if (source.includes(PROFILE_LINK_SKIP_MARKER)) {
    throw new Error(PROFILE_LINK_SKIP_ID + ': 检测到 marker 但结构不完整，拒绝在可疑产物上继续')
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const before = newline === '\n' ? ANCHOR : ANCHOR.replace(/\n/g, newline)
  const after = newline === '\n' ? REPLACEMENT : REPLACEMENT.replace(/\n/g, newline)
  const patched = replaceOnce(source, before, after, 'symlinksUnder + linkedProfileRoots')
  if (!hasProfileLinkSkip(patched)) {
    throw new Error(PROFILE_LINK_SKIP_ID + ': 复核失败——不写回')
  }
  return patched
}
