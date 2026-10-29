import moment from 'moment';
import { Op } from 'sequelize';
import { INDEXES, INDEXES_NAMES, MODEL } from '../constant';
import { db } from '../model';

const NIFTY_NAME = INDEXES_NAMES.NIFTY_50;

export const asExpiryDay = (value: unknown): string =>
    moment(value).format('YYYY-MM-DD');

/** Next NSE session date (skips Sat/Sun; exchange holidays are not in this list). */
export const nextMarketDay = (day: string): string => {
    let d = moment(day, 'YYYY-MM-DD').add(1, 'day');
    while (d.day() === 0 || d.day() === 6) d = d.add(1, 'day');
    return d.format('YYYY-MM-DD');
};

export type NiftyExpiryPlan = {
    today: string;
    nearestExpiry: string | null;
    /** Contract the engine may BUY. On expiry day this is next week, never today. */
    tradeExpiry: string | null;
    /** Expiries kept in hedging_options and on the market websocket. */
    subscribeExpiries: string[];
    isExpiryDay: boolean;
};

const listNiftyExpiriesOnOrAfter = async (day: string): Promise<string[]> => {
    const rows = (await db[MODEL.OPTIONS_CHAINS].findAll({
        where: {
            name: NIFTY_NAME,
            expiry: { [Op.gte]: day },
        },
        attributes: ['expiry'],
        raw: true,
    })) as { expiry: string }[];
    return [...new Set(rows.map((r) => asExpiryDay(r.expiry)))]
        .filter((d) => d && d !== 'Invalid date')
        .sort();
};

export const getNiftyExpiryPlan = async (
    day?: string,
): Promise<NiftyExpiryPlan> => {
    const today = day ?? moment().startOf('day').format('YYYY-MM-DD');
    const unique = await listNiftyExpiriesOnOrAfter(today);
    const nearestExpiry = unique[0] ?? null;
    const isExpiryDay = Boolean(nearestExpiry && nearestExpiry === today);
    const tradeExpiry = isExpiryDay
        ? (unique[1] ?? nearestExpiry)
        : nearestExpiry;
    const subscribeExpiries = unique.slice(0, 2);
    return {
        today,
        nearestExpiry,
        tradeExpiry,
        subscribeExpiries,
        isExpiryDay,
    };
};

export const getNiftyTradeExpiry = async (): Promise<string | null> => {
    const plan = await getNiftyExpiryPlan();
    return plan.tradeExpiry;
};

/** Keys the market websocket should request: hedging rows + Nifty spot. */
export const getNiftyMarketSubscribeKeys = async (): Promise<string[]> => {
    const options = await db[MODEL.HEDGING_OPTIONS].findAll({
        where: { name: NIFTY_NAME },
        attributes: ['instrument_key'],
        raw: true,
    });
    return [
        ...new Set(
            [
                ...options.map((o: { instrument_key?: string }) => o.instrument_key),
                INDEXES.NIFTY_50,
            ].filter(Boolean) as string[],
        ),
    ];
};

export const expiryForInstrument = async (
    instrumentKey: string,
): Promise<string | null> => {
    const row =
        (await db[MODEL.HEDGING_OPTIONS].findOne({
            where: { instrument_key: instrumentKey },
            attributes: ['expiry'],
            raw: true,
        })) ||
        (await db[MODEL.OPTIONS_CHAINS].findOne({
            where: { instrument_key: instrumentKey },
            attributes: ['expiry'],
            raw: true,
        }));
    if (!row?.expiry) return null;
    return asExpiryDay(row.expiry);
};

/** Flatten immediately — this contract expires today. */
export const optionExpiresToday = (
    optionExpiry: string | null,
    today: string,
): boolean => Boolean(optionExpiry && optionExpiry === today);

/**
 * Do not hold overnight: the option expires today or on the next session
 * (e.g. this week's Nifty on Monday afternoon).
 */
export const mustNotCarryOvernight = (
    optionExpiry: string | null,
    today: string,
): boolean => Boolean(optionExpiry && optionExpiry <= nextMarketDay(today));
