import { Op } from 'sequelize';
import { MODEL } from '../constant';
import { db } from '../model';
import {
    NIFTY_HEDGE_PREMIUM_MAX,
    NIFTY_HEDGE_PREMIUM_MIN,
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

    const indicators = {
        ema9: lastEMA9,
        ema21: lastEMA21,
        prevEma9: prevEMA9,
        prevEma21: prevEMA21,
        rsi: lastRSI,
    };

    if (
        side === 'CE' &&
        lastEMA9 > lastEMA21 &&
        prevEMA9 <= prevEMA21 &&
        lastRSI > 45 &&
        lastRSI < config.rsi_ce_max
    ) {
        return {
            signal: 'CE_BUY',
            reason: 'CE_EMA_CROSS_UP_RSI_OK',
            indicators,
            instrument,
        };
    }

    if (
        side === 'PE' &&
        lastEMA9 < lastEMA21 &&
        prevEMA9 >= prevEMA21 &&
        lastRSI < 55 &&
        lastRSI > config.rsi_pe_min
    ) {
        return {
            signal: 'PE_BUY',
            reason: 'PE_EMA_CROSS_DOWN_RSI_OK',
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

export const findAtmCePe = async (
    spot: number,
    expiry: string,
    strikeStep: number,
) => {
    const atm = Math.round(spot / strikeStep) * strikeStep;
    const ce = await db[MODEL.HEDGING_OPTIONS].findOne({
        where: {
            expiry,
            strike_price: atm,
            instrument_type: 'CE',
            name: 'NIFTY',
        },
    });
    const pe = await db[MODEL.HEDGING_OPTIONS].findOne({
        where: {
            expiry,
            strike_price: atm,
            instrument_type: 'PE',
            name: 'NIFTY',
        },
    });
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

/** ATM first; if unaffordable with hedge+2nd lot, step to cheaper premium. */
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
    if (atmOption && hedge && canAffordPair(atmOption, hedge, balance, addPoints)) {
        return atmOption;
    }
    const direction = side === 'CE' ? 1 : -1;
    for (let step = 1; step <= 6; step += 1) {
        const option = await findStrike(
            expiry,
            atm + direction * strikeStep * step,
            side,
        );
        if (option && hedge && canAffordPair(option, hedge, balance, addPoints)) {
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
        const trend = await spotTrendAllows(
            config.underlying_instrument_key,
            'CE',
            config,
        );
        if (!trend.ok) {
            // fall through to PE
        } else {
            const hedge = await findHedgeOption({
                expiry,
                mainSide: 'CE',
                spot,
                strikeStep: config.strike_step,
            });
            if (!hedge) {
                return {
                    signal: 'NONE',
                    reason: 'CE_NO_HEDGE_IN_BAND',
                    indicators: { ...ceSignal.indicators, ...trend.indicators },
                };
            }
            if (balance == null) {
                return { ...ceSignal, hedgeInstrument: hedge };
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
                    hedgeInstrument: hedge,
                    reason:
                        picked === ce
                            ? ceSignal.reason
                            : `${ceSignal.reason}_CHEAPER_STRIKE`,
                    indicators: { ...ceSignal.indicators, ...trend.indicators },
                };
            }
            return {
                signal: 'NONE',
                reason: 'CE_INSUFFICIENT_BALANCE_2LOT_HEDGE',
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
        const trend = await spotTrendAllows(
            config.underlying_instrument_key,
            'PE',
            config,
        );
        if (!trend.ok) {
            return {
                signal: 'NONE',
                reason: `SPOT_TREND_BLOCKS_PE|${ceSignal.reason}`,
                indicators: {
                    ...ceSignal.indicators,
                    ...peSignal.indicators,
                    ...trend.indicators,
                },
            };
        }
        const hedge = await findHedgeOption({
            expiry,
            mainSide: 'PE',
            spot,
            strikeStep: config.strike_step,
        });
        if (!hedge) {
            return {
                signal: 'NONE',
                reason: 'PE_NO_HEDGE_IN_BAND',
                indicators: { ...peSignal.indicators, ...trend.indicators },
            };
        }
        if (balance == null) {
            return { ...peSignal, hedgeInstrument: hedge };
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
                hedgeInstrument: hedge,
                reason:
                    picked === pe
                        ? peSignal.reason
                        : `${peSignal.reason}_CHEAPER_STRIKE`,
                indicators: { ...peSignal.indicators, ...trend.indicators },
            };
        }
        return {
            signal: 'NONE',
            reason: 'PE_INSUFFICIENT_BALANCE_2LOT_HEDGE',
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
