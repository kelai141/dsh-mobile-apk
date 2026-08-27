// upload-snapshot-input.mjs — 上传双快照到 snapshot-input draft release（CI 构建输入）
// draft release 不显示在 release 界面；CI workflow 用 GITHUB_TOKEN 经 API 下载。
// 用法: $env:GH_TOKEN=<pat> node scripts/upload-snapshot-input.mjs [tag]
// 幂等：tag 已存在则复用，同名资产先删后传。
import { existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) { console.error('需要 GH_TOKEN（PAT）'); process.exit(1) }
const OWNER = 'kelai141'
const REPO = 'dsh-mobile-apk'
const TAG = process.argv[2] || 'snapshot-input'
const snapDir = join(root, 'dsh-mobile-apk', 'snapshot')
const files = ['snapshot-arm64.tar.xz', 'snapshot-x86_64.tar.xz'].map(f => join(snapDir, f))
for (const f of files) { if (!existsSync(f)) { console.error('缺失: ' + f); process.exit(1) } }
console.log('== 上传快照输入 → ' + TAG)
for (const f of files) { console.log('  ' + basename(f) + ' ' + (statSync(f).size / 1e6).toFixed(1) + ' MB') }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function api(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: { authorization: 'Bearer ' + token, 'user-agent': 'dsh-snapshot-input', ...(opts.headers || {}) },
  })
  const text = await r.text()
  if (!text) return { status: r.status, json: null }
  try { return { status: r.status, json: JSON.parse(text) } } catch { return { status: r.status, json: null, bodyError: text.slice(0, 200) } }
}

// 1) 复用或创建 draft release（分页遍历：releases 可能超 100 条，tags 端点对 draft 返回 404）
let release = null
for (let page = 1; page <= 10 && !release; page++) {
  const list = await api('/repos/' + OWNER + '/' + REPO + '/releases?per_page=100&page=' + page)
  if (list.status !== 200 || !Array.isArray(list.json)) break
  release = list.json.find(r => r.tag_name === TAG) || null
}
if (release) {
  console.log('  release 已存在（draft=' + release.draft + '），复用')
} else {
  const created = await api('/repos/' + OWNER + '/' + REPO + '/releases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: TAG + ' (internal snapshot inputs)', body: 'CI 构建输入快照，不对外发布。由 scripts/upload-snapshot-input.mjs 更新。', draft: true }),
  })
  if (created.status === 201) { release = created.json; console.log('  draft release 创建成功') }
  else { console.error('  创建失败: ' + created.status + ' ' + JSON.stringify(created.json)); process.exit(1) }
}

// 2) 删旧传新（同名资产幂等）
const uploadBase = release.upload_url.replace('{?name,label}', '')
const proxyUrl = process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || ''
let failed = false
for (const file of files) {
  const name = basename(file)
  const old = release.assets.find(a => a.name === name)
  if (old) {
    const del = await api('/repos/' + OWNER + '/' + REPO + '/releases/assets/' + old.id, { method: 'DELETE' })
    if (del.status === 204) console.log('  - 删除旧 ' + name)
    else console.warn('  旧资产删除失败: ' + del.status + '（继续上传）')
  }
  let uploaded = false
  for (let attempt = 0; attempt < 8 && !uploaded; attempt++) {
    const useProxy = proxyUrl !== '' && attempt < 2
    const args = ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '1200']
    if (useProxy) args.push('-x', proxyUrl)
    else args.push('--noproxy', '*')
    args.push(
      '-H', 'Authorization: Bearer ' + token,
      '-H', 'Content-Type: application/octet-stream',
      '-H', 'User-Agent: dsh-snapshot-input',
      '--data-binary', '@' + file,
      uploadBase + '?name=' + encodeURIComponent(name),
    )
    let code
    try { code = execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4096, timeout: 1200000 }).trim() }
    catch (e) { code = String(e.status ?? 'ERR') }
    if (code === '201') { console.log('  ↑ ' + name); uploaded = true }
    else if (code === '422') { console.log('  = ' + name + ' 已存在，跳过'); uploaded = true }
    else { console.log('  upload ' + name + ' HTTP ' + code + (useProxy ? ' (proxy)' : ' (direct)') + '，重试 ' + (attempt + 1)); await sleep(15000) }
  }
  if (!uploaded) { console.error('  FAILED: ' + name); failed = true }
}
console.log(failed ? 'DONE (有失败项，需重跑)' : 'DONE')
