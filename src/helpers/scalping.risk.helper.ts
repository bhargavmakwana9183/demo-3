import moment from 'moment';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { getCurrentISTDate } from './stock.helper';

const { ATR } = require('technicalindicators');

export interface ScalpingConfig {
    strategy_name: string;
    market_start_time: string;
    entry_start_time: string;
    entry_cutoff_time: string;
    force_exit_time: string;
    market_end_time: string;
    risk_per_trade_pct: number;
    max_lots_per_trade: number;
    max_trades_per_day: number;
    max_daily_loss: number;
    max_loss_per_trade: number;
    max_consecutive_losses: number;
    cooldown_minutes: number;
    trailing_breakeven_at: number;
    trailing_atr_multiplier: number;
    brokerage_per_lot: number;
    slippage_pct: number;
    paper_balance: number;
    mode: string;
    is_active: boolean;
    ema_fast: number;
    ema_slow: number;
    rsi_period: number;
    rsi_ce_max: number;
    rsi_pe_min: number;
    atr_stop_multiplier: number;
    atr_target_multiplier: number;
    min_rr_ratio: number;
    volume_lookback: number;
    trend_ema_period: number;
    min_candles_1m: number;
    partial_target_pct: number;
    partial_target_extension: number;
    time_exit_minutes: number;
    time_exit_min_pl: number;
    time_exit_max_pl: number;
    enable_partial_exit: boolean;
    enable_ema_reversal_exit: boolean;
    enable_time_exit: boolean;
    underlying_name: string;
    underlying_instrument_key: string;
    strike_step: number;
    atm_itm_steps: number;
    max_spread_pct: number;
    min_open_interest: number;
    expiry_day_cutoff_time: string;
    enable_dynamic_atm: boolean;
    enable_liquidity_check: boolean;
    enable_expiry_rules: boolean;
    target_profit_rs?: number;
    add_lot_points?: number;
    enable_plan_b?: boolean;
    enable_overnight_carry?: boolean;
    plan_b_min_lots?: number;
    plan_b_bounce_points?: number;
}

const DEFAULT_SCALPING_CONFIG = {
    strategy_name: STRATEGY.SCALLPING,
    market_start_time: '09:15',
    entry_start_time: '09:45',
    entry_cutoff_time: '15:00',
    force_exit_time: '15:15',
    market_end_time: '15:19',
    risk_per_trade_pct: 0.01,
    max_lots_per_trade: 2,
    max_trades_per_day: 3,
    max_daily_loss: 5000,
    max_loss_per_trade: 3000,
    max_consecutive_losses: 2,
    cooldown_minutes: 30,
    trailing_breakeven_at: 2,
    trailing_atr_multiplier: 1.5,
    brokerage_per_lot: 40,
    slippage_pct: 0.002,
    paper_balance: 100000,
    mode: 'paper',
    is_active: true,
    ema_fast: 9,
    ema_slow: 21,
    rsi_period: 14,
    rsi_ce_max: 70,
    rsi_pe_min: 30,
    atr_stop_multiplier: 1.5,
    atr_target_multiplier: 2.5,
    min_rr_ratio: 1.5,
    volume_lookback: 10,
    trend_ema_period: 21,
    min_candles_1m: 22,
    partial_target_pct: 0.5,
    partial_target_extension: 1.2,
    time_exit_minutes: 30,
    time_exit_min_pl: -500,
    time_exit_max_pl: 500,
    enable_partial_exit: true,
    enable_ema_reversal_exit: true,
    enable_time_exit: true,
    underlying_name: 'STATE BANK OF INDIA',
    underlying_instrument_key: 'NSE_EQ|INE062A01020',
    strike_step: 10,
    atm_itm_steps: 0,
    max_spread_pct: 0.02,
    min_open_interest: 10000,
    expiry_day_cutoff_time: '14:00',
    enable_dynamic_atm: true,
    enable_liquidity_check: true,
    enable_expiry_rules: true,
};

export const buildMarketTime = (
    formattedDate: string,
    time: string,
): Date => {
    return new Date(`${formattedDate}T${time}:00+05:30`);
};

export const getStrategyConfig = async (
    strategyName: string = STRATEGY.SCALLPING,
): Promise<ScalpingConfig> => {
    const [config] = await db[MODEL.STRATEGY_CONFIG].findOrCreate({
        where: { strategy_name: strategyName },
        defaults: { ...DEFAULT_SCALPING_CONFIG, strategy_name: strategyName },
    });
    return {
        ...DEFAULT_SCALPING_CONFIG,
        ...config.get({ plain: true }),
        strategy_name: strategyName,
    } as ScalpingConfig;
};

export const getTodayDate = (): string => {
    return moment(getCurrentISTDate()).format('YYYY-MM-DD');
};

export const getOrCreateDailyStats = async (strategyName: string) => {
    const tradeDate = getTodayDate();
    const [stats] = await db[MODEL.STRATEGY_DAILY_STATS].findOrCreate({
        where: { strategy_name: strategyName, trade_date: tradeDate },
        defaults: {
            strategy_name: strategyName,
            trade_date: tradeDate,
        },
    });
    return stats;
};

