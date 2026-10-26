import { INDEXES, INDEXES_NAMES, MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import {
    ScalpingConfig,
    getStrategyConfig,
} from './scalping.risk.helper';

export interface NiftyScalpConfig extends ScalpingConfig {
    target_profit_rs: number;
    add_lot_points: number;
    enable_plan_b: boolean;
    enable_overnight_carry: boolean;
    plan_b_min_lots: number;
    plan_b_bounce_points: number;
}

const DEFAULT_NIFTY_SCALP: Partial<NiftyScalpConfig> = {
    strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
    market_start_time: '09:15',
    entry_start_time: '09:20',
    entry_cutoff_time: '15:20',
    force_exit_time: '15:25',
    market_end_time: '15:30',
    max_lots_per_trade: 100,
    max_trades_per_day: 100,
    max_daily_loss: 20000,
    max_loss_per_trade: 15000,
    max_consecutive_losses: 5,
    cooldown_minutes: 10,
    brokerage_per_lot: 40,
    slippage_pct: 0.002,
    paper_balance: 100000,
    mode: 'paper',
    is_active: true,
    ema_fast: 9,
    ema_slow: 21,
    rsi_period: 14,
    rsi_ce_max: 75,
    rsi_pe_min: 25,
    min_candles_1m: 22,
    underlying_name: INDEXES_NAMES.NIFTY_50,
    underlying_instrument_key: INDEXES.NIFTY_50,
    strike_step: 50,
    atm_itm_steps: 0,
    enable_dynamic_atm: true,
    enable_liquidity_check: false,
    enable_expiry_rules: false,
    enable_partial_exit: false,
    enable_ema_reversal_exit: false,
    enable_time_exit: false,
    target_profit_rs: 200,
    add_lot_points: 10,
    enable_plan_b: true,
    enable_overnight_carry: true,
    plan_b_min_lots: 2,
    plan_b_bounce_points: 3,
};

export const getNiftyScalpConfig = async (): Promise<NiftyScalpConfig> => {
    const [row] = await db[MODEL.STRATEGY_CONFIG].findOrCreate({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
        defaults: DEFAULT_NIFTY_SCALP,
    });

    const base = await getStrategyConfig(STRATEGY.NIFTY_OPTIONS_SCALP);
    const plain = row.get({ plain: true });

    return {
        ...base,
        ...DEFAULT_NIFTY_SCALP,
        ...plain,
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        target_profit_rs: Number(plain.target_profit_rs ?? 200),
        add_lot_points: Number(plain.add_lot_points ?? 10),
        enable_plan_b: plain.enable_plan_b !== false,
        enable_overnight_carry: plain.enable_overnight_carry !== false,
        plan_b_min_lots: Number(plain.plan_b_min_lots ?? 2),
        plan_b_bounce_points: Number(plain.plan_b_bounce_points ?? 3),
    };
};

export const calculateRoundTripCharges = (
    qty: number,
    lotSize: number,
    avgBuy: number,
    config: NiftyScalpConfig,
): number => {
    const lots = Number(qty) || 1;
    const brokerage = config.brokerage_per_lot * lots * 2;
    const notional = avgBuy * lotSize * lots;
    const slippage = notional * config.slippage_pct * 2;
    return brokerage + slippage;
};

export const calculateTargetLtp = (
    avgBuy: number,
    qty: number,
    lotSize: number,
    config: NiftyScalpConfig,
): number => {
    const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
    const needGross = config.target_profit_rs + charges;
    const points = needGross / (lotSize * qty);
    return avgBuy + points;
};

export const calculateGrossPl = (
    ltp: number,
    avgBuy: number,
    qty: number,
    lotSize: number,
): number => {
    return (ltp - avgBuy) * lotSize * qty;
};

/** One lot per trade. No averaging down. */
export const NIFTY_MAX_LOTS = 1;

/** Hard stop: exit when price is this many points below entry. */
export const NIFTY_STOP_POINTS = 12;
/** Backstop on net loss (covers a gap through the point stop and legacy hedged trades). */
export const NIFTY_SOFT_LOSS_RS = 1200;

/** No follow-through: minutes to wait and the minimum points the price must reach. */
export const NIFTY_NO_FOLLOW_MINUTES = 4;
export const NIFTY_NO_FOLLOW_POINTS = 2;

/**
 * Profit protection, two steps:
 *  1. Peak net ≥ NIFTY_BREAKEVEN_ARM_RS → a winner may not turn into a loss
 *     (exit if net falls back to NIFTY_BREAKEVEN_FLOOR_RS).
 *  2. Peak net ≥ NIFTY_TRAIL_ARM_RS → trailing stop: the higher of
 *     peak − NIFTY_TRAIL_POINTS and the price that keeps NIFTY_TRAIL_FLOOR_RS.
 * The gap between arm and floor is the room a winner gets before the stop bites.
 */
export const NIFTY_BREAKEVEN_ARM_RS = 200;
export const NIFTY_BREAKEVEN_FLOOR_RS = 0;
export const NIFTY_TRAIL_ARM_RS = 300;
export const NIFTY_TRAIL_POINTS = 6;
/** Once the trail is armed, never give back below this net profit (₹). */
export const NIFTY_TRAIL_FLOOR_RS = 150;
/** Close at this net profit (₹) even if still rising. */
export const NIFTY_PROFIT_CAP_RS = 800;
/** Close an armed trade after this many minutes in the trade. */
export const NIFTY_TRAIL_MAX_MINUTES = 20;

/** Exit early if the Nifty trend flips against the side while the trade is under water. */
export const NIFTY_SPOT_FLIP_MIN_MINUTES = 2;

/** Entry quality filters. */
export const NIFTY_ENTRY_QUIET_UNTIL = '09:45';
export const NIFTY_SPOT_5M_FAST = 5;
export const NIFTY_SPOT_5M_SLOW = 13;
/** Skip entries when the option is already stretched this far above/below its 9 EMA. */
export const NIFTY_MAX_EXTENSION_PCT = 0.03;
/** Skip when summed volume of the last 5 one-minute candles is below this. */
export const NIFTY_MIN_VOLUME_5M = 500000;

/** Day-level protection. */
export const NIFTY_DAILY_MAX_CONSECUTIVE_LOSSES = 2;
export const NIFTY_DAILY_MAX_LOSS_RS = 1500;
export const NIFTY_DAILY_PROFIT_LOCK_RS = 800;
export const NIFTY_DAILY_MAX_TRADES = 8;
export const NIFTY_COOLDOWN_AFTER_LOSS_MIN = 15;

/** Paper fills cross the spread: buy at ltp + this, sell at ltp − this (points). */
export const NIFTY_PAPER_SPREAD_POINTS = 0.5;

/** Price at which combined net equals `netRs` for a one-lot-style position. */
export const priceForNet = (
    avgBuy: number,
    qty: number,
    lotSize: number,
    config: NiftyScalpConfig,
    netRs: number,
    hedgeNet = 0,
): number => {
    const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
    return avgBuy + (netRs + charges - hedgeNet) / (lotSize * qty);
};
/** Opposite-side hedge buying is off. Legacy trades that already hold a hedge still close it. */
export const NIFTY_HEDGE_ENABLED = false;
export const NIFTY_HEDGE_PREMIUM_MIN = 5;
export const NIFTY_HEDGE_PREMIUM_MAX = 15;

export const canAffordLot = (
    balance: number,
    ltp: number,
    lotSize: number,
): boolean => {
    const required = ltp * lotSize;
    return balance >= required && required > 0;
};

/**
 * Reserve for entry: main lot + one add at main−10, plus the hedge lot only when a hedge is used.
 * Same check for paper and production (uses strategy_balance).
 */
export const twoLotWithHedgeCost = (
    mainLtp: number,
    hedgeLtp: number,
    lotSize: number,
    addPoints: number,
): number | null => {
    if (!(mainLtp > 0) || !(lotSize > 0)) return null;
    const hedge = Number(hedgeLtp) > 0 ? Number(hedgeLtp) : 0;
    if (NIFTY_HEDGE_ENABLED && !(hedge > 0)) return null;
    // Only reserve a second lot when more than one lot is allowed.
    const second =
        NIFTY_MAX_LOTS > 1 ? Math.max(mainLtp - addPoints, 0.05) : 0;
    return (mainLtp + (NIFTY_HEDGE_ENABLED ? hedge : 0) + second) * lotSize;
};

export const getNiftyStrategyBalance = async (
    config: NiftyScalpConfig,
): Promise<number> => {
    const strategy = await db[MODEL.STRATEGY].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    if (strategy?.strategy_balance != null && strategy.strategy_balance > 0) {
        return Number(strategy.strategy_balance);
    }
    return Number(config.paper_balance);
};

export const setNiftyStrategyBalance = async (amount: number) => {
    if (!Number.isFinite(amount)) return;
    const strategy = await db[MODEL.STRATEGY].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    if (!strategy) return;
    await strategy.update({ strategy_balance: amount });
};

export const updateNiftyStrategyBalance = async (delta: number) => {
    const strategy = await db[MODEL.STRATEGY].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    if (!strategy) return;
    await strategy.update({
        strategy_balance: Number(strategy.strategy_balance || 0) + delta,
    });
};
