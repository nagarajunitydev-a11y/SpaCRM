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
for (const id of ['basic', 'standard', 'premium', 'business']) {
    assert(nativeSubscription.includes(`data-plan-card="${id}"`), `Android must list the ${id} plan`);
    assert(nativeSubscription.includes(`₹${DEFAULT_PLANS[id].priceMonthly.toLocaleString('en-IN')}`), `Android must show the ${id} price`);
}
assert(nativeSubscription.includes('data-action="billing-cycle"'), 'Android must offer monthly / annual options');

// App builds with Google Play billing (user choice) purchase through Play's flow.
const ready = { ...state, nativeBillingReady: true };
const playCheckout = renderCheckout(ready);
assert(playCheckout.includes('data-action="confirm-payment"') && playCheckout.includes('Continue to payment'));
assert(playCheckout.includes('data-action="checkout-tax-state"') && playCheckout.includes('TAMIL NADU'), 'India reporting needs the GST state');
assert(/data-action="confirm-payment" disabled /.test(playCheckout), 'Continue stays disabled until a state is chosen');
assert(!/data-action="confirm-payment" disabled /.test(renderCheckout({ ...ready, checkout: { ...ready.checkout, taxState: 'KERALA' } })));
assert(!playCheckout.includes('aria-label="Payment method"') && !playCheckout.includes('data-action="checkout-renewal"'),
    'No gateway method picker or automatic-renewal option before Google Play\'s choice screen');
const playPlans = renderSubscription(ready);
assert(playPlans.includes('data-action="select-plan"') && !playPlans.includes('data-native-purchase-note'));
const playBilled = renderSubscription({ ...ready, subscription: { billingSource: 'google_play', playProductId: 'glowos_standard', planId: 'standard', status: 'ACTIVE' },
    access: { planId: 'standard', plan: DEFAULT_PLANS.standard, status: 'ACTIVE', usage: {}, limit: () => 1 } });
assert(playBilled.includes('Managed in Google Play') && playBilled.includes('play.google.com/store/account/subscriptions?sku=glowos_standard'));
delete globalThis.window;
console.log('PAYMENT UI: manual checkout, recurring consent, scheduled changes, mandate options and native policy checks passed.');
