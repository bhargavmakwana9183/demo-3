import moment from 'moment';
import { Op } from 'sequelize';
import { MODEL, STRATEGY, INDEXES, INDEXES_NAMES } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import {
    current_strike_price,
    getCurrentISTDate,
    get_upcoming_expiry_date,
} from '../helpers/stock.helper';
import { buildMarketTime, canOpenNewTrade } from '../helpers/scalping.risk.helper';
import {
    NIFTY_COOLDOWN_AFTER_LOSS_MIN,
    NIFTY_DAILY_MAX_CONSECUTIVE_LOSSES,
    NIFTY_DAILY_MAX_LOSS_RS,
    NIFTY_DAILY_MAX_TRADES,
    NIFTY_DAILY_PROFIT_LOCK_RS,
    NIFTY_ENTRY_QUIET_UNTIL,
    NIFTY_HEDGE_ENABLED,
    NIFTY_MAX_LOTS,
    NIFTY_NO_FOLLOW_MINUTES,
    NIFTY_NO_FOLLOW_POINTS,
    NIFTY_PROFIT_CAP_RS,
    NIFTY_SOFT_LOSS_RS,
    NIFTY_SPOT_FLIP_MIN_MINUTES,
    NIFTY_STOP_POINTS,
    NIFTY_TRAIL_FLOOR_RS,
    NIFTY_TRAIL_MAX_MINUTES,
    NIFTY_TRAIL_POINTS,
    priceForNet,
    getNiftyScalpConfig,
    getNiftyStrategyBalance,
    calculateGrossPl,
    calculateRoundTripCharges,
} from '../helpers/nifty.scalp.config.helper';
import {
    evaluateNiftyOptionSignal,
    spotTrendAllows,
} from '../helpers/nifty.scalp.signal.helper';
import {
    closeNiftyScalpTrade,
    hedgeOpenNet,
    openNiftyScalpEntry,
} from '../helpers/nifty.scalp.trade.helper';
import { recordNiftyPriceTick } from '../helpers/nifty.scalp.planb.helper';
import { logNiftyAudit } from '../helpers/nifty.scalp.audit.helper';
import { notifyNiftyEvent } from '../helpers/nifty.scalp.notify.helper';

const NO_NEW_ENTRY_AFTER = '14:30';
const EXPIRY_NO_NEW_ENTRY_AFTER = '11:30';
const EOD_CHECK_TIME = '15:10';
const EOD_LOSS_CHOICE_RS = 500;

export type NiftyEngineState =
    | 'INACTIVE'
    | 'MARKET_CLOSED'
    | 'SCANNING'
    | 'IN_TRADE'
    | 'AVERAGING'
    | 'RECOVERY'
    | 'CARRY_FORWARD'
    | 'EXIT_PENDING'
    | 'HALTED';

export class NiftyScalpEngine {
    private lastCarryLogDate: string | null = null;

    async run(): Promise<NiftyEngineState> {
        const config = await getNiftyScalpConfig();

        if (!config.is_active) {
            return 'INACTIVE';
        }

        if (config.mode === 'backtest') {
            return 'INACTIVE';
        }

        const currentISTDate = getCurrentISTDate();
        const formattedDate = currentISTDate.toISOString().slice(0, 10);
        const startTime = buildMarketTime(
            formattedDate,
            config.market_start_time,
        );
        const endTime = buildMarketTime(formattedDate, config.market_end_time);
        const position = await this.getActivePosition();

        if (currentISTDate < startTime || currentISTDate > endTime) {
            if (position && config.enable_overnight_carry) {
                if (this.lastCarryLogDate !== formattedDate) {
                    this.lastCarryLogDate = formattedDate;
                    await logNiftyAudit({
                        action: 'CARRY_FORWARD',
                        reason: 'OUTSIDE_MARKET_HOURS_HOLD',
                        engineState: 'CARRY_FORWARD',
                        config,
                        tradeId: position.id,
                        metadata: {
                            thinking:
                                'Market closed/not open. Holding open position overnight — no force exit.',
                        },
                    });
                    notifyNiftyEvent(
                        'CARRY_FORWARD',
                        'Position carried overnight — waiting for next session',
                        { positionId: position.id },
                    );
                }
                return 'CARRY_FORWARD';
            }
            return 'MARKET_CLOSED';
        }

        if (position) {
            return this.manageOpenPosition(position, config, currentISTDate);
        }

        return this.scanForEntry(config, currentISTDate);
    }

