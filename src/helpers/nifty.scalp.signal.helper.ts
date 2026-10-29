import { Op } from 'sequelize';
import { MODEL } from '../constant';
import { db } from '../model';
import {
    NIFTY_HEDGE_ENABLED,
    NIFTY_HEDGE_PREMIUM_MAX,
    NIFTY_HEDGE_PREMIUM_MIN,
    NIFTY_MAX_EXTENSION_PCT,
    NIFTY_MIN_VOLUME_5M,
    NIFTY_SPOT_5M_FAST,
    NIFTY_SPOT_5M_SLOW,
    NiftyScalpConfig,
    twoLotWithHedgeCost,
} from './nifty.scalp.config.helper';

const { EMA, RSI } = require('technicalindicators');

export type NiftySignalResult = {
    signal: 'CE_BUY' | 'PE_BUY' | 'NONE';
    reason: string;
    indicators: {
        ema9?: number;
        ema21?: number;
        prevEma9?: number;
        prevEma21?: number;
        rsi?: number;
        spotEma9?: number;
        spotEma21?: number;
        spot5mFast?: number;
        spot5mSlow?: number;
        volume5m?: number;
        extensionPct?: number;
        signalCandleTs?: number;
    };
    instrument?: any;
    hedgeInstrument?: any;
    /** Per-side verdict and numbers, so the audit never mixes CE and PE values. */
    sides?: Partial<Record<'CE' | 'PE', NiftySideSummary>>;
};

export type NiftySideSummary = {
    symbol?: string;
    reason: string;
    ema9?: number;
    ema21?: number;
    rsi?: number;
    extensionPct?: number;
    volume5m?: number;
    trend?: Record<string, number>;
};

const round2 = (v: unknown) =>
    Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : undefined;

const summarizeSide = (
    result: NiftySignalResult,
    reason: string,
    trend?: Record<string, number>,
): NiftySideSummary => ({
    symbol: result.instrument?.trading_symbol,
    reason,
    ema9: round2(result.indicators.ema9),
    ema21: round2(result.indicators.ema21),
    rsi: round2(result.indicators.rsi),
    extensionPct: result.indicators.extensionPct,
    volume5m: result.indicators.volume5m,
    trend: trend
        ? Object.fromEntries(
              Object.entries(trend).map(([k, v]) => [k, round2(v) as number]),
          )
        : undefined,
});

const describeSideReason = (side: 'CE' | 'PE', s: NiftySideSummary) => {
    const r = s.reason;
    const t = s.trend ?? {};
    if (/^NO_(CE|PE)_EMA_CROSS$/.test(r)) return 'no fresh EMA9/21 cross up on the premium';
    if (r.endsWith('_SKIP_EXTENDED_FROM_EMA9'))
        return `crossed up, but price is ${((s.extensionPct ?? 0) * 100).toFixed(2)}% from EMA9 (chasing)`;
    if (r.endsWith('_SKIP_LOW_VOLUME'))
        return `crossed up, but 5-candle volume ${s.volume5m} is too thin`;
    if (r.startsWith('SPOT_1M_TREND_BLOCKS'))
        return `crossed up, but Nifty 1m trend disagrees (EMA9 ${t.spotEma9} vs EMA21 ${t.spotEma21}; ${side} needs Nifty ${side === 'CE' ? 'rising' : 'falling'})`;
    if (r.startsWith('SPOT_5M_TREND_BLOCKS'))
        return `crossed up, but Nifty 5m trend disagrees (EMA5 ${t.spot5mFast} vs EMA13 ${t.spot5mSlow}; ${side} needs Nifty ${side === 'CE' ? 'rising' : 'falling'})`;
    if (r.endsWith('_CANDLES_INSUFFICIENT')) return 'not enough candles yet';
    return r;
};

