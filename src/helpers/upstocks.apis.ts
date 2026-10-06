import { logger } from '../logger/logger';
import axios from 'axios';

export const place_order_on_upstocks = async (data) => {
    try {
        const url = 'https://api-hft.upstox.com/v3/order/place';
        const accessToken = data.accessToken;
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
            slice: false,
            market_protection: 0,
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

/** Fetch live order status/average price from Upstox */
export const get_upstox_order_details = async (
    accessToken: string,
    orderId: string,
): Promise<{
    status: string;
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
            average_price: Number(
                d?.average_price ?? d?.avg_price ?? d?.price ?? 0,
            ),
            filled_quantity: Number(
                d?.filled_quantity ?? d?.filled_qty ?? d?.quantity ?? 0,
            ),
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
