/**
 * seedData.js
 * Demo-mode seed records, shared by the tenant repositories and the unit
 * test-suite so revenue calculations can be verified against real record
 * shapes (identical to the Firestore document schema).
 */

export const serviceSeed = [
    { id: 's1', salonId: 'salon_luxe_01', name: 'Balayage & Gloss', price: 160, duration: '120m' },
    { id: 's2', salonId: 'salon_luxe_01', name: 'Signature Facial', price: 95, duration: '60m' },
    { id: 's3', salonId: 'salon_luxe_01', name: 'Precision Haircut', price: 75, duration: '45m' },
];

export const appointmentSeed = [
    { id: 'a1', salonId: 'salon_luxe_01', customerName: 'Olivia Wilde', serviceName: 'Balayage & Gloss', staffName: 'Victoria Sterling', date: '2026-06-15', time: '10:00', status: 'Completed', amount: 160, discount: 0, couponCode: '', loyaltyRedemption: 0, tax: 28.8, refund: 0, paymentMethod: 'upi', paid: true, paymentNote: '' },
];

export default { serviceSeed, appointmentSeed };
