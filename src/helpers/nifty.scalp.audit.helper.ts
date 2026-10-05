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
    | 'PLAN_B_SCALP'
    | 'TARGET_HIT'
    | 'CARRY_FORWARD'
    | 'LIVE_ORDER_FAIL'
    | 'CHAIN_SYNC'
    | 'HEDGING_SYNC'
    | 'ENTRY_FILLED';

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
        'PLAN_B_SCALP',
        'LIVE_ORDER_FAIL',
        'CARRY_FORWARD',
        'CHAIN_SYNC',
        'HEDGING_SYNC',
        'PARTIAL',
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
    limit = 100,
}: {
    days?: number;
    action?: string;
    limit?: number;
}) => {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const where: Record<string, unknown> = {
        strategy_name: STRATEGY.NIFTY_OPTIONS_SCALP,
        timestamp: { [Op.gte]: since },
    };
    if (action) where.action = action;

    return db[MODEL.DECISION_AUDIT].findAll({
        where,
        order: [['timestamp', 'DESC']],
        limit: Math.min(limit, 500),
    });
};
