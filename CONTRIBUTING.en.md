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

## Device acceptance

A UI, shell-behavior or security-sensitive change must carry a device-acceptance section **in the PR body**. Use exactly one of the two states below; leave it empty or write both and the review is rejected. The state block is a fact recorded in the body — writing it needs no special permission.

### State A: acceptance was run

State the evidence and the verdict:

- Three evidence elements: **tree@sha** · **device serial** · **case name**; attach screenshots as a path or link;
- Verdict: `PASS`, or `FAIL` with a reason.

### State B: request acceptance

If you cannot run a device yourself, do not stop at "no device verification". Write a card someone else can execute:

- Device prerequisites: Android version / package (versionName or head sha) / permission state;
- Steps: 1. 2. 3. … — forward-looking and executable, down to the command or the tap target;
- Expected observable: concrete values, copy, log lines, controls that must appear;
- What failure looks like: counterexamples.

### Four rules

1. **All three evidence elements are mandatory** (tree@sha + device serial + case name): without the sha nobody knows which commit was verified.
2. **Expectations must be values or copy**, never "works", "fine" or "ok": such words cannot go red, so the expectation does not exist.
3. **The package version in the card must match what gets installed** (head sha or versionName): install a different build and the result proves nothing about this PR.
4. **On FAIL, commit on the same branch and force-push; do not open a new PR**: this keeps review and acceptance history together instead of splitting one change into unrelated threads.

### Who does what

| Role | Does | Permission needed |
|---|---|---|
| Contributor | Writes "State A (verified, with evidence)" or "State B (request acceptance, with forward steps / expectations / failure samples)" **in the PR body** | None |
| Maintainer | Reads the card, then applies `needs-device-verification` as an **internal scheduling marker** | triage |
| Acceptance specialist | Only handles labelled PRs; changes no code, does not merge, writes back `PASS`/`FAIL` and the raw output | None |

**The state block is the fact in the body; the label is only the maintainer's index.** Therefore:

- Contributors cannot apply labels and do not need to — putting your card in the body is enough;
- The other way round, **without a card the maintainer cannot schedule anything**: a PR with a label but no State B card is sent back for one;
- Maintainers add and remove the label; do not pester for it — writing a complete card is more useful than asking once more.

The specialist changes no code and does not merge; they only write back `PASS`/`FAIL` with the raw output (commands, key stdout, screenshot paths).

### A new commit invalidates the card

The card is bound to a sha. After you add a commit the old evidence no longer points at the current HEAD, so write a fresh State B card instead of reusing the previous verdict.

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

