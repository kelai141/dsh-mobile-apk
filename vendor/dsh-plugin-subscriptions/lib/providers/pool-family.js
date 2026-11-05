/**
 * Same-subscription account routing: the picker is the union of every
 * account's catalog (deduped by wire id). A model listed by two or more
 * accounts failovers between them; a model listed by only one account is
 * sent to that account. No extra pool identity, no cross-provider
 * aggregation.
 */
/** Map key for one provider's pool of one model (ids collide across providers). */
export function poolKey(provider, model) {
    return `${provider}/${model}`;
}
/**
 * Build per-provider account routes. Each model id becomes a definition of
 * the accounts that list it: two or more fail over; one is pinned to that
 * account (so a Max-only model is never sent to a Plus login). The picker
 * unions these catalogs; a logout that drops a model to one account keeps
 * the same id and pins it to whoever remains.
 * @param sources - per-account catalogs (providers with no accounts list
 *   nothing and simply never join a pool).
 * @returns `provider/model` → pool definition (not listed as an extra entry).
 */
export function buildAccountPools(sources) {
    const pools = new Map();
    for (const [provider, source] of Object.entries(sources)) {
        const byModel = new Map();
        for (const catalog of source.catalogs) {
            for (const model of catalog.models) {
                let entry = byModel.get(model.id);
                if (entry === undefined) {
                    entry = { members: [], info: model };
                    byModel.set(model.id, entry);
                }
                entry.members.push({ provider, account: catalog.account, model: model.id });
            }
        }
        for (const [id, { members, info }] of byModel) {
            pools.set(poolKey(provider, id), {
                members,
                ...info.name === undefined || info.name === id ? {} : { name: info.name },
                ...info.description === undefined ? {} : { description: info.description },
            });
        }
    }
    return pools;
}
