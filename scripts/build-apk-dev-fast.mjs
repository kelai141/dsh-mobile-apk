#!/usr/bin/env node
// Local-only APK repack for shell/UI iteration. This intentionally skips every
// release gate and requires an existing snapshot asset in the APK project.
// Never publish this artifact: it is unsigned-release, ungated and unverified.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apkDir = existsSync(join(root, 'dsh-mobile-apk')) ? join(root, 'dsh-mobile-apk') : root
const snapshot = join(apkDir, 'app/src/main/assets/snapshot.tar.xz')
const output = join(root, '.deploy-tmp', 'dev-fast', 'dsh-mobile-apk-dev-fast.apk')
const localSdk = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
  : null
if (!process.env.ANDROID_HOME && localSdk && existsSync(localSdk)) {
  process.env.ANDROID_HOME = localSdk
}

if (!existsSync(snapshot)) {
  throw new Error('missing ' + snapshot + ': obtain a verified snapshot asset first; dev repack must not invent one')
}
mkdirSync(dirname(output), { recursive: true })
// EngineManager refuses to launch when its product ownership manifest is absent.
// Generate it from the exact embedded archive before Gradle packages assets.
execFileSync(process.execPath, [join(root, 'scripts', 'build-hard-manifest.mjs'),
  '--snapshot', snapshot, '--out', join(apkDir, 'app/src/main/assets/plugin-hard-manifest.json')],
  { cwd: root, stdio: 'inherit' })
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
const args = [':app:assembleDebug', '--no-daemon', '--console=plain', '-PversionNameSuffix=-DEV-FAST']
console.log('DEV-FAST: all release gates skipped; artifact is for local verification only')
execFileSync(gradle, args, { cwd: apkDir, stdio: 'inherit', shell: process.platform === 'win32' })
const built = join(apkDir, 'app/build/outputs/apk/debug/app-debug.apk')
if (!existsSync(built)) throw new Error('gradle finished without ' + built)
copyFileSync(built, output)
console.log('DEV-FAST artifact: ' + output)
console.log('Install with adb install -r -t; do not attach this package to a release.')
