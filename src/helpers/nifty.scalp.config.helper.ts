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

export const canAffordLot = (
    balance: number,
    ltp: number,
    lotSize: number,
): boolean => {
    const required = ltp * lotSize;
    return balance >= required && required > 0;
};

export const getNiftyStrategyBalance = async (
    config: NiftyScalpConfig,
): Promise<number> => {
    const strategy = await db[MODEL.STRATEGY].findOne({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
    });
    if (strategy?.strategy_balance && strategy.strategy_balance > 0) {
        return Number(strategy.strategy_balance);
    }
    return Number(config.paper_balance);
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