/** Plain-language summary of a signal evaluation for the audit log. */
export const explainSignal = (result: NiftySignalResult): string => {
    if (result.signal !== 'NONE') {
        return `${result.signal}: ${result.instrument?.trading_symbol ?? ''} premium crossed EMA9 above EMA21 with RSI ${round2(result.indicators.rsi)}, extension ${((result.indicators.extensionPct ?? 0) * 100).toFixed(2)}%, and Nifty 1m + 5m trend agree. (${result.reason})`;
    }
    if (!result.sides) return `No trade: ${result.reason}`;
    const parts = (['CE', 'PE'] as const)
        .filter((side) => result.sides?.[side])
        .map((side) => {
            const s = result.sides![side]!;
            return `${side} ${s.symbol ?? ''} (EMA9 ${s.ema9}, EMA21 ${s.ema21}, RSI ${s.rsi}): ${describeSideReason(side, s)}`;
        });
    return `No trade. ${parts.join('. ')}.`;
};

/** A side that got past "no cross" is the more interesting one to show. */
const crossed = (reason: string) => !/^NO_(CE|PE)_EMA_CROSS$/.test(reason);

const optionLotSize = (option: any) =>
    Number(option?.lot_size || option?.minimum_lot) || 0;

/**
 * Tunable entry thresholds. The live engine always uses the defaults; the
 * replay tool overrides them to test changes on stored days.
 */
export type NiftySignalParams = {
    maxExtensionPct: number;
    minVolume5m: number;
    /** Points the Nifty 1m EMA9 may sit on the wrong side of EMA21 and still count as agreeing. */
    spot1mTolerancePts: number;
    /** Same for the 5m EMA5 vs EMA13. */
    spot5mTolerancePts: number;
};

export const DEFAULT_NIFTY_SIGNAL_PARAMS: NiftySignalParams = {
    maxExtensionPct: NIFTY_MAX_EXTENSION_PCT,
    minVolume5m: NIFTY_MIN_VOLUME_5M,
    spot1mTolerancePts: 0,
    spot5mTolerancePts: 0,
};

type CandleLike = { ts: number | string; close: number | string; volume?: number | string };

/** Entry check for one option from its 1m candles (newest first). No DB access. */
export const optionSignalFromCandles = (
    instrument: any,
    candlesDesc: CandleLike[],
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
    params: NiftySignalParams = DEFAULT_NIFTY_SIGNAL_PARAMS,
): NiftySignalResult => {
    if (candlesDesc.length < config.min_candles_1m) {
        return {
            signal: 'NONE',
            reason: `${side}_CANDLES_INSUFFICIENT`,
            indicators: {},
            instrument,
        };
    }

    const closes = candlesDesc.map((c) => Number(c.close)).reverse();
    const ema9 = EMA.calculate({ period: config.ema_fast, values: closes });
    const ema21 = EMA.calculate({ period: config.ema_slow, values: closes });
    const rsiArr = RSI.calculate({
        period: config.rsi_period,
        values: closes,
    });

    const lastEMA9 = ema9[ema9.length - 1];
    const prevEMA9 = ema9[ema9.length - 2];
    const lastEMA21 = ema21[ema21.length - 1];
    const prevEMA21 = ema21[ema21.length - 2];
    const lastRSI = rsiArr[rsiArr.length - 1];

    const lastClose = Number(candlesDesc[0]?.close ?? 0);
    const volume5m = candlesDesc
        .slice(0, 5)
        .reduce((sum, c) => sum + Number(c.volume || 0), 0);
    const extensionPct =
        lastEMA9 > 0 ? Math.abs(lastClose - lastEMA9) / lastEMA9 : 0;

    const indicators = {
        ema9: lastEMA9,
        ema21: lastEMA21,
        prevEma9: prevEMA9,
        prevEma21: prevEMA21,
        rsi: lastRSI,
        volume5m,
        extensionPct: Number(extensionPct.toFixed(4)),
        // Start (epoch ms) of the completed candle the cross was read from.
        signalCandleTs: Number(candlesDesc[0]?.ts) || undefined,
    };

    // These are the option's own premium candles, and we only ever BUY.
    // A PE premium rises when Nifty falls, so both sides need the premium
    // crossing UP with healthy (not overbought) momentum.
    const premiumCrossUp =
        lastEMA9 > lastEMA21 &&
        prevEMA9 <= prevEMA21 &&
        lastRSI > 45 &&
        lastRSI < config.rsi_ce_max;
    const rawSignal: 'CE_BUY' | 'PE_BUY' | null = premiumCrossUp
        ? side === 'CE'
            ? 'CE_BUY'
            : 'PE_BUY'
        : null;

    if (rawSignal) {
        // Skip chasing: price already far from its 9 EMA.
        if (extensionPct > params.maxExtensionPct) {
            return {
                signal: 'NONE',
                reason: `${side}_SKIP_EXTENDED_FROM_EMA9`,
                indicators,
                instrument,
            };
        }
        // Skip thin options (wide spreads, bad fills).
        if (volume5m < params.minVolume5m) {
            return {
                signal: 'NONE',
                reason: `${side}_SKIP_LOW_VOLUME`,
                indicators,
                instrument,
            };
        }
        return {
            signal: rawSignal,
            reason: `${side}_EMA_CROSS_UP_RSI_OK`,
            indicators,
            instrument,
        };
    }

    return {
        signal: 'NONE',
        reason: side === 'CE' ? 'NO_CE_EMA_CROSS' : 'NO_PE_EMA_CROSS',
        indicators,
        instrument,
    };
};

