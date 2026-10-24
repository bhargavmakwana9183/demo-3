import { Op } from 'sequelize';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import {
    cancel_upstox_order,
    get_upstox_order_details,
    place_order_on_upstocks,
} from './upstocks.apis';
import { isLiveTradingEnabled } from './scalping.trade.helper';
import {
    NiftyScalpConfig,
    calculateTargetLtp,
} from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';

export const ORDER_CONFIRM_TIMEOUT_MS = 25_000;
export const ORDER_POLL_MS = 600;
/** Exit retries are spaced out (see EXIT_RETRY_BACKOFF_SEC) so a transient broker error cannot halt the trade in seconds. */
export const MAX_EXIT_RETRIES = 8;
export const EXIT_RETRY_BACKOFF_SEC = [5, 15, 30, 60, 60, 90, 120, 120];
/** A BUY with no trade row after this long is treated as abandoned and resolved. */
export const STALE_ENTRY_ORDER_MS = 120_000;
const CANCEL_SETTLE_MS = 6_000;
const FILL_PRICE_RETRIES = 4;

export type OrderPurpose =
    | 'ENTRY'
    | 'ADD_LOT'
    | 'EXIT'
    | 'PARTIAL_EXIT'
    | 'FLATTEN';

export type ConfirmedOrderResult = {
    ok: boolean;
    paper?: boolean;
    pending?: boolean;
    rejected?: boolean;
    timedOut?: boolean;
    /** The order was cancelled by us after a timeout. */
    cancelled?: boolean;
    /** Cancel was requested but Upstox has not settled the order yet. */
    stillPending?: boolean;
    /** Order filled only after our timeout / cancel request. */
    lateFill?: boolean;
    /** Order filled partially before being cancelled. */
    partialQty?: number;
    /** Broker returned no average price, so callers fall back to the quote. */
    priceEstimated?: boolean;
    orderId?: string;
    status?: string;
    averagePrice?: number;
    filledQty?: number;
    error?: any;
};

export type AuditCtx = {
    config: NiftyScalpConfig;
    instrumentKey: string;
    tradeId?: string | null;
    purpose: string;
    side: 'BUY' | 'SELL';
};

const normalizeStatus = (status?: string | null) =>
    String(status || '')
        .trim()
        .toLowerCase();

/** Exact status sets. Substring matching mis-read "partially filled" and "not cancelled". */
const FILLED_STATUSES = new Set([
    'complete',
    'completed',
    'filled',
    'traded',
    'fully executed',
    'success',
]);

export const isOrderFilled = (status?: string | null) =>
    FILLED_STATUSES.has(normalizeStatus(status));

export const isOrderRejected = (status?: string | null) => {
    const s = normalizeStatus(status);
    return (
        s.startsWith('rejected') ||
        s.startsWith('cancelled') ||
        s.startsWith('canceled') ||
        s.startsWith('failed') ||
        s.startsWith('expired')
    );
};

