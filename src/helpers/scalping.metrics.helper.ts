export interface TradePlRow {
    netPl: number;
    grossPl?: number;
    exitReason?: string | null;
    closedAt?: Date;
}

export interface DailyPlRow {
    date: string;
    pl: number;
}

export interface PerformanceMetrics {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number | null;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    totalGrossPl: number;
    totalNetPl: number;
    maxDrawdown: number;
    bestDay: { date: string; pl: number } | null;
    worstDay: { date: string; pl: number } | null;
    exitReasonBreakdown: Record<string, number>;
}

export const computePerformanceMetrics = (
    trades: TradePlRow[],
    dailyPl: DailyPlRow[] = [],
): PerformanceMetrics => {
    const netPls = trades.map((t) => Number(t.netPl) || 0);
    const wins = netPls.filter((p) => p > 0);
    const losses = netPls.filter((p) => p <= 0);

    const grossWins = wins.reduce((s, p) => s + p, 0);
    const grossLosses = Math.abs(
        losses.reduce((s, p) => s + p, 0),
    );

    const winRate = netPls.length
        ? (wins.length / netPls.length) * 100
        : 0;
    const profitFactor =
        grossLosses > 0
            ? grossWins / grossLosses
            : grossWins > 0
              ? null // Infinity is not JSON-safe; clients treat null as ∞
              : 0;
    const avgWin = wins.length ? grossWins / wins.length : 0;
    const avgLoss = losses.length
        ? losses.reduce((s, p) => s + p, 0) / losses.length
        : 0;
    const winPct = netPls.length ? wins.length / netPls.length : 0;
    const lossPct = netPls.length ? losses.length / netPls.length : 0;
    const expectancy = winPct * avgWin + lossPct * avgLoss;

    const exitReasonBreakdown: Record<string, number> = {};
    for (const trade of trades) {
        const reason = trade.exitReason || 'UNKNOWN';
        exitReasonBreakdown[reason] =
            (exitReasonBreakdown[reason] ?? 0) + 1;
    }

    let maxDrawdown = 0;
    let bestDay: { date: string; pl: number } | null = null;
    let worstDay: { date: string; pl: number } | null = null;

    if (dailyPl.length > 0) {
        let cumulative = 0;
        let peak = 0;
        for (const day of dailyPl) {
            cumulative += day.pl;
            peak = Math.max(peak, cumulative);
            maxDrawdown = Math.max(maxDrawdown, peak - cumulative);

            if (!bestDay || day.pl > bestDay.pl) {
                bestDay = { date: day.date, pl: day.pl };
            }
            if (!worstDay || day.pl < worstDay.pl) {
                worstDay = { date: day.date, pl: day.pl };
            }
        }
    } else if (netPls.length > 0) {
        let cumulative = 0;
        let peak = 0;
        for (const pl of netPls) {
            cumulative += pl;
            peak = Math.max(peak, cumulative);
            maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
        }
    }

    const totalGrossPl = trades.reduce(
        (s, t) => s + (Number(t.grossPl ?? t.netPl) || 0),
        0,
    );
    const totalNetPl = netPls.reduce((s, p) => s + p, 0);

    return {
        totalTrades: netPls.length,
        wins: wins.length,
        losses: losses.length,
        winRate,
        profitFactor,
        avgWin,
        avgLoss,
        expectancy,
        totalGrossPl,
        totalNetPl,
        maxDrawdown,
        bestDay,
        worstDay,
        exitReasonBreakdown,
    };
};
