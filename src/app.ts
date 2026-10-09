import express, { Express } from 'express';
import fileUpload from 'express-fileupload';
import './config/database';
import http, { request } from 'http';
import * as dotenv from 'dotenv';
dotenv.config();
import { logger } from './logger/logger';
import './config/passport.jwt';
import routes from './routes/index';
import passport from 'passport';
import cors from 'cors';
import session from 'express-session';
import { END_POINTS, MODEL } from './constant';
import i18n from './locales/index';
import { ErrorHandler } from './middleware';
import WebSocket from 'ws';
import * as UpstoxClient from 'upstox-js-sdk';
import protobuf from 'protobufjs';
import { db } from './model';
import { Server } from 'socket.io';
import { INDEXES, USER_DETAILS } from './constant/response.types';
import { strategyController } from './controller';
import './config/restart.json';
import cron from 'node-cron';
import moment from 'moment';
import { debounce } from 'lodash';
import { Op } from 'sequelize';
import axios from 'axios';
import './utils/cron.job';
import './utils/reconciliation.cron';
import './utils/nifty.chain.cron';
import {
    // LEGACY SBIN scalping feed — disabled while Nifty Options Scalp is active
    // processMarketFeed,
    STRATEGY_THROTTLE_MS,
} from './helpers/scalping.trade.helper';
import { processNiftyMarketFeed } from './helpers/nifty.scalp.trade.helper';
import { setNiftyNotifyEmitter } from './helpers/nifty.scalp.notify.helper';
import { ensureNiftyStrategyRecords } from './helpers/nifty.chain.sync.helper';
import { handleNiftyOrderStatusUpdate } from './helpers/nifty.scalp.order.helper';
import './utils/nifty.reconciliation.cron';

let protobufRoot = null;
let defaultClient = UpstoxClient.ApiClient.instance;
let apiVersion = '3.0';
let OAUTH2 = defaultClient.authentications['OAUTH2'];
let updateBuffer = {};
let lastStrategyRunAt = 0;
let lastPositionsEmitAt = 0;
const POSITIONS_EMIT_THROTTLE_MS = 500;

const port = process.env.PORT_SERVER || 8000;
const stocks = new Map<string, any>();

