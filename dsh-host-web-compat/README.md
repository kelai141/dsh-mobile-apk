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
| `Array.prototype.toSorted` / `toReversed` / `toSpliced` / `with` | missing | Chrome 110+ (ES2023); upstream `ui-model-selection` calls `groups.toSorted(...)` inside render, so without it the model capsule never renders and `/model` shows `groups.toSorted is not a function` |

Idempotent: skipped when already present. Every snippet shares **one** `<script>` element, so each
one must end on a complete statement (see Development constraints).

## Other injections

- Directory-picker bridge (`__dshBridge` plus the `/api/android/dir-pick/*` polling endpoints that
  return real SAF paths);
- open-path (`window.__dshOpenPath`: chat mentions and tool-row paths into the shell chooser) —
  0.14 makes resolution session-scoped (relative paths resolve against the active session cwd);
- theme bridge (`__dshThemeBridge`: system light/dark into page theme variables);
- agent tool-row path recognition — 0.14 keys on DOM facts (not CSS-module class names) when
  clicking an absolute path in a tool row hands it to the shell chooser;
- clipboard fallback (2026-10-03): a global wrapper over `navigator.clipboard.writeText`. Android
  WebView denies the async Clipboard API (`NotAllowedError: Write permission denied`; WebView has no
  permission prompt), and upstream `writeClipboard` returns false from its `catch` — it only falls
  back to `execCommand('copy')` when the API is *absent* — so every copy button wrote nothing and
  showed nothing. The wrapper falls back to the shell bridge `window.androidBridge.copyText`
  (ClipboardManager), then to `execCommand('copy')`, and emits one plain-language notice when all
  three fail. Patching the API instead of each caller covers CodeBlock / MessageIconActions /
  TerminalBlock / HoverCard / user-questions / trajectory and third-party plugins, which all read
  the API at click time;
- boot watchdog: 40s stuck diagnostics plus the three contract lines the shell APK parses by
  field position (`[dsh-boot-stall]` stuck, `[dsh-boot-ready]` really rendered,
  `[dsh-boot-failed]` client plugin tree failed) — see Boot diagnostics contract.;
- slot-guard (2026-10-25): neutralizes undefined React elements at the module-system boundary.
  On a Xiaomi 14 / Google WebView 155 device the upstream slot system resolves one
  `conversation.input.left` entry to `undefined`, React throws #130 ("Element type … got:
  undefined"), the whole tree unmounts and every boot lands in the repair gate — reproduced with
  shell 0.14.7/main, snapshot rc.2/rc.3, third-party plugins removed and a 57-entry all-upstream
  load list, so the crash is upstream's (no per-entry error boundary). The guard traps the
  `window.__ModuleLoader__` assignment (earliest `<head>` injection, before the upstream queue
  script), wraps each registration's `factory` so `react` / `react/jsx-runtime(-dev-runtime)`
  namespaces get fail-soft `createElement` / `jsx` / `jsxs` / `jsxDEV`: `undefined` types render
  `null` (that entry silently absent) with a single `console.warn`, everything else passes
  through untouched. Upstream fix pending; the guard is then harmless dead weight.

## Boot diagnostics contract

The watchdog reports on the `console.error` channel. The shell APK matches the line prefix and then
reads the remaining fields **by position**, so the field order below is part of the interface:

| line | meaning | fields after the prefix |
|---|---|---|
| `[dsh-boot-stall] dsh-boot-diag source=page-stall ...` | 40s without a render | `pageSideRuntime=<folded JSON> detail=<folded k=v>` |
| `[dsh-boot-ready] dsh-boot-diag source=page-ready ...` | `#root` rendered **and** the boot page is gone | `pageSideRuntime=<folded JSON>` |
| `[dsh-boot-failed] dsh-boot-diag source=page-plugin-fail ...` | client plugin tree failed | `detail=reason=<first line, 200 chars> takenMs=<ms> failedCount=<N> rendered=<bool>`, `failedIds=<comma list or ->`, `pageSideRuntime=<folded JSON, last>` |

`failedIds` keeps only items that look like a loader entry id
(`/^[@A-Za-z0-9][@A-Za-z0-9._\/-]*$/`, at most 120 characters), at most 8 items, unquoted and
space-free; `-` when none is readable. It sits **before** `pageSideRuntime` because `fold`
truncates at 2048 characters and a truncated JSON tail cannot be parsed at all.

Readiness is `rendered() && !bootPagePresent()`. A failed client plugin tree renders a boot page
that still gives `#root` children, so the old `rendered()`-only criterion reported it as ready: the
shell stopped its stall timer and the failure stayed silent. The failure line is published from two
idempotent trigger points — the `MutationObserver` callback (2s debounce) and every `readyWatch`
tick, which covers a failure page that reached its final state before the observer was installed.
`pendingBoot()` is unchanged, so a failure page deliberately does **not** raise the 40s overlay: it
exits through `[dsh-boot-failed]` instead.

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
node scripts/boot-watchdog.test.mjs # watchdog behaviour: pendingBoot / ready / failure contract line
node scripts/slot-guard.test.mjs     # slot guard: undefined-element neutralization / idempotency / injection position
```

The script loads the real plugin against a stubbed cordis, runs one `tapIndex` transform, and parses
every served script element — the only check that catches an assembly syntax error (grepping the text
does not).