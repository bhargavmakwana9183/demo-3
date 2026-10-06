import { DataTypes } from 'sequelize';

export const tradeModel = (sequelize) => {
    const tradeModel = sequelize.define(
        'trade_details',
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: DataTypes.UUIDV4,
                primaryKey: true,
            },
            position_id: {
                type: DataTypes.UUID,
                allowNull: true,
            },
            trade_id: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            strategy_name: {
                type: DataTypes.STRING,
            },
            trading_symbol: {
                type: DataTypes.STRING,
            },
            options_chain_id: {
                type: DataTypes.UUID,
            },
            instrument_key: {
                type: DataTypes.STRING,
            },
            instrument_type: {
                type: DataTypes.STRING,
            },
            trade_type: {
                type: DataTypes.STRING,
            },
            buy_price: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            sell_price: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            stop_loss: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            target_price: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            pl: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            ltp: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            qty: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            lot_size: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            highest_ltp: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            charges: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            net_pl: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            partial_exit_done: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            original_qty: {
                type: DataTypes.FLOAT,
                defaultValue: 0,
            },
            exit_reason: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            order_lifecycle: {
                type: DataTypes.STRING,
                allowNull: true,
                defaultValue: 'OPEN',
            },
            broker_confirmed: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            entry_order_id: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            exit_order_id: {
                type: DataTypes.STRING,
                allowNull: true,
            },
            exit_pending: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            exit_retry_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
            },
            exit_halted: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            last_order_error: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            pending_exit_reason: {
                type: DataTypes.STRING,
                allowNull: true,
            },
        },
        {
            paranoid: true,
            freezeTableName: true,
            indexes: [
                {
                    fields: ['instrument_key'],
                },
            ],
        },
    );

    tradeModel.associate = (models) => {
        tradeModel.belongsTo(models.positionModel, {
            foreignKey: 'position_id',
        });
        tradeModel.belongsTo(models.OptionchainModel, {
            foreignKey: 'options_chain_id',
        });
    };

    return tradeModel;
};
