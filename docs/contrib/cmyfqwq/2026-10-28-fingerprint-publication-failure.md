# Fingerprint publication failure

## Symptom

The snapshot fingerprint writer used an atomic replacement helper, but still called `target.writeText()` when both move attempts failed. That fallback could truncate the old commit point and leave a partial fingerprint if the write itself failed.

## Root cause

The helper returned a Boolean while the caller treated `false` as permission to use a non-atomic overwrite. The snapshot transaction could not distinguish a successful commit from a failed publication.

## Fix

`AtomicFileReplace.writeText` writes a sibling temporary file and publishes it through the atomic replacement helper. A failed publish removes the temporary file and throws, so `EngineManager` enters its existing rollback path without modifying the previous fingerprint.

## Verification

- `AtomicFileReplaceTest.failedTextPublishPreservesTheOldTargetAndRemovesTheTemp` injects a failed publisher and verifies the old fingerprint is unchanged.
- The focused `AtomicFileReplaceTest` run passed.
- The full Kotlin suite passed: 1,899 tests across 176 classes. The generated baseline check passed with no skipped or missing classes.
- `SnapshotAtomicRecoveryTest.failedFingerprintPublicationPreservesTheCommitPoint` passed on an x86_64 emulator. It verifies failed publication preserves the prior fingerprint, removes the temporary file, and a subsequent real publication succeeds.
- The debug APK installed after its bundled snapshot fingerprint matched the installed fingerprint and the snapshot transaction marker was absent. The WebView check passed all 46 assertions, and ADB navigation returned to the main session composer with a captured screen.
- This is development validation, not release-candidate validation.
