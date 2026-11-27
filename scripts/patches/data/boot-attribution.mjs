import { replaceOnce } from '../lib/replace-once.mjs'

const ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh'
const packageFile = name => `${ROOT}/node_modules/@deepseek-ai/${name}/lib/index.js`
export const BOOT_ATTRIBUTION_FILE = `${ROOT}/lib/bin.js`
const BOOT_ATTRIBUTION_MARKER = 'dsh-mobile boot attribution'
const probe = 'globalThis.__dshMobileBootAttribution'
const marker = `/* ${BOOT_ATTRIBUTION_MARKER} */`

// Copied verbatim into the installed Node entry. All timestamps, including the
// two P1 boundaries, are on the same process-relative monotonic clock.
function createBootAttribution(entryAt) {
  const runId = `${process.pid}-${process.hrtime.bigint()}`
  const marks = new Map([['node-origin', { at: 0 }], ['node-entry', { at: entryAt }]])
  const rows = new Map()
  let tracking = false
  const round = ms => Number(ms.toFixed(2))
  const elapsed = (start, end) => start === undefined || end === undefined ? null : round(end - start)

  function report() {
    // The P1 window can overlap both phases. Rank by their union within that
    // window, while retaining each full duration in the row.
    const p1Start = marks.get('p1-wait-start')?.at
    const p1End = marks.get('p1-settled')?.at
    const clip = (start, end) => start === undefined || p1Start === undefined || p1End === undefined
      ? [] : [Math.max(p1Start, start), Math.min(p1End, end ?? p1End)]
    const width = ([start, end]) => end > start ? end - start : 0
    const ranked = [...rows.values()].map(row => {
      const init = clip(row.initStart, row.initEnd)
      const inertia = clip(row.inertiaStart, row.inertiaEnd)
      const shared = width(init.length && inertia.length
        ? [Math.max(init[0], inertia[0]), Math.min(init[1], inertia[1])] : [])
      return {
        id: row.id, name: row.name,
        initTaskMs: elapsed(row.initStart, row.initEnd),
        importMs: elapsed(row.initStart, row.importEnd),
        inertiaMs: elapsed(row.inertiaStart, row.inertiaEnd),
        p1OverlapMs: width(init) + width(inertia) - shared,
      }
    }).filter(row => row.p1OverlapMs > 0)
      .sort((a, b) => b.p1OverlapMs - a.p1OverlapMs || a.id.localeCompare(b.id))
    let previous = 0
    const phases = [...marks].sort((a, b) => a[1].at - b[1].at).map(([name, { at, port }]) => {
      const phase = { name, atMs: round(at), deltaMs: round(at - previous) }
      if (port !== undefined) phase.port = port
      previous = at
      return phase
    })
    console.log('[perf] boot-attribution ' + JSON.stringify({
      runId, pid: process.pid, clock: 'node-monotonic-ms', phases,
      loader: {
        p1WaitMs: elapsed(p1Start, p1End),
        observedEntries: rows.size,
        overlappingEntries: ranked.length,
        top: ranked.slice(0, 10).map(row => ({ ...row, p1OverlapMs: round(row.p1OverlapMs) })),
      },
    }))
  }

  return {
    mark(name, at = performance.now(), port) {
      if (marks.has(name)) return
      marks.set(name, { at, port })
      if (name === 'loader-arming') tracking = true
      if (name === 'loader-settled') tracking = false
      if (marks.has('startup-audit-complete') && marks.has('url-announced')) {
        delete globalThis.__dshMobileBootAttribution
        report()
      }
    },
    begin(entry) {
      if (!tracking || rows.has(entry)) return
      const row = { id: entry.id, name: entry.options.name, initStart: performance.now() }
      rows.set(entry, row)
      return row
    },
    imported(row) {
      if (row) row.importEnd = performance.now()
    },
    endInit(entry) {
      const row = rows.get(entry)
      if (tracking && row && row.initEnd === undefined) row.initEnd = performance.now()
    },
    beginInertia(fiber) {
      if (!tracking || fiber.parent.fiber?.entry === fiber.entry) return
      const row = rows.get(fiber.entry)
      if (!row || row.inertiaStart !== undefined) return
      row.inertiaStart = performance.now()
      return row
    },
    endInertia(row) {
      if (row) row.inertiaEnd = performance.now()
    },
  }
}

