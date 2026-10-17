/** Retain the exact official 0.2.1-rc.2 pi-ai streaming patch after raw npm overlay extraction. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OFFICIAL_PI_PATCH_SHA256 = '66eaf960054f10441b93ac3857114e96c1901f6d183713e2f21437b007111644'
export const PI_STREAMING_FILES = Object.freeze([
  'dist/api/anthropic-messages.js', 'dist/api/bedrock-converse-stream.js',
  'dist/api/mistral-conversations.js', 'dist/api/openai-completions.js',
  'dist/api/openai-responses-shared.js', 'dist/api/pi-messages.js',
])
const PATCH = join(dirname(fileURLToPath(import.meta.url)), 'upstream', 'pi-ai-1.1.0.patch')

/**
 * Prepare all six file replacements before any write; exact upstream context, no fuzzy patching.
 * @param packageRoot - extracted pi-ai package root (disposable build stage).
 * @param read - stage reader, including the unified runner's cached prior patches.
 * @returns complete idempotent replacement plan; drift/malformed patch/version throws.
 */
export function planPiStreaming(packageRoot, read = file => readFileSync(join(packageRoot, file), 'utf8')) {
  const manifest = JSON.parse(read('package.json'))
  if (manifest.name !== '@earendil-works/pi-ai' || manifest.version !== '1.1.0') {
    throw new Error('pi-upstream-streaming-020 requires @earendil-works/pi-ai@1.1.0')
  }
  const bytes = readFileSync(PATCH)
  if (createHash('sha256').update(bytes).digest('hex') !== OFFICIAL_PI_PATCH_SHA256) {
    throw new Error('official pi-ai streaming patch SHA-256 mismatch')
  }
  const sections = bytes.toString('utf8').split(/^diff --git /m).slice(1)
  const plans = sections.map(section => {
    const lines = section.split('\n')
    const header = /^a\/(\S+) b\/(\S+)$/.exec(lines[0])
    if (!header || header[1] !== header[2] || !PI_STREAMING_FILES.includes(header[1])) {
      throw new Error('unexpected official pi-ai patch target')
    }
    const hunks = lines.flatMap((line, i) => line.startsWith('@@ ') ? [i] : [])
    if (hunks.length !== 1) throw new Error('unexpected official pi-ai patch hunk count')
    const body = lines.slice(hunks[0] + 1)
    if (body[body.length - 1] === '') body.pop()
    if (body.some(line => !/^[ +\-]/.test(line))) throw new Error('invalid official pi-ai patch context')
    const before = body.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n'
    const after = body.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n'
    const original = read(header[1])
    const matches = original.split(before).length - 1
    const patchedMatches = original.split(after).length - 1
    if (matches === 1 && patchedMatches === 0) return { file: header[1], before: original, after: original.replace(before, after) }
    if (matches === 0 && patchedMatches === 1) return { file: header[1], before: original, after: original }
    throw new Error('official pi-ai streaming context drift: ' + header[1])
  })
  if (JSON.stringify(plans.map(plan => plan.file)) !== JSON.stringify(PI_STREAMING_FILES)) {
    throw new Error('official pi-ai streaming patch target set/order mismatch')
  }
  return plans
}
