import { DataTypes } from 'sequelize';

export const tradeLegHistoryModel = (sequelize) => {
    const tradeLegHistoryModel = sequelize.define(
        'trade_leg_history',
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: DataTypes.UUIDV4,
                primaryKey: true,
            },
            trade_uuid: {
                type: DataTypes.UUID,
                allowNull: false,
            },
            trade_ref: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            position_id: {
                type: DataTypes.UUID,
                allowNull: true,
            },
            strategy_name: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            leg_type: {
                type: DataTypes.STRING,
                allowNull: false,
            },
            side: {
                type: DataTypes.STRING,
                allowNull: false,
            },
            lots: {
                type: DataTypes.FLOAT,
                allowNull: false,
                defaultValue: 1,
            },
            lot_size: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            quantity: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            price: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            avg_buy_after: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            qty_after: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            target_after: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            gross_pl: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            net_pl: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            charges: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            broker_order_id: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            instrument_key: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            trading_symbol: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            reason: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            mode: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            metadata: {
                type: DataTypes.JSONB,
                allowNull: true,
            },
            occurred_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW,
            },
        },
        {
            paranoid: true,
            freezeTableName: true,
            indexes: [
                { fields: ['trade_uuid'] },
                { fields: ['trade_ref'] },
                { fields: ['leg_type'] },
                { fields: ['occurred_at'] },
            ],
        },
    );

    tradeLegHistoryModel.associate = (models) => {
        if (models.tradeModel) {
            tradeLegHistoryModel.belongsTo(models.tradeModel, {
                foreignKey: 'trade_uuid',
                as: 'trade',
            });
        }
    };

    return tradeLegHistoryModel;
};
