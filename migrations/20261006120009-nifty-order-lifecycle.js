'use strict';

const TRADE_TABLE = 'trade_details';
const ORDER_TABLE = 'upstock_order_details';

const tradeColumns = (Sequelize) => ({
    order_lifecycle: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'OPEN',
        comment:
            'PENDING_ENTRY | OPEN | EXIT_PENDING | CLOSED | FAILED | HALTED',
    },
    broker_confirmed: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false,
    },
    entry_order_id: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    exit_order_id: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    exit_pending: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false,
    },
    exit_retry_count: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 0,
    },
    exit_halted: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false,
    },
    last_order_error: {
        type: Sequelize.TEXT,
        allowNull: true,
    },
    pending_exit_reason: {
        type: Sequelize.STRING,
        allowNull: true,
    },
});

const orderColumns = (Sequelize) => ({
    trade_id: {
        type: Sequelize.UUID,
        allowNull: true,
    },
    instrument_key: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    quantity: {
        type: Sequelize.FLOAT,
        allowNull: true,
    },
    purpose: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'ENTRY | ADD_LOT | EXIT | PARTIAL_EXIT',
    },
    average_price: {
        type: Sequelize.FLOAT,
        allowNull: true,
    },
    filled_quantity: {
        type: Sequelize.FLOAT,
        allowNull: true,
        defaultValue: 0,
    },
    rejection_reason: {
        type: Sequelize.TEXT,
        allowNull: true,
    },
    strategy_name: {
        type: Sequelize.STRING,
        allowNull: true,
    },
});

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const tradeTable = await queryInterface.describeTable(TRADE_TABLE);
        for (const [name, definition] of Object.entries(
            tradeColumns(Sequelize),
        )) {
            if (!tradeTable[name]) {
                await queryInterface.addColumn(TRADE_TABLE, name, definition);
            }
        }

        const orderTable = await queryInterface.describeTable(ORDER_TABLE);
        for (const [name, definition] of Object.entries(
            orderColumns(Sequelize),
        )) {
            if (!orderTable[name]) {
                await queryInterface.addColumn(ORDER_TABLE, name, definition);
            }
        }
    },

    async down(queryInterface) {
        for (const name of Object.keys(tradeColumns({}))) {
            const tradeTable = await queryInterface.describeTable(TRADE_TABLE);
            if (tradeTable[name]) {
                await queryInterface.removeColumn(TRADE_TABLE, name);
            }
        }
        for (const name of Object.keys(orderColumns({}))) {
            const orderTable = await queryInterface.describeTable(ORDER_TABLE);
            if (orderTable[name]) {
                await queryInterface.removeColumn(ORDER_TABLE, name);
            }
        }
    },
};
