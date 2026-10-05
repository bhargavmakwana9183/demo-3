type NotifyPayload = {
    type: string;
    message: string;
    data?: Record<string, unknown>;
    at?: string;
};

let emitFn: ((event: string, payload: NotifyPayload) => void) | null = null;

export const setNiftyNotifyEmitter = (
    fn: (event: string, payload: NotifyPayload) => void,
) => {
    emitFn = fn;
};

export const notifyNiftyEvent = (
    type: string,
    message: string,
    data?: Record<string, unknown>,
) => {
    const payload: NotifyPayload = {
        type,
        message,
        data,
        at: new Date().toISOString(),
    };
    try {
        emitFn?.('nifty_scalp_notify', payload);
    } catch {
        // never break trading on notify failure
    }
};
