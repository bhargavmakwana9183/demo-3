import moment from 'moment';
import { MODEL, STRATEGY, USER_DETAILS } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { isLiveTradingEnabled } from './scalping.trade.helper';
import {
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
    calculateTargetLtp,
    canAffordLot,
    getNiftyScalpConfig,
    getNiftyStrategyBalance,
    updateNiftyStrategyBalance,
} from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';
import {
    MAX_EXIT_RETRIES,
    isOrderFilled,
    isOrderPending,
    isOrderRejected,
    placeConfirmedUpstoxOrder,
    waitForOrderConfirmation,
} from './nifty.scalp.order.helper';

let entryInProgress = false;

export const processNiftyMarketFeed = async (stocks_data: any) => {
    if (!stocks_data?.feeds) return;

    for (const key of Object.keys(stocks_data.feeds)) {
        const feedData = stocks_data.feeds[key]?.fullFeed?.marketFF;
        if (!feedData) continue;

        if (feedData.ltpc?.ltp) {
            const ltp = feedData.ltpc.ltp;
            await db[MODEL.HEDGING_OPTIONS].update(
                { ltp },
                { where: { instrument_key: key } },
            );
            await db[MODEL.TRADE].update(
                { ltp },
                {
                    where: {
                        instrument_key: key,
                        is_active: true,
                        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                    },
                },
            );
        }

        const i1Candle = feedData.marketOHLC?.ohlc?.find(
            (c: { interval: string }) => c.interval === 'I1',
        );
        if (!i1Candle) continue;

        const timestamp = i1Candle.ts.toNumber();
        const volume = i1Candle.vol.toNumber();
        const [candle] = await db[MODEL.CANDELS].findOrCreate({
            where: {
                ts: timestamp.toString(),
                instrument_key: key,
            },
            defaults: {
                ts: timestamp.toString(),
                open: i1Candle.open,
                high: i1Candle.high,
                low: i1Candle.low,
                close: i1Candle.close,
                volume,
                instrument_key: key,
                interval: i1Candle.interval,
            },
        });

        if (candle) {
            await db[MODEL.CANDELS].update(
                {
                    open: i1Candle.open,
                    high: i1Candle.high,
                    low: i1Candle.low,
                    close: i1Candle.close,
                    volume,
                },
                { where: { id: candle.id } },
            );
        }
    }
};

const getTradingUser = async () =>
    db[MODEL.USER].findOne({ where: { email: USER_DETAILS.EMAIL } });

const markExitRetry = async (
    trade: any,
    error: any,
    config: NiftyScalpConfig,
) => {
    const retries = Number(trade.exit_retry_count || 0) + 1;
    const halted = retries >= MAX_EXIT_RETRIES;
    await trade.update({
        exit_pending: true,
        exit_retry_count: retries,
        exit_halted: halted,
        order_lifecycle: halted ? 'HALTED' : 'EXIT_PENDING',
        last_order_error: String(
            error?.message || error?.error || error || 'EXIT_FAILED',
        ),
        is_active: true,
    });
    await logNiftyAudit({
        action: 'LIVE_ORDER_FAIL',
        reason: halted ? 'EXIT_HALTED_MAX_RETRIES' : 'EXIT_RETRY_SCHEDULED',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        config,
        metadata: { retries, max: MAX_EXIT_RETRIES, error },
        skipThrottle: true,
    });
    notifyNiftyEvent(
        'LIVE_ORDER_FAIL',
        halted
            ? `Exit failed ${retries}x — HALTED. Square off manually on Upstox`
            : `Exit not confirmed — retry ${retries}/${MAX_EXIT_RETRIES} (trade stays OPEN)`,
        { tradeId: trade.id, retries },
    );
    return { halted, retries };
};

