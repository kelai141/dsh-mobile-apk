import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Subscription usage badge: a stats pill in the composer's dock
 * (`conversation.composer.dock`), modelled on the host's own token-usage
 * pill. Collapsed, it shows the rate-limit windows of the provider behind the
 * session's CURRENT model (a GPT model → Codex usage, a Claude model → Claude
 * usage); clicking it opens a trigger-anchored dialog listing every logged-in
 * account of every provider, with long window lists collapsed into previews,
 * the current provider first and the default account (starred) first within
 * a provider. Model-scoped usage follows the current model.
 *
 * Usage rides the `subscriptions-auth` `status` + `usage` endpoints on a slow
 * poll (the server shares its cache across UI surfaces); the current model
 * comes from ui-model-selection's `modelDirectories` service on a quicker
 * poll, since the host pushes nothing on a model switch. Renders nothing when
 * no provider has a logged-in account that reports usage.
 *
 * The collapsed pill reads only the default account — the same account
 * direct (non-pool) routes serve — so it stays one short segment even for a
 * provider with several accounts connected; the dialog shows them all.
 * Every color resolves through a `--dsw-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { subscriptionChromeCss } from './provider-settings-styles.js';
import { createPortal } from 'react-dom';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives';
import { callSubscriptionsAuth, usageBarColor } from './SubscriptionsSection.js';
import { en } from './locales.js';
import { hostIcon } from './host-icons.js';
import { useUsageBadgeMode } from './usage-badge-preferences.js';
import { DISPLAY_NAME_CHANGED } from './display-name-events.js';
/** DSH renamed the data icon in 0.1.7; retain older supported hosts too. */
export function usageBadgeIcon(icons) {
    return hostIcon(icons, 'DataOutline');
}
const UsageBadgeIcon = usageBadgeIcon(primitives);
/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const USAGE_POLL_INTERVAL_MS = 15 * 60_000;
/** How often the badge re-reads the session's current model (model switches arrive only by asking). */
const MODEL_POLL_INTERVAL_MS = 3000;
/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8;
/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12;
/** The account the collapsed pill reads: the default one, else the first listed. */
export function pillAccountOf(d) {
    return d.accounts.find(a => a.isDefault) ?? d.accounts[0];
}
/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES = {
    codex: 'Codex',
    claude: 'Claude',
    grok: 'Grok',
    copilot: 'Copilot',
};
/**
 * The `currentModel` half of the inject face: the session's effective
 * model selection through ui-model-selection's `modelDirectories` service,
 * resolved lazily per call (the service may register after this plugin, and
 * a shell without it reports "unknown"; the badge keeps the most recent
 * subscription selected in this view, or stays hidden).
 */
export function createCurrentModelReader(models, sessionId) {
    return async () => {
        const directories = models();
        if (directories === undefined)
            return undefined;
        const { current } = await directories.directoryFor(sessionId).load();
        return current ?? undefined;
    };
}
/**
 * Compact time-remaining label derived from the window's `resetsAt` timestamp:
 * "6d 18h" (days+hours), "1h 58m" (hours+minutes), or "42m" (minutes only).
 * Falls back to the scope/kind abbreviation when no reset time is known.
 */
export function windowLabel(w) {
    if (w.resetsAt === undefined) {
        if (w.scope !== undefined && w.scope !== '')
            return w.scope;
        switch (w.kind) {
            case 'session': return '5h';
            case 'weekly': return 'Wk';
            default: return 'W';
        }
    }
    const ms = Math.max(0, w.resetsAt - Date.now());
    const minutes = Math.floor(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m`;
    return `${Math.max(1, minutes)}m`;
}
/** Clamp and round a window's used share for display. */
function usedPercent(w) {
    return Math.round(Math.min(100, Math.max(0, w.usedPercent)));
}
/** Keep model quotas separate: matching percentages do not imply a shared pool. */
export function prioritizeWindows(windows, model) {
    return model === undefined ? [...windows] : [
        ...windows.filter(w => w.scope === model),
        ...windows.filter(w => w.scope !== model),
    ];
}
/** Small previews keep a live model catalog from taking over the dialog. */
export const WINDOW_PREVIEW_LIMIT = 4;
export function previewWindows(windows, model, provider) {
    const ordered = prioritizeWindows(windows, model);
    const limit = WINDOW_PREVIEW_LIMIT;
    return { shown: ordered.slice(0, limit), hidden: ordered.slice(limit) };
}
/** Bounded readout. */
export function compactSegment(d, model, t = fallbackTranslate) {
    const windows = pillAccountOf(d).windows;
    const parts = windows.slice(0, 2).map(w => `${windowLabel(w)} ${usedPercent(w)}%`);
    if (windows.length > 2)
        parts.push(`+${windows.length - 2}`);
    return `${d.name} ${parts.join(' · ')}`;
}
/** Remember only the most recent subscription in this view, including its model scope. */
export function retainSubscriptionSelection(previous, current) {
    return current !== undefined && Object.hasOwn(PROVIDER_NAMES, current.provider) ? current : previous;
}
/** At most one provider; no known selection or no usage means no badge. */
export function collapsedDisplays(displays, current) {
    const match = displays.find(d => d.provider === current);
    return match === undefined ? [] : [match];
}
/** Order for the expanded dialog: the current provider first, the rest in poll order. */
export function expandedDisplays(displays, current) {
    const match = displays.find(d => d.provider === current);
    return match === undefined ? displays : [match, ...displays.filter(d => d !== match)];
}
/**
 * A provider's logged-in accounts, the effective default first. When no
 * account is flagged default the first listed stands in, matching what
 * direct routes fall back to.
 */
