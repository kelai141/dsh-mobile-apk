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
      const matches = current.split(before).length - 1
      const patched = current.split(after).length - 1
      if (matches === 1 && patched === 0) { current = current.replace(before, after); continue }
      if (matches === 0 && patched === 1) continue
      throw new Error('official pi-ai streaming context drift: ' + header[1] + ' hunk#' + (h + 1))
    }
    return { file: header[1], before: original0, after: current }
  })
  if (JSON.stringify(plans.map(plan => plan.file)) !== JSON.stringify(PI_STREAMING_FILES)) {
    throw new Error('official pi-ai streaming patch target set/order mismatch')
  }
  return plans
}
