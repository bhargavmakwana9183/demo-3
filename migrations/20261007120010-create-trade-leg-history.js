'use strict';

const TABLE = 'trade_leg_history';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const tables = await queryInterface.showAllTables();
        const exists = tables
            .map((t) => (typeof t === 'string' ? t : t.tableName || t))
            .includes(TABLE);
        if (exists) return;

        await queryInterface.createTable(TABLE, {
            id: {
                type: Sequelize.UUID,
                allowNull: false,
                primaryKey: true,
                defaultValue: Sequelize.UUIDV4,
            },
            trade_uuid: {
                type: Sequelize.UUID,
                allowNull: false,
                comment: 'trade_details.id',
            },
            trade_ref: {
                type: Sequelize.STRING,
                allowNull: true,
                comment: 'trade_details.trade_id display ref',
            },
            position_id: {
                type: Sequelize.UUID,
                allowNull: true,
            },
            strategy_name: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            leg_type: {
                type: Sequelize.STRING,
                allowNull: false,
                comment:
                    'ENTRY | ADD_LOT | PARTIAL_SELL | FULL_EXIT | MANUAL_ENTRY',
            },
            side: {
                type: Sequelize.STRING,
                allowNull: false,
                comment: 'BUY | SELL',
            },
            lots: {
                type: Sequelize.FLOAT,
                allowNull: false,
                defaultValue: 1,
            },
            lot_size: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            quantity: {
                type: Sequelize.FLOAT,
                allowNull: true,
                comment: 'lots * lot_size',
            },
            price: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            avg_buy_after: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            qty_after: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            target_after: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            gross_pl: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            net_pl: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            charges: {
                type: Sequelize.FLOAT,
                allowNull: true,
            },
            broker_order_id: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            instrument_key: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            trading_symbol: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            reason: {
                type: Sequelize.STRING,
                allowNull: true,
            },
            mode: {
                type: Sequelize.STRING,
                allowNull: true,
                comment: 'paper | live',
            },
            metadata: {
                type: Sequelize.JSONB,
                allowNull: true,
            },
            occurred_at: {
                type: Sequelize.DATE,
                allowNull: false,
                defaultValue: Sequelize.NOW,
            },
            createdAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            updatedAt: {
                type: Sequelize.DATE,
                allowNull: false,
            },
            deletedAt: {
                type: Sequelize.DATE,
                allowNull: true,
            },
        });

        await queryInterface.addIndex(TABLE, ['trade_uuid']);
        await queryInterface.addIndex(TABLE, ['trade_ref']);
        await queryInterface.addIndex(TABLE, ['leg_type']);
        await queryInterface.addIndex(TABLE, ['occurred_at']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable(TABLE);
    },
};
