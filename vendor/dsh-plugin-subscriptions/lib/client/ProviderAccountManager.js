import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useRef, useState } from 'react';
import { callSubscriptionsAuth } from './subscriptions-rpc.js';
import { accountModelRows, accountPoolSelection, mergeAccountChanges, mergeLatestAccounts } from './account-preferences.js';
import { ProviderModelEditor } from './ProviderModelEditor.js';
import { notifyDisplayNameChange } from './display-name-events.js';
import { providerSettingsCss } from './provider-settings-styles.js';
const PROMPT_CACHE_TTLS = ['5m', '1h'];
const border = '0.5px solid var(--dsw-alias-border-l2)';
const stack = { display: 'grid', gap: 12, minWidth: 0 };
const actions = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
/** Native top-layer dialog provides keyboard containment, Escape and focus restoration. */
export function ProviderAccountManager({ provider, name, rpc, t, onClose }) {
    const dialog = useRef(null);
    const title = useId();
    const description = useId();
    const cacheTtlId = useId();
    const [catalog, setCatalog] = useState();
    const [changes, setChanges] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [modelsDirty, setModelsDirty] = useState(false);
    const [displayName, setDisplayName] = useState('');
    const [nameDirty, setNameDirty] = useState(false);
    /** '' follows the plugin config; otherwise an explicit TTL. */
    const [cacheTtl, setCacheTtl] = useState('');
    const [cacheTtlDirty, setCacheTtlDirty] = useState(false);
    const alive = useRef(true);
    const saveLock = useRef(false);
    const editor = useRef(null);
    useEffect(() => {
        alive.current = true;
        const element = dialog.current;
        const previous = document.activeElement;
        element.showModal();
        return () => {
            alive.current = false;
            element.close();
            if (previous instanceof HTMLElement && previous.isConnected)
                previous.focus();
        };
    }, []);
    useEffect(() => {
        let current = true;
        setLoading(true);
        setError('');
        void callSubscriptionsAuth(rpc, 'providerSettings', { provider }).then(data => {
            if (current) {
                setCatalog(data);
                setDisplayName(data.settings.displayName ?? '');
                setCacheTtl(data.settings.promptCacheTtl ?? '');
            }
        }).catch(error => {
            if (current)
                setError(t('accountsLoadFailed', { message: error instanceof Error ? error.message : String(error) }));
        }).finally(() => { if (current)
            setLoading(false); });
        return () => { current = false; };
    }, [provider, rpc, attempt]);
    function edit(key, next) {
        setChanges(current => ({ ...current, [key]: next }));
    }
    /**
     * One submit for both drafts: the model editor's (visibility, effort,
     * context, tools) and this dialog's account edits. A failure keeps the
     * dialog open with every edit intact.
     */
    async function save() {
        if (saveLock.current)
            return;
        // An invalid model draft (e.g. a malformed context window) blocks the
        // whole submit; the editor shows the reason next to the field.
        const models = editor.current === null ? { efforts: [] } : editor.current.collect();
        if (models === undefined)
            return;
        saveLock.current = true;
        setSaving(true);
        setSaveError('');
        let savedEfforts = 0;
        try {
            for (const { model, effort } of models.efforts) {
                await callSubscriptionsAuth(rpc, 'setModelDefault', { provider, model, ...(effort ? { effort } : {}) });
                savedEfforts++;
                if (!alive.current)
                    return;
            }
            // Re-read before writing: another client may have saved since this
            // dialog loaded, and a stale snapshot must never be written back.
            const latest = await callSubscriptionsAuth(rpc, 'providerSettings', { provider });
            if (!alive.current)
                return;
            const base = models.settings === undefined ? latest.settings : mergeLatestAccounts(models.settings, latest.settings);
            const { displayName: _staleName, promptCacheTtl: _staleTtl, ...rest } = mergeAccountChanges(base, changes);
            const savedName = nameDirty ? displayName.trim() : latest.settings.displayName;
            const savedTtl = cacheTtlDirty ? cacheTtl : latest.settings.promptCacheTtl;
            const settings = {
                ...rest,
                ...(savedName ? { displayName: savedName } : {}),
                ...(savedTtl ? { promptCacheTtl: savedTtl } : {}),
            };
            await callSubscriptionsAuth(rpc, 'setProviderSettings', { provider, settings });
            notifyDisplayNameChange(provider, settings.displayName);
            if (alive.current)
                onClose();
        }
        catch (error) {
            if (alive.current) {
                const message = error instanceof Error ? error.message : String(error);
                setSaveError((savedEfforts ? t('modelsPartialSave') + ' ' : '') + t('accountsSaveFailed', { message }));
            }
        }
        finally {
            saveLock.current = false;
            if (alive.current)
                setSaving(false);
        }
    }
    return _jsxs("dialog", { className: "dsh-subscription-manager", ref: dialog, "aria-labelledby": title, "aria-describedby": description, onCancel: event => { if (saveLock.current)
            event.preventDefault(); }, onClose: onClose, style: { width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)', overflow: 'auto' }, children: [_jsx("style", { children: providerSettingsCss }), _jsxs("div", { style: { ...stack, padding: 20 }, children: [_jsxs("header", { style: { ...actions, justifyContent: 'space-between' }, children: [_jsx("h2", { id: title, style: { margin: 0 }, children: t('accountsTitle', { provider: name }) }), _jsx("button", { type: "button", autoFocus: true, disabled: saving, onClick: onClose, children: t('imageClose') })] }), _jsx("p", { id: description, className: "dsh-subscription-hint", children: t('accountsHint') }), error && _jsx("p", { role: "alert", children: error }), loading && _jsx("p", { role: "status", className: "dsh-subscription-hint", children: t('accountsLoading') }), !loading && !catalog && _jsx("button", { type: "button", onClick: () => setAttempt(value => value + 1), children: t('modelDefaultsRetry') }), catalog && _jsxs("fieldset", { disabled: saving || loading, style: { ...stack, border: 0, margin: 0, padding: 0 }, children: [_jsxs("section", { style: { ...stack, gap: 6, paddingBottom: 8 }, children: [_jsxs("label", { style: { ...stack, gap: 6 }, children: [_jsx("strong", { children: t('subscriptionDisplayName') }), _jsx("input", { maxLength: 80, value: displayName, placeholder: name, onChange: event => { setDisplayName(event.target.value); setNameDirty(true); } })] }), _jsxs("div", { style: { ...actions, justifyContent: 'space-between' }, children: [_jsx("small", { className: "dsh-subscription-hint", children: t('subscriptionDisplayNameHint') }), _jsx("button", { type: "button", disabled: !displayName, onClick: () => { setDisplayName(''); setNameDirty(true); }, children: t('displayNameReset') })] })] }), provider === 'claude' && _jsxs("section", { style: { ...stack, gap: 6, paddingBottom: 8 }, children: [_jsx("label", { htmlFor: cacheTtlId, children: _jsx("strong", { children: t('claudePromptCacheTtl') }) }), _jsxs("select", { id: cacheTtlId, value: cacheTtl, style: { justifySelf: 'start' }, onChange: event => { setCacheTtl(event.target.value); setCacheTtlDirty(true); }, children: [_jsx("option", { value: "", children: t('claudePromptCacheTtlDefault', { ttl: catalog.promptCacheTtlDefault ?? '5m' }) }), PROMPT_CACHE_TTLS.map(ttl => _jsx("option", { value: ttl, children: t(`claudePromptCacheTtl${ttl}`) }, ttl))] }), _jsx("small", { className: "dsh-subscription-hint", children: t('claudePromptCacheTtlHint') })] }), catalog.accounts.length === 0 && _jsx("p", { className: "dsh-subscription-hint", children: t('accountsEmpty') }), catalog.accounts.map(account => {
                                const preferences = changes[account.key] ?? catalog.settings.accounts?.[account.key] ?? {};
                                const selected = accountPoolSelection(preferences, account.models);
                                const models = accountModelRows(account, preferences);
                                return _jsxs("fieldset", { style: { ...stack, border, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: 14, margin: 0 }, children: [_jsx("legend", { style: { padding: '0 6px', overflowWrap: 'anywhere', maxWidth: '100%' }, children: account.label }), account.unavailable && _jsx("p", { className: "dsh-subscription-hint", children: t('accountsCatalogUnavailable') }), _jsxs("label", { style: { ...stack, gap: 6 }, children: [_jsx("span", { className: "dsh-subscription-label", children: t('accountsAlias') }), _jsx("input", { value: preferences.alias ?? '', placeholder: account.label, onChange: event => {
                                                        const next = { ...preferences };
                                                        if (event.target.value.trim())
                                                            next.alias = event.target.value;
                                                        else
                                                            delete next.alias;
                                                        edit(account.key, next);
                                                    } })] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: preferences.poolEnabled !== false, onChange: event => edit(account.key, { ...preferences, poolEnabled: event.target.checked }) }), " ", t('accountsPoolEnabled')] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: preferences.independentEntry === true, onChange: event => edit(account.key, { ...preferences, independentEntry: event.target.checked }) }), " ", t('accountsIndependent')] }), _jsx("p", { className: "dsh-subscription-hint", children: t('accountsIndependentHint') }), _jsxs("details", { children: [_jsxs("summary", { style: { cursor: 'pointer', fontSize: 13 }, children: [t('accountsModels'), " \u00B7 ", preferences.poolModels === undefined
                                                            ? t('accountsModelsAll') : t('accountsModelsCount', { count: preferences.poolModels.length })] }), _jsxs("div", { style: { ...stack, marginTop: 12 }, children: [_jsx("p", { className: "dsh-subscription-hint", children: t('accountsModelsHint') }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: preferences.poolModels === undefined, onChange: event => {
                                                                        const next = { ...preferences };
                                                                        if (event.target.checked)
                                                                            delete next.poolModels;
                                                                        else
                                                                            next.poolModels = account.models.map(model => model.id);
                                                                        edit(account.key, next);
                                                                    } }), " ", t('accountsModelsAutomatic')] }), _jsxs("div", { style: actions, children: [_jsx("button", { type: "button", onClick: () => edit(account.key, { ...preferences, poolModels: models.map(model => model.id) }), children: t('modelsSelectAll') }), _jsx("button", { type: "button", onClick: () => edit(account.key, { ...preferences, poolModels: [] }), children: t('modelsSelectNone') })] }), _jsxs("div", { style: { ...stack, gap: 8, maxHeight: 240, overflowY: 'auto' }, children: [models.map(model => _jsxs("label", { style: { overflowWrap: 'anywhere' }, children: [_jsx("input", { type: "checkbox", checked: selected.has(model.id), onChange: event => {
                                                                                const next = new Set(selected);
                                                                                if (event.target.checked)
                                                                                    next.add(model.id);
                                                                                else
                                                                                    next.delete(model.id);
                                                                                edit(account.key, { ...preferences, poolModels: [...next] });
                                                                            } }), " ", model.name, model.unavailable && ` (${t('modelsUnavailable')})`] }, model.id)), models.length === 0 && _jsx("p", { className: "dsh-subscription-hint", children: t('accountsNoModels') })] })] })] })] }, account.key);
                            })] }), _jsx(ProviderModelEditor, { ref: editor, provider: provider, rpc: rpc, t: t, disabled: saving, onDirtyChange: setModelsDirty }), _jsxs("footer", { style: { ...stack, gap: 8, borderTop: border, padding: '14px 0 8px',
                            position: 'sticky', bottom: 0, background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))' }, children: [saveError && _jsx("p", { role: "alert", children: saveError }), _jsxs("div", { style: { ...actions, justifyContent: 'flex-end' }, children: [_jsx("button", { type: "button", disabled: saving, onClick: onClose, children: t('cancel') }), _jsx("button", { type: "button", className: "dsh-subscription-primary", disabled: loading || saving || (!Object.keys(changes).length && !modelsDirty && !nameDirty && !cacheTtlDirty), onClick: () => { void save(); }, children: saving ? t('modelDefaultsSaving') : t('modelsSave') })] })] })] })] });
}
