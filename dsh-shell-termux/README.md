# dsh-shell-termux

[🌐 中文说明 / 中文 README](README.zh.md)

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）

Android/Termux bash capability provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Registers as `ctx.shell` on Android so the model's `bash` tool executes in a controlled Termux
environment — no fake sandboxing, no dependency on the ambient environment being accidentally right.

## Why

On Android the upstream `bash-sandbox` fails closed (no bwrap/landlock/seatbelt platform chain),
so the bash tool is dead out of the box. This provider replaces it with an honest Termux execution
world: explicit environment injection, probe diagnostics, and a declared app-domain sandbox
semantics (`workspace-write` + `enforcement: 'partial'`).

## Quick start

**Prerequisite**: a Termux installation with `bash` (`pkg install bash`).

**1. Install** — put the package into the profile's node_modules (healed fallback resolves its
`@deepseek-ai/*` dependencies to the running dsh instance):

```sh
# from the profile directory (~/.dsh/profiles/web)
npm install /path/to/dsh-shell-termux-0.1.0.tgz
# or manually: unpack into <profile>/node_modules/@dsh-android/dsh-shell-termux/
```

**2. Mount** — add to the profile's `cordis.patch.yml`:

```yaml
- id: bash-sandbox
  disabled: true
- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      config:
        bashPath: /data/data/com.termux/files/usr/bin/bash
        prefix: /data/data/com.termux/files/usr
        home: /data/data/com.termux/files/home
        cwd: /data/data/com.termux/files/home
        timeoutMs: 120000
        maxTimeoutMs: 600000
```

**3. Restart** the dsh service and verify with `--dump-config` (the row must be present, not disabled).

## Configuration

| key | meaning | default |
|---|---|---|
| `bashPath` | absolute bash binary path | required |
| `prefix` | Termux prefix root (contains bin/ lib/) | required |
| `home` | Termux home directory | required |
| `termuxVersion` | TERMUX_VERSION value injected | `0.118.3` |
| `extraPath` | extra PATH entries prepended (e.g. /system/bin) | `[]` |
| `cwd` / `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` | inherited local-executor knobs (editable via shell settings) | mirror `dsh-bash-local` |

## What it does

- **Controlled environment** — every spawn injects `PATH`/`LD_LIBRARY_PATH`/`HOME`/`PREFIX`/`TERMUX_VERSION`/`SHELL`
  explicitly; execution never depends on the launcher environment.
- **Reuses local mechanics** — extends `LocalBashExecutor` (`runArgv`/`startArgv`): process-group
  SIGTERM→SIGKILL, output caps + spill, grace period, background lifecycle, teardown ownership.
- **Honest sandbox declaration** — `sandboxMode = 'workspace-write'` (so permission presets mount)
  with per-process `enforcement: 'partial'`: the protection boundary is the Android app domain
  (SELinux u0_aXXX) plus the approval flow, not a path-level confiner.
- **Probe diagnostics** — `probe()` reports bash presence/version and missing toolchain packages
  (`pkg install bash coreutils findutils grep ripgrep` hints). Misconfigured bash fails loud with
  repair guidance.

## Verification

- `probe()` status: `full` / `partial` / `unusable` with a missing-package list;
- fault injection: point `bashPath` at a missing binary → structured error
  (`shell-termux: <path> is not executable; run 'pkg install bash' …`) returned to the model.

## License

MIT. Contains code derived from `@deepseek-ai/dsh-bash-local` (MIT, © 2026 DeepSeek) — see NOTICE.
Design rationale: `docs/design.md`.
