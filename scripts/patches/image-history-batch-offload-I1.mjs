/** Batch old image occurrences before the request approaches its image limits. */
export const IMAGE_HISTORY_MARKER = 'dsh-mobile image history batch offload (I1)'
const ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
export const IMAGE_HISTORY_CORE = ROOT + 'dsh-llm/lib/index.js'

export const IMAGE_BATCH_FUNCTION = `function offloadedImagePrefixCount(lengths, budget) {
\t// ${IMAGE_HISTORY_MARKER}
\tconst count = lengths.length;
\tif (count === 0) return 0;
\tconst hardBytes = budget.maxBytes ?? Infinity;
\tconst hardCount = budget.maxImages ?? Infinity;
\t// A single observation cannot be made smaller by removing older history.
\tif (lengths[count - 1] > hardBytes || hardCount < 1) {
\t\tthrow new LlmError("The latest image alone exceeds the request image limit; history was not changed.", "INVALID_REQUEST");
\t}
\tif (count === 1) return 0;
\tconst softBytes = Number.isFinite(hardBytes) ? Math.max(1, Math.floor(hardBytes * 0.9)) : Infinity;
\tconst softCount = Number.isFinite(hardCount) ? Math.max(1, Math.ceil(hardCount * 0.9)) : Infinity;
\tconst total = lengths.reduce((sum, bytes) => sum + bytes, 0);
\tif (total < softBytes && count < softCount) return 0;
\tlet removed = Math.min(count - 1, Math.ceil(count * 0.4));
\tlet remaining = total;
\tfor (let index = 0; index < removed; index++) remaining -= lengths[index];
\t// Heterogeneous images may need more than 40% of occurrences to release enough bytes.
\twhile (removed < count - 1 && (remaining >= softBytes || count - removed >= softCount)) {
\t\tremaining -= lengths[removed++];
\t}
\treturn removed;
}`

export function patchImageBatchOffload(source) {
  const start = source.indexOf('function offloadedImagePrefixCount(')
  if (start < 0 || source.indexOf('function offloadedImagePrefixCount(', start + 1) >= 0) {
    throw new Error('I1: expected one offloadedImagePrefixCount function')
  }
  const end = source.indexOf('\n}', start)
  if (end < 0) throw new Error('I1: missing function boundary')
  const current = source.slice(start, end + 2)
  if (current === IMAGE_BATCH_FUNCTION) return source
  if (current.includes(IMAGE_HISTORY_MARKER) || ![
    'const total = lengths.reduce((sum, bytes) => sum + bytes, 0);',
    'const excessCount = budget.maxImages === void 0 ? 0 : Math.max(0, lengths.length - budget.maxImages);',
    'const countQuantum = budget.countQuantum ?? 1;',
    'const byteQuantum = budget.byteQuantum ?? 1;',
    'return count;',
  ].every(anchor => current.includes(anchor))) throw new Error('I1: batch image offload anchors changed')
  return source.slice(0, start) + IMAGE_BATCH_FUNCTION + source.slice(end + 2)
}

export function planImageHistory(read) {
  const manifest = JSON.parse(read(ROOT + 'dsh-llm/package.json'))
  if (manifest.name !== '@deepseek-ai/dsh-llm' || manifest.version !== '0.2.1-rc.3') {
    throw new Error('I1 requires dsh-llm@0.2.1-rc.3')
  }
  const before = read(IMAGE_HISTORY_CORE)
  return [{ file: IMAGE_HISTORY_CORE, before, after: patchImageBatchOffload(before) }]
}
