/** Notify mounted views after a successful save, without another quota request. */
export const DISPLAY_NAME_CHANGED = 'dsh-subscriptions-display-name-changed';
export function notifyDisplayNameChange(provider, displayName) {
    window.dispatchEvent(new CustomEvent(DISPLAY_NAME_CHANGED, {
        detail: { provider, ...(displayName?.trim() ? { displayName: displayName.trim() } : {}) },
    }));
}
