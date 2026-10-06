import moment from 'moment';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import {
    ScalpingConfig,
    getStrategyConfig,
} from './scalping.risk.helper';
import { runScalpingBacktest, BacktestResult } from './scalping.backtest.helper';
import { SignalType } from './scalping.entry.filters';

export type TunableParam = keyof typeof TUNABLE_PARAM_GRID;

export const TUNABLE_PARAM_GRID = {
    min_rr_ratio: [1.2, 1.5, 1.8, 2.0],
    atr_stop_multiplier: [1.2, 1.5, 1.8, 2.0],
    atr_target_multiplier: [2.0, 2.5, 3.0],
    rsi_ce_max: [65, 70, 75],
    rsi_pe_min: [25, 30, 35],
    trailing_atr_multiplier: [1.2, 1.5, 2.0],
    max_trades_per_day: [2, 3, 4],
} as const;

export interface ParamOptimizationResult {
    param: TunableParam;
    currentValue: number;
    bestValue: number;
    baselineProfitFactor: number;
    bestProfitFactor: number;
    baselineWinRate: number;
    bestWinRate: number;
    improved: boolean;
    trials: Array<{
        value: number;
        profitFactor: number;
        winRate: number;
        totalNetPl: number;
        totalTrades: number;
    }>;
}

export interface OptimizationReport {
    startDate: string;
    endDate: string;
    signalType: SignalType;
    instrumentType: 'CE' | 'PE';
    baseline: BacktestResult;
    paramResults: ParamOptimizationResult[];
    suggestedOverrides: Partial<ScalpingConfig>;
    applied: boolean;
}

const pfScore = (value: number | null | undefined): number => {
    if (value == null) return Number.POSITIVE_INFINITY;
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

const summarizeBacktest = (result: BacktestResult) => ({
    profitFactor: result.profitFactor == null ? null : Number(result.profitFactor),
    winRate: result.winRate,
    totalNetPl: result.totalNetPl,
    totalTrades: result.totalTrades,
});

const runTrial = async (
    startDate: string,
    endDate: string,
    signalType: SignalType,
    instrumentType: 'CE' | 'PE',
    configOverride: Partial<ScalpingConfig>,
): Promise<BacktestResult> => {
    return runScalpingBacktest({
        startDate,
        endDate,
        signalType,
        instrumentType,
        configOverride,
        skipAuditLog: true,
    });
};

export const runScalpingOptimization = async ({
    days = 60,
    signalType = 'CE',
    instrumentType = 'CE',
    applyBest = false,
    params,
}: {
    days?: number;
    signalType?: SignalType;
    instrumentType?: 'CE' | 'PE';
    applyBest?: boolean;
    params?: TunableParam[];
}): Promise<OptimizationReport> => {
    const endDate = moment().format('YYYY-MM-DD');
    const startDate = moment().subtract(days, 'days').format('YYYY-MM-DD');
    const config = await getStrategyConfig(STRATEGY.SCALLPING);

    const baseline = await runTrial(
        startDate,
        endDate,
        signalType,
        instrumentType,
        {},
    );

    const paramsToTune =
        params ?? (Object.keys(TUNABLE_PARAM_GRID) as TunableParam[]);

    const paramResults: ParamOptimizationResult[] = [];
    const suggestedOverrides: Partial<ScalpingConfig> = {};

    for (const param of paramsToTune) {
        const candidates = TUNABLE_PARAM_GRID[param];
        if (!candidates) continue;

        const currentValue = Number(config[param]);
        const trials: ParamOptimizationResult['trials'] = [];
        let bestValue = currentValue;
        let bestProfitFactor = baseline.profitFactor;
        let bestWinRate = baseline.winRate;
        let bestTrialResult = summarizeBacktest(baseline);

        for (const value of candidates) {
            const result = await runTrial(
                startDate,
                endDate,
                signalType,
                instrumentType,
                { [param]: value },
            );
            const summary = summarizeBacktest(result);
            trials.push({
                value,
                profitFactor: pfScore(summary.profitFactor),
                winRate: summary.winRate,
                totalNetPl: summary.totalNetPl,
                totalTrades: summary.totalTrades,
            });

            if (
                pfScore(summary.profitFactor) > pfScore(bestProfitFactor) ||
                (pfScore(summary.profitFactor) === pfScore(bestProfitFactor) &&
                    summary.totalNetPl > bestTrialResult.totalNetPl)
            ) {
                bestValue = value;
                bestProfitFactor = summary.profitFactor;
                bestWinRate = summary.winRate;
                bestTrialResult = summary;
            }
        }

        const improved =
            pfScore(bestProfitFactor) > pfScore(baseline.profitFactor);
        if (improved && bestValue !== currentValue) {
            (suggestedOverrides as Record<string, number>)[param] = bestValue;
        }

        paramResults.push({
            param,
            currentValue,
            bestValue,
            baselineProfitFactor: pfScore(baseline.profitFactor),
            bestProfitFactor: pfScore(bestProfitFactor),
            baselineWinRate: baseline.winRate,
            bestWinRate,
            improved,
            trials,
        });
    }

    let applied = false;
    if (applyBest && Object.keys(suggestedOverrides).length > 0) {
        await db[MODEL.STRATEGY_CONFIG].update(suggestedOverrides, {
            where: { strategy_name: STRATEGY.SCALLPING },
        });
        applied = true;
    }

    return {
        startDate,
        endDate,
        signalType,
        instrumentType,
        baseline,
        paramResults,
        suggestedOverrides,
        applied,
    };
};
