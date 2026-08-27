# dsh-undo-savepoint — Undo/rollback system for DSH

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml/badge.svg)](https://github.com/lire1131/dsh-undo-savepoint/actions/workflows/ci.yml)

> English | [中文](README.md) | [Changelog](CHANGELOG.en.md)

**DSH crash-rescue plugin: undo config & plugin-code changes, secret-safe snapshots, one-click SAFE MODE, plus offline CLI/GUI that work even when DSH won't boot.**

An undo/rollback system for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): **every plugin install, skin switch or settings change is auto-snapshotted; manual saves whenever you want; one-click undo / redo / restore to any version** — plus offline CLI & GUI tools that still work even when DSH fails to boot.

## Preview

| v0.3.5 conversation header: iconized Undo / Redo / Snapshots buttons + auto-snapshot status badge (click the badge to open the panel) |
|---|
| ![header](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/webui-header.png) |

| WebUI snapshot manager (diff / restore / delete / clean-up / export / import / SAFE MODE) | WebUI Settings — own "Snapshots" section (sensitive mode / plugin whitelist / dir pickers) |
|---|---|
| ![panel](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/webui-panel.png) | ![settings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/webui-settings-section.png) |

| Offline GUI (two-row toolbar + SAFE MODE button; works when DSH is down) | Offline settings dialog (sensitive mode / Browse dirs) |
|---|---|
| ![gui](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/gui-main.png) | ![guisettings](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/gui-settings.png) |

