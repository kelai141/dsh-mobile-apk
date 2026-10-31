import { useSyncExternalStore } from 'react';
const MODE_KEY = 'dsh.subscriptions.usageBadgeMode';
const MODE_EVENT = 'dsh:subscriptions:usage-badge-mode';
/** Read the browser preference; blocked storage retains the default display. */
export function readUsageBadgeMode() {
    if (typeof window === 'undefined')
        return 'recent';
    try {
        return window.localStorage.getItem(MODE_KEY) === 'hidden' ? 'hidden' : 'recent';
    }
    catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'SecurityError')
            throw error;
        return 'recent';
    }
}
/** Save first, then notify; the settings control reports a rejected write. */
export function setUsageBadgeMode(mode) {
    if (mode !== 'recent' && mode !== 'hidden')
        throw new TypeError('Invalid subscription usage display mode');
    window.localStorage.setItem(MODE_KEY, mode);
    window.dispatchEvent(new Event(MODE_EVENT));
}
/** Same-tab writes need a custom event; other tabs use the storage event. */
export function subscribeUsageBadgeMode(notify) {
    const onStorage = (event) => {
        if (event.key === MODE_KEY || event.key === null)
            notify();
    };
    window.addEventListener(MODE_EVENT, notify);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(MODE_EVENT, notify);
        window.removeEventListener('storage', onStorage);
    };
}
/** Shared React snapshot used by the settings control and every mounted badge. */
export function useUsageBadgeMode() {
    return useSyncExternalStore(subscribeUsageBadgeMode, readUsageBadgeMode, () => 'recent');
}
