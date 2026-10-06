import { randomUUID } from 'crypto';
import { Op } from 'sequelize';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import {
    ScalpingConfig,
    buildMarketTime,
    calculateNetPl,
    calculateTradeCharges,
    getStrategyConfig,
} from './scalping.risk.helper';
import {
    SignalType,
    validateEntrySignal,
} from './scalping.entry.filters';
import {
    getExitDecision,
    ExitReason,
} from './scalping.exit.helper';
import { calculateTradePl } from './scalping.trade.helper';
import { logScalpingDecision } from './scalping.audit.helper';

export interface BacktestTrade {
    id: string;
    signalType: SignalType;
    instrumentKey: string;
    entryTime: Date;
    exitTime: Date;
    buyPrice: number;
    sellPrice: number;
    qty: number;
    lotSize: number;
    grossPl: number;
    netPl: number;
    exitReason: ExitReason;
}

export interface BacktestResult {
    runId: string;
    startDate: string;
    endDate: string;
    instrumentKey: string;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number | null;
    totalGrossPl: number;
    totalNetPl: number;
    maxDrawdown: number;
    trades: BacktestTrade[];
}

interface VirtualPosition {
    signalType: SignalType;
    instrumentKey: string;
    buyPrice: number;
    stopLoss: number;
    targetPrice: number;
    qty: number;
    lotSize: number;
    highestLtp: number;
    partialExitDone: boolean;
    entryTime: Date;
    entryTs: string;
}

const tsToDate = (ts: string | number): Date => new Date(Number(ts));

const isWeekday = (date: Date): boolean => {
    const day = date.getUTCDay();
    return day !== 0 && day !== 6;
};

const isWithinEntryWindow = (
    date: Date,
    config: ScalpingConfig,
    formattedDate: string,
): boolean => {
    const start = buildMarketTime(formattedDate, config.entry_start_time);
    const cutoff = buildMarketTime(formattedDate, config.entry_cutoff_time);
    return date >= start && date <= cutoff;
};

const isForceExit = (
    date: Date,
    config: ScalpingConfig,
    formattedDate: string,
): boolean => {
    const forceExit = buildMarketTime(formattedDate, config.force_exit_time);
    return date >= forceExit;
};

const simulateTrailingStop = (
    position: VirtualPosition,
    ltp: number,
    atr: number,
    config: ScalpingConfig,
): number => {
    let stop = position.stopLoss;
    if (ltp > position.highestLtp) {
        position.highestLtp = ltp;
    }
    if (ltp >= position.buyPrice + (config.trailing_breakeven_at ?? 2)) {
        stop = Math.max(stop, position.buyPrice);
    }
    if (atr > 0) {
        const trail = position.highestLtp - atr * config.trailing_atr_multiplier;
        stop = Math.max(stop, trail);
    }
    position.stopLoss = stop;
    return stop;
};

const closeVirtualTrade = (
    position: VirtualPosition,
    sellPrice: number,
    exitTime: Date,
    exitReason: ExitReason,
    config: ScalpingConfig,
): BacktestTrade => {
    const grossPl =
        (sellPrice - position.buyPrice) *
        position.lotSize *
        position.qty;
    const tradeLike = {
        buy_price: position.buyPrice,
        lot_size: position.lotSize,
        qty: position.qty,
    };
    const charges = calculateTradeCharges(tradeLike, config);
    const netPl = calculateNetPl(grossPl, tradeLike, config);

    return {
        id: randomUUID(),
        signalType: position.signalType,
        instrumentKey: position.instrumentKey,
        entryTime: position.entryTime,
        exitTime,
        buyPrice: position.buyPrice,
        sellPrice,
        qty: position.qty,
        lotSize: position.lotSize,
        grossPl,
        netPl,
        exitReason,
    };
};