const evaluateOptionCandles = async (
    instrument: any,
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
): Promise<NiftySignalResult> => {
    if (!instrument?.instrument_key) {
        return {
            signal: 'NONE',
            reason: `${side}_INSTRUMENT_MISSING`,
            indicators: {},
        };
    }
    const candlesDesc = await db[MODEL.CANDELS].findAll({
        where: { instrument_key: instrument.instrument_key },
        order: [['ts', 'DESC']],
        limit: 100,
    });
    return optionSignalFromCandles(instrument, candlesDesc, side, config);
};

/** Nifty 1m trend from closes (oldest first). CE needs EMA9 ≥ EMA21, PE needs ≤. */
export const spotTrend1mFromCloses = (
    closesAsc: number[],
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
    tolerancePts = 0,
): { ok: boolean; indicators: Record<string, number> } => {
    if (closesAsc.length < config.min_candles_1m) {
        return { ok: true, indicators: {} };
    }
    const ema9 = EMA.calculate({ period: config.ema_fast, values: closesAsc });
    const ema21 = EMA.calculate({ period: config.ema_slow, values: closesAsc });
    const last9 = ema9[ema9.length - 1];
    const last21 = ema21[ema21.length - 1];
    const indicators = { spotEma9: last9, spotEma21: last21 };
    if (side === 'CE') return { ok: last9 >= last21 - tolerancePts, indicators };
    return { ok: last9 <= last21 + tolerancePts, indicators };
};

/**
 * Nifty 5m trend built from 1m candles (oldest first): the last close of each
 * 5-minute bucket. Passes (but flags it) while there are too few bars.
 */
export const spotTrend5mFromCandles = (
    candlesAsc: CandleLike[],
    side: 'CE' | 'PE',
    tolerancePts = 0,
): { ok: boolean; insufficient: boolean; indicators: Record<string, number> } => {
    const bucketMs = 5 * 60 * 1000;
    const buckets = new Map<number, number>();
    for (const c of candlesAsc) {
        buckets.set(Math.floor(Number(c.ts) / bucketMs), Number(c.close));
    }
    const closes = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, close]) => close);
    if (closes.length < NIFTY_SPOT_5M_SLOW + 2) {
        return { ok: true, insufficient: true, indicators: {} };
    }
    const fast = EMA.calculate({ period: NIFTY_SPOT_5M_FAST, values: closes });
    const slow = EMA.calculate({ period: NIFTY_SPOT_5M_SLOW, values: closes });
    const lastFast = fast[fast.length - 1];
    const lastSlow = slow[slow.length - 1];
    const indicators = { spot5mFast: lastFast, spot5mSlow: lastSlow };
    return {
        ok:
            side === 'CE'
                ? lastFast >= lastSlow - tolerancePts
                : lastFast <= lastSlow + tolerancePts,
        insufficient: false,
        indicators,
    };
};

