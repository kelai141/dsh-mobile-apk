# Reusable workflow concurrency namespaces

PR #702 assigned the same workflow-level concurrency expression to `build-apk.yml` and the reusable `build-apk-source.yml` that it calls for source-audit builds. In the reusable workflow, `github.workflow` resolves to the caller workflow name. The nested source run could therefore request the group already held by the parent run waiting for it. Direct source dispatches also used a different group from nested calls because their workflow names differ.

The entry workflow and source-build workflow now use separate stable group prefixes keyed by `github.ref`. This avoids caller/callee self-blocking and keeps direct and nested source builds serialized on the same ref. A regression test models both execution contexts and contains a controlled negative case for the former shared group.

Validation: `node --test scripts/source-build/source-chain-rerun.test.mjs` passed 16/16 on Linux, including the concurrency-group regression and negative control. `scripts/check-code-map.mjs` and `git diff --check` passed.
