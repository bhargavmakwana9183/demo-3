import { Op } from 'sequelize';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import { AuditAction, AuditLogInput, logScalpingDecision } from './scalping.audit.helper';
import { NiftyScalpConfig } from './nifty.scalp.config.helper';

export type NiftyAuditAction =
    | AuditAction
    | 'ENGINE_TICK'
    | 'SIGNAL_EVAL'
    | 'ADD_LOT'
    | 'CANNOT_ADD_LOT'
    | 'PLAN_B_START'
    | 'PLAN_B_REBUY'
    | 'PLAN_B_SCALP'
    | 'PLAN_B_MAX_LOSS'
    | 'TARGET_HIT'
    | 'CARRY_FORWARD'
    | 'LIVE_ORDER_FAIL'
    | 'CHAIN_SYNC'
    | 'HEDGING_SYNC'
    | 'ENTRY_FILLED'
    // Live order lifecycle: every step the system takes is recorded
    | 'ENTRY_ATTEMPT'
    | 'EXIT_DECISION'
    | 'ORDER_PLACING'
    | 'ORDER_PLACED'
    | 'ORDER_STATUS'
    | 'ORDER_FILLED'
    | 'ORDER_REJECTED'
    | 'ORDER_TIMEOUT'
    | 'ORDER_CANCEL'
    | 'ORDER_ADOPTED'
    | 'SAFETY_CHECK'
    | 'PRICE_CORRECTED'
    | 'MODE_TOGGLE';

const lastTickLogAt = new Map<string, number>();
const TICK_THROTTLE_MS = 8_000;

export const logNiftyAudit = async (input: {
    action: NiftyAuditAction;
    reason?: string | null;
    signal?: 'CE_BUY' | 'PE_BUY' | 'NONE' | null;
    instrumentKey?: string | null;
    tradeId?: string | null;
    engineState?: string | null;
    config?: NiftyScalpConfig | null;
    indicators?: AuditLogInput['indicators'];
    metadata?: Record<string, unknown>;
    skipThrottle?: boolean;
}): Promise<void> => {
    const alwaysLog = [
        'ENTER',
        'ENTRY_FILLED',
        'EXIT',
        'TARGET_HIT',
        'ADD_LOT',
        'CANNOT_ADD_LOT',
        'PLAN_B_START',
        'PLAN_B_SCALP',
        'PLAN_B_MAX_LOSS',
        'LIVE_ORDER_FAIL',
        'CARRY_FORWARD',
        'CHAIN_SYNC',
        'HEDGING_SYNC',
        'PARTIAL',
        'ENTRY_ATTEMPT',
        'EXIT_DECISION',
        'ORDER_PLACING',
        'ORDER_PLACED',
        'ORDER_STATUS',
        'ORDER_FILLED',
        'ORDER_REJECTED',
        'ORDER_TIMEOUT',
        'ORDER_CANCEL',
        'ORDER_ADOPTED',
        'PRICE_CORRECTED',
        'MODE_TOGGLE',
        'RECONCILE',
    ].includes(input.action);

    if (!alwaysLog && !input.skipThrottle) {
        const key = `${input.action}:${input.reason ?? ''}:${input.instrumentKey ?? ''}`;
        const now = Date.now();
        const last = lastTickLogAt.get(key) ?? 0;
        if (now - last < TICK_THROTTLE_MS) return;
        lastTickLogAt.set(key, now);
    }

    await logScalpingDecision({
        strategyName: STRATEGY.NIFTY_OPTIONS_SCALP,
        action: input.action as AuditAction,
        reason: input.reason,
        signal: input.signal,
        instrumentKey: input.instrumentKey,
        tradeId: input.tradeId,
        engineState: input.engineState,
        mode: input.config?.mode,
        config: input.config as any,
        indicators: input.indicators,
        metadata: input.metadata,
        skipThrottle: true,
    });
};

export const getNiftyAuditLogs = async ({
    days = 7,
    action,
    pageIndex = 1,
    pageSize = 20,
}: {
    days?: number;
    action?: string;
    pageIndex?: number;
    pageSize?: number;
}) => {
    const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
    const since = new Date();
    since.setDate(since.getDate() - safeDays);
    const where: Record<string, unknown> = {
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        timestamp: { [Op.gte]: since },
    };
    if (action) where.action = action;

    const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 20));
    const requestedPage = Math.max(1, Math.floor(pageIndex) || 1);

    const total = await db[MODEL.DECISION_AUDIT].count({ where });
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const safePage = Math.min(requestedPage, totalPages);

    const logs = await db[MODEL.DECISION_AUDIT].findAll({
        where,
        order: [['timestamp', 'DESC']],
        limit: safeSize,
        offset: (safePage - 1) * safeSize,
    });

    return {
        logs,
        total,
        pageIndex: safePage,
        pageSize: safeSize,
        totalPages,
    };
};
