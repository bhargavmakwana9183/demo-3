import moment from 'moment';
import { Op } from 'sequelize';
import { MODEL, STRATEGY } from '../constant';
import { db } from '../model';
import { logger } from '../logger/logger';

export type TradeLegType =
    | 'ENTRY'
    | 'MANUAL_ENTRY'
    | 'ADD_LOT'
    | 'PARTIAL_SELL'
    | 'FULL_EXIT';

export type TradeLegSide = 'BUY' | 'SELL';

export const recordTradeLeg = async (input: {
    trade: any;
    legType: TradeLegType;
    side: TradeLegSide;
    lots: number;
    price: number;
    reason?: string | null;
    brokerOrderId?: string | null;
    mode?: string | null;
    grossPl?: number | null;
    netPl?: number | null;
    charges?: number | null;
    avgBuyAfter?: number | null;
    qtyAfter?: number | null;
    targetAfter?: number | null;
    metadata?: Record<string, unknown>;
}): Promise<any | null> => {
    try {
        const trade = input.trade;
        if (!trade?.id) return null;

        const lotSize = Number(trade.lot_size || 0);
        const lots = Number(input.lots || 0);
        const row = await db[MODEL.TRADE_LEG_HISTORY].create({
            trade_uuid: trade.id,
            trade_ref: String(trade.trade_id || ''),
            position_id: trade.position_id || null,
            strategy_name:
                trade.strategy_name || STRATEGY.NIFTY_OPTIONS_SCALP,
            leg_type: input.legType,
            side: input.side,
            lots,
            lot_size: lotSize || null,
            quantity: lotSize > 0 ? lots * lotSize : null,
            price: Number(input.price || 0),
            avg_buy_after:
                input.avgBuyAfter != null
                    ? Number(input.avgBuyAfter)
                    : Number(trade.buy_price || 0),
            qty_after:
                input.qtyAfter != null
                    ? Number(input.qtyAfter)
                    : Number(trade.qty || 0),
            target_after:
                input.targetAfter != null
                    ? Number(input.targetAfter)
                    : Number(trade.target_price || 0),
            gross_pl: input.grossPl != null ? Number(input.grossPl) : null,
            net_pl: input.netPl != null ? Number(input.netPl) : null,
            charges: input.charges != null ? Number(input.charges) : null,
            broker_order_id: input.brokerOrderId || null,
            instrument_key: trade.instrument_key || null,
            trading_symbol: trade.trading_symbol || null,
            reason: input.reason || null,
            mode: input.mode || null,
            metadata: input.metadata || null,
            occurred_at: moment().toDate(),
        });
        return row;
    } catch (error: any) {
        logger.error(
            `recordTradeLeg failed: ${error?.message || error}`,
        );
        return null;
    }
};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value: string) => UUID_RE.test(String(value || '').trim());

const mapLegRow = (r: any) => {
    const plain = r.get ? r.get({ plain: true }) : r;
    return {
        id: plain.id,
        tradeUuid: plain.trade_uuid,
        tradeRef: plain.trade_ref,
        positionId: plain.position_id,
        strategyName: plain.strategy_name,
        legType: plain.leg_type,
        side: plain.side,
        lots: Number(plain.lots || 0),
        lotSize: Number(plain.lot_size || 0),
        quantity: Number(plain.quantity || 0),
        price: Number(plain.price || 0),
        avgBuyAfter: Number(plain.avg_buy_after || 0),
        qtyAfter: Number(plain.qty_after || 0),
        targetAfter: Number(plain.target_after || 0),
        grossPl: plain.gross_pl != null ? Number(plain.gross_pl) : null,
        netPl: plain.net_pl != null ? Number(plain.net_pl) : null,
        charges: plain.charges != null ? Number(plain.charges) : null,
        brokerOrderId: plain.broker_order_id,
        instrumentKey: plain.instrument_key,
        tradingSymbol: plain.trading_symbol,
        reason: plain.reason,
        mode: plain.mode,
        metadata: plain.metadata,
        occurredAt: plain.occurred_at,
        createdAt: plain.createdAt,
    };
};

export const getTradeLegsByTradeKey = async (
    tradeKey: string,
): Promise<any[]> => {
    if (!tradeKey) return [];

    // Frontend often sends short trade_ref (e.g. "440073") — never cast that to UUID
    const where = isUuid(tradeKey)
        ? { trade_uuid: tradeKey }
        : { trade_ref: String(tradeKey) };

    const rows = await db[MODEL.TRADE_LEG_HISTORY].findAll({
        where,
        order: [
            ['occurred_at', 'ASC'],
            ['createdAt', 'ASC'],
        ],
    });

    return rows.map(mapLegRow);
};

export const getTradeLegCounts = async (
    tradeKeys: string[],
): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    if (!tradeKeys.length) return counts;

    const unique = [...new Set(tradeKeys.map(String).filter(Boolean))];
    const uuids = unique.filter(isUuid);
    const refs = unique.filter((k) => !isUuid(k));

    const orClause: any[] = [];
    if (refs.length) orClause.push({ trade_ref: { [Op.in]: refs } });
    if (uuids.length) orClause.push({ trade_uuid: { [Op.in]: uuids } });
    if (!orClause.length) return counts;

    const rows = await db[MODEL.TRADE_LEG_HISTORY].findAll({
        where: { [Op.or]: orClause },
        attributes: ['trade_ref', 'trade_uuid'],
    });

    for (const row of rows) {
        const ref = String(row.trade_ref || '');
        const uuid = String(row.trade_uuid || '');
        if (ref) counts[ref] = (counts[ref] || 0) + 1;
        if (uuid) counts[uuid] = (counts[uuid] || 0) + 1;
    }
    return counts;
};
