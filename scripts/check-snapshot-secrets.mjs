// check-snapshot-secrets.mjs — 快照敏感内容门禁（跨平台；Windows 走 wsl/win tar、Linux 原生 tar）
//
// 对应原 scripts/check-snapshot-secrets.ps1（PowerShell + cmd/findstr，仅 Windows 可跑）。
// 改为 Node + lib.shell 的 sh()：同一逻辑跑本地/云端，避免两套漂移。
// 检查（路径级 + settings.yaml 内容级）：credentials / sessions / storages / anon-id /
// settings.yaml 内容（不得含 sk-/apiKey 实际值/私钥头）/ 私有源映射 / npmrc。
//
// 性能：只在开头 tar -tJf 解一次列出全部成员（避免每 pattern 重解 150MB xz），后续匹配在内存中做。
//
// 用法：node scripts/check-snapshot-secrets.mjs <snapshot.tar.xz>
// 退出 0 = 通过；1 = 检出敏感内容。
import { wslPath, sh } from './lib/shell.mjs'

const snap = process.argv[2]
if (!snap) {
  console.error('用法: node scripts/check-snapshot-secrets.mjs <snapshot.tar.xz>')
  process.exit(2)
}
const abs = wslPath(snap)

let listing = ''
try {
  listing = sh(`tar -tJf "${abs}" 2>/dev/null`, { maxBuffer: 96 * 1024 * 1024 })
} catch { /* 归档不可读则后续全不命中，交给其它门禁兜底 */ }
const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)

let fail = false
function failOut(name, hits) {
  console.error(`FAIL[${name}]: ${hits.slice(0, 3).join('; ')}`)
  fail = true
}

// 路径级敏感文件（在单一 listing 内匹配）
function pathHits(re) { return lines.filter((l) => re.test(l)) }

const creds = pathHits(/home\/\.dsh\/\.credentials/i)
if (creds.length) failOut('credentials', creds)
const sess = pathHits(/home\/\.dsh\/sessions\//i)
if (sess.length) failOut('sessions', sess)
const stor = pathHits(/home\/\.dsh\/storages\//i)
if (stor.length) failOut('storages', stor)
const anon = pathHits(/\.anonymous-user-id/i)
if (anon.length) failOut('anon-id', anon)
const npmrc = pathHits(/home\/\.npmrc/i)
if (npmrc.length) failOut('npmrc', npmrc)

// settings.yaml 内容级（0.13.0 C1/Q14）：允许非机密 seed 模板存在，但不得含真实凭据形态
const hasSettings = pathHits(/home\/\.dsh\/settings\.yaml/i)
if (hasSettings.length) {
  let content = ''
  try { content = sh(`tar -xOf "${abs}" home/.dsh/settings.yaml 2>/dev/null`) } catch { /* 空 */ }
  const leakRe = /(sk-|apiKey\s*:\s*\S|api[_-]?key\s*=\s*\S|BEGIN (RSA|OPENSSH|PRIVATE))/i
  const m = leakRe.exec(content)
  if (m) { console.error(`FAIL[settings-yaml-secret]: ${m[0]}`); fail = true }
}

// 私有源映射：仅 @dsh-android 插件的 .js.map 才算泄露（npm 公共依赖带 map 属正常）
const privMaps = lines.filter((l) => l.includes('@dsh-android') && l.includes('.js.map'))
if (privMaps.length) {
  console.error(`FAIL[private-sourcemap]: ${privMaps.slice(0, 3).join('; ')}`)
  fail = true
}

if (fail) {
  console.error('SNAPSHOT_SECRET_CHECK_FAILED')
  process.exit(1)
}
console.log('SNAPSHOT_SECRET_CHECK_PASSED')