/** 1m and 5m Nifty trend must both agree with the side. */
export const spotTrendAllFromCandles = (
    candlesAsc: CandleLike[],
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
    params: NiftySignalParams = DEFAULT_NIFTY_SIGNAL_PARAMS,
): { ok: boolean; reason: string; indicators: Record<string, number> } => {
    const oneMin = spotTrend1mFromCloses(
        candlesAsc.slice(-100).map((c) => Number(c.close)),
        side,
        config,
        params.spot1mTolerancePts,
    );
    if (!oneMin.ok) {
        return { ok: false, reason: 'SPOT_1M_TREND', indicators: oneMin.indicators };
    }
    const fiveMin = spotTrend5mFromCandles(
        candlesAsc.slice(-500),
        side,
        params.spot5mTolerancePts,
    );
    return {
        ok: fiveMin.ok,
        reason: 'SPOT_5M_TREND',
        indicators: { ...oneMin.indicators, ...fiveMin.indicators },
    };
};

/**
 * Same side order as evaluateNiftyOptionSignal: CE first; if CE has no signal
 * or the Nifty trend refuses it, try PE. No DB access.
 */
export const pickNiftyEntrySide = (
    ceSignal: NiftySignalResult,
    peSignal: NiftySignalResult,
    spotCandlesAsc: CandleLike[],
    config: NiftyScalpConfig,
    params: NiftySignalParams = DEFAULT_NIFTY_SIGNAL_PARAMS,
): { side: 'CE' | 'PE' | null; reason: string } => {
    let ceReason = ceSignal.reason;
    if (ceSignal.signal === 'CE_BUY') {
        const trend = spotTrendAllFromCandles(spotCandlesAsc, 'CE', config, params);
        if (trend.ok) return { side: 'CE', reason: ceSignal.reason };
        ceReason = `${trend.reason}_BLOCKS_CE`;
    }
    if (peSignal.signal === 'PE_BUY') {
        const trend = spotTrendAllFromCandles(spotCandlesAsc, 'PE', config, params);
        if (trend.ok) return { side: 'PE', reason: peSignal.reason };
        return { side: null, reason: `${ceReason}|${trend.reason}_BLOCKS_PE` };
    }
    return { side: null, reason: `${ceReason}|${peSignal.reason}` };
};

const spotCandlesAsc = async (spotKey: string, limit: number) =>
    (
        await db[MODEL.CANDELS].findAll({
            where: { instrument_key: spotKey },
            order: [['ts', 'DESC']],
            limit,
        })
    ).reverse();

/** Spot trend: CE only when fast EMA above slow; PE only when below. */
export const spotTrendAllows = async (
    spotKey: string,
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
): Promise<{ ok: boolean; indicators: Record<string, number> }> => {
    const candles = await spotCandlesAsc(spotKey, 100);
    return spotTrend1mFromCloses(
        candles.map((c) => Number(c.close)),
        side,
        config,
    );
};

/** 1-minute and 5-minute Nifty trend must both agree with the side. */
export const spotTrendAllowsAll = async (
    spotKey: string,
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
): Promise<{ ok: boolean; reason: string; indicators: Record<string, number> }> =>
    spotTrendAllFromCandles(await spotCandlesAsc(spotKey, 500), side, config);

/** Nearest listed strike to ATM for one side (ATM first, then ±1..3 steps). */
const findNearestListed = async (
    expiry: string,
    atm: number,
    strikeStep: number,
    instrumentType: 'CE' | 'PE',
) => {
    const offsets = [0, 1, -1, 2, -2, 3, -3];
    for (const k of offsets) {
        const row = await findStrike(expiry, atm + k * strikeStep, instrumentType);
        if (row) return row;
    }
    return null;
};

export const findAtmCePe = async (
    spot: number,
    expiry: string,
    strikeStep: number,
) => {
    const atm = Math.round(spot / strikeStep) * strikeStep;
    // If the exact ATM strike is not listed, use the nearest one that is.
    const ce = await findNearestListed(expiry, atm, strikeStep, 'CE');
    const pe = await findNearestListed(expiry, atm, strikeStep, 'PE');
    return { atm, ce, pe };
};

const findStrike = async (
    expiry: string,
    strike: number,
    instrumentType: 'CE' | 'PE',
) =>
    db[MODEL.HEDGING_OPTIONS].findOne({
        where: {
            expiry,
            strike_price: strike,
            instrument_type: instrumentType,
            name: 'NIFTY',
        },
    });

