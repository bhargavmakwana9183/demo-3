import { DataTypes } from 'sequelize';

export const UpstocksOrderModel = (sequelize) => {
    const UpstocksOrderModel = sequelize.define(
        'upstock_order_details',
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: DataTypes.UUIDV4,
                primaryKey: true,
            },
            postion_id: {
                type: DataTypes.UUID,
                allowNull: true,
            },
            upstock_order_id: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            order_type: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            status: {
                type: DataTypes.TEXT,
                defaultValue: 'Pending',
                comment: 'Pending, open, complete, rejected, cancelled, failed',
            },
            trade_id: {
                type: DataTypes.UUID,
                allowNull: true,
            },
            instrument_key: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            quantity: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            purpose: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            average_price: {
                type: DataTypes.FLOAT,
                allowNull: true,
            },
            filled_quantity: {
                type: DataTypes.FLOAT,
                allowNull: true,
                defaultValue: 0,
            },
            rejection_reason: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            strategy_name: {
                type: DataTypes.STRING,
                allowNull: true,
            },
        },
        {
            paranoid: true,
        },
    );
    return UpstocksOrderModel;
};
