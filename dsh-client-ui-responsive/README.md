# dsh-client-ui-responsive

[🌐 中文说明 / 中文 README](README.zh.md)

> **dsh-mobile 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

Mobile-responsive AppFrame for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web UI. A drop-in replacement for the upstream `ui-layout` that adds a proper **Mobile form**
(<640px): drawer sidebar, bottom-sheet details, top bar with hamburger, and safe-area insets —
while keeping the Wide/Narrow behavior byte-identical to upstream.

## Quick start

**1. Install** — package into the web profile's node_modules (see dsh-shell-termux for the pattern).

**2. Mount** — in the profile's `cordis.patch.yml`:

```yaml
- id: ui-layout
  disabled: true
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
```

**3. Restart** and verify the browser roster (`window.__DSH_BOOT__` entries contain
`@dsh-android/dsh-client-ui-responsive`, `ui-layout` is gone).

## Breakpoint system

| tier | width | form |
|---|---|---|
| Wide | ≥1024px | three columns, upstream behavior |
| Narrow | 640–1024px | upstream auto-collapse rail + manual re-expand |
| **Mobile** | <640px | single column: sidebar → left drawer, details → bottom sheet, top bar + hamburger, safe areas |

Landscape phones (≥640 logical px) reuse the original Wide/Narrow UI unchanged.

## Behavior notes

- **Same slots, same services**: `sidebar`/`conversation`/`details`/`shell.overlay` and
  `ctx.layout` are provided identically to ui-layout — consumers (ui-sidebar, ui-conversation)
  work unchanged.
- **Mobile state semantics**: hamburger toggles the drawer (mask tap closes); opening details via
  `ctx.layout.openDetails()` shows the bottom sheet; `shell.overlay` stays the top layer (z 20).
- **Rotation** is instant: the frame switches tiers via the same rAF-throttled ResizeObserver;
  `prefers-reduced-motion` disables transitions.

## Build

```sh
npm install          # baseline pinned to @deepseek-ai/* 0.1.0-rc.6
npm run build        # tsc (lib/types) + tsdown (lib/client.js browser bundle)
npm run typecheck
```

The browser bundle uses the `__ModuleLoader__.load` contract; rebuild before probing a live server
(the registry serves `lib/client.js`, not sources).

## Testing

- Component specs: host CDP against a served page at 412px (drawer open/close, mask) and 1280px
  (three-column regression) — see the project verification log in the coordination repo.
- Old-kernel browsers (pre-ES2024 WebView) cannot load the client bundles; use a current WebView
  (system WebView is fine) — the polyfill plugin helps for older kernels.

## License

MIT. Derived from `@deepseek-ai/dsh-client-ui-layout` (MIT, © 2026 DeepSeek) — see NOTICE.
Design rationale: `docs/design.md`.
