/** Model catalogs refresh at startup, then one hour after each run completes. */
export const CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000;
/** Start a non-overlapping, disposable loop; failures wait for the next interval. */
export function startCatalogRefresh(refresh, onError = () => { }) {
    const controller = new AbortController();
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
                timer.unref();
            }
        }
    };
    void run();
    return () => {
        controller.abort();
        if (timer !== undefined)
            clearTimeout(timer);
    };
}
