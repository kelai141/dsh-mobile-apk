# Accessibility Channel State Diagnostics

Issues #670 and #689 covered adjacent losses of state certainty in the Android bridge. The shell preference parser treated a missing `a11yEnabled` key as `false`, stale heartbeat and confirmed disablement shared the `off` source, and the capability facade converted probe exceptions to `a11y: false`.

The bridge now reports four diagnostic sources: `heartbeat`, `disabled`, `stale`, and `unknown`. `a11yEnabled` remains fail-closed and only a fresh heartbeat enables the accessibility route. Status output includes a finite heartbeat age when available. The capability response carries the source, omits the boolean for stale or unobserved states, preserves explicit `false`, and tells the caller to try the requested operation and use its structured result instead of declaring the channel unavailable. The status route also omits `alternative.available` for stale and unknown a11y states, while retaining `source` and actionable guidance.

Validation: the Android bridge package build and all 173 package tests passed, including stale-heartbeat, explicit-disable, missing-preference, failed-probe, route, and rendered-status cases. `check-code-map`, `check-state-registry`, `check-bridge-symmetry`, and `check-tool-output-schema` passed. No device validation was performed.
