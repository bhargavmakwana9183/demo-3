import cron from 'node-cron';
import { logger } from '../logger/logger';
import {
    ensureNiftyStrategyRecords,
    syncNiftyHedgingOptions,
    syncNiftyOptionChain,
} from '../helpers/nifty.chain.sync.helper';

const runSafe = async (label: string, fn: () => Promise<unknown>) => {
    try {
        logger.info(`Nifty cron start: ${label}`);
        await fn();
        logger.info(`Nifty cron done: ${label}`);
    } catch (error: any) {
        logger.error(`Nifty cron failed (${label}): ${error?.message || error}`);
    }
};

// Nightly: refresh full Nifty option contracts into option_chain_details
cron.schedule(
    '57 23 * * *',
    async () => {
        await runSafe('option_chain_sync', async () => {
            await ensureNiftyStrategyRecords();
            await syncNiftyOptionChain();
        });
    },
    { timezone: 'Asia/Kolkata' },
);

// Morning: load current/upcoming expiry into hedging_options_details
cron.schedule(
    '30 8 * * 1-5',
    async () => {
        await runSafe('hedging_sync', async () => {
            await ensureNiftyStrategyRecords();
            await syncNiftyOptionChain();
            await syncNiftyHedgingOptions();
        });
    },
    { timezone: 'Asia/Kolkata' },
);

logger.info('Nifty chain/hedging crons registered');