export const isOrderPending = (status?: string | null) => {
    if (!status) return true;
    return !isOrderFilled(status) && !isOrderRejected(status);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Human readable text out of the many shapes Upstox errors come in. */
export const errText = (e: any): string => {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    const nested = e?.error ?? e;
    const first = nested?.errors?.[0] ?? e?.errors?.[0];
    if (first?.message) {
        return `${first.errorCode ? `${first.errorCode}: ` : ''}${first.message}`;
    }
    if (typeof nested === 'string') return nested;
    if (nested?.message) return String(nested.message);
    try {
        return JSON.stringify(e).slice(0, 300);
    } catch {
        return String(e);
    }
};

const updateLocalOrderRow = async (
    orderId: string,
    patch: Record<string, unknown>,
) => {
    await db[MODEL.UPSTOCK_ORDERS].update(patch, {
        where: { upstock_order_id: orderId },
    });
};

const auditCtxBase = (ctx?: AuditCtx) =>
    ctx
        ? {
              instrumentKey: ctx.instrumentKey,
              tradeId: ctx.tradeId || undefined,
              config: ctx.config,
          }
        : {};

/**
 * Poll DB (WS updates) + Upstox REST until filled / rejected / timeout.
 * Never treats timeout as success in production.
 * Logs an ORDER_STATUS audit row every time the broker status changes.
 */
export const waitForOrderConfirmation = async ({
    orderId,
    accessToken,
    timeoutMs = ORDER_CONFIRM_TIMEOUT_MS,
    audit,
}: {
    orderId: string;
    accessToken: string;
    timeoutMs?: number;
    audit?: AuditCtx;
}): Promise<ConfirmedOrderResult> => {
    const started = Date.now();
    let lastLogged = '';

    const noteStatus = async (status: string, detail?: Record<string, unknown>) => {
        const s = normalizeStatus(status);
        if (!audit || !s || s === lastLogged) return;
        lastLogged = s;
        const waited = Date.now() - started;
        await logNiftyAudit({
            action: 'ORDER_STATUS',
            reason: `${audit.side}_${audit.purpose}_${s.toUpperCase().replace(/\s+/g, '_')}`.slice(
                0,
                120,
            ),
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                status: s,
                waitedMs: waited,
                ...detail,
                thinking: `Upstox order ${orderId} (${audit.side} ${audit.purpose}) reports "${s}" after ${waited}ms.`,
            },
        });
    };

    while (Date.now() - started < timeoutMs) {
        const row = await db[MODEL.UPSTOCK_ORDERS].findOne({
            where: { upstock_order_id: orderId },
        });
        const localStatus = row?.status;
        await noteStatus(localStatus);

        if (isOrderFilled(localStatus) && Number(row?.average_price || 0) > 0) {
            return {
                ok: true,
                orderId,
                status: normalizeStatus(localStatus),
                averagePrice: Number(row?.average_price || 0) || undefined,
                filledQty: Number(row?.filled_quantity || 0) || undefined,
            };
        }
        if (isOrderRejected(localStatus)) {
            return {
                ok: false,
                rejected: true,
                orderId,
                status: normalizeStatus(localStatus),
                error: row?.rejection_reason || localStatus,
            };
        }

        const remote = await get_upstox_order_details(accessToken, orderId);
        if (remote) {
            await updateLocalOrderRow(orderId, {
                status: remote.status || localStatus || 'Pending',
                average_price: remote.average_price || row?.average_price,
                filled_quantity:
                    remote.filled_quantity || row?.filled_quantity || 0,
                ...(isOrderRejected(remote.status)
                    ? {
                          rejection_reason:
                              remote.status_message || remote.status,
                      }
                    : {}),
            });
            await noteStatus(remote.status, {
                filledQty: remote.filled_quantity,
                avgPrice: remote.average_price,
                brokerMessage: remote.status_message,
            });

            if (isOrderFilled(remote.status)) {
                return {
                    ok: true,
                    orderId,
                    status: normalizeStatus(remote.status),
                    averagePrice: remote.average_price || undefined,
                    filledQty: remote.filled_quantity || undefined,
                };
            }
            if (isOrderRejected(remote.status)) {
                return {
                    ok: false,
                    rejected: true,
                    orderId,
                    status: normalizeStatus(remote.status),
                    error: remote.status_message || remote.status,
                };
            }
        }

        await sleep(ORDER_POLL_MS);
    }

    return {
        ok: false,
        pending: true,
        timedOut: true,
        orderId,
        status: 'pending_timeout',
        error: 'ORDER_CONFIRM_TIMEOUT',
    };
};

/** A filled order with no average price: ask Upstox again a few times. */
const resolveFillPrice = async (
    confirmed: ConfirmedOrderResult,
    accessToken: string,
): Promise<ConfirmedOrderResult> => {
    if (!confirmed.ok || !confirmed.orderId) return confirmed;
    if (confirmed.averagePrice && confirmed.averagePrice > 0) return confirmed;
    for (let i = 0; i < FILL_PRICE_RETRIES; i += 1) {
        await sleep(500);
        const remote = await get_upstox_order_details(
            accessToken,
            confirmed.orderId,
        );
        if (remote?.average_price && remote.average_price > 0) {
            await updateLocalOrderRow(confirmed.orderId, {
                average_price: remote.average_price,
                filled_quantity: remote.filled_quantity || 0,
            });
            return {
                ...confirmed,
                averagePrice: remote.average_price,
                filledQty: remote.filled_quantity || confirmed.filledQty,
            };
        }
    }
    return { ...confirmed, priceEstimated: true };
};

