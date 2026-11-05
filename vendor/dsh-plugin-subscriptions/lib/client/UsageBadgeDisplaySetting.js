import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { setUsageBadgeMode, useUsageBadgeMode } from './usage-badge-preferences.js';
/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }) {
    const mode = useUsageBadgeMode();
    const [failed, setFailed] = useState(false);
    return (_jsxs("div", { style: styles.card, children: [_jsxs("label", { style: styles.field, children: [_jsx("span", { children: t('usageBadgeDisplay') }), _jsxs("select", { style: styles.select, "aria-label": t('usageBadgeDisplay'), value: mode, onChange: event => {
                            const value = event.currentTarget.value;
                            if (value !== 'recent' && value !== 'hidden')
                                return;
                            try {
                                setUsageBadgeMode(value);
                                setFailed(false);
                            }
                            catch (error) {
                                if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name))
                                    throw error;
                                setFailed(true);
                            }
                        }, children: [_jsx("option", { value: "recent", children: t('usageBadgeDisplayRecent') }), _jsx("option", { value: "hidden", children: t('usageBadgeDisplayHidden') })] })] }), _jsx("p", { style: styles.hint, children: t('usageBadgeDisplayHint') }), failed && _jsx("p", { role: "alert", style: { ...styles.hint, color: 'var(--dsw-alias-state-error-primary)' }, children: t('usageBadgeDisplaySaveFailed') })] }));
}
const styles = {
    card: {
        border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
        borderRadius: 'var(--dsw-radius-xl, 20px)', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
    },
    field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, lineHeight: '20px' },
    select: { width: '100%' },
    hint: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
};
