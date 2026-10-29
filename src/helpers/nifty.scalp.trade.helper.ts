import moment from 'moment';
import { MODEL, STRATEGY, USER_DETAILS } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { isLiveTradingEnabled } from './scalping.trade.helper';
import {
    NIFTY_HEDGE_ENABLED,
    NIFTY_MAX_LOTS,
    NIFTY_PAPER_SPREAD_POINTS,
    NIFTY_STOP_POINTS,
    NIFTY_BREAKEVEN_ARM_RS,
    NIFTY_TRAIL_ARM_RS,
    NIFTY_TRAIL_FLOOR_RS,
    NIFTY_TRAIL_POINTS,
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
    calculateTargetLtp,
    canAffordLot,
    getNiftyScalpConfig,
    getNiftyStrategyBalance,
    setNiftyStrategyBalance,
    twoLotWithHedgeCost,
    updateNiftyStrategyBalance,
} from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';
import {
    EXIT_RETRY_BACKOFF_SEC,
    MAX_EXIT_RETRIES,
    errText,
    flattenStrayQuantity,
    isOrderFilled,
    isOrderPending,
    isOrderRejected,
    placeConfirmedUpstoxOrder,
    waitForOrderConfirmation,
} from './nifty.scalp.order.helper';
import { getUpstoxPositionsOrNull } from './scalping.reconciliation.helper';
import { recordTradeLeg } from './nifty.scalp.leg.helper';
import {
    get_upstox_funds_and_margin,
    get_upstox_order_details,
} from './upstocks.apis';

let entryInProgress = false;

/** Trades whose SELL is being placed / awaited right now (stops a second SELL). */
const exitsInFlight = new Set<string>();
export const isExitInFlight = (tradeId: string) =>
    exitsInFlight.has(String(tradeId));

/** Earliest time the next exit attempt may run, per trade (retry backoff). */
const exitRetryNotBefore = new Map<string, number>();

/** After a failed live BUY, wait before trying again (the signal stays true for a minute). */
export const ENTRY_FAIL_COOLDOWN_MS = 90_000;
let entryRetryNotBefore = 0;
export const getEntryCooldownRemainingMs = () =>
    Math.max(0, entryRetryNotBefore - Date.now());
const startEntryCooldown = () => {
    entryRetryNotBefore = Date.now() + ENTRY_FAIL_COOLDOWN_MS;
};

/** True when a Nifty trade is open: the live/paper switch must not change then. */
export const hasActiveNiftyTrade = async () => {
    const p = await db[MODEL.POSITION].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP, is_active: true },
    });
    return Boolean(p);
};

/** After confirmed live fill, replace strategy_balance with Upstox available_margin. */
export const syncStrategyBalanceFromUpstox = async () => {
    const user = await getTradingUser();
    if (!user?.token) return null;
    const available = await get_upstox_funds_and_margin(user.token);
    if (available == null) {
        logger.warn('Upstox funds sync skipped — no available_margin');
        return null;
    }
    await setNiftyStrategyBalance(available);
    return available;
};

/** Hedge open P/L after estimated round-trip charges. */
export const hedgeOpenNet = (
    trade: any,
    lotSize: number,
    config?: NiftyScalpConfig | null,
) => {
    const hedgeQty = Number(trade.hedge_qty || 0);
    const hedgeBuy = Number(trade.hedge_buy_price || 0);
    const hedgeLtp = Number(trade.hedge_ltp || hedgeBuy);
    if (hedgeQty <= 0 || hedgeBuy <= 0) return 0;
    const gross = (hedgeLtp - hedgeBuy) * lotSize * hedgeQty;
    if (!config) return gross;
    const charges = calculateRoundTripCharges(
        hedgeQty,
        lotSize,
        hedgeBuy,
        config,
    );
    return gross - charges;
};

/** Hedge row for positions and history. Closed trades keep the symbol even if qty was cleared. */
export const hedgeLegView = (
    trade: any,
    lotSize: number,
    config?: NiftyScalpConfig | null,
) => {
    const hedgeSymbol = trade.hedge_trading_symbol || null;
    const hedgeBuy = Number(trade.hedge_buy_price || 0);
    const hedgeLtp = Number(trade.hedge_ltp || hedgeBuy || 0);
    let hedgeLots = Number(trade.hedge_qty || 0);
    if (hedgeLots <= 0 && hedgeSymbol && hedgeBuy > 0) hedgeLots = 1;
    if (!hedgeSymbol || hedgeBuy <= 0 || hedgeLots <= 0 || !(lotSize > 0)) {
        return null;
    }
    const hedgeGross = (hedgeLtp - hedgeBuy) * lotSize * hedgeLots;
    const chargeConfig = {
        brokerage_per_lot: Number(config?.brokerage_per_lot ?? 40),
        slippage_pct: Number(config?.slippage_pct ?? 0.002),
    } as NiftyScalpConfig;
    const hedgeCharges = calculateRoundTripCharges(
        hedgeLots,
        lotSize,
        hedgeBuy,
        chargeConfig,
    );
    return {
        hedgeSymbol,
        hedgeBuy: Number(hedgeBuy.toFixed(2)),
        hedgeLtp: Number(hedgeLtp.toFixed(2)),
        hedgeLots,
        hedgeGross: Number(hedgeGross.toFixed(2)),
        hedgeCharges: Number(hedgeCharges.toFixed(2)),
        hedgeNet: Number((hedgeGross - hedgeCharges).toFixed(2)),
    };
};

