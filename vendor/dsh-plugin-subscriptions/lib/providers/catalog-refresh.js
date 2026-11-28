/** Model catalogs refresh after an optional startup delay, then one hour after each run completes. */
export const CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000;
/** Start a non-overlapping, disposable loop; failures wait for the next interval. */
export function startCatalogRefresh(refresh, onError = () => { }, options = {}) {
    const initialDelayMs = typeof options === 'number' ? options : options?.initialDelayMs ?? 0;
    const controller = new AbortController();
    let initialTimer;
    let timer;
    const run = async () => {
        if (controller.signal.aborted)
            return;
        try {
            await refresh(controller.signal);
        }
        catch (error) {
            if (!controller.signal.aborted)
                onError(error);
        }
        finally {
            if (!controller.signal.aborted) {
                timer = setTimeout(() => { void run(); }, CATALOG_REFRESH_INTERVAL_MS);
                timer.unref?.();
            }
        }
    };
    if (initialDelayMs > 0) {
        initialTimer = setTimeout(() => {
            initialTimer = undefined;
            void run();
        }, initialDelayMs);
        initialTimer.unref?.();
    }
    else {
        void run();
    }
    return () => {
        controller.abort();
        if (initialTimer !== undefined) {
            clearTimeout(initialTimer);
            initialTimer = undefined;
        }
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
}