function accountsOf(status) {
    if (status === undefined || status.accounts.length === 0)
        return [];
    const fallback = status.accounts.find(a => a.isDefault) ?? status.accounts[0];
    return status.accounts
        .map(a => (a === fallback ? { ...a, isDefault: true } : a))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}
/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key, params) {
    return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
}
/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t, window) {
    const base = window.kind === 'session'
        ? t('usageSession')
        : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow');
    return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base;
}
/**
 * The composer subscription-usage badge: a pill reading e.g.
 * `Codex 6d 1h 25%` for the current model's provider, opening a dialog with
 * every provider's accounts and their windows. Returns null when no data is
 * available.
 */
export function SubscriptionUsageBadge({ rpc, currentModel, t }) {
    const translate = t ?? fallbackTranslate;
    const [displays, setDisplays] = useState([]);
    const [selection, setSelection] = useState(undefined);
    const [lastSubscription, setLastSubscription] = useState(undefined);
    const displayMode = useUsageBadgeMode();
    const current = selection?.provider;
    const badgeSelection = retainSubscriptionSelection(lastSubscription, selection);
    const [open, setOpen] = useState(false);
    const [hover, setHover] = useState(false);
    const inflightRef = useRef(false);
    const mountedRef = useRef(true);
    const rootRef = useRef(null);
    const panelRef = useRef(null);
    // Always-rendered, invisible marker in the dock: locates the composer bar
    // (and the host stats row inside it) even while the pill itself is portaled.
    const seatRef = useRef(null);
    // The inject face may be re-evaluated (new callback identities) on
    // re-render; the model poll mounts once and reads through this ref.
    const currentRef = useRef(currentModel);
    currentRef.current = currentModel;
    // Last-known-good windows per account (keyed `provider:accountKey`), kept
    // across a failed poll (e.g. a 429 during the server's own negative-cache
    // cooldown) so a row doesn't flicker away — it only disappears once the
    // account actually logs out or a fetch succeeds but reports the window as
    // unsupported.
    const lastKnownRef = useRef(new Map());
    const namesRevision = useRef(0);
    const recentNames = useRef(new Map());
    const refresh = useCallback(async () => {
        if (rpc === undefined || inflightRef.current)
            return;
        inflightRef.current = true;
        const revision = namesRevision.current;
        try {
            const statusResp = await callSubscriptionsAuth(rpc, 'status', {});
            if (!mountedRef.current)
                return;
            // Every logged-in account of every provider, in a stable order (the
            // `status` provider order, default account first) so rows don't jump
            // around as polls settle at different times.
            const roster = [];
            for (const provider of Object.keys(statusResp.providers)) {
                for (const account of accountsOf(statusResp.providers[provider]))
                    roster.push({ provider, account });
            }
            const keyOf = (provider, account) => `${provider}:${account.key}`;
            const lastKnown = lastKnownRef.current;
            // Drop last-known state for anything no longer logged in — that is a
            // real signal, unlike a fetch failure.
            const live = new Set(roster.map(({ provider, account }) => keyOf(provider, account)));
            for (const key of lastKnown.keys()) {
                if (!live.has(key))
                    lastKnown.delete(key);
            }
            if (roster.length === 0) {
                setDisplays([]);
                return;
            }
            const results = await Promise.allSettled(roster.map(async ({ provider, account }) => {
                const usage = await callSubscriptionsAuth(rpc, 'usage', { provider, account: account.key });
                return { provider, account, usage };
            }));
            if (!mountedRef.current)
                return;
            const plans = new Map();
            for (const r of results) {
                if (r.status !== 'fulfilled')
                    continue; // keep whatever is cached for this account
                const { provider, account, usage } = r.value;
                const key = keyOf(provider, account);
                if (usage.plan !== undefined)
                    plans.set(key, usage.plan);
                if (!usage.supported || !usage.windows || usage.windows.length === 0) {
                    lastKnown.delete(key);
                    continue;
                }
                lastKnown.set(key, usage.windows);
            }
            const byProvider = new Map();
            for (const { provider, account } of roster) {
                const key = keyOf(provider, account);
                const windows = lastKnown.get(key);
                if (windows === undefined)
                    continue;
                const plan = plans.get(key) ?? account.plan;
                const row = {
                    key: account.key,
                    isDefault: account.isDefault,
                    ...account.account === undefined ? {} : { account: account.account },
                    ...plan === undefined ? {} : { plan },
                    windows,
                };
                const display = byProvider.get(provider);
                if (display === undefined)
                    byProvider.set(provider, { provider, name: statusResp.providers[provider]?.displayName || PROVIDER_NAMES[provider], accounts: [row] });
                else
                    display.accounts.push(row);
            }
            // A save during a slow quota poll wins over that poll's old status snapshot.
            setDisplays([...byProvider.values()].map(row => {
                const saved = recentNames.current.get(row.provider);
                return saved && saved.revision > revision ? { ...row, name: saved.name } : row;
            }));
        }
        catch {
            // A failed poll must not crash the badge; keep last known state.
        }
        finally {
            inflightRef.current = false;
        }
    }, [rpc]);
    useEffect(() => {
        const update = (event) => {
            const { provider, displayName } = event.detail;
            recentNames.current.set(provider, { revision: ++namesRevision.current, name: displayName || PROVIDER_NAMES[provider] });
            setDisplays(current => current.map(row => row.provider === provider
                ? { ...row, name: displayName || PROVIDER_NAMES[provider] } : row));
        };
        window.addEventListener(DISPLAY_NAME_CHANGED, update);
        return () => { window.removeEventListener(DISPLAY_NAME_CHANGED, update); };
    }, []);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    // Hidden renders nothing, so it polls nothing; showing it again refreshes at once.
    useEffect(() => {
        if (displayMode === 'hidden')
            return;
        void refresh();
        const timer = setInterval(() => { void refresh(); }, USAGE_POLL_INTERVAL_MS);
        return () => { clearInterval(timer); };
    }, [refresh, displayMode]);
    useEffect(() => {
        if (currentRef.current === undefined)
            return;
        let cancelled = false;
        let inflight = false;
        const reload = () => {
            const read = currentRef.current;
            if (read === undefined || inflight)
                return;
            inflight = true;
            void read().then((model) => {
                if (cancelled)
                    return;
                setLastSubscription(previous => retainSubscriptionSelection(previous, model));
                setSelection(model);
            }, () => { }).finally(() => { inflight = false; });
        };
        reload();
        const timer = setInterval(reload, MODEL_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);
    const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN });
    useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
    useEffect(() => {
        if (!open)
            return;
        const onKeyDown = (event) => {
            if (event.key === 'Escape')
                setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
    }, [open]);
    // Sit on the host's stats row when there is one. Every dock entry is its
    // own row in the composer bar, so a badge rendered in place lands under the
    // shipped time/token pills; the host marks its pill row with
    // `data-composer-stats`, and rendering into it makes the badge a third pill
    // on that line. The marker is watched (the row mounts only once the session
    // has steps or tokens, and unmounts with them) and older hosts without it
    // keep the in-place row.
    const [statsRow, setStatsRow] = useState(null);
    useEffect(() => {
        const seat = seatRef.current;
        if (seat === null)
            return;
        const scope = statsScopeOf(seat);
        if (scope === null)
            return;
        const find = () => scope.querySelector('[data-composer-stats]');
        setStatsRow(find());
        const observer = new MutationObserver(() => { setStatsRow(find()); });
        observer.observe(scope, { childList: true, subtree: true });
        return () => { observer.disconnect(); };
    }, []);
    useEffect(() => {
        if (displayMode === 'hidden')
            setOpen(false);
    }, [displayMode]);
    const seat = _jsx("span", { ref: seatRef, style: styles.seat, "aria-hidden": true });
    const collapsed = collapsedDisplays(displays, badgeSelection?.provider);
    if (displayMode === 'hidden' || collapsed.length === 0)
        return seat;
    const label = compactSegment(collapsed[0], badgeSelection?.model, translate);
    // The dialog opens from the badge, so it follows the provider and model the
    // badge shows (a retained subscription when the current model is not one).
    const expanded = expandedDisplays(displays, badgeSelection?.provider);
    const title = translate('usageBadgeTitle');
    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next)
            void refresh();
    };
    const pill = (_jsxs("span", { ref: rootRef, style: styles.anchor, children: [_jsx("style", { children: subscriptionChromeCss }), _jsxs("button", { type: "button", className: "dsh-subscription-usage-pill", style: { ...styles.pill, ...(hover || open ? styles.pillActive : {}) }, "aria-haspopup": "dialog", "aria-expanded": open, "aria-label": `${title} · ${label}`, title: title, onMouseEnter: () => { setHover(true); }, onMouseLeave: () => { setHover(false); }, onClick: toggle, children: [_jsx(UsageBadgeIcon, {}), _jsx("span", { style: styles.label, children: label })] }), open && createPortal(_jsxs("div", { ref: panelRef, role: "dialog", "aria-label": title, className: "dsh-subscription-usage-panel", style: { ...styles.panel, ...(pos ?? MEASURE_STYLE) }, children: [_jsx("div", { style: styles.title, children: _jsxs("span", { style: styles.titleLabel, children: [_jsx(UsageBadgeIcon, {}), title] }) }), _jsx("div", { style: styles.titleRule, "aria-hidden": true }), expanded.map((d, index) => (_jsxs("section", { style: index === 0 ? undefined : styles.section, children: [_jsxs("div", { style: styles.providerRow, children: [_jsxs("span", { style: styles.providerName, children: [d.name, d.provider === current && _jsx("span", { style: styles.currentTag, children: translate('usageBadgeCurrent') })] }), d.accounts.length === 1 && _jsx(AccountMeta, { account: d.accounts[0], translate: translate })] }), d.accounts.map((account, accountIndex) => (_jsxs("div", { style: accountIndex === 0 ? undefined : styles.accountBlock, children: [d.accounts.length > 1 && (_jsx("div", { style: styles.accountRow, children: _jsx(AccountMeta, { account: account, translate: translate }) })), _jsx(AccountWindows, { windows: account.windows, model: d.provider === badgeSelection?.provider ? badgeSelection.model : undefined, provider: d.provider, translate: translate }, `${d.provider}:${badgeSelection?.model ?? ''}`)] }, account.key)))] }, d.provider)))] }), document.body)] }));
    return (_jsxs(_Fragment, { children: [seat, statsRow !== null && statsRow.isConnected ? createPortal(pill, statsRow) : pill] }));
}
/**
 * Nearest ancestor of the dock seat that can contain the host's stats row:
 * the composer bar. Bounded so a badge in an unfamiliar layout never adopts
 * some other composer's pills.
 */
