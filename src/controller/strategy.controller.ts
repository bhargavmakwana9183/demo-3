import { db } from '../model';
import dotenv from 'dotenv';
dotenv.config();
import {
    ERRORTYPES,
    INDEXES_NAMES,
    INSTRUMENT_KEYS,
    MODEL,
    RES_STATUS,
    STRATEGY,
    USER_DETAILS,
} from '../constant';
import { AppError } from '../utils';
import {
    findHedgingOptions,
    find_CE,
    find_CE_SELL,
    find_PE,
    find_PE_SELL,
    find_sbin_stocks,
    getCurrentISTDate,
    getISTTime,
    get_current_day_name,
    get_upcoming_expiry_date,
    place_order_on_upstocks,
} from '../helpers';
import { scalpingEngine } from '../services/scalping.engine';
import { niftyScalpEngine } from '../services/nifty.scalp.engine';
import { runScalpingBacktest } from '../helpers/scalping.backtest.helper';
import { getAuditSkipBreakdown } from '../helpers/scalping.audit.helper';
import { getScalpingPerformance } from '../helpers/scalping.performance.helper';
import { runScalpingOptimization } from '../helpers/scalping.optimize.helper';
import {
    getScalpingSystemStatus,
} from '../helpers/scalping.market.quality.helper';
import { getStrategyConfig } from '../helpers/scalping.risk.helper';
import { getNiftyScalpConfig } from '../helpers/nifty.scalp.config.helper';
import { getNiftyAuditLogs } from '../helpers/nifty.scalp.audit.helper';
import {
    ensureNiftyStrategyRecords,
    syncNiftyHedgingOptions,
    syncNiftyOptionChain,
} from '../helpers/nifty.chain.sync.helper';
import { logger } from '../logger/logger';
import { Op } from 'sequelize';
import moment from 'moment';
import { RSI } from 'technicalindicators';
const { EMA } = require('technicalindicators');

