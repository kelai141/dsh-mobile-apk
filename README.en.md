# dsh-mobile-apk — AI Agent on your phone (DeepSeek Harness Android shell)

<!-- This file mirrors README.md section by section; change both in the same PR. 本文件与 README.md 逐节对应，改动请在同一 PR 内双语同步。 -->

[中文说明](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/kelai141/dsh-mobile-apk)](https://github.com/kelai141/dsh-mobile-apk/releases/latest)
![Android](https://img.shields.io/badge/Android-8.0%2B-3DDC84?logo=android&logoColor=white)
[![QQ群](https://img.shields.io/badge/QQ群-dsh--mobile用户群-12B7F5?logo=tencentqq)](https://qun.qq.com/universal-share/share?ac=1&authKey=C2NW5eWXsV%2FYu5DEkV9Ac%2FqYcXhGCY8C3Lga40KNCfE4AOjzlSeAaRGvWZqc3ADV&busi_data=eyJncm91cENvZGUiOiIxMTA5NDkzOTkyIiwidG9rZW4iOiJjTTRDM3pwNjRLTE8rbkZBVjRDbnFVWlBOdU04aGJaS3FaSG1xZWFXbm5ZNXphbEJBOXdGMGw2N0V3YnpabnhaIiwidWluIjoiMzc1NDY4MDE3NSJ9&data=NzUYIVyoUDsINSstug9aQ6Kf4EUx-hhDegPFaPS-1RD-p_4eE02WN773yEIujclrFYtWRDkLyDa-YDtWj2bKjg&svctype=4&tempid=h5_group_info)
[![QQ2群](https://img.shields.io/badge/QQ2群-dsh--mobile用户2群-12B7F5?logo=tencentqq)](qrcode/qqcommunity-2.png)

> **One APK, a complete AI agent: it can drive a browser and your phone, and actually runs bash — no root, no custom ROM.**

Android shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). App name `DeepCode`, package `com.dsharnessmobile.shell`.

> This project is open source under the MIT License. Forks, modifications, and redistribution are welcome. Contributions, suggestions, and feedback are appreciated.
> Judge AI-generated content and actions yourself; experimental features are labeled as such.

## What it can do

- **Real bash**: commands the AI runs actually execute in the built-in Termux environment — not simulated output.
- **Runs in the background, self-recovers**: lock the screen or switch apps and tasks keep running; the engine is watchdogged and relaunched when it wedges, and comes back on its own after a reboot. Background use drains more battery than an average app — allow "ignore battery optimizations" when the app guides you to.
- **AI browser** (experimental): the AI opens and drives web pages in a separate window whose cookies and logins are fully isolated from your daily browser — it never touches your accounts.
- **Virtual display** (experimental, needs Shizuku): the AI launches and operates third-party apps on a separate virtual screen without taking over yours, and you can watch it work in a floating window.
- **Phone control**: after you grant accessibility, the AI can read the screen and tap, swipe, type and screenshot for you on a real phone. By default only the virtual screen is allowed — touching the real screen requires you to widen the scope in settings.
- **Notification replies & approvals**: the AI's questions and approvals land in the notification shade; reply, pick options, approve or deny without switching back to the app (Android 13+ requires allowing notifications in system settings).
- **Floating bubble**: a desktop bubble shows live progress; expand the panel to answer the AI's questions and read task reports; triple-tap the status line to jump back into the app. Hide it any time.
- **Stable & self-healing**: a broken plugin that wrecks the page is auto-removed and the engine restarts within a minute; safe mode starts the app on a minimal setup for repair; startup failures get a repair assistant and a sanitized diagnostics bundle that is only sent when you tap share.

## Screenshots

| Home & chat | Split view & floating window |
|---|---|
| ![Home & chat](docs/images/ui-home.jpg) | ![Split view & floating window](docs/images/ui-split.jpg) |
| **Notification replies** | **Sidebar & session management** |
| ![Notification replies](docs/images/ui-notification.jpg) | ![Sidebar & session management](docs/images/ui-drawer.jpg) |

Screenshots come from real task runs.

## Quick start

| Item | Requirement |
|---|---|
| OS | Android 8.0 and above |
| Download size | about 150-160 MB, Wi-Fi recommended |
| Root | not required (optional Shizuku unlocks advanced device control) |

1. Download the APK matching your device (see next section): arm64 for phones, x86_64 for emulators.
2. Install and launch. The first launch (or an upgrade) may need a few to a dozen-plus minutes to extract/refresh the runtime — do not force-kill the app while it runs.
3. Grant permissions as guided in-app: accessibility, notifications, Shizuku.
4. Configure a model API in settings and run your first command.

Advanced install: `adb install -r -t <apk>` (same-signature in-place upgrade).

## Download & install

The latest version always lives at [GitHub Releases (latest)](https://github.com/kelai141/dsh-mobile-apk/releases/latest).
If GitHub is hard to reach, use the [official download page](https://kelai141.github.io/dsh-mobile-apk/) (auto-routes the official source and accelerated mirrors).

| Package | For |
|---|---|
| arm64 APK | most real devices |
| x86_64 APK | emulators / x86_64 devices |

**The ABI must match your device**: a mismatched package crashes the engine on start (CPU architecture mismatch). Pick by device type; if you picked wrong, just reinstall the right package.

**Stick to one channel for upgrades**: the app ships an in-app update check; if mixing channels breaks something, uninstall completely and reinstall before reporting.

Upgrades keep your sessions, settings and plugin configuration. If a runtime refresh is triggered it can take ten-plus minutes — do not force-kill the app.

## Permissions

| Permission | Purpose |
|---|---|
| Network | Loading AI chats, probing the local engine, checking for updates (manual trigger only) |
| Notifications | Notification replies and task alerts (Android 13 and above requires allowing it in system settings) |
| Foreground service | Keep-alive, so AI tasks keep running in the background |
| All files access | Needed for external workspace directories; you grant it manually in system settings |
| Install unknown apps | Launches the system installer for in-app updates; you must grant it explicitly |

Picking directories and images goes through the system pickers — no extra permission needed. Virtual displays and privileged actions require you to install, start and authorize [Shizuku](https://github.com/RikkaApps/Shizuku).

## FAQ

**Why is accessibility required?**
It is the data channel for the AI to see the screen and operate it; without it only the virtual screen works. By default the AI may only operate the virtual screen; touching the real screen requires you to widen the scope in settings.

**Killed in the background?**
Follow the in-app guide to whitelist the app from battery optimization; some aggressive vendor power-saving may still need a manual whitelist.

**Where do I report problems?**
Open a GitHub [issue](https://github.com/kelai141/dsh-mobile-apk/issues) with your device model, app version (see the About page) and reproduction steps; or join the user group below.

**Where does the model API come from?**
Pick the protocol and thinking level directly in the model entry in settings; the app ships with no model service.

**armv7l / older devices?**
Not supported yet — requests are welcome at the issue tracker.

## For developers

- **Build it yourself**: snapshots and packaging happen in the coordination repo [dsh-mobile](https://github.com/kelai141/dsh-mobile); this repository is the shell. Environment requirements: [`CONTRIBUTING.md`](CONTRIBUTING.md) and `docs/AGENTS/build-and-env.md`.
- **Bridge protocol** (`window.androidBridge`): see [`docs/AGENTS/BRIDGE-API.md`](docs/AGENTS/BRIDGE-API.md).
- **Model-visible tool surface**: see [`docs/AGENTS/modules.md`](docs/AGENTS/modules.md) (the current code is the authority).
- **Contributing**: see [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Version history**: see [`docs/AGENTS/changelog-archive.md`](docs/AGENTS/changelog-archive.md) (reverse chronological, newest first).

## Acknowledgements

This project is built together with its community. Below are the eight most active contributors, ordered by code contribution (the maintainer is not listed):

| # | Contributor | Main contributions |
|---|---|---|
| 1 | [@snoworwind](https://github.com/snoworwind) | Source-auditable ARM64 build chain, source-chain reproducibility fixes, snapshot panel layering and overlay fixes |
| 2 | [@cmyfqwq](https://github.com/cmyfqwq) | AI root authorization surface, root lease settlement and criteria, lock-splitting performance work |
| 3 | [@wen0531](https://github.com/wen0531) | In-snapshot git SHELL_PATH relocation, arm64 asset naming, file-write fallback, preset seeding fix |
| 4 | [@lemonhub-io](https://github.com/lemonhub-io) | App naming and icon, single-source version, launch and console UI rework, vendored-bundle language stats cleanup |
| 5 | [@SinBC227](https://github.com/SinBC227) | Image input and vision reading, clipboard bridge, LaTeX streaming render, font size and immersive status bar |
| 6 | [@Ni-ShuWu](https://github.com/Ni-ShuWu) | README badges, lock-splitting proposal for entry settlement |
| 7 | [@MCMR-JIM](https://github.com/MCMR-JIM) | Sidebar sorting and drag-drop fix, risk-tiered verification docs |
| 8 | [@adeahejshshsh](https://github.com/adeahejshshsh) | Language follow-system resolved at startup, settings row style alignment |

We also thank the early members who helped us pin down problems through issues and pull requests: cdwlll, haitunlang, TACONailoong, X-SCI-TECH, Yangerwei, gr12-cmd, and everyone who sent feedback and suggestions.

## Join the user group

<img src="qrcode/qqcommunity-1.png" alt="dsh-mobile user group QR code (group no. 1109493992)" width="320">
<img src="qrcode/qqcommunity-2.png" alt="dsh-mobile user group 2 QR code (group no. 1038381236)" width="320">

Usage questions, device compatibility and feature requests are all welcome in the group. If group 1 is full or will not let you in, scan the group 2 code above (group no. 1038381236).

## Support us

Please consider a modest, voluntary donation only if you have room in your personal budget and are financially independent.

- Third-party model API relay site (not owned by the developer; promotion only): <https://d1api.xin/sign-up?aff=mVa0>
- Third-party model API relay site (not owned by the developer; promotion only): <https://aiapi.keniis.top/sign-up?aff=v5GFqLPO>

WeChat & Alipay QR codes:

<img src="qrcode/support-wechat.png" alt="WeChat appreciation code" width="320">
<img src="qrcode/support-alipay.png" alt="Alipay payment code" width="320">

## License

MIT. Third-party components ship under their own licenses — see [`LICENSES/`](LICENSES) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). GPL compliance: the full copyleft text is present in three forms — snapshot `usr/share/LICENSES/`, repo `LICENSES/`, and APK `assets/licenses/`.
