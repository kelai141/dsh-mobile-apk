# Release variant: configurable, regression-tested, documented

## Context

Issue #1118 / PR #1126 already switched the shared terminal engine `scripts/build-apk-engine.mjs` from `:app:assembleDebug` to `:app:assembleRelease`. The reason was that `app/build.gradle.kts` gives debug and release the same `signingConfigs.repoDebug`, so the shipped artifact was a debug variant with a fully correct signature: `aapt2 dump badging` on the 0.14.9 release APK contains `application-debuggable` while the signature gate stayed green.

That switch left three gaps, which this change closes. It does not repeat the variant switch.

## Gaps closed

**The variant was a literal, not a parameter.** `assembleApk()` derived the Gradle task, the stale-output directory it clears, and the artifact path it copies from three separate hard-coded `release` literals. Changing the variant meant editing three places, and a missed one would not fail loudly: it would clear directory A and then read the artifact from directory B, which reads as success. Now one `buildType` option (default `release`, allowed set `['release', 'debug']`) feeds all three, and an unknown value throws before Gradle runs instead of surfacing after a full build as "Gradle succeeded but APK is missing". `debug` stays selectable because the negative-control test needs to ask for it, and because a future `official`-style type must be addable without rewriting the function.

**No regression test could catch a flip back.** A build type that silently reverted to `debug` would deliver a debuggable artifact. `scripts/build-apk-engine.test.mjs` now runs the same assemble + verify stage twice, changing only `buildType`, and asserts that the `debug` run is aborted by the form gate while the `release` run passes. The red verdict is not a hand-written mock: it is the result of the form gate's own `evaluateBadging()`, so the test and production share one judgement.

**The docs still described the old variant.** `docs/AGENTS/EXECUTION-MAP.md` had six `:app:assembleDebug` descriptions left over (the shared-stage paragraph, the `build-apk-013.ps1` coordinate, two mermaid nodes, the "who gets control next" line, and the per-ABI step list). All six are corrected; the `build-apk-013.ps1` coordinate was also wrong in a second way, since that script does not call Gradle for packaging at all — it hands the snapshot to the engine. `docs/AGENTS/build-and-env.md` gained a paragraph on the variant split and its Gradle example now reflects what the chain actually runs.

`scripts/build-apk-dev-fast.mjs` deliberately keeps `:app:assembleDebug`. It is the fast local iteration path and its artifact is `application-debuggable` by design, which is exactly what `check-apk-form.mjs` rejects. Its header now says so, so the difference is not mistaken for a missed edit later.

## Evidence

- Real release build through `build-apk-engine.mjs assemble` in this worktree: BUILD SUCCESSFUL, artifact `dsh-mobile-apk-v0.14.9-x86_64.apk`.
- That artifact: `aapt2 dump badging` has zero `application-debuggable` lines; `apksigner verify --verbose --print-certs --min-sdk-version 18` reports v1/v2/v3 all true with certificate `1dde9d98...` (same key as the published packages).
- `check-apk-form.mjs --require`: PASS on the release artifact, FAIL on the real debug artifact `out/v0.14.9/dsh-mobile-apk-v0.14.9-arm64.apk`.

## Not verified

No device install on a Chinese ROM was repeated. Device-side evidence for the release variant comes from the earlier MuMu (x86_64) run: overwrite install succeeded, DEBUGGABLE disappeared from pkgFlags, engine and plugins all started, zero logcat crashes. This change adds no device validation of its own.