class StrategyController {
    async percentage_strategy() {
        try {
            // console.log('Percentage strategy calling');
            const currentISTDate = getCurrentISTDate();
            const formattedDate = currentISTDate.toISOString().slice(0, 10);
            const currentTime = getISTTime(currentISTDate);
            const startTime = new Date(`${formattedDate}T09:30:00+05:30`);
            const endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const currnet_day = get_current_day_name();
            const hedging_conditions = await db[MODEL.HEDGING_TIME].findOne({
                where: {
                    index_name: INDEXES_NAMES.MIDCAP,
                    day: currnet_day,
                },
            });
            if (currentISTDate >= startTime && currentISTDate <= endTime) {
                const find_strategy = await db[MODEL.POSITION].findOne({
                    where: {
                        strategy_name: STRATEGY.PERCENTAGE,
                        is_active: true,
                    },
                });
                if (find_strategy) {
                    // console.time('postion check');
                    const find_trade = await db[MODEL.TRADE].findAll({
                        where: {
                            strategy_name: STRATEGY.PERCENTAGE,
                            is_active: true,
                        },
                    });

                    let CE_SELL_PL = 0;
                    let PE_SELL_PL = 0;
                    let CE_PL = 0;
                    let PE_PL = 0;
                    let MARGIN = 0;
                    await Promise.all(
                        find_trade.map(async (trade) => {
                            if (trade.trade_type === 'SELL') {
                                if (trade.instrument_type === 'CE') {
                                    const diff = trade.buy_price - trade.ltp;
                                    const lot = trade.lot_size * trade.qty;
                                    CE_SELL_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: CE_SELL_PL },
                                        { where: { id: trade.id } },
                                    );
                                } else {
                                    const diff = trade.buy_price - trade.ltp;
                                    const lot = trade.lot_size * trade.qty;
                                    PE_SELL_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: PE_SELL_PL },
                                        { where: { id: trade.id } },
                                    );
                                }
                            } else {
                                if (trade.instrument_type === 'CE') {
                                    const diff = trade.ltp - trade.buy_price;
                                    const lot = trade.lot_size * trade.qty;
                                    CE_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: CE_PL },
                                        { where: { id: trade.id } },
                                    );
                                } else {
                                    const diff = trade.ltp - trade.buy_price;
                                    const lot = trade.lot_size * trade.qty;
                                    PE_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: PE_PL },
                                        { where: { id: trade.id } },
                                    );
                                }
                            }
                        }),
                    );
                    const tradesToClose = find_trade.filter(
                        (trade) =>
                            trade.trade_type === 'SELL' &&
                            trade.ltp >= trade.stop_loss,
                    );
                    const PL = CE_SELL_PL + PE_SELL_PL + CE_PL + PE_PL;
                    if (tradesToClose.length > 0) {
                        console.log('Close trades triggered.');
                        find_trade.map(async (trade) => {
                            await db[MODEL.TRADE].update(
                                {
                                    is_active: false,
                                    sell_price: trade.ltp,
                                },
                                {
                                    where: { id: trade.id },
                                },
                            );
                        });

                        await db[MODEL.POSITION].update(
                            { is_active: false, end_time: moment() },
                            { where: { id: find_strategy.id } },
                        );

                        const current_bal = await db[MODEL.STRATEGY].findOne({
                            where: {
                                strategy_name: STRATEGY.PERCENTAGE,
                            },
                        });
                        await db[MODEL.STRATEGY].update(
                            {
                                strategy_balance:
                                    current_bal?.strategy_balance +
                                    PL +
                                    hedging_conditions?.required_margin * 2,
                            },
                            {
                                where: {
                                    strategy_name: STRATEGY.PERCENTAGE,
                                },
                            },
                        );
                    }
                    const target = (find_strategy.required_margin * 1) / 100;
                    if (PL > target) {
                        console.log(
                            'Congratulations! target has been successfully achieved. A profit of 1% has been booked on this trade.',
                        );
                        find_trade.map(async (trade) => {
                            await db[MODEL.TRADE].update(
                                {
                                    is_active: false,
                                    sell_price: trade.ltp,
                                },
                                {
                                    where: { id: trade.id },
                                },
                            );
                        });
                        await db[MODEL.POSITION].update(
                            { is_active: false, end_time: moment() },
                            { where: { id: find_strategy.id } },
                        );
                        const current_bal = await db[MODEL.STRATEGY].findOne({
                            where: {
                                strategy_name: STRATEGY.PERCENTAGE,
                            },
                        });
                        await db[MODEL.STRATEGY].update(
                            {
                                strategy_balance:
                                    current_bal?.strategy_balance +
                                    PL +
                                    hedging_conditions?.required_margin * 2,
                            },
                            {
                                where: {
                                    strategy_name: STRATEGY.PERCENTAGE,
                                },
                            },
                        );
                    }
                    await db[MODEL.POSITION].update(
                        { pl: PL },
                        { where: { id: find_strategy.id } },
                    );
                    // console.timeEnd('postion check');
                } else {
                    // console.time('trade_created');
                    const currnet_day = get_current_day_name();
                    // console.log(currnet_day);

                    const expirey = await get_upcoming_expiry_date(
                        INDEXES_NAMES.MIDCAP,
                    );
                    const exclude_days = ['SUNDAY', 'SATURDAY'];
                    const strike = await db[MODEL.STRIKE_MODEL].findAll({});
                    const totalStrikePrice = strike.reduce(
                        (sum, strike) => sum + strike.ltp,
                        0,
                    );
                    // console.log('primuem_price  ' + totalStrikePrice);
                    if (!exclude_days.includes(currnet_day)) {
                        const hedging_conditions = await db[
                            MODEL.HEDGING_TIME
                        ].findOne({
                            where: {
                                index_name: INDEXES_NAMES.MIDCAP,
                                day: currnet_day,
                            },
                        });
                        if (
                            totalStrikePrice >
                            hedging_conditions?.market_premium
                        ) {
                            const { CE_SELL, PE_SELL, PE, CE } =
                                await findHedgingOptions({
                                    hedging_conditions,
                                    expirey,
                                });
                            if (CE_SELL && PE_SELL && CE && PE) {
                                const create_postions = await db[
                                    MODEL.POSITION
                                ].create({
                                    strategy_id:
                                        'f3254597-f223-45ff-a60f-37322425895d',
                                    strategy_name: STRATEGY.PERCENTAGE,
                                    is_active: true,
                                    qty: 4,
                                    trade_id: Math.floor(
                                        100000 + Math.random() * 900000,
                                    ),
                                    date: formattedDate,
                                    start_time: currentISTDate,
                                    required_margin:
                                        hedging_conditions?.required_margin * 2,
                                });
                                const ce_sell = await db[MODEL.TRADE].create({
                                    position_id: create_postions.id,
                                    options_chain_id: CE_SELL.options_chain_id,
                                    trade_id: create_postions.trade_id,
                                    strategy_name: STRATEGY.PERCENTAGE,
                                    trading_symbol: CE_SELL.trading_symbol,
                                    instrument_key: CE_SELL.instrument_key,
                                    instrument_type: CE_SELL.instrument_type,
                                    trade_type: 'SELL',
                                    buy_price: CE_SELL.ltp,
                                    stop_loss: CE_SELL.ltp * 2,
                                    is_active: true,
                                    ltp: CE_SELL.ltp,
                                    qty: 4,
                                    lot_size: CE_SELL.lot_size,
                                });
                                const pe_sell = await db[MODEL.TRADE].create({
                                    position_id: create_postions.id,
                                    options_chain_id: PE_SELL.options_chain_id,
                                    trade_id: create_postions.trade_id,
                                    strategy_name: STRATEGY.PERCENTAGE,
                                    trading_symbol: PE_SELL.trading_symbol,
                                    instrument_key: PE_SELL.instrument_key,
                                    instrument_type: PE_SELL.instrument_type,
                                    trade_type: 'SELL',
                                    buy_price: PE_SELL.ltp,
                                    stop_loss: PE_SELL.ltp * 2,
                                    is_active: true,
                                    ltp: PE_SELL.ltp,
                                    qty: 4,
                                    lot_size: PE_SELL.lot_size,
                                });
                                const ce = await db[MODEL.TRADE].create({
                                    position_id: create_postions.id,
                                    options_chain_id: CE.options_chain_id,
                                    trade_id: create_postions.trade_id,
                                    strategy_name: STRATEGY.PERCENTAGE,
                                    trading_symbol: CE.trading_symbol,
                                    instrument_key: CE.instrument_key,
                                    instrument_type: CE.instrument_type,
                                    trade_type: 'BUY',
                                    buy_price: CE.ltp,
                                    stop_loss: 0,
                                    is_active: true,
                                    ltp: CE.ltp,
                                    qty: 4,
                                    lot_size: CE.lot_size,
                                });
                                const pe = await db[MODEL.TRADE].create({
                                    position_id: create_postions.id,
                                    options_chain_id: PE.options_chain_id,
                                    trade_id: create_postions.trade_id,
                                    strategy_name: STRATEGY.PERCENTAGE,
                                    trading_symbol: PE.trading_symbol,
                                    instrument_key: PE.instrument_key,
                                    instrument_type: PE.instrument_type,
                                    trade_type: 'BUY',
                                    buy_price: PE.ltp,
                                    stop_loss: 0,
                                    is_active: true,
                                    ltp: PE.ltp,
                                    qty: 4,
                                    lot_size: PE.lot_size,
                                });

                                if (ce_sell && pe_sell && ce && pe) {
                                    const current_bal = await db[
                                        MODEL.STRATEGY
                                    ].findOne({
                                        where: {
                                            strategy_name: STRATEGY.PERCENTAGE,
                                        },
                                    });
                                    await db[MODEL.STRATEGY].update(
                                        {
                                            strategy_balance:
                                                current_bal?.strategy_balance -
                                                hedging_conditions?.required_margin *
                                                    2,
                                        },
                                        {
                                            where: {
                                                strategy_name:
                                                    STRATEGY.PERCENTAGE,
                                            },
                                        },
                                    );
                                    logger.info('Trade Placed successfully');
                                } else {
                                    await db[MODEL.TRADE].update(
                                        { is_active: false },
                                        { where: { id: ce?.id } },
                                    );
                                    await db[MODEL.TRADE].update(
                                        { is_active: false },
                                        { where: { id: pe?.id } },
                                    );
                                    await db[MODEL.TRADE].update(
                                        { is_active: false },
                                        { where: { id: ce_sell?.id } },
                                    );
                                    await db[MODEL.TRADE].update(
                                        { is_active: false },
                                        { where: { id: pe_sell?.id } },
                                    );
                                    await db[MODEL.POSITION].update(
                                        { is_active: false },
                                        { where: { id: create_postions?.id } },
                                    );
                                    logger.error('Trade Placement failed');
                                }
                                // console.timeEnd('trade_created');
                            } else {
                                logger.info(
                                    'ce pe ce_sell pe_sell not found anyone',
                                );
                            }
                        } else {
                            // logger.info('priminum price is not matching');
                        }
                    } else {
                        logger.info('Today is holiday');
                    }
                }
            } else {
                // logger.error('Market Time is closed');
            }
        } catch (error) {
            logger.error(error.message);
        }
    }

    async percentage_without_contions_strategy() {
        try {
            // console.log('Percentage without condtoins strategy calling');
            const currentISTDate = getCurrentISTDate();
            const formattedDate = currentISTDate.toISOString().slice(0, 10);
            const currentTime = getISTTime(currentISTDate);
            const startTime = new Date(`${formattedDate}T09:30:00+05:30`);
            const endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const currnet_day = get_current_day_name();
            const hedging_conditions = await db[MODEL.HEDGING_TIME].findOne({
                where: {
                    index_name: INDEXES_NAMES.MIDCAP,
                    day: currnet_day,
                },
            });
            if (currentISTDate >= startTime && currentISTDate <= endTime) {
                const find_strategy = await db[MODEL.POSITION].findOne({
                    where: {
                        strategy_name: STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                        is_active: true,
                    },
                });
                if (find_strategy) {
                    // console.time('postion check');
                    const find_trade = await db[MODEL.TRADE].findAll({
                        where: {
                            strategy_name:
                                STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                            is_active: true,
                        },
                    });

                    let CE_SELL_PL = 0;
                    let PE_SELL_PL = 0;
                    let CE_PL = 0;
                    let PE_PL = 0;
                    let MARGIN = 0;
                    await Promise.all(
                        find_trade.map(async (trade) => {
                            if (trade.trade_type === 'SELL') {
                                if (trade.instrument_type === 'CE') {
                                    const diff = trade.buy_price - trade.ltp;
                                    const lot = trade.lot_size * trade.qty;
                                    CE_SELL_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: CE_SELL_PL },
                                        { where: { id: trade.id } },
                                    );
                                } else {
                                    const diff = trade.buy_price - trade.ltp;
                                    const lot = trade.lot_size * trade.qty;
                                    PE_SELL_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: PE_SELL_PL },
                                        { where: { id: trade.id } },
                                    );
                                }
                            } else {
                                if (trade.instrument_type === 'CE') {
                                    const diff = trade.ltp - trade.buy_price;
                                    const lot = trade.lot_size * trade.qty;
                                    CE_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: CE_PL },
                                        { where: { id: trade.id } },
                                    );
                                } else {
                                    const diff = trade.ltp - trade.buy_price;
                                    const lot = trade.lot_size * trade.qty;
                                    PE_PL = diff * lot;
                                    await db[MODEL.TRADE].update(
                                        { pl: PE_PL },
                                        { where: { id: trade.id } },
                                    );
                                }
                            }
                        }),
                    );
                    const tradesToClose = find_trade.filter(
                        (trade) =>
                            trade.trade_type === 'SELL' &&
                            trade.ltp >= trade.stop_loss,
                    );
                    const PL = CE_SELL_PL + PE_SELL_PL + CE_PL + PE_PL;
                    if (tradesToClose.length) {
                        console.log(
                            'Close trades triggered. without contionds',
                        );
                        find_trade.map(async (trade) => {
                            await db[MODEL.TRADE].update(
                                {
                                    is_active: false,
                                    sell_price: trade.ltp,
                                },
                                {
                                    where: { id: trade.id },
                                },
                            );
                        });

                        await db[MODEL.POSITION].update(
                            { is_active: false, end_time: moment() },
                            { where: { id: find_strategy.id } },
                        );

                        const current_bal = await db[MODEL.STRATEGY].findOne({
                            where: {
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                            },
                        });
                        await db[MODEL.STRATEGY].update(
                            {
                                strategy_balance:
                                    current_bal?.strategy_balance +
                                    PL +
                                    hedging_conditions?.required_margin * 2,
                            },
                            {
                                where: {
                                    strategy_name:
                                        STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                },
                            },
                        );
                    }
                    const target = (find_strategy.required_margin * 1) / 100;
                    if (PL > target) {
                        console.log(
                            'Congratulations! target has been successfully achieved. A profit of 1% has been booked on this trade.',
                        );
                        find_trade.map(async (trade) => {
                            await db[MODEL.TRADE].update(
                                {
                                    is_active: false,
                                    sell_price: trade.ltp,
                                },
                                {
                                    where: { id: trade.id },
                                },
                            );
                        });
                        await db[MODEL.POSITION].update(
                            { is_active: false, end_time: moment() },
                            { where: { id: find_strategy.id } },
                        );
                        const current_bal = await db[MODEL.STRATEGY].findOne({
                            where: {
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                            },
                        });
                        await db[MODEL.STRATEGY].update(
                            {
                                strategy_balance:
                                    current_bal?.strategy_balance +
                                    PL +
                                    hedging_conditions?.required_margin * 2,
                            },
                            {
                                where: {
                                    strategy_name:
                                        STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                },
                            },
                        );
                    }
                    await db[MODEL.POSITION].update(
                        { pl: PL },
                        { where: { id: find_strategy.id } },
                    );
                    // console.timeEnd('postion check');
                } else {
                    // console.time('trade_created');
                    const currnet_day = get_current_day_name();
                    // console.log(currnet_day);

                    const expirey = await get_upcoming_expiry_date(
                        INDEXES_NAMES.MIDCAP,
                    );
                    const exclude_days = ['SUNDAY', 'SATURDAY'];
                    const strike = await db[MODEL.STRIKE_MODEL].findAll({});
                    const totalStrikePrice = strike.reduce(
                        (sum, strike) => sum + strike.ltp,
                        0,
                    );
                    console.log('primuem_price  ' + totalStrikePrice);
                    if (!exclude_days.includes(currnet_day)) {
                        const hedging_conditions = await db[
                            MODEL.HEDGING_TIME
                        ].findOne({
                            where: {
                                index_name: INDEXES_NAMES.MIDCAP,
                                day: currnet_day,
                            },
                        });
                        const { CE_SELL, PE_SELL, PE, CE } =
                            await findHedgingOptions({
                                hedging_conditions,
                                expirey,
                            });

                        if (CE_SELL && PE_SELL && CE && PE) {
                            const create_postions = await db[
                                MODEL.POSITION
                            ].create({
                                strategy_id:
                                    '550de29a-44a8-4a2a-a356-e2132bbfdb8f',
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                is_active: true,
                                qty: 4,
                                trade_id: Math.floor(
                                    100000 + Math.random() * 900000,
                                ),
                                date: formattedDate,
                                start_time: currentISTDate,
                                required_margin:
                                    hedging_conditions?.required_margin * 2,
                            });
                            const ce_sell = await db[MODEL.TRADE].create({
                                position_id: create_postions.id,
                                options_chain_id: CE_SELL.options_chain_id,
                                trade_id: create_postions.trade_id,
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                trading_symbol: CE_SELL.trading_symbol,
                                instrument_key: CE_SELL.instrument_key,
                                instrument_type: CE_SELL.instrument_type,
                                trade_type: 'SELL',
                                buy_price: CE_SELL.ltp,
                                stop_loss: CE_SELL.ltp * 2,
                                is_active: true,
                                ltp: CE_SELL.ltp,
                                qty: 4,
                                lot_size: CE_SELL.lot_size,
                            });
                            const pe_sell = await db[MODEL.TRADE].create({
                                position_id: create_postions.id,
                                options_chain_id: PE_SELL.options_chain_id,
                                trade_id: create_postions.trade_id,
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                trading_symbol: PE_SELL.trading_symbol,
                                instrument_key: PE_SELL.instrument_key,
                                instrument_type: PE_SELL.instrument_type,
                                trade_type: 'SELL',
                                buy_price: PE_SELL.ltp,
                                stop_loss: PE_SELL.ltp * 2,
                                is_active: true,
                                ltp: PE_SELL.ltp,
                                qty: 4,
                                lot_size: PE_SELL.lot_size,
                            });
                            const ce = await db[MODEL.TRADE].create({
                                position_id: create_postions.id,
                                options_chain_id: CE.options_chain_id,
                                trade_id: create_postions.trade_id,
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                trading_symbol: CE.trading_symbol,
                                instrument_key: CE.instrument_key,
                                instrument_type: CE.instrument_type,
                                trade_type: 'BUY',
                                buy_price: CE.ltp,
                                stop_loss: 0,
                                is_active: true,
                                ltp: CE.ltp,
                                qty: 4,
                                lot_size: CE.lot_size,
                            });
                            const pe = await db[MODEL.TRADE].create({
                                position_id: create_postions.id,
                                options_chain_id: PE.options_chain_id,
                                trade_id: create_postions.trade_id,
                                strategy_name:
                                    STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                trading_symbol: PE.trading_symbol,
                                instrument_key: PE.instrument_key,
                                instrument_type: PE.instrument_type,
                                trade_type: 'BUY',
                                buy_price: PE.ltp,
                                stop_loss: 0,
                                is_active: true,
                                ltp: PE.ltp,
                                qty: 4,
                                lot_size: PE.lot_size,
                            });

                            if (ce_sell && pe_sell && ce && pe) {
                                const current_bal = await db[
                                    MODEL.STRATEGY
                                ].findOne({
                                    where: {
                                        strategy_name:
                                            STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                    },
                                });
                                await db[MODEL.STRATEGY].update(
                                    {
                                        strategy_balance:
                                            current_bal?.strategy_balance -
                                            hedging_conditions?.required_margin *
                                                2,
                                    },
                                    {
                                        where: {
                                            strategy_name:
                                                STRATEGY.PERCENTAGE_WITHOUT_CONDITIONS,
                                        },
                                    },
                                );
                                logger.info('Trade Placed successfully');
                            } else {
                                await db[MODEL.TRADE].update(
                                    { is_active: false },
                                    { where: { id: ce?.id } },
                                );
                                await db[MODEL.TRADE].update(
                                    { is_active: false },
                                    { where: { id: pe?.id } },
                                );
                                await db[MODEL.TRADE].update(
                                    { is_active: false },
                                    { where: { id: ce_sell?.id } },
                                );
                                await db[MODEL.TRADE].update(
                                    { is_active: false },
                                    { where: { id: pe_sell?.id } },
                                );
                                await db[MODEL.POSITION].update(
                                    { is_active: false },
                                    { where: { id: create_postions?.id } },
                                );
                                logger.error('Trade Placement failed');
                            }
                            // console.timeEnd('trade_created');
                        } else {
                            logger.info(
                                'ce pe ce_sell pe_sell not found anyone',
                            );
                        }
                    } else {
                        logger.info('Today is holiday');
                    }
                }
            } else {
                // logger.error('Market Time is closed');
            }
        } catch (error) {
            logger.error(error.message);
        }
    }

    async sbin_timing_strategy() {
        try {
            // console.log('SBIN strategy calling');
            const currentISTDate = getCurrentISTDate();
            const formattedDate = currentISTDate.toISOString().slice(0, 10);
            const currentTime = getISTTime(currentISTDate);
            const startTime = new Date(`${formattedDate}T09:30:00+05:30`);
            const trade_startTime = new Date(`${formattedDate}T10:30:00+05:30`);
            const endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const trade_endTime = new Date(`${formattedDate}T14:19:00+05:30`);
            const currnet_day = get_current_day_name();
            if (currentISTDate >= startTime && currentISTDate <= endTime) {
                const find_strategy = await db[MODEL.POSITION].findOne({
                    where: {
                        strategy_name: STRATEGY.SBIN_TIMING,
                        is_active: true,
                    },
                });
                // console.log(find_strategy);

                if (find_strategy) {
                    console.log('postion check');
                    const find_trade = await db[MODEL.TRADE].findOne({
                        where: {
                            strategy_name: STRATEGY.SBIN_TIMING,
                            is_active: true,
                        },
                    });
                    let trade_pl = 0;
                    const diff = find_trade.ltp - find_trade.buy_price;
                    const lot = find_trade.lot_size * find_trade.qty;
                    trade_pl = diff * lot;
                    await db[MODEL.POSITION].update(
                        { pl: trade_pl },
                        { where: { id: find_strategy.id } },
                    );
                    await db[MODEL.TRADE].update(
                        {
                            pl: trade_pl,
                        },
                        {
                            where: { id: find_trade.id },
                        },
                    );
                    if (trade_endTime <= currentISTDate) {
                        const trade_closed = await db[MODEL.TRADE].update(
                            {
                                is_active: false,
                                sell_price: find_trade.ltp,
                                pl: trade_pl,
                            },
                            {
                                where: { id: find_trade.id },
                            },
                        );

                        if (trade_closed) {
                            const position_closed = await db[
                                MODEL.POSITION
                            ].update(
                                {
                                    is_active: false,
                                    pl: trade_pl,
                                    end_time: moment(),
                                },
                                { where: { id: find_strategy.id } },
                            );
                            console.log('Trade Closed Successfully');
                            const current_bal = await db[
                                MODEL.STRATEGY
                            ].findOne({
                                where: {
                                    strategy_name: STRATEGY.SBIN_TIMING,
                                },
                            });
                            await db[MODEL.STRATEGY].update(
                                {
                                    strategy_balance:
                                        current_bal?.strategy_balance +
                                        trade_pl,
                                },
                                {
                                    where: {
                                        strategy_name: STRATEGY.SBIN_TIMING,
                                    },
                                },
                            );
                        }
                        console.log('endd');
                    }
                } else {
                    const currnet_day = get_current_day_name();
                    const exclude_days = ['SUNDAY', 'SATURDAY'];
                    if (!exclude_days.includes(currnet_day)) {
                        if (
                            currentISTDate >= trade_startTime &&
                            currentISTDate <= trade_endTime
                        ) {
                            const get_current_stock_price = await db[
                                MODEL.INSTRUMENT
                            ].findOne({
                                where: {
                                    instrument_key:
                                        INSTRUMENT_KEYS.SBIN_INSTRUMENT,
                                },
                            });
                            const ltp = get_current_stock_price.last_price;
                            const percentage_change =
                                get_current_stock_price.lot_size;
                            const stcoks = await find_sbin_stocks(
                                ltp,
                                percentage_change,
                            );

                            if (stcoks) {
                                const create_postions = await db[
                                    MODEL.POSITION
                                ].create({
                                    strategy_id:
                                        '24d70d09-7967-495c-9a8d-3c3db1157110',
                                    strategy_name: STRATEGY.SBIN_TIMING,
                                    is_active: true,
                                    qty: 1,
                                    trade_id: Math.floor(
                                        100000 + Math.random() * 900000,
                                    ),
                                    date: formattedDate,
                                    start_time: currentISTDate,
                                    required_margin: Number(stcoks.ltp) * 750,
                                });

                                if (create_postions) {
                                    const trade_placed = await db[
                                        MODEL.TRADE
                                    ].create({
                                        position_id: create_postions.id,
                                        options_chain_id: stcoks.id,
                                        trade_id: create_postions.trade_id,
                                        strategy_name: STRATEGY.SBIN_TIMING,
                                        trading_symbol: stcoks.trading_symbol,
                                        instrument_key: stcoks.instrument_key,
                                        instrument_type: stcoks.instrument_type,
                                        trade_type: 'BUY',
                                        buy_price: stcoks.ltp,
                                        stop_loss: stcoks.lot_size * 2,
                                        is_active: true,
                                        ltp: stcoks.ltp,
                                        qty: 1,
                                        lot_size: stcoks.lot_size,
                                    });
                                    if (trade_placed) {
                                        logger.info(
                                            'Trade Placed Successfully',
                                        );
                                    }
                                }
                            } else {
                                logger.info('Stock Not Found');
                            }
                        }
                    } else {
                        logger.info('Today is holiday');
                    }
                }
            } else {
                logger.error('Market Time is closed');
            }
        } catch (error) {
            logger.error(error.message);
        }
    }
    async scallping_strategy() {
        try {
            // console.log('SBIN strategy calling');
            const currentISTDate = getCurrentISTDate();
            const formattedDate = currentISTDate.toISOString().slice(0, 10);
            const currentTime = getISTTime(currentISTDate);
            const startTime = new Date(`${formattedDate}T09:30:00+05:30`);
            const trade_startTime = new Date(`${formattedDate}T10:30:00+05:30`);
            const endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const trade_endTime = new Date(`${formattedDate}T14:19:00+05:30`);
            const currnet_day = get_current_day_name();
            // if (currentISTDate >= startTime && currentISTDate <= endTime) {
            //     const find_strategy = await db[MODEL.POSITION].findOne({
            //         where: {
            //             strategy_name: STRATEGY.SBIN_TIMING,
            //             is_active: true,
            //         },
            //     });
            //     // console.log(find_strategy);

            //     if (find_strategy) {
            //         console.log('postion check');
            //         const find_trade = await db[MODEL.TRADE].findOne({
            //             where: {
            //                 strategy_name: STRATEGY.SBIN_TIMING,
            //                 is_active: true,
            //             },
            //         });
            //         let trade_pl = 0;
            //         const diff = find_trade.ltp - find_trade.buy_price;
            //         const lot = find_trade.lot_size * find_trade.qty;
            //         trade_pl = diff * lot;
            //         await db[MODEL.POSITION].update(
            //             { pl: trade_pl },
            //             { where: { id: find_strategy.id } },
            //         );
            //         await db[MODEL.TRADE].update(
            //             {
            //                 pl: trade_pl,
            //             },
            //             {
            //                 where: { id: find_trade.id },
            //             },
            //         );
            //         if (trade_endTime <= currentISTDate) {
            //             const trade_closed = await db[MODEL.TRADE].update(
            //                 {
            //                     is_active: false,
            //                     sell_price: find_trade.ltp,
            //                     pl: trade_pl,
            //                 },
            //                 {
            //                     where: { id: find_trade.id },
            //                 },
            //             );

            //             if (trade_closed) {
            //                 const position_closed = await db[
            //                     MODEL.POSITION
            //                 ].update(
            //                     {
            //                         is_active: false,
            //                         pl: trade_pl,
            //                         end_time: moment(),
            //                     },
            //                     { where: { id: find_strategy.id } },
            //                 );
            //                 console.log('Trade Closed Successfully');
            //                 const current_bal = await db[
            //                     MODEL.STRATEGY
            //                 ].findOne({
            //                     where: {
            //                         strategy_name: STRATEGY.SBIN_TIMING,
            //                     },
            //                 });
            //                 await db[MODEL.STRATEGY].update(
            //                     {
            //                         strategy_balance:
            //                             current_bal?.strategy_balance +
            //                             trade_pl,
            //                     },
            //                     {
            //                         where: {
            //                             strategy_name: STRATEGY.SBIN_TIMING,
            //                         },
            //                     },
            //                 );
            //             }
            //             console.log('endd');
            //         }
            //     } else {
            //         const currnet_day = get_current_day_name();
            //         const exclude_days = ['SUNDAY', 'SATURDAY'];
            //         if (!exclude_days.includes(currnet_day)) {
            //             if (
            //                 currentISTDate >= trade_startTime &&
            //                 currentISTDate <= trade_endTime
            //             ) {
            //                 const get_current_stock_price = await db[
            //                     MODEL.INSTRUMENT
            //                 ].findOne({
            //                     where: {
            //                         instrument_key:
            //                             INSTRUMENT_KEYS.SBIN_INSTRUMENT,
            //                     },
            //                 });
            //                 const ltp = get_current_stock_price.last_price;
            //                 const percentage_change =
            //                     get_current_stock_price.lot_size;
            //                 const stcoks = await find_sbin_stocks(
            //                     ltp,
            //                     percentage_change,
            //                 );

            //                 if (stcoks) {
            //                     const create_postions = await db[
            //                         MODEL.POSITION
            //                     ].create({
            //                         strategy_id:
            //                             '24d70d09-7967-495c-9a8d-3c3db1157110',
            //                         strategy_name: STRATEGY.SBIN_TIMING,
            //                         is_active: true,
            //                         qty: 1,
            //                         trade_id: Math.floor(
            //                             100000 + Math.random() * 900000,
            //                         ),
            //                         date: formattedDate,
            //                         start_time: currentISTDate,
            //                         required_margin: Number(stcoks.ltp) * 750,
            //                     });

            //                     if (create_postions) {
            //                         const trade_placed = await db[
            //                             MODEL.TRADE
            //                         ].create({
            //                             position_id: create_postions.id,
            //                             options_chain_id: stcoks.id,
            //                             trade_id: create_postions.trade_id,
            //                             strategy_name: STRATEGY.SBIN_TIMING,
            //                             trading_symbol: stcoks.trading_symbol,
            //                             instrument_key: stcoks.instrument_key,
            //                             instrument_type: stcoks.instrument_type,
            //                             trade_type: 'BUY',
            //                             buy_price: stcoks.ltp,
            //                             stop_loss: stcoks.lot_size * 2,
            //                             is_active: true,
            //                             ltp: stcoks.ltp,
            //                             qty: 1,
            //                             lot_size: stcoks.lot_size,
            //                         });
            //                         if (trade_placed) {
            //                             logger.info(
            //                                 'Trade Placed Successfully',
            //                             );
            //                         }
            //                     }
            //                 } else {
            //                     logger.info('Stock Not Found');
            //                 }
            //             }
            //         } else {
            //             logger.info('Today is holiday');
            //         }
            //     }
            // } else {
            //     logger.error('Market Time is closed');
            // }

            let find_candels = await db[MODEL.CANDELS].findAll({
                where: {
                    instrument_key: 'NSE_FO|57735',
                },
                order: [['ts', 'DESC']],
                limit: 100,
            });

            if (find_candels.length < 22) {
                logger.info('Candel Not Found');
            } else {
                console.log('candes');
                const closes = find_candels
                    .map((c) => Number(c.close))
                    .reverse();
                const ema9 = EMA.calculate({ period: 9, values: closes });
                const ema21 = EMA.calculate({ period: 21, values: closes });
                const lastEMA9 = ema9[ema9.length - 1];
                const prevEMA9 = ema9[ema9.length - 2];
                const lastEMA21 = ema21[ema21.length - 1];
                const prevEMA21 = ema21[ema21.length - 2];
                //BUY Signal
                if (lastEMA9 > lastEMA21 && prevEMA9 <= prevEMA21) {
                    console.log('BUY Signal');
                }
                if (lastEMA9 < lastEMA21 && prevEMA9 >= prevEMA21) {
                    console.log('SELL Signal');
                }
            }

            return find_candels;
        } catch (error) {
            logger.error(error.message);
        }
    }
    async scallping_strategy_new() {
        try {
            // LEGACY SBIN/scalping engine disabled — Nifty Options Scalp is active in app.ts
            // await scalpingEngine.run();
            return;
        } catch (error) {
            logger.error(error.message);
        }
    }

    async nifty_options_scalp_run() {
        try {
            return await niftyScalpEngine.run();
        } catch (error) {
            logger.error(error.message);
        }
    }

    async sync_nifty_option_chain(req, res, next) {
        try {
            await ensureNiftyStrategyRecords();
            const result = await syncNiftyOptionChain();
            return res.status(200).json({
                status: RES_STATUS.CREATE,
                data: result,
                message: 'Nifty option_chain_details synced',
            });
        } catch (error) {
            return next(error);
        }
    }

    async sync_nifty_hedging_options(req, res, next) {
        try {
            await ensureNiftyStrategyRecords();
            const chain = await syncNiftyOptionChain();
            const hedging = await syncNiftyHedgingOptions();
            return res.status(200).json({
                status: RES_STATUS.CREATE,
                data: { chain, hedging },
                message: 'Nifty hedging_options_details synced',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_nifty_scalp_status(req, res, next) {
        try {
            const status = await niftyScalpEngine.getStatus();
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });
            return res.status(200).json({
                status: RES_STATUS.GET,
                data: {
                    ...status,
                    isLive: Boolean(user?.is_live),
                },
                message: 'Nifty scalp status fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_nifty_scalp_audit(req, res, next) {
        try {
            const days = Number(req.query?.days ?? 7);
            const action = req.query?.action as string | undefined;
            const limit = Math.min(Number(req.query?.limit ?? 100), 500);
            const logs = await getNiftyAuditLogs({ days, action, limit });
            return res.status(200).json({
                status: RES_STATUS.GET,
                data: { logs },
                message: 'Nifty scalp audit logs fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_nifty_scalp_config(req, res, next) {
        try {
            const config = await getNiftyScalpConfig();
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });
            return res.status(200).json({
                status: RES_STATUS.GET,
                data: {
                    config,
                    isLive: Boolean(user?.is_live),
                },
                message: 'Nifty scalp config fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async update_nifty_scalp_config(req, res, next) {
        try {
            const body = req.body ?? {};
            const allowedModes = ['paper', 'live', 'backtest'];
            if (body.mode && !allowedModes.includes(body.mode)) {
                throw new AppError(
                    `mode must be one of: ${allowedModes.join(', ')}`,
                    ERRORTYPES.VALIDATION_ERROR,
                );
            }

            const updates: Record<string, unknown> = {};
            const fields = [
                'mode',
                'is_active',
                'paper_balance',
                'target_profit_rs',
                'add_lot_points',
                'enable_plan_b',
                'enable_overnight_carry',
                'plan_b_min_lots',
                'plan_b_bounce_points',
                'brokerage_per_lot',
                'max_trades_per_day',
                'entry_start_time',
                'entry_cutoff_time',
                'market_start_time',
                'market_end_time',
            ];
            for (const key of fields) {
                if (body[key] !== undefined) updates[key] = body[key];
            }

            if (Object.keys(updates).length === 0) {
                throw new AppError(
                    'No valid fields to update',
                    ERRORTYPES.VALIDATION_ERROR,
                );
            }

            await ensureNiftyStrategyRecords();
            await db[MODEL.STRATEGY_CONFIG].update(updates, {
                where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP },
            });

            if (typeof body.paper_balance === 'number') {
                await db[MODEL.STRATEGY].update(
                    { strategy_balance: body.paper_balance },
                    { where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP } },
                );
            }

            const config = await getNiftyScalpConfig();
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });

            return res.status(200).json({
                status: RES_STATUS.UPDATE,
                data: { config, isLive: Boolean(user?.is_live) },
                message: 'Nifty scalp config updated',
            });
        } catch (error) {
            return next(error);
        }
    }

    async toggle_nifty_scalp_live(req, res, next) {
        try {
            const production =
                bodyProduction(req.body?.production ?? req.body?.live ?? req.query?.production);

            await ensureNiftyStrategyRecords();
            await db[MODEL.STRATEGY_CONFIG].update(
                { mode: production ? 'live' : 'paper' },
                { where: { strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP } },
            );
            await db[MODEL.USER].update(
                { is_live: production },
                { where: { email: USER_DETAILS.EMAIL } },
            );

            const config = await getNiftyScalpConfig();
            return res.status(200).json({
                status: RES_STATUS.UPDATE,
                data: {
                    production,
                    mode: config.mode,
                    isLive: production,
                },
                message: production
                    ? 'Production ON — Upstox live orders enabled'
                    : 'Production OFF — paper/dummy money mode',
            });
        } catch (error) {
            return next(error);
        }
    }

    async run_scalping_backtest(req, res, next) {
        try {
            const {
                startDate,
                endDate,
                signalType = 'CE',
                instrumentType = 'CE',
            } = req.body ?? req.query;

            if (!startDate || !endDate) {
                throw new AppError(
                    'startDate and endDate are required (YYYY-MM-DD)',
                    ERRORTYPES.VALIDATION_ERROR,
                );
            }

            const result = await runScalpingBacktest({
                startDate: String(startDate),
                endDate: String(endDate),
                signalType: signalType === 'PE' ? 'PE' : 'CE',
                instrumentType: instrumentType === 'PE' ? 'PE' : 'CE',
            });

            return res.status(200).json({
                status: RES_STATUS.GET,
                data: result,
                message: 'Backtest completed',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_scalping_audit_log(req, res, next) {
        try {
            const days = Number(req.query?.days ?? 7);
            const action = req.query?.action as string | undefined;
            const limit = Math.min(Number(req.query?.limit ?? 100), 500);

            const since = new Date();
            since.setDate(since.getDate() - days);

            const where: Record<string, unknown> = {
                strategy_name: STRATEGY.SCALLPING,
                timestamp: { [Op.gte]: since },
            };
            if (action) where.action = action;

            const [logs, skipBreakdown] = await Promise.all([
                db[MODEL.DECISION_AUDIT].findAll({
                    where,
                    order: [['timestamp', 'DESC']],
                    limit,
                }),
                getAuditSkipBreakdown(STRATEGY.SCALLPING, days),
            ]);

            return res.status(200).json({
                status: RES_STATUS.GET,
                data: { logs, skipBreakdown },
                message: 'Audit log fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_scalping_performance(req, res, next) {
        try {
            const days = Number(req.query?.days ?? 30);
            const strategyName =
                (req.query?.strategy_name as string) ?? STRATEGY.SCALLPING;

            const report = await getScalpingPerformance({
                strategyName,
                days,
            });

            return res.status(200).json({
                status: RES_STATUS.GET,
                data: report,
                message: 'Scalping performance KPIs fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async run_scalping_optimize(req, res, next) {
        try {
            const body = req.body ?? req.query;
            const days = Number(body?.days ?? 60);
            const signalType = body?.signalType === 'PE' ? 'PE' : 'CE';
            const instrumentType =
                body?.instrumentType === 'PE' ? 'PE' : 'CE';
            const applyBest = Boolean(
                body?.applyBest === true || body?.applyBest === 'true',
            );
            const params = body?.params
                ? String(body.params)
                      .split(',')
                      .map((p: string) => p.trim())
                      .filter(Boolean)
                : undefined;

            const report = await runScalpingOptimization({
                days,
                signalType,
                instrumentType,
                applyBest,
                params: params as any,
            });

            return res.status(200).json({
                status: RES_STATUS.GET,
                data: report,
                message: applyBest
                    ? 'Optimization complete; best params applied to strategy_config'
                    : 'Optimization complete; review suggestedOverrides before applying',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_scalping_status(req, res, next) {
        try {
            const status = await getScalpingSystemStatus();
            return res.status(200).json({
                status: RES_STATUS.GET,
                data: status,
                message: 'Scalping system status fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async get_strategy_config(req, res, next) {
        try {
            const strategyName =
                (req.query?.strategy_name as string) ?? STRATEGY.SCALLPING;
            const config = await getStrategyConfig(strategyName);
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });
            return res.status(200).json({
                status: RES_STATUS.GET,
                data: {
                    config,
                    isLive: Boolean(user?.is_live),
                },
                message: 'Strategy config fetched',
            });
        } catch (error) {
            return next(error);
        }
    }

    async update_strategy_config(req, res, next) {
        try {
            const strategyName =
                (req.body?.strategy_name as string) ?? STRATEGY.SCALLPING;
            const { mode } = req.body ?? {};
            const allowedModes = ['paper', 'live', 'backtest'];
            if (mode && !allowedModes.includes(mode)) {
                throw new AppError(
                    `mode must be one of: ${allowedModes.join(', ')}`,
                    ERRORTYPES.VALIDATION_ERROR,
                );
            }

            const updates: Record<string, string> = {};
            if (mode) updates.mode = mode;

            if (Object.keys(updates).length === 0) {
                throw new AppError(
                    'No valid fields to update',
                    ERRORTYPES.VALIDATION_ERROR,
                );
            }

            await db[MODEL.STRATEGY_CONFIG].update(updates, {
                where: { strategy_name: strategyName },
            });

            const config = await getStrategyConfig(strategyName);
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });

            return res.status(200).json({
                status: RES_STATUS.GET,
                data: {
                    config,
                    isLive: Boolean(user?.is_live),
                },
                message: 'Strategy config updated',
            });
        } catch (error) {
            return next(error);
        }
    }

    async scallping_strategy_new_tralling_stoploss() {
        try {
            const currentISTDate = getCurrentISTDate();
            const formattedDate = currentISTDate.toISOString().slice(0, 10);
            const currentTime = getISTTime(currentISTDate);
            const startTime = new Date(`${formattedDate}T09:15:00+05:30`);
            const trade_startTime = new Date(`${formattedDate}T09:45:00+05:30`);
            const endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const trade_endTime = new Date(`${formattedDate}T15:19:00+05:30`);
            const currnet_day = get_current_day_name();
            if (currentISTDate >= startTime && currentISTDate <= endTime) {
                const find_strategy = await db[MODEL.POSITION].findOne({
                    where: {
                        strategy_name: STRATEGY.SCALLPING_TRAILLING,
                        is_active: true,
                    },
                });
                // console.log(find_strategy);

                if (find_strategy && !find_strategy.is_exectued) {
                    const find_trade = await db[MODEL.TRADE].findOne({
                        where: {
                            strategy_name: STRATEGY.SCALLPING_TRAILLING,
                            is_active: true,
                            position_id: find_strategy.id,
                        },
                    });
                    console.log(
                        find_trade?.ltp >= find_trade?.buy_price,
                        find_trade?.ltp,
                        find_trade?.buy_price,
                    );
                    if (
                        find_trade &&
                        find_trade?.ltp >= find_trade?.buy_price
                    ) {
                        await db[MODEL.POSITION].update(
                            {
                                is_exectued: true,
                            },
                            { where: { id: find_strategy.id } },
                        );
                    }
                } else if (find_strategy && find_strategy.is_exectued) {
                    console.log('postion check');
                    const find_trade = await db[MODEL.TRADE].findOne({
                        where: {
                            strategy_name: STRATEGY.SCALLPING_TRAILLING,
                            is_active: true,
                        },
                    });
                    let trade_pl = 0;
                    const diff = find_trade.ltp - find_trade.buy_price;
                    const lot = find_trade.lot_size * find_trade.qty;
                    trade_pl = diff * lot;
                    await db[MODEL.POSITION].update(
                        { pl: trade_pl },
                        { where: { id: find_strategy.id } },
                    );
                    await db[MODEL.TRADE].update(
                        {
                            pl: trade_pl,
                        },
                        {
                            where: { id: find_trade.id },
                        },
                    );
                    if (trade_endTime <= currentISTDate) {
                        const trade_closed = await db[MODEL.TRADE].update(
                            {
                                is_active: false,
                                sell_price: find_trade.ltp,
                                pl: trade_pl,
                            },
                            {
                                where: { id: find_trade.id },
                            },
                        );

                        if (trade_closed) {
                            const position_closed = await db[
                                MODEL.POSITION
                            ].update(
                                {
                                    is_active: false,
                                    pl: trade_pl,
                                    end_time: moment(),
                                },
                                { where: { id: find_strategy.id } },
                            );
                            console.log('Trade Closed Successfully');
                            const current_bal = await db[
                                MODEL.STRATEGY
                            ].findOne({
                                where: {
                                    strategy_name: STRATEGY.SCALLPING_TRAILLING,
                                },
                            });
                            await db[MODEL.STRATEGY].update(
                                {
                                    strategy_balance:
                                        current_bal?.strategy_balance +
                                        trade_pl,
                                },
                                {
                                    where: {
                                        strategy_name:
                                            STRATEGY.SCALLPING_TRAILLING,
                                    },
                                },
                            );
                        }
                        console.log('endd');
                    } else if (
                        find_trade.stop_loss >= find_trade.ltp ||
                        trade_pl <= -3000
                    ) {
                        const trade_closed = await db[MODEL.TRADE].update(
                            {
                                is_active: false,
                                sell_price: find_trade.ltp,
                                pl: trade_pl,
                            },
                            {
                                where: { id: find_trade.id },
                            },
                        );

                        if (trade_closed) {
                            const position_closed = await db[
                                MODEL.POSITION
                            ].update(
                                {
                                    is_active: false,
                                    pl: trade_pl,
                                    end_time: moment(),
                                },
                                { where: { id: find_strategy.id } },
                            );
                            console.log('Trade Closed Successfully');
                            const current_bal = await db[
                                MODEL.STRATEGY
                            ].findOne({
                                where: {
                                    strategy_name: STRATEGY.SCALLPING_TRAILLING,
                                },
                            });
                            await db[MODEL.STRATEGY].update(
                                {
                                    strategy_balance:
                                        current_bal?.strategy_balance +
                                        trade_pl,
                                },
                                {
                                    where: {
                                        strategy_name:
                                            STRATEGY.SCALLPING_TRAILLING,
                                    },
                                },
                            );
                        }
                        console.log('stopploss hits');
                    } else if (find_trade.target_price <= find_trade.ltp) {
                        const trade_closed = await db[MODEL.TRADE].update(
                            {
                                is_active: false,
                                sell_price: find_trade.ltp,
                                pl: trade_pl,
                            },
                            {
                                where: { id: find_trade.id },
                            },
                        );

                        if (trade_closed) {
                            const position_closed = await db[
                                MODEL.POSITION
                            ].update(
                                {
                                    is_active: false,
                                    pl: trade_pl,
                                    end_time: moment(),
                                },
                                { where: { id: find_strategy.id } },
                            );
                            console.log('Trade Closed Successfully');
                            const current_bal = await db[
                                MODEL.STRATEGY
                            ].findOne({
                                where: {
                                    strategy_name: STRATEGY.SCALLPING_TRAILLING,
                                },
                            });
                            await db[MODEL.STRATEGY].update(
                                {
                                    strategy_balance:
                                        current_bal?.strategy_balance +
                                        trade_pl,
                                },
                                {
                                    where: {
                                        strategy_name:
                                            STRATEGY.SCALLPING_TRAILLING,
                                    },
                                },
                            );
                        }
                        console.log('target hits');
                    } else {
                        await strategyController.applying_tralling_stoploss({
                            instrument_type: find_trade.instrument_type,
                            stop_loss_price: find_trade.stop_loss,
                            target_price: find_trade.target_price,
                            trade_id: find_trade.id,
                            pl: trade_pl,
                        });
                    }
                } else {
                    const currnet_day = get_current_day_name();
                    const exclude_days = ['SUNDAY', 'SATURDAY'];
                    if (!exclude_days.includes(currnet_day)) {
                        if (
                            currentISTDate >= trade_startTime &&
                            currentISTDate <= trade_endTime
                        ) {
                            // const get_current_stock_price = await db[
                            //     MODEL.INSTRUMENT
                            // ].findOne({
                            //     where: {
                            //         instrument_key:
                            //             INSTRUMENT_KEYS.SBIN_INSTRUMENT,
                            //     },
                            // });
                            // const ltp = get_current_stock_price.last_price;
                            // const percentage_change =
                            //     get_current_stock_price.lot_size;
                            // const stcoks = await find_sbin_stocks(
                            //     ltp,
                            //     percentage_change,
                            // );
                            // if (stcoks) {
                            //     const create_postions = await db[
                            //         MODEL.POSITION
                            //     ].create({
                            //         strategy_id:
                            //             '24d70d09-7967-495c-9a8d-3c3db1157110',
                            //         strategy_name: STRATEGY.SBIN_TIMING,
                            //         is_active: true,
                            //         qty: 1,
                            //         trade_id: Math.floor(
                            //             100000 + Math.random() * 900000,
                            //         ),
                            //         date: formattedDate,
                            //         start_time: currentISTDate,
                            //         required_margin: Number(stcoks.ltp) * 750,
                            //     });
                            //     if (create_postions) {
                            //         const trade_placed = await db[
                            //             MODEL.TRADE
                            //         ].create({
                            //             position_id: create_postions.id,
                            //             options_chain_id: stcoks.id,
                            //             trade_id: create_postions.trade_id,
                            //             strategy_name: STRATEGY.SBIN_TIMING,
                            //             trading_symbol: stcoks.trading_symbol,
                            //             instrument_key: stcoks.instrument_key,
                            //             instrument_type: stcoks.instrument_type,
                            //             trade_type: 'BUY',
                            //             buy_price: stcoks.ltp,
                            //             stop_loss: stcoks.lot_size * 2,
                            //             is_active: true,
                            //             ltp: stcoks.ltp,
                            //             qty: 1,
                            //             lot_size: stcoks.lot_size,
                            //         });
                            //         if (trade_placed) {
                            //             logger.info(
                            //                 'Trade Placed Successfully',
                            //             );
                            //         }
                            //     }
                            // } else {
                            //     logger.info('Stock Not Found');
                            // }

                            const find_stocks = await db[
                                MODEL.STRIKE_MODEL
                            ].findOne({
                                where: {
                                    instrument_type: 'CE',
                                    is_active: true,
                                },
                            });

                            if (find_stocks && find_stocks.instrument_key) {
                                let find_candels = await db[
                                    MODEL.CANDELS
                                ].findAll({
                                    where: {
                                        instrument_key:
                                            find_stocks.instrument_key,
                                    },
                                    order: [['ts', 'DESC']],
                                    limit: 100,
                                });

                                if (find_candels.length < 22) {
                                    logger.info(
                                        `Candel Not Found ${
                                            22 - find_candels.length
                                        }`,
                                    );
                                } else {
                                    // console.log('candles', find_candels.length);
                                    const closes = find_candels
                                        .map((c) => Number(c.close))
                                        .reverse();
                                    const rsi =
                                        closes.length >= 14
                                            ? RSI.calculate({
                                                  period: 14,
                                                  values: closes,
                                              })
                                            : [];
                                    const lastRSI = rsi[rsi.length - 1];

                                    const last_make_candels =
                                        find_candels.reverse();
                                    const ema9 = EMA.calculate({
                                        period: 9,
                                        values: closes,
                                    });
                                    const ema21 = EMA.calculate({
                                        period: 21,
                                        values: closes,
                                    });
                                    const lastEMA9 = ema9[ema9.length - 1];
                                    const prevEMA9 = ema9[ema9.length - 2];
                                    const lastEMA21 = ema21[ema21.length - 1];
                                    const prevEMA21 = ema21[ema21.length - 2];

                                    const lastCandle =
                                        last_make_candels[
                                            find_candels.length - 1
                                        ];

                                    //BUY Signal
                                    // logger.info(
                                    //     'BUYING RSI',
                                    //     lastRSI,
                                    //     lastRSI > 45,
                                    //     lastRSI < 75,
                                    // );

                                    if (
                                        lastEMA9 > lastEMA21 &&
                                        prevEMA9 <= prevEMA21 &&
                                        lastRSI > 45 &&
                                        lastRSI < 75
                                    ) {
                                        console.log('BUY Signal');

                                        const stcoks = await db[
                                            MODEL.STRIKE_MODEL
                                        ].findOne({
                                            where: {
                                                instrument_type: 'CE',
                                                is_active: true,
                                            },
                                        });

                                        if (stcoks && stcoks.instrument_key) {
                                            const buy_price = lastCandle.close;
                                            const target_price =
                                                stcoks.ltp +
                                                (stcoks.ltp - lastCandle.low) *
                                                    1.5;
                                            const stop_loss_price =
                                                buy_price - lastCandle.low > 5
                                                    ? lastCandle.low
                                                    : buy_price - 5;

                                            if (
                                                buy_price > stop_loss_price &&
                                                target_price > buy_price &&
                                                target_price > stop_loss_price
                                            ) {
                                                const create_postions =
                                                    await db[
                                                        MODEL.POSITION
                                                    ].create({
                                                        strategy_id:
                                                            '65daacfc-6380-4ca6-af61-4183cef4c82b',
                                                        strategy_name:
                                                            STRATEGY.SCALLPING_TRAILLING,
                                                        is_active: true,
                                                        qty: 1,
                                                        trade_id: Math.floor(
                                                            100000 +
                                                                Math.random() *
                                                                    900000,
                                                        ),
                                                        date: formattedDate,
                                                        start_time:
                                                            currentISTDate,
                                                        required_margin:
                                                            Number(stcoks.ltp) *
                                                            Number(
                                                                stcoks.lot_size,
                                                            ),
                                                    });

                                                if (create_postions) {
                                                    const trade_placed =
                                                        await db[
                                                            MODEL.TRADE
                                                        ].create({
                                                            position_id:
                                                                create_postions.id,
                                                            options_chain_id:
                                                                stcoks.id,
                                                            trade_id:
                                                                create_postions.trade_id,
                                                            strategy_name:
                                                                STRATEGY.SCALLPING_TRAILLING,
                                                            trading_symbol:
                                                                stcoks.trading_symbol,
                                                            instrument_key:
                                                                stcoks.instrument_key,
                                                            instrument_type:
                                                                stcoks.instrument_type,
                                                            trade_type: 'BUY',
                                                            buy_price:
                                                                lastCandle.close,
                                                            target_price:
                                                                stcoks.ltp +
                                                                (stcoks.ltp -
                                                                    lastCandle.low) *
                                                                    1.5,
                                                            stop_loss:
                                                                stop_loss_price,
                                                            is_active: true,
                                                            ltp: stcoks.ltp,
                                                            qty: 1,
                                                            lot_size:
                                                                stcoks.lot_size,
                                                        });
                                                    if (trade_placed) {
                                                        logger.info(
                                                            'Trade Placed Successfully',
                                                        );
                                                        if (
                                                            process.env
                                                                .UPSTOCKS_ACCOUNT ===
                                                            'live'
                                                        ) {
                                                            const user =
                                                                await db[
                                                                    MODEL.USER
                                                                ].findOne({
                                                                    where: {
                                                                        email: USER_DETAILS.EMAIL,
                                                                    },
                                                                });

                                                            const order_placed =
                                                                await place_order_on_upstocks(
                                                                    {
                                                                        instrument_key:
                                                                            stcoks.instrument_key,
                                                                        accessToken:
                                                                            user.token,
                                                                        quantity:
                                                                            stcoks.lot_size,
                                                                        transaction_type:
                                                                            'BUY',
                                                                    },
                                                                );

                                                            if (order_placed) {
                                                                logger.info(
                                                                    'Upstock Order Placed Successfully',
                                                                );
                                                                console.log(
                                                                    order_placed,
                                                                );

                                                                if (
                                                                    order_placed.status ===
                                                                        'success' &&
                                                                    order_placed
                                                                        .data
                                                                        .order_ids
                                                                        .length >
                                                                        0
                                                                ) {
                                                                    const orders_done =
                                                                        order_placed
                                                                            .data
                                                                            .order_ids;

                                                                    orders_done.map(
                                                                        async (
                                                                            order_id,
                                                                        ) => {
                                                                            await db[
                                                                                MODEL
                                                                                    .UPSTOCK_ORDERS
                                                                            ].create(
                                                                                {
                                                                                    upstock_order_id:
                                                                                        order_id,
                                                                                    postion_id:
                                                                                        create_postions.id,
                                                                                    order_type:
                                                                                        'BUY',
                                                                                },
                                                                            );
                                                                        },
                                                                    );
                                                                }
                                                            } else {
                                                                logger.error(
                                                                    'Order Not Placed',
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                            } else {
                                                logger.info(
                                                    'target stoploss not match',
                                                );
                                                logger.info(
                                                    'target price',
                                                    target_price,
                                                );
                                                logger.info(
                                                    'stoploss',
                                                    stop_loss_price,
                                                );
                                                logger.info(
                                                    'buyprice',
                                                    buy_price,
                                                );
                                            }
                                        } else {
                                            logger.info('Stock Not Found');
                                        }
                                    } else {
                                        /// sell signal process
                                        const find_stocks = await db[
                                            MODEL.STRIKE_MODEL
                                        ].findOne({
                                            where: {
                                                instrument_type: 'PE',
                                                is_active: true,
                                            },
                                        });

                                        if (
                                            find_stocks &&
                                            find_stocks.instrument_key
                                        ) {
                                            let find_candels = await db[
                                                MODEL.CANDELS
                                            ].findAll({
                                                where: {
                                                    instrument_key:
                                                        find_stocks.instrument_key,
                                                },
                                                order: [['ts', 'DESC']],
                                                limit: 100,
                                            });

                                            if (find_candels.length < 22) {
                                                logger.info(
                                                    `Candel Not Found ${
                                                        22 - find_candels.length
                                                    }`,
                                                );
                                            } else {
                                                // console.log('candles', find_candels.length);
                                                const closes = find_candels
                                                    .map((c) => Number(c.close))
                                                    .reverse();
                                                const last_make_candels =
                                                    find_candels.reverse();
                                                const ema9 = EMA.calculate({
                                                    period: 9,
                                                    values: closes,
                                                });
                                                const ema21 = EMA.calculate({
                                                    period: 21,
                                                    values: closes,
                                                });
                                                const rsi =
                                                    closes.length >= 14
                                                        ? RSI.calculate({
                                                              period: 14,
                                                              values: closes,
                                                          })
                                                        : [];
                                                const lastRSI =
                                                    rsi[rsi.length - 1];
                                                const lastEMA9 =
                                                    ema9[ema9.length - 1];
                                                const prevEMA9 =
                                                    ema9[ema9.length - 2];
                                                const lastEMA21 =
                                                    ema21[ema21.length - 1];
                                                const prevEMA21 =
                                                    ema21[ema21.length - 2];

                                                const lastCandle =
                                                    last_make_candels[
                                                        find_candels.length - 1
                                                    ];

                                                if (
                                                    lastEMA9 > lastEMA21 &&
                                                    prevEMA9 <= prevEMA21
                                                ) {
                                                    console.log('BUY Signal');

                                                    if (
                                                        lastRSI < 55 &&
                                                        lastRSI > 0
                                                    ) {
                                                        const stcoks = await db[
                                                            MODEL.STRIKE_MODEL
                                                        ].findOne({
                                                            where: {
                                                                instrument_type:
                                                                    'PE',
                                                                is_active: true,
                                                            },
                                                        });

                                                        if (
                                                            stcoks &&
                                                            stcoks.instrument_key
                                                        ) {
                                                            const buy_price =
                                                                lastCandle.close;
                                                            const target_price =
                                                                stcoks.ltp +
                                                                (stcoks.ltp -
                                                                    lastCandle.low) *
                                                                    1.5;
                                                            const stop_loss_price =
                                                                buy_price -
                                                                    lastCandle.low >
                                                                5
                                                                    ? lastCandle.low
                                                                    : buy_price -
                                                                      5;

                                                            if (
                                                                buy_price >
                                                                    stop_loss_price &&
                                                                target_price >
                                                                    buy_price &&
                                                                target_price >
                                                                    stop_loss_price
                                                            ) {
                                                                const create_postions =
                                                                    await db[
                                                                        MODEL
                                                                            .POSITION
                                                                    ].create({
                                                                        strategy_id:
                                                                            '65daacfc-6380-4ca6-af61-4183cef4c82b',
                                                                        strategy_name:
                                                                            STRATEGY.SCALLPING_TRAILLING,
                                                                        is_active:
                                                                            true,
                                                                        qty: 1,
                                                                        trade_id:
                                                                            Math.floor(
                                                                                100000 +
                                                                                    Math.random() *
                                                                                        900000,
                                                                            ),
                                                                        date: formattedDate,
                                                                        start_time:
                                                                            currentISTDate,
                                                                        required_margin:
                                                                            Number(
                                                                                stcoks.ltp,
                                                                            ) *
                                                                            Number(
                                                                                stcoks.lot_size,
                                                                            ),
                                                                    });

                                                                if (
                                                                    create_postions
                                                                ) {
                                                                    const trade_placed =
                                                                        await db[
                                                                            MODEL
                                                                                .TRADE
                                                                        ].create(
                                                                            {
                                                                                position_id:
                                                                                    create_postions.id,
                                                                                options_chain_id:
                                                                                    stcoks.id,
                                                                                trade_id:
                                                                                    create_postions.trade_id,
                                                                                strategy_name:
                                                                                    STRATEGY.SCALLPING_TRAILLING,
                                                                                trading_symbol:
                                                                                    stcoks.trading_symbol,
                                                                                instrument_key:
                                                                                    stcoks.instrument_key,
                                                                                instrument_type:
                                                                                    stcoks.instrument_type,
                                                                                trade_type:
                                                                                    'BUY',
                                                                                buy_price:
                                                                                    lastCandle.close,
                                                                                target_price:
                                                                                    stcoks.ltp +
                                                                                    (stcoks.ltp -
                                                                                        lastCandle.low) *
                                                                                        1.5,
                                                                                stop_loss:
                                                                                    stop_loss_price,
                                                                                is_active:
                                                                                    true,
                                                                                ltp: stcoks.ltp,
                                                                                qty: 1,
                                                                                lot_size:
                                                                                    stcoks.lot_size,
                                                                            },
                                                                        );
                                                                    if (
                                                                        trade_placed
                                                                    ) {
                                                                        logger.info(
                                                                            'Trade Placed Successfully',
                                                                        );
                                                                        if (
                                                                            process
                                                                                .env
                                                                                .UPSTOCKS_ACCOUNT ===
                                                                            'live'
                                                                        ) {
                                                                            const user =
                                                                                await db[
                                                                                    MODEL
                                                                                        .USER
                                                                                ].findOne(
                                                                                    {
                                                                                        where: {
                                                                                            email: USER_DETAILS.EMAIL,
                                                                                        },
                                                                                    },
                                                                                );

                                                                            const order_placed =
                                                                                await place_order_on_upstocks(
                                                                                    {
                                                                                        instrument_key:
                                                                                            stcoks.instrument_key,
                                                                                        accessToken:
                                                                                            user.token,
                                                                                        quantity:
                                                                                            stcoks.lot_size,
                                                                                        transaction_type:
                                                                                            'BUY',
                                                                                    },
                                                                                );

                                                                            if (
                                                                                order_placed
                                                                            ) {
                                                                                logger.info(
                                                                                    'Upstock Order Placed Successfully',
                                                                                );
                                                                                console.log(
                                                                                    order_placed,
                                                                                );

                                                                                if (
                                                                                    order_placed.status ===
                                                                                        'success' &&
                                                                                    order_placed
                                                                                        .data
                                                                                        .order_ids
                                                                                        .length >
                                                                                        0
                                                                                ) {
                                                                                    const orders_done =
                                                                                        order_placed
                                                                                            .data
                                                                                            .order_ids;

                                                                                    orders_done.map(
                                                                                        async (
                                                                                            order_id,
                                                                                        ) => {
                                                                                            await db[
                                                                                                MODEL
                                                                                                    .UPSTOCK_ORDERS
                                                                                            ].create(
                                                                                                {
                                                                                                    upstock_order_id:
                                                                                                        order_id,
                                                                                                    postion_id:
                                                                                                        create_postions.id,
                                                                                                    order_type:
                                                                                                        'BUY',
                                                                                                },
                                                                                            );
                                                                                        },
                                                                                    );
                                                                                }
                                                                            } else {
                                                                                logger.error(
                                                                                    'Order Not Placed',
                                                                                );
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            } else {
                                                                logger.info(
                                                                    'target stoploss not match',
                                                                );
                                                                logger.info(
                                                                    'target price',
                                                                    target_price,
                                                                );
                                                                logger.info(
                                                                    'stoploss',
                                                                    stop_loss_price,
                                                                );
                                                                logger.info(
                                                                    'buyprice',
                                                                    buy_price,
                                                                );
                                                            }
                                                        } else {
                                                            logger.info(
                                                                'Stock Not Found',
                                                            );
                                                        }
                                                    } else {
                                                        logger.info(
                                                            'Reject for RSI Selling Process',
                                                            lastRSI,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // sell process

                                    // if (
                                    //     lastEMA9 < lastEMA21 &&
                                    //     prevEMA9 >= prevEMA21
                                    // ) {
                                    //     console.log('SELL Signal');
                                    //     const stcoks = await db[
                                    //         MODEL.STRIKE_MODEL
                                    //     ].findOne({
                                    //         where: {
                                    //             instrument_type: 'PE',
                                    //             is_active: true,
                                    //         },
                                    //     });

                                    //     let find_candels_pe = await db[
                                    //         MODEL.CANDELS
                                    //     ].findAll({
                                    //         where: {
                                    //             instrument_key:
                                    //                 stcoks.instrument_key,
                                    //         },
                                    //         order: [['ts', 'DESC']],
                                    //         limit: 100,
                                    //     });

                                    //     if (find_candels_pe.length < 22) {
                                    //         logger.info('Candel Not Found');
                                    //     } else {
                                    //         const reverse_candle =
                                    //             find_candels_pe.reverse();
                                    //         const last_make_candels_pe =
                                    //             reverse_candle[
                                    //                 find_candels_pe.length - 1
                                    //             ];
                                    //         if (
                                    //             stcoks &&
                                    //             stcoks.instrument_key
                                    //         ) {
                                    //             const buy_price =
                                    //                 last_make_candels_pe.close;
                                    //             const stop_loss_price =
                                    //                 buy_price -
                                    //                     last_make_candels_pe.low >
                                    //                 5
                                    //                     ? last_make_candels_pe.low
                                    //                     : buy_price - 5;
                                    //             const target_price =
                                    //                 stcoks.ltp +
                                    //                 (stcoks.ltp -
                                    //                     last_make_candels_pe.low) *
                                    //                     1.5;

                                    //             if (
                                    //                 buy_price >
                                    //                     stop_loss_price &&
                                    //                 target_price > buy_price &&
                                    //                 target_price >
                                    //                     stop_loss_price
                                    //             ) {
                                    //                 const create_postions =
                                    //                     await db[
                                    //                         MODEL.POSITION
                                    //                     ].create({
                                    //                         strategy_id:
                                    //                             '50e7fd1e-54e6-4686-93d0-c0adbaff65bf',
                                    //                         strategy_name:
                                    //                             STRATEGY.SCALLPING,
                                    //                         is_active: true,
                                    //                         qty: 1,
                                    //                         trade_id:
                                    //                             Math.floor(
                                    //                                 100000 +
                                    //                                     Math.random() *
                                    //                                         900000,
                                    //                             ),
                                    //                         date: formattedDate,
                                    //                         start_time:
                                    //                             currentISTDate,
                                    //                         required_margin:
                                    //                             Number(
                                    //                                 stcoks.ltp,
                                    //                             ) *
                                    //                             Number(
                                    //                                 stcoks.lot_size,
                                    //                             ),
                                    //                     });

                                    //                 if (create_postions) {
                                    //                     const trade_placed =
                                    //                         await db[
                                    //                             MODEL.TRADE
                                    //                         ].create({
                                    //                             position_id:
                                    //                                 create_postions.id,
                                    //                             options_chain_id:
                                    //                                 stcoks.id,
                                    //                             trade_id:
                                    //                                 create_postions.trade_id,
                                    //                             strategy_name:
                                    //                                 STRATEGY.SCALLPING,
                                    //                             trading_symbol:
                                    //                                 stcoks.trading_symbol,
                                    //                             instrument_key:
                                    //                                 stcoks.instrument_key,
                                    //                             instrument_type:
                                    //                                 stcoks.instrument_type,
                                    //                             trade_type:
                                    //                                 'BUY',
                                    //                             buy_price:
                                    //                                 last_make_candels_pe.close,
                                    //                             target_price:
                                    //                                 stcoks.ltp +
                                    //                                 (stcoks.ltp -
                                    //                                     last_make_candels_pe.low) *
                                    //                                     1.5,
                                    //                             stop_loss:
                                    //                                 stop_loss_price,
                                    //                             is_active: true,
                                    //                             ltp: stcoks.ltp,
                                    //                             qty: 1,
                                    //                             lot_size:
                                    //                                 stcoks.lot_size,
                                    //                         });
                                    //                     if (trade_placed) {
                                    //                         logger.info(
                                    //                             'Trade Placed Successfully',
                                    //                         );

                                    //                         if (
                                    //                             process.env
                                    //                                 .UPSTOCKS_ACCOUNT ===
                                    //                             'live'
                                    //                         ) {
                                    //                             const user =
                                    //                                 await db[
                                    //                                     MODEL
                                    //                                         .USER
                                    //                                 ].findOne({
                                    //                                     where: {
                                    //                                         email: USER_DETAILS.EMAIL,
                                    //                                     },
                                    //                                 });

                                    //                             const order_placed =
                                    //                                 await place_order_on_upstocks(
                                    //                                     {
                                    //                                         instrument_key:
                                    //                                             stcoks.instrument_key,
                                    //                                         accessToken:
                                    //                                             user.token,
                                    //                                         quantity:
                                    //                                             stcoks.lot_size,
                                    //                                         transaction_type:
                                    //                                             'BUY',
                                    //                                     },
                                    //                                 );

                                    //                             if (
                                    //                                 order_placed
                                    //                             ) {
                                    //                                 logger.info(
                                    //                                     'Upstock Order Placed Successfully',
                                    //                                 );
                                    //                                 console.log(
                                    //                                     order_placed,
                                    //                                 );

                                    //                                 if (
                                    //                                     order_placed.status ===
                                    //                                         'success' &&
                                    //                                     order_placed
                                    //                                         .data
                                    //                                         .order_ids
                                    //                                         .length >
                                    //                                         0
                                    //                                 ) {
                                    //                                     const orders_done =
                                    //                                         order_placed
                                    //                                             .data
                                    //                                             .order_ids;

                                    //                                     orders_done.map(
                                    //                                         async (
                                    //                                             order_id,
                                    //                                         ) => {
                                    //                                             await db[
                                    //                                                 MODEL
                                    //                                                     .UPSTOCK_ORDERS
                                    //                                             ].create(
                                    //                                                 {
                                    //                                                     upstock_order_id:
                                    //                                                         order_id,
                                    //                                                     postion_id:
                                    //                                                         create_postions.id,
                                    //                                                     order_type:
                                    //                                                         'BUY',
                                    //                                                 },
                                    //                                             );
                                    //                                         },
                                    //                                     );
                                    //                                 }
                                    //                             } else {
                                    //                                 logger.error(
                                    //                                     'Order Not Placed',
                                    //                                 );
                                    //                             }
                                    //                         }
                                    //                     }
                                    //                 }
                                    //             } else {
                                    //                 logger.info(
                                    //                     'target stoploss not match',
                                    //                 );
                                    //                 logger.info(
                                    //                     'target price',
                                    //                     target_price,
                                    //                 );
                                    //                 logger.info(
                                    //                     'stoploss',
                                    //                     stop_loss_price,
                                    //                 );
                                    //                 logger.info(
                                    //                     'buyprice',
                                    //                     buy_price,
                                    //                 );
                                    //             }
                                    //         } else {
                                    //             logger.info('Stock Not Found');
                                    //         }
                                    //     }
                                    // }
                                }
                            }
                        }
                    } else {
                        logger.info('Today is holiday');
                    }
                }
            } else {
                logger.error('Market Time is closed');
            }
        } catch (error) {
            logger.error(error.message);
        }
    }

    async check_market_time(instrument_key, instrument_type) {
        try {
            let find_candels = await db[MODEL.CANDELS].findAll({
                where: {
                    instrument_key: instrument_key,
                },
                order: [['ts', 'DESC']],
                limit: 100,
            });

            if (find_candels.length < 22) {
                logger.info('Candel Not Found');
            } else {
                console.log('candes');
                const candles = find_candels.map((c) => c).reverse();
                const closes = find_candels
                    .map((c) => Number(c.close))
                    .reverse();
                const ema9 = EMA.calculate({ period: 9, values: closes });
                const ema21 = EMA.calculate({ period: 21, values: closes });
                const lastEMA9 = ema9[ema9.length - 1];
                const prevEMA9 = ema9[ema9.length - 2];
                const lastEMA21 = ema21[ema21.length - 1];
                const prevEMA21 = ema21[ema21.length - 2];
                const lastCandle = candles[candles.length - 1];
                //BUY Signal
                if (lastEMA9 > lastEMA21 && prevEMA9 <= prevEMA21) {
                    console.log('BUY Signal', instrument_key, instrument_type);
                    const entryPrice = lastCandle.close;
                    const stopLoss = lastCandle.low; // recent swing low
                    const target = entryPrice + 5; // 5 points profit
                    const signal = {
                        type: 'BUY',
                        instrument_type: instrument_type,
                        price: entryPrice,
                        stopLoss,
                        target,
                        instrument_key: instrument_key,
                    };
                    return signal;
                }
                // if (lastEMA9 < lastEMA21 && prevEMA9 >= prevEMA21) {
                //     console.log('SELL Signal');
                // }
            }

            // return find_candels;
        } catch (error) {
            logger.error(error.message);
        }
    }

    async applying_tralling_stoploss(data) {
        try {
            const find_stocks = await db[MODEL.STRIKE_MODEL].findOne({
                where: {
                    instrument_type: data.instrument_type,
                    is_active: true,
                },
            });

            let find_candels = await db[MODEL.CANDELS].findAll({
                where: {
                    instrument_key: find_stocks.instrument_key,
                },
                order: [['ts', 'DESC']],
                limit: 100,
            });

            if (find_candels.length < 22) {
                logger.info(`Candel Not Found ${22 - find_candels.length}`);
            } else {
                // console.log('candles', find_candels.length);
                const closes = find_candels
                    .map((c) => Number(c.close))
                    .reverse();
                const rsi =
                    closes.length >= 14
                        ? RSI.calculate({
                              period: 14,
                              values: closes,
                          })
                        : [];
                const lastRSI = rsi[rsi.length - 1];

                const last_make_candels = find_candels.reverse();
                const ema9 = EMA.calculate({
                    period: 9,
                    values: closes,
                });
                const ema21 = EMA.calculate({
                    period: 21,
                    values: closes,
                });
                const lastEMA9 = ema9[ema9.length - 1];
                const prevEMA9 = ema9[ema9.length - 2];
                const lastEMA21 = ema21[ema21.length - 1];
                const prevEMA21 = ema21[ema21.length - 2];
                const lastCandle = last_make_candels[find_candels.length - 1];

                const stcoks = await db[MODEL.STRIKE_MODEL].findOne({
                    where: {
                        instrument_type: data.instrument_type,
                        is_active: true,
                    },
                });

                if (lastEMA9 > lastEMA21 && prevEMA9 <= prevEMA21) {
                    if (data.instrument_type === 'CE') {
                        if (lastRSI > 45 && lastRSI < 75) {
                            const target_price =
                                stcoks.ltp +
                                (stcoks.ltp - lastCandle.low) * 1.5;
                            const stop_loss_price = lastCandle.low;

                            if (
                                data.target_price < target_price &&
                                data.stop_loss_price < stop_loss_price
                            ) {
                                await db[MODEL.TRADE].update(
                                    {
                                        target_price: target_price,
                                        stop_loss:
                                            data.pl > 100
                                                ? stop_loss_price
                                                : data.stop_loss_price,
                                    },
                                    {
                                        where: {
                                            id: data.trade_id,
                                        },
                                    },
                                );

                                const create_history = await db[
                                    MODEL.TRADE_UPDATE
                                ].create({
                                    trade_id: data.trade_id,
                                    trade_old_sl: data.stop_loss_price,
                                    trade_new_sl:
                                        data.pl > 100
                                            ? stop_loss_price
                                            : data.stop_loss_price,
                                    trade_old_tg: data.target_price,
                                    trade_new_tg: target_price,
                                });
                            }
                        } else {
                            logger.info(
                                'applying tralling stoploss rejected for RSI CE',
                                lastRSI,
                            );
                        }
                    } else {
                        if (lastRSI < 55 && lastRSI > 0) {
                            const target_price =
                                stcoks.ltp +
                                (stcoks.ltp - lastCandle.low) * 1.5;
                            const stop_loss_price = lastCandle.low;

                            if (
                                data.target_price < target_price &&
                                data.stop_loss_price < stop_loss_price
                            ) {
                                await db[MODEL.TRADE].update(
                                    {
                                        target_price: target_price,
                                        stop_loss:
                                            data.pl > 100
                                                ? stop_loss_price
                                                : data.stop_loss_price,
                                    },
                                    {
                                        where: {
                                            id: data.trade_id,
                                        },
                                    },
                                );
                                const create_history = await db[
                                    MODEL.TRADE_UPDATE
                                ].create({
                                    trade_id: data.trade_id,
                                    trade_old_sl: data.stop_loss_price,
                                    trade_new_sl:
                                        data.pl > 100
                                            ? stop_loss_price
                                            : data.stop_loss_price,
                                    trade_old_tg: data.target_price,
                                    trade_new_tg: target_price,
                                });
                            }
                        } else {
                            logger.info(
                                'applying tralling stoploss rejected for RSI PE',
                                lastRSI,
                            );
                        }
                    }
                }
            }
        } catch (error) {
            logger.error(error);
        }
    }
}

export const strategyController = new StrategyController();

function bodyProduction(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}