/** Persist close only after broker fill (or paper). Never fake-close live fails. */
export const finalizeNiftyExitAfterBrokerFill = async ({
    trade,
    sellPrice,
    orderId,
}: {
    trade: any;
    sellPrice: number;
    orderId?: string;
}) => {
    const fresh = await db[MODEL.TRADE].findByPk(trade.id);
    if (!fresh || !fresh.is_active) return false;

    const configRow = await db[MODEL.STRATEGY_CONFIG].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    const config = configRow?.get({ plain: true }) as NiftyScalpConfig;

    const ltp = Number(sellPrice || fresh.ltp);
    const avgBuy = Number(fresh.buy_price);
    const qty = Number(fresh.qty);
    const lotSize = Number(fresh.lot_size);
    const grossPl = calculateGrossPl(ltp, avgBuy, qty, lotSize);
    const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, {
        ...config,
        brokerage_per_lot: Number(config?.brokerage_per_lot ?? 40),
        slippage_pct: Number(config?.slippage_pct ?? 0.002),
    } as NiftyScalpConfig);
    const netPl = grossPl - charges;
    const exitReason =
        fresh.pending_exit_reason || fresh.exit_reason || 'EXIT';

    await fresh.update({
        is_active: false,
        sell_price: ltp,
        pl: grossPl,
        charges,
        net_pl: netPl,
        exit_reason: exitReason,
        exit_pending: false,
        exit_halted: false,
        order_lifecycle: 'CLOSED',
        broker_confirmed: true,
        exit_order_id: orderId || fresh.exit_order_id,
        last_order_error: null,
    });

    const position = await db[MODEL.POSITION].findByPk(fresh.position_id);
    if (position) {
        await position.update({
            is_active: false,
            pl: netPl,
            end_time: moment(),
        });
    }

    const user = await getTradingUser();
    if (!isLiveTradingEnabled(user, config)) {
        await updateNiftyStrategyBalance(ltp * lotSize * qty);
    } else {
        await updateNiftyStrategyBalance(netPl);
    }

    await logNiftyAudit({
        action: exitReason === 'TARGET_HIT' ? 'TARGET_HIT' : 'EXIT',
        reason: exitReason,
        instrumentKey: fresh.instrument_key,
        tradeId: fresh.id,
        engineState: 'CLOSED',
        config,
        metadata: {
            ltp,
            avgBuy,
            qty,
            grossPl,
            charges,
            netPl,
            orderId,
            thinking: `Broker-confirmed exit @ ${ltp}. Net ₹${netPl.toFixed(2)}`,
        },
        skipThrottle: true,
    });
    notifyNiftyEvent(
        exitReason === 'TARGET_HIT' ? 'TARGET_HIT' : 'EXIT',
        `Sold (broker confirmed). Net P&L ₹${netPl.toFixed(2)}`,
        { ltp, qty, netPl, exitReason, orderId },
    );
    return true;
};