/**
 * A BUY that was not confirmed in time. Never leave it working at the broker:
 * cancel it, then read the final state so a late fill is never lost.
 *   filled      -> ok:true, lateFill:true (caller records the trade normally)
 *   partial     -> ok:false, partialQty (caller flattens the stray quantity)
 *   cancelled   -> ok:false, rejected+cancelled (nothing at the broker)
 *   unsettled   -> ok:false, stillPending (row marked ENTRY_ORPHAN for adoption)
 */
export const cancelAndResolveBuy = async ({
    orderId,
    accessToken,
    audit,
    markOrphanOnPending = true,
}: {
    orderId: string;
    accessToken: string;
    audit: AuditCtx;
    markOrphanOnPending?: boolean;
}): Promise<ConfirmedOrderResult> => {
    const cancel = await cancel_upstox_order(accessToken, orderId);
    await logNiftyAudit({
        action: 'ORDER_CANCEL',
        reason: cancel.ok ? 'CANCEL_REQUESTED' : 'CANCEL_REQUEST_FAILED',
        ...auditCtxBase(audit),
        skipThrottle: true,
        metadata: {
            orderId,
            cancel,
            thinking: cancel.ok
                ? `BUY ${orderId} was not confirmed in time. I asked Upstox to cancel it so it cannot fill later without a stop-loss.`
                : `BUY ${orderId} was not confirmed in time and the cancel request failed (${errText(cancel.error)}). It may already be filled; re-reading its state.`,
        },
    });

    const started = Date.now();
    let remote = await get_upstox_order_details(accessToken, orderId);
    while (
        Date.now() - started < CANCEL_SETTLE_MS &&
        remote &&
        isOrderPending(remote.status)
    ) {
        await sleep(500);
        remote = await get_upstox_order_details(accessToken, orderId);
    }

    const filledQty = Number(remote?.filled_quantity || 0);
    const avg = Number(remote?.average_price || 0) || undefined;
    const status = normalizeStatus(remote?.status);

    if (remote) {
        await updateLocalOrderRow(orderId, {
            status: remote.status || 'Pending',
            average_price: remote.average_price || undefined,
            filled_quantity: filledQty,
        });
    }

    if (remote && isOrderFilled(remote.status)) {
        await logNiftyAudit({
            action: 'ORDER_FILLED',
            reason: 'FILLED_DURING_CANCEL',
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                avgPrice: avg,
                filledQty,
                thinking: `The BUY filled while I was cancelling it (avg ${avg}). Treating it as a normal entry so the trade is managed.`,
            },
        });
        return {
            ok: true,
            lateFill: true,
            orderId,
            status,
            averagePrice: avg,
            filledQty,
        };
    }

    if (remote && isOrderRejected(remote.status)) {
        if (filledQty > 0) {
            return {
                ok: false,
                rejected: true,
                cancelled: true,
                partialQty: filledQty,
                orderId,
                status,
                averagePrice: avg,
                filledQty,
                error: 'PARTIAL_FILL_THEN_CANCELLED',
            };
        }
        await logNiftyAudit({
            action: 'ORDER_REJECTED',
            reason: 'CANCELLED_NOTHING_FILLED',
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                status,
                thinking: `BUY ${orderId} is "${status}" with nothing filled. No position at Upstox, no trade created.`,
            },
        });
        return {
            ok: false,
            rejected: true,
            cancelled: true,
            orderId,
            status,
            error: 'CANCELLED_NO_FILL',
        };
    }

    // Upstox has not settled it (or we could not read it).
    if (markOrphanOnPending && audit.purpose === 'ENTRY') {
        await db[MODEL.UPSTOCK_ORDERS].update(
            { purpose: 'ENTRY_ORPHAN' },
            {
                where: {
                    upstock_order_id: orderId,
                    trade_id: null,
                },
            },
        );
    }
    await logNiftyAudit({
        action: 'ORDER_TIMEOUT',
        reason: 'CANCEL_NOT_SETTLED',
        ...auditCtxBase(audit),
        skipThrottle: true,
        metadata: {
            orderId,
            status: status || 'unknown',
            thinking: `BUY ${orderId} is still "${status || 'unknown'}" after the cancel request. Marked as ENTRY_ORPHAN: if it fills, the order watcher adopts it as a managed trade; the 3-minute reconcile keeps checking.`,
        },
    });
    notifyNiftyEvent(
        'LIVE_ORDER_FAIL',
        'BUY order not settled after cancel — watching it. Check Upstox.',
        { orderId },
    );
    return {
        ok: false,
        pending: true,
        timedOut: true,
        stillPending: true,
        orderId,
        status: status || 'pending_timeout',
        error: 'CANCEL_NOT_SETTLED',
    };
};

