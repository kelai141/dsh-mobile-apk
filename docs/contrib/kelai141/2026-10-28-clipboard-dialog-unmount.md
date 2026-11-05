# Clipboard Draft Cleanup on Dialog Removal

The clipboard-draft observer filters document mutations to settings and onboarding dialog scopes. Removing the last dialog also removes that scope before the observer callback runs, so the previous early return skipped `scan()` and retained the detached editor and its listeners. An in-flight native clipboard request could remain pending as well.

The observer now detects when a removed subtree contains a tracked editor and runs the existing cleanup scan even when no dialog remains. Disposal removes the draft panel, releases the page listener and timeout, and sends the existing native cancellation request. Unrelated document churn remains filtered.

Validation: `npm test --prefix dsh-client-ui-responsive -- tests/clipboard-model-drafts.spec.tsx` passed (13 tests); `npm run typecheck --prefix dsh-client-ui-responsive` and `git diff --check` passed. No device validation was performed; this change only covers observer lifecycle cleanup and preserves the existing user interaction flow.
