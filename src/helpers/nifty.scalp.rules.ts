/**
 * Pure trading rules for the Nifty options scalp: exit plan and day limits.
 * No DB or broker access, so the live engine and the replay tool run exactly
 * the same logic.
 */
import {
    NIFTY_BREAKEVEN_ARM_RS,
    NIFTY_BREAKEVEN_FLOOR_RS,
    NIFTY_BREAKEVEN_FAST_DROP_POINTS,
    NIFTY_COOLDOWN_AFTER_LOSS_MIN,
    NIFTY_DAILY_MAX_CONSECUTIVE_LOSSES,
    NIFTY_DAILY_MAX_LOSS_RS,
    NIFTY_DAILY_MAX_TRADES,
    NIFTY_DAILY_PROFIT_LOCK_RS,
    NIFTY_NO_FOLLOW_MINUTES,
    NIFTY_NO_FOLLOW_POINTS,
    NIFTY_PROFIT_CAP_RS,
    NIFTY_SCRATCH_RS,
    NIFTY_SOFT_LOSS_RS,
    NIFTY_SPOT_FLIP_MIN_MINUTES,
    NIFTY_STOP_POINTS,
    NIFTY_TRAIL_ARM_RS,
    NIFTY_TRAIL_FLOOR_RS,
    NIFTY_TRAIL_MAX_MINUTES,
    NIFTY_TRAIL_POINTS,
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
    priceForNet,
} from './nifty.scalp.config.helper';

export type NiftyExitParams = {
    stopPoints: number;
    softLossRs: number;
    profitCapRs: number;
    breakevenArmRs: number;
    breakevenFloorRs: number;
    breakevenFastDropPoints: number;
    trailArmRs: number;
    trailPoints: number;
    trailFloorRs: number;
    trailMaxMinutes: number;
    noFollowMinutes: number;
    noFollowPoints: number;
    spotFlipMinMinutes: number;
};

export const DEFAULT_NIFTY_EXIT_PARAMS: NiftyExitParams = {
    stopPoints: NIFTY_STOP_POINTS,
    softLossRs: NIFTY_SOFT_LOSS_RS,
    profitCapRs: NIFTY_PROFIT_CAP_RS,
    breakevenArmRs: NIFTY_BREAKEVEN_ARM_RS,
    breakevenFloorRs: NIFTY_BREAKEVEN_FLOOR_RS,
    breakevenFastDropPoints: NIFTY_BREAKEVEN_FAST_DROP_POINTS,
    trailArmRs: NIFTY_TRAIL_ARM_RS,
    trailPoints: NIFTY_TRAIL_POINTS,
    trailFloorRs: NIFTY_TRAIL_FLOOR_RS,
    trailMaxMinutes: NIFTY_TRAIL_MAX_MINUTES,
    noFollowMinutes: NIFTY_NO_FOLLOW_MINUTES,
    noFollowPoints: NIFTY_NO_FOLLOW_POINTS,
    spotFlipMinMinutes: NIFTY_SPOT_FLIP_MIN_MINUTES,
};

export type NiftyStage = 'INITIAL' | 'BREAKEVEN' | 'TRAILING';

export type NiftyExitPlan = {
    stage: NiftyStage;
    /** Stop level for this stage (shown in positions / STOP_UPDATED). */
    newStop: number;
    netPl: number;
    peakNet: number;
    hardStop: number;
    breakevenPrice: number;
    trailFloorPrice: number;
    trailStop: number;
    /** Plain-language description of the current protection stage. */
    protection: string;
    exit: { reason: string; why: string } | null;
    /** True when the caller should check whether the Nifty trend flipped against the trade. */
    checkSpotFlip: boolean;
};