/**
 * Place market order and wait for broker confirmation.
 * Paper mode short-circuits with ok=true paper=true (no Upstox call)
 * unless forceLive: closing a trade that was entered live must reach Upstox
 * even if the live switch was turned off afterwards.
 */
export const placeConfirmedUpstoxOrder = async ({
    user,
    config,
    instrumentKey,
    quantity,
    side,
    purpose,
    positionId,
    tradeId,
    why,
    forceLive,
    onOrderPlaced,
}: {
    user: any;
    config: NiftyScalpConfig;
    instrumentKey: string;
    quantity: number;
    side: 'BUY' | 'SELL';
    purpose: OrderPurpose;
    positionId?: string | null;
    tradeId?: string | null;
    /** Plain-language reason shown in the audit log. */
    why?: string;
    forceLive?: boolean;
    /** Called as soon as Upstox returns an order id (before confirmation). */
    onOrderPlaced?: (orderId: string) => Promise<void>;
}): Promise<ConfirmedOrderResult> => {
    if (!forceLive && !isLiveTradingEnabled(user, config)) {
        return { ok: true, paper: true };
    }

    const audit: AuditCtx = {
        config,
        instrumentKey,
        tradeId,
        purpose,
        side,
    };

    if (!user?.token) {
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: 'NO_UPSTOX_TOKEN',
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                purpose,
                side,
                thinking:
                    'No Upstox access token on the user. Login to Upstox again. No order was sent.',
            },
        });
        notifyNiftyEvent('LIVE_ORDER_FAIL', 'No Upstox token — cannot trade live', {
            purpose,
            side,
        });
        return { ok: false, rejected: true, error: 'NO_UPSTOX_TOKEN' };
    }

    await logNiftyAudit({
        action: 'ORDER_PLACING',
        reason: `${side}_${purpose}`,
        ...auditCtxBase(audit),
        skipThrottle: true,
        metadata: {
            quantity,
            side,
            purpose,
            orderType: 'MARKET',
            thinking: `Sending LIVE ${side} MARKET order to Upstox: ${quantity} qty. ${why ? `Why: ${why}` : ''}`.trim(),
        },
    });

    const placedAt = Date.now();
    const orderPlaced = await place_order_on_upstocks({
        instrument_key: instrumentKey,
        accessToken: user.token,
        quantity,
        transaction_type: side,
        tag: `nifty-${purpose.toLowerCase()}`,
    });

    const orderIds: string[] = orderPlaced?.data?.order_ids || [];
    const placedOk =
        orderPlaced?.status === 'success' && orderIds.length > 0;

    if (!placedOk) {
        const why2 = errText(orderPlaced?.error ?? orderPlaced);
        await logNiftyAudit({
            action: 'ORDER_REJECTED',
            reason: `${side}_PLACE_REJECTED`,
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                purpose,
                brokerError: why2,
                orderPlaced,
                thinking: `Upstox refused the ${side} order at placement: ${why2}. No order exists at the broker.`,
            },
        });
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            `${side} place rejected by Upstox (${purpose}): ${why2}`,
            { instrumentKey, purpose, orderPlaced },
        );
        return {
            ok: false,
            rejected: true,
            error: why2 || 'PLACE_FAILED',
        };
    }

    const orderId = String(orderIds[0]);
    await db[MODEL.UPSTOCK_ORDERS].create({
        upstock_order_id: orderId,
        postion_id: positionId || null,
        trade_id: tradeId || null,
        order_type: side,
        status: 'Pending',
        purpose,
        instrument_key: instrumentKey,
        quantity,
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        filled_quantity: 0,
    });

    // Persist the order id immediately so an overlapping tick or a restart
    // can see the order exists (prevents a double SELL).
    if (onOrderPlaced) {
        try {
            await onOrderPlaced(orderId);
        } catch (err: any) {
            logger.error(`onOrderPlaced failed: ${err?.message || err}`);
        }
    }

    await logNiftyAudit({
        action: 'ORDER_PLACED',
        reason: `${side}_${purpose}_ACCEPTED`,
        ...auditCtxBase(audit),
        skipThrottle: true,
        metadata: {
            orderId,
            quantity,
            latencyMs: Date.now() - placedAt,
            thinking: `Upstox accepted the ${side} order (id ${orderId}). Now waiting up to ${ORDER_CONFIRM_TIMEOUT_MS / 1000}s for the exchange to confirm a fill.`,
        },
    });

    let confirmed = await waitForOrderConfirmation({
        orderId,
        accessToken: user.token,
        audit,
    });

    if (confirmed.ok) {
        confirmed = await resolveFillPrice(confirmed, user.token);
        await logNiftyAudit({
            action: 'ORDER_FILLED',
            reason: `${side}_${purpose}_FILLED`,
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                avgPrice: confirmed.averagePrice,
                filledQty: confirmed.filledQty,
                priceEstimated: Boolean(confirmed.priceEstimated),
                totalMs: Date.now() - placedAt,
                thinking: confirmed.priceEstimated
                    ? `Order ${orderId} is filled but Upstox gave no average price. The quote price is used for now and the portfolio feed will correct it.`
                    : `Order ${orderId} filled at average ${confirmed.averagePrice} in ${Date.now() - placedAt}ms. This price is used for the trade.`,
            },
        });
        return confirmed;
    }

    if (confirmed.timedOut) {
        await logNiftyAudit({
            action: 'ORDER_TIMEOUT',
            reason: `${side}_${purpose}_CONFIRM_TIMEOUT`,
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                thinking:
                    side === 'BUY'
                        ? `No fill confirmation within ${ORDER_CONFIRM_TIMEOUT_MS / 1000}s. A BUY must not stay working at the broker without a stop-loss, so I will cancel it.`
                        : `No fill confirmation within ${ORDER_CONFIRM_TIMEOUT_MS / 1000}s. The SELL stays working; the trade stays OPEN and no second SELL is sent while this one is alive.`,
            },
        });

        if (side === 'BUY') {
            const resolved = await cancelAndResolveBuy({
                orderId,
                accessToken: user.token,
                audit,
            });
            if (resolved.ok) {
                return resolveFillPrice(resolved, user.token);
            }
            if (resolved.partialQty && resolved.partialQty > 0) {
                // Only part of the quantity bought: it cannot be tracked as a
                // trade, so sell it straight back.
                await flattenStrayQuantity({
                    user,
                    config,
                    instrumentKey,
                    quantity: resolved.partialQty,
                    why: `BUY ${orderId} filled only ${resolved.partialQty} of ${quantity} before it was cancelled.`,
                });
            }
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                resolved.partialQty
                    ? `BUY partially filled (${resolved.partialQty}) then cancelled`
                    : 'BUY confirmation timeout — cancelled',
                { instrumentKey, purpose, orderId },
            );
            return resolved;
        }
    } else {
        await logNiftyAudit({
            action: 'ORDER_REJECTED',
            reason: `${side}_${purpose}_REJECTED`,
            ...auditCtxBase(audit),
            skipThrottle: true,
            metadata: {
                orderId,
                status: confirmed.status,
                brokerMessage: errText(confirmed.error),
                thinking: `Upstox ${confirmed.status} the ${side} order ${orderId}: ${errText(confirmed.error)}. ${
                    side === 'BUY'
                        ? 'Nothing was bought, so no trade is created.'
                        : 'The position is still held, so the trade stays OPEN and the exit will be retried.'
                }`,
            },
        });
    }

    notifyNiftyEvent(
        'LIVE_ORDER_FAIL',
        confirmed.timedOut
            ? `${side} confirmation timeout — NOT treating as filled`
            : `${side} rejected/failed on Upstox: ${errText(confirmed.error)}`,
        { instrumentKey, purpose, orderId, confirmed },
    );

    return confirmed;
};

