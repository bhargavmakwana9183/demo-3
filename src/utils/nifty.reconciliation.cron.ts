import cron from 'node-cron';
import { MODEL, STRATEGY, USER_DETAILS } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { getCurrentISTDate } from '../helpers/stock.helper';
import { buildMarketTime } from '../helpers/scalping.risk.helper';
import { getUpstoxPositionsOrNull } from '../helpers/scalping.reconciliation.helper';
import { getNiftyScalpConfig } from '../helpers/nifty.scalp.config.helper';
import { logNiftyAudit } from '../helpers/nifty.scalp.audit.helper';
import { notifyNiftyEvent } from '../helpers/nifty.scalp.notify.helper';
import {
    isOrderFilled,
    isOrderPending,
    isOrderRejected,
    resolveStaleEntryOrders,
} from '../helpers/nifty.scalp.order.helper';
import { get_upstox_order_details } from '../helpers/upstocks.apis';
import {
    finalizeNiftyExitAfterBrokerFill,
    isExitInFlight,
} from '../helpers/nifty.scalp.trade.helper';
import { handleNiftyOrderStatusUpdate } from '../helpers/nifty.scalp.order.helper';

/** A trade must look flat at the broker this many runs in a row before the DB is closed. */
const FLAT_CONFIRMATIONS = 2;
/** Positions can lag a new fill; do not judge a trade younger than this. */
const MIN_TRADE_AGE_MS = 2 * 60 * 1000;
const flatSeen = new Map<string, number>();

/**
 * Reconcile Nifty live positions: Upstox portfolio vs DB.
 * Never paper-closes a still-open broker position.
 * If broker is already flat while DB says open → finalize DB close (fill already happened).
 * A FAILED positions call is "unknown", never "flat".
 */
