import { DataTypes } from 'sequelize';

export const strategyConfigModel = (sequelize) => {
    const strategyConfigModel = sequelize.define(
        'strategy_config',
        {
            id: {
                type: DataTypes.UUID,
                allowNull: false,
                defaultValue: DataTypes.UUIDV4,
                primaryKey: true,
            },
            strategy_name: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true,
            },
            market_start_time: {
                type: DataTypes.STRING,
                defaultValue: '09:15',
            },
            entry_start_time: {
                type: DataTypes.STRING,
                defaultValue: '09:45',
            },
            entry_cutoff_time: {
                type: DataTypes.STRING,
                defaultValue: '15:00',
            },
            force_exit_time: {
                type: DataTypes.STRING,
                defaultValue: '15:15',
            },
            market_end_time: {
                type: DataTypes.STRING,
                defaultValue: '15:19',
            },
            risk_per_trade_pct: {
                type: DataTypes.FLOAT,
                defaultValue: 0.01,
            },
            max_lots_per_trade: {
                type: DataTypes.INTEGER,
                defaultValue: 2,
            },
            max_trades_per_day: {
                type: DataTypes.INTEGER,
                defaultValue: 3,
            },
            max_daily_loss: {
                type: DataTypes.FLOAT,
                defaultValue: 5000,
            },
            max_loss_per_trade: {
                type: DataTypes.FLOAT,
                defaultValue: 3000,
            },
            max_consecutive_losses: {
                type: DataTypes.INTEGER,
                defaultValue: 2,
            },
            cooldown_minutes: {
                type: DataTypes.INTEGER,
                defaultValue: 30,
            },
            trailing_breakeven_at: {
                type: DataTypes.FLOAT,
                defaultValue: 2,
            },
            trailing_atr_multiplier: {
                type: DataTypes.FLOAT,
                defaultValue: 1.5,
            },
            brokerage_per_lot: {
                type: DataTypes.FLOAT,
                defaultValue: 40,
            },
            slippage_pct: {
                type: DataTypes.FLOAT,
                defaultValue: 0.002,
            },
            paper_balance: {
                type: DataTypes.FLOAT,
                defaultValue: 100000,
            },
            mode: {
                type: DataTypes.STRING,
                defaultValue: 'paper',
            },
            is_active: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            ema_fast: {
                type: DataTypes.INTEGER,
                defaultValue: 9,
            },
            ema_slow: {
                type: DataTypes.INTEGER,
                defaultValue: 21,
            },
            rsi_period: {
                type: DataTypes.INTEGER,
                defaultValue: 14,
            },
            rsi_ce_max: {
                type: DataTypes.FLOAT,
                defaultValue: 70,
            },
            rsi_pe_min: {
                type: DataTypes.FLOAT,
                defaultValue: 30,
            },
            atr_stop_multiplier: {
                type: DataTypes.FLOAT,
                defaultValue: 1.5,
            },
            atr_target_multiplier: {
                type: DataTypes.FLOAT,
                defaultValue: 2.5,
            },
            min_rr_ratio: {
                type: DataTypes.FLOAT,
                defaultValue: 1.5,
            },
            volume_lookback: {
                type: DataTypes.INTEGER,
                defaultValue: 10,
            },
            trend_ema_period: {
                type: DataTypes.INTEGER,
                defaultValue: 21,
            },
            min_candles_1m: {
                type: DataTypes.INTEGER,
                defaultValue: 22,
            },
            partial_target_pct: {
                type: DataTypes.FLOAT,
                defaultValue: 0.5,
            },
            partial_target_extension: {
                type: DataTypes.FLOAT,
                defaultValue: 1.2,
            },
            time_exit_minutes: {
                type: DataTypes.INTEGER,
                defaultValue: 30,
            },
            time_exit_min_pl: {
                type: DataTypes.FLOAT,
                defaultValue: -500,
            },
            time_exit_max_pl: {
                type: DataTypes.FLOAT,
                defaultValue: 500,
            },
            enable_partial_exit: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            enable_ema_reversal_exit: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            enable_time_exit: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            underlying_name: {
                type: DataTypes.STRING,
                defaultValue: 'STATE BANK OF INDIA',
            },
            underlying_instrument_key: {
                type: DataTypes.STRING,
                defaultValue: 'NSE_EQ|INE062A01020',
            },
            strike_step: {
                type: DataTypes.FLOAT,
                defaultValue: 10,
            },
            atm_itm_steps: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
            },
            max_spread_pct: {
                type: DataTypes.FLOAT,
                defaultValue: 0.02,
            },
            min_open_interest: {
                type: DataTypes.FLOAT,
                defaultValue: 10000,
            },
            expiry_day_cutoff_time: {
                type: DataTypes.STRING,
                defaultValue: '14:00',
            },
            enable_dynamic_atm: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            enable_liquidity_check: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            enable_expiry_rules: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            target_profit_rs: {
                type: DataTypes.FLOAT,
                defaultValue: 200,
            },
            add_lot_points: {
                type: DataTypes.FLOAT,
                defaultValue: 10,
            },
            enable_plan_b: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            enable_overnight_carry: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            plan_b_min_lots: {
                type: DataTypes.INTEGER,
                defaultValue: 2,
            },
            plan_b_bounce_points: {
                type: DataTypes.FLOAT,
                defaultValue: 3,
            },
        },
        {
            paranoid: true,
            freezeTableName: true,
        },
    );

    return strategyConfigModel;
};