export const planNiftyExit = (input: {
    ltp: number;
    avgBuy: number;
    highest: number;
    qty: number;
    lotSize: number;
    hedgeNet?: number;
    ageMin: number;
    config: NiftyScalpConfig;
    /** Close of the last fully finished minute while in the trade (null if none yet). */
    lastMinuteClose: number | null;
    params?: NiftyExitParams;
}): NiftyExitPlan => {
    const p = input.params ?? DEFAULT_NIFTY_EXIT_PARAMS;
    const { ltp, avgBuy, highest, qty, lotSize, ageMin, config } = input;
    const hedgeNet = input.hedgeNet ?? 0;
    const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
    const netAtPrice = (price: number) =>
        calculateGrossPl(price, avgBuy, qty, lotSize) - charges + hedgeNet;
    const netPl = netAtPrice(ltp);
    const peakNet = netAtPrice(highest);

    const trailArmed = peakNet >= p.trailArmRs;
    const breakevenArmed = !trailArmed && peakNet >= p.breakevenArmRs;
    const breakevenPrice = priceForNet(avgBuy, qty, lotSize, config, p.breakevenFloorRs, hedgeNet);
    const trailFloorPrice = priceForNet(avgBuy, qty, lotSize, config, p.trailFloorRs, hedgeNet);
    const trailStop = Math.max(highest - p.trailPoints, trailFloorPrice);
    const hardStop = avgBuy - p.stopPoints;
    const stage: NiftyStage = trailArmed ? 'TRAILING' : breakevenArmed ? 'BREAKEVEN' : 'INITIAL';
    const newStop = trailArmed ? trailStop : breakevenArmed ? breakevenPrice : hardStop;

    const protection = trailArmed
        ? `Stage 3 TRAILING (peak net ₹${peakNet.toFixed(0)} ≥ ₹${p.trailArmRs}): exit at ${trailStop.toFixed(2)} = max(peak ${highest} − ${p.trailPoints}, floor ${trailFloorPrice.toFixed(2)} for +₹${p.trailFloorRs})`
        : breakevenArmed
          ? `Stage 2 BREAKEVEN (peak net ₹${peakNet.toFixed(0)} ≥ ₹${p.breakevenArmRs}): exit if a 1-minute candle closes at or below ${breakevenPrice.toFixed(2)} (net ₹${p.breakevenFloorRs}), or at once if price drops to ${(breakevenPrice - p.breakevenFastDropPoints).toFixed(2)}; trailing starts at net ₹${p.trailArmRs}`
          : `Stage 1 INITIAL: hard stop ${hardStop.toFixed(2)} (−${p.stopPoints} pts); breakeven protection starts at net ₹${p.breakevenArmRs}, trailing at ₹${p.trailArmRs}`;

    const base = {
        stage,
        newStop,
        netPl,
        peakNet,
        hardStop,
        breakevenPrice,
        trailFloorPrice,
        trailStop,
        protection,
    };
    const exit = (reason: string, why: string): NiftyExitPlan => ({
        ...base,
        exit: { reason, why },
        checkSpotFlip: false,
    });

    // 1. Hard point stop: caps the loss on every trade.
    if (ltp <= hardStop) {
        return exit(
            `STOP_LOSS_${p.stopPoints}PT`,
            `price fell ${(avgBuy - ltp).toFixed(2)} pts below entry, at or past the ${p.stopPoints}-pt hard stop`,
        );
    }
    // 2. Net-loss backstop (gap through the stop, or a legacy hedged trade).
    if (netPl <= -p.softLossRs) {
        return exit(
            'SOFT_NET_LOSS',
            `open net loss ₹${netPl.toFixed(2)} reached the ₹${p.softLossRs} backstop`,
        );
    }
    // 3. Profit cap.
    if (netPl >= p.profitCapRs) {
        return exit(
            'TARGET_HIT',
            `open net profit ₹${netPl.toFixed(2)} reached the ₹${p.profitCapRs} profit cap`,
        );
    }
    // 4. Trailing.
    if (trailArmed) {
        if (ltp <= trailStop) {
            return exit(
                'TRAIL_PROFIT_EXIT',
                `trailing stop hit: price ${ltp} fell to the trail level ${trailStop.toFixed(2)} (the higher of peak ${highest} − ${p.trailPoints} pts and the +₹${p.trailFloorRs} floor ${trailFloorPrice.toFixed(2)}); peak net was ₹${peakNet.toFixed(0)}`,
            );
        }
        if (ageMin >= p.trailMaxMinutes) {
            return exit(
                'TARGET_TIME_CAP',
                `profit target was reached but the trade has run ${ageMin.toFixed(1)} min (limit ${p.trailMaxMinutes}), so I bank the profit`,
            );
        }
        return { ...base, exit: null, checkSpotFlip: false };
    }

    // 4b. Breakeven. One tick under the level is normal option noise, so it
    // needs a 1-minute close below it (and price still below now), unless the
    // price is falling fast.
    if (breakevenArmed) {
        if (ltp <= breakevenPrice - p.breakevenFastDropPoints) {
            return exit(
                'BREAKEVEN_EXIT',
                `the trade was up ₹${peakNet.toFixed(0)} at its peak (${highest}) and is now falling fast: price ${ltp} is ${p.breakevenFastDropPoints} pts under the breakeven level ${breakevenPrice.toFixed(2)}, so I exit now instead of waiting for the minute to close`,
            );
        }
        if (
            input.lastMinuteClose != null &&
            input.lastMinuteClose <= breakevenPrice &&
            ltp <= breakevenPrice
        ) {
            return exit(
                'BREAKEVEN_EXIT',
                `the trade was up ₹${peakNet.toFixed(0)} at its peak (${highest}) but the last 1-minute candle closed at ${input.lastMinuteClose}, at or below the breakeven level ${breakevenPrice.toFixed(2)}, and price ${ltp} is still below it. The move has failed, so I exit near flat`,
            );
        }
    }

    // 5. No follow-through: never reached +N points within M minutes.
    if (ageMin >= p.noFollowMinutes && highest < avgBuy + p.noFollowPoints) {
        return exit(
            'NO_FOLLOW_THROUGH',
            `after ${ageMin.toFixed(1)} min the price never got +${p.noFollowPoints} pts above entry (peak ${highest}), so the entry is not working`,
        );
    }

    // 6. Nifty trend flipped against the side while under water (caller checks).
    return {
        ...base,
        exit: null,
        checkSpotFlip: ageMin >= p.spotFlipMinMinutes && netPl < 0,
    };
};

