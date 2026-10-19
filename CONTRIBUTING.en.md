# Contributing

[中文版](CONTRIBUTING.md)

This repository is the Android shell for DeepSeek Harness. Read [`AGENTS.md`](AGENTS.md) first: it holds the project map, build commands, device acceptance rules and documentation protocol.

## Repository scope

- This repository owns shell Kotlin, the bridge protocol, accessibility and virtual display, the Shizuku channel, build gates and the release chain.
- Engine-side plugins, injection layers and snapshot configuration live in the private coordination repository `kelai141/dsh-mobile`. External contributors only need this repository; maintainers mirror coordination-side changes.
- Upstream `deepseek-harness` is read-only. Adapt through patches, plugins or the shell.

## Branches and commits

- The default branch is `main`. Never push to it directly; every change goes through a branch and a pull request.
- Name branches `<type>/<short-description>`; write commit messages as `<type>: <description>` with type from `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `ci`.
- One pull request contains one logical change that can be reverted on its own.

## Field notes

Do not pile every finding into one file. `docs/AGENTS/gotchas.md` is the shared summary maintained by merging stable conclusions; day-to-day notes live in your own file, named after your GitHub account:

```
docs/contrib/<github-account>/YYYY-MM-DD-<topic>.md
```

Write all four parts: symptom, root cause, fix, verification evidence. A note that only says what to do will not help the next person. Durable, general findings are merged into the matching document under `docs/AGENTS/`, keeping your original file and noting where it went.

## New interfaces must be bilingual

Not every user reads Chinese. Every **new** custom interface (page, panel, dialog, overlay, setting, notification channel name and description, error message, button, placeholder) ships in both Chinese and English:

- Page-side plugins use the existing locale channel: register `zh` and `en` dictionaries for one namespace with identical keys and placeholders.
- Native shell text in `strings.xml` or Kotlin needs an English counterpart.
- The interface updates when the language changes; do not cache strings read once at startup.
- Never show machine codes, internal keys or enum values. A Chinese-only interface is incomplete. Existing interfaces are not retrofitted by rule, but any block you rewrite or extend must be completed in both languages.

## Pull requests

Write the title and description in Chinese, or provide a Chinese and English version. Keep sentences short and readable. Describe the change, the reason, the verification and the scope. If you did not run on-device acceptance, say so explicitly. Fill in all four state-registration fields in the template, or write `none` with a reason.

Match evidence to risk:

| Change | Required evidence |
|---|---|
| Documentation, comments | Self-check passes; no build needed |
| Gates, build scripts | The gate's `--self-test` plus one controlled negative control |
| Security-sensitive areas (snapshot transactions, signing, gate predicates, bridge protocol) | Code, CDP and ADB user-level acceptance in the same round |
| UI and shell behavior | Emulator acceptance in all three layers, portrait and landscape |

Paste the command and the key output. If a test was not run, say it was not run.

## Self-review before pushing

Read the full diff, stage only the files that belong to the change (do not run `git add .`), and make sure these commands report nothing:

```powershell
git diff --check
git diff --stat
git status --short
git diff --cached --stat
```

No debug leftovers or local paths; no credentials or device serial numbers; new interfaces checked in Chinese and English; commit message matches the change; the verification in the pull request was actually run; the description reads cleanly; one to three labels set.

Delete the branch after merging.

