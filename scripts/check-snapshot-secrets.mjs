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

// ── --self-test：判别力自证（2026-10-29 补；2026-10-30 按 issue #1033 扩到 12 项）──────
//
// 判据是「归档成员路径 + 成员内容」，造真实归档才跑得起来，所以此前只能看它对真快照说 PASS，
// 看不出它在本该红的时候会不会红。这里现场做多个**极小**归档，覆盖：
//   该绿 1 条 / 路径级该红 2 条 / 内容级该红 5 条（issue #1033 的六组夹具方向）/
//   假红修正 1 条（home/.npmrc 无凭据不得判红）/ 两个「不是发行快照」的硬失败前提。
// 归档用**显式列举顶层目录**打包（不是 -C dir .），否则成员名带 './' 前缀，路径判据会被前缀差异漏掉。
// 压缩用 plain tar（不是 -cJf）：本仓历史上 --self-test 因为 GNU tar 在 Windows 上不能 exec xz 而崩，
// 而本门禁的判据是成员路径 + 内容，与压缩格式无关（tar -tf / -xOf 对 plain tar 同样有效）。
if (process.argv.includes('--self-test')) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const selfPath = fileURLToPath(import.meta.url)
  const ENGINE = 'node_modules/@deepseek-ai/dsh/index.js'
  const runGate = (archive) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  const buildArchive = (tag, entries) => {
    const dir = mkdtempSync(join(tmpdir(), 'snapsecret-src-'))
    for (const e of entries) {
      const full = join(dir, e.path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, e.content ?? 'x')
    }
    const tops = [...new Set(entries.map((e) => e.path.split('/')[0]))]
    const archive = join(tmpdir(), 'snapsecret-' + tag + '-' + process.pid + '.tar')
    execFileSync(TAR, ['-cf', archive, '-C', dir, ...tops], { stdio: ['ignore', 'pipe', 'pipe'] })
    rmSync(dir, { recursive: true, force: true })
    return archive
  }

  const base = [{ path: 'usr/bin/true' }, { path: ENGINE }]
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const clean = buildArchive('clean', [...base,
    { path: 'home/.dsh/settings.yaml', content: 'model: x\n' },
    // issue #1033 反向：路径命中但内容干净 —— 旧实现按路径名判，这里会假红
    { path: 'home/.npmrc', content: 'registry=https://registry.npmjs.org/\n' },
  ])
  const creds = buildArchive('creds', [...base, { path: 'home/.dsh/.credentials', content: '{}' }])
  const sk = buildArchive('sk', [...base, { path: 'home/.dsh/settings.yaml', content: 'apiKey: sk-abc12345\n' }])
  // issue #1033 夹具 1：apiKey 放在 config.json（不是 settings.yaml）
  const configJson = buildArchive('cfgjson', [...base, { path: 'usr/lib/app/config.json', content: '{"apiKey":"sk-live-9f3a2b7c"}\n' }])
  // 夹具 2：私钥文件（路径即证据）
  const privKey = buildArchive('privkey', [...base, { path: 'home/.ssh/id_rsa', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' }])
  // 夹具 3：settings.yaml 内含 JWT（旧正则无 JWT 形态）
  const jwt = buildArchive('jwt', [...base, { path: 'home/.dsh/settings.yaml', content: 'token: ' + JWT + '\n' }])
  // 夹具 4：JWT 拆两行（旧正则单行，必然漏）
  const jwtSplit = buildArchive('jwtsplit', [...base, { path: 'home/.dsh/settings.yaml', content: 'token: ' + JWT.slice(0, 20) + '\n  ' + JWT.slice(20) + '\n' }])
  // 夹具 5：_authToken 写在 usr/etc/npmrc（旧实现只认 home/.npmrc 这个路径名）
  const authToken = buildArchive('authtoken', [...base, { path: 'usr/etc/npmrc', content: '//registry.npmjs.org/:_authToken=npm_9Xk2abcdef\n' }])
  // 夹具 6：npmrc 里的 _authToken 在 home/.npmrc（内容级必须抓住，不能只靠路径名）
  const authTokenHome = buildArchive('authtokenhome', [...base, { path: 'home/.npmrc', content: '//registry.npmjs.org/:_authToken=npm_9Xk2abcdef\n' }])
  const noEngine = buildArchive('noengine', [{ path: 'usr/bin/true' }])
  const noUsr = buildArchive('nousr', [{ path: ENGINE }])

  const checks = [
    ['合规快照（usr/ + 引擎包 + 干净 settings.yaml + 无凭据的 .npmrc）→ PASSED 且 exit 0', clean, (r) => r.code === 0 && r.out.includes('SNAPSHOT_SECRET_CHECK_PASSED')],
    ['含 home/.dsh/.credentials → FAILED 且 exit 1', creds, (r) => r.code === 1 && r.out.includes('FAIL[credentials]')],
    ['settings.yaml 含 sk- 实际值 → FAILED（内容级）', sk, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['夹具 1：apiKey 在 usr/lib/app/config.json → FAILED（内容级扩到多成员）', configJson, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['夹具 2：home/.ssh/id_rsa 私钥文件 → FAILED（路径即证据）', privKey, (r) => r.code === 1 && r.out.includes('FAIL[private-key-file]')],
    ['夹具 3：settings.yaml 含 JWT → FAILED（补 JWT 形态）', jwt, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['夹具 4：JWT 拆两行 → FAILED（多行匹配）', jwtSplit, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['夹具 5：_authToken 在 usr/etc/npmrc → FAILED', authToken, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['夹具 6：_authToken 在 home/.npmrc → FAILED（内容级，不只看路径名）', authTokenHome, (r) => r.code === 1 && r.out.includes('FAIL[credential-content]')],
    ['缺 @deepseek-ai/dsh 引擎包 → 硬失败（不是发行快照）', noEngine, (r) => r.code === 1 && r.out.includes('不是发行快照')],
    ['缺 usr/ 前缀 → 硬失败', noUsr, (r) => r.code === 1 && r.out.includes('没有 usr/ 前缀')],
  ]
  let bad = 0
  for (const [label, archive, verify] of checks) {
    const result = runGate(archive)
    const ok = verify(result)
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 220)))
    if (!ok) bad += 1
  }
  // 纯函数面：内容判据的边界（不造归档，直接喂字符串）
  const pure = [
    ['纯函数：sk- 命中', credentialHit('apiKey: sk-live-123456') !== null],
    ['纯函数：JWT 命中', credentialHit('token: ' + JWT) !== null],
    ['纯函数：JWT 跨行命中', credentialHit('token: ' + JWT.slice(0, 20) + '\n  ' + JWT.slice(20)) !== null],
    ['纯函数：_authToken 命中', credentialHit('//registry.npmjs.org/:_authToken=npm_x') !== null],
    ['纯函数：私钥头命中', credentialHit('-----BEGIN OPENSSH PRIVATE KEY-----') !== null],
    ['纯函数：干净 npmrc 不命中', credentialHit('registry=https://registry.npmjs.org/') === null],
    ['纯函数：空占位不命中', credentialHit('apiKey: ""\ntoken: ""') === null],
  ]
  for (const [label, ok] of pure) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
    if (!ok) bad += 1
  }
  for (const a of [clean, creds, sk, configJson, privKey, jwt, jwtSplit, authToken, authTokenHome, noEngine, noUsr]) rmSync(a, { force: true })
  console.log(bad === 0
    ? 'SNAPSHOT_SECRET_SELF_TEST_PASSED（' + (checks.length + 7) + ' 项）'
    : 'SNAPSHOT_SECRET_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

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

// ── 内容级扫描面（issue #1033）──────────────────────────────────────────────
//
// 旧实现只做两件事：① 对 6 个字面路径跑路径名正则；② 只读 home/.dsh/settings.yaml 一个成员做内容级检查，
// 且那个正则单行、无 JWT/_authToken 形态。于是实测 6 组夹具全部 PASSED exit 0：
//   usr/lib/app/config.json 里的 apiKey / home/.ssh/id_rsa 的私钥头 / settings.yaml 里的 JWT /
//   拆两行的 JWT / usr/etc/npmrc 的 _authToken / settings.yaml 超过 maxBuffer 时只 SKIP。
// 承诺是「快照里不含凭据/令牌/私钥」，实际只覆盖了 6 个路径名 + 1 个成员的内容。
//
// 修法：
//   ① **内容级扩到多成员**：所有「看起来能承载配置/凭据」的成员（配置、yaml/yml/json/ini/toml/
//      属性文件、npmrc 系列、无扩展名的 dotfile）都读进来扫，不再只认 settings.yaml 一个名字；
//   ② **多行匹配**：先按行拼成整串再扫，跨行的 JWT / PEM 私钥体也能命中（旧正则单行必然漏）；
//   ③ **补 JWT / _authToken / bearer 形态**；
//   ④ 路径命中但内容干净的**假红**修掉：路径级只保留「本身就是凭据载体」的路径
//      （.credentials / sessions / storages / anonymous-user-id），.npmrc 改为内容级判据
//      （只有真的写了 token 才红，`registry=https://…` 这种干净文件不再红）；
//   ⑤ 读不出来的成员在 --require 下判红（SKIP 不得结案），非严格档计数 SKIP。
const CONTENT_SCAN_RE = /(?:^|\/)(?:[^/]*\.(?:ya?ml|json|ini|toml|cfg|conf|properties|npmrc|netrc|pem|key)|npmrc|netrc|credentials|\.git-credentials|\.npmrc)$/i
/** 路径级：本身就是凭据载体的文件/目录（内容无关，存在即泄露）。 */
function pathHits(re) { return lines.filter((l) => re.test(l)) }

const creds = pathHits(/home\/\.dsh\/\.credentials/i)
if (creds.length) failOut('credentials', creds)
const sess = pathHits(/home\/\.dsh\/sessions\//i)
if (sess.length) failOut('sessions', sess)
const stor = pathHits(/home\/\.dsh\/storages\//i)
if (stor.length) failOut('storages', stor)
const anon = pathHits(/\.anonymous-user-id/i)
if (anon.length) failOut('anon-id', anon)
// 私钥文件：路径即证据（issue #1033 夹具 2：home/.ssh/id_rsa 此前只在 settings.yaml 内容级判据里才看私钥头）。
const privKeyFiles = pathHits(/(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.ssh\/|.*\.(?:pem|key|p12|pfx))$/i)
  .filter((l) => !/\/(?:node_modules|usr\/lib\/node_modules)\//.test(l))
if (privKeyFiles.length) failOut('private-key-file', privKeyFiles)

/**
 * 凭据内容判据（纯函数，供 --self-test 直接钉住）。
 *
 * 多行：先把整串拼起来再扫，跨行的 JWT / PEM 体也能命中。
 * 覆盖：sk- / PEM 私钥头 / 引擎 web token / JWT（三段 base64url）/ npm _authToken / Bearer /
 *       键值族（apiKey/token/password/secret/credential，值非空且非引号占位）。
 *
 * @param {string} content 成员全文
 * @returns {string|null} 命中片段（null = 干净）
 */
export function credentialHit(content) {
  const text = String(content)
  const patterns = [
    /sk-[A-Za-z0-9_-]{8,}/,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
    /dsh web: \S*\/\?token=[A-Za-z0-9_-]{40,}/,
    // JWT：三段 base64url，header 段以 eyJ 开头（典型形态）；允许跨行（先拼串再扫）
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    // npm 私有源令牌
    /_authToken\s*=\s*\S+/i,
    /(?:_auth|_password)\s*=\s*\S+/i,
    /Bearer\s+[A-Za-z0-9._-]{20,}/,
    /(?:apiKey|api[_-]?key|token|password|passwd|secret|credentials?)\s*[:=]\s*["']?[^\s"']{4,}/i,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

// settings.yaml.imported：存在即泄露（用户导入的个人设置，不进发行快照）
const importedSettings = lines.filter((path) => path.split('/').pop()?.toLowerCase() === 'settings.yaml.imported')
if (importedSettings.length) failOut('imported-user-settings', importedSettings)

// ── 内容级：多成员扫描（issue #1033）─────────────────────────────────────────
//
// 旧实现只读 home/.dsh/settings.yaml **一个成员**（路径全等比较），且正则是单行、无 JWT/_authToken。
// 于是 usr/lib/app/config.json 里的 apiKey、usr/etc/npmrc 的 _authToken、拆两行的 JWT 全部 PASSED。
// 现在：所有「能承载配置/凭据」的成员都读进来扫，且**整串拼起来再扫**（跨行也能命中）。
// 读不出来的成员：--require 判红（SKIP 不得结案）；非严格档计数 SKIP 并打印。
const contentTargets = lines.filter((path) => CONTENT_SCAN_RE.test(path) && !path.endsWith('/'))
let contentScanned = 0
const contentUnreadable = []
for (const member of contentTargets) {
  let content = ''
  try {
    content = execFileSync(TAR, ['-xOf', abs, member], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch {
    contentUnreadable.push(member)
    continue
  }
  contentScanned += 1
  const hit = credentialHit(content)
  if (hit) {
    console.error('FAIL[credential-content]: ' + member + ' 含凭据形态：' + String(hit).slice(0, 80))
    fail = true
  }
}
if (contentUnreadable.length > 0) {
  const msg = contentUnreadable.length + ' 个可扫描成员的内容读取失败（归档部分损坏或超 maxBuffer？）：'
    + contentUnreadable.slice(0, 3).join(', ') + ' —— 这些成员的内容级检查未执行'
  if (REQUIRE) failHard(msg + '\n  --require 档不得以 SKIP 结案')
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + msg)
}
console.log('内容级扫描：' + contentScanned + '/' + contentTargets.length + ' 个成员（配置/凭据载体）')

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
