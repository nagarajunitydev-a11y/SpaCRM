import assert from 'node:assert/strict';
import { renderCheckout } from '../public/js/ui/views/checkout.js';
import { renderSubscription } from '../public/js/ui/views/subscription.js';
import { razorpayGateway } from '../public/js/services/payment/razorpayGateway.js';
import { DEFAULT_PLANS } from '../public/js/core/plans.js';
import { isNativePaymentContext } from '../public/js/core/platform.js';

globalThis.window = { location: { search: '' } };
const state = { mode: 'firebase', plansCatalog: DEFAULT_PLANS, checkout: {
    planId: 'standard', billingCycle: 'monthly', method: 'upi', step: 'select', renewalMode: 'manual',
} };
const manual = renderCheckout(state);
assert(manual.includes('Total today') && manual.includes('data-checkout-total'));
assert(manual.includes('Payment method') && manual.includes('Pay '));
assert(manual.includes('One payment only'));
const automatic = renderCheckout({ ...state, checkout: { ...state.checkout, renewalMode: 'automatic' } });
assert(automatic.includes('Recurring amount') && !automatic.includes('Total today'));
assert(automatic.includes('Agree and authorise automatic renewal'));
assert(automatic.includes('120 monthly') && !automatic.includes('aria-label="Payment method"'));
const scheduled = renderCheckout({ ...state, subscription: { autoRenew: true }, checkout: { ...state.checkout, renewalMode: 'automatic' } });
assert(scheduled.includes('Schedule plan change') && scheduled.includes('next billing cycle'));

let options;
window.Razorpay = class {
    constructor(value) { options = value; }
    on() {}
    open() { options.handler({ razorpay_subscription_id: 'sub_fixture', razorpay_payment_id: 'pay_fixture', razorpay_signature: 'fixture' }); }
};
const result = await razorpayGateway.openCheckout({ subscriptionId: 'sub_fixture', keyId: 'rzp_test_fixture', currency: 'INR' });
assert.equal(options.subscription_id, 'sub_fixture');
assert.equal(options.order_id, undefined);
assert.equal(options.amount, undefined);
assert.equal(result.subscriptionId, 'sub_fixture');

window.AndroidNative = { exitApp() {} };
assert(isNativePaymentContext(), 'Native bridge must identify Android even without its query parameter');
const nativeCheckout = renderCheckout(state);
assert(!nativeCheckout.includes('data-action="confirm-payment"'));
assert(!nativeCheckout.includes('data-action="checkout-renewal"'));
const nativeSubscription = renderSubscription(state);
assert(!nativeSubscription.includes('data-action="select-plan"'));
assert(!nativeSubscription.includes('https://'));
assert(nativeSubscription.includes('Existing subscriptions remain available'));
delete globalThis.window;
console.log('PAYMENT UI: manual checkout, recurring consent, scheduled changes, mandate options and native policy checks passed.');