export const openNiftyScalpEntry = async ({
    option,
    signal,
    config,
    reason,
    indicators,
}: {
    option: any;
    signal: 'CE_BUY' | 'PE_BUY';
    config: NiftyScalpConfig;
    reason: string;
    indicators: Record<string, number | undefined>;
}) => {
    if (entryInProgress) return null;
    entryInProgress = true;

    try {
        const existing = await db[MODEL.POSITION].findOne({
            where: {
                strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                is_active: true,
            },
        });
        if (existing) return null;

        const quoteLtp = Number(option.ltp);
        const lotSize = Number(option.lot_size) || 25;
        if (!quoteLtp || quoteLtp <= 0) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'INVALID_LTP',
                signal,
                instrumentKey: option.instrument_key,
                config,
                indicators,
            });
            return null;
        }

        const balance = await getNiftyStrategyBalance(config);
        if (!canAffordLot(balance, quoteLtp, lotSize)) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'INSUFFICIENT_BALANCE_ENTRY',
                signal,
                instrumentKey: option.instrument_key,
                config,
                indicators,
                metadata: { balance, required: quoteLtp * lotSize },
            });
            notifyNiftyEvent(
                'CANNOT_ADD_LOT',
                'Not enough balance to open first lot',
                { balance, required: quoteLtp * lotSize },
            );
            return null;
        }

        const user = await getTradingUser();
        const liveMode = isLiveTradingEnabled(user, config);

        // PRODUCTION: place + confirm BUY before creating active trade
        let fillPrice = quoteLtp;
        let entryOrderId: string | null = null;
        let brokerConfirmed = !liveMode;

        if (liveMode) {
            const live = await placeConfirmedUpstoxOrder({
                user,
                config,
                instrumentKey: option.instrument_key,
                quantity: lotSize * 1,
                side: 'BUY',
                purpose: 'ENTRY',
            });

            if (!live.ok) {
                // Timeout / reject → do NOT open paper trade
                await logNiftyAudit({
                    action: 'LIVE_ORDER_FAIL',
                    reason: live.timedOut
                        ? 'ENTRY_CONFIRM_TIMEOUT'
                        : 'ENTRY_BUY_FAILED',
                    signal,
                    instrumentKey: option.instrument_key,
                    config,
                    indicators,
                    metadata: { live },
                    skipThrottle: true,
                });
                return null;
            }

            fillPrice = Number(live.averagePrice || quoteLtp);
            entryOrderId = live.orderId || null;
            brokerConfirmed = true;
        }

        const target = calculateTargetLtp(fillPrice, 1, lotSize, config);
        const tradeId = Math.floor(100000 + Math.random() * 900000);
        const today = moment().format('YYYY-MM-DD');

        const position = await db[MODEL.POSITION].create({
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
            qty: 1,
            trade_id: tradeId,
            date: today,
            start_time: moment(),
            required_margin: fillPrice * lotSize,
            is_exectued: true,
            is_upstock_exectued: brokerConfirmed && liveMode,
        });

        const trade = await db[MODEL.TRADE].create({
            position_id: position.id,
            options_chain_id: option.options_chain_id || option.id,
            trade_id: String(tradeId),
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            trading_symbol: option.trading_symbol,
            instrument_key: option.instrument_key,
            instrument_type: option.instrument_type,
            trade_type: 'BUY',
            buy_price: fillPrice,
            target_price: target,
            stop_loss: fillPrice - config.add_lot_points,
            is_active: true,
            ltp: fillPrice,
            qty: 1,
            lot_size: lotSize,
            highest_ltp: fillPrice,
            original_qty: 1,
            order_lifecycle: 'OPEN',
            broker_confirmed: brokerConfirmed,
            entry_order_id: entryOrderId,
            exit_pending: false,
            exit_retry_count: 0,
            exit_halted: false,
        });

        if (entryOrderId) {
            await db[MODEL.UPSTOCK_ORDERS].update(
                { trade_id: trade.id, postion_id: position.id },
                { where: { upstock_order_id: entryOrderId } },
            );
        }

        if (!liveMode) {
            await updateNiftyStrategyBalance(-(fillPrice * lotSize));
        }

        await logNiftyAudit({
            action: 'ENTRY_FILLED',
            reason,
            signal,
            instrumentKey: option.instrument_key,
            tradeId: trade.id,
            engineState: 'IN_TRADE',
            config,
            indicators,
            metadata: {
                fillPrice,
                target,
                lotSize,
                qty: 1,
                mode: config.mode,
                liveMode,
                entryOrderId,
                brokerConfirmed,
                thinking: liveMode
                    ? `Upstox BUY confirmed @ ${fillPrice}. Target ${target.toFixed(2)}`
                    : `Paper BUY @ ${fillPrice}. Target ${target.toFixed(2)}`,
            },
            skipThrottle: true,
        });

        notifyNiftyEvent(
            'ENTRY_FILLED',
            liveMode
                ? `Live BUY confirmed ${option.instrument_type} 1 lot @ ${fillPrice}`
                : `Paper BUY ${option.instrument_type} 1 lot @ ${fillPrice}`,
            { symbol: option.trading_symbol, fillPrice, target, entryOrderId },
        );

        return { position, trade };
    } finally {
        entryInProgress = false;
    }
};

