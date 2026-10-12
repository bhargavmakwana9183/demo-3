import {
    NiftyScalpConfig,
    calculateRoundTripCharges,
    calculateTargetLtp,
} from './nifty.scalp.config.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { notifyNiftyEvent } from './nifty.scalp.notify.helper';
import {
    buyNiftyPlanBScalp,
    closeNiftyScalpTrade,
    sellNiftyPlanBBounce,
    sellPartialNiftyLots,
} from './nifty.scalp.trade.helper';

const REBUY_DROP_POINTS = 5;
const BOUNCE_SELL_POINTS = 3;
const MAX_LOSS_RS = 8000;

const chargesCoverConfig = (config: NiftyScalpConfig): NiftyScalpConfig => ({
    ...config,
    target_profit_rs: 0,
});

type TickPoint = { ltp: number; at: number };

const recentTicks = new Map<string, TickPoint[]>();
const MAX_TICKS = 30;

export const recordNiftyPriceTick = (tradeId: string, ltp: number) => {
    const list = recentTicks.get(tradeId) || [];
    list.push({ ltp, at: Date.now() });
    while (list.length > MAX_TICKS) list.shift();
    recentTicks.set(tradeId, list);
};

/** Open net of the kept lot plus any scalp lots, after charges. */
export const planBOpenNet = (trade: any, config: NiftyScalpConfig): number => {
    const ltp = Number(trade.ltp);
    const lotSize = Number(trade.lot_size);
    const qty = Number(trade.qty);
    const scalpOpen = Number(trade.plan_b_scalp_open || 0);
    const coreQty = Math.max(0, qty - scalpOpen);
    const coreAvg = Number(trade.buy_price);
    const scalpBuy = Number(trade.plan_b_scalp_buy_price || 0);
    const coreGross = (ltp - coreAvg) * lotSize * coreQty;
    const scalpGross =
        scalpOpen > 0 && scalpBuy > 0
            ? (ltp - scalpBuy) * lotSize * scalpOpen
            : 0;
    const coreCharges =
        coreQty > 0
            ? calculateRoundTripCharges(coreQty, lotSize, coreAvg, config)
            : 0;
    const scalpCharges =
        scalpOpen > 0 && scalpBuy > 0
            ? calculateRoundTripCharges(scalpOpen, lotSize, scalpBuy, config)
            : 0;
    return coreGross + scalpGross - coreCharges - scalpCharges;
};

const planBTotal = (trade: any, config: NiftyScalpConfig) =>
    Number(trade.pl || 0) + planBOpenNet(trade, config);

const applyChargesCoverTarget = async (trade: any, config: NiftyScalpConfig) => {
    const avg = Number(trade.buy_price);
    const qty = Number(trade.qty);
    const lotSize = Number(trade.lot_size);
    const target = calculateTargetLtp(
        avg,
        Math.max(qty, 1),
        lotSize,
        chargesCoverConfig(config),
    );
    await trade.update({ target_price: target });
};

/**
 * First start only. Caller already knows price is 10 points under the average
 * and the balance cannot pay for another lot.
 * Sells every lot except 1 immediately. The kept lot's average stays unchanged.
 */
export const startNiftyPlanB = async ({
    trade,
    position,
    config,
    balance,
    ltp,
    avgBuy,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
    balance: number;
    ltp: number;
    avgBuy: number;
}) => {
    if (trade.plan_b_started) return false;
    if (!config.enable_plan_b) return false;

    const qty = Number(trade.qty);
    const lotSize = Number(trade.lot_size);

    await trade.update({ plan_b_started: true });
    trade.plan_b_started = true;

    await logNiftyAudit({
        action: 'CANNOT_ADD_LOT',
        reason: 'INSUFFICIENT_BALANCE_ADD_LOT',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'RECOVERY',
        config,
        metadata: {
            ltp,
            avgBuy,
            balance,
            required: ltp * lotSize,
            qty,
            thinking:
                'Price is 10 points under the average and the balance cannot pay for another lot. Plan B starts now.',
        },
        skipThrottle: true,
    });

    await logNiftyAudit({
        action: 'PLAN_B_START',
        reason: 'INSUFFICIENT_BALANCE_ADD_LOT',
        instrumentKey: trade.instrument_key,
        tradeId: trade.id,
        engineState: 'RECOVERY',
        config,
        metadata: {
            ltp,
            avgBuy,
            qty,
            balance,
            thinking:
                'Plan B started. It stays on for this trade. First sell keeps 1 lot. Later cycles buy a 5-point drop and sell a 3-point bounce.',
        },
        skipThrottle: true,
    });

    notifyNiftyEvent(
        'PLAN_B_START',
        `Plan B started. ${qty} lot(s) open, price ${ltp}, average ${avgBuy}.`,
        { tradeId: trade.id, ltp, avgBuy, qty },
    );

    if (qty >= 2) {
        const lotsToSell = qty - 1;
        const sold = await sellPartialNiftyLots({
            trade,
            position,
            config,
            lotsToSell,
            reason: 'PLAN_B_START_SCALE_OUT',
        });
        if (sold) {
            const sellPrice = Number(trade.ltp);
            const remaining = Number(trade.qty);
            await trade.update({
                plan_b_scalp_lots: lotsToSell,
                plan_b_last_sell_price: sellPrice,
                plan_b_scalp_open: 0,
                plan_b_scalp_buy_price: null,
            });
            await applyChargesCoverTarget(trade, config);
            await logNiftyAudit({
                action: 'PLAN_B_START',
                reason: 'PLAN_B_START_SCALE_OUT',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                engineState: 'RECOVERY',
                config,
                metadata: {
                    lotsSold: lotsToSell,
                    remaining,
                    sellPrice,
                    avgBuy: Number(trade.buy_price),
                    thinking:
                        'Sold down to 1 lot. That lot keeps its average. Booked loss stays booked.',
                },
                skipThrottle: true,
            });
        }
        return true;
    }

    await trade.update({
        plan_b_scalp_lots: 0,
        plan_b_scalp_open: 0,
        plan_b_scalp_buy_price: null,
    });
    await applyChargesCoverTarget(trade, config);
    return true;
};