export type NiftyDayLimitParams = {
    maxLossRs: number;
    profitLockRs: number;
    maxTrades: number;
    maxConsecutiveLosses: number;
    cooldownAfterLossMin: number;
    scratchRs: number;
};

export const DEFAULT_NIFTY_DAY_LIMIT_PARAMS: NiftyDayLimitParams = {
    maxLossRs: NIFTY_DAILY_MAX_LOSS_RS,
    profitLockRs: NIFTY_DAILY_PROFIT_LOCK_RS,
    maxTrades: NIFTY_DAILY_MAX_TRADES,
    maxConsecutiveLosses: NIFTY_DAILY_MAX_CONSECUTIVE_LOSSES,
    cooldownAfterLossMin: NIFTY_COOLDOWN_AFTER_LOSS_MIN,
    scratchRs: NIFTY_SCRATCH_RS,
};

export type NiftyDayStats = {
    tradeCount: number;
    dayNet: number;
    lossCount: number;
    scratchCount: number;
    consecutiveLosses: number;
    lastLossAt: Date | null;
};

/**
 * A "scratch" (net within ±scratchRs, e.g. a breakeven exit eaten by charges)
 * is neither a win nor a loss: it does not start the loss cooldown, does not
 * add to the losing streak and does not reset it. Its money still counts in dayNet.
 */
export const niftyDayStats = (
    closed: { net: number; closedAt: Date }[],
    params: NiftyDayLimitParams = DEFAULT_NIFTY_DAY_LIMIT_PARAMS,
): NiftyDayStats => {
    const ordered = [...closed].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
    const stats: NiftyDayStats = {
        tradeCount: ordered.length,
        dayNet: 0,
        lossCount: 0,
        scratchCount: 0,
        consecutiveLosses: 0,
        lastLossAt: null,
    };
    for (const t of ordered) {
        stats.dayNet += t.net;
        if (Math.abs(t.net) < params.scratchRs) {
            stats.scratchCount += 1;
        } else if (t.net < 0) {
            stats.lossCount += 1;
            stats.consecutiveLosses += 1;
            stats.lastLossAt = t.closedAt;
        } else {
            stats.consecutiveLosses = 0;
        }
    }
    return stats;
};

/** Day-level protection. Returns a skip reason, or null when a new entry is allowed. */
export const niftyDayLimitReason = (
    stats: NiftyDayStats,
    now: Date,
    params: NiftyDayLimitParams = DEFAULT_NIFTY_DAY_LIMIT_PARAMS,
): string | null => {
    if (stats.dayNet <= -params.maxLossRs) return 'DAILY_LOSS_LIMIT';
    if (stats.consecutiveLosses >= params.maxConsecutiveLosses) return 'CONSECUTIVE_LOSS_LIMIT';
    if (stats.dayNet >= params.profitLockRs) return 'DAILY_PROFIT_LOCK';
    if (stats.tradeCount >= params.maxTrades) return 'MAX_TRADES_PER_DAY';
    if (
        stats.lastLossAt &&
        now.getTime() - stats.lastLossAt.getTime() < params.cooldownAfterLossMin * 60000
    ) {
        return 'COOLDOWN_AFTER_LOSS';
    }
    return null;
};
