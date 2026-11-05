## Evidence mismatch

The GitHub Releases API parser used to retain only each asset's name, URL, and byte length. GitHub provides the APK asset SHA-256 in `assets[].digest`, but dropping that value made the API fallback create an update with no digest. The shared artifact verifier accepted any file with the declared size when its digest was absent, so replacing the APK with different bytes of the same length still passed download reuse and the install-time recheck.

The verifier now requires a valid SHA-256 for every APK artifact. GitHub API parsing reads and validates the `sha256:<hex>` digest, and all release sources feed the same digest-bearing facts into update classification. Releases without a usable digest are rejected before download. Tests cover API digest parsing, missing and malformed digests, and same-size artifact replacement rejection.

Validation: focused JVM tests for `ApkArtifactCheckTest`, `ApkUpdateObserverTest`, `IndependentUpdateCheckerTest`, and `UpdateCheckerTest` pass (100 tests, 0 failures, 0 errors, 0 skipped); `node scripts/check-code-map.mjs` passes. No device validation was run.