export const addNiftyScalpLot = async ({
    trade,
    position,
    config,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
}) => {
    if (trade.exit_pending || trade.exit_halted) return false;
    if (
        isLiveTradingEnabled(
            await getTradingUser(),
            config,
        ) &&
        !trade.broker_confirmed
    ) {
        return false;
    }

    const ltp = Number(trade.ltp);
    const lotSize = Number(trade.lot_size);
    const avgBuy = Number(trade.buy_price);
    const qty = Number(trade.qty);

    if (ltp > avgBuy - config.add_lot_points) return false;

    const balance = await getNiftyStrategyBalance(config);
    if (!canAffordLot(balance, ltp, lotSize)) {
        await logNiftyAudit({
            action: 'CANNOT_ADD_LOT',
            reason: 'INSUFFICIENT_BALANCE_ADD_LOT',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            engineState: 'IN_TRADE',
            config,
            metadata: {
                ltp,
                avgBuy,
                balance,
                required: ltp * lotSize,
            },
        });
        notifyNiftyEvent(
            'CANNOT_ADD_LOT',
            'Price down but not enough money for another lot — holding',
            { ltp, avgBuy, balance },
        );
        return false;
    }

    const user = await getTradingUser();
    const liveMode = isLiveTradingEnabled(user, config);
    let addPrice = ltp;

    if (liveMode) {
        const live = await placeConfirmedUpstoxOrder({
            user,
            config,
            instrumentKey: trade.instrument_key,
            quantity: lotSize * 1,
            side: 'BUY',
            purpose: 'ADD_LOT',
            positionId: position.id,
            tradeId: trade.id,
        });
        if (!live.ok) {
            // Do not bump qty on failed/pending live add
            return false;
        }
        addPrice = Number(live.averagePrice || ltp);
    }

    const newQty = qty + 1;
    const newAvg = (avgBuy * qty + addPrice) / newQty;
    const newTarget = calculateTargetLtp(newAvg, newQty, lotSize, config);

    await trade.update({
        qty: newQty,
        buy_price: newAvg,
        target_price: newTarget,
        stop_loss: newAvg - config.add_lot_points,
        original_qty: newQty,
        ltp: addPrice,
        broker_confirmed: true,
    });
    await position.update({
        qty: newQty,
        required_margin: newAvg * lotSize * newQty,
    });

    if (!liveMode) {
        await updateNiftyStrategyBalance(-(addPrice * lotSize));
    }

    await logNiftyAudit({
        action: 'ADD_LOT',
        reason: 'DRAWDOWN_10_POINTS',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'AVERAGING',
        config,
        metadata: {
            oldAvg: avgBuy,
            newAvg,
            newQty,
            newTarget,
            addPrice,
            liveMode,
        },
        skipThrottle: true,
    });

    notifyNiftyEvent(
        'LOT_ADDED',
        `Added 1 lot @ ${addPrice}. New avg ${newAvg.toFixed(2)}`,
        { newQty, newAvg, newTarget },
    );

    return true;
};

