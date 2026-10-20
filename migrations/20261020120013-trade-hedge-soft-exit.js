'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('trade_details');
        const columns = {
            hedge_instrument_key: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            hedge_trading_symbol: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            hedge_buy_price: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            hedge_qty: {
                type: Sequelize.FLOAT,
                allowNull: false,
                defaultValue: 0,
            },
            hedge_ltp: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            hedge_entry_order_id: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            soft_under_avg_at: {
                type: Sequelize.DATE,
                allowNull: true,
            },
        };
        for (const [name, spec] of Object.entries(columns)) {
            if (!table[name]) {
                await queryInterface.addColumn('trade_details', name, spec);
            }
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('trade_details');
        for (const name of [
            'soft_under_avg_at',
            'hedge_entry_order_id',
            'hedge_ltp',
            'hedge_qty',
            'hedge_buy_price',
            'hedge_trading_symbol',
            'hedge_instrument_key',
        ]) {
            if (table[name]) {
                await queryInterface.removeColumn('trade_details', name);
            }
        }
    },
};
