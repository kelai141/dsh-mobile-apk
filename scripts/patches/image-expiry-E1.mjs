/** Missing reclaimed images become text; passive history replay never renews image lifetime. */
import { PREVIEW_LOCAL, PREVIEW_PI, PREVIEW_DEEPSEEK } from './image-request-preview-P1.mjs'
export const EXPIRY_MARKER = 'dsh-mobile image expiry placeholder (E1)'
export const EXPIRED_IMAGE_TEXT = '[图片已清理或文件缺失；需要当前画面时请重新截图。]'

function once(source, before, after) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  before = before.replace(/\r?\n/g, eol)
  after = after.replace(/\r?\n/g, eol)
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error('E1: image lifetime anchor changed')
  return source.replace(before, after)
}

const projector = `function dshProjectMissingImages(messages, versions) {
\t// ${EXPIRY_MARKER}
\treturn messages.map(message => ({ ...message, content: message.content.map(block =>
\t\tblock.type === "image" && block.offloaded !== true && !versions.has(block.attachment.attachmentId)
\t\t\t? { type: "text", text: ${JSON.stringify(EXPIRED_IMAGE_TEXT)} } : block) }));
}
`

export function patchImageExpiry(source, kind) {
  if (source.includes('function dshProjectMissingImages(')
    && !source.replace(/\r\n/g, '\n').includes(projector)) throw new Error('E1: image placeholder projector changed')
  if (kind === 'local') {
    source = once(source, 'import { constants, createReadStream } from "node:fs";',
      'import { constants, createReadStream, statSync, utimesSync } from "node:fs";')
    source = once(source, '\treturn prepared.ref;\n}',
      '\ttry { const now = new Date(); utimesSync(normalizedImagePath(root, prepared.ref), now, now); } catch {}\n\treturn prepared.ref;\n}')
    source = once(source, '\tasync readImage(ref, signal) {\n\t\treturn readImageFile(this.root, ref, signal);\n\t}',
      `\tget imageExpirySupported() { return true; } // ${EXPIRY_MARKER}
\tasync readImage(ref, signal) {
\t\ttry { const now = new Date(); utimesSync(normalizedImagePath(this.root, ref), now, now); } catch {}
\t\treturn readImageFile(this.root, ref, signal);
\t}`)
    source = once(source, 'stored ?? await this.readImage(ref, sharedSignal)',
      'stored ?? await readImageFile(this.root, ref, sharedSignal)')
    return once(source, '\t\t\t\treturn await readRequestImageFile(this.cacheRoot, stored ?? await readImageFile(this.root, ref, sharedSignal), target, sharedSignal);',
      `\t\t\t\tconst version = await readRequestImageFile(this.cacheRoot, stored ?? await readImageFile(this.root, ref, sharedSignal), target, sharedSignal);
\t\t\t\t// A newly encoded preview of an old image must not gain another 120 minutes.
\t\t\t\ttry {
\t\t\t\t\tconst accessed = statSync(normalizedImagePath(this.root, ref)).mtime;
\t\t\t\t\tconst hash = String(version.variantId).replace(/^sha256:/, "");
\t\t\t\t\tutimesSync(join(this.cacheRoot, "request-images", hash.slice(0, 2), hash), accessed, accessed);
\t\t\t\t} catch {}
\t\t\t\treturn version;`)
  }
  if (kind === 'pi') {
    source = once(source,
      '(ref) => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal)',
      '(ref) => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal).catch(error => { if (error?.code === "ATTACHMENT_NOT_FOUND") return void 0; throw error; })')
    // Rollup emits parentheses around arrow arguments in the pinned build.
    source = once(source, 'for (const [index, ref] of orderedRefs.entries()) versions.set(ref.attachmentId, prepared[index]);',
      'for (const [index, ref] of orderedRefs.entries()) if (prepared[index] !== void 0) versions.set(ref.attachmentId, prepared[index]);')
    source = once(source, 'async function toPiContextWithImages(', projector + 'async function toPiContextWithImages(')
    source = once(source, '\tconst split = splitSystemPrompt(options);\n\tconst requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal);',
      '\tconst split = splitSystemPrompt(options);\n\tconst requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, options.signal);\n\tsplit.messages = dshProjectMissingImages(split.messages, requestImages);')
    return source
  }
  if (kind === 'deepseek') {
    source = once(source, 'async function prepareImages(', projector + 'async function prepareImages(')
    source = once(source, '\tconst messages = projectOffloadedImages(history, (ref) => offloadedImageText(ref, access(ref)));',
      '\tlet messages = projectOffloadedImages(history, (ref) => offloadedImageText(ref, access(ref)));')
    return once(source, '\tfor (const message of messages) for (const ref of imageRefs(message.content)) if (!versions.has(ref.attachmentId)) versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal));\n\tassertImagesFit(messages, versions, connection, "raw");',
      `\tfor (const message of messages) for (const ref of imageRefs(message.content)) if (!versions.has(ref.attachmentId)) {
\t\ttry { versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal)); }
\t\tcatch (error) { if (error?.code !== "ATTACHMENT_NOT_FOUND") throw error; }
\t}
\tmessages = dshProjectMissingImages(messages, versions);
\tassertImagesFit(messages, versions, connection, "raw");`)
  }
  throw new Error('E1: unknown lifetime target')
}

export function planImageExpiry(read) {
  return [[PREVIEW_LOCAL, 'local'], [PREVIEW_PI, 'pi'], [PREVIEW_DEEPSEEK, 'deepseek']].map(([file, kind]) => {
    const manifest = JSON.parse(read(file.replace(/lib\/index\.js$/, 'package.json')))
    if (manifest.name !== '@deepseek-ai/' + file.split('/').at(-3) || manifest.version !== '0.2.1-rc.3') throw new Error('E1 requires pinned attachment and model runtimes@0.2.1-rc.3')
    const before = read(file)
    return { file, before, after: patchImageExpiry(before, kind) }
  })
}
