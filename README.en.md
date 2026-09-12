[![QQ群](https://img.shields.io/badge/QQ群-dsh--mobile用户群-12B7F5?logo=tencentqq)](https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info)

# dsh-mobile-apk — DeepSeek Harness Android Shell APK

[🌐 中文说明 / 中文 README](README.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)


> **dsh-mobile 生态** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux)（shell）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）

> **0.13.0 — official release**: the ADB real channel (pairing / port discovery / shell execution / authorization gates / audit) is fully implemented and device-verified.
> - **Plugin-marketplace caveat**: the built-in marketplace covers many third-party plugins, and **most of them are likely unavailable or buggy on phones** (mobile vs desktop differ in WebView engine / filesystem / permission model / runtime). Mobile adaptation is long-term work — treat this beta as usability validation & feedback, not a production dependency. Report plugin issues to the [issue tracker](https://github.com/kelai141/dsh-mobile-apk/issues) with device model / version / reproduction steps.

Android shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): WebView UI
over an **embedded Termux runtime snapshot** (extract-and-run, no Termux app needed), SAF directory
bridge, keep-alive foreground service, engine watchdog, and online runtime updates. One APK to
install: it boots a full dsh web agent that can really execute bash. App name `DeepCode` (icon text
DeepSearch), package `com.dsharnessmobile.shell`, version `0.13.0-fx-1` (versionCode 26).

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
- **APK self-update (0.13.8)** — the startup screen's "check for updates" button, manual only
  (**never automatic**): queries the GitHub latest release, matches the asset for the device ABI and
  downloads it through a mirror chain. When a newer version exists the **same button** turns into
  "download and install vX.Y.Z" as a second confirmation; after the download the system
  "install unknown apps" screen is opened on first use, then the system installer (signature
  mismatch is rejected by the system; the app never installs anything silently).
- **SAF bridge** — `pickDirectory` maps the picked tree to a real path (`/storage/emulated/0/…`).
- **Device access** — All Files Access; Shizuku probe example.
- **ADB real channel (0.13.0)** — real `adb pair` SPAKE2 handshake + NSD/mDNS port discovery,
  shell execution via adbd (uid 2000) with danger-command blacklist, three-gate authorization
  (All Files Access / in-app switch / pairing code) plus live session-mode gating, and native audit
  (`files/audit/audit.ndjson`); connect-port rotation self-heals with a 5555 fallback.

## Download / Install

Release `v0.13.0-fx-1` ships two ABI variants (plus snapshot archives, plugin packages,
MANIFEST checksums and release notes):

| APK | Target |
|---|---|
| `dsh-mobile-apk-v0.13.0-fx-1-arm64.apk` | arm64 devices (real phones) |
| `dsh-mobile-apk-v0.13.0-fx-1-x86_64.apk` | x86_64 emulators / devices |

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
`androidBridge.version` returns the app version (currently `0.13.0-fx-1`, versionCode 26);
pages feature-detect on it. The ADB methods below are the preview authorization surface — the real
channel completes in the 0.13.0 official release.

**Synchronous**

| method | signature | description |
|---|---|---|
| `version` | () → string | app version (`0.13.0-fx-1`) for feature detection |
| `getSystemDark` | () → boolean | system dark mode (bypasses vendor WebViews whose `matchMedia` is stuck on light; used by the first-frame theme bridge) |
| `checkEngine` | () → string | probes 127.0.0.1:3080; JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | () → boolean | whether All Files Access is granted (external workspace requirement) |
| `getPickToken` | () → string | one-shot token for the directory-picker bridge (validated by the engine-side pick endpoint) |
| `copyText` | (text) → boolean | native clipboard write (WebView `clipboard.writeText` is always rejected; page falls back to this) |
| `getDevLogEnabled` | () → boolean | dev debug-log toggle **fact** = preference && collector running (ST-11) |
| `getImmersiveMode` | () → boolean | authoritative shell-side immersive value (ST-10; pairs with `setImmersiveMode`) |
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

## APK self-update protocol (0.13.8)

Fully separate from the runtime snapshot update above (`UpdateChecker` vs `UpdateManager`); this one
handles the APK itself:

1. **Manual only** — triggered by the startup screen's "check for updates" button, never automatically
   (no background behavior around a 160MB asset);
2. **Metadata** — `api.github.com/repos/kelai141/dsh-mobile-apk/releases/latest`, direct with 10/15s
   timeouts; failures report the real reason (HTTP code / exception) and do **not** block the existing
   snapshot-update check (the same button then runs it);
3. **Asset match** — `dsh-mobile-apk-v<version>-<abi>.apk` with the ABI taken from `SUPPORTED_ABIS[0]`
   (the device's native ABI; ARM-translated x86 devices report `x86_64,arm64-v8a,x86` and a naive
   "any arm64" rule downloads the wrong package);
4. **Version compare** — tag vs `BuildConfig.VERSION_NAME` (minus any `-SN-*` snapshot suffix), compared
   digit-group by digit-group, covering both semver and the `0.13.7fx-N` revision naming;
5. **Mirror-chain download** — `github.com` direct → `gh-proxy.com` → `ghfast.top`, landing in
   `Documents/dshdata/updates/` (already inside the FileProvider mapping), `.tmp` → rename atomic;
   verified against the `.sha256` asset when present (mismatch deletes the file and reports); an already
   downloaded, verified package is reused instead of re-downloading after an interrupted permission flow;
6. **Install** — without the "install unknown apps" grant the system settings screen is opened first
   (the install resumes on `onResume` after granting), then a FileProvider URI + `ACTION_VIEW` opens the
   system installer; a signature mismatch is rejected by the system. Nothing is ever installed silently.

This is the shell's only external HTTP egress (every other shell-side HTTP call is same-origin to the
local engine at `127.0.0.1:3080`) and it only fires on an explicit user tap.

## Permissions

| permission | purpose |
|---|---|
| `INTERNET` | WebView + engine probe + APK self-update (manual only) |
| `POST_NOTIFICATIONS` | notification channel (runtime request on API 33+) |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | keep-alive foreground service |
| `MANAGE_EXTERNAL_STORAGE` | All Files Access (external workspace requirement; special permission, user-granted) |
| `REQUEST_INSTALL_PACKAGES` | open the system installer for a downloaded update (0.13.8; the user must grant "install unknown apps" in system settings) |

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
Yangerwei (file race feedback), gr12-cmd (armv7l demand), cmyfqwq (coverage-install compatibility feedback).

Contributors welcome: Android compatibility testing (Huawei / Honor / Xiaomi custom WebViews),
armv7l and more device support, completing the ADB channel, and growing the plugin ecosystem.
Development & contribution guidelines live in each repo's `AGENTS.md`.