export type PlanBCycleResult = 'CLOSED' | 'ACTED' | 'HOLD';

/** Runs only after Plan B has started. Does not turn Plan B off. */
export const manageNiftyPlanB = async ({
    trade,
    position,
    config,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
}): Promise<PlanBCycleResult> => {
    const ltp = Number(trade.ltp);
    const qty = Number(trade.qty);
    const total = planBTotal(trade, config);

    if (total <= -MAX_LOSS_RS) {
        await logNiftyAudit({
            action: 'PLAN_B_MAX_LOSS',
            reason: 'PLAN_B_MAX_LOSS_8000',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            engineState: 'RECOVERY',
            config,
            metadata: {
                total,
                booked: Number(trade.pl || 0),
                openNet: planBOpenNet(trade, config),
                thinking:
                    'Booked Plan B loss plus the open loss reached ₹8,000. Selling every lot.',
            },
            skipThrottle: true,
        });
        const closed = await closeNiftyScalpTrade({
            trade,
            position,
            config,
            exitReason: 'PLAN_B_MAX_LOSS_8000',
        });
        return closed ? 'CLOSED' : 'HOLD';
    }

    const scalpLots = Number(trade.plan_b_scalp_lots || 0);
    const lastSell = Number(trade.plan_b_last_sell_price || 0);
    const scalpOpen = Number(trade.plan_b_scalp_open || 0);

    // First sell did not confirm yet. Retry until 1 lot remains.
    if (scalpLots <= 0 && lastSell <= 0 && scalpOpen <= 0 && qty >= 2) {
        const lotsToSell = qty - 1;
        const sold = await sellPartialNiftyLots({
            trade,
            position,
            config,
            lotsToSell,
            reason: 'PLAN_B_START_SCALE_OUT',
        });
        if (!sold) return 'HOLD';
        await trade.update({
            plan_b_scalp_lots: lotsToSell,
            plan_b_last_sell_price: Number(trade.ltp),
            plan_b_scalp_open: 0,
            plan_b_scalp_buy_price: null,
        });
        await applyChargesCoverTarget(trade, config);
        return 'ACTED';
    }

    if (scalpOpen > 0 && ltp >= Number(trade.plan_b_scalp_buy_price) + BOUNCE_SELL_POINTS) {
        const sold = await sellNiftyPlanBBounce({ trade, position, config });
        if (!sold) return 'HOLD';
        const openNet = planBOpenNet(trade, config);
        if (Number(trade.plan_b_scalp_open || 0) <= 0 && openNet >= 0) {
            const closed = await closeNiftyScalpTrade({
                trade,
                position,
                config,
                exitReason: 'PLAN_B_CHARGES_COVER',
            });
            return closed ? 'CLOSED' : 'ACTED';
        }
        return 'ACTED';
    }

    if (scalpOpen <= 0 && planBOpenNet(trade, config) >= 0) {
        const closed = await closeNiftyScalpTrade({
            trade,
            position,
            config,
            exitReason: 'PLAN_B_CHARGES_COVER',
        });
        return closed ? 'CLOSED' : 'HOLD';
    }

    if (
        scalpOpen <= 0 &&
        scalpLots > 0 &&
        lastSell > 0 &&
        ltp <= lastSell - REBUY_DROP_POINTS
    ) {
        const bought = await buyNiftyPlanBScalp({ trade, position, config });
        return bought ? 'ACTED' : 'HOLD';
    }

    return 'HOLD';
};
