import axios from 'axios';
import { Op } from 'sequelize';
import {
    INDEXES,
    INDEXES_NAMES,
    MODEL,
    STRATEGY,
    USER_DETAILS,
} from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import { getNiftyExpiryPlan } from './nifty.expiry.helper';
import { resubscribeNiftyMarketFeed } from './nifty.market.subscribe.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';
import { NIFTY_WARMUP_STRIKE_STEPS } from './nifty.scalp.config.helper';

const NIFTY_INSTRUMENT_KEY = INDEXES.NIFTY_50;
const NIFTY_NAME = INDEXES_NAMES.NIFTY_50;

export const syncNiftyOptionChain = async (): Promise<{
    inserted: number;
    skipped: number;
    deletedExpired: number;
}> => {
    const user = await db[MODEL.USER].findOne({
        where: { email: USER_DETAILS.EMAIL },
    });
    if (!user?.token) {
        throw new Error('User token not found for Nifty option chain sync');
    }

    const response = await axios.get(
        'https://api.upstox.com/v2/option/contract',
        {
            headers: {
                Authorization: `Bearer ${user.token}`,
                Accept: 'application/json',
            },
            params: { instrument_key: NIFTY_INSTRUMENT_KEY },
            maxBodyLength: Infinity,
        },
    );

    const contracts = response.data?.data || [];
    let inserted = 0;
    let skipped = 0;

    // Insert-only into option_chain_details — never delete chain / trade / position
    for (const data of contracts) {
        const existing = await db[MODEL.OPTIONS_CHAINS].findOne({
            where: { instrument_key: data.instrument_key },
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        await db[MODEL.OPTIONS_CHAINS].create({
            ...data,
            name: data.name || NIFTY_NAME,
        });
        inserted += 1;
    }

    await logNiftyAudit({
        action: 'CHAIN_SYNC',
        reason: 'Nifty option_chain_details synced (insert only)',
        metadata: { inserted, skipped, deletedExpired: 0 },
    });

    logger.info(
        `Nifty option chain sync: inserted=${inserted}, skipped=${skipped} (no chain/trade deletes)`,
    );

    return { inserted, skipped, deletedExpired: 0 };
};

const hedgingFieldsFromChain = (data: any) => ({
    options_chain_id: data.id,
    name: data.name,
    segment: data.segment,
    exchange: data.exchange,
    expiry: data.expiry,
    weekly: data.weekly,
    instrument_key: data.instrument_key,
    exchange_token: data.exchange_token,
    trading_symbol: data.trading_symbol,
    tick_size: data.tick_size,
    lot_size: data.lot_size,
    instrument_type: data.instrument_type,
    freeze_quantity: data.freeze_quantity,
    underlying_type: data.underlying_type,
    underlying_key: data.underlying_key,
    underlying_symbol: data.underlying_symbol,
    strike_price: data.strike_price,
    ltp: data.ltp || 0,
    minimum_lot: data.minimum_lot,
});

const lastNiftySpot = async (): Promise<number | null> => {
    const row = await db[MODEL.CANDELS].findOne({
        where: { instrument_key: INDEXES.NIFTY_50 },
        order: [['ts', 'DESC']],
    });
    const close = Number(row?.close);
    return Number.isFinite(close) && close > 0 ? close : null;
};

const upsertHedgingExpiry = async (
    expiry: string,
    keepStrikes?: { atm: number; step: number; steps: number },
): Promise<{ inserted: number; skipped: number }> => {
    const chainRows = await db[MODEL.OPTIONS_CHAINS].findAll({
        where: { name: NIFTY_NAME, expiry },
    });
    let inserted = 0;
    let skipped = 0;
    for (const data of chainRows) {
        if (keepStrikes) {
            const strike = Number(data.strike_price);
            if (
                !Number.isFinite(strike) ||
                Math.abs(strike - keepStrikes.atm) >
                    keepStrikes.steps * keepStrikes.step
            ) {
                continue;
            }
        }
        const existing = await db[MODEL.HEDGING_OPTIONS].findOne({
            where: { instrument_key: data.instrument_key },
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        await db[MODEL.HEDGING_OPTIONS].create(hedgingFieldsFromChain(data));
        inserted += 1;
    }
    return { inserted, skipped };
};

export const syncNiftyHedgingOptions = async (): Promise<{
    expiry: string | null;
    tradeExpiry: string | null;
    subscribeExpiries: string[];
    isExpiryDay: boolean;
    inserted: number;
    skipped: number;
    deleted: number;
}> => {
    const plan = await getNiftyExpiryPlan();
    if (!plan.tradeExpiry || plan.subscribeExpiries.length === 0) {
        logger.warn('No upcoming Nifty expiry found in option_chain_details');
        return {
            expiry: null,
            tradeExpiry: null,
            subscribeExpiries: [],
            isExpiryDay: false,
            inserted: 0,
            skipped: 0,
            deleted: 0,
        };
    }

    const spot = await lastNiftySpot();
    const step = 50;
    const atm = spot != null ? Math.round(spot / step) * step : null;

    let inserted = 0;
    let skipped = 0;
    for (const expiry of plan.subscribeExpiries) {
        const isTrade = expiry === plan.tradeExpiry;
        const band =
            !isTrade && atm != null
                ? { atm, step, steps: NIFTY_WARMUP_STRIKE_STEPS }
                : undefined;
        const part = await upsertHedgingExpiry(expiry, band);
        inserted += part.inserted;
        skipped += part.skipped;
    }

    const openTrades = (await db[MODEL.TRADE].findAll({
        where: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            is_active: true,
        },
        attributes: ['instrument_key'],
        raw: true,
    })) as { instrument_key?: string }[];
    const keepKeys = openTrades
        .map((t) => t.instrument_key)
        .filter(Boolean) as string[];

    const extraWhere: Record<string, unknown>[] = [
        { expiry: { [Op.notIn]: plan.subscribeExpiries } },
        { expiry: { [Op.lt]: plan.today } },
    ];
    if (atm != null && plan.subscribeExpiries.length > 1) {
        const warmup = plan.subscribeExpiries.filter(
            (e) => e !== plan.tradeExpiry,
        );
        const maxDist = NIFTY_WARMUP_STRIKE_STEPS * step;
        extraWhere.push({
            expiry: { [Op.in]: warmup },
            strike_price: {
                [Op.or]: [
                    { [Op.lt]: atm - maxDist },
                    { [Op.gt]: atm + maxDist },
                ],
            },
        });
    }

    const purgeWhere: Record<string, unknown> = {
        name: NIFTY_NAME,
        [Op.or]: extraWhere,
    };
    if (keepKeys.length) {
        purgeWhere.instrument_key = { [Op.notIn]: keepKeys };
    }
    const deleted = await db[MODEL.HEDGING_OPTIONS].destroy({
        where: purgeWhere,
        force: true,
    });

    await logNiftyAudit({
        action: 'HEDGING_SYNC',
        reason: plan.isExpiryDay
            ? `Expiry day: trading ${plan.tradeExpiry} (not ${plan.nearestExpiry}). Feed also keeps ${plan.subscribeExpiries.join(', ')}`
            : `Hedging options synced for trade expiry ${plan.tradeExpiry} (feed ${plan.subscribeExpiries.join(', ')})`,
        metadata: {
            expiry: plan.tradeExpiry,
            tradeExpiry: plan.tradeExpiry,
            nearestExpiry: plan.nearestExpiry,
            subscribeExpiries: plan.subscribeExpiries,
            isExpiryDay: plan.isExpiryDay,
            inserted,
            skipped,
            deleted,
            warmupAtm: atm,
        },
        engineState: 'SYNC',
    });

    logger.info(
        `Nifty hedging sync trade=${plan.tradeExpiry} feed=[${plan.subscribeExpiries.join(',')}]: inserted=${inserted}, skipped=${skipped}, deletedHedging=${deleted}`,
    );

    await resubscribeNiftyMarketFeed();

    return {
        expiry: plan.tradeExpiry,
        tradeExpiry: plan.tradeExpiry,
        subscribeExpiries: plan.subscribeExpiries,
        isExpiryDay: plan.isExpiryDay,
        inserted,
        skipped,
        deleted,
    };
};

export const ensureNiftyStrategyRecords = async () => {
    await db[MODEL.STRATEGY].findOrCreate({
        where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
        defaults: {
            strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
            strategy_balance: 100000,
        },
    });

    // Keep legacy scalping strategy disabled while Nifty scalp is active
    await db[MODEL.STRATEGY_CONFIG].update(
        { is_active: false },
        { where: { strategy_name: STRATEGY.SCALLPING } },
    );
};
