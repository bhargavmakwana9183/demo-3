/**
 * Replay the Nifty options scalp over stored 1-minute candles (read-only).
 *
 *   yarn replay:nifty                         # all stored days, live settings
 *   yarn replay:nifty --from 2026-10-21 --to 2026-10-29 --verbose
 *   yarn replay:nifty --be-arm 400 --trail-arm 550 --tol5m 3
 *   yarn replay:nifty --grid                  # compare preset variants
 *
 * Uses the same signal, exit and day-limit functions as the live engine.
 * Simplifications: entries fill at the next candle's open + spread; inside a
 * candle the price path is open → low → high → close (or open → high → low →
 * close for a down candle) walked in 0.5-pt steps; on days without stored
 * Nifty spot candles, spot is estimated from options (strike + CE − PE).
 */
import { Op } from 'sequelize';
import { db } from '../model';
import { INDEXES, INDEXES_NAMES, MODEL } from '../constant';
import {
    NIFTY_ENTRY_QUIET_UNTIL,
    NIFTY_PAPER_SPREAD_POINTS,
    NiftyScalpConfig,
    calculateGrossPl,
    calculateRoundTripCharges,
    getNiftyScalpConfig,
} from '../helpers/nifty.scalp.config.helper';
import {
    DEFAULT_NIFTY_SIGNAL_PARAMS,
    NiftySignalParams,
    optionSignalFromCandles,
    pickNiftyEntrySide,
    spotTrend1mFromCloses,
} from '../helpers/nifty.scalp.signal.helper';
import {
    DEFAULT_NIFTY_DAY_LIMIT_PARAMS,
    DEFAULT_NIFTY_EXIT_PARAMS,
    NiftyDayLimitParams,
    NiftyExitParams,
    niftyDayLimitReason,
    niftyDayStats,
    planNiftyExit,
} from '../helpers/nifty.scalp.rules';

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };
type Option = { key: string; symbol: string; strike: number; type: 'CE' | 'PE'; lotSize: number };
type Params = { signal: NiftySignalParams; exit: NiftyExitParams; day: NiftyDayLimitParams };
type Trade = {
    day: string;
    symbol: string;
    side: 'CE' | 'PE';
    entryTs: number;
    entry: number;
    exitTs: number;
    exit: number;
    reason: string;
    net: number;
    peak: number;
};

const MIN = 60_000;
const NO_NEW_ENTRY_AFTER = '14:30';
const EXPIRY_NO_NEW_ENTRY_AFTER = '11:30';
const EOD_CHECK_TIME = '15:10';
const LAST_CANDLE = '15:29';

