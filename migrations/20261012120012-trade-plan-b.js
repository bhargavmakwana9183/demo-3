'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('trade_details');
        const columns = {
            plan_b_started: {
                type: Sequelize.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            plan_b_scalp_lots: {
                type: Sequelize.FLOAT,
                allowNull: false,
                defaultValue: 0,
            },
            plan_b_last_sell_price: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            plan_b_scalp_open: {
                type: Sequelize.FLOAT,
                allowNull: false,
                defaultValue: 0,
            },
            plan_b_scalp_buy_price: {
                type: Sequelize.FLOAT,
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
            'plan_b_scalp_buy_price',
            'plan_b_scalp_open',
            'plan_b_last_sell_price',
            'plan_b_scalp_lots',
            'plan_b_started',
        ]) {
            if (table[name]) {
                await queryInterface.removeColumn('trade_details', name);
            }
        }
    },
};
