/**
 * Browser payment-gateway registry. The server names the gateway in the
 * create-order response; adding a gateway = add a module here that follows the
 * contract in razorpayGateway.js. Nothing else in the app knows which gateway
 * is in use.
 */
import { razorpayGateway } from './razorpayGateway.js';

const REGISTRY = { razorpay: razorpayGateway };

export function getBrowserGateway(id) {
    const g = REGISTRY[id];
    if (!g) throw new Error(`Unsupported payment gateway "${id}".`);
    return g;
}

/** Methods the owner can pick on our screen (the gateway sheet does the rest). */
export const PAYMENT_METHODS = [
    { id: 'upi', label: 'UPI', hint: 'GPay, PhonePe, Paytm, any UPI app', icon: 'smartphone' },
    { id: 'card', label: 'Credit / Debit Card', hint: 'Visa, Mastercard, RuPay, Amex', icon: 'credit-card' },
    { id: 'netbanking', label: 'Net Banking', hint: 'All major Indian banks', icon: 'landmark' },
    { id: 'wallet', label: 'Wallets', hint: 'Where supported by the gateway', icon: 'wallet' },
];
