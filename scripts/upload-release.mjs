// upload-release.mjs — fully automated release creation + asset upload (PAT or GH_TOKEN env var)
// Usage: $env:GH_TOKEN=<pat> node scripts/upload-release.mjs [version, default: newest v dir under release/]
// v2: version parameterized + dual-ABI assets + single release entry (dsh-mobile-apk repo only; see release/README.md)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) { console.error('需要 GH_TOKEN（PAT）'); process.exit(1) }
const OWNER = 'kelai141'
const REPO = 'dsh-mobile-apk'

// Version: CLI arg wins; otherwise the newest v* dir under release/
let version = process.argv[2]
if (!version) {
  const dirs = readdirSync(join(root, 'release')).filter(d => /^v[0-9]/.test(d)).sort()
  version = dirs.length > 0 ? dirs[dirs.length - 1].slice(1) : null
}
if (!version) { console.error('未找到版本（release/v* 目录）'); process.exit(1) }
const TAG = 'v' + version
const relDir = join(root, 'release', TAG)
if (!existsSync(relDir)) { console.error('release 目录不存在: ' + relDir); process.exit(1) }
console.log('== 发布 ' + TAG + ' (dsh-mobile-apk 单一入口)')

// Asset list: apk/* + snapshot/* + plugins/* + MANIFEST.txt + notes.md
const assets = []
for (const sub of ['apk', 'snapshot', 'plugins']) {
  const dir = join(relDir, sub)
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) assets.push(join(dir, f))
  }
}
for (const f of ['MANIFEST.txt', 'notes.md']) {
  const p = join(relDir, f)
  if (existsSync(p)) assets.push(p)
}
if (assets.length === 0) { console.error('无资产可上传'); process.exit(1) }
console.log('资产: ' + assets.map(a => basename(a)).join(', '))

// Release body: full notes.md text (GitHub release body must equal the notes.md attachment;
// placeholder templates are forbidden — v0.10.2~v0.10.8 lost release notes to templates, see sync-release-notes.mjs)
const notesPath = join(relDir, 'notes.md')
const notesBody = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : null
const fallbackBody = [
  '# ' + TAG + ' 发布说明',
  '',
  '（未提供 notes.md——请先填写 release/' + TAG + '/notes.md 再发布）',
  '',
  '## 资产',
  '- ' + assets.map(a => basename(a)).join('\n- '),
  '',
  '校验：sha256 见 MANIFEST.txt。',
].join('\n')
const wantBody = notesBody || fallbackBody
const wantName = 'dsh-mobile ' + TAG

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function api(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: { authorization: 'Bearer ' + token, 'user-agent': 'dsh-release', ...(opts.headers || {}) },
  })
  const text = await r.text()
  // Review 2026-08-18 (R4): non-JSON responses (gateway 502/HTML pages etc.) must not crash the
  // script — return a readable error object and let callers handle it by status.
  if (!text) return { status: r.status, json: null }
  try {
    return { status: r.status, json: JSON.parse(text) }
  } catch {
    return { status: r.status, json: null, bodyError: text.slice(0, 200) }
  }
}

// Create / reuse the release
let release = null
const existing = await api('/repos/' + OWNER + '/' + REPO + '/releases/tags/' + TAG)
if (existing.status === 200) {
  release = existing.json
  console.log('  release 已存在，复用')
  // Idempotent sync: PATCH when body/name differ from notes.md (re-runs converge on the full notes.md text)
  if (release.body !== wantBody || release.name !== wantName) {
    const patched = await api('/repos/' + OWNER + '/' + REPO + '/releases/' + release.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: wantName, body: wantBody }),
    })
    if (patched.status === 200) {
      release = patched.json
      console.log('  release body 已同步为 notes.md（' + wantBody.length + ' 字符）')
    } else { console.error('  body 同步失败: ' + patched.status + ' ' + JSON.stringify(patched.json)) }
  } else { console.log('  release body 已与 notes.md 一致') }
} else {
  const created = await api('/repos/' + OWNER + '/' + REPO + '/releases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: wantName, body: wantBody, draft: false }),
  })
  if (created.status === 201) { release = created.json; console.log('  release 创建成功') }
  else { console.error('  创建失败: ' + created.status + ' ' + JSON.stringify(created.json)); process.exit(1) }
}

// Upload assets (uploads.github.com, retry until success)
// Transfer via curl: Node fetch through the local proxy fails repeatedly for this domain in some
// environments (api.github.com is fine, curl with the same proxy works); after 2 proxy attempts it
// retries direct (uploads.github.com is reachable directly).
import { execFileSync } from 'node:child_process'
const uploadBase = release.upload_url.replace('{?name,label}', '')
// Proxy parameterized (Review 2026-08-18 R4): PROXY_URL env var wins, then system HTTPS_PROXY;
// otherwise direct. No more hardcoded local Clash port.
const proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || ''
let failed = false
for (const file of assets) {
  const name = basename(file)
  let uploaded = false
  for (let attempt = 0; attempt < 8 && !uploaded; attempt++) {
    // With a proxy available: first 2 attempts via proxy, then direct; without one, always direct.
    const useProxy = proxyUrl !== '' && attempt < 2
    const args = ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '900']
    if (useProxy) args.push('-x', proxyUrl)
    else args.push('--noproxy', '*')
    args.push(
      '-H', 'Authorization: Bearer ' + token,
      '-H', 'Content-Type: application/octet-stream',
      '-H', 'User-Agent: dsh-release',
      '--data-binary', '@' + file,
      uploadBase + '?name=' + encodeURIComponent(name),
    )
    let code
    try {
      code = execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4096, timeout: 900000 }).trim()
    } catch (e) {
      code = String(e.status ?? 'ERR')
    }
    if (code === '201') { console.log('  ↑ ' + name + ' (' + (statSync(file).size / 1e6).toFixed(1) + ' MB)'); uploaded = true }
    else if (code === '422') { console.log('  = ' + name + ' 已存在，跳过'); uploaded = true }
    else {
      console.log('  upload ' + name + ' HTTP ' + code + (useProxy ? ' (proxy)' : ' (direct)') + '，重试 ' + (attempt + 1))
      await sleep(15000)
    }
  }
  if (!uploaded) { console.error('  FAILED: ' + name); failed = true }
}
console.log(failed ? 'DONE (有失败项，需重跑)' : 'DONE')