export const closeNiftyScalpTrade = async ({
    trade,
    position,
    config,
    exitReason,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
    exitReason: string;
}) => {
    if (!trade?.is_active) return false;
    if (trade.exit_halted) {
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            'Exit halted — manual square-off required on Upstox',
            { tradeId: trade.id },
        );
        return false;
    }

    const user = await getTradingUser();
    const liveMode = isLiveTradingEnabled(user, config);
    const ltp = Number(trade.ltp);
    const qty = Number(trade.qty);
    const lotSize = Number(trade.lot_size);

    // Mark exit pending BEFORE placing sell — never pretend closed
    await trade.update({
        exit_pending: true,
        pending_exit_reason: exitReason,
        order_lifecycle: 'EXIT_PENDING',
    });

    if (!liveMode) {
        await finalizeNiftyExitAfterBrokerFill({
            trade,
            sellPrice: ltp,
        });
        return true;
    }

    // Resume wait on in-flight EXIT — never double-SELL while Pending
    if (trade.exit_order_id && user?.token) {
        const existing = await db[MODEL.UPSTOCK_ORDERS].findOne({
            where: { upstock_order_id: trade.exit_order_id },
        });
        if (existing && isOrderFilled(existing.status)) {
            await finalizeNiftyExitAfterBrokerFill({
                trade,
                sellPrice: Number(existing.average_price || ltp),
                orderId: trade.exit_order_id,
            });
            return true;
        }
        if (existing && isOrderPending(existing.status)) {
            const resumed = await waitForOrderConfirmation({
                orderId: String(trade.exit_order_id),
                accessToken: user.token,
            });
            if (resumed.ok) {
                await finalizeNiftyExitAfterBrokerFill({
                    trade,
                    sellPrice: Number(resumed.averagePrice || ltp),
                    orderId: resumed.orderId,
                });
                return true;
            }
            if (resumed.timedOut || resumed.pending) {
                // Still pending — do not place another SELL / do not bump retry yet
                notifyNiftyEvent(
                    'LIVE_ORDER_FAIL',
                    'Exit order still pending on Upstox — waiting (no double sell)',
                    { tradeId: trade.id, orderId: trade.exit_order_id },
                );
                return false;
            }
            // Rejected / cancelled → bump retry, clear id, then place fresh below
            if (resumed.rejected || isOrderRejected(resumed.status)) {
                await markExitRetry(
                    trade,
                    resumed.error || resumed.status,
                    config,
                );
                const halted = await db[MODEL.TRADE].findByPk(trade.id);
                if (halted?.exit_halted) return false;
                await trade.update({ exit_order_id: null });
                trade.exit_order_id = null;
            }
        }
    }

    const live = await placeConfirmedUpstoxOrder({
        user,
        config,
        instrumentKey: trade.instrument_key,
        quantity: lotSize * qty,
        side: 'SELL',
        purpose: 'EXIT',
        positionId: position.id,
        tradeId: trade.id,
    });

    if (live.ok && !live.paper) {
        await trade.update({ exit_order_id: live.orderId || null });
        await finalizeNiftyExitAfterBrokerFill({
            trade,
            sellPrice: Number(live.averagePrice || ltp),
            orderId: live.orderId,
        });
        return true;
    }

    // Rejected / timeout / error → keep trade OPEN (NOT paper close)
    if (live.orderId) {
        await trade.update({ exit_order_id: live.orderId });
    }
    // Only bump retry counter on hard reject — timeout keeps waiting on same order
    if (live.rejected && !live.timedOut) {
        await markExitRetry(trade, live.error || live.status || live, config);
    } else if (live.timedOut) {
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            'Exit confirm timeout — trade stays OPEN until Upstox fills or rejects',
            { tradeId: trade.id, orderId: live.orderId },
        );
    } else {
        await markExitRetry(trade, live.error || live.status || live, config);
    }
    logger.error(
        `Nifty scalp SELL not confirmed for trade ${trade.id}: ${JSON.stringify(live)}`,
    );
    return false;
};

export const sellPartialNiftyLots = async ({
    trade,
    position,
    config,
    lotsToSell,
    reason,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
    lotsToSell: number;
    reason: string;
}) => {
    if (trade.exit_pending || trade.exit_halted) return false;

    const qty = Number(trade.qty);
    if (lotsToSell <= 0 || lotsToSell >= qty) return false;

    const ltp = Number(trade.ltp);
    const avgBuy = Number(trade.buy_price);
    const lotSize = Number(trade.lot_size);
    const user = await getTradingUser();
    const liveMode = isLiveTradingEnabled(user, config);
    let sellPrice = ltp;

    if (liveMode) {
        const live = await placeConfirmedUpstoxOrder({
            user,
            config,
            instrumentKey: trade.instrument_key,
            quantity: lotSize * lotsToSell,
            side: 'SELL',
            purpose: 'PARTIAL_EXIT',
            positionId: position.id,
            tradeId: trade.id,
        });
        if (!live.ok) {
            // Do not reduce qty without broker confirm
            return false;
        }
        sellPrice = Number(live.averagePrice || ltp);
    }

    const partialGross = calculateGrossPl(sellPrice, avgBuy, lotsToSell, lotSize);
    const partialCharges = calculateRoundTripCharges(
        lotsToSell,
        lotSize,
        avgBuy,
        config,
    );
    const partialNet = partialGross - partialCharges;
    const remaining = qty - lotsToSell;
    const newTarget = calculateTargetLtp(avgBuy, remaining, lotSize, config);

    await trade.update({
        qty: remaining,
        original_qty: remaining,
        pl: Number(trade.pl || 0) + partialNet,
        target_price: newTarget,
        ltp: sellPrice,
    });
    await position.update({ qty: remaining });

    if (!liveMode) {
        await updateNiftyStrategyBalance(sellPrice * lotSize * lotsToSell);
    } else {
        await updateNiftyStrategyBalance(partialNet);
    }

    await logNiftyAudit({
        action: 'PLAN_B_SCALP',
        reason,
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'RECOVERY',
        config,
        metadata: {
            lotsSold: lotsToSell,
            remaining,
            sellPrice,
            avgBuy,
            partialNet,
            newTarget,
            liveMode,
        },
        skipThrottle: true,
    });

    notifyNiftyEvent(
        'PLAN_B_SCALP',
        `Sold ${lotsToSell} lot(s) (confirmed). Remaining ${remaining}`,
        { remaining, partialNet, newTarget },
    );

    return true;
};

