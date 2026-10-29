/**
 * Lets chain-sync ask the live market websocket to subscribe newly added keys
 * without importing app.ts (circular).
 */
let resubscribeFn: (() => Promise<void>) | null = null;

export const setNiftyMarketResubscribe = (fn: () => Promise<void>) => {
    resubscribeFn = fn;
};

export const resubscribeNiftyMarketFeed = async () => {
    if (!resubscribeFn) return;
    try {
        await resubscribeFn();
    } catch {
        // Subscribe retry happens on the next websocket reconnect.
    }
};
