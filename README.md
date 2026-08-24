# dsh-mobile-apk — DeepSeek Harness Android Shell APK

[🌐 中文说明 / 中文 README](README.zh.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)


> **dsh-mobile 生态** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）

> ⚠️ **0.13.0-preview — preview release**: unstable, intended for community validation — do not rely on it in production.
> - **ADB is not complete**: pairing / port auto-scan / execution are preview UI screens — the real ADB channel is under development and completes in the 0.13.0 official release.
> - **Plugin-marketplace caveat**: the built-in marketplace covers many third-party plugins, and **most of them are likely unavailable or buggy on phones** (mobile vs desktop differ in WebView engine / filesystem / permission model / runtime). Mobile adaptation is long-term work — treat this beta as usability validation & feedback, not a production dependency. Report plugin issues to the [issue tracker](https://github.com/kelai141/dsh-mobile-apk/issues) with device model / version / reproduction steps.

Android shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): WebView UI
over an **embedded Termux runtime snapshot** (extract-and-run, no Termux app needed), SAF directory
bridge, keep-alive foreground service, engine watchdog, and online runtime updates. One APK to
install: it boots a full dsh web agent that can really execute bash. App name `DeepCode` (icon text
DeepSearch), package `com.dsharnessmobile.shell`, version `0.13.0-preview` (versionCode 24).

## Features

- **Embedded runtime** — xz snapshot (arm64 151.6 MB / x86_64 158.9 MB) bundling node + git + bash +
  coreutils + dsh + plugins + pnpm + python/perl/ruby; first launch extracts in 2–4 min
  (`refreshSnapshot`), engine listens on `127.0.0.1:3080`; fully offline.
