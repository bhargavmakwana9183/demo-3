import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import {
    get_upstox_order_details,
    place_order_on_upstocks,
} from './upstocks.apis';
import { isLiveTradingEnabled } from './scalping.trade.helper';
import { NiftyScalpConfig } from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';

export const ORDER_CONFIRM_TIMEOUT_MS = 25_000;
export const ORDER_POLL_MS = 600;
export const MAX_EXIT_RETRIES = 5;

export type OrderPurpose = 'ENTRY' | 'ADD_LOT' | 'EXIT' | 'PARTIAL_EXIT';

export type ConfirmedOrderResult = {
    ok: boolean;
    paper?: boolean;
    pending?: boolean;
    rejected?: boolean;
    timedOut?: boolean;
    orderId?: string;
    status?: string;
    averagePrice?: number;
    filledQty?: number;
    error?: any;
};

const normalizeStatus = (status?: string | null) =>
    String(status || '')
        .trim()
        .toLowerCase();

export const isOrderFilled = (status?: string | null) => {
    const s = normalizeStatus(status);
    return [
        'complete',
        'completed',
        'filled',
        'success',
        'traded',
        'fully executed',
    ].some((x) => s === x || s.includes(x));
};

export const isOrderRejected = (status?: string | null) => {
    const s = normalizeStatus(status);
    return [
        'rejected',
        'cancelled',
        'canceled',
        'failed',
        'expired',
        'not modified',
    ].some((x) => s === x || s.includes(x));
};

export const isOrderPending = (status?: string | null) => {
    if (!status) return true;
    if (isOrderFilled(status) || isOrderRejected(status)) return false;
    return true;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const updateLocalOrderRow = async (
    orderId: string,
    patch: Record<string, unknown>,
) => {
    await db[MODEL.UPSTOCK_ORDERS].update(patch, {
        where: { upstock_order_id: orderId },
    });
};

/**
 * Poll DB (WS updates) + Upstox REST until filled / rejected / timeout.
 * Never treats timeout as success in production.
 */
export const waitForOrderConfirmation = async ({
    orderId,
    accessToken,
    timeoutMs = ORDER_CONFIRM_TIMEOUT_MS,
}: {
    orderId: string;
    accessToken: string;
    timeoutMs?: number;
}): Promise<ConfirmedOrderResult> => {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const row = await db[MODEL.UPSTOCK_ORDERS].findOne({
            where: { upstock_order_id: orderId },
        });
        const localStatus = row?.status;

        if (isOrderFilled(localStatus)) {
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
                await updateLocalOrderRow(orderId, {
                    rejection_reason: remote.status,
                });
                return {
                    ok: false,
                    rejected: true,
                    orderId,
                    status: normalizeStatus(remote.status),
                    error: remote.status,
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

/**
 * Place market order and wait for broker confirmation.
 * Paper mode short-circuits with ok=true paper=true (no Upstox call).
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
}: {
    user: any;
    config: NiftyScalpConfig;
    instrumentKey: string;
    quantity: number;
    side: 'BUY' | 'SELL';
    purpose: OrderPurpose;
    positionId?: string | null;
    tradeId?: string | null;
}): Promise<ConfirmedOrderResult> => {
    if (!isLiveTradingEnabled(user, config)) {
        return { ok: true, paper: true };
    }
    if (!user?.token) {
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: 'NO_UPSTOX_TOKEN',
            instrumentKey,
            config,
            metadata: { purpose, side },
        });
        notifyNiftyEvent('LIVE_ORDER_FAIL', 'No Upstox token — cannot trade live', {
            purpose,
            side,
        });
        return { ok: false, rejected: true, error: 'NO_UPSTOX_TOKEN' };
    }

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
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: `${side}_PLACE_REJECTED`,
            instrumentKey,
            tradeId: tradeId || undefined,
            config,
            metadata: { purpose, orderPlaced },
        });
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            `${side} place rejected by Upstox (${purpose})`,
            { instrumentKey, purpose, orderPlaced },
        );
        return {
            ok: false,
            rejected: true,
            error: orderPlaced?.error || orderPlaced || 'PLACE_FAILED',
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

    const confirmed = await waitForOrderConfirmation({
        orderId,
        accessToken: user.token,
    });

    if (confirmed.ok) {
        return confirmed;
    }

    await logNiftyAudit({
        action: 'LIVE_ORDER_FAIL',
        reason: confirmed.timedOut
            ? `${side}_CONFIRM_TIMEOUT`
            : `${side}_REJECTED_OR_FAILED`,
        instrumentKey,
        tradeId: tradeId || undefined,
        config,
        metadata: { purpose, confirmed },
        skipThrottle: true,
    });
    notifyNiftyEvent(
        'LIVE_ORDER_FAIL',
        confirmed.timedOut
            ? `${side} confirmation timeout — NOT treating as filled`
            : `${side} rejected/failed on Upstox`,
        { instrumentKey, purpose, orderId, confirmed },
    );

    return confirmed;
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

    await row.update({
        status: status || row.status,
        average_price: averagePrice || row.average_price,
        filled_quantity: filledQty || row.filled_quantity,
        rejection_reason: isOrderRejected(status)
            ? rejectionReason || status
            : row.rejection_reason,
    });

    if (!row.trade_id) return;

    const trade = await db[MODEL.TRADE].findByPk(row.trade_id);
    if (!trade || trade.strategy_name !== STRATEGY.NIFTY_OPTIONS_SCALP) {
        return;
    }

    const purpose = String(row.purpose || '').toUpperCase();

    if (isOrderFilled(status)) {
        if (purpose === 'ENTRY' || purpose === 'ADD_LOT') {
            await trade.update({
                broker_confirmed: true,
                order_lifecycle: 'OPEN',
                buy_price:
                    averagePrice > 0 ? averagePrice : trade.buy_price,
                last_order_error: null,
            });
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
            // Finalize close is done by closeNiftyScalpTrade wait path;
            // if still pending (timeout earlier), finalize now.
            const { finalizeNiftyExitAfterBrokerFill } = await import(
                './nifty.scalp.trade.helper'
            );
            await finalizeNiftyExitAfterBrokerFill({
                trade,
                sellPrice: averagePrice > 0 ? averagePrice : Number(trade.ltp),
                orderId,
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
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                'Entry order rejected — trade cancelled (not paper-closed as win)',
                { orderId, tradeId: trade.id },
            );
        }

        if (purpose === 'EXIT' || purpose === 'PARTIAL_EXIT') {
            // Keep trade OPEN — engine/reconcile retries. Do not paper-close.
            await trade.update({
                exit_pending: true,
                order_lifecycle: 'EXIT_PENDING',
                last_order_error: rejectionReason || status,
                is_active: true,
                // Clear rejected exit id so next retry can place a fresh SELL
                exit_order_id:
                    purpose === 'EXIT' ? null : trade.exit_order_id,
            });
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                `Exit ${status} on Upstox — trade stays OPEN (will retry)`,
                { orderId, tradeId: trade.id },
            );
        }
    }
};
