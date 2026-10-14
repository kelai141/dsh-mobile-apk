// check-snapshot-secrets.mjs — 快照敏感内容门禁（跨平台；Windows 走 wsl/win tar、Linux 原生 tar）
//
// 对应原 scripts/check-snapshot-secrets.ps1（PowerShell + cmd/findstr，仅 Windows 可跑）。
// 改为 Node + lib.shell 的 sh()：同一逻辑跑本地/云端，避免两套漂移。
// 检查（路径级 + settings.yaml 内容级）：credentials / sessions / storages / anon-id /
// settings.yaml 内容（不得含 sk-/apiKey 实际值/私钥头）/ 私有源映射 / npmrc。
//
// review C3（2026-09-14）实锤：旧实现在 `tar -tJf` 失败时 catch 后**静默继续**——在空成员列表上
// 跑全部匹配必然全 PASS，实测垃圾文件也 PASS exit 0（无机密防线）。现收紧：
//   ① 归档不可读 / 成员列表为空 / 不是发行快照（无 usr/ 前缀 / 无引擎包）→ **硬失败**，不接受 SKIP 结案；
//   ② 支持 `--require`（构建链/发布链传参）：任何降级（settings.yaml 读取失败）即失败；
//   ③ SKIP 全部计数并打印汇总（ST-31；发布链要求 SKIP=0）。
//
// 用法：node scripts/check-snapshot-secrets.mjs <snapshot.tar.xz> [--require]
// 退出 0 = 通过；1 = 检出敏感内容或归档不可判定；2 = 用法错误。
// ── P2（0.14.8 门禁优化）：改为**原生解码**，不再走 WSL 往返。──────────────────────
//
// 旧实现用 `sh('tar -tJf ...')`，在 Windows 上展开为 `wsl.exe -e bash -lc`，于是在 WSL 里
// 解压 /mnt/d 上的归档。同一条 160 MB tar 的实测对比（本机，2026-10-14）：
//
//   WSL  侧 `tar -tJf /mnt/d/...`   26.4 s   ← 旧路径
//   原生 侧 `tar -tf  D:\...`       11.3 s   ← 现路径
//
// 而这条门禁**产出 56 字节**，改前实测总耗时 **67.7 s**（其中约 50 s 是 wsl.exe 进程启动 +
// 9p 往返 + bash -lc 冷启动，与判据无关）。
//
// 【改这条不只是提速，是修一个真实缺陷】等价比对（`.deploy-tmp/gate-perf-probe/equiv-p2.mjs`）实测：
//   native -tf  : 49030 members
//   wsl   -tJf  : 49033 members
//   only-wsl    : ["...dsh-session/lib/index.js already-ok", "...dsh-session/lib/types/index.js already-ok", "up-to-date"]
//
// 即 WSL 通道会把 **代理/工具的噪声行**掺进成员列表——这正是 lib/shell.mjs 头注释记录过的坑
// （「wsl.exe 的 localhost 代理会把 already-ok/up-to-date 噪音写进 stdout」）。旧实现在此之后
// 才做 path 过滤，噪声虽不匹配敏感路径，但它让「成员数」这一读数失真，并使一切
// 「按成员集合判定」的推理都建立在被污染的数据上。
//
// 与设备同源性的说明（诚实标注）：本门禁的判据是**归档成员路径**（`usr/` 前缀、`home/.dsh/*`、
// `@dsh-android` 的 .js.map），这些是 tar 头里的路径字符串，**不经过 xz 解码器**——
// 与 check-snapshot-decode 那条「必须用设备同一套解码器」的门禁不同，此处用哪套 tar 不影响判据强度。
// 换 tar 实现不会放过任何一个敏感路径：两侧都是完整的 49,030 条成员表（见上方比对）。
import { execFileSync } from 'node:child_process'
import { TAR } from './lib/shell.mjs'

const args = process.argv.slice(2)
const snap = args.find((a) => !a.startsWith('--'))
const REQUIRE = args.includes('--require') || process.env.DSH_REQUIRE_SNAPSHOT_SECRETS === '1'
if (!snap) {
  console.error('用法: node scripts/check-snapshot-secrets.mjs <snapshot.tar.xz> [--require]')
  process.exit(2)
}
const abs = snap

let skipped = 0
function failHard(msg) {
  console.error('FAIL[archive]: ' + msg)
  console.error('SNAPSHOT_SECRET_CHECK_FAILED')
  process.exit(1)
}

let listing = ''
try {
  listing = execFileSync(TAR, ['-tf', abs], { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024 })
} catch (error) {
  failHard('归档不可读（tar -tf 失败）：' + String(error).slice(0, 240)
    + '\n  旧实现把这里当「全不命中」→ 空成员列表上全部检查全 PASS（review C3 的假绿）；现直接判红')
}
const lines = listing.split('\n').map((l) => l.trim()).filter(Boolean)
if (lines.length === 0) failHard('归档成员列表为空（不是 tar.xz / 解压失败）')
if (!lines.some((l) => l.startsWith('usr/'))) failHard('成员列表里没有 usr/ 前缀——看起来不是发行快照（拒绝空集假绿）')
if (!lines.some((l) => l.includes('node_modules/@deepseek-ai/dsh/'))) failHard('成员列表里没有 @deepseek-ai/dsh 引擎包——不是发行快照')

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
const importedSettings = lines.filter((path) => path.split('/').pop()?.toLowerCase() === 'settings.yaml.imported')
if (importedSettings.length) failOut('imported-user-settings', importedSettings)
const hasSettings = lines.filter((path) => path === 'home/.dsh/settings.yaml')
if (hasSettings.length) {
  let content = ''
  let readFailed = false
  // P2：同样改走原生 tar。旧实现是 `sh('tar -xOf ...')`——**对同一份归档第二次全量解码**
  // （xz 不可随机寻址，取一个成员 = 从头解一遍），且还要再付一次 wsl.exe + 9p 往返。
  // 实测该分支在原生路径下会把 SKIP(#1) 打成 PASS：成员 49,030 已证明归档可读，
  // 此时读不出内容只可能是路径写法问题，不是「归档部分损坏」。
  try { content = execFileSync(TAR, ['-xOf', abs, 'home/.dsh/settings.yaml'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) } catch { readFailed = true }
  if (readFailed || content.trim() === '') {
    const msg = 'settings.yaml 内容读取为空/失败（归档部分损坏？）——存在性检查已命中，内容级检查未执行'
    if (REQUIRE) failHard(msg + '\n  --require 档不得以 SKIP 结案')
    skipped += 1
    console.log('SKIP(#' + skipped + ')  ' + msg)
  } else {
    const leakRe = /(sk-|apiKey\s*:\s*\S|api[_-]?key\s*=\s*\S|BEGIN (RSA|OPENSSH|PRIVATE)|dsh web: \S*\/\?token=[A-Za-z0-9_-]{40,})/i
    const m = leakRe.exec(content)
    if (m) { console.error(`FAIL[settings-yaml-secret]: ${m[0]}`); fail = true }
  }
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
console.log('SNAPSHOT_SECRET_CHECK_PASSED（成员 ' + lines.length + '，SKIP=' + skipped + '）')
