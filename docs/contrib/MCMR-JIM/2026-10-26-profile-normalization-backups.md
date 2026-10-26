# Durable profile normalization backups

**An existing backup path is not evidence of a complete rollback copy (#608).** Normalization skipped backup creation for directories and partial historical files, then changed the live profile. ProfilePatchPublication now creates a unique per-attempt file, writes the exact prior text and synchronizes it before atomic publication. Historical artifacts remain untouched and cannot stand in for this attempt. Six filesystem regressions cover successful publication, historical directories/partial files, rejected publication, per-attempt ownership and validation failure.

## Verification

All six filesystem regressions pass. Restoring historical-backup reuse fails three cases. All three production Android migration cases pass, including historical directories and incomplete backups. The focused JVM suite passes 87 cases without failures or skips; the integrated APK passes all 1,842 Kotlin tests.

On Android 15 with WebView 124, the complete focused device suite passes all 64 cases across 13 classes. Browser lifecycle and panel CDP regressions pass; WebView verification passes all 39 checks in each orientation. ADB interaction in portrait and landscape completes file creation, reading and cleanup through the visible console, with screenshots and CDP output confirming the results. The tested APK contains the identical normalization implementation from this branch.
