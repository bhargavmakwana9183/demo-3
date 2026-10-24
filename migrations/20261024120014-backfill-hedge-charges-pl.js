'use strict';

/**
 * Closed hedged trades stored `pl` after hedge charges and `charges` for the main leg only.
 * Rewrite them so pl = gross of both legs, charges = both legs, net_pl unchanged (= pl − charges).
 */
module.exports = {
    async up(queryInterface) {
        const sequelize = queryInterface.sequelize;
        const [cfgRows] = await sequelize.query(
            `SELECT brokerage_per_lot, slippage_pct FROM strategy_config WHERE strategy_name = 'NIFTY_OPTIONS_SCALP' LIMIT 1`,
        );
        const brokerage = Number(cfgRows?.[0]?.brokerage_per_lot ?? 40);
        const slippage = Number(cfgRows?.[0]?.slippage_pct ?? 0.002);

        const [trades] = await sequelize.query(
            `SELECT id, pl, charges, net_pl, lot_size, hedge_buy_price, hedge_qty
             FROM trade_details
             WHERE strategy_name = 'NIFTY_OPTIONS_SCALP'
               AND is_active = false
               AND hedge_buy_price IS NOT NULL
               AND hedge_trading_symbol IS NOT NULL`,
        );

        for (const t of trades) {
            const lots = Math.max(Number(t.hedge_qty || 0), 1);
            const lotSize = Number(t.lot_size || 0);
            const hedgeBuy = Number(t.hedge_buy_price || 0);
            if (!(lotSize > 0) || !(hedgeBuy > 0)) continue;

            const hedgeCharges = Number(
                (brokerage * lots * 2 + hedgeBuy * lotSize * lots * slippage * 2).toFixed(2),
            );
            const oldPl = Number(t.pl || 0);
            const oldCharges = Number(t.charges || 0);
            const newPl = Number((oldPl + hedgeCharges).toFixed(4));
            const newCharges = Number((oldCharges + hedgeCharges).toFixed(4));

            // Runs once via SequelizeMeta. Run it before restarting the backend with the new close logic.
            await sequelize.query(
                `UPDATE trade_details SET pl = :newPl, charges = :newCharges WHERE id = :id`,
                { replacements: { newPl, newCharges, id: t.id } },
            );
            await sequelize.query(
                `UPDATE trade_leg_history
                 SET gross_pl = COALESCE(gross_pl, 0) + :hc,
                     charges = COALESCE(charges, 0) + :hc
                 WHERE trade_uuid = :id AND leg_type = 'FULL_EXIT'`,
                { replacements: { hc: hedgeCharges, id: t.id } },
            );
        }
    },

    async down() {
        // Data fix only; the original split is not restored.
    },
};
