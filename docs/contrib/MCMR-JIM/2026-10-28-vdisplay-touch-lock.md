# Virtual display usage timestamp synchronization

Issue #694 records a race introduced by the idle-reclamation fix: launch paths called `touch()` outside the monitor while `records` is a mutable `LinkedHashMap` shared with reclaim, create, and destroy paths.

`touch()` now acquires the controller's `lock` before reading or updating records. Existing callers that already hold the same monitor remain safe because Java monitors are reentrant. A regression test holds the controller monitor and verifies that a concurrent `touch()` blocks until it is released.

Validation: the complete Kotlin unit suite passed 1,899 tests; the per-class Kotlin test-count gate passed with no skips; `scripts/check-code-map.mjs` and `git diff --check` passed. No device stress test was run for this concurrency race.
