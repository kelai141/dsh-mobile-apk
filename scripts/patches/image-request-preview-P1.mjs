/** Keep originals local; model requests use deterministic, compressed previews. */
export const PREVIEW_MARKER = 'dsh-mobile compressed request preview (P1)'
const ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
export const PREVIEW_LOCAL = ROOT + 'dsh-attachment-local/lib/index.js'
export const PREVIEW_PI = ROOT + 'dsh-llm-pi-ai/lib/index.js'
export const PREVIEW_DEEPSEEK = ROOT + 'dsh-llm-deepseek/lib/index.js'

function replaceOnce(source, before, after) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  before = before.replace(/\r?\n/g, eol)
  after = after.replace(/\r?\n/g, eol)
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error('P1: request preview anchor changed')
  return source.replace(before, after)
}

export function patchRequestPreview(source, kind) {
  if (kind === 'local') {
    source = replaceOnce(source, 'const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-v6";',
      `const REQUEST_IMAGE_TRANSFORM_VERSION = "request-image-android-p1"; // ${PREVIEW_MARKER}`)
    return replaceOnce(source, `\tif (target.width >= attachment.ref.width && target.height >= attachment.ref.height && attachment.data.byteLength <= target.maxBytes) return {
\t\tdata: attachment.data,
\t\tmediaType: attachment.ref.mediaType,
\t\twidth: attachment.ref.width,
\t\theight: attachment.ref.height
\t};`, `\t// ${PREVIEW_MARKER}: never forward source bytes, including small screenshots.`)
  }
  if (kind === 'pi') return replaceOnce(source, `function requestImageTarget(ref, budget) {
\treturn {
\t\t...requestImageDimensions(ref.width, ref.height, budget.maxPixels),
\t\tmaxBytes: budget.maxBytes
\t};
}`, `function requestImageTarget(ref, budget) {
\t// ${PREVIEW_MARKER}; route limits may further reduce this fixed preview.
\tconst projected = requestImageDimensions(ref.width, ref.height, budget.maxPixels);
\tconst scale = Math.min(1, 1600 / Math.max(ref.width, ref.height));
\tconst dimensions = Math.max(projected.width, projected.height) <= 1600 ? projected
\t\t: { width: Math.max(1, Math.round(ref.width * scale)), height: Math.max(1, Math.round(ref.height * scale)) };
\treturn {
\t\t...dimensions,
\t\tmaxBytes: Math.min(budget.maxBytes, 1024 * 1024)
\t};
}`)
  if (kind === 'deepseek') {
    source = replaceOnce(source, 'const REQUEST_IMAGE_MAX_DIMENSION = 4096;',
      `const REQUEST_IMAGE_MAX_DIMENSION = 1600; // ${PREVIEW_MARKER}`)
    source = replaceOnce(source, 'Math.max(projected.width, projected.height) > 4096 ?',
      'Math.max(projected.width, projected.height) > 1600 ?')
    return replaceOnce(source, 'maxBytes: resolveRequestImageMaxBytes(model)',
      'maxBytes: Math.min(resolveRequestImageMaxBytes(model), 1024 * 1024)')
  }
  throw new Error('P1: unknown preview target')
}

/** Preflight every runtime before publishing any transformed file. */
export function planRequestPreview(read) {
  return [[PREVIEW_LOCAL, 'local'], [PREVIEW_PI, 'pi'], [PREVIEW_DEEPSEEK, 'deepseek']].map(([file, kind]) => {
    const manifest = JSON.parse(read(file.replace(/lib\/index\.js$/, 'package.json')))
    if (manifest.name !== '@deepseek-ai/' + file.split('/').at(-3) || manifest.version !== '0.2.1-rc.3') {
      throw new Error('P1 requires pinned attachment-local/llm-pi-ai/llm-deepseek@0.2.1-rc.3')
    }
    const before = read(file)
    return { file, before, after: patchRequestPreview(before, kind) }
  })
}