const mark = (name) => `${probe}?.mark("${name}");`
const insert = (anchor, text) => [anchor, `${anchor}\n${text}`]
const replacements = new Map([
  [BOOT_ATTRIBUTION_FILE, [
    insert('import { pathToFileURL } from "node:url";', `import { existsSync as dshMobileBootFlagExists } from "node:fs";
${marker}
${createBootAttribution.toString()}
if (dshMobileBootFlagExists(new URL("../../../../../../.boot-attribution", import.meta.url))
    && process.getBuiltinModule("node:worker_threads").isMainThread) {
  ${probe} = createBootAttribution(performance.now());
}`),
  ]],
  [packageFile('dsh-app-boot'), [
    insert('function collectInstallationScopePackages(installAnchor, skippedBundles) {',
      `\t${marker}\n\t${mark('installation-scan-start')}`),
    ['\treturn {\n\t\tpackageNames: new Set(links.keys()),',
      `\t${mark('installation-scan-end')}\n\treturn {\n\t\tpackageNames: new Set(links.keys()),`],
    ['\t\tawait ctx.plugin(Loader);',
      `\t\t${mark('loader-arming')}\n\t\tawait ctx.plugin(Loader);\n\t\t${mark('loader-armed')}`],
    insert('\t\tstage = "plugin tree failed to load";', `\t\t${mark('loader-mount-start')}`),
    insert('\t\tawait ctx.get("loader")?.await();', `\t\t${mark('loader-settled')}`),
    insert('\t\tawait auditStartupEntries(ctx, binName);', `\t\t${mark('startup-audit-complete')}`),
  ]],
  [packageFile('cordis-plugin-loader'), [
    insert('\t\t\tthis._initTask = void 0;', `\t\t\t${probe}?.endInit(this);`),
    insert('\tasync _init() {', `\t\t${marker}\n\t\tconst bootProbe = ${probe};\n\t\tconst bootRow = bootProbe?.begin(this);`),
    ['\t\t} catch (error) {\n\t\t\tthis.ctx.logger.error(error);\n\t\t\treturn;\n\t\t}\n\t\tconst plugin = this.loader.unwrapExports(moduleNamespace);',
      '\t\t} catch (error) {\n\t\t\tbootProbe?.imported(bootRow);\n\t\t\tthis.ctx.logger.error(error);\n\t\t\treturn;\n\t\t}\n\t\tbootProbe?.imported(bootRow);\n\t\tconst plugin = this.loader.unwrapExports(moduleNamespace);'],
  ]],
  [packageFile('cordis'), [
    insert('\tasync _reload() {', `\t\t${marker}\n\t\tconst bootProbe = ${probe};\n\t\tconst bootRow = bootProbe?.beginInertia(this);`),
    ['\t}\n\tasync _unload() {', '\t\tbootProbe?.endInertia(bootRow);\n\t}\n\tasync _unload() {'],
  ]],
  [packageFile('dsh-web-app'), [
    ['\t\t\tif (config.printUrl) console.log(`dsh web: ${authenticatedUrl}`);',
      `\t\t\tif (config.printUrl) {
\t\t\t\t${marker}
\t\t\t\tconsole.log(\`dsh web: \${authenticatedUrl}\`);
\t\t\t\t${mark('url-announced')}
\t\t\t}`],
    insert('\t\t\tawait auditStartupEntries(connectionCtx.root, "dsh web", () => {});', `\t\t\t${mark('web-audit-complete')}`),
  ]],
])

export const BOOT_ATTRIBUTION_ADDITIONAL = [...replacements.keys()].slice(1)

export function patchBootAttribution(file, source) {
  const edits = replacements.get(file)
  if (edits.every(([, after]) => source.includes(after))) return source
  if (source.includes(marker)) throw new Error(`${BOOT_ATTRIBUTION_MARKER}: partial patch in ${file}`)
  return edits.reduce((current, [before, after]) => replaceOnce(
    current, before, after, `${BOOT_ATTRIBUTION_MARKER}: ${file}: ${before.trim()}`,
  ), source)
}
