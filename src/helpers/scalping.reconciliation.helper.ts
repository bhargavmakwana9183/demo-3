import axios from 'axios';
import { logger } from '../logger/logger';

export interface UpstoxPosition {
    instrument_key: string;
    quantity: number;
    product: string;
    trading_symbol?: string;
}

/**
 * Strict variant: returns null when the positions call FAILED.
 * An empty array here really means "broker is flat".
 */
export const getUpstoxPositionsOrNull = async (
    accessToken: string,
): Promise<UpstoxPosition[] | null> => {
    try {
        const response = await axios.get(
            'https://api.upstox.com/v2/portfolio/short-term-positions',
            {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                timeout: 10000,
            },
        );
        const data = response.data?.data ?? [];
        return data.map((p: any) => ({
            instrument_key: p.instrument_token ?? p.instrument_key,
            quantity: Number(p.quantity ?? p.net_quantity ?? 0),
            product: p.product,
            trading_symbol: p.trading_symbol,
        }));
    } catch (error: any) {
        logger.error(
            'getUpstoxPositions failed',
            error?.response?.data || error?.message,
        );
        return null;
    }
};

/** Legacy variant used by the older scalping strategy: [] on failure. */
export const getUpstoxPositions = async (
    accessToken: string,
): Promise<UpstoxPosition[]> =>
    (await getUpstoxPositionsOrNull(accessToken)) ?? [];