export const processNiftyMarketFeed = async (stocks_data: any) => {
    if (!stocks_data?.feeds) return;

    for (const key of Object.keys(stocks_data.feeds)) {
        // Options arrive as marketFF; the Nifty index arrives as indexFF.
        // Index candles feed the spot-trend filters.
        const fullFeed = stocks_data.feeds[key]?.fullFeed;
        const feedData = fullFeed?.marketFF ?? fullFeed?.indexFF;
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
        const volume = i1Candle.vol?.toNumber?.() ?? 0;
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

const finalizing = new Set<string>();

const getTradingUser = async () =>
    db[MODEL.USER].findOne({ where: { email: USER_DETAILS.EMAIL } });

export const markExitRetry = async (
    trade: any,
    error: any,
    config: NiftyScalpConfig,
) => {
    const retries = Number(trade.exit_retry_count || 0) + 1;
    const halted = retries >= MAX_EXIT_RETRIES;
    const waitSec =
        EXIT_RETRY_BACKOFF_SEC[
            Math.min(retries - 1, EXIT_RETRY_BACKOFF_SEC.length - 1)
        ];
    if (!halted) {
        exitRetryNotBefore.set(String(trade.id), Date.now() + waitSec * 1000);
    }
    const errorText = errText(error);
    await trade.update({
        exit_pending: true,
        exit_retry_count: retries,
        exit_halted: halted,
        order_lifecycle: halted ? 'HALTED' : 'EXIT_PENDING',
        last_order_error: errorText.slice(0, 500),
        is_active: true,
    });
    await logNiftyAudit({
        action: 'LIVE_ORDER_FAIL',
        reason: halted ? 'EXIT_HALTED_MAX_RETRIES' : 'EXIT_RETRY_SCHEDULED',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        config,
        metadata: {
            retries,
            max: MAX_EXIT_RETRIES,
            nextRetryInSec: halted ? null : waitSec,
            error: errorText,
            thinking: halted
                ? `SELL failed ${retries} times (last: ${errorText}). I stopped retrying so I do not spam Upstox. The position is STILL OPEN at the broker: square it off manually on Upstox.`
                : `SELL attempt ${retries}/${MAX_EXIT_RETRIES} failed (${errorText}). The position is still held, so the trade stays OPEN. Next attempt in ${waitSec}s.`,
        },
        skipThrottle: true,
    });
    notifyNiftyEvent(
        'LIVE_ORDER_FAIL',
        halted
            ? `Exit failed ${retries}x — HALTED. Square off manually on Upstox`
            : `Exit not confirmed — retry ${retries}/${MAX_EXIT_RETRIES} in ${waitSec}s (trade stays OPEN)`,
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
    // Two paths can learn about the same fill at once (engine wait + portfolio feed).
    if (finalizing.has(String(trade.id))) return false;
    finalizing.add(String(trade.id));
    try {
        return await finalizeNiftyExitInner({ trade, sellPrice, orderId });
    } finally {
        finalizing.delete(String(trade.id));
    }
};

const finalizeNiftyExitInner = async ({
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
    const entryPosition = await db[MODEL.POSITION].findByPk(fresh.position_id);
    // Mode follows how the trade was ENTERED, not the switch position now.
    const tradeWasLive = Boolean(entryPosition?.is_upstock_exectued);

    const ltp = Number(sellPrice || fresh.ltp);
    const avgBuy = Number(fresh.buy_price);
    const qty = Number(fresh.qty);
    const lotSize = Number(fresh.lot_size);
    const grossPl = calculateGrossPl(ltp, avgBuy, qty, lotSize);
    const mainCharges = calculateRoundTripCharges(qty, lotSize, avgBuy, {
        ...config,
        brokerage_per_lot: Number(config?.brokerage_per_lot ?? 40),
        slippage_pct: Number(config?.slippage_pct ?? 0.002),
    } as NiftyScalpConfig);
    // Legacy trades only: a hedge may still be open. New entries do not buy one.
    const hedge = hedgeLegView(fresh, lotSize, config);
    const hedgeGross = hedge?.hedgeGross ?? 0;
    const hedgeCharges = hedge?.hedgeCharges ?? 0;
    const hedgeNet = hedgeGross - hedgeCharges;
    // pl = gross of both legs, charges = both legs, net_pl = pl − charges
    const totalGross = grossPl + hedgeGross;
    const charges = Number((mainCharges + hedgeCharges).toFixed(2));
    const netPl = totalGross - charges;
    const exitReason =
        fresh.pending_exit_reason || fresh.exit_reason || 'EXIT';

    await fresh.update({
        is_active: false,
        sell_price: ltp,
        pl: totalGross,
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

    await recordTradeLeg({
        trade: fresh,
        legType: 'FULL_EXIT',
        side: 'SELL',
        lots: qty,
        price: ltp,
        reason: exitReason,
        brokerOrderId: orderId || fresh.exit_order_id,
        mode: tradeWasLive ? 'live' : 'paper',
        grossPl: totalGross,
        netPl,
        charges,
        avgBuyAfter: avgBuy,
        qtyAfter: 0,
        targetAfter: Number(fresh.target_price || 0),
        metadata: { exitReason, hedgeNet, hedgeGross, hedgeCharges, mainCharges },
    });

    const position = await db[MODEL.POSITION].findByPk(fresh.position_id);
    if (position) {
        await position.update({
            is_active: false,
            pl: netPl,
            end_time: moment(),
        });
    }

    exitRetryNotBefore.delete(String(fresh.id));
    let balanceNote = '';
    if (!tradeWasLive) {
        const hedgeQty = Number(fresh.hedge_qty || 0);
        const hedgeLtp = Number(fresh.hedge_ltp || fresh.hedge_buy_price || 0);
        await updateNiftyStrategyBalance(
            ltp * lotSize * qty +
                (hedgeQty > 0 ? hedgeLtp * lotSize * hedgeQty : 0),
        );
        balanceNote = 'Paper balance credited with the sale proceeds.';
    } else {
        const synced = await syncStrategyBalanceFromUpstox();
        balanceNote =
            synced != null
                ? `Balance re-read from Upstox: ₹${Number(synced).toFixed(2)}.`
                : 'Upstox balance read failed; balance will refresh on the next sync.';
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
            mode: tradeWasLive ? 'live' : 'paper',
            thinking: `${tradeWasLive ? 'Upstox confirmed the SELL' : 'Paper SELL filled'} at ${ltp} (bought ${avgBuy}, ${qty} lot x ${lotSize}). Gross ₹${totalGross.toFixed(2)} - charges ₹${charges.toFixed(2)} = net ₹${netPl.toFixed(2)}. Reason: ${exitReason}. Trade closed. ${balanceNote}`,
        },
        skipThrottle: true,
    });
    notifyNiftyEvent(
        exitReason === 'TARGET_HIT' ? 'TARGET_HIT' : 'EXIT',
        `Sold (${tradeWasLive ? 'broker confirmed' : 'paper'}). Net P&L ₹${netPl.toFixed(2)}`,
        { ltp, qty, netPl, exitReason, orderId },
    );
    return true;
};

/** Exit price was recorded from a quote (broker gave no average). Fix it once the real fill arrives. */
export const correctClosedTradeExitPrice = async ({
    trade,
    brokerPrice,
    orderId,
    config,
}: {
    trade: any;
    brokerPrice: number;
    orderId: string;
    config: NiftyScalpConfig;
}) => {
    const fresh = await db[MODEL.TRADE].findByPk(trade.id);
    if (!fresh || fresh.is_active) return false;
    const oldSell = Number(fresh.sell_price || 0);
    if (Math.abs(oldSell - brokerPrice) <= 0.004) return false;

    const qty = Number(fresh.qty);
    const lotSize = Number(fresh.lot_size);
    const avgBuy = Number(fresh.buy_price);
    const hedge = hedgeLegView(fresh, lotSize, config);
    const totalGross =
        calculateGrossPl(brokerPrice, avgBuy, qty, lotSize) +
        (hedge?.hedgeGross ?? 0);
    const charges = Number(fresh.charges || 0);
    const netPl = totalGross - charges;
    const oldNet = Number(fresh.net_pl || 0);

    await fresh.update({ sell_price: brokerPrice, pl: totalGross, net_pl: netPl });
    const position = await db[MODEL.POSITION].findByPk(fresh.position_id);
    if (position) await position.update({ pl: netPl });
    await syncStrategyBalanceFromUpstox();

    await logNiftyAudit({
        action: 'PRICE_CORRECTED',
        reason: 'EXIT_PRICE_FROM_BROKER',
        instrumentKey: fresh.instrument_key,
        tradeId: fresh.id,
        config,
        skipThrottle: true,
        metadata: {
            orderId,
            oldSellPrice: oldSell,
            newSellPrice: brokerPrice,
            oldNetPl: oldNet,
            newNetPl: netPl,
            thinking: `The trade was closed using a quoted exit price (${oldSell}). Upstox's real average sell price is ${brokerPrice}, so P/L was corrected: net ₹${oldNet.toFixed(2)} -> ₹${netPl.toFixed(2)}.`,
        },
    });
    notifyNiftyEvent(
        'EXIT',
        `Exit price corrected to Upstox fill ${brokerPrice}. Net ₹${netPl.toFixed(2)}`,
        { tradeId: fresh.id, orderId },
    );
    return true;
};

/**
 * A BUY we stopped watching (timeout / restart) has filled at Upstox.
 * Turn it into a managed trade so it gets a stop-loss and exit.
 * If it cannot be managed (partial lot, another trade open), sell it back.
 */
export const adoptOrphanEntryFill = async ({
    orderRow,
    averagePrice,
    filledQty,
    config,
}: {
    orderRow: any;
    averagePrice: number;
    filledQty: number;
    config: NiftyScalpConfig;
}) => {
    // Claim the row so the feed and the reconcile cron cannot both adopt it.
    const [claimed] = await db[MODEL.UPSTOCK_ORDERS].update(
        { purpose: 'ENTRY_ADOPTING' },
        { where: { id: orderRow.id, purpose: 'ENTRY_ORPHAN' } },
    );
    if (!claimed) return false;

    const instrumentKey = orderRow.instrument_key;
    const orderId = String(orderRow.upstock_order_id);
    const user = await getTradingUser();
    const option = await db[MODEL.HEDGING_OPTIONS].findOne({
        where: { instrument_key: instrumentKey },
    });
    const lotSize = Number(option?.lot_size) || 0;
    const lotsExact = lotSize > 0 ? filledQty / lotSize : 0;
    const lots = Math.round(lotsExact);
    const wholeLots = lots >= 1 && Math.abs(lotsExact - lots) < 1e-6;
    const active = await db[MODEL.POSITION].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP, is_active: true },
    });
    let fillPrice = Number(averagePrice || 0);
    if (!(fillPrice > 0)) {
        const remote = user?.token
            ? await get_upstox_order_details(user.token, orderId)
            : null;
        fillPrice = Number(remote?.average_price || option?.ltp || 0);
    }

    if (!option || !wholeLots || active || !(fillPrice > 0)) {
        const sameInstrument =
            active &&
            (await db[MODEL.TRADE].findOne({
                where: { position_id: active.id, instrument_key: instrumentKey },
            }));
        const cannot = !option
            ? 'option not found in the database'
            : !wholeLots
              ? `filled quantity ${filledQty} is not a whole lot (lot size ${lotSize})`
              : active
                ? 'another Nifty trade is already open'
                : 'no usable fill price';
        await logNiftyAudit({
            action: 'ORDER_ADOPTED',
            reason: sameInstrument ? 'ADOPT_SKIPPED_SAME_INSTRUMENT' : 'ADOPT_IMPOSSIBLE',
            instrumentKey,
            config,
            skipThrottle: true,
            metadata: {
                orderId,
                filledQty,
                cannot,
                thinking: sameInstrument
                    ? `Order ${orderId} filled ${filledQty} more of an instrument that is already an open trade. I cannot merge it safely: CHECK UPSTOX quantity.`
                    : `Late BUY fill (${filledQty} qty) cannot become a managed trade: ${cannot}. Selling it back so no unmanaged position remains.`,
            },
        });
        if (sameInstrument) {
            await db[MODEL.UPSTOCK_ORDERS].update(
                { purpose: 'ENTRY_ORPHAN_FAILED' },
                { where: { id: orderRow.id } },
            );
            notifyNiftyEvent(
                'LIVE_ORDER_FAIL',
                'Late BUY fill on an open instrument — check Upstox quantity',
                { orderId, instrumentKey, filledQty },
            );
            return false;
        }
        const flat = await flattenStrayQuantity({
            user,
            config,
            instrumentKey,
            quantity: filledQty,
            why: `Late BUY fill ${orderId} could not be managed (${cannot}).`,
        });
        await db[MODEL.UPSTOCK_ORDERS].update(
            { purpose: flat ? 'ENTRY_FLATTENED' : 'ENTRY_ORPHAN_FAILED' },
            { where: { id: orderRow.id } },
        );
        return false;
    }

    const target = calculateTargetLtp(fillPrice, lots, lotSize, config);
    const tradeRef = Math.floor(100000 + Math.random() * 900000);
    const position = await db[MODEL.POSITION].create({
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        is_active: true,
        qty: lots,
        trade_id: tradeRef,
        date: moment().format('YYYY-MM-DD'),
        start_time: moment(),
        required_margin: fillPrice * lotSize * lots,
        is_exectued: true,
        is_upstock_exectued: true,
    });
    const trade = await db[MODEL.TRADE].create({
        position_id: position.id,
        options_chain_id: option.options_chain_id || option.id,
        trade_id: String(tradeRef),
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        trading_symbol: option.trading_symbol,
        instrument_key: instrumentKey,
        instrument_type: option.instrument_type,
        trade_type: 'BUY',
        buy_price: fillPrice,
        target_price: target,
        stop_loss: 0,
        is_active: true,
        ltp: Number(option.ltp) > 0 ? Number(option.ltp) : fillPrice,
        qty: lots,
        lot_size: lotSize,
        highest_ltp: Math.max(fillPrice, Number(option.ltp) || 0),
        original_qty: lots,
        order_lifecycle: 'OPEN',
        broker_confirmed: true,
        entry_order_id: orderId,
        exit_pending: false,
        exit_retry_count: 0,
        exit_halted: false,
    });
    await db[MODEL.UPSTOCK_ORDERS].update(
        {
            purpose: 'ENTRY',
            trade_id: trade.id,
            postion_id: position.id,
        },
        { where: { id: orderRow.id } },
    );
    const synced = await syncStrategyBalanceFromUpstox();
    await recordTradeLeg({
        trade,
        legType: 'ENTRY',
        side: 'BUY',
        lots,
        price: fillPrice,
        reason: 'ADOPTED_LATE_FILL',
        brokerOrderId: orderId,
        mode: 'live',
        avgBuyAfter: fillPrice,
        qtyAfter: lots,
        targetAfter: target,
        metadata: { adopted: true },
    });
    await logNiftyAudit({
        action: 'ORDER_ADOPTED',
        reason: 'LATE_BUY_FILL_ADOPTED',
        instrumentKey,
        tradeId: trade.id,
        engineState: 'IN_TRADE',
        config,
        skipThrottle: true,
        metadata: {
            orderId,
            fillPrice,
            lots,
            target,
            balance: synced,
            thinking: `BUY ${orderId} had timed out earlier but Upstox filled it at ${fillPrice} (${lots} lot). I created the trade now, so the stop (${NIFTY_STOP_POINTS} pts), trailing and exit rules apply to it like any other trade.`,
        },
    });
    notifyNiftyEvent(
        'ENTRY_FILLED',
        `Late BUY fill adopted ${option.trading_symbol} @ ${fillPrice}`,
        { orderId, fillPrice, lots },
    );
    return true;
};

export const openNiftyScalpEntry = async ({
    option,
    signal,
    config,
    reason,
    indicators,
    hedgeOption,
}: {
    option: any;
    signal: 'CE_BUY' | 'PE_BUY';
    config: NiftyScalpConfig;
    reason: string;
    indicators: Record<string, number | undefined>;
    hedgeOption?: any;
}) => {
    if (entryInProgress) return null;
    if (getEntryCooldownRemainingMs() > 0) return null;
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

        const useHedge =
            NIFTY_HEDGE_ENABLED &&
            Boolean(hedgeOption?.instrument_key) &&
            Number(hedgeOption?.ltp) > 0;
        if (NIFTY_HEDGE_ENABLED && !useHedge) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'HEDGE_OPTION_REQUIRED',
                signal,
                instrumentKey: option.instrument_key,
                config,
                indicators,
            });
            return null;
        }

        const hedgeLtp = useHedge ? Number(hedgeOption.ltp) : 0;
        const balance = await getNiftyStrategyBalance(config);
        const reserved = twoLotWithHedgeCost(
            quoteLtp,
            hedgeLtp,
            lotSize,
            Number(config.add_lot_points || 10),
        );
        if (reserved == null || balance < reserved) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'INSUFFICIENT_BALANCE_2LOT',
                signal,
                instrumentKey: option.instrument_key,
                config,
                indicators,
                metadata: { balance, required: reserved, quoteLtp, hedgeLtp },
            });
            notifyNiftyEvent(
                'CANNOT_ADD_LOT',
                'Balance cannot cover entry + one add lot',
                { balance, required: reserved },
            );
            return null;
        }

        const user = await getTradingUser();
        const liveMode = isLiveTradingEnabled(user, config);

        // Paper fills cross the spread so results are not flattered by last-price fills.
        let fillPrice = liveMode
            ? quoteLtp
            : Number((quoteLtp + NIFTY_PAPER_SPREAD_POINTS).toFixed(2));
        let entryOrderId: string | null = null;
        let hedgeFill = useHedge ? hedgeLtp : 0;
        let hedgeOrderId: string | null = null;
        let brokerConfirmed = !liveMode;

        await logNiftyAudit({
            action: 'ENTRY_ATTEMPT',
            reason,
            signal,
            instrumentKey: option.instrument_key,
            engineState: 'ENTERING',
            config,
            indicators,
            skipThrottle: true,
            metadata: {
                symbol: option.trading_symbol,
                quoteLtp,
                lotSize,
                balance,
                liveMode,
                thinking: `Signal ${signal} accepted (${reason}). ${option.trading_symbol} quote ${quoteLtp}, cost for 1 lot ≈ ₹${(quoteLtp * lotSize).toFixed(0)}, balance ₹${balance.toFixed(0)}. Filters passed (trend, extension, volume, day limits). ${
                    liveMode
                        ? 'LIVE mode: sending a real BUY and waiting for Upstox to confirm.'
                        : `PAPER mode: simulated fill at quote + ${NIFTY_PAPER_SPREAD_POINTS} spread.`
                }`,
            },
        });

        if (liveMode) {
            const live = await placeConfirmedUpstoxOrder({
                user,
                config,
                instrumentKey: option.instrument_key,
                quantity: lotSize * 1,
                side: 'BUY',
                purpose: 'ENTRY',
                why: `${signal} entry (${reason}) on ${option.trading_symbol}, quote ${quoteLtp}.`,
            });

            if (!live.ok) {
                startEntryCooldown();
                const failText = live.timedOut
                    ? live.stillPending
                        ? 'The BUY timed out and Upstox has not settled the cancel yet. It is being watched and will be adopted if it fills.'
                        : 'The BUY timed out and was cancelled.'
                    : `Upstox rejected the BUY: ${errText(live.error || live.status)}.`;
                await logNiftyAudit({
                    action: 'LIVE_ORDER_FAIL',
                    reason: live.timedOut
                        ? 'ENTRY_CONFIRM_TIMEOUT'
                        : 'ENTRY_BUY_FAILED',
                    signal,
                    instrumentKey: option.instrument_key,
                    engineState: 'SCANNING',
                    config,
                    indicators,
                    metadata: {
                        live,
                        cooldownSec: ENTRY_FAIL_COOLDOWN_MS / 1000,
                        thinking: `${failText} No trade was created. I will not try a new entry for ${ENTRY_FAIL_COOLDOWN_MS / 1000}s, so one rejected signal is not retried every second.`,
                    },
                    skipThrottle: true,
                });
                return null;
            }

            fillPrice = Number(live.averagePrice || quoteLtp);
            entryOrderId = live.orderId || null;
            brokerConfirmed = true;

            if (useHedge) {
                const hedgeLive = await placeConfirmedUpstoxOrder({
                    user,
                    config,
                    instrumentKey: hedgeOption.instrument_key,
                    quantity: lotSize * 1,
                    side: 'BUY',
                    purpose: 'ENTRY',
                });
                if (!hedgeLive.ok) {
                    // Main already filled — leave hedge empty; soft rules still manage main
                    await logNiftyAudit({
                        action: 'LIVE_ORDER_FAIL',
                        reason: 'HEDGE_BUY_FAILED',
                        signal,
                        instrumentKey: hedgeOption.instrument_key,
                        config,
                        metadata: { hedgeLive, mainOrderId: entryOrderId },
                        skipThrottle: true,
                    });
                    hedgeFill = 0;
                } else {
                    hedgeFill = Number(hedgeLive.averagePrice || hedgeLtp);
                    hedgeOrderId = hedgeLive.orderId || null;
                }
            }
        }

        const target = calculateTargetLtp(fillPrice, 1, lotSize, config);
        const tradeId = Math.floor(100000 + Math.random() * 900000);
        const today = moment().format('YYYY-MM-DD');
        const hasHedge = useHedge && hedgeFill > 0;

        const position = await db[MODEL.POSITION].create({
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
            qty: 1,
            trade_id: tradeId,
            date: today,
            start_time: moment(),
            required_margin: fillPrice * lotSize + (hasHedge ? hedgeFill * lotSize : 0),
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
            stop_loss: 0,
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
            hedge_instrument_key: hasHedge ? hedgeOption.instrument_key : null,
            hedge_trading_symbol: hasHedge ? hedgeOption.trading_symbol : null,
            hedge_buy_price: hasHedge ? hedgeFill : null,
            hedge_qty: hasHedge ? 1 : 0,
            hedge_ltp: hasHedge ? hedgeFill : null,
            hedge_entry_order_id: hedgeOrderId,
        });

        if (entryOrderId) {
            await db[MODEL.UPSTOCK_ORDERS].update(
                { trade_id: trade.id, postion_id: position.id },
                { where: { upstock_order_id: entryOrderId } },
            );
        }
        if (hedgeOrderId) {
            await db[MODEL.UPSTOCK_ORDERS].update(
                { trade_id: trade.id, postion_id: position.id },
                { where: { upstock_order_id: hedgeOrderId } },
            );
        }

        if (!liveMode) {
            await updateNiftyStrategyBalance(
                -(fillPrice * lotSize) -
                    (hasHedge ? hedgeFill * lotSize : 0),
            );
        } else {
            await syncStrategyBalanceFromUpstox();
        }

        await recordTradeLeg({
            trade,
            legType: 'ENTRY',
            side: 'BUY',
            lots: 1,
            price: fillPrice,
            reason,
            brokerOrderId: entryOrderId,
            mode: liveMode ? 'live' : 'paper',
            avgBuyAfter: fillPrice,
            qtyAfter: 1,
            targetAfter: target,
            metadata: {
                signal,
                brokerConfirmed,
                hedge: hasHedge
                    ? {
                          key: hedgeOption.instrument_key,
                          price: hedgeFill,
                      }
                    : null,
            },
        });

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
                hedgeFill: hasHedge ? hedgeFill : null,
                hedgeKey: hasHedge ? hedgeOption.instrument_key : null,
                thinking: `${
                    liveMode
                        ? `Upstox confirmed the BUY at ${fillPrice} (quote was ${quoteLtp}, slippage ${(fillPrice - quoteLtp).toFixed(2)} pts)`
                        : `Paper BUY filled at ${fillPrice} (quote ${quoteLtp} + spread)`
                }${hasHedge ? ` + hedge @ ${hedgeFill}` : ''}. Trade created and now managed by the engine: hard stop at ${(fillPrice - NIFTY_STOP_POINTS).toFixed(2)} (-${NIFTY_STOP_POINTS} pts), breakeven protection from net ₹${NIFTY_BREAKEVEN_ARM_RS} (1-minute close, or a fast drop), trailing stop from net ₹${NIFTY_TRAIL_ARM_RS} (peak − ${NIFTY_TRAIL_POINTS} pts, never below +₹${NIFTY_TRAIL_FLOOR_RS}).`,
            },
            skipThrottle: true,
        });

        notifyNiftyEvent(
            'ENTRY_FILLED',
            liveMode
                ? `Live BUY ${option.instrument_type} @ ${fillPrice}${hasHedge ? ` + hedge @ ${hedgeFill}` : ''}`
                : `Paper BUY ${option.instrument_type} @ ${fillPrice}${hasHedge ? ` + hedge @ ${hedgeFill}` : ''}`,
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

    if (qty >= NIFTY_MAX_LOTS) return false;
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
        stop_loss: 0,
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
    } else {
        await syncStrategyBalanceFromUpstox();
    }

    await recordTradeLeg({
        trade,
        legType: 'ADD_LOT',
        side: 'BUY',
        lots: 1,
        price: addPrice,
        reason: 'DRAWDOWN_10_POINTS',
        mode: liveMode ? 'live' : 'paper',
        avgBuyAfter: newAvg,
        qtyAfter: newQty,
        targetAfter: newTarget,
        metadata: { oldAvg: avgBuy, oldQty: qty },
    });

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
    const tradeKey = String(trade.id);

    if (trade.exit_halted) {
        notifyNiftyEvent(
            'LIVE_ORDER_FAIL',
            'Exit halted — manual square-off required on Upstox',
            { tradeId: trade.id },
        );
        return false;
    }

    // Only one exit attempt per trade at a time. The engine ticks every second
    // and a SELL can take longer than that to confirm.
    if (exitsInFlight.has(tradeKey)) {
        await logNiftyAudit({
            action: 'SAFETY_CHECK',
            reason: 'EXIT_ALREADY_IN_FLIGHT',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            config,
            metadata: {
                requestedReason: exitReason,
                thinking: `Exit (${exitReason}) requested again, but a SELL for this trade is already being placed or confirmed. I will not send a second SELL: that could open a short position.`,
            },
        });
        return false;
    }

    const notBefore = exitRetryNotBefore.get(tradeKey) || 0;
    if (Date.now() < notBefore) {
        const waitSec = Math.ceil((notBefore - Date.now()) / 1000);
        await logNiftyAudit({
            action: 'SAFETY_CHECK',
            reason: 'EXIT_RETRY_BACKOFF',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            config,
            metadata: {
                requestedReason: exitReason,
                retries: trade.exit_retry_count,
                waitSec,
                thinking: `Exit (${exitReason}) is due but the last SELL failed. Waiting ${waitSec}s before attempt ${Number(trade.exit_retry_count || 0) + 1}. Position stays OPEN.`,
            },
        });
        return false;
    }

    exitsInFlight.add(tradeKey);
    try {
        return await closeNiftyScalpTradeInner({
            trade,
            position,
            config,
            exitReason,
        });
    } finally {
        exitsInFlight.delete(tradeKey);
    }
};

