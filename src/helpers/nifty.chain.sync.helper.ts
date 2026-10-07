import axios from 'axios';
import moment from 'moment';
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
import { get_upcoming_expiry_date } from './stock.helper';
import { logNiftyAudit } from './nifty.scalp.audit.helper';

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

export const syncNiftyHedgingOptions = async (): Promise<{
    expiry: string | null;
    inserted: number;
    skipped: number;
    deleted: number;
}> => {
    const expiry = await get_upcoming_expiry_date(NIFTY_NAME);
    if (!expiry) {
        logger.warn('No upcoming Nifty expiry found in option_chain_details');
        return { expiry: null, inserted: 0, skipped: 0, deleted: 0 };
    }

    const chainRows = await db[MODEL.OPTIONS_CHAINS].findAll({
        where: {
            name: NIFTY_NAME,
            expiry,
        },
    });

    let inserted = 0;
    let skipped = 0;

    for (const data of chainRows) {
        const existing = await db[MODEL.HEDGING_OPTIONS].findOne({
            where: { instrument_key: data.instrument_key },
        });
        if (existing) {
            skipped += 1;
            continue;
        }
        await db[MODEL.HEDGING_OPTIONS].create({
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
        inserted += 1;
    }

    // Only purge hedging_options_details (never option_chain / trade / position)
    const today = moment().startOf('day').format('YYYY-MM-DD');
    const deleted = await db[MODEL.HEDGING_OPTIONS].destroy({
        where: {
            name: NIFTY_NAME,
            [Op.or]: [
                { expiry: { [Op.ne]: expiry } },
                { expiry: { [Op.lt]: today } },
            ],
        },
        force: true,
    });

    await logNiftyAudit({
        action: 'HEDGING_SYNC',
        reason: `Hedging options synced for expiry ${expiry}`,
        metadata: { expiry, inserted, skipped, deleted },
        engineState: 'SYNC',
    });

    logger.info(
        `Nifty hedging sync expiry=${expiry}: inserted=${inserted}, skipped=${skipped}, deletedHedging=${deleted}`,
    );

    return { expiry, inserted, skipped, deleted };
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
