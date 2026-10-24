import { logger } from '../logger/logger';
import axios from 'axios';

export const place_order_on_upstocks = async (data) => {
    try {
        const url = 'https://api-hft.upstox.com/v3/order/place';
        const accessToken = data.accessToken;
        // Upstox API rejects MARKET with market_protection=0 (UDAPI1158).
        // -1 = exchange guideline protection; 1–25 = custom % cap on slippage.
        const marketProtection =
            data.market_protection !== undefined
                ? Number(data.market_protection)
                : -1;
        const payload = {
            quantity: data.quantity,
            product: 'D',
            validity: 'DAY',
            price: 0,
            tag: data.tag || 'nifty-scalp',
            instrument_token: data.instrument_key,
            order_type: 'MARKET',
            transaction_type: data.transaction_type,
            disclosed_quantity: 0,
            trigger_price: 0,
            is_amo: false,
            slice: Boolean(data.slice),
            market_protection: marketProtection,
        };
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${accessToken}`,
            },
            timeout: 15000,
        });
        logger.info(
            `Upstox place order ${data.transaction_type} ${data.instrument_key} qty=${data.quantity}`,
        );
        return response.data;
    } catch (error: any) {
        logger.error(
            'Error in place_order_on_upstocks',
            error?.response?.data || error?.message || error,
        );
        return {
            status: 'error',
            error: error?.response?.data || error?.message || 'order_place_failed',
        };
    }
};

/** Equity available_margin. Call after a confirmed fill — not before a buy. */
export const get_upstox_funds_and_margin = async (
    accessToken: string,
): Promise<number | null> => {
    try {
        const response = await axios.get(
            'https://api.upstox.com/v2/user/get-funds-and-margin',
            {
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                timeout: 10000,
            },
        );
        const available = Number(
            response.data?.data?.equity?.available_margin,
        );
        if (!Number.isFinite(available)) return null;
        return available;
    } catch (error: any) {
        logger.warn(
            `get_upstox_funds_and_margin failed: ${
                error?.response?.data?.message || error?.message
            }`,
        );
        return null;
    }
};

/**
 * Cancel a pending order (v3 HFT endpoint, same host as place).
 * Returns { ok, error }. A "cancel accepted" does NOT mean cancelled yet — re-read the order.
 */
export const cancel_upstox_order = async (
    accessToken: string,
    orderId: string,
): Promise<{ ok: boolean; error?: any; raw?: any }> => {
    try {
        const response = await axios.delete(
            'https://api-hft.upstox.com/v3/order/cancel',
            {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                params: { order_id: orderId },
                timeout: 10000,
            },
        );
        logger.info(`Upstox cancel order ${orderId}`);
        return { ok: response.data?.status !== 'error', raw: response.data };
    } catch (error: any) {
        logger.warn(
            `cancel_upstox_order(${orderId}) failed: ${
                JSON.stringify(error?.response?.data) || error?.message
            }`,
        );
        return {
            ok: false,
            error: error?.response?.data || error?.message || 'cancel_failed',
        };
    }
};

/** Fetch live order status/average price from Upstox */
export const get_upstox_order_details = async (
    accessToken: string,
    orderId: string,
): Promise<{
    status: string;
    status_message?: string;
    average_price?: number;
    filled_quantity?: number;
    pending_quantity?: number;
    raw?: any;
} | null> => {
    try {
        const response = await axios.get(
            'https://api.upstox.com/v2/order/details',
            {
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                },
                params: { order_id: orderId },
                timeout: 10000,
            },
        );
        const d = response.data?.data ?? response.data;
        const status = String(
            d?.status || d?.order_status || d?.Status || '',
        ).toLowerCase();
        return {
            status,
            status_message:
                d?.status_message_raw || d?.status_message || undefined,
            // Never fall back to limit price or ordered quantity: an unfilled
            // order must not look filled.
            average_price: Number(d?.average_price ?? d?.avg_price ?? 0),
            filled_quantity: Number(d?.filled_quantity ?? d?.filled_qty ?? 0),
            pending_quantity: Number(d?.pending_quantity ?? 0),
            raw: d,
        };
    } catch (error: any) {
        logger.warn(
            `get_upstox_order_details(${orderId}) failed: ${
                error?.response?.data?.message || error?.message
            }`,
        );
        return null;
    }
};
