# dsh-client-ui-responsive

[中文说明](README.zh.md)

> **dsh-mobile 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）· [dsh-mobile](https://github.com/kelai141/dsh-mobile)（协调仓库，private）

Android mobile adaptation layer for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web UI.

**0.2.0 de-forked the plugin.** Up to 0.1.14 it replaced the upstream `ui-layout`
frame with a mobile fork of its own. Upstream 0.1.5 turned `ui-layout` into the
layout service hub (`ctx.layout`, the keyed `main` panel seat, the right column's
track/fullscreen reporting) that ui-conversation, ui-sidebar and ui-sidebar-right
all compose against — reproducing that surface meant re-forking it every release.
The plugin now keeps upstream's frame and adds only what a phone needs.

## What it does

Phone session reordering translates a long press into the upstream drag lifecycle.
Multitouch, cancellation, and out-of-list release settle back on the source row
without saving a new order. Each phase flushes React state before the next one,
and transfer metadata remains compatible with global file-drop listeners.

| Area | Contribution |
|---|---|
| Phone form (<768px) | CSS over the upstream frame: the left sidebar becomes an off-canvas drawer, the centre column spans the frame, the right Sidebar keeps upstream's own fullscreen slide-over (same 768px threshold), touch drag handles step aside |
| Drawer entry | `shell.overlay` top bar with one toggle (the rail sits off-canvas on a phone, and no control is added to the composer row) |
| Native "open with" | An `extension`-band tab type for archives/binaries, plus an “Open in external app” pill below the document preview's unsupported notice (including audio), in both narrow and wide layouts. The preview supplies the resolved path; the existing shell bridge opens the Android chooser. The former Session-header directory action is retired. |
| Composer | Insets (system bars + IME), narrow-screen control-row cap, popup width/height/shift guard, mobile Enter guard, and an upward paperclip source menu. The menu reuses the existing hidden multiple-file input: “Upload attachment” temporarily selects `*/*`; “Upload image” selects `image/*`; both preserve that filter through WebView's synchronous input-focus event, restore it when SAF settles, and use the upstream draft/upload flow. |
| Browser and scope | The Files sidebar registers a native BrowserHost workbench beside workspace files. The Developer-options card 「屏幕与 Shizuku 控制」 owns the `virtual-only` / `real-only` / `all` screen-access selector; model tools cannot write it. |
| External open/share | The consumer opens a blank temporary Session, claims opaque incoming metadata only after its Session scope exists, and adds one unsent generic file attachment through the upstream composer/upload path. It never creates an `@path` message and does not restore the draft after restart. |
| Shell surfaces | Developer options section, Android general settings rows, export-result dialog, theme bridge, keyboard boundary |
| Retired with 0.1.5 | The frame fork, the duplicated theme presenter, the injected 「上传图片」/「导出调试日志」 menu items, the image-pick bridge, and the CSS that hid upstream's own attachment buttons |

## Right-panel bubble tabs

Below 768 CSS pixels, a current-title header and top-right disclosure replace the persistent horizontal strip. Pills derive their order, live title, status and close eligibility from the native tabs. Selection collapses the list. Swipe vertically to scroll; hold for 400ms to reorder within the original pane. Alt plus Up/Down reorders; arrows/Home/End move focus; Delete closes; Escape and Android Back dismiss navigation first.

Wide windows retain native horizontal tabs and the parallel main/secondary layout. Resizing replaces navigation chrome only and leaves tab content under its existing owner. The list follows panel, safe-area and visual-viewport bounds. Native BrowserHost is hidden during the disclosure and exit animation, then presents the same retained page.

Reordering requires the mobile patch `sidebar-bubble-reorder-B1`, which adds `sidebarRight.reorderIn(session, tab, before)` over the existing placement/focus actions. It retains the active tab and rejects stale Sessions, floating pages and cross-pane targets. Ship the engine adapter and plugin together; runtime hot-push must update both.

Tests: [bubble interaction](tests/sidebar-bubbles.spec.ts), [native browser presentation](tests/native-browser-presentation.spec.ts). The APK mirror supplies the device driver `scripts/verify-sidebar-bubbles.mjs`.

## Install and mount

**1. Package** into the web profile's `node_modules` (see dsh-shell-termux for the pattern).

**2. Insert** in the profile's `cordis.patch.yml` — `ui-layout` stays ENABLED:

```yaml
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true
```

**3. Restart** and verify the browser roster (`window.__DSH_BOOT__` entries contain
both `ui-layout` and `@dsh-android/dsh-client-ui-responsive`).

## Contract anchors

The narrow form keys on DOM facts, never on CSS-Module class names, and the facts
themselves are published by this plugin:

| Fact | Written by | Consumed by |
|---|---|---|
| `html[data-dsh-mobile-form]` | `mobile/form-marker.ts` (mirrors `(max-width: 767px)`) | every injected stylesheet |
| `[data-dsh-frame]` | same (tagged from upstream's `[data-rightbar-col]`) | `mobile-form.css.ts`, keyboard boundary |
| `html[data-dsh-modal-open]`, `[data-dsh-settings-dialog]` | same | settings-panel reflow |
| `[data-dsh-mobile-topbar]` | `mobile/MobileChrome.tsx` | composer popup guard |

Upstream attributes the sheet relies on: `data-sidebar-collapsed`,
`data-rightbar-col`, `data-rightbar-panel="fullscreen"`,
`data-sidebar-right-toggle`, `data-conversation-header-corner`.

## Build

```sh
npm install          # @deepseek-ai/* pinned to 0.1.5-rc.1
npm run typecheck
npm run build        # tsc (lib/types) + tsdown (lib/client.js browser bundle)
npx vitest run
```

The browser bundle uses the `__ModuleLoader__.load` contract; rebuild before probing
a live server (the registry serves `lib/client.js`, not sources).

## License

MIT. Derived from `@deepseek-ai/dsh-client-ui-layout` (MIT, © 2026 DeepSeek) — see NOTICE.
Design rationale: `docs/design.md`.