/**
 * Sell a quantity that should not exist (partial fill of a cancelled BUY,
 * or a fill that cannot be tracked as a trade). Never leave it unmanaged.
 */
export const flattenStrayQuantity = async ({
    user,
    config,
    instrumentKey,
    quantity,
    why,
}: {
    user: any;
    config: NiftyScalpConfig;
    instrumentKey: string;
    quantity: number;
    why: string;
}): Promise<boolean> => {
    if (!(quantity > 0)) return true;
    const result = await placeConfirmedUpstoxOrder({
        user,
        config,
        instrumentKey,
        quantity,
        side: 'SELL',
        purpose: 'FLATTEN',
        why,
        forceLive: true,
    });
    await logNiftyAudit({
        action: 'SAFETY_CHECK',
        reason: result.ok ? 'STRAY_QTY_FLATTENED' : 'STRAY_QTY_FLATTEN_FAILED',
        instrumentKey,
        config,
        skipThrottle: true,
        metadata: {
            quantity,
            result,
            thinking: result.ok
                ? `Stray ${quantity} qty was sold at Upstox so no unmanaged position remains.`
                : `Could not sell the stray ${quantity} qty (${errText(result.error)}). SQUARE OFF MANUALLY ON UPSTOX.`,
        },
    });
    if (!result.ok) {
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            `Stray ${quantity} qty could not be sold — square off manually on Upstox`,
            { instrumentKey, quantity },
        );
    }
    return result.ok;
};

