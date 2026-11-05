# Snapshot Gate Negative-Control Regression

The snapshot injector deliberately leaves `headless-bad` untouched so its invalid startup patch remains a negative control. The package consistency gate nevertheless compared that profile's stale `dsh-shell-termux` payload with the current built package, causing valid Fast and release snapshots to fail after the package output changed.

The gate now compares plugin payloads only in the assembled `web` and `headless` profiles. It still rejects package mismatches in either assembled profile and still rejects a `headless-bad` patch that has been replaced with the authoritative patch.

`python scripts/ci-verify-snapshot.py --self-test` builds synthetic snapshots for the positive case and controlled negative cases covering assembly mismatches, fixture overwrite, and sourcemap rejection. The script is mirrored build input; the coordinator counterpart must receive the same change after this repository change lands. No APK device validation is needed for this build-gate-only change.