/**
 * Manual / test entry from frontend.
 * Places Upstox BUY (when production) with confirmation, then opens a
 * NIFTY_OPTIONS_SCALP position the engine manages (target, add-lot, Plan B).
 */
export const manualOpenNiftyScalpEntry = async ({
    instrumentKey,
    hedgingOptionId,
    lots = 1,
    referenceBuyPrice,
}: {
    instrumentKey?: string;
    hedgingOptionId?: string;
    lots?: number;
    referenceBuyPrice?: number;
}): Promise<{
    ok: boolean;
    error?: string;
    position?: any;
    trade?: any;
    liveMode?: boolean;
    fillPrice?: number;
    entryOrderId?: string | null;
}> => {
    if (entryInProgress) {
        return { ok: false, error: 'ENTRY_IN_PROGRESS' };
    }
    entryInProgress = true;

    try {
        const config = await getNiftyScalpConfig();
        const qty = Math.max(1, Math.min(Number(lots) || 1, 20));

        const existing = await db[MODEL.POSITION].findOne({
            where: {
                strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                is_active: true,
            },
        });
        if (existing) {
            return {
                ok: false,
                error: 'ACTIVE_POSITION_EXISTS — close or wait for engine exit first',
            };
        }

        let option: any = null;
        if (hedgingOptionId) {
            option = await db[MODEL.HEDGING_OPTIONS].findByPk(hedgingOptionId);
        }
        if (!option && instrumentKey) {
            option = await db[MODEL.HEDGING_OPTIONS].findOne({
                where: { instrument_key: instrumentKey },
            });
        }
        if (!option) {
            return { ok: false, error: 'OPTION_NOT_FOUND' };
        }

        const quoteLtp = Number(option.ltp) || Number(referenceBuyPrice) || 0;
        const lotSize = Number(option.lot_size) || 25;
        if (!quoteLtp || quoteLtp <= 0) {
            return { ok: false, error: 'INVALID_LTP' };
        }

        const signal: 'CE_BUY' | 'PE_BUY' =
            String(option.instrument_type).toUpperCase() === 'PE'
                ? 'PE_BUY'
                : 'CE_BUY';

        const balance = await getNiftyStrategyBalance(config);
        const required = quoteLtp * lotSize * qty;
        if (!isLiveTradingEnabled(await getTradingUser(), config)) {
            if (balance < required) {
                return {
                    ok: false,
                    error: `INSUFFICIENT_PAPER_BALANCE need ₹${required.toFixed(0)} have ₹${balance.toFixed(0)}`,
                };
            }
        }

        const user = await getTradingUser();
        const liveMode = isLiveTradingEnabled(user, config);

        let fillPrice =
            Number(referenceBuyPrice) > 0
                ? Number(referenceBuyPrice)
                : quoteLtp;
        let entryOrderId: string | null = null;
        let brokerConfirmed = !liveMode;

        if (liveMode) {
            const live = await placeConfirmedUpstoxOrder({
                user,
                config,
                instrumentKey: option.instrument_key,
                quantity: lotSize * qty,
                side: 'BUY',
                purpose: 'ENTRY',
            });

            if (!live.ok) {
                await logNiftyAudit({
                    action: 'LIVE_ORDER_FAIL',
                    reason: live.timedOut
                        ? 'MANUAL_ENTRY_CONFIRM_TIMEOUT'
                        : 'MANUAL_ENTRY_BUY_FAILED',
                    signal,
                    instrumentKey: option.instrument_key,
                    config,
                    metadata: { live, qty, manual: true },
                    skipThrottle: true,
                });
                return {
                    ok: false,
                    error: live.timedOut
                        ? 'UPSTOX_CONFIRM_TIMEOUT — order may still fill; check Upstox / reconcile'
                        : `UPSTOX_BUY_FAILED: ${JSON.stringify(live.error || live.status)}`,
                    liveMode: true,
                };
            }

            fillPrice = Number(live.averagePrice || fillPrice || quoteLtp);
            entryOrderId = live.orderId || null;
            brokerConfirmed = true;
        }

        const target = calculateTargetLtp(fillPrice, qty, lotSize, config);
        const tradeId = Math.floor(100000 + Math.random() * 900000);
        const today = moment().format('YYYY-MM-DD');

        const position = await db[MODEL.POSITION].create({
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
            qty,
            trade_id: tradeId,
            date: today,
            start_time: moment(),
            required_margin: fillPrice * lotSize * qty,
            is_exectued: true,
            is_upstock_exectued: brokerConfirmed && liveMode,
        });

        const trade = await db[MODEL.TRADE].create({
            position_id: position.id,
            options_chain_id: option.options_chain_id || option.id,
            trade_id: String(tradeId),
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            trading_symbol: option.trading_symbol,
            instrument_key: option.instrument_key,
            instrument_type: option.instrument_type,
            trade_type: 'BUY',
            buy_price: fillPrice,
            target_price: target,
            stop_loss: fillPrice - config.add_lot_points,
            is_active: true,
            ltp: fillPrice,
            qty,
            lot_size: lotSize,
            highest_ltp: fillPrice,
            original_qty: qty,
            order_lifecycle: 'OPEN',
            broker_confirmed: brokerConfirmed,
            entry_order_id: entryOrderId,
            exit_pending: false,
            exit_retry_count: 0,
            exit_halted: false,
        });

        if (entryOrderId) {
            await db[MODEL.UPSTOCK_ORDERS].update(
                { trade_id: trade.id, postion_id: position.id },
                { where: { upstock_order_id: entryOrderId } },
            );
        }

        if (!liveMode) {
            await updateNiftyStrategyBalance(-(fillPrice * lotSize * qty));
        }

        await logNiftyAudit({
            action: 'ENTRY_FILLED',
            reason: 'MANUAL_FRONTEND_ENTRY',
            signal,
            instrumentKey: option.instrument_key,
            tradeId: trade.id,
            engineState: 'IN_TRADE',
            config,
            metadata: {
                fillPrice,
                target,
                lotSize,
                qty,
                mode: config.mode,
                liveMode,
                entryOrderId,
                brokerConfirmed,
                manual: true,
                referenceBuyPrice,
                thinking: liveMode
                    ? `Manual Upstox BUY confirmed ${qty} lot(s) @ ${fillPrice}. Engine will manage target/Plan B.`
                    : `Manual paper BUY ${qty} lot(s) @ ${fillPrice}. Engine will manage target/Plan B.`,
            },
            skipThrottle: true,
        });

        notifyNiftyEvent(
            'ENTRY_FILLED',
            liveMode
                ? `Manual live BUY confirmed ${option.trading_symbol} ${qty} lot(s) @ ${fillPrice}`
                : `Manual paper BUY ${option.trading_symbol} ${qty} lot(s) @ ${fillPrice}`,
            {
                symbol: option.trading_symbol,
                fillPrice,
                target,
                qty,
                entryOrderId,
                manual: true,
            },
        );

        return {
            ok: true,
            position,
            trade,
            liveMode,
            fillPrice,
            entryOrderId,
        };
    } finally {
        entryInProgress = false;
    }
};
