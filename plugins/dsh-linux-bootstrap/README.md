# @dsh-android/linux-bootstrap

The **experimental**, opt-in entry point for the DSH Mobile Linux environment. It
is deliberately small: it discovers releases, verifies the runtime package before
staging it, and exposes status/actions to the mobile settings client. Its version
is independent of the DSH Mobile app version.

Both plugins in this system are **our own experimental internal plugins**:

* The bootstrap is distributed with the app in the built-in (hard) plugin
  directory, but it is **not enabled by default** — presence is not activation.
  It is not mounted in the Cordis profile either: the host loads it only once the
  user explicitly enables the Linux environment (see `docs/DECISIONS.md` D-014).
* The runtime plugin, Bionilux, the rootfs and the shared glibc Node are **not**
  distributed with the app: they are fetched on demand from a versioned Release.
* Installing a new DSH Mobile APK or publishing a new Linux release never enables
  a plugin, and never re-enables one the user turned off.
* The Linux environment only becomes usable after the user explicitly enables the
  system and confirms an install.

## Engine plugin

```js
import linuxBootstrap from '@dsh-android/linux-bootstrap'

ctx.plugin(linuxBootstrap, {
  dataDir,                 // required: <filesDir>/linux-environment
  releaseUrl,              // required: GitHub repo or /releases/latest API URL
  pluginHost,              // required: linuxPluginHost {install, uninstall, isInjected}
  downloadAsset,           // required: checksum-verifying downloader
  extractArchive,          // required: safe extractor (no shell tar)
  appVersionProvider,      // DSH Mobile version (function, getVersion(), or string)
  managerProvider,         // optional: build the manager after the runtime plugin loads
  arch,                    // optional: 'arm64' or 'x64'; defaults to process.arch
})
```

`apply(ctx, config)` publishes the service as `ctx.provide('linuxBootstrap', service)`
and returns it.

### Architecture and runtime defaults

The host architecture comes from the explicit arch option, or from process.arch
when it is omitted. Only arm64 and x64 are accepted; any other host architecture
raises an explicit error rather than guessing.

The canonical runtime IDs are:

| Host | Default runtime ID |
|---|---|
| arm64 | debian-minimal |
| x64 | debian-minimal-x64 |

status() reports architecture, defaultRuntimeId, runtimeId and only the runtimes
available for this host. An install, reinstall or automatic update without an
explicit ID selects that architecture's canonical ID. An explicit ID that
belongs to another architecture is rejected before host activation, and a
manifest without a runtime for this architecture fails closed instead of
falling back to another architecture. A manifest must use unique IDs. Custom IDs
remain valid when explicitly selected; an omitted ID requires the host's default
to be present. The historical `DEFAULT_RUNTIME_ID` export remains an ARM64-only
compatibility constant; new callers should use `defaultRuntimeIdForArch()`.

### Required IO

* `downloadAsset(asset, { destination, fetchImpl })` writes bytes to
  `destination` (or returns bytes/path). Whatever it does, the bootstrap
  re-hashes the file and requires the manifest's exact `sha256` and `size` before
  anything is extracted.
* `extractArchive(archivePath, destination, { kind, safe, stripComponents })` must
  reject absolute paths, `..` traversal and symlinks escaping `destination`.
  The runtime package is rejected if it does not contain
  `package.json` named `@dsh-android/linux-runtime` with a safe `lib/index.js`.
* When the host has already fetched and extracted the bundle itself — the shipped
  arrangement, where the settings client triggers the host and `.tar.xz` is
  decoded host-side (see `docs/DECISIONS.md` D-015) — both hooks may be
  pass-through. Nothing is trusted on that basis: the bootstrap re-verifies the
  staged content against the manifest before it activates, so a reuse result is a
  verification outcome and never an assumption.

### Host adapter (`linuxPluginHost`)

* `install({ directory, entry, config, enable })` loads the verified runtime
  plugin directory as a Cordis scope and returns `{ manager, rollback? }` (or the
  manager through `managerProvider`).