- **File-to-session (F5)** — "Open with / Share" auto-jumps into this app and forces a fresh temp
  workspace session for the file; temp workspaces get a 7-day TTL auto-cleanup and appear in the
  workspace panel (issue #60).
- **Search (grep/glob)** — mobile ripgrep platform package (android-arm64, pcre2/NEON full-featured).
- **Notifications** — automatic task-completion notifications (engine event bridge + watchdog
  consumer); system notification chain incl. authorization requests.
- **Mobile UI** — responsive plugin (drawer/sheet on phones); adjustable font size, immersive status
  bar, dark theme.
- **Built-in console** — standalone bash terminal (`assets/console.html` + embedded Termux), usable
  for diagnostics even when the engine is down.
- **Keep-alive** — foreground service + 5s watchdog (auto-restarts a hung engine) + 3s UI monitor
  poll + crash auto-rollback gate (UndoGate).
- **Online runtime updates** — manifest-driven snapshot swap (download → sha256 → atomic switch →
  auto-restart); the running runtime can update itself without an APK update.
- **SAF bridge** — `pickDirectory` maps the picked tree to a real path (`/storage/emulated/0/…`).
- **Device access** — All Files Access; Shizuku probe example.
- **ADB authorization UI (preview)** — three-gate authorization state machine + pairing-port
  auto-scan; the real ADB channel lands in the 0.13.0 official release.

## Download / Install

Release `v0.13.0-preview` ships two ABI variants:

| APK | Target |
|---|---|
| `dsh-mobile-apk-v0.13.0-preview-arm64.apk` | arm64 devices (real phones) |
| `dsh-mobile-apk-v0.13.0-preview-x86_64.apk` | x86_64 emulators / devices |

```sh
adb install -r -t <apk>    # same-signature overwrite install
```

**ABI must match the device.** A mismatched snapshot crashes the engine at startup — node ELF
`EM_X86_64` vs `EM_AARCH64`. Pick arm64 for real phones, x86_64 for emulators.

## Build

Snapshot build & packaging live in the coordination repo
([dsh-mobile](https://github.com/kelai141/dsh-mobile)); this repo is the shell. Requirements:
JDK 17+, Android SDK (compileSdk 36); Gradle 8.11.1 via wrapper.

```powershell
# Snapshot build (Termux sources + dependency closure + pnpm + cordis overrides + slimming):
node scripts\build-snapshot-013.mjs <arm64|x86_64>

# One-shot packaging (snapshot → injection → gates → gradle):
pwsh scripts\build-apk-013.ps1 -Suffix "-preview"
# output: out\v0.13.0\dsh-mobile-apk-v<ver>-<abi>.apk
```

Gates (inside `build-apk-013.ps1`): third-party compliance (`check-third-party.mjs`, GPL
obligations) / secrets / ELF / cordis mount-set ⊇ injected set / LICENSES self-check (Python
streaming) — any failure rejects the build.

## Bridge protocol v1 (`window.androidBridge`)

App name `DeepCode` (icon text DeepSearch), package `com.dsharnessmobile.shell`.
`androidBridge.version` returns the app version (currently `0.13.0-preview`, versionCode 24);
pages feature-detect on it. The ADB methods below are the preview authorization surface — the real
channel completes in the 0.13.0 official release.

**Synchronous**

| method | signature | description |
|---|---|---|
| `version` | () → string | app version (`0.13.0-preview`) for feature detection |
| `getSystemDark` | () → boolean | system dark mode (bypasses vendor WebViews whose `matchMedia` is stuck on light; used by the first-frame theme bridge) |
| `checkEngine` | () → string | probes 127.0.0.1:3080; JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | () → boolean | whether All Files Access is granted (external workspace requirement) |
| `getPickToken` | () → string | one-shot token for the directory-picker bridge (validated by the engine-side pick endpoint) |
| `copyText` | (text) → boolean | native clipboard write (WebView `clipboard.writeText` is always rejected; page falls back to this) |
| `getDevLogEnabled` | () → boolean | dev debug-log toggle state |
| `getAdbState` | () → string | ADB authorization state view (gate state machine): JSON `{fullAccess, allowSwitch, paired, wirelessDebugOn, message}` (preview) |
| `discoverAdbPorts` | () → string | wireless-debug port auto-scan (native TCP sweep): pairing-port candidates as JSONArray; `[]` while wireless debugging is off (preview) |
| `setAdbPair` | (code, pairPort, connectPort) → boolean | gate-3 pairing: real `adb pair` handshake; the code goes to argv only — never into the audit log (preview) |
| `adbShell` | (cmd) → string | ADB shell primitive: JSON `{ok, stdout?, stderr?, guidance?}`; fail-closed when not authorized (preview) |

**Commands**

| method | signature | description |
|---|---|---|
| `keepScreenOn` | (enable) | screen-on wake lock |
| `showNotification` | (title, text) | test notification channel (POST_NOTIFICATIONS) |
| `pickDirectory` | (callbackId) | SAF tree picker; result async via `window.__dshBridge.onDirectoryPicked(callbackId, path)` |
| `pickImage` | (callbackId) | SAF image picker; result async via the same callback |
| `setTextZoom` | (percent) | WebView font scale (50–200; Settings → General slider) |
| `setImmersiveMode` | (enable) | immersive status bar toggle (true = status bar normally hidden) |
| `downloadDebugLogs` | () | exports engine logs + environment info (zipped, system download/share dialog) |
| `requestAllFilesAccess` | () | opens the system All Files Access grant page (special permission) |
| `restartEngine` | () | restarts the engine process (EngineService watchdog brings it back) |
| `shutdownToGuide` | () | stops the engine and falls back to the test screen (no auto-restart) |
| `reloadWebUI` | () | reloads the Web UI |
| `openConsole` | () | opens the built-in console |
| `setDevLogEnabled` | (enabled) | sets the dev debug-log toggle (logs go under `dshdata/log/` when on) |
| `setAdbAllow` | (enable) | gate-2 "allow access" switch (default off; off ⇒ channel fail-closed) (preview) |
| `revokeAdbPair` | () | revoke pairing (disconnect + delete adbkey + clear state; audited) (preview) |

The bridge decouples the APK from the dsh version: pages feature-detect on `androidBridge.version`.

## Online update protocol

1. App fetches `manifest.json`: `{url, sha256, size}` (default `http://10.0.2.2:8899/manifest.json`
   for emulator testing; production points at a release server);
2. Downloads the snapshot, verifies SHA-256, extracts to a staging dir (never touching the live tree),
   atomically swaps `usr` → `usr-old` → new `usr`, then kills the old engine — the watchdog
   restarts it from the new runtime.

Test trigger: `adb shell am start -n com.dsharnessmobile.shell/.MainActivity -a com.dsharnessmobile.shell.action.UPDATE`;
status is written to `files/update-status.txt`. Test server: serve `manifest.json` + the snapshot from any
local HTTP server (default endpoint `http://10.0.2.2:8899/manifest.json` maps the host from the emulator).

## Permissions

| permission | purpose |
|---|---|
| `INTERNET` | WebView + engine probe |
| `POST_NOTIFICATIONS` | notification channel (runtime request on API 33+) |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | keep-alive foreground service |
| `MANAGE_EXTERNAL_STORAGE` | All Files Access (external workspace requirement; special permission, user-granted) |

SAF picking needs no permission.

## ABI & pagesize

arm64 and x86_64 are both verified end-to-end; APKs are distributed per-ABI (the embedded snapshot
is arch-specific). A 16KB-page build must be produced on a 16KB device (see docs/design.md §ABI).

## License

MIT. Contains third-party components under their own licenses (see dependency declarations).
GPL compliance: copyleft license texts ship in all three forms — snapshot `usr/share/LICENSES/`,
repo `LICENSES/`, and APK `assets/licenses/`. Design rationale: `docs/design.md`.

## Acknowledgments & invitation

Thanks to the community for feedback and contributions — especially cdwlll (environment issues),
haitunlang (MIUI 12 compatibility), TACONailoong (legacy-WebView compat), X-SCI-TECH (PRs),
Yangerwei (file race feedback), gr12-cmd (armv7l demand).

Contributors welcome: Android compatibility testing (Huawei / Honor / Xiaomi custom WebViews),
armv7l and more device support, completing the ADB channel, and growing the plugin ecosystem.
Development & contribution guidelines live in each repo's `AGENTS.md`.