/** Presentation only: never trim the raw snapshots used by quota/routing logic. */
export function visibleUsageWindows(provider, windows, visibleModels) {
    const all = windows ?? [];
    // Other providers may scope quotas by family rather than exact model ID.
    const selected = new Set(visibleModels);
    return all.filter(window => !window.scope || selected.has(window.scope));
}
