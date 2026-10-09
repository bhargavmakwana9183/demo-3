import moment from 'moment';
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
    getNiftyScalpConfig,
    getNiftyStrategyBalance,
    calculateGrossPl,
    calculateRoundTripCharges,
} from '../helpers/nifty.scalp.config.helper';
import { evaluateNiftyOptionSignal } from '../helpers/nifty.scalp.signal.helper';
import {
    addNiftyScalpLot,
    closeNiftyScalpTrade,
    openNiftyScalpEntry,
} from '../helpers/nifty.scalp.trade.helper';
import { tryNiftyPlanB, recordNiftyPriceTick } from '../helpers/nifty.scalp.planb.helper';
import { logNiftyAudit } from '../helpers/nifty.scalp.audit.helper';
import { notifyNiftyEvent } from '../helpers/nifty.scalp.notify.helper';

const NO_NEW_ENTRY_AFTER = '14:30';
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

        // Overnight carry: outside market hours, keep position, do not force exit
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

        const ltp = Number(trade.ltp);
        const avgBuy = Number(trade.buy_price);
        const qty = Number(trade.qty);
        const lotSize = Number(trade.lot_size);
        const target = Number(trade.target_price);
        const grossPl = calculateGrossPl(ltp, avgBuy, qty, lotSize);
        const charges = calculateRoundTripCharges(qty, lotSize, avgBuy, config);
        const netPl = grossPl - charges;

        recordNiftyPriceTick(String(trade.id), ltp);

        // Live exit halted after max SELL failures — do not auto-manage
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
                    thinking:
                        'Exit HALTED. Trade stays OPEN in DB until manual Upstox square-off + reconcile.',
                },
            });
            return 'HALTED';
        }

        // Exit pending: retry / resume confirm — never paper-close
        if (trade.exit_pending) {
            await logNiftyAudit({
                action: 'HOLD',
                reason: 'EXIT_PENDING_RETRY',
                instrumentKey: trade.instrument_key,
                tradeId: trade.id,
                engineState: 'IN_TRADE',
                config,
                metadata: {
                    ltp,
                    exitOrderId: trade.exit_order_id,
                    retries: trade.exit_retry_count,
                    pendingReason: trade.pending_exit_reason,
                },
            });
            const closed = await closeNiftyScalpTrade({
                trade,
                position,
                config,
                exitReason:
                    trade.pending_exit_reason || trade.exit_reason || 'EXIT',
            });
            return closed ? 'SCANNING' : 'EXIT_PENDING';
        }

        // Live entry must be broker-confirmed before averaging / plan B
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
                netPl,
                pointsFromAvg: Number((ltp - avgBuy).toFixed(2)),
                thinking: `Holding ${qty} lot(s). LTP ${ltp}, avg ${avgBuy}, target ${target.toFixed(2)}, net≈${netPl.toFixed(2)}`,
            },
        });

        // Target hit: charges + ₹200 net
        if (ltp >= target && netPl >= config.target_profit_rs * 0.9) {
            await closeNiftyScalpTrade({
                trade,
                position,
                config,
                exitReason: 'TARGET_HIT',
            });
            return 'SCANNING';
        }

        const formattedDate = currentISTDate.toISOString().slice(0, 10);
        const eodCheck = buildMarketTime(formattedDate, EOD_CHECK_TIME);
        if (currentISTDate >= eodCheck && trade.eod_decision !== 'CARRY') {
            // Green or flat: sell the rest. Add-lot and Plan B stay available before this.
            if (netPl >= 0) {
                await closeNiftyScalpTrade({
                    trade,
                    position,
                    config,
                    exitReason: 'EOD_1510_NOT_IN_LOSS',
                });
                return 'SCANNING';
            }

            // Loss of ₹500 or worse: ask carry vs manual sell. Do not auto-close.
            if (netPl <= -EOD_LOSS_CHOICE_RS && trade.eod_decision !== 'REQUIRED') {
                await trade.update({ eod_decision: 'REQUIRED' });
                await logNiftyAudit({
                    action: 'HOLD',
                    reason: 'EOD_LOSS_CHOICE_REQUIRED',
                    instrumentKey: trade.instrument_key,
                    tradeId: trade.id,
                    engineState: 'IN_TRADE',
                    config,
                    metadata: {
                        netPl,
                        threshold: -EOD_LOSS_CHOICE_RS,
                        thinking:
                            'After 15:10, loss is ₹500 or worse. Waiting for carry or manual sell.',
                    },
                    skipThrottle: true,
                });
                notifyNiftyEvent(
                    'EOD_DECISION',
                    `Loss ₹${Math.abs(netPl).toFixed(0)} after 3:10. Choose carry forward or manual sell.`,
                    { tradeId: trade.id, netPl },
                );
            }
        }

        // Averaging: -10 points from avg buy
        if (ltp <= avgBuy - config.add_lot_points) {
            const added = await addNiftyScalpLot({ trade, position, config });
            if (added) return 'AVERAGING';
        }

        // Plan B recovery / opportunistic scalp
        const planB = await tryNiftyPlanB({ trade, position, config });
        if (planB) return 'RECOVERY';

        return 'IN_TRADE';
    }

    private async scanForEntry(
        config: Awaited<ReturnType<typeof getNiftyScalpConfig>>,
        currentISTDate: Date,
    ): Promise<NiftyEngineState> {
        const formattedDate = currentISTDate.toISOString().slice(0, 10);
        const noNewAfter = buildMarketTime(formattedDate, NO_NEW_ENTRY_AFTER);
        if (currentISTDate >= noNewAfter) {
            await logNiftyAudit({
                action: 'SKIP',
                reason: 'AFTER_1430_NO_NEW_ENTRY',
                engineState: 'SCANNING',
                config,
                metadata: {
                    thinking:
                        'After 14:30 with no open trade. Scan stopped. An open trade would still add, run Plan B, and watch the target.',
                },
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

        const expiry = await get_upcoming_expiry_date(INDEXES_NAMES.NIFTY_50);
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

        const signal = await evaluateNiftyOptionSignal(config, spot, expiry);

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
                thinking: `Evaluated ATM option candles. Signal=${signal.signal}. Reason=${signal.reason}`,
            },
        });

        if (signal.signal === 'NONE' || !signal.instrument) {
            return 'SCANNING';
        }

        await openNiftyScalpEntry({
            option: signal.instrument,
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
                enable_plan_b: config.enable_plan_b,
                enable_overnight_carry: config.enable_overnight_carry,
                paper_balance: config.paper_balance,
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