const closeNiftyScalpTradeInner = async ({
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
    const user = await getTradingUser();
    const globalLive = isLiveTradingEnabled(user, config);
    // The trade decides live vs paper, not the switch now: a live position must
    // be sold at Upstox even if live was switched off, and a paper trade must
    // never send a real SELL.
    const entryPosition =
        position ?? (await db[MODEL.POSITION].findByPk(trade.position_id));
    const tradeWasLive = Boolean(entryPosition?.is_upstock_exectued);
    const liveMode = tradeWasLive;
    const ltp = Number(trade.ltp);
    const qty = Number(trade.qty);
    const lotSize = Number(trade.lot_size);

    if (tradeWasLive !== globalLive) {
        await logNiftyAudit({
            action: 'SAFETY_CHECK',
            reason: 'MODE_MISMATCH_FOLLOWS_TRADE',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            config,
            metadata: {
                tradeWasLive,
                globalLive,
                thinking: tradeWasLive
                    ? 'This trade was bought LIVE but live trading is switched off now. It is still sold on Upstox, because the position really exists there.'
                    : 'This trade was a PAPER trade but live trading is on now. It is closed as paper: no real SELL is sent for something that was never bought.',
            },
            skipThrottle: true,
        });
    }

    // Mark exit pending BEFORE placing sell — never pretend closed
    await trade.update({
        exit_pending: true,
        pending_exit_reason: exitReason,
        order_lifecycle: 'EXIT_PENDING',
    });

    if (!liveMode) {
        await finalizeNiftyExitAfterBrokerFill({
            trade,
            sellPrice: Math.max(
                Number((ltp - NIFTY_PAPER_SPREAD_POINTS).toFixed(2)),
                0.05,
            ),
        });
        return true;
    }

    const exitAudit = {
        config,
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        purpose: 'EXIT',
        side: 'SELL' as const,
    };

    const sellHedgeIfAny = async () => {
        const hedgeKey = trade.hedge_instrument_key;
        const hedgeQty = Number(trade.hedge_qty || 0);
        if (!hedgeKey || hedgeQty <= 0) return;
        const hedgeSell = await placeConfirmedUpstoxOrder({
            user,
            config,
            instrumentKey: hedgeKey,
            quantity: lotSize * hedgeQty,
            side: 'SELL',
            purpose: 'EXIT',
            positionId: entryPosition?.id,
            tradeId: trade.id,
            why: `Closing the legacy hedge leg together with the main leg (${exitReason}).`,
            forceLive: true,
        });
        if (hedgeSell.ok) {
            await trade.update({
                hedge_ltp: Number(hedgeSell.averagePrice || trade.hedge_ltp),
            });
        }
    };

    // Resume wait on in-flight EXIT — never double-SELL while Pending
    if (trade.exit_order_id && user?.token) {
        const existing = await db[MODEL.UPSTOCK_ORDERS].findOne({
            where: { upstock_order_id: trade.exit_order_id },
        });
        if (existing && isOrderFilled(existing.status)) {
            await sellHedgeIfAny();
            await finalizeNiftyExitAfterBrokerFill({
                trade,
                sellPrice: Number(existing.average_price || ltp),
                orderId: trade.exit_order_id,
            });
            return true;
        }
        if (existing && isOrderPending(existing.status)) {
            await logNiftyAudit({
                action: 'SAFETY_CHECK',
                reason: 'RESUME_EXISTING_EXIT_ORDER',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                skipThrottle: true,
                metadata: {
                    orderId: trade.exit_order_id,
                    status: existing.status,
                    thinking: `A SELL (${trade.exit_order_id}) is already working at Upstox (status "${existing.status}"). Waiting on it instead of sending another.`,
                },
            });
            const resumed = await waitForOrderConfirmation({
                orderId: String(trade.exit_order_id),
                accessToken: user.token,
                audit: exitAudit,
            });
            if (resumed.ok) {
                await sellHedgeIfAny();
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
            // Rejected / cancelled → count the retry, clear the id. The fresh
            // SELL goes out on a later tick, after the backoff.
            if (resumed.rejected || isOrderRejected(resumed.status)) {
                await markExitRetry(
                    trade,
                    resumed.error || resumed.status,
                    config,
                );
                await trade.update({ exit_order_id: null });
                trade.exit_order_id = null;
                return false;
            }
        }
    }

    // Safety: confirm the broker really holds what we are about to sell.
    // A SELL on a position that is already flat (manual square-off, earlier
    // fill) would open a naked short.
    let sellQty = lotSize * qty;
    const ageSec = (Date.now() - new Date(trade.createdAt).getTime()) / 1000;
    if (user?.token && ageSec >= 90) {
        const positions = await getUpstoxPositionsOrNull(user.token);
        if (positions == null) {
            await logNiftyAudit({
                action: 'SAFETY_CHECK',
                reason: 'POSITIONS_CHECK_UNAVAILABLE',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                config,
                metadata: {
                    thinking:
                        'Could not read positions from Upstox before selling. Exiting is more important than the check, so the SELL goes ahead.',
                },
            });
        } else {
            const brokerQty = positions
                .filter((p) => p.instrument_key === trade.instrument_key)
                .reduce((sum, p) => sum + Number(p.quantity || 0), 0);
            if (brokerQty <= 0) {
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
                await logNiftyAudit({
                    action: 'SAFETY_CHECK',
                    reason:
                        brokerQty === 0
                            ? 'BROKER_ALREADY_FLAT'
                            : 'BROKER_SHORT_DETECTED',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        brokerQty,
                        expectedQty: sellQty,
                        foundFilledSell: Boolean(filledSell),
                        thinking:
                            brokerQty === 0
                                ? `Exit wanted (${exitReason}) but Upstox shows NO position in this instrument. Selling now would open a short, so no SELL is sent. ${filledSell ? `A SELL order (${filledSell.upstock_order_id}) did fill earlier at ${filledSell.average_price}: closing the trade with that price.` : 'It was probably squared off manually on Upstox: closing the trade record at the last price.'}`
                                : `Upstox shows a NET SHORT (${brokerQty}) in this instrument. I will not sell more. CHECK UPSTOX NOW.`,
                    },
                });
                if (brokerQty < 0) {
                    notifyNiftyEvent(
                        'LIVE_ORDER_FAIL',
                        `Broker shows net short ${brokerQty} — check Upstox now`,
                        { tradeId: trade.id, brokerQty },
                    );
                    return false;
                }
                await trade.update({
                    pending_exit_reason: filledSell
                        ? exitReason
                        : 'BROKER_FLAT_MANUAL_SQUARE_OFF',
                });
                await finalizeNiftyExitAfterBrokerFill({
                    trade,
                    sellPrice: Number(filledSell?.average_price || ltp),
                    orderId: filledSell?.upstock_order_id,
                });
                return true;
            }
            if (brokerQty < sellQty) {
                await logNiftyAudit({
                    action: 'SAFETY_CHECK',
                    reason: 'BROKER_QTY_LOWER_THAN_DB',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    config,
                    skipThrottle: true,
                    metadata: {
                        brokerQty,
                        expectedQty: sellQty,
                        thinking: `Upstox holds ${brokerQty} but the trade says ${sellQty}. Selling only ${brokerQty} so I never sell more than exists.`,
                    },
                });
                sellQty = brokerQty;
            }
        }
    }

    const live = await placeConfirmedUpstoxOrder({
        user,
        config,
        instrumentKey: trade.instrument_key,
        quantity: sellQty,
        side: 'SELL',
        purpose: 'EXIT',
        positionId: entryPosition?.id,
        tradeId: trade.id,
        why: `Exit rule ${exitReason}: LTP ${ltp}, bought ${Number(trade.buy_price)}.`,
        forceLive: true,
        // Save the order id at once so a restart or overlapping tick sees it.
        onOrderPlaced: async (orderId) => {
            await trade.update({ exit_order_id: orderId });
            trade.exit_order_id = orderId;
        },
    });

    if (live.ok && !live.paper) {
        await trade.update({ exit_order_id: live.orderId || null });
        await sellHedgeIfAny();
        await finalizeNiftyExitAfterBrokerFill({
            trade,
            sellPrice: Number(live.averagePrice || ltp),
            orderId: live.orderId,
        });
        return true;
    }

    // Rejected / timeout / error → keep trade OPEN (NOT paper close)
    if (live.rejected && !live.timedOut) {
        await trade.update({ exit_order_id: null });
        trade.exit_order_id = null;
        await markExitRetry(trade, live.error || live.status || live, config);
    } else if (live.timedOut) {
        if (live.orderId) {
            await trade.update({ exit_order_id: live.orderId });
        }
        await logNiftyAudit({
            action: 'LIVE_ORDER_FAIL',
            reason: 'EXIT_CONFIRM_TIMEOUT',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            config,
            skipThrottle: true,
            metadata: {
                orderId: live.orderId,
                thinking: `The SELL ${live.orderId} was not confirmed in 25s. It is still working at Upstox, so the trade stays OPEN and the next tick keeps waiting on the SAME order (no second SELL).`,
            },
        });
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

    await recordTradeLeg({
        trade,
        legType: 'PARTIAL_SELL',
        side: 'SELL',
        lots: lotsToSell,
        price: sellPrice,
        reason,
        mode: liveMode ? 'live' : 'paper',
        grossPl: partialGross,
        netPl: partialNet,
        charges: partialCharges,
        avgBuyAfter: avgBuy,
        qtyAfter: remaining,
        targetAfter: newTarget,
        metadata: { lotsSold: lotsToSell, planB: true },
    });

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

const chargesCoverConfig = (config: NiftyScalpConfig): NiftyScalpConfig => ({
    ...config,
    target_profit_rs: 0,
});

/** Buy back the Plan B scalp quantity after a 5-point drop. Core average stays put. */
export const buyNiftyPlanBScalp = async ({
    trade,
    position,
    config,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
}) => {
    if (trade.exit_pending || trade.exit_halted) return false;
    if (Number(trade.plan_b_scalp_open || 0) > 0) return false;

    const ltp = Number(trade.ltp);
    const lotSize = Number(trade.lot_size);
    const want = Math.floor(Number(trade.plan_b_scalp_lots || 0));
    if (want < 1 || ltp <= 0 || lotSize <= 0) return false;

    const balance = await getNiftyStrategyBalance(config);
    const lotCost = ltp * lotSize;
    const affordable = Math.floor(balance / lotCost);
    const lots = Math.min(want, affordable);
    if (lots < 1) {
        await logNiftyAudit({
            action: 'PLAN_B_REBUY',
            reason: 'INSUFFICIENT_BALANCE_PLAN_B_REBUY',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            engineState: 'RECOVERY',
            config,
            metadata: {
                ltp,
                want,
                balance,
                required: lotCost,
                thinking: 'Plan B wanted to buy the sold quantity. Balance cannot pay.',
            },
        });
        return false;
    }

    const user = await getTradingUser();
    const liveMode = isLiveTradingEnabled(user, config);
    let buyPrice = ltp;

    if (liveMode) {
        const live = await placeConfirmedUpstoxOrder({
            user,
            config,
            instrumentKey: trade.instrument_key,
            quantity: lotSize * lots,
            side: 'BUY',
            purpose: 'ADD_LOT',
            positionId: position.id,
            tradeId: trade.id,
        });
        if (!live.ok) return false;
        buyPrice = Number(live.averagePrice || ltp);
    }

    const qty = Number(trade.qty);
    const newQty = qty + lots;
    const coreAvg = Number(trade.buy_price);

    await trade.update({
        qty: newQty,
        original_qty: newQty,
        ltp: buyPrice,
        plan_b_scalp_open: lots,
        plan_b_scalp_buy_price: buyPrice,
        broker_confirmed: true,
    });
    await position.update({ qty: newQty });

    if (!liveMode) {
        await updateNiftyStrategyBalance(-(buyPrice * lotSize * lots));
    }

    await recordTradeLeg({
        trade,
        legType: 'PLAN_B_REBUY',
        side: 'BUY',
        lots,
        price: buyPrice,
        reason: 'PLAN_B_DROP_5',
        mode: liveMode ? 'live' : 'paper',
        avgBuyAfter: coreAvg,
        qtyAfter: newQty,
        metadata: { scalpBuy: buyPrice, coreAvg, want },
    });

    await logNiftyAudit({
        action: 'PLAN_B_REBUY',
        reason: 'PLAN_B_DROP_5',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'RECOVERY',
        config,
        metadata: {
            lots,
            buyPrice,
            coreAvg,
            newQty,
            liveMode,
            thinking: `Plan B bought ${lots} lot(s) @ ${buyPrice}. Core average stays ${coreAvg}.`,
        },
        skipThrottle: true,
    });

    notifyNiftyEvent(
        'PLAN_B_REBUY',
        `Plan B bought ${lots} lot(s) @ ${buyPrice}`,
        { lots, buyPrice, coreAvg },
    );

    return true;
};

/**
 * Sell the open Plan B scalp lots after a 3-point bounce.
 * Net profit is subtracted from the kept lot's cost so its average falls.
 */
export const sellNiftyPlanBBounce = async ({
    trade,
    position,
    config,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
}) => {
    if (trade.exit_pending || trade.exit_halted) return false;

    const qty = Number(trade.qty);
    const lots = Math.floor(Number(trade.plan_b_scalp_open || 0));
    const scalpBuy = Number(trade.plan_b_scalp_buy_price || 0);
    if (lots < 1 || lots >= qty || scalpBuy <= 0) return false;

    const ltp = Number(trade.ltp);
    const lotSize = Number(trade.lot_size);
    const user = await getTradingUser();
    const liveMode = isLiveTradingEnabled(user, config);
    let sellPrice = ltp;

    if (liveMode) {
        const live = await placeConfirmedUpstoxOrder({
            user,
            config,
            instrumentKey: trade.instrument_key,
            quantity: lotSize * lots,
            side: 'SELL',
            purpose: 'PARTIAL_EXIT',
            positionId: position.id,
            tradeId: trade.id,
        });
        if (!live.ok) return false;
        sellPrice = Number(live.averagePrice || ltp);
    }

    const partialGross = (sellPrice - scalpBuy) * lotSize * lots;
    const partialCharges = calculateRoundTripCharges(
        lots,
        lotSize,
        scalpBuy,
        config,
    );
    const partialNet = partialGross - partialCharges;
    const coreQty = qty - lots;
    const coreAvg = Number(trade.buy_price);
    const coreCost = coreAvg * lotSize * coreQty;
    const newAvg = (coreCost - partialNet) / (lotSize * coreQty);
    const cover = chargesCoverConfig(config);
    const newTarget = calculateTargetLtp(newAvg, coreQty, lotSize, cover);

    await trade.update({
        qty: coreQty,
        original_qty: coreQty,
        buy_price: newAvg,
        pl: Number(trade.pl || 0) + partialNet,
        target_price: newTarget,
        ltp: sellPrice,
        plan_b_scalp_open: 0,
        plan_b_scalp_buy_price: null,
        plan_b_last_sell_price: sellPrice,
    });
    await position.update({
        qty: coreQty,
        required_margin: newAvg * lotSize * coreQty,
    });

    if (!liveMode) {
        await updateNiftyStrategyBalance(sellPrice * lotSize * lots);
    } else {
        await updateNiftyStrategyBalance(partialNet);
    }

    await recordTradeLeg({
        trade,
        legType: 'PARTIAL_SELL',
        side: 'SELL',
        lots,
        price: sellPrice,
        reason: 'PLAN_B_BOUNCE_3',
        mode: liveMode ? 'live' : 'paper',
        grossPl: partialGross,
        netPl: partialNet,
        charges: partialCharges,
        avgBuyAfter: newAvg,
        qtyAfter: coreQty,
        targetAfter: newTarget,
        metadata: { scalpBuy, oldAvg: coreAvg, partialNet },
    });

    await logNiftyAudit({
        action: 'PLAN_B_SCALP',
        reason: 'PLAN_B_BOUNCE_3',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'RECOVERY',
        config,
        metadata: {
            lots,
            sellPrice,
            scalpBuy,
            partialNet,
            oldAvg: coreAvg,
            newAvg,
            newTarget,
            liveMode,
            thinking: `Bounce sell ${lots} lot(s). Core average ${coreAvg.toFixed(2)} → ${newAvg.toFixed(2)}.`,
        },
        skipThrottle: true,
    });

    notifyNiftyEvent(
        'PLAN_B_SCALP',
        `Plan B sold ${lots} lot(s) @ ${sellPrice}. Average now ${newAvg.toFixed(2)}`,
        { lots, sellPrice, newAvg, partialNet },
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
                why: `Manual entry from the frontend: ${qty} lot(s) of ${option.trading_symbol}.`,
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

        await recordTradeLeg({
            trade,
            legType: 'MANUAL_ENTRY',
            side: 'BUY',
            lots: qty,
            price: fillPrice,
            reason: 'MANUAL_FRONTEND_ENTRY',
            brokerOrderId: entryOrderId,
            mode: liveMode ? 'live' : 'paper',
            avgBuyAfter: fillPrice,
            qtyAfter: qty,
            targetAfter: target,
            metadata: { manual: true, referenceBuyPrice },
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