export const runScalpingBacktest = async ({
    startDate,
    endDate,
    signalType = 'CE',
    instrumentType = 'CE',
    configOverride,
    skipAuditLog = false,
}: {
    startDate: string;
    endDate: string;
    signalType?: SignalType;
    instrumentType?: 'CE' | 'PE';
    configOverride?: Partial<ScalpingConfig>;
    skipAuditLog?: boolean;
}): Promise<BacktestResult> => {
    const baseConfig = await getStrategyConfig(STRATEGY.SCALLPING);
    const config = { ...baseConfig, ...configOverride } as ScalpingConfig;
    const runId = randomUUID();

    const logDecision = (input: Parameters<typeof logScalpingDecision>[0]) => {
        if (!skipAuditLog) return logScalpingDecision(input);
    };

    const strike = await db[MODEL.STRIKE_MODEL].findOne({
        where: { instrument_type: instrumentType, is_active: true },
    });
    if (!strike?.instrument_key) {
        throw new Error(`No active ${instrumentType} strike found`);
    }

    const startTs = new Date(`${startDate}T00:00:00+05:30`).getTime();
    const endTs = new Date(`${endDate}T23:59:59+05:30`).getTime();

    const candles = await db[MODEL.CANDELS].findAll({
        where: {
            instrument_key: strike.instrument_key,
            ts: {
                [Op.between]: [String(startTs), String(endTs)],
            },
        },
        order: [['ts', 'ASC']],
    });

    if (candles.length < (config.min_candles_1m ?? 22)) {
        throw new Error('Insufficient candle data for backtest range');
    }

    const trades: BacktestTrade[] = [];
    let position: VirtualPosition | null = null;
    let equity = config.paper_balance ?? 100000;
    let peakEquity = equity;
    let maxDrawdown = 0;
    let tradesToday = 0;
    let lastTradeDate = '';

    const candleLimit = Math.max(120, (config.trend_ema_period ?? 21) * 5 + 22);

    for (let i = config.min_candles_1m ?? 22; i < candles.length; i++) {
        const candle = candles[i];
        const candleDate = tsToDate(candle.ts);
        const formattedDate = candleDate.toISOString().slice(0, 10);

        if (!isWeekday(candleDate)) continue;

        const history = candles.slice(Math.max(0, i - candleLimit + 1), i + 1);
        const ltp = Number(candle.close);

        if (position) {
            const validation = validateEntrySignal(
                position.signalType,
                history,
                config,
            );
            const atr = validation.indicators?.atr ?? 0;
            simulateTrailingStop(position, ltp, atr, config);

            const tradeLike = {
                buy_price: position.buyPrice,
                stop_loss: position.stopLoss,
                target_price: position.targetPrice,
                ltp,
                lot_size: position.lotSize,
                qty: position.qty,
                partial_exit_done: position.partialExitDone,
                instrument_type: instrumentType,
                instrument_key: position.instrumentKey,
                is_active: true,
                createdAt: position.entryTime,
            };

            const tradePl = calculateTradePl(tradeLike);
            const tradeEndTime = buildMarketTime(
                formattedDate,
                config.force_exit_time,
            );

            const decision = await getExitDecision({
                trade: tradeLike,
                tradePl,
                currentISTDate: candleDate,
                tradeEndTime,
                config,
            });

            if (decision.action === 'FULL_CLOSE' && decision.reason) {
                const closed = closeVirtualTrade(
                    position,
                    ltp,
                    candleDate,
                    decision.reason,
                    config,
                );
                trades.push(closed);
                equity += closed.netPl;
                peakEquity = Math.max(peakEquity, equity);
                maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
                position = null;

                await logDecision({
                    strategyName: STRATEGY.SCALLPING,
                    action: 'EXIT',
                    reason: decision.reason,
                    signal: signalType === 'CE' ? 'CE_BUY' : 'PE_BUY',
                    instrumentKey: strike.instrument_key,
                    engineState: 'IN_TRADE',
                    config,
                    mode: 'backtest',
                    backtestRunId: runId,
                    timestamp: candleDate,
                    metadata: { netPl: closed.netPl, ltp },
                });
            } else if (decision.action === 'PARTIAL_CLOSE') {
                const halfQty = Math.floor(position.qty / 2);
                if (halfQty >= 1) {
                    const partialPl =
                        (ltp - position.buyPrice) *
                        position.lotSize *
                        halfQty;
                    equity += partialPl;
                    position.qty -= halfQty;
                    position.partialExitDone = true;
                    position.stopLoss = position.buyPrice;
                    const targetDistance =
                        position.targetPrice - position.buyPrice;
                    position.targetPrice =
                        position.buyPrice +
                        targetDistance *
                            (config.partial_target_extension ?? 1.2);
                }
            }

            if (isForceExit(candleDate, config, formattedDate) && position) {
                const closed = closeVirtualTrade(
                    position,
                    ltp,
                    candleDate,
                    'EOD',
                    config,
                );
                trades.push(closed);
                equity += closed.netPl;
                position = null;
            }
            continue;
        }

        if (lastTradeDate !== formattedDate) {
            tradesToday = 0;
            lastTradeDate = formattedDate;
        }
        if (tradesToday >= config.max_trades_per_day) continue;
        if (!isWithinEntryWindow(candleDate, config, formattedDate)) continue;

        const validation = validateEntrySignal(signalType, history, config);
        if (!validation.ok) {
            if (
                validation.reason !== 'NO_CE_EMA_CROSS' &&
                validation.reason !== 'NO_PE_EMA_CROSS'
            ) {
                await logDecision({
                    strategyName: STRATEGY.SCALLPING,
                    action: 'SKIP',
                    reason: validation.reason,
                    signal: signalType === 'CE' ? 'CE_BUY' : 'PE_BUY',
                    instrumentKey: strike.instrument_key,
                    engineState: 'SCANNING',
                    config,
                    mode: 'backtest',
                    backtestRunId: runId,
                    timestamp: candleDate,
                    indicators: validation.indicators,
                });
            }
            continue;
        }

        position = {
            signalType,
            instrumentKey: strike.instrument_key,
            buyPrice: validation.buyPrice!,
            stopLoss: validation.stopLoss!,
            targetPrice: validation.targetPrice!,
            qty: 1,
            lotSize: Number(strike.lot_size),
            highestLtp: ltp,
            partialExitDone: false,
            entryTime: candleDate,
            entryTs: candle.ts,
        };
        tradesToday += 1;

        await logDecision({
            strategyName: STRATEGY.SCALLPING,
            action: 'ENTER',
            reason: 'SIGNAL_PASSED',
            signal: signalType === 'CE' ? 'CE_BUY' : 'PE_BUY',
            instrumentKey: strike.instrument_key,
            engineState: 'SCANNING',
            config,
            mode: 'backtest',
            backtestRunId: runId,
            timestamp: candleDate,
            indicators: validation.indicators,
        });
    }

    if (position) {
        const lastCandle = candles[candles.length - 1];
        const closed = closeVirtualTrade(
            position,
            Number(lastCandle.close),
            tsToDate(lastCandle.ts),
            'EOD',
            config,
        );
        trades.push(closed);
        equity += closed.netPl;
    }

    const wins = trades.filter((t) => t.netPl > 0).length;
    const losses = trades.filter((t) => t.netPl <= 0).length;
    const grossWins = trades
        .filter((t) => t.netPl > 0)
        .reduce((s, t) => s + t.netPl, 0);
    const grossLosses = Math.abs(
        trades.filter((t) => t.netPl < 0).reduce((s, t) => s + t.netPl, 0),
    );

    return {
        runId,
        startDate,
        endDate,
        instrumentKey: strike.instrument_key,
        totalTrades: trades.length,
        wins,
        losses,
        winRate: trades.length ? (wins / trades.length) * 100 : 0,
        profitFactor:
            grossLosses > 0
                ? grossWins / grossLosses
                : grossWins > 0
                  ? null
                  : 0,
        totalGrossPl: trades.reduce((s, t) => s + t.grossPl, 0),
        totalNetPl: trades.reduce((s, t) => s + t.netPl, 0),
        maxDrawdown,
        trades,
    };
};
