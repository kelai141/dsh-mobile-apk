import { replaceOnce } from '../lib/replace-once.mjs'

const MARKER = 'dsh-mobile webserver lazy compression'
const IMPORTS = 'import compressionMiddleware from "compression";\n'
  + 'import ipaddr from "ipaddr.js";\n'
  + 'import Negotiator from "negotiator";'
const CONSTRUCTOR = '\t\tthis.tlsConfig = resolved.tls ?? void 0;'
const EAGER_GZIP = 'this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;'
const GZIP_CONSTRUCTOR = CONSTRUCTOR + '\n\t\t' + EAGER_GZIP
const GZIP_FACTORY = 'function createGzipMiddleware(config) {'
const INJECTED_FACTORY = 'function createGzipMiddleware(config, compressionMiddleware, Negotiator) {'
const INIT_SIGNATURE = 'async [Service.init]() {'
const INIT = '\t' + INIT_SIGNATURE + '\n'
const LISTENER = '\t\tconst handle = async (req, res) => {'
const LAZY_INIT = INIT + [
  '		/* ' + MARKER + ' */',
  '		if (this.config.compression === "gzip") {',
  '			const [{ default: compressionMiddleware }, { default: Negotiator }] = await Promise.all([',
  '				import("compression"),',
  '				import("negotiator")',
  '			]);',
  '			this.gzip = createGzipMiddleware(this.config, compressionMiddleware, Negotiator);',
  '		}',
  LISTENER,
].join('\n')

const STATIC_GZIP_IMPORT = /^import (?:[^\n]*\bfrom )?["'](?:compression|negotiator)["'];/m
const unique = (source, anchor) => source.split(anchor).length === 2

export function hasWebserverLazyCompression(source) {
  return unique(source, 'function createGzipMiddleware(')
    && unique(source, INIT_SIGNATURE)
    && unique(source, INJECTED_FACTORY)
    && unique(source, LAZY_INIT)
    && !STATIC_GZIP_IMPORT.test(source)
    && !source.includes(EAGER_GZIP)
}

export function patchWebserverLazyCompression(source) {
  if (hasWebserverLazyCompression(source)) return source
  if (source.includes(MARKER)) throw new Error('webserver-lazy-compression: partial marker')
  if (!unique(source, 'function createGzipMiddleware(') || !unique(source, INIT_SIGNATURE)) {
    throw new Error('webserver-lazy-compression: expected one gzip factory and one Service.init')
  }
  let patched = replaceOnce(source, IMPORTS, 'import ipaddr from "ipaddr.js";', 'webserver static compression imports')
  patched = replaceOnce(patched, GZIP_CONSTRUCTOR, CONSTRUCTOR, 'webserver gzip constructor')
  patched = replaceOnce(patched, GZIP_FACTORY, INJECTED_FACTORY, 'webserver gzip factory')
  patched = replaceOnce(patched, INIT + LISTENER, LAZY_INIT, 'webserver gzip Service.init')
  if (!hasWebserverLazyCompression(patched)) {
    throw new Error('webserver-lazy-compression: result does not match expected shape')
  }
  return patched
}
