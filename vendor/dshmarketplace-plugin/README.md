<p align="center">
  <img src=".github/assets/banner.jpg" alt="DSH Marketplace — install DeepSeek Harness plugins without leaving DSH" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dshmarketplace-plugin"><img src="https://img.shields.io/npm/v/dshmarketplace-plugin?style=flat-square&color=c0561d&labelColor=241f1a&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dshmarketplace-plugin"><img src="https://img.shields.io/npm/dm/dshmarketplace-plugin?style=flat-square&color=c0561d&labelColor=241f1a&label=downloads" alt="downloads"></a>
  <a href="https://github.com/DshMarketPlace/dsh-plugins-store/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/DshMarketPlace/dsh-plugins-store/test.yml?style=flat-square&color=c0561d&labelColor=241f1a&label=tests" alt="tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-c0561d?style=flat-square&labelColor=241f1a" alt="MIT"></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-community-c0561d?style=flat-square&labelColor=241f1a" alt="LINUX DO"></a>
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

Browse and install DeepSeek Harness plugins from inside DSH, in English or
Chinese. Backed by [DSH Marketplace](https://dshmarketplace.dev), which writes a
page per plugin rather than linking straight out to GitHub.

> The npm package is `dshmarketplace-plugin`; this repository is
> `dsh-plugins-store`. The names differ because the shorter one was taken.

## Install

```bash
dsh plugin --profile web add dshmarketplace-plugin
```

Then `/store` in any session, or **Settings → Plugins → Plugin store**.

`--profile` is not optional. `dsh plugin` forwards to pnpm inside a profile
directory, so `dsh plugin add x` exits with *required option '--profile
&lt;name&gt;' not specified* and installs nothing. Swap `web` for your profile if
you run another one.

## What it does

| | |
| --- | --- |
| **`/store`** | Opens the catalogue over the session — search by capability, see what each plugin reaches, install without leaving the harness. |
| **Settings tab** | The same catalogue, docked under Settings → Plugins. |
| **Agent tools** | `dshmarketplace_search` and `dshmarketplace_install`, so *"find me a memory plugin and set it up"* works in conversation. |
| **Bundled skill** | Teaches the agent to search rather than recall a plugin name from training data — for an ecosystem this young, a remembered name is usually wrong. |
| **Bilingual** | Every listing carries a hand-written English and Chinese description. The plugin follows your DSH language setting, live. |

## Safety

Plugins run with your agent's permissions, and a listing is not a security
review. Three things this plugin does about that.

**Install commands are validated, never interpolated.** The catalogue supplies a
command already built; `src/installer.js` accepts only a bare npm specifier or
`github:owner/repo`, refuses anything containing `..`, and passes arguments as an
array rather than through a shell. If the catalogue were ever compromised, the
blast radius stops there. `tests/installer.test.js` covers that boundary
specifically — writing it found a real hole, since `../../etc/passwd` is only
word characters, dots and slashes.

**The browser half cannot reach the shell.** It talks to two exact-path local
endpoints, and the install endpoint takes a catalogue entry rather than a
command, so the client cannot widen what runs.

**Risk flags gate both paths.** Listings carry detected `install script`,
`terminal surface` and `requires credentials` flags. Anything flagged stops for
an explicit confirmation, in the UI and on the agent path alike — and the
confirmation says plainly that an empty list would not have meant it was safe.

## Privacy

The plugin sends exactly one thing anywhere: after a successful install, the
plugin's public identifier, so install counts are real. No machine id, no
session id, no user, no query, no telemetry of any other kind. Searches go to
the public catalogue API in order to answer them and carry no identifiers.

```bash
DSHM_NO_TELEMETRY=1    # disables the install count entirely
DSHM_API=https://…     # point at a different catalogue
```

## Development

```bash
npm install
npm test         # the install-command boundary, and catalogue helpers
npm run build    # esbuild → lib/index.js (node) and lib/client.js (browser)
```

The browser bundle may only require `react` and
`@deepseek-ai/dsh-client-ui-primitives`, and must announce itself through
`window.__ModuleLoader__.load`. `build.mjs` enforces both against the emitted
code before writing it, so an unsupported import fails here instead of inside
someone else's harness.

## Related

- [dshmarketplace.dev](https://dshmarketplace.dev) — the catalogue, with a
  written page per plugin
- [`dshmarketplace-cli`](https://github.com/DshMarketPlace/dshmarketplace-cli) —
  the same catalogue for coding agents outside DSH
- `GET /api/v1/plugins` — the public API all three read

## Contact

- **Community** — [LINUX DO](https://linux.do)
- **Issues** — [GitHub Issues](https://github.com/DshMarketPlace/dsh-plugins-store/issues)

## Acknowledgements

- [**LINUX DO**](https://linux.do) — where the DSH ecosystem is actually being
  discussed, and where this project is published and takes its feedback.
  Plugins whose authors posted them there carry a verified badge in the
  catalogue.
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  (CC0-1.0) — the community registry the catalogue is seeded from.
- [ZASENJC/dsh-plugins-store](https://github.com/ZASENJC/dsh-plugins-store)
  (MIT) — reading its source is how the DSH client plugin API was worked out.
  No code was copied; the manifest shape, the two entry points and the slot
  names are public interface, and having them written down saved a lot of
  guessing.

## License

MIT. Independent project, not affiliated with DeepSeek. DeepSeek and DeepSeek
Harness are marks of their respective owner, used here only to describe what
this plugin is for.
