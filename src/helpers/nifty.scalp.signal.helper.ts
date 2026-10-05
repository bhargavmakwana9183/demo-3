import { MODEL } from '../constant';
import { db } from '../model';
import { NiftyScalpConfig } from './nifty.scalp.config.helper';

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
    };
    instrument?: any;
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

export const evaluateNiftyOptionSignal = async (
    config: NiftyScalpConfig,
    spot: number,
    expiry: string,
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

    const ceSignal = ce
        ? await evaluateOptionCandles(ce, 'CE', config)
        : {
              signal: 'NONE' as const,
              reason: 'CE_MISSING',
              indicators: {},
          };
    if (ceSignal.signal === 'CE_BUY') return ceSignal;

    const peSignal = pe
        ? await evaluateOptionCandles(pe, 'PE', config)
        : {
              signal: 'NONE' as const,
              reason: 'PE_MISSING',
              indicators: {},
          };
    if (peSignal.signal === 'PE_BUY') return peSignal;

    return {
        signal: 'NONE',
        reason: `${ceSignal.reason}|${peSignal.reason}`,
        indicators: {
            ...ceSignal.indicators,
            ...peSignal.indicators,
        },
    };
};
