# Shared update-check deadline

The former 120-second watchdog could expire before sequential metadata fallbacks completed their declared connection and read budgets. The first five sources alone allow 152 seconds. Redirects restarted socket timeouts, while a per-read timeout did not bound the entire body.

UpdateCheckDeadline supplies one monotonic total deadline from check acceptance through publication. Each source receives a bounded child budget shared across redirect hops; connect and body reads consume the remaining budget. Scheduled disconnection bounds blocked requests. Publication checks the same deadline while holding the epoch lock, including when the main-thread watchdog has not yet run.

## Verification

The final focused JVM run passes 85 cases, including ten deadline regressions covering blocked-request cancellation and expired publication. Restoring the former 120-second budget fails the fallback-budget regression. The full main-based run executes 1,840 tests with one failure in the existing snapshot journal directory-target regression tracked by #595; it is not counted as a passing full run. The integration build including that repair passes all 1,852 tests across 171 classes, without failures or skips.

An APK rebuilt with the deadline implementation passes three Android 15 device regressions: blocked-header disconnection, a shared redirect budget, and expired-result rejection using a real Activity. WebView 124 CDP verification passes 39 checks in each orientation. ADB navigation and update-button interaction show checking followed by up-to-date in portrait and landscape; CDP confirms agreement between native and rendered state. An initial probe run encountered the first-launch onboarding state; that failure is retained separately, and the settled-page rerun passes. The APK is a local development repack with the existing verified runtime archive, not a release candidate.
