import moment from 'moment';
import { MODEL, STRATEGY, USER_DETAILS } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { place_order_on_upstocks } from './upstocks.apis';
import { isLiveTradingEnabled } from './scalping.trade.helper';
import {
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
    calculateTargetLtp,
    canAffordLot,
    getNiftyStrategyBalance,
    updateNiftyStrategyBalance,
} from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';

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

const placeLiveOrder = async ({
    user,
    config,
    instrumentKey,
    lotSize,
    qty,
    positionId,
    side,
}: {
    user: any;
    config: NiftyScalpConfig;
    instrumentKey: string;
    lotSize: number;
    qty: number;
    positionId: string;
    side: 'BUY' | 'SELL';
}) => {
    if (!isLiveTradingEnabled(user, config) || !user?.token) {
        return { ok: true, paper: true };
    }

    const orderPlaced = await place_order_on_upstocks({
        instrument_key: instrumentKey,
        accessToken: user.token,
        quantity: Number(lotSize) * Number(qty),
        transaction_type: side,
    });

    if (
        orderPlaced?.status === 'success' &&
        orderPlaced?.data?.order_ids?.length > 0
    ) {
        await Promise.all(
            orderPlaced.data.order_ids.map((order_id: string) =>
                db[MODEL.UPSTOCK_ORDERS].create({
                    upstock_order_id: order_id,
                    postion_id: positionId,
                    order_type: side,
                }),
            ),
        );
        return { ok: true, paper: false };
    }

    await logNiftyAudit({
        action: 'LIVE_ORDER_FAIL',
        reason: `${side}_ORDER_FAILED`,
        instrumentKey,
        config,
        metadata: { orderPlaced },
    });
    notifyNiftyEvent('LIVE_ORDER_FAIL', `${side} order failed on Upstox`, {
        instrumentKey,
        side,
    });
    return { ok: false, paper: false };
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

        const buyPrice = Number(option.ltp);
        const lotSize = Number(option.lot_size) || 25;
        if (!buyPrice || buyPrice <= 0) {
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
        if (!canAffordLot(balance, buyPrice, lotSize)) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'INSUFFICIENT_BALANCE_ENTRY',
                signal,
                instrumentKey: option.instrument_key,
                config,
                indicators,
                metadata: { balance, required: buyPrice * lotSize },
            });
            notifyNiftyEvent(
                'CANNOT_ADD_LOT',
                'Not enough balance to open first lot',
                { balance, required: buyPrice * lotSize },
            );
            return null;
        }

        const target = calculateTargetLtp(buyPrice, 1, lotSize, config);
        const user = await db[MODEL.USER].findOne({
            where: { email: USER_DETAILS.EMAIL },
        });
        const tradeId = Math.floor(100000 + Math.random() * 900000);
        const today = moment().format('YYYY-MM-DD');

        const position = await db[MODEL.POSITION].create({
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
            qty: 1,
            trade_id: tradeId,
            date: today,
            start_time: moment(),
            required_margin: buyPrice * lotSize,
            is_exectued: true,
            is_upstock_exectued: isLiveTradingEnabled(user, config),
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
            buy_price: buyPrice,
            target_price: target,
            stop_loss: buyPrice - config.add_lot_points,
            is_active: true,
            ltp: buyPrice,
            qty: 1,
            lot_size: lotSize,
            highest_ltp: buyPrice,
            original_qty: 1,
        });

        const live = await placeLiveOrder({
            user,
            config,
            instrumentKey: option.instrument_key,
            lotSize,
            qty: 1,
            positionId: position.id,
            side: 'BUY',
        });

        if (!live.ok) {
            await trade.update({ is_active: false, exit_reason: 'LIVE_BUY_FAIL' });
            await position.update({ is_active: false, end_time: moment() });
            return null;
        }

        if (config.mode !== 'live' || !user?.is_live) {
            await updateNiftyStrategyBalance(-(buyPrice * lotSize));
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
                buyPrice,
                target,
                lotSize,
                qty: 1,
                mode: config.mode,
                thinking: `EMA/RSI signal ${signal}. Buy 1 lot @ ${buyPrice}. Target ${target.toFixed(2)} for charges + ₹${config.target_profit_rs}`,
            },
        });

        notifyNiftyEvent('ENTRY_FILLED', `Bought ${option.instrument_type} 1 lot`, {
            symbol: option.trading_symbol,
            buyPrice,
            target,
        });

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
                thinking: `Price dropped ${config.add_lot_points}+ points from avg ${avgBuy} to ${ltp}, but balance ${balance} cannot buy another lot`,
            },
        });
        notifyNiftyEvent(
            'CANNOT_ADD_LOT',
            'Price down 10pts but not enough money for another lot — holding for target',
            { ltp, avgBuy, balance },
        );
        return false;
    }

    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });
    const live = await placeLiveOrder({
        user,
        config,
        instrumentKey: trade.instrument_key,
        lotSize,
        qty: 1,
        positionId: position.id,
        side: 'BUY',
    });
    if (!live.ok) return false;

    const newQty = qty + 1;
    const newAvg = (avgBuy * qty + ltp) / newQty;
    const newTarget = calculateTargetLtp(newAvg, newQty, lotSize, config);

    await trade.update({
        qty: newQty,
        buy_price: newAvg,
        target_price: newTarget,
        stop_loss: newAvg - config.add_lot_points,
        original_qty: newQty,
        ltp,
    });
    await position.update({
        qty: newQty,
        required_margin: newAvg * lotSize * newQty,
    });

    if (config.mode !== 'live' || !user?.is_live) {
        await updateNiftyStrategyBalance(-(ltp * lotSize));
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
            addPrice: ltp,
            thinking: `LTP ${ltp} is >= ${config.add_lot_points} below avg ${avgBuy}. Added 1 lot. New avg ${newAvg.toFixed(2)}, target ${newTarget.toFixed(2)}`,
        },
    });

    notifyNiftyEvent('LOT_ADDED', `Added 1 lot @ ${ltp}. New avg ${newAvg.toFixed(2)}`, {
        newQty,
        newAvg,
        newTarget,
    });

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

    const ltp = Number(trade.ltp);
    const avgBuy = Number(trade.buy_price);
    const qty = Number(trade.qty);
    const lotSize = Number(trade.lot_size);
    const grossPl = calculateGrossPl(ltp, avgBuy, qty, lotSize);
    const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
    const netPl = grossPl - charges;

    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });

    const live = await placeLiveOrder({
        user,
        config,
        instrumentKey: trade.instrument_key,
        lotSize,
        qty,
        positionId: position.id,
        side: 'SELL',
    });

    if (!live.ok) {
        logger.error(`Nifty scalp SELL failed for trade ${trade.id}`);
        return false;
    }

    await trade.update({
        is_active: false,
        sell_price: ltp,
        pl: grossPl,
        charges,
        net_pl: netPl,
        exit_reason: exitReason,
    });
    await position.update({
        is_active: false,
        pl: netPl,
        end_time: moment(),
    });

    // paper: credit sale proceeds + track P&L via balance already reduced on buys
    if (config.mode !== 'live' || !user?.is_live) {
        await updateNiftyStrategyBalance(ltp * lotSize * qty);
    } else {
        await updateNiftyStrategyBalance(netPl);
    }

    await logNiftyAudit({
        action: exitReason === 'TARGET_HIT' ? 'TARGET_HIT' : 'EXIT',
        reason: exitReason,
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'CLOSED',
        config,
        metadata: {
            ltp,
            avgBuy,
            qty,
            grossPl,
            charges,
            netPl,
            thinking: `Closed ${qty} lot(s) @ ${ltp}. Gross ${grossPl.toFixed(2)}, charges ${charges.toFixed(2)}, net ${netPl.toFixed(2)}`,
        },
    });

    notifyNiftyEvent(
        exitReason === 'TARGET_HIT' ? 'TARGET_HIT' : 'EXIT',
        `Sold position. Net P&L ₹${netPl.toFixed(2)}`,
        { ltp, qty, netPl, exitReason },
    );

    return true;
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
    const qty = Number(trade.qty);
    if (lotsToSell <= 0 || lotsToSell >= qty) return false;

    const ltp = Number(trade.ltp);
    const avgBuy = Number(trade.buy_price);
    const lotSize = Number(trade.lot_size);
    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });

    const live = await placeLiveOrder({
        user,
        config,
        instrumentKey: trade.instrument_key,
        lotSize,
        qty: lotsToSell,
        positionId: position.id,
        side: 'SELL',
    });
    if (!live.ok) return false;

    const partialGross = calculateGrossPl(ltp, avgBuy, lotsToSell, lotSize);
    const partialCharges = calculateRoundTripCharges(
        lotsToSell,
        lotSize,
        avgBuy,
        config,
    );
    const partialNet = partialGross - partialCharges;
    const remaining = qty - lotsToSell;

    await trade.update({
        qty: remaining,
        original_qty: remaining,
        pl: Number(trade.pl || 0) + partialNet,
    });
    await position.update({ qty: remaining });

    if (config.mode !== 'live' || !user?.is_live) {
        await updateNiftyStrategyBalance(ltp * lotSize * lotsToSell);
    } else {
        await updateNiftyStrategyBalance(partialNet);
    }

    const newTarget = calculateTargetLtp(
        avgBuy,
        remaining,
        lotSize,
        config,
    );
    await trade.update({ target_price: newTarget });

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
            ltp,
            avgBuy,
            partialNet,
            newTarget,
            thinking: `Plan B: sold ${lotsToSell} lot(s) @ ${ltp} to book ₹${partialNet.toFixed(2)}. Remaining ${remaining} lots, target ${newTarget.toFixed(2)}`,
        },
    });

    notifyNiftyEvent('PLAN_B_SCALP', `Sold ${lotsToSell} lot(s) in recovery scalp`, {
        remaining,
        partialNet,
        newTarget,
    });

    return true;
};