/** Opposite hedge in ₹5–15 premium band, closest to mid of band. */
export const findHedgeOption = async ({
    expiry,
    mainSide,
    spot,
    strikeStep,
}: {
    expiry: string;
    mainSide: 'CE' | 'PE';
    spot: number;
    strikeStep: number;
}) => {
    const hedgeSide = mainSide === 'CE' ? 'PE' : 'CE';
    const rows = await db[MODEL.HEDGING_OPTIONS].findAll({
        where: {
            expiry,
            name: 'NIFTY',
            instrument_type: hedgeSide,
            ltp: {
                [Op.gte]: NIFTY_HEDGE_PREMIUM_MIN,
                [Op.lte]: NIFTY_HEDGE_PREMIUM_MAX,
            },
        },
    });
    if (!rows.length) {
        // Fallback: nearest OTM with any positive LTP under max
        const atm = Math.round(spot / strikeStep) * strikeStep;
        const direction = hedgeSide === 'CE' ? 1 : -1;
        for (let step = 1; step <= 8; step += 1) {
            const row = await findStrike(
                expiry,
                atm + direction * strikeStep * step,
                hedgeSide,
            );
            const ltp = Number(row?.ltp || 0);
            if (row && ltp > 0 && ltp <= NIFTY_HEDGE_PREMIUM_MAX) return row;
        }
        return null;
    }
    const mid = (NIFTY_HEDGE_PREMIUM_MIN + NIFTY_HEDGE_PREMIUM_MAX) / 2;
    return [...rows].sort(
        (a, b) =>
            Math.abs(Number(a.ltp) - mid) - Math.abs(Number(b.ltp) - mid),
    )[0];
};

const canAffordPair = (
    main: any,
    hedge: any,
    balance: number,
    addPoints: number,
) => {
    const cost = twoLotWithHedgeCost(
        Number(main?.ltp),
        Number(hedge?.ltp),
        optionLotSize(main),
        addPoints,
    );
    return cost != null && balance >= cost;
};

/** ATM first; if unaffordable with the 2nd lot (and hedge, when enabled), step to cheaper premium. */
const firstAffordableMain = async ({
    side,
    atm,
    expiry,
    strikeStep,
    balance,
    atmOption,
    hedge,
    addPoints,
}: {
    side: 'CE' | 'PE';
    atm: number;
    expiry: string;
    strikeStep: number;
    balance: number;
    atmOption: any;
    hedge: any;
    addPoints: number;
}) => {
    if (atmOption && canAffordPair(atmOption, hedge, balance, addPoints)) {
        return atmOption;
    }
    const direction = side === 'CE' ? 1 : -1;
    for (let step = 1; step <= 6; step += 1) {
        const option = await findStrike(
            expiry,
            atm + direction * strikeStep * step,
            side,
        );
        if (option && canAffordPair(option, hedge, balance, addPoints)) {
            return option;
        }
    }
    return null;
};