/**
 * Resolve BUY orders that have no trade after STALE_ENTRY_ORDER_MS
 * (timeout, crash, restart). Fills are adopted as managed trades; anything
 * still working is cancelled. Called from the reconcile cron.
 */
export const resolveStaleEntryOrders = async ({
    user,
    config,
}: {
    user: any;
    config: NiftyScalpConfig;
}) => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const rows = await db[MODEL.UPSTOCK_ORDERS].findAll({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            order_type: 'BUY',
            trade_id: null,
            purpose: { [Op.in]: ['ENTRY', 'ENTRY_ORPHAN'] },
            createdAt: {
                [Op.gte]: dayStart,
                [Op.lte]: new Date(Date.now() - STALE_ENTRY_ORDER_MS),
            },
        },
        order: [['createdAt', 'ASC']],
        limit: 10,
    });

    for (const row of rows) {
        if (isOrderRejected(row.status) && Number(row.filled_quantity || 0) <= 0) {
            continue;
        }
        const orderId = String(row.upstock_order_id);
        const audit: AuditCtx = {
            config,
            instrumentKey: row.instrument_key,
            purpose: 'ENTRY',
            side: 'BUY',
        };
        let remote = await get_upstox_order_details(user.token, orderId);
        if (!remote) continue;

        if (isOrderPending(remote.status)) {
            const resolved = await cancelAndResolveBuy({
                orderId,
                accessToken: user.token,
                audit,
                markOrphanOnPending: true,
            });
            remote = (await get_upstox_order_details(user.token, orderId)) || remote;
            if (!resolved.ok && !resolved.partialQty) continue;
        }

        const filledQty = Number(remote.filled_quantity || 0);
        if (!isOrderFilled(remote.status) && filledQty <= 0) continue;

        await db[MODEL.UPSTOCK_ORDERS].update(
            { purpose: 'ENTRY_ORPHAN' },
            { where: { id: row.id, trade_id: null } },
        );
        await logNiftyAudit({
            action: 'RECONCILE',
            reason: 'STALE_BUY_HAS_FILL',
            instrumentKey: row.instrument_key,
            config,
            skipThrottle: true,
            metadata: {
                orderId,
                status: remote.status,
                filledQty,
                avgPrice: remote.average_price,
                thinking: `Order ${orderId} is a BUY with no trade row but Upstox says it filled (${filledQty} qty @ ${remote.average_price}). Adopting it so it gets a stop-loss and exit.`,
            },
        });
        await handleNiftyOrderStatusUpdate({
            order_id: orderId,
            status: isOrderFilled(remote.status) ? remote.status : 'cancelled',
            average_price: remote.average_price,
            filled_quantity: filledQty,
            status_message: remote.status_message || remote.status,
        });
    }
};