    private async getActivePosition() {
        return db[MODEL.POSITION].findOne({
            where: {
                strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                is_active: true,
            },
        });
    }

    private async getActiveTrade(positionId: string) {
        return db[MODEL.TRADE].findOne({
            where: {
                strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                is_active: true,
                position_id: positionId,
            },
        });
    }

    private async todayLossStats() {
        const start = moment().startOf('day').toDate();
        const end = moment().endOf('day').toDate();
        const closed = await db[MODEL.TRADE].findAll({
            where: {
                strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                is_active: false,
                createdAt: { [Op.between]: [start, end] },
            },
        });
        const ordered = [...closed].sort(
            (a, b) =>
                new Date(a.updatedAt).getTime() -
                new Date(b.updatedAt).getTime(),
        );
        let lossCount = 0;
        let dayNet = 0;
        let consecutiveLosses = 0;
        let lastLossAt: Date | null = null;
        for (const t of ordered) {
            const n = Number(t.net_pl ?? t.pl ?? 0);
            dayNet += n;
            if (n < 0) {
                lossCount += 1;
                consecutiveLosses += 1;
                lastLossAt = new Date(t.updatedAt);
            } else {
                consecutiveLosses = 0;
            }
        }
        return {
            lossCount,
            dayNet,
            consecutiveLosses,
            lastLossAt,
            tradeCount: ordered.length,
        };
    }

    /** Day-level protection. Returns a skip reason, or null when trading is allowed. */
    private async dayLimitReason(): Promise<{
        reason: string;
        metadata: Record<string, unknown>;
    } | null> {
        const stats = await this.todayLossStats();
        const metadata = { ...stats, lastLossAt: stats.lastLossAt?.toISOString() };
        if (stats.dayNet <= -NIFTY_DAILY_MAX_LOSS_RS) {
            return { reason: 'DAILY_LOSS_LIMIT', metadata };
        }
        if (stats.consecutiveLosses >= NIFTY_DAILY_MAX_CONSECUTIVE_LOSSES) {
            return { reason: 'CONSECUTIVE_LOSS_LIMIT', metadata };
        }
        if (stats.dayNet >= NIFTY_DAILY_PROFIT_LOCK_RS) {
            return { reason: 'DAILY_PROFIT_LOCK', metadata };
        }
        if (stats.tradeCount >= NIFTY_DAILY_MAX_TRADES) {
            return { reason: 'MAX_TRADES_PER_DAY', metadata };
        }
        if (
            stats.lastLossAt &&
            Date.now() - stats.lastLossAt.getTime() <
                NIFTY_COOLDOWN_AFTER_LOSS_MIN * 60000
        ) {
            return { reason: 'COOLDOWN_AFTER_LOSS', metadata };
        }
        return null;
    }

