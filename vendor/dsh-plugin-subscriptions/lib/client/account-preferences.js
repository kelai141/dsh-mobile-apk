/** Missing allowlist follows discovery; explicit [] must remain empty. */
export function accountPoolSelection(account, models) {
    return new Set(account.poolModels ?? models.map(model => model.id));
}
/** Retain unavailable saved IDs so a temporary catalog failure cannot erase them. */
export function accountModelRows(account, preferences) {
    const known = new Set(account.models.map(model => model.id));
    return [
        ...account.models.map(model => ({ ...model, unavailable: false })),
        ...(preferences.poolModels ?? []).filter(id => !known.has(id)).map(id => ({ id, name: id, unavailable: true })),
    ];
}
/** The model editor owns everything except the separately managed accounts. */
export function mergeLatestAccounts(draft, latest) {
    const { accounts: _stale, ...settings } = draft;
    return { ...settings, ...(latest.accounts === undefined ? {} : { accounts: latest.accounts }) };
}
/** Only touched accounts replace their latest preferences; other settings survive. */
export function mergeAccountChanges(latest, changes) {
    return { ...latest, accounts: { ...latest.accounts, ...changes } };
}