/**
 * Portfolio WS / REST status updates — drive trade lifecycle.
 * Never closes a live trade as paper when Upstox fails.
 */
export const handleNiftyOrderStatusUpdate = async (orderData: any) => {
    const orderId = String(
        orderData?.order_id || orderData?.orderId || '',
    );
    if (!orderId) return;

    const status = normalizeStatus(
        orderData?.status || orderData?.order_status,
    );
    const averagePrice = Number(
        orderData?.average_price ?? orderData?.avg_price ?? 0,
    );
    const filledQty = Number(
        orderData?.filled_quantity ?? orderData?.filled_qty ?? 0,
    );
    const rejectionReason =
        orderData?.status_message ||
        orderData?.rejection_reason ||
        orderData?.message ||
        null;

    const row = await db[MODEL.UPSTOCK_ORDERS].findOne({
        where: { upstock_order_id: orderId },
    });
    if (!row) return;

    const prevStatus = row.status;
    await row.update({
        status: status || row.status,
        average_price: averagePrice || row.average_price,
        filled_quantity: filledQty || row.filled_quantity,
        rejection_reason: isOrderRejected(status)
            ? rejectionReason || status
            : row.rejection_reason,
    });

    const purpose = String(row.purpose || '').toUpperCase();
    const configRow = await db[MODEL.STRATEGY_CONFIG].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    const config = configRow?.get({ plain: true }) as NiftyScalpConfig;

    // BUY we gave up on (timeout / restart) that has now filled: adopt it.
    if (!row.trade_id) {
        if (purpose === 'ENTRY_ORPHAN' && (isOrderFilled(status) || filledQty > 0)) {
            const { adoptOrphanEntryFill } = await import(
                './nifty.scalp.trade.helper'
            );
            await adoptOrphanEntryFill({
                orderRow: row,
                averagePrice: averagePrice || Number(row.average_price || 0),
                filledQty: filledQty || Number(row.filled_quantity || 0),
                config,
            });
        }
        return;
    }

    const trade = await db[MODEL.TRADE].findByPk(row.trade_id);
    if (!trade || trade.strategy_name !== STRATEGY.NIFTY_OPTIONS_SCALP) {
        return;
    }

    if (isOrderFilled(status)) {
        if (purpose === 'ENTRY' || purpose === 'ADD_LOT') {
            // ADD_LOT fill price is one lot, not the position average.
            const keepAverage =
                purpose === 'ADD_LOT' || Number(trade.qty) > 1;
            const oldBuy = Number(trade.buy_price);
            const priceChanged =
                !keepAverage &&
                averagePrice > 0 &&
                Math.abs(averagePrice - oldBuy) > 0.004;
            await trade.update({
                broker_confirmed: true,
                order_lifecycle: 'OPEN',
                ...(keepAverage
                    ? {}
                    : {
                          buy_price:
                              averagePrice > 0 ? averagePrice : trade.buy_price,
                          ...(priceChanged && config
                              ? {
                                    target_price: calculateTargetLtp(
                                        averagePrice,
                                        Number(trade.qty),
                                        Number(trade.lot_size),
                                        config,
                                    ),
                                    highest_ltp: Math.max(
                                        Number(trade.highest_ltp || 0),
                                        averagePrice,
                                    ),
                                }
                              : {}),
                      }),
                last_order_error: null,
            });
            if (priceChanged) {
                await logNiftyAudit({
                    action: 'PRICE_CORRECTED',
                    reason: 'ENTRY_PRICE_FROM_BROKER',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        orderId,
                        oldBuyPrice: oldBuy,
                        newBuyPrice: averagePrice,
                        thinking: `Upstox's final average price ${averagePrice} differs from the price first recorded (${oldBuy}). Entry price and target were corrected to the real fill.`,
                    },
                });
            }
            if (purpose === 'ENTRY') {
                const position = await db[MODEL.POSITION].findByPk(
                    trade.position_id,
                );
                if (position) {
                    await position.update({ is_upstock_exectued: true });
                }
            }
        }

        if (
            (purpose === 'EXIT' || purpose === 'PARTIAL_EXIT') &&
            trade.exit_pending
        ) {
            // closeNiftyScalpTrade normally finalizes; if it gave up waiting
            // (timeout), finalize now that Upstox confirmed the fill.
            const { finalizeNiftyExitAfterBrokerFill, isExitInFlight } =
                await import('./nifty.scalp.trade.helper');
            if (!isExitInFlight(trade.id)) {
                await logNiftyAudit({
                    action: 'ORDER_FILLED',
                    reason: 'EXIT_FILLED_VIA_FEED',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        orderId,
                        avgPrice: averagePrice,
                        thinking: `The portfolio feed reports the SELL ${orderId} filled at ${averagePrice} (after the engine stopped waiting). Closing the trade with this real price.`,
                    },
                });
                await finalizeNiftyExitAfterBrokerFill({
                    trade,
                    sellPrice:
                        averagePrice > 0 ? averagePrice : Number(trade.ltp),
                    orderId,
                });
            }
        }

        if (
            purpose === 'EXIT' &&
            !trade.is_active &&
            averagePrice > 0 &&
            Math.abs(averagePrice - Number(trade.sell_price || 0)) > 0.004
        ) {
            const { correctClosedTradeExitPrice } = await import(
                './nifty.scalp.trade.helper'
            );
            await correctClosedTradeExitPrice({
                trade,
                brokerPrice: averagePrice,
                orderId,
                config,
            });
        }
        return;
    }

    if (isOrderRejected(status)) {
        if (purpose === 'ENTRY' && trade.is_active && !trade.broker_confirmed) {
            await trade.update({
                is_active: false,
                order_lifecycle: 'FAILED',
                exit_reason: 'LIVE_BUY_REJECTED',
                last_order_error: rejectionReason || status,
                broker_confirmed: false,
            });
            const position = await db[MODEL.POSITION].findByPk(
                trade.position_id,
            );
            if (position) {
                await position.update({
                    is_active: false,
                    is_upstock_exectued: false,
                });
            }
            await logNiftyAudit({
                action: 'ORDER_REJECTED',
                reason: 'ENTRY_REJECTED_VIA_FEED',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                skipThrottle: true,
                metadata: {
                    orderId,
                    status,
                    brokerMessage: rejectionReason,
                    thinking: `Upstox ${status} the entry order. The trade was cancelled and is not counted as a win or loss.`,
                },
            });
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                'Entry order rejected — trade cancelled (not paper-closed as win)',
                { orderId, tradeId: trade.id },
            );
        }

        if (purpose === 'EXIT' || purpose === 'PARTIAL_EXIT') {
            const { markExitRetry, isExitInFlight } = await import(
                './nifty.scalp.trade.helper'
            );
            // If closeNiftyScalpTrade is waiting on this order it handles the
            // rejection itself (and counts the retry). Otherwise count it here.
            const alreadyCounted = isOrderRejected(prevStatus);
            const staleOrder =
                purpose === 'EXIT' &&
                trade.exit_order_id &&
                String(trade.exit_order_id) !== orderId;
            if (
                trade.is_active &&
                !isExitInFlight(trade.id) &&
                !alreadyCounted &&
                !staleOrder &&
                config
            ) {
                await trade.update({
                    exit_order_id:
                        purpose === 'EXIT' ? null : trade.exit_order_id,
                });
                await markExitRetry(
                    trade,
                    rejectionReason || status,
                    config,
                );
            }
        }
    }
};