    private async manageOpenPosition(
        position: any,
        config: Awaited<ReturnType<typeof getNiftyScalpConfig>>,
        currentISTDate: Date,
    ): Promise<NiftyEngineState> {
        const trade = await this.getActiveTrade(position.id);
        if (!trade) return 'IN_TRADE';

        const hedging = await db[MODEL.HEDGING_OPTIONS].findOne({
            where: { instrument_key: trade.instrument_key },
        });
        if (hedging?.ltp) {
            await trade.update({ ltp: Number(hedging.ltp) });
            trade.ltp = Number(hedging.ltp);
        }

        if (trade.hedge_instrument_key) {
            const hedgeRow = await db[MODEL.HEDGING_OPTIONS].findOne({
                where: { instrument_key: trade.hedge_instrument_key },
            });
            if (hedgeRow?.ltp) {
                await trade.update({ hedge_ltp: Number(hedgeRow.ltp) });
                trade.hedge_ltp = Number(hedgeRow.ltp);
            }
        }

        const ltp = Number(trade.ltp);
        const avgBuy = Number(trade.buy_price);
        const qty = Number(trade.qty);
        const lotSize = Number(trade.lot_size);
        const target = Number(trade.target_price);
        const highest = Math.max(Number(trade.highest_ltp || 0), ltp);
        if (highest !== Number(trade.highest_ltp || 0)) {
            await trade.update({ highest_ltp: highest });
            trade.highest_ltp = highest;
        }
        const grossPl = calculateGrossPl(ltp, avgBuy, qty, lotSize);
        const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
        const mainNet = grossPl - charges;
        const hedgeNet = hedgeOpenNet(trade, lotSize, config);
        const netPl = mainNet + hedgeNet;

        recordNiftyPriceTick(String(trade.id), ltp);

        if (trade.exit_halted) {
            await logNiftyAudit({
                action: 'LIVE_ORDER_FAIL',
                reason: 'EXIT_HALTED',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                engineState: 'IN_TRADE',
                config,
                metadata: {
                    ltp,
                    retries: trade.exit_retry_count,
                    lastError: trade.last_order_error,
                },
            });
            return 'HALTED';
        }

        if (trade.exit_pending) {
            const closed = await closeNiftyScalpTrade({
                trade,
                position,
                config,
                exitReason:
                    trade.pending_exit_reason || trade.exit_reason || 'EXIT',
            });
            return closed ? 'SCANNING' : 'EXIT_PENDING';
        }

        if (config.mode === 'live' && !trade.broker_confirmed) {
            await logNiftyAudit({
                action: 'HOLD',
                reason: 'WAITING_ENTRY_CONFIRM',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                engineState: 'IN_TRADE',
                config,
                metadata: { entryOrderId: trade.entry_order_id },
            });
            return 'IN_TRADE';
        }

        await logNiftyAudit({
            action: 'HOLD',
            reason: 'MONITORING_TARGET',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            engineState: 'IN_TRADE',
            config,
            metadata: {
                ltp,
                avgBuy,
                qty,
                target,
                mainNet,
                hedgeNet,
                netPl,
                pointsFromAvg: Number((ltp - avgBuy).toFixed(2)),
                thinking: `Holding ${qty} lot(s). LTP ${ltp}, avg ${avgBuy}, guideTarget ${target.toFixed(2)}, combinedNet≈${netPl.toFixed(2)} (main≈${mainNet.toFixed(2)}, hedge≈${hedgeNet.toFixed(2)})`,
            },
        });

        const ageMin =
            (Date.now() - new Date(trade.createdAt).getTime()) / 60000;
        const netAtPrice = (price: number) =>
            calculateGrossPl(price, avgBuy, qty, lotSize) - charges + hedgeNet;
        const peakNet = netAtPrice(highest);
        const trailArmed = peakNet >= config.target_profit_rs;

        const exitNow = async (exitReason: string): Promise<NiftyEngineState> => {
            await closeNiftyScalpTrade({ trade, position, config, exitReason });
            return 'SCANNING';
        };

        // 1. Hard point stop: caps the loss on every trade.
        if (ltp <= avgBuy - NIFTY_STOP_POINTS) {
            return exitNow(`STOP_LOSS_${NIFTY_STOP_POINTS}PT`);
        }

        // 2. Net-loss backstop (gap through the stop, or a legacy hedged trade).
        if (netPl <= -NIFTY_SOFT_LOSS_RS) {
            return exitNow('SOFT_NET_LOSS');
        }

        // 3. Profit cap.
        if (netPl >= NIFTY_PROFIT_CAP_RS) {
            return exitNow('TARGET_HIT');
        }

        // 4. Trailing exit once net profit has reached the target.
        if (trailArmed) {
            const floorPrice = priceForNet(
                avgBuy,
                qty,
                lotSize,
                config,
                NIFTY_TRAIL_FLOOR_RS,
                hedgeNet,
            );
            const trailStop = Math.max(highest - NIFTY_TRAIL_POINTS, floorPrice);
            if (ltp <= trailStop) {
                return exitNow('TRAIL_PROFIT_EXIT');
            }
            if (ageMin >= NIFTY_TRAIL_MAX_MINUTES) {
                return exitNow('TARGET_TIME_CAP');
            }
        } else {
            // 5. No follow-through: never reached +N points within M minutes.
            if (
                ageMin >= NIFTY_NO_FOLLOW_MINUTES &&
                highest < avgBuy + NIFTY_NO_FOLLOW_POINTS
            ) {
                return exitNow('NO_FOLLOW_THROUGH');
            }

            // 6. Nifty trend flipped against the side while the trade is under water.
            if (ageMin >= NIFTY_SPOT_FLIP_MIN_MINUTES && netPl < 0) {
                const side =
                    String(trade.instrument_type).toUpperCase() === 'PE'
                        ? 'PE'
                        : 'CE';
                if (!(await this.spotTrendStillOk(side, config))) {
                    return exitNow('SPOT_TREND_FLIP');
                }
            }
        }

        const formattedDate = currentISTDate.toISOString().slice(0, 10);
        const eodCheck = buildMarketTime(formattedDate, EOD_CHECK_TIME);
        if (currentISTDate >= eodCheck && trade.eod_decision !== 'CARRY') {
            if (netPl >= 0) {
                await closeNiftyScalpTrade({
                    trade,
                    position,
                    config,
                    exitReason: 'EOD_1510_NOT_IN_LOSS',
                });
                return 'SCANNING';
            }
            if (netPl <= -EOD_LOSS_CHOICE_RS && trade.eod_decision !== 'REQUIRED') {
                await trade.update({ eod_decision: 'REQUIRED' });
                notifyNiftyEvent(
                    'EOD_DECISION',
                    `Loss ₹${Math.abs(netPl).toFixed(0)} after 3:10. Choose carry or manual sell.`,
                    { tradeId: trade.id, netPl },
                );
            }
        }

        // One lot per trade: no averaging down, no Plan B.
        return 'IN_TRADE';
    }