* `uninstall({ runtimeId, directory, rollback? })` disposes that scope.
* `isInjected({ name, runtimeId, directory })` returns `{ injected, active }` (or
  a boolean). This is the **authority** on whether the runtime plugin is still in
  the user's injection directory; only read-only queries are allowed.

`isInjected` is what keeps the "never resurrect" rule honest: if the user removes
the runtime plugin by hand, the bootstrap persists `enabled: false` /
`injectionActivated: false`, an automatic update then fails closed instead of
re-adding it, and only an explicit install can bring it back.

## Service API

| Method | Behaviour |
|---|---|
| `status()` | Current state object (see below). |
| `checkForUpdates({ source })` | `'manual'` always queries the release channel and **only reports**; `'mobile-version-change'` is the host-triggered automatic path. |
| `install({ runtimeId, confirmed, activate })` | Requires `confirmed: true` **and** `activate: true`; downloads, verifies, stages and activates. |
| `reinstall({ confirmed, activate })` | Same guarantees, forcing a re-stage of the pinned release. |
| `uninstall({ confirmed })` | Requires `confirmed: true`; removes the runtime and the plugin scope. |
| `setAutoUpdateEnabled(boolean)` | Persists the user's preference. It never triggers a check by itself. |
| `syncInjectionState()` | Re-reads the host's injection view and persists the result. |
| `subscribe(listener)` | Status stream; returns an unsubscribe function. |

`status()` exposes `installed`, `version`, `mobileVersion`,
`installedSystemMobileVersion`, `autoUpdate`, `availableVersion`,
`updateAvailable`, `updateBlocked`, `busy`, `operation`, `runtime`,
`injectionActivated`, `enabled`, `pluginReleaseUrls`, `lastCheckAt` and `error`.

The status object also includes architecture, defaultRuntimeId, runtimeId and
the host-architecture runtimes list.

## Update policy

* Automatic updating is **off** until the user turns it on (`autoUpdateEnabled`
  defaults to `false`).
* An automatic check runs only when all of these hold: a runtime is installed,
  the plugin is still injected, the user enabled auto-update, and the current
  **DSH Mobile app version differs** from the app version recorded when the
  runtime was installed or last updated.
* Each changed app version is checked at most once; toggling the preference,
  restarting the app, regaining network, or a new release alone never triggers a
  check.
* A newer Linux release is installed automatically in that case; an equal or
  older one is not reinstalled (downgrades are blocked).
* A manual check is never downgraded to an install: it reports
  `updateAvailable`, and the user confirms the install separately.

## Routes (for the shell adapter)

The package exports `LINUX_ENVIRONMENT_ROUTES` and `createRouteHandlers(service)`
so the Android shell can expose its existing authenticated route style without
re-implementing the transaction:

`GET /api/android/linux-environment/status`, `POST …/check`,
`POST …/install`, `POST …/reinstall`, `POST …/uninstall`,
`POST …/auto-update-on`, `POST …/auto-update-off`.

Mutating actions require `{"confirmed": true}` in the body.

`POST …/auto-check` (source `mobile-version-change`) is provided as an **optional**
convenience: a host that triggers the automatic check when the `linuxBootstrap`
service becomes ready calls `checkForUpdates({ source: 'mobile-version-change' })`
directly and needs no route. Do not expose both paths; the duplicate would be a
dead surface.

## Mobile settings client

`@dsh-android/linux-bootstrap/client` registers the `settings.section` slot with
id `linux-environment` and label `Linux环境`. The section states up front that
the plugin is experimental and disabled by default, shows the installed/available
versions and the app-version baseline, offers the persisted 自动更新 toggle and
手动检查更新, install/reinstall/uninstall (each with an explicit confirmation), and
links to both plugin Release pages from the manifest.

## Verification status

Package-level behaviour is covered by `node --test` (manifest shape, checksum
rejection before activation, opt-in activation, per-app-version dedup,
manual-check isolation, never-resurrect after manual removal, rollback, and the
cutover/abort semantics of the runtime manager). Real-device installation, the
Android `isInjected` implementation and the guest DNS path are tracked as open
integration items rather than asserted here.
