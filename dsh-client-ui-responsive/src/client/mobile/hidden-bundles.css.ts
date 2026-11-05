/**
 * Plugin entries the Android form hides from the Plugins page (2026-10-31, user decision).
 *
 * Both bundles below carry a native payload this shell cannot load, so neither can be
 * repaired from here (upstream is a read-only checkout in this repository):
 *
 * - `@deepseek-ai/dsh-subagent-claude-code` depends on `claude-agent-sdk-linux-*`, a glibc
 *   dynamic binary; Android has no `/lib64/ld-linux-x86-64.so.2`, so it is structurally
 *   unusable there.
 * - `@deepseek-ai/dsh-subagent-codex` installs (pnpm skips the platform package) but cannot
 *   run: the shipped 0.153.4 binary is not static-pie.
 *
 * The user's call (2026-10-31, verbatim): 「纯 UI 隐藏——看不见就不会想装；高级用户自己能鼓捣
 * 那是他们的事」. Hiding beats unmounting: the cards belong to the upstream plugin manager,
 * which owns that list, and a stylesheet override leaves its React state untouched.
 *
 * Anchors are the upstream page's own published attributes, never hashed CSS-Module class
 * names and never row positions:
 * - `data-plugin-package={pkg.name}` — the bundle card in the list (plugin-manager
 *   `PluginManagerPage.tsx:549`; the same card renders in the Extensions group and on the
 *   More list, so one rule covers both).
 * - `data-plugin-detail={pkg.name}` — the detail page that card opens (`:727`); kept so a
 *   deep link (`pluginNavigation.openBundle`) cannot land on a hidden entry's page.
 *
 * Scope: every rule is gated on `html[data-dsh-mobile-form]` (published by
 * `mobile/form-marker.ts`), so the desktop and web forms keep both entries.
 */

/**
 * Bundles whose entries the Android form does not show: each one's native payload is
 * missing from the Android distribution, so the entry can only lead to a broken install.
 */
export const ANDROID_HIDDEN_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-subagent-codex',
]

/** One `display: none` block per hidden bundle, all gated on the Android form marker. */
export const HIDDEN_BUNDLES_CSS: string = ANDROID_HIDDEN_BUNDLES.map(name => `
/* ${name}: no Android native payload -> not offered on the phone form. */
html[data-dsh-mobile-form] [data-plugin-package="${name}"],
html[data-dsh-mobile-form] [data-plugin-detail="${name}"] {
  display: none !important;
}
`).join('')
