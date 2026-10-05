import {
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
} from './nifty.scalp.config.helper';
import { sellPartialNiftyLots } from './nifty.scalp.trade.helper';

type TickPoint = { ltp: number; at: number };

const recentTicks = new Map<string, TickPoint[]>();
const MAX_TICKS = 30;

export const recordNiftyPriceTick = (tradeId: string, ltp: number) => {
    const list = recentTicks.get(tradeId) || [];
    list.push({ ltp, at: Date.now() });
    while (list.length > MAX_TICKS) list.shift();
    recentTicks.set(tradeId, list);
};

export const tryNiftyPlanB = async ({
    trade,
    position,
    config,
}: {
    trade: any;
    position: any;
    config: NiftyScalpConfig;
}): Promise<boolean> => {
    if (!config.enable_plan_b) return false;

    const qty = Number(trade.qty);
    const ltp = Number(trade.ltp);
    const avgBuy = Number(trade.buy_price);
    const lotSize = Number(trade.lot_size);
    const drawdown = avgBuy - ltp;

    if (qty < config.plan_b_min_lots) return false;
    if (drawdown < config.add_lot_points) return false;

    recordNiftyPriceTick(String(trade.id), ltp);
    const ticks = recentTicks.get(String(trade.id)) || [];
    if (ticks.length < 5) return false;

    const lows = ticks.map((t) => t.ltp);
    const recentLow = Math.min(...lows);
    const bounce = ltp - recentLow;

    if (bounce < config.plan_b_bounce_points) return false;

    // Only scalp if that 1-lot bounce covers round-trip charges on 1 lot
    const oneLotGross = calculateGrossPl(ltp, recentLow, 1, lotSize);
    const oneLotCharges = calculateRoundTripCharges(1, lotSize, recentLow, config);
    if (oneLotGross < oneLotCharges) return false;

    const lotsToSell = Math.min(2, qty - 1);
    return sellPartialNiftyLots({
        trade,
        position,
        config,
        lotsToSell,
        reason: 'AUTO_RECOVERY_BOUNCE_SCALP',
    });
};
