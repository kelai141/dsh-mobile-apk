import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * native settings vocabulary with shared, scoped control states.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { en } from './locales.js';
import { resetActionBlock } from './reset-action.js';
import { visibleUsageWindows } from './usage-window-filter.js';
import { ProviderAccountManager } from './ProviderAccountManager.js';
import { providerSettingsCss } from './provider-settings-styles.js';
import { UsageBadgeDisplaySetting } from './UsageBadgeDisplaySetting.js';
import { callSubscriptionsAuth, SubscriptionsAuthError } from './subscriptions-rpc.js';
export { callSubscriptionsAuth } from './subscriptions-rpc.js';
/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000;
/**
 * Model count above which the expanded default-effort list also offers a name
 * filter; below it the list is short enough to scan.
 */
const MODEL_FILTER_THRESHOLD = 8;
const CLIENT_VERSION_SOURCES = {
    npm: 'clientVersionNpm',
    local: 'clientVersionLocal',
    fallback: 'clientVersionFallback',
    config: 'clientVersionConfig',
};
/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS = [
    { id: 'codex', name: 'Codex (ChatGPT)' },
    { id: 'claude', name: 'Claude' },
    { id: 'grok', name: 'Grok (X Premium)' },
    { id: 'copilot', name: 'GitHub Copilot' },
];
/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale(map, live) {
    const stale = Object.keys(map).filter(key => !live.has(key));
    if (stale.length === 0)
        return map;
    const next = { ...map };
    for (const key of stale)
        delete next[key];
    return next;
}
/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key, params) {
    let text = en[key];
    for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}
const styles = {
    section: {
        display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
        color: 'var(--dsw-alias-label-primary)',
    },
    intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
    card: {
        border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
        borderRadius: 'var(--dsw-radius-xl, 20px)', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    },
    proxyCard: {
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    },
    separator: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
    cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
    name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
    statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    clientVersion: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
    errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
    actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
    usage: {
        display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
        borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 8,
    },
    usageHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    usageTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
    usagePlan: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
    usageRefresh: { minHeight: 22, height: 22, padding: '0 8px', marginLeft: 'auto' },
    usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
    usageMeta: {
        display: 'flex', justifyContent: 'space-between', gap: 8,
        fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
    },
    accountRow: {
        display: 'flex', flexDirection: 'column', gap: 6,
        border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg, 16px)',
        padding: '8px 10px', marginTop: 4,
    },
    accountHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    accountName: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
    starButton: {
        border: 'none', padding: 0, width: 28,
        font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
        color: 'var(--dsw-alias-state-warn-label)',
    },
    usageTrack: {
        height: 6, borderRadius: 3, overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)',
    },
    usageFill: { height: '100%', borderRadius: 3 },
    deviceCode: {
        marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
        border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg, 16px)',
        padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
    },
    deviceCodeText: {
        fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
        color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
    },
    proxyField: { display: 'flex', flexDirection: 'column', gap: 4 },
    proxyLabel: { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
    proxyInput: { width: '100%' },
    manual: { fontSize: 13, lineHeight: '20px' },
    manualRow: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 },
    manualInput: { flex: '1 1 200px', minWidth: 0 },
    proxyHint: {
        margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
    },
    proxyCheck: {
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
    },
    proxyMessage: { margin: 0, fontSize: 12, lineHeight: '18px' },
    proxyActions: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 2 },
    modalOverlay: {
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'var(--dsw-alias-bg-mask-1, #0006)', backdropFilter: 'var(--dsw-mask-blur, none)',
    },
    modal: {
        width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
        padding: '16px 18px', borderRadius: 'var(--dsw-radius-panel, 28px)',
        background: 'var(--dsw-alias-bg-layer-2)', border: 0, boxShadow: 'var(--dsw-elevation-prominent)',
    },
    modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
    modalTitle: { fontWeight: 500, fontSize: 16, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
};
/** Status dot color for one provider state. */
function dotColor(status) {
    if (status?.busy === true)
        return 'var(--dsw-alias-state-warn-label)';
    if ((status?.accounts.length ?? 0) > 0)
        return 'var(--dsw-alias-state-success-primary)';
    return 'var(--dsw-alias-label-dimmed)';
}
/**
 * Whether a provider has at least one connected account. Multi-account made
 * "logged in" a property of the account list rather than a flag, so every
 * logged-in test goes through this one predicate.
 * @param status - the provider's last reported state, possibly absent.
 * @returns true when the provider serves at least one account.
 */