| SAFE MODE confirmation (enter / exit) | SAFE MODE status notice |
|---|---|
| ![confirm](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/safe-mode-confirm.png) | ![done](https://cdn.jsdelivr.net/gh/lire1131/dsh-undo-savepoint@master/docs/safe-mode-done.png) |

## Features

| Capability | What it does |
|---|---|
| **Config + plugin-code rollback** | Snapshots cover config files AND user-plugin code trees — any broken edit is undoable (incl. pure code incidents like the whale-kit `yield*` crash); undo / redo / restore-to-any-version from WebUI, chat or offline CLI |
| **Secret redaction + local vault** | `.env` / credentials enter snapshots auto-redacted (structure preserved) — exported ZIPs are safe to share; real values live in a local vault, **local rollbacks restore them fully** |
| **One-click SAFE MODE** | When DSH cannot boot at all, temporarily disables every user plugin except the undo system so it always boots; auto-snapshots + config backup on entry, one-click exit (v0.3.7+: profile/home dual-level patches backed up & restored, empty-backup `[]` fallback, stale-state downgrade on home rebuild; **v0.3.8+: also neutralizes `dsh.profile.bundles` entries that would fail the boot loader's hard checks — original `package.json` backed up separately and fully restored on exit**) |
| **Crash attribution** | After an abnormal exit, names the concrete last-known-good snapshot with a one-click rollback button — no guessing (**v0.3.8+: classifies the crash by log signature — `session-corrupt` / `bundle-check` / `patch-tree` — and the banner suggests the matching remedy**) |
| **Session-file scan & repair** | `undo_scan` scans `<home>/sessions/**/session.jsonl.zstd`: single-frame layout violations (the 8/18 crash root cause) are recoded in place (original kept as `.bak` + quarantine copy) with triple verification; undecodable files are only isolated, never touched. Offline via `dsh-undo.ps1 scan [--fix]` (requires Node ≥22.15; degrades to a notice on Node 20) |
| **Safe cross-machine migration** | Restore preflights missing plugins and warns clearly; snapshots export/import as one-click ZIP (see [docs/migration.en.md](docs/migration.en.md)) |
| **Offline emergency kit** | CLI + GUI window + one-click desktop shortcut: undo / restore / SAFE MODE / crash banner / rollback log — everything works when DSH is down |

> Basic capabilities (keyboard shortcuts, chat commands, auto-cleanup, dual save modes, configurable options, …) are covered below and in the [Changelog](CHANGELOG.en.md).

## Crash rescue quick reference (pick by scenario)

| Scenario | Action |
|---|---|
| Config/plugin mount broken | Chat / WebUI / CLI: `undo` or `restore -Id <id>` |
| Plugin code broken | Same (snapshots include plugin code trees, one-click restore) |
| Last run crashed, unsure what to roll back to | WebUI / GUI banner shows the last-known-good snapshot, one-click rollback |
| **DSH will not boot at all** | Desktop "DSH Undo Manager" → **SAFE MODE** button (or CLI `safe-mode -Label on`) → restart DSH, it always boots |
| Crash banner says session damage | Chat / CLI: `undo_scan quarantine=true` (or offline `dsh-undo.ps1 scan --fix`) |
| Missing plugins after restore (cross-machine) | Preflight warning in the restore report; install first or use safe mode |
| "My config suddenly changed" | CLI `recent` / chat `undo_recent` check the rollback log |
| Rollback touched plugins/mounts | Report says "restart DSH for it to take effect" |

## What is snapshotted & where

The snapshot captures DSH's boot-critical config: `cordis.patch.yml`, `package.json`, `cordis.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (under the profile) + `cordis.patch.yml`, `settings.yaml`, `.env`, `.credentials.yaml` (under `$DSH_HOME`, default `~/.dsh`).
When a restore touches `package.json` / `pnpm-lock.yaml`, the default behavior only reports that `node_modules` may be out of sync. To rebuild dependencies, pass `-SyncDeps` (offline CLI), `sync_deps: true` (chat tool), or `syncDeps: true` (REST); the plugin runs `pnpm install --frozen-lockfile` (plain `pnpm install` when there is no lockfile). A failed install leaves the restored config files in place.

| Store | Default path (configurable in settings) | Contents |
|---|---|---|
| Manual store | `<snapshot root>\manual\` | Manual snapshots (never auto-pruned) |
| Auto store | `<snapshot root>\auto\` | Auto snapshots, boot baselines, undo pre-restore snapshots (auto keeps latest 20) |
| Legacy store | `<snapshot root>\` root | Old flat layout — still read, auto-migrated on startup |

> ⚠️ Snapshots contain copies of `.env` etc. which may include secrets — do not share or push them.

## Multi-profile support (v0.3.3)

The plugin detects the active DSH profile from the launch arguments (`dsh --profile mine` / `--profile=mine`; `dsh web` falls back to `web`) and works per profile:

- **Config directory**: defaults to `$DSH_HOME/profiles/<current profile>` (DSH_HOME defaults to `~/.dsh`; previously hardcoded to `web` — under any other profile snapshots read the wrong files, the watcher missed changes, and restores wrote to the wrong place);
- **Snapshot stores**: default to `<snapshot root>/<current profile>/{auto,manual}` (per-profile isolation); if the scoped dir does not exist but the old flat store does, the flat store is used so legacy snapshots are never hidden;
- **Provenance**: the manifest records a `profile` field and `undo_list` shows the current profile.

Offline CLI/GUI cannot see the launch arguments — set the `DSH_UNDO_PROFILE` environment variable or `profileName` in settings (default `web`).

Explicit configuration always wins: `profileDir` / `manualDir` / `autoDir` / `profileName` (config or settings).

## Custom DSH home support (v0.3.5, issue #6)

The DSH data-home resolution matches the official launcher (`@deepseek-ai/dsh-home-paths`) exactly: **`$DSH_HOME` wins** (blank = unset; `~` / `~/` / `~\` prefixes supported), otherwise it falls back to `<user home>\.dsh`. The settings file (`$DSH_HOME\undo\settings.json`), default snapshot root (`$DSH_HOME\undo-snapshots`), profile dir (`$DSH_HOME\profiles\<profile>`), home root and plugin-discovery paths are all derived from it — third-party clients with a custom `DSH_HOME` no longer suffer the "two homes" split (settings written to `~/.dsh` while DSH actually uses `$DSH_HOME`), and custom directories survive restarts.

Explicit overrides are preserved: `DSH_UNDO_SETTINGS` / `DSH_UNDO_ROOT` / `DSH_UNDO_EXPORT` (env vars) and the config keys `homeDir` / `profileDir` / `manualDir` / `autoDir` keep the highest precedence.

## Repository topics

So the repository is easier to find on GitHub search & Explore, these topics are set on the repo:

`deepseek-harness` · `dsh` · `dsh-plugin` · `undo` · `rollback` · `snapshot` · `crash-recovery` · `backup` · `windows` · `powershell`

## Installation

Prerequisites: DSH (`@deepseek-ai/dsh`) and Node.js (≥20).

**Option A (GitHub direct)** — install the latest master commit:

```bat
dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master
```

Restart DSH after installing. Snapshot directories and options are configurable in Settings.

**Option B (local source / pre-release)** — clone and mount manually:

1. **Clone the repository** into a local plugins directory (an ASCII path is safer), e.g. `D:\dsh\plugins\dsh-undo-savepoint`:

```bat
git clone https://github.com/lire1131/dsh-undo-savepoint.git D:\dsh\plugins\dsh-undo-savepoint
```

2. **Create a junction** so DSH's module resolver can find the local package by name `dsh-undo-savepoint` (used by both the host plugin and the WebUI client plugin):

```bat
mklink /J "<your-dsh-install>\node_modules\dsh-undo-savepoint" "D:\dsh\plugins\dsh-undo-savepoint"
```

> DSH resolves package names by walking up from its own `node_modules`. The default location is `C:\Users\<username>\node_modules` when npm installed into the user directory; if you run DSH from an npx cache, junction into that cache's `node_modules` instead. Check the path in DSH's startup error output or run `npm root -g`.

3. **Mount it in the profile patch layer**: edit `<DSH_HOME>\profiles\web\cordis.patch.yml` and append:

```yaml
- insert:
    - id: dsh-undo-savepoint
      name: dsh-undo-savepoint
```

4. **Activate**: saving hot-reloads the host part; refresh the page to see the header buttons and settings rows; restart DSH for full steady state (legacy flat snapshots migrate automatically).

> Dependency note: the host plugin loads `@deepseek-ai/dsh-tools` via `createRequire('<dsh-install-root>/package.json')`. If DSH lives elsewhere, set the environment variable `DSH_ROOT=<dsh-install-root>` — no extra package installation needed.

## Where are the external tools? ("I installed it and cannot find it")

The external undo tools (GUI window + CLI) are **not placed on the desktop** — they ship inside the plugin install directory:

| Install method | Tool location |
|---|---|
| Method A: `dsh plugin add` | `$DSH_HOME\profiles\web\node_modules\dsh-undo-savepoint\tools\` (DSH_HOME defaults to `%USERPROFILE%\.dsh`) |
| Method B: clone + junction | your clone `...\dsh-undo-savepoint\tools\` |

**One-click desktop shortcut (recommended — open the tools straight from the desktop afterwards):**

Double-click `tools\make-desktop-shortcut.bat` (it auto-locates the plugin directory) and a **DSH Undo Manager** icon appears on the desktop;
or copy the whole block below into a PowerShell window and press Enter (no need to locate any file first):

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
$d = @("$dshHome\profiles\web\node_modules\dsh-undo-savepoint", "$dshHome\profiles\node_modules\dsh-undo-savepoint", "$env:USERPROFILE\node_modules\dsh-undo-savepoint") | Where-Object { Test-Path (Join-Path $_ 'tools\dsh-undo-savepoint-gui.bat') } | Select-Object -First 1
if ($d) {
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Undo Manager.lnk'))
  $s.TargetPath = Join-Path $d 'tools\dsh-undo-savepoint-gui.bat'
  $s.WorkingDirectory = Join-Path $d 'tools'
  $s.Save()
  Write-Host "Desktop shortcut created: $($s.FullName)"
} else { Write-Host 'Plugin directory not found — install it first: dsh plugin --profile web add github:lire1131/dsh-undo-savepoint#master' }
```

**Just want to open the tools folder:**

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
explorer "$dshHome\profiles\web\node_modules\dsh-undo-savepoint\tools"
```

After that, double-click the desktop **DSH Undo Manager** icon to open the external tools (they work even when DSH itself fails to boot).

## Usage

- **Undo**: header **Undo** button / `Ctrl+Alt+Z` / tell the AI "undo the last step".
- **Redo**: **Redo** button / `Ctrl+Alt+Y` (only when nothing changed since the undo).
- **Manual save**: "Save" in the panel / tell the AI "save a snapshot" / CLI `snapshot`.
- **Restore to a fixed version**: click "Restore to this" on a row in the panel; or tell the AI "restore to <id>"; or CLI `restore -Id <id>`.
- **Delete a snapshot**: "Delete" in the panel; or CLI `remove -Id <id>`.
- **Custom shortcuts**: Settings → General → Undo/Redo shortcut (click the box then press a combo; Backspace clears).
- **Save options**: Settings → General → Snapshot Settings (auto-save toggle, debounce, keep count, two directories; the 📁 button opens the native folder picker).

### Offline tools (works even when DSH won't boot)

> GUI language: the manager window follows the system UI language (zh/en); force it with `DSH_UNDO_LANG=zh|en`.

From the repository directory:

```powershell
# GUI window (recommended): double-click tools\dsh-undo-savepoint-gui.bat, or:
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint-gui.ps1"

# CLI
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" list
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" snapshot -Label "reason"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" undo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" undo -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" redo
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" restore -Id <id> -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" restore -Id <id> -Force -SyncDeps
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" remove -Id <id>
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-undo-savepoint.ps1" prune -KeepAuto 20

# Safe plugin install (auto snapshots before/after; auto-rollback on failure)
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\dsh-plugin.ps1" add <package>
```

Typical rescue scenario: **DSH fails to boot with something like `duplicate loader entry id`** → open "DSH Undo Manager", pick the snapshot from before the change → Restore → restart DSH. No reinstall, no lost sessions.

## REST API (backend of the WebUI)

| Endpoint | Description |
|---|---|
| `GET /api/undo/status` | `{canUndo, canRedo, total}` |
| `GET /api/undo/list` | Snapshot list (with location: manual/auto/legacy) |
| `GET/POST /api/undo/settings` | Read/write save options (auto-save, debounce, keep count, dirs); POST applies immediately |
| `POST /api/undo/undo` | Undo the last change; optional body `{syncDeps: true}` rebuilds `node_modules` from the restored lockfile |
| `POST /api/undo/redo` | Redo the last undo; optional body `{syncDeps: true}` |
| `POST /api/undo/restore` | body `{id, syncDeps?}` — restore to a fixed version |
| `POST /api/undo/remove` | body `{id}` — delete a snapshot |
| `POST /api/undo/snapshot` | body `{reason}` — manual save |
| `POST /api/undo/pick-dir` | Open the native folder picker, return the chosen path |

## Design notes

- **Undo semantics**: auto snapshots are taken *after* a change, so "restoring the newest snapshot" would be a no-op; real undo restores the newest snapshot whose state **differs** from the current one. When everything matches, a clear "nothing to undo" message is shown instead of pretending.
- **Undo can never undo itself**: after restoring `cordis.patch.yml`, the plugin re-ensures its own mount entry automatically.
- **Auto-archiving never sabotages undo**: the watcher records content hashes of what a restore wrote, so the restore's own file changes are not auto-snapshotted (which would block redo); real changes are snapshotted as usual.
- **Format parity**: the Node plugin and the PowerShell tools share the same snapshot stores and manifest format; compatible with both Windows PowerShell 5.1 and PowerShell 7.

## Development

- Dependency resolution: the host plugin loads `@deepseek-ai/dsh-tools` via `createRequire(<dsh-install-root>/package.json)` (override with `DSH_ROOT`), no in-repo dependencies required.
- Tests (no DSH needed; run in the repository directory):

```bat
node tools\smoke-test.mjs     :: 174 logic tests (snapshot/undo/redo/store split/no-change hint)
node tools\e2e-watch.mjs      :: 10 real-timing regressions (auto-save/undo-no-harm/redo)
```
