# Profile backup attempt ownership

## Failure and cause

Timestamp names were opened with truncation. Two calls in the same millisecond overwrote the first rollback copy, and an existing file at the predicted name was modified. A clock rollback could also place the current attempt first in lexical order, so retention deleted the file being returned to the normalizer.

Retention accepted any regular-looking file with the version prefix and `.bak` suffix. That included UUID rollback copies and foreign names. The original UUID test used a random name that happened to sort after the tested timestamps, masking the deletion case. `File.isFile` also followed symbolic links despite the documented ownership rule.

## Repair

Allocate an exclusive `CREATE_NEW` channel with `NOFOLLOW_LINKS`. Advance beyond the greatest strictly parsed attempt sequence so repeated or backwards clock values cannot reuse or immediately evict the current attempt. Use locale-independent formatting, force the channel to disk, and verify the returned copy after retention. Manage only non-link regular files matching the complete 13-digit naming grammar. Serialize allocation and retention in the helper.

## Evidence

Five new JVM counterexamples all failed on the original implementation and passed after the repair. All thirteen existing backup cases also passed. The full Kotlin suite passed 172 classes and 1870 cases with no failures, errors or skipped cases; the count gate passed.

Five Android cases passed using real application-private files and the actual normalization entry point: historical directory, partial historical file, unwritable backup directory leaving live and marker untouched, four migrations retaining the last three originals, and exclusive allocation with links, foreign UUIDs, equal timestamps, a clock rollback and separate helper retention quotas.

This repair concerns file ownership and allocation. The separate integration issue #640 concerns recording success and pruning before live publication has actually succeeded. The helper's separate quotas do not establish that the current normalizer correctly classifies failed publications. That issue remains open.

The validation APK is a local development build, not a release candidate. Device UI and runtime checks are recorded in the repair PR with their exact scope; they do not establish final dual-ABI or physical-device release qualification.
