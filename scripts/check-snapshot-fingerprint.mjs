#!/usr/bin/env node
// check-snapshot-fingerprint.mjs — 快照指纹对账门禁（0.13.8-b 批 B2 / ST-04，溯源 F-ENV-01）
//
// 缺的同步路径：全仓没有任何 \`sha256(assets/snapshot.tar.xz) == assets/snapshot.sha256\` 断言。
// 三个构建脚本会重写声明值，走完整链是安全的；**但「手工替换 tar」这一动作没有机器校验**
// （壳侧 EngineManager.snapshotFresh() 只做字符串比较，陈旧即跳过重解压，运行期也发现不了）。
//
// 断言：assets/snapshot.tar.xz 的实际 sha256（小写十六进制）== assets/snapshot.sha256 的声明值（逐字节）。
// 两个 ABI 各自构建时各自声明值与各自 tar 一致——不得再出现「入库值是单一 ABI 构建的事实」。
//
// 用法：node scripts/check-snapshot-fingerprint.mjs [--require] [--root <树>]
//   --require  构建链/发布链用：tar 缺席即失败（不得 SKIP exit 0）。也可用 DSH_REQUIRE_SNAPSHOT_FINGERPRINT=1。
//   --root     仅用于反向验证或非标准布局；缺省自动探测「含 app/src/main 的树」。
// 退出码：0 = 通过（或 CI 净检出下明确计数并打印的 SKIP）；1 = 不一致 / 声明缺席 / 树定位失败。
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT
const REQUIRE = argv.includes('--require') || process.env.DSH_REQUIRE_SNAPSHOT_FINGERPRINT === '1'

const fail = (msg) => {
  console.error('SNAPSHOT-FINGERPRINT CHECK FAILED：' + msg)
  process.exit(1)
}
const skip = (msg) => {
  console.log('SKIP  ' + msg + '（SKIP=1；发布链要求 SKIP=0，构建链以 --require 调用）')
  process.exit(0)
}

const hasAssets = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'assets'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]
const APK_ROOT = CANDIDATES.find(hasAssets)
if (!APK_ROOT) {
  fail('找不到含 app/src/main/assets 的树（协调仓布局应为 <根>/dsh-mobile-apk，apk 仓自包含布局应为 <根> 本身）\n'
    + '  候选：' + CANDIDATES.join('、'))
}
const ASSETS = join(APK_ROOT, 'app', 'src', 'main', 'assets')
const TAR = join(ASSETS, 'snapshot.tar.xz')
const SHA_FILE = join(ASSETS, 'snapshot.sha256')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))
if (!existsSync(TAR)) {
  const msg = '快照 tar 不在场（' + rel(TAR) + '）——净检出/CI 下 tar 被 .gitignore 忽略'
  if (REQUIRE) fail(msg + '\n  构建链要求在场：先跑 scripts/build-snapshot-013.mjs <abi>（或注入链），再跑本门禁')
  skip(msg)
}
if (!existsSync(SHA_FILE)) {
  fail('指纹声明缺席（' + rel(SHA_FILE) + '）——tar 在场却没有声明值，无法对账；'
    + '构建链会在拷贝 tar 后写入该文件（build-apk-013.ps1 / build-apk.mjs）')
}
const declared = readFileSync(SHA_FILE, 'utf8').trim().toLowerCase()
if (!/^[0-9a-f]{64}$/.test(declared)) {
  fail('指纹声明格式非法（' + rel(SHA_FILE) + '）：期望 64 位小写十六进制，实际 ' + JSON.stringify(declared.slice(0, 80)))
}
const actual = await new Promise((ok, bad) => {
  const h = createHash('sha256')
  createReadStream(TAR).on('data', (c) => h.update(c)).on('error', bad).on('end', () => ok(h.digest('hex')))
})
if (actual !== declared) {
  fail('指纹与快照不一致（手工替换 tar 的典型形态）\n'
    + '  ' + rel(TAR) + ' 实际 = ' + actual + '（' + statSync(TAR).size + ' B）\n'
    + '  ' + rel(SHA_FILE) + ' 声明 = ' + declared + '\n'
    + '  修复：重跑构建链（拷贝 tar 后自动重写声明值），勿手工编辑声明值')
}
console.log('PASS  ' + rel(TAR) + ' == ' + rel(SHA_FILE) + '（sha256=' + actual + '）')
console.log('SNAPSHOT-FINGERPRINT CHECK PASSED')
