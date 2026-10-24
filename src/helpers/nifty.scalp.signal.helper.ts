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
    };
    instrument?: any;
    hedgeInstrument?: any;
};

const optionLotSize = (option: any) =>
    Number(option?.lot_size || option?.minimum_lot) || 0;

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
    };

    const rawSignal: 'CE_BUY' | 'PE_BUY' | null =
        side === 'CE' &&
        lastEMA9 > lastEMA21 &&
        prevEMA9 <= prevEMA21 &&
        lastRSI > 45 &&
        lastRSI < config.rsi_ce_max
            ? 'CE_BUY'
            : side === 'PE' &&
                lastEMA9 < lastEMA21 &&
                prevEMA9 >= prevEMA21 &&
                lastRSI < 55 &&
                lastRSI > config.rsi_pe_min
              ? 'PE_BUY'
              : null;

    if (rawSignal) {
        // Skip chasing: price already far from its 9 EMA.
        if (extensionPct > NIFTY_MAX_EXTENSION_PCT) {
            return {
                signal: 'NONE',
                reason: `${side}_SKIP_EXTENDED_FROM_EMA9`,
                indicators,
                instrument,
            };
        }
        // Skip thin options (wide spreads, bad fills).
        if (volume5m < NIFTY_MIN_VOLUME_5M) {
            return {
                signal: 'NONE',
                reason: `${side}_SKIP_LOW_VOLUME`,
                indicators,
                instrument,
            };
        }
        return {
            signal: rawSignal,
            reason:
                rawSignal === 'CE_BUY'
                    ? 'CE_EMA_CROSS_UP_RSI_OK'
                    : 'PE_EMA_CROSS_DOWN_RSI_OK',
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

/** Spot trend: CE only when fast EMA above slow; PE only when below. */
export const spotTrendAllows = async (
    spotKey: string,
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
): Promise<{ ok: boolean; indicators: Record<string, number> }> => {
    const candlesDesc = await db[MODEL.CANDELS].findAll({
        where: { instrument_key: spotKey },
        order: [['ts', 'DESC']],
        limit: 100,
    });
    if (candlesDesc.length < config.min_candles_1m) {
        return { ok: true, indicators: {} };
    }
    const closes = candlesDesc.map((c) => Number(c.close)).reverse();
    const ema9 = EMA.calculate({ period: config.ema_fast, values: closes });
    const ema21 = EMA.calculate({ period: config.ema_slow, values: closes });
    const last9 = ema9[ema9.length - 1];
    const last21 = ema21[ema21.length - 1];
    const indicators = { spotEma9: last9, spotEma21: last21 };
    if (side === 'CE') return { ok: last9 >= last21, indicators };
    return { ok: last9 <= last21, indicators };
};

/**
 * 5-minute Nifty trend built from stored 1-minute spot candles.
 * CE needs fast EMA >= slow EMA; PE needs fast <= slow.
 * Passes (but flags it) while there are too few bars, e.g. right after a restart.
 */
export const spotTrend5mAllows = async (
    spotKey: string,
    side: 'CE' | 'PE',
): Promise<{ ok: boolean; insufficient: boolean; indicators: Record<string, number> }> => {
    const candlesDesc = await db[MODEL.CANDELS].findAll({
        where: { instrument_key: spotKey },
        order: [['ts', 'DESC']],
        limit: 500,
    });
    const bucketMs = 5 * 60 * 1000;
    const buckets = new Map<number, number>();
    for (const c of [...candlesDesc].reverse()) {
        const bucket = Math.floor(Number(c.ts) / bucketMs);
        buckets.set(bucket, Number(c.close));
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
        ok: side === 'CE' ? lastFast >= lastSlow : lastFast <= lastSlow,
        insufficient: false,
        indicators,
    };
};

/** 1-minute and 5-minute Nifty trend must both agree with the side. */
export const spotTrendAllowsAll = async (
    spotKey: string,
    side: 'CE' | 'PE',
    config: NiftyScalpConfig,
): Promise<{ ok: boolean; reason: string; indicators: Record<string, number> }> => {
    const oneMin = await spotTrendAllows(spotKey, side, config);
    if (!oneMin.ok) {
        return { ok: false, reason: 'SPOT_1M_TREND', indicators: oneMin.indicators };
    }
    const fiveMin = await spotTrend5mAllows(spotKey, side);
    return {
        ok: fiveMin.ok,
        reason: 'SPOT_5M_TREND',
        indicators: { ...oneMin.indicators, ...fiveMin.indicators },
    };
};

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

    if (ceSignal.signal === 'CE_BUY') {
        const trend = await spotTrendAllowsAll(
            config.underlying_instrument_key,
            'CE',
            config,
        );
        if (!trend.ok) {
            // fall through to PE
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
            return {
                signal: 'NONE',
                reason: `${trend.reason}_BLOCKS_PE|${ceSignal.reason}`,
                indicators: {
                    ...ceSignal.indicators,
                    ...peSignal.indicators,
                    ...trend.indicators,
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

    return {
        signal: 'NONE',
        reason: `${ceSignal.reason}|${peSignal.reason}`,
        indicators: {
            ...ceSignal.indicators,
            ...peSignal.indicators,
        },
    };
};
