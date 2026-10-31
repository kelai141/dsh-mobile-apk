import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { callSubscriptionsAuth } from './subscriptions-rpc.js';
import { modelEditorState, savedModelIds } from './model-filter.js';
const border = '0.5px solid var(--dsw-alias-border-l2, #ddd)';
const actions = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
/**
 * Embedded section of the account manager dialog. It owns the model draft
 * (visibility, effort, context, tools) but not its submission: the dialog
 * collects the draft through the handle and saves it with the account edits
 * in one go, so there is a single Save/Cancel pair.
 */
export const ProviderModelEditor = forwardRef(function ProviderModelEditor({ provider, rpc, t, disabled = false, onDirtyChange }, ref) {
    const [catalog, setCatalog] = useState();
    const [draft, setDraft] = useState({});
    const [contexts, setContexts] = useState({});
    const [efforts, setEfforts] = useState({});
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [error, setError] = useState('');
    const generation = useRef(0);
    useEffect(() => () => { generation.current++; }, []);
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
    function reset(data) {
        setCatalog(data);
        setDraft(data.settings);
        setEfforts(Object.fromEntries(data.models.map(model => [model.id, model.configured ?? ''])));
        setContexts(Object.fromEntries(Object.entries(data.settings.contextWindows ?? {}).map(([id, value]) => [id, String(value)])));
        setDirty(false);
    }
    async function load(force = false) {
        const request = ++generation.current;
        setBusy(true);
        setError('');
        try {
            const data = await callSubscriptionsAuth(rpc, 'providerSettings', { provider, force });
            if (generation.current === request)
                reset(data);
        }
        catch (error) {
            if (generation.current === request)
                setError(String(error instanceof Error ? error.message : error));
        }
        finally {
            if (generation.current === request)
                setBusy(false);
        }
    }
    function edit(next) { setDraft(next); setDirty(true); }
    useEffect(() => { void load(); }, [provider, rpc]);
    useImperativeHandle(ref, () => ({
        collect() {
            if (!catalog || !dirty)
                return { efforts: [] };
            const windows = Object.create(null);
            for (const [model, text] of Object.entries(contexts)) {
                if (!text.trim())
                    continue;
                const value = Number(text);
                if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value <= 0) {
                    setError(t('modelsContextInvalid', { model }));
                    return undefined;
                }
                windows[model] = value;
            }
            setError('');
            const { accounts: _accounts, ...settings } = { ...draft, ...(provider === 'codex' ? { contextWindows: windows } : {}) };
            return {
                settings,
                efforts: catalog.models.flatMap(model => {
                    const effort = efforts[model.id] ?? '';
                    return effort === (model.configured ?? '') || !model.efforts?.length ? [] : [{ model: model.id, effort }];
                }),
            };
        },
    }), [catalog, dirty, draft, contexts, efforts, provider]);
    const allModels = catalog?.models ?? [];
    const known = new Set(allModels.map(model => model.id));
    const savedIds = savedModelIds(draft.visibleModels, draft.modelDisplayNames, draft.subagentSpeeds);
    const missing = savedIds.filter(id => !known.has(id)).map(id => ({ id, name: id }));
    const customName = (id) => Object.hasOwn(draft.modelDisplayNames ?? {}, id) ? draft.modelDisplayNames[id] : '';
    const editName = (id, value) => {
        const names = Object.assign(Object.create(null), draft.modelDisplayNames);
        if (value.trim())
            names[id] = value;
        else
            delete names[id];
        edit({ ...draft, modelDisplayNames: names });
    };
    const models = [...allModels, ...missing].filter(model => `${model.name} ${model.id} ${customName(model.id)}`.toLowerCase().includes(query.trim().toLowerCase()));
    const editorState = modelEditorState({
        discovered: allModels.length,
        saved: missing.length,
        matched: models.length,
        accounts: catalog?.accounts ?? [],
    });
    const selected = new Set(draft.visibleModels ?? allModels.map(model => model.id));
    return _jsxs("div", { style: { borderTop: border, marginTop: 12, paddingTop: 12 }, children: [_jsx("h3", { style: { margin: 0 }, children: t('modelsEdit') }), _jsxs("div", { style: { display: 'grid', gap: 12, marginTop: 12 }, children: [_jsx("p", { className: "dsh-subscription-hint", children: t('modelsHint') }), error && _jsx("p", { role: "alert", children: error }), _jsxs("div", { style: actions, children: [_jsx("button", { type: "button", className: "dsh-subscription-quiet", disabled: busy || disabled || dirty, onClick: () => { void load(true); }, children: t('usageRefresh') }), busy && _jsx("span", { role: "status", children: t('modelDefaultsLoading') })] }), catalog && _jsxs("fieldset", { disabled: busy || disabled, style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 12 }, children: [_jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.visibleModels === undefined, onChange: event => {
                                            const next = { ...draft };
                                            if (event.target.checked)
                                                delete next.visibleModels;
                                            else
                                                next.visibleModels = allModels.map(model => model.id);
                                            edit(next);
                                        } }), " ", t('modelsAutomatic')] }), editorState.listState === 'provider-empty' ? _jsx("p", { className: "dsh-subscription-hint", children: t(editorState.noticeKey) }) : _jsxs(_Fragment, { children: [_jsxs("div", { style: actions, children: [_jsx("input", { style: { flex: '1 1 180px' }, value: query, onChange: event => setQuery(event.target.value), placeholder: t('modelDefaultsFilterPlaceholder'), "aria-label": t('modelDefaultsFilterPlaceholder') }), _jsx("button", { type: "button", onClick: () => edit({ ...draft, visibleModels: allModels.map(model => model.id) }), children: t('modelsSelectAll') }), _jsx("button", { type: "button", onClick: () => edit({ ...draft, visibleModels: [] }), children: t('modelsSelectNone') })] }), _jsxs("div", { style: { maxHeight: 360, overflowY: 'auto', display: 'grid', gap: 8 }, children: [models.map(model => _jsxs("div", { style: { borderBottom: border, padding: '8px 2px', display: 'grid', gap: 8 }, children: [_jsxs("label", { style: { overflowWrap: 'anywhere' }, children: [_jsx("input", { type: "checkbox", checked: selected.has(model.id), onChange: event => {
                                                                    const next = new Set(selected);
                                                                    if (event.target.checked)
                                                                        next.add(model.id);
                                                                    else
                                                                        next.delete(model.id);
                                                                    edit({ ...draft, visibleModels: [...next] });
                                                                } }), " ", model.name, !known.has(model.id) && ` (${t('modelsUnavailable')})`] }), _jsxs("small", { style: { color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }, children: ["ID: ", model.id] }), _jsxs("div", { style: actions, children: [_jsxs("label", { style: { display: 'grid', gap: 6, flex: '1 1 200px', minWidth: 0 }, children: [_jsx("span", { style: { fontSize: 12 }, children: t('modelDisplayName') }), _jsx("input", { maxLength: 80, "aria-label": `${model.name} ${t('modelDisplayName')}`, placeholder: model.name, value: customName(model.id), onChange: event => editName(model.id, event.target.value) })] }), _jsx("button", { type: "button", style: { alignSelf: 'end' }, "aria-label": `${model.name} ${t('displayNameReset')}`, disabled: !customName(model.id), onClick: () => editName(model.id, ''), children: t('displayNameReset') })] }), _jsx("small", { style: { color: 'var(--dsw-alias-label-tertiary)' }, children: t('modelDisplayNameHint') }), _jsxs("div", { style: actions, children: [(model.efforts?.length ?? 0) > 0 && _jsxs("label", { style: actions, children: [t('modelDefaultsTitle'), _jsxs("select", { "aria-label": `${model.name} ${t('modelDefaultsTitle')}`, value: efforts[model.id] ?? '', onChange: event => {
                                                                            setEfforts({ ...efforts, [model.id]: event.target.value });
                                                                            setDirty(true);
                                                                        }, children: [_jsx("option", { value: "", children: t('modelDefaultsFollowProvider') }), model.configured && !model.efforts?.some(effort => effort.id === model.configured) &&
                                                                                _jsxs("option", { value: model.configured, disabled: true, children: [model.configured, " (", t('modelsUnavailable'), ")"] }), model.efforts?.map(effort => _jsx("option", { value: effort.id, children: effort.name }, effort.id))] })] }), provider === 'codex' && model.maxContextWindow !== undefined && _jsxs("div", { style: actions, children: [_jsxs("label", { style: actions, children: [t('modelsContext'), _jsx("input", { style: { width: 140 }, inputMode: "numeric", value: contexts[model.id] ?? '', "aria-label": `${model.name} ${t('modelsContext')}`, placeholder: String(model.defaultContextWindow), onChange: event => { setContexts({ ...contexts, [model.id]: event.target.value }); setDirty(true); } })] }), _jsx("small", { children: t('modelsContextBounds', { default: model.defaultContextWindow, max: model.maxContextWindow }) })] })] }), provider === 'codex' && (model.fastTier || Object.hasOwn(draft.subagentSpeeds ?? {}, model.id)) && _jsxs("div", { style: { display: 'grid', gap: 6 }, children: [_jsxs("label", { style: actions, children: [t('modelsSubagentSpeed'), _jsxs("select", { "aria-label": `${model.name} ${t('modelsSubagentSpeed')}`, value: Object.hasOwn(draft.subagentSpeeds ?? {}, model.id) ? draft.subagentSpeeds[model.id] : 'standard', onChange: event => edit({ ...draft, subagentSpeeds: {
                                                                                ...draft.subagentSpeeds, [model.id]: event.target.value,
                                                                            } }), children: [_jsx("option", { value: "standard", children: t('speedStandard') }), _jsxs("option", { value: "fast", disabled: !model.fastTier, children: [t('speedFast'), !model.fastTier && ` (${t('modelsUnavailable')})`] })] })] }), _jsx("small", { children: t('modelsSubagentSpeedHint') })] })] }, model.id)), models.length === 0 && _jsx("span", { children: t('modelDefaultsFilterEmpty', { query }) })] })] }), provider === 'codex' && _jsx("small", { children: t('modelsContextHint') }), catalog.tools.length > 0 && _jsxs("div", { style: { display: 'grid', gap: 8 }, children: [_jsx("strong", { children: t('modelsTools') }), _jsx("small", { children: t('modelsToolsHint') }), catalog.tools.map(tool => _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.tools?.[tool] !== false, onChange: event => edit({
                                                    ...draft, tools: { ...draft.tools, [tool]: event.target.checked },
                                                }) }), " ", t(tool === 'image_generate' ? 'modelsImage' : tool === 'video_generate' ? 'modelsVideo' : tool === 'web_search' ? 'modelsWebSearch' : 'modelsSearch')] }, tool))] })] })] })] });
});