export const reconcileNiftyOrders = async (): Promise<void> => {
    const config = await getNiftyScalpConfig();

    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });
    if (!user?.token) return;

    const openLivePositions = await db[MODEL.POSITION].count({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
            is_upstock_exectued: true,
        },
    });
    const liveSwitchedOn = config.mode === 'live' && user.is_live;
    // A live trade must keep being reconciled even if live was switched off.
    if (!liveSwitchedOn && openLivePositions === 0) return;
    if (!config.is_active && openLivePositions === 0) return;

    const currentISTDate = getCurrentISTDate();
    const formattedDate = currentISTDate.toISOString().slice(0, 10);
    const startTime = buildMarketTime(
        formattedDate,
        config.market_start_time,
    );
    const endTime = buildMarketTime(formattedDate, config.market_end_time);
    // Allow a short post-market window for pending settles
    const endPlus = new Date(endTime.getTime() + 30 * 60 * 1000);
    if (currentISTDate < startTime || currentISTDate > endPlus) return;

    const summary = {
        pendingOrdersChecked: 0,
        activeTrades: 0,
        brokerPositions: 0 as number | null,
        closedFlat: 0,
        exitFinalized: 0,
        qtyMismatch: 0,
        unknownBrokerPositions: 0,
        positionsFetchFailed: false,
    };

    // BUY orders that lost their trade (timeout / crash): adopt fills, cancel the rest.
    try {
        await resolveStaleEntryOrders({ user, config });
    } catch (err: any) {
        logger.error(`resolveStaleEntryOrders failed: ${err?.message || err}`);
    }

    // Refresh pending Upstox order rows via REST
    const pendingOrders = await db[MODEL.UPSTOCK_ORDERS].findAll({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        },
        order: [['updatedAt', 'DESC']],
        limit: 40,
    });

    for (const row of pendingOrders) {
        if (!isOrderPending(row.status)) continue;
        const remote = await get_upstox_order_details(
            user.token,
            String(row.upstock_order_id),
        );
        if (!remote) continue;
        summary.pendingOrdersChecked += 1;
        await handleNiftyOrderStatusUpdate({
            order_id: row.upstock_order_id,
            status: remote.status,
            average_price: remote.average_price,
            filled_quantity: remote.filled_quantity,
            status_message: remote.status_message || remote.status,
        });
    }

    const brokerPositions = await getUpstoxPositionsOrNull(user.token);
    const activeTrades = await db[MODEL.TRADE].findAll({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
        },
    });
    summary.activeTrades = activeTrades.length;

    if (brokerPositions == null) {
        // Unknown is not flat. Do not touch any trade based on a failed call.
        summary.brokerPositions = null;
        summary.positionsFetchFailed = true;
        flatSeen.clear();
        await logNiftyAudit({
            action: 'RECONCILE',
            reason: 'POSITIONS_FETCH_FAILED',
            config,
            skipThrottle: true,
            metadata: {
                ...summary,
                thinking:
                    'Could not read positions from Upstox (token expired, network or rate limit). I do NOT treat that as "broker is flat", so no trade was closed or changed this run. Will retry in 3 minutes.',
            },
        });
        if (activeTrades.length > 0) {
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                'Reconcile: cannot read Upstox positions — check token/login',
                { activeTrades: activeTrades.length },
            );
        }
        return;
    }

    const brokerByKey = new Map<string, number>();
    for (const p of brokerPositions) {
        if (p.quantity === 0) continue;
        brokerByKey.set(
            p.instrument_key,
            (brokerByKey.get(p.instrument_key) || 0) + p.quantity,
        );
    }
    summary.brokerPositions = brokerByKey.size;

    for (const trade of activeTrades) {
        const brokerQty = brokerByKey.get(trade.instrument_key) ?? 0;
        const expectedQty = Number(trade.lot_size) * Number(trade.qty);
        const tradeKey = String(trade.id);
        const ageMs = Date.now() - new Date(trade.createdAt).getTime();

        // The engine is placing or waiting on this trade's SELL right now.
        if (isExitInFlight(trade.id)) continue;

        // Exit order filled but trade still open → finalize
        if (trade.exit_order_id) {
            const exitRow = await db[MODEL.UPSTOCK_ORDERS].findOne({
                where: { upstock_order_id: trade.exit_order_id },
            });
            if (exitRow && isOrderFilled(exitRow.status)) {
                await logNiftyAudit({
                    action: 'RECONCILE',
                    reason: 'EXIT_ORDER_FILLED_TRADE_OPEN',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        exitOrderId: trade.exit_order_id,
                        avgPrice: exitRow.average_price,
                        thinking: `SELL ${trade.exit_order_id} is filled at Upstox (avg ${exitRow.average_price}) but the trade was still open in the DB. Closing the trade with the real fill price.`,
                    },
                });
                await finalizeNiftyExitAfterBrokerFill({
                    trade,
                    sellPrice: Number(exitRow.average_price || trade.ltp),
                    orderId: trade.exit_order_id,
                });
                summary.exitFinalized += 1;
                flatSeen.delete(tradeKey);
                continue;
            }
            if (
                exitRow &&
                isOrderRejected(exitRow.status) &&
                !trade.exit_halted
            ) {
                // Ensure exit_pending so engine retries
                await trade.update({
                    exit_pending: true,
                    order_lifecycle: 'EXIT_PENDING',
                    last_order_error:
                        exitRow.rejection_reason || exitRow.status,
                });
            }
            // A SELL is still working: the position is not flat yet.
            if (exitRow && isOrderPending(exitRow.status)) {
                flatSeen.delete(tradeKey);
                continue;
            }
        }

        if (brokerQty === 0 && expectedQty > 0) {
            // Broker looks flat while the DB is open. Only believe it when the
            // trade is not brand new and it looked flat on consecutive runs.
            if (ageMs < MIN_TRADE_AGE_MS) {
                await logNiftyAudit({
                    action: 'RECONCILE',
                    reason: 'FLAT_IGNORED_TRADE_TOO_NEW',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    metadata: {
                        ageSec: Math.round(ageMs / 1000),
                        thinking: `Upstox shows no position yet, but the trade is only ${Math.round(ageMs / 1000)}s old and positions can lag a fresh fill. Not closing it.`,
                    },
                });
                continue;
            }
            const seen = (flatSeen.get(tradeKey) || 0) + 1;
            flatSeen.set(tradeKey, seen);
            if (seen < FLAT_CONFIRMATIONS) {
                await logNiftyAudit({
                    action: 'RECONCILE',
                    reason: 'FLAT_FIRST_OBSERVATION',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        seen,
                        need: FLAT_CONFIRMATIONS,
                        thinking: `Upstox shows no position for an open trade (observation ${seen}/${FLAT_CONFIRMATIONS}). I wait for one more run to confirm before closing the DB record.`,
                    },
                });
                continue;
            }

            logger.warn(
                `Nifty reconcile: DB open but broker flat for ${trade.trading_symbol}`,
            );
            const sellRow = await db[MODEL.UPSTOCK_ORDERS].findOne({
                where: {
                    trade_id: trade.id,
                    order_type: 'SELL',
                    purpose: 'EXIT',
                },
                order: [['updatedAt', 'DESC']],
            });
            const filledSell =
                sellRow && isOrderFilled(sellRow.status) ? sellRow : null;
            await trade.update({
                pending_exit_reason:
                    trade.pending_exit_reason ||
                    (filledSell
                        ? 'RECONCILE_BROKER_FLAT'
                        : 'BROKER_FLAT_MANUAL_SQUARE_OFF'),
            });
            const sellPrice = Number(filledSell?.average_price || trade.ltp);
            await finalizeNiftyExitAfterBrokerFill({
                trade,
                sellPrice,
                orderId: filledSell?.upstock_order_id,
            });
            flatSeen.delete(tradeKey);
            summary.closedFlat += 1;
            await logNiftyAudit({
                action: 'RECONCILE',
                reason: 'BROKER_FLAT_DB_CLOSED',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                metadata: {
                    expectedQty,
                    brokerQty,
                    sellPrice,
                    foundFilledSell: Boolean(filledSell),
                    thinking: filledSell
                        ? `Upstox is flat and a filled SELL (${filledSell.upstock_order_id}) exists. Closed the trade at the real price ${sellPrice}.`
                        : `Upstox has been flat for ${FLAT_CONFIRMATIONS} runs with no SELL of ours. It was most likely squared off manually on Upstox. Closed the trade record at the last price ${sellPrice}; check the real exit price in Upstox.`,
                },
                skipThrottle: true,
            });
            notifyNiftyEvent(
                'EXIT',
                `Reconcile: broker flat — DB closed for ${trade.trading_symbol}`,
                { expectedQty, brokerQty },
            );
            continue;
        }
        flatSeen.delete(tradeKey);

        if (brokerQty !== 0 && Math.abs(brokerQty) !== expectedQty) {
            summary.qtyMismatch += 1;
            logger.error(
                `Nifty reconcile QTY MISMATCH ${trade.trading_symbol}: broker=${brokerQty} db=${expectedQty}`,
            );
            await logNiftyAudit({
                action: 'LIVE_ORDER_FAIL',
                reason: 'RECONCILE_QTY_MISMATCH',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                metadata: {
                    expectedQty,
                    brokerQty,
                    thinking: `Upstox holds ${brokerQty} but the trade says ${expectedQty}. Not auto-fixing: check Upstox. (Exits never sell more than Upstox actually holds.)`,
                },
                skipThrottle: true,
            });
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                `Qty mismatch broker=${brokerQty} db=${expectedQty}`,
                { instrumentKey: trade.instrument_key },
            );
        }

        if (trade.exit_halted) {
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                `HALTED trade still open — square off ${trade.trading_symbol} on Upstox`,
                { tradeId: trade.id, brokerQty },
            );
        }
    }

    // Broker open, no Nifty DB trade → critical alert (do not auto-open)
    for (const [instrumentKey, qty] of brokerByKey.entries()) {
        const dbTrade = activeTrades.find(
            (t) => t.instrument_key === instrumentKey,
        );
        if (dbTrade) continue;

        // Ignore if another strategy owns it
        const other = await db[MODEL.TRADE].findOne({
            where: {
                instrument_key: instrumentKey,
                is_active: true,
            },
        });
        if (other) continue;

        summary.unknownBrokerPositions += 1;
        logger.error(
            `Nifty reconcile CRITICAL: broker open ${instrumentKey} qty=${qty} but no DB trade`,
        );
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: 'RECONCILE_BROKER_OPEN_DB_CLOSED',
            instrumentKey,
            config,
            metadata: {
                brokerQty: qty,
                thinking: `Upstox holds ${qty} of this instrument but there is no open trade for it and no stray BUY order to adopt. The engine does not manage it: check Upstox and square off if it is not intended.`,
            },
            skipThrottle: true,
        });
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            `Broker has open qty=${qty} with no DB trade — check Upstox`,
            { instrumentKey, brokerQty: qty },
        );
    }

    if (
        summary.activeTrades > 0 ||
        summary.pendingOrdersChecked > 0 ||
        summary.brokerPositions ||
        summary.closedFlat ||
        summary.exitFinalized
    ) {
        const issues =
            summary.qtyMismatch +
            summary.unknownBrokerPositions +
            summary.closedFlat;
        await logNiftyAudit({
            action: 'RECONCILE',
            reason: issues > 0 ? 'RECONCILE_ISSUES_FOUND' : 'RECONCILE_OK',
            config,
            skipThrottle: true,
            metadata: {
                ...summary,
                thinking:
                    issues > 0
                        ? `Reconcile run: ${issues} difference(s) between Upstox and the database (see the rows above).`
                        : `Reconcile run: ${summary.activeTrades} open trade(s) match Upstox (${summary.brokerPositions} broker position(s)), ${summary.pendingOrdersChecked} pending order(s) refreshed.`,
            },
        });
    }
};

cron.schedule(
    '*/3 9-15 * * 1-5',
    async () => {
        try {
            await reconcileNiftyOrders();
        } catch (error: any) {
            logger.error('Nifty reconciliation cron error', error?.message);
        }
    },
    { timezone: 'Asia/Kolkata' },
);

logger.info(
    'Nifty reconciliation cron scheduled (every 3 min, market hours).',
);