const istMs = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`).getTime();
const hhmm = (ts: number) =>
    new Date(ts).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
// ---------------------------------------------------------------- data

const toCandles = (rows: any[]): Candle[] => {
    // The feed rewrites a minute's row for ~2 minutes; keep the latest version.
    const byTs = new Map<number, Candle>();
    for (const r of rows) {
        byTs.set(Number(r.ts), {
            ts: Number(r.ts),
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: Number(r.volume || 0),
        });
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
};

const loadCandles = async (keys: string[], fromMs: number, toMs: number) => {
    const rows = await db[MODEL.CANDELS].findAll({
        where: {
            instrument_key: { [Op.in]: keys },
            ts: { [Op.between]: [String(fromMs), String(toMs)] },
        },
        order: [['updatedAt', 'ASC']],
        raw: true,
    });
    const grouped = new Map<string, any[]>();
    for (const r of rows as any[]) {
        if (!grouped.has(r.instrument_key)) grouped.set(r.instrument_key, []);
        grouped.get(r.instrument_key)!.push(r);
    }
    const out = new Map<string, Candle[]>();
    for (const k of keys) out.set(k, toCandles(grouped.get(k) ?? []));
    return out;
};

/** Spot from put-call parity at the strike where CE and PE are closest. */
const syntheticSpot = (options: Option[], candles: Map<string, Candle[]>): Candle[] => {
    const byStrike = new Map<number, { ce?: Map<number, Candle>; pe?: Map<number, Candle> }>();
    for (const o of options) {
        const m = new Map((candles.get(o.key) ?? []).map((c) => [c.ts, c]));
        const slot = byStrike.get(o.strike) ?? {};
        if (o.type === 'CE') slot.ce = m;
        else slot.pe = m;
        byStrike.set(o.strike, slot);
    }
    const allTs = new Set<number>();
    for (const c of candles.values()) for (const x of c) allTs.add(x.ts);
    const out: Candle[] = [];
    for (const ts of [...allTs].sort((a, b) => a - b)) {
        let best: { diff: number; value: number } | null = null;
        for (const [strike, { ce, pe }] of byStrike) {
            const c = ce?.get(ts);
            const p = pe?.get(ts);
            if (!c || !p) continue;
            const diff = Math.abs(c.close - p.close);
            if (!best || diff < best.diff) best = { diff, value: strike + c.close - p.close };
        }
        if (best) {
            const v = Number(best.value.toFixed(2));
            out.push({ ts, open: v, high: v, low: v, close: v, volume: 0 });
        }
    }
    return out;
};

type DayData = {
    day: string;
    expiry: string;
    options: Option[];
    candles: Map<string, Candle[]>;
    spot: Candle[];
    spotSource: 'real' | 'synthetic';
};

const loadDay = async (day: string): Promise<DayData | null> => {
    const chain = await db[MODEL.OPTIONS_CHAINS].findOne({
        where: { name: INDEXES_NAMES.NIFTY_50, expiry: { [Op.gte]: day } },
        order: [['expiry', 'ASC']],
        raw: true,
    });
    if (!chain) return null;
    const expiry = String((chain as any).expiry).slice(0, 10);
    const rows = (await db[MODEL.OPTIONS_CHAINS].findAll({
        where: { name: INDEXES_NAMES.NIFTY_50, expiry },
        raw: true,
    })) as any[];
    const options: Option[] = rows
        .filter((r) => r.instrument_type === 'CE' || r.instrument_type === 'PE')
        .map((r) => ({
            key: r.instrument_key,
            symbol: r.trading_symbol,
            strike: Number(r.strike_price),
            type: r.instrument_type,
            lotSize: Number(r.lot_size || r.minimum_lot) || 65,
        }));
    // Warm-up: the engine reads the last 100 candles, which reach back into earlier days.
    const from = istMs(day, '09:15') - 4 * 24 * 60 * MIN;
    const to = istMs(day, LAST_CANDLE);
    const candles = await loadCandles(options.map((o) => o.key), from, to);
    const todayCount = [...candles.values()].reduce(
        (n, c) => n + c.filter((x) => x.ts >= istMs(day, '09:15')).length,
        0,
    );
    if (todayCount < 1000) return null;

    const realSpot = (await loadCandles([INDEXES.NIFTY_50], from, to)).get(INDEXES.NIFTY_50)!;
    const realToday = realSpot.filter((c) => c.ts >= istMs(day, '09:15')).length;
    const spot = realToday >= 300 ? realSpot : syntheticSpot(options, candles);
    return {
        day,
        expiry,
        options,
        candles,
        spot,
        spotSource: realToday >= 300 ? 'real' : 'synthetic',
    };
};

const storedDays = async (from?: string, to?: string): Promise<string[]> => {
    const [rows] = await db.sequelize.query(
        `select distinct to_char(to_timestamp(c.ts::bigint/1000) at time zone 'Asia/Kolkata','YYYY-MM-DD') d
         from candels c join option_chain_details o on o.instrument_key = c.instrument_key
         where o.name = :name and c."deletedAt" is null order by 1`,
        { replacements: { name: INDEXES_NAMES.NIFTY_50 } },
    );
    return (rows as any[])
        .map((r) => r.d as string)
        .filter((d) => (!from || d >= from) && (!to || d <= to));
};

// ---------------------------------------------------------------- simulation

const lastBefore = (list: Candle[], ts: number, n: number) => {
    // list is ascending; candles with c.ts <= ts, newest n
    let hi = list.length;
    let lo = 0;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].ts <= ts) lo = mid + 1;
        else hi = mid;
    }
    return list.slice(Math.max(0, lo - n), lo);
};

const nearestListed = (options: Option[], atm: number, type: 'CE' | 'PE', step: number) => {
    for (const k of [0, 1, -1, 2, -2, 3, -3]) {
        const o = options.find((x) => x.type === type && x.strike === atm + k * step);
        if (o) return o;
    }
    return null;
};

/** Price path inside one candle, in small steps so stops trigger near their level. */
const candlePath = (c: Candle): number[] => {
    const legs = c.close >= c.open ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
    const out: number[] = [legs[0]];
    for (let i = 1; i < legs.length; i++) {
        const a = legs[i - 1];
        const b = legs[i];
        const n = Math.max(1, Math.ceil(Math.abs(b - a) / 0.5));
        for (let s = 1; s <= n; s++) out.push(Number((a + ((b - a) * s) / n).toFixed(2)));
    }
    return out;
};

const simulateDay = (data: DayData, config: NiftyScalpConfig, params: Params): Trade[] => {
    const { day, options, candles, spot } = data;
    const spread = NIFTY_PAPER_SPREAD_POINTS;
    const trades: Trade[] = [];
    const usedSignalCandles = new Set<number>();
    const quiet = istMs(day, NIFTY_ENTRY_QUIET_UNTIL);
    const noNew = istMs(day, data.expiry === day ? EXPIRY_NO_NEW_ENTRY_AFTER : NO_NEW_ENTRY_AFTER);
    const eod = istMs(day, EOD_CHECK_TIME);
    const last = istMs(day, LAST_CANDLE);
    const minutes = spot.filter((c) => c.ts >= istMs(day, '09:15') && c.ts <= last).map((c) => c.ts);

    let pos: null | {
        option: Option;
        entryTs: number;
        entry: number;
        highest: number;
        lastMinuteClose: number | null;
        series: Map<number, Candle>;
    } = null;

    const close = (ts: number, price: number, reason: string) => {
        const p = pos!;
        const fill = Math.max(0.05, price - spread);
        const charges = calculateRoundTripCharges(1, p.option.lotSize, p.entry, config);
        trades.push({
            day,
            symbol: p.option.symbol,
            side: p.option.type,
            entryTs: p.entryTs,
            entry: p.entry,
            exitTs: ts,
            exit: Number(fill.toFixed(2)),
            reason,
            net: calculateGrossPl(fill, p.entry, 1, p.option.lotSize) - charges,
            peak: p.highest,
        });
        pos = null;
    };

    for (let i = 0; i < minutes.length; i++) {
        const ts = minutes[i];

        // 1. Manage the open trade through this candle.
        if (pos) {
            const c = pos.series.get(ts);
            if (c) {
                const path = candlePath(c);
                let exited = false;
                for (let s = 0; s < path.length; s++) {
                    const x = path[s];
                    pos.highest = Math.max(pos.highest, x);
                    const atTs = ts + Math.round((s / Math.max(1, path.length - 1)) * 59_000);
                    const plan = planNiftyExit({
                        ltp: x,
                        avgBuy: pos.entry,
                        highest: pos.highest,
                        qty: 1,
                        lotSize: pos.option.lotSize,
                        ageMin: (atTs - pos.entryTs) / MIN,
                        config,
                        lastMinuteClose: pos.lastMinuteClose,
                        params: params.exit,
                    });
                    if (plan.exit) {
                        close(atTs, x, plan.exit.reason);
                        exited = true;
                        break;
                    }
                    if (s === path.length - 1 && plan.checkSpotFlip) {
                        const closes = lastBefore(spot, ts, 100).map((k) => k.close);
                        if (!spotTrend1mFromCloses(closes, pos.option.type, config).ok) {
                            close(atTs, x, 'SPOT_TREND_FLIP');
                            exited = true;
                            break;
                        }
                    }
                }
                if (!exited && pos) {
                    pos.lastMinuteClose = c.close;
                    const net =
                        calculateGrossPl(c.close - spread, pos.entry, 1, pos.option.lotSize) -
                        calculateRoundTripCharges(1, pos.option.lotSize, pos.entry, config);
                    if ((ts >= eod && net >= 0) || ts >= last) {
                        close(ts + 59_000, c.close, ts >= last ? 'EOD_FORCED_CLOSE' : 'EOD_1510_NOT_IN_LOSS');
                    }
                }
            }
            if (pos) continue;
        }

        // 2. Flat: the candle at `ts` has just completed; decide at ts+60s, fill at the next open.
        const decideAt = ts + MIN;
        if (decideAt < quiet || decideAt >= noNew || i + 1 >= minutes.length) continue;
        if (usedSignalCandles.has(ts)) continue;
        const stats = niftyDayStats(
            trades.map((t) => ({ net: t.net, closedAt: new Date(t.exitTs) })),
            params.day,
        );
        if (niftyDayLimitReason(stats, new Date(decideAt), params.day)) continue;

        const spotNow = lastBefore(spot, ts, 500);
        const spotClose = spotNow[spotNow.length - 1]?.close;
        if (!spotClose) continue;
        const atm = Math.round(spotClose / config.strike_step) * config.strike_step;
        const ce = nearestListed(options, atm, 'CE', config.strike_step);
        const pe = nearestListed(options, atm, 'PE', config.strike_step);
        if (!ce || !pe) continue;
        const desc = (o: Option) => lastBefore(candles.get(o.key) ?? [], ts, 100).reverse();
        const ceSig = optionSignalFromCandles(ce, desc(ce), 'CE', config, params.signal);
        const peSig = optionSignalFromCandles(pe, desc(pe), 'PE', config, params.signal);
        const pick = pickNiftyEntrySide(ceSig, peSig, spotNow, config, params.signal);
        if (!pick.side) continue;

        const option = pick.side === 'CE' ? ce : pe;
        const series = new Map((candles.get(option.key) ?? []).map((c) => [c.ts, c]));
        const next = series.get(minutes[i + 1]);
        if (!next) continue;
        usedSignalCandles.add(ts);
        const entry = Number((next.open + spread).toFixed(2));
        pos = {
            option,
            entryTs: next.ts,
            entry,
            highest: entry,
            lastMinuteClose: null,
            series,
        };
    }
    return trades;
};

// ---------------------------------------------------------------- report

const summarize = (trades: Trade[], scratchRs: number) => {
    const wins = trades.filter((t) => t.net >= scratchRs).length;
    const losses = trades.filter((t) => t.net <= -scratchRs).length;
    const net = trades.reduce((s, t) => s + t.net, 0);
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    for (const t of trades) {
        equity += t.net;
        peak = Math.max(peak, equity);
        maxDd = Math.min(maxDd, equity - peak);
    }
    const reasons: Record<string, number> = {};
    for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
    return {
        trades: trades.length,
        wins,
        scratches: trades.length - wins - losses,
        losses,
        net: Math.round(net),
        avg: trades.length ? Math.round(net / trades.length) : 0,
        maxDrawdown: Math.round(maxDd),
        reasons,
    };
};

const parseArgs = () => {
    const args = process.argv.slice(2);
    const get = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const num = (name: string, fallback: number) => {
        const v = get(name);
        return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
    };
    const params: Params = {
        signal: {
            ...DEFAULT_NIFTY_SIGNAL_PARAMS,
            maxExtensionPct: num('ext', DEFAULT_NIFTY_SIGNAL_PARAMS.maxExtensionPct * 100) / 100,
            spot1mTolerancePts: num('tol1m', DEFAULT_NIFTY_SIGNAL_PARAMS.spot1mTolerancePts),
            spot5mTolerancePts: num('tol5m', DEFAULT_NIFTY_SIGNAL_PARAMS.spot5mTolerancePts),
        },
        exit: {
            ...DEFAULT_NIFTY_EXIT_PARAMS,
            breakevenArmRs: num('be-arm', DEFAULT_NIFTY_EXIT_PARAMS.breakevenArmRs),
            breakevenFastDropPoints: num('be-fast', DEFAULT_NIFTY_EXIT_PARAMS.breakevenFastDropPoints),
            trailArmRs: num('trail-arm', DEFAULT_NIFTY_EXIT_PARAMS.trailArmRs),
            trailPoints: num('trail-pts', DEFAULT_NIFTY_EXIT_PARAMS.trailPoints),
            trailFloorRs: num('trail-floor', DEFAULT_NIFTY_EXIT_PARAMS.trailFloorRs),
            profitCapRs: num('cap', DEFAULT_NIFTY_EXIT_PARAMS.profitCapRs),
            stopPoints: num('stop', DEFAULT_NIFTY_EXIT_PARAMS.stopPoints),
        },
        day: {
            ...DEFAULT_NIFTY_DAY_LIMIT_PARAMS,
            scratchRs: num('scratch', DEFAULT_NIFTY_DAY_LIMIT_PARAMS.scratchRs),
        },
    };
    return {
        from: get('from'),
        to: get('to'),
        verbose: args.includes('--verbose'),
        grid: args.includes('--grid'),
        params,
    };
};

const withOverrides = (base: Params, o: {
    signal?: Partial<NiftySignalParams>;
    exit?: Partial<NiftyExitParams>;
    day?: Partial<NiftyDayLimitParams>;
}): Params => ({
    signal: { ...base.signal, ...o.signal },
    exit: { ...base.exit, ...o.exit },
    day: { ...base.day, ...o.day },
});

const GRID: { name: string; o: Parameters<typeof withOverrides>[1] }[] = [
    {
        name: 'old: BE ₹200 instant, trail ₹300, no scratch rule',
        o: { exit: { breakevenArmRs: 200, breakevenFastDropPoints: 0, trailArmRs: 300 }, day: { scratchRs: 0 } },
    },
    { name: 'old stops + scratch rule', o: { exit: { breakevenArmRs: 200, breakevenFastDropPoints: 0, trailArmRs: 300 } } },
    { name: 'BE ₹200 on 1m close, trail ₹300', o: { exit: { breakevenArmRs: 200, trailArmRs: 300 } } },
    { name: 'BE ₹300 on 1m close, trail ₹450', o: { exit: { breakevenArmRs: 300, trailArmRs: 450 } } },
    { name: 'BE ₹400 on 1m close, trail ₹550', o: { exit: { breakevenArmRs: 400, trailArmRs: 550 } } },
    { name: 'BE ₹400 instant, trail ₹550', o: { exit: { breakevenArmRs: 400, breakevenFastDropPoints: 0, trailArmRs: 550 } } },
    { name: 'BE ₹400 on 1m close, trail ₹550, trail 8 pts', o: { exit: { breakevenArmRs: 400, trailArmRs: 550, trailPoints: 8 } } },
    { name: 'no breakeven, trail ₹550', o: { exit: { breakevenArmRs: 1e9, trailArmRs: 550 } } },
    { name: 'BE ₹400/trail ₹550 + 5m tolerance 3 pts', o: { exit: { breakevenArmRs: 400, trailArmRs: 550 }, signal: { spot5mTolerancePts: 3 } } },
    { name: 'BE ₹400/trail ₹550 + 1m tol 1, 5m tol 3', o: { exit: { breakevenArmRs: 400, trailArmRs: 550 }, signal: { spot1mTolerancePts: 1, spot5mTolerancePts: 3 } } },
];

const main = async () => {
    const { from, to, verbose, grid, params } = parseArgs();
    const config = await getNiftyScalpConfig();
    const days = await storedDays(from, to);
    const loaded: DayData[] = [];
    for (const d of days) {
        const data = await loadDay(d);
        if (data) loaded.push(data);
    }
    console.log(
        `Days: ${loaded.map((d) => `${d.day}${d.spotSource === 'synthetic' ? '*' : ''}`).join(', ') || 'none'}`,
    );
    console.log('(* = Nifty spot estimated from option prices)\n');

    const runs = grid ? GRID.map((g) => ({ name: g.name, p: withOverrides(params, g.o) })) : [{ name: 'current settings', p: params }];
    for (const run of runs) {
        const all: Trade[] = [];
        for (const d of loaded) {
            const t = simulateDay(d, config, run.p);
            all.push(...t);
            if (verbose && !grid) {
                const s = summarize(t, run.p.day.scratchRs);
                console.log(`${d.day}${d.spotSource === 'synthetic' ? '*' : ''} (expiry ${d.expiry}): ${s.trades} trades, net ₹${s.net}`);
                for (const x of t) {
                    console.log(
                        `   ${hhmm(x.entryTs)}→${hhmm(x.exitTs)} ${x.symbol.padEnd(22)} buy ${x.entry.toFixed(2)} sell ${x.exit.toFixed(2)} peak ${x.peak.toFixed(2)}  ${x.reason.padEnd(22)} net ₹${x.net.toFixed(0)}`,
                    );
                }
            }
        }
        const s = summarize(all, run.p.day.scratchRs);
        const perDay = loaded.map((d) => Math.round(all.filter((t) => t.day === d.day).reduce((n, t) => n + t.net, 0)));
        console.log(
            `${run.name}\n   trades ${s.trades} | wins ${s.wins} / scratch ${s.scratches} / losses ${s.losses} | net ₹${s.net} | avg ₹${s.avg} | max drawdown ₹${s.maxDrawdown}\n   per day ${perDay.join(', ')}\n   exits ${JSON.stringify(s.reasons)}\n`,
        );
    }
};

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
