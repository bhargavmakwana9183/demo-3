'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
    async up(queryInterface, Sequelize) {
        const table = await queryInterface.describeTable('trade_details');
        if (!table.eod_decision) {
            await queryInterface.addColumn('trade_details', 'eod_decision', {
                type: Sequelize.STRING,
                allowNull: true,
                comment: 'REQUIRED | CARRY | MANUAL_SELL',
            });
        }
    },

    async down(queryInterface) {
        const table = await queryInterface.describeTable('trade_details');
        if (table.eod_decision) {
            await queryInterface.removeColumn('trade_details', 'eod_decision');
        }
    },
};
