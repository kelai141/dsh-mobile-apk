import { replaceOnce } from '../lib/replace-once.mjs'

const MARKER = 'dsh-mobile appboot compileResolution realpath memo (S2)'
const PREFIXES = [
  'function prefixes(path) {',
  '	const configured = resolve(path) + sep;',
  '	const canonical = canonicalPath(path) + sep;',
  '	return canonical === configured ? [configured] : [configured, canonical];',
  '}',
].join('\n')
const CACHED_PREFIXES = PREFIXES
  .replace('prefixes(path)', 'prefixes(path, canonicalize = canonicalPath)')
  .replace('canonicalPath(path)', 'canonicalize(path)')

const COMPILE = 'function compileResolution(resolution) {'
const RESULT_HEAD = [
  '	return {',
  '		entries: new Map(resolution.entries.map((entry) => [entry.name, {',
  '			...entry,',
  '			realDir: canonicalPath(entry.packageDir)',
  '		}])),',
  '		profilesDir: resolution.profilesDir,',
  '		profileDir: resolution.profileDir,',
  '		profilePaths: prefixes(resolution.profilesDir),',
  '		profile: resolution.profileDir === void 0 ? [] : prefixes(resolution.profileDir),',
  '		installationPaths: [...new Set(resolution.entries.filter((entry) => entry.scope === "installation").flatMap((entry) => prefixes(entry.packageDir)))],',
  '		linkedPaths: resolution.linkedRoots.flatMap((root) => prefixes(root.realPath)),',
].join('\n')
const CACHED_COMPILE = [
  COMPILE,
  '	/* ' + MARKER + ' */',
  '	const canonicalPaths = new Map();',
  '	const canonicalize = (path) => {',
  '		let canonical = canonicalPaths.get(path);',
  '		if (canonical === void 0) {',
  '			canonical = canonicalPath(path);',
  '			canonicalPaths.set(path, canonical);',
  '		}',
  '		return canonical;',
  '	};',
  RESULT_HEAD
    .replace('canonicalPath(entry.packageDir)', 'canonicalize(entry.packageDir)')
    .replace('prefixes(resolution.profilesDir)', 'prefixes(resolution.profilesDir, canonicalize)')
    .replace('prefixes(resolution.profileDir)', 'prefixes(resolution.profileDir, canonicalize)')
    .replace('prefixes(entry.packageDir)', 'prefixes(entry.packageDir, canonicalize)')
    .replace('prefixes(root.realPath)', 'prefixes(root.realPath, canonicalize)'),
].join('\n')

const unique = (source, anchor) => source.split(anchor).length === 2
const hasUniqueFunctions = (source) => unique(source, 'function prefixes(')
  && unique(source, 'function compileResolution(')

export function hasAppbootCompileResolution(source) {
  return hasUniqueFunctions(source) && source.includes(CACHED_PREFIXES) && source.includes(CACHED_COMPILE)
}

export function patchAppbootCompileResolution(source) {
  if (hasAppbootCompileResolution(source)) return source
  if (source.includes(MARKER)) throw new Error('appboot-compile-resolution-S2: partial marker')
  if (!hasUniqueFunctions(source)) {
    throw new Error('appboot-compile-resolution-S2: expected one prefixes and one compileResolution definition')
  }
  const patched = replaceOnce(source, PREFIXES, CACHED_PREFIXES, 'app-boot prefixes')
  return replaceOnce(patched, COMPILE + '\n' + RESULT_HEAD, CACHED_COMPILE, 'app-boot compileResolution')
}
