// Extend the existing F3 patch in the engine stage, leaving npm package
// identity and the upstream errno mapping intact.
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const anchor = '        // dsh-mobile flock fallback (F3): no prebuilt binding for this platform. Single-process host\n'
const marker = '// dsh-mobile: Android session flock from APK nativeLibraryDir'
const imports = [
  'import { statSync as dshFlockStat } from "node:fs";',
  'import { isAbsolute as dshFlockIsAbsolute } from "node:path";',
  '',
].join('\n')
const loader = [
  '        ' + marker,
  '        if (platform === "android") {',
  '            const libDir = process.env.DSH_NATIVE_LIB_DIR;',
  '            if (libDir && dshFlockIsAbsolute(libDir)) {',
  '                const nativeFile = join(libDir, "libdsh_session_flock.so");',
  '                let info;',
  '                try { info = dshFlockStat(nativeFile); }',
  '                catch (error) { if (error?.code !== "ENOENT") throw error; }',
  '                if (info) {',
  '                    if (!info.isFile()) throw new Error("Android session flock is not a file");',
  '                    const nativeModule = { exports: {} };',
  '                    process.dlopen(nativeModule, nativeFile);',
  '                    if (typeof nativeModule.exports.tryLock !== "function") {',
  '                        throw new Error("Android session flock does not export tryLock");',
  '                    }',
  '                    binding = nativeModule.exports;',
  '                    return binding;',
  '                }',
  '            }',
  '        }',
  '',
].join('\n')

export function attachAndroidSessionFlock(source) {
  if (source.includes(marker)) {
    if (!source.startsWith(imports) || !source.includes(loader + anchor)) {
      throw new Error('Android session flock patch is incomplete')
    }
    return source
  }
  if (source.split(anchor).length !== 2 || !source.includes('binding = { tryLock(_fd, done) { done(0); } };')) {
    throw new Error('F3 anchor changed: review the installed session flock module')
  }
  return imports + source.replace(anchor, loader + anchor)
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

export function installAndroidSessionFlock(stage) {
  const root = realpathSync(stage)
  const persistence = join(root, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    'dsh-session-persistence-jsonl/lib/index.js')
  // Resolve from the real importer. pnpm may put the package in a different
  // physical location than the alias visible at the top of the engine tree.
  const importer = realpathSync(persistence)
  if (!inside(root, importer)) throw new Error('Resolved session backend is outside the snapshot stage')
  const require = createRequire(importer)
  const target = realpathSync(require.resolve('@deepseek-ai/node-addon-system/flock'))
  if (!inside(root, target)) {
    throw new Error('Resolved session flock module is outside the snapshot stage')
  }
  const original = readFileSync(target, 'utf8')
  const patched = attachAndroidSessionFlock(original)
  if (original === patched) return target
  const scratch = mkdtempSync(join(dirname(target), '.dsh-android-session-flock-'))
  const temporary = join(scratch, 'flock.js')
  try {
    writeFileSync(temporary, patched, { flag: 'wx', mode: statSync(target).mode })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
    rmdirSync(scratch)
  }
  return target
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2]
  if (!stage || process.argv.length !== 3) throw new Error('usage: install-android-session-flock.mjs <snapshot-stage>')
  installAndroidSessionFlock(stage)
  console.log('Android session flock loader installed')
}
