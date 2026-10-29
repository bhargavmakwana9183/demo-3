import moment from 'moment';
import { Op } from 'sequelize';
import { MODEL, STRATEGY, INDEXES, INDEXES_NAMES } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';
import {
    current_strike_price,
    getCurrentISTDate,
} from '../helpers/stock.helper';
import {
    expiryForInstrument,
    getNiftyExpiryPlan,
    mustNotCarryOvernight,
    optionExpiresToday,
} from '../helpers/nifty.expiry.helper';
import { buildMarketTime, canOpenNewTrade } from '../helpers/scalping.risk.helper';
import {
    NIFTY_BREAKEVEN_ARM_RS,
    NIFTY_BREAKEVEN_FAST_DROP_POINTS,
    NIFTY_COOLDOWN_AFTER_LOSS_MIN,
    NIFTY_DAILY_MAX_LOSS_RS,
    NIFTY_DAILY_MAX_TRADES,
    NIFTY_DAILY_PROFIT_LOCK_RS,
    NIFTY_ENTRY_QUIET_UNTIL,
    NIFTY_HEDGE_ENABLED,
    NIFTY_MAX_LOTS,
    NIFTY_PROFIT_CAP_RS,
    NIFTY_SCRATCH_RS,
    NIFTY_SOFT_LOSS_RS,
    NIFTY_STOP_POINTS,
    NIFTY_TRAIL_ARM_RS,
    NIFTY_TRAIL_FLOOR_RS,
    NIFTY_TRAIL_POINTS,
    getNiftyScalpConfig,
    getNiftyStrategyBalance,
    calculateGrossPl,
    calculateRoundTripCharges,
} from '../helpers/nifty.scalp.config.helper';
import {
    niftyDayLimitReason,
    niftyDayStats,
    planNiftyExit,
} from '../helpers/nifty.scalp.rules';
import {
    evaluateNiftyOptionSignal,
    explainSignal,
    spotTrendAllows,
} from '../helpers/nifty.scalp.signal.helper';
import {
    closeNiftyScalpTrade,
    getEntryCooldownRemainingMs,
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

    /**
     * Ticks arrive every second but placing an order can take up to ~30s.
     * Never run two ticks at once: a second tick would act on a half-finished
     * order (for example send another SELL).
     */
    private runningSince = 0;
    private lastHaltLogAt = 0;
    private static readonly RUN_STALE_MS = 120_000;

    async run(): Promise<NiftyEngineState> {
        if (
            this.runningSince &&
            Date.now() - this.runningSince < NiftyScalpEngine.RUN_STALE_MS
        ) {
            return 'IN_TRADE';
        }
        this.runningSince = Date.now();
        try {
            return await this.runOnce();
        } finally {
            this.runningSince = 0;
        }
    }

    private async runOnce(): Promise<NiftyEngineState> {
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
            if (position) {
                const overnightTrade = await this.getActiveTrade(position.id);
                const optionExpiry = overnightTrade
                    ? await expiryForInstrument(overnightTrade.instrument_key)
                    : null;
                if (
                    overnightTrade &&
                    mustNotCarryOvernight(optionExpiry, formattedDate)
                ) {
                    await logNiftyAudit({
                        action: 'EXIT_DECISION',
                        reason: 'EOD_BEFORE_EXPIRY',
                        tradeId: overnightTrade.id,
                        instrumentKey: overnightTrade.instrument_key,
                        engineState: 'EXITING',
                        config,
                        skipThrottle: true,
                        metadata: {
                            optionExpiry,
                            thinking: `This option expires ${optionExpiry}. I will not carry it into expiry day, so I flatten now.`,
                        },
                    });
                    await closeNiftyScalpTrade({
                        trade: overnightTrade,
                        position,
                        config,
                        exitReason: 'EOD_BEFORE_EXPIRY',
                    });
                    return 'SCANNING';
                }
            }
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
            const openTrade = await this.getActiveTrade(position.id);
            if (openTrade) {
                const optionExpiry = await expiryForInstrument(
                    openTrade.instrument_key,
                );
                if (optionExpiresToday(optionExpiry, formattedDate)) {
                    await logNiftyAudit({
                        action: 'EXIT_DECISION',
                        reason: 'EXPIRY_DAY_FLAT_THIS_WEEK',
                        tradeId: openTrade.id,
                        instrumentKey: openTrade.instrument_key,
                        engineState: 'EXITING',
                        config,
                        skipThrottle: true,
                        metadata: {
                            optionExpiry,
                            thinking: `This option expires today (${optionExpiry}). Expiry-day entries use next week only, so I flatten this-week leftover now.`,
                        },
                    });
                    await closeNiftyScalpTrade({
                        trade: openTrade,
                        position,
                        config,
                        exitReason: 'EXPIRY_DAY_FLAT_THIS_WEEK',
                    });
                    return 'SCANNING';
                }
            }
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
        return niftyDayStats(
            closed.map((t) => ({
                net: Number(t.net_pl ?? t.pl ?? 0),
                closedAt: new Date(t.updatedAt),
            })),
        );
    }

    /** Day-level protection. Returns a skip reason, or null when trading is allowed. */
    private async dayLimitReason(): Promise<{
        reason: string;
        metadata: Record<string, unknown>;
    } | null> {
        const stats = await this.todayLossStats();
        const metadata = {
            ...stats,
            lastLossAt: stats.lastLossAt?.toISOString(),
            scratchRs: NIFTY_SCRATCH_RS,
        };
        const reason = niftyDayLimitReason(stats, new Date());
        if (!reason) return null;
        const thinking =
            reason === 'COOLDOWN_AFTER_LOSS'
                ? `Last real loss (net beyond ±₹${NIFTY_SCRATCH_RS}) was at ${stats.lastLossAt?.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}. Waiting ${NIFTY_COOLDOWN_AFTER_LOSS_MIN} min before a new entry. Scratches from charges do not start this cooldown.`
                : `Day limit ${reason}: net ₹${stats.dayNet.toFixed(0)}, trades ${stats.tradeCount}, losses ${stats.lossCount}, scratches ${stats.scratchCount}.`;
        return { reason, metadata: { ...metadata, thinking } };
    }

    /**
     * Close of the last fully finished 1-minute candle while this trade has
     * been open. The current minute is still forming, so it is ignored.
     */
    private async lastCompletedMinuteClose(
        instrumentKey: string,
        enteredAt: Date,
    ): Promise<number | null> {
        const lastClosedStart = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
        const entryMinuteStart =
            Math.floor(new Date(enteredAt).getTime() / 60_000) * 60_000;
        if (lastClosedStart < entryMinuteStart) return null;
        const row = await db[MODEL.CANDELS].findOne({
            where: {
                instrument_key: instrumentKey,
                ts: { [Op.lte]: String(lastClosedStart) },
            },
            order: [['ts', 'DESC']],
        });
        if (!row || Number(row.ts) < entryMinuteStart) return null;
        const close = Number(row.close);
        return Number.isFinite(close) ? close : null;
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
            // Log once a minute, not every tick.
            if (Date.now() - this.lastHaltLogAt > 60_000) {
                this.lastHaltLogAt = Date.now();
                await logNiftyAudit({
                    action: 'LIVE_ORDER_FAIL',
                    reason: 'EXIT_HALTED',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    engineState: 'HALTED',
                    config,
                    skipThrottle: true,
                    metadata: {
                        ltp,
                        retries: trade.exit_retry_count,
                        lastError: trade.last_order_error,
                        thinking: `Exit is HALTED after ${trade.exit_retry_count} failed SELL attempts (last error: ${trade.last_order_error}). The position is still open at Upstox and the engine will not send more orders. Square it off manually on Upstox.`,
                    },
                });
            }
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

        const ageMin =
            (Date.now() - new Date(trade.createdAt).getTime()) / 60000;
        const lastMinuteClose = await this.lastCompletedMinuteClose(
            trade.instrument_key,
            trade.createdAt,
        );
        const plan = planNiftyExit({
            ltp,
            avgBuy,
            highest,
            qty,
            lotSize,
            hedgeNet,
            ageMin,
            config,
            lastMinuteClose,
        });
        const { peakNet, breakevenPrice, trailFloorPrice, protection, stage } =
            plan;

        await this.recordStopMove({
            trade,
            config,
            stage,
            newStop: plan.newStop,
            ltp,
            avgBuy,
            highest,
            peakNet,
            netPl,
            breakevenPrice,
            trailFloorPrice,
        });

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
                highest,
                peakNet: Number(peakNet.toFixed(2)),
                stage,
                lastMinuteClose,
                thinking: `Holding ${qty} lot(s). LTP ${ltp}, bought ${avgBuy}, peak ${highest}, open net ₹${netPl.toFixed(2)}. ${protection}.`,
            },
        });


        const exitNow = async (
            exitReason: string,
            why: string,
        ): Promise<NiftyEngineState> => {
            // Record the decision with the numbers it was based on, BEFORE any order.
            await logNiftyAudit({
                action: 'EXIT_DECISION',
                reason: exitReason,
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                engineState: 'EXITING',
                config,
                skipThrottle: true,
                metadata: {
                    ltp,
                    avgBuy,
                    highest,
                    netPl: Number(netPl.toFixed(2)),
                    ageMin: Number(ageMin.toFixed(1)),
                    thinking: `Exit decided: ${why} (LTP ${ltp}, bought ${avgBuy}, peak ${highest}, open net ₹${netPl.toFixed(2)}, held ${ageMin.toFixed(1)} min). Closing the whole position now.`,
                },
            });
            await closeNiftyScalpTrade({ trade, position, config, exitReason });
            return 'SCANNING';
        };

        if (plan.exit) {
            return exitNow(plan.exit.reason, plan.exit.why);
        }

        if (plan.checkSpotFlip) {
            const side =
                String(trade.instrument_type).toUpperCase() === 'PE'
                    ? 'PE'
                    : 'CE';
            if (!(await this.spotTrendStillOk(side, config))) {
                return exitNow(
                    'SPOT_TREND_FLIP',
                    `Nifty's 1-minute trend turned against this ${side} while the trade is losing`,
                );
            }
        }

        const formattedDate = currentISTDate.toISOString().slice(0, 10);
        const eodCheck = buildMarketTime(formattedDate, EOD_CHECK_TIME);
        if (currentISTDate >= eodCheck) {
            const optionExpiry = await expiryForInstrument(trade.instrument_key);
            if (mustNotCarryOvernight(optionExpiry, formattedDate)) {
                return exitNow(
                    'EOD_BEFORE_EXPIRY',
                    `this option expires ${optionExpiry}, so I flatten at 15:10 and do not carry it into expiry day`,
                );
            }
            if (trade.eod_decision !== 'CARRY') {
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
        }

        // One lot per trade: no averaging down, no Plan B.
        return 'IN_TRADE';
    }

    /** Last stop level written to the audit log, per trade. */
    private lastStopLogged = new Map<string, { stop: number; stage: string }>();

    /**
     * The stop only moves up. Saves the current stop on the trade (shown in
     * positions) and writes a STOP_UPDATED audit row when the stop is first
     * set, when the stage changes, or when it has risen ≥ STOP_LOG_STEP_POINTS
     * since the last row (so a rise of 0.05 per tick does not flood the log).
     */
    private static readonly STOP_LOG_STEP_POINTS = 0.5;

    private async recordStopMove(input: {
        trade: any;
        config: Awaited<ReturnType<typeof getNiftyScalpConfig>>;
        stage: 'INITIAL' | 'BREAKEVEN' | 'TRAILING';
        newStop: number;
        ltp: number;
        avgBuy: number;
        highest: number;
        peakNet: number;
        netPl: number;
        breakevenPrice: number;
        trailFloorPrice: number;
    }) {
        const { trade, config, stage, ltp, avgBuy, highest, peakNet, netPl } = input;
        const newStop = Number(input.newStop.toFixed(2));
        const savedStop = Number(trade.stop_loss || 0);
        const key = String(trade.id);

        // Stage the saved stop belongs to (survives a restart).
        const savedStage =
            savedStop <= 0
                ? 'NONE'
                : savedStop >= input.trailFloorPrice - 0.01
                  ? 'TRAILING'
                  : savedStop >= input.breakevenPrice - 0.01
                    ? 'BREAKEVEN'
                    : 'INITIAL';
        const last = this.lastStopLogged.get(key) ?? {
            stop: savedStop,
            stage: savedStage,
        };

        if (savedStop > 0 && newStop <= savedStop + 0.004) return;

        await trade.update({ stop_loss: newStop });
        trade.stop_loss = newStop;

        const stageChanged = last.stage !== stage;
        const roseEnough =
            newStop - last.stop >= NiftyScalpEngine.STOP_LOG_STEP_POINTS;
        if (!stageChanged && !roseEnough && last.stage !== 'NONE') return;

        this.lastStopLogged.set(key, { stop: newStop, stage });
        const lotSize = Number(trade.lot_size);
        const qty = Number(trade.qty);
        const lockedNet =
            (newStop - avgBuy) * lotSize * qty -
            calculateRoundTripCharges(qty, lotSize, avgBuy, config);

        let thinking: string;
        if (last.stage === 'NONE' || savedStop <= 0) {
            thinking = `Initial stop set at ${newStop} (entry ${avgBuy} − ${NIFTY_STOP_POINTS} pts). Worst case if hit ≈ ₹${lockedNet.toFixed(0)} net.`;
        } else if (stageChanged && stage === 'BREAKEVEN') {
            thinking = `Peak net reached ₹${peakNet.toFixed(0)} (≥ ₹${NIFTY_BREAKEVEN_ARM_RS}), so the stop moved UP from ${last.stop} to breakeven ${newStop}. Exit if a 1-minute candle closes at or below that, or at once if price drops ${NIFTY_BREAKEVEN_FAST_DROP_POINTS} pts under it. This trade can no longer turn into a full loss (apart from slippage).`;
        } else if (stageChanged && stage === 'TRAILING') {
            thinking = `Peak net reached ₹${peakNet.toFixed(0)} (≥ ₹${NIFTY_TRAIL_ARM_RS}), so trailing started: stop moved UP from ${last.stop} to ${newStop}, which locks about ₹${lockedNet.toFixed(0)} net. From here it follows the peak − ${NIFTY_TRAIL_POINTS} pts.`;
        } else {
            thinking = `New high ${highest}: trailing stop moved UP from ${last.stop} to ${newStop} (peak − ${NIFTY_TRAIL_POINTS} pts), now locking about ₹${lockedNet.toFixed(0)} net.`;
        }

        await logNiftyAudit({
            action: 'STOP_UPDATED',
            reason:
                last.stage === 'NONE' || savedStop <= 0
                    ? 'STOP_INITIAL'
                    : stageChanged
                      ? `STOP_TO_${stage}`
                      : 'STOP_TRAILED_UP',
            instrumentKey: trade.instrument_key,
            tradeId: trade.id,
            engineState: 'IN_TRADE',
            config,
            skipThrottle: true,
            metadata: {
                stage,
                oldStop: last.stop || null,
                newStop,
                ltp,
                avgBuy,
                highest,
                peakNet: Number(peakNet.toFixed(2)),
                openNet: Number(netPl.toFixed(2)),
                lockedNet: Number(lockedNet.toFixed(2)),
                thinking,
            },
        });
        notifyNiftyEvent(
            'STOP_UPDATED',
            `Stop ${stage === 'INITIAL' ? 'set' : 'moved up'} to ${newStop} (${stage})`,
            { tradeId: trade.id, newStop, stage },
        );
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

        const cooldownMs = getEntryCooldownRemainingMs();
        if (cooldownMs > 0) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'ENTRY_RETRY_COOLDOWN',
                engineState: 'SCANNING',
                config,
                metadata: {
                    remainingSec: Math.ceil(cooldownMs / 1000),
                    thinking: `The last live BUY failed. Waiting ${Math.ceil(cooldownMs / 1000)}s more before looking for a new entry, so the same signal is not retried every second.`,
                },
            });
            return 'SCANNING';
        }

        const expiryPlan = await getNiftyExpiryPlan(formattedDate);
        const expiry = expiryPlan.tradeExpiry;
        // Safety only: if we were still pointing at today's expiry, stop new
        // entries at 11:30. Next-week contracts use the normal 14:30 cutoff.
        if (
            expiryPlan.isExpiryDay &&
            expiry === formattedDate &&
            currentISTDate >=
                buildMarketTime(formattedDate, EXPIRY_NO_NEW_ENTRY_AFTER)
        ) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'EXPIRY_DAY_AFTER_1130_NO_NEW_ENTRY',
                engineState: 'SCANNING',
                config,
                metadata: {
                    expiry,
                    thinking:
                        'Still on today\'s expiry (next week missing). No new entries after 11:30.',
                },
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
                isExpiryDay: expiryPlan.isExpiryDay,
                nearestExpiry: expiryPlan.nearestExpiry,
                balance,
                hedgeKey: signal.hedgeInstrument?.instrument_key,
                sides: signal.sides,
                thinking: expiryPlan.isExpiryDay
                    ? `${explainSignal(signal)} Expiry day: trading ${expiry}, not today's ${expiryPlan.nearestExpiry}.`
                    : explainSignal(signal),
            },
        });

        if (
            signal.signal === 'NONE' ||
            !signal.instrument ||
            (NIFTY_HEDGE_ENABLED && !signal.hedgeInstrument)
        ) {
            return 'SCANNING';
        }

        // One trade per signal candle. The feed delivers the last COMPLETED
        // 1-minute candle, so the same cross stays "true" for a whole minute.
        // Any trade opened after that candle closed has already used it.
        const signalCandleTs = Number(signal.indicators?.signalCandleTs || 0);
        if (signalCandleTs > 0) {
            const candleClosedAt = new Date(signalCandleTs + 60_000);
            const usedBy = await db[MODEL.TRADE].findOne({
                where: {
                    strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
                    createdAt: { [Op.gte]: candleClosedAt },
                },
                order: [['createdAt', 'DESC']],
            });
            if (usedBy) {
                await logNiftyAudit({
                    action: 'SKIP',
                    reason: 'SIGNAL_CANDLE_ALREADY_TRADED',
                    signal: signal.signal,
                    instrumentKey: signal.instrument.instrument_key,
                    engineState: 'SCANNING',
                    config,
                    indicators: signal.indicators,
                    metadata: {
                        signalCandle: moment(signalCandleTs).format('HH:mm'),
                        usedByTrade: usedBy.trade_id,
                        thinking: `${signal.signal} is still showing, but it comes from the ${moment(signalCandleTs).format('HH:mm')} candle, which trade ${usedBy.trade_id} already traded. Waiting for a NEW cross instead of re-entering on the same signal.`,
                    },
                });
                return 'SCANNING';
            }
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
        const expiryPlan = await getNiftyExpiryPlan();

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
                trail_arm_rs: NIFTY_TRAIL_ARM_RS,
                breakeven_arm_rs: NIFTY_BREAKEVEN_ARM_RS,
                breakeven_fast_drop_points: NIFTY_BREAKEVEN_FAST_DROP_POINTS,
                scratch_rs: NIFTY_SCRATCH_RS,
                profit_cap_rs: NIFTY_PROFIT_CAP_RS,
                daily_max_loss_rs: NIFTY_DAILY_MAX_LOSS_RS,
                daily_profit_lock_rs: NIFTY_DAILY_PROFIT_LOCK_RS,
                daily_max_trades: NIFTY_DAILY_MAX_TRADES,
            },
            balance,
            expiry: expiryPlan.tradeExpiry,
            nearestExpiry: expiryPlan.nearestExpiry,
            tradeExpiry: expiryPlan.tradeExpiry,
            subscribeExpiries: expiryPlan.subscribeExpiries,
            isExpiryDay: expiryPlan.isExpiryDay,
            hedgingCount,
            position,
            trade,
            now: moment().toISOString(),
        };
    }
}

export const niftyScalpEngine = new NiftyScalpEngine();
