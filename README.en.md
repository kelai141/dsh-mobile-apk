# dsh-mobile-apk — DeepSeek Harness Android Shell APK

[🌐 中文说明 / 中文 README](README.md)

[![QQ群](https://img.shields.io/badge/QQ群-dsh--mobile用户群-12B7F5?logo=tencentqq)](https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info)
[![QQ Group 2](https://img.shields.io/badge/QQ_Group_2-dsh--mobile_users_2-12B7F5?logo=tencentqq)](qrcode/qqcommunity-2.png)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek_Harness-blue?style=flat&logo=DeepSeek&logoSize=auto&color=%232D5F9E)
![Android](https://img.shields.io/badge/Android-blue?style=flat&logo=Android&logoSize=auto&color=%2397CA00)

> **dsh-mobile ecosystem** · [dsh-shell-termux](https://github.com/kelai141/dsh-shell-termux) (shell) · [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive) (mobile UI) · [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat) (web compat) · [dsh-mobile](https://github.com/kelai141/dsh-mobile) (coordination repo, private)

Android shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): WebView UI
over an **embedded Termux runtime snapshot** (extract-and-run, no Termux app needed), SAF directory
bridge, keep-alive foreground service, engine watchdog, and online runtime updates. One APK to
install: it boots a full dsh web agent that can really execute bash.

App name `DeepCode` (icon text DeepSearch), package `com.dsharnessmobile.shell`,
current source version **`0.14.6`** (versionCode 50), engine `@deepseek-ai/dsh` 0.2.0-rc.2 (local development candidate, **not released**).

> **Plugin-marketplace caveat**: the built-in marketplace covers many third-party plugins, and
> **most of them are likely unavailable or buggy on phones** (mobile vs desktop differ in WebView
> engine / filesystem / permission model / runtime). Mobile adaptation is long-term work — treat this
> beta as usability validation & feedback, not a production dependency.
> Report plugin issues to the [issue tracker](https://github.com/kelai141/dsh-mobile-apk/issues)
> with device model / version / reproduction steps.

## Features

### Runtime and lifecycle

- **Embedded runtime** — xz snapshot bundling node + git + bash + coreutils + dsh + plugins + pnpm +
  python/perl/ruby; first launch extracts in 2–4 min (`refreshSnapshot`), engine listens on
  `127.0.0.1:3080`; fully offline.
- **APK self-update (the primary user-facing path as of 0.14.6)** — queries the GitHub latest release,
  matches the asset by device ABI, and falls back through a mirror chain; after download it verifies
  sha256 and launches the system installer. Two entry points share **one** state: "Check for updates"
  reachable in the healthy state, and a secondary button on the launch screen; **never automatic**.
  The update action **never occupies the phase or the primary button**, and every terminal state
  lands on honest text (with a timeout fallback).
- **Runtime snapshot update** — manifest-driven snapshot replacement (download → sha256 → atomic swap →
  restart), so the runtime self-updates without an APK update. The tree swap is **one transaction**:
  extract to staging → verify completeness → swap wholesale; interruption rolls back, and user data
  (sessions / attachments / settings / credentials / workspaces) is **never** touched.
  Note: as of 0.14.6 the user-facing entry moved to the APK update above, and the snapshot chain is no
  longer triggered from the launch screen; the adb-only debugging path remains but has no timeout fallback.
- **Keep-alive** — foreground service + 5s watchdog (relaunches a wedged engine) + 3s UI poll +
  crash rollback gate (UndoGate).
- **Built-in console** — a standalone interactive bash terminal (`assets/console.html`) that works
  even when the engine is down.

### AI browser (isolated WebView workbench)

- A separate workbench in the right sidebar, backed by a **second WebView fully isolated** from the
  main UI. The AI can open tabs and manage multiple pages at once; opening the sidebar lets a human
  view several tabs simultaneously — **the UI is for humans, the AI reads pages through tools**.
- **Resolution = CSS viewport** (document-start injection of `width=<cssW>` plus a letterboxed
  physical rect), so `window.innerWidth` equals the requested value exactly; **PC / mobile identity**
  is switchable (UA-CH capability gate; WebView 110 "degraded" is reported honestly).
- The viewport **no longer collapses to 0x0** when the sidebar is collapsed (visibility uses
  `INVISIBLE` rather than `GONE`, preserving layout, with a non-degenerate rect derived from the
  last stage size).
- `browser_snapshot` now renders a ref per line (previously only a count, leaving the model with no
  clickable targets).
- Scroll avoidance, Edge-style error page, close-to-destroy, and failure rendering with a real error.

### Virtual display (run third-party apps on a separate screen)

- Creates a virtual display through the **Shizuku privileged channel**, so third-party apps run on a
  separate screen **without taking over the user's foreground**; single instance, max 1, with alias
  reuse (`virtual-1` is always the fresh-screen number).
- **The only workable cross-screen launch path**: the shell-side Shizuku UserService running
  `am start --display <id> -n <component>` (fixed argv, component resolved first via
  `cmd package resolve-activity`). The other three paths were measured and do not work
  (`monkey --display` has no such option / shell `am start` is unreliable / in-process
  `setLaunchDisplayId` is rejected by `SafeActivityOptions`).
  Model-facing usage: `android_app_launch { pkg, screenId: "virtual-N" }`.
- **Coordinate input** — absolute `x/y` plus `screenId` on a virtual display (injected through
  `input -d <displayId>`, leaving the real screen untouched); normalized `nx/ny` is **explicitly
  rejected** on virtual displays (an ambiguous denominator silently taps the real screen).
- **Screenshot respects the target** — both `android_screenshot { screenId }` channels now land on
  the target displayId and report that screen's own pixel dimensions as the resolution anchor
  (previously the ADB fallback ignored `screenId` and captured the real screen).
- Aspect-preserving fit (letterboxed and centered by content aspect ratio, never stretched),
  10-minute idle reclaim, and a "phone control" settings section with force-destroy (triple-tap).

### Phone control (accessibility + Shizuku, dual channel)

- **Accessibility channel** — semantic tree / ref actions / virtual-display semantic tree.
  **Shizuku privileged channel** — executes system commands as uid 2000 (`screencap` / `uiautomator` /
  `dumpsys` / `input`, read-only and input classes only; system-configuration writes are always rejected).
- **ref addressing** — node handles are retained at dump time so relocation never re-walks
  `childPath`; the window id is pinned when the tree is built (focus changes no longer switch trees);
  the UI cache TTL is 10 minutes.
- **screenId triple** — `screenId` / `displayId` / `scope` are backfilled per entry, and `guard()`
  resolves aliases asynchronously (a virtual-display alias to a dynamic displayId must ask the
  shell-side registry; the synchronous surface cannot do it).
- **"Phone control" settings section** — Shizuku status and guidance, screen scope, virtual-display
  scale, floating-window toggle, accessibility entry, force destroy.

### Attachments and files

- **Paperclip pop-up menu** (DSH-native visuals): the paperclip shows "Upload attachment / Upload
  image", and it opens on a **single tap** (no more double-tap). The two rows go to the **system file
  picker** and the **system photo gallery** respectively (an explicit image type routes to
  `PickMultipleVisualMedia`, the system photo picker on API 33+).
- **File-to-session** — "Open with / Share" auto-jumps into this app and forces a fresh temp workspace
  session for the file; temp workspaces get a 7-day TTL auto-cleanup.
- **SAF bridge** — `pickDirectory` maps the chosen directory to a real path.

## Download / install

Releases provide both ABI packages (plus snapshot archives, plugin packages, a MANIFEST checklist and
release notes):

| APK | Applies to |
|---|---|
| `dsh-mobile-apk-v<version>-arm64.apk` | arm64 devices (real hardware) |
| `dsh-mobile-apk-v<version>-x86_64.apk` | x86_64 emulators / devices |

```sh
adb install -r -t <apk>    # in-place upgrade, same signature
```

**The ABI must match the device.** A mismatch crashes the engine on start — node ELF `EM_X86_64` vs
`EM_AARCH64`. Use the arm64 package on real hardware and x86_64 on emulators.

> **After an in-place upgrade, wait for the first extraction to finish** (snapshot fingerprint flip),
> and do not force-kill the app while it runs.

## Build

Snapshot construction and packaging happen in the **coordination repo**
([dsh-mobile](https://github.com/kelai141/dsh-mobile)); this repository is the shell subrepo.
Requirements: JDK 17+, Android SDK (compileSdk 36); Gradle 8.11.1 comes from the wrapper.

```powershell
# Snapshot build (Termux source + dependency closure + pnpm + authoritative cordis overlay + slim):
node scripts\build-snapshot-013.mjs <arm64|x86_64>

# One-shot package (snapshot → inject → gates → gradle, both ABIs):
pwsh scripts\build-apk-013.ps1 -Suffix ""

# dev profile: single ABI x86_64 + preset 1 (larger artifacts, not for release)
pwsh scripts\build-apk-013.ps1 -Fast
```

Artifacts land in `out\v<version>\dsh-mobile-apk-v<version>-<abi>.apk`.

Gates are aggregated by `scripts/check-release-gates.mjs` (`--list` counts them). Any failing gate
refuses packaging, and the strict release profile `--run --require` demands SKIP=0.

## Bridge protocol v1 (`window.androidBridge`)

The shell exposes **51 `@JavascriptInterface` methods**; the page feature-detects through
`androidBridge.version`, which keeps APK and dsh versions decoupled.

**Synchronous getters**

| Method | Purpose |
|---|---|
| `version` | App version string, for feature detection |
| `getSystemDark` | System dark mode (works around some vendors' broken `matchMedia`, used for the first-frame theme) |
| `checkEngine` | Probes `127.0.0.1:3080`; JSON `{running, latencyMs, error?}` |
| `hasAllFilesAccess` | Whether "All files access" is granted |
| `getPickToken` | One-shot session token for the directory-picker bridge (validated by the engine-side pick endpoint) |
| `copyText` | Writes to the system clipboard (fallback when WebView `clipboard.writeText` is denied) |
| `getDevLogEnabled` / `setDevLogEnabled` | Dev-log switch fact (refuses optimistic reporting) |
| `getImmersiveMode` / `setImmersiveMode` | Immersive status bar (authoritative shell-side value) |
| `getOverlayEnabled` / `setOverlayEnabled` | Overlay toggle |
| `getScreenScope` / `setScreenScope` | Screen scope (virtual-only / real-only / all) |
| `getVdisplayScale` / `setVdisplayScale` | Virtual-display resolution scale |
| `getVdisplayFloatEnabled` / `setVdisplayFloatEnabled` | Auto floating window on background |
| `a11yStatus` | Accessibility control-channel status JSON |

**Browser workbench**

| Method | Purpose |
|---|---|
| `browserHostStatus` | Workbench status |
| `browserHostShow` | Open / reopen (including the zero-arg overload — the WebView bridge matches by actual arity) |
| `browserHostHide` / `browserHostClose` | Hide / close-and-destroy the current page |
| `browserHostReload` | Reload (implies `browserHostShow`) |
| `browserHostBounds` / `browserHostViewport` | Stage geometry / resolution (CSS viewport) |
| `browserHostIdentity` | Identity profile switch (PC / mobile), payload `{profile, ua}` |

**Virtual display**

| Method | Purpose |
|---|---|
| `vdisplayStatus` / `vdisplayCreate` / `vdisplayDestroy` | Status / create (idempotent) / destroy |
| `vdisplaySelect` | Select the presentation target (only owned virtual aliases are selectable) |
| `vdisplayBounds` | Publishes sidebar stage geometry (native cover-view alignment) |
| `forceDestroyVdisplay` | Force-destroys all virtual displays (same semantics as the settings section) |

**Commands**

| Method | Purpose |
|---|---|
| `pickDirectory` | SAF directory pick; the result returns asynchronously via `window.__dshBridge.onDirectoryPicked(callbackId, path)` |
| `openPathChooser` | Path picker (workspace / shared dirs) |
| `openNativePath` | "Open with another app" for a native path |
| `settingsPath` / `exportSettingsDocument` / `exportConfig` / `importConfig` | Settings-document import / export |
| `keepScreenOn` / `showNotification` | Keep screen on / notification test channel |
| `requestAllFilesAccess` | Opens the system "All files access" grant page (special permission) |
| `openA11ySettings` / `unlockRestrictedSettings` | Accessibility settings / one-tap unlock of restricted settings on Android 13+ |
| `restartEngine` / `shutdownToGuide` / `reloadWebUI` / `openConsole` | Engine and UI lifecycle |
| `incomingWorkspacePath` | Incoming-session workspace path |

## Tool surface (model-visible capabilities)

**Every AI-visible capability comes from a plugin**; the shell never registers tools directly. There
are currently 45 tools, disclosed progressively by capability group (call `android_capabilities`
first — only then do the tools appear in the list):

- **phone** (14): `android_ui_dump` / `android_ui_click` / `android_ui_input` / `android_ui_scroll` /
  `android_ui_tree` / `android_ui_detail` / `android_ui_global` / `android_screenshot` /
  `android_screen_list` / `android_app_launch` / `android_device_info` / `android_act_input` /
  `android_web_dump` / `android_env_prepare`
- **browser** (19): `browser_open` / `browser_snapshot` / `browser_click` / `browser_type` / … (17 more)
- **virtual-display** (3): `android_vdisplay_create` / `android_vdisplay_destroy` / `android_vdisplay_status`
- plus bridge (4), model-capability (2), linux-env (2), file-open (1)

**Cross-screen usage**: any tool that accepts `screenId` runs on a virtual display when passed
`"virtual-N"` (`android_screen_list` lists the current aliases and scope); the default `real` means
the physical screen.

## Permissions

| Permission | Purpose |
|---|---|
| `INTERNET` | WebView + engine probe + APK self-update (manual trigger only) |
| `POST_NOTIFICATIONS` | Notification channel (runtime request on API 33+) |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | Keep-alive foreground service |
| `MANAGE_EXTERNAL_STORAGE` | "All files access" (required for external workspaces; special permission, granted manually) |
| `REQUEST_INSTALL_PACKAGES` | Launches the system installer for a downloaded update (the user must grant it explicitly) |

SAF directory and image picking need no permission. Virtual displays and privileged shell require the
user to install, start and authorize **Shizuku**.

## Version history

The full version history lives in [`docs/AGENTS/changelog-archive.md`](docs/AGENTS/changelog-archive.md)
(reverse chronological, newest first). The development map and pitfall library are in
[`AGENTS.md`](AGENTS.md) and [`docs/AGENTS/gotchas.md`](docs/AGENTS/gotchas.md).

## License

MIT. Third-party components under their own licenses (see the dependency notices). GPL compliance:
the full copyleft text ships in three forms — snapshot `usr/share/LICENSES/`, repo `LICENSES/`, and
APK `assets/licenses/`.

## Thanks and invitation

**Thanks to every community member for the feedback and contributions!** Special thanks to cdwlll
(environment reports), haitunlang (MIUI12 compatibility), TACONailoong (legacy WebView compatibility
approach), X-SCI-TECH (PR contribution), Yangerwei (file race feedback), gr12-cmd (armv7l request),
and cmyfqwq (in-place upgrade feedback).

**Developers are very welcome to join**: issues, PRs, suggestions and improvements are all
appreciated. What we especially need: Android compatibility testing (vendor WebViews such as Huawei /
Honor / Xiaomi), support for more devices (armv7l), Shizuku channel work, and plugin-ecosystem
expansion. Development and maintenance conventions live in each repository's `AGENTS.md`.

## Join the user group

<img src="qrcode/qqcommunity-1.png" alt="dsh-mobile user group QR code (group no. 1109493992)" width="320">
<img src="qrcode/qqcommunity-2.png" alt="dsh-mobile user group 2 QR code (group no. 1038381236)" width="320">

Join the dsh-mobile user group for feedback: usage questions, device compatibility and feature
requests are all welcome there. If group 1 is full, scan the group 2 QR code above (group no. 1038381236).


## Support us / 支持我们

请在个人生活有余力且经济自主的前提下进行适当的自愿赞助

Please consider a modest, voluntary donation only if you have room in your personal budget and are financially independent.

<img src="qrcode/support-wechat.png" alt="WeChat appreciation code" width="320">
<img src="qrcode/support-alipay.png" alt="Alipay payment code" width="320">
