import cron from 'node-cron';
import { MODEL, STRATEGY, USER_DETAILS } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { getCurrentISTDate } from '../helpers/stock.helper';
import { buildMarketTime } from '../helpers/scalping.risk.helper';
import { getUpstoxPositions } from '../helpers/scalping.reconciliation.helper';
import { getNiftyScalpConfig } from '../helpers/nifty.scalp.config.helper';
import { logNiftyAudit } from '../helpers/nifty.scalp.audit.helper';
import { notifyNiftyEvent } from '../helpers/nifty.scalp.notify.helper';
import {
    isOrderFilled,
    isOrderPending,
    isOrderRejected,
} from '../helpers/nifty.scalp.order.helper';
import { get_upstox_order_details } from '../helpers/upstocks.apis';
import { finalizeNiftyExitAfterBrokerFill } from '../helpers/nifty.scalp.trade.helper';
import { handleNiftyOrderStatusUpdate } from '../helpers/nifty.scalp.order.helper';

/**
 * Reconcile Nifty live positions: Upstox portfolio vs DB.
 * Never paper-closes a still-open broker position.
 * If broker is already flat while DB says open → finalize DB close (fill already happened).
 */
export const reconcileNiftyOrders = async (): Promise<void> => {
    const config = await getNiftyScalpConfig();
    if (config.mode !== 'live' || !config.is_active) return;

    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });
    if (!user?.token || !user?.is_live) return;

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
        await handleNiftyOrderStatusUpdate({
            order_id: row.upstock_order_id,
            status: remote.status,
            average_price: remote.average_price,
            filled_quantity: remote.filled_quantity,
            status_message: remote.status,
        });
    }

    const brokerPositions = await getUpstoxPositions(user.token);
    const brokerByKey = new Map(
        brokerPositions
            .filter((p) => p.quantity !== 0)
            .map((p) => [p.instrument_key, p.quantity]),
    );

    const activeTrades = await db[MODEL.TRADE].findAll({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
        },
    });

    for (const trade of activeTrades) {
        const brokerQty = brokerByKey.get(trade.instrument_key) ?? 0;
        const expectedQty = Number(trade.lot_size) * Number(trade.qty);

        // Exit order filled but trade still open → finalize
        if (trade.exit_order_id) {
            const exitRow = await db[MODEL.UPSTOCK_ORDERS].findOne({
                where: { upstock_order_id: trade.exit_order_id },
            });
            if (exitRow && isOrderFilled(exitRow.status)) {
                await finalizeNiftyExitAfterBrokerFill({
                    trade,
                    sellPrice: Number(
                        exitRow.average_price || trade.ltp,
                    ),
                    orderId: trade.exit_order_id,
                });
                await logNiftyAudit({
                    action: 'EXIT',
                    reason: 'RECONCILE_EXIT_ORDER_FILLED',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    metadata: { exitOrderId: trade.exit_order_id },
                    skipThrottle: true,
                });
                continue;
            }
            if (exitRow && isOrderRejected(exitRow.status) && !trade.exit_halted) {
                // Ensure exit_pending so engine retries
                await trade.update({
                    exit_pending: true,
                    order_lifecycle: 'EXIT_PENDING',
                    last_order_error:
                        exitRow.rejection_reason || exitRow.status,
                });
            }
        }

        if (brokerQty === 0 && expectedQty > 0) {
            // Broker already flat — DB still open. Sync DB closed (no new SELL).
            logger.warn(
                `Nifty reconcile: DB open but broker flat for ${trade.trading_symbol}`,
            );
            await trade.update({
                pending_exit_reason:
                    trade.pending_exit_reason || 'RECONCILE_BROKER_FLAT',
            });
            await finalizeNiftyExitAfterBrokerFill({
                trade,
                sellPrice: Number(trade.ltp),
            });
            await logNiftyAudit({
                action: 'EXIT',
                reason: 'RECONCILE_BROKER_FLAT',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                metadata: { expectedQty, brokerQty },
                skipThrottle: true,
            });
            notifyNiftyEvent(
                'EXIT',
                `Reconcile: broker flat — DB closed for ${trade.trading_symbol}`,
                { expectedQty, brokerQty },
            );
            continue;
        }

        if (brokerQty !== 0 && Math.abs(brokerQty) !== expectedQty) {
            logger.error(
                `Nifty reconcile QTY MISMATCH ${trade.trading_symbol}: broker=${brokerQty} db=${expectedQty}`,
            );
            await logNiftyAudit({
                action: 'LIVE_ORDER_FAIL',
                reason: 'RECONCILE_QTY_MISMATCH',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                metadata: { expectedQty, brokerQty },
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

        logger.error(
            `Nifty reconcile CRITICAL: broker open ${instrumentKey} qty=${qty} but no DB trade`,
        );
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: 'RECONCILE_BROKER_OPEN_DB_CLOSED',
            instrumentKey,
            config,
            metadata: { brokerQty: qty },
            skipThrottle: true,
        });
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            `Broker has open qty=${qty} with no DB trade — check Upstox`,
            { instrumentKey, brokerQty: qty },
        );
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
