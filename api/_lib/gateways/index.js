/** Picks the payment gateway from PAYMENT_GATEWAY (default: razorpay). */
import { createGateway as razorpay } from './razorpay.js';

const REGISTRY = { razorpay };

export function getGateway(env = process.env) {
    const name = (env.PAYMENT_GATEWAY || 'razorpay').toLowerCase();
    const factory = REGISTRY[name];
    if (!factory) throw new Error(`Unknown PAYMENT_GATEWAY "${name}".`);
    return factory(env);
}
