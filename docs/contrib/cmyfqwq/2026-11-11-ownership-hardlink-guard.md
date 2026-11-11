# Ownership Repair Must Not Disable Itself On Vendor ROMs

## Problem

`OwnershipRepair.repair` rejected the whole run unless `/proc/sys/fs/protected_hardlinks` read `1`.
Several vendor kernels ship it as `0`. Measured on the released build (v0.14.11, OnePlus PLR110 /
ColorOS 16 / Android 16, app root granted, APatch): the startup self-heal returned

    {"ok":false,"checked":0,"healed":0,"code":"hardlink-protection-unavailable"}

after one second, having inspected zero entries. The residual root-owned backup stayed in the profile
directory, so the next snapshot refresh died as `snapshot-refresh-unclassified` with a bare
`AccessDeniedException`, and the engine never started.

The kill switch is redundant. `OwnershipRepairCore` already requires `linkCount == 1` for every
regular file and re-checks the inode identity and link count immediately before and after `fchown`
(`safeLinks`, `visit`); another root writer is outside this primitive's trust boundary by design.
Treating a sysctl as a precondition therefore only means: on vendor ROMs where it is `0`, ownership
repair is permanently disabled.

A second gap hid the failure. Forcing the sysctl to `1` on the same device produced
`{"ok":false,"checked":0,"code":"anchor-open-failed"}` — with no errno, because the handler discarded
the exception. Every cause (EACCES, ENOTDIR, ELOOP) collapsed into one opaque string.

## Change

- `OwnershipRepair.repair` no longer returns early when kernel hardlink protection is off. Per-entry
  `linkCount` checking is unchanged; the probe result is reported as `hardlinkProtection` so the
  difference between devices stays visible.
- Anchor open failures keep the underlying message as `anchor-open-failed:<detail>`, bounded to 80
  characters, and fall back to the bare code when there is no message.

## Verification

- Reproduction above measured on the released build with the exact arguments the app passes
  (`CLASSPATH=<base.apk> /system/bin/app_process /system/bin RootRepairMain <uid> <dataDir> files 200000 20000`).
- `OwnershipRepairCoreTest`: anchor open failure carries the message; a message-less failure stays bare.
- `RootOwnershipTest`: guards that the self-disabling rejection is gone and the probe is reported.
- `check-kotlin-comments.mjs`, `check-code-map.mjs`: passed.
- The patched build was not installed on a device; device validation is pending.