function statsScopeOf(seat) {
    let node = seat.parentElement;
    for (let depth = 0; node !== null && depth < 4; depth++) {
        if (node.querySelector('[data-composer-stats]') !== null)
            return node;
        node = node.parentElement;
    }
    return seat.parentElement;
}
/**
 * One account's handle and plan: `★ ys@example.com · 计划：pro`. The star
 * marks the default account (the one direct routes serve and the collapsed
 * pill reads), the same glyph Settings → 订阅 uses.
 */
function AccountMeta({ account, translate }) {
    const parts = [account.account, account.plan === undefined ? undefined : translate('usagePlan', { plan: account.plan })]
        .filter((part) => part !== undefined && part !== '');
    return (_jsxs("span", { style: styles.providerMeta, title: account.account, children: [account.isDefault && _jsx("span", { style: styles.defaultStar, "aria-label": "default", children: "\u2605 " }), parts.join(' · ')] }));
}
/** Preview each account independently; all remaining quotas stay accessible. */
export function AccountWindows({ windows, model, provider, translate }) {
    const { shown, hidden } = previewWindows(windows, model, provider);
    const rows = (items) => (_jsx("dl", { style: styles.details, children: items.map((w, i) => (_jsx(WindowRow, { label: `${usageWindowLabel(translate, w)}${model !== undefined && w.scope === model ? ` · ${translate('usageBadgeCurrent')}` : ''}`, window: w }, i))) }));
    return _jsxs(_Fragment, { children: [rows(shown), hidden.length > 0 && _jsxs("details", { style: styles.moreWindows, children: [_jsx("summary", { style: styles.moreSummary, children: translate('usageBadgeMoreWindows', { count: hidden.length }) }), rows(hidden)] })] });
}
/** One `dt`/`dd` pair: window name → `25% · 6d 1h`, with the bar underneath. */
function WindowRow({ label, window: w }) {
    const percent = usedPercent(w);
    return (_jsxs(_Fragment, { children: [_jsx("dt", { style: styles.dt, children: label }), _jsxs("dd", { style: styles.dd, children: [percent, "%", w.resetsAt !== undefined && _jsxs("span", { style: styles.reset, children: [" \u00B7 ", windowLabel(w)] })] }), _jsx("div", { style: styles.bar, "aria-hidden": true, children: _jsx("div", { style: { ...styles.barFill, width: `${percent}%`, background: usageBarColor(percent) } }) })] }));
}
/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
const styles = {
    seat: { display: 'none' },
    anchor: { minWidth: 0, maxWidth: '100%', display: 'inline-flex' },
    // Mirrors the host StatsPills pill so the badge reads as a sibling of the
    // shipped time/token pills.
    pill: {
        boxSizing: 'border-box', maxWidth: '100%',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'inherit', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))', whiteSpace: 'nowrap',
        background: 'transparent', border: 'none', borderRadius: 999,
        alignItems: 'center', gap: 6, padding: '1px 8px', display: 'inline-flex', cursor: 'pointer',
    },
    pillActive: {
        background: 'var(--dsw-alias-interactive-bg-hover)',
        color: 'var(--dsw-alias-label-secondary)',
    },
    label: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' },
    // Mirrors the host stat-dialog panel.
    panel: {
        position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
        background: 'var(--dsw-specific-menu)',
        width: 'max-content', minWidth: 'min(300px, 100vw - 24px)', maxWidth: 'min(440px, 100vw - 24px)',
        maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',
        boxShadow: 'var(--dsw-elevation-prominent)',
        color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
        border: 0, borderRadius: 'var(--dsw-radius-lg, 16px)', padding: 16, fontSize: 12, lineHeight: '18px',
    },
    title: {
        color: 'var(--dsw-alias-label-primary)', display: 'flex',
        justifyContent: 'space-between', gap: 16, marginBottom: 8, fontWeight: 500,
    },
    titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
    titleRule: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 },
    section: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
    providerRow: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginBottom: 6,
    },
    providerName: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 },
    currentTag: {
        fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '0 5px', borderRadius: 7,
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
    },
    providerMeta: {
        color: 'var(--dsw-alias-label-tertiary)', minWidth: 0, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
    // Same star and color as the default-account marker in Settings → 订阅.
    defaultStar: { color: 'var(--dsw-alias-state-warn-label)' },
    accountBlock: { marginTop: 8 },
    accountRow: { display: 'flex', marginBottom: 4 },
    details: {
        color: 'var(--dsw-alias-label-tertiary)', display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) max-content', gap: '4px 16px', margin: 0,
    },
    moreWindows: { marginTop: 8 },
    moreSummary: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 },
    dt: { minWidth: 0, margin: 0, overflowWrap: 'anywhere' },
    dd: {
        minWidth: 0, margin: 0, color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums', textAlign: 'right',
    },
    reset: { color: 'var(--dsw-alias-label-tertiary)' },
    bar: {
        gridColumn: '1 / -1', height: 4, borderRadius: 2, overflow: 'hidden',
        background: 'var(--dsw-alias-border-l2)', marginBottom: 2,
    },
    barFill: { height: '100%', borderRadius: 2 },
};
