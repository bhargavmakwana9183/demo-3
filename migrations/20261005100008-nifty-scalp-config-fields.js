'use strict';

const CONFIG_TABLE = 'strategy_config';

const configColumns = (Sequelize) => ({
    target_profit_rs: {
        type: Sequelize.FLOAT,
        defaultValue: 200,
        allowNull: true,
    },
    add_lot_points: {
        type: Sequelize.FLOAT,
        defaultValue: 10,
        allowNull: true,
    },
    enable_plan_b: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull: true,
    },
    enable_overnight_carry: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull: true,
    },
    plan_b_min_lots: {
        type: Sequelize.INTEGER,
        defaultValue: 2,
        allowNull: true,
    },
    plan_b_bounce_points: {
        type: Sequelize.FLOAT,
        defaultValue: 3,
        allowNull: true,
    },
});

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const configTable = await queryInterface.describeTable(CONFIG_TABLE);
        for (const [name, definition] of Object.entries(
            configColumns(Sequelize),
        )) {
            if (!configTable[name]) {
                await queryInterface.addColumn(CONFIG_TABLE, name, definition);
            }
        }
    },

    async down(queryInterface, Sequelize) {
        for (const name of Object.keys(configColumns(Sequelize))) {
            const configTable = await queryInterface.describeTable(CONFIG_TABLE);
            if (configTable[name]) {
                await queryInterface.removeColumn(CONFIG_TABLE, name);
            }
        }
    },
};