class AppServer {
    private io: Server;
    private marketWs: WebSocket | null = null;
    private portfolioWs: WebSocket | null = null;
    private orderUpdateWs: WebSocket | null = null;
    private reconnectAttempts = 0;
    private readonly MAX_RETRIES = 50;
    constructor() {
        const app: Express = express();
        const server = http.createServer(app);
        this.initWebSocket();
        const io = new Server(server, {
            cors: {
                origin: '*',
            },
            path: '/api/socket',
        });
        this.io = io;
        setNiftyNotifyEmitter((event, payload) => {
            this.io.emit(event, payload);
        });
        ensureNiftyStrategyRecords().catch((err) =>
            logger.error(`ensureNiftyStrategyRecords: ${err.message}`),
        );
        this.io.on('connection', async (socket) => {
            // Immediate snapshot so Positions page has live LTP/P-L right away
            try {
                await this.emitTodayTrades();
            } catch (err: any) {
                logger.error(`emitTodayTrades on connect: ${err?.message || err}`);
            }
            socket.on('sendemit', (data) => {
                console.log(data);
                this.io.emit('stock_data', data);
            });
            socket.on('disconnect', () => {});
        });
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json({}));
        app.use(
            fileUpload({
                limits: { fileSize: 1024 * 1024 * 1024 },
            }),
        );
        app.use(
            cors({
                origin: '*',
                credentials: true,
            }),
        );
        app.use(
            session({
                secret: process.env.SESSION_SECERET,
                resave: false,
                saveUninitialized: true,
            }),
        );
        app.use(i18n.init);
        app.use(passport.initialize());
        app.use(passport.session());
        app.use(END_POINTS.MAIN, routes);
        app.use(ErrorHandler);
        server.listen(port, () => {
            logger.info(`🚀 Server is listening on Port:- ${port}`);
        });
    }

    async initWebSocket() {
        try {
            await this.initProtobuf();
            const wsUrl = await this.getMarketFeedUrl();
            const wsPortfolioUrl = await this.getPortfolioFeedUrl();
            const ws = await this.connectWebSocket(wsUrl);
            const portfolio_ws = await this.connectPortfolioWebSocket(
                wsPortfolioUrl,
            );
        } catch (error) {
            console.error('An error occurred:', error.message);
        }
    }

    private async reconnectMarketFeed() {
        if (this.reconnectAttempts >= this.MAX_RETRIES) {
            logger.error('Max reconnection attempts reached');
            return;
        }

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
        this.reconnectAttempts++;

        logger.warn(`Reconnecting market feed in ${delay} ms`);

        setTimeout(async () => {
            try {
                const wsUrl = await this.getMarketFeedUrl();
                this.marketWs = await this.connectWebSocket(wsUrl);
                const wsPortfolioUrl = await this.getPortfolioFeedUrl();
                this.orderUpdateWs = await this.connectPortfolioWebSocket(
                    wsPortfolioUrl,
                );
                this.reconnectAttempts = 0;
            } catch (err) {
                logger.error('Reconnect failed:', err.message);
                this.reconnectMarketFeed();
            }
        }, delay);
    }

    async getMarketFeedUrl() {
        try {
            const user = await db[MODEL.USER].findOne({
                where: { email: USER_DETAILS.EMAIL },
            });

            if (!user || !user.token) {
                throw new Error('User token not found');
            }
            OAUTH2.accessToken = user.token;
            const url =
                'https://api.upstox.com/v3/feed/market-data-feed/authorize';

            const response = await axios.get(url, {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${user.token}`,
                },
            });

            return response.data.data.authorizedRedirectUri;
        } catch (error) {
            console.error('Error in getMarketFeedUrl:', error.message || error);
            throw error;
        }
    }
    async getPortfolioFeedUrl() {
        return new Promise((resolve, reject) => {
            let apiInstance = new UpstoxClient.WebsocketApi();
            apiInstance.getPortfolioStreamFeedAuthorize(
                '2.0',
                (error, data, response) => {
                    if (error) {
                        console.log(error);
                        reject(error);
                    } else {
                        resolve(data.data.authorizedRedirectUri);
                    }
                },
            );
        });
    }

    initProtobuf = async () => {
        protobufRoot = await protobuf.load(
            __dirname + '/MarketDataFeedV3.proto',
        );
        console.log('Protobuf part initialization complete');
    };
    decodeProfobuf = (buffer) => {
        if (!protobufRoot) {
            console.warn('Protobuf part not initialized yet!');
            return null;
        }

        const FeedResponse = protobufRoot.lookupType(
            'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
        );
        return FeedResponse.decode(buffer);
    };
    async connectWebSocket(wsUrl: string) {
        return new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(wsUrl, {
                headers: {
                    'Api-Version': apiVersion,
                    Authorization: 'Bearer ' + OAUTH2.accessToken,
                },
                followRedirects: true,
            });
            ws.on('open', () => {
                console.log('connected');
                resolve(ws);
                setTimeout(async () => {
                    // Nifty Options Scalp: subscribe near-ATM hedging keys (+ index)
                    const allOptions = await db[MODEL.HEDGING_OPTIONS].findAll(
                        {},
                    );
                    let options = allOptions;
                    try {
                        const spotResp = await axios.get(
                            'https://api.upstox.com/v2/market-quote/ltp',
                            {
                                headers: {
                                    Authorization:
                                        'Bearer ' + OAUTH2.accessToken,
                                    Accept: 'application/json',
                                },
                                params: {
                                    instrument_key: INDEXES.NIFTY_50,
                                },
                            },
                        );
                        let spot = 0;
                        for (const key in spotResp.data?.data || {}) {
                            spot = spotResp.data.data[key].last_price;
                            break;
                        }
                        if (spot > 0) {
                            const atm = Math.round(spot / 50) * 50;
                            options = allOptions.filter((o) => {
                                const strike = Number(o.strike_price);
                                return (
                                    !Number.isNaN(strike) &&
                                    Math.abs(strike - atm) <= 50 * 10
                                );
                            });
                        }
                    } catch (e) {
                        logger.warn(
                            'ATM band filter failed; subscribing all hedging keys',
                        );
                    }

                    const instrumentKeys = options.map(
                        (option) => option.instrument_key,
                    );
                    const instrument_data_keys = [
                        ...new Set(
                            [...instrumentKeys, INDEXES.NIFTY_50].filter(
                                Boolean,
                            ),
                        ),
                    ];
                    console.log(
                        'Subscribing instruments:',
                        instrument_data_keys.length,
                    );
                    const data = {
                        typr: '',
                        guid: 'someguid',
                        method: 'sub',
                        data: {
                            mode: 'full',
                            instrumentKeys: instrument_data_keys,
                        },
                    };
                    ws.send(Buffer.from(JSON.stringify(data)));
                }, 1000);
            });
            ws.on('close', () => {
                console.log('disconnected main websockets');
                this.reconnectMarketFeed();
            });

            ws.on('message', async (data) => {
                const stocks_data: any = this.decodeProfobuf(data);

                // LEGACY SBIN scalping feed — commented out
                // await processMarketFeed(stocks_data);
                await processNiftyMarketFeed(stocks_data);

                const now = Date.now();
                if (now - lastStrategyRunAt >= STRATEGY_THROTTLE_MS) {
                    lastStrategyRunAt = now;
                    // LEGACY: await strategyController.scallping_strategy_new();
                    await strategyController.nifty_options_scalp_run();
                }

                // Push live LTP / P/L to Positions UI (throttled)
                const emitNow = Date.now();
                if (emitNow - lastPositionsEmitAt >= POSITIONS_EMIT_THROTTLE_MS) {
                    lastPositionsEmitAt = emitNow;
                    await this.emitTodayTrades();
                }
            });
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            });
        });
    }

    private async emitTodayTrades() {
        const formated_data = [];
        const trades = await db[MODEL.TRADE].findAll({
            where: {
                createdAt: {
                    [Op.between]: [
                        moment().startOf('day'),
                        moment().endOf('day'),
                    ],
                },
            },
            order: [['createdAt', 'DESC']],
        });

        for (const datas of trades) {
            const buyPrice = Number(datas.buy_price || 0);
            const ltp = Number(datas.ltp || 0);
            const sellPrice = Number(datas.sell_price || 0);
            const lots = Number(datas.qty || 0);
            const lotSize = Number(datas.lot_size || 0);
            const qtyUnits = lotSize * lots;
            const isActive = Boolean(datas.is_active);

            // Live mark for open trades; closed uses stored sell
            const markPrice = isActive
                ? ltp
                : sellPrice > 0
                  ? sellPrice
                  : ltp;
            const grossPl =
                buyPrice && markPrice && qtyUnits
                    ? (markPrice - buyPrice) * qtyUnits
                    : Number(datas.pl || 0);
            const storedCharges = Number(datas.charges || 0);
            // Open: estimate charges ~ ₹40/lot round-trip if not stored yet
            const estCharges =
                storedCharges > 0
                    ? storedCharges
                    : Math.max(0, lots) * 40 * 2;
            const netPl = isActive
                ? grossPl - estCharges
                : Number(datas.net_pl ?? grossPl - storedCharges);

            formated_data.push({
                id: datas.trade_id,
                tradeUuid: datas.id,
                entryDate: datas.createdAt,
                symbol: datas.trading_symbol,
                buyPrice,
                sellPrice: isActive ? null : sellPrice || null,
                currentLTP: ltp,
                markPrice,
                target: Number(datas.target_price || 0),
                stopploss: Number(datas.stop_loss || 0),
                profitLoss: Number(grossPl.toFixed(2)),
                netPl: Number(netPl.toFixed(2)),
                charges: Number((isActive ? estCharges : storedCharges).toFixed(2)),
                quantity: qtyUnits,
                lots,
                lot_size: lotSize,
                status: isActive ? 'in_trade' : 'closed',
                trade_time: datas.createdAt,
                strategy_name: datas.strategy_name,
                instrument_type: datas.instrument_type,
                exit_reason: datas.exit_reason,
                highest_ltp: Number(datas.highest_ltp ?? ltp ?? 0),
                eodDecision: datas.eod_decision || null,
                live: true,
                updatedAt: new Date().toISOString(),
            });
        }

        this.io.emit('stock_data', { data: formated_data });
    }

    async connectPortfolioWebSocket(wsPortfolioUrl) {
        return new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(wsPortfolioUrl, {
                headers: {
                    'Api-Version': apiVersion,
                    Authorization: 'Bearer ' + OAUTH2.accessToken,
                },
                followRedirects: true,
            });
            ws.on('open', function open() {
                console.log('connected order update ');
                resolve(ws);
            });

            ws.on('close', () => {
                console.log('disconnected order update');
                this.reconnectMarketFeed();
            });

            ws.on('message', async function message(data) {
                const order_data = JSON.parse(data.toString());
                console.log(order_data);

                // Drive Nifty order lifecycle (confirm / reject / finalize exit)
                try {
                    await handleNiftyOrderStatusUpdate(order_data);
                } catch (err: any) {
                    console.error(
                        'handleNiftyOrderStatusUpdate error:',
                        err?.message || err,
                    );
                }

                // Keep generic status patch for non-Nifty / legacy rows
                const find_order = await db[MODEL.UPSTOCK_ORDERS].findOne({
                    where: {
                        upstock_order_id: order_data.order_id,
                    },
                });

                if (find_order && !find_order.purpose) {
                    await db[MODEL.UPSTOCK_ORDERS].update(
                        {
                            status: order_data.status,
                        },
                        {
                            where: {
                                upstock_order_id: order_data.order_id,
                            },
                        },
                    );
                }
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            });
        });
    }
}
new AppServer();
