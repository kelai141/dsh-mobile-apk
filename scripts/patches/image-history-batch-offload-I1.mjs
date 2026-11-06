/** Batch old image occurrences before the request approaches its image limits. */
import { ENGINE_BASELINE, PINNED_PI_AI, assertEngineBaseline } from './engine-versions.mjs'
export const IMAGE_HISTORY_MARKER = 'dsh-mobile image history batch offload (I1)'
const ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
export const IMAGE_HISTORY_CORE = ROOT + 'dsh-llm/lib/index.js'

export const IMAGE_BATCH_FUNCTION = `function offloadedImagePrefixCount(lengths, budget) {
\t// ${IMAGE_HISTORY_MARKER}
\tconst count = lengths.length;
\tif (count === 0) return 0;
\tconst hardBytes = budget.maxBytes ?? Infinity;
\tconst hardCount = budget.maxImages ?? Infinity;
\t// issue #1334：最新一张图**自身**超预算时不得抛 INVALID_REQUEST。
\t//
\t// 唯一消费方 dsh-compaction-image-offload 只认 IMAGE_OFFLOAD_REQUIRED_CODE，
\t// 其它 code 一律 return next() 放过 —— 于是没有任何环节会去卸载，之后每一轮都抛
\t// 同一条错误，该会话在删掉附件之前彻底卡死。
\t//
\t// 与引擎原实现一致：返回计数（这里是全部 occurrence），让适配器抛
\t// IMAGE_OFFLOAD_REQUIRED(n)，由卸载插件把内联字节换成引用后重试。
\t// 「单张自身超预算」并不等于无解：卸载换的是表示形态（内联 base64 → 引用），
\t// 字节数会大幅下降，重试即可通过。
\tif (lengths[count - 1] > hardBytes || hardCount < 1) {
\t\treturn count;
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
  if (manifest.name !== '@deepseek-ai/dsh-llm') {
    throw new Error('I1 requires @deepseek-ai/dsh-llm, got ' + manifest.name)
  }
  // 包身份正确 != 版本正确：上一代同名同包，函数体与预算语义可能已经变了。
  // 版本断言走 engine-versions.mjs 的单一真源，不在补丁里写死数字。
  assertEngineBaseline(manifest, 'I1')
  const before = read(IMAGE_HISTORY_CORE)
  return [{ file: IMAGE_HISTORY_CORE, before, after: patchImageBatchOffload(before) }]
}
