/** Explain client-side gating; the server independently revalidates before spending. */
export function resetActionBlock(usage, now = Date.now()) {
    const weekly = usage.windows?.find(w => w.kind === 'weekly' && w.scope === undefined);
    if (!weekly || !Number.isFinite(weekly.usedPercent))
        return 'resetUseRefresh';
    if (weekly.usedPercent < 80)
        return 'resetUseGuard';
    if (weekly.resetsAt === undefined || weekly.resetsAt <= now || usage.resetCreditsError)
        return 'resetUseRefresh';
    if (!usage.resetCredits?.some(c => c.id))
        return 'resetUseRestart';
    if (!usage.resetCredits.some(c => c.id && (c.expiresAt === undefined || c.expiresAt > now)))
        return 'resetUseRefresh';
    return undefined;
}