export const canOpenNewTrade = async (
    strategyName: string,
    config: ScalpingConfig,
    currentISTDate: Date,
): Promise<{ ok: boolean; reason?: string }> => {
    const stats = await getOrCreateDailyStats(strategyName);

    if (stats.is_trading_halted) {
        return { ok: false, reason: 'DAILY_LOSS_LIMIT' };
    }

    if (stats.trades_count >= config.max_trades_per_day) {
        return { ok: false, reason: 'MAX_TRADES_PER_DAY' };
    }

    if (stats.cooldown_until && currentISTDate < new Date(stats.cooldown_until)) {
        return { ok: false, reason: 'COOLDOWN_ACTIVE' };
    }

    const entryCutoff = buildMarketTime(
        moment(currentISTDate).format('YYYY-MM-DD'),
        config.entry_cutoff_time,
    );
    if (currentISTDate >= entryCutoff) {
        return { ok: false, reason: 'ENTRY_CUTOFF' };
    }

    return { ok: true };
};

export const calculatePositionSize = ({
    accountBalance,
    buyPrice,
    stopLoss,
    lotSize,
    config,
}: {
    accountBalance: number;
    buyPrice: number;
    stopLoss: number;
    lotSize: number;
    config: ScalpingConfig;
}): number => {
    const riskAmount = accountBalance * config.risk_per_trade_pct;
    const riskPerUnit = buyPrice - stopLoss;

    if (riskPerUnit <= 0 || lotSize <= 0) {
        return 1;
    }

    let lots = Math.floor(riskAmount / (riskPerUnit * lotSize));
    lots = Math.max(1, lots);
    lots = Math.min(lots, config.max_lots_per_trade);
    return lots;
};

export const calculateTradeCharges = (
    trade: { buy_price: number; lot_size: number; qty: number },
    config: ScalpingConfig,
): number => {
    const qty = Number(trade.qty) || 1;
    const lotSize = Number(trade.lot_size) || 1;
    const buyPrice = Number(trade.buy_price) || 0;
    const brokerage = config.brokerage_per_lot * qty;
    const slippage = buyPrice * lotSize * qty * config.slippage_pct;
    return brokerage + slippage;
};

export const calculateNetPl = (
    grossPl: number,
    trade: { buy_price: number; lot_size: number; qty: number },
    config: ScalpingConfig,
): number => {
    return grossPl - calculateTradeCharges(trade, config);
};

export const updateTrailingStop = async (
    trade: any,
    config: ScalpingConfig,
): Promise<any> => {
    const ltp = Number(trade.ltp);
    const buyPrice = Number(trade.buy_price);
    const highestLtp = Math.max(Number(trade.highest_ltp || buyPrice), ltp);
    let newStop = Number(trade.stop_loss);

    if (ltp >= buyPrice + config.trailing_breakeven_at) {
        newStop = Math.max(newStop, buyPrice);
    }

    const candles = await db[MODEL.CANDELS].findAll({
        where: { instrument_key: trade.instrument_key },
        order: [['ts', 'DESC']],
        limit: 30,
    });

    if (candles.length >= 15) {
        const reversed = [...candles].reverse();
        const atrValues = ATR.calculate({
            period: 14,
            high: reversed.map((c) => Number(c.high)),
            low: reversed.map((c) => Number(c.low)),
            close: reversed.map((c) => Number(c.close)),
        });
        const atr = atrValues[atrValues.length - 1];
        if (atr) {
            const trailStop = highestLtp - atr * config.trailing_atr_multiplier;
            newStop = Math.max(newStop, trailStop);
        }
    }

    await db[MODEL.TRADE].update(
        {
            highest_ltp: highestLtp,
            stop_loss: newStop,
        },
        { where: { id: trade.id } },
    );

    return {
        ...trade.get?.({ plain: true }) ?? trade,
        highest_ltp: highestLtp,
        stop_loss: newStop,
        ltp,
    };
};

export const updateDailyStatsOnClose = async (
    strategyName: string,
    netPl: number,
    config: ScalpingConfig,
    isLoss: boolean,
) => {
    const stats = await getOrCreateDailyStats(strategyName);
    const now = getCurrentISTDate();

    let consecutiveLosses = stats.consecutive_losses || 0;
    let winsCount = stats.wins_count || 0;
    let lossesCount = stats.losses_count || 0;

    if (isLoss) {
        consecutiveLosses += 1;
        lossesCount += 1;
    } else {
        consecutiveLosses = 0;
        winsCount += 1;
    }

    const dailyPl = (stats.daily_pl || 0) + netPl;
    const dailyPlAfterCharges = (stats.daily_pl_after_charges || 0) + netPl;

    let cooldownUntil = stats.cooldown_until;
    if (consecutiveLosses >= config.max_consecutive_losses) {
        cooldownUntil = moment(now)
            .add(config.cooldown_minutes, 'minutes')
            .toDate();
        logger.info(
            `Cooldown activated for ${config.cooldown_minutes} minutes after ${consecutiveLosses} consecutive losses`,
        );
    }

    const isTradingHalted = dailyPlAfterCharges <= -config.max_daily_loss;

    await stats.update({
        trades_count: (stats.trades_count || 0) + 1,
        wins_count: winsCount,
        losses_count: lossesCount,
        consecutive_losses: consecutiveLosses,
        daily_pl: dailyPl,
        daily_pl_after_charges: dailyPlAfterCharges,
        cooldown_until: cooldownUntil,
        is_trading_halted: isTradingHalted,
        last_trade_at: now,
    });

    if (isTradingHalted) {
        logger.warn(
            `Trading halted for ${strategyName}: daily loss limit reached (${dailyPlAfterCharges})`,
        );
    }
};

export const resolveAccountBalance = (
    user: { balance?: number } | null,
    config: ScalpingConfig,
): number => {
    if (user?.balance && user.balance > 0) {
        return user.balance;
    }
    return config.paper_balance;
};