    /** 1-minute Nifty trend check, cached for a few seconds so ticks do not hammer the DB. */
    private spotFlipCache = new Map<string, { at: number; ok: boolean }>();

    private async spotTrendStillOk(
        side: 'CE' | 'PE',
        config: Awaited<ReturnType<typeof getNiftyScalpConfig>>,
    ): Promise<boolean> {
        const cached = this.spotFlipCache.get(side);
        if (cached && Date.now() - cached.at < 15_000) return cached.ok;
        const trend = await spotTrendAllows(
            config.underlying_instrument_key,
            side,
            config,
        );
        this.spotFlipCache.set(side, { at: Date.now(), ok: trend.ok });
        return trend.ok;
    }

    private async scanForEntry(
        config: Awaited<ReturnType<typeof getNiftyScalpConfig>>,
        currentISTDate: Date,
    ): Promise<NiftyEngineState> {
        const formattedDate = currentISTDate.toISOString().slice(0, 10);

        const quietUntil = buildMarketTime(
            formattedDate,
            NIFTY_ENTRY_QUIET_UNTIL,
        );
        if (currentISTDate < quietUntil) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'BEFORE_0945_NO_ENTRY',
                engineState: 'SCANNING',
                config,
                metadata: {
                    thinking: 'Skip open chaos until 09:45 IST.',
                },
            });
            return 'SCANNING';
        }

        const dayLimit = await this.dayLimitReason();
        if (dayLimit) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: dayLimit.reason,
                engineState: 'SCANNING',
                config,
                metadata: dayLimit.metadata,
            });
            return 'SCANNING';
        }

        const expiry = await get_upcoming_expiry_date(INDEXES_NAMES.NIFTY_50);
        const expiryDay = expiry ? moment(expiry).format('YYYY-MM-DD') : '';
        const expiryCutoff = buildMarketTime(
            formattedDate,
            EXPIRY_NO_NEW_ENTRY_AFTER,
        );
        if (expiryDay === formattedDate && currentISTDate >= expiryCutoff) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'EXPIRY_DAY_AFTER_1130_NO_NEW_ENTRY',
                engineState: 'SCANNING',
                config,
                metadata: { expiry: expiryDay },
            });
            return 'SCANNING';
        }

        const noNewAfter = buildMarketTime(formattedDate, NO_NEW_ENTRY_AFTER);
        if (currentISTDate >= noNewAfter) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'AFTER_1430_NO_NEW_ENTRY',
                engineState: 'SCANNING',
                config,
            });
            return 'SCANNING';
        }

        const gate = await canOpenNewTrade(
            STRATEGY.NIFTY_OPTIONS_SCALP,
            config,
            currentISTDate,
        );
        if (!gate.ok) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: gate.reason,
                engineState: 'SCANNING',
                config,
            });
            return 'SCANNING';
        }

        if (!expiry) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'NO_EXPIRY',
                engineState: 'SCANNING',
                config,
            });
            return 'SCANNING';
        }

        let spot = 0;
        try {
            spot = await current_strike_price(INDEXES.NIFTY_50);
        } catch (err: any) {
            logger.error(`Nifty spot fetch failed: ${err.message}`);
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'SPOT_FETCH_FAIL',
                engineState: 'SCANNING',
                config,
            });
            return 'SCANNING';
        }

        const balance = await getNiftyStrategyBalance(config);
        const signal = await evaluateNiftyOptionSignal(
            config,
            spot,
            expiry,
            balance,
        );

        await logNiftyAudit({
            action: 'SIGNAL_EVAL',
            reason: signal.reason,
            signal: signal.signal === 'NONE' ? 'NONE' : signal.signal,
            instrumentKey: signal.instrument?.instrument_key,
            engineState: 'SCANNING',
            config,
            indicators: signal.indicators,
            metadata: {
                spot,
                expiry,
                balance,
                hedgeKey: signal.hedgeInstrument?.instrument_key,
                thinking: `Signal=${signal.signal}. Reason=${signal.reason}`,
            },
        });

        if (
            signal.signal === 'NONE' ||
            !signal.instrument ||
            (NIFTY_HEDGE_ENABLED && !signal.hedgeInstrument)
        ) {
            return 'SCANNING';
        }

        await openNiftyScalpEntry({
            option: signal.instrument,
            hedgeOption: signal.hedgeInstrument,
            signal: signal.signal,
            config,
            reason: signal.reason,
            indicators: signal.indicators,
        });

        return 'IN_TRADE';
    }

    async getStatus() {
        const config = await getNiftyScalpConfig();
        const balance = await getNiftyStrategyBalance(config);
        const position = await this.getActivePosition();
        const trade = position
            ? await this.getActiveTrade(position.id)
            : null;
        const hedgingCount = await db[MODEL.HEDGING_OPTIONS].count({
            where: { name: INDEXES_NAMES.NIFTY_50 },
        });
        const expiry = await get_upcoming_expiry_date(INDEXES_NAMES.NIFTY_50);

        return {
            strategy: STRATEGY.NIFTY_OPTIONS_SCALP,
            config: {
                mode: config.mode,
                is_active: config.is_active,
                target_profit_rs: config.target_profit_rs,
                add_lot_points: config.add_lot_points,
                enable_plan_b: false,
                enable_overnight_carry: config.enable_overnight_carry,
                paper_balance: config.paper_balance,
                max_lots: NIFTY_MAX_LOTS,
                soft_loss_rs: NIFTY_SOFT_LOSS_RS,
                stop_points: NIFTY_STOP_POINTS,
                trail_points: NIFTY_TRAIL_POINTS,
                trail_floor_rs: NIFTY_TRAIL_FLOOR_RS,
                profit_cap_rs: NIFTY_PROFIT_CAP_RS,
                daily_max_loss_rs: NIFTY_DAILY_MAX_LOSS_RS,
                daily_profit_lock_rs: NIFTY_DAILY_PROFIT_LOCK_RS,
                daily_max_trades: NIFTY_DAILY_MAX_TRADES,
            },
            balance,
            expiry,
            hedgingCount,
            position,
            trade,
            now: moment().toISOString(),
        };
    }
}

export const niftyScalpEngine = new NiftyScalpEngine();
