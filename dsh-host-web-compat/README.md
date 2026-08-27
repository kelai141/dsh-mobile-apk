# dsh-host-web-compat

[🌐 中文说明 / 中文 README](README.zh.md)

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）

Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that injects
legacy-browser polyfills into every served page via the webserver `tapIndex` hook. Fixes the
in-app directory picker and other RPC flows on older WebView/browser kernels.

## Background

Old kernels (e.g. MuMu's bundled browser, older WebViews) lack `AbortSignal.any()`, which breaks
the workspace directory picker's concurrent RPC cancellation (list renders empty). This plugin
injects idempotent polyfills at the HTML level — no browser-side changes needed.

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
| `AbortSignal.any` | missing | Chrome 116+ / Node 20.3+; older WebViews need it |
| `structuredClone` | missing | Chrome 98+ / Node 17+ |

Idempotent: skipped when already present.

## Notes

- Keep this plugin even in the shell-APK form as a last-mile fallback for old system WebViews.
- If you move to a native SAF picker, the page still benefits from the other polyfills.

## License

MIT.