function hasAccount(status) {
    return (status?.accounts.length ?? 0) > 0;
}
/** The CLI version a route presents, beside the provider name; nothing for routes without one. */
export function ClientVersionTag({ clientVersion, t }) {
    if (clientVersion === undefined)
        return null;
    return (_jsx("span", { style: styles.clientVersion, title: t('clientVersionHint'), children: t('clientVersion', { version: clientVersion.version, source: t(CLIENT_VERSION_SOURCES[clientVersion.source]) }) }));
}
/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t, status) {
    if (status === undefined)
        return t('checking');
    if (status.busy)
        return t('loginInProgress');
    if (status.accounts.length > 0)
        return t('loggedInCount', { count: status.accounts.length });
    return t('notLoggedIn');
}
/**
 * Localized label of one usage window (kind, plus the model scope when named).
 * @param t - section translate.
 * @param window - the reported window.
 * @returns e.g. "5-hour window" or "Weekly · Opus".
 */
function usageWindowLabel(t, window) {
    const base = window.kind === 'session'
        ? t('usageSession')
        : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow');
    return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base;
}
/** Bar fill color: success normally, warn from 80%, error from 95%. Shared with the composer badge. */
export function usageBarColor(usedPercent) {
    if (usedPercent >= 95)
        return 'var(--dsw-alias-state-error-primary)';
    if (usedPercent >= 80)
        return 'var(--dsw-alias-state-warn-label)';
    return 'var(--dsw-alias-state-success-primary)';
}
/** One-line status text of the proxy config card. */
function proxyStatusText(t, proxy, loadError) {
    if (loadError !== undefined)
        return t('proxyLoadFailed', { message: loadError });
    if (proxy === undefined)
        return t('proxyLoading');
    if (proxy.error !== undefined)
        return t('proxyStatusError', { message: proxy.error });
    if (proxy.enabled)
        return t('proxyStatusEnabled', { url: proxy.url });
    return t('proxyStatusNone');
}
/** Feedback-line color of the proxy dialog. */
function messageColor(tone) {
    return tone === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-success-primary)';
}
/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export function deriveModelDefaultsView(models, filter) {
    const all = models ?? [];
    const withEfforts = all.filter(model => model.efforts.length > 0);
    const query = filter.trim().toLowerCase();
    const shown = query === ''
        ? withEfforts
        : withEfforts.filter(model => model.name.toLowerCase().includes(query)
            || model.id.toLowerCase().includes(query));
    return {
        shown,
        total: withEfforts.length,
        overridden: withEfforts.filter(model => model.configured !== undefined).length,
        withoutEfforts: all.length - withEfforts.length,
        showFilter: withEfforts.length > MODEL_FILTER_THRESHOLD,
    };
}
/**
 * Whether the default-effort catalog needs (re)fetching.
 *
 * Fetching is gated on an *attempt* signature rather than on the payload
 * being empty: an empty answer is a legitimate result (a narrowed
 * `config.providers`, or a catalog that is momentarily unavailable), and
 * treating it as "not loaded yet" re-ran this effect forever. The signature
 * also covers the accounts, so logging a second provider in refetches
 * instead of leaving that card on the previous answer.
 * @param input - the decision inputs.
 * @returns true when the caller should start a fetch.
 */
export function shouldFetchModelDefaults(input) {
    if (input.failed)
        return false;
    if (input.loggedIn.length === 0)
        return false;
    // Only an open disclosure pays for the per-model live resolve.
    if (!input.open.some(provider => input.loggedIn.includes(provider)))
        return false;
    return input.loadedFor !== input.signature;
}
/**
 * Stable signature of the accounts a catalog answer depends on. A change
 * means a previous answer is stale (an account arrived or left), so the next
 * open disclosure refetches.
 * @param statuses - the per-provider status snapshot.
 * @returns a signature string, stable across renders with equal accounts.
 */