export const evaluateNiftyOptionSignal = async (
    config: NiftyScalpConfig,
    spot: number,
    expiry: string,
    balance?: number,
): Promise<NiftySignalResult> => {
    const { ce, pe, atm } = await findAtmCePe(
        spot,
        expiry,
        config.strike_step,
    );

    if (!ce && !pe) {
        return {
            signal: 'NONE',
            reason: `ATM_NOT_FOUND_${atm}`,
            indicators: {},
        };
    }

    const addPoints = Number(config.add_lot_points || 10);

    const ceSignal = ce
        ? await evaluateOptionCandles(ce, 'CE', config)
        : {
              signal: 'NONE' as const,
              reason: 'CE_MISSING',
              indicators: {},
          };

    let ceReason = ceSignal.reason;
    let ceTrend: Record<string, number> | undefined;

    if (ceSignal.signal === 'CE_BUY') {
        const trend = await spotTrendAllowsAll(
            config.underlying_instrument_key,
            'CE',
            config,
        );
        ceTrend = trend.indicators;
        if (!trend.ok) {
            // Still check PE, but remember why CE was refused.
            ceReason = `${trend.reason}_BLOCKS_CE`;
        } else {
            const hedge = NIFTY_HEDGE_ENABLED
                ? await findHedgeOption({
                      expiry,
                      mainSide: 'CE',
                      spot,
                      strikeStep: config.strike_step,
                  })
                : null;
            if (NIFTY_HEDGE_ENABLED && !hedge) {
                return {
                    signal: 'NONE',
                    reason: 'CE_NO_HEDGE_IN_BAND',
                    indicators: { ...ceSignal.indicators, ...trend.indicators },
                };
            }
            if (balance == null) {
                return { ...ceSignal, hedgeInstrument: hedge ?? undefined };
            }
            const picked = await firstAffordableMain({
                side: 'CE',
                atm,
                expiry,
                strikeStep: config.strike_step,
                balance,
                atmOption: ce,
                hedge,
                addPoints,
            });
            if (picked) {
                return {
                    ...ceSignal,
                    instrument: picked,
                    hedgeInstrument: hedge ?? undefined,
                    reason:
                        picked === ce
                            ? ceSignal.reason
                            : `${ceSignal.reason}_CHEAPER_STRIKE`,
                    indicators: { ...ceSignal.indicators, ...trend.indicators },
                };
            }
            return {
                signal: 'NONE',
                reason: 'CE_INSUFFICIENT_BALANCE_2LOT',
                indicators: { ...ceSignal.indicators, ...trend.indicators },
            };
        }
    }

    const peSignal = pe
        ? await evaluateOptionCandles(pe, 'PE', config)
        : {
              signal: 'NONE' as const,
              reason: 'PE_MISSING',
              indicators: {},
          };

    if (peSignal.signal === 'PE_BUY') {
        const trend = await spotTrendAllowsAll(
            config.underlying_instrument_key,
            'PE',
            config,
        );
        if (!trend.ok) {
            const peReason = `${trend.reason}_BLOCKS_PE`;
            return {
                signal: 'NONE',
                reason: `${ceReason}|${peReason}`,
                indicators: { ...peSignal.indicators, ...trend.indicators },
                sides: {
                    CE: summarizeSide(ceSignal, ceReason, ceTrend),
                    PE: summarizeSide(peSignal, peReason, trend.indicators),
                },
            };
        }
        const hedge = NIFTY_HEDGE_ENABLED
            ? await findHedgeOption({
                  expiry,
                  mainSide: 'PE',
                  spot,
                  strikeStep: config.strike_step,
              })
            : null;
        if (NIFTY_HEDGE_ENABLED && !hedge) {
            return {
                signal: 'NONE',
                reason: 'PE_NO_HEDGE_IN_BAND',
                indicators: { ...peSignal.indicators, ...trend.indicators },
            };
        }
        if (balance == null) {
            return { ...peSignal, hedgeInstrument: hedge ?? undefined };
        }
        const picked = await firstAffordableMain({
            side: 'PE',
            atm,
            expiry,
            strikeStep: config.strike_step,
            balance,
            atmOption: pe,
            hedge,
            addPoints,
        });
        if (picked) {
            return {
                ...peSignal,
                instrument: picked,
                hedgeInstrument: hedge ?? undefined,
                reason:
                    picked === pe
                        ? peSignal.reason
                        : `${peSignal.reason}_CHEAPER_STRIKE`,
                indicators: { ...peSignal.indicators, ...trend.indicators },
            };
        }
        return {
            signal: 'NONE',
            reason: 'PE_INSUFFICIENT_BALANCE_2LOT',
            indicators: { ...peSignal.indicators, ...trend.indicators },
        };
    }

    // The flat indicator columns show ONE side: the one that actually
    // crossed (and was then filtered), else CE. Both sides live in `sides`.
    const focusPe = crossed(peSignal.reason) && !crossed(ceReason);
    const focus = focusPe
        ? peSignal.indicators
        : { ...ceSignal.indicators, ...(ceTrend ?? {}) };
    return {
        signal: 'NONE',
        reason: `${ceReason}|${peSignal.reason}`,
        indicators: focus,
        sides: {
            CE: summarizeSide(ceSignal, ceReason, ceTrend),
            PE: summarizeSide(peSignal, peSignal.reason),
        },
    };
};
