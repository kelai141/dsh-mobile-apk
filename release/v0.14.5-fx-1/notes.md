# v0.14.5-fx-1

This maintenance release addresses the open reports #340, #341, and #342. Issue #108 remains not planned and is not implemented by this release.

## Changes

- **#341 Browser sidebar rendering:** renew visible native overlay bounds while the presentation is mounted, recover drawing after foreground/lifecycle restoration, and rebind when the page replaces its stage element. The implementation does not reload the isolated page or clear browser data.
- **#342 Startup diagnostics:** show actionable messages for confirmed port conflicts and classified runtime/permission failures, keep unknown engine failures distinct, and offer an explicit retry action.
- **#340 Status bar insets:** consume the current system top inset on wide layouts across immersive-mode changes without fixed-height padding.
- Increment Android `versionCode` from 47 to 48 and set `versionName` to `0.14.5-fx-1`; existing app data remains in place on same-signature `install -r` upgrades.

## Validation status

The release workflow rebuilds both ABI snapshots, runs release gates, assembles both APKs, and verifies their signing schemes and certificate. These checks are performed by the workflow for this release and are not claimed here as already passed.

The MuMu test report confirms the #342 port-conflict recovery path and the tested subset of #340 immersive inset behavior. Full #341 isolated-WebView drawing validation remains inconclusive because the available MuMu WebView provider does not support the required multi-profile capability. Xiaomi Pad 7S Pro and OPPO OPD2601 device validation remains outstanding. See `docs/maintenance/0.14.5-fx-1/06-validation-report.md` in the coordination repository for exact commands and evidence.