export function modelDefaultsSignature(statuses) {
    return PROVIDERS
        .map(({ id }) => `${id}:${(statuses[id]?.accounts ?? []).map(account => account.key).sort().join(',')}`)
        .join('|');
}
/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props) {
    const { rpc } = props;
    const t = props.t ?? fallbackTranslate;
    const [statuses, setStatuses] = useState({});
    const [errors, setErrors] = useState({});
    const [manualDrafts, setManualDrafts] = useState({
        codex: '', claude: '', grok: '', copilot: '',
    });
    /** Pending device-flow codes (copilot), shown while the attempt polls. */
    const [deviceCodes, setDeviceCodes] = useState({});
    const [copiedCode, setCopiedCode] = useState(undefined);
    /** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
    const [usages, setUsages] = useState({});
    const [usageErrors, setUsageErrors] = useState({});
    const [usageLoading, setUsageLoading] = useState({});
    const [resetConfirmation, setResetConfirmation] = useState();
    const [resetBusy, setResetBusy] = useState(false);
    const [resetAcknowledged, setResetAcknowledged] = useState(false);
    const [resetMessage, setResetMessage] = useState('');
    const [resetAccount, setResetAccount] = useState();
    const resetDialogRef = useRef(null);
    useEffect(() => {
        if (resetConfirmation)
            resetDialogRef.current?.showModal();
        else
            resetDialogRef.current?.close();
    }, [resetConfirmation]);
    const resetInflight = useRef(false);
    const mountedRef = useRef(true);
    const pollersRef = useRef(new Map());
    /** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
    const usageInflightRef = useRef(new Set());
    /** Proxy config as last answered by `proxyGet`/`proxySet`. */
    const [proxy, setProxy] = useState(undefined);
    const [proxyLoadError, setProxyLoadError] = useState(undefined);
    /** Proxy dialog state (draft fields; the password never pre-fills). */
    const [proxyOpen, setProxyOpen] = useState(false);
    const [managedProvider, setManagedProvider] = useState();
    const [proxyEnabled, setProxyEnabled] = useState(false);
    const [proxyUrl, setProxyUrl] = useState('');
    const [proxyUsername, setProxyUsername] = useState('');
    const [proxyPassword, setProxyPassword] = useState('');
    const [proxyClearPassword, setProxyClearPassword] = useState(false);
    const [proxyBypass, setProxyBypass] = useState('');
    const [proxySaving, setProxySaving] = useState(false);
    const [proxyTesting, setProxyTesting] = useState(false);
    const [proxyMessage, setProxyMessage] = useState(undefined);
    const [proxyTestResult, setProxyTestResult] = useState(undefined);
    const setProviderError = useCallback((provider, message) => {
        if (!mountedRef.current)
            return;
        setErrors((prev) => {
            const next = { ...prev };
            if (message === undefined)
                delete next[provider];
            else
                next[provider] = message;
            return next;
        });
    }, []);
    const stopPolling = useCallback((provider) => {
        const poller = pollersRef.current.get(provider);
        if (poller !== undefined) {
            clearInterval(poller);
            pollersRef.current.delete(provider);
        }
    }, []);
    /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
    const refresh = useCallback(async () => {
        if (rpc === undefined)
            return;
        let response;
        try {
            response = await callSubscriptionsAuth(rpc, 'status', {});
        }
        catch (error) {
            // A failed poll must not kill the page; busy providers keep polling and
            // the action paths report their own errors. But staying silent turns a
            // persistent failure into an endless "Checking…" — show it instead.
            const message = error instanceof Error ? error.message : String(error);
            for (const { id } of PROVIDERS)
                setProviderError(id, message);
            return;
        }
        if (!mountedRef.current)
            return;
        setStatuses(response.providers);
        // The poll recovered: drop any error line a previous failed poll left.
        for (const { id } of PROVIDERS)
            setProviderError(id, undefined);
        for (const { id } of PROVIDERS) {
            const status = response.providers[id];
            if (status.accounts.length > 0 || !status.busy) {
                stopPolling(id);
                // The attempt settled (success, timeout, or cancel): drop the code card.
                setDeviceCodes((prev) => {
                    if (prev[id] === undefined)
                        return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                });
            }
        }
    }, [rpc, stopPolling, setProviderError]);
    const startPolling = useCallback((provider) => {
        if (pollersRef.current.has(provider))
            return;
        pollersRef.current.set(provider, setInterval(() => { void refresh(); }, POLL_INTERVAL_MS));
    }, [refresh]);
    // Initial load; every busy provider (e.g. an attempt started before a page
    // reload) resumes polling. Teardown clears pollers and the mounted guard.
    useEffect(() => {
        mountedRef.current = true;
        void refresh().then(() => {
            if (!mountedRef.current)
                return;
            setStatuses((current) => {
                for (const { id } of PROVIDERS) {
                    if (current[id]?.busy === true)
                        startPolling(id);
                }
                return current;
            });
        });
        return () => {
            mountedRef.current = false;
            for (const poller of pollersRef.current.values())
                clearInterval(poller);
            pollersRef.current.clear();
        };
    }, [refresh, startPolling]);
    const loadUsage = useCallback(async (provider, account, force = false) => {
        const key = `${provider}:${account}`;
        if (rpc === undefined || usageInflightRef.current.has(key))
            return;
        usageInflightRef.current.add(key);
        setUsageLoading(prev => ({ ...prev, [key]: true }));
        try {
            const usage = await callSubscriptionsAuth(rpc, 'usage', { provider, account, ...force ? { force: true } : {} });
            if (!mountedRef.current)
                return;
            setUsages(prev => ({ ...prev, [key]: usage }));
            setUsageErrors((prev) => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
        }
        catch (error) {
            if (mountedRef.current)
                setUsageErrors(prev => ({ ...prev, [key]: messageOf(error) }));
        }
        finally {
            usageInflightRef.current.delete(key);
            if (mountedRef.current)
                setUsageLoading(prev => ({ ...prev, [key]: false }));
        }
    }, [rpc]);
    async function prepareReset(account) {
        if (!rpc || resetInflight.current)
            return;
        resetInflight.current = true;
        setResetBusy(true);
        setResetAccount(account);
        setResetConfirmation(undefined);
        setResetMessage('');
        try {
            const result = await callSubscriptionsAuth(rpc, 'prepareReset', { account });
            setResetAcknowledged(false);
            setResetConfirmation({ ...result, account });
        }
        catch (error) {
            setResetMessage(messageOf(error));
        }
        finally {
            resetInflight.current = false;
            setResetBusy(false);
        }
    }
    async function consumeReset() {
        if (!rpc || !resetConfirmation || !resetAcknowledged || resetInflight.current)
            return;
        const { account, ticket } = resetConfirmation;
        resetInflight.current = true;
        setResetBusy(true);
        setResetConfirmation(undefined);
        try {
            await callSubscriptionsAuth(rpc, 'consumeReset', { account, ticket });
            setResetMessage(t('resetUseSuccess'));
        }
        catch (error) {
            setResetMessage(messageOf(error));
        }
        finally {
            await loadUsage('codex', account, true);
            resetInflight.current = false;
            setResetBusy(false);
        }
    }
    // Fetch usage once an account is logged in; drop the snapshots of accounts
    // that vanished so a re-login refetches. A failed lookup does not auto-retry
    // — the per-account Refresh button is the retry path.
    useEffect(() => {
        const live = new Set();
        for (const { id } of PROVIDERS) {
            for (const account of statuses[id]?.accounts ?? []) {
                const key = `${id}:${account.key}`;
                live.add(key);
                if (usages[key] === undefined && usageErrors[key] === undefined)
                    void loadUsage(id, account.key);
            }
        }
        setUsages(prev => dropStale(prev, live));
        setUsageErrors(prev => dropStale(prev, live));
    }, [statuses, usages, usageErrors, loadUsage]);
    const login = useCallback(async (provider, method) => {
        if (rpc === undefined)
            return;
        setProviderError(provider, undefined);
        try {
            const response = await callSubscriptionsAuth(rpc, 'login', {
                provider,
                ...method === undefined ? {} : { method },
            });
            if (typeof response.authorizeUrl === 'string' && response.authorizeUrl === '') {
                // Instant login (e.g. imported from Claude Code credentials)
                await refresh();
                return;
            }
            if (typeof response.authorizeUrl !== 'string') {
                throw new SubscriptionsAuthError(t('loginMissingUrl'));
            }
            if (!mountedRef.current)
                return;
            // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
            setStatuses(prev => ({
                ...prev,
                [provider]: { accounts: prev[provider]?.accounts ?? [], ...prev[provider], busy: true },
            }));
            if (typeof response.userCode === 'string' && response.userCode.length > 0) {
                // Device flow: show the code card instead of opening the page blind —
                // the user copies the code first, then opens the verification page.
                setDeviceCodes(prev => ({ ...prev, [provider]: { userCode: response.userCode, verificationUrl: response.authorizeUrl } }));
            }
            else {
                window.open(response.authorizeUrl, '_blank', 'noopener');
            }
            startPolling(provider);
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
    }, [rpc, t, setProviderError, startPolling]);
    const cancel = useCallback(async (provider) => {
        if (rpc === undefined)
            return;
        stopPolling(provider);
        try {
            await callSubscriptionsAuth(rpc, 'cancel', { provider });
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, stopPolling, setProviderError, refresh]);
    const submitManual = useCallback(async (provider) => {
        if (rpc === undefined)
            return;
        const input = manualDrafts[provider].trim();
        if (input === '')
            return;
        setProviderError(provider, undefined);
        try {
            await callSubscriptionsAuth(rpc, 'manual', { provider, input });
            if (mountedRef.current)
                setManualDrafts(prev => ({ ...prev, [provider]: '' }));
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, manualDrafts, setProviderError, refresh]);
    const logout = useCallback(async (provider, account, display, name) => {
        if (rpc === undefined)
            return;
        if (!window.confirm(t('logoutAccountConfirm', { provider: name, account: display })))
            return;
        setProviderError(provider, undefined);
        try {
            await callSubscriptionsAuth(rpc, 'logout', { provider, account });
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, t, setProviderError, refresh]);
    const setDefault = useCallback(async (provider, account) => {
        if (rpc === undefined)
            return;
        setProviderError(provider, undefined);
        try {
            await callSubscriptionsAuth(rpc, 'setDefault', { provider, account });
        }
        catch (error) {
            setProviderError(provider, messageOf(error));
        }
        await refresh();
    }, [rpc, setProviderError, refresh]);
    const copyDeviceCode = useCallback((provider, userCode) => {
        void navigator.clipboard?.writeText(userCode).then(() => {
            if (!mountedRef.current)
                return;
            setCopiedCode(provider);
            setTimeout(() => {
                if (mountedRef.current) {
                    setCopiedCode(current => current === provider ? undefined : current);
                }
            }, 1500);
        }).catch(() => undefined);
    }, []);
    // Proxy configuration: load once on mount; the dialog drives proxySet/proxyTest.
    useEffect(() => {
        if (rpc === undefined)
            return;
        let alive = true;
        void callSubscriptionsAuth(rpc, 'proxyGet', {}).then((view) => {
            if (!alive)
                return;
            setProxy(view);
            setProxyLoadError(undefined);
        }).catch((error) => {
            if (alive)
                setProxyLoadError(messageOf(error));
        });
        return () => { alive = false; };
    }, [rpc]);
    useEffect(() => {
        if (!proxyOpen)
            return;
        const onKey = (event) => {
            if (event.key === 'Escape')
                setProxyOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [proxyOpen]);
    const openProxyDialog = useCallback(() => {
        if (proxy === undefined)
            return;
        setProxyEnabled(proxy.enabled);
        setProxyUrl(proxy.url);
        setProxyUsername(proxy.username ?? '');
        setProxyPassword('');
        setProxyClearPassword(false);
        setProxyBypass(proxy.bypass.join(', '));
        setProxyMessage(undefined);
        setProxyTestResult(undefined);
        setProxyOpen(true);
    }, [proxy]);
    const saveProxy = useCallback(async () => {
        if (rpc === undefined)
            return;
        setProxySaving(true);
        setProxyMessage(undefined);
        try {
            const view = await callSubscriptionsAuth(rpc, 'proxySet', {
                enabled: proxyEnabled,
                url: proxyUrl.trim(),
                username: proxyUsername,
                ...proxyClearPassword ? { password: null } : proxyPassword !== '' ? { password: proxyPassword } : {},
                bypass: proxyBypass.split(/[,\n]/).map(entry => entry.trim()).filter(entry => entry !== ''),
            });
            setProxy(view);
            setProxyLoadError(undefined);
            setProxyMessage({ tone: 'success', text: t('proxySaved') });
            setProxyOpen(false);
        }
        catch (error) {
            setProxyMessage({ tone: 'error', text: t('proxySaveFailed', { message: messageOf(error) }) });
        }
        finally {
            setProxySaving(false);
        }
    }, [rpc, proxyEnabled, proxyUrl, proxyUsername, proxyPassword, proxyClearPassword, proxyBypass, t]);
    const testProxy = useCallback(async () => {
        if (rpc === undefined || proxyTesting)
            return;
        setProxyTesting(true);
        setProxyTestResult(undefined);
        try {
            // Test the dialog's current inputs (they do not need to be saved first);
            // the host builds a throwaway agent for the probe.
            setProxyTestResult(await callSubscriptionsAuth(rpc, 'proxyTest', {
                proxy: {
                    url: proxyUrl.trim(),
                    ...proxyUsername.trim() !== '' ? { username: proxyUsername.trim() } : {},
                    ...proxyPassword !== '' ? { password: proxyPassword } : {},
                },
            }));
        }
        catch (error) {
            setProxyTestResult({ ok: false, viaProxy: false, error: messageOf(error) });
        }
        finally {
            setProxyTesting(false);
        }
    }, [rpc, proxyTesting, proxyUrl, proxyUsername, proxyPassword]);
    if (rpc === undefined) {
        return _jsx("p", { style: styles.intro, children: t('unavailable') });
    }
    return (_jsxs("div", { className: "dsh-subscriptions-settings", style: styles.section, children: [_jsx("style", { children: providerSettingsCss }), _jsx("p", { style: styles.intro, children: t('intro') }), _jsx(UsageBadgeDisplaySetting, { t: t }), _jsxs("div", { style: styles.proxyCard, children: [_jsxs("div", { style: styles.cardHeader, children: [_jsx("span", { style: {
                                    ...styles.dot,
                                    background: proxy?.enabled === true
                                        ? 'var(--dsw-alias-state-success-primary)'
                                        : 'var(--dsw-alias-label-dimmed)',
                                } }), _jsx("span", { style: styles.name, children: t('proxyTitle') }), _jsx("button", { type: "button", style: { marginLeft: 'auto', flexShrink: 0 }, onClick: openProxyDialog, children: t('proxyConfigure') })] }), _jsx("p", { style: styles.statusLine, children: proxyStatusText(t, proxy, proxyLoadError) })] }), _jsx("div", { style: styles.separator }), PROVIDERS.map(({ id, name }) => {
                const status = statuses[id];
                const busy = status?.busy === true;
                const deviceCode = deviceCodes[id];
                const accounts = status?.accounts ?? [];
                return (_jsxs("div", { style: styles.card, children: [_jsxs("div", { style: styles.cardHeader, children: [_jsx("span", { style: { ...styles.dot, background: dotColor(status) } }), _jsx("span", { style: styles.name, children: status?.displayName || name }), status?.displayName && _jsx("small", { style: styles.statusLine, children: name }), _jsx(ClientVersionTag, { clientVersion: status?.clientVersion, t: t })] }), _jsx("p", { style: styles.statusLine, children: statusText(t, status) }), status?.detail !== undefined && status.detail !== '' && (_jsx("p", { style: styles.statusLine, children: status.detail })), errors[id] !== undefined && _jsx("p", { style: styles.errorLine, children: errors[id] }), accounts.map((account) => {
                            const usageKey = `${id}:${account.key}`;
                            const usage = usages[usageKey];
                            const shownWindows = visibleUsageWindows(id, usage?.windows, status?.visibleModels);
                            const usageError = usageErrors[usageKey];
                            const display = account.account ?? account.key;
                            const sortedCredits = [...(usage?.resetCredits ?? [])].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
                            const nextReset = sortedCredits.find(c => c.expiresAt === undefined || c.expiresAt > Date.now());
                            const resetBlock = usage ? resetActionBlock(usage) : 'resetUseRefresh';
                            const resetDisabled = resetBusy || resetBlock !== undefined;
                            // Providers without a usage endpoint answer supported:false — no block.
                            const showUsage = usage?.supported !== false
                                && (usage !== undefined || usageError !== undefined || usageLoading[usageKey] === true);
                            return (_jsxs("div", { style: styles.accountRow, children: [_jsxs("div", { style: styles.accountHeader, children: [_jsx("button", { type: "button", style: styles.starButton, title: account.isDefault ? t('defaultBadge') : t('setDefault'), onClick: () => {
                                                    if (!account.isDefault)
                                                        void setDefault(id, account.key);
                                                }, children: account.isDefault ? '★' : '☆' }), _jsx("span", { style: styles.accountName, children: display }), account.plan !== undefined && (_jsx("span", { style: styles.usagePlan, children: account.plan })), account.expiresAt !== undefined && (_jsx("span", { style: styles.statusLine, children: t('accountExpires', { date: new Date(account.expiresAt).toLocaleString() }) })), _jsx("button", { type: "button", style: { marginLeft: 'auto', flexShrink: 0 }, onClick: () => { void logout(id, account.key, display, name); }, children: t('logout') })] }), showUsage && (_jsxs("div", { style: styles.usage, children: [_jsxs("div", { style: styles.usageHeader, children: [_jsx("span", { style: styles.usageTitle, children: t('usageTitle') }), usage?.plan !== undefined && (_jsx("span", { style: styles.usagePlan, children: t('usagePlan', { plan: usage.plan }) })), _jsx("button", { type: "button", style: styles.usageRefresh, disabled: usageLoading[usageKey] === true, onClick: () => { void loadUsage(id, account.key, true); }, children: t('usageRefresh') })] }), usage === undefined && usageError === undefined && (_jsx("p", { style: styles.statusLine, children: t('usageLoading') })), usageError !== undefined && (_jsx("p", { style: styles.errorLine, children: t('usageError', { message: usageError }) })), usage?.windows !== undefined && usage.windows.length === 0 && (_jsx("p", { style: styles.statusLine, children: t('usageEmpty') })), usage?.windows !== undefined && usage.windows.length > 0 && shownWindows.length === 0 && (_jsx("p", { style: styles.statusLine, children: t('usageNoVisibleModels') })), shownWindows.map((window, index) => {
                                                const percent = Math.min(100, Math.max(0, window.usedPercent));
                                                return (_jsxs("div", { style: styles.usageRow, children: [_jsxs("div", { style: styles.usageMeta, children: [_jsx("span", { children: usageWindowLabel(t, window) }), _jsxs("span", { children: [`${String(Math.round(percent))}%`, window.resetsAt !== undefined
                                                                            && ` · ${t('usageResets', { date: new Date(window.resetsAt).toLocaleString() })}`] })] }), _jsx("div", { style: styles.usageTrack, children: _jsx("div", { style: { ...styles.usageFill, width: `${String(percent)}%`, background: usageBarColor(percent) } }) })] }, index));
                                            }), id === 'codex' && usage?.resetCreditsError !== undefined && (_jsx("p", { style: styles.errorLine, children: t('resetCreditsError', { message: usage.resetCreditsError }) })), id === 'codex' && usage?.resetCredits !== undefined && (_jsxs("details", { className: "subscriptions-reset-credits", style: styles.usageRow, children: [_jsxs("summary", { style: { ...styles.usageMeta, cursor: 'pointer', listStyle: 'none', justifyContent: 'flex-start', gap: 6 }, children: [_jsx("svg", { "aria-hidden": "true", width: "12", height: "12", viewBox: "0 0 16 16", style: { flexShrink: 0 }, children: _jsx("path", { d: "m6 3 5 5-5 5", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) }), _jsx("span", { children: t('resetCreditsTitle') }), _jsx("span", { style: { marginLeft: 'auto' }, children: t('resetCreditsAvailable', { count: usage.resetCredits.length }) })] }), _jsx("style", { children: '.subscriptions-reset-credits > summary::-webkit-details-marker { display: none; }'
                                                            + '.subscriptions-reset-credits[open] > summary > svg { transform: rotate(90deg); }' }), _jsxs("div", { style: { paddingLeft: 18, marginTop: 6 }, children: [sortedCredits.map((credit, index) => (_jsxs("div", { style: { ...styles.usageMeta, minHeight: 28, gap: 12 }, children: [_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }, children: [t('resetCreditFull'), credit === nextReset && (_jsx("button", { type: "button", "aria-disabled": resetDisabled, title: t(resetBusy ? 'resetUseChecking' : resetBlock ?? 'resetUseReady'), style: { height: 22, minHeight: 22, padding: '0 7px',
                                                                                    opacity: resetDisabled ? 0.35 : 1, cursor: resetDisabled ? 'not-allowed' : 'pointer' }, onClick: () => { if (!resetDisabled)
                                                                                    void prepareReset(account.key); }, children: resetBusy && resetAccount === account.key ? t('resetUseChecking') : t('resetUseButton') }))] }), _jsx("span", { style: { textAlign: 'right' }, children: credit.expiresAt === undefined ? t('resetCreditExpiryUnknown') : t('resetCreditExpires', { date: new Date(credit.expiresAt).toLocaleString() }) })] }, credit.id ?? index))), resetAccount === account.key && resetMessage && _jsx("p", { role: "status", style: styles.statusLine, children: resetMessage })] })] }))] }))] }, account.key));
                        }), _jsxs("div", { style: styles.actions, children: [!busy && accounts.length === 0 && (_jsx("button", { type: "button", onClick: () => { void login(id); }, children: t('login') })), !busy && accounts.length > 0 && id === 'claude' && (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", onClick: () => { void login(id, 'oauth'); }, children: t('addAccountOAuth') }), _jsx("button", { type: "button", onClick: () => { void login(id, 'keychain'); }, children: t('addAccountKeychain') })] })), !busy && accounts.length > 0 && id !== 'claude' && (_jsx("button", { type: "button", onClick: () => { void login(id); }, children: t('addAccount') })), !busy && _jsx("button", { type: "button", "aria-haspopup": "dialog", onClick: () => setManagedProvider({ id, name }), children: t('accountsManage') }), busy && (_jsx("button", { type: "button", onClick: () => { void cancel(id); }, children: t('cancel') }))] }), !busy && accounts.length > 0 && (_jsx("p", { style: styles.statusLine, children: t('addAccountHint') })), busy && deviceCode !== undefined && (_jsxs("div", { style: styles.deviceCode, children: [_jsx("span", { style: styles.statusLine, children: t('deviceCodePrompt') }), _jsx("span", { style: styles.deviceCodeText, children: deviceCode.userCode }), _jsxs("div", { style: styles.actions, children: [_jsx("button", { type: "button", onClick: () => { copyDeviceCode(id, deviceCode.userCode); }, children: copiedCode === id ? t('deviceCodeCopied') : t('deviceCodeCopy') }), _jsx("button", { type: "button", onClick: () => { window.open(deviceCode.verificationUrl, '_blank', 'noopener'); }, children: t('deviceCodeOpenPage') })] })] })), busy && deviceCode === undefined && (_jsxs("details", { style: styles.manual, children: [_jsx("summary", { children: t('manualSummary') }), _jsxs("div", { style: styles.manualRow, children: [_jsx("input", { style: styles.manualInput, value: manualDrafts[id], placeholder: t('manualPlaceholder'), onChange: event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value })) }), _jsx("button", { type: "button", onClick: () => { void submitManual(id); }, children: t('submit') })] })] }))] }, id));
            }), managedProvider && _jsx(ProviderAccountManager, { provider: managedProvider.id, name: managedProvider.name, rpc: rpc, t: t, onClose: () => { setManagedProvider(undefined); void refresh(); } }), _jsx("style", { children: '.subscriptions-reset-dialog::backdrop { background: var(--dsw-alias-bg-mask-1, #0006); backdrop-filter: var(--dsw-mask-blur, none); }' }), _jsx("dialog", { ref: resetDialogRef, className: "subscriptions-reset-dialog", "aria-labelledby": "subscriptions-reset-title", onCancel: () => setResetConfirmation(undefined), onClose: () => setResetConfirmation(undefined), style: { ...styles.modal, display: resetConfirmation ? 'flex' : 'none', margin: 'auto', color: 'var(--dsw-alias-label-primary)' }, children: resetConfirmation && _jsxs(_Fragment, { children: [_jsx("h3", { id: "subscriptions-reset-title", style: { ...styles.modalTitle, margin: 0 }, children: t('resetUseConfirmTitle') }), _jsx("p", { style: { ...styles.statusLine, overflowWrap: 'anywhere' }, children: statuses.codex?.accounts.find(a => a.key === resetConfirmation.account)?.account ?? resetConfirmation.account }), _jsxs("div", { style: { ...styles.usageMeta, gap: 12 }, children: [_jsx("span", { children: t('usageWeekly') }), _jsxs("strong", { children: [Math.round(resetConfirmation.weeklyUsedPercent), "%"] })] }), _jsx("div", { style: styles.usageMeta, children: _jsx("span", { children: resetConfirmation.creditExpiresAt === undefined ? t('resetCreditExpiryUnknown') : t('resetCreditExpires', { date: new Date(resetConfirmation.creditExpiresAt).toLocaleString() }) }) }), _jsx("p", { style: { ...styles.statusLine, margin: '4px 0' }, children: t('resetUseWarning') }), _jsxs("label", { style: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }, children: [_jsx("input", { type: "checkbox", checked: resetAcknowledged, onChange: e => setResetAcknowledged(e.target.checked) }), t('resetUseAcknowledge')] }), _jsxs("div", { className: "dsh-subscription-dialog-actions", style: { ...styles.actions, justifyContent: 'flex-end', marginTop: 8 }, children: [_jsx("button", { type: "button", autoFocus: true, onClick: () => setResetConfirmation(undefined), children: t('cancel') }), _jsx("button", { type: "button", className: "dsh-subscription-primary", style: { opacity: resetAcknowledged ? 1 : 0.35, cursor: resetAcknowledged ? 'pointer' : 'not-allowed' }, disabled: !resetAcknowledged || resetBusy, onClick: () => { void consumeReset(); }, children: t('resetUseConfirm') })] })] }) }), proxyOpen && (_jsx("div", { style: styles.modalOverlay, onClick: () => setProxyOpen(false), children: _jsxs("div", { style: styles.modal, onClick: event => event.stopPropagation(), children: [_jsxs("div", { style: styles.modalHeader, children: [_jsx("span", { style: styles.modalTitle, children: t('proxyDialogTitle') }), _jsx("button", { type: "button", style: { marginLeft: 'auto' }, onClick: () => setProxyOpen(false), children: t('proxyDialogClose') })] }), _jsxs("label", { style: styles.proxyCheck, children: [_jsx("input", { type: "checkbox", checked: proxyEnabled, onChange: event => setProxyEnabled(event.target.checked) }), _jsx("span", { children: t('proxyEnabled') })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyUrl') }), _jsx("input", { style: styles.proxyInput, value: proxyUrl, placeholder: t('proxyUrlPlaceholder'), onChange: event => setProxyUrl(event.target.value) }), _jsx("p", { style: styles.proxyHint, children: t('proxyUrlHint') })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyUsername') }), _jsx("input", { style: styles.proxyInput, value: proxyUsername, placeholder: t('proxyUsernamePlaceholder'), onChange: event => setProxyUsername(event.target.value) })] }), _jsxs("div", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyPassword') }), _jsx("input", { type: "password", style: styles.proxyInput, value: proxyPassword, placeholder: t('proxyPasswordPlaceholder'), onChange: event => setProxyPassword(event.target.value) }), _jsxs("label", { style: styles.proxyCheck, children: [_jsx("input", { type: "checkbox", checked: proxyClearPassword, onChange: event => setProxyClearPassword(event.target.checked) }), _jsx("span", { children: t('proxyClearPassword') })] })] }), _jsxs("label", { style: styles.proxyField, children: [_jsx("span", { style: styles.proxyLabel, children: t('proxyBypass') }), _jsx("input", { style: styles.proxyInput, value: proxyBypass, placeholder: t('proxyBypassPlaceholder'), onChange: event => setProxyBypass(event.target.value) }), _jsx("p", { style: styles.proxyHint, children: t('proxyBypassHint') })] }), _jsx("p", { style: styles.proxyHint, children: t('proxyNote') }), proxyMessage !== undefined && (_jsx("p", { style: { ...styles.proxyMessage, color: messageColor(proxyMessage.tone) }, children: proxyMessage.text })), proxyTestResult !== undefined && (_jsx("p", { style: {
                                ...styles.proxyMessage,
                                color: proxyTestResult.ok
                                    ? 'var(--dsw-alias-state-success-primary)'
                                    : 'var(--dsw-alias-state-error-primary)',
                            }, children: proxyTestResult.ok
                                ? (proxyTestResult.viaProxy
                                    ? t('proxyTestOk', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) })
                                    : t('proxyTestOkDirect', { status: String(proxyTestResult.status), ms: String(proxyTestResult.latencyMs) }))
                                : t('proxyTestFail', { message: proxyTestResult.error ?? '' }) })), _jsxs("div", { className: "dsh-subscription-dialog-actions", style: styles.proxyActions, children: [_jsx("button", { type: "button", disabled: proxyTesting, onClick: () => { void testProxy(); }, children: proxyTesting ? t('proxyTesting') : t('proxyTest') }), _jsx("button", { type: "button", className: "dsh-subscription-primary", disabled: proxySaving, onClick: () => { void saveProxy(); }, children: proxySaving ? t('proxySaving') : t('proxySave') }), _jsx("button", { type: "button", onClick: () => setProxyOpen(false), children: t('proxyCancel') })] })] }) }))] }));
}
