/** Retain the exact official pi-ai streaming patch (pinned via engine-overlay pins) after raw npm overlay extraction. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PINNED_PI_AI } from './engine-versions.mjs'

export const OFFICIAL_PI_PATCH_SHA256 = 'd2ee86c4d257ca3f8a41c013307d739a90cb6d618fcac3a9099792e198ed5051'
export const PI_STREAMING_FILES = Object.freeze([
  'dist/api/anthropic-messages.js', 'dist/api/bedrock-converse-stream.js',
  'dist/api/mistral-conversations.js', 'dist/api/openai-completions.js',
  'dist/api/openai-responses-shared.js', 'dist/api/pi-messages.js',
])
const PATCH = join(dirname(fileURLToPath(import.meta.url)), 'upstream', 'pi-ai-' + PINNED_PI_AI + '.patch')

/**
 * Prepare all six file replacements before any write; exact upstream context, no fuzzy patching.
 * @param packageRoot - extracted pi-ai package root (disposable build stage).
 * @param read - stage reader, including the unified runner's cached prior patches.
 * @returns complete idempotent replacement plan; drift/malformed patch/version throws.
 */
/**
 * 后续补丁（pi-toolcall-G2）已改写同一文件时，判断某个 hunk 是否**已经生效**。
 *
 * 为什么需要它：apply 轮与 --check 轮看到的文件状态不同。apply 轮里本补丁先跑，
 * hunk 能干净命中；--check 轮里 G2 已经把本补丁插入的行并进了它自己的锚点，
 * 于是本补丁的 after 片段不再连续存在。用「G2 marker 在场 + 本 hunk 的关键插入行在场」
 * 两条同时成立来判定已施加，而不是放宽成「marker 在场就放行」。
 *
 * @param current 当前文件内容
 * @param added 本 hunk 的**新增行**（补丁里 `+` 开头的行，已去掉前缀与行尾）
 * @param file 补丁目标相对路径
 * @returns 已生效为 true
 */
function hunkAlreadyAppliedAfterLaterPatch(current, added, file) {
  // 只有 openai-completions.js 会被 G2 改写；其它文件没有这个形态。
  if (file !== 'dist/api/openai-completions.js') return false
  if (!current.includes('dsh-mobile tool_call guard (G2)')) return false
  // 只看**本 hunk 自己新增的行**：那才是本补丁的产物。上下文行（空格开头）在 G2 改写后
  // 可能已被替换（例如 arguments 那一行被 G2 换成 serializedArguments），拿上下文当指纹会误判。
  const fingerprints = added
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^[{}()\[\];,]+$/.test(line))
  if (fingerprints.length === 0) return false
  return fingerprints.every(line => current.includes(line))
}

export function planPiStreaming(packageRoot, read = file => readFileSync(join(packageRoot, file), 'utf8')) {
  const manifest = JSON.parse(read('package.json'))
  if (manifest.name !== '@earendil-works/pi-ai' || manifest.version !== PINNED_PI_AI) {
    throw new Error('pi-upstream-streaming-020 requires @earendil-works/pi-ai@' + PINNED_PI_AI)
  }
  const bytes = readFileSync(PATCH)
  if (createHash('sha256').update(bytes).digest('hex') !== OFFICIAL_PI_PATCH_SHA256) {
    throw new Error('official pi-ai streaming patch SHA-256 mismatch')
  }
  const sections = bytes.toString('utf8').split(/^diff --git /m).slice(1)
  const plans = sections.map(section => {
    // 补丁文件是 CRLF（上游在 Windows 侧导出），而 npm tgz 内是 LF：断言前先归一化行尾，
    // 否则每个 context 行都带 \r，occurrences 恒为 0 —— 那不是锚点失配，是行尾失配。
    const lines = section.split('\n').map(line => line.replace(/\r$/, ''))
    // 首个 \r 是 CRLF 补丁的行尾残留；只影响 header 行。
    const headerLine = (lines[0] || '').replace(/\r$/, '')
    const header = /^a\/(\S+) b\/(\S+)$/.exec(headerLine)
    if (!header || header[1] !== header[2] || !PI_STREAMING_FILES.includes(header[1])) {
      throw new Error('unexpected official pi-ai patch target')
    }
    const hunkStarts = lines.flatMap((line, i) => line.startsWith('@@ ') ? [i] : [])
    if (hunkStarts.length < 1) throw new Error('unexpected official pi-ai patch hunk count')
    const original0 = read(header[1])
    let current = original0
    // 逐 hunk 施加：每个 hunk 的 before 必须在当前内容里恰好命中一次（或在已施加态的 after 命中一次）。
    for (let h = 0; h < hunkStarts.length; h++) {
      const from = hunkStarts[h] + 1
      const to = h + 1 < hunkStarts.length ? hunkStarts[h + 1] : lines.length
      const body = lines.slice(from, to)
      if (body[body.length - 1] === '') body.pop()
      if (body.some(line => !/^[ +\-]/.test(line))) throw new Error('invalid official pi-ai patch context')
      const before = body.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n'
      const after = body.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n'
      // 本 hunk 的**新增行**：判定「已施加」时只认这些（上下文行可能已被后续补丁改写）。
      const added = body.filter(line => line[0] === '+').map(line => line.slice(1))
      const matches = current.split(before).length - 1
      const patched = current.split(after).length - 1
      if (matches === 1 && patched === 0) { current = current.replace(before, after); continue }
      if (matches === 0 && patched === 1) continue
      // ── 幂等复检的已知形态（0.2.2-rc.1 暴露）──────────────────────────────
      // registry 顺序是 streaming(41) 先于 pi-toolcall-G2(44)，所以 apply 轮永远正常。
      // 但 --check 是**在 apply 之后**跑的：此时 openai-completions.js 已被 G2 改过，
      // 而 G2 的 MAP_OLD 锚点里**包含了本补丁插入的那 3 行**（geminiThoughtSignature），
      // 于是本补丁的 after 片段在文件里被拆散，patched 命中数变成 0。
      // 这不是上游漂移，也不是本补丁没生效——是「同一文件被两个补丁依次改写」的正常结果。
      // 判据取向：只有当文件**确实带着本补丁的产物**（G2 marker 在场）且**确实带着本 hunk 的
      // 关键插入行**时才算已施加；两者缺一就仍然判红，不能拿 marker 当免死金牌。
      if (hunkAlreadyAppliedAfterLaterPatch(current, added, header[1])) continue
      throw new Error('official pi-ai streaming context drift: ' + header[1] + ' hunk#' + (h + 1))
    }
    return { file: header[1], before: original0, after: current }
  })
  if (JSON.stringify(plans.map(plan => plan.file)) !== JSON.stringify(PI_STREAMING_FILES)) {
    throw new Error('official pi-ai streaming patch target set/order mismatch')
  }
  return plans
}
