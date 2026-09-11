# dsh-host-web-compat

[🌐 中文说明 / 中文 README](README.zh.md)

> **DeepSeek Harness × Android ecosystem** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) (shell APK) · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux) (shell) · [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive) (mobile UI)

Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that injects
legacy-browser polyfills into every served page via the webserver `tapIndex` hook, and bridges the
shell APK's directory picker and path-open channels.

## Background

Older kernels (MuMu's bundled browser, older WebViews) lack APIs the host page calls directly:

- missing `AbortSignal.any()` breaks the workspace directory picker's concurrent RPC cancellation;
- missing `Promise.withResolvers()` breaks the host boot-ready tail script, failing the plugin tree;
- missing global `Iterator` (Chrome 122+) makes upstream 0.1.5 client bundles (documentpreview and
  others) throw `Iterator is not defined` at import time ("Failed to load plugins").

The plugin injects idempotent polyfills at the HTML level — no browser-side changes needed.

## Quick start

**1. Install** — package into the profile's node_modules.

**2. Mount** — in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: web-compat
      name: '@dsh-android/dsh-host-web-compat'
      disabled: !!js process.platform !== 'android'
```

**3. Restart** the service; the picker works again in old kernels.

## Polyfills injected

| API | condition | note |
|---|---|---|
| `AbortSignal.any` | missing | Chrome 116+ / Node 20.3+ |
| `AbortSignal.timeout` | missing | Chrome 103+ / Node 17.3+ |
| `structuredClone` | missing | Chrome 98+ / Node 17+ |
| `Object.hasOwn` | missing | Chrome 93+ / Safari 15.4+ |
| `Array.prototype.at` | missing | Chrome 92+ |
| `String.prototype.replaceAll` | missing | Chrome 85+ |
| `crypto.randomUUID` | missing | Chrome 92+, secure context required |
| `Promise.withResolvers` | missing | Chrome 119+; the host boot-ready tail depends on it |
| global `Iterator` + iterator helpers | missing | Chrome 122+ (map/filter/take/drop/flatMap/toArray/forEach/some/every/find/reduce + `Iterator.from`) |
| `Object.groupBy` / `Map.groupBy` | missing | Chrome 117+ |
| `Set.prototype` set methods | missing | Chrome 122+ (union/intersection/difference/symmetricDifference/isSubsetOf/isSupersetOf/isDisjointFrom) |
| `Array.fromAsync` | missing | Chrome 121+ |

Idempotent: skipped when already present. Every snippet shares **one** `<script>` element, so each
one must end on a complete statement (see Development constraints).

## Other injections

- Directory-picker bridge (`__dshBridge` plus the `/api/android/dir-pick/*` polling endpoints that
  return real SAF paths);
- theme bridge (`__dshThemeBridge`: system light/dark into page theme variables);
- agent tool-row path recognition (clicking an absolute path in a tool row hands it to the shell
  chooser);
- boot watchdog (diagnostics plus one automatic reload when "Loading plugins" persists past 40s).

## Development constraints

Snippets live in the `POLYFILLS` array; the assembly rule is `POLYFILL_SCRIPT_BODY` in
`lib/index.js`:

- **Every snippet must end with `;` or `}`.** All snippets share one `<script>` element, and a
  single syntax error makes the parser reject the whole element: the page then behaves as if no
  polyfill existed while the served HTML still contains the snippet text (measured 2026-09-10 — the
  Set-methods IIFE ended with `})()` against the next snippet's `if (`, so WebView 110 reported
  `Iterator is not defined` at import time).
- `apply()` parse-checks the assembled markup with `new Function` at load and throws on failure
  (loud failure beats a silent downgrade).
- **Shim the real structure, not just the name**: the global `Iterator` must be a constructor whose `.prototype` IS `%IteratorPrototype%` (bundled code such as pdfjs patches `Iterator.prototype.x` directly), and iterator wrappers must inherit that same prototype or chained helpers break.

## Tests

```sh
node scripts/smoke-injections.mjs   # assembly + per-script parse + page-marker assertions, no install needed
```

The script loads the real plugin against a stubbed cordis, runs one `tapIndex` transform, and parses
every served script element — the only check that catches an assembly syntax error (grepping the text
does not).
