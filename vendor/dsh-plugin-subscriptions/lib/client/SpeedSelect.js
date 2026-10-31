import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Codex Speed toggle: one small control in the composer's right tool row
 * (`conversation.input.right`), switching the session between standard routing
 * and the fast (priority) service tier — the Codex desktop app's Speed menu.
 * The choice is per session and lives in the node half (in-memory); this
 * component holds only viewing state. The control renders nothing until the
 * first load proves the session's current model is a codex model whose catalog
 * advertises the fast tier.
 *
 * Every color resolves through a `--dsw-alias-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace, same as the settings section.
 */
import { useEffect, useRef, useState } from 'react';
import { callSubscriptionsAuth } from './SubscriptionsSection.js';
import { subscriptionChromeCss } from './provider-settings-styles.js';
import { en } from './locales.js';
/**
 * The `loadSpeed` half of the inject face: the plugin's own speed state plus
 * the host's current model selection (the visibility gate). A model-RPC
 * failure throws rather than answering "hidden" — the caller keeps its last
 * known state, so a transient failure never locks the toggle away.
 *
 * `sessionId` is a plain string: slot and command contexts brand it through
 * different dsh-session copies, and only the service boundary needs one.
 *
 * `models` resolves lazily per call: the ui-model-selection service may
 * register after this plugin applies, and a shell without it (no model seat
 * at all) simply keeps the toggle hidden.
 */
export function createSpeedLoader(connection, models, sessionId) {
    return async () => {
        const directories = models();
        const current = directories === undefined ? null : (await directories.directoryFor(sessionId).load()).current;
        const state = await callSubscriptionsAuth(connection.rpc, 'speed', {
            sessionId, ...(current?.provider === 'codex' ? { model: current.model } : {}),
        });
        const visible = current !== null && current.provider === 'codex'
            && state.fastModels.includes(current.model);
        return { visible, tier: state.tier };
    };
}
/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
export function createSpeedSetter(connection, sessionId) {
    return tier => callSubscriptionsAuth(connection.rpc, 'setSpeed', { sessionId, tier })
        .then(() => true, () => false);
}
/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key) {
    return en[key];
}
const TIERS = ['standard', 'fast'];
/**
 * The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
 * that opens a two-row menu (standard/fast with descriptions, check mark on
 * the current tier). Mount and every open reload the host state so a model
 * switch made since the last open self-corrects.
 */
/** How often the control re-reads the host state (model switches arrive only by asking). */
const POLL_INTERVAL_MS = 3000;
/**
 * The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
 * that opens a two-row menu (standard/fast with descriptions, check mark on
 * the current tier). The host pushes nothing on a model switch, so the
 * control re-reads on a slow poll with a single-flight guard; a failed read
 * keeps the last known state, so a transient RPC failure can never lock the
 * toggle away (the earlier mount-only load had no recovery path).
 */
export function SpeedSelect({ loadSpeed, setSpeed, t }) {
    const translate = t ?? fallbackTranslate;
    const [state, setState] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef(null);
    // The inject face may be re-evaluated (new callback identities) on re-render;
    // the poll effect mounts once and reads through this ref, so identity churn
    // neither resets the interval nor multiplies in-flight loads.
    const loadRef = useRef(loadSpeed);
    loadRef.current = loadSpeed;
    useEffect(() => {
        if (loadRef.current === undefined)
            return;
        let cancelled = false;
        let inflight = false;
        const reload = () => {
            const load = loadRef.current;
            if (load === undefined || inflight)
                return;
            inflight = true;
            void load().then((loaded) => { if (!cancelled)
                setState(loaded); }, () => { }).finally(() => { inflight = false; });
        };
        reload();
        const timer = setInterval(reload, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);
    useEffect(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            if (!rootRef.current?.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside); };
    }, [open]);
    if (loadSpeed === undefined || setSpeed === undefined || state === null || !state.visible) {
        return null;
    }
    const choose = (tier) => {
        if (busy)
            return;
        if (tier === state.tier) {
            setOpen(false);
            return;
        }
        setBusy(true);
        void setSpeed(tier).then((ok) => {
            setBusy(false);
            if (ok) {
                setState({ visible: true, tier });
                setOpen(false);
            }
        });
    };
    const show = () => {
        setOpen(true);
        const load = loadRef.current;
        if (load === undefined)
            return;
        void load().then(setState, () => { });
    };
    const tierName = (tier) => translate(tier === 'fast' ? 'speedFast' : 'speedStandard');
    const tierDescription = (tier) => translate(tier === 'fast' ? 'speedFastDescription' : 'speedStandardDescription');
    const triggerLabel = `${translate('speed')} · ${tierName(state.tier)}`;
    return (_jsxs("div", { ref: rootRef, className: "dsh-subscription-speed", style: styles.root, onKeyDown: (event) => {
            if (event.key === 'Escape' && open) {
                event.preventDefault();
                setOpen(false);
            }
        }, children: [_jsx("style", { children: subscriptionChromeCss }), open && (_jsx("div", { style: styles.menu, role: "menu", "aria-label": translate('speed'), children: TIERS.map(tier => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": tier === state.tier, style: styles.item, disabled: busy, onClick: () => { choose(tier); }, children: [_jsx("span", { style: styles.itemCheck, children: tier === state.tier ? '✓' : '' }), _jsxs("span", { style: styles.itemText, children: [_jsx("span", { style: styles.itemName, children: tierName(tier) }), _jsx("span", { style: styles.itemDescription, children: tierDescription(tier) })] })] }, tier))) })), _jsx("button", { type: "button", style: styles.trigger, "aria-haspopup": "menu", "aria-expanded": open, title: triggerLabel, disabled: busy, onClick: () => {
                    if (open)
                        setOpen(false);
                    else
                        show();
                }, children: triggerLabel })] }));
}
const styles = {
    root: { position: 'relative', display: 'inline-flex' },
    trigger: {
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm, 8px)',
        background: 'var(--dsh-subscription-speed-hover, transparent)', color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit', fontSize: 12, lineHeight: '18px',
        padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
    },
    menu: {
        position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
        minWidth: 180, padding: 4, zIndex: 20,
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2))', border: 0,
        boxShadow: 'var(--dsw-elevation-prominent)', borderRadius: 'var(--dsw-radius-lg, 16px)', display: 'flex', flexDirection: 'column', gap: 2,
    },
    item: {
        display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%',
        border: 'none', borderRadius: 'var(--dsw-radius-sm, 8px)', background: 'var(--dsh-subscription-speed-hover, transparent)',
        padding: '6px 8px', cursor: 'pointer', font: 'inherit', textAlign: 'left',
    },
    itemCheck: {
        width: 14, flexShrink: 0, fontSize: 12, lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
    },
    itemText: { display: 'flex', flexDirection: 'column' },
    itemName: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' },
    itemDescription: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
};